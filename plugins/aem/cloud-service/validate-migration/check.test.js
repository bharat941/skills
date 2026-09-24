'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  parseBundleDiagnosticReport,
  parseComponentsFromReport,
  normalizeState,
  mcpUnavailableOutcome,
  buildMcpPayload,
  toClassEntry,
  stripEmpty,
  truncate,
  parseArgs,
  PATTERNS,
  readContext,
  classifyDialog,
  clearDiagnosisMap,
} = require('./check.js');
const { ALL_FAILURE_CLASSES, FAILURE_CLASSES, isFailureClass } = require('./failure-classes.js');
const { changedFiles, RULES, SOURCE_ONLY_PATTERNS } = require('./plan.js');
const { selectArtifact } = require('./build.js');
// ── Failure-class taxonomy ────────────────────────────────────────

test('every failure_class the skill emits is in the frozen taxonomy', () => {
  for (const value of Object.values(FAILURE_CLASSES)) {
    assert.ok(isFailureClass(value), `${value} in ALL_FAILURE_CLASSES`);
  }
  assert.ok(ALL_FAILURE_CLASSES.includes('setup.mcp_unavailable'));
});

test('mcpUnavailableOutcome uses setup.mcp_unavailable with setup guidance', () => {
  const outcome = mcpUnavailableOutcome('com.acme.core');
  assert.strictEqual(outcome.result, 'fail');
  assert.strictEqual(outcome.failure_class, 'setup.mcp_unavailable');
  assert.ok(isFailureClass(outcome.failure_class), 'class is in the frozen taxonomy (MCP parity)');
  assert.match(outcome.evidence, /diagnose-osgi-bundle/);
  assert.match(outcome.evidence, /com\.acme\.core/);
});

// ── diagnose-osgi-bundle report parsing ─────────────────────────────────────

test('parseBundleDiagnosticReport reads an Active bundle state', () => {
  const report = 'Bundle: com.acme.core\nState: ACTIVE\n';
  const r = parseBundleDiagnosticReport(report);
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.bundle_state, 'Active');
});

test('parseBundleDiagnosticReport reads a Resolved bundle state', () => {
  const r = parseBundleDiagnosticReport('Bundle: com.acme.core\nState: RESOLVED\n');
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.bundle_state, 'Resolved');
});

test('parseBundleDiagnosticReport marks a missing bundle not found', () => {
  const r = parseBundleDiagnosticReport('no such bundle: com.acme.core');
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.bundle_state, 'Unknown');
});

test('parseComponentsFromReport extracts component states', () => {
  const report = [
    'Bundle: com.acme.core',
    'State: ACTIVE',
    '--- Declarative Services Components ---',
    'Component: com.acme.core.MyJob',
    '  State: ACTIVE',
    'Component: com.acme.core.Broken',
    '  State: UNSATISFIED',
  ].join('\n');
  const comps = parseComponentsFromReport(report);
  assert.strictEqual(comps.get('com.acme.core.MyJob').state, 'Active');
  assert.strictEqual(comps.get('com.acme.core.Broken').state, 'Unsatisfied');
});

test('normalizeState title-cases OSGi upper-case states', () => {
  assert.strictEqual(normalizeState('ACTIVE'), 'Active');
  assert.strictEqual(normalizeState('resolved'), 'Resolved');
  assert.strictEqual(normalizeState(''), 'Unknown');
});

// ── Payload builders (report-migration-outcome schema) ──────────────────────

test('toClassEntry keeps failure_class on fail and omits it on pass', () => {
  const fail = toClassEntry({
    result: 'fail',
    pattern: 'scheduler',
    failure_class: 'runtime.bundle_not_active',
    bundle_state: 'Resolved',
    evidence: 'bundle state=Resolved',
  });
  assert.strictEqual(fail.result, 'fail');
  assert.strictEqual(fail.failure_class, 'runtime.bundle_not_active');

  const pass = toClassEntry({ result: 'pass', pattern: 'scheduler', discovered: { fqcn: 'com.acme.MyJob' } });
  assert.strictEqual(pass.result, 'pass');
  assert.strictEqual(pass.class_name, 'com.acme.MyJob');
  assert.ok(!('failure_class' in pass), 'no failure_class on a pass entry');
});

