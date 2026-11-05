'use strict';

const { normalizeText, collapseSpace, similarity, normalizePath, imageStem, round } = require('./util');
const { applyRewrites } = require('./rules');

const MAX_ITEMS = 50;

function finding(check, severity, summary, extra = {}) {
  return { check, severity, summary, ...extra };
}

function cap(items) {
  return items.length > MAX_ITEMS ? { items: items.slice(0, MAX_ITEMS), truncated: items.length - MAX_ITEMS } : { items };
}

function counter(list, keyFn) {
  const m = new Map();
  for (const x of list) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

// ---------- text ----------

function diffBlocks(beforeBlocks, afterBlocks, volatile = []) {
  const vol = new Set(volatile.map(normalizeText));
  const bl = beforeBlocks.map((b) => ({ ...b, norm: normalizeText(b.text) })).filter((b) => b.norm && !vol.has(b.norm));
  const al = afterBlocks.map((b) => ({ ...b, norm: normalizeText(b.text) })).filter((b) => b.norm);

  const pool = counter(al, (b) => b.norm);
  let formatOnly = 0;
  const unmatchedBefore = [];
  for (const b of bl) {
    const hits = pool.get(b.norm);
    if (hits && hits.length) {
      const other = hits.shift();
      if (collapseSpace(other.text) !== collapseSpace(b.text)) formatOnly++;
    } else {
      unmatchedBefore.push(b);
    }
  }
  let unmatchedAfter = [...pool.values()].flat();

  const volNorms = [...vol];
  unmatchedAfter = unmatchedAfter.filter((a) => !volNorms.some((v) => similarity(a.norm, v) >= 0.6));

  const missing = [];
  const changed = [];
  const available = new Set(unmatchedAfter);
  for (const b of unmatchedBefore) {
    let best = null;
    let bestSim = 0;
    for (const a of available) {
      if (Math.abs(a.norm.length - b.norm.length) > Math.max(b.norm.length, a.norm.length) * 0.6) continue;
      const s = similarity(b.norm, a.norm);
      if (s > bestSim) {
        bestSim = s;
        best = a;
      }
    }
    if (best && bestSim >= 0.85) {
      available.delete(best);
      changed.push({ before: b.text, after: best.text, similarity: round(bestSim), region: b.region, hidden: !!b.hidden });
    } else {
      missing.push({ text: b.text, region: b.region, hidden: !!b.hidden, chars: b.norm.length });
    }
  }
  const added = [...available].map((a) => ({ text: a.text, region: a.region, chars: a.norm.length }));

  const totalChars = bl.reduce((n, b) => n + b.norm.length, 0);
  const lost = missing.reduce((n, m) => n + m.chars, 0) + changed.reduce((n, c) => n + (1 - c.similarity) * normalizeText(c.before).length, 0);
  const addedChars = added.reduce((n, a) => n + a.chars, 0);
  return {
    missing,
    changed,
    added,
    formatOnly,
    totalChars,
    missingPct: totalChars ? round((lost / totalChars) * 100) : 0,
    addedPct: totalChars ? round((addedChars / totalChars) * 100) : 0,
  };
}

function textFindings(before, after, rules, volatile) {
  const d = diffBlocks(before.blocks, after.blocks, volatile);
  const out = [];
  const sev = d.missingPct > rules.text.failMissingPct ? 'fail' : 'review';
  if (d.missing.length) {
    out.push(finding('content.text.missing', sev, `${d.missing.length} text block(s) from the before page are missing on the after page (${d.missingPct}% of text)`, cap(d.missing)));
  }
  if (d.changed.length) {
    out.push(finding('content.text.changed', d.missing.length ? 'review' : sev, `${d.changed.length} text block(s) were reworded`, cap(d.changed)));
  }
  if (d.added.length) {
    out.push(finding('content.text.added', d.addedPct > rules.text.addedReviewPct ? 'review' : 'info', `${d.added.length} new text block(s) on the after page (${d.addedPct}% of before text)`, cap(d.added)));
  }
  if (d.formatOnly) {
    out.push(finding('content.text.format', 'info', `${d.formatOnly} block(s) differ only in spacing`));
  }
  return out;
}

// ---------- meta / head ----------

function metaFindings(before, after, ctx) {
  const out = [];
  const same = (a, b) => normalizeText(a) === normalizeText(b);
  if (!after.title && before.title) out.push(finding('meta.title', 'fail', 'Title is missing on the after page', { before: before.title, after: after.title }));
  else if (!same(before.title, after.title)) out.push(finding('meta.title', 'review', 'Title changed', { before: before.title, after: after.title }));

  const bm = before.meta || {};
  const am = after.meta || {};
  if (bm.description && !am.description) out.push(finding('meta.description', 'review', 'Meta description is missing on the after page', { before: bm.description }));
  else if (bm.description && !same(bm.description, am.description)) out.push(finding('meta.description', 'review', 'Meta description changed', { before: bm.description, after: am.description }));

  if (am.robots && /noindex/i.test(am.robots) && !/noindex/i.test(bm.robots || '')) {
    out.push(finding('meta.robots', 'fail', 'After page is set to noindex', { before: bm.robots || '', after: am.robots }));
  } else if ((bm.robots || '') !== (am.robots || '')) {
    out.push(finding('meta.robots', 'review', 'Robots meta changed', { before: bm.robots || '', after: am.robots || '' }));
  }

  if (am.canonical) {
    const canonHost = safeHost(am.canonical);
    if (canonHost && canonHost !== ctx.afterHost && bm.canonical && safeHost(bm.canonical) === ctx.beforeHost) {
      out.push(finding('meta.canonical', 'fail', 'Canonical still points to a different host than the after page', { before: bm.canonical, after: am.canonical }));
    } else if (bm.canonical && ctx.canon(bm.canonical, 'before') !== ctx.canon(am.canonical, 'after')) {
      out.push(finding('meta.canonical', 'review', 'Canonical URL changed', { before: bm.canonical, after: am.canonical }));
    }
  } else if (bm.canonical) {
    out.push(finding('meta.canonical', 'review', 'Canonical link is missing on the after page', { before: bm.canonical }));
  }

  const hb = new Set((before.hreflang || []).map((h) => h.lang));
  const ha = new Set((after.hreflang || []).map((h) => h.lang));
  const lostLang = [...hb].filter((l) => !ha.has(l));
  if (lostLang.length) out.push(finding('meta.hreflang', 'review', `hreflang missing on after page: ${lostLang.join(', ')}`, { items: lostLang }));

  const social = Object.keys(bm).filter((k) => /^(og|twitter):/.test(k) && !am[k]);
  if (social.length) out.push(finding('meta.social', 'review', `Open Graph / Twitter tags missing on after page: ${social.join(', ')}`, { items: social }));

  if (before.lang && before.lang !== after.lang) out.push(finding('meta.lang', 'review', 'html lang attribute changed', { before: before.lang, after: after.lang }));
  if (before.favicon && !after.favicon) out.push(finding('meta.favicon', 'info', 'Favicon link missing on after page'));
  return out;
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    return '';
  }
}

