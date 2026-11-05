'use strict';

const { STATUS_ORDER } = require('./report');

const SEVERITY_ORDER = { fail: 0, review: 1, info: 2 };
const SEVERITY_LABEL = { fail: '❌ Fail', review: '⚠️ Review', info: 'ℹ️ Info' };
const RESULT_LABEL = { fail: '❌ Fail', review: '⚠️ Review', pass: '✅ Pass' };

const AREAS = [
  { id: 'content', title: 'Content parity', covers: 'Text, headings, meta and SEO tags, images, links, buttons and forms' },
  { id: 'visual', title: 'Visual parity', covers: 'Section-by-section screenshots at each viewport' },
  { id: 'integration', title: 'Integration', covers: 'Console and network errors, analytics, broken links and downloads, redirects, robots.txt and sitemap' },
];

const INTEGRATION = /^(console\.|js\.|request\.|resource\.|a11y\.|analytics\.|http\.|image\.broken|link\.broken|link\.unchecked|download\.|redirect\.|site\.)/;
const MAX_ROWS = 10;
const MAX_CELL = 140;
const MAX_DETAIL_PAGES = 25;

/** Which of the three report areas a check id belongs to. Unknown checks count as content. */
function areaOf(check) {
  if (check.startsWith('visual.')) return 'visual';
  return INTEGRATION.test(check) ? 'integration' : 'content';
}

function cell(v, max = MAX_CELL) {
  let s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s.replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;')).replace(/\|/g, '\\|');
}

