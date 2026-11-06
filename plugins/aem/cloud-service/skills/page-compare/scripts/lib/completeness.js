'use strict';

// Checks that go beyond a single page load: downloads, broken links, redirects, robots/sitemap
// and page-set coverage. HTTP only (HEAD, falling back to GET); the fetch function is injectable.

const { normalizePath, hostOf, round, isPreviewHost } = require('./util');
const { finding, cap } = require('./content');
const { loadSitemap } = require('./pairs');

function createFetcher({ fetchFn = globalThis.fetch, userAgent = 'page-compare/1.0', timeoutMs = 15000, pacer } = {}) {
  const cache = new Map();

  async function request(url, method, redirect) {
    if (pacer) await pacer.wait(hostOf(url));
    const res = await fetchFn(url, { method, redirect, headers: { 'user-agent': userAgent }, signal: AbortSignal.timeout(timeoutMs) });
    return res;
  }

  async function head(url) {
    if (cache.has(url)) return cache.get(url);
    const p = (async () => {
      try {
        let res = await request(url, 'HEAD', 'follow');
        if ([403, 405, 501].includes(res.status)) res = await request(url, 'GET', 'follow');
        return {
          status: res.status,
          type: (res.headers.get('content-type') || '').split(';')[0].trim(),
          size: Number(res.headers.get('content-length')) || null,
          finalUrl: res.url || url,
        };
      } catch (e) {
        return { status: 0, error: String(e.message || e) };
      }
    })();
    cache.set(url, p);
    return p;
  }

  async function text(url) {
    try {
      const res = await request(url, 'GET', 'follow');
      return { status: res.status, body: res.ok ? await res.text() : '' };
    } catch (e) {
      return { status: 0, body: '', error: String(e.message || e) };
    }
  }

  async function redirectOf(url) {
    try {
      const res = await request(url, 'GET', 'manual');
      return { status: res.status, location: res.headers.get('location') || '' };
    } catch (e) {
      return { status: 0, location: '', error: String(e.message || e) };
    }
  }

  return { head, text, redirectOf };
}

async function downloadFindings(before, after, ctx) {
  const beforeByText = new Map((before.downloads || []).map((d) => [d.text.toLowerCase(), d]));
  const bad = [];
  const changed = [];
  for (const d of (after.downloads || []).slice(0, ctx.rules.links.maxPerPage)) {
    const a = await ctx.fetcher.head(d.href);
    if (a.status === 0 || a.status >= 400) {
      bad.push({ text: d.text, url: d.href, status: a.status || a.error });
      continue;
    }
    const b = beforeByText.get(d.text.toLowerCase());
    if (!b) continue;
    const bh = await ctx.fetcher.head(b.href);
    if (bh.status >= 400 || bh.status === 0) continue;
    const sizeOff = bh.size && a.size && Math.abs(a.size - bh.size) / bh.size > 0.2;
    if ((bh.type && a.type && bh.type !== a.type) || sizeOff) {
      changed.push({ text: d.text, before: `${bh.type} ${bh.size ?? '?'} bytes`, after: `${a.type} ${a.size ?? '?'} bytes` });
    }
  }
  const out = [];
  if (bad.length) out.push(finding('download.broken', 'fail', `${bad.length} download link(s) on the after page do not resolve`, cap(bad)));
  if (changed.length) out.push(finding('download.changed', 'review', `${changed.length} download(s) differ in type or size from the before page`, cap(changed)));
  return out;
}

async function brokenLinkFindings(before, after, ctx) {
  const afterHost = ctx.afterHost;
  const seen = new Set();
  const targets = [];
  for (const l of after.links || []) {
    if (!/^https?:/.test(l.href) || hostOf(l.href) !== afterHost) continue;
    const key = l.href.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ ...l, url: key });
  }
  const limit = ctx.rules.links.maxPerPage;
  const checked = targets.slice(0, limit);
  const beforeKeys = new Set((before.links || []).map((l) => ctx.canon(l.href, 'before').split('#')[0]));
  const broken = [];
  const preExisting = [];
  for (const t of checked) {
    const r = await ctx.fetcher.head(t.url);
    if (r.status === 0 || r.status >= 400) {
      const item = { text: t.text, url: t.url, status: r.status || r.error };
      // A link that was already on the before page and was already broken there is not a regression.
      if (beforeKeys.has(t.url)) {
        const bUrl = (before.links || []).find((l) => ctx.canon(l.href, 'before').split('#')[0] === t.url);
        const br = bUrl ? await ctx.fetcher.head(bUrl.href) : null;
        if (br && (br.status === 0 || br.status >= 400)) {
          preExisting.push(item);
          continue;
        }
      }
      broken.push(item);
    }
  }
  const out = [];
  if (broken.length) out.push(finding('link.broken', 'fail', `${broken.length} internal link(s) on the after page return an error`, cap(broken)));
  if (preExisting.length) out.push(finding('link.broken.preexisting', 'info', `${preExisting.length} link(s) were already broken on the before page`, cap(preExisting)));
  if (targets.length > limit) out.push(finding('link.unchecked', 'info', `${targets.length - limit} internal link(s) were not checked (limit ${limit} per page)`));
  return out;
}