// ---------- headings ----------

function headingFindings(before, after) {
  const out = [];
  const bh = before.headings || [];
  const ah = after.headings || [];
  const aMap = counter(ah, (h) => normalizeText(h.text));
  const missingH1 = [];
  const missingOther = [];
  const levelChanged = [];
  for (const h of bh) {
    const key = normalizeText(h.text);
    const hits = aMap.get(key);
    if (hits && hits.length) {
      const match = hits.shift();
      if (match.level !== h.level) levelChanged.push({ text: h.text, before: `H${h.level}`, after: `H${match.level}` });
      continue;
    }
    const near = ah.find((x) => x.level === h.level && similarity(normalizeText(x.text), key) >= 0.8);
    if (near) {
      (h.level === 1 ? missingH1 : missingOther).push({ text: h.text, reworded: near.text, level: h.level, soft: true });
    } else {
      (h.level === 1 ? missingH1 : missingOther).push({ text: h.text, level: h.level });
    }
  }
  const hardH1 = missingH1.filter((x) => !x.soft);
  if (hardH1.length) out.push(finding('heading.h1', 'fail', 'H1 missing or changed on the after page', cap(hardH1)));
  const softH1 = missingH1.filter((x) => x.soft);
  if (softH1.length) out.push(finding('heading.h1.reworded', 'review', 'H1 reworded on the after page', cap(softH1)));
  if (!ah.some((h) => h.level === 1) && bh.some((h) => h.level === 1) && !hardH1.length && !softH1.length) {
    out.push(finding('heading.h1', 'fail', 'After page has no H1'));
  }
  if (missingOther.length) out.push(finding('heading.missing', 'review', `${missingOther.length} heading(s) missing on the after page`, cap(missingOther)));
  if (levelChanged.length) out.push(finding('heading.level', 'review', `${levelChanged.length} heading(s) changed level`, cap(levelChanged)));
  const extra = [...aMap.values()].flat();
  if (extra.length) out.push(finding('heading.added', 'info', `${extra.length} new heading(s) on the after page`, cap(extra.map((h) => ({ text: h.text, level: h.level })))));
  return out;
}

