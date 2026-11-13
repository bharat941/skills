---
name: page-compare
description: "[BETA] Compares a live \"before\" page with its \"after\" counterpart (or 100+ pairs from a CSV, Excel sheet or sitemap) after an AEM migration or redesign, and produces a static HTML report. Checks content (text, headings, meta, images, links, forms, structured data), visual differences per section at several viewports with a noise baseline, and functional signals (JavaScript and console errors, failed assets, load timing, accessibility deltas, Adobe Analytics / Web SDK / GA4 / Launch values), plus downloads, broken links, redirects, robots.txt and page-set coverage. Use when the user asks to compare two URLs, validate a migrated site against the live one, QA before and after pages, or build a regression report across many pages. Do NOT use to validate code migration patterns (use validate-migration) or to review a single page in isolation. This skill is in beta. Verify all outputs before applying them to production projects."
metadata:
  status: beta
license: Apache-2.0
---

> **Beta Skill**: This skill is in beta and under active development.
> Results should be reviewed carefully before use in production.
> Report issues at https://github.com/adobe/skills/issues

# page-compare

Compares live **before** and **after** pages and writes a report of what differs. The skill drives `scripts/compare.js`; you triage the report with the user. It is read-only against the sites: pages are loaded with GET, nothing is clicked or submitted, and nothing is sent to any other service.

## When to use

- "Compare these two URLs" or "did the migrated page lose anything?"
- Regression report across a page list or a before sitemap (100+ pages).
- Cut-over checks: redirects, new pages missing from the compared set, robots.txt, analytics values.

Not for checking migrated Java/OSGi code (`validate-migration`) or for a one-off visual review of a single page.

## Setup (once)

```bash
cd <skill dir>/scripts && npm run setup   # installs dependencies and Chromium
```

Needs Node 18.3 or newer. If `compare.js` reports a missing browser, run the setup again.

## Gather inputs

Ask only for what is missing:

1. **Pages**: one `--before`/`--after` pair, a `--pairs` file, or `--sitemap <before sitemap> --map <beforeHost=afterHost>` (add `--path-map /old/=/new/` when paths change). The pairs file is a `.csv` or an Excel `.xlsx` (first sheet): before URLs in column A, after URLs in column B, then optional label and group. A header row (`before,after[,label][,group]`, columns in any order) is optional. Old `.xls` files must be saved as `.xlsx` or `.csv`. For 100+ pages ask for a `group` column (template or section) so a sample per group can be run first.
2. **Access**: if either site needs a login, a Playwright storage state file (`--storage-state`). Without it, login pages are compared as they appear to a visitor.
3. **Bot protection**: sites behind a WAF (Akamai, Cloudflare, ...) may turn the headless runner away. The run reports those pages as `blocked`, not as failures. First ask the customer to allowlist the runner IP or the `page-compare/1.0` user agent. If that is not possible and the customer agrees to the testing, capture with a real Chrome instead (`--cdp-url`, see below).
4. **Known volatile areas**: `--mask <selector>` for clocks, rotating promos and other content that changes on every load.
5. **Expected analytics** (optional): `--expect-analytics file.json` with `{ "rsid": "...", "datastreamId": "...", "launch": "..." }`.

## Run

```bash
node scripts/compare.js --pairs pages.csv --out ./out \
  --after-sitemap https://after.example.com/sitemap.xml --redirects redirects.csv
```

Useful options: `--viewports 1440,768,375` (default), `--concurrency 2`, `--pace-ms 500`, `--noise-sample 20%` (noise baseline on a share of pages for faster big runs), `--include/--exclude/--limit` to run a subset first. Run `node scripts/compare.js --help` for all options.

Run a small sample (`--limit 5`) first on large sets, check it with the user, then run the full set.

For 100+ pages, work in three steps:

1. **Smoke test**: `--limit 5` to confirm access, bot protection and the URL mapping.
2. **Sample per template**: `--per-group 2` keeps 2 pages from each group (the CSV `group` column, else the first path segment after any locale such as `/en/` or `/content/<site>/en/`). A CSV `group` column is the reliable option; without it, two-letter sections are read as locales. This usually shows every template-level issue in a fraction of the time.
3. **Full run** only when needed (for example go-live sign-off): add `--noise-sample 20%`, split by section with `--include`, and use `--resume` after an interruption. Run time depends on the sites and has not been measured on a large run: each pair needs about nine page loads (before twice, after, at three viewports), so time a `--limit 10` run and multiply before committing to a long run.

`--resume` reuses pages that were captured and retries pages that were blocked or errored, so after an allowlist change rerun the same command with `--resume`.

Exit code: `0` no fail/error/blocked, `1` at least one, `2` usage or setup error.

## Read the report

Open `out/report.md` first. It reads in a minute at any number of pages and is what to share with a customer or leadership:

