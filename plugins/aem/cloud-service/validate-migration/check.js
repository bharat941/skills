#!/usr/bin/env node
'use strict';

/**
 * validate-migration check — verify one or more migrated patterns on the customer's local Cloud SDK.
 *
 *   validate-migration check                                 (auto: diff branch vs main, verify what changed)
 *   validate-migration check <pattern>                       (manual: verify one pattern, flags auto-resolved)
 *   validate-migration check <pattern> --finding <id> --project-id <pid> --project <dir>
 *
 * Auto mode diffs the current branch against `main`/`origin/main` (see plan.js),
 * classifies changed files into supported patterns, and runs each as its own
 * build → deploy → verify task — aggregated into one outcome + one MCP payload.
 *
 * Config, all optional (never persisted to disk):
 *   AEM_SDK_URL      SDK base URL (default http://localhost:4502)
 *   AEM_SDK_USER     SDK admin user (default 'admin' — warns if used against a non-local URL)
 *   AEM_SDK_PASS     SDK admin password (default 'admin' — warns if used against a non-local URL)
 *   --sdk / --user / --password    CLI overrides
 *
 * Reads <cwd>/.validate-migration/context.json for projectId + pendingFindings (written by the
 * analyze / migration skill), and <cwd>/pom.xml as the default project root.
 *
 * Pipeline (per task): build → discover class → deploy → verify → emit outcome via MCP.
 * Exits 0 pass, 1 fail. Never modifies customer code.
 */
if (typeof fetch !== 'function' || typeof FormData !== 'function' || typeof Blob !== 'function') {
  console.error('[validate-migration] Node 18+ required (needs global fetch / FormData / Blob).');
  process.exit(2);
}

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { build } = require('./build.js');
const { deploy } = require('./deploy.js');
const { FAILURE_CLASSES } = require('./failure-classes.js');
const { computeValidationPlan } = require('./plan.js');

