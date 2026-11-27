'use strict';

// Functional parity: the same interactions on the source and destination page, compared.
// Accordions, tabs, carousels, menus and search are used for real (read-only, GET); forms are dry runs:
// fields are filled with test data and submit is clicked, but every non-GET request and every
// navigation the form causes is recorded and aborted, so nothing is ever sent.

const crypto = require('crypto');
const { finding } = require('./content');
const { classifyRequest } = require('./functional');

const MAX_PER_KIND = 8;
const ACTION_WAIT_MS = 700;
const EMPTY_STATE = /no results( found)?|nothing (was )?found|0 results|no matches/i;

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** How a control is matched across pages: its kind and visible label. */
function controlKey(c) {
  return `${clean(c.kind).toLowerCase()}|${clean(c.label).toLowerCase()}`;
}

// In the page: find interactive controls, mark each with data-pc-ctl, and describe them.
function discoverControls({ max, consentSel }) {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const header = document.querySelector('header, [role=banner]');
  const footer = document.querySelector('footer, [role=contentinfo]');
  const regionOf = (el) => (footer && footer.contains(el) ? 'footer' : header && header.contains(el) ? 'header' : 'main');
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter((h) => regionOf(h) === 'main');
  const headingBefore = (el) => {
    let found = '';
    for (const h of headings) {
      if (h.contains(el)) continue;
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) found = clean(h.innerText || h.textContent);
      else break;
    }
    return found;
  };
  const labelOf = (el) => clean(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || '').slice(0, 80);
  for (const el of document.querySelectorAll('[data-pc-ctl]')) el.removeAttribute('data-pc-ctl');
  const out = [];
  const seen = new Set();
  const add = (kind, el, extra = {}) => {
    if (!el || seen.has(el) || (consentSel && el.closest(consentSel)) || !visible(el)) return;
    if (out.filter((c) => c.kind === kind).length >= max) return;
    seen.add(el);
    el.setAttribute('data-pc-ctl', String(out.length));
    const region = regionOf(el);
    out.push({ id: out.length, kind, label: labelOf(el), region, heading: region === 'main' ? headingBefore(el) : '', ...extra });
  };
  for (const el of document.querySelectorAll('input[type=search], [role=search] input:not([type=hidden]):not([type=submit]), input[name=q], input[name*=search i]:not([type=hidden])')) add('search', el);
  for (const form of document.querySelectorAll('form')) {
    if (form.querySelector('[data-pc-ctl]')) continue;
    const fields = [...form.querySelectorAll('input, select, textarea')].filter((e) => !['hidden', 'submit', 'button', 'image', 'reset'].includes((e.getAttribute('type') || '').toLowerCase()));
    const submit = form.querySelector('button[type=submit], input[type=submit], button:not([type])');
    if (submit && fields.length) add('form', submit, { fields: fields.map((e) => e.getAttribute('name') || e.id).filter(Boolean) });
  }
  for (const el of document.querySelectorAll('[role=tab], .cmp-tabs__tab')) if (el.getAttribute('aria-selected') !== 'true') add('tab', el);
  for (const el of document.querySelectorAll('.cmp-carousel__action--next, button[aria-label*="next" i], [role=button][aria-label*="next" i]')) add('carousel', el);
  for (const el of document.querySelectorAll('summary, button[aria-expanded], [role=button][aria-expanded], .cmp-accordion__button')) add(regionOf(el) === 'main' ? 'accordion' : 'menu', el);
  return out;
}

