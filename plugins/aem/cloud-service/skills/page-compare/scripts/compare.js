#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('node:util');

const { loadPairs } = require('./lib/pairs');
const { loadRules, loadAccepted, rewritesFrom, applyAccepted, deriveStatus, reusableResult } = require('./lib/rules');
const { createPacer, runPool, withRetry } = require('./lib/guard');
const { contentFindings, diffBlocks, makeCanon, safeHost } = require('./lib/content');
const { functionalFindings } = require('./lib/functional');
const { visualFindings } = require('./lib/visual');
const { createFetcher, downloadFindings, brokenLinkFindings, siteFindings, redirectFindings, pageSetCoverage } = require('./lib/completeness');
const { renderHtml, renderJson, toCsv, summarize, exitCode } = require('./lib/report');
const { renderMarkdownFiles, writeReportFiles } = require('./lib/markdown');
const { normalizePath, hash } = require('./lib/util');
const { parseCsv } = require('./lib/pairs');

const USAGE = `Usage: node compare.js [options]

Pages (one of):
  --before <url> --after <url>        Compare one pair
  --pairs <file.csv|file.xlsx>        Pairs from a CSV or the first sheet of an Excel workbook: before in column A, after in column B,
                                      optional label and group. A header row (before,after[,label][,group]) is optional
  --sitemap <url> --map <b=a>         Compare every URL in a before sitemap; --path-map <old=new> rewrites paths

Options:
  --out <dir>               Output directory (default ./page-compare-out)
  --viewports <list>        Comma-separated widths (default 1440,768,375)
  --concurrency <n>         Parallel pairs (default 2)
  --pace-ms <n>             Minimum gap between requests per host (default 500)
  --mask <selector>         Hide matching elements in screenshots and text (repeatable)
  --sections <selector>     Override section detection (repeatable)
  --storage-state <file>    Playwright storage state for authenticated pages
  --accept <file>           accepted.json with reviewed differences
  --rules <file>            JSON overrides for thresholds
  --expect-analytics <file> JSON { rsid, datastreamId, launch } the after pages must use
  --after-sitemap <url>     Report after-site pages that are not in the compared set
  --redirects <file.csv>    CSV with header: from,to; checks the before URL redirects to the target
  --noise-sample <pct>      Run the noise baseline on this share of pages (default 100%)
  --include <regex> / --exclude <regex> / --limit <n>   Filter the page list (matched on before URL)
  --per-group <n>           Keep n pages per group: the CSV "group" column, else the first path segment after any /content/<site> and locale (/en/)
  --resume                  Reuse stored captures in --out and only reapply --accept
  --no-link-check           Skip HTTP checks of links and downloads
  --ua <suffix>             User-agent suffix (default page-compare/1.0)
  -h, --help

Exit codes: 0 no fail/error/blocked, 1 at least one, 2 usage or setup error.`;

const NOT_TESTED = [
  'Form submissions, logins, search and other interactions (pages are only loaded, never clicked)',
  'Analytics interaction events, consent behaviour and end-to-end data arrival',
  'Performance beyond load and LCP timing, security headers, SEO ranking signals',
  'Cross-browser rendering (Chromium only)',
];

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      before: { type: 'string' },
      after: { type: 'string' },
      pairs: { type: 'string' },
      sitemap: { type: 'string' },
      map: { type: 'string', multiple: true },
      'path-map': { type: 'string', multiple: true },
      out: { type: 'string', default: './page-compare-out' },
      viewports: { type: 'string', default: '1440,768,375' },
      concurrency: { type: 'string', default: '2' },
      'pace-ms': { type: 'string', default: '500' },
      mask: { type: 'string', multiple: true },
      sections: { type: 'string', multiple: true },
      'storage-state': { type: 'string' },
      accept: { type: 'string' },
      rules: { type: 'string' },
      'expect-analytics': { type: 'string' },
      'after-sitemap': { type: 'string' },
      redirects: { type: 'string' },
      'noise-sample': { type: 'string', default: '100' },
      include: { type: 'string' },
      exclude: { type: 'string' },
      limit: { type: 'string' },
      'per-group': { type: 'string' },
      resume: { type: 'boolean', default: false },
      'no-link-check': { type: 'boolean', default: false },
      ua: { type: 'string', default: 'page-compare/1.0' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  return values;
}

function viewportList(spec) {
  return spec.split(',').map((w) => {
    const width = Number(w.trim());
    if (!width) fail(`Invalid viewport width: ${w}`);
    return { name: String(width), width, height: width >= 1000 ? 900 : 800 };
  });
}

function pathInfo(pair) {
  const p = (u) => {
    try {
      return normalizePath(new URL(u).pathname);
    } catch (e) {
      return u;
    }
  };
  return { path: p(pair.after), beforePath: p(pair.before) };
}

