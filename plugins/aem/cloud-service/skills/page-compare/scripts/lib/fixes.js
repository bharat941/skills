'use strict';

// Turns findings into fixes: one per section of a page (or of a template, across pages) with one cause.
// Every report view (report.md, report.html, fixes.json, the CSVs) is rendered from the model built here.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { priorityOf, ownerOf, DEFAULT_RULES } = require('./rules');
const { isPreviewHost, hostOf } = require('./util');
const { areaOf, pathOf, issueTitle, countKey, verdictOf, PRIORITY_ORDER } = require('./actions');

const AREA_ORDER = ['content', 'visual', 'integration'];
const AREA_LETTER = { content: 'C', visual: 'V', integration: 'I' };
const MAX_FIX_ITEMS = 50;
const MAX_VALUE = 300;

const SECTION_TEXT = new Set(['content.text.missing', 'content.text.changed', 'content.text.rewritten', 'content.facts.changed', 'content.placeholder', 'content.empty_state', 'image.missing']);
// Text and images missing under one heading are one fix: the section lost its content.
const MISSING = new Set(['content.text.missing', 'image.missing']);
const ASSET = new Set(['image.broken', 'request.failed', 'image.alt.changed']);
const VISUAL = new Set(['visual.section.missing', 'visual.section', 'visual.height']);
const CHROME_REGIONS = new Set(['header', 'footer']);
// Checks whose items are text found on the destination page, not text the source had.
const DESTINATION_TEXT = new Set(['content.placeholder', 'content.empty_state', 'content.text.added']);

/** Stable id for a fix: area letter + 8 hex of sha1(scope key). The scope key never contains the page. */
function fixId(area, scopeKey) {
  return `${AREA_LETTER[area] || 'I'}-${crypto.createHash('sha1').update(scopeKey).digest('hex').slice(0, 8)}`;
}

