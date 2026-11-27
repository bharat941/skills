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
const { renderHtml, exitCode, summarize } = require('./lib/report');
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

test('report: renders escaped html and exit code', () => {
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
  assert.match(renderMarkdownFiles({ generatedAt: 'now', viewports: [1440], pairs: [pair], completeness: {}, notTested: [] })['pages.csv'].split('\n')[1], /,yes,/);
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
  assert.match(rows[0], /^fix_id,priority,area,section,fix_type,owner,problem,how_many,pages_affected,source_value,destination_value,example_page,pages$/);
  const store = rows.filter((r) => r.includes('Link to /store.html'));
  assert.equal(store.length, 1);
  assert.match(store[0], /,90,/);
  assert.equal(rows.filter((r) => r.includes('Canonical still points')).length, 1);
  assert.equal(rows.filter((r) => r.includes('console error')).length, 1, 'cache-buster numbers must not split one console error into many');
});

test('markdown scale: every page is in pages.csv and each page with problems gets its own file', () => {
  const files = renderMarkdownFiles(scaleRun(500));
  const rows = csvRows(files['pages.csv']);
  assert.match(rows[0], /^page,status,flaky,content,visual,functional,integration,fail,review,p1,p2,p3,content_parity,visual_parity,functional_parity,top_issue,detail,before,after/);
  assert.equal(rows.length, 501);
  const pageFiles = Object.keys(files).filter((k) => k.startsWith('pages/'));
  assert.equal(pageFiles.length, 450);
  assert.match(files[pageFiles[0]], /## Content parity/);
  assert.match(files['report.md'], /pages\.csv/);
});

test('markdown scale: long lists say what was left out', () => {
  const run = scaleRun(500);
  for (const p of run.pairs) for (let k = 0; k < 20; k++) p.findings.push({ check: `extra.check${k}`, severity: 'fail', summary: `Extra problem ${k}` });
  const md = renderMarkdownFiles(run)['report.md'];
  assert.match(md, /…and \d+ more in fixes\.json/);
});

// ---------- spreadsheet input ----------

const zlib = require('zlib');
const { pairsFromRows, readPairsFile } = require('./lib/pairs');
const { readXlsxRows } = require('./lib/xlsx');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

// Minimal zip writer so the tests can build workbooks laid out the way Excel stores them.
function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text, method = 8] of entries) {
    const raw = Buffer.from(text);
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(4, 28);
    const extra = Buffer.alloc(4);
    locals.push(local, nameBuf, extra, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc32(raw), 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + 4 + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';

// rows: arrays of strings, written as shared strings (t="s") like Excel does.
function makeXlsx(rows, { sheetNames = ['in'], extraEntries = [] } = {}) {
  const strings = [];
  const idx = (s) => (strings.includes(s) ? strings.indexOf(s) : strings.push(s) - 1);
  const col = (i) => String.fromCharCode(65 + i);
  const sheetRows = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => `<c r="${col(ci)}${ri + 1}" t="s"><v>${idx(v)}</v></c>`).join('')}</row>`).join('');
  const sst = `${XML}<sst ${NS} count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${s.replace(/&/g, '&amp;')}</t></si>`).join('')}</sst>`;
  const sheets = sheetNames.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const rels = sheetNames.map((n, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  return makeZip([
    ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`],
    ['xl/workbook.xml', `${XML}<workbook ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`],
    ['xl/sharedStrings.xml', sst],
    ['xl/worksheets/sheet1.xml', `${XML}<worksheet ${NS}><sheetData>${sheetRows}</sheetData></worksheet>`],
    ...sheetNames.slice(1).map((n, i) => [`xl/worksheets/sheet${i + 2}.xml`, `${XML}<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>https://other.example/</t></is></c></row></sheetData></worksheet>`]),
    ...extraEntries,
  ]);
}

const tmpFile = (name, content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-sheet-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
};

test('xlsx: reads rows from the first sheet, columns in order', () => {
  const file = tmpFile('p.xlsx', makeXlsx([['before', 'after', 'label'], ['https://b/a', 'https://a/a', 'Home']], { sheetNames: ['in', 'second'] }));
  assert.deepEqual(readXlsxRows(file), [['before', 'after', 'label'], ['https://b/a', 'https://a/a', 'Home']]);
});

test('xlsx: handles rich text, inline strings, entities, stored entries and gaps in columns', () => {
  const sst = `${XML}<sst ${NS}><si><r><t>https://b/a?x=1&amp;</t></r><r><t>y=2</t></r></si><si><t>https://a/a</t><rPh><t>ignored</t></rPh></si></sst>`;
  const sheet = `${XML}<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>section</t></is></c></row><row r="2"><c r="A2" t="str"><v>https://b/z</v></c><c r="B2"><v>7</v></c></row></sheetData></worksheet>`;
  const zip = makeZip([['xl/workbook.xml', `${XML}<workbook ${NS}><sheets><sheet name="s" sheetId="1" r:id="rId9" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>`, 0], ['xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Target="/xl/worksheets/sheet1.xml"/></Relationships>`], ['xl/sharedStrings.xml', sst, 0], ['xl/worksheets/sheet1.xml', sheet]]);
  assert.deepEqual(readXlsxRows(tmpFile('r.xlsx', zip)), [['https://b/a?x=1&y=2', 'https://a/a', '', 'section'], ['https://b/z', '7']]);
});

test('xlsx: a file that is not a workbook gives a clear error', () => {
  assert.throws(() => readXlsxRows(tmpFile('bad.xlsx', 'not a zip at all')), /not an \.xlsx workbook/);
  assert.throws(() => readXlsxRows(tmpFile('empty.xlsx', makeZip([['hello.txt', 'hi']]))), /workbook/);
});

test('pairs: a sheet without a header row (before in column A, after in column B) is accepted', () => {
  const file = tmpFile('gm.xlsx', makeXlsx([['https://gm.com/', 'https://main--x--y.aem.live/'], ['https://gm.com/heritage', 'https://main--x--y.aem.live/heritage']]));
  assert.deepEqual(readPairsFile(file), [
    { before: 'https://gm.com/', after: 'https://main--x--y.aem.live/', label: '' },
    { before: 'https://gm.com/heritage', after: 'https://main--x--y.aem.live/heritage', label: '' },
  ]);
});

test('pairs: a sheet with a header row can name label and group columns in any order', () => {
  const file = tmpFile('h.xlsx', makeXlsx([['Group', 'After', 'Before', 'Label'], ['blog', 'https://a/1', 'https://b/1', 'One'], ['', 'https://a/2', 'https://b/2', '']]));
  assert.deepEqual(readPairsFile(file), [
    { before: 'https://b/1', after: 'https://a/1', label: 'One', group: 'blog' },
    { before: 'https://b/2', after: 'https://a/2', label: '' },
  ]);
});

test('pairs: a csv without a header row is accepted too', () => {
  const file = tmpFile('p.csv', 'https://b/1,https://a/1\n# a comment\nhttps://b/2,https://a/2,Two\n');
  assert.deepEqual(readPairsFile(file).map((p) => [p.before, p.after, p.label]), [['https://b/1', 'https://a/1', ''], ['https://b/2', 'https://a/2', 'Two']]);
});

test('pairs: a first row that is neither a header nor two URLs is rejected with what to fix', () => {
  assert.throws(() => pairsFromRows([['page', 'new page'], ['https://b/1', 'https://a/1']]), /"before" and "after"/);
  assert.throws(() => pairsFromRows([['https://b/1', 'not a url']]), /"before" and "after"/);
});

test('pairs: old .xls files and unreadable spreadsheets say to save as .xlsx or .csv', () => {
  assert.throws(() => readPairsFile(tmpFile('old.xls', 'x')), /\.xlsx or \.csv/);
});

test('pairs: loadPairs reads an .xlsx given to --pairs and applies per-group', async () => {
  const file = tmpFile('lp.xlsx', makeXlsx([['https://b/en/blog/a', 'https://a/en/blog/a'], ['https://b/en/blog/b', 'https://a/en/blog/b'], ['https://b/en/products/x', 'https://a/en/products/x']]));
  const { pairs } = await loadPairs({ pairs: file, perGroup: '1' });
  assert.deepEqual(pairs.map((p) => p.before), ['https://b/en/blog/a', 'https://b/en/products/x']);
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
  assert.ok(files['issues.csv'].includes("'=HYPERLINK"));
});

test('csv: ordinary values and numbers are not altered', () => {
  const run = { generatedAt: 'now', viewports: [1440], completeness: {}, notTested: [], pairs: [{ id: 'x-1', before: 'https://b/x', after: 'https://a/x', status: 'fail', findings: [{ check: 'meta.title', severity: 'fail', summary: 'Title missing' }] }] };
  const rows = renderMarkdownFiles(run)['pages.csv'].trim().split('\n');
  assert.match(rows[1], /^\/x,fail,,fail,pass,not checked,pass,1,0,0,1,0,100,,,Title missing,,https:\/\/b\/x,https:\/\/a\/x$/);
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

// ---------- report.md: verdict and action items ----------

const leadRun = () => mdRun([{
  id: 'lp-1', before: 'https://www.b.com/lpddr5x', after: 'https://publish-p1-e2.adobeaemcloud.com/lpddr5x', status: 'fail', noise: 0,
  findings: [
    { check: 'content.facts.changed', severity: 'fail', summary: '1 text block(s) state different figures on the after page', items: [{ before: 'With speeds up to 1.25 times faster and 25% better power efficiency', after: 'With speeds 1.3 times faster and 20% better power efficiency', numbersBefore: ['1.25', '25%'], numbersAfter: ['1.3', '20%'] }] },
    { check: 'image.broken', severity: 'fail', summary: '4 content image(s) fail to load on the after page', items: [1, 2, 3, 4].map((i) => ({ src: `https://cdn/dev/img${i}.png` })) },
    { check: 'link.broken', severity: 'fail', summary: '17 internal link(s) on the after page return an error', items: [{ url: 'https://publish-p1-e2.adobeaemcloud.com/', status: 404 }] },
    { check: 'analytics.rsid', severity: 'review', summary: 'Report suite differs from the before page', before: 'prodsuite', after: 'testsuite' },
  ],
}], { siteFindings: [{ check: 'site.robots', severity: 'fail', summary: 'robots.txt on the after site disallows everything (Disallow: / for all agents)' }] });

test('issues.csv and pages.csv carry the priority', () => {
  const files = renderMarkdownFiles(leadRun());
  const issues = csvRows(files['issues.csv']);
  assert.match(issues[0], /^fix_id,priority,area,/);
  assert.match(issues[1], /^C-[0-9a-f]{8},P1,/);
  assert.ok(issues.some((r) => /^I-[0-9a-f]{8},expected,/.test(r) && r.includes('robots.txt')));
  const pages = csvRows(files['pages.csv']);
  assert.match(pages[1], /,fail,pass,not checked,fail,3,1,2,1,0,/);
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
    for (const p of ['/wrapped', '/inline-style']) {
      assert.ok(!checks(p).includes('visual.section.missing'), `${p}: ${JSON.stringify(by[p].findings)}`);
      assert.deepEqual(by[p].findings.filter((f) => f.severity === 'fail'), [], p);
    }
    assert.ok(by['/wrapped'].visual.rows.filter((r) => r.viewport === '1440' && r.status === 'pass').length >= 5, 'sections inside single-child wrappers are compared one by one');
    assert.ok(fs.existsSync(path.join(out, 'report.html')));
    assert.ok(!/<script/i.test(fs.readFileSync(path.join(out, 'report.html'), 'utf8')), 'report.html is the leadership report, without scripts');
    assert.match(fs.readFileSync(path.join(out, 'review.html'), 'utf8'), /data-accept/, 'review.html keeps the Accept buttons');
    for (const f of ['report.md', 'fixes.json', 'issues.csv', 'pages.csv']) assert.ok(fs.existsSync(path.join(out, f)), `${f} missing`);
    for (const f of ['issues.md', 'summary.csv']) assert.ok(!fs.existsSync(path.join(out, f)), `${f} should not be written`);
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

// ---------- facts changed and rewritten copy ----------

test('diffBlocks: a rewrite with different numbers is facts changed', () => {
  const d = diffBlocks(
    [{ text: 'With speeds up to 1.25 times faster and 25% better power efficiency compared to the previous generation', region: 'main' }],
    [{ text: 'With speeds 1.3 times faster than the previous generation and 20% better power efficiency', region: 'main' }],
  );
  assert.equal(d.missing.length, 0);
  assert.equal(d.added.length, 0);
  assert.equal(d.rewritten.length, 1);
  assert.deepEqual(d.rewritten[0].numbersBefore, ['1.25', '25%']);
  assert.deepEqual(d.rewritten[0].numbersAfter, ['1.3', '20%']);
});

test('content: same numbers is rewritten, not facts changed', () => {
  const ctx = ctxFor('https://www.b.com/', 'https://www.a.com/');
  const out = contentFindings(snap({ blocks: [{ text: 'It took advanced 12nm process technology and innovative circuit designs', region: 'main' }] }),
    snap({ blocks: [{ text: 'It took the industry leading 12nm process technology and new circuit designs', region: 'main' }] }), ctx);
  assert.ok(out.some((f) => f.check === 'content.text.rewritten'), JSON.stringify(out));
  assert.ok(!out.some((f) => f.check === 'content.facts.changed'));
});

test('content: hidden main text still counts as missing, hidden header/footer text does not', () => {
  const d = diffBlocks([{ text: 'LPDDR5X is an enhanced version of LPDDR5 with higher speed', region: 'main', hidden: true },
    { text: 'Products Type', region: 'header', hidden: true }], []);
  assert.deepEqual(d.missing.map((m) => m.text), ['LPDDR5X is an enhanced version of LPDDR5 with higher speed']);
});

test('content: product names with digits are not facts (LPDDR5X, AEC-Q100)', () => {
  const ctx = ctxFor('https://www.b.com/', 'https://www.a.com/');
  const out = contentFindings(snap({ blocks: [{ text: 'LPDDR5X meets the AEC-Q100 standard for automotive memory parts', region: 'main' }] }),
    snap({ blocks: [{ text: 'The memory meets the automotive standard for parts in modern cars', region: 'main' }] }), ctx);
  assert.ok(!out.some((f) => f.check === 'content.facts.changed'), JSON.stringify(out));
});

// ---------- placeholder and empty-state text ----------

test('content: placeholder text only on the after page is content.placeholder', () => {
  const ctx = ctxFor('https://www.b.com/', 'https://www.a.com/');
  const after = snap({ blocks: [{ text: 'Disclaimer text 1', region: 'main' }, { text: 'Disclaimer text 2', region: 'main' }, { text: 'Disclaimer text 1', region: 'main' }, { text: 'Real copy about memory', region: 'main' }] });
  const found = contentFindings(snap({ blocks: [{ text: 'Real copy about memory', region: 'main' }] }), after, ctx).filter((f) => f.check === 'content.placeholder');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'fail');
  assert.deepEqual(found[0].items.map((i) => i.text), ['Disclaimer text 1', 'Disclaimer text 2']);
});

test('content: placeholder on both pages is not flagged', () => {
  const ctx = ctxFor('https://www.b.com/', 'https://www.a.com/');
  const both = snap({ blocks: [{ text: 'Lorem ipsum dolor sit amet', region: 'main' }] });
  assert.ok(!contentFindings(both, both, ctx).some((f) => f.check === 'content.placeholder'));
});

test('content: empty state only on the after page is content.empty_state', () => {
  const ctx = ctxFor('https://www.b.com/', 'https://www.a.com/');
  const found = contentFindings(snap({ blocks: [] }), snap({ blocks: [{ text: 'No results found', region: 'main' }] }), ctx).filter((f) => f.check === 'content.empty_state');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'review');
});

test('content: "Learn more" alone is never flagged as placeholder or empty state', () => {
  const ctx = ctxFor('https://www.b.com/', 'https://www.a.com/');
  const out = contentFindings(snap({ blocks: [] }), snap({ blocks: [{ text: 'Learn more', region: 'main' }, { text: 'Learn more', region: 'main' }] }), ctx);
  assert.ok(!out.some((f) => f.check === 'content.placeholder' || f.check === 'content.empty_state'));
});

// ---------- action items ----------

const { verdictOf } = require('./lib/actions');

const pairOf = (i, findings, extra = {}) => ({ id: `p${i}`, before: `https://www.b.com/p${i}`, after: `https://www.a.com/p${i}`, status: 'fail', findings, ...extra });
const actionRun = (pairs, completeness = {}) => ({ generatedAt: 'now', viewports: [1440], pairs, completeness, notTested: [] });

test('verdict: any P1 is Not ready, only P2 is Ready after fixes, none is No blocking differences found', () => {
  assert.equal(verdictOf([{ priority: 'P1' }, { priority: 'P2' }]).label, 'Not ready');
  assert.deepEqual(verdictOf([{ priority: 'P1' }, { priority: 'P2' }, { priority: 'P2' }, { priority: 'expected' }]), { label: 'Not ready', p1: 1, p2: 2, p3: 0, expected: 1, notCompared: 0 });
  assert.equal(verdictOf([{ priority: 'P2' }, { priority: 'P3' }]).label, 'Ready after fixes');
  assert.equal(verdictOf([{ priority: 'P3' }, { priority: 'expected' }]).label, 'No blocking differences found');
});

test('verdict: pages that could not be compared make an otherwise clean run Incomplete', () => {
  assert.equal(verdictOf([], { notCompared: 4 }).label, 'Incomplete');
  assert.equal(verdictOf([{ priority: 'P1' }], { notCompared: 4 }).label, 'Not ready');
});

// ---------- priority rubric ----------

const { priorityOf, ownerOf, DEFAULT_RULES: RULES } = require('./lib/rules');
const prod = { previewHost: false };
const preview = { previewHost: true };
const f = (check, severity = 'fail', extra = {}) => ({ check, severity, summary: check, ...extra });

test('priority: content loss is P1', () => {
  for (const c of ['content.text.missing', 'image.broken', 'image.missing', 'content.facts.changed', 'content.placeholder', 'heading.h1', 'form.field.missing']) {
    assert.equal(priorityOf(f(c), prod), 'P1', c);
  }
  assert.equal(priorityOf(f('content.text.missing', 'review'), prod), 'P1', 'missing content is P1 even when only a little text is gone');
});

test('priority: production robots stays P1, preview robots is expected', () => {
  assert.equal(priorityOf(f('site.robots'), prod), 'P1');
  assert.equal(priorityOf(f('site.robots', 'review'), preview), 'expected');
  assert.equal(priorityOf(f('meta.canonical', 'review'), preview), 'expected');
  assert.equal(priorityOf(f('meta.canonical'), prod), 'P1');
  assert.equal(priorityOf(f('site.sitemap', 'review'), preview), 'expected');
  assert.equal(priorityOf(f('site.sitemap', 'review'), prod), 'P3');
});

test('priority: analytics on preview is expected, on production P2', () => {
  assert.equal(priorityOf(f('analytics.rsid', 'review'), preview), 'expected');
  assert.equal(priorityOf(f('analytics.beacon'), prod), 'P2');
});

test('priority: header section missing is P3, main section missing is P1', () => {
  assert.equal(priorityOf(f('visual.section.missing', 'fail', { items: [{ section: 'header', viewport: '1440' }] }), prod), 'P3');
  assert.equal(priorityOf(f('visual.section.missing', 'fail', { items: [{ section: 'footer' }, { section: 'main-4:.faq' }] }), prod), 'P1');
  assert.equal(priorityOf(f('visual.section', 'fail'), prod), 'P2');
  assert.equal(priorityOf(f('visual.section', 'review'), prod), 'P3');
});

test('priority: info and accepted are not listed', () => {
  assert.equal(priorityOf(f('content.text.regrouped', 'info'), prod), null);
  assert.equal(priorityOf(f('content.text.missing', 'fail', { accepted: { reason: 'retired' } }), prod), null);
});

test('priority: unknown check fail→P2 review→P3', () => {
  assert.equal(priorityOf(f('brand.new.check', 'fail'), prod), 'P2');
  assert.equal(priorityOf(f('brand.new.check', 'review'), prod), 'P3');
});

test('priority: --rules override wins', () => {
  const rules = { ...RULES, priority: { ...RULES.priority, 'nav.item': 'P1' } };
  assert.equal(priorityOf(f('nav.item', 'review'), prod, rules), 'P1');
  assert.equal(priorityOf(f('nav.item', 'review'), prod), 'P3');
});

test('ownerOf maps check prefixes to a likely owner', () => {
  assert.equal(ownerOf('content.facts.changed'), 'Content / authoring');
  assert.equal(ownerOf('image.broken'), 'Dev / assets');
  assert.equal(ownerOf('link.broken'), 'Dev / assets');
  assert.equal(ownerOf('link.target'), 'Content / dev');
  assert.equal(ownerOf('perf.lcp'), 'Dev (front end)');
  assert.equal(ownerOf('meta.canonical'), 'SEO');
  assert.equal(ownerOf('analytics.rsid'), 'Analytics');
  assert.equal(ownerOf('page.missing'), 'Dev');
});

// ---------- preview hosts ----------

test('isPreviewHost knows AEM Cloud publish and preview hosts', () => {
  const { isPreviewHost } = require('./lib/util');
  assert.equal(isPreviewHost('publish-p142164-e2390502.adobeaemcloud.com'), true);
  assert.equal(isPreviewHost('preview-p1-e2.adobeaemcloud.net'), true);
  assert.equal(isPreviewHost('main--site--org.aem.page'), true);
  assert.equal(isPreviewHost('www.samsung.com'), false);
  assert.equal(isPreviewHost('publish-p1-e2.adobeaemcloud.com.evil.example'), false);
});

// ---------- header, footer and navigation ----------

test('visual.pairSections pairs header and footer even when their text differs', () => {
  const s = (name, fp) => ({ name, fp });
  const r = pairSections([s('header', 'products dram ssd'), s('main-1', 'alpha beta gamma'), s('footer', 'contact us sitemap')],
    [s('header', 'about company'), s('main-1', 'alpha beta gamma'), s('footer', 'legal privacy')]);
  assert.equal(r.pairs.length, 3);
  assert.deepEqual([r.missing.length, r.added.length], [0, 0]);
  assert.ok(r.pairs.some(([b, a]) => b.name === 'header' && a.name === 'header'));
});

test('content: nav.item is review, not fail', () => {
  const ctx = ctxFor('https://www.b.com/', 'https://www.a.com/');
  const f = contentFindings(snap({ nav: ['A', 'B'] }), snap({ nav: [] }), ctx).find((x) => x.check === 'nav.item');
  assert.equal(f.severity, 'review');
});

// ---------- AEM to Edge Delivery markup changes ----------

test('diffBlocks: text split into or merged from other blocks is not reported as missing or added', () => {
  const d = diffBlocks(
    [{ text: 'Owners Careers Investors', region: 'header' }, { text: 'Pricing details are listed for every region.', region: 'main' }],
    [{ text: 'Owners', region: 'header' }, { text: 'Careers', region: 'header' }, { text: 'Investors', region: 'header' }],
  );
  assert.deepEqual(d.missing.map((m) => m.text), ['Pricing details are listed for every region.']);
  assert.deepEqual(d.added, []);
  assert.equal(d.regrouped, 1);
  const merged = diffBlocks([{ text: 'Owners' }, { text: 'Careers' }], [{ text: 'Owners Careers' }]);
  assert.deepEqual([merged.missing, merged.added], [[], []]);
});

test('content: an image renamed on the after page is matched by its alt text', () => {
  const ctx = ctxFor('https://www.b.com/', 'https://www.a.com/');
  const img = (src, alt) => ({ src, alt, inMain: true, broken: false });
  const before = snap({ images: [img('https://www.b.com/content/x/jcr:content/image.img.jpg/1764614500750.jpg', 'Orange Corvette from above'), img('https://www.b.com/content/y/gone.jpg', 'Old banner')] });
  const after = snap({ images: [img('https://www.a.com/media_1a2b3c.jpg?width=750&format=webply', 'Orange Corvette from above')] });
  const missing = contentFindings(before, after, ctx).find((f) => f.check === 'image.missing');
  assert.deepEqual(missing.items.map((i) => i.alt), ['Old banner']);
});

// ---------- real browser over CDP ----------

const { beforeBase } = require('./lib/content');

test('content.beforeBase follows a before-page redirect to another host', () => {
  assert.equal(beforeBase('https://gm.com/heritage', 'https://www.gm.com/heritage'), 'https://www.gm.com/heritage');
  assert.equal(beforeBase('https://www.b.com/x', 'https://www.b.com/x'), 'https://www.b.com/x');
  assert.equal(beforeBase('https://www.b.com/x', ''), 'https://www.b.com/x');
  assert.equal(beforeBase('https://www.b.com/x', 'about:blank'), 'https://www.b.com/x');
});

test('cli: --cdp-url that cannot be reached exits 2 and says how to start Chrome', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'compare.js'), '--before', 'https://b.invalid/', '--after', 'https://a.invalid/', '--cdp-url', 'http://127.0.0.1:9', '--out', path.join(os.tmpdir(), 'pc-cdp-bad')], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /remote-debugging-port/);
});

// Starts the Playwright Chromium as a separate process with a DevTools port, the way a user would start Chrome.
async function startDebugChromium() {
  const exe = require('playwright').chromium.executablePath();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cdp-profile-'));
  const proc = require('child_process').spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
  return { url: `http://127.0.0.1:${port}`, stop: () => { proc.kill(); fs.rmSync(profile, { recursive: true, force: true }); } };
}

const e2eCdp = chromiumAvailable() ? test : test.skip;

e2eCdp('end to end: --cdp-url drives an already running browser', { timeout: 180000 }, async () => {
  const { start } = require('./fixtures/server');
  const { server, port } = await start();
  const chrome = await startDebugChromium();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cdp-out-'));
  try {
    const r = await new Promise((resolve) => {
      const p = require('child_process').spawn(process.execPath, [path.join(__dirname, 'compare.js'), '--cdp-url', chrome.url, '--before', `http://127.0.0.1:${port}/identical`, '--after', `http://localhost:${port}/identical`, '--out', out, '--viewports', '1440', '--pace-ms', '0'], { stdio: 'pipe' });
      let output = '';
      p.stdout.on('data', (d) => (output += d));
      p.stderr.on('data', (d) => (output += d));
      p.on('close', (code) => resolve({ code, output }));
    });
    assert.equal(r.code, 0, r.output);
    const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
    assert.equal(report.pairs[0].status, 'pass', JSON.stringify(report.pairs[0]));
    const version = await (await fetch(`${chrome.url}/json/version`)).json();
    assert.ok(version.Browser, 'the external browser is still running after the run');
  } finally {
    chrome.stop();
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('cli: usage errors exit with 2', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'compare.js'), '--bogus'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  const none = spawnSync(process.execPath, [path.join(__dirname, 'compare.js'), '--out', os.tmpdir() + '/pc-none'], { encoding: 'utf8' });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /No pages to compare/);
});

// ---------- review fixes ----------

const { numbersIn } = require('./lib/content');

test('numbersIn keeps any unit written next to the number', () => {
  assert.deepEqual(numbersIn('data rates up to 8533Mbps'), ['8533mbps']);
  assert.deepEqual(numbersIn('120Hz display, 3.5mm jack, 5000mAh battery, 65W charging'), ['120hz', '3.5mm', '5000mah', '65w']);
  assert.deepEqual(numbersIn('a breakthrough 32 GB capacity'), ['32gb']);
  assert.deepEqual(numbersIn('sold in over 30 countries'), ['30']);
  assert.deepEqual(numbersIn('LPDDR5X meets AEC-Q100 for 5G phones'), []);
});

test('content: 8533Mbps → 10700Mbps is facts changed', () => {
  const ctx = ctxFor('https://www.b.com/', 'https://www.a.com/');
  const out = contentFindings(snap({ blocks: [{ text: 'LPDDR5X offers data rates up to 8533Mbps for on-device AI workloads', region: 'main' }] }),
    snap({ blocks: [{ text: 'LPDDR5X offers data rates up to 10700Mbps for on-device AI workloads', region: 'main' }] }), ctx);
  assert.ok(out.some((x) => x.check === 'content.facts.changed'), JSON.stringify(out));
});

test('priority: robots and canonical review findings on production are P2, fail stays P1', () => {
  assert.equal(priorityOf(f('meta.robots', 'review'), prod), 'P2');
  assert.equal(priorityOf(f('meta.robots', 'fail'), prod), 'P1');
  assert.equal(priorityOf(f('meta.canonical', 'review'), prod), 'P2');
  assert.equal(priorityOf(f('site.robots', 'review'), prod), 'P2');
  assert.equal(priorityOf(f('site.robots', 'fail'), prod), 'P1');
});

test('priority: header/footer text missing is P3, main text missing is P1', () => {
  assert.equal(priorityOf(f('content.text.missing', 'review', { items: [{ text: 'Careers', region: 'footer' }] }), prod), 'P3');
  assert.equal(priorityOf(f('content.text.missing', 'review', { items: [{ text: 'Careers', region: 'footer' }, { text: 'FAQs', region: 'main' }] }), prod), 'P1');
});

test('report: --rules priority overrides reach report.md, issues.csv and pages.csv', () => {
  const run = actionRun([pairOf(1, [{ check: 'nav.item', severity: 'review', summary: '1 navigation item(s) missing', items: [{ text: 'Products', region: 'header' }] }])]);
  const rules = { ...RULES, priority: { ...RULES.priority, 'nav.item': 'P1' } };
  const files = renderMarkdownFiles(run, rules);
  assert.match(files['report.md'], /\*\*Not ready: 1 blocker\*\*/);
  assert.match(files['issues.csv'].split('\n')[1], /^[CVI]-[0-9a-f]{8},P1,/);
  assert.match(files['pages.csv'].split('\n')[1], /,0,1,1,0,0,/);
  assert.match(renderMarkdownFiles(run)['report.md'], /No blocking differences found/);
});

test('report: a run with no pages says nothing was compared', () => {
  assert.match(toMarkdown(actionRun([])), /\*\*Nothing compared/);
});

// ---------- fix report: heading, component and meta ----------

const { extractInPage } = require('./lib/capture');
const { metaSummary } = require('./lib/content');

e2e('capture: blocks and images carry nearest heading and component', { timeout: 60000 }, async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<html><body><header><nav><a href="/x">Products</a></nav></header><main>
      <h2>FAQs</h2><div class="cmp-accordion"><p>What is LPDDR5X?</p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="20" height="20" alt="chip"></div>
      <section id="specs"><p>Specs paragraph</p></section></main></body></html>`);
    const x = await page.evaluate(extractInPage, { masks: [], sectionSelectors: [] });
    const b = x.blocks.find((bl) => bl.text === 'What is LPDDR5X?');
    assert.equal(b.heading, 'FAQs');
    assert.equal(b.component, 'div.cmp-accordion');
    const specs = x.blocks.find((bl) => bl.text === 'Specs paragraph');
    assert.equal(specs.component, 'section#specs');
    assert.equal(specs.heading, 'FAQs');
    assert.equal(x.blocks.find((bl) => bl.text === 'Products').heading, '');
    const img = x.images.find((i) => i.alt === 'chip');
    assert.equal(img.heading, 'FAQs');
    assert.equal(img.component, 'div.cmp-accordion');
    assert.equal(img.region, 'main');
  } finally {
    await browser.close();
  }
});

test('diffBlocks: missing and rewritten items keep heading and component', () => {
  const d = diffBlocks([
    { text: 'Answer one about memory speed and power efficiency in phones', region: 'main', heading: 'FAQs', component: 'div.cmp-accordion' },
    { text: 'With speeds up to 1.25 times faster and 25% better power efficiency compared to before', region: 'main', heading: 'Key features', component: 'div.cmp-text' },
  ], [{ text: 'With speeds 1.3 times faster than before and 20% better power efficiency compared', region: 'main', heading: 'Key features', component: 'div.cmp-text' }]);
  assert.deepEqual([d.missing[0].heading, d.missing[0].component], ['FAQs', 'div.cmp-accordion']);
  assert.deepEqual([d.rewritten[0].heading, d.rewritten[0].component], ['Key features', 'div.cmp-text']);
});

test('content.text.missing carries pct', () => {
  const ctx = ctxFor('https://www.b.com/', 'https://www.a.com/');
  const out = contentFindings(snap({ blocks: [{ text: 'Only paragraph on the before page with enough words', region: 'main' }] }), snap({ blocks: [] }), ctx);
  assert.equal(out.find((x) => x.check === 'content.text.missing').pct, 100);
});

test('content: missing image keeps heading, component and region', () => {
  const ctx = ctxFor('https://www.b.com/', 'https://www.a.com/');
  const out = contentFindings(snap({ images: [{ src: 'https://www.b.com/a.png', alt: 'A', inMain: true, heading: 'Key features', component: 'div.cmp-image', region: 'main' }] }), snap(), ctx);
  const it = out.find((x) => x.check === 'image.missing').items[0];
  assert.deepEqual([it.heading, it.component, it.region], ['Key features', 'div.cmp-image', 'main']);
});

test('metaSummary picks title, description, canonical, robots, og:title and first h1', () => {
  const m = metaSummary(snap({ title: 'T', meta: { description: 'D', canonical: 'C', 'og:title': 'O' }, headings: [{ level: 2, text: 'Sub' }, { level: 1, text: 'H' }] }));
  assert.deepEqual(m, { title: 'T', description: 'D', canonical: 'C', robots: '', ogTitle: 'O', h1: 'H' });
});

// ---------- fix model ----------

const { buildFixes, fixId, pageParity, runParity, reportModel, sectionLabel } = require('./lib/fixes');

const missingText = (items, extra = {}) => ({ check: 'content.text.missing', severity: 'fail', summary: `${items.length} text block(s) from the before page are missing on the after page (30% of text)`, pct: 30, items, ...extra });
const txt = (text, heading, region = 'main', component = '') => ({ text, region, heading, component, hidden: false, chars: text.length });

test('fixes: missing blocks under three headings are three fixes, header text is a separate Header fix', () => {
  const run = actionRun([pairOf(1, [missingText([txt('Q1', 'FAQs'), txt('Q2', 'FAQs'), txt('Fast', 'Key features'), txt('Intro', ''), txt('Tech Blog', '', 'header')])])]);
  const fixes = buildFixes(run);
  assert.deepEqual(fixes.map((x) => [x.priority, x.title]).sort(), [
    ['P1', 'FAQs: 2 text block(s) missing'],
    ['P1', 'Key features: 1 text block(s) missing'],
    ['P1', 'Main content: 1 text block(s) missing'],
    ['P3', 'Header: 1 item(s) missing'],
  ]);
  const faq = fixes.find((x) => x.section === 'FAQs');
  assert.equal(faq.expected, 'Q1');
  assert.equal(faq.actual, '');
  assert.equal(faq.fixType, 'content');
  assert.equal(faq.area, 'content');
  assert.deepEqual(faq.pages, [{ source: 'https://www.b.com/p1', destination: 'https://www.a.com/p1' }]);
});

test('fixes: nav items and header text are one Header fix', () => {
  const run = actionRun([pairOf(1, [missingText([txt('Tech Blog', '', 'header')]), { check: 'nav.item', severity: 'review', summary: '2 navigation item(s) missing', items: [{ text: 'DRAM' }, { text: 'SSD' }] }])]);
  const fixes = buildFixes(run);
  assert.equal(fixes.length, 1);
  assert.deepEqual([fixes[0].title, fixes[0].priority, fixes[0].count], ['Header: 3 item(s) missing', 'P3', 3]);
});

test('fixes: broken images and failed requests under /dev/image/ are one fix', () => {
  const src = (i) => `https://img.example.com/dev/image/products/x${i}.png`;
  const run = actionRun([pairOf(1, [
    { check: 'image.broken', severity: 'fail', summary: '4 content image(s) fail to load', items: [0, 1, 2, 3].map((i) => ({ src: src(i) })) },
    { check: 'request.failed', severity: 'review', summary: '7 new failed request(s)', items: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ url: src(i + 10), status: 404 })) },
  ])]);
  const fixes = buildFixes(run);
  assert.equal(fixes.length, 1);
  assert.deepEqual([fixes[0].priority, fixes[0].count, fixes[0].fixType, fixes[0].area], ['P1', 11, 'content', 'integration']);
  assert.equal(fixes[0].title, 'Files under img.example.com/dev/image/ fail to load (11)');
});

