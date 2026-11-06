'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { parseCsv, pairsFromCsv, parseSitemapXml, mapUrl, parseMap, loadPairs } = require('./lib/pairs');
const { diffBlocks } = require('./lib/content');
const { applyAccepted, loadAccepted, deriveStatus, worstSeverity } = require('./lib/rules');
const { classifyBlock, createPacer, withRetry } = require('./lib/guard');
const { classifyRequest } = require('./lib/functional');
const { normalizePath } = require('./lib/util');
const { renderHtml, toCsv, exitCode, summarize } = require('./lib/report');
const { robotsBlocksAll, redirectFindings } = require('./lib/completeness');
const { toMarkdown, areaOf } = require('./lib/markdown');
const { pairSections } = require('./lib/visual');

// ---------- units ----------

test('pairs: csv with header, quotes and comments', () => {
  const rows = pairsFromCsv('# c\nbefore,after,label\n"https://a/x,1",https://b/x,"Home, page"\n');
  assert.deepEqual(rows, [{ before: 'https://a/x,1', after: 'https://b/x', label: 'Home, page' }]);
  assert.throws(() => pairsFromCsv('a,b\n1,2'), /before.*after/);
  assert.equal(parseCsv('a,b\r\n1,2\r\n').length, 2);
});

test('pairs: sitemap index and url set, host and path maps', async () => {
  assert.deepEqual(parseSitemapXml('<urlset><url><loc>https://a/x?a=1&amp;b=2</loc></url></urlset>'), { isIndex: false, locs: ['https://a/x?a=1&b=2'] });
  const files = {
    'https://a/index.xml': '<sitemapindex><sitemap><loc>https://a/s1.xml</loc></sitemap></sitemapindex>',
    'https://a/s1.xml': '<urlset><url><loc>https://a/en/one</loc></url><url><loc>https://a/en/two</loc></url><url><loc>https://a/skip/x</loc></url></urlset>',
  };
  const loaded = await loadPairs({ sitemap: 'https://a/index.xml', map: ['a=b'], pathMap: ['/en/=/us/en/'], exclude: '/skip/' }, async (u) => files[u]);
  assert.deepEqual(loaded.pairs.map((p) => p.after), ['https://b/us/en/one', 'https://b/us/en/two']);
  assert.equal(mapUrl('https://a/p', { hostMap: [parseMap('a=b')] }), 'https://b/p');
  await assert.rejects(loadPairs({ sitemap: 'https://a/index.xml' }, async (u) => files[u]), /--map/);
});

test('util.normalizePath strips extension, index and tracking params', () => {
  assert.equal(normalizePath('/a/b.html'), '/a/b');
  assert.equal(normalizePath('/a/index.html'), '/a');
  assert.equal(normalizePath('/a/?utm_source=x'), '/a');
});

test('content.diffBlocks: missing, changed, added and volatile text', () => {
  const b = [{ text: 'Alpha beta gamma delta epsilon zeta eta theta' }, { text: 'Our prices start at 49 dollars per month for teams' }, { text: 'Visitors 123' }];
  const a = [{ text: 'Our prices start at 59 dollars per month for teams' }, { text: 'Brand new paragraph about something else entirely' }, { text: 'Visitors 456' }];
  const d = diffBlocks(b, a, ['Visitors 123', 'Visitors 456']);
  assert.equal(d.missing.length, 1);
  assert.equal(d.changed.length, 1);
  assert.equal(d.added.length, 1);
  assert.ok(d.missingPct > 0);
});

test('rules: accepted marks findings and never drops them', () => {
  const findings = [
    { check: 'content.text.missing', severity: 'fail', summary: 's', items: [{ text: 'Legacy banner' }, { text: 'Pricing' }] },
    { check: 'meta.title', severity: 'review', summary: 'Title changed' },
  ];
  const page = { path: '/en/a', beforePath: '/en/a' };
  const out = applyAccepted(findings, [{ page: '/en/*', check: 'content.text', match: 'Legacy', reason: 'retired' }, { check: 'meta.title', reason: 'new brand' }], page);
  assert.equal(out.length, 2);
  assert.equal(out[0].items.length, 1);
  assert.equal(out[0].acceptedItems.length, 1);
  assert.ok(out[1].accepted);
  assert.equal(worstSeverity(out), 'fail');
  const other = applyAccepted(findings, [{ page: '/fr/*', check: 'meta.title', reason: 'x' }], page);
  assert.equal(other[1].accepted, undefined);
});

