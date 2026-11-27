'use strict';

const fs = require('fs');
const { globToRegex } = require('./util');

const DEFAULT_RULES = {
  text: {
    failMissingPct: 10,
    addedReviewPct: 2,
    volatileFlakyPct: 5,
    // Regex sources, case-insensitive. Text on the after page only that matches is left-over authoring copy.
    placeholder: ['lorem ipsum', 'disclaimer text \\d', 'placeholder', 'sample text', 'text goes here', '\\btbd\\b', 'dummy text'],
    // A list or search component on the after page that came back empty.
    emptyState: ['no results found', 'no items found', 'nothing to show'],
  },
  visual: {
    reviewPct: 1,
    failPct: 5,
    unstableNoisePct: 15,
    heightReviewPct: 10,
    missingSectionFailMinChars: 20,
    missingSectionFailMinHeight: 200,
  },
  timing: { slowerRatio: 1.5, minDeltaMs: 1000 },
  links: { maxPerPage: 50 },
  // What a finding means for a launch. A check id or a prefix ending in "." maps to
  // P1 (blocker: content loss, broken page), P2 (major), P3 (minor), or an object
  // { preview, production } for checks that are expected to differ before launch; either side can be
  // { fail, review } to depend on the finding's severity.
  // "auto" is decided from the finding itself (see priorityOf).
  priority: {
    'content.facts.changed': 'P1',
    'content.placeholder': 'P1',
    'content.text.missing': 'auto',
    'image.missing': 'P1',
    'image.broken': 'P1',
    'heading.h1': 'P1',
    'form.field.missing': 'P1',
    'page.missing': 'P1',
    'http.status': 'P1',
    'js.error': 'P1',
    'visual.section.missing': 'auto',
    'interaction.no_response': 'P1',
    'interaction.js_error': 'P1',
    'interaction.search.empty': 'P1',
    'interaction.form.not_submitted': 'P1',
    'interaction.': 'P2',
    'content.text.rewritten': 'P2',
    'content.text.changed': 'P2',
    'content.empty_state': 'P2',
    'heading.h1.reworded': 'P2',
    'heading.missing': 'P2',
    'cta.missing': 'P2',
    'form.field.changed': 'P2',
    'form.action': 'P2',
    'link.broken': 'P2',
    'download.broken': 'P2',
    'download.changed': 'P2',
    'resource.missing': 'P2',
    'visual.section': 'auto',
    'perf.': 'P2',
    'jsonld.type': 'P2',
    'redirect.wrong': 'P2',
    'meta.title': 'P2',
    'meta.description': 'P2',
    'image.alt': 'P2',
    'a11y.delta': 'P2',
    'nav.item': 'P3',
    'link.missing': 'P3',
    'link.target': 'P3',
    'image.missing.chrome': 'P3',
    'image.broken.chrome': 'P3',
    'image.alt.changed': 'P3',
    'heading.level': 'P3',
    'visual.height': 'P3',
    'meta.social': 'P3',
    'meta.lang': 'P3',
    'meta.hreflang': 'P3',
    'meta.favicon': 'P3',
    'console.error': 'P3',
    'request.': 'P3',
    'redirect.': 'P3',
    'consent.missing': 'P3',
    'content.text.added': 'P3',
    'site.robots': { preview: 'expected', production: { fail: 'P1', review: 'P2' } },
    'meta.robots': { preview: 'expected', production: { fail: 'P1', review: 'P2' } },
    'meta.canonical': { preview: 'expected', production: { fail: 'P1', review: 'P2' } },
    'site.sitemap': { preview: 'expected', production: 'P3' },
    'analytics.': { preview: 'expected', production: 'P2' },
  },
  // What kind of change fixes it, by check-id prefix (longest prefix wins): content (authoring, assets and
  // links in the CMS), code (front end) or config (Dispatcher, CDN, SEO and analytics setup). Default: code.
  fixType: {
    'content.': 'content',
    'heading.': 'content',
    'cta.': 'content',
    'form.field': 'content',
    'image.missing': 'content',
    'image.alt': 'content',
    'image.broken': 'content',
    'request.failed': 'content',
    'nav.': 'content',
    'link.': 'content',
    'meta.title': 'content',
    'meta.description': 'content',
    'meta.social': 'content',
    'download.': 'content',
    'site.': 'config',
    'meta.robots': 'config',
    'meta.canonical': 'config',
    'meta.hreflang': 'config',
    'redirect.': 'config',
    'analytics.': 'config',
    'consent.': 'config',
  },
  // Who most likely fixes it, by check-id prefix (longest prefix wins). A suggestion, not an assignment.
  owner: {
    'content.': 'Content / authoring',
    'heading.': 'Content / authoring',
    'cta.': 'Content / authoring',
    'form.': 'Content / authoring',
    'image.': 'Dev / assets',
    'download.': 'Dev / assets',
    'link.broken': 'Dev / assets',
    'resource.': 'Dev / assets',
    'request.': 'Dev / assets',
    'visual.': 'Dev (front end)',
    'interaction.': 'Dev (front end)',
    'perf.': 'Dev (front end)',
    'js.': 'Dev (front end)',
    'console.': 'Dev (front end)',
    'a11y.': 'Dev (front end)',
    'nav.': 'Content / dev',
    'link.': 'Content / dev',
    'meta.': 'SEO',
    'site.': 'SEO',
    'jsonld.': 'SEO',
    'redirect.': 'SEO',
    'analytics.': 'Analytics',
    'consent.': 'Privacy / dev',
  },
};