test('fixes: the same broken link on many pages is one fix', () => {
  const pairs = [1, 2, 3].map((i) => pairOf(i, [{ check: 'link.broken', severity: 'fail', summary: '1 internal link(s) return an error', items: [{ text: 'SAMSUNG', url: 'https://www.a.com/', status: 404 }] }]));
  const fixes = buildFixes(actionRun(pairs));
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].title, 'Link to / returns 404 (3 link(s))');
  assert.equal(fixes[0].actual, 'https://www.a.com/ → 404');
  assert.equal(fixes[0].pages.length, 3);
});

test('fixes: id is the same for the same problem on 1 page and on 3 pages', () => {
  const f = () => [missingText([txt('Q1', 'FAQs')])];
  const one = buildFixes(actionRun([pairOf(1, f())]))[0];
  const three = buildFixes(actionRun([pairOf(1, f()), pairOf(2, f()), pairOf(3, f())]))[0];
  assert.equal(one.id, three.id);
  assert.match(one.id, /^C-[0-9a-f]{8}$/);
  assert.equal(three.pages.length, 3);
});

test('fixes: id is stable across calls and page order', () => {
  const a = pairOf(1, [missingText([txt('Q1', 'FAQs')])]);
  const b = pairOf(2, [{ check: 'visual.section.missing', severity: 'fail', summary: '1 section(s) have no match at 1440', items: [{ section: 'main-4:.faq', viewport: '1440' }] }]);
  const ids = (pairs) => buildFixes(actionRun(pairs)).map((x) => x.id).sort();
  assert.deepEqual(ids([a, b]), ids([b, a]));
  assert.equal(fixId('content', 'x'), fixId('content', 'x'));
  assert.notEqual(fixId('content', 'x'), fixId('visual', 'x'));
});

