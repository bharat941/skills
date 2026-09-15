#!/usr/bin/env node
/**
 * ab-check — A/B pixel-diff for AEM template migrations.
 *
 * Renders the same mock content on the LEGACY template and the NEW template
 * (or before/after modernize conversion) and pixel-diffs them. No stored
 * baseline required — both renders are captured live at validation time.
 *
 * Usage:
 *   ab-check \
 *     --fixture ./fixtures/wknd-ab-article/fixture.json \
 *     --sdk http://localhost:4602 \
 *     --auth admin:admin \
 *     --project /path/to/customer/project \
 *     --out ./out
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import puppeteer from 'puppeteer';

/* ---------------- args ---------------- */

function parseArgs(argv) {
  const args = { threshold: 0.1, maxDiffPct: 0.5, out: './out' };
  for (let i = 2; i < argv.length; i++) {
    const [key, val] = [argv[i], argv[i + 1]];
    switch (key) {
      case '--fixture': args.fixture = val; i++; break;
      case '--sdk': args.sdk = val; i++; break;
      case '--auth': args.auth = val; i++; break;
      case '--project': args.project = val; i++; break;
      case '--out': args.out = val; i++; break;
      case '--threshold': args.threshold = parseFloat(val); i++; break;
      case '--max-diff-pct': args.maxDiffPct = parseFloat(val); i++; break;
      case '--run-id': args.runId = val; i++; break;
      case '--skip-build': args.skipBuild = true; break;
      case '-h':
      case '--help': printHelp(); process.exit(0);
    }
  }
  if (!args.fixture) die('--fixture is required');
  if (!args.sdk) die('--sdk is required');
  args.auth = args.auth || 'admin:admin';
  args.runId = args.runId || `abc-${Date.now()}`;
  return args;
}

function printHelp() {
  console.log(`ab-check — A/B pixel-diff for AEM template migrations

  --fixture <file>    fixture.json (sourceTemplate + targetTemplate + mockContent)
  --sdk <url>         AEM SDK base URL (e.g. http://localhost:4602)
  --auth <u:p>        basic auth (default admin:admin)
  --project <path>    customer project root; runs 'mvn install' first
  --skip-build        skip the mvn step even if --project is set
  --out <dir>         outputs directory (default ./out)
  --threshold <n>     pixelmatch per-pixel tolerance 0..1 (default 0.1)
  --max-diff-pct <n>  max % of pixels allowed to differ (default 0.5)
  --run-id <id>       identity for the outcome (default abc-<epoch>)
`);
}

function die(msg) { console.error(`error: ${msg}`); process.exit(2); }

/* ---------------- shared http helpers ---------------- */