1. A one-line **verdict**: `Not ready: N blockers`, `Ready after fixes`, `Incomplete` (pages could not be compared), `Nothing compared` (no pairs matched the filters) or `No blocking differences found`.
2. **Action items**: one row per problem (ten broken images are one row), with a priority, how many items and pages, an example and a likely owner.
3. **Content differences**: `Before says / After says`, with changed figures in bold.
4. **Expected on preview**: robots.txt, canonical and analytics differences that are normal before launch on a preview or publish host.

Priorities: 🔴 **P1** must be fixed before launch. Content is non-negotiable: lost main-content text, changed figures, placeholder text, missing images, sections and form fields are P1, as are broken pages, noindex, `Disallow: /` and a canonical pointing to another host on a production host. 🟠 **P2** should be fixed (rewritten or reworded copy, broken links, large visual or speed differences, smaller robots/canonical changes). 🟡 **P3** is polish (navigation, header/footer text and sections, small visual shifts). ⚪ **Expected** is fine on a preview host and must be rechecked on the launch domain. The map is `priority` in `scripts/lib/rules.js` and can be changed per customer with `--rules`; priority is worked out when the report is written, so `--resume --rules` re-prioritises without reloading pages (detection changes such as changed figures need a fresh run). Alongside the summary:

- `issues.md` / `issues.csv`: the work list, every item with its priority and the pages it affects. The same broken link or wrong canonical on 400 pages is one row.
- `pages.csv`: one row per page with a result per area and its P1/P2/P3 counts; open it in a spreadsheet to sort and filter.
- `pages/<page>.md`: full before/after detail for each page that did not pass.
- `report.html`: interactive version with the **Accept** buttons (also `report.json`, `summary.csv`).

Pages are ordered worst first. Statuses:

| Status | Meaning |
|---|---|
| `fail` | A finding that most likely needs a fix |
| `review` | Needs a human look; may be intended |
| `flaky` | Needed a retry, or its text changes between two loads of the before page. A flaky page that also fails keeps status `fail`, and is still marked flaky in every report |
| `unstable` | The before page itself changes too much between loads for pixel comparison to be trusted |
| `blocked` | Bot protection answered; not a site defect |
| `error` | The page could not be captured |
| `pass` | No unaccepted fail or review findings |

Work through the action items top down: P1 first, then P2. For each, say what changed and whether it looks like a regression or an intended change, using the example and the page detail. Never call an action item fixed or intended without checking it. When the after site is a preview or publish host (`*.aem.page`, `*.aem.live`, `author/publish/preview-p…-e….adobeaemcloud.com`), the robots.txt, canonical, sitemap and analytics differences listed under "Expected on preview" are normal there; say they must be checked again on the launch domain. See `references/checks.md` for what each check means and `references/report.md` for the report layout and the full priority table.

## Accepting differences

Intended differences are recorded in `accepted.json`; the report's **Accept** button copies an entry. Add it to the file with a `reason`, then rerun the same command with `--resume --accept accepted.json`: captures are reused and only the acceptance is reapplied. Accepted findings stay in the report, greyed out.

Never add entries on the user's behalf without them saying a difference is intended. A `reason` is required.

## Limits to state in your summary

Chromium only; pages are loaded, never interacted with; analytics checks cover page-view tags and values, not interaction events, consent behaviour or data arriving in reporting; no security or SEO-ranking audit. The report lists these under "Not tested". Do not describe a `pass` as proof that the page is correct, only as "no differences found by these checks".

## Troubleshooting

- Many `blocked` pages: slow down (`--pace-ms 2000 --concurrency 1`) or get an allowlist, then `--resume`. If the site still turns the headless browser away, use a real Chrome (next section).

## Capturing with a real Chrome (`--cdp-url`)

Some bot protection rejects headless browsers but accepts a normal Chrome. With the customer's agreement, start a separate Chrome with its own empty profile and a DevTools port, then point the run at it:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir=/tmp/page-compare-chrome --no-first-run   # macOS
node scripts/compare.js --pairs pages.xlsx --out ./out --cdp-url http://127.0.0.1:9222
```

Use a separate `--user-data-dir`: never point the run at the user's everyday profile, which holds their logins and cookies. The run opens its own windows in that Chrome, uses Chrome's own user agent instead of `page-compare/1.0`, and leaves Chrome running when it finishes; close it afterwards. All checks, the noise baseline and the reports are the same as a headless run. Expect it to be slower: on a heavy site a 5-page run took about 9 minutes.
- Many `unstable`/`flaky` pages: add `--mask` selectors for the moving parts.
- Everything fails visually after a redesign: that is expected; rely on the content and functional findings, or accept the visual checks in bulk with `{ "check": "visual", "reason": "..." }`.
