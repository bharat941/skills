'use strict';

// report.html for people: the same story and fix ids as report.md, in one self-contained file
// (inline CSS, no scripts, the first screenshots embedded) that can be emailed or printed.

const fs = require('fs');
const path = require('path');
const { numbersIn } = require('./content');
const { pathOf } = require('./actions');
const { progressLine } = require('./markdown');

const AREAS = [['content', 'Content parity', 'Content'], ['visual', 'Visual parity', 'Visual'], ['integration', 'Integration & SEO', 'Integration & SEO']];
const PRIORITY_TEXT = { P1: 'P1 Blocker', P2: 'P2 Major', P3: 'P3 Minor', expected: 'Expected' };
const META_ROWS = [['title', 'Title'], ['description', 'Description'], ['canonical', 'Canonical'], ['robots', 'Robots'], ['ogTitle', 'Social title'], ['h1', 'H1']];
const MAX_CARDS = 20;
const MAX_LINKS = 20;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const short = (s, max = 400) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Escaped text with the figures that differ from the other side wrapped in <mark>.
function markFigures(text, other) {
  const t = short(text);
  const left = numbersIn(other);
  const parts = [];
  let last = 0;
  const re = /(?<![\p{L}\d.,])\d+(?:[.,]\d+)?(?:%|x|w|\p{L}{2,}|\s(?:%|x|w|nm|mm|cm|kg|hz|khz|mhz|ghz|mb|gb|tb|mbps|gbps|mah|wh|kwh))?(?![\p{L}\d])/giu;
  for (const m of t.matchAll(re)) {
    const key = m[0].toLowerCase().replace(/\s+/g, '');
    const i = left.indexOf(key);
    if (i >= 0) {
      left.splice(i, 1);
      continue;
    }
    parts.push(esc(t.slice(last, m.index)), `<mark>${esc(m[0])}</mark>`);
    last = m.index + m[0].length;
  }
  parts.push(esc(t.slice(last)));
  return parts.join('');
}

function verdictText(v) {
  if (v.label === 'Nothing compared') return ['none', 'Nothing compared', 'No page pairs matched the input and filters.'];
  if (v.label === 'Not ready') return ['bad', `Not ready: ${plural(v.p1, 'blocker')}`, 'Fix the P1 items below before launch.'];
  if (v.label === 'Incomplete') return ['warn', `Incomplete: ${plural(v.notCompared, 'page')} could not be compared`, 'Rerun the pages that were blocked or failed to load.'];
  if (v.label === 'Ready after fixes') return ['warn', `Ready after fixes: ${plural(v.p2, 'major issue')}`, 'No blockers; fix the P2 items before launch.'];
  return ['good', 'No blocking differences found', 'Recheck the "expected on preview" items on the launch domain.'];
}

const CSS = `
*{box-sizing:border-box}body{margin:0;background:#f4f5f7;color:#1f2329;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:32px 24px 64px}h1{font-size:26px;margin:0 0 12px}h2{font-size:20px;margin:40px 0 12px;padding-bottom:6px;border-bottom:2px solid #e3e5e8}h3{font-size:15px;margin:20px 0 8px}
.urls{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0 0 8px}.urls b{color:#5b6370;font-weight:600}.urls a{color:#1d4ed8;word-break:break-all}.meta{color:#5b6370;font-size:13px}
.verdict{border-radius:10px;padding:18px 20px;margin:24px 0 16px;border:1px solid}.verdict strong{font-size:20px;display:block}.verdict.bad{background:#fdecec;border-color:#f3b4b4;color:#8a1c1c}.verdict.warn{background:#fff6e0;border-color:#f3d48a;color:#7a5200}.verdict.good{background:#e8f6ee;border-color:#a7dcbc;color:#14532d}.verdict.none{background:#eef0f3;border-color:#cfd4da}
.score{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.tile{background:#fff;border:1px solid #e3e5e8;border-radius:10px;padding:16px}.tile .n{font-size:32px;font-weight:700}.tile .l{color:#5b6370}.tile .c{margin-top:6px;font-size:13px}
.chip{display:inline-block;border-radius:999px;padding:1px 9px;font-size:12px;font-weight:600;white-space:nowrap}.P1{background:#fde2e2;color:#9b1c1c}.P2{background:#ffedd5;color:#9a3412}.P3{background:#fef9c3;color:#854d0e}.expected{background:#eef0f3;color:#475467}
.card{background:#fff;border:1px solid #e3e5e8;border-radius:10px;padding:14px 16px;margin:10px 0;break-inside:avoid}.card .top{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}.card .t{font-weight:600;font-size:15px}.card .id{margin-left:auto;font:12px ui-monospace,Menlo,monospace;color:#5b6370}
.card .sub{color:#5b6370;font-size:13px;margin-top:2px}.sxs{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}.sxs>div{background:#f8f9fb;border-radius:8px;padding:10px}.sxs .h{font-size:12px;color:#5b6370;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}
.shots{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:10px}.shots figure{margin:0}.shots .frame{max-height:520px;overflow:auto;border:1px solid #e3e5e8;border-radius:6px;background:#fff}.shots img{width:100%;display:block}.shots figcaption{font-size:12px;color:#5b6370}.na{border:1px dashed #cfd4da;border-radius:6px;padding:24px 8px;text-align:center;color:#8a93a0;font-size:12px}
mark{background:#fde68a;padding:0 2px;border-radius:3px}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e3e5e8;border-radius:10px;overflow:hidden;margin:8px 0}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef0f3;vertical-align:top}th{background:#f8f9fb;font-size:12px;color:#5b6370;text-transform:uppercase;letter-spacing:.04em}td{word-break:break-word}
details{background:#fff;border:1px solid #e3e5e8;border-radius:10px;padding:10px 16px;margin:10px 0}summary{cursor:pointer;font-weight:600}ul{margin:6px 0;padding-left:20px}.empty{color:#5b6370;font-style:italic}.foot{margin-top:40px;color:#5b6370;font-size:13px}code{font:12px ui-monospace,Menlo,monospace;background:#eef0f3;padding:1px 4px;border-radius:4px}
@media print{body{background:#fff}.wrap{padding:0}.shots .frame{max-height:none;overflow:visible}.card,table,details,.tile{break-inside:avoid}details{display:block}}
`;

