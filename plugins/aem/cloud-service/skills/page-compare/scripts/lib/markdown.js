'use strict';

const fs = require('fs');
const path = require('path');
const { STATUS_ORDER } = require('./report');
const { csvCell, isPreviewHost, hostOf } = require('./util');
const { priorityOf } = require('./rules');
const { NUMBER, numbersIn } = require('./content');
const { areaOf, pathOf, subjectOf, normalizeSubject, issueTitle, buildActions, verdictOf, PRIORITY_ORDER } = require('./actions');

const SEVERITY_ORDER = { fail: 0, review: 1, info: 2 };
const SEVERITY_LABEL = { fail: '❌ Fail', review: '⚠️ Review', info: 'ℹ️ Info' };
const RESULT_LABEL = { fail: '❌ Fail', review: '⚠️ Review', pass: '✅ Pass' };

const AREAS = [
  { id: 'content', title: 'Content parity', covers: 'Text, headings, meta and SEO tags, images, links, buttons and forms' },
  { id: 'visual', title: 'Visual parity', covers: 'Section-by-section screenshots at each viewport' },
  { id: 'integration', title: 'Integration', covers: 'Console and network errors, analytics, broken links and downloads, redirects, robots.txt and sitemap' },
];

const MAX_ROWS = 10;
const MAX_CELL = 140;
const MAX_TOP = 10;
const MAX_ISSUE_ROWS = 200;
const MAX_ISSUE_PAGES = 20;

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

function imageLinks(files, pairId, prefix = '') {
  return ['before', 'after', 'diff'].filter((k) => files[k]).map((k) => `[${k}](${encodeURI(`${prefix}pairs/${pairId}/visual/${files[k]}`)})`).join(' · ');
}

