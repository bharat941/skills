# Report and files

Everything is written under `--out` (default `./page-compare-out`).

```
report.html               the report to share: self-contained (inline CSS, screenshots embedded, no scripts)
report.md                 the same report as text, about 80 lines at any number of pages; start here
fixes.json                the fix list for agents: every fix with id, where, source and destination values, fix type
issues.csv                one row per fix, same ids as fixes.json
pages.csv                 one row per page: result per area, parity, P1/P2/P3 counts, link to detail
pages/<id>.md             the report for one page (multi-page runs, pages that did not pass)
review.html               interactive page with Accept buttons for intended differences
report.json               full results (raw findings, used by review.html)
pairs/<id>/result.json    stored raw findings, used by --resume
pairs/<id>/visual/        source/destination/diff PNGs, only for flagged sections
```

`report.html` can be emailed on its own: the first 12 screenshots are embedded and later ones link to `pairs/`. Keep the folder together when sharing the Markdown files, which link to screenshots under `pairs/`.

## Fixes

Every view renders the same fix list. A fix is one section of a page (or of a template, across pages) with one cause:

| Findings | One fix per | Title |
|---|---|---|
| Missing, reworded, rewritten text, changed figures, placeholder or empty-state text, missing images | heading the text sits under (else its component, else "Main content") | `FAQs: 6 text block(s) missing`, `Key features: figures changed (32gb → 64gb)` |
| Images that fail to load, failed requests, image alt changes | first two path segments of the destination URL | `Files under img.example.com/dev/image/ fail to load (11)` |
| Broken internal links | target URL | `Link to / returns 404 (17 link(s))` |
| Navigation items, header/footer text and images | header or footer | `Header: 138 item(s) missing` (P3) |
| Visual sections (all viewports together) | section | `Section root-container looks different (12.5% of pixels)` |
| Everything else | check | the finding's summary |

The fix id is the area letter (`C` content, `V` visual, `I` integration) and 8 hex characters of a hash of that scope. It does not include the page, so the same problem keeps its id when it appears on more or fewer pages, and across runs.

`fixes.json` is `{ generatedAt, source, destination, verdict, parity, fixes, fixed, notRechecked, accepted }`. Each fix: `id, priority, area, title, section, component, fixType (content | code | config), owner, checks, pages [{ source, destination }], siteWide, count, expected, actual, items (up to 50, each with its page), truncated, evidence { before, after, diff }` (visual fixes) and, with `--baseline`, `status` (`new` or `open`). `fixed`, `notRechecked` and `accepted` list the earlier run's fixes whose ids are gone (see `--baseline`). For placeholder, empty-state and new text, `expected` is empty and `actual` is the text found on the destination.

**Parity:** content parity is 100 minus the share of source text missing on the destination; visual parity is the share of source sections (at every viewport) that match. The run value is the mean over compared pages; a page that could not be compared has none.

## report.md and report.html

Same order and ids in both:

1. Title with **Source** and **Destination** (URLs for one page, hosts for many), date, pages, viewports.
2. **Verdict**: `Not ready: N blockers` (any P1), `Ready after fixes: N major issues` (P2 only), `Incomplete: N pages could not be compared`, `Nothing compared`, or `No blocking differences found`; then, with `--baseline`, `Since <date>: P1 6 → 2, 4 fixed, 0 new.`
3. **Scorecard**: Content, Visual, Integration & SEO with parity and P1/P2/P3 counts.
4. **Content parity**, **Visual parity**, **Integration & SEO**: P1 and P2 fixes (report.md: at most 10 per area as a table `ID, Priority, Section, Problem, Source says, Destination says, Fix type`; report.html: cards with the values side by side, or source / destination / diff screenshots for visual fixes), then P3 fixes in one line (collapsed in report.html). Changed figures are bold (highlighted in HTML). A single-page run adds a **Metadata** table (`Property, Source, Destination, Match`); Integration adds **Broken links** (`Status, Link, Link text`).
5. **Expected on preview — recheck at launch**.
6. **Fixed since last run** (with `--baseline`).
7. **Pages with most blockers** (multi-page runs, top 10, linked to `pages/<id>.md`).
8. **For agents**: where to start and the file list.

Human-facing text never shows check ids or internal fields; those are in `fixes.json`. Every list that is cut says how many were left out and which file has them.

### Priorities

| Priority | Meaning | Typical checks |
|---|---|---|
| 🔴 P1 Blocker | Must be fixed before launch. Content is non-negotiable and comes first | changed figures, placeholder text, missing main-content text, missing or broken content images, missing main sections, H1, form fields, page missing or erroring; on a production host: noindex, `Disallow: /`, canonical pointing to another host |
| 🟠 P2 Major | Should be fixed before launch | rewritten or reworded copy, empty components, missing headings or CTAs, broken links and downloads, large visual differences, slower load; on a production host: analytics and other robots/canonical changes |
| 🟡 P3 Minor | Polish | navigation, missing header/footer text and sections, link targets, alt text changes, small visual shifts, console errors |
| ⚪ Expected | Differs by design on a preview or publish host (`*.aem.page/live`, `*.hlx.page/live`, `author/publish/preview-p…-e….adobeaemcloud.com`) | robots.txt, canonical, sitemap, analytics |

