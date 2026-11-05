# Checks reference

Every finding has a `check` id, a severity (`fail`, `review`, `info`) and, where useful, `before`/`after` values or a list of `items`. Check ids are what `accepted.json` entries match on; a prefix matches all checks below it (`content.text` covers `content.text.missing`, `content.text.changed`, ...).

Thresholds live in `scripts/lib/rules.js` and can be overridden with `--rules file.json`.

## Page status and redirects

| Check | Severity | Meaning |
|---|---|---|
| `page.missing` | fail | Before page loads, after page returns 404/410 |
| `http.status` | fail / review | After page returns a non-2xx status (review when the before page failed too) |
| `http.before` | review | Before page is not 2xx, so nothing can be compared |
| `redirect.chain` | review | After URL needs more than 3 redirects |
| `redirect.temporary` | review | After URL redirects with 302/303/307 |
| `redirect.target` | info | After URL ends on a different path |

When either page is not 2xx, the remaining checks are skipped for that pair.

## Content

| Check | Severity | Meaning |
|---|---|---|
| `content.text.missing` | fail above 10% of before text lost, otherwise review | Text blocks on before that have no match on after. Blocks hidden on load (tabs, accordions) are included and flagged `hidden` |
| `content.text.changed` | review | Reworded text (85% or more similar) |
| `content.text.added` | review above 2% of before text, otherwise info | New text on after |
| `content.text.format` | info | Same words, different spacing |
| `heading.missing` / `heading.level` / `heading.added` | review / review / info | Heading text and level changes |
| `meta.title`, `meta.description`, `meta.canonical`, `meta.robots`, `meta.lang`, `meta.hreflang`, `meta.social`, `meta.favicon` | fail or review | Head metadata. A missing title, a canonical pointing to the wrong host and `noindex` appearing are fails. On an Edge Delivery preview host (`*.aem.page`/`.live`, `*.hlx.page`/`.live`) a canonical that still points to production is review, since preview pages keep it by design |
| `consent.missing` | review | A cookie consent banner (OneTrust, Cookiebot, TrustArc, ...) is on the before page but not on the after page. Consent dialogs are otherwise left out of every content check and screenshot, so their headings, buttons and logos never show up as missing content |
| `image.missing`, `image.broken` | fail | Content images missing or failing to load |
| `image.alt`, `image.alt.changed` | review | Alt text lost or changed |
| `image.missing.chrome`, `image.broken.chrome` | review | Same, for header/footer images |
| `link.missing`, `link.target`, `link.added` | review / review / info | Links compared after mapping before hosts and paths to the after site |
| `nav.item` | fail | Navigation entry missing |
| `cta.missing` | review | Button or call-to-action label missing |
| `form.field.missing` | fail | A form field present before is gone |
| `form.field.changed`, `form.action` | review | Field type, label or required flag changed; form action changed |
| `jsonld.type` | fail | Structured data type missing |

Text that differs between two loads of the before page (for example a counter) is treated as volatile and ignored. If more than 5% of the text is volatile the page is `flaky`.

## Visual

Pages are split into sections (header, footer, and the children of `main`; override with `--sections`). Sections are paired by text, then by order, and compared at each viewport. The before page is loaded twice; pixels that differ between those loads are masked out of the comparison. A section whose text differs between the two before loads (rotating testimonials, carousels) is paired by its position name instead of its text and compared with that mask, so it is never reported as missing. A section with the same name and the same opening words (usually its heading) on both pages is also treated as the same section with changed content, so a carousel that starts on a different slide is a visual difference with screenshots, not a missing section. Add `--mask <selector>` for carousels to leave them out entirely. One-pixel shifts caused by content above a section are tolerated.

| Check | Severity | Meaning |
|---|---|---|
| `visual.section` | review above 1% pixels changed, fail above 5% | Sections that look different (diff image saved) |
| `visual.section.missing` | fail when the section has 20 or more characters of text or is 200px or taller, otherwise review | Section on before with no match on after |
| `visual.section.added` | info | New section on after |
| `visual.height` | review | Section height changed by more than 10% |
| `visual.unstable` | review | The before page changes 15% or more between two loads; the page is marked `unstable` and pixels are not compared |

Whole-page height differences are reported per section, not as a pixel diff of the whole page.

## Functional

| Check | Severity | Meaning |
|---|---|---|
| `js.error` | fail | New uncaught JavaScript error on after |
| `console.error` | review | New console error on after |
| `resource.missing` | fail | CSS, JS or font request fails on after and not on before |
| `request.failed` | review | Other new failed requests |
| `request.mixed` | review | More insecure (http) requests |
| `perf.load`, `perf.lcp` | review | Load or LCP at least 1.5x and 1000 ms slower |
| `a11y.delta` | review | More images without alt, empty links or empty buttons |
| `download.broken` / `download.changed` | fail / review | Linked PDFs and other downloads that do not resolve, or changed type or size (over 20%) |
| `link.broken` | fail | Internal links on after that return an error (up to 50 checked per page). Links already broken on before are `link.broken.preexisting` (info) |

## Analytics

Compared from the requests a page load makes and from `adobeDataLayer` / `digitalData`.

| Check | Severity | Meaning |
|---|---|---|
| `analytics.tag` | fail / review | Tag manager (Launch, GTM) or analytics requests lost |
| `analytics.beacon` | fail | No page-view beacon fired on after |
| `analytics.rsid`, `analytics.datastream`, `analytics.ga4` | review | Report suite, datastream or measurement ID differs |
| `analytics.pagename`, `analytics.channel` | review | Adobe Analytics values differ |
| `analytics.launch` | review | Launch library differs |
| `analytics.expected` | fail | Value differs from `--expect-analytics` |
| `analytics.datalayer.keys` / `.values` | fail or review | Data layer keys missing, or values differ |

Not covered: interaction events (clicks, form submits), consent behaviour, and whether data reaches reporting.

## Site level (once per run)

| Check | Severity | Meaning |
|---|---|---|
| `site.robots` | fail / review | After robots.txt disallows everything, or is missing when before has one. Review instead of fail on an Edge Delivery preview host, where blocking crawlers is by design |
| `site.sitemap` | review | sitemap.xml missing on after |
| `redirect.wrong` / `redirect.temporary` | fail / review | From `--redirects`: before URL does not redirect to the expected target, or uses a temporary redirect |
| Page-set coverage | shown in summary | With `--after-sitemap`: after pages not in the compared set |

## Not tested

Form submission, login flows, search, carousels and tabs beyond what is in the initial DOM, cross-browser rendering, security headers, SEO ranking, and analytics interaction events.
