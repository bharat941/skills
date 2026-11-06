'use strict';

const { normalizeText } = require('./util');
const { finding, cap, safeHost } = require('./content');

// ---------- analytics beacon classification (pure; fed by the capture layer) ----------

function parseBody(body) {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch (e) {
    return Object.fromEntries(new URLSearchParams(body));
  }
}

function classifyRequest(url, method = 'GET', postData = '') {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return null;
  }
  const path = u.pathname;
  const aa = path.match(/\/b\/ss\/([^/]+)\//);
  if (aa) {
    const params = { ...Object.fromEntries(u.searchParams), ...(method === 'POST' ? parseBody(postData) : {}) };
    return { kind: 'aa', rsid: aa[1], pageName: params.pageName || params.gn || '', channel: params.ch || '', server: params.server || '', pageView: !params.pe };
  }
  if (/\/ee(-pre-prod)?\/(.+\/)?v\d+\/(interact|collect)/.test(path)) {
    const body = method === 'POST' ? parseBody(postData) : {};
    const xdm = (body.events && body.events[0] && body.events[0].xdm) || {};
    const details = (xdm.web && xdm.web.webPageDetails) || {};
    const eventType = xdm.eventType || '';
    return {
      kind: 'websdk',
      datastreamId: u.searchParams.get('configId') || '',
      pageName: details.name || '',
      eventType,
      pageView: !eventType || /pageViews/i.test(eventType) || /pageViews/i.test(JSON.stringify(details)),
    };
  }
  if (/\/g\/collect$/.test(path) && u.searchParams.get('tid')) {
    return { kind: 'ga4', id: u.searchParams.get('tid'), event: u.searchParams.get('en') || '', pageView: u.searchParams.get('en') === 'page_view' };
  }
  if (/google-analytics\.com\/collect$/.test(u.host + path) && u.searchParams.get('tid')) {
    return { kind: 'ga4', id: u.searchParams.get('tid'), event: u.searchParams.get('t') || '', pageView: u.searchParams.get('t') === 'pageview' };
  }
  if (/(^|\.)adobedtm\.com$/.test(u.host) && /\/(launch-|satelliteLib-)[^/]*\.js$/.test(path)) {
    const lib = path.split('/').filter(Boolean).slice(-2).join('/');
    return { kind: 'launch', lib, env: (lib.match(/-(development|staging|production)/) || [])[1] || '' };
  }
  if (u.host === 'www.googletagmanager.com' && path === '/gtm.js') {
    return { kind: 'gtm', id: u.searchParams.get('id') || '' };
  }
  return null;
}

// Flattens a data layer object to path -> scalar, depth-limited.
function flattenDataLayer(value, prefix = '', depth = 0, out = {}) {
  if (depth > 4 || value == null) return out;
  if (Array.isArray(value)) {
    value.slice(0, 1).forEach((v) => flattenDataLayer(v, `${prefix}[0]`, depth + 1, out));
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) flattenDataLayer(v, prefix ? `${prefix}.${k}` : k, depth + 1, out);
  } else {
    out[prefix] = String(value);
  }
  return out;
}

const COMPARABLE_KEY = /(name|section|channel|lang|language|site|template|type|category|rsid|suite)$/i;

// ---------- diff ----------

function normalizeMessage(m) {
  return String(m).replace(/https?:\/\/\S+/g, '<url>').replace(/\d+/g, '#').trim();
}

