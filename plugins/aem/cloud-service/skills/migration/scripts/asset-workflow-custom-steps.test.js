'use strict';
// Branch H: read-only review of the custom Java steps that stay in migrated asset workflows.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs'); const os = require('os'); const path = require('path');
const S = require('./asset-workflow-custom-steps.js');
const I = require('./asset-workflow-inventory.js');
const R = require('./asset-workflow-report.js');
const RUN = require('./asset-workflow-run.js');
const T = require('./fixtures/asset-workflow.js');
const J = require('./fixtures/asset-workflow-java.js');

const withTmp = fn => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'awcs-')); try { return fn(d); } finally { fs.rmSync(d, { recursive: true, force: true }); } };
const PKG = 'com.example.wfmin.core.workflow';
const byStep = (review, short) => review.steps.find(s => s.shortName === short);
const kinds = c => [...new Set(c.signals.map(s => s.kind))].sort();
const javaClass = body => `package x;\npublic class A {\n${body}\n}\n`;

function treeHash(dir) {
  const h = crypto.createHash('sha256');
  for (const f of T.listFiles(dir).sort()) h.update(f).update(fs.readFileSync(path.join(dir, f)));
  return h.digest('hex');
}

// ── classifySource ────────────────────────────────────────────────────

test('custom steps: rendition writes and image work → processing profile or custom worker', () => {
  for (const body of ['asset.addRendition("x", in, "image/png");', 'RenditionMaker maker;', 'Layer l = new Layer(in);', 'import com.day.cq.gfx.Gfx;', 'AssetHandler h;']) {
    assert.strictEqual(S.classifySource(javaClass(body)).outcome, 'processing-profile-or-worker', body);
  }
});

test('custom steps: shelling out → custom worker', () => {
  for (const body of ['Runtime.getRuntime().exec("convert");', 'new ProcessBuilder("convert").start();', 'import com.day.cq.dam.core.process.CommandLineProcess;', 'import org.apache.commons.exec.CommandLine;']) {
    assert.strictEqual(S.classifySource(javaClass(body)).outcome, 'custom-worker', body);
  }
});

test('custom steps: original binary or local filesystem → manual review', () => {
  for (const body of ['InputStream in = asset.getOriginal().getStream();', 'Rendition o = asset.getOriginal();\nInputStream in = o.getStream();', 'File t = File.createTempFile("a", "b");', 'import java.io.FileOutputStream;', 'Path p = Files.createTempDirectory("x");']) {
    assert.strictEqual(S.classifySource(javaClass(body)).outcome, 'manual-review', body);
  }
});

test('custom steps: APIs a Branch B pattern covers → hand off to that pattern', () => {
  const am = S.classifySource(`import com.day.cq.dam.api.AssetManager;\n${javaClass('AssetManager m;')}`);
  assert.strictEqual(am.outcome, 'pattern-handoff');
  assert.deepStrictEqual(am.handoffs.map(h => [h.id, h.pattern]), [['asset-manager', 'assetApi']]);
  const rep = S.classifySource(`import com.day.cq.replication.Replicator;\nimport org.apache.felix.scr.annotations.Component;\n${javaClass('Replicator r;')}`);
  assert.deepStrictEqual(rep.handoffs.map(h => h.id), ['replication', 'scr-to-osgi-ds']);
  assert.strictEqual(S.classifySource(`import com.adobe.granite.asset.api.AssetManager;\n${javaClass('AssetManager m;')}`).outcome, 'keep-post-processing', 'the Granite AssetManager is the supported API');
});

test('custom steps: nothing found → keep as a post-processing step; comments are ignored', () => {
  const r = S.classifySource(javaClass('/* Runtime.getRuntime().exec("x") */\n// asset.addRendition(x)\nString s = "a";'));
  assert.strictEqual(r.outcome, 'keep-post-processing');
  assert.deepStrictEqual(r.signals, []);
});