// Each pattern entry defines how to find its migrated class in a built jar
// (`discover`) and how to check the runtime contract on the SDK (`verify`).
const PATTERNS = {
  scheduler: {
    describe: 'Sling Scheduler (Cloud Service contract)',
    discover: (jar, args) => {
      // If the caller pinned a class, take it verbatim.
      if (args && args.fqcn) return { fqcn: args.fqcn };
      // Otherwise match any DS descriptor with scheduler.expression. Prefer the
      // one that ALSO declares scheduler.runOn (the migrated one).
      const candidates = [];
      for (const [fname, xml] of jarDsDescriptors(jar)) {
        if (!/property\s+name="scheduler\.expression"/.test(xml)) continue;
        const nm = xml.match(/<scr:component[^>]*name="([^"]+)"/) || xml.match(/name="([^"]+)"/);
        const hasRunOn = /property\s+name="scheduler\.runOn"/.test(xml);
        candidates.push({ fqcn: nm ? nm[1] : path.basename(fname, '.xml'), hasRunOn });
      }
      if (candidates.length === 0) return null;
      const migrated = candidates.find((c) => c.hasRunOn);
      if (!migrated && candidates.length > 1) {
        console.log(`  note: ${candidates.length} scheduler classes in jar, none declare scheduler.runOn; picking ${candidates[0].fqcn} — pass --fqcn to override`);
      }
      return { fqcn: (migrated || candidates[0]).fqcn };
    },
    async verify({ bundleBSN, discovered, args }) {
      const fqcn = discovered.fqcn;

      // 1. bundle + component state — both from the MCP diagnose-osgi-bundle tool
      const diagnosis = await getBundleDiagnosis({ bundleBSN, args });
      if (!diagnosis.available) return mcpUnavailableOutcome(bundleBSN);
      if (!diagnosis.found) {
        return { result: 'fail', failure_class: FAILURE_CLASSES.BUNDLE_NOT_INSTALLED, bundle_state: diagnosis.bundle_state, component_state: 'Unknown', evidence: `bundle ${bundleBSN} not found on SDK` };
      }
      if (diagnosis.bundle_state !== 'Active') {
        return { result: 'fail', failure_class: FAILURE_CLASSES.BUNDLE_NOT_ACTIVE, bundle_state: diagnosis.bundle_state, component_state: 'Unknown', evidence: `bundle state=${diagnosis.bundle_state}` };
      }
      const bundle_state = diagnosis.bundle_state;

      const compFromMcp = diagnosis.components.get(fqcn);
      if (!compFromMcp) {
        return { result: 'fail', failure_class: FAILURE_CLASSES.COMPONENT_UNSATISFIED, bundle_state, component_state: 'Unknown', evidence: `component ${fqcn} not present in MCP diagnose-osgi-bundle report` };
      }
      const component_state = compFromMcp.state || 'Unknown';

      if (component_state !== 'Active') {
        return {
          result: 'fail',
          failure_class: FAILURE_CLASSES.ACTIVATION_ERROR,
          bundle_state,
          component_state,
          evidence: `component_state=${component_state}`,
        };
      }

      // Contract properties (scheduler.expression, scheduler.runOn, etc.) are
      // not exposed by diagnose-osgi-bundle today. Report as restricted so the
      // agent knows the bundle+component check passed but the DS-property
      // contract could not be verified. Track as an MCP feature request.
      return {
        result: 'pass',
        bundle_state,
        component_state: 'Active',
        restricted: true,
        restricted_reason: 'scheduler DS properties not exposed by diagnose-osgi-bundle',
      };
    },
  },

  'asset-manager': {
    describe: 'AssetManager → ResourceResolver (Cloud Service asset ops)',
    discover: (jar, args) => {
      // Legacy code imports com.day.cq.dam.api.AssetManager. Migrated code
      // uses ResourceResolver.delete/adaptTo(Asset.class) via the resolver
      // factory. Discovery = the bundle-level manifest check + any DS
      // component with `sling.resource.type` or a service that references
      // ResourceResolverFactory. If the caller pinned a class, take it.
      if (args && args.fqcn) return { fqcn: args.fqcn };
      for (const [fname, xml] of jarDsDescriptors(jar)) {
        if (!/reference\s+[^>]*interface="org\.apache\.sling\.api\.resource\.ResourceResolverFactory"/.test(xml)) continue;
        const nm = xml.match(/<scr:component[^>]*name="([^"]+)"/) || xml.match(/name="([^"]+)"/);
        if (nm) return { fqcn: nm[1], manifestImportsLegacyDam: manifestImportsLegacyDam(jar) };
      }
      return { fqcn: null, manifestImportsLegacyDam: manifestImportsLegacyDam(jar) };
    },
    async verify({ bundleBSN, discovered, args }) {
      // 1. bundle + component state from MCP diagnose-osgi-bundle
      const diagnosis = await getBundleDiagnosis({ bundleBSN, args });
      if (!diagnosis.available) return mcpUnavailableOutcome(bundleBSN);
      if (!diagnosis.found) return { result: 'fail', failure_class: FAILURE_CLASSES.BUNDLE_NOT_INSTALLED, bundle_state: diagnosis.bundle_state, component_state: 'Unknown', evidence: `bundle ${bundleBSN} not on SDK` };
      if (diagnosis.bundle_state !== 'Active') return { result: 'fail', failure_class: FAILURE_CLASSES.BUNDLE_NOT_ACTIVE, bundle_state: diagnosis.bundle_state, component_state: 'Unknown', evidence: `bundle state=${diagnosis.bundle_state}` };

      // Manifest headers are read offline from the built artifact — not from
      // the SDK — so this stays MCP-independent.
      if (discovered.manifestImportsLegacyDam) {
        return {
          result: 'fail',
          failure_class: FAILURE_CLASSES.CONTRACT_MISMATCH,
          bundle_state: 'Active', component_state: 'Active',
          evidence: 'bundle still imports com.day.cq.dam.api.AssetManager — migration incomplete',
        };
      }

      const compFromMcp = discovered.fqcn ? diagnosis.components.get(discovered.fqcn) : null;
      if (discovered.fqcn && !compFromMcp) return { result: 'fail', failure_class: FAILURE_CLASSES.COMPONENT_UNSATISFIED, bundle_state: 'Active', component_state: 'Unknown', evidence: `component ${discovered.fqcn} not present in MCP diagnose-osgi-bundle report` };
      const compState = (compFromMcp && compFromMcp.state) || 'Unknown';

      // Satisfied is fine for a service-only component that nothing has activated yet.
      if (compFromMcp && compState !== 'Active' && compState !== 'Satisfied') {
        return {
          result: 'fail',
          failure_class: FAILURE_CLASSES.ACTIVATION_ERROR,
          bundle_state: 'Active', component_state: compState,
          evidence: `component_state=${compState}`,
        };
      }

      return { result: 'pass', bundle_state: 'Active', component_state: compFromMcp ? compState : 'Active', checks: { imports_legacy_dam: false } };
    },
  },

  'event-migration': {
    describe: 'OSGi EventHandler → Sling JobConsumer',
    discover: (jar, args) => {
      // Migrated code declares a JobConsumer with job.topics property.
      if (args && args.fqcn) return { fqcn: args.fqcn };
      for (const [fname, xml] of jarDsDescriptors(jar)) {
        if (!/property\s+name="job\.topics"/.test(xml)) continue;
        const nm = xml.match(/<scr:component[^>]*name="([^"]+)"/) || xml.match(/name="([^"]+)"/);
        const topic = (xml.match(/property\s+name="job\.topics"[^>]*value="([^"]+)"/) || [])[1];
        if (nm) return { fqcn: nm[1], topic: topic || null };
      }
      return null;
    },
    async verify({ bundleBSN, discovered, args }) {
      // 1. bundle + component state from MCP diagnose-osgi-bundle
      const diagnosis = await getBundleDiagnosis({ bundleBSN, args });
      if (!diagnosis.available) return mcpUnavailableOutcome(bundleBSN);
      if (!diagnosis.found) return { result: 'fail', failure_class: FAILURE_CLASSES.BUNDLE_NOT_INSTALLED, bundle_state: diagnosis.bundle_state, component_state: 'Unknown', evidence: `bundle ${bundleBSN} not on SDK` };
      if (diagnosis.bundle_state !== 'Active') return { result: 'fail', failure_class: FAILURE_CLASSES.BUNDLE_NOT_ACTIVE, bundle_state: diagnosis.bundle_state, component_state: 'Unknown', evidence: `bundle state=${diagnosis.bundle_state}` };

      const compFromMcp = diagnosis.components.get(discovered.fqcn);
      if (!compFromMcp) return { result: 'fail', failure_class: FAILURE_CLASSES.COMPONENT_UNSATISFIED, bundle_state: 'Active', component_state: 'Unknown', evidence: `component ${discovered.fqcn} not present in MCP diagnose-osgi-bundle report` };
      const compState = compFromMcp.state || 'Unknown';
      if (compState !== 'Active') {
        return {
          result: 'fail',
          failure_class: FAILURE_CLASSES.ACTIVATION_ERROR,
          bundle_state: 'Active', component_state: compState,
          evidence: `component_state=${compState}`,
        };
      }

      // job.topics is read at discovery time from the built DS descriptor
      // (offline), so no Felix property lookup is needed.
      if (!discovered.topic) {
        return {
          result: 'fail',
          failure_class: FAILURE_CLASSES.CONTRACT_MISMATCH,
          bundle_state: 'Active', component_state: 'Active',
          evidence: 'JobConsumer contract missing job.topics property in DS descriptor',
        };
      }
      return { result: 'pass', bundle_state: 'Active', component_state: 'Active', checks: { topic: discovered.topic } };
    },
  },

  replication: {
    describe: 'CQ Replicator / Sling Replicator → Sling Distribution API',
    discover: (jar, args) => {
      // Discovery on manifest: bundle imports org.apache.sling.distribution
      // (migrated) and NOT com.day.cq.replication (legacy). Class detection
      // is optional; we verify at the bundle level.
      if (args && args.fqcn) return { fqcn: args.fqcn };
      const manifest = readJarManifest(jar);
      const importsDistribution = /Import-Package:[\s\S]*org\.apache\.sling\.distribution/.test(manifest);
      const importsLegacy = /Import-Package:[\s\S]*com\.day\.cq\.replication/.test(manifest);
      return { importsDistribution, importsLegacy, fqcn: null };
    },
    async verify({ bundleBSN, discovered, args }) {
      // Bundle state via MCP. Manifest headers are inspected offline from the
      // built artifact (see discover); the Distributor service list is not
      // exposed by diagnose-osgi-bundle today — tracked as a restricted check.
      const diagnosis = await getBundleDiagnosis({ bundleBSN, args });
      if (!diagnosis.available) return mcpUnavailableOutcome(bundleBSN);
      if (!diagnosis.found) return { result: 'fail', failure_class: FAILURE_CLASSES.BUNDLE_NOT_INSTALLED, bundle_state: diagnosis.bundle_state, component_state: 'Unknown', evidence: `bundle ${bundleBSN} not on SDK` };
      if (diagnosis.bundle_state !== 'Active') return { result: 'fail', failure_class: FAILURE_CLASSES.BUNDLE_NOT_ACTIVE, bundle_state: diagnosis.bundle_state, component_state: 'Unknown', evidence: `bundle state=${diagnosis.bundle_state}` };

      if (discovered.importsLegacy) {
        return {
          result: 'fail',
          failure_class: FAILURE_CLASSES.CONTRACT_MISMATCH,
          bundle_state: 'Active', component_state: 'Active',
          evidence: 'bundle still imports com.day.cq.replication — migration incomplete',
        };
      }
      if (!discovered.importsDistribution) {
        return {
          result: 'fail',
          failure_class: FAILURE_CLASSES.CONTRACT_MISMATCH,
          bundle_state: 'Active', component_state: 'Active',
          evidence: 'bundle does not import org.apache.sling.distribution — migration incomplete',
        };
      }

      return {
        result: 'pass',
        bundle_state: 'Active', component_state: 'Active',
        restricted: true,
        restricted_reason: 'Distributor service registration not exposed by diagnose-osgi-bundle',
        checks: { imports_distribution: true, imports_legacy: false },
      };
    },
  },

  'legacy-ui': {
    describe: 'Classic UI / Coral 2 dialogs → Coral 3 (offline source check)',
    mode: 'source-only',
    discover: (jar) => {
      // Content packages (.zip via maven-bundle-plugin) put dialog XMLs under
      // /jcr_root/apps/**/cq:dialog/.content.xml. Bundles that embed content
      // also carry them at the same path or under jcr_root/.
      const listing = execFileSync('unzip', ['-l', jar], { encoding: 'utf8' });
      const dialogs = [];
      for (const line of listing.split('\n')) {
        const m = line.match(/(jcr_root\/.*?\/(_cq_dialog|cq:dialog)\/\.content\.xml)$/);
        if (m) dialogs.push(m[1]);
      }
      return dialogs.length ? { dialogs } : null;
    },
    async verify({ artifactPath, discovered }) {
      const classic = [];
      const coral2 = [];
      const coral3 = [];
      for (const p of discovered.dialogs) {
        const xml = execFileSync('unzip', ['-p', artifactPath, p], { encoding: 'utf8' });
        if (/\bxtype\s*=\s*"/.test(xml)) classic.push(p);
        else if (/sling:resourceType\s*=\s*"cq\/gui\/components\/authoring\/dialog/.test(xml)) coral2.push(p);
        else if (/sling:resourceType\s*=\s*"granite\/ui\/components\/coral\/foundation/.test(xml)) coral3.push(p);
      }
      const bad = classic.length + coral2.length;
      if (bad > 0) {
        return {
          result: 'fail',
          failure_class: FAILURE_CLASSES.SOURCE_CONTRACT_MISMATCH,
          bundle_state: null, component_state: null,
          evidence: `${classic.length} Classic UI + ${coral2.length} Coral 2 dialogs remain (Coral 3 ok: ${coral3.length})`,
          checks: { dialogs_total: discovered.dialogs.length, classic: classic.length, coral2: coral2.length, coral3: coral3.length },
        };
      }
      return {
        result: 'pass',
        bundle_state: null, component_state: null,
        checks: { dialogs_total: discovered.dialogs.length, coral3: coral3.length },
      };
    },
  },
};

// Wall-clock start of this run, captured in main(), used for started_at on
// every outcome so run duration is honest.
let RUN_STARTED_AT = null;

async function main() {
  RUN_STARTED_AT = new Date().toISOString();
  const args = parseArgs(process.argv.slice(2));
  if (args.pattern && !PATTERNS[args.pattern]) fatal(`unknown pattern: ${args.pattern}\nsupported: ${Object.keys(PATTERNS).join(', ')}`);

  const stage = args.stage || 'all'; // 'prepare' | 'verify' | 'all'
  if (!['prepare', 'verify', 'all'].includes(stage)) {
    fatal(`unknown --stage: ${stage}. Use one of: prepare, verify, all.`);
  }

  const setup = readSdkCreds(args);
  const context = readContext();

  // Local validation does not require a CAM project-id. When one is available
  // (either --project-id or auto-loaded from .validate-migration/context.json),
  // we emit the report-migration-outcome payload; otherwise we skip that reporting
  // step and just print the local outcome.
  if (!args['project-id'] && context.projectId) {
    args['project-id'] = context.projectId;
    console.log(`(auto) project-id = ${args['project-id']}`);
  }

  const cwd = args.project || process.cwd();
  const statePath = path.join(cwd, '.validate-migration', 'state.json');

  // ---- stage: verify (consume persisted state + agent-supplied MCP diagnosis) ----
  if (stage === 'verify') {
    if (!fs.existsSync(statePath)) {
      fatal(`no ${path.relative(cwd, statePath)} found. Run --stage prepare first.`);
    }
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    RUN_STARTED_AT = state.started_at || RUN_STARTED_AT;
    const records = [];
    for (const t of state.prepared) {
      records.push(await verifyPreparedTask(t, args));
    }
    return finishAll(records, args);
  }

  // ---- stage: prepare | all ----
  // Resolve tasks: either the pattern the caller pinned, or an auto-detected
  // set from diffing the branch against main (plan.js).
  let tasks;
  if (args.pattern) {
    if (!args.project && !args.jar) {
      if (fs.existsSync(path.join(process.cwd(), 'pom.xml'))) {
        args.project = process.cwd();
        console.log(`(auto) project    = ${args.project}`);
      } else {
        fatal('no --project or --jar and current directory has no pom.xml — cd into your project or pass --project <dir>');
      }
    }
    tasks = [{ module: args.project, jar: args.jar, pattern: args.pattern, fqcn: args.fqcn }];
  } else {
    const plan = computeValidationPlan({ cwd, baseRef: args.base });
    if (plan.error) fatal(`could not auto-detect what to verify: ${plan.error} — pass --pattern <name> to run one pattern manually`);
    if (plan.tasks.length === 0) {
      console.log(`[validate-migration] no validate-migration-relevant changes vs ${plan.baseRef} — nothing to verify.`);
      process.exit(0);
    }
    console.log(`[validate-migration] auto-detected ${plan.tasks.length} task(s) from diff vs ${plan.baseRef}:`);
    for (const t of plan.tasks) console.log(`  • ${t.pattern} — ${path.relative(cwd, t.module) || '.'} (${t.files.length} file(s) changed)`);
    tasks = plan.tasks;
  }

  const anyNeedsSdk = tasks.some((t) => PATTERNS[t.pattern].mode !== 'source-only');
  const sdkUrl = anyNeedsSdk ? await resolveSdkUrl(args) : null;
  if (anyNeedsSdk && !sdkUrl) {
    fatal('no running SDK found on ports 4502 / 4602 / 4503. Start your local Cloud SDK, or set AEM_SDK_URL / pass --sdk <url>.');
  }
  const { user, password } = validateCreds(setup, sdkUrl);

  const prepared = [];
  for (const task of tasks) {
    const p = await prepareTask(task, { sdkUrl, user, password });
    prepared.push(p);
  }

  // Persist prepared state so `--stage verify` (potentially re-invoked after
  // the agent gathers MCP diagnosis) doesn't have to rebuild + redeploy.
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ started_at: RUN_STARTED_AT, prepared }, null, 2));

  if (stage === 'prepare') {
    console.log(`\n[validate-migration] prepare complete. ${prepared.length} task(s) staged.`);
    const bsns = [...new Set(prepared.map((p) => p.symbolicName).filter(Boolean))];
    if (bsns.length) {
      console.log('Have the coding assistant call the AEM Quickstart MCP tool `diagnose-osgi-bundle` for each of these bundles:');
      for (const b of bsns) console.log(`  - ${b}`);
      console.log(`then write the raw tool outputs to ${path.relative(cwd, path.join(cwd, '.validate-migration', 'diagnosis-map.json'))} as a { "<BSN>": "<raw text>" } map,`);
      console.log('and finally re-run:  node ../../validate-migration/check.js --stage verify');
    }
    process.exit(0);
  }

  // stage === 'all': continue straight into verify. Give DS a moment to
  // settle after deploy so component activation is observable.
  if (prepared.some((p) => p.mode === 'bundle-runtime' && !p.failure)) {
    await sleep(3000);
  }
  const records = [];
  for (const t of prepared) {
    records.push(await verifyPreparedTask(t, args));
  }
  return finishAll(records, args);
}