test('rules: accepted.json requires a reason', () => {
  const f = path.join(os.tmpdir(), `pc-acc-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify([{ check: 'meta.title' }]));
  assert.throws(() => loadAccepted(f), /reason/);
  fs.rmSync(f);
});

test('rules.deriveStatus priority', () => {
  const fail = [{ check: 'x', severity: 'fail' }];
  assert.equal(deriveStatus({ blocked: 'x', findings: fail }), 'blocked');
  assert.equal(deriveStatus({ findings: fail, flaky: true }), 'fail');
  assert.equal(deriveStatus({ findings: [{ check: 'x', severity: 'review' }], flaky: true }), 'flaky');
  assert.equal(deriveStatus({ findings: [{ check: 'x', severity: 'review' }], unstable: true }), 'unstable');
  assert.equal(deriveStatus({ findings: [{ check: 'x', severity: 'fail', accepted: { reason: 'r' } }] }), 'pass');
});

test('guard: bot-protection detection, pacing and retry', async () => {
  assert.match(classifyBlock({ status: 403, headers: { 'CF-Ray': '1' } }), /403/);
  assert.match(classifyBlock({ status: 429 }), /429/);
  assert.equal(classifyBlock({ status: 404, body: 'Not found' }), null);
  assert.equal(classifyBlock({ status: 403, body: 'Forbidden' }), null);
  assert.match(classifyBlock({ status: 200, body: '<p>Verify you are human</p>' }), /challenge/);

  const sleeps = [];
  let now = 0;
  const pacer = createPacer(100, () => now, async (ms) => sleeps.push(ms));
  await pacer.wait('h');
  await pacer.wait('h');
  await pacer.wait('other');
  assert.deepEqual(sleeps, [100]);

  let calls = 0;
  const r = await withRetry(async () => {
    if (++calls === 1) throw new Error('Timeout 30000ms exceeded');
    return 'ok';
  });
  assert.deepEqual(r, { value: 'ok', retried: true });
  await assert.rejects(withRetry(async () => { throw new Error('syntax error'); }), /syntax/);
});

test('functional.classifyRequest identifies analytics vendors', () => {
  assert.equal(classifyRequest('https://x.com/b/ss/suite1/1/JS-2.0/s1?pageName=Home', 'GET', '').kind, 'aa');
  assert.equal(classifyRequest('https://assets.adobedtm.com/launch-abc.min.js', 'GET', '').kind, 'launch');
  assert.equal(classifyRequest('https://www.google-analytics.com/g/collect?v=2&tid=G-1', 'GET', '').kind, 'ga4');
  assert.equal(classifyRequest('https://example.com/app.js', 'GET', ''), null);
});

test('completeness.robotsBlocksAll', () => {
  assert.ok(robotsBlocksAll('User-agent: *\nDisallow: /\n'));
  assert.ok(!robotsBlocksAll('User-agent: *\nDisallow: /admin\n'));
  assert.ok(!robotsBlocksAll('User-agent: bot\nDisallow: /\nUser-agent: *\nAllow: /\n'));
});

test('visual.pairSections matches by text, then by order', () => {
  const s = (name, fp) => ({ name, fp });
  const r = pairSections([s('main-1', 'alpha beta'), s('main-2', 'gamma delta'), s('footer', 'foot')], [s('main-1', 'new intro'), s('main-2', 'gamma delta'), s('main-3', 'alpha beta'), s('footer', 'foot')]);
  assert.equal(r.pairs.length, 3);
  assert.equal(r.missing.length, 0);
  assert.equal(r.added.length, 1);
});

test('report: renders escaped html, csv and exit code', () => {
  const pairs = [
    { id: 'a-1', before: 'https://b/<x>', after: 'https://a/x', status: 'fail', findings: [{ check: 'meta.title', severity: 'fail', summary: '<script>alert(1)</script>', items: [{ text: 'Only one' }] }] },
    { id: 'b-1', before: 'https://b/y', after: 'https://a/y', status: 'pass', findings: [] },
  ];
  const html = renderHtml({ generatedAt: 'now', viewports: [1440], pairs, notTested: ['x'] });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('data-accept'));
  assert.equal(exitCode(pairs), 1);
  assert.equal(exitCode([pairs[1]]), 0);
  assert.equal(summarize(pairs).fail, 1);
  assert.match(toCsv(pairs), /^status,before,after/);
});

test('completeness: findings keep items as a list so the report renders', async () => {
  const fetcher = { redirectOf: async () => ({ status: 404, location: '' }) };
  const { findings } = await redirectFindings([{ from: 'https://b/old', to: 'https://a/new' }], fetcher, 'https://a');
  assert.equal(findings.length, 1);
  assert.ok(Array.isArray(findings[0].items));
  assert.equal(findings[0].items.length, 1);
  const html = renderHtml({ generatedAt: 'now', viewports: [1440], pairs: [{ id: 'r-1', before: 'https://b/old', after: 'https://a/new', status: 'fail', findings }], notTested: [] });
  assert.ok(html.includes('redirect.wrong'));
});

// ---------- markdown report ----------

const mdPair = (findings, extra = {}) => ({ id: 'p-1', before: 'https://b/x', after: 'https://a/x', status: 'fail', noise: 0, findings, ...extra });
const mdRun = (pairs, completeness = {}) => ({ generatedAt: 'now', viewports: [1440, 375], pairs, completeness, notTested: ['Interactions'] });

test('markdown: areaOf groups checks into content, visual and integration', () => {
  assert.equal(areaOf('heading.missing'), 'content');
  assert.equal(areaOf('link.target'), 'content');
  assert.equal(areaOf('visual.section'), 'visual');
  assert.equal(areaOf('console.error'), 'integration');
  assert.equal(areaOf('link.broken'), 'integration');
  assert.equal(areaOf('site.robots'), 'integration');
});

test('markdown: report has the three areas with their own result', () => {
  const md = toMarkdown(mdRun([mdPair([
    { check: 'heading.missing', severity: 'review', summary: '1 heading(s) missing', items: [{ text: 'About us', level: 2 }] },
    { check: 'link.broken', severity: 'fail', summary: '1 internal link(s) return an error', items: [{ text: 'Shop', url: 'https://a/shop', status: 404 }] },
  ])]));
  assert.match(md, /### Content parity: ⚠️ Review/);
  assert.match(md, /### Visual parity: ✅ Pass/);
  assert.match(md, /### Integration: ❌ Fail/);
  assert.match(md, /\| Content parity \| ⚠️ Review \| 0 \| 1 \|/);
  assert.match(md, /\| About us \| 2 \|/);
  assert.match(md, /\| Shop \| https:\/\/a\/shop \| 404 \|/);
  assert.match(md, /## Not tested/);
});

test('markdown: a section reported missing and added at the same spot is one content change', () => {
  const sec = (viewport, text) => ({ section: 'main-2:.section', viewport, text });
  const md = toMarkdown(mdRun([mdPair([
    { check: 'visual.section.missing', severity: 'fail', summary: 'missing', items: [sec('1440', 'old testimonial'), sec('375', 'old testimonial')] },
    { check: 'visual.section.added', severity: 'info', summary: 'added', items: [sec('1440', 'new testimonial'), sec('375', 'new testimonial')] },
  ], { visual: { rows: [{ viewport: '1440', section: 'main-1', status: 'pass' }, { viewport: '1440', section: 'main-2', status: 'missing' }, { viewport: '1440', section: 'main-2', status: 'added' }] } })]));
  assert.match(md, /content differs/);
  assert.match(md, /\| main-2:\.section \| 1440px, 375px \| old testimonial \| new testimonial \|/);
  assert.match(md, /\| 1440px \| 1 \| 1 \| 0 \| 1 \| 1 \|/);
  assert.ok(!md.includes('Section only on the before page'));
});

test('markdown: escapes table cells and caps long lists', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ text: i === 0 ? 'a|b <script>' : `t${i}` }));
  const md = toMarkdown(mdRun([mdPair([{ check: 'cta.missing', severity: 'review', summary: '12 missing', items }])]));
  assert.ok(md.includes('a\\|b &lt;script&gt;'));
  assert.ok(!md.includes('<script>'));
  assert.match(md, /…and 2 more/);
});

test('markdown: site-wide findings count under integration and clean pages say so', () => {
  const md = toMarkdown(mdRun([mdPair([], { status: 'pass' })], { siteFindings: [{ check: 'site.robots', severity: 'fail', summary: 'robots.txt disallows everything' }] }));
  assert.match(md, /\| Integration \| ❌ Fail \| 0 \| 0 \| 1 \| 1 \|/);
  assert.match(md, /## Site-wide checks/);
  const clean = toMarkdown(mdRun([mdPair([], { status: 'pass' })]));
  assert.match(clean, /\*\*Overall: ✅ Pass\*\*/);
});

// ---------- accuracy fixes ----------

const { contentFindings, makeCanon } = require('./lib/content');
const { siteFindings } = require('./lib/completeness');
const { DEFAULT_RULES, reusableResult } = require('./lib/rules');
const { volatileSections } = require('./lib/visual');

const snap = (extra = {}) => ({ status: 200, finalUrl: '', redirects: [], lang: 'en', title: 'T', meta: { canonical: '' }, hreflang: [], favicon: true, headings: [], blocks: [], images: [], links: [], nav: [], ctas: [], forms: [], jsonld: [], downloads: [], ...extra });
const ctxFor = (beforeUrl, afterUrl) => ({ beforeUrl, afterUrl, beforeHost: new URL(beforeUrl).host, afterHost: new URL(afterUrl).host, canon: makeCanon({ beforeUrl, afterUrl }), rules: DEFAULT_RULES, volatile: [] });

test('content: consent banner only on the before page is a single consent.missing finding', () => {
  const ctx = ctxFor('https://www.b.com/', 'https://www.a.com/');
  const out = contentFindings(snap({ consent: true }), snap({ consent: false }), ctx);
  const consent = out.filter((f) => f.check === 'consent.missing');
  assert.equal(consent.length, 1);
  assert.equal(consent[0].severity, 'review');
  assert.equal(contentFindings(snap({ consent: true }), snap({ consent: true }), ctx).filter((f) => f.check.startsWith('consent')).length, 0);
});

test('visual.volatileSections finds sections whose text changes between two loads', () => {
  const s = (name, fp) => ({ name, fp });
  const before = [s('main-1', 'alpha beta gamma'), s('main-2', 'great guidance and clean execution from the team')];
  const before2 = [s('main-1', 'alpha beta gamma'), s('main-2', 'professional clean and seamless design support')];
  assert.deepEqual([...volatileSections(before, before2)], ['main-2']);
});

test('visual.pairSections pairs a volatile section by name even when its text differs', () => {
  const s = (name, fp) => ({ name, fp });
  const before = [s('main-1', 'alpha beta gamma'), s('main-2', 'great guidance and clean execution from the team')];
  const after = [s('main-1', 'alpha beta gamma'), s('main-2', 'professional clean and seamless design support')];
  assert.equal(pairSections(before, after).missing.length, 1);
  const r = pairSections(before, after, { byName: new Set(['main-2']) });
  assert.equal(r.pairs.length, 2);
  assert.equal(r.missing.length, 0);
  assert.equal(r.added.length, 0);
});

test('visual.pairSections treats a same-named section with the same heading as changed, not missing', () => {
  const s = (name, fp) => ({ name, fp });
  const before = [s('main-1', 'alpha beta gamma'), s('main-10', 'what ourclients say about us great guidance and clean execution the bhps team explained the full process clearly and the supervisor guided me on current design trends and colour choices that suited our home')];
  const after = [s('main-1', 'alpha beta gamma'), s('main-10', 'what ourclients say about us professional clean and seamlessbhps stood out with execution excellence and design support that truly brought our vision alive we would recommend them to every homeowner')];
  const r = pairSections(before, after);
  assert.equal(r.pairs.length, 2);
  assert.equal(r.missing.length, 0);
  const other = pairSections([s('main-3', 'pricing plans for every team size')], [s('main-3', 'security reviews and audit logging')]);
  assert.equal(other.missing.length, 1, 'different heading means a different section');
});

test('report: flaky pages are flagged in csv, html and markdown even when they fail', () => {
  const pair = { id: 'f-1', before: 'https://b/x', after: 'https://a/x', status: 'fail', flaky: true, volatilePct: 13, findings: [{ check: 'meta.title', severity: 'fail', summary: 'Title missing' }] };
  assert.match(toCsv([pair]).split('\n')[1], /,yes,/);
  assert.match(renderHtml({ generatedAt: 'now', viewports: [1440], pairs: [pair], notTested: [] }), /changes between loads/);
  assert.match(toMarkdown({ generatedAt: 'now', viewports: [1440], pairs: [pair], completeness: {}, notTested: [] }), /> ⚠️ .*changes between loads/);
});

test('resume: blocked and errored results are retried, finished ones are reused', () => {
  assert.equal(reusableResult({ id: 'a', rawFindings: [] }), true);
  assert.equal(reusableResult({ id: 'a', blocked: 'cloudflare', rawFindings: [] }), false);
  assert.equal(reusableResult({ id: 'a', error: 'timeout', rawFindings: [] }), false);
  assert.equal(reusableResult(null), false);
});

test('preview hosts: robots.txt disallow and production canonical are review, not fail', async () => {
  const fetcher = { text: async (url) => ({ status: 200, body: url.includes('aem.page') || url.includes('stage.a.com') ? 'User-agent: *\nDisallow: /\n' : 'User-agent: *\nAllow: /\n' }) };
  const preview = await siteFindings({ beforeOrigin: 'https://www.b.com', afterOrigin: 'https://main--site--org.aem.page', fetcher });
  assert.equal(preview.find((f) => f.check === 'site.robots').severity, 'review');
  const prod = await siteFindings({ beforeOrigin: 'https://www.b.com', afterOrigin: 'https://stage.a.com', fetcher });
  assert.equal(prod.find((f) => f.check === 'site.robots').severity, 'fail');

  const canon = (afterUrl) => contentFindings(snap({ meta: { canonical: 'https://www.b.com/' } }), snap({ meta: { canonical: 'https://www.b.com/' } }), ctxFor('https://www.b.com/', afterUrl)).find((f) => f.check === 'meta.canonical');
  assert.equal(canon('https://main--site--org.aem.page/').severity, 'review');
  assert.equal(canon('https://stage.a.com/').severity, 'fail');
});

// ---------- markdown at scale ----------

const { renderMarkdownFiles } = require('./lib/markdown');

function scaleRun(n) {
  const pairs = Array.from({ length: n }, (_, i) => {
    const pass = i % 10 === 0;
    return {
      id: `p${i}-abc`, before: `https://www.b.com/p${i}`, after: `https://www.a.com/p${i}`, status: pass ? 'pass' : 'fail', noise: 0,
      findings: pass ? [] : [
        { check: 'meta.canonical', severity: 'fail', summary: 'Canonical still points to a different host than the after page', before: `https://www.b.com/p${i}`, after: `https://www.b.com/p${i}` },
        { check: 'link.broken', severity: 'fail', summary: '2 internal link(s) on the after page return an error', items: [{ text: 'Store', url: 'https://www.a.com/store.html', status: 404 }, { text: 'Own', url: `https://www.a.com/own-${i}.html`, status: 404 }] },
        { check: 'console.error', severity: 'review', summary: '1 new console error(s) on the after page', items: [{ message: `Access to fetch at 'https://api.x/cart.json?_=${1793874404668 + i}' blocked by CORS policy` }] },
      ],
    };
  });
  return { generatedAt: 'now', viewports: [1440], pairs, completeness: { siteFindings: [] }, notTested: ['Interactions'] };
}