test('custom steps: the strongest outcome wins; every signal and hand-off is still listed with its line', () => {
  const r = S.classifySource(`import com.day.cq.replication.Replicator;\n${javaClass('void a() { new ProcessBuilder("x"); asset.addRendition("r", in, "t"); }')}`);
  assert.strictEqual(r.outcome, 'processing-profile-or-worker');
  assert.deepStrictEqual(kinds(r), ['renditions', 'shell']);
  assert.deepStrictEqual(r.handoffs.map(h => h.id), ['replication']);
  assert.ok(r.signals.every(s => Number.isInteger(s.line) && s.line > 1), JSON.stringify(r.signals));
});

// ── resolveStepClass ──────────────────────────────────────────────────

test('custom steps: resolves PROCESS by class name, nested classes to the outer file', () => withTmp(d => {
  J.writeJavaSources(d);
  const files = S.findJavaSources(d);
  const r = S.resolveStepClass(`${PKG}.WatermarkProcess`, files, d);
  assert.deepStrictEqual([r.resolved, r.by, r.file], [true, 'class', 'core/src/main/java/com/example/wfmin/core/workflow/WatermarkProcess.java']);
  assert.strictEqual(S.resolveStepClass(`${PKG}.WatermarkProcess$Inner`, files, d).file, r.file);
}));

test('custom steps: falls back to the process.label property (DS and SCR annotations)', () => withTmp(d => {
  J.writeJavaSources(d);
  const files = S.findJavaSources(d);
  const ds = S.resolveStepClass('Tag by folder', files, d);
  assert.deepStrictEqual([ds.resolved, ds.by, path.basename(ds.file)], [true, 'process.label', 'TagByFolderProcess.java']);
  assert.strictEqual(path.basename(S.resolveStepClass('Auto publish', files, d).file), 'AutoPublishProcess.java');
}));

test('custom steps: missing or ambiguous classes are unresolved, never guessed', () => withTmp(d => {
  J.writeJavaSources(d);
  const dup = 'other/src/main/java/com/example/wfmin/core/workflow/WatermarkProcess.java';
  J.writeJavaSources(d, { [dup]: J.JAVA_FILES[`core/src/main/java/com/example/wfmin/core/workflow/WatermarkProcess.java`] });
  const files = S.findJavaSources(d);
  const amb = S.resolveStepClass(`${PKG}.WatermarkProcess`, files, d);
  assert.strictEqual(amb.resolved, false);
  assert.strictEqual(amb.candidates.length, 2);
  assert.match(amb.reason, /ambiguous/);
  const label = S.resolveStepClass('Watermark renditions', files, d);
  assert.strictEqual(label.resolved, false, 'two classes carry the label');
  const none = S.resolveStepClass('com.acme.NotHere', files, d);
  assert.deepStrictEqual([none.resolved, none.candidates], [false, []]);
  assert.match(none.reason, /not found/);
}));

test('custom steps: only src/main/java is searched; target and node_modules are skipped', () => withTmp(d => {
  J.writeJavaSources(d, {
    'core/target/generated/src/main/java/a/B.java': 'package a; class B {}',
    'core/src/test/java/a/C.java': 'package a; class C {}',
    'node_modules/x/src/main/java/a/D.java': 'package a; class D {}',
    'core/src/main/java/a/E.java': 'package a; class E {}',
  });
  assert.deepStrictEqual(S.findJavaSources(d).map(f => path.relative(d, f).split(path.sep).join('/')), ['core/src/main/java/a/E.java']);
}));

// ── reviewCustomSteps on the fixture project ──────────────────────────