// prepareTask: build → discover → (source-only verify | deploy). Returns a
// serializable record persisted to .validate-migration/state.json and later
// consumed by verifyPreparedTask.
async function prepareTask(task, { sdkUrl, user, password }) {
  const pat = PATTERNS[task.pattern];
  console.log(`\n=== validate-migration prepare · ${task.pattern} ===`);
  console.log(task.jar ? `jar    : ${task.jar}` : `project: ${task.module}`);
  if (pat.mode !== 'source-only') console.log(`sdk    : ${sdkUrl}`);
  console.log(`pattern: ${pat.describe}\n`);

  // 1. build (unless a pre-built jar was supplied)
  let artifactPath;
  if (task.jar) {
    if (!fs.existsSync(task.jar)) {
      return { pattern: task.pattern, module: task.module, jar: task.jar,
        failure: { result: 'fail', failure_class: FAILURE_CLASSES.INPUT_JAR_MISSING, verification_level: 'source-only', evidence: `no file at ${task.jar}` } };
    }
    artifactPath = task.jar;
    console.log(`▸ skip build (using --jar)\n  ok (${path.basename(artifactPath)})\n`);
  } else {
    step('build customer project');
    const b = build({ projectDir: task.module });
    if (!b.ok) {
      return { pattern: task.pattern, module: task.module,
        failure: { result: 'fail', failure_class: FAILURE_CLASSES.BUILD_FAILED, verification_level: 'source-only', evidence: b.log } };
    }
    artifactPath = b.artifactPath;
    console.log(`  ok (${path.basename(artifactPath)}, ${b.elapsedMs}ms)\n`);
  }

  // 2. auto-discover
  step('discover migrated class');
  const discovered = pat.discover(artifactPath, task);
  if (!discovered) {
    return { pattern: task.pattern, module: task.module, artifactPath,
      failure: { result: 'fail', failure_class: FAILURE_CLASSES.DISCOVERY_NO_MATCH, verification_level: 'source-only', evidence: `no DS component in ${artifactPath} matches the ${task.pattern} signature` } };
  }
  console.log(`  ok → ${JSON.stringify(discovered)}\n`);

  // Source-only patterns: no deploy; verify runs off the artifact only.
  if (pat.mode === 'source-only') {
    return { pattern: task.pattern, module: task.module, artifactPath, discovered, mode: 'source-only' };
  }

  // 3. deploy the customer bundle
  step('deploy customer bundle');
  const d = await deploy({ projectDir: task.module, artifactPath, sdkUrl, user, password });
  if (!d.ok) {
    return { pattern: task.pattern, module: task.module, artifactPath, discovered, mode: 'bundle-runtime',
      symbolicName: d.symbolicName || null,
      failure: { result: 'fail', failure_class: FAILURE_CLASSES.DEPLOY_FAILED, verification_level: 'runtime', evidence: d.log,
        ...(d.symbolicName ? { bundle: { symbolic_name: d.symbolicName, state: normalizeBundleState() } } : {}) } };
  }
  console.log(`  ok (bundle ${d.symbolicName}${d.mode ? ' via ' + d.mode : ''})\n`);
  return { pattern: task.pattern, module: task.module, artifactPath, discovered, mode: 'bundle-runtime', symbolicName: d.symbolicName, deployMode: d.mode };
}