// In the page: fill a form's visible fields with test data.
function fillForm(submit, marker) {
  const form = submit.form || submit.closest('form');
  if (!form) return;
  const set = (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const radios = new Set();
  for (const el of form.querySelectorAll('input, select, textarea')) {
    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset', 'file'].includes(type) || el.disabled || el.readOnly) continue;
    if (type === 'checkbox') el.checked = true;
    else if (type === 'radio') {
      if (!radios.has(el.name)) {
        el.checked = true;
        radios.add(el.name);
      }
    } else if (type === 'select') {
      if (el.options.length > 1) el.selectedIndex = 1;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (type === 'email') set(el, `pc-dryrun-${marker}@example.invalid`);
    else if (type === 'tel' || type === 'number') set(el, '5555555555');
    else if (type === 'url') set(el, `https://example.invalid/pc-dryrun-${marker}`);
    else if (type === 'date') set(el, '2030-01-01');
    else if (type === 'textarea') set(el, `pc-dryrun-${marker} test message, please ignore`);
    else set(el, `pc-dryrun-${marker}`);
  }
}

function pathOfUrl(u) {
  try {
    const x = new URL(u);
    return x.pathname || '/';
  } catch (e) {
    return String(u);
  }
}

const safeDecode = (s) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch (e) {
    return s;
  }
};

/** The field names a request carries (query, form-encoded, multipart or JSON body). Never throws. */
function fieldsOf(request) {
  const out = new Set();
  try {
    for (const k of new URL(request.url()).searchParams.keys()) out.add(k);
  } catch (e) {
    // not a URL
  }
  let body = '';
  try {
    body = request.postData() || '';
  } catch (e) {
    body = '';
  }
  let json = null;
  try {
    json = JSON.parse(body);
  } catch (e) {
    json = null;
  }
  if (json && typeof json === 'object') for (const k of Object.keys(json)) out.add(k);
  else {
    for (const m of body.matchAll(/(?:^|&)([^=&]+)=/g)) out.add(safeDecode(m[1]));
    for (const m of body.matchAll(/name="([^"]+)"/g)) out.add(m[1]);
  }
  return [...out];
}

// Requests a used form may cause, which are blocked (and recorded) once a form has been used on the page.
const SCRIPTED = new Set(['document', 'xhr', 'fetch', 'script', 'ping', 'other', 'eventsource', 'websocket']);

/**
 * The request a form sent, from the requests blocked while it was used: the one carrying the dry-run marker,
 * else one carrying the form's field names, else one to the page's own host. Analytics beacons never count.
 */
function pickSubmit(attempts, formFields = [], pageHost = '') {
  const real = (attempts || []).filter((a) => !a.analytics);
  return real.find((a) => a.marked)
    || real.find((a) => (a.fields || []).some((f) => formFields.includes(f)))
    || real.find((a) => a.host === pageHost)
    || null;
}

// In the page: start watching the control's own component (not the whole page) for changes.
function watchControl(id) {
  const el = document.querySelector(`[data-pc-ctl="${id}"]`);
  if (!el) return null;
  const scopes = [];
  for (const target of String(el.getAttribute('aria-controls') || '').split(/\s+/)) {
    const t = target && document.getElementById(target);
    if (t) scopes.push(t);
  }
  const component = el.closest('[class*="cmp-"], [class*="accordion" i], [class*="carousel" i], [class*="tabs" i], [role=tablist], [role=tabpanel], details, form, nav, header');
  if (component) scopes.push(component);
  else {
    scopes.push(el);
    if (el.nextElementSibling) scopes.push(el.nextElementSibling);
  }
  window.__pcMut = 0;
  if (window.__pcObs) window.__pcObs.disconnect();
  window.__pcObs = new MutationObserver((list) => { window.__pcMut += list.length; });
  for (const sc of scopes) window.__pcObs.observe(sc, { subtree: true, childList: true, attributes: true, characterData: true });
  window.__pcScopes = scopes;
  const text = () => window.__pcScopes.reduce((n, x) => n + (x.innerText || '').length, 0);
  window.__pcText = text;
  return { url: location.href, scopeText: text(), bodyText: document.body.innerText.length };
}

/**
 * Loads `url`, finds its interactive controls and uses each one, returning what happened.
 * Forms are a dry run: test values carry a unique marker; any request carrying it, every non-GET request,
 * and (once a form has been used) every navigation or scripted request, in any frame or popup, is blocked.
 * `term` is the search term (taken from the source page's H1 when not given).
 * @returns {Promise<{term: string, controls: object[]}>}
 */
async function interactPage(browser, url, opts = {}) {
  const { viewport, userAgent, storageState, pacer, timeoutMs = 45000, consentSel = '', hideCss = '', max = MAX_PER_KIND } = opts;
  const marker = crypto.randomBytes(5).toString('hex');
  const context = await browser.newContext({ viewport, ...(userAgent ? { userAgent } : {}), storageState: storageState || undefined, reducedMotion: 'reduce', serviceWorkers: 'block' });
  try {
    const errors = [];
    const failed = [];
    const attempts = [];
    let armed = false;
    let opening = false;
    await context.route('**/*', (route) => {
      const req = route.request();
      const method = req.method();
      let reqUrl = '';
      let body = '';
      try {
        reqUrl = req.url();
        body = req.postData() || '';
      } catch (e) {
        // keep empty
      }
      const marked = reqUrl.includes(marker) || body.includes(marker);
      const type = req.resourceType();
      const block = marked || (method !== 'GET' && method !== 'HEAD') || (armed && !opening && (req.isNavigationRequest() || SCRIPTED.has(type)));
      if (!block) return route.continue().catch(() => {});
      // Block first; recording what was blocked must never let a request through.
      const done = route.abort('blockedbyclient').catch(() => {});
      try {
        let host = '';
        try {
          host = new URL(reqUrl).host;
        } catch (e) {
          host = '';
        }
        attempts.push({ method, host, path: pathOfUrl(reqUrl), fields: fieldsOf(req), marked, analytics: !!classifyRequest(reqUrl, method, body) });
      } catch (e) {
        attempts.push({ method, host: '', path: '', fields: [], marked, analytics: false });
      }
      return done;
    });
    const page = await context.newPage();
    // Popups (target=_blank) are routed like the page and closed at once.
    context.on('page', (p) => {
      if (p !== page) p.close().catch(() => {});
    });
    page.on('pageerror', (e) => errors.push(clean(e.message || e).slice(0, 200)));
    page.on('response', (r) => {
      if (r.status() >= 400) failed.push({ url: r.url(), status: r.status() });
    });

    let baseUrl = '';
    const noHash = (u) => String(u).split('#')[0];
    const baseline = { errors: new Set(), failed: new Set() };
    const open = async () => {
      if (pacer) await pacer.wait(new URL(url).host);
      opening = true;
      try {
        await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      } finally {
        opening = false;
      }
      if (hideCss) await page.addStyleTag({ content: hideCss }).catch(() => {});
      baseUrl = noHash(page.url());
      // Errors and failing requests that happen with nobody touching the page are not blamed on a control.
      await page.waitForTimeout(ACTION_WAIT_MS);
      for (const m of errors) baseline.errors.add(m);
      for (const x of failed) baseline.failed.add(pathOfUrl(x.url));
      return page.evaluate(discoverControls, { max, consentSel });
    };

    let controls = await open();
    const term = opts.term || (await page.evaluate(() => {
      const h1 = document.querySelector('h1');
      const word = ((h1 && h1.innerText) || '').split(/\s+/).find((w) => /^[\p{L}\p{N}-]{4,}$/u.test(w));
      return (word || 'test').toLowerCase();
    }));
    const navigating = new Set(['search', 'form']);
    const order = [...controls.filter((c) => !navigating.has(c.kind)), ...controls.filter((c) => navigating.has(c.kind))];
    const seenKeys = new Map();
    const results = [];

    for (const planned of order) {
      const base = controlKey(planned);
      const nth = (seenKeys.get(base) || 0) + 1;
      seenKeys.set(base, nth);
      if (noHash(page.url()) !== baseUrl) controls = await open().catch(() => []);
      let c = controls.filter((x) => controlKey(x) === base)[nth - 1];
      if (!c) {
        // Some components render late; scroll through the page once and look again.
        await page.evaluate(async () => {
          for (let y = 0; y < Math.min(document.documentElement.scrollHeight, 30000); y += 600) {
            scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 80));
          }
          scrollTo(0, 0);
        }).catch(() => {});
        await page.waitForTimeout(ACTION_WAIT_MS);
        controls = await page.evaluate(discoverControls, { max, consentSel }).catch(() => []);
        c = controls.filter((x) => controlKey(x) === base)[nth - 1];
      }
      const result = { kind: planned.kind, label: planned.label, region: planned.region, heading: planned.heading, responded: false, navigated: false, empty: false, jsErrors: [], failed: [], submit: null };
      results.push(result);
      if (!c) {
        result.skipped = 'control not found after reloading the page';
        result.responded = false;
        continue;
      }
      const loc = page.locator(`[data-pc-ctl="${c.id}"]`).first();
      const before = await page.evaluate(watchControl, c.id).catch(() => null) || { url: page.url(), scopeText: 0, bodyText: 0 };
      const e0 = errors.length;
      const f0 = failed.length;
      const a0 = attempts.length;
      try {
        if (c.kind === 'search') {
          await loc.fill(term, { timeout: 3000 });
          await loc.press('Enter', { timeout: 3000 });
        } else if (c.kind === 'form') {
          await loc.evaluate(fillForm, marker);
          armed = true;
          await loc.click({ timeout: 3000 });
        } else {
          await loc.click({ timeout: 3000 });
        }
      } catch (e) {
        result.error = clean(e.message).split(' Call log')[0].slice(0, 160);
      }
      await page.waitForTimeout(ACTION_WAIT_MS);
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
      const after = await page.evaluate(() => ({
        url: location.href,
        mut: window.__pcMut || 0,
        scopeText: window.__pcText ? window.__pcText() : 0,
        bodyText: document.body.innerText.length,
        body: document.body.innerText.slice(0, 20000),
      })).catch(() => null);
      result.navigated = !!after && noHash(after.url) !== noHash(before.url);
      const changed = !!after && (after.mut > 0 || after.scopeText !== before.scopeText || (c.kind === 'search' && after.bodyText !== before.bodyText));
      result.responded = !result.error && (result.navigated || changed);
      result.empty = c.kind === 'search' && !!after && EMPTY_STATE.test(after.body);
      result.jsErrors = errors.slice(e0).filter((m) => !baseline.errors.has(m));
      result.failed = failed.slice(f0).filter((x) => !baseline.failed.has(pathOfUrl(x.url)));
      if (c.kind === 'form') {
        let host = '';
        try {
          host = new URL(page.url()).host;
        } catch (e) {
          host = '';
        }
        const sent = pickSubmit(attempts.slice(a0), c.fields || [], host);
        result.submit = sent ? { method: sent.method, path: sent.path, fields: sent.fields } : null;
        if (sent) result.responded = true;
      }
    }
    return { term, controls: results };
  } finally {
    await context.close().catch(() => {});
  }
}

