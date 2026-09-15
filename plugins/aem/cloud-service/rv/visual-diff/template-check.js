#!/usr/bin/env node
/**
 * template-check — HTML content comparison for AEM template migrations.
 *
 * Given a fixture describing a source (legacy) and destination (editable)
 * template plus mock content, this tool:
 *   1. Creates a synthetic page from the source template + mock content
 *   2. Creates a synthetic page from the destination template + same mock content
 *   3. GETs both rendered HTMLs from the SDK
 *   4. Runs assertions on both:
 *        - HTTP 200
 *        - required CSS selectors present on destination
 *        - forbidden markers absent on destination
 *        - visible text on both is the same (proves content parity)
 *   5. Deletes both test pages
 *   6. Emits the same outcome envelope as rv-check
 *
 * Usage:
 *   template-check \
 *     --fixture ./fixtures/wknd-page-content/fixture.json \
 *     --sdk http://localhost:4602 \
 *     --auth admin:admin \
 *     --project /path/to/customer/project \
 *     --out ./out
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as cheerio from 'cheerio';

/* ---------------- args ---------------- */

function parseArgs(argv) {
  const args = { out: './out' };
  for (let i = 2; i < argv.length; i++) {
    const [key, val] = [argv[i], argv[i + 1]];
    switch (key) {
      case '--fixture': args.fixture = val; i++; break;
      case '--sdk': args.sdk = val; i++; break;
      case '--auth': args.auth = val; i++; break;
      case '--project': args.project = val; i++; break;
      case '--out': args.out = val; i++; break;
      case '--run-id': args.runId = val; i++; break;
      case '--skip-build': args.skipBuild = true; break;
      case '--keep-pages': args.keepPages = true; break;
      case '-h':
      case '--help': help(); process.exit(0);
    }
  }
  if (!args.fixture) die('--fixture is required');
  if (!args.sdk) die('--sdk is required');
  args.auth = args.auth || 'admin:admin';
  args.runId = args.runId || `tcc-${Date.now()}`;
  return args;
}

function help() {
  console.log(`template-check — HTML content parity for template migrations

  --fixture <file>    fixture.json (sourceTemplate + targetTemplate + assertions)
  --sdk <url>         AEM SDK base URL
  --auth <u:p>        basic auth (default admin:admin)
  --project <path>    customer project; runs 'mvn install' first
  --skip-build        skip mvn even if --project is set
  --keep-pages        don't delete test pages after the run (debug)
  --out <dir>         output dir (default ./out)
  --run-id <id>       identity (default tcc-<epoch>)
`);
}

function die(m) { console.error(`error: ${m}`); process.exit(2); }

/* ---------------- sling helpers ---------------- */

function authHeaders(u) {
  return {
    Authorization: `Basic ${Buffer.from(u).toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

async function createPage({ sdk, auth, parentPath, name, template, title }) {
  const body = new URLSearchParams({
    cmd: 'createPage',
    parentPath,
    template,
    title,
    _charset_: 'utf-8',
    ':name': name,
  });
  const res = await fetch(`${sdk}/bin/wcmcommand`, {
    method: 'POST', headers: authHeaders(auth), body,
  });
  if (!res.ok) {
    throw new Error(`createPage ${parentPath}/${name} (${template}) → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

async function writeProps({ sdk, auth, pagePath, mockContent }) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(mockContent)) body.set(k, String(v));
  body.set('_charset_', 'utf-8');
  const res = await fetch(`${sdk}${pagePath}/jcr:content`, {
    method: 'POST', headers: authHeaders(auth), body,
  });
  if (!res.ok) throw new Error(`writeProps ${pagePath} → ${res.status}`);
}

async function deletePage({ sdk, auth, pagePath }) {
  try {
    const body = new URLSearchParams({ ':operation': 'delete' });
    await fetch(`${sdk}${pagePath}`, {
      method: 'POST', headers: authHeaders(auth), body,
    });
  } catch { /* cleanup best-effort */ }
}