// verifyPreparedTask: source-only patterns verify off the artifact; runtime
// patterns require the agent-supplied MCP diagnosis-map.
async function verifyPreparedTask(prepared, args) {
  if (prepared.failure) {
    return { pattern: prepared.pattern, ...prepared.failure, discovered: prepared.discovered };
  }
  const pat = PATTERNS[prepared.pattern];

  if (prepared.mode === 'source-only') {
    step(`source verify · ${prepared.pattern}`);
    const outcome = await pat.verify({ artifactPath: prepared.artifactPath, discovered: prepared.discovered });
    console.log(`  ${outcome.result === 'pass' ? 'ok' : 'FAIL'}${outcome.evidence ? ' — ' + outcome.evidence : ''}\n`);
    return { pattern: prepared.pattern, ...outcome, verification_level: 'source-only', discovered: prepared.discovered };
  }

  step(`runtime verify · ${prepared.pattern}`);
  const outcome = await pat.verify({ bundleBSN: prepared.symbolicName, discovered: prepared.discovered, args });
  console.log(`  ${outcome.result === 'pass' ? 'ok' : 'FAIL'} — bundle=${outcome.bundle_state} component=${outcome.component_state}${outcome.evidence ? '  ' + outcome.evidence : ''}\n`);

  return {
    pattern: prepared.pattern,
    ...outcome,
    verification_level: 'runtime',
    discovered: prepared.discovered,
    bundle: { symbolic_name: prepared.symbolicName, state: normalizeBundleState(outcome.bundle_state) },
  };
}