// ---------- images ----------

function imageFindings(before, after) {
  const out = [];
  const aMap = counter(after.images || [], (i) => imageStem(i.src));
  const missing = [];
  const altChanged = [];
  const altLost = [];
  for (const img of before.images || []) {
    const hits = aMap.get(imageStem(img.src));
    if (!hits || !hits.length) {
      missing.push({ src: img.src, alt: img.alt, inMain: img.inMain });
      continue;
    }
    const match = hits.shift();
    if (img.alt && !match.alt) altLost.push({ src: match.src, before: img.alt, after: '' });
    else if (img.alt && normalizeText(img.alt) !== normalizeText(match.alt)) altChanged.push({ src: match.src, before: img.alt, after: match.alt });
  }
  const missingMain = missing.filter((m) => m.inMain);
  const missingOther = missing.filter((m) => !m.inMain);
  if (missingMain.length) out.push(finding('image.missing', 'fail', `${missingMain.length} content image(s) missing on the after page`, cap(missingMain)));
  if (missingOther.length) out.push(finding('image.missing.chrome', 'review', `${missingOther.length} header/footer image(s) missing on the after page`, cap(missingOther)));
  if (altLost.length) out.push(finding('image.alt', 'review', `${altLost.length} image(s) lost their alt text`, cap(altLost)));
  if (altChanged.length) out.push(finding('image.alt.changed', 'review', `${altChanged.length} image alt text(s) changed`, cap(altChanged)));

  const brokenBefore = new Set((before.images || []).filter((i) => i.broken).map((i) => imageStem(i.src)));
  const broken = (after.images || []).filter((i) => i.broken && !brokenBefore.has(imageStem(i.src)));
  const brokenMain = broken.filter((i) => i.inMain);
  if (brokenMain.length) out.push(finding('image.broken', 'fail', `${brokenMain.length} content image(s) fail to load on the after page`, cap(brokenMain.map((i) => ({ src: i.src })))));
  const brokenOther = broken.filter((i) => !i.inMain);
  if (brokenOther.length) out.push(finding('image.broken.chrome', 'review', `${brokenOther.length} header/footer image(s) fail to load on the after page`, cap(brokenOther.map((i) => ({ src: i.src })))));
  const extra = [...aMap.values()].flat();
  if (extra.length) out.push(finding('image.added', 'info', `${extra.length} new image(s) on the after page`, cap(extra.map((i) => ({ src: i.src })))));
  return out;
}

// ---------- links, nav, CTAs, downloads ----------

function isSkippable(href) {
  return !href || href.startsWith('#') || /^javascript:/i.test(href);
}