test('fixes: old result without heading/component groups by region and does not throw', () => {
  const old = { check: 'content.text.missing', severity: 'fail', summary: '2 text block(s) from the before page are missing on the after page (12% of text)', items: [{ text: 'A', region: 'main' }, { text: 'B', region: 'main' }] };
  const fixes = buildFixes(actionRun([pairOf(1, [old])]));
  assert.deepEqual(fixes.map((x) => x.title), ['Main content: 2 text block(s) missing']);
});

test('fixes: facts changed title names the figures; values are before and after', () => {
  const item = { before: 'With a breakthrough 32GB capacity', after: 'With a breakthrough 64GB capacity', similarity: 0.87, region: 'main', heading: 'Key features', numbersBefore: ['32gb'], numbersAfter: ['64gb'] };
  const fix = buildFixes(actionRun([pairOf(1, [{ check: 'content.facts.changed', severity: 'fail', summary: '1 text block(s) state different figures on the after page', items: [item] }])]))[0];
  assert.equal(fix.title, 'Key features: figures changed (32gb → 64gb)');
  assert.deepEqual([fix.expected, fix.actual], [item.before, item.after]);
});

test('fixes: visual section at three viewports is one fix with 1440 evidence', () => {
  const sec = (vp) => ({ check: 'visual.section', severity: 'fail', summary: `1 section(s) look different at ${vp}`, items: [{ section: 'main-2:#root-container', viewport: vp, pct: vp === '1440' ? 12.5 : 8, files: { before: `${vp}-b.png`, after: `${vp}-a.png`, diff: `${vp}-d.png` } }] });
  const fixes = buildFixes(actionRun([pairOf(1, [sec('375'), sec('1440'), sec('768')])]));
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].title, 'Section root-container looks different (12.5% of pixels)');
  assert.deepEqual(fixes[0].evidence, { before: 'pairs/p1/visual/1440-b.png', after: 'pairs/p1/visual/1440-a.png', diff: 'pairs/p1/visual/1440-d.png' });
  assert.equal(fixes[0].count, 1);
  assert.equal(fixes[0].fixType, 'code');
});