// ---- helpers ----
function jarDsDescriptors(jarPath) {
  // read all OSGI-INF/*.xml entries via `unzip -p`
  const listing = execFileSync('unzip', ['-l', jarPath], { encoding: 'utf8' });
  const files = [];
  for (const line of listing.split('\n')) {
    const m = line.match(/(OSGI-INF\/[^ ]+\.xml)$/);
    if (m) files.push(m[1]);
  }
  return files.map(f => [f, execFileSync('unzip', ['-p', jarPath, f], { encoding: 'utf8' })]);
}

// Read META-INF/MANIFEST.MF from a jar, unfolding continuation lines.
function readJarManifest(jarPath) {
  try {
    const mf = execFileSync('unzip', ['-p', jarPath, 'META-INF/MANIFEST.MF'], { encoding: 'utf8' });
    return mf.replace(/\r?\n /g, '');
  } catch { return ''; }
}

// Offline check for the legacy DAM API import, read from the built artifact's
// manifest. Used by the asset-manager pattern in place of a Felix bundle
// detail lookup.
function manifestImportsLegacyDam(jarPath) {
  const manifest = readJarManifest(jarPath);
  const importLine = (manifest.match(/Import-Package:\s*([^\n]*)/) || [])[1] || '';
  return /com\.day\.cq\.dam\.api\.AssetManager/.test(importLine);
}

