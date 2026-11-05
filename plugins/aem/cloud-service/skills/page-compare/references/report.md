# Report and files

Everything is written under `--out` (default `./page-compare-out`).

```
report.html          single static report; open in a browser
report.json          full results (same data as the HTML)
summary.csv          one row per pair: status, counts, top finding
pairs/<id>/result.json    stored raw findings, used by --resume
pairs/<id>/visual/        before/after/diff PNGs, only for flagged sections
```

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
