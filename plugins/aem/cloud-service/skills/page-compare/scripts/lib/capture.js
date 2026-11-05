'use strict';

const { classifyBlock } = require('./guard');
const { classifyRequest, flattenDataLayer } = require('./functional');

const HIDE_CSS = `
*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}
#onetrust-consent-sdk,#onetrust-banner-sdk,#truste-consent-track,#CybotCookiebotDialog,.cc-window,.cookie-banner,.cookie-consent,.cmp-cookie-banner,[id^="sp_message_container"],.evidon-banner{display:none!important}
`;

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (e) {
    throw Object.assign(new Error('Playwright is not installed. Run `npm run setup` in the page-compare scripts directory.'), { code: 'NO_PLAYWRIGHT' });
  }
}

async function launchBrowser() {
  const { chromium } = loadPlaywright();
  try {
    return await chromium.launch({ headless: true });
  } catch (e) {
    if (/Executable doesn't exist|browserType\.launch/i.test(e.message)) {
      throw Object.assign(new Error('Chromium is not installed. Run `npx playwright install chromium` in the page-compare scripts directory.'), { code: 'NO_BROWSER' });
    }
    throw e;
  }
}

// Runs inside the page. Must stay self-contained.
function extractInPage({ masks, sectionSelectors }) {
  const maskSel = masks.join(',');
  const isMasked = (el) => !!maskSel && !!el.closest(maskSel);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'IFRAME', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO']);
  const INLINE = new Set(['A', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'U', 'SMALL', 'SUP', 'SUB', 'ABBR', 'CODE', 'MARK', 'TIME', 'CITE', 'Q', 'S', 'DEL', 'INS', 'FONT', 'BDI', 'BDO', 'DATA', 'DFN', 'KBD', 'SAMP', 'VAR', 'WBR', 'BR', 'LABEL']);
  const visible = (el) => {
    try {
      return el.checkVisibility({ checkVisibilityCSS: true });
    } catch (e) {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && (r.width > 0 || r.height > 0);
    }
  };
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const abs = (h) => {
    try {
      return new URL(h, location.href).href;
    } catch (e) {
      return h;
    }
  };
  const main = document.querySelector('main, [role=main]');
  const header = document.querySelector('header, [role=banner]');
  const footer = document.querySelector('footer, [role=contentinfo]');
  const regionOf = (el) => (footer && footer.contains(el) ? 'footer' : header && header.contains(el) ? 'header' : 'main');

  const blocks = [];
  function walk(el, state) {
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        state.buf += ' ' + node.nodeValue;
      } else if (node.nodeType === 1) {
        if (SKIP.has(node.tagName.toUpperCase()) || isMasked(node)) continue;
        if (INLINE.has(node.tagName)) {
          if (visible(node)) walk(node, state);
        } else {
          flush(state);
          const child = { buf: '', el: node, hidden: !visible(node) };
          walk(node, child);
          flush(child);
        }
      }
    }
  }
  function flush(state) {
    const text = clean(state.buf);
    state.buf = '';
    if (text) blocks.push({ text, hidden: !!state.hidden, region: regionOf(state.el) });
  }
  const root = { buf: '', el: document.body, hidden: false };
  walk(document.body, root);
  flush(root);

  const live = (sel) => [...document.querySelectorAll(sel)].filter((e) => !isMasked(e));
  const headings = live('h1,h2,h3,h4,h5,h6,[role=heading][aria-level]').map((h) => ({
    level: /^H\d$/.test(h.tagName) ? Number(h.tagName[1]) : Number(h.getAttribute('aria-level')),
    text: clean(h.textContent),
  })).filter((h) => h.text);

  const images = live('img').map((i) => {
    const src = i.currentSrc || i.getAttribute('src') || i.getAttribute('data-src') || '';
    return { src, alt: clean(i.getAttribute('alt')), broken: !!src && !src.startsWith('data:') && i.complete && i.naturalWidth === 0, inMain: !(header && header.contains(i)) && !(footer && footer.contains(i)), tiny: (i.width <= 1 && i.height <= 1) };
  }).filter((i) => i.src && !i.tiny);

  const linkText = (a) => clean(a.textContent) || clean(a.getAttribute('aria-label')) || clean(a.getAttribute('title')) || clean((a.querySelector('img') || {}).alt);
  const links = live('a[href]').map((a) => ({ text: linkText(a), href: abs(a.getAttribute('href')) }));
  const nav = [...new Set(live('nav a, [role=navigation] a, header a').map(linkText).filter(Boolean))];
  const ctas = [...new Set(live('button, input[type=submit], input[type=button], [role=button], a[class*=btn], a[class*=button], a[class*=cta]').map((e) => clean(e.value || e.textContent || e.getAttribute('aria-label'))).filter(Boolean))];

  const forms = live('form').map((f) => ({
    action: f.getAttribute('action') ? abs(f.getAttribute('action')) : '',
    method: (f.getAttribute('method') || 'get').toLowerCase(),
    fields: [...f.querySelectorAll('input,select,textarea')]
      .filter((e) => !['hidden', 'submit', 'button', 'image', 'reset'].includes((e.getAttribute('type') || '').toLowerCase()))
      .map((e) => {
        const lbl = (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)) || e.closest('label');
        return {
          name: e.getAttribute('name') || '',
          id: e.id || '',
          type: e.tagName === 'INPUT' ? (e.getAttribute('type') || 'text').toLowerCase() : e.tagName.toLowerCase(),
          required: e.required || e.getAttribute('aria-required') === 'true',
          label: clean((lbl && lbl.textContent) || e.getAttribute('aria-label') || e.getAttribute('placeholder')),
        };
      }),
  }));

  const jsonld = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent);
      const nodes = [].concat(data, ...[].concat(data).map((d) => (d && d['@graph']) || []));
      for (const n of nodes) if (n && n['@type']) jsonld.push({ type: [].concat(n['@type']).join('/'), name: n.name || n.headline || '' });
    } catch (e) {
      jsonld.push({ type: 'invalid-json-ld', name: '' });
    }
  }

  const meta = {};
  for (const m of document.querySelectorAll('meta[name],meta[property]')) {
    const k = (m.getAttribute('name') || m.getAttribute('property') || '').toLowerCase();
    if (k === 'description' || k === 'robots' || /^(og|twitter):/.test(k)) meta[k] = m.getAttribute('content') || '';
  }
  const canonical = document.querySelector('link[rel=canonical]');
  meta.canonical = canonical ? canonical.href : '';

  const dl = (v) => {
    try {
      return JSON.parse(JSON.stringify(v));
    } catch (e) {
      return null;
    }
  };
  let adobe = null;
  if (window.adobeDataLayer) {
    adobe = typeof window.adobeDataLayer.getState === 'function' ? dl(window.adobeDataLayer.getState()) : dl(Object.assign({}, ...window.adobeDataLayer.filter((x) => x && typeof x === 'object' && !Array.isArray(x))));
  }

  const DOWNLOAD = /\.(pdf|docx?|xlsx?|pptx?|zip|csv)(\?|#|$)/i;
  const downloads = links.filter((l) => DOWNLOAD.test(l.href)).map((l) => ({ text: l.text, href: l.href }));

  // sections
  let sections = [];
  const norm = (s) => clean(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  const describe = (el) => (el.id ? `#${el.id}` : el.classList.length ? `.${el.classList[0]}` : el.tagName.toLowerCase());
  const add = (name, el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    const idx = sections.length;
    el.setAttribute('data-pc-section', String(idx));
    const t = clean(el.textContent);
    sections.push({ index: idx, name, fp: norm(t).slice(0, 200), chars: t.length, x: Math.max(0, r.left + scrollX), y: r.top + scrollY, width: r.width, height: r.height });
  };
  if (header && visible(header)) add('header', header);
  if (sectionSelectors.length) {
    sectionSelectors.forEach((sel) => [...document.querySelectorAll(sel)].filter(visible).forEach((el, i) => add(`${sel}[${i}]`, el)));
  } else {
    let kids = [...(main || document.body).children].filter((e) => !SKIP.has(e.tagName.toUpperCase()) && e !== header && e !== footer && !e.contains(header || document.createElement('i')) && visible(e));
    for (let depth = 0; depth < 2 && kids.length === 1 && kids[0].children.length > 1; depth++) kids = [...kids[0].children].filter((e) => !SKIP.has(e.tagName.toUpperCase()) && visible(e));
    kids.filter((e) => e.getBoundingClientRect().height >= 40).forEach((el, i) => add(`main-${i + 1}:${describe(el)}`, el));
  }
  if (footer && visible(footer)) add('footer', footer);

  return {
    lang: document.documentElement.lang || '',
    title: document.title || '',
    meta,
    hreflang: [...document.querySelectorAll('link[rel=alternate][hreflang]')].map((l) => ({ lang: l.getAttribute('hreflang'), href: l.href })),
    favicon: !!document.querySelector('link[rel~=icon]'),
    headings,
    blocks,
    images,
    links,
    nav,
    ctas,
    forms,
    jsonld,
    downloads,
    dataLayer: { ...(adobe ? { adobeDataLayer: adobe } : {}), ...(window.digitalData ? { digitalData: dl(window.digitalData) } : {}) },
    a11y: {
      imgNoAlt: live('img:not([alt]):not([role=presentation])').length,
      emptyLinks: live('a[href]').filter((a) => !linkText(a)).length,
      emptyButtons: live('button').filter((b) => !clean(b.textContent) && !b.getAttribute('aria-label') && !b.getAttribute('title')).length,
    },
    pageHeight: document.documentElement.scrollHeight,
    sections,
  };
}

async function settle(page) {
  await page.evaluate(async () => {
    const step = Math.max(300, Math.floor(innerHeight * 0.8));
    for (let y = 0; y < Math.min(document.documentElement.scrollHeight, 60000); y += step) {
      scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    scrollTo(0, 0);
  });
  let last = -1;
  for (let i = 0; i < 4; i++) {
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    if (h === last) break;
    last = h;
    await page.waitForTimeout(250);
  }
  await page
    .evaluate(async () => {
      await document.fonts.ready;
      const pending = [...document.images].filter((i) => !i.complete);
      await Promise.race([Promise.all(pending.map((i) => new Promise((r) => { i.onload = i.onerror = r; }))), new Promise((r) => setTimeout(r, 5000))]);
      scrollTo(0, 0);
    })
    .catch(() => {});
  await page.waitForTimeout(200);
}

/**
 * Loads one URL and returns { snapshot, sections } where each section carries a PNG buffer.
 * Throws an Error with `.blocked` set when the response looks like bot protection.
 */
async function capturePage(browser, url, opts) {
  const { viewport, userAgent, storageState, masks = [], sectionSelectors = [], pacer, timeoutMs = 45000, settleMs = 0 } = opts;
  if (pacer) await pacer.wait(new URL(url).host);
  const context = await browser.newContext({
    viewport,
    userAgent,
    storageState: storageState || undefined,
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      try {
        new PerformanceObserver((list) => {
          const e = list.getEntries();
          window.__pcLcp = e[e.length - 1].startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch (e) {
        // unsupported
      }
    });
    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    const beacons = [];
    const tags = [];
    let mixed = 0;
    page.on('console', (m) => {
      if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) consoleErrors.push(m.text().slice(0, 300));
    });
    page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 300)));
    page.on('response', (r) => {
      if (r.status() >= 400) failedRequests.push({ url: r.url(), status: r.status(), type: r.request().resourceType() });
    });
    page.on('requestfailed', (r) => {
      const failure = r.failure() && r.failure().errorText;
      if (failure && !/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/.test(failure)) failedRequests.push({ url: r.url(), failure, type: r.resourceType() });
    });
    page.on('request', (r) => {
      if (/^http:\/\//.test(r.url()) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(r.url())) mixed++;
      const hit = classifyRequest(r.url(), r.method(), r.postData() || '');
      if (!hit) return;
      if (['launch', 'gtm'].includes(hit.kind)) tags.push(hit);
      else {
        beacons.push(hit);
        tags.push({ kind: hit.kind });
      }
    });

    const response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    const status = response ? response.status() : 0;
    const headers = response ? await response.allHeaders() : {};
    const bodyStart = (await page.content()).slice(0, 8000);
    const blocked = classifyBlock({ status, headers, body: bodyStart });
    if (blocked) throw Object.assign(new Error(`Blocked: ${blocked}`), { blocked });

    const redirects = [];
    for (let req = response && response.request().redirectedFrom(); req; req = req.redirectedFrom()) {
      const rs = await req.response();
      redirects.unshift({ url: req.url(), status: rs ? rs.status() : 0 });
    }

    const timing = await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0];
      return n ? { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), lcp: Math.round(window.__pcLcp || 0) } : {};
    });

    await page.addStyleTag({ content: HIDE_CSS + masks.map((m) => `${m}{visibility:hidden!important}`).join('\n') });
    await settle(page);
    if (settleMs) await page.waitForTimeout(settleMs);

    const extracted = await page.evaluate(extractInPage, { masks, sectionSelectors });
    const { sections: rects, pageHeight, ...rest } = extracted;

    const sections = [];
    for (const s of rects) {
      const png = await page.locator(`[data-pc-section="${s.index}"]`).first().screenshot({ animations: 'disabled', caret: 'hide', timeout: 30000 }).catch(() => null);
      if (png) sections.push({ name: s.name, fp: s.fp, chars: s.chars, height: Math.ceil(s.height), width: Math.ceil(s.width), png });
    }

    const dataLayer = {};
    for (const [k, v] of Object.entries(rest.dataLayer || {})) Object.assign(dataLayer, flattenDataLayer(v, k));

    return {
      snapshot: {
        ...rest,
        dataLayer,
        status,
        finalUrl: page.url(),
        redirects,
        consoleErrors,
        pageErrors,
        failedRequests,
        mixedContent: mixed,
        analytics: { beacons, tags },
        timing,
        pageHeight,
      },
      sections,
    };
  } finally {
    await context.close();
  }
}

module.exports = { launchBrowser, capturePage, extractInPage, loadPlaywright };