Missing text in the header or footer is its own P3 fix; missing main-content text is P1. The full map is `priority` in `scripts/lib/rules.js` (check id or `prefix.` → priority, `{ preview, production }` per host type, and `{ fail, review }` per severity). Override it per customer with `--rules`, for example `{"priority": {"nav.item": "P1"}}`. "Likely owner" comes from `owner` in the same file and is a suggestion.

Priority is not severity. Fail / review / info, shown in the page detail and in `report.json`, say how sure a check is that something changed; the priority says how much it matters for the launch.

## issues.csv

One row per fix: `fix_id, priority, area, section, fix_type, owner, problem, how_many, pages_affected, source_value, destination_value, example_page, pages` (up to 20 page paths). Every cell that starts with a formula character is prefixed with `'`.

## pages.csv and pages/

`pages.csv` has one row per compared page: `page, status, flaky, content, visual, integration, fail, review, p1, p2, p3, content_parity, visual_parity, top_issue, detail, before, after`. Each area is `pass`, `review`, `fail` or `not compared` (blocked or error); `p1`/`p2`/`p3` count the page's findings by priority. `content_parity` and `visual_parity` are the page's percentages. `detail` points to `pages/<id>.md`, the report for that one page (source and destination, verdict, its fixes). Pages that pass, and single-page runs, get no detail file.

## review.html

- Summary chips by status, with filter buttons.
- Page-set and site checks: coverage of `--after-sitemap`, redirect results, robots.txt and sitemap findings.
- One collapsible block per pair, worst first. Each finding shows severity, check id, summary, before/after values or items, and screenshots for visual findings.
- **Accept** on a finding copies an `accepted.json` entry to the clipboard. The page is a static file and cannot write to disk; paste the entry into your `accepted.json` and fill in `reason`.

## --baseline

`--baseline <dir>` reads `<dir>/fixes.json` from an earlier run (the earlier `--out` folder). Current fixes whose id is in it are `open`, others `new`. An earlier fix whose id is gone is **fixed** only when every page it was on was compared in this run; if some of its pages were not compared (a rerun of a subset, or a blocked page) it is **not rechecked**, and if the difference was accepted it is **accepted**. Page files in a multi-page run do not repeat the run-wide progress. A missing or invalid `fixes.json` stops the run with exit code 2 before any page loads.

## accepted.json

A JSON array. `reason` is required.

```json
[
  { "page": "/en/products/*", "check": "content.text.missing", "match": "Legacy banner", "reason": "Banner retired in the redesign" },
  { "check": "visual", "page": "/en/campaign/*", "reason": "New campaign layout" },
  { "from": "/content/site/en", "to": "/en", "reason": "Path structure changed" }
]
```

- `page`: glob on the page path (default `*`); matches the after or before path.
- `check`: a check id or prefix (`visual` matches all `visual.*`).
- `match`: only accept items whose text contains this string. Other items on the same finding stay open.
- `from`/`to`: link rewrite applied before diffing links, for path changes that are intended.

Accepted findings stay visible but greyed out and no longer count towards `fail`/`review`. A page passes when it has no unaccepted fail or review findings.

Apply with `--resume --accept accepted.json`; stored captures are reused.

## Status and exit code

Priority when a page has several: `blocked`, `error`, `fail`, `flaky`, `unstable`, `review`, `pass`. Exit code is `1` when any page is `fail`, `error` or `blocked`.

## Running at scale

- About nine page loads per pair (before twice and after, at three viewports). The original sizing estimate was roughly 25 to 30 minutes per 100 pairs at the default concurrency, but that has not been measured on a large run: time a `--limit 10` run first and extrapolate. `--noise-sample 20%` runs the second before load on a fifth of the pages.
- Requests to each host are spaced by `--pace-ms`. If more than 20% of a host's pages (after at least five) are blocked, the run stops loading that host and reports the rest as blocked.
- A page that loads only after a retry is marked `flaky` rather than hidden.
- `--per-group <n>` keeps n pages per template or section (the CSV `group` column, else the first path segment of the before URL after any `/content/<site>` prefix and locale such as `/en/` or `/en-us/`; two-letter sections are read as locales, so use a `group` column when a site has them). A sample of 2 per group usually surfaces every template-level issue.
- `--resume` reuses captured pages and retries pages that were blocked or errored.
- The report stays readable at any size: `report.md` is a fixed-size summary, and the per-page detail lives in `pages.csv` and `pages/`.