function mergeDeep(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] ? mergeDeep(base[k], v) : v;
  }
  return out;
}

function loadRules(file) {
  if (!file) return DEFAULT_RULES;
  return mergeDeep(DEFAULT_RULES, JSON.parse(fs.readFileSync(file, 'utf8')));
}

function loadAccepted(file) {
  if (!file) return [];
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data)) throw new Error(`${file} must be a JSON array`);
  for (const [i, e] of data.entries()) {
    if (!e.reason) throw new Error(`${file}[${i}]: "reason" is required`);
    if (!e.check && !(e.from && e.to)) throw new Error(`${file}[${i}]: "check" (or "from"+"to") is required`);
  }
  return data;
}

// `page` is { path, beforePath }: normalized paths of the after and before URLs.
function pageMatches(entry, page) {
  const re = globToRegex(entry.page || '*');
  return re.test(page.path || '') || re.test(page.beforePath || '');
}

function checkMatches(entry, check) {
  if (!entry.check || entry.check === '*') return true;
  return check === entry.check || check.startsWith(entry.check + '.') || (entry.check.endsWith('*') && check.startsWith(entry.check.slice(0, -1)));
}

function strings(value) {
  if (value == null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object') return Object.values(value).flatMap(strings);
  return [String(value)];
}

function itemMatches(entry, item) {
  if (entry.match && !strings(item).some((s) => s.includes(entry.match))) return false;
  if (entry.selector && item && item.selector !== entry.selector) return false;
  return true;
}

// Rewrites (from/to) map old link prefixes to their new form before diffing.
function rewritesFrom(accepted) {
  return accepted.filter((e) => e.from && e.to).map((e) => ({ from: e.from, to: e.to, page: e.page || '*' }));
}

function applyRewrites(path, rewrites, page) {
  let out = path;
  for (const r of rewrites) {
    if (!pageMatches({ page: r.page }, page)) continue;
    if (out.startsWith(r.from)) out = r.to + out.slice(r.from.length);
  }
  return out;
}

// Marks findings (or individual items of a finding) as accepted. Never drops them.
function applyAccepted(findings, accepted, page) {
  const entries = accepted.filter((e) => e.check && pageMatches(e, page));
  if (!entries.length) return findings;
  return findings.map((f) => {
    const hits = entries.filter((e) => checkMatches(e, f.check));
    if (!hits.length) return f;
    if (Array.isArray(f.items) && f.items.length) {
      const remaining = [];
      const acceptedItems = [];
      for (const item of f.items) {
        const hit = hits.find((e) => (e.match || e.selector ? itemMatches(e, item) : true));
        (hit ? acceptedItems : remaining).push(hit ? { item, reason: hit.reason } : item);
      }
      if (!acceptedItems.length) return f;
      if (!remaining.length) return { ...f, accepted: { reason: acceptedItems[0].reason, items: acceptedItems.length } };
      return { ...f, items: remaining, acceptedItems: acceptedItems.map((a) => a.item), acceptedReason: acceptedItems[0].reason };
    }
    const hit = hits.find((e) => !e.match || strings([f.summary, f.before, f.after]).some((s) => s.includes(e.match)));
    return hit ? { ...f, accepted: { reason: hit.reason } } : f;
  });
}

const SEVERITY_ORDER = { fail: 3, review: 2, info: 1 };

function worstSeverity(findings) {
  let worst = null;
  for (const f of findings) {
    if (f.accepted) continue;
    if (!worst || SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[worst]) worst = f.severity;
  }
  return worst;
}

// Priority: blocked/error, fail, flaky/unstable, review, pass.
function deriveStatus({ error, blocked, flaky, unstable, findings = [] }) {
  if (blocked) return 'blocked';
  if (error) return 'error';
  const worst = worstSeverity(findings);
  if (worst === 'fail') return 'fail';
  if (flaky) return 'flaky';
  if (unstable) return 'unstable';
  return worst === 'review' ? 'review' : 'pass';
}

/** A stored pair result can be reused by --resume only when the page was actually captured. */
function reusableResult(result) {
  return !!result && !result.blocked && !result.error;
}

// Exact check id first, then the longest "prefix." entry.
function lookup(map, check) {
  if (!map) return undefined;
  if (map[check] !== undefined) return map[check];
  const prefix = Object.keys(map).filter((k) => k.endsWith('.') && check.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return prefix ? map[prefix] : undefined;
}

const CHROME_SECTIONS = new Set(['header', 'footer']);

/** True for an item found in the page header or footer. */
const isChromeItem = (it) => Boolean(it && CHROME_SECTIONS.has(it.region));

/**
 * Launch priority of a finding: 'P1' | 'P2' | 'P3' | 'expected' (fine before launch, recheck on the launch
 * domain), or null for info-level and accepted findings, which are not fixes.
 */
function priorityOf(finding, { previewHost = false } = {}, rules = DEFAULT_RULES) {
  if (!finding || finding.accepted || !['fail', 'review'].includes(finding.severity)) return null;
  let p = lookup(rules.priority, finding.check);
  if (p && typeof p === 'object') p = previewHost ? p.preview : p.production;
  if (p && typeof p === 'object') p = p[finding.severity];
  if (p === 'auto') {
    const items = Array.isArray(finding.items) ? finding.items : [];
    if (finding.check === 'visual.section.missing') return items.some((it) => it && !CHROME_SECTIONS.has(it.section)) ? 'P1' : 'P3';
    // Text missing from the main content is a blocker; header/footer text is menus and links.
    if (finding.check === 'content.text.missing') return !items.length || items.some((it) => !isChromeItem(it)) ? 'P1' : 'P3';
    return finding.severity === 'fail' ? 'P2' : 'P3';
  }
  if (p) return p;
  return finding.severity === 'fail' ? 'P2' : 'P3';
}

/** Who most likely fixes a finding, from its check id. */
function ownerOf(check, rules = DEFAULT_RULES) {
  return lookup(rules.owner, check) || 'Dev';
}

module.exports = {
  deriveStatus,
  reusableResult,
  priorityOf,
  ownerOf,
  isChromeItem,
  DEFAULT_RULES,
  loadRules,
  loadAccepted,
  rewritesFrom,
  applyRewrites,
  applyAccepted,
  worstSeverity,
  SEVERITY_ORDER,
};
