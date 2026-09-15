#!/usr/bin/env node
/**
 * visual-check — pixel-diff validation for AEM template/UI migrations.
 *
 * Given a fixture (mock content + expected assertions) and a live SDK URL,
 * this tool:
 *   1. Creates a synthetic page from the template using the fixture's mock content.
 *   2. Screenshots the rendered page with headless Chrome (puppeteer).
 *   3. Compares against a pixel baseline using pixelmatch.
 *   4. Cleans up the synthetic page.
 *   5. Emits the same outcome shape as rv-check so `report-rv-outcome` can consume it.
 *
 * Usage:
 *   visual-check \
 *     --fixture ./fixtures/wknd-article/fixture.json \
 *     --baseline ./fixtures/wknd-article/baseline.png \
 *     --sdk http://localhost:4502 \
 *     --auth admin:admin \
 *     --out ./out
 *
 *   # Capture baseline (first run against a known-good SDK):
 *   visual-check --fixture ... --capture-baseline
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import puppeteer from 'puppeteer';

/* ---------------- arg parsing ---------------- */

function parseArgs(argv) {
  const args = { threshold: 0.1, maxDiffPct: 0.5, out: './out' };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    switch (key) {
      case '--fixture': args.fixture = val; i++; break;
      case '--baseline': args.baseline = val; i++; break;
      case '--sdk': args.sdk = val; i++; break;
      case '--auth': args.auth = val; i++; break;
      case '--out': args.out = val; i++; break;
      case '--threshold': args.threshold = parseFloat(val); i++; break;
      case '--max-diff-pct': args.maxDiffPct = parseFloat(val); i++; break;
      case '--capture-baseline': args.captureBaseline = true; break;
      case '--run-id': args.runId = val; i++; break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
    }
  }
  if (!args.fixture) fail('--fixture is required');
  if (!args.sdk) fail('--sdk is required (e.g. http://localhost:4502)');
  args.runId = args.runId || `vdc-${Date.now()}`;
  return args;
}

function printHelp() {
  console.log(`visual-check — pixel-diff for AEM template migrations

  --fixture <file>         fixture.json describing template + mock content + assertions
  --baseline <file>        baseline PNG to diff against (skip with --capture-baseline)
  --sdk <url>              base URL of the running AEM SDK (author or publish)
  --auth <user:pass>       basic auth for the SDK (default: admin:admin)
  --out <dir>              directory for outputs (screenshot, diff, result.json)
  --threshold <n>          pixelmatch pixel tolerance 0..1 (default 0.1)
  --max-diff-pct <n>       max % of pixels allowed to differ (default 0.5)
  --capture-baseline       skip diff and save the screenshot as the baseline
  --run-id <id>            run identifier for the outcome (default vdc-<epoch>)
`);
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(2);
}

/* ---------------- fixture-driven page lifecycle ---------------- */

async function createMockPage({ sdk, auth, fixture, pagePath }) {
  const url = `${sdk}${path.dirname(pagePath)}/*`;
  const params = new URLSearchParams();
  params.set('cmd', 'createPage');
  params.set('parentPath', path.dirname(pagePath));
  params.set('title', fixture.mockContent['jcr:title'] || 'RV Visual Test');
  params.set('template', fixture.template);
  params.set('_charset_', 'utf-8');
  params.set(':name', path.basename(pagePath));

  const res = await fetch(`${sdk}/bin/wcmcommand`, {
    method: 'POST',
    headers: authHeader(auth),
    body: params,
  });
  if (!res.ok) throw new Error(`createPage failed: ${res.status} ${await res.text()}`);

  // Apply mockContent as flat property writes on the jcr:content node.
  const propsUrl = `${sdk}${pagePath}/jcr:content`;
  const propsBody = new URLSearchParams();
  for (const [k, v] of Object.entries(fixture.mockContent)) {
    propsBody.set(k, String(v));
  }
  propsBody.set('_charset_', 'utf-8');
  const propRes = await fetch(propsUrl, {
    method: 'POST',
    headers: authHeader(auth),
    body: propsBody,
  });
  if (!propRes.ok) throw new Error(`property write failed: ${propRes.status}`);
}

async function deletePage({ sdk, auth, pagePath }) {
  try {
    const params = new URLSearchParams();
    params.set(':operation', 'delete');
    await fetch(`${sdk}${pagePath}`, {
      method: 'POST',
      headers: authHeader(auth),
      body: params,
    });
  } catch {
    // cleanup errors are non-fatal
  }
}