test('buildMcpPayload derives summary counts and carries a setup.mcp_unavailable class', () => {
  const record = {
    run_id: 'run-1',
    result: 'fail',
    verification_level: 'runtime',
    started_at: '2026-09-23T00:00:00.000Z',
    finished_at: '2026-09-23T00:00:01.000Z',
    classes: [
      { result: 'pass', pattern: 'scheduler', discovered: { fqcn: 'com.acme.Ok' } },
      mcpUnavailableOutcome('com.acme.core'),
    ],
  };
  const payload = buildMcpPayload(record, { 'project-id': 'p1', pattern: 'scheduler' });
  assert.strictEqual(payload.project_id, 'p1');
  assert.strictEqual(payload.summary.classes_total, 2);
  assert.strictEqual(payload.summary.classes_pass, 1);
  assert.strictEqual(payload.summary.classes_fail, 1);
  const setupClass = payload.classes.find((c) => c.failure_class === 'setup.mcp_unavailable');
  assert.ok(setupClass, 'setup.mcp_unavailable class survives into the payload');
});

test('stripEmpty removes undefined and null but keeps falsy values', () => {
  const out = stripEmpty({ a: 1, b: undefined, c: null, d: 0, e: '' });
  assert.deepStrictEqual(out, { a: 1, d: 0, e: '' });
});

test('truncate caps long strings with an ellipsis', () => {
  assert.strictEqual(truncate('hello', 10), 'hello');
  assert.strictEqual(truncate('hello world', 6), 'hello…');
});

// ── CLI arg parsing ─────────────────────────────────────────────────────────

test('parseArgs reads a leading pattern and --flags', () => {
  const args = parseArgs(['scheduler', '--stage', 'verify', '--project-id', 'p1']);
  assert.strictEqual(args.pattern, 'scheduler');
  assert.strictEqual(args.stage, 'verify');
  assert.strictEqual(args['project-id'], 'p1');
});

test('parseArgs treats a leading flag as no pattern', () => {
  const args = parseArgs(['--stage', 'prepare']);
  assert.strictEqual(args.pattern, undefined);
  assert.strictEqual(args.stage, 'prepare');
});

// ── plan.js change scoping (CF0005) ─────────────────────────────────────────

function git(cwd, ...a) {
  return execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
}

test('changedFiles unions committed, staged, unstaged, and untracked changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-plan-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t.t');
  git(root, 'config', 'user.name', 't');
  git(root, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  git(root, 'add', 'base.txt');
  git(root, 'commit', '-q', '-m', 'base');

  git(root, 'checkout', '-q', '-b', 'feature');
  const write = (rel, c) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, c);
  };
  // committed on feature
  write('committed.java', 'x');
  git(root, 'add', 'committed.java');
  git(root, 'commit', '-q', '-m', 'committed');
  // staged
  write('staged.java', 'x');
  git(root, 'add', 'staged.java');
  // unstaged (modify a tracked file)
  fs.appendFileSync(path.join(root, 'base.txt'), 'more\n');
  // untracked
  write('untracked.java', 'x');

  const files = changedFiles(root, 'main');
  assert.ok(files.includes('committed.java'), 'committed change detected');
  assert.ok(files.includes('staged.java'), 'staged change detected');
  assert.ok(files.includes('base.txt'), 'unstaged change detected');
  assert.ok(files.includes('untracked.java'), 'untracked change detected');

  fs.rmSync(root, { recursive: true, force: true });
});

// ── Pattern registry parity (plan.js ↔ check.js) ──────────────────

test('every plan.js RULE pattern is verifiable in check.js PATTERNS', () => {
  for (const { pattern } of RULES) {
    assert.ok(PATTERNS[pattern], `plan.js emits '${pattern}' but check.js PATTERNS has no such verifier`);
  }
});

test('SOURCE_ONLY_PATTERNS matches the source-only patterns plan.js can emit', () => {
  const rulePatterns = new Set(RULES.map((r) => r.pattern));
  // SOURCE_ONLY_PATTERNS only governs plan-derived tasks, so it must equal
  // exactly the RULE patterns whose check.js verifier declares source-only mode.
  const expected = new Set(
    [...rulePatterns].filter((p) => PATTERNS[p].mode === 'source-only'),
  );
  assert.deepStrictEqual(
    [...SOURCE_ONLY_PATTERNS].sort(),
    [...expected].sort(),
    'plan.js SOURCE_ONLY_PATTERNS is out of sync with check.js source-only modes',
  );
});

// ── Build artifact selection (bundle .jar vs content-package .zip) ──

test('selectArtifact picks the .jar for bundle patterns', () => {
  const files = ['core-1.0.jar', 'core-1.0-sources.jar'];
  assert.strictEqual(selectArtifact(files, 'bundle'), 'core-1.0.jar');
});