const csvRows = (text) => text.trim().split('\n');

test('markdown scale: report.md stays about the same size from 10 to 1000 pages', () => {
  const small = renderMarkdownFiles(scaleRun(10))['report.md'];
  const big = renderMarkdownFiles(scaleRun(1000))['report.md'];
  assert.ok(big.length < 20000, `report.md is ${big.length} chars at 1000 pages`);
  assert.ok(big.length - small.length < 4000, `report.md grew by ${big.length - small.length} chars`);
});

test('markdown scale: the same issue on many pages is one issue with a page count', () => {
  const files = renderMarkdownFiles(scaleRun(100));
  const rows = csvRows(files['issues.csv']);
  assert.match(rows[0], /^severity,area,check,issue,pages_affected,example_page/);
  const store = rows.filter((r) => r.includes('https://www.a.com/store.html'));
  assert.equal(store.length, 1);
  assert.match(store[0], /,90,/);
  assert.equal(rows.filter((r) => r.includes('meta.canonical')).length, 1);
  assert.equal(rows.filter((r) => r.includes('console.error')).length, 1, 'cache-buster numbers must not split one console error into many');
  assert.match(files['report.md'], /Canonical still points to a different host[^\n]*\| 90 \|/);
});

test('markdown scale: every page is in pages.csv and each page with problems gets its own file', () => {
  const files = renderMarkdownFiles(scaleRun(500));
  const rows = csvRows(files['pages.csv']);
  assert.match(rows[0], /^page,status,flaky,content,visual,integration,fail,review,top_issue,detail,before,after/);
  assert.equal(rows.length, 501);
  const pageFiles = Object.keys(files).filter((k) => k.startsWith('pages/'));
  assert.equal(pageFiles.length, 450);
  assert.match(files[pageFiles[0]], /### Content parity/);
  assert.match(files['report.md'], /pages\.csv/);
});

test('markdown scale: long lists say what was left out', () => {
  const files = renderMarkdownFiles(scaleRun(500));
  assert.match(files['issues.md'], /more in issues\.csv/);
  assert.match(files['report.md'], /and \d+ more/);
});

// ---------- review fixes: safe output, csv injection, locale groups ----------

const { writeReportFiles } = require('./lib/markdown');
const { groupOf } = require('./lib/pairs');

test('output: stale page details are removed one file at a time and user files in pages/ survive', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-out-'));
  fs.mkdirSync(path.join(out, 'pages', 'notes'), { recursive: true });
  fs.mkdirSync(path.join(out, 'pairs', 'old-1'), { recursive: true });
  fs.writeFileSync(path.join(out, 'pages', 'my-notes.md'), 'keep me');
  fs.writeFileSync(path.join(out, 'pages', 'notes', 'deep.txt'), 'keep me too');
  fs.writeFileSync(path.join(out, 'pages', 'old-1.md'), 'stale detail from a previous run');
  writeReportFiles(out, { 'report.md': 'new', 'pages/new-1.md': 'detail' });
  assert.equal(fs.readFileSync(path.join(out, 'pages', 'my-notes.md'), 'utf8'), 'keep me');
  assert.equal(fs.readFileSync(path.join(out, 'pages', 'notes', 'deep.txt'), 'utf8'), 'keep me too');
  assert.ok(!fs.existsSync(path.join(out, 'pages', 'old-1.md')), 'stale detail of a page from this tool is removed');
  assert.equal(fs.readFileSync(path.join(out, 'pages', 'new-1.md'), 'utf8'), 'detail');
  fs.rmSync(out, { recursive: true, force: true });
});