function findingBlock(f, pairId, prefix = '') {
  const lines = [`#### ${SEVERITY_LABEL[f.severity] || f.severity}: ${cell(f.summary, 220)}`, '', `\`${f.check}\``];
  if (f.before !== undefined || f.after !== undefined) lines.push('', `- Before: ${cell(f.before)}`, `- After: ${cell(f.after)}`);
  const items = Array.isArray(f.items) ? f.items : [];
  const withImages = items.filter((it) => it && it.files);
  if (withImages.length) {
    const rows = withImages.slice(0, MAX_ROWS).map((it) => `- ${cell(it.section)} at ${cell(it.viewport)}px${it.pct != null ? `, ${cell(it.pct)}% of pixels differ` : ''}: ${imageLinks(it.files, pairId, prefix)}`);
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

function visualSections(p, findings, prefix = '') {
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
  out.push(...rest.map((f) => findingBlock(f, p.id, prefix)));
  return out;
}


function counts(findings) {
  const open = findings.filter((f) => !f.accepted);
  return { fail: open.filter((f) => f.severity === 'fail').length, review: open.filter((f) => f.severity === 'review').length };
}

function resultOf(findings) {
  const c = counts(findings);
  return c.fail ? 'fail' : c.review ? 'review' : 'pass';
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

function pairSection(p, prefix = '') {
  const head = [`## Page: ${cell(pathOf(p))}`, '', `- **Before:** ${cell(p.before, 300)}`, `- **After:** ${cell(p.after, 300)}`];
  const reliability = [p.noise != null && `noise baseline ${cell(p.noise)}%`, p.volatilePct != null && `${cell(p.volatilePct)}% of the page text changes between loads`, p.retried && 'needed a retry (flaky)', p.unstable && 'before page unstable']
    .filter(Boolean).join(' · ');
  if (reliability) head.push(`- **Reliability:** ${reliability}`);
  if (p.blocked || p.error) return [...head, '', `> This page could not be compared: ${cell(p.blocked || p.error, 300)}`].join('\n');
  if (p.flaky && p.volatilePct) head.push('', `> ⚠️ ${cell(p.volatilePct)}% of this page's text changes between loads (rotating or random content), so some findings may be noise.`);
  const by = groupByArea(sortFindings(p.findings || []));
  const parts = [head.join('\n')];
  for (const area of AREAS) {
    const list = by[area.id];
    const detail = area.id === 'visual' ? visualSections(p, list, prefix) : list.filter((f) => !f.accepted).map((f) => findingBlock(f, p.id, prefix));
    const body = [...detail, ...acceptedLines(list)];
    parts.push(`### ${area.title}: ${RESULT_LABEL[resultOf(list)]}`, body.length ? body.join('\n\n') : '_No differences found by these checks._');
  }
  return parts.join('\n\n');
}

function siteFindingsOf(run) {
  const c = run.completeness || {};
  return sortFindings([...(c.siteFindings || []), ...(c.redirectFindings || [])]);
}

function siteSection(run) {
  const c = run.completeness || {};
  const lines = [];
  if (c.coverage && !c.coverage.error) lines.push(`Page-set coverage: **${cell(c.coverage.coveragePct)}%** of ${cell(c.coverage.total)} after-sitemap URLs were compared; ${(c.coverage.afterOnly || []).length} new page(s) were not.`);
  if (c.coverage && c.coverage.error) lines.push(cell(c.coverage.error, 300));
  if (c.redirects) lines.push(`Redirects checked: ${c.redirects.length}, wrong: ${c.redirects.filter((r) => r.status === 'fail').length}.`);
  const findings = siteFindingsOf(run);
  if (!lines.length && !findings.length) return '';
  return ['## Site-wide checks (counted under Integration)', ...lines, ...findings.map((f) => findingBlock(f))].join('\n\n');
}

// ---------- issues across pages ----------

/** Groups open fail/review findings from all pages into item-level issues with the pages they affect and their priority. */
function groupIssues(pairs, run) {
  const map = new Map();
  const add = (f, issue, page, previewHost) => {
    const key = `${f.check}\u0000${issue}`;
    const priority = priorityOf(f, { previewHost });
    const e = map.get(key) || { priority, action: issueTitle(f), severity: f.severity, area: areaOf(f.check), check: f.check, issue, pages: [], siteWide: page === null };
    if (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[e.severity]) e.severity = f.severity;
    if (PRIORITY_ORDER.indexOf(priority) < PRIORITY_ORDER.indexOf(e.priority)) e.priority = priority;
    if (page !== null && e.pages[e.pages.length - 1] !== page) e.pages.push(page);
    map.set(key, e);
  };
  for (const p of pairs) {
    const page = pathOf(p);
    const previewHost = isPreviewHost(hostOf(p.after));
    for (const f of p.findings || []) {
      if (f.accepted || !['fail', 'review'].includes(f.severity)) continue;
      const items = Array.isArray(f.items) ? f.items : [];
      if (items.length) for (const it of items) add(f, `${issueTitle(f)}: ${normalizeSubject(subjectOf(it))}`, page, previewHost);
      else add(f, normalizeSubject(issueTitle(f)), page, previewHost);
    }
  }
  const sitePreview = pairs.length ? isPreviewHost(hostOf(pairs[0].after)) : false;
  for (const f of siteFindingsOf(run)) if (!f.accepted && ['fail', 'review'].includes(f.severity)) add(f, f.summary, null, sitePreview);
  return [...map.values()].sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority)
    || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || Number(b.siteWide) - Number(a.siteWide) || b.pages.length - a.pages.length || a.issue.localeCompare(b.issue));
}

const AREA_TITLE = Object.fromEntries(AREAS.map((a) => [a.id, a.title]));
const PRIORITY_LABEL = { P1: '🔴 P1', P2: '🟠 P2', P3: '🟡 P3', expected: '⚪ Expected' };

function issueRow(e) {
  return [PRIORITY_LABEL[e.priority] || '', SEVERITY_LABEL[e.severity], AREA_TITLE[e.area], cell(e.issue, 180), e.siteWide ? 'site-wide' : e.pages.length, e.siteWide ? '' : cell(e.pages[0])];
}

function toCsvText(header, rows) {
  return `${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n')}\n`;
}

function issuesCsv(issues) {
  return toCsvText(['priority', 'action', 'severity', 'area', 'check', 'issue', 'pages_affected', 'example_page', 'pages'],
    issues.map((e) => [e.priority, e.action, e.severity, AREA_TITLE[e.area], e.check, e.issue, e.siteWide ? 'site-wide' : e.pages.length, e.siteWide ? '' : e.pages[0], e.pages.slice(0, MAX_ISSUE_PAGES).join(' ') + (e.pages.length > MAX_ISSUE_PAGES ? ` (+${e.pages.length - MAX_ISSUE_PAGES} more)` : '')]));
}

function issuesMd(issues, run) {
  const shown = issues.slice(0, MAX_ISSUE_ROWS);
  const out = ['# Issues across all pages', `Every item behind the action items in report.md: ${issues.length} row(s) on ${(run.pairs || []).length} page(s), highest priority first. The same item on many pages is listed once, with how many pages it affects. Info-level findings are left out.`];
  out.push(shown.length ? table(['Priority', 'Severity', 'Area', 'Issue', 'Pages affected', 'Example page'], shown.map(issueRow)) : '_No open issues._');
  if (issues.length > shown.length) out.push(`_…and ${issues.length - shown.length} more in issues.csv (every issue, with up to ${MAX_ISSUE_PAGES} affected pages each)._`);
  return `${out.join('\n\n')}\n`;
}

// ---------- pages ----------

function pageAreas(p) {
  const by = groupByArea(p.findings || []);
  return Object.fromEntries(AREAS.map((a) => [a.id, p.blocked || p.error ? 'not compared' : resultOf(by[a.id])]));
}

function topIssueOf(p) {
  const open = sortFindings((p.findings || []).filter((f) => !f.accepted && ['fail', 'review'].includes(f.severity)));
  return open.length ? open[0].summary : p.blocked || p.error || '';
}

function detailPath(p) {
  return `pages/${p.id}.md`;
}

function pagesCsv(pairs) {
  return toCsvText(['page', 'status', 'flaky', 'content', 'visual', 'integration', 'fail', 'review', 'p1', 'p2', 'p3', 'top_issue', 'detail', 'before', 'after'],
    pairs.map((p) => {
      const a = pageAreas(p);
      const c = counts(p.findings || []);
      const previewHost = isPreviewHost(hostOf(p.after));
      const pr = (want) => (p.findings || []).filter((f) => priorityOf(f, { previewHost }) === want).length;
      return [pathOf(p), p.status, p.flaky || p.retried ? 'yes' : '', a.content, a.visual, a.integration, c.fail, c.review, pr('P1'), pr('P2'), pr('P3'), topIssueOf(p), p.status === 'pass' ? '' : detailPath(p), p.before, p.after];
    }));
}

function areaPageTable(pairs, siteIssues) {
  const compared = pairs.filter((p) => !p.blocked && !p.error);
  return table(['Area', 'Result', 'Pages failing', 'Pages to review', 'Pages passing', 'Site-wide issues', 'What it covers'], AREAS.map((a) => {
    const results = compared.map((p) => pageAreas(p)[a.id]);
    const n = (r) => results.filter((x) => x === r).length;
    const site = siteIssues.filter((e) => e.area === a.id);
    const siteResult = site.some((e) => e.severity === 'fail') ? 'fail' : site.length ? 'review' : 'pass';
    const result = n('fail') || siteResult === 'fail' ? 'fail' : n('review') || siteResult === 'review' ? 'review' : 'pass';
    return [a.title, RESULT_LABEL[result], n('fail'), n('review'), n('pass'), a.id === 'integration' ? site.length : '—', a.covers];
  }));
}

function statusLine(pairs) {
  const c = Object.fromEntries(STATUS_ORDER.map((s) => [s, pairs.filter((p) => p.status === s).length]));
  return STATUS_ORDER.filter((s) => c[s]).map((s) => `${c[s]} ${s}`).join(' · ');
}

function worstPages(pairs, single) {
  const bad = pairs.filter((p) => p.status !== 'pass')
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || counts(b.findings || []).fail - counts(a.findings || []).fail);
  if (!bad.length) return '';
  const shown = bad.slice(0, MAX_TOP);
  const rows = shown.map((p) => {
    const c = counts(p.findings || []);
    return [cell(pathOf(p)), p.status + (p.flaky ? ' (flaky)' : ''), c.fail, c.review, cell(topIssueOf(p), 120), single ? 'below' : `[details](${detailPath(p)})`];
  });
  const out = ['## Pages that need attention', table(['Page', 'Status', 'Fail', 'Review', 'Top issue', 'Detail'], rows)];
  if (bad.length > shown.length) out.push(`_…and ${bad.length - shown.length} more in pages.csv (one row per page, filterable)._`);
  return out.join('\n\n');
}

