'use strict';

// Pacing, concurrency, retries and bot-protection detection. No browser dependency.

function createPacer(paceMs, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const next = new Map();
  return {
    async wait(host) {
      if (!paceMs) return;
      const t = now();
      const slot = Math.max(t, next.get(host) || 0);
      next.set(host, slot + paceMs);
      if (slot > t) await sleep(slot - t);
    },
  };
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let index = 0;
  async function lane() {
    while (index < items.length) {
      const i = index++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane));
  return results;
}

const WAF_HEADERS = ['cf-ray', 'cf-mitigated', 'x-akamai-request-id', 'akamai-grn', 'x-amz-cf-id', 'x-amzn-waf-action', 'x-sucuri-id', 'x-iinfo', 'x-datadome', 'x-px'];
const CHALLENGE_BODY = /captcha|access denied|attention required|verify you are (a )?human|bot (detection|protection)|request unsuccessful|pardon our interruption|checking your browser|unusual traffic|just a moment\.\.\./i;

// Returns a short reason string when the response looks like bot protection, else null.
function classifyBlock({ status, headers = {}, body = '' }) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const server = (lower.server || '').toLowerCase();
  const wafSignal = WAF_HEADERS.find((h) => h in lower) || (/(akamaighost|cloudflare|awselb|sucuri|imperva|incapsula)/.test(server) ? `server: ${server}` : '');
  if (status === 429) return 'HTTP 429 (rate limited)';
  if ([403, 503].includes(status) && (wafSignal || CHALLENGE_BODY.test(body))) {
    return `HTTP ${status} with bot-protection signal (${wafSignal || 'challenge page'})`;
  }
  if (status === 200 && body.length < 4000 && /captcha|verify you are (a )?human|checking your browser/i.test(body)) {
    return 'challenge page served with HTTP 200';
  }
  return null;
}

function isRetryable(err) {
  return /timeout|net::|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|HTTP 5\d\d/i.test(String((err && err.message) || err));
}

async function withRetry(fn, { retries = 1 } = {}) {
  let retried = false;
  for (let attempt = 0; ; attempt++) {
    try {
      const value = await fn(attempt);
      return { value, retried };
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw Object.assign(err, { retried });
      retried = true;
    }
  }
}

module.exports = { createPacer, runPool, classifyBlock, isRetryable, withRetry };