function sampled(id, pct) {
  return parseInt(hash(id, 4), 16) % 100 < pct;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function processPair(pair, env) {
  const { opts, rules, accepted, viewports, browser, pacer, fetcher, outDir } = env;
  const page = pathInfo(pair);
  const pairDir = path.join(outDir, 'pairs', pair.id);
  const visualDir = path.join(pairDir, 'visual');
  const result = { id: pair.id, before: pair.before, after: pair.after, label: pair.label || '', retried: false };
  const { capturePage } = require('./lib/capture');

  const load = async (url, viewport) => {
    const run = () =>
      withRetry(() =>
        capturePage(browser, url, {
          viewport,
          userAgent: `Mozilla/5.0 (compatible; ${opts.ua})`,
          storageState: opts['storage-state'],
          masks: opts.mask || [],
          sectionSelectors: opts.sections || [],
          pacer,
        }),
      );
    let { value, retried } = await run();
    if (value.snapshot.status >= 500) {
      const second = await run();
      if (second.value.snapshot.status < 500) retried = true;
      value = second.value;
    }
    if (retried) result.retried = true;
    return value;
  };

  try {
    const canon = makeCanon({ beforeUrl: pair.before, afterUrl: pair.after, hostMap: env.hostMap, pathMap: env.pathMap, rewrites: env.rewrites, page });
    const beforeHost = safeHost(pair.before);
    const afterHost = safeHost(pair.after);
    const doNoise = sampled(pair.id, env.noiseSample);
    const primary = viewports[0];

    const b1 = await load(pair.before, primary);
    const a1 = await load(pair.after, primary);
    const comparable = a1.snapshot.status >= 200 && a1.snapshot.status < 300 && b1.snapshot.status >= 200 && b1.snapshot.status < 300;

    let b2 = null;
    let volatile = [];
    let volatilePct = 0;
    if (comparable && doNoise) {
      b2 = await load(pair.before, primary);
      const d = diffBlocks(b1.snapshot.blocks, b2.snapshot.blocks);
      volatile = [...d.missing.map((m) => m.text), ...d.changed.flatMap((c) => [c.before, c.after]), ...d.added.map((x) => x.text)];
      volatilePct = Math.max(d.missingPct, d.addedPct);
    }

    const ctx = { beforeUrl: pair.before, afterUrl: pair.after, beforeHost, afterHost, canon, rules, volatile, expect: env.expect, fetcher };
    const findings = [...contentFindings(b1.snapshot, a1.snapshot, ctx)];
    let unstable = false;
    const rows = [];
    let noise = null;

    if (comparable) {
      findings.push(...functionalFindings(b1.snapshot, a1.snapshot, ctx));
      if (!opts['no-link-check']) {
        findings.push(...(await downloadFindings(b1.snapshot, a1.snapshot, ctx)));
        findings.push(...(await brokenLinkFindings(b1.snapshot, a1.snapshot, ctx)));
      }
      for (const [i, vp] of viewports.entries()) {
        const b = i === 0 ? b1 : await load(pair.before, vp);
        const a = i === 0 ? a1 : await load(pair.after, vp);
        const bb = doNoise ? (i === 0 ? b2 : await load(pair.before, vp)) : null;
        const v = visualFindings({ viewport: vp.name, before: b.sections, after: a.sections, before2: bb && bb.sections, rules, outDir: visualDir });
        findings.push(...v.findings);
        rows.push(...v.rows);
        if (v.noise !== null) noise = Math.max(noise ?? 0, v.noise);
        if (v.unstable) unstable = true;
      }
    }
    const flaky = volatilePct > rules.text.volatileFlakyPct || result.retried;
    Object.assign(result, { rawFindings: findings, noise, volatilePct, flaky, unstable, visual: { rows } });
  } catch (err) {
    if (err.blocked) result.blocked = err.blocked;
    else result.error = String(err.message || err);
    result.rawFindings = [];
  }
  fs.mkdirSync(pairDir, { recursive: true });
  fs.writeFileSync(path.join(pairDir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

function finalize(result, accepted) {
  const page = pathInfo(result);
  const findings = applyAccepted(result.rawFindings || [], accepted, page);
  const status = deriveStatus({ error: result.error, blocked: result.blocked, flaky: result.flaky, unstable: result.unstable, findings });
  const { rawFindings, ...rest } = result;
  return { ...rest, findings, status };
}

async function main() {
  let opts;
  try {
    opts = parseOptions(process.argv.slice(2));
  } catch (e) {
    fail(`${e.message}\n\n${USAGE}`);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  let rules;
  let accepted;
  let expect = null;
  try {
    rules = loadRules(opts.rules);
    accepted = loadAccepted(opts.accept);
    if (opts['expect-analytics']) expect = readJson(opts['expect-analytics']);
  } catch (e) {
    fail(e.message);
  }
  const viewports = viewportList(opts.viewports);
  const outDir = path.resolve(opts.out);
  fs.mkdirSync(path.join(outDir, 'pairs'), { recursive: true });

  let loaded;
  try {
    loaded = await loadPairs({
      before: opts.before,
      after: opts.after,
      pairs: opts.pairs,
      sitemap: opts.sitemap,
      map: opts.map,
      pathMap: opts['path-map'],
      include: opts.include,
      exclude: opts.exclude,
      limit: opts.limit,
      perGroup: opts['per-group'],
    });
  } catch (e) {
    fail(e.message);
  }
  const { pairs, hostMap, pathMap } = loaded;
  console.log(`${pairs.length} page pair(s), viewports ${viewports.map((v) => v.width).join('/')}`);

  const stored = (p) => {
    const f = path.join(outDir, 'pairs', p.id, 'result.json');
    if (opts.resume && fs.existsSync(f)) {
      try {
        const r = readJson(f);
        return reusableResult(r) ? r : null;
      } catch (e) {
        return null;
      }
    }
    return null;
  };

  const pacer = createPacer(Number(opts['pace-ms']));
  const fetcher = createFetcher({ userAgent: opts.ua, pacer });
  const rewrites = rewritesFrom(accepted);
  const todo = pairs.filter((p) => !stored(p));

  let browser = null;
  const blockedByHost = new Map();
  const totalByHost = new Map();
  const pausedHosts = new Set();
  const noiseSample = Number(String(opts['noise-sample']).replace('%', ''));

  if (todo.length) {
    const { launchBrowser } = require('./lib/capture');
    try {
      browser = await launchBrowser();
    } catch (e) {
      fail(e.message);
    }
  }

  const env = { opts, rules, accepted, viewports, browser, pacer, fetcher, outDir, hostMap, pathMap, rewrites, expect, noiseSample };
  let done = 0;
  const results = await runPool(pairs, Number(opts.concurrency) || 2, async (pair) => {
    let result = stored(pair);
    if (!result) {
      const hosts = [safeHost(pair.before), safeHost(pair.after)];
      if (hosts.some((h) => pausedHosts.has(h))) {
        result = { id: pair.id, before: pair.before, after: pair.after, label: pair.label || '', blocked: 'skipped: this host was paused after repeated bot-protection blocks', rawFindings: [] };
      } else {
        result = await processPair(pair, env);
        for (const h of hosts) {
          totalByHost.set(h, (totalByHost.get(h) || 0) + 1);
          if (result.blocked) blockedByHost.set(h, (blockedByHost.get(h) || 0) + 1);
          if (totalByHost.get(h) >= 5 && blockedByHost.get(h) / totalByHost.get(h) > 0.2) pausedHosts.add(h);
        }
      }
    }
    done++;
    if (done % 10 === 0 || done === pairs.length) console.log(`  ${done}/${pairs.length} pages`);
    return result;
  });
  if (browser) await browser.close();

  const completeness = {};
  const firstPair = pairs[0];
  if (!opts['no-link-check'] && firstPair) {
    const origin = (u) => new URL(u).origin;
    completeness.siteFindings = await siteFindings({ beforeOrigin: origin(firstPair.before), afterOrigin: origin(firstPair.after), fetcher });
  }
  if (opts.redirects) {
    const rows = parseCsv(fs.readFileSync(opts.redirects, 'utf8'));
    const [head, ...data] = rows;
    const fi = head.indexOf('from');
    const ti = head.indexOf('to');
    if (fi < 0 || ti < 0) fail('--redirects CSV needs a header with "from" and "to"');
    const r = await redirectFindings(data.map((row) => ({ from: row[fi], to: row[ti] })), fetcher);
    completeness.redirects = r.results;
    completeness.redirectFindings = r.findings;
  }
  if (opts['after-sitemap']) completeness.coverage = await pageSetCoverage({ afterSitemapUrl: opts['after-sitemap'], pairs, fetcher });

  const finalPairs = results.map((r) => finalize(r, accepted));
  const run = {
    generatedAt: new Date().toISOString(),
    viewports: viewports.map((v) => v.width),
    blockedHosts: [...pausedHosts],
    notTested: NOT_TESTED,
    completeness,
    pairs: finalPairs,
  };
  fs.writeFileSync(path.join(outDir, 'report.html'), renderHtml(run));
  writeReportFiles(outDir, renderMarkdownFiles(run));
  fs.writeFileSync(path.join(outDir, 'report.json'), renderJson(run));
  fs.writeFileSync(path.join(outDir, 'summary.csv'), toCsv(finalPairs));

  const counts = summarize(finalPairs);
  console.log(Object.entries(counts).filter(([, n]) => n).map(([s, n]) => `${s}: ${n}`).join('  '));
  console.log(`Report: ${path.join(outDir, 'report.html')}`);
  console.log(`Markdown: ${path.join(outDir, 'report.md')} (issues.csv, pages.csv and pages/ alongside)`);
  if (pausedHosts.size) console.log(`Bot protection blocked ${[...pausedHosts].join(', ')}; allowlist this runner or raise --pace-ms, then rerun with --resume.`);
  process.exit(exitCode(finalPairs));
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(2);
});
