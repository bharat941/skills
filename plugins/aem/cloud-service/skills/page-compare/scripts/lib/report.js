'use strict';

const STATUS_ORDER = ['blocked', 'error', 'fail', 'flaky', 'unstable', 'review', 'pass'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function summarize(pairs) {
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
  for (const p of pairs) counts[p.status] = (counts[p.status] || 0) + 1;
  return counts;
}

function exitCode(pairs) {
  return pairs.some((p) => ['fail', 'error', 'blocked'].includes(p.status)) ? 1 : 0;
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(pairs) {
  const head = ['status', 'before', 'after', 'label', 'fail', 'review', 'accepted', 'noise_pct', 'flaky', 'top_finding'];
  const rows = pairs.map((p) => {
    const open = (p.findings || []).filter((f) => !f.accepted);
    const top = open.find((f) => f.severity === 'fail') || open.find((f) => f.severity === 'review');
    return [
      p.status,
      p.before,
      p.after,
      p.label || '',
      open.filter((f) => f.severity === 'fail').length,
      open.filter((f) => f.severity === 'review').length,
      (p.findings || []).filter((f) => f.accepted).length,
      p.noise ?? '',
      p.retried ? 'yes' : '',
      top ? top.summary : p.error || p.blocked || '',
    ].map(csvCell).join(',');
  });
  return [head.join(','), ...rows].join('\n') + '\n';
}

function pageKey(p) {
  try {
    return new URL(p.after).pathname;
  } catch (e) {
    return p.after;
  }
}

function acceptEntry(p, f) {
  const entry = { page: pageKey(p), check: f.check, reason: '' };
  if (Array.isArray(f.items) && f.items.length === 1) {
    const only = f.items[0];
    const m = typeof only === 'string' ? only : only.text || only.message || only.url || only.section;
    if (m) entry.match = String(m).slice(0, 80);
  }
  return entry;
}

function renderItems(items) {
  if (!items || !items.length) return '';
  const rows = items.map((it) => {
    if (typeof it === 'string') return `<li>${esc(it)}</li>`;
    const files = it.files;
    const kv = Object.entries(it).filter(([k]) => k !== 'files').map(([k, v]) => `<span class="k">${esc(k)}</span> ${esc(typeof v === 'object' ? JSON.stringify(v) : v)}`).join(' &middot; ');
    return `<li>${kv}${files ? ' ' + renderImages(files) : ''}</li>`;
  });
  return `<ul>${rows.join('')}</ul>`;
}

function renderImages(files, dir = '') {
  if (!files) return '';
  return `<div class="shots">${['before', 'after', 'diff'].filter((k) => files[k]).map((k) => `<figure><figcaption>${k}</figcaption><a href="${esc(dir + files[k])}"><img loading="lazy" src="${esc(dir + files[k])}"></a></figure>`).join('')}</div>`;
}

function renderFinding(p, f) {
  const entry = JSON.stringify(acceptEntry(p, f));
  const cls = f.accepted ? 'accepted' : f.severity;
  const files = f.files || (f.items && f.items.length === 1 && f.items[0].files) || null;
  const itemsHtml = renderItems((f.items || []).map((it) => (it && it.files ? { ...it, files: undefined } : it)));
  const imgs = files ? renderImages(files, `pairs/${p.id}/visual/`) : '';
  const itemImgs = (f.items || []).filter((it) => it && it.files && it.files !== files).map((it) => renderImages(it.files, `pairs/${p.id}/visual/`)).join('');
  const ba = f.before !== undefined || f.after !== undefined ? `<div class="ba"><span class="k">before</span> ${esc(f.before)} <span class="k">after</span> ${esc(f.after)}</div>` : '';
  const acc = f.accepted ? `<div class="reason">Accepted: ${esc(f.accepted.reason)}</div>` : f.acceptedItems ? `<div class="reason">${f.acceptedItems.length} item(s) accepted: ${esc(f.acceptedReason)}</div>` : '';
  return `<div class="finding ${cls}"><div class="fhead"><span class="sev">${esc(f.accepted ? 'accepted' : f.severity)}</span> <code>${esc(f.check)}</code> ${esc(f.summary)}${f.accepted ? '' : `<button data-accept='${esc(entry)}'>Accept</button>`}</div>${ba}${itemsHtml}${imgs}${itemImgs}${acc}</div>`;
}

function renderPair(p) {
  const findings = [...(p.findings || [])].sort((a, b) => Number(!!a.accepted) - Number(!!b.accepted) || ({ fail: 0, review: 1, info: 2 }[a.severity] - { fail: 0, review: 1, info: 2 }[b.severity]));
  const note = p.blocked ? `<div class="note">Blocked by bot protection: ${esc(p.blocked)}. Not a site defect; allowlist the runner or slow down, then rerun.</div>` : p.error ? `<div class="note">${esc(p.error)}</div>` : '';
  const flaky = p.retried ? '<div class="note">Needed a retry to load: treat as flaky.</div>' : '';
  const noise = p.noise != null ? ` <span class="k">noise</span> ${esc(p.noise)}%` : '';
  const rows = (p.visual && p.visual.rows) || [];
  const table = rows.length
    ? `<table><tr><th>viewport</th><th>section</th><th>diff %</th><th>height before/after</th><th>status</th></tr>${rows.map((r) => `<tr class="${esc(r.status)}"><td>${esc(r.viewport)}</td><td>${esc(r.section)}</td><td>${esc(r.pct ?? '')}</td><td>${esc(r.heightBefore ?? '')}/${esc(r.heightAfter ?? '')}</td><td>${esc(r.status)}</td></tr>`).join('')}</table>`
    : '';
  return `<details class="pair ${esc(p.status)}" data-status="${esc(p.status)}"><summary><span class="badge ${esc(p.status)}">${esc(p.status)}</span> ${esc(pageKey(p))}${noise}<span class="urls">${esc(p.before)} &rarr; ${esc(p.after)}</span></summary>${note}${flaky}${findings.map((f) => renderFinding(p, f)).join('') || '<p>No findings.</p>'}${table}</details>`;
}

function renderCompleteness(c) {
  if (!c) return '';
  const parts = [];
  if (c.coverage) {
    if (c.coverage.error) parts.push(`<p>${esc(c.coverage.error)}</p>`);
    else parts.push(`<p>Page-set coverage: <b>${esc(c.coverage.coveragePct)}%</b> of ${esc(c.coverage.total)} after-sitemap URLs were compared. ${c.coverage.afterOnly.length} new page(s) were not compared.</p>${renderItems(c.coverage.afterOnly.slice(0, 50))}`);
  }
  if (c.redirects) parts.push(`<p>Redirects checked: ${c.redirects.length}, wrong: ${c.redirects.filter((r) => r.status === 'fail').length}</p>`);
  for (const f of c.siteFindings || []) parts.push(`<div class="finding ${f.severity}"><span class="sev">${esc(f.severity)}</span> <code>${esc(f.check)}</code> ${esc(f.summary)}</div>`);
  for (const f of c.redirectFindings || []) parts.push(`<div class="finding ${f.severity}"><span class="sev">${esc(f.severity)}</span> <code>${esc(f.check)}</code> ${esc(f.summary)}${renderItems(f.items)}</div>`);
  return parts.length ? `<section><h2>Page set and site checks</h2>${parts.join('')}</section>` : '';
}

const CSS = `body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#222}h1{margin:0 0 4px}code{background:#f2f2f2;padding:0 4px;border-radius:3px}
.sum span{display:inline-block;margin:0 8px 8px 0;padding:4px 10px;border-radius:12px;color:#fff}
.badge{display:inline-block;min-width:60px;text-align:center;padding:1px 8px;border-radius:10px;color:#fff;font-size:12px}
.blocked,.badge.blocked{background:#6a3d9a}.error,.badge.error{background:#b2182b}.fail,.badge.fail{background:#d6272b}.flaky,.badge.flaky{background:#e08214}.unstable,.badge.unstable{background:#bf812d}.review,.badge.review{background:#d9a400}.pass,.badge.pass{background:#2c9c4a}.info{background:none}
details.pair{border:1px solid #ddd;border-radius:6px;margin:6px 0;padding:6px 10px}summary{cursor:pointer}.urls{display:block;color:#777;font-size:12px;margin-left:72px}
.finding{border-left:4px solid #ccc;margin:8px 0;padding:4px 10px;background:#fafafa}.finding.fail{border-color:#d6272b}.finding.review{border-color:#d9a400}.finding.accepted{opacity:.55;border-color:#2c9c4a}
.sev{font-weight:600;text-transform:uppercase;font-size:11px}.k{color:#888;font-size:12px}button{float:right;font-size:12px;cursor:pointer}
.shots{display:flex;gap:8px;flex-wrap:wrap}.shots figure{margin:4px 0}.shots img{max-width:320px;border:1px solid #ccc}.note{background:#fff4e5;padding:6px 10px;margin:6px 0}.reason{color:#2c9c4a}
table{border-collapse:collapse;margin-top:8px}td,th{border:1px solid #ddd;padding:2px 8px;font-size:12px}.filters button{float:none;margin-right:6px}`;

const SCRIPT = `
document.addEventListener('click',function(e){var b=e.target.closest('button[data-accept]');if(b){navigator.clipboard.writeText(b.getAttribute('data-accept')+',').then(function(){b.textContent='Copied';});}
var f=e.target.closest('button[data-filter]');if(f){var v=f.getAttribute('data-filter');document.querySelectorAll('details.pair').forEach(function(d){d.style.display=(v==='all'||d.dataset.status===v)?'':'none';});}});`;

function renderHtml(run) {
  const counts = summarize(run.pairs);
  const sorted = [...run.pairs].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
  const chips = STATUS_ORDER.filter((s) => counts[s]).map((s) => `<span class="${s}">${s}: ${counts[s]}</span>`).join('');
  const filters = `<div class="filters"><button data-filter="all">all</button>${STATUS_ORDER.filter((s) => counts[s]).map((s) => `<button data-filter="${s}">${s}</button>`).join('')}</div>`;
  const notTested = (run.notTested || []).length ? `<section><h2>Not tested</h2><ul>${run.notTested.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></section>` : '';
  const blockedWarn = (run.blockedHosts || []).length ? `<div class="note">Bot protection blocked requests to: ${run.blockedHosts.map(esc).join(', ')}.</div>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>page-compare report</title><style>${CSS}</style></head><body>
<h1>page-compare report</h1><div class="k">${esc(run.generatedAt)} &middot; ${run.pairs.length} page pair(s) &middot; viewports ${esc((run.viewports || []).join(', '))}</div>
<p>Accept copies an <code>accepted.json</code> entry to the clipboard; fill in <code>reason</code>, add it to the file and rerun with <code>--resume --accept accepted.json</code>.</p>
<div class="sum">${chips}</div>${blockedWarn}${renderCompleteness(run.completeness)}${filters}
${sorted.map(renderPair).join('\n')}${notTested}<script>${SCRIPT}</script></body></html>`;
}

function renderJson(run) {
  return JSON.stringify({ ...run, summary: summarize(run.pairs) }, null, 2);
}

module.exports = { STATUS_ORDER, summarize, exitCode, toCsv, renderHtml, renderJson, esc, acceptEntry };