function label(key) {
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function pathOf(p) {
  try {
    return new URL(p.after).pathname || '/';
  } catch (e) {
    return p.after;
  }
}

function table(headers, rows) {
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

function itemsTable(items, extra = 0) {
  if (!Array.isArray(items) || !items.length) return '';
  const shown = items.slice(0, MAX_ROWS);
  const more = items.length - shown.length + (extra || 0);
  const tail = more > 0 ? `\n\n_…and ${more} more (see report.json)._` : '';
  if (items.every((it) => typeof it !== 'object' || it === null)) return shown.map((it) => `- ${cell(it)}`).join('\n') + tail;
  const keys = [];
  for (const it of items) for (const k of Object.keys(it || {})) if (k !== 'files' && !keys.includes(k)) keys.push(k);
  const cols = keys.slice(0, 6);
  const value = (v) => (typeof v === 'boolean' ? (v ? 'yes' : 'no') : cell(v));
  return table(cols.map(label), shown.map((it) => cols.map((k) => value(it && it[k])))) + tail;
}

function imageLinks(files, pairId) {
  return ['before', 'after', 'diff'].filter((k) => files[k]).map((k) => `[${k}](${encodeURI(`pairs/${pairId}/visual/${files[k]}`)})`).join(' · ');
}

function findingBlock(f, pairId) {
  const lines = [`#### ${SEVERITY_LABEL[f.severity] || f.severity}: ${cell(f.summary, 220)}`, '', `\`${f.check}\``];
  if (f.before !== undefined || f.after !== undefined) lines.push('', `- Before: ${cell(f.before)}`, `- After: ${cell(f.after)}`);
  const items = Array.isArray(f.items) ? f.items : [];
  const withImages = items.filter((it) => it && it.files);
  if (withImages.length) {
    const rows = withImages.slice(0, MAX_ROWS).map((it) => `- ${cell(it.section)} at ${cell(it.viewport)}px${it.pct != null ? `, ${cell(it.pct)}% of pixels differ` : ''}: ${imageLinks(it.files, pairId)}`);
    lines.push('', ...rows);
  } else if (items.length) {
    lines.push('', itemsTable(items, f.truncated));
  }
  return lines.join('\n');
}

/** Pairs "missing" and "added" sections that share a name and viewport: the section exists on both pages but its content differs. */
function sectionChanges(findings) {
  const take = (check) => findings.filter((f) => f.check === check && !f.accepted)
    .flatMap((f) => (Array.isArray(f.items) ? f.items : []).map((it) => ({ ...it, severity: f.severity })));
  const missing = take('visual.section.missing');
  const added = take('visual.section.added');
  const used = new Set();
  const changed = new Map();
  const onlyBefore = new Map();
  const onlyAfter = new Map();
  const push = (map, key, entry, viewport) => {
    const e = map.get(key) || { ...entry, viewports: [] };
    e.viewports.push(viewport);
    map.set(key, e);
  };
  for (const m of missing) {
    const i = added.findIndex((a, n) => !used.has(n) && a.section === m.section && a.viewport === m.viewport);
    if (i >= 0) {
      used.add(i);
      push(changed, `${m.section}\u0000${m.text}\u0000${added[i].text}`, { section: m.section, before: m.text, after: added[i].text, severity: m.severity }, m.viewport);
    } else {
      push(onlyBefore, `${m.section}\u0000${m.text}`, { section: m.section, text: m.text, severity: m.severity }, m.viewport);
    }
  }
  added.forEach((a, n) => {
    if (!used.has(n)) push(onlyAfter, `${a.section}\u0000${a.text}`, { section: a.section, text: a.text, severity: a.severity }, a.viewport);
  });
  return { changed: [...changed.values()], onlyBefore: [...onlyBefore.values()], onlyAfter: [...onlyAfter.values()] };
}

function visualTable(rows) {
  const by = new Map();
  for (const r of rows) {
    const s = by.get(r.viewport) || { identical: 0, different: 0, missing: 0, added: 0 };
    if (r.status === 'missing') s.missing++;
    else if (r.status === 'added') s.added++;
    else if (r.status === 'pass') s.identical++;
    else s.different++;
    by.set(r.viewport, s);
  }
  const viewports = [...by.keys()].sort((a, b) => Number(b) - Number(a));
  return table(['Viewport', 'Sections compared', 'Identical', 'Different', 'Only on before', 'Only on after'],
    viewports.map((v) => {
      const s = by.get(v);
      return [`${cell(v)}px`, s.identical + s.different, s.identical, s.different, s.missing, s.added];
    }));
}

function visualSections(p, findings) {
  const out = [];
  const rows = (p.visual && p.visual.rows) || [];
  if (rows.length) out.push(visualTable(rows));
  const c = sectionChanges(findings);
  const where = (e) => e.viewports.map((v) => `${cell(v)}px`).join(', ');
  const sev = (e) => (e.severity === 'fail' ? '❌' : '⚠️');
  if (c.changed.length) {
    out.push('#### Section present on both pages, content differs', table(['', 'Section', 'Viewports', 'Before page says', 'After page says'],
      c.changed.map((e) => [sev(e), cell(e.section), where(e), cell(e.before), cell(e.after)])));
  }
  if (c.onlyBefore.length) {
    out.push('#### Section only on the before page', table(['', 'Section', 'Viewports', 'Text'], c.onlyBefore.map((e) => [sev(e), cell(e.section), where(e), cell(e.text)])));
  }
  if (c.onlyAfter.length) {
    out.push('#### Section only on the after page', table(['', 'Section', 'Viewports', 'Text'], c.onlyAfter.map((e) => ['ℹ️', cell(e.section), where(e), cell(e.text)])));
  }
  const rest = findings.filter((f) => !f.accepted && f.check !== 'visual.section.missing' && f.check !== 'visual.section.added');
  out.push(...rest.map((f) => findingBlock(f, p.id)));
  return out;
}

function visualProblems(p, withPage) {
  const findings = (p.findings || []).filter((f) => f.check.startsWith('visual.') && !f.accepted);
  const c = sectionChanges(findings);
  const where = (e) => e.viewports.map((v) => `${v}px`).join(', ');
  const prefix = withPage ? `${pathOf(p)}: ` : '';
  const lines = [
    ...c.changed.filter((e) => e.severity === 'fail').map((e) => `Section ${e.section} is on both pages but its content differs (${where(e)})`),
    ...c.onlyBefore.filter((e) => e.severity === 'fail').map((e) => `Section ${e.section} is only on the before page (${where(e)})`),
    ...findings.filter((f) => f.severity === 'fail' && f.check !== 'visual.section.missing' && f.check !== 'visual.section.added').map((f) => f.summary),
  ];
  return lines.slice(0, 4).map((l) => `- **Visual parity:** ${cell(prefix + l, 200)}`);
}

function counts(findings) {
  const open = findings.filter((f) => !f.accepted);
  return { fail: open.filter((f) => f.severity === 'fail').length, review: open.filter((f) => f.severity === 'review').length };
}

function resultOf(findings) {
  const c = counts(findings);
  return c.fail ? 'fail' : c.review ? 'review' : 'pass';
}

function countsText(findings) {
  const c = counts(findings);
  return c.fail || c.review ? [c.fail && `${c.fail} fail`, c.review && `${c.review} review`].filter(Boolean).join(', ') : 'none';
}

function sortFindings(list) {
  return [...list].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3));
}

function groupByArea(findings) {
  const by = { content: [], visual: [], integration: [] };
  for (const f of findings) by[areaOf(f.check)].push(f);
  return by;
}

function acceptedLines(findings) {
  const done = findings.filter((f) => f.accepted);
  return done.length ? ['**Accepted differences**', '', ...done.map((f) => `- ${cell(f.summary, 200)}: ${cell(f.accepted.reason)}`)] : [];
}

function pairSection(p) {
  const head = [`## Page: ${cell(pathOf(p))}`, '', `- **Before:** ${cell(p.before, 300)}`, `- **After:** ${cell(p.after, 300)}`];
  const reliability = [p.noise != null && `noise baseline ${cell(p.noise)}%`, p.volatilePct != null && `${cell(p.volatilePct)}% of the page text changes between loads`, p.retried && 'needed a retry (flaky)', p.unstable && 'before page unstable']
    .filter(Boolean).join(' · ');
  if (reliability) head.push(`- **Reliability:** ${reliability}`);
  if (p.blocked || p.error) return [...head, '', `> This page could not be compared: ${cell(p.blocked || p.error, 300)}`].join('\n');
  const by = groupByArea(sortFindings(p.findings || []));
  const parts = [head.join('\n')];
  for (const area of AREAS) {
    const list = by[area.id];
    const detail = area.id === 'visual' ? visualSections(p, list) : list.filter((f) => !f.accepted).map((f) => findingBlock(f, p.id));
    const body = [...detail, ...acceptedLines(list)];
    parts.push(`### ${area.title}: ${RESULT_LABEL[resultOf(list)]}`, body.length ? body.join('\n\n') : '_No differences found by these checks._');
  }
  return parts.join('\n\n');
}

