'use strict';

// Turns findings into action items: one row per problem, across items and pages, with a launch priority.

const { priorityOf, ownerOf, isChromeItem, DEFAULT_RULES } = require('./rules');
const { isPreviewHost, hostOf } = require('./util');

const INTEGRATION = /^(console\.|js\.|request\.|resource\.|a11y\.|analytics\.|http\.|image\.broken|link\.broken|link\.unchecked|download\.|redirect\.|site\.)/;
const PRIORITY_ORDER = ['P1', 'P2', 'P3', 'expected'];
const AREA_ORDER = ['content', 'visual', 'integration'];

/** Which of the three report areas a check id belongs to. Unknown checks count as content. */
function areaOf(check) {
  if (check.startsWith('visual.')) return 'visual';
  return INTEGRATION.test(check) ? 'integration' : 'content';
}

function pathOf(p) {
  try {
    return new URL(p.after).pathname || '/';
  } catch (e) {
    return p.after;
  }
}

const SUBJECT_KEYS = ['url', 'src', 'href', 'target', 'message', 'text', 'label', 'name', 'type'];

function subjectOf(item) {
  if (item === null || typeof item !== 'object') return String(item ?? '');
  if (item.section) return `${item.section}${item.viewport ? ` at ${item.viewport}px` : ''}`;
  if (item.before !== undefined && item.after !== undefined) return `${item.before} → ${item.after}`;
  for (const k of SUBJECT_KEYS) if (item[k]) return String(item[k]);
  return JSON.stringify(item);
}

// Cache busters and timestamps make the same problem look different on every page.
function normalizeSubject(s) {
  return String(s).replace(/([?&])_=\d+&?/g, '$1').replace(/[?&]$/, '').replace(/\d{6,}/g, '#').replace(/\s+/g, ' ').trim();
}

/** A finding's summary without its count, viewport or share: "48 internal link(s) ... at 1440" → "internal link(s) ...". */
function issueTitle(f) {
  return String(f.summary || f.check)
    .replace(/^\d+\s+(of \d+\s+)?/, '')
    .replace(/\s+at \d+$/, '')
    .replace(/\s*\([^)]*%[^)]*\)$/, '');
}

// The thing an action counts: one section regardless of viewport, else the item's normalised subject.
function countKey(item) {
  if (item && typeof item === 'object' && item.section) return `section:${item.section}`;
  return normalizeSubject(subjectOf(item));
}

function exampleOf(f, pair) {
  const page = pair ? pathOf(pair) : '';
  const items = Array.isArray(f.items) ? f.items : [];
  const first = items[0];
  const ex = { page, pairId: pair ? pair.id : '' };
  if (f.before !== undefined || f.after !== undefined) Object.assign(ex, { before: f.before, after: f.after });
  else if (first && typeof first === 'object' && (first.before !== undefined || first.after !== undefined)) Object.assign(ex, { before: first.before, after: first.after });
  else if (first !== undefined) ex.detail = subjectOf(first);
  const withFiles = items.find((it) => it && it.files);
  if (withFiles) ex.files = withFiles.files;
  return ex;
}

/**
 * A finding as the parts that are prioritised separately. Missing text found in both the main content
 * and the header/footer becomes two parts, so menu labels do not make the main-content blocker look bigger.
 */
function priorityParts(f) {
  const items = Array.isArray(f.items) ? f.items : [];
  if (f.check !== 'content.text.missing') return [f];
  const chrome = items.filter(isChromeItem);
  if (!chrome.length || chrome.length === items.length) return [f];
  return [
    { ...f, items: items.filter((it) => !isChromeItem(it)) },
    { ...f, items: chrome, truncated: 0, summary: `${chrome.length} header/footer text block(s) missing on the after page` },
  ];
}

/**
 * Action items for a run: one per (check, priority) across all pages and site-wide findings,
 * sorted P1 → P2 → P3 → expected, content before visual before integration, then by reach.
 */
function buildActions(run, rules = DEFAULT_RULES) {
  const pairs = run.pairs || [];
  const map = new Map();
  const add = (f, pair, previewHost) => {
    const priority = priorityOf(f, { previewHost }, rules);
    if (!priority) return;
    const key = `${f.check}\u0000${priority}`;
    let a = map.get(key);
    if (!a) {
      a = { priority, area: areaOf(f.check), check: f.check, title: issueTitle(f), count: 0, pages: [], siteWide: !pair, example: exampleOf(f, pair), owner: ownerOf(f.check, rules), keys: new Set(), capped: 0, plain: 0 };
      map.set(key, a);
    }
    if (pair && !a.pages.includes(pathOf(pair))) a.pages.push(pathOf(pair));
    const items = Array.isArray(f.items) ? f.items : [];
    if (items.length) {
      for (const it of items) a.keys.add(countKey(it));
      // A capped list only shows the first items; the full count is the shown items plus the rest.
      if (Number(f.truncated)) a.capped = Math.max(a.capped, items.length + Number(f.truncated));
    } else {
      a.plain++;
    }
  };
  for (const p of pairs) {
    const previewHost = isPreviewHost(hostOf(p.after));
    for (const f of p.findings || []) for (const part of priorityParts(f)) add(part, p, previewHost);
  }
  const c = run.completeness || {};
  const sitePreview = pairs.length ? isPreviewHost(hostOf(pairs[0].after)) : false;
  for (const f of [...(c.siteFindings || []), ...(c.redirectFindings || [])]) add(f, null, sitePreview);

  return [...map.values()]
    .map(({ keys, capped, plain, ...a }) => ({ ...a, count: Math.max(keys.size, capped) || plain || 1 }))
    .sort((x, y) => PRIORITY_ORDER.indexOf(x.priority) - PRIORITY_ORDER.indexOf(y.priority)
      || AREA_ORDER.indexOf(x.area) - AREA_ORDER.indexOf(y.area)
      || y.pages.length - x.pages.length
      || y.count - x.count
      || x.check.localeCompare(y.check));
}

/** The one-line answer for a run: is it ready to launch? */
function verdictOf(actions, { notCompared = 0, pages } = {}) {
  const n = (p) => actions.filter((a) => a.priority === p).length;
  const counts = { p1: n('P1'), p2: n('P2'), p3: n('P3'), expected: n('expected'), notCompared };
  let label = 'No blocking differences found';
  if (pages === 0) label = 'Nothing compared';
  else if (counts.p1) label = 'Not ready';
  else if (notCompared) label = 'Incomplete';
  else if (counts.p2) label = 'Ready after fixes';
  return { label, ...counts };
}

module.exports = { buildActions, verdictOf, priorityParts, areaOf, pathOf, subjectOf, normalizeSubject, issueTitle, PRIORITY_ORDER };