/** A readable name for a visual section id: "main-3:#cm-semi-breadcrumb" → "cm-semi-breadcrumb". */
function sectionLabel(name) {
  const s = String(name || '');
  if (CHROME_REGIONS.has(s)) return s[0].toUpperCase() + s.slice(1);
  return s.replace(/^main-\d+:/, '').replace(/^[#.]/, '') || s;
}

const round1 = (n) => Math.round(n * 10) / 10;
const clip = (v) => {
  const s = v === undefined || v === null ? '' : String(v);
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE - 1)}…` : s;
};
const placeOf = (it) => (it && (it.heading || it.component)) || '';
const regionTitle = (r) => (r === 'footer' ? 'Footer' : r === 'header' ? 'Header' : 'Header and footer');

function assetPrefix(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean).slice(0, 2);
    return `${u.host}/${segs.join('/')}`;
  } catch (e) {
    return String(url || '');
  }
}

// The scopes a finding's items fall into: [{ key, kind, items }]. Items in one scope belong to one fix.
function scopesOf(f) {
  const items = Array.isArray(f.items) ? f.items : [];
  const out = new Map();
  const put = (key, kind, item) => {
    if (!out.has(key)) out.set(key, { key, kind, items: [] });
    if (item !== undefined) out.get(key).items.push(item);
  };
  if (f.check === 'nav.item') {
    if (!items.length) put('chrome|header', 'chrome');
    for (const it of items) put('chrome|header', 'chrome', it);
  } else if (f.check === 'image.missing.chrome') {
    for (const it of items) put(`chrome|${(it && it.region) || 'header'}`, 'chrome', it);
  } else if (SECTION_TEXT.has(f.check)) {
    if (!items.length) put(`${f.check}|main`, 'section');
    for (const it of items) {
      if (f.check === 'content.text.missing' && it && CHROME_REGIONS.has(it.region)) put(`chrome|${it.region}`, 'chrome', it);
      else put(`${MISSING.has(f.check) ? 'missing' : f.check}|${placeOf(it) || 'main'}`, 'section', it);
    }
  } else if (ASSET.has(f.check) && items.length) {
    for (const it of items) put(`asset|${assetPrefix(it && (it.src || it.url))}`, 'asset', it);
  } else if (f.check === 'link.broken' && items.length) {
    for (const it of items) put(`link.broken|${it && it.url}`, 'link', it);
  } else if (VISUAL.has(f.check)) {
    if (items.length) for (const it of items) put(`${f.check}|${it && it.section}`, 'visual', it);
    else put(`${f.check}|${f.section || ''}`, 'visual', { section: f.section, viewport: f.viewport, files: f.files, summary: f.summary });
  } else {
    put(f.check, 'other');
    for (const it of items) put(f.check, 'other', it);
  }
  return [...out.values()];
}

function valuesOf(f, it) {
  if (it && typeof it === 'object') {
    if (f.check === 'link.broken' || f.check === 'request.failed') return { expected: '', actual: `${it.url || it.src} → ${it.status || 'failed'}` };
    if (f.check === 'image.broken') return { expected: '', actual: `${it.src} → fails to load` };
    if (it.before !== undefined || it.after !== undefined) return { expected: it.before, actual: it.after };
    if (it.text !== undefined) return DESTINATION_TEXT.has(f.check) ? { expected: '', actual: it.text } : { expected: it.text, actual: '' };
    if (it.src !== undefined) return { expected: it.src, actual: '' };
  }
  if (f.before !== undefined || f.after !== undefined) return { expected: f.before, actual: f.after };
  return { expected: '', actual: '' };
}

function titleOf(fx) {
  const n = fx.count;
  const first = fx.first;
  const S = fx.section;
  switch (fx.kind) {
    case 'chrome':
      return `${S}: ${n} item(s) missing`;
    case 'section':
      if (MISSING.has(first.check)) {
        const text = fx.keysByCheck.get('content.text.missing');
        const img = fx.keysByCheck.get('image.missing');
        const parts = [text && `${text.size} text block(s)`, img && `${img.size} image(s)`].filter(Boolean);
        return `${S}: ${parts.join(' and ')} missing`;
      }
      if (first.check === 'content.facts.changed') {
        const it = fx.items.find((x) => x.numbersBefore) || {};
        return `${S}: figures changed (${(it.numbersBefore || []).join(', ')} → ${(it.numbersAfter || []).join(', ')})`;
      }
      if (first.check === 'content.placeholder') return `${S}: placeholder text on the destination`;
      if (first.check === 'content.empty_state') return `${S}: shows an empty result`;
      return `${S}: text reworded (${n})`;
    case 'asset':
      return fx.checks.size === 1 && fx.checks.has('image.alt.changed') ? `Image alt text changed under ${S}/ (${n})` : `Files under ${S}/ fail to load (${n})`;
    case 'link': {
      const it = fx.items[0] || {};
      return `Link to ${S} returns ${it.status || 'an error'} (${fx.occurrences} link(s))`;
    }
    case 'visual': {
      if (first.check === 'visual.section.missing') return fx.replaced ? `Section ${S} has different content on the destination` : `Section ${S} is missing on the destination`;
      if (first.check === 'visual.section') return `Section ${S} looks different (${Math.max(...fx.items.map((x) => Number(x.pct) || 0))}% of pixels)`;
      const pick = fx.items.find((x) => String(x.viewport) === '1440') || fx.items[0] || {};
      const m = /is (\d+)px (taller|shorter)/.exec(pick.summary || first.summary || '');
      return m ? `Section ${S} is ${m[1]}px ${m[2]}` : issueTitle(first);
    }
    default:
      return issueTitle(first);
  }
}

function sectionOf(kind, scope, f) {
  const it = scope.items[0];
  if (kind === 'chrome') return regionTitle(scope.key.split('|')[1]);
  if (kind === 'section') return placeOf(it) || 'Main content';
  if (kind === 'asset') return scope.key.slice('asset|'.length);
  if (kind === 'link') {
    try {
      return new URL(it.url).pathname || '/';
    } catch (e) {
      return String(it && it.url);
    }
  }
  if (kind === 'visual') return sectionLabel(it && it.section);
  return f.section ? sectionLabel(f.section) : '';
}

function areaOfScope(kind, check) {
  if (kind === 'chrome' || kind === 'section') return 'content';
  if (kind === 'asset' || kind === 'link') return 'integration';
  return areaOf(check);
}

function lookupLongest(map, check) {
  let best = '';
  for (const k of Object.keys(map || {})) if (check.startsWith(k) && k.length > best.length) best = k;
  return best ? map[best] : undefined;
}

function evidenceOf(items, pair) {
  const withFiles = items.filter((x) => x && x.files);
  const pick = withFiles.find((x) => String(x.viewport) === '1440') || withFiles[0];
  if (!pick || !pair) return null;
  const at = (file) => (file ? `pairs/${pair.id}/visual/${file}` : '');
  return { before: at(pick.files.before), after: at(pick.files.after), diff: at(pick.files.diff) };
}

/** All fixes in a run, highest priority first. */
function buildFixes(run, rules = DEFAULT_RULES) {
  const pairs = run.pairs || [];
  const map = new Map();
  const add = (f, pair, previewHost, replaced = new Set()) => {
    for (const scope of scopesOf(f)) {
      const part = { ...f, items: scope.items.length ? scope.items : f.items };
      const priority = priorityOf(part, { previewHost }, rules);
      if (!priority) continue;
      const area = areaOfScope(scope.kind, f.check);
      let fx = map.get(scope.key);
      if (!fx) {
        fx = { key: scope.key, kind: scope.kind, area, priority, first: f, checks: new Set(), pages: [], pageKeys: new Set(), keys: new Set(), keysByCheck: new Map(), capped: 0, plain: 0, occurrences: 0, items: [], section: sectionOf(scope.kind, scope, f), component: '', evidence: null, ...valuesOf(f, scope.items[0]) };
        map.set(scope.key, fx);
      }
      if (PRIORITY_ORDER.indexOf(priority) < PRIORITY_ORDER.indexOf(fx.priority)) fx.priority = priority;
      fx.checks.add(f.check);
      if (pair && !fx.pageKeys.has(pair.after)) {
        fx.pageKeys.add(pair.after);
        fx.pages.push({ source: pair.before, destination: pair.after });
      }
      const page = pair ? pathOf(pair) : '';
      if (scope.items.length) {
        for (const it of scope.items) {
          fx.keys.add(countKey(it));
          if (!fx.keysByCheck.has(f.check)) fx.keysByCheck.set(f.check, new Set());
          fx.keysByCheck.get(f.check).add(countKey(it));
          fx.occurrences++;
          if (!fx.component && it && it.component) fx.component = it.component;
          if (fx.items.length < MAX_FIX_ITEMS) fx.items.push(it && typeof it === 'object' ? { ...it, page } : { value: it, page });
        }
        if (Number(f.truncated) && scopesOf(f).length === 1) fx.capped = Math.max(fx.capped, scope.items.length + Number(f.truncated));
      } else {
        fx.plain++;
        fx.occurrences++;
        if ((f.before !== undefined || f.after !== undefined) && fx.items.length < MAX_FIX_ITEMS) fx.items.push({ before: f.before, after: f.after, page });
      }
      if (scope.kind === 'visual' && !fx.evidenceAt1440) {
        const ev = evidenceOf(scope.items, pair);
        if (ev && (!fx.evidence || scope.items.some((x) => x && x.files && String(x.viewport) === '1440'))) {
          fx.evidence = ev;
          fx.evidenceAt1440 = scope.items.some((x) => x && x.files && String(x.viewport) === '1440');
        }
      }
      if (scope.kind === 'visual' && !fx.component) fx.component = (scope.items[0] && scope.items[0].section) || '';
      if (f.check === 'visual.section.missing' && scope.items.some((it) => it && replaced.has(it.section))) fx.replaced = true;
    }
  };
  for (const p of pairs) {
    const previewHost = isPreviewHost(hostOf(p.after));
    // A section missing and another added under the same name: the section is there, its content changed.
    const replaced = new Set((p.findings || []).filter((f) => f.check === 'visual.section.added').flatMap((f) => (f.items || []).map((it) => it && it.section)));
    for (const f of p.findings || []) add(f, p, previewHost, replaced);
  }
  const c = run.completeness || {};
  const sitePreview = pairs.length ? isPreviewHost(hostOf(pairs[0].after)) : false;
  for (const f of [...(c.siteFindings || []), ...(c.redirectFindings || [])]) add(f, null, sitePreview);

  return [...map.values()].map((fx) => {
    const count = Math.max(fx.keys.size, fx.capped) || fx.plain || 1;
    const out = {
      id: fixId(fx.area, fx.key),
      priority: fx.priority,
      area: fx.area,
      title: '',
      section: fx.section,
      component: fx.component,
      fixType: lookupLongest(rules.fixType, fx.first.check) || 'code',
      owner: ownerOf(fx.first.check, rules),
      checks: [...fx.checks],
      pages: fx.pages,
      siteWide: !fx.pages.length,
      count,
      expected: clip(fx.expected),
      actual: clip(fx.actual),
      items: fx.items,
      ...(fx.occurrences > fx.items.length ? { truncated: fx.occurrences - fx.items.length } : {}),
      ...(fx.evidence ? { evidence: fx.evidence } : {}),
    };
    out.title = titleOf({ ...fx, count });
    return out;
  }).sort((x, y) => PRIORITY_ORDER.indexOf(x.priority) - PRIORITY_ORDER.indexOf(y.priority)
    || AREA_ORDER.indexOf(x.area) - AREA_ORDER.indexOf(y.area)
    || y.pages.length - x.pages.length
    || y.count - x.count
    || x.id.localeCompare(y.id));
}

/** Content and visual parity of one page, in percent; null when the page could not be compared or has no sections. */
function pageParity(pair) {
  if (pair.blocked || pair.error) return { content: null, visual: null };
  const missing = (pair.findings || []).find((f) => f.check === 'content.text.missing');
  let pct = 0;
  if (missing) {
    const m = /\(([\d.]+)% of text\)/.exec(missing.summary || '');
    pct = Number.isFinite(missing.pct) ? missing.pct : m ? Number(m[1]) : 0;
  }
  const rows = ((pair.visual && pair.visual.rows) || []).filter((r) => r.status !== 'added');
  return { content: round1(100 - pct), visual: rows.length ? round1((100 * rows.filter((r) => r.status === 'pass').length) / rows.length) : null };
}

/** Mean parity over the compared pages. */
function runParity(pairs) {
  const all = (pairs || []).map(pageParity);
  const mean = (k) => {
    const v = all.map((x) => x[k]).filter((x) => x !== null);
    return v.length ? round1(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  return { content: mean('content'), visual: mean('visual') };
}

const hostsOf = (urls) => [...new Set(urls.map(hostOf).filter(Boolean))].join(', ');

/** Everything a report view needs: where the comparison ran, the verdict, parity and the fixes. */
function reportModel(run, rules = DEFAULT_RULES, baseline = null) {
  const pairs = run.pairs || [];
  const single = pairs.length === 1;
  const built = buildFixes(run, rules);
  let compared = new Set();
  let acceptedIds = new Set();
  if (baseline) {
    compared = new Set(pairs.filter((p) => !p.blocked && !p.error).map((p) => p.after));
    const unaccepted = { ...run, pairs: pairs.map((p) => ({ ...p, findings: (p.findings || []).map(({ accepted, ...f }) => f) })) };
    acceptedIds = new Set(buildFixes(unaccepted, rules).map((f) => f.id));
  }
  const { fixes, fixed, notRechecked, accepted } = baseline ? applyBaseline(built, baseline, { compared, acceptedIds }) : { fixes: built, fixed: [], notRechecked: [], accepted: [] };
  const notCompared = pairs.filter((p) => p.blocked || p.error).length;
  const model = {
    generatedAt: run.generatedAt,
    source: single ? pairs[0].before : hostsOf(pairs.map((p) => p.before)),
    destination: single ? pairs[0].after : hostsOf(pairs.map((p) => p.after)),
    single,
    pages: pairs.length,
    viewports: run.viewports || [],
    parity: runParity(pairs),
    fixes,
    fixed,
    notRechecked,
    accepted,
    hasBaseline: !!baseline,
    baselineAt: baseline ? baseline.generatedAt || null : null,
    baselineP1: baseline ? (baseline.fixes || []).filter((f) => f.priority === 'P1').length : null,
    pair: single ? pairs[0] : null,
    flaky: pairs.filter((p) => p.flaky).length,
    notTested: run.notTested || [],
  };
  model.verdict = verdictOf(fixes, { notCompared, pages: pairs.length });
  return model;
}

/** Reads a previous run's fixes.json for --baseline. Throws with a message that says what to fix. */
function loadBaseline(dir) {
  const file = path.join(dir, 'fixes.json');
  if (!fs.existsSync(file)) throw new Error(`--baseline: ${file} not found; point --baseline at the --out folder of an earlier run`);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`--baseline: ${file} is not valid JSON`);
  }
  if (!data || !Array.isArray(data.fixes)) throw new Error(`--baseline: ${file} has no "fixes" list`);
  return data;
}

/**
 * Marks fixes as new or open against an earlier run. An earlier fix that is gone counts as fixed only when
 * every page it was on was compared this run (site-wide fixes: when any page was); otherwise it is not rechecked.
 * One that is gone because the difference was accepted is listed as accepted.
 * Without `compared`, every page counts as compared.
 */
function applyBaseline(fixes, baseline, { compared = null, acceptedIds = new Set() } = {}) {
  const before = new Set((baseline.fixes || []).map((f) => f.id));
  const now = new Set(fixes.map((f) => f.id));
  const rechecked = (f) => {
    if (!compared) return true;
    const pages = Array.isArray(f.pages) ? f.pages : [];
    return pages.length ? pages.every((p) => compared.has(p.destination)) : compared.size > 0;
  };
  const gone = (baseline.fixes || []).filter((f) => !now.has(f.id));
  return {
    fixes: fixes.map((f) => ({ ...f, status: before.has(f.id) ? 'open' : 'new' })),
    fixed: gone.filter((f) => !acceptedIds.has(f.id) && rechecked(f)),
    notRechecked: gone.filter((f) => !acceptedIds.has(f.id) && !rechecked(f)),
    accepted: gone.filter((f) => acceptedIds.has(f.id)),
  };
}

/** The model narrowed to one page: its fixes, with only that page's items, its own parity and verdict. */
function pageModel(model, pair) {
  const page = pathOf(pair);
  const fixes = model.fixes.filter((f) => f.pages.some((p) => p.destination === pair.after)).map((f) => ({
    ...f,
    pages: f.pages.filter((p) => p.destination === pair.after),
    items: f.items.filter((it) => !it.page || it.page === page),
  }));
  return {
    ...model,
    source: pair.before,
    destination: pair.after,
    single: true,
    pages: 1,
    parity: pageParity(pair),
    fixes,
    fixed: [],
    notRechecked: [],
    accepted: [],
    // Progress is run-wide; a page file does not repeat it.
    hasBaseline: false,
    pair,
    verdict: verdictOf(fixes, { notCompared: pair.blocked || pair.error ? 1 : 0, pages: 1 }),
  };
}

module.exports = { loadBaseline, applyBaseline, pageModel, buildFixes, fixId, pageParity, runParity, reportModel, sectionLabel, assetPrefix, AREA_ORDER };