function linkFindings(before, after, ctx) {
  const out = [];
  const group = (links, side) => {
    const m = new Map();
    for (const l of links) {
      if (isSkippable(l.href)) continue;
      const text = normalizeText(l.text);
      if (!text) continue;
      const key = ctx.canon(l.href, side);
      if (!m.has(text)) m.set(text, { text: l.text, targets: new Set() });
      m.get(text).targets.add(key);
    }
    return m;
  };
  const bg = group(before.links || [], 'before');
  const ag = group(after.links || [], 'after');
  const afterTargets = new Set([...ag.values()].flatMap((g) => [...g.targets]));
  const beforeTargets = new Set([...bg.values()].flatMap((g) => [...g.targets]));

  const missing = [];
  const retargeted = [];
  for (const [text, g] of bg) {
    const hit = ag.get(text);
    if (!hit) {
      if (![...g.targets].some((t) => afterTargets.has(t))) missing.push({ text: g.text, target: [...g.targets][0] });
      continue;
    }
    if (![...g.targets].some((t) => hit.targets.has(t))) {
      retargeted.push({ text: g.text, before: [...g.targets].join(', '), after: [...hit.targets].join(', ') });
    }
  }
  if (missing.length) out.push(finding('link.missing', 'review', `${missing.length} link(s) from the before page are missing on the after page`, cap(missing)));
  if (retargeted.length) out.push(finding('link.target', 'review', `${retargeted.length} link(s) point somewhere different on the after page`, cap(retargeted)));
  const added = [...ag].filter(([text, g]) => !bg.has(text) && ![...g.targets].some((t) => beforeTargets.has(t)));
  if (added.length) out.push(finding('link.added', 'info', `${added.length} new link(s) on the after page`, cap(added.map(([, g]) => ({ text: g.text, target: [...g.targets][0] })))));
  return out;
}

function navFindings(before, after) {
  const have = new Set((after.nav || []).map(normalizeText));
  const missing = (before.nav || []).filter((t) => normalizeText(t) && !have.has(normalizeText(t)));
  return missing.length ? [finding('nav.item', 'fail', `${missing.length} navigation item(s) missing on the after page`, cap(missing.map((text) => ({ text }))))] : [];
}

function ctaFindings(before, after) {
  const have = new Set((after.ctas || []).map(normalizeText));
  const missing = (before.ctas || []).filter((t) => normalizeText(t) && !have.has(normalizeText(t)));
  return missing.length ? [finding('cta.missing', 'review', `${missing.length} button/CTA label(s) missing on the after page`, cap(missing.map((text) => ({ text }))))] : [];
}

// ---------- forms ----------

function formFindings(before, after, ctx) {
  const out = [];
  const afterFields = new Map();
  for (const f of after.forms || []) for (const field of f.fields) afterFields.set(fieldKey(field), field);
  const missing = [];
  const changed = [];
  for (const f of before.forms || []) {
    for (const field of f.fields) {
      const hit = afterFields.get(fieldKey(field));
      if (!hit) {
        missing.push({ field: fieldKey(field), type: field.type, label: field.label });
      } else if (hit.type !== field.type || hit.required !== field.required) {
        changed.push({ field: fieldKey(field), before: `${field.type}${field.required ? ' required' : ''}`, after: `${hit.type}${hit.required ? ' required' : ''}` });
      }
    }
  }
  if (missing.length) out.push(finding('form.field.missing', 'fail', `${missing.length} form field(s) missing on the after page`, cap(missing)));
  if (changed.length) out.push(finding('form.field.changed', 'review', `${changed.length} form field(s) changed type or required flag`, cap(changed)));
  const bActions = (before.forms || []).map((f) => f.action && ctx.canon(f.action, 'before')).filter(Boolean);
  const aActions = new Set((after.forms || []).map((f) => f.action && ctx.canon(f.action, 'after')).filter(Boolean));
  const lost = bActions.filter((a) => !aActions.has(a));
  if (lost.length && (after.forms || []).length) out.push(finding('form.action', 'review', 'Form action target changed', { items: lost.map((a) => ({ before: a })) }));
  return out;
}

