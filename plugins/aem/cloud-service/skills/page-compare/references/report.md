# Report and files

Everything is written under `--out` (default `./page-compare-out`).

```
report.md                 one-page summary at any number of pages; start here
issues.md, issues.csv     every distinct issue once, with how many pages it affects
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

The report to hand to a customer. Its size does not grow with the number of pages:

- Overall result, pages compared by status, and a summary table per area (**content parity**, **visual parity**, **integration**) counted in pages: failing, to review, passing, plus site-wide issues.
- **Top issues**: the 10 most important distinct issues, each with the number of pages it affects and an example page.
- A note when pages are flaky (text changes between loads), so their findings are read with care.
- Site-wide checks: robots.txt, sitemap, redirects, page-set coverage.
- **Pages that need attention**: the 10 worst pages with a link to their detail file.
- For a single page, the full page detail follows inline.

Every list that is cut says how many rows were left out and which file has them.

## issues.md and issues.csv

Open fail and review findings from all pages are grouped into issues. Findings with items (broken links, missing headings, console errors) become one issue per item; others become one issue per finding. Numbers that change on every page load (cache busters such as `?_=1793874404668`, long ids) are ignored when grouping, so the same console error on 300 pages is one issue. Info-level findings are not listed.

`issues.csv` columns: `severity, area, check, issue, pages_affected, example_page, pages` (up to 20 page paths). `issues.md` shows the first 200 issues and points to the CSV for the rest.

## pages.csv and pages/

`pages.csv` has one row per compared page: `page, status, flaky, content, visual, integration, fail, review, top_issue, detail, before, after`. Each area is `pass`, `review`, `fail` or `not compared` (blocked or error). `detail` points to `pages/<id>.md`, which has the page's content parity, visual parity and integration sections with before/after tables and screenshot links. Pages that pass get no detail file.

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

- About nine page loads per pair (before twice and after, at three viewports): roughly 25 to 30 minutes per 100 pairs at the default concurrency. `--noise-sample 20%` runs the second before load on a fifth of the pages.
- Requests to each host are spaced by `--pace-ms`. If more than 20% of a host's pages (after at least five) are blocked, the run stops loading that host and reports the rest as blocked.
- A page that loads only after a retry is marked `flaky` rather than hidden.
- `--per-group <n>` keeps n pages per template or section (the CSV `group` column, else the first path segment of the before URL). A sample of 2 per group usually surfaces every template-level issue.
- `--resume` reuses captured pages and retries pages that were blocked or errored.
- The report stays readable at any size: `report.md` is a fixed-size summary, and the per-page detail lives in `pages.csv` and `pages/`.
