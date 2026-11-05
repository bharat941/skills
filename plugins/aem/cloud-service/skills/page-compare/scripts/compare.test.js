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
    assert.ok(fs.existsSync(path.join(out, 'report.html')));
    assert.ok(fs.existsSync(path.join(out, 'summary.csv')));
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