function fieldKey(field) {
  return field.name || field.id || `[${field.type}] ${field.label}`;
}

// ---------- structured data ----------

function jsonldFindings(before, after) {
  const bt = new Set((before.jsonld || []).map((j) => j.type));
  const at = new Set((after.jsonld || []).map((j) => j.type));
  const missing = [...bt].filter((t) => !at.has(t));
  return missing.length ? [finding('jsonld.type', 'fail', `Structured data type(s) missing on the after page: ${missing.join(', ')}`, { items: missing })] : [];
}

// ---------- status / redirects ----------

function statusFindings(before, after, ctx) {
  const out = [];
  const ok = (s) => s >= 200 && s < 300;
  if (!ok(after.status)) {
    const gone = [404, 410].includes(after.status);
    out.push(finding(gone && ok(before.status) ? 'page.missing' : 'http.status', ok(before.status) ? 'fail' : 'review', `After page returned HTTP ${after.status}${ok(before.status) ? '' : ` (before page returned ${before.status})`}`, { before: before.status, after: after.status }));
    return { findings: out, comparable: false };
  }
  if (!ok(before.status)) {
    out.push(finding('http.before', 'review', `Before page returned HTTP ${before.status}; nothing to compare against`, { before: before.status, after: after.status }));
    return { findings: out, comparable: false };
  }
  const chain = after.redirects || [];
  if (chain.length > 3) out.push(finding('redirect.chain', 'review', `After URL needs ${chain.length} redirects`, { items: chain }));
  const temp = chain.filter((r) => [302, 303, 307].includes(r.status));
  if (temp.length) out.push(finding('redirect.temporary', 'review', 'After URL uses a temporary redirect where a permanent one is usually expected', { items: temp }));
  if (chain.length && normalizePath(after.finalUrl) !== normalizePath(ctx.afterUrl)) {
    out.push(finding('redirect.target', 'info', 'After URL redirects to a different path', { before: ctx.afterUrl, after: after.finalUrl }));
  }
  return { findings: out, comparable: true };
}

function contentFindings(before, after, ctx) {
  const status = statusFindings(before, after, ctx);
  if (!status.comparable) return status.findings;
  return [
    ...status.findings,
    ...metaFindings(before, after, ctx),
    ...headingFindings(before, after),
    ...textFindings(before, after, ctx.rules, ctx.volatile),
    ...imageFindings(before, after),
    ...linkFindings(before, after, ctx),
    ...navFindings(before, after),
    ...ctaFindings(before, after),
    ...formFindings(before, after, ctx),
    ...jsonldFindings(before, after),
  ];
}

// canon(href, side): comparable key for a link/URL in "after space".
function makeCanon({ beforeUrl, afterUrl, hostMap = [], pathMap = [], rewrites = [], page = {} }) {
  const afterHost = safeHost(afterUrl);
  const beforeHost = safeHost(beforeUrl);
  return function canon(href, side) {
    const base = side === 'before' ? beforeUrl : afterUrl;
    let u;
    try {
      u = new URL(href, base);
    } catch (e) {
      return href;
    }
    if (!/^https?:$/.test(u.protocol)) return href;
    let host = u.host;
    let pathname = u.pathname;
    if (side === 'before') {
      if (host === beforeHost) {
        host = afterHost;
      } else {
        for (const [from, to] of hostMap) {
          if (host === from || u.origin === from) {
            host = to.includes('://') ? new URL(to).host : to;
            break;
          }
        }
      }
      for (const [from, to] of pathMap) {
        if (pathname.startsWith(from)) {
          pathname = to + pathname.slice(from.length);
          break;
        }
      }
    }
    const path = normalizePath(pathname + u.search + u.hash, 'http://x.invalid');
    const rewritten = side === 'before' ? applyRewrites(path, rewrites, page) : path;
    return host === afterHost ? rewritten : `//${host}${rewritten}`;
  };
}

module.exports = { diffBlocks, contentFindings, makeCanon, finding, cap, counter, safeHost, MAX_ITEMS };