test('fixes: sorted P1 → P3, content before visual before integration; info and accepted left out', () => {
  const fixes = buildFixes(actionRun([pairOf(1, [
    { check: 'link.broken', severity: 'fail', summary: '1 link', items: [{ url: 'https://www.a.com/x', status: 404 }] },
    { check: 'visual.section.missing', severity: 'fail', summary: '1 section', items: [{ section: 'main-4:.faq', viewport: '1440' }] },
    missingText([txt('Q1', 'FAQs')]),
    { check: 'content.text.regrouped', severity: 'info', summary: 'x' },
    { check: 'meta.title', severity: 'review', summary: 'Title changed', before: 'A', after: 'B', accepted: { reason: 'ok' } },
  ])]));
  assert.deepEqual(fixes.map((x) => `${x.priority} ${x.area}`), ['P1 content', 'P1 visual', 'P2 integration']);
});

test('sectionLabel turns section ids into names', () => {
  assert.equal(sectionLabel('header'), 'Header');
  assert.equal(sectionLabel('main-3:#cm-semi-breadcrumb'), 'cm-semi-breadcrumb');
  assert.equal(sectionLabel('main-4:.static-content'), 'static-content');
});

test('parity: content 100 − pct, parsed from summary when pct missing; visual = pass rows / source rows; blocked page is null', () => {
  const rows = [{ status: 'pass' }, { status: 'pass' }, { status: 'fail' }, { status: 'missing' }, { status: 'added' }];
  assert.deepEqual(pageParity(pairOf(1, [missingText([txt('A', '')])], { visual: { rows } })), { content: 70, visual: 50, functional: null });
  const old = { check: 'content.text.missing', severity: 'fail', summary: '2 text block(s) missing (28.97% of text)', items: [] };
  assert.equal(pageParity(pairOf(1, [old])).content, 71);
  assert.deepEqual(pageParity(pairOf(1, [])), { content: 100, visual: null, functional: null });
  assert.deepEqual(pageParity(pairOf(1, [], { blocked: 'waf' })), { content: null, visual: null, functional: null });
  assert.deepEqual(runParity([pairOf(1, [missingText([txt('A', '')])], { visual: { rows } }), pairOf(2, [], { visual: { rows: [{ status: 'pass' }] } })]), { content: 85, visual: 75, functional: null });
});

test('reportModel: single pair shows URLs, many pairs show hosts; verdict from fixes', () => {
  const one = reportModel(actionRun([pairOf(1, [missingText([txt('Q1', 'FAQs')])])]));
  assert.deepEqual([one.source, one.destination, one.single, one.pages], ['https://www.b.com/p1', 'https://www.a.com/p1', true, 1]);
  assert.equal(one.verdict.label, 'Not ready');
  assert.deepEqual([one.fixed, one.hasBaseline], [[], false]);
  const many = reportModel(actionRun([pairOf(1, []), pairOf(2, [])]));
  assert.deepEqual([many.source, many.destination, many.single], ['www.b.com', 'www.a.com', false]);
});

// ---------- fixes.json and CSVs ----------

test('fixes.json parses and every fix has id, priority, area, title, fixType, pages, expected, actual', () => {
  const files = renderMarkdownFiles(leadRun());
  const data = JSON.parse(files['fixes.json']);
  assert.deepEqual(Object.keys(data).sort(), ['accepted', 'destination', 'fixed', 'fixes', 'generatedAt', 'notRechecked', 'parity', 'source', 'verdict']);
  assert.ok(data.fixes.length > 0);
  for (const f of data.fixes) {
    for (const k of ['id', 'priority', 'area', 'title', 'section', 'component', 'fixType', 'owner', 'pages', 'expected', 'actual', 'count']) assert.ok(k in f, `${f.id} lacks ${k}`);
    assert.match(f.id, /^[CVI]-[0-9a-f]{8}$/);
  }
  assert.equal(data.verdict.label, 'Not ready');
});

test('issues.csv rows carry fix_id that exists in fixes.json', () => {
  const files = renderMarkdownFiles(leadRun());
  const ids = new Set(JSON.parse(files['fixes.json']).fixes.map((f) => f.id));
  const rows = csvRows(files['issues.csv']).slice(1);
  assert.equal(rows.length, ids.size);
  for (const r of rows) assert.ok(ids.has(r.split(',')[0]), r);
});

test('pages.csv has content_parity and visual_parity', () => {
  const run = actionRun([pairOf(1, [missingText([txt('A', '')])], { visual: { rows: [{ status: 'pass' }, { status: 'fail' }] } })]);
  const rows = csvRows(renderMarkdownFiles(run)['pages.csv']);
  const head = rows[0].split(',');
  const cells = rows[1].split(',');
  assert.equal(cells[head.indexOf('content_parity')], '70');
  assert.equal(cells[head.indexOf('visual_parity')], '50');
});

// ---------- report.md from fixes ----------

const fixRun = () => mdRun([{
  id: 'lp-1', before: 'https://www.b.com/lpddr5x', after: 'https://publish-p1-e2.adobeaemcloud.com/lpddr5x', status: 'fail', noise: 0,
  visual: { rows: [{ status: 'pass' }, { status: 'fail' }] },
  meta: { before: { title: 'LPDDR5X | DRAM', description: 'Fast memory', canonical: 'https://www.b.com/lpddr5x', robots: '', ogTitle: '', h1: 'LPDDR5X' }, after: { title: 'LPDDR5X | DRAM | Features', description: 'Fast memory', canonical: 'https://www.b.com/lpddr5x', robots: '', ogTitle: '', h1: 'LPDDR5X' } },
  findings: [
    { check: 'content.facts.changed', severity: 'fail', summary: '1 text block(s) state different figures on the after page', items: [{ before: 'With speeds up to 1.25 times faster and 25% better power efficiency', after: 'With speeds 1.3 times faster and 20% better power efficiency', region: 'main', heading: 'Key features', numbersBefore: ['1.25', '25%'], numbersAfter: ['1.3', '20%'] }] },
    missingText([txt('What is LPDDR5X?', 'FAQs', 'main', 'div.cmp-accordion'), txt('Tech Blog', '', 'header')]),
    { check: 'visual.section', severity: 'fail', summary: '1 section(s) look different at 1440', items: [{ section: 'main-2:#root-container', viewport: '1440', pct: 12, files: { before: 'b.png', after: 'a.png', diff: 'd.png' } }] },
    { check: 'image.broken', severity: 'fail', summary: '4 content image(s) fail to load on the after page', items: [1, 2, 3, 4].map((i) => ({ src: `https://cdn.x.com/dev/image/img${i}.png` })) },
    { check: 'link.broken', severity: 'fail', summary: '17 internal link(s) on the after page return an error', items: [{ text: 'SAMSUNG', url: 'https://publish-p1-e2.adobeaemcloud.com/', status: 404 }] },
    { check: 'analytics.rsid', severity: 'review', summary: 'Report suite differs from the before page', before: 'prodsuite', after: 'testsuite' },
  ],
}], { siteFindings: [{ check: 'site.robots', severity: 'fail', summary: 'robots.txt on the after site disallows everything (Disallow: / for all agents)' }] });

