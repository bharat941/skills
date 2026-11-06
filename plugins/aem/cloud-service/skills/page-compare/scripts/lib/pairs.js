'use strict';

const fs = require('fs');
const path = require('path');
const { hash, slug } = require('./util');
const { readXlsxRows } = require('./xlsx');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows.filter((r) => !String(r[0]).trim().startsWith('#'));
}

const isUrl = (s) => /^https?:\/\//i.test(String(s || '').trim());

/**
 * Pairs from table rows (a CSV or the first sheet of a workbook). The first row is either a header naming
 * "before" and "after" (plus optional "label" and "group", in any order), or already the first pair:
 * before in column A, after in column B, then optional label and group.
 */
function pairsFromRows(rows) {
  const cell = (r, i) => String((r && r[i]) ?? '').trim();
  const data = rows.filter((r) => r.some((c) => String(c ?? '').trim() !== '') && !cell(r, 0).startsWith('#'));
  if (!data.length) return [];
  const header = data[0].map((h) => String(h ?? '').trim().toLowerCase());
  let body;
  let bi = header.indexOf('before');
  let ai = header.indexOf('after');
  let li = header.indexOf('label');
  let gi = header.indexOf('group');
  if (bi >= 0 && ai >= 0) {
    body = data.slice(1);
  } else if (isUrl(cell(data[0], 0)) && isUrl(cell(data[0], 1))) {
    [bi, ai, li, gi] = [0, 1, 2, 3];
    body = data;
  } else {
    throw new Error('The first row needs a header with "before" and "after" columns, or two URLs (before in column A, after in column B)');
  }
  return body.map((r) => ({
    before: cell(r, bi),
    after: cell(r, ai),
    label: li >= 0 ? cell(r, li) : '',
    ...(gi >= 0 && cell(r, gi) ? { group: cell(r, gi) } : {}),
  })).filter((p) => p.before && p.after);
}

function pairsFromCsv(text) {
  return pairsFromRows(parseCsv(text));
}

/** Pairs from a .csv or .xlsx file (the first sheet of the workbook). */
function readPairsFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.xlsx' || ext === '.xlsm') return pairsFromRows(readXlsxRows(file));
  if (ext === '.xls') throw new Error(`${file} is an old Excel format. Save it as .xlsx or .csv and try again.`);
  return pairsFromCsv(fs.readFileSync(file, 'utf8'));
}

// A leading locale such as en, en-us, en_GB or zh-Hans.
const LOCALE_SEGMENT = /^[a-z]{2}([-_][a-zA-Z]{2,4})?$/;

// Template or section a page belongs to: the CSV "group" column, else the first path segment after
// any AEM /content/<site> prefix and locale segment (/en/blog/a and /content/site/en/blog/a are both "blog").
// Two-letter sections are read as locales, so use a CSV "group" column when a site has them.
function groupOf(pair) {
  if (pair.group) return pair.group;
  try {
    let segments = new URL(pair.before).pathname.split('/').filter(Boolean);
    if (segments[0] === 'content' && segments.length > 1) segments = segments.slice(2);
    for (let i = 0; i < 2 && segments.length && LOCALE_SEGMENT.test(segments[0]); i++) segments.shift();
    return segments[0] || '/';
  } catch (e) {
    return '/';
  }
}

function parseMap(spec) {
  const i = String(spec).indexOf('=');
  if (i < 1) throw new Error(`Invalid mapping "${spec}", expected from=to`);
  return [spec.slice(0, i).trim(), spec.slice(i + 1).trim()];
}

// before URL -> after URL using host and path-prefix maps.
function mapUrl(beforeUrl, { hostMap = [], pathMap = [] } = {}) {
  const u = new URL(beforeUrl);
  for (const [from, to] of hostMap) {
    if (u.host === from || u.origin === from) {
      if (to.includes('://')) {
        const t = new URL(to);
        u.protocol = t.protocol;
        u.host = t.host;
      } else {
        u.host = to;
      }
      break;
    }
  }
  for (const [from, to] of pathMap) {
    if (u.pathname.startsWith(from)) {
      u.pathname = to + u.pathname.slice(from.length);
      break;
    }
  }
  return u.toString();
}

function parseSitemapXml(xml) {
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
  return { isIndex: /<sitemapindex[\s>]/i.test(xml), locs };
}

async function loadSitemap(url, fetchText, depth = 0) {
  const { isIndex, locs } = parseSitemapXml(await fetchText(url));
  if (!isIndex) return locs;
  if (depth >= 2) return [];
  const nested = [];
  for (const loc of locs) nested.push(...(await loadSitemap(loc, fetchText, depth + 1)));
  return nested;
}

async function defaultFetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'page-compare/1.0' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

function pairId(p) {
  let path = p.after;
  try {
    path = new URL(p.after).pathname;
  } catch (e) {
    // keep raw value
  }
  return `${slug(path, 40)}-${hash(p.before + '|' + p.after, 6)}`;
}

async function loadPairs(opts, fetchText = defaultFetchText) {
  const hostMap = (opts.map || []).map(parseMap);
  const pathMap = (opts.pathMap || []).map(parseMap);
  let pairs = [];
  let beforeUrls = null;

  if (opts.before && opts.after) {
    pairs.push({ before: opts.before, after: opts.after, label: '' });
  }
  if (opts.pairs) {
    pairs.push(...readPairsFile(opts.pairs));
  }
  if (opts.sitemap) {
    if (!hostMap.length && !pathMap.length) {
      throw new Error('--sitemap needs --map (host) and/or --path-map to build the after URLs');
    }
    beforeUrls = await loadSitemap(opts.sitemap, fetchText);
    for (const before of beforeUrls) {
      pairs.push({ before, after: mapUrl(before, { hostMap, pathMap }), label: '' });
    }
  }
  if (!pairs.length) {
    throw new Error('No pages to compare: pass --before/--after, --pairs <csv> or --sitemap <url> with --map');
  }

  const include = opts.include ? new RegExp(opts.include) : null;
  const exclude = opts.exclude ? new RegExp(opts.exclude) : null;
  const seen = new Set();
  pairs = pairs.filter((p) => {
    const key = p.before + '|' + p.after;
    if (seen.has(key)) return false;
    seen.add(key);
    if (include && !include.test(p.before)) return false;
    if (exclude && exclude.test(p.before)) return false;
    return true;
  });
  if (opts.perGroup) {
    const per = Number(opts.perGroup);
    if (!Number.isInteger(per) || per < 1) throw new Error(`--per-group needs a whole number of 1 or more, got "${opts.perGroup}"`);
    const taken = new Map();
    pairs = pairs.filter((p) => {
      const g = groupOf(p);
      taken.set(g, (taken.get(g) || 0) + 1);
      return taken.get(g) <= per;
    });
  }
  if (opts.limit) pairs = pairs.slice(0, Number(opts.limit));
  return { pairs: pairs.map((p) => ({ ...p, id: pairId(p) })), beforeUrls, hostMap, pathMap };
}

module.exports = { parseCsv, pairsFromCsv, pairsFromRows, readPairsFile, parseMap, mapUrl, parseSitemapXml, loadSitemap, loadPairs, pairId, groupOf };
