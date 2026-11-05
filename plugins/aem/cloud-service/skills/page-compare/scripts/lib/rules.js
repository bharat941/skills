'use strict';

const fs = require('fs');
const { globToRegex } = require('./util');

const DEFAULT_RULES = {
  text: { failMissingPct: 10, addedReviewPct: 2, volatileFlakyPct: 5 },
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

module.exports = {
  deriveStatus,
  reusableResult,
  DEFAULT_RULES,
  loadRules,
  loadAccepted,
  rewritesFrom,
  applyRewrites,
  applyAccepted,
  worstSeverity,
  SEVERITY_ORDER,
};