// ---- MCP-based diagnosis (AEM Quickstart MCP server, diagnose-osgi-bundle) ----
// The skill (agent) invokes the `diagnose-osgi-bundle` MCP tool on the
// agent-configured AEM Quickstart MCP server and writes a JSON map
//     { "<Bundle-SymbolicName>": "<raw tool text output>" }
// to `.validate-migration/diagnosis-map.json` (or a path passed via
// `--diagnosis-map <file>`). This script does not speak MCP itself — that is
// the coding-assistant's job.
//
// When a BSN is not in the map, verification for that task fails with
// `setup.mcp_unavailable` and the outcome carries setup guidance. There is no
// silent Felix Web Console fallback.
let diagnosisMap; // undefined = not yet loaded, {} = loaded (may be empty)
const diagnosisCache = new Map(); // BSN -> parsed diagnosis, per run

function loadDiagnosisMap(args) {
  if (diagnosisMap !== undefined) return diagnosisMap;
  const explicit = args && args['diagnosis-map'];
  const candidates = [
    explicit,
    path.join(process.cwd(), '.validate-migration', 'diagnosis-map.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (parsed && typeof parsed === 'object') { diagnosisMap = parsed; return diagnosisMap; }
    } catch { /* try next */ }
  }
  diagnosisMap = {};
  return diagnosisMap;
}

// Returns { bundle_state, found, components: Map<fqcn, {state}>, source, available }.
// `available: false` means the agent has not supplied MCP diagnosis for this
// BSN — callers must fail with SETUP_MCP_UNAVAILABLE + setup guidance.
async function getBundleDiagnosis({ bundleBSN, args }) {
  if (diagnosisCache.has(bundleBSN)) return diagnosisCache.get(bundleBSN);
  const map = loadDiagnosisMap(args);
  const raw = map[bundleBSN];
  if (raw == null) {
    const missing = { available: false };
    diagnosisCache.set(bundleBSN, missing);
    return missing;
  }
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const parsed = parseBundleDiagnosticReport(text);
  parsed.available = true;
  parsed.source = 'mcp';
  diagnosisCache.set(bundleBSN, parsed);
  return parsed;
}

