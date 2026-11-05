'use strict';

const crypto = require('crypto');

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function collapseSpace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// Dice coefficient on word sets; cheap and good enough for "same block, small edit".
function similarity(a, b) {
  if (a === b) return 1;
  const ta = a.split(' ').filter(Boolean);
  const tb = b.split(' ').filter(Boolean);
  if (!ta.length || !tb.length) return 0;
  const counts = new Map();
  for (const t of ta) counts.set(t, (counts.get(t) || 0) + 1);
  let shared = 0;
  for (const t of tb) {
    const c = counts.get(t);
    if (c) {
      shared++;
      counts.set(t, c - 1);
    }
  }
  return (2 * shared) / (ta.length + tb.length);
}

const TRACKING_PARAM = /^(utm_|gclid$|fbclid$|msclkid$|mc_|_ga$|cmp$|s_kwcid$|ef_id$|wcmmode$)/i;

// Path (+ meaningful query) used to compare link targets across hosts and URL styles.
function normalizePath(href, base) {
  let u;
  try {
    u = new URL(href, base || 'http://placeholder.invalid');
  } catch (e) {
    return String(href || '');
  }
  let p = u.pathname;
  p = p.replace(/\.html$/i, '').replace(/\/index$/i, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAM.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const q = params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '';
  return decodeSafe(p) + q + (u.hash && u.hash.length > 1 ? u.hash : '');
}

function decodeSafe(s) {
  try {
    return decodeURI(s);
  } catch (e) {
    return s;
  }
}

// Image identity: file stem without extension, AEM rendition and size suffixes.
function imageStem(src) {
  let p;
  try {
    p = new URL(src, 'http://placeholder.invalid').pathname;
  } catch (e) {
    p = String(src || '');
  }
  let name = decodeSafe(p.split('/').filter(Boolean).pop() || '');
  name = name
    .replace(/\.coreimg(\.\d+)?/i, '')
    .replace(/\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?)$/i, '')
    .replace(/[-_.]\d{2,5}x\d{2,5}$/i, '')
    .replace(/\.\d+\.\d+$/, '');
  return name.toLowerCase();
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    return '';
  }
}

function hash(s, len = 8) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, len);
}

function slug(s, max = 48) {
  return String(s || '')
    .toLowerCase()
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'root';
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Glob with * only; used for page patterns in accepted.json.
function globToRegex(glob) {
  return new RegExp('^' + String(glob).split('*').map(escapeRegex).join('.*') + '$');
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function round(n, d = 2) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

module.exports = {
  normalizeText,
  collapseSpace,
  similarity,
  normalizePath,
  imageStem,
  hostOf,
  hash,
  slug,
  escapeRegex,
  globToRegex,
  median,
  round,
};
