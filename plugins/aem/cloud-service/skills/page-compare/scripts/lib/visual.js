'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');
const { similarity, normalizeText, round } = require('./util');
const { finding, cap } = require('./content');

function crop(png, w, h) {
  if (png.width === w && png.height === h) return Buffer.from(png.data);
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) png.data.copy(out, y * w * 4, y * png.width * 4, y * png.width * 4 + w * 4);
  return out;
}

// Pixels that differ between two loads of the same page, grown a little so edges are covered.
function buildMask(bufA, bufB, { delta = 40, radius = 2 } = {}) {
  const A = PNG.sync.read(bufA);
  const B = PNG.sync.read(bufB);
  const w = Math.min(A.width, B.width);
  const h = Math.min(A.height, B.height);
  const a = crop(A, w, h);
  const b = crop(B, w, h);
  const data = new Uint8Array(w * h);
  let count = 0;
  for (let i = 0, p = 0; p < w * h; i += 4, p++) {
    if (Math.abs(a[i] - b[i]) > delta || Math.abs(a[i + 1] - b[i + 1]) > delta || Math.abs(a[i + 2] - b[i + 2]) > delta) {
      for (let dy = -radius; dy <= radius; dy++) {
        const y = Math.floor(p / w) + dy;
        if (y < 0 || y >= h) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const x = (p % w) + dx;
          if (x < 0 || x >= w) continue;
          const q = y * w + x;
          if (!data[q]) {
            data[q] = 1;
            count++;
          }
        }
      }
    }
  }
  return { w, h, data, count };
}

// Counts pixels that have no close match within one pixel in the other image (either way),
// so a sub-pixel vertical shift from content above does not look like a change.
function shiftTolerantChanged(a, b, w, h, delta = 48) {
  const near = (src, dst, x, y) => {
    const i = (y * w + x) * 4;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const j = (yy * w + xx) * 4;
        if (Math.abs(src[i] - dst[j]) <= delta && Math.abs(src[i + 1] - dst[j + 1]) <= delta && Math.abs(src[i + 2] - dst[j + 2]) <= delta) return true;
      }
    }
    return false;
  };
  let changed = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!near(a, b, x, y) || !near(b, a, x, y)) changed++;
    }
  }
  return changed;
}

function compareImages(bufA, bufB, mask, { tolerantAbovePct } = {}) {
  const A = PNG.sync.read(bufA);
  const B = PNG.sync.read(bufB);
  const w = Math.min(A.width, B.width);
  const h = Math.min(A.height, B.height);
  const a = crop(A, w, h);
  const b = crop(B, w, h);
  let masked = 0;
  if (mask) {
    for (let y = 0; y < Math.min(h, mask.h); y++) {
      for (let x = 0; x < Math.min(w, mask.w); x++) {
        if (mask.data[y * mask.w + x]) {
          const i = (y * w + x) * 4;
          a[i] = b[i] = a[i + 1] = b[i + 1] = a[i + 2] = b[i + 2] = 0;
          a[i + 3] = b[i + 3] = 255;
          masked++;
        }
      }
    }
  }
  const diff = new PNG({ width: w, height: h });
  let changed = w && h ? pixelmatch(a, b, diff.data, w, h, { threshold: 0.1 }) : 0;
  const area = Math.max(1, w * h - masked);
  if (tolerantAbovePct !== undefined && (changed / area) * 100 > tolerantAbovePct) {
    changed = Math.min(changed, shiftTolerantChanged(a, b, w, h));
  }
  return {
    pct: round((changed / area) * 100),
    changed,
    width: w,
    height: h,
    heightBefore: A.height,
    heightAfter: B.height,
    widthBefore: A.width,
    widthAfter: B.width,
    maskedPct: round((masked / Math.max(1, w * h)) * 100),
    diffPng: () => PNG.sync.write(diff),
  };
}

function kindOf(name) {
  return name === 'header' || name === 'footer' ? name : 'main';
}

// Pair sections by text fingerprint first, then by order within the same kind.
function pairSections(before, after) {
  const usedB = new Set();
  const usedA = new Set();
  const pairs = [];
  for (const [i, b] of before.entries()) {
    if (!b.fp) continue;
    const j = after.findIndex((a, k) => !usedA.has(k) && kindOf(a.name) === kindOf(b.name) && a.fp === b.fp);
    if (j >= 0) {
      usedB.add(i);
      usedA.add(j);
      pairs.push([b, after[j]]);
    }
  }
  let cursor = 0;
  for (const [i, b] of before.entries()) {
    if (usedB.has(i)) continue;
    for (let k = cursor; k < after.length; k++) {
      const a = after[k];
      if (usedA.has(k) || kindOf(a.name) !== kindOf(b.name)) continue;
      if ((!b.fp && !a.fp) || similarity(normalizeText(b.fp), normalizeText(a.fp)) >= 0.5) {
        usedB.add(i);
        usedA.add(k);
        pairs.push([b, a]);
        cursor = k + 1;
        break;
      }
    }
  }
  return {
    pairs,
    missing: before.filter((_, i) => !usedB.has(i)),
    added: after.filter((_, i) => !usedA.has(i)),
  };
}