function analyticsFindings(before, after, ctx) {
  const out = [];
  const ba = before.analytics || { beacons: [], tags: [] };
  const aa = after.analytics || { beacons: [], tags: [] };
  const kindsBefore = new Set(ba.tags.map((t) => t.kind));
  const kindsAfter = new Set(aa.tags.map((t) => t.kind));
  const lost = [...kindsBefore].filter((k) => !kindsAfter.has(k) && k !== 'launch' && k !== 'gtm');
  const lostLoaders = ['launch', 'gtm'].filter((k) => kindsBefore.has(k) && !kindsAfter.has(k));
  if (lostLoaders.length) out.push(finding('analytics.tag', 'fail', `Tag manager not loaded on the after page: ${lostLoaders.join(', ')}`));

  const pv = (a) => a.beacons.filter((b) => b.pageView);
  for (const kind of ['aa', 'websdk', 'ga4']) {
    const bb = pv(ba).filter((b) => b.kind === kind)[0];
    const ab = pv(aa).filter((b) => b.kind === kind)[0];
    if (bb && !ab) {
      out.push(finding('analytics.beacon', 'fail', `No ${LABEL[kind]} page-view beacon fired on the after page`, { before: describe(bb) }));
      continue;
    }
    if (!bb || !ab) continue;
    const expected = ctx.expect || {};
    if (kind === 'aa') {
      if (expected.rsid) {
        if (ab.rsid !== expected.rsid) out.push(finding('analytics.expected', 'fail', `Report suite is ${ab.rsid}, expected ${expected.rsid}`, { before: bb.rsid, after: ab.rsid }));
      } else if (bb.rsid !== ab.rsid) {
        out.push(finding('analytics.rsid', 'review', 'Report suite differs from the before page', { before: bb.rsid, after: ab.rsid }));
      }
      diffField(out, 'analytics.pagename', 'pageName', bb.pageName, ab.pageName);
      diffField(out, 'analytics.channel', 'channel', bb.channel, ab.channel);
    }
    if (kind === 'websdk') {
      if (expected.datastreamId) {
        if (ab.datastreamId !== expected.datastreamId) out.push(finding('analytics.expected', 'fail', `Datastream is ${ab.datastreamId}, expected ${expected.datastreamId}`, { before: bb.datastreamId, after: ab.datastreamId }));
      } else if (bb.datastreamId !== ab.datastreamId) {
        out.push(finding('analytics.datastream', 'review', 'Datastream differs from the before page', { before: bb.datastreamId, after: ab.datastreamId }));
      }
      diffField(out, 'analytics.pagename', 'page name', bb.pageName, ab.pageName);
    }
    if (kind === 'ga4' && bb.id !== ab.id) out.push(finding('analytics.ga4', 'review', 'GA4 measurement ID differs', { before: bb.id, after: ab.id }));
  }
  for (const kind of lost) {
    if (!['aa', 'websdk', 'ga4'].includes(kind)) continue;
    // already reported through the missing beacon check when a page-view fired before
    if (!pv(ba).some((b) => b.kind === kind)) out.push(finding('analytics.tag', 'review', `${LABEL[kind]} requests seen on the before page are absent on the after page`));
  }

  const lb = ba.tags.find((t) => t.kind === 'launch');
  const la = aa.tags.find((t) => t.kind === 'launch');
  if (ctx.expect && ctx.expect.launch) {
    if (!la || !la.lib.includes(ctx.expect.launch)) out.push(finding('analytics.expected', 'fail', `Launch library does not match expected "${ctx.expect.launch}"`, { after: la ? la.lib : '(none)' }));
  } else if (lb && la && lb.lib !== la.lib) {
    out.push(finding('analytics.launch', 'review', 'Launch library differs from the before page', { before: lb.lib, after: la.lib }));
  }

  const dlb = before.dataLayer || {};
  const dla = after.dataLayer || {};
  const missingKeys = Object.keys(dlb).filter((k) => !(k in dla));
  if (missingKeys.length && Object.keys(dla).length) out.push(finding('analytics.datalayer.keys', 'review', `${missingKeys.length} data layer key(s) missing on the after page`, cap(missingKeys.map((key) => ({ key })))));
  if (Object.keys(dlb).length && !Object.keys(dla).length) out.push(finding('analytics.datalayer.keys', 'fail', 'Data layer is empty or missing on the after page'));
  const changed = Object.keys(dlb)
    .filter((k) => k in dla && COMPARABLE_KEY.test(k.split('.').pop()))
    .filter((k) => !sameValue(dlb[k], dla[k], ctx))
    .map((key) => ({ key, before: dlb[key], after: dla[key] }));
  if (changed.length) out.push(finding('analytics.datalayer.values', 'review', `${changed.length} data layer value(s) differ`, cap(changed)));
  return out;
}

