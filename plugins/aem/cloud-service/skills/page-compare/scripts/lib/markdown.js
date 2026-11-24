'use strict';

// report.md, pages/<page>.md, issues.csv, pages.csv and fixes.json: all rendered from one report model (lib/fixes.js).

const fs = require('fs');
const path = require('path');
const { csvCell, isPreviewHost, hostOf } = require('./util');
const { priorityOf, DEFAULT_RULES } = require('./rules');
const { NUMBER, numbersIn } = require('./content');
const { reportModel, pageModel, pageParity } = require('./fixes');
const { areaOf, pathOf, priorityParts } = require('./actions');
const { STATUS_ORDER } = require('./report');

const SEVERITY_ORDER = { fail: 0, review: 1, info: 2 };
const AREA_IDS = ['content', 'visual', 'integration'];
const AREA_TITLE = { content: 'Content parity', visual: 'Visual parity', integration: 'Integration & SEO' };
const SCORE_TITLE = { content: 'Content', visual: 'Visual', integration: 'Integration & SEO' };
const PRIORITY_LABEL = { P1: '🔴 P1', P2: '🟠 P2', P3: '🟡 P3', expected: '⚪ Expected' };
const MAX_FIXES = 10;
const MAX_CELL = 120;
const MAX_ISSUE_PAGES = 20;
const MAX_LINKS = 10;
const MAX_PAGES = 10;

function cell(v, max = MAX_CELL) {
  let s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s.replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;')).replace(/\|/g, '\\|');
}

function table(headers, rows) {
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);
const idCell = (f) => `\`${f.id}\``;