const MAX_ACTIONS = 15;
const MAX_DIFFS = 10;

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function verdictLine(v) {
  const head = v.label === 'Not ready' ? `**Not ready: ${plural(v.p1, 'blocker')}**`
    : v.label === 'Incomplete' ? `**Incomplete: ${plural(v.notCompared, 'page')} could not be compared**`
      : v.label === 'Ready after fixes' ? `**Ready after fixes: ${plural(v.p2, 'major issue')}**`
        : '**No blocking differences found**';
  return `${head}. ${v.p1} P1 · ${v.p2} P2 · ${v.p3} P3 action item(s) · ${v.expected} to recheck at launch.`;
}

function howMany(a) {
  if (a.siteWide) return 'site-wide';
  if (a.pages.length > 1) return a.count === a.pages.length ? `on ${a.pages.length} pages` : `${a.count} on ${a.pages.length} pages`;
  return String(a.count);
}

function exampleCell(a, multiPage) {
  if (a.siteWide) return 'site-wide';
  const ex = a.example || {};
  let text = ex.before !== undefined || ex.after !== undefined ? `${cell(ex.before, 70)} → ${cell(ex.after, 70)}` : cell(ex.detail || '', 90);
  if (multiPage && ex.page) text = `${cell(ex.page, 50)}: ${text}`;
  if (ex.files && ex.pairId) text += ` (${imageLinks(ex.files, ex.pairId)})`;
  return text;
}

