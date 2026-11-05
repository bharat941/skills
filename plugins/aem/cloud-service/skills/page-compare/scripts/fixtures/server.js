'use strict';

// One local server plays both sites: 127.0.0.1 is "before", localhost is "after".
const http = require('http');
const { PNG } = require('pngjs');

const png = (() => {
  const p = new PNG({ width: 40, height: 40 });
  p.data.fill(180);
  for (let i = 3; i < p.data.length; i += 4) p.data[i] = 255;
  return PNG.sync.write(p);
})();

const PARA = [
  'Our enterprise platform gives marketing teams a single place to plan, build and measure campaigns across every channel.',
  'Customers choose the plan that fits their team size, and can change it at any time without losing historical reporting data.',
  'The onboarding specialists walk through data import, permission setup and the first dashboard in a one hour session.',
  'Security reviews cover single sign on, audit logging, data residency options and the yearly penetration test summary.',
  'Support is available around the clock with a four hour response target for priority incidents and a named account manager.',
];

function sec(i, text, extra = '') {
  return `<section class="s${i}"><h2>Section ${i}</h2><p>${text}</p>${extra}</section>`;
}

function doc({ title = 'Product overview', body, head = '', script = '', nav = '<a href="/">Home</a><a href="/about">About</a>' }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="A product page"><link rel="canonical" href="/p">${head}</head><body><header><nav>${nav}</nav></header><main><div><h1>${title}</h1>${body}</div></main><footer><p>Copyright example company</p></footer>${script}</body></html>`;
}

const standard = (n = 5, extra = '') => PARA.slice(0, n).map((t, i) => sec(i + 1, t)).join('') + extra;
const base = () => doc({ body: standard() });

// Each entry: { before, after } where a value is html, or { status, html, headers, onRequest(count) }.
const scenarios = {
  '/identical': { before: base(), after: base() },
  '/text-removed': { before: base(), after: doc({ body: standard(2) }) },
  '/alt-changed': {
    before: doc({ body: standard(3, '<img src="/img.png" alt="Team photo" width="40" height="40">') }),
    after: doc({ body: standard(3, '<img src="/img.png" alt="Picture" width="40" height="40">') }),
  },
  '/link-retargeted': {
    before: doc({ body: standard(3, '<a href="/about">Learn more</a>') }),
    after: doc({ body: standard(3, '<a href="/other">Learn more</a>') }),
  },
  '/gone': { before: base(), after: { status: 404, html: '<html><body>Not found</body></html>' } },
  '/js-error': { before: base(), after: doc({ body: standard(), script: '<script>setTimeout(function(){ throw new Error("boom after migration"); }, 50);</script>' }) },
  '/section-added': { before: base(), after: doc({ body: standard(5, sec(6, 'A brand new section about sustainability commitments and annual reporting goals for the company.')) }) },
  '/volatile': {
    before: doc({ body: standard(5, '<p class="rand">Visitors today <span id="n"></span></p>'), script: '<script>document.getElementById("n").textContent=Math.floor(Math.random()*1e9)+" random visitors "+Math.random();</script>' }),
    after: doc({ body: standard(5, '<p class="rand">Visitors today <span id="n"></span></p>'), script: '<script>document.getElementById("n").textContent=Math.floor(Math.random()*1e9)+" random visitors "+Math.random();</script>' }),
  },
  '/accepted': { before: base(), after: doc({ body: standard(2) }) },
  '/color-change': {
    before: base(),
    after: doc({ body: standard(), head: '<style>.s2{background:#ff3b3b;color:#fff}</style>' }),
  },
  '/hidden-tab': {
    before: doc({ body: standard(5, '<div class="tab" style="display:none"><p>Pricing details are listed in the second tab of this component for every region.</p></div>') }),
    after: doc({ body: standard(5) }),
  },
  '/blocked': {
    before: base(),
    after: { status: 403, headers: { 'cf-ray': 'abc123', server: 'cloudflare' }, html: '<html><body><h1>Attention Required</h1><p>Verify you are human</p></body></html>' },
  },
  '/flaky': { before: base(), after: { flaky: true, html: base() } },
  '/analytics': {
    before: doc({ body: standard(), script: '<script>fetch("/b/ss/prodsuite/1/JS-2.0/s1?pageName=home&rsid=prodsuite").catch(function(){});</script>' }),
    after: doc({ body: standard(), script: '<script>fetch("/b/ss/stagesuite/1/JS-2.0/s1?pageName=home-new&rsid=stagesuite").catch(function(){});</script>' }),
  },
  '/redirect': { before: base(), after: { status: 302, headers: { location: '/identical' } } },
};

const statics = { '/': 'Home', '/about': 'About us', '/other': 'Other page' };

function start() {
  const counts = new Map();
  const server = http.createServer((req, res) => {
    const host = (req.headers.host || '').startsWith('127.0.0.1') ? 'before' : 'after';
    const url = new URL(req.url, 'http://x');
    const key = `${host}:${url.pathname}`;
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);

    if (url.pathname === '/img.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(png);
    }
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nAllow: /\n');
    }
    if (url.pathname.startsWith('/b/ss/')) {
      res.writeHead(200, { 'content-type': 'image/gif' });
      return res.end('GIF89a');
    }
    if (statics[url.pathname]) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(doc({ title: statics[url.pathname], body: sec(1, PARA[0]) }));
    }
    const sc = scenarios[url.pathname];
    if (!sc) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<html><body>Not found</body></html>');
    }
    let entry = sc[host];
    if (typeof entry === 'string') entry = { status: 200, html: entry };
    if (entry.flaky) {
      if (n === 1) {
        res.writeHead(500, { 'content-type': 'text/html' });
        return res.end('<html><body>oops</body></html>');
      }
      entry = { status: 200, html: entry.html };
    }
    res.writeHead(entry.status || 200, { 'content-type': 'text/html', ...(entry.headers || {}) });
    res.end(entry.html);
  });
  return new Promise((resolve) => server.listen(0, '::', () => resolve({ server, port: server.address().port })));
}

module.exports = { start, scenarios, doc, standard, PARA };