function authHeader(auth) {
  return {
    Authorization: `Basic ${Buffer.from(auth || 'admin:admin').toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

/* ---------------- screenshot + compare ---------------- */

async function screenshot({ url, auth, viewport, outFile }) {
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    if (auth) {
      const [user, pass] = auth.split(':');
      await page.authenticate({ username: user, password: pass });
    }
    await page.setViewport(viewport || { width: 1440, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30_000 });
    await page.screenshot({ path: outFile, fullPage: true });
  } finally {
    await browser.close();
  }
}

function diff({ actualPath, baselinePath, outPath, threshold }) {
  const actual = PNG.sync.read(fs.readFileSync(actualPath));
  const baseline = PNG.sync.read(fs.readFileSync(baselinePath));
  if (actual.width !== baseline.width || actual.height !== baseline.height) {
    return {
      diffPixels: -1,
      totalPixels: actual.width * actual.height,
      diffPct: 100,
      sizeMismatch: {
        actual: [actual.width, actual.height],
        baseline: [baseline.width, baseline.height],
      },
    };
  }
  const { width, height } = actual;
  const diffImg = new PNG({ width, height });
  const diffPixels = pixelmatch(
    actual.data, baseline.data, diffImg.data, width, height,
    { threshold, includeAA: true },
  );
  fs.writeFileSync(outPath, PNG.sync.write(diffImg));
  const totalPixels = width * height;
  return { diffPixels, totalPixels, diffPct: (diffPixels / totalPixels) * 100 };
}

/* ---------------- main ---------------- */

async function main() {
  const args = parseArgs(process.argv);
  const started = new Date().toISOString();

  const fixture = JSON.parse(fs.readFileSync(args.fixture, 'utf8'));
  fs.mkdirSync(args.out, { recursive: true });

  const pagePath = `/content/rv-visual/${args.runId}`;
  const rendered = `${args.sdk}${pagePath}.html?wcmmode=disabled`;
  const shotFile = path.join(args.out, 'actual.png');
  const diffFile = path.join(args.out, 'diff.png');

  let result = 'fail';
  let failureClass = 'unknown';
  let evidence = {};

  try {
    console.log(`▸ create mock page ${pagePath} from ${fixture.template}`);
    await createMockPage({ sdk: args.sdk, auth: args.auth, fixture, pagePath });

    console.log(`▸ screenshot ${rendered}`);
    await screenshot({
      url: rendered,
      auth: args.auth,
      viewport: fixture.viewport,
      outFile: shotFile,
    });

    if (args.captureBaseline) {
      const baselineTarget = args.baseline || path.join(args.out, 'baseline.png');
      fs.mkdirSync(path.dirname(baselineTarget), { recursive: true });
      fs.copyFileSync(shotFile, baselineTarget);
      console.log(`▸ baseline captured: ${baselineTarget}`);
      result = 'pass';
      evidence = { captured_baseline: baselineTarget };
    } else if (!args.baseline || !fs.existsSync(args.baseline)) {
      failureClass = 'input.baseline_missing';
      evidence = { hint: 'run with --capture-baseline first' };
    } else {
      console.log(`▸ pixel diff vs ${args.baseline}`);
      const d = diff({
        actualPath: shotFile,
        baselinePath: args.baseline,
        outPath: diffFile,
        threshold: args.threshold,
      });
      evidence = d;
      const passed = d.diffPixels >= 0 && d.diffPct <= args.maxDiffPct;
      result = passed ? 'pass' : 'fail';
      if (!passed) failureClass = 'runtime.visual_mismatch';
    }
  } catch (err) {
    failureClass = 'runtime.render_failed';
    evidence = { error: String(err.message || err).slice(0, 512) };
  } finally {
    await deletePage({ sdk: args.sdk, auth: args.auth, pagePath });
  }

  const finished = new Date().toISOString();
  const outcome = {
    run_id: args.runId,
    skill_pattern: 'template-visual',
    skill_version: '0.1',
    verification_level: 'runtime',
    started_at: started,
    finished_at: finished,
    result,
    summary: {
      classes_total: 1,
      classes_pass: result === 'pass' ? 1 : 0,
      classes_fail: result === 'pass' ? 0 : 1,
    },
    classes: [
      {
        class_name: fixture.template,
        result,
        ...(result === 'fail' ? { failure_class: failureClass } : {}),
        checks: {
          diff_pct: Number((evidence.diffPct ?? 0).toFixed(3)),
          diff_pixels: evidence.diffPixels ?? 0,
          total_pixels: evidence.totalPixels ?? 0,
          max_diff_pct_allowed: args.maxDiffPct,
        },
        ...(result === 'fail'
          ? { evidence: JSON.stringify(evidence).slice(0, 2048) }
          : {}),
      },
    ],
  };

  fs.writeFileSync(path.join(args.out, 'result.json'), JSON.stringify(outcome, null, 2));

  console.log('\n=== outcome ===');
  console.log(JSON.stringify(outcome, null, 2));
  console.log('\n=== report-rv-outcome payload ===');
  console.log(JSON.stringify(outcome));
  console.log('=== end payload ===');

  process.exit(result === 'pass' ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(3);
});