function mcpUnavailableOutcome(bundleBSN) {
  return {
    result: 'fail',
    failure_class: FAILURE_CLASSES.SETUP_MCP_UNAVAILABLE,
    bundle_state: 'Unknown',
    component_state: 'Unknown',
    evidence: `no MCP diagnose-osgi-bundle output for ${bundleBSN}. `
      + `Have the coding assistant call the AEM Quickstart MCP tool `
      + `\`diagnose-osgi-bundle\` for this bundle and write the raw text output `
      + `into .validate-migration/diagnosis-map.json as { "${bundleBSN}": "..." }, `
      + `then re-run \`node ../../validate-migration/check.js --stage verify\`.`,
  };
}

// The diagnostic tool returns free text, not JSON. Unrecognized shapes map to
// 'Unknown' rather than a guessed 'Active', so a parse miss fails safe.
// State is normalized to title case ('Active', 'Installed', 'Resolved') because
// the OSGi runtime and Sling's diagnostic report both use upper case ('ACTIVE'),
// while Felix's JSON and the rest of validate-migration use title case.
function parseBundleDiagnosticReport(text) {
  const components = parseComponentsFromReport(text);
  if (/no such bundle|not found|not installed/i.test(text)) return { bundle_state: 'Unknown', found: false, components };
  const stateLine = text.match(/State:\s*([A-Za-z]+)/);
  if (stateLine) return { bundle_state: normalizeState(stateLine[1]), found: true, components };
  if (/INSTALLED but not RESOLVED/i.test(text)) return { bundle_state: 'Installed', found: true, components };
  if (/\bACTIVE\b/i.test(text) && !/not RESOLVED|not ACTIVE|unsatisfied/i.test(text)) return { bundle_state: 'Active', found: true, components };
  return { bundle_state: 'Unknown', found: true, components };
}

// Parses the `--- Declarative Services Components ---` section of the report
// into a Map<fqcn, {state}>. Only states are exposed today; component
// properties are a documented MCP gap (tracked upstream).
function parseComponentsFromReport(text) {
  const out = new Map();
  const start = text.indexOf('Declarative Services Components');
  if (start === -1) return out;
  const body = text.slice(start);
  const re = /Component:\s*([^\r\n]+)\r?\n\s*State:\s*([A-Za-z]+)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    out.set(m[1].trim(), { state: normalizeState(m[2]) });
  }
  return out;
}

function normalizeState(s) {
  if (!s) return 'Unknown';
  const lc = String(s).toLowerCase();
  return lc.charAt(0).toUpperCase() + lc.slice(1);
}

