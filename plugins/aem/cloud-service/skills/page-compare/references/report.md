# Report and files

Everything is written under `--out` (default `./page-compare-out`).

```
report.md                 one-page summary at any number of pages: verdict and prioritised action items; start here
issues.md, issues.csv     the work list: every item with its priority and how many pages it affects
pages.csv                 one row per page: result per area, counts, top issue, link to detail
pages/<id>.md             full detail for each page that did not pass
report.html               interactive report with Accept buttons
report.json               full results (same data as the HTML)
summary.csv               one row per pair: status, counts, top finding
pairs/<id>/result.json    stored raw findings, used by --resume
pairs/<id>/visual/        before/after/diff PNGs, only for flagged sections
```

Share the whole output folder: the Markdown files link to screenshots under `pairs/`.

## report.md

The report to hand to a customer or to leadership. Its size does not grow with the number of pages. Top to bottom:

1. **Verdict**, one line: `Not ready: N blockers` (any P1), `Ready after fixes: N major issues` (P2 only), `Incomplete: N pages could not be compared` (pages blocked or failed and nothing blocking found), or `No blocking differences found`, followed by the count of P1, P2 and P3 action items and of items to recheck at launch.
2. **Action items**: one row per problem, not per item. Ten broken images are one row with "How many: 10"; the same broken link on 90 pages is one row "on 90 pages". Columns: `#, Priority, Area, Problem, How many, Example, Likely owner`. Sorted by priority, content before visual before integration, then by reach. At most 15 rows; the rest are in `issues.csv`.
3. **Content differences**: `Before says / After says` for text that says something different on the after page. Changed figures (speeds, sizes, percentages) are bold and marked 🔴. At most 10 rows.
4. **Expected on preview — recheck at launch**: robots.txt, canonical, sitemap and analytics differences on a preview or publish host, which are expected before launch.
5. Area summary (content, visual, integration counted in pages), a note on flaky pages, site-wide checks, **Pages that need attention** (the 10 worst pages, linked to their detail), and for a single page the full page detail.

Every list that is cut says how many rows were left out and which file has them.

### Priorities

| Priority | Meaning | Typical checks |
|---|---|---|
| 🔴 P1 Blocker | Must be fixed before launch. Content is non-negotiable and comes first | changed figures, placeholder text, missing text, missing or broken content images, missing main sections, H1, form fields, page missing or erroring, robots/canonical on a production host |
| 🟠 P2 Major | Should be fixed before launch | rewritten or reworded copy, empty components, missing headings or CTAs, broken links and downloads, large visual differences, slower load, analytics on a production host |
| 🟡 P3 Minor | Polish | navigation and header/footer differences, link targets, alt text changes, small visual shifts, console errors |
| ⚪ Expected | Differs by design on a preview or publish host (`*.aem.page/live`, `*.hlx.page/live`, `author/publish/preview-p…-e….adobeaemcloud.com`) | robots.txt, canonical, sitemap, analytics |

The full map is `priority` in `scripts/lib/rules.js` (check id or `prefix.` → priority). Override it per customer with `--rules`, for example `{"priority": {"nav.item": "P1"}}`. "Likely owner" comes from `owner` in the same file and is a suggestion.

Priority is not severity. Fail / review / info, shown in the page detail and in `report.json`, say how sure a check is that something changed; the priority says how much it matters for the launch.

## issues.md and issues.csv

The work list behind the action items: every item, one row each, highest priority first. Findings with items (broken links, missing headings, console errors) become one row per item; others become one row per finding. Numbers that change on every page load (cache busters such as `?_=1793874404668`, long ids) are ignored when grouping, so the same console error on 300 pages is one row. Info-level findings are not listed.

`issues.csv` columns: `priority, action, severity, area, check, issue, pages_affected, example_page, pages` (up to 20 page paths). `action` is the action item the row belongs to. `issues.md` shows the first 200 rows and points to the CSV for the rest.

## pages.csv and pages/

`pages.csv` has one row per compared page: `page, status, flaky, content, visual, integration, fail, review, p1, p2, p3, top_issue, detail, before, after`. Each area is `pass`, `review`, `fail` or `not compared` (blocked or error); `p1`/`p2`/`p3` count the page's findings by priority. `detail` points to `pages/<id>.md`, which has the page's content parity, visual parity and integration sections with before/after tables and screenshot links. Pages that pass get no detail file.

## report.html

- Summary chips by status, with filter buttons.
- Page-set and site checks: coverage of `--after-sitemap`, redirect results, robots.txt and sitemap findings.
- One collapsible block per pair, worst first. Each finding shows severity, check id, summary, before/after values or items, and screenshots for visual findings.
- **Accept** on a finding copies an `accepted.json` entry to the clipboard. The report is a static file and cannot write to disk; paste the entry into your `accepted.json` and fill in `reason`.
- "Not tested" lists what the run does not cover.

Image links are relative, so keep `report.html` next to the `pairs/` folder when sharing it.

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
