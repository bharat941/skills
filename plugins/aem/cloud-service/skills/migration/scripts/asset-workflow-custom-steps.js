'use strict';
// Branch H: read-only review of the custom Java process steps that wf-migrator keeps in migrated asset
// workflows. Resolves each step's PROCESS value to its class in the workspace and looks for APIs that do not
// belong in a post-processing workflow on AEM as a Cloud Service. Never edits project files.
//
// Scope: the step's own class only. Helpers, base classes and called services are not scanned; the agent
// reads them (see references/asset-workflow/context.md, "Custom Java step review").
const fs = require('fs');
const path = require('path');
const C = require('./asset-workflow-catalog.js');
const I = require('./asset-workflow-inventory.js');

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist']);
const toPosix = p => p.split(path.sep).join('/');
const SCOPE = 'Step class only: helpers, base classes and called services are not scanned. Read the listed helpers before acting.';

// Most to least severe; the first outcome with a signal wins.
const OUTCOMES = [
  {
    id: 'processing-profile-or-worker', kind: 'renditions',
    action: 'Writes renditions or does image work; the asset microservices own renditions on Cloud Service. Move it to a processing-profile rendition or an Asset Compute custom worker, then drop the step.',
    rules: [
      [/\.addRendition\s*\(/, 'addRendition()'],
      [/\bRenditionMaker\b/, 'RenditionMaker'],
      [/\bcom\.day\.image\.Layer\b|\bnew\s+Layer\s*\(/, 'Layer'],
      [/\bcom\.day\.cq\.gfx\b|\bGfx\b/, 'Gfx'],
      [/\bAssetHandler\b/, 'AssetHandler'],
    ],
  },
  {
    id: 'custom-worker', kind: 'shell',
    action: 'Runs an external command, which Cloud Service does not allow. Re-implement it as an Asset Compute custom worker.',
    rules: [
      [/\bRuntime\s*\.\s*getRuntime\s*\(\s*\)\s*\.\s*exec\s*\(/, 'Runtime.exec()'],
      [/\bProcessBuilder\b/, 'ProcessBuilder'],
      [/\bCommandLineProcess\b/, 'CommandLineProcess'],
      [/\borg\.apache\.commons\.exec\b/, 'commons-exec'],
    ],
  },
  {
    id: 'manual-review', kind: 'binary',
    action: 'Reads the original binary or the local filesystem. Review it: avoid loading the binary into memory and local files, or move the binary work to a custom worker.',
    rules: [
      [/\.getOriginal\s*\(\s*\)\s*\.\s*getStream\s*\(/, 'getOriginal().getStream()'],
      [/\bjava\.io\.(?:File|FileInputStream|FileOutputStream|FileReader|FileWriter|RandomAccessFile)\b/, 'java.io.File*'],
      [/\bnew\s+File(?:InputStream|OutputStream|Reader|Writer)?\s*\(/, 'new File…()'],
      [/\bFile\s*\.\s*createTempFile\s*\(/, 'File.createTempFile()'],
      [/\bFiles\s*\.\s*createTemp(?:File|Directory)\s*\(/, 'Files.createTemp…()'],
    ],
  },
];

const HANDOFFS = [
  { id: 'asset-manager', pattern: 'assetApi', guide: 'code-assessment/asset-manager/SKILL.md', re: /\bcom\.day\.cq\.dam\.api\.AssetManager\b|\bimport\s+com\.day\.cq\.dam\.api\.\*\s*;[\s\S]*\bAssetManager\b/ },
  { id: 'replication', pattern: 'replication', guide: 'code-assessment/replication/SKILL.md', re: /\bcom\.day\.cq\.replication\.Replicator\b|\bimport\s+com\.day\.cq\.replication\.\*\s*;[\s\S]*\bReplicator\b/ },
  { id: 'scr-to-osgi-ds', pattern: null, guide: 'code-assessment/references/scr-to-osgi-ds.md', re: /\borg\.apache\.felix\.scr\.annotations\b/ },
];

const ACTIONS = {
  'pattern-handoff': 'Uses APIs a Java migration pattern covers. Fix it with that pattern (Branch B, its own session), then keep it as a post-processing step.',
  'keep-post-processing': 'Nothing blocking found in the class. Keep it as a post-processing step once its helpers are checked.',
  unresolved: 'Source not found in the workspace, so it was not reviewed. Ask where the class lives (another repository or a dependency) and review it there.',
};
for (const o of OUTCOMES) ACTIONS[o.id] = o.action;

// Blanks comments (keeping line breaks and string literals) so commented-out code is not reported.
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i]; const n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2); const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' '); i = stop; continue;
    }
    if (c === '"' || c === '\'') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}

const lineAt = (text, idx) => text.slice(0, idx).split('\n').length;

function classifySource(source) {
  const code = stripComments(source);
  const signals = [];
  for (const o of OUTCOMES) {
    for (const [re, evidence] of o.rules) {
      const m = re.exec(code);
      if (m) signals.push({ kind: o.kind, evidence, line: lineAt(code, m.index) });
    }
  }
  // The original's stream read through a variable: `Rendition o = asset.getOriginal(); o.getStream()`.
  if (!signals.some(s => s.evidence === 'getOriginal().getStream()')) {
    const orig = /\.getOriginal\s*\(\s*\)/.exec(code);
    if (orig && /\.getStream\s*\(/.test(code)) signals.push({ kind: 'binary', evidence: 'getOriginal() + getStream()', line: lineAt(code, orig.index) });
  }
  const handoffs = HANDOFFS.filter(h => h.re.test(code)).map(({ id, pattern, guide }) => ({ id, pattern, guide }));
  const top = OUTCOMES.find(o => signals.some(s => s.kind === o.kind));
  const outcome = top ? top.id : handoffs.length ? 'pattern-handoff' : 'keep-post-processing';
  return { outcome, signals, handoffs };
}

function findJavaSources(root, dir = root, out = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) findJavaSources(root, p, out); } else if (e.isFile() && e.name.endsWith('.java') && toPosix(p).includes('/src/main/java/')) out.push(p);
  }
  return out;
}