const LABEL = { aa: 'Adobe Analytics', websdk: 'Web SDK', ga4: 'GA4' };

function describe(b) {
  return b.rsid || b.datastreamId || b.id || b.kind;
}

function diffField(out, check, label, a, b) {
  if (a && normalizeText(a) !== normalizeText(b)) out.push(finding(check, 'review', `Analytics ${label} differs`, { before: a, after: b }));
}

function sameValue(a, b, ctx) {
  if (normalizeText(a) === normalizeText(b)) return true;
  if (/^(https?:)?\/|^\//.test(a) && /^(https?:)?\/|^\//.test(b)) return ctx.canon(a, 'before') === ctx.canon(b, 'after');
  return false;
}

function functionalFindings(before, after, ctx) {
  const out = [];
  const rules = ctx.rules;

  const seen = new Set((before.consoleErrors || []).map(normalizeMessage));
  const newConsole = (after.consoleErrors || []).filter((m) => !seen.has(normalizeMessage(m)));
  if (newConsole.length) out.push(finding('console.error', 'review', `${newConsole.length} new console error(s) on the after page`, cap(newConsole.map((message) => ({ message })))));
  const seenPage = new Set((before.pageErrors || []).map(normalizeMessage));
  const newPage = (after.pageErrors || []).filter((m) => !seenPage.has(normalizeMessage(m)));
  if (newPage.length) out.push(finding('js.error', 'fail', `${newPage.length} new uncaught JavaScript error(s) on the after page`, cap(newPage.map((message) => ({ message })))));

  const bk = (r) => requestKey(r, ctx);
  const seenReq = new Set((before.failedRequests || []).map(bk));
  const newReq = (after.failedRequests || []).filter((r) => !seenReq.has(bk(r)));
  const critical = newReq.filter((r) => ['stylesheet', 'script', 'font'].includes(r.type));
  const rest = newReq.filter((r) => !['stylesheet', 'script', 'font'].includes(r.type));
  const row = (r) => ({ url: r.url, status: r.status || r.failure, type: r.type });
  if (critical.length) out.push(finding('resource.missing', 'fail', `${critical.length} CSS/JS/font request(s) fail on the after page`, cap(critical.map(row))));
  if (rest.length) out.push(finding('request.failed', 'review', `${rest.length} new failed request(s) on the after page`, cap(rest.map(row))));

  if ((after.mixedContent || 0) > (before.mixedContent || 0)) out.push(finding('request.mixed', 'review', `${after.mixedContent} insecure (http) request(s) on the after page`));

  const t0 = before.timing || {};
  const t1 = after.timing || {};
  for (const metric of ['load', 'lcp']) {
    if (t0[metric] && t1[metric] && t1[metric] > t0[metric] * rules.timing.slowerRatio && t1[metric] - t0[metric] >= rules.timing.minDeltaMs) {
      out.push(finding(`perf.${metric}`, 'review', `${metric.toUpperCase()} is slower on the after page`, { before: `${t0[metric]} ms`, after: `${t1[metric]} ms` }));
    }
  }

  const a0 = before.a11y || {};
  const a1 = after.a11y || {};
  const worse = ['imgNoAlt', 'emptyLinks', 'emptyButtons'].filter((k) => (a1[k] || 0) > (a0[k] || 0));
  if (worse.length) out.push(finding('a11y.delta', 'review', `More accessibility issues on the after page: ${worse.map((k) => `${k} ${a0[k] || 0} -> ${a1[k]}`).join(', ')}`));

  out.push(...analyticsFindings(before, after, ctx));
  return out;
}

function requestKey(r, ctx) {
  const host = safeHost(r.url);
  const primary = host === ctx.beforeHost || host === ctx.afterHost;
  let path = r.url;
  try {
    path = new URL(r.url).pathname;
  } catch (e) {
    // keep raw
  }
  return `${r.type}:${primary ? '*' : host}${path}:${r.status || r.failure}`;
}

module.exports = { classifyRequest, flattenDataLayer, functionalFindings, analyticsFindings, normalizeMessage };
