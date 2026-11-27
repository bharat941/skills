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

const CSS_BLOCK = '.preload-screen,.hero-preloader{position:absolute;inset:0;background:#000;z-index:100;display:flex;align-items:center;justify-content:center;transition:opacity .5s ease}.hero-preloader .bar{width:40%;height:2px;background:#fff;animation:none}.hero-preloader.done{opacity:0;pointer-events:none}';

// Each entry: { before, after } where a value is html, or { status, html, headers, onRequest(count) }.
// Interactive page: works on "before", broken on "after" (accordion has no script, a tab throws,
// search finds nothing, the lead form never submits). The search page answers both.
const INTERACTIVE = (after) => doc({
  body: standard(2, `<h2>FAQs</h2>
<button class="cmp-accordion__button" aria-expanded="false" aria-controls="p1" id="a1">What does the platform do?</button>
<div id="p1" hidden><p>It plans, builds and measures campaigns.</p></div>
<div role="tablist"><button role="tab" aria-selected="true">Overview</button><button role="tab" aria-selected="false" id="t2">Specifications</button></div>
<div id="tp">Overview panel</div>
<form role="search" action="/search" method="get"><input type="search" name="q" aria-label="Search"><button type="submit">Go</button></form>
<h2>Contact us</h2>
<form id="lead" ${after ? '' : 'action="/api/lead" method="post"'}><input name="email" type="email" required aria-label="Email"><input name="company" aria-label="Company"><button type="submit">Send</button></form>`),
  script: after
    ? '<script>document.getElementById("t2").onclick=function(){throw new Error("tab handler broken after migration")};document.getElementById("lead").onsubmit=function(e){e.preventDefault()};</script>'
    : '<script>var a1=document.getElementById("a1"),p1=document.getElementById("p1"),t2=document.getElementById("t2");a1.onclick=function(){var o=a1.getAttribute("aria-expanded")==="true";a1.setAttribute("aria-expanded",String(!o));p1.hidden=o};t2.onclick=function(){document.getElementById("tp").textContent="Specifications panel";t2.setAttribute("aria-selected","true")};</script>',
});

// Forms that must never reach /trap/: new-tab POST and GET, a GET into an iframe, a JS GET fetch, JSONP, and a late submit.
const DRYRUN = doc({
  body: standard(1, `<h2>Forms</h2>
<form action="/trap/blank-post" method="post" target="_blank"><input name="email" type="email" aria-label="E1"><button type="submit">Send one</button></form>
<form action="/trap/blank-get" method="get" target="_blank"><input name="g" aria-label="E2"><button type="submit">Send two</button></form>
<iframe name="sink" style="width:10px;height:10px"></iframe>
<form action="/trap/iframe-get" method="get" target="sink"><input name="i" aria-label="E3"><button type="submit">Send three</button></form>
<form id="f4"><input name="email" type="email" aria-label="E4"><button type="submit">Send four</button></form>
<form id="f5"><input name="email" type="email" aria-label="E5"><button type="submit">Send five</button></form>
<form id="f6" action="/trap/late" method="get"><input name="l" aria-label="E6"><button type="submit">Send six</button></form>`),
  script: `<script>
document.getElementById('f4').onsubmit=function(e){e.preventDefault();fetch('/trap/fetch-get?email='+encodeURIComponent(this.email.value))};
document.getElementById('f5').onsubmit=function(e){e.preventDefault();var s=document.createElement('script');s.src='/trap/jsonp?email='+encodeURIComponent(this.email.value);document.body.appendChild(s)};
document.getElementById('f6').onsubmit=function(e){e.preventDefault();var f=this;setTimeout(function(){f.submit()},4500)};
</script>`,
});

// Background activity unrelated to the control: a ticker that changes every 150 ms (before only) and a recurring error (after only).
const NOISY = (after) => doc({
  body: standard(1, `<p id="tick">0</p><h2>FAQ</h2><button aria-expanded="false" id="dead">Dead question</button>
<button aria-expanded="false" id="live" aria-controls="lp">Live question</button><div id="lp" hidden><p>Live answer text.</p></div>`),
  script: `<script>
var live=document.getElementById('live');live.onclick=function(){live.setAttribute('aria-expanded','true');document.getElementById('lp').hidden=false};
${after ? "setInterval(function(){throw new Error('recurring background error')},250);" : "setInterval(function(){var t=document.getElementById('tick');t.textContent=String(+t.textContent+1)},150);"}
</script>`,
});

const scenarios = {
  '/dryrun': { before: DRYRUN, after: DRYRUN },
  '/noisy': { before: NOISY(false), after: NOISY(true) },
  '/start': { before: { status: 301, html: '', headers: { location: '/interactive' } }, after: { status: 301, html: '', headers: { location: '/interactive' } } },
  '/interactive': { before: INTERACTIVE(false), after: INTERACTIVE(true) },
  '/search': {
    before: doc({ title: 'Search', body: '<ul class="results"><li>Platform overview</li><li>Platform pricing</li></ul>' }),
    after: doc({ title: 'Search', body: '<p class="empty">No results found</p>' }),
  },
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
  '/consent': {
    before: doc({ body: standard(), script: '<div id="onetrust-consent-sdk"><div id="onetrust-banner-sdk"><h2>Privacy Preference Center</h2><img src="/img.png" alt="Company Logo" width="40" height="40"><a href="/about">More information</a><button>Accept All Cookies</button></div></div>' }),
    after: base(),
  },
  '/rotating': { before: { rotate: true }, after: { rotate: true } },
  // AEM 6.5 style: sections two single-child wrappers deep (gm.com: .gbs-page-body > .par.parsys > sections)
  '/wrapped': { before: page(`<div class="page-body"><div class="parsys"><h1>Product overview</h1>${standard()}</div></div>`), after: base() },
  // a section that carries a long inline <style> must be fingerprinted by its visible text, not its CSS
  '/inline-style': { before: page(`<div><h1>Product overview</h1><section class="s1"><style>${CSS_BLOCK}</style><h2>Section 1</h2><p>${PARA[0]}</p></section>${PARA.slice(1).map((t, i) => sec(i + 2, t)).join('')}</div>`), after: base() },
};

// Same head, header and footer as doc(), with the main content given as raw markup.
function page(mainHtml) {
  return doc({ body: '' }).replace(/<main>[\s\S]*<\/main>/, `<main>${mainHtml}</main>`);
}

const TESTIMONIALS = [
  'Great guidance and clean execution. The team explained the full process clearly and the supervisor guided us on every colour decision.',
  'Professional, clean and seamless. They stood out with execution excellence and design support that truly brought our vision alive.',
];
const rotating = (n) => doc({ body: standard(4, `<section class="quotes"><h2>What our clients say</h2><p>${TESTIMONIALS[n % 2]}</p></section>`) });

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
    if (entry.rotate) entry = { status: 200, html: rotating(n) };
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