const FQCN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const classSuffix = fqcn => `/src/main/java/${fqcn.split('$')[0].replace(/\./g, '/')}.java`;
const LABEL_RES = [
  /"\s*process\.label\s*=\s*([^"]*)"/g,
  /name\s*=\s*"process\.label"\s*,\s*value\s*=\s*\{?\s*"([^"]*)"/g,
  /value\s*=\s*\{?\s*"([^"]*)"\s*\}?\s*,\s*name\s*=\s*"process\.label"/g,
];

function labelsOf(text) {
  const out = [];
  for (const re of LABEL_RES) for (const m of text.matchAll(re)) out.push(m[1].trim());
  return out;
}

function resolveStepClass(process, javaFiles, root) {
  const rel = f => toPosix(path.relative(root, f));
  const found = (file, by) => ({ resolved: true, by, file: rel(file), abs: file, candidates: [] });
  const unresolved = (reason, candidates = []) => ({ resolved: false, by: null, file: null, candidates: candidates.map(rel), reason });

  if (FQCN.test(process)) {
    const hits = javaFiles.filter(f => toPosix(f).endsWith(classSuffix(process)));
    if (hits.length === 1) return found(hits[0], 'class');
    if (hits.length > 1) return unresolved(`ambiguous: ${hits.length} source files match ${process}`, hits);
  }
  const byLabel = javaFiles.filter(f => { try { return labelsOf(fs.readFileSync(f, 'utf8')).includes(process.trim()); } catch { return false; } });
  if (byLabel.length === 1) return found(byLabel[0], 'process.label');
  if (byLabel.length > 1) return unresolved(`ambiguous: ${byLabel.length} classes have process.label "${process}"`, byLabel);
  return unresolved('not found in the workspace (no matching class under src/main/java and no matching process.label)');
}

// Project classes the step imports: the helpers the agent reads next. Same-package classes are not listed.
function projectImports(source, javaFiles, root) {
  const out = [];
  for (const m of stripComments(source).matchAll(/^\s*import\s+([\w.$]+)\s*;/gm)) {
    const hits = javaFiles.filter(f => toPosix(f).endsWith(classSuffix(m[1])));
    if (hits.length === 1) out.push(toPosix(path.relative(root, hits[0])));
  }
  return [...new Set(out)];
}

function reviewCustomSteps(inv, root) {
  root = path.resolve(root || inv.root);
  const javaFiles = findJavaSources(root);
  const byProcess = new Map();
  for (const w of I.affectedWorkflows(inv)) {
    for (const s of w.model.flat.filter(x => x.kind === 'process' && x.category === 'CUSTOM')) {
      if (!byProcess.has(s.process)) byProcess.set(s.process, []);
      byProcess.get(s.process).push({ model: w.model.confPath, step: s.path, title: s.title, inSplit: !!s.split });
    }
  }
  const steps = [];
  for (const [process, usedIn] of byProcess) {
    const res = resolveStepClass(process, javaFiles, root);
    const step = { process, shortName: C.shortName(process), usedIn, source: res.file, resolvedBy: res.by, candidates: res.candidates, outcome: 'unresolved', signals: [], handoffs: [], helpers: [] };
    if (res.resolved) {
      const text = fs.readFileSync(res.abs, 'utf8');
      Object.assign(step, classifySource(text), { helpers: projectImports(text, javaFiles, root) });
    } else step.reason = res.reason;
    step.action = ACTIONS[step.outcome];
    steps.push(step);
  }
  const counts = {};
  for (const s of steps) counts[s.outcome] = (counts[s.outcome] || 0) + 1;
  return { scope: SCOPE, steps, counts };
}

const needsAction = review => ((review && review.steps) || []).filter(s => s.outcome !== 'keep-post-processing');

module.exports = { OUTCOMES, HANDOFFS, ACTIONS, SCOPE, stripComments, classifySource, findJavaSources, resolveStepClass, projectImports, reviewCustomSteps, needsAction };