test('selectArtifact picks the .zip for content-package (source-only) patterns', () => {
  // ui.apps module: a content package .zip, no bundle jar — the legacy-ui/cdw case.
  const files = ['ui.apps-1.0.zip'];
  assert.strictEqual(selectArtifact(files, 'content-package'), 'ui.apps-1.0.zip');
});

test('selectArtifact prefers .zip over .jar for content-package', () => {
  const files = ['ui.apps-1.0.jar', 'ui.apps-1.0.zip'];
  assert.strictEqual(selectArtifact(files, 'content-package'), 'ui.apps-1.0.zip');
});

test('selectArtifact falls back to a content-embedding jar when no zip', () => {
  const files = ['bundle-with-content-1.0.jar'];
  assert.strictEqual(selectArtifact(files, 'content-package'), 'bundle-with-content-1.0.jar');
});

test('selectArtifact ignores -sources.jar and returns undefined when nothing matches', () => {
  assert.strictEqual(selectArtifact(['app-sources.jar', 'app.pom'], 'bundle'), undefined);
});

// ── --project path resolution (read paths match write paths) ──

test('readContext honors args.project for the context.json path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-ctx-'));
  fs.mkdirSync(path.join(root, '.validate-migration'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.validate-migration', 'context.json'),
    JSON.stringify({ projectId: 'P123' }),
  );
  assert.strictEqual(readContext({ project: root }).projectId, 'P123');
  fs.rmSync(root, { recursive: true, force: true });
});

// ── Review-fix regressions ────────────────────────────────────────

test('RULES: a ResourceChangeListener that uses ResourceResolverFactory is not classified as asset-manager', () => {
  const text = 'class X implements ResourceChangeListener { @Reference ResourceResolverFactory rrf; }';
  const hit = RULES.find((r) => r.test('X.java', text));
  assert.strictEqual(hit.pattern, 'resource-change-listener');
});

test('parseBundleDiagnosticReport reads Active state even when the report mentions a reference not found', () => {
  const report = 'Bundle com.acme.core\nState: ACTIVE\n  reference com.foo.Bar not found (optional)';
  const r = parseBundleDiagnosticReport(report);
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.bundle_state, 'Active');
});

test('parseBundleDiagnosticReport does not read a component State: as the bundle state', () => {
  const report = 'Bundle com.acme.core\n\nDeclarative Services Components\nComponent: com.acme.Comp\n  State: RESOLVED';
  const r = parseBundleDiagnosticReport(report);
  assert.notStrictEqual(r.bundle_state, 'Resolved');
});

test('toClassEntry surfaces restricted in checks on a restricted pass', () => {
  const cls = toClassEntry({
    pattern: 'scheduler',
    result: 'pass',
    bundle_state: 'Active',
    component_state: 'Active',
    restricted: true,
    restricted_reason: 'scheduler DS properties not exposed by diagnose-osgi-bundle',
  });
  assert.strictEqual(cls.result, 'pass');
  assert.strictEqual(cls.checks.restricted, true);
  assert.match(cls.checks.restricted_reason, /scheduler DS properties/);
});

test('classifyDialog distinguishes classic, coral 2, and coral 3 by field type', () => {
  assert.strictEqual(classifyDialog('<n xtype="textfield"/>'), 'classic');
  assert.strictEqual(classifyDialog('<n sling:resourceType="granite/ui/components/foundation/form/textfield"/>'), 'coral2');
  assert.strictEqual(classifyDialog('<n sling:resourceType="granite/ui/components/coral/foundation/form/textfield"/>'), 'coral3');
  // Shared Touch UI dialog root alone is not a Coral 2 signal.
  assert.strictEqual(classifyDialog('<n sling:resourceType="cq/gui/components/authoring/dialog"/>'), 'other');
});

test('clearDiagnosisMap removes a stale default map', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-map-'));
  fs.mkdirSync(path.join(root, '.validate-migration'), { recursive: true });
  const mapPath = path.join(root, '.validate-migration', 'diagnosis-map.json');
  fs.writeFileSync(mapPath, '{"com.acme.core":"x"}');
  clearDiagnosisMap(root);
  assert.strictEqual(fs.existsSync(mapPath), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('legacy-ui plan rule requires a path boundary (confirmdialog.xml does not match)', () => {
  const rule = RULES.find((r) => r.pattern === 'legacy-ui');
  assert.strictEqual(rule.test('apps/x/comp/_cq_dialog/.content.xml'), true);
  assert.strictEqual(rule.test('apps/x/comp/dialog.xml'), true);
  assert.strictEqual(rule.test('apps/x/clientlibs/confirmdialog.xml'), false);
  assert.strictEqual(rule.test('apps/x/custom-dialog.xml'), false);
});