function siteSection(c) {
  if (!c) return '';
  const lines = [];
  if (c.coverage && !c.coverage.error) lines.push(`Page-set coverage: **${cell(c.coverage.coveragePct)}%** of ${cell(c.coverage.total)} after-sitemap URLs were compared; ${(c.coverage.afterOnly || []).length} new page(s) were not.`);
  if (c.coverage && c.coverage.error) lines.push(cell(c.coverage.error, 300));
  if (c.redirects) lines.push(`Redirects checked: ${c.redirects.length}, wrong: ${c.redirects.filter((r) => r.status === 'fail').length}.`);
  const findings = sortFindings([...(c.siteFindings || []), ...(c.redirectFindings || [])]);
  if (!lines.length && !findings.length) return '';
  return ['## Site-wide checks (counted under Integration)', ...lines, ...findings.map((f) => findingBlock(f))].join('\n\n');
}

function pagesOverview(pairs) {
  const rows = pairs.map((p) => {
    const by = groupByArea(p.findings || []);
    const cellFor = (id) => (by[id].length && resultOf(by[id]) !== 'pass' ? countsText(by[id]) : '✅');
    return [cell(pathOf(p)), p.status, cellFor('content'), cellFor('visual'), cellFor('integration')];
  });
  return ['## All pages', table(['Page', 'Status', 'Content', 'Visual', 'Integration'], rows.slice(0, 200))].join('\n\n');
}

/**
 * Markdown version of the report, organised as content parity, visual parity and integration.
 * Takes the same run object as renderHtml/renderJson.
 */
function toMarkdown(run) {
  const pairs = [...(run.pairs || [])].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
  const site = run.completeness || {};
  const siteFindings = [...(site.siteFindings || []), ...(site.redirectFindings || [])];
  const all = { content: [], visual: [], integration: [...siteFindings] };
  for (const p of pairs) {
    const by = groupByArea(p.findings || []);
    for (const id of Object.keys(all)) all[id].push(...by[id]);
  }
  const overall = resultOf([...all.content, ...all.visual, ...all.integration]);
  const failed = pairs.some((p) => ['fail', 'error', 'blocked'].includes(p.status));
  const verdict = failed && overall === 'pass' ? 'fail' : overall;
  const out = [
    '# Page comparison report',
    [`- **Generated:** ${cell(run.generatedAt)}`, `- **Pages compared:** ${pairs.length}`, `- **Viewports:** ${(run.viewports || []).map((v) => `${v}px`).join(', ')}`].join('\n'),
    `**Overall: ${RESULT_LABEL[verdict]}**. ${countsText([...all.content, ...all.visual, ...all.integration])}.`,
    '## Summary',
    table(['Area', 'Result', 'Fail', 'Review', 'What it covers'], AREAS.map((a) => {
      const c = counts(all[a.id]);
      return [a.title, RESULT_LABEL[resultOf(all[a.id])], c.fail, c.review, a.covers];
    })),
  ];
  const key = AREAS.flatMap((a) => (a.id === 'visual'
    ? pairs.flatMap((p) => visualProblems(p, pairs.length > 1))
    : sortFindings(all[a.id].filter((f) => !f.accepted && f.severity === 'fail')).slice(0, 4).map((f) => `- **${a.title}:** ${cell(f.summary, 200)}`)));
  if (key.length) out.push('**Main problems**', key.join('\n'));
  const siteMd = siteSection(run.completeness);
  if (siteMd) out.push(siteMd);
  if (pairs.length > 1) out.push(pagesOverview(pairs));
  const detailed = pairs.filter((p) => p.status !== 'pass').slice(0, MAX_DETAIL_PAGES);
  out.push(...detailed.map(pairSection));
  if (pairs.filter((p) => p.status !== 'pass').length > detailed.length) out.push(`_Detail is shown for the ${MAX_DETAIL_PAGES} worst pages. See report.json for the rest._`);
  out.push('## How to read this', [
    '- **Fail**: most likely needs a fix. **Review**: needs a human look and may be intended. **Info**: for awareness.',
    '- A pass means no differences were found by these checks, not proof that the page is correct.',
  ].join('\n'));
  if ((run.notTested || []).length) out.push('## Not tested', run.notTested.map((n) => `- ${cell(n, 300)}`).join('\n'));
  return `${out.join('\n\n')}\n`;
}

module.exports = { toMarkdown, areaOf };