async function fetchHtml({ sdk, auth, pagePath }) {
  const url = `${sdk}${pagePath}.html?wcmmode=disabled`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(auth).toString('base64')}`,
    },
  });
  const body = await res.text();
  return { status: res.status, url, body };
}

/* ---------------- mvn helper ---------------- */

function mvnInstall({ project, sdk }) {
  const u = new URL(sdk);
  console.log(`▸ mvn install (${project})`);
  const r = spawnSync(
    'mvn',
    ['clean', 'install', '-PautoInstallSinglePackage',
     `-Daem.host=${u.hostname}`, `-Daem.port=${u.port || '4502'}`, '-DskipTests'],
    { cwd: project, stdio: 'inherit' },
  );
  if (r.status !== 0) throw new Error('mvn install failed');
}

/* ---------------- assertions ---------------- */

function normalizeVisibleText(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, template, cq').remove();
  return $('body')
    .text()
    .replace(/\s+/g, ' ')
    .trim();
}

function assertHtml({ label, html, status, assertions }) {
  const failures = [];
  if (status !== 200) {
    failures.push({ check: 'httpStatus', expected: 200, actual: status });
  }
  const $ = cheerio.load(html);

  for (const sel of assertions?.mustContainSelectors || []) {
    if ($(sel).length === 0) failures.push({ check: 'mustContainSelector', selector: sel });
  }
  for (const marker of assertions?.mustNotContain || []) {
    if (html.includes(marker)) failures.push({ check: 'mustNotContain', marker });
  }
  for (const attrRule of assertions?.mustHaveAttribute || []) {
    const nodes = $(attrRule.selector);
    if (nodes.length === 0) {
      failures.push({ check: 'mustHaveAttribute.selectorMissing', selector: attrRule.selector });
    } else {
      nodes.each((_, el) => {
        if (!$(el).attr(attrRule.attr)) {
          failures.push({
            check: 'mustHaveAttribute.attrMissing',
            selector: attrRule.selector, attr: attrRule.attr,
          });
        }
      });
    }
  }
  return { label, status, failures };
}

function textParity(sourceText, destText) {
  if (sourceText === destText) return { same: true, diffChars: 0 };
  const [longer, shorter] = sourceText.length >= destText.length
    ? [sourceText, destText] : [destText, sourceText];
  let matched = 0;
  const shorterSet = new Set(shorter.toLowerCase().split(/\s+/));
  for (const w of longer.toLowerCase().split(/\s+/)) if (shorterSet.has(w)) matched++;
  const total = new Set([...shorterSet, ...longer.toLowerCase().split(/\s+/)]).size;
  const overlap = total === 0 ? 0 : matched / total;
  return {
    same: false,
    diffChars: Math.abs(sourceText.length - destText.length),
    wordOverlap: Number(overlap.toFixed(3)),
    sourceLen: sourceText.length,
    destLen: destText.length,
  };
}

/* ---------------- main ---------------- */

async function main() {
  const args = parseArgs(process.argv);
  const started = new Date().toISOString();
  const fixture = JSON.parse(fs.readFileSync(args.fixture, 'utf8'));
  fs.mkdirSync(args.out, { recursive: true });

  const parent = fixture.parentPath || '/content/rv-template';
  const nameSrc = `${args.runId}-src`;
  const nameDst = `${args.runId}-dst`;
  const pathSrc = `${parent}/${nameSrc}`;
  const pathDst = `${parent}/${nameDst}`;

  let result = 'fail', failureClass = 'unknown';
  const evidence = { source: null, destination: null, parity: null };

  try {
    if (args.project && !args.skipBuild) mvnInstall({ project: args.project, sdk: args.sdk });

    console.log(`▸ create source page from ${fixture.sourceTemplate}`);
    await createPage({ sdk: args.sdk, auth: args.auth, parentPath: parent,
      name: nameSrc, template: fixture.sourceTemplate,
      title: `Template check — source ${args.runId}` });
    await writeProps({ sdk: args.sdk, auth: args.auth, pagePath: pathSrc,
      mockContent: fixture.mockContent });

    console.log(`▸ create destination page from ${fixture.targetTemplate}`);
    await createPage({ sdk: args.sdk, auth: args.auth, parentPath: parent,
      name: nameDst, template: fixture.targetTemplate,
      title: `Template check — destination ${args.runId}` });
    await writeProps({ sdk: args.sdk, auth: args.auth, pagePath: pathDst,
      mockContent: fixture.mockContent });

    console.log(`▸ fetch source html`);
    const src = await fetchHtml({ sdk: args.sdk, auth: args.auth, pagePath: pathSrc });
    fs.writeFileSync(path.join(args.out, 'source.html'), src.body);

    console.log(`▸ fetch destination html`);
    const dst = await fetchHtml({ sdk: args.sdk, auth: args.auth, pagePath: pathDst });
    fs.writeFileSync(path.join(args.out, 'destination.html'), dst.body);

    const srcCheck = assertHtml({ label: 'source', html: src.body, status: src.status,
      assertions: fixture.assertions?.source || {} });
    const dstCheck = assertHtml({ label: 'destination', html: dst.body, status: dst.status,
      assertions: fixture.assertions?.destination || fixture.assertions || {} });
    evidence.source = srcCheck;
    evidence.destination = dstCheck;

    const parity = textParity(
      normalizeVisibleText(src.body),
      normalizeVisibleText(dst.body),
    );
    evidence.parity = parity;

    const parityOk = fixture.assertions?.requireExactTextParity
      ? parity.same
      : (parity.same || (parity.wordOverlap ?? 0) >= (fixture.assertions?.minWordOverlap ?? 0.9));

    const passed =
      srcCheck.failures.length === 0 &&
      dstCheck.failures.length === 0 &&
      parityOk;
    result = passed ? 'pass' : 'fail';
    if (!passed) {
      failureClass =
        !parityOk ? 'runtime.content_mismatch'
        : srcCheck.failures.some(f => f.check === 'httpStatus') ? 'runtime.render_failed'
        : dstCheck.failures.some(f => f.check === 'httpStatus') ? 'runtime.render_failed'
        : 'runtime.html_assertion_failed';
    }
  } catch (err) {
    failureClass =
      /createPage/.test(err.message) ? 'runtime.template_missing'
      : /mvn install/.test(err.message) ? 'build.failed'
      : 'runtime.render_failed';
    evidence.error = String(err.message || err).slice(0, 512);
  } finally {
    if (!args.keepPages) {
      await deletePage({ sdk: args.sdk, auth: args.auth, pagePath: pathSrc });
      await deletePage({ sdk: args.sdk, auth: args.auth, pagePath: pathDst });
    }
  }

  const outcome = {
    run_id: args.runId,
    skill_pattern: 'template-html',
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
        source_status: evidence.source?.status ?? 0,
        destination_status: evidence.destination?.status ?? 0,
        source_failures: evidence.source?.failures?.length ?? 0,
        destination_failures: evidence.destination?.failures?.length ?? 0,
        text_parity: evidence.parity?.same ?? false,
        word_overlap: evidence.parity?.wordOverlap ?? 0,
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
