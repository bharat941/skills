'use strict';

// Shared helpers for turning findings into fixes: report area, page path, item subject, title, verdict.

const { isChromeItem } = require('./rules');

const INTEGRATION = /^(console\.|js\.|request\.|resource\.|a11y\.|analytics\.|http\.|image\.broken|link\.broken|link\.unchecked|download\.|redirect\.|site\.)/;
const PRIORITY_ORDER = ['P1', 'P2', 'P3', 'expected'];

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

module.exports = { verdictOf, priorityParts, countKey, areaOf, pathOf, subjectOf, normalizeSubject, issueTitle, PRIORITY_ORDER };