function actionTable(actions, multiPage) {
  const rows = actions.filter((a) => a.priority !== 'expected');
  if (!rows.length) return '_No action items._';
  const shown = rows.slice(0, MAX_ACTIONS);
  const out = [table(['#', 'Priority', 'Area', 'Problem', 'How many', 'Example', 'Likely owner'],
    shown.map((a, i) => [i + 1, PRIORITY_LABEL[a.priority], AREA_TITLE[a.area], cell(a.title, 120), howMany(a), exampleCell(a, multiPage), a.owner]))];
  if (rows.length > shown.length) out.push(`_…and ${rows.length - shown.length} more action item(s) in issues.csv._`);
  return out.join('\n\n');
}

// Bold the figures in `text` that the other side does not have.
function boldFigures(text, own, other) {
  const left = [...other];
  const differ = own.filter((n) => {
    const i = left.indexOf(n);
    if (i >= 0) left.splice(i, 1);
    return i < 0;
  });
  if (!differ.length) return cell(text, 200);
  return cell(text, 200).replace(new RegExp(NUMBER.source, NUMBER.flags), (m) => {
    const key = m.toLowerCase().replace(/\s+/g, '');
    const i = differ.indexOf(key);
    if (i < 0) return m;
    differ.splice(i, 1);
    return `**${m}**`;
  });
}

const DIFF_CHECKS = ['content.facts.changed', 'content.text.changed', 'content.text.rewritten'];