/** report.html for a report model. Screenshots are read from outDir; up to embedMax of them and embedBytes in total are embedded, the rest linked. */
function renderLeadershipHtml(model, { outDir = '.', embedMax = 12, embedBytes = 5000000 } = {}) {
  let embedded = 0;
  let bytes = 0;
  const img = (rel, caption) => {
    if (!rel) return `<figure><div class="na">screenshot not available</div><figcaption>${esc(caption)}</figcaption></figure>`;
    const file = path.join(outDir, rel);
    if (!fs.existsSync(file)) return `<figure><div class="na">screenshot not available</div><figcaption>${esc(caption)}</figcaption></figure>`;
    const size = fs.statSync(file).size;
    const embed = embedded < embedMax && bytes + size <= embedBytes;
    if (embed) {
      embedded++;
      bytes += size;
    }
    const src = embed ? `data:image/png;base64,${fs.readFileSync(file).toString('base64')}` : encodeURI(rel);
    return `<figure><div class="frame"><img src="${esc(src)}" alt="${esc(caption)}"></div><figcaption>${esc(caption)}</figcaption></figure>`;
  };
  const progress = (m) => progressLine(m);
  const chip = (p) => `<span class="chip ${esc(p)}">${esc(PRIORITY_TEXT[p] || p)}</span>`;
  const pagesText = (f) => (f.siteWide ? 'site-wide' : f.pages.length === 1 ? pathOf({ after: f.pages[0].destination }) : `${f.pages.length} pages`);
  const sub = (f) => [f.section && `Section: ${f.section}`, f.component && f.component !== f.section && `Component: ${f.component}`, `Pages: ${pagesText(f)}`, `Fix type: ${f.fixType}`, `Owner: ${f.owner}`].filter(Boolean).map(esc).join(' · ');

  const card = (f) => {
    const facts = f.checks.includes('content.facts.changed');
    const values = f.area !== 'visual' && (f.expected || f.actual)
      ? `<div class="sxs"><div><div class="h">Source says</div>${facts ? markFigures(f.expected, f.actual) : esc(short(f.expected)) || '—'}</div><div><div class="h">Destination says</div>${facts ? markFigures(f.actual, f.expected) : esc(short(f.actual)) || '<span class="empty">not on the destination</span>'}</div></div>`
      : '';
    const shots = f.area === 'visual' && f.evidence ? `<div class="shots">${img(f.evidence.before, 'Source')}${img(f.evidence.after, 'Destination')}${img(f.evidence.diff, 'Differences')}</div>` : '';
    const status = f.status === 'new' ? ' <span class="chip expected">new</span>' : '';
    return `<div class="card"><div class="top">${chip(f.priority)}${status}<span class="t">${esc(f.title)}</span><span class="id">${esc(f.id)}</span></div><div class="sub">${sub(f)}</div>${values}${shots}</div>`;
  };

  const area = ([id, title]) => {
    const list = model.fixes.filter((f) => f.area === id && f.priority !== 'expected');
    const major = list.filter((f) => f.priority === 'P1' || f.priority === 'P2');
    const minor = list.filter((f) => f.priority === 'P3');
    const out = [`<h2>${esc(title)}</h2>`];
    if (!list.length) out.push('<p class="empty">No differences found.</p>');
    out.push(...major.slice(0, MAX_CARDS).map(card));
    if (major.length > MAX_CARDS) out.push(`<p class="empty">…and ${major.length - MAX_CARDS} more in fixes.json.</p>`);
    if (minor.length) out.push(`<details><summary>${plural(minor.length, 'minor difference')} (P3)</summary><ul>${minor.map((f) => `<li>${esc(f.title)} <code>${esc(f.id)}</code></li>`).join('')}</ul></details>`);
    if (id === 'content' && model.single && model.pair && model.pair.meta && model.pair.meta.before && model.pair.meta.after) {
      const m = model.pair.meta;
      out.push('<h3>Metadata</h3><table><tr><th>Property</th><th>Source</th><th>Destination</th><th>Match</th></tr>'
        + META_ROWS.map(([k, label]) => `<tr><td>${esc(label)}</td><td>${esc(m.before[k] || '—')}</td><td>${esc(m.after[k] || '—')}</td><td>${(m.before[k] || '') === (m.after[k] || '') ? '✅' : '❌'}</td></tr>`).join('') + '</table>');
    }
    if (id === 'integration') {
      const links = list.filter((f) => f.checks.includes('link.broken'));
      if (links.length) {
        out.push('<h3>Broken links</h3><table><tr><th>Status</th><th>Link</th><th>Link text</th><th>Pages</th></tr>'
          + links.slice(0, MAX_LINKS).map((f) => {
            const it = f.items[0] || {};
            return `<tr><td>${esc(it.status || '—')}</td><td>${esc(it.url)}</td><td>${esc(it.text || '—')}</td><td>${esc(pagesText(f))}</td></tr>`;
          }).join('') + '</table>');
      }
    }
    return out.join('\n');
  };

  const [cls, head, hint] = verdictText(model.verdict);
  const n = (a, p) => model.fixes.filter((f) => f.area === a && f.priority === p).length;
  const parity = { content: model.parity.content, visual: model.parity.visual, integration: null };
  const tiles = AREAS.map(([id, , label]) => `<div class="tile"><div class="n">${parity[id] === null || parity[id] === undefined ? '—' : `${esc(parity[id])}%`}</div><div class="l">${esc(label)}${id === 'integration' ? '' : ' parity'}</div><div class="c">${chip('P1')} ${n(id, 'P1')} &nbsp; ${chip('P2')} ${n(id, 'P2')} &nbsp; ${chip('P3')} ${n(id, 'P3')}</div></div>`).join('');
  const link = (u) => (/^https?:\/\//.test(u) ? `<a href="${esc(u)}">${esc(u)}</a>` : `<span>${esc(u)}</span>`);
  const expected = model.fixes.filter((f) => f.priority === 'expected');
  const body = [
    '<h1>Migration comparison</h1>',
    `<div class="urls"><b>Source</b>\n${link(model.source)}<b>Destination</b>\n${link(model.destination)}</div>`,
    `<div class="meta">${esc(String(model.generatedAt || '').slice(0, 10))} · ${plural(model.pages, 'page')}${(model.viewports || []).length ? ` · viewports ${esc(model.viewports.join(', '))}` : ''}</div>`,
    `<div class="verdict ${cls}"><strong>${esc(head)}</strong>${esc(hint)} ${model.verdict.p1} P1 · ${model.verdict.p2} P2 · ${model.verdict.p3} P3 · ${model.verdict.expected} to recheck at launch.</div>`,
    model.flaky ? `<p class="empty">${plural(model.flaky, 'page')} change between loads (rotating or random content); some differences may be noise.</p>` : '',
    model.hasBaseline ? `<p><strong>${esc(progress(model))}</strong></p>` : '',
    `<div class="score">${tiles}</div>`,
    ...AREAS.map(area),
    expected.length ? `<h2>Expected on preview — recheck at launch</h2><p>The destination is a preview or publish host, where these usually differ by design. Check them again on the launch domain.</p><ul>${expected.map((f) => `<li>${esc(f.title)} <code>${esc(f.id)}</code></li>`).join('')}</ul>` : '',
    model.hasBaseline ? `<h2>Fixed since last run</h2>${model.fixed.length ? `<ul>${model.fixed.map((f) => `<li>${esc(f.title || f.id)} <code>${esc(f.id)}</code></li>`).join('')}</ul>` : '<p class="empty">Nothing from the last run is fixed yet.</p>'}` : '',
    '<h2>For agents</h2><p>Work from <code>fixes.json</code>: one entry per fix with the same id as above, its section and component, the source and destination values and the fix type. Verify a fix by running the comparison again with <code>--baseline &lt;this folder&gt;</code>. To accept a difference as intended, open <code>review.html</code>.</p>',
    (model.notTested || []).length ? `<p class="foot">Not tested: ${model.notTested.map(esc).join('; ')}.</p>` : '',
  ].filter(Boolean);
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Migration comparison: ${esc(model.destination)}</title><style>${CSS}</style></head>\n<body><div class="wrap">\n${body.join('\n')}\n</div></body></html>\n`;
}

module.exports = { renderLeadershipHtml };