function safeName(s) {
  return String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 30);
}

function writeFiles(dir, base, bufs) {
  fs.mkdirSync(dir, { recursive: true });
  const files = {};
  for (const [k, buf] of Object.entries(bufs)) {
    const name = `${base}-${k}.png`;
    fs.writeFileSync(path.join(dir, name), buf);
    files[k] = name;
  }
  return files;
}

/**
 * before/after: section lists from one viewport; before2: optional second load of the before page.
 * Returns { findings, rows, noise } where rows feed the report.
 */
function visualFindings({ viewport, before, after, before2, rules, outDir, sectionFilter }) {
  const v = rules.visual;
  const findings = [];
  const rows = [];
  const pairing = pairSections(before, after);

  let noiseWeighted = 0;
  let noiseArea = 0;
  const masks = new Map();
  if (before2 && before2.length) {
    const noisePairs = pairSections(before, before2).pairs;
    for (const [b, b2] of noisePairs) {
      const n = compareImages(b.png, b2.png);
      masks.set(b.name, buildMask(b.png, b2.png));
      noiseWeighted += n.pct * n.width * n.height;
      noiseArea += n.width * n.height;
    }
  }
  const noise = noiseArea ? round(noiseWeighted / noiseArea) : null;
  if (noise !== null && noise >= v.unstableNoisePct) {
    findings.push(finding('visual.unstable', 'review', `The before page changes ${noise}% between two loads at ${viewport}; pixel comparison is not reliable for this page`, { viewport, noise }));
    return { findings, rows, noise, unstable: true };
  }

  const flagged = [];
  for (const [b, a] of pairing.pairs) {
    const r = compareImages(b.png, a.png, masks.get(b.name), { tolerantAbovePct: v.reviewPct });
    const heightDelta = r.heightAfter - r.heightBefore;
    const status = r.pct > v.failPct ? 'fail' : r.pct > v.reviewPct ? 'review' : 'pass';
    const row = { viewport, section: a.name, before: b.name, pct: r.pct, maskedPct: r.maskedPct, heightBefore: r.heightBefore, heightAfter: r.heightAfter, heightDelta, status };
    if (status !== 'pass' || Math.abs(heightDelta) > r.heightBefore * (v.heightReviewPct / 100)) {
      row.files = writeFiles(outDir, `${viewport}-${safeName(a.name)}`, { before: b.png, after: a.png, diff: r.diffPng() });
    }
    rows.push(row);
    if (status !== 'pass') flagged.push({ ...row });
    if (r.heightBefore && Math.abs(heightDelta) > r.heightBefore * (v.heightReviewPct / 100)) {
      findings.push(finding('visual.height', 'review', `Section "${a.name}" is ${Math.abs(heightDelta)}px ${heightDelta > 0 ? 'taller' : 'shorter'} at ${viewport}`, { viewport, section: a.name, before: `${r.heightBefore}px`, after: `${r.heightAfter}px`, files: row.files }));
    }
  }
  if (flagged.length) {
    const worst = flagged.some((f) => f.status === 'fail') ? 'fail' : 'review';
    findings.push(finding('visual.section', worst, `${flagged.length} section(s) look different at ${viewport}`, cap(flagged.map((f) => ({ section: f.section, viewport, pct: f.pct, files: f.files })))));
  }
  if (pairing.missing.length) {
    const important = pairing.missing.some((m) => m.chars >= v.missingSectionFailMinChars || m.height >= v.missingSectionFailMinHeight);
    findings.push(finding('visual.section.missing', important ? 'fail' : 'review', `${pairing.missing.length} section(s) from the before page have no match on the after page at ${viewport}`, cap(pairing.missing.map((m) => ({ section: m.name, viewport, text: (m.fp || '').slice(0, 120), height: m.height })))));
    for (const m of pairing.missing) rows.push({ viewport, section: m.name, status: 'missing', heightBefore: m.height });
  }
  if (pairing.added.length) {
    findings.push(finding('visual.section.added', 'info', `${pairing.added.length} new section(s) on the after page at ${viewport}`, cap(pairing.added.map((m) => ({ section: m.name, viewport, text: (m.fp || '').slice(0, 120) })))));
    for (const m of pairing.added) rows.push({ viewport, section: m.name, status: 'added', heightAfter: m.height });
  }
  return { findings, rows, noise, unstable: false };
}

module.exports = { buildMask, compareImages, pairSections, visualFindings };