function contentDiffs(pairs) {
  const rows = [];
  const seen = new Set();
  for (const check of DIFF_CHECKS) {
    for (const p of pairs) {
      for (const f of p.findings || []) {
        if (f.check !== check || f.accepted) continue;
        for (const it of Array.isArray(f.items) ? f.items : []) {
          const key = `${it.before}\u0000${it.after}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const nb = it.numbersBefore || numbersIn(it.before);
          const na = it.numbersAfter || numbersIn(it.after);
          rows.push({ facts: check === 'content.facts.changed', page: pathOf(p), before: boldFigures(it.before, nb, na), after: boldFigures(it.after, na, nb) });
        }
      }
    }
  }
  if (!rows.length) return '';
  const multi = new Set(rows.map((r) => r.page)).size > 1;
  const shown = rows.slice(0, MAX_DIFFS);
  const head = multi ? ['', 'Page', 'Before says', 'After says'] : ['', 'Before says', 'After says'];
  const out = ['## Content differences', 'Text that says something different on the after page. 🔴 marks changed figures (speeds, sizes, percentages), shown in bold.',
    table(head, shown.map((r) => (multi ? [r.facts ? '🔴' : '', cell(r.page, 50), r.before, r.after] : [r.facts ? '🔴' : '', r.before, r.after])))];
  if (rows.length > shown.length) out.push(`_…and ${rows.length - shown.length} more in issues.csv and pages/._`);
  return out.join('\n\n');
}

function expectedSection(actions) {
  const list = actions.filter((a) => a.priority === 'expected');
  if (!list.length) return '';
  const line = (a) => {
    const ex = a.example || {};
    const ba = ex.before !== undefined || ex.after !== undefined ? `: ${cell(ex.before, 80)} → ${cell(ex.after, 80)}` : '';
    return `- ${cell(a.title, 160)}${ba}${a.siteWide || a.pages.length <= 1 ? '' : ` (on ${a.pages.length} pages)`}`;
  };
  return ['## Expected on preview — recheck at launch', 'The after site is a preview or publish host, where these usually differ by design. Check them again on the launch domain.', list.map(line).join('\n')].join('\n\n');
}

function summaryMd(run, pairs, issues) {
  const single = pairs.length === 1;
  const siteIssues = issues.filter((e) => e.siteWide);
  const actions = buildActions(run);
  const notCompared = pairs.filter((p) => p.blocked || p.error).length;
  const verdict = verdictOf(actions, { notCompared });
  const out = [
    '# Page comparison report',
    [`- **Generated:** ${cell(run.generatedAt)}`, `- **Pages compared:** ${pairs.length} (${statusLine(pairs)})`, `- **Viewports:** ${(run.viewports || []).map((v) => `${v}px`).join(', ')}`].join('\n'),
    verdictLine(verdict),
  ];
  if (notCompared) out.push(`> ⚠️ ${plural(notCompared, 'page')} could not be compared (blocked or failed to load); see "Pages that need attention".`);
  out.push('## Action items', 'One row per problem, highest priority first. 🔴 P1 must be fixed before launch (content loss and broken pages come first), 🟠 P2 should be, 🟡 P3 is polish.', actionTable(actions, !single));
  const diffs = contentDiffs(pairs);
  if (diffs) out.push(diffs);
  const expected = expectedSection(actions);
  if (expected) out.push(expected);
  out.push('## Summary', areaPageTable(pairs, siteIssues));
  const flaky = pairs.filter((p) => p.flaky).length;
  if (flaky) out.push(`> ⚠️ ${flaky} page(s) change between loads (rotating or random content); their findings may include noise. They are marked "flaky" in pages.csv.`);
  const site = siteSection(run);
  if (site) out.push(site);
  const worst = worstPages(pairs, single);
  if (worst) out.push(worst);
  if (single) out.push(pairSection(pairs[0]));
  out.push('## Files in this report', [
    '- `report.md`: this summary.',
    '- `issues.md` / `issues.csv`: every item behind the action items, with its priority and how many pages it affects. Use it as the work list.',
    '- `pages.csv`: one row per page with a result for content, visual and integration and its P1/P2/P3 counts. Open it in a spreadsheet to sort and filter.',
    '- `pages/<page>.md`: full detail for each page that did not pass. Screenshots are linked from `pairs/`.',
  ].join('\n'));
  out.push('## How to read this', [
    '- **🔴 P1 Blocker**: must be fixed before launch: content lost or changed (text, figures, images, sections, forms), broken pages, and robots/canonical on a production host.',
    '- **🟠 P2 Major**: should be fixed before launch: rewritten copy, broken links and downloads, large visual or speed differences.',
    '- **🟡 P3 Minor**: polish: header, footer and navigation differences, small visual shifts, alt text.',
    '- **⚪ Expected**: differs by design on a preview or publish host; recheck on the launch domain.',
    '- "Likely owner" is a suggestion from the type of check, not an assignment.',
    '- **Fail / Review / Info** in the page detail say how sure the check is that something changed; the priority says how much it matters.',
    '- A pass means no differences were found by these checks, not proof that the page is correct.',
  ].join('\n'));
  if ((run.notTested || []).length) out.push('## Not tested', run.notTested.map((n) => `- ${cell(n, 300)}`).join('\n'));
  return `${out.join('\n\n')}\n`;
}

/**
 * All Markdown/CSV report files for a run, keyed by path relative to the output directory:
 * report.md (fixed-size summary), issues.md, issues.csv, pages.csv and pages/<id>.md for every page that did not pass.
 */
function renderMarkdownFiles(run) {
  const pairs = [...(run.pairs || [])].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
  const issues = groupIssues(pairs, run);
  const files = {
    'report.md': summaryMd(run, pairs, issues),
    'issues.md': issuesMd(issues, run),
    'issues.csv': issuesCsv(issues),
    'pages.csv': pagesCsv(pairs),
  };
  for (const p of pairs) if (p.status !== 'pass') files[detailPath(p)] = `${pairSection(p, '../')}\n`;
  return files;
}

/** The summary report (report.md) for a run. */
function toMarkdown(run) {
  return renderMarkdownFiles(run)['report.md'];
}

/**
 * Writes the report files under outDir. Page detail files of pages that no longer need one
 * (pairs/<id>/ exists, so this tool made that page) are removed one file at a time.
 * Nothing else under outDir is deleted, so --out can point at a folder that holds other files.
 */
function writeReportFiles(outDir, files) {
  const pagesDir = path.join(outDir, 'pages');
  if (fs.existsSync(pagesDir)) {
    for (const entry of fs.readdirSync(pagesDir, { withFileTypes: true })) {
      const id = entry.name.replace(/\.md$/, '');
      const ours = entry.isFile() && entry.name.endsWith('.md') && fs.existsSync(path.join(outDir, 'pairs', id));
      if (ours && !(`pages/${entry.name}` in files)) fs.unlinkSync(path.join(pagesDir, entry.name));
    }
  }
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(outDir, rel), content);
  }
}

module.exports = { toMarkdown, renderMarkdownFiles, writeReportFiles, areaOf };