test('csv: cells that start with a formula character are neutralised in every csv', () => {
  const hostile = ['=HYPERLINK("http://evil","x")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd'];
  const findings = hostile.map((t, i) => ({ check: 'cta.missing', severity: 'review', summary: t, items: [{ text: t }] }));
  const run = { generatedAt: 'now', viewports: [1440], completeness: {}, notTested: [], pairs: [{ id: 'x-1', before: 'https://b/x', after: 'https://a/x', label: hostile[0], status: 'fail', findings }] };
  const files = renderMarkdownFiles(run);
  const firstChar = (csv) => csv.split('\n').flatMap((l) => l.split(',')).map((c) => c.replace(/^"/, '')[0]);
  for (const name of ['issues.csv', 'pages.csv']) {
    for (const c of firstChar(files[name])) assert.ok(!['=', '+', '-', '@', '\t', '\r'].includes(c), `${name} has a cell starting with ${JSON.stringify(c)}: ${files[name]}`);
  }
  const summary = toCsv(run.pairs);
  for (const c of firstChar(summary)) assert.ok(!['=', '+', '-', '@', '\t', '\r'].includes(c), `summary.csv has a cell starting with ${JSON.stringify(c)}`);
  assert.ok(files['issues.csv'].includes("'=HYPERLINK"));
});

test('csv: ordinary values and numbers are not altered', () => {
  const run = { generatedAt: 'now', viewports: [1440], completeness: {}, notTested: [], pairs: [{ id: 'x-1', before: 'https://b/x', after: 'https://a/x', status: 'fail', findings: [{ check: 'meta.title', severity: 'fail', summary: 'Title missing' }] }] };
  const rows = renderMarkdownFiles(run)['pages.csv'].trim().split('\n');
  assert.match(rows[1], /^\/x,fail,,fail,pass,pass,1,0,Title missing,pages\/x-1\.md,https:\/\/b\/x,https:\/\/a\/x$/);
});

test('pairs: groupOf skips locale and AEM /content/<site> prefixes', () => {
  const g = (u) => groupOf({ before: u });
  assert.equal(g('https://b.com/en/blog/a'), 'blog');
  assert.equal(g('https://b.com/en-us/products/x'), 'products');
  assert.equal(g('https://b.com/en_GB/products/x'), 'products');
  assert.equal(g('https://b.com/content/site/en/blog/a'), 'blog');
  assert.equal(g('https://b.com/content/site/blog/a'), 'blog');
  assert.equal(g('https://b.com/blog/a'), 'blog');
  assert.equal(g('https://b.com/en'), '/');
  assert.equal(g('https://b.com/'), '/');
  assert.equal(g('https://b.com/about'), 'about');
  assert.equal(groupOf({ before: 'https://b.com/en/blog/a', group: 'article' }), 'article');
});

test('pairs: --per-group on a locale-prefixed site samples each section, not each locale', async () => {
  const fetchText = async () => '<urlset>' + ['en/blog/a', 'en/blog/b', 'en/blog/c', 'en/products/x', 'en/products/y', 'fr/blog/d'].map((p) => `<url><loc>https://b.com/${p}</loc></url>`).join('') + '</urlset>';
  const { pairs } = await loadPairs({ sitemap: 'https://b.com/sitemap.xml', map: ['b.com=a.com'], perGroup: '1' }, fetchText);
  assert.deepEqual(pairs.map((p) => p.before), ['https://b.com/en/blog/a', 'https://b.com/en/products/x']);
});

// ---------- per-group sampling ----------

test('pairs: --per-group keeps N pages from each CSV group', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-group-'));
  const csv = path.join(dir, 'p.csv');
  fs.writeFileSync(csv, 'before,after,label,group\nhttps://b/a1,https://a/a1,,article\nhttps://b/a2,https://a/a2,,article\nhttps://b/a3,https://a/a3,,article\nhttps://b/p1,https://a/p1,,product\nhttps://b/p2,https://a/p2,,product\n');
  const { pairs } = await loadPairs({ pairs: csv, perGroup: '2' });
  assert.deepEqual(pairs.map((p) => p.before), ['https://b/a1', 'https://b/a2', 'https://b/p1', 'https://b/p2']);
  await assert.rejects(loadPairs({ pairs: csv, perGroup: 'all' }), /--per-group/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pairs: --per-group falls back to the first path segment of the before URL', async () => {
  const fetchText = async () => '<urlset><url><loc>https://b.com/</loc></url><url><loc>https://b.com/blog/a</loc></url><url><loc>https://b.com/blog/b</loc></url><url><loc>https://b.com/products/x</loc></url><url><loc>https://b.com/products/y</loc></url></urlset>';
  const { pairs } = await loadPairs({ sitemap: 'https://b.com/sitemap.xml', map: ['b.com=a.com'], perGroup: '1' }, fetchText);
  assert.deepEqual(pairs.map((p) => p.before), ['https://b.com/', 'https://b.com/blog/a', 'https://b.com/products/x']);
});

// ---------- end to end (needs Chromium) ----------

function chromiumAvailable() {
  const r = spawnSync(process.execPath, ['-e', "require('playwright').chromium.launch().then(b=>b.close()).then(()=>process.exit(0),()=>process.exit(1))"], { cwd: __dirname });
  return r.status === 0;
}

const e2e = chromiumAvailable() ? test : test.skip;

e2e('end to end: fixture site comparison', { timeout: 280000 }, async () => {
  const { start, scenarios } = require('./fixtures/server');
  const { server, port } = await start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-e2e-'));
  try {
    const paths = Object.keys(scenarios);
    const csv = ['before,after', ...paths.map((p) => `http://127.0.0.1:${port}${p},http://localhost:${port}${p}`)].join('\n');
    const pairsFile = path.join(dir, 'pairs.csv');
    fs.writeFileSync(pairsFile, csv);
    const out = path.join(dir, 'out');
    fs.mkdirSync(path.join(out, 'pages'), { recursive: true });
    fs.writeFileSync(path.join(out, 'pages', 'my-notes.md'), 'keep me');
    const run = (extra, standalone = false) =>
      new Promise((resolve) => {
        const args = standalone ? ['--pace-ms', '0', ...extra] : ['--pairs', pairsFile, '--out', out, '--viewports', '1440,375', '--pace-ms', '0', '--concurrency', '4', ...extra];
        const p = require('child_process').spawn(process.execPath, [path.join(__dirname, 'compare.js'), ...args], { stdio: 'pipe' });
        let output = '';
        p.stdout.on('data', (d) => (output += d));
        p.stderr.on('data', (d) => (output += d));
        p.on('close', (code) => resolve({ code, output }));
      });

    const first = await run([]);
    assert.equal(first.code, 1, first.output);
    assert.equal(fs.readFileSync(path.join(out, 'pages', 'my-notes.md'), 'utf8'), 'keep me', 'a user file in <out>/pages must survive a run');
    const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
    const by = Object.fromEntries(report.pairs.map((p) => [new URL(p.after).pathname, p]));
    const checks = (p) => by[p].findings.map((f) => f.check);

    assert.equal(by['/identical'].status, 'pass', JSON.stringify(by['/identical'].findings));
    assert.deepEqual(by['/identical'].findings, []);
    assert.equal(by['/text-removed'].status, 'fail');
    assert.ok(checks('/text-removed').includes('content.text.missing'));
    assert.ok(checks('/text-removed').includes('visual.section.missing'));
    assert.ok(checks('/alt-changed').includes('image.alt.changed'));
    assert.ok(checks('/link-retargeted').includes('link.target'));
    assert.equal(by['/gone'].status, 'fail');
    assert.ok(checks('/gone').includes('page.missing'));
    assert.ok(checks('/js-error').includes('js.error'));
    assert.ok(checks('/section-added').includes('visual.section.added'));
    assert.ok(!checks('/section-added').some((c) => c === 'visual.section'), 'sub-pixel shift must not flag unchanged sections');
    assert.ok(checks('/color-change').includes('visual.section'));
    assert.deepEqual(by['/volatile'].findings.filter((f) => f.severity !== 'info'), []);
    assert.ok(by['/hidden-tab'].findings.some((f) => f.check === 'content.text.missing' && f.items.some((i) => i.hidden)));
    assert.equal(by['/blocked'].status, 'blocked');
    assert.equal(by['/flaky'].status, 'flaky');
    assert.ok(checks('/analytics').some((c) => c.startsWith('analytics.')));
    assert.ok(checks('/redirect').includes('redirect.temporary'));
    assert.ok(checks('/consent').includes('consent.missing'), JSON.stringify(by['/consent'].findings));
    for (const c of ['heading.missing', 'cta.missing', 'image.missing', 'link.missing', 'content.text.missing']) {
      assert.ok(!checks('/consent').includes(c), `consent banner leaked into ${c}: ${JSON.stringify(by['/consent'].findings)}`);
    }
    assert.ok(!checks('/rotating').includes('visual.section.missing'), JSON.stringify(by['/rotating'].findings));
    assert.deepEqual(by['/rotating'].findings.filter((f) => f.severity === 'fail'), []);
    assert.ok(fs.existsSync(path.join(out, 'report.html')));
    assert.ok(fs.existsSync(path.join(out, 'summary.csv')));
    for (const f of ['report.md', 'issues.md', 'issues.csv', 'pages.csv']) assert.ok(fs.existsSync(path.join(out, f)), `${f} missing`);
    assert.equal(fs.readFileSync(path.join(out, 'pages.csv'), 'utf8').trim().split('\n').length, paths.length + 1);
    assert.ok(fs.existsSync(path.join(out, 'pages', `${by['/text-removed'].id}.md`)));
    assert.ok(!fs.existsSync(path.join(out, 'pages', `${by['/identical'].id}.md`)), 'passing pages get no detail file');
    const flagged = by['/color-change'].findings.find((f) => f.check === 'visual.section');
    assert.ok(fs.existsSync(path.join(out, 'pairs', by['/color-change'].id, 'visual', flagged.items[0].files.diff)));

    // accept a difference and reapply without reloading pages
    const acceptedFile = path.join(dir, 'accepted.json');
    fs.writeFileSync(acceptedFile, JSON.stringify([{ page: '/accepted', check: 'content.text', reason: 'Section retired' }, { page: '/accepted', check: 'heading', reason: 'Section retired' }, { page: '/accepted', check: 'visual', reason: 'Section retired' }]));
    const second = await run(['--resume', '--accept', acceptedFile]);
    assert.ok(second.output.includes('Report:'), second.output);
    const again = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
    const acc = again.pairs.find((p) => p.after.endsWith('/accepted'));
    assert.equal(acc.status, 'pass');
    assert.ok(acc.findings.length > 0 && acc.findings.every((f) => f.accepted));

    // comparing a page with itself must be clean
    const self = await run(['--before', `http://127.0.0.1:${port}/identical`, '--after', `http://127.0.0.1:${port}/identical`, '--out', path.join(dir, 'self'), '--viewports', '1440'], true);
    assert.equal(self.code, 0, self.output);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: usage errors exit with 2', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'compare.js'), '--bogus'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  const none = spawnSync(process.execPath, [path.join(__dirname, 'compare.js'), '--out', os.tmpdir() + '/pc-none'], { encoding: 'utf8' });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /No pages to compare/);
});