const headings = (md) => md.split('\n').filter((l) => /^## /.test(l));

test('report.md: Content parity comes before Visual parity before Integration & SEO', () => {
  const h = headings(toMarkdown(fixRun()));
  assert.deepEqual(h.slice(0, 5), ['## Content parity', '## Visual parity', '## Functional parity', '## Integration & SEO', '## Expected on preview — recheck at launch']);
  assert.equal(h[h.length - 1], '## For agents');
});

test('report.md: shows Source and Destination URLs for one page and hosts for many', () => {
  const md = toMarkdown(fixRun());
  assert.match(md, /^# Migration comparison\n\n- \*\*Source:\*\* https:\/\/www\.b\.com\/lpddr5x\n- \*\*Destination:\*\* https:\/\/publish-p1-e2\.adobeaemcloud\.com\/lpddr5x\n/);
  const many = renderMarkdownFiles(scaleRun(20))['report.md'];
  assert.match(many, /- \*\*Source:\*\* www\.b\.com\n- \*\*Destination:\*\* www\.a\.com\n/);
});

test('report.md: verdict and scorecard with content and visual parity', () => {
  const md = toMarkdown(fixRun());
  assert.match(md, /\*\*Not ready: 3 blockers\*\*/);
  assert.match(md, /\| Area \| Parity \| 🔴 P1 \| 🟠 P2 \| 🟡 P3 \|/);
  assert.match(md, /\| Content \| 70% \| 2 \| 0 \| 1 \|/);
  assert.match(md, /\| Visual \| 50% \| 0 \| 1 \| 0 \|/);
  assert.match(md, /\| Integration & SEO \| — \| 1 \| 1 \| 0 \|/);
});

test('report.md: fix rows show id, section, and source vs destination with changed figures in bold', () => {
  const md = toMarkdown(fixRun());
  const content = md.split('## Content parity')[1].split('\n## ')[0];
  assert.match(content, /\| `C-[0-9a-f]{8}` \| 🔴 P1 \| Key features \| Key features: figures changed \(1\.25, 25% → 1\.3, 20%\) \| With speeds up to \*\*1\.25\*\* times faster and \*\*25%\*\*[^|]*\| With speeds \*\*1\.3\*\* times faster and \*\*20%\*\*[^|]*\| content \|/);
  assert.match(content, /\| FAQs \| FAQs: 1 text block\(s\) missing \| What is LPDDR5X\? \| — \| content \|/);
  assert.match(content, /\*\*Minor:\*\* Header: 1 item\(s\) missing \(`C-[0-9a-f]{8}`\)/);
});

test('report.md: visual fixes link source, destination and diff screenshots', () => {
  const visual = toMarkdown(fixRun()).split('## Visual parity')[1].split('\n## ')[0];
  assert.match(visual, /\| `V-[0-9a-f]{8}` \| 🟠 P2 \| root-container \| Section root-container looks different \(12% of pixels\) \| \[source\]\(pairs\/lp-1\/visual\/b\.png\) · \[destination\]\(pairs\/lp-1\/visual\/a\.png\) · \[diff\]\(pairs\/lp-1\/visual\/d\.png\) \|/);
});

test('report.md: integration lists broken links as Status | Link | Link text', () => {
  const integ = toMarkdown(fixRun()).split('## Integration & SEO')[1].split('\n## ')[0];
  assert.match(integ, /Files under cdn\.x\.com\/dev\/image\/ fail to load \(4\)/);
  assert.match(integ, /### Broken links\n\n\| Status \| Link \| Link text \|\n[^\n]*\n\| 404 \| https:\/\/publish-p1-e2\.adobeaemcloud\.com\/ \| SAMSUNG \|/);
});

test('report.md: expected-on-preview items are listed with their ids, not as fixes', () => {
  const md = toMarkdown(fixRun());
  const expected = md.split('## Expected on preview — recheck at launch')[1].split('\n## ')[0];
  assert.match(expected, /- robots\.txt on the after site disallows everything \(Disallow: \/ for all agents\) \(`I-[0-9a-f]{8}`\)/);
  assert.match(expected, /- Report suite differs from the before page: prodsuite → testsuite/);
  assert.ok(!/robots\.txt/.test(md.split('## Integration & SEO')[1].split('\n## ')[0]));
});

test('report.md: single page has a Metadata table', () => {
  const content = toMarkdown(fixRun()).split('## Content parity')[1].split('\n## ')[0];
  assert.match(content, /### Metadata\n\n\| Property \| Source \| Destination \| Match \|/);
  assert.match(content, /\| Title \| LPDDR5X \\\| DRAM \| LPDDR5X \\\| DRAM \\\| Features \| ❌ \|/);
  assert.match(content, /\| Description \| Fast memory \| Fast memory \| ✅ \|/);
});

test('report.md: never shows check ids or region/hidden/chars', () => {
  const md = toMarkdown(fixRun()) + renderMarkdownFiles(scaleRun(20))['report.md'];
  for (const bad of ['content.text.missing', 'content.facts.changed', 'link.broken', 'site.robots', 'region', 'hidden', 'chars', 'similarity', 'numbersBefore']) assert.ok(!md.includes(bad), bad);
});

test('report.md: | and newlines in a fix title do not break the table', () => {
  const run = mdRun([mdPair([missingText([txt('a | b\nc <script>', 'Q | A')])])]);
  const md = toMarkdown(run);
  const row = md.split('\n').find((l) => l.includes('Q \\| A'));
  assert.ok(row, md);
  assert.ok(!md.includes('<script>'));
  assert.equal(row.split(/(?<!\\)\|/).length, 9, row);
});

test('report.md: 500 pages stays under 120 lines', () => {
  const run = scaleRun(500);
  for (const p of run.pairs) for (let k = 0; k < 20; k++) p.findings.push({ check: `extra.check${k}`, severity: 'fail', summary: `Extra problem ${k}` });
  const md = renderMarkdownFiles(run)['report.md'];
  assert.ok(md.split('\n').length < 120, `${md.split('\n').length} lines`);
  assert.match(md, /## Pages with most blockers/);
});

test('report.md: a clean run says no differences, site-wide findings still listed', () => {
  const clean = toMarkdown(mdRun([mdPair([], { status: 'pass' })]));
  assert.match(clean, /\*\*No blocking differences found\*\*/);
  assert.match(clean, /## Content parity\n\n_No differences found\._/);
});

test('report.md: a section replaced at the same spot says its content differs', () => {
  const sec = (viewport, text) => ({ section: 'main-2:.section', viewport, text });
  const md = toMarkdown(mdRun([mdPair([
    { check: 'visual.section.missing', severity: 'fail', summary: 'missing', items: [sec('1440', 'old testimonial'), sec('375', 'old testimonial')] },
    { check: 'visual.section.added', severity: 'info', summary: 'added', items: [sec('1440', 'new testimonial'), sec('375', 'new testimonial')] },
  ])]));
  assert.match(md, /Section section has different content on the destination/);
});

test('pages/<id>.md only for multi-page runs, with the page as source and destination', () => {
  assert.deepEqual(Object.keys(renderMarkdownFiles(fixRun())).filter((k) => k.startsWith('pages/')), []);
  const files = renderMarkdownFiles(scaleRun(20));
  const page = files['pages/p1-abc.md'];
  assert.match(page, /- \*\*Source:\*\* https:\/\/www\.b\.com\/p1\n- \*\*Destination:\*\* https:\/\/www\.a\.com\/p1\n/);
  assert.match(page, /## Integration & SEO/);
});

// ---------- leadership report.html ----------

const { renderLeadershipHtml } = require('./lib/html');
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

function htmlOut(model, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-html-'));
  const shotsDir = path.join(dir, 'pairs', 'lp-1', 'visual');
  fs.mkdirSync(shotsDir, { recursive: true });
  for (const f of opts.files || ['b.png', 'a.png', 'd.png']) fs.writeFileSync(path.join(shotsDir, f), PNG_1PX);
  try {
    return renderLeadershipHtml(model, { outDir: dir, ...opts });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('html: no <script> and no external stylesheet', () => {
  const html = htmlOut(reportModel(fixRun()));
  assert.ok(!/<script/i.test(html));
  assert.ok(!/<link[^>]+stylesheet/i.test(html));
  assert.match(html, /<style>/);
});

test('html: shows Source and Destination', () => {
  const html = htmlOut(reportModel(fixRun()));
  assert.match(html, /Source<\/[a-z]+>\s*<a href="https:\/\/www\.b\.com\/lpddr5x">https:\/\/www\.b\.com\/lpddr5x<\/a>/);
  assert.match(html, /Destination<\/[a-z]+>\s*<a href="https:\/\/publish-p1-e2\.adobeaemcloud\.com\/lpddr5x">/);
});

test('html: embeds screenshots as data URIs up to embedMax, links the rest', () => {
  assert.equal((htmlOut(reportModel(fixRun())).match(/src="data:image\/png;base64,/g) || []).length, 3);
  const html = htmlOut(reportModel(fixRun()), { embedMax: 1 });
  assert.equal((html.match(/src="data:image\/png;base64,/g) || []).length, 1);
  assert.match(html, /src="pairs\/lp-1\/visual\/a\.png"/);
});

test('html: missing screenshot file shows "screenshot not available"', () => {
  const html = htmlOut(reportModel(fixRun()), { files: ['b.png'] });
  assert.equal((html.match(/screenshot not available/g) || []).length, 2);
});

test('html: escapes <script> in a fix title', () => {
  const html = htmlOut(reportModel(mdRun([mdPair([missingText([txt('<script>alert(1)</script>', '<img onerror=x>')])])])));
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(!html.includes('<img onerror'));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('html: section order matches report.md and shows the same fix ids', () => {
  const model = reportModel(fixRun());
  const html = htmlOut(model);
  const order = ['Content parity', 'Visual parity', 'Integration &amp; SEO', 'Expected on preview', 'For agents'].map((h) => html.indexOf(`<h2>${h}`));
  assert.ok(order.every((x) => x > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  for (const f of model.fixes) assert.ok(html.includes(f.id), f.id);
  assert.match(html, /Not ready: 3 blockers/);
  assert.match(html, />70%</);
});

// ---------- --baseline ----------

const { loadBaseline, applyBaseline } = require('./lib/fixes');

test('baseline: ids in both are open, only now are new, only before are fixed', () => {
  const now = [{ id: 'C-aaaaaa', priority: 'P1' }, { id: 'C-bbbbbb', priority: 'P2' }];
  const before = { generatedAt: '2026-11-13T10:00:00Z', fixes: [{ id: 'C-aaaaaa', priority: 'P1' }, { id: 'I-cccccc', priority: 'P1', title: 'Old broken images' }] };
  const r = applyBaseline(now, before);
  assert.deepEqual(r.fixes.map((f) => [f.id, f.status]), [['C-aaaaaa', 'open'], ['C-bbbbbb', 'new']]);
  assert.deepEqual(r.fixed.map((f) => f.id), ['I-cccccc']);
});

test('baseline: report.md shows progress line and Fixed since last run; html too', () => {
  const run = fixRun();
  const first = JSON.parse(renderMarkdownFiles(run)['fixes.json']);
  first.generatedAt = '2026-11-13T10:00:00Z';
  first.fixes.push({ id: 'I-cccccc', priority: 'P1', area: 'integration', title: 'Files under cdn.old/dev/ fail to load (4)' });
  const md = renderMarkdownFiles(run, undefined, first)['report.md'];
  assert.match(md, /Since 2026-11-13: P1 4 → 3, 1 fixed, 0 new\./);
  assert.match(md, /## Fixed since last run\n\n- Files under cdn\.old\/dev\/ fail to load \(4\) \(`I-cccccc`\)/);
  const json = JSON.parse(renderMarkdownFiles(run, undefined, first)['fixes.json']);
  assert.ok(json.fixes.every((f) => f.status === 'open'));
  assert.deepEqual(json.fixed.map((f) => f.id), ['I-cccccc']);
  const html = renderLeadershipHtml(reportModel(run, undefined, first), { outDir: os.tmpdir() });
  assert.match(html, /Since 2026-11-13: P1 4 → 3, 1 fixed, 0 new\./);
  assert.match(html, /<h2>Fixed since last run/);
});

test('baseline: loadBaseline reads fixes.json and explains what is wrong', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-base-'));
  try {
    assert.throws(() => loadBaseline(dir), /--baseline: .*fixes\.json not found/);
    fs.writeFileSync(path.join(dir, 'fixes.json'), '{oops');
    assert.throws(() => loadBaseline(dir), /--baseline: .*fixes\.json is not valid JSON/);
    fs.writeFileSync(path.join(dir, 'fixes.json'), JSON.stringify({ generatedAt: 'x', fixes: [{ id: 'C-1' }] }));
    assert.deepEqual(loadBaseline(dir).fixes, [{ id: 'C-1' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: --baseline without a usable fixes.json exits 2 before loading pages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-base-cli-'));
  try {
    const args = (base) => [path.join(__dirname, 'compare.js'), '--before', 'http://127.0.0.1:9/a', '--after', 'http://127.0.0.1:9/b', '--baseline', base, '--out', path.join(dir, 'out')];
    const missing = spawnSync(process.execPath, args(dir), { encoding: 'utf8' });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /fixes\.json not found/);
    fs.writeFileSync(path.join(dir, 'fixes.json'), 'nope');
    const bad = spawnSync(process.execPath, args(dir), { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /not valid JSON/);
    assert.ok(!fs.existsSync(path.join(dir, 'out', 'pairs')), 'no page was loaded');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- fix report: real-run refinements ----------

test('fixes: missing text and images under one heading are one fix', () => {
  const run = actionRun([pairOf(1, [
    missingText([txt('Card one', 'Explore more'), txt('Card two', 'Explore more')]),
    { check: 'image.missing', severity: 'fail', summary: '1 content image(s) missing on the after page', items: [{ src: 'https://www.b.com/c.png', alt: 'c', inMain: true, region: 'main', heading: 'Explore more', component: 'div.cmp-teaser' }] },
    { check: 'image.missing', severity: 'fail', summary: '1 content image(s) missing on the after page', items: [{ src: 'https://www.b.com/d.png', alt: 'd', inMain: true, region: 'main', heading: 'Speed', component: 'div.cmp-image' }] },
  ])]);
  const titles = buildFixes(run).map((f) => f.title).sort();
  assert.deepEqual(titles, ['Explore more: 2 text block(s) and 1 image(s) missing', 'Speed: 1 image(s) missing']);
});

test('content: placeholder items keep heading and component', () => {
  const ctx = ctxFor('https://www.b.com/', 'https://www.a.com/');
  const out = contentFindings(snap({ blocks: [] }), snap({ blocks: [{ text: 'Disclaimer text 1', region: 'main', heading: 'Key features', component: 'div.cmp-text' }] }), ctx);
  const it = out.find((x) => x.check === 'content.placeholder').items[0];
  assert.deepEqual([it.heading, it.component], ['Key features', 'div.cmp-text']);
});

e2e('capture: a heading with hidden responsive copies is read once; a cookie component is consent UI', { timeout: 60000 }, async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<html><body><main><h2><div class="pc">Pioneering DRAM</div><div class="mo" style="display:none">Pioneering DRAM</div></h2><p>Body copy</p>
      <div id="cookie_component_emea" class="CO35_Cookie_EMEA" style="display:none"><p>Our site uses cookies.</p><button>Accept all</button></div>
      <div id="cookie_component" class="CO11_cookie"><p>${'Real product copy that happens to sit inside a wrapper named cookie. '.repeat(30)}</p></div></main></body></html>`);
    const x = await page.evaluate(extractInPage, { masks: [], sectionSelectors: [], consentSel: require('./lib/capture').CONSENT_SELECTORS.join(',') });
    assert.equal(x.blocks.find((b) => b.text === 'Body copy').heading, 'Pioneering DRAM');
    assert.equal(x.headings[0].text, 'Pioneering DRAM');
    assert.ok(!x.blocks.some((b) => /cookies|Accept all/.test(b.text)), JSON.stringify(x.blocks));
    assert.ok(x.blocks.some((b) => b.text.startsWith('Real product copy')), 'a large wrapper whose id and class say cookie is still content');
  } finally {
    await browser.close();
  }
});

test('html: images load eagerly (printable) and embedding stops at the byte budget', () => {
  const html = htmlOut(reportModel(fixRun()));
  assert.ok(!/loading="lazy"/.test(html));
  const budget = htmlOut(reportModel(fixRun()), { embedBytes: PNG_1PX.length * 2 });
  assert.equal((budget.match(/src="data:image\/png;base64,/g) || []).length, 2);
  assert.match(budget, /src="pairs\/lp-1\/visual\/d\.png"/);
});

// ---------- final review fixes ----------

test('fixes: placeholder, empty-state and added text are destination values, not source values', () => {
  const run = actionRun([pairOf(1, [
    { check: 'content.placeholder', severity: 'fail', summary: '1 placeholder text(s) on the after page', items: [{ text: 'Disclaimer text 1', region: 'main', heading: 'Key features' }] },
    { check: 'content.text.added', severity: 'review', summary: '1 new text block(s) on the after page', items: [{ text: 'Brand new copy', region: 'main', heading: 'Intro' }] },
  ])]);
  const fixes = buildFixes(run);
  const ph = fixes.find((f) => f.checks.includes('content.placeholder'));
  assert.deepEqual([ph.expected, ph.actual], ['', 'Disclaimer text 1']);
  const added = fixes.find((f) => f.checks.includes('content.text.added'));
  assert.deepEqual([added.expected, added.actual], ['', 'Brand new copy']);
});

test('baseline: fixes on pages not compared this run are not rechecked, not fixed', () => {
  const brokenLink = (i) => ({ check: 'link.broken', severity: 'fail', summary: '1 link', items: [{ url: `https://www.a.com/gone-${i}`, status: 404 }] });
  const first = JSON.parse(renderMarkdownFiles(actionRun([pairOf(1, [brokenLink(1)]), pairOf(2, [brokenLink(2)]), pairOf(3, [brokenLink(3)])]))['fixes.json']);
  const subset = renderMarkdownFiles(actionRun([pairOf(1, [brokenLink(1)])]), undefined, first);
  const json = JSON.parse(subset['fixes.json']);
  assert.deepEqual(json.fixed, []);
  assert.equal(json.notRechecked.length, 2);
  assert.match(subset['report.md'], /0 fixed, 0 new, 2 not rechecked\./);
  const blocked = JSON.parse(renderMarkdownFiles(actionRun([pairOf(1, [brokenLink(1)]), pairOf(2, [], { blocked: 'waf', status: 'blocked' }), pairOf(3, [])]), undefined, first)['fixes.json']);
  assert.deepEqual(blocked.fixed.map((f) => f.title), ['Link to /gone-3 returns 404 (1 link(s))']);
  assert.equal(blocked.notRechecked.length, 1);
});

test('baseline: an accepted difference is listed as accepted, not fixed', () => {
  const f = () => ({ check: 'meta.title', severity: 'fail', summary: 'Title changed', before: 'A', after: 'B' });
  const first = JSON.parse(renderMarkdownFiles(actionRun([pairOf(1, [f()])]))['fixes.json']);
  const json = JSON.parse(renderMarkdownFiles(actionRun([pairOf(1, [{ ...f(), accepted: { reason: 'new title' } }])]), undefined, first)['fixes.json']);
  assert.deepEqual(json.fixed, []);
  assert.equal(json.accepted.length, 1);
});

test('baseline: per-page reports in a multi-page run do not show run-wide progress', () => {
  const brokenLink = (i) => ({ check: 'link.broken', severity: 'fail', summary: '1 link', items: [{ url: `https://www.a.com/gone-${i}`, status: 404 }] });
  const first = JSON.parse(renderMarkdownFiles(actionRun([pairOf(1, [brokenLink(1)]), pairOf(2, [brokenLink(2)])]))['fixes.json']);
  const files = renderMarkdownFiles(actionRun([pairOf(1, [brokenLink(1)]), pairOf(2, [])]), undefined, first);
  const page = files['pages/p1.md'];
  assert.ok(!/^Since /m.test(page), page);
  assert.ok(!/^## Fixed since last run/m.test(page));
  assert.match(files['report.md'], /1 fixed, 0 new/);
});

test('fixes: ids are 8 hex characters', () => {
  assert.match(fixId('content', 'x'), /^C-[0-9a-f]{8}$/);
});

// ---------- scale: review pages, slim report.json, fix filter ----------

const { renderReviewFiles, renderJson: renderReportJson } = require('./lib/report');
const { filterFixes } = require('./lib/fixes');

const reviewRun = (n) => ({ generatedAt: 'now', viewports: [1440], completeness: {}, notTested: [], pairs: Array.from({ length: n }, (_, i) => ({
  id: `p${i}`, before: `https://www.b.com/p${i}`, after: `https://www.a.com/p${i}`, status: i % 3 ? 'fail' : 'pass',
  findings: i % 3 ? [{ check: 'visual.section', severity: 'fail', summary: '1 section(s) look different at 1440', items: [{ section: 'main-1', viewport: '1440', pct: 9, files: { before: 'b.png', after: 'a.png', diff: 'd.png' } }] }] : [],
})) });

test('review: up to 100 pages is one review.html with Accept buttons', () => {
  const files = renderReviewFiles(reviewRun(30));
  assert.deepEqual(Object.keys(files), ['review.html']);
  assert.match(files['review.html'], /<button data-accept/);
  assert.match(files['review.html'], /src="pairs\/p1\/visual\/b\.png"/);
});

test('review: above 100 pages review.html is an index and each page that did not pass gets review/<id>.html', () => {
  const files = renderReviewFiles(reviewRun(300));
  const pages = Object.keys(files).filter((k) => k.startsWith('review/'));
  assert.equal(pages.length, 200);
  assert.ok(!/<button data-accept/.test(files['review.html']));
  assert.match(files['review.html'], /href="review\/p1\.html"/);
  assert.ok(Buffer.byteLength(files['review.html']) < 200000, `${Buffer.byteLength(files['review.html'])} bytes`);
  assert.match(files['review/p1.html'], /<button data-accept/);
  assert.match(files['review/p1.html'], /src="\.\.\/pairs\/p1\/visual\/b\.png"/);
  assert.match(files['review/p1.html'], /href="\.\.\/review\.html"/);
});

test('report.json keeps at most 50 items per finding and counts the rest', () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ text: `t${i}` }));
  const run = { generatedAt: 'now', viewports: [1440], pairs: [{ id: 'x', before: 'https://b/x', after: 'https://a/x', status: 'fail', findings: [{ check: 'cta.missing', severity: 'review', summary: '130 missing', items, truncated: 10 }] }] };
  const f = JSON.parse(renderReportJson(run)).pairs[0].findings[0];
  assert.equal(f.items.length, 50);
  assert.equal(f.truncated, 80);
  assert.equal(run.pairs[0].findings[0].items.length, 120, 'the run itself is not changed');
});

const fixesDoc = () => ({ generatedAt: 'now', source: 's', destination: 'd', verdict: { label: 'Not ready' }, parity: {}, fixed: [], notRechecked: [], accepted: [], fixes: [
  { id: 'C-11111111', priority: 'P1', area: 'content', fixType: 'content', pages: [{ source: 'https://b/dram/x', destination: 'https://a/dram/x' }] },
  { id: 'C-22222222', priority: 'P2', area: 'content', fixType: 'content', pages: [{ source: 'https://b/ssd/y', destination: 'https://a/ssd/y' }] },
  { id: 'V-33333333', priority: 'P1', area: 'visual', fixType: 'code', pages: [{ source: 'https://b/dram/z', destination: 'https://a/dram/z' }, { source: 'https://b/ssd/z', destination: 'https://a/ssd/z' }] },
  { id: 'I-44444444', priority: 'expected', area: 'integration', fixType: 'config', pages: [], siteWide: true },
] });

test('filterFixes: by priority, area, fix type, page and id; pages narrowed to the filter', () => {
  const ids = (o) => filterFixes(fixesDoc(), o).fixes.map((f) => f.id);
  assert.deepEqual(ids({ priority: ['P1'] }), ['C-11111111', 'V-33333333']);
  assert.deepEqual(ids({ area: ['visual'] }), ['V-33333333']);
  assert.deepEqual(ids({ type: ['content'], priority: ['P1', 'P2'] }), ['C-11111111', 'C-22222222']);
  assert.deepEqual(ids({ id: ['I-44444444'] }), ['I-44444444']);
  const dram = filterFixes(fixesDoc(), { page: '/dram/' });
  assert.deepEqual(dram.fixes.map((f) => f.id), ['C-11111111', 'V-33333333']);
  assert.equal(dram.fixes[1].pages.length, 1);
  assert.equal(dram.matched, 2);
  assert.equal(dram.total, 4);
});

test('cli: fixes.js prints the filtered fixes and exits 2 without fixes.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-fixes-'));
  try {
    const cli = (args) => spawnSync(process.execPath, [path.join(__dirname, 'fixes.js'), ...args], { encoding: 'utf8' });
    const none = cli([dir]);
    assert.equal(none.status, 2);
    assert.match(none.stderr, /fixes\.json not found/);
    fs.writeFileSync(path.join(dir, 'fixes.json'), JSON.stringify(fixesDoc()));
    const r = cli([dir, '--priority', 'P1', '--area', 'content']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).fixes.map((f) => f.id), ['C-11111111']);
    assert.equal(cli([dir, '--priority', 'P9']).status, 2, 'unknown priority is a usage error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('output: stale review/<id>.html files from this tool are removed, user files survive', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-out-'));
  try {
    fs.mkdirSync(path.join(out, 'review'), { recursive: true });
    fs.mkdirSync(path.join(out, 'pairs', 'old-1'), { recursive: true });
    fs.writeFileSync(path.join(out, 'review', 'old-1.html'), 'stale');
    fs.writeFileSync(path.join(out, 'review', 'mine.html'), 'keep me');
    writeReportFiles(out, { 'review.html': 'index', 'review/new-1.html': 'page' });
    assert.ok(!fs.existsSync(path.join(out, 'review', 'old-1.html')));
    assert.equal(fs.readFileSync(path.join(out, 'review', 'mine.html'), 'utf8'), 'keep me');
    assert.equal(fs.readFileSync(path.join(out, 'review', 'new-1.html'), 'utf8'), 'page');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('report.json above 100 pages is compact, keeps finding summaries and points to each page detail', () => {
  const run = reviewRun(150);
  const text = renderReportJson(run);
  assert.ok(!text.includes('\n  '), 'compact');
  const data = JSON.parse(text);
  const f = data.pairs[1].findings[0];
  assert.deepEqual([f.check, f.severity, f.items, f.itemCount], ['visual.section', 'fail', undefined, 1]);
  assert.equal(data.pairs[1].detail, 'pairs/p1/result.json');
  assert.equal(data.summary.fail, 100);
});

// ---------- functional parity: interactions ----------

const { interactionFindings, controlKey } = require('./lib/interact');

const ctl = (kind, label, extra = {}) => ({ kind, label, region: 'main', heading: 'FAQs', responded: true, navigated: false, empty: false, jsErrors: [], failed: [], submit: null, ...extra });
const ix = (controls, term = 'memory') => ({ term, controls });

test('interaction: a control that works on the source and does nothing on the destination is no_response (fail)', () => {
  const r = interactionFindings(ix([ctl('accordion', 'What is LPDDR5X?')]), ix([ctl('accordion', 'What is LPDDR5X?', { responded: false })]));
  const f = r.findings.find((x) => x.check === 'interaction.no_response');
  assert.equal(f.severity, 'fail');
  assert.deepEqual(f.items.map((i) => [i.kind, i.label, i.heading]), [['accordion', 'What is LPDDR5X?', 'FAQs']]);
  assert.deepEqual([r.total, r.ok], [1, 0]);
});

test('interaction: a control that does nothing on both pages is not reported and not counted', () => {
  const r = interactionFindings(ix([ctl('tab', 'Overview', { responded: false })]), ix([ctl('tab', 'Overview', { responded: false })]));
  assert.deepEqual(r.findings, []);
  assert.deepEqual([r.total, r.ok], [0, 0]);
});

test('interaction: new JavaScript error and failed requests on the destination', () => {
  const r = interactionFindings(
    ix([ctl('tab', 'Specs', { jsErrors: ['old error'] })]),
    ix([ctl('tab', 'Specs', { jsErrors: ['old error', 'tab broken'], failed: [{ url: 'https://a/api/specs', status: 500 }] })]),
  );
  assert.deepEqual(r.findings.find((x) => x.check === 'interaction.js_error').items.map((i) => i.message), ['tab broken']);
  assert.equal(r.findings.find((x) => x.check === 'interaction.request.failed').severity, 'review');
  assert.deepEqual([r.total, r.ok], [1, 0]);
});

test('interaction: search with results on the source and an empty result on the destination', () => {
  const r = interactionFindings(ix([ctl('search', 'Search', { navigated: true })]), ix([ctl('search', 'Search', { navigated: true, empty: true })]));
  const f = r.findings.find((x) => x.check === 'interaction.search.empty');
  assert.equal(f.severity, 'fail');
  assert.equal(f.items[0].term, 'memory');
});

test('interaction: forms — not submitted, different endpoint, missing fields', () => {
  const sent = { method: 'POST', path: '/api/lead', fields: ['email', 'name', 'consent'] };
  const notSent = interactionFindings(ix([ctl('form', 'Send', { submit: sent })]), ix([ctl('form', 'Send', { submit: null, responded: false })]));
  assert.equal(notSent.findings.find((x) => x.check === 'interaction.form.not_submitted').severity, 'fail');
  assert.ok(!notSent.findings.some((x) => x.check === 'interaction.no_response'), 'a form that does not submit is reported once');
  const moved = interactionFindings(ix([ctl('form', 'Send', { submit: sent })]), ix([ctl('form', 'Send', { submit: { method: 'POST', path: '/bin/lead', fields: ['email', 'name'] } })]));
  const ep = moved.findings.find((x) => x.check === 'interaction.form.endpoint');
  assert.deepEqual([ep.severity, ep.items[0].before, ep.items[0].after], ['review', 'POST /api/lead', 'POST /bin/lead']);
  assert.deepEqual(moved.findings.find((x) => x.check === 'interaction.form.fields').items[0].missing, ['consent']);
});

test('interaction: a control only on the source is control.missing; matching uses kind, label and order', () => {
  const r = interactionFindings(
    ix([ctl('accordion', 'Q'), ctl('accordion', 'Q'), ctl('carousel', 'Next')]),
    ix([ctl('accordion', 'Q'), ctl('carousel', 'Next')]),
  );
  const missing = r.findings.find((x) => x.check === 'interaction.control.missing');
  assert.deepEqual(missing.items.map((i) => [i.kind, i.label]), [['accordion', 'Q']]);
  assert.deepEqual([r.total, r.ok], [3, 2]);
  assert.equal(controlKey(ctl('Accordion', '  What   is it? ')), 'accordion|what is it?');
});

test('interaction: nothing interactive on either page gives no findings and total 0', () => {
  assert.deepEqual(interactionFindings(ix([]), ix([])), { findings: [], total: 0, ok: 0 });
});

e2e('interaction end to end: broken accordion, tab error, empty search and unsent form are found; no form is ever sent', { timeout: 120000 }, async () => {
  const { start } = require('./fixtures/server');
  const { chromium } = require('playwright');
  const { interactPage } = require('./lib/interact');
  const { server, port } = await start();
  const seen = [];
  server.on('request', (req) => seen.push(`${req.method} ${req.url}`));
  const browser = await chromium.launch();
  try {
    const opts = { viewport: { width: 1440, height: 900 } };
    const before = await interactPage(browser, `http://127.0.0.1:${port}/interactive`, opts);
    const after = await interactPage(browser, `http://localhost:${port}/interactive`, { ...opts, term: before.term });
    const kinds = before.controls.map((c) => c.kind).sort();
    assert.deepEqual(kinds, ['accordion', 'form', 'search', 'tab'], JSON.stringify(before.controls));
    assert.ok(before.controls.every((c) => c.responded), JSON.stringify(before.controls));
    assert.deepEqual(before.controls.find((c) => c.kind === 'form').submit, { method: 'POST', path: '/api/lead', fields: ['email', 'company'] });
    const r = interactionFindings(before, after);
    const checks = r.findings.map((f) => f.check).sort();
    assert.deepEqual(checks, ['interaction.form.not_submitted', 'interaction.js_error', 'interaction.no_response', 'interaction.search.empty'], JSON.stringify(r.findings));
    assert.deepEqual(r.findings.find((f) => f.check === 'interaction.no_response').items.map((i) => i.kind).sort(), ['accordion', 'tab']);
    assert.equal(r.findings.find((f) => f.check === 'interaction.no_response').items.find((i) => i.kind === 'accordion').heading, 'FAQs');
    assert.deepEqual([r.total, r.ok], [4, 0]);
    assert.ok(!seen.some((s) => !/^(GET|HEAD) /.test(s)), `a non-GET request reached the server: ${seen.filter((s) => !/^GET /.test(s))}`);
    assert.ok(!seen.some((s) => s.includes('/api/lead')), 'the form was never sent');
  } finally {
    await browser.close();
    server.close();
  }
});

// ---------- functional parity in the fix model and reports ----------

const ixFinding = (check, severity, items) => ({ check, severity, summary: check, items });
const functionalRun = () => mdRun([{
  id: 'lp-1', before: 'https://www.b.com/lpddr5x', after: 'https://www.a.com/lpddr5x', status: 'fail', noise: 0,
  interaction: { total: 4, ok: 1 },
  findings: [
    ixFinding('interaction.no_response', 'fail', [{ kind: 'accordion', label: 'What is LPDDR5X?', heading: 'FAQs', region: 'main', error: 'nothing happened' }, { kind: 'accordion', label: 'Is it fast?', heading: 'FAQs', region: 'main', error: 'nothing happened' }]),
    ixFinding('interaction.search.empty', 'fail', [{ kind: 'search', label: 'Search', heading: '', region: 'main', term: 'lpddr5x' }]),
    ixFinding('interaction.form.endpoint', 'review', [{ kind: 'form', label: 'Send', heading: 'Contact us', region: 'main', before: 'POST /api/lead', after: 'POST /bin/lead' }]),
  ],
}]);

test('fixes: interaction findings are functional fixes grouped by section, with F- ids and plain titles', () => {
  const fixes = buildFixes(functionalRun());
  assert.deepEqual(fixes.map((f) => [f.priority, f.area, f.title]), [
    ['P1', 'functional', 'FAQs: 2 accordion(s) do not respond on the destination'],
    ['P1', 'functional', 'Search returns no results on the destination (search "lpddr5x")'],
    ['P2', 'functional', 'Contact us: form sends to a different address'],
  ]);
  assert.ok(fixes.every((f) => /^F-[0-9a-f]{8}$/.test(f.id)));
  const faq = fixes[0];
  assert.deepEqual([faq.expected, faq.actual, faq.fixType, faq.owner], ['accordion "What is LPDDR5X?" responds', 'nothing happened', 'code', 'Dev (front end)']);
  assert.deepEqual([fixes[2].expected, fixes[2].actual], ['POST /api/lead', 'POST /bin/lead']);
});

test('parity: functional is ok / total when interactions ran, null when they did not', () => {
  assert.equal(pageParity(functionalRun().pairs[0]).functional, 25);
  assert.equal(pageParity(pairOf(1, [])).functional, null);
  assert.equal(pageParity(pairOf(1, [], { interaction: { total: 0, ok: 0 } })).functional, null);
  assert.equal(runParity(functionalRun().pairs).functional, 25);
});

test('report.md: Functional parity sits between Visual and Integration, with a scorecard row', () => {
  const md = toMarkdown(functionalRun());
  assert.match(md, /\| Functional \| 25% \| 2 \| 1 \| 0 \|/);
  const section = md.split('## Functional parity')[1].split('\n## ')[0];
  assert.match(section, /FAQs: 2 accordion\(s\) do not respond on the destination/);
  assert.match(section, /\| accordion "What is LPDDR5X\?" responds \| nothing happened \| code \|/);
});

test('report.md and report.html say functional parity was not checked without --interact', () => {
  const md = toMarkdown(fixRun());
  assert.match(md, /## Functional parity\n\n_Not checked: run with `--interact`/);
  assert.match(md, /\| Functional \| — \| 0 \| 0 \| 0 \|/);
  const html = renderLeadershipHtml(reportModel(fixRun()), { outDir: os.tmpdir() });
  assert.match(html, /<h2>Functional parity<\/h2>\s*<p class="empty">Not checked: run with <code>--interact<\/code>/);
});

test('report.html shows Functional parity in order with its parity tile', () => {
  const html = renderLeadershipHtml(reportModel(functionalRun()), { outDir: os.tmpdir() });
  const order = ['Visual parity', 'Functional parity', 'Integration &amp; SEO'].map((h) => html.indexOf(`<h2>${h}`));
  assert.ok(order.every((x) => x > 0) && order[0] < order[1] && order[1] < order[2], JSON.stringify(order));
  assert.match(html, />25%<\/div><div class="l">Functional parity/);
});

e2e('cli: --interact adds Functional parity to the reports and never sends a form', { timeout: 240000 }, async () => {
  const { start } = require('./fixtures/server');
  const { server, port } = await start();
  const seen = [];
  server.on('request', (req) => seen.push(`${req.method} ${req.url}`));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-interact-'));
  try {
    const args = [path.join(__dirname, 'compare.js'), '--before', `http://127.0.0.1:${port}/interactive`, '--after', `http://localhost:${port}/interactive`, '--viewports', '1440', '--noise-sample', '0', '--no-link-check', '--out', out];
    const r = await new Promise((resolve) => {
      const p = require('child_process').spawn(process.execPath, [...args, '--interact']);
      let output = '';
      p.stdout.on('data', (d) => (output += d));
      p.stderr.on('data', (d) => (output += d));
      p.on('close', (code) => resolve({ code, output }));
    });
    assert.equal(r.code, 1, r.output);
    const md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
    const functional = md.split('## Functional parity')[1].split('\n## ')[0];
    assert.match(functional, /FAQs: 1 accordion\(s\) do not respond on the destination/);
    assert.match(functional, /Contact us: form does not submit on the destination/);
    assert.match(functional, /Search returns no results on the destination/);
    assert.match(md, /\| Functional \| 0% \|/);
    const fixes = JSON.parse(fs.readFileSync(path.join(out, 'fixes.json'), 'utf8')).fixes.filter((f) => f.area === 'functional');
    assert.ok(fixes.length >= 4 && fixes.every((f) => /^F-/.test(f.id)), JSON.stringify(fixes.map((f) => f.title)));
    assert.match(fs.readFileSync(path.join(out, 'report.html'), 'utf8'), /<h2>Functional parity<\/h2>/);
    assert.ok(!seen.some((s) => !/^(GET|HEAD) /.test(s)), `a non-GET request reached the server: ${seen.filter((s) => !/^GET /.test(s))}`);
    const result = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')).pairs[0];
    assert.deepEqual([result.interaction.total, result.interaction.ok], [4, 0]);
  } finally {
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('interaction: fieldsOf never throws on odd request bodies', () => {
  const { fieldsOf } = require('./lib/interact');
  const req = (url, body) => ({ url: () => url, postData: () => body });
  assert.deepEqual(fieldsOf(req('https://a/x?q=1', 'email=a%40b.com&bad=%E0%A4%A&name=x')).sort(), ['bad', 'email', 'name', 'q']);
  assert.deepEqual(fieldsOf(req('https://a/x', '%%%=1')), ['%%%']);
  assert.deepEqual(fieldsOf(req('not a url', '{"a":1,"b":2}')), ['a', 'b']);
  assert.deepEqual(fieldsOf({ url: () => { throw new Error('x'); }, postData: () => { throw new Error('y'); } }), []);
});

// ---------- review fixes: dry run, submit choice, reloads, background noise ----------

e2e('interaction safety: no form ever reaches the server (new tab, iframe, JS fetch, JSONP, late submit)', { timeout: 120000 }, async () => {
  const { start } = require('./fixtures/server');
  const { chromium } = require('playwright');
  const { interactPage } = require('./lib/interact');
  const { server, port } = await start();
  const seen = [];
  server.on('request', (req) => seen.push(`${req.method} ${req.url}`));
  const browser = await chromium.launch();
  try {
    const r = await interactPage(browser, `http://127.0.0.1:${port}/dryrun`, { viewport: { width: 1440, height: 900 } });
    assert.equal(r.controls.filter((c) => c.kind === 'form').length, 6, JSON.stringify(r.controls));
    await new Promise((res) => setTimeout(res, 5500));
    const trapped = seen.filter((s) => s.includes('/trap/'));
    assert.deepEqual(trapped, [], `form data reached the server: ${trapped.join(', ')}`);
    const recorded = r.controls.filter((c) => c.kind === 'form' && c.submit).map((c) => c.submit.path).sort();
    assert.deepEqual(recorded, ['/trap/blank-get', '/trap/blank-post', '/trap/fetch-get', '/trap/iframe-get', '/trap/jsonp']);
  } finally {
    await browser.close();
    server.close();
  }
});

test('interaction: pickSubmit prefers the request carrying the form data over analytics beacons', () => {
  const { pickSubmit } = require('./lib/interact');
  const attempts = [
    { method: 'POST', host: 'www.google-analytics.com', path: '/g/collect', fields: ['v', 'tid'], marked: false, analytics: true },
    { method: 'POST', host: 'www.b.com', path: '/api/lead', fields: ['email', 'company'], marked: true, analytics: false },
  ];
  assert.equal(pickSubmit(attempts, ['email', 'company'], 'www.b.com').path, '/api/lead');
  assert.equal(pickSubmit([attempts[0]], ['email'], 'www.b.com'), null, 'an analytics beacon alone is not a form submit');
  assert.equal(pickSubmit([{ method: 'POST', host: 'www.b.com', path: '/bin/x', fields: [], marked: false, analytics: false }], ['email'], 'www.b.com').path, '/bin/x');
});

e2e('interaction: a redirecting URL is loaded once, not before every control', { timeout: 120000 }, async () => {
  const { start } = require('./fixtures/server');
  const { chromium } = require('playwright');
  const { interactPage } = require('./lib/interact');
  const { server, port } = await start();
  const seen = [];
  server.on('request', (req) => seen.push(`${req.method} ${req.url}`));
  const browser = await chromium.launch();
  try {
    await interactPage(browser, `http://127.0.0.1:${port}/start`, { viewport: { width: 1440, height: 900 } });
    const loads = seen.filter((s) => s === 'GET /start').length;
    assert.ok(loads <= 2, `the redirecting page was loaded ${loads} times`);
  } finally {
    await browser.close();
    server.close();
  }
});

e2e('interaction: background changes and recurring errors are not blamed on controls', { timeout: 120000 }, async () => {
  const { start } = require('./fixtures/server');
  const { chromium } = require('playwright');
  const { interactPage } = require('./lib/interact');
  const { server, port } = await start();
  const browser = await chromium.launch();
  try {
    const opts = { viewport: { width: 1440, height: 900 } };
    const before = await interactPage(browser, `http://127.0.0.1:${port}/noisy`, opts);
    const after = await interactPage(browser, `http://localhost:${port}/noisy`, opts);
    assert.equal(before.controls.find((c) => c.label === 'Dead question').responded, false, 'a ticker elsewhere on the page is not a response');
    const r = interactionFindings(before, after);
    assert.deepEqual(r.findings, [], JSON.stringify(r.findings));
    assert.deepEqual([r.total, r.ok], [1, 1]);
  } finally {
    await browser.close();
    server.close();
  }
});

test('report: interactions that could not run say so instead of asking for --interact; skipped pages are not checked', () => {
  const run = mdRun([mdPair([], { interaction: { error: 'Target closed' } })]);
  const md = toMarkdown(run);
  assert.match(md, /## Functional parity\n\n_Interactions could not run on 1 page\(s\): Target closed\._/);
  const skipped = mdRun([mdPair([], { interaction: { skipped: 'page not comparable' } })]);
  assert.match(toMarkdown(skipped), /_Not checked: run with `--interact`/);
  assert.match(renderMarkdownFiles(skipped)['pages.csv'].split('\n')[1], /,not checked,/);
});

test('interaction: a destination control that could not be checked is neither a failure nor counted', () => {
  const r = interactionFindings(ix([ctl('search', 'Search keyword'), ctl('accordion', 'Q')]), ix([ctl('search', 'Search keyword', { responded: false, skipped: 'control not found after reloading the page' }), ctl('accordion', 'Q')]));
  assert.deepEqual(r.findings, []);
  assert.deepEqual([r.total, r.ok], [1, 1]);
});

test('fixes: the figures-changed title lists only the figures that differ', () => {
  const item = { before: 'up to 8,000 Mbps, 2.5x higher, burst 8 to 16, banks 16 to 32', after: 'up to 7,200 Mbps, burst 8 to 16, banks 16 to 32', region: 'main', heading: 'DDR5', numbersBefore: ['8,000mbps', '2.5x', '8', '16', '16', '32'], numbersAfter: ['7,200mbps', '8', '16', '16', '32'] };
  const fix = buildFixes(actionRun([pairOf(1, [{ check: 'content.facts.changed', severity: 'fail', summary: '1 text block(s) state different figures on the after page', items: [item] }])]))[0];
  assert.equal(fix.title, 'DDR5: figures changed (8,000mbps, 2.5x → 7,200mbps)');
  const removed = { ...item, numbersBefore: ['2.5x', '8'], numbersAfter: ['8'] };
  assert.equal(buildFixes(actionRun([pairOf(1, [{ check: 'content.facts.changed', severity: 'fail', summary: 'x', items: [removed] }])]))[0].title, 'DDR5: figures changed (2.5x → —)');
});

test('fixes: a failing-files fix shows a failing file as its example, not an alt-text change', () => {
  const src = 'https://img.example.com/dev/image/a.png';
  const fix = buildFixes(actionRun([pairOf(1, [
    { check: 'image.alt.changed', severity: 'review', summary: '1 image alt text(s) changed', items: [{ src, before: 'Samsung LPDDR5X Built to power', after: 'Built to power' }] },
    { check: 'image.broken', severity: 'fail', summary: '1 content image(s) fail to load', items: [{ src }] },
  ])]))[0];
  assert.equal(fix.title, 'Files under img.example.com/dev/image/ fail to load (1)');
  assert.deepEqual([fix.expected, fix.actual], ['', `${src} → fails to load`]);
});