function step(name) { console.log(`▸ ${name}`); }
function fatal(msg) { console.error(msg); process.exit(2); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Aggregates every task's outcome record into one run, prints it, emits the
// MCP payload once for the whole run, and exits (0 all-pass, 1 any-fail).
function finishAll(records, args) {
  const finishedAt = new Date().toISOString();
  const record = {
    run_id: 'rvc-' + Date.now(),
    started_at: RUN_STARTED_AT || finishedAt,
    finished_at: finishedAt,
    result: records.some((r) => r.result === 'fail') ? 'fail' : 'pass',
    verification_level: records.some((r) => r.verification_level === 'runtime') ? 'runtime' : 'source-only',
    classes: records,
  };
  console.log('=== outcome ===');
  console.log(JSON.stringify(record, null, 2));

  // Emit the report-migration-outcome payload only when a CAM project-id is available.
  // Local validation does not require CAM integration — outcome reporting is
  // optional. The agent reads this delimited block, if present, and invokes
  // the `report-migration-outcome` MCP tool with it.
  if (args && args['project-id']) {
    const payload = buildMcpPayload(record, args);
    console.log('\n=== report-migration-outcome payload ===');
    console.log(JSON.stringify(payload));
    console.log('=== end payload ===');
  }

  process.exit(record.result === 'pass' ? 0 : 1);
}

// ---- SDK config (never persisted to disk) ----
// URL: honors --sdk / AEM_SDK_URL; otherwise probes common local ports so a
// developer never has to configure anything when the SDK is on 4502/4602/4503.
// Credentials: --user/--password / AEM_SDK_USER/AEM_SDK_PASS, default admin/admin.
// admin/admin is refused for any URL that isn't localhost — keeps the default
// safe if someone accidentally points validate-migration at a shared instance.
const COMMON_SDK_PORTS = [4502, 4602, 4503];
const SDK_PROBE_TIMEOUT_MS = 500;

async function resolveSdkUrl(args) {
  const explicit = args.sdk || process.env.AEM_SDK_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  for (const port of COMMON_SDK_PORTS) {
    const url = `http://localhost:${port}`;
    if (await isSdkReachable(url)) {
      console.log(`(auto) SDK       = ${url}`);
      return url;
    }
  }
  return null;
}

async function isSdkReachable(url) {
  try {
    const res = await fetch(`${url}/system/console`, { redirect: 'manual', signal: AbortSignal.timeout(SDK_PROBE_TIMEOUT_MS) });
    return res.status < 500;
  } catch { return false; }
}

function readSdkCreds(args) {
  return {
    user: args.user || process.env.AEM_SDK_USER || 'admin',
    password: args.password || process.env.AEM_SDK_PASS || 'admin',
  };
}

function validateCreds({ user, password }, sdkUrl) {
  const isLocal = !sdkUrl || /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(sdkUrl);
  if (!isLocal && user === 'admin' && password === 'admin') {
    fatal(`refusing to send admin/admin to non-local SDK: ${sdkUrl}. Set AEM_SDK_USER and AEM_SDK_PASS.`);
  }
  return { user, password };
}

// ---- context.json (written by the analyze / migration skill) ----
// Shape: { projectId: string, pendingFindings: [{ id, pattern }] }
function readContext() {
  const ctxPath = path.join(process.cwd(), '.validate-migration', 'context.json');
  if (!fs.existsSync(ctxPath)) return {};
  try { return JSON.parse(fs.readFileSync(ctxPath, 'utf8')); } catch { return {}; }
}

// ---- MCP telemetry ----
const EVIDENCE_MAX = 2048;
const BUNDLE_STATE_ENUM = new Set(['Installed', 'Resolved', 'Active', 'Fragment', 'Unknown']);

function normalizeBundleState(s) {
  if (!s) return 'Unknown';
  const v = String(s);
  return BUNDLE_STATE_ENUM.has(v) ? v : 'Unknown';
}

// Zod expects checks as Record<string, string|number|boolean>. verify() may
// stash nested objects (e.g. `properties`) — flatten one level, drop
// non-scalar values, and replace `.` with `_` in keys (MongoDB rejects
// dots in map keys).
function flattenChecks(checks) {
  if (!checks || typeof checks !== 'object') return undefined;
  const safeKey = (k) => String(k).replace(/\./g, '_');
  const out = {};
  for (const [k, v] of Object.entries(checks)) {
    if (['string', 'number', 'boolean'].includes(typeof v)) out[safeKey(k)] = v;
    else if (v && typeof v === 'object') {
      for (const [k2, v2] of Object.entries(v)) {
        if (['string', 'number', 'boolean'].includes(typeof v2)) out[`${safeKey(k)}_${safeKey(k2)}`] = v2;
      }
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function buildMcpPayload(record, args) {
  const classes = record.classes.map(toClassEntry);
  const bundleEntry = record.classes.find((r) => r.bundle);
  const patterns = [...new Set(record.classes.map((r) => r.pattern).filter(Boolean))];

  const payload = {
    run_id: record.run_id,
    project_id: args['project-id'],
    skill_pattern: args.pattern || patterns.join('+'),
    skill_version: args['skill-version'] || '1.0',
    result: record.result,
    verification_level: record.verification_level,
    started_at: record.started_at,
    finished_at: record.finished_at,
    summary: {
      classes_total: classes.length,
      classes_pass: record.classes.filter((r) => r.result === 'pass').length,
      classes_fail: record.classes.filter((r) => r.result === 'fail').length,
    },
    classes,
  };
  if (bundleEntry) payload.bundle = bundleEntry.bundle;
  if (record.skill_decisions) payload.skill_decisions = record.skill_decisions;
  return stripEmpty(payload);
}

// Builds one `classes[]` entry (report-migration-outcome schema) from one task's outcome.
function toClassEntry(outcome) {
  const className = (outcome.discovered && outcome.discovered.fqcn) || `(${outcome.pattern})`;
  const cls = { class_name: className, result: outcome.result };

  if (outcome.result === 'fail') {
    cls.failure_class = outcome.failure_class || FAILURE_CLASSES.UNKNOWN;
    if (outcome.bundle_state) cls.bundle_state = outcome.bundle_state;
    if (outcome.component_state) cls.component_state = outcome.component_state;
    if (outcome.unsatisfied_references && outcome.unsatisfied_references.length) cls.unsatisfied_references = outcome.unsatisfied_references;
    if (outcome.activation_error) cls.activation_error = outcome.activation_error;
    if (outcome.evidence) cls.evidence = truncate(outcome.evidence, EVIDENCE_MAX);
  } else {
    if (outcome.bundle_state) cls.bundle_state = outcome.bundle_state;
    if (outcome.component_state) cls.component_state = outcome.component_state;
    const checks = flattenChecks(outcome.checks);
    if (checks) cls.checks = checks;
  }
  return stripEmpty(cls);
}

function truncate(s, max) {
  if (typeof s !== 'string' || s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// Strip both undefined and null so optional Zod string fields stay unset
// rather than being sent as null (which Zod's .optional() rejects).
function stripEmpty(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

function parseArgs(argv) {
  const out = {};
  if (argv[0] && !argv[0].startsWith('--')) out.pattern = argv[0];
  const rest = out.pattern ? argv.slice(1) : argv;
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) continue;
    const k = rest[i].replace(/^--/, '');
    out[k] = rest[++i];
  }
  return out;
}

main().catch(e => { console.error(e); process.exit(2); });