function verdictLine(v) {
  if (v.label === 'Nothing compared') return '**Nothing compared**: no page pairs matched the input and filters.';
  const head = v.label === 'Not ready' ? `**Not ready: ${plural(v.p1, 'blocker')}**`
    : v.label === 'Incomplete' ? `**Incomplete: ${plural(v.notCompared, 'page')} could not be compared**`
      : v.label === 'Ready after fixes' ? `**Ready after fixes: ${plural(v.p2, 'major issue')}**`
        : '**No blocking differences found**';
  return `${head}. ${v.p1} P1 · ${v.p2} P2 · ${v.p3} P3 fix(es) · ${v.expected} to recheck at launch.`;
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


// Source says / Destination says cells; changed figures in bold for facts.
function valueCells(f) {
  if (f.checks.includes('content.facts.changed')) {
    const nb = numbersIn(f.expected);
    const na = numbersIn(f.actual);
    return [boldFigures(f.expected, nb, na), boldFigures(f.actual, na, nb)];
  }
  return [f.expected ? cell(f.expected) : '—', f.actual ? cell(f.actual) : '—'];
}

function pagesCell(f) {
  if (f.siteWide) return 'site-wide';
  return f.pages.length === 1 ? cell(pathOf({ after: f.pages[0].destination }), 60) : `${f.pages.length} pages`;
}

function shots(f, prefix) {
  const e = f.evidence;
  if (!e) return '—';
  return [['source', e.before], ['destination', e.after], ['diff', e.diff]].filter(([, v]) => v).map(([k, v]) => `[${k}](${encodeURI(prefix + v)})`).join(' · ');
}

function more(list, shown, where = 'fixes.json') {
  return list.length > shown ? [`_…and ${list.length - shown} more in ${where}._`] : [];
}

function header(model) {
  const date = String(model.generatedAt || '').slice(0, 10);
  const vps = (model.viewports || []).join(', ');
  return ['# Migration comparison', [
    `- **Source:** ${cell(model.source, 300)}`,
    `- **Destination:** ${cell(model.destination, 300)}`,
    `- **Run:** ${date} · ${plural(model.pages, 'page')}${vps ? ` · viewports ${vps}` : ''}`,
  ].join('\n')];
}

function scorecard(model) {
  const n = (area, p) => model.fixes.filter((f) => f.area === area && f.priority === p).length;
  const parity = { content: model.parity.content, visual: model.parity.visual, integration: null };
  return table(['Area', 'Parity', '🔴 P1', '🟠 P2', '🟡 P3'], AREA_IDS.map((a) => [SCORE_TITLE[a], pct(parity[a]), n(a, 'P1'), n(a, 'P2'), n(a, 'P3')]));
}

function fixTable(list, multi) {
  const head = ['ID', 'Priority', 'Section', 'Problem', 'Source says', 'Destination says', ...(multi ? ['Pages'] : []), 'Fix type'];
  return table(head, list.map((f) => [idCell(f), PRIORITY_LABEL[f.priority], cell(f.section, 60), cell(f.title), ...valueCells(f), ...(multi ? [pagesCell(f)] : []), f.fixType]));
}

function visualTable(list, multi, prefix) {
  const head = ['ID', 'Priority', 'Section', 'Problem', 'Screenshots', ...(multi ? ['Pages'] : [])];
  return table(head, list.map((f) => [idCell(f), PRIORITY_LABEL[f.priority], cell(f.section, 60), cell(f.title), shots(f, prefix), ...(multi ? [pagesCell(f)] : [])]));
}

function minorLine(list) {
  if (!list.length) return [];
  const shown = list.slice(0, MAX_FIXES);
  return [`**Minor:** ${shown.map((f) => `${cell(f.title, 80)} (${idCell(f)})`).join(' · ')}${list.length > shown.length ? ` · _…and ${list.length - shown.length} more in fixes.json_` : ''}`];
}

const META_ROWS = [['title', 'Title'], ['description', 'Description'], ['canonical', 'Canonical'], ['robots', 'Robots'], ['ogTitle', 'Social title'], ['h1', 'H1']];

function metadataTable(pair) {
  const m = pair && pair.meta;
  if (!m || !m.before || !m.after) return [];
  return ['### Metadata', table(['Property', 'Source', 'Destination', 'Match'], META_ROWS.map(([k, label]) => [label, cell(m.before[k] || '—', 100), cell(m.after[k] || '—', 100), (m.before[k] || '') === (m.after[k] || '') ? '✅' : '❌']))];
}

function brokenLinks(fixes, multi) {
  const rows = [];
  for (const f of fixes.filter((x) => x.checks.includes('link.broken'))) {
    const it = f.items[0] || {};
    rows.push([it.status || '—', cell(it.url, 100), cell(it.text || '—', 60), ...(multi ? [pagesCell(f)] : [])]);
  }
  if (!rows.length) return [];
  const shown = rows.slice(0, MAX_LINKS);
  return ['### Broken links', table(['Status', 'Link', 'Link text', ...(multi ? ['Pages'] : [])], shown), ...more(rows, shown.length)];
}

function areaSection(model, area, prefix) {
  const multi = !model.single;
  const list = model.fixes.filter((f) => f.area === area && f.priority !== 'expected');
  const major = list.filter((f) => f.priority === 'P1' || f.priority === 'P2');
  const minor = list.filter((f) => f.priority === 'P3');
  const out = [`## ${AREA_TITLE[area]}`];
  if (!list.length) out.push('_No differences found._');
  if (major.length) {
    const shown = major.slice(0, MAX_FIXES);
    out.push(area === 'visual' ? visualTable(shown, multi, prefix) : fixTable(shown, multi), ...more(major, shown.length));
  }
  out.push(...minorLine(minor));
  if (area === 'content' && model.single) out.push(...metadataTable(model.pair));
  if (area === 'integration') out.push(...brokenLinks(list, multi));
  return out;
}

function expectedSection(model) {
  const list = model.fixes.filter((f) => f.priority === 'expected');
  if (!list.length) return [];
  const line = (f) => `- ${cell(f.title, 200)}${f.expected || f.actual ? `: ${cell(f.expected, 80)} → ${cell(f.actual, 80)}` : ''} (${idCell(f)})`;
  return ['## Expected on preview — recheck at launch', 'The destination is a preview or publish host, where these usually differ by design. Check them again on the launch domain.', list.map(line).join('\n')];
}

function worstPages(model, pairs) {
  if (model.single) return [];
  const rows = pairs.filter((p) => p.status !== 'pass').map((p) => {
    const mine = model.fixes.filter((f) => f.pages.some((x) => x.destination === p.after));
    const parity = pageParity(p);
    return { p, p1: mine.filter((f) => f.priority === 'P1').length, p2: mine.filter((f) => f.priority === 'P2').length, parity };
  }).sort((a, b) => b.p1 - a.p1 || b.p2 - a.p2 || (a.parity.content ?? 100) - (b.parity.content ?? 100));
  if (!rows.length) return [];
  const shown = rows.slice(0, MAX_PAGES);
  return ['## Pages with most blockers', table(['Page', '🔴 P1', '🟠 P2', 'Content parity', 'Visual parity', 'Detail'],
    shown.map((r) => [cell(pathOf(r.p), 80), r.p1, r.p2, pct(r.parity.content), pct(r.parity.visual), `[details](${detailPath(r.p)})`])), ...more(rows, shown.length, 'pages.csv')];
}

function agentsSection(model) {
  const files = model.single ? '`report.html` (to share) · `fixes.json` · `issues.csv` · `pages.csv` · `review.html` (accept differences)'
    : '`report.html` (to share) · `fixes.json` · `issues.csv` · `pages.csv` · `pages/<page>.md` · `review.html` (accept differences)';
  const out = ['## For agents',
    'Work from `fixes.json`: one entry per fix with its section and component, the source value (`expected`), the destination value (`actual`) and the fix type (content, code or config). Fix by priority and skip "expected". To verify, run the comparison again with `--baseline <this folder>`: a fixed id moves to "Fixed since last run". See SKILL.md › Fix mode.',
    `Files: ${files}.`];
  if ((model.notTested || []).length) out.push(`_Not tested: ${model.notTested.map((n) => cell(n, 120)).join('; ')}._`);
  return out;
}

/** report.md (or pages/<page>.md with prefix '../') for a model. */
function reportMd(model, { pairs = [], prefix = '' } = {}) {
  const out = [...header(model), verdictLine(model.verdict)];
  if (model.flaky) out.push(`> ⚠️ ${plural(model.flaky, 'page')} changes between loads (rotating or random content); some differences may be noise. They are marked "flaky" in pages.csv.`);
  out.push(scorecard(model));
  for (const a of AREA_IDS) out.push(...areaSection(model, a, prefix));
  out.push(...expectedSection(model), ...worstPages(model, pairs), ...agentsSection(model));
  return `${out.join('\n\n')}\n`;
}

// ---------- CSVs and JSON ----------

function toCsvText(header, rows) {
  return `${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n')}\n`;
}

const FIX_AREA_TITLE = { content: 'Content parity', visual: 'Visual parity', integration: 'Integration & SEO' };

/** The work list for a spreadsheet: one row per fix, with the same id as fixes.json. */
function issuesCsv(fixes) {
  const pathOfUrl = (u) => pathOf({ after: u });
  return toCsvText(['fix_id', 'priority', 'area', 'section', 'fix_type', 'owner', 'problem', 'how_many', 'pages_affected', 'source_value', 'destination_value', 'example_page', 'pages'],
    fixes.map((f) => {
      const pages = f.pages.map((p) => pathOfUrl(p.destination));
      return [f.id, f.priority, FIX_AREA_TITLE[f.area], f.section, f.fixType, f.owner, f.title, f.count, f.siteWide ? 'site-wide' : pages.length, f.expected, f.actual, pages[0] || '',
        pages.slice(0, MAX_ISSUE_PAGES).join(' ') + (pages.length > MAX_ISSUE_PAGES ? ` (+${pages.length - MAX_ISSUE_PAGES} more)` : '')];
    }));
}

/** fixes.json: the fix list an agent works from. */
function fixesJson(model) {
  const { generatedAt, source, destination, verdict, parity, fixes, fixed } = model;
  return `${JSON.stringify({ generatedAt, source, destination, verdict, parity, fixes, fixed }, null, 2)}\n`;
}

// ---------- pages ----------

function counts(findings) {
  const open = findings.filter((f) => !f.accepted);
  return { fail: open.filter((f) => f.severity === 'fail').length, review: open.filter((f) => f.severity === 'review').length };
}

function resultOf(findings) {
  const c = counts(findings);
  return c.fail ? 'fail' : c.review ? 'review' : 'pass';
}

function pageAreas(p) {
  const by = { content: [], visual: [], integration: [] };
  for (const f of p.findings || []) by[areaOf(f.check)].push(f);
  return Object.fromEntries(AREA_IDS.map((a) => [a, p.blocked || p.error ? 'not compared' : resultOf(by[a])]));
}

function topIssueOf(p) {
  const open = (p.findings || []).filter((f) => !f.accepted && ['fail', 'review'].includes(f.severity)).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return open.length ? open[0].summary : p.blocked || p.error || '';
}

function detailPath(p) {
  return `pages/${p.id}.md`;
}

function pagesCsv(pairs, rules = DEFAULT_RULES, single = false) {
  return toCsvText(['page', 'status', 'flaky', 'content', 'visual', 'integration', 'fail', 'review', 'p1', 'p2', 'p3', 'content_parity', 'visual_parity', 'top_issue', 'detail', 'before', 'after'],
    pairs.map((p) => {
      const a = pageAreas(p);
      const c = counts(p.findings || []);
      const previewHost = isPreviewHost(hostOf(p.after));
      const pr = (want) => (p.findings || []).flatMap(priorityParts).filter((f) => priorityOf(f, { previewHost }, rules) === want).length;
      const parity = pageParity(p);
      return [pathOf(p), p.status, p.flaky || p.retried ? 'yes' : '', a.content, a.visual, a.integration, c.fail, c.review, pr('P1'), pr('P2'), pr('P3'), parity.content ?? '', parity.visual ?? '', topIssueOf(p), p.status === 'pass' || single ? '' : detailPath(p), p.before, p.after];
    }));
}

/**
 * All Markdown, CSV and JSON report files for a run, keyed by path relative to the output directory:
 * report.md, fixes.json, issues.csv, pages.csv, and pages/<id>.md for every page that did not pass in a multi-page run.
 * `rules` are the run's rules, so --rules priority and owner overrides apply.
 */
function renderMarkdownFiles(run, rules = DEFAULT_RULES) {
  const pairs = [...(run.pairs || [])].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
  const model = reportModel(run, rules);
  const files = {
    'report.md': reportMd(model, { pairs }),
    'fixes.json': fixesJson(model),
    'issues.csv': issuesCsv(model.fixes),
    'pages.csv': pagesCsv(pairs, rules, model.single),
  };
  if (!model.single) for (const p of pairs) if (p.status !== 'pass') files[detailPath(p)] = reportMd(pageModel(model, p), { prefix: '../' });
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

module.exports = { toMarkdown, renderMarkdownFiles, writeReportFiles, reportMd, areaOf, PRIORITY_LABEL };