function robotsBlocksAll(body) {
  let applies = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^(user-agent|disallow)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    if (m[1].toLowerCase() === 'user-agent') applies = m[2].trim() === '*';
    else if (applies && m[2].trim() === '/') return true;
  }
  return false;
}

async function siteFindings({ beforeOrigin, afterOrigin, fetcher }) {
  const out = [];
  const [bRobots, aRobots] = await Promise.all([fetcher.text(`${beforeOrigin}/robots.txt`), fetcher.text(`${afterOrigin}/robots.txt`)]);
  if (aRobots.status === 200 && robotsBlocksAll(aRobots.body) && !(bRobots.status === 200 && robotsBlocksAll(bRobots.body))) {
    if (isPreviewHost(hostOf(afterOrigin))) {
      out.push(finding('site.robots', 'review', 'robots.txt on the after site disallows everything; expected on a preview host, check it again on the launch domain'));
    } else {
      out.push(finding('site.robots', 'fail', 'robots.txt on the after site disallows everything (Disallow: / for all agents)'));
    }
  } else if (bRobots.status === 200 && aRobots.status !== 200) {
    out.push(finding('site.robots', 'review', `robots.txt exists on the before site but returns ${aRobots.status || 'an error'} on the after site`));
  }
  const [bMap, aMap] = await Promise.all([fetcher.text(`${beforeOrigin}/sitemap.xml`), fetcher.text(`${afterOrigin}/sitemap.xml`)]);
  if (bMap.status === 200 && aMap.status !== 200) {
    out.push(finding('site.sitemap', 'review', `sitemap.xml exists on the before site but returns ${aMap.status || 'an error'} on the after site`));
  }
  return out;
}

function pathOf(url) {
  try {
    return normalizePath(new URL(url).pathname);
  } catch (e) {
    return normalizePath(url);
  }
}

// Each CSV row is "from,to": the before URL must redirect to the after URL.
async function redirectFindings(rows, fetcher, afterOrigin) {
  const results = [];
  for (const { from, to } of rows) {
    const r = await fetcher.redirectOf(from);
    const target = r.location ? new URL(r.location, from).href : '';
    let status = 'pass';
    let reason = '';
    if (![301, 302, 307, 308].includes(r.status)) {
      status = 'fail';
      reason = `expected a redirect, got ${r.status || r.error}`;
    } else if (pathOf(target) !== pathOf(to) || (hostOf(target) && hostOf(to) && hostOf(target) !== hostOf(to))) {
      status = 'fail';
      reason = `redirects to ${target}, expected ${to}`;
    } else if (r.status === 302 || r.status === 307) {
      status = 'review';
      reason = `temporary redirect (${r.status}); use 301/308 for permanent moves`;
    }
    results.push({ from, to, status, reason });
  }
  const failing = results.filter((r) => r.status === 'fail');
  const review = results.filter((r) => r.status === 'review');
  const out = [];
  if (failing.length) out.push(finding('redirect.wrong', 'fail', `${failing.length} of ${results.length} redirect(s) are missing or wrong`, cap(failing)));
  if (review.length) out.push(finding('redirect.temporary', 'review', `${review.length} redirect(s) are temporary`, cap(review)));
  return { results, findings: out, afterOrigin };
}

// Pages that exist on the after site but were not part of the compared set.
async function pageSetCoverage({ afterSitemapUrl, pairs, fetcher }) {
  let urls;
  try {
    urls = await loadSitemap(afterSitemapUrl, async (u) => {
      const res = await fetcher.text(u);
      if (res.status !== 200) throw new Error(`${u} returned ${res.status || res.error}`);
      return res.body;
    });
  } catch (e) {
    return { error: `Could not read the after sitemap: ${e.message}`, afterOnly: [], total: 0 };
  }
  const covered = new Set(pairs.map((p) => pathOf(p.after)));
  const afterOnly = urls.filter((u) => !covered.has(pathOf(u)));
  return {
    total: urls.length,
    afterOnly,
    coveragePct: urls.length ? round(((urls.length - afterOnly.length) / urls.length) * 100) : 100,
  };
}

module.exports = { createFetcher, downloadFindings, brokenLinkFindings, siteFindings, redirectFindings, pageSetCoverage, robotsBlocksAll };