test('custom steps: reviews every kept custom step of the affected workflows, read-only', () => withTmp(d => {
  T.materializeProject(d); J.writeJavaSources(d);
  const before = treeHash(d);
  const review = S.reviewCustomSteps(I.buildInventory(d), d);
  assert.strictEqual(treeHash(d), before, 'the review must not change the project');
  assert.deepStrictEqual(review.steps.map(s => s.shortName).sort(), ['AutoPublishProcess', 'TagByFolderProcess', 'WatermarkProcess']);

  const wm = byStep(review, 'WatermarkProcess');
  assert.strictEqual(wm.outcome, 'processing-profile-or-worker');
  assert.deepStrictEqual(kinds(wm), ['binary', 'renditions']);
  assert.deepStrictEqual(wm.usedIn.map(u => u.model), ['/conf/global/settings/workflow/models/dam/update_asset']);

  const tag = byStep(review, 'TagByFolderProcess');
  assert.strictEqual(tag.outcome, 'keep-post-processing');
  assert.ok(tag.usedIn[0].inSplit, 'the step sits inside an OR split');
  assert.deepStrictEqual(tag.helpers, ['core/src/main/java/com/example/wfmin/core/util/FolderTags.java']);

  const pub = byStep(review, 'AutoPublishProcess');
  assert.strictEqual(pub.outcome, 'pattern-handoff');
  assert.deepStrictEqual(pub.handoffs.map(h => h.id), ['replication', 'scr-to-osgi-ds']);
  assert.ok(review.scope && /helpers/.test(review.scope));
  assert.deepStrictEqual(review.counts, { 'processing-profile-or-worker': 1, 'keep-post-processing': 1, 'pattern-handoff': 1 });
}));

test('custom steps: without the sources every custom step is unresolved', () => {
  const review = S.reviewCustomSteps(I.buildInventory(T.PROJECT), T.PROJECT);
  assert.strictEqual(review.steps.length, 3);
  for (const s of review.steps) assert.deepStrictEqual([s.outcome, s.source, s.signals], ['unresolved', null, []], s.shortName);
});

// ── run + report ──────────────────────────────────────────────────────

test('custom steps: the dry run, the result JSON and the report carry the review', () => withTmp(d => {
  const root = path.join(d, 'project');
  T.materializeProject(root); J.writeJavaSources(root);
  const dry = RUN.migrate(RUN.parseArgs([root, '--dry-run', '--report-dir', path.join(d, 'dry')]));
  assert.strictEqual(byStep(dry.customSteps, 'WatermarkProcess').outcome, 'processing-profile-or-worker');
  const lines = [];
  RUN.main([root, '--dry-run', '--report-dir', path.join(d, 'dry')], l => lines.push(l));
  assert.match(lines.join('\n'), /Custom Java steps: 3[\s\S]*WatermarkProcess → processing-profile-or-worker/);

  const after = path.join(d, 'after');
  T.copyDir(root, after); T.materializeToolOutput(after);
  const reportDir = path.join(d, 'report');
  RUN.migrate(RUN.parseArgs([after, '--verify-only', '--baseline', root, '--acknowledge', 'CommandLineProcess,/var/workflow/models/wfmin-legacy', '--report-dir', reportDir]));
  const json = JSON.parse(fs.readFileSync(path.join(reportDir, 'asset-workflow-result.json'), 'utf8'));
  assert.strictEqual(byStep(json.customSteps, 'AutoPublishProcess').outcome, 'pattern-handoff');
  const md = fs.readFileSync(path.join(reportDir, 'asset-workflow-report.md'), 'utf8');
  assert.match(md, /## Custom Java steps/);
  assert.match(md, /\| `AutoPublishProcess` \|.*pattern-handoff/);
  assert.match(md, /replication/);
  assert.match(md, /Custom Java steps reviewed \| 3 \(2 need action\)/);
}));

test('custom steps: the report section is left out when there are no custom steps', () => {
  const md = R.renderReport({ pre: null, post: null, followUps: null, verify: { ok: true, failures: [], warnings: [] }, tool: { skipped: true }, customSteps: { steps: [] } });
  assert.doesNotMatch(md, /## Custom Java steps/);
});