const describe = (c) => ({ kind: c.kind, label: c.label, heading: c.heading || '', region: c.region || 'main' });

/** Findings for the destination's interactions against the source's, with how many source controls behave the same. */
function interactionFindings(before, after) {
  const pool = new Map();
  for (const c of (after && after.controls) || []) {
    const k = controlKey(c);
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(c);
  }
  const out = { missing: [], noResponse: [], jsError: [], failed: [], empty: [], notSubmitted: [], endpoint: [], fields: [] };
  let total = 0;
  let ok = 0;
  for (const s of (before && before.controls) || []) {
    if (!s.responded) continue;
    const list = pool.get(controlKey(s));
    const d = list && list.shift();
    // A control the tool could not get at (e.g. it loads late after a reload) is not checked, not failed.
    if (d && d.skipped) continue;
    total++;
    if (!d) {
      out.missing.push(describe(s));
      continue;
    }
    let good = true;
    const formCase = s.kind === 'form' && s.submit;
    if (!d.responded && !formCase) {
      out.noResponse.push({ ...describe(s), error: d.error || 'nothing happened' });
      good = false;
    }
    const newErrors = (d.jsErrors || []).filter((m) => !(s.jsErrors || []).includes(m));
    for (const message of newErrors) out.jsError.push({ ...describe(s), message });
    if (newErrors.length) good = false;
    if ((d.failed || []).length && !(s.failed || []).length) {
      for (const x of d.failed) out.failed.push({ ...describe(s), url: x.url, status: x.status });
      good = false;
    }
    if (s.kind === 'search' && !s.empty && d.empty) {
      out.empty.push({ ...describe(s), term: after.term || before.term });
      good = false;
    }
    if (s.kind === 'form' && s.submit) {
      if (!d.submit) {
        out.notSubmitted.push({ ...describe(s), before: `${s.submit.method} ${s.submit.path}`, after: 'no request' });
        good = false;
      } else {
        if (d.submit.path !== s.submit.path || d.submit.method !== s.submit.method) out.endpoint.push({ ...describe(s), before: `${s.submit.method} ${s.submit.path}`, after: `${d.submit.method} ${d.submit.path}` });
        const missing = (s.submit.fields || []).filter((f) => !(d.submit.fields || []).includes(f));
        if (missing.length) out.fields.push({ ...describe(s), missing });
      }
    }
    if (good) ok++;
  }
  const findings = [];
  const add = (list, check, severity, summary) => {
    if (list.length) findings.push(finding(check, severity, summary(list.length), { items: list }));
  };
  add(out.noResponse, 'interaction.no_response', 'fail', (n) => `${n} control(s) work on the source but do nothing on the destination`);
  add(out.jsError, 'interaction.js_error', 'fail', (n) => `${n} new JavaScript error(s) when using controls on the destination`);
  add(out.empty, 'interaction.search.empty', 'fail', () => 'Search returns results on the source but none on the destination');
  add(out.notSubmitted, 'interaction.form.not_submitted', 'fail', (n) => `${n} form(s) submit on the source but not on the destination`);
  add(out.missing, 'interaction.control.missing', 'review', (n) => `${n} interactive control(s) from the source are not on the destination`);
  add(out.failed, 'interaction.request.failed', 'review', (n) => `${n} request(s) fail when using controls on the destination`);
  add(out.endpoint, 'interaction.form.endpoint', 'review', (n) => `${n} form(s) send to a different address on the destination`);
  add(out.fields, 'interaction.form.fields', 'review', (n) => `${n} form(s) send fewer fields on the destination`);
  return { findings, total, ok };
}

module.exports = { interactPage, interactionFindings, controlKey, discoverControls, fieldsOf, pickSubmit, EMPTY_STATE };