function auth(u) {
  return {
    Authorization: `Basic ${Buffer.from(u).toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

async function createPage({ sdk, authStr, parentPath, name, template, title }) {
  const body = new URLSearchParams({
    cmd: 'createPage',
    parentPath,
    template,
    title,
    _charset_: 'utf-8',
    ':name': name,
  });
  const res = await fetch(`${sdk}/bin/wcmcommand`, {
    method: 'POST', headers: auth(authStr), body,
  });
  if (!res.ok) throw new Error(`createPage ${parentPath}/${name} failed: ${res.status} ${await res.text()}`);
}

async function writeProps({ sdk, authStr, pagePath, mockContent }) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(mockContent)) body.set(k, String(v));
  body.set('_charset_', 'utf-8');
  const res = await fetch(`${sdk}${pagePath}/jcr:content`, {
    method: 'POST', headers: auth(authStr), body,
  });
  if (!res.ok) throw new Error(`writeProps ${pagePath} failed: ${res.status}`);
}

async function deletePage({ sdk, authStr, pagePath }) {
  try {
    const body = new URLSearchParams({ ':operation': 'delete' });
    await fetch(`${sdk}${pagePath}`, { method: 'POST', headers: auth(authStr), body });
  } catch { /* cleanup errors non-fatal */ }
}

/* ---------------- optional: modernize conversion ---------------- */

async function modernizeStructure({ sdk, authStr, pagePath, targetTemplate }) {
  const body = new URLSearchParams({
    paths: pagePath,
    targetPath: targetTemplate,
  });
  const res = await fetch(`${sdk}/libs/cq/modernize/structure/content.json`, {
    method: 'POST', headers: auth(authStr), body,
  });
  if (!res.ok) throw new Error(`modernize.structure failed: ${res.status}`);
}

/* ---------------- build + screenshot + diff ---------------- */

function mvnInstall({ project, sdk }) {
  const port = new URL(sdk).port || '4502';
  const host = new URL(sdk).hostname;
  console.log(`▸ mvn install (${project})`);
  const r = spawnSync(
    'mvn',
    ['clean', 'install', '-PautoInstallSinglePackage',
     `-Daem.host=${host}`, `-Daem.port=${port}`, '-DskipTests'],
    { cwd: project, stdio: 'inherit' },
  );
  if (r.status !== 0) throw new Error('mvn install failed');
}

async function shot({ url, authStr, viewport, outFile }) {
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    const [u, p] = authStr.split(':');
    await page.authenticate({ username: u, password: p });
    await page.setViewport(viewport || { width: 1440, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 45_000 });
    await page.screenshot({ path: outFile, fullPage: true });
  } finally {
    await browser.close();
  }
}

function diff({ aPath, bPath, outPath, threshold }) {
  const a = PNG.sync.read(fs.readFileSync(aPath));
  const b = PNG.sync.read(fs.readFileSync(bPath));
  if (a.width !== b.width || a.height !== b.height) {
    return { diffPixels: -1, totalPixels: a.width * a.height, diffPct: 100,
             sizeMismatch: { a: [a.width, a.height], b: [b.width, b.height] } };
  }
  const diffImg = new PNG({ width: a.width, height: a.height });
  const diffPixels = pixelmatch(
    a.data, b.data, diffImg.data, a.width, a.height,
    { threshold, includeAA: true },
  );
  fs.writeFileSync(outPath, PNG.sync.write(diffImg));
  const totalPixels = a.width * a.height;
  return { diffPixels, totalPixels, diffPct: (diffPixels / totalPixels) * 100 };
}

/* ---------------- main ---------------- */

async function main() {
  const args = parseArgs(process.argv);
  const started = new Date().toISOString();
  const fixture = JSON.parse(fs.readFileSync(args.fixture, 'utf8'));
  fs.mkdirSync(args.out, { recursive: true });

  const parent = fixture.parentPath || '/content/rv-ab';
  const nameA = `${args.runId}-src`;
  const nameB = `${args.runId}-dst`;
  const pathA = `${parent}/${nameA}`;
  const pathB = `${parent}/${nameB}`;
  const shotA = path.join(args.out, 'source.png');
  const shotB = path.join(args.out, 'destination.png');
  const diffOut = path.join(args.out, 'diff.png');

  let result = 'fail', failureClass = 'unknown', evidence = {};

  try {
    if (args.project && !args.skipBuild) mvnInstall({ project: args.project, sdk: args.sdk });

    console.log(`▸ create source page from ${fixture.sourceTemplate}`);
    await createPage({ sdk: args.sdk, authStr: args.auth, parentPath: parent,
      name: nameA, template: fixture.sourceTemplate,
      title: `RV A/B source ${args.runId}` });
    await writeProps({ sdk: args.sdk, authStr: args.auth, pagePath: pathA,
      mockContent: fixture.mockContent });

    if (fixture.modernize?.applyInPlace) {
      console.log(`▸ modernize source page → ${fixture.targetTemplate}`);
      await modernizeStructure({ sdk: args.sdk, authStr: args.auth,
        pagePath: pathA, targetTemplate: fixture.targetTemplate });
    } else {
      console.log(`▸ create destination page from ${fixture.targetTemplate}`);
      await createPage({ sdk: args.sdk, authStr: args.auth, parentPath: parent,
        name: nameB, template: fixture.targetTemplate,
        title: `RV A/B destination ${args.runId}` });
      await writeProps({ sdk: args.sdk, authStr: args.auth, pagePath: pathB,
        mockContent: fixture.mockContent });
    }

    const wcm = '?wcmmode=disabled';
    console.log(`▸ screenshot source: ${args.sdk}${pathA}.html`);
    await shot({ url: `${args.sdk}${pathA}.html${wcm}`, authStr: args.auth,
      viewport: fixture.viewport, outFile: shotA });

    const bUrl = fixture.modernize?.applyInPlace
      ? `${args.sdk}${pathA}.html${wcm}`  // same path, now converted
      : `${args.sdk}${pathB}.html${wcm}`;
    console.log(`▸ screenshot destination: ${bUrl}`);
    await shot({ url: bUrl, authStr: args.auth,
      viewport: fixture.viewport, outFile: shotB });

    console.log('▸ pixel diff source vs destination');
    const d = diff({ aPath: shotA, bPath: shotB, outPath: diffOut,
      threshold: args.threshold });
    evidence = d;
    const passed = d.diffPixels >= 0 && d.diffPct <= args.maxDiffPct;
    result = passed ? 'pass' : 'fail';
    if (!passed) failureClass = 'runtime.visual_mismatch';
  } catch (err) {
    failureClass = err.message?.includes('modernize') ? 'sdk.modernize_missing'
      : err.message?.includes('createPage') ? 'runtime.template_missing'
      : 'runtime.render_failed';
    evidence = { error: String(err.message || err).slice(0, 512) };
  } finally {
    await deletePage({ sdk: args.sdk, authStr: args.auth, pagePath: pathA });
    if (!fixture.modernize?.applyInPlace) {
      await deletePage({ sdk: args.sdk, authStr: args.auth, pagePath: pathB });
    }
  }

  const outcome = {
    run_id: args.runId,
    skill_pattern: 'template-visual-ab',
    skill_version: '0.1',
    verification_level: 'runtime',
    started_at: started,
    finished_at: new Date().toISOString(),
    result,
    summary: {
      classes_total: 1,
      classes_pass: result === 'pass' ? 1 : 0,
      classes_fail: result === 'pass' ? 0 : 1,
    },
    classes: [{
      class_name: fixture.targetTemplate,
      result,
      ...(result === 'fail' ? { failure_class: failureClass } : {}),
      checks: {
        source_template: fixture.sourceTemplate,
        target_template: fixture.targetTemplate,
        modernize_in_place: !!fixture.modernize?.applyInPlace,
        diff_pct: Number((evidence.diffPct ?? 0).toFixed(3)),
        diff_pixels: evidence.diffPixels ?? 0,
        total_pixels: evidence.totalPixels ?? 0,
        max_diff_pct_allowed: args.maxDiffPct,
      },
      ...(result === 'fail'
        ? { evidence: JSON.stringify(evidence).slice(0, 2048) } : {}),
    }],
  };

  fs.writeFileSync(path.join(args.out, 'result.json'), JSON.stringify(outcome, null, 2));

  console.log('\n=== outcome ===');
  console.log(JSON.stringify(outcome, null, 2));
  console.log('\n=== report-rv-outcome payload ===');
  console.log(JSON.stringify(outcome));
  console.log('=== end payload ===');

  process.exit(result === 'pass' ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(3); });
