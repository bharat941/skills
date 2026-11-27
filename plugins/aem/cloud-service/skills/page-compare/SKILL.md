---
name: page-compare
description: "[BETA] Compares a live \"before\" page with its \"after\" counterpart (or 100+ pairs from a CSV, Excel sheet or sitemap) after an AEM migration or redesign, and produces a static HTML report. Checks content (text, headings, meta, images, links, forms, structured data), visual differences per section at several viewports with a noise baseline, and functional signals (JavaScript and console errors, failed assets, load timing, accessibility deltas, Adobe Analytics / Web SDK / GA4 / Launch values), optional --interact checks that accordions, tabs, search and forms still work, plus downloads, broken links, redirects, robots.txt and page-set coverage. Use when the user asks to compare two URLs, validate a migrated site against the live one, QA before and after pages, or build a regression report across many pages. Do NOT use to validate code migration patterns (use validate-migration) or to review a single page in isolation. This skill is in beta. Verify all outputs before applying them to production projects."
metadata:
  status: beta
license: Apache-2.0
---

> **Beta Skill**: This skill is in beta and under active development.
> Results should be reviewed carefully before use in production.
> Report issues at https://github.com/adobe/skills/issues

# page-compare

Compares live **before** and **after** pages and writes a report of what differs. The skill drives `scripts/compare.js`; you triage the report with the user. It is read-only against the sites: pages are loaded with GET and nothing is sent to any other service. Only with `--interact` are controls clicked, and forms are then a dry run (the request is recorded and blocked, never sent).

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

**Functional parity (`--interact`).** After a migration, add `--interact` to prove the pages still work, not only that they look the same: on both pages it opens accordions and tabs, moves carousels, opens menus, runs a search with the same term, and fills and submits forms, then compares what happened (did it respond, new JavaScript errors or failed requests, search results, where a form sends and which fields). Forms are a **dry run**: every non-GET request and every navigation a form causes is recorded and blocked, so nothing is ever sent, which makes it safe on a production site. It runs at the first viewport and adds time per page, so on large runs use it with `--per-group`. Logins, payments and multi-step flows are not covered.

Run a small sample (`--limit 5`) first on large sets, check it with the user, then run the full set.

For 100+ pages, work in three steps:

1. **Smoke test**: `--limit 5` to confirm access, bot protection and the URL mapping.
2. **Sample per template**: `--per-group 2` keeps 2 pages from each group (the CSV `group` column, else the first path segment after any locale such as `/en/` or `/content/<site>/en/`). A CSV `group` column is the reliable option; without it, two-letter sections are read as locales. This usually shows every template-level issue in a fraction of the time.
3. **Full run** only when needed (for example go-live sign-off): add `--noise-sample 20%`, split by section with `--include`, and use `--resume` after an interruption. Run time depends on the sites and has not been measured on a large run: each pair needs about nine page loads (before twice, after, at three viewports), so time a `--limit 10` run and multiply before committing to a long run.

`--resume` reuses pages that were captured and retries pages that were blocked or errored, so after an allowlist change rerun the same command with `--resume`.

Exit code: `0` no fail/error/blocked, `1` at least one, `2` usage or setup error.

## Read the report

Every run writes one fix list and shows it three ways, all with the same fix ids:

| File | For | What it is |
|---|---|---|
| `report.html` | Leadership, customers | The report to share: one self-contained file (screenshots embedded, no scripts) |
| `report.md` | People in chat or a PR, and agents | The same report as text, about 80 lines at any number of pages |
| `fixes.json` | Agents | The work list: every fix with where it is, the source and destination values and how to verify |
| `issues.csv`, `pages.csv` | Spreadsheets | One row per fix, and one row per page with its parity and P1/P2/P3 counts |
| `pages/<page>.md` | Multi-page runs | The same report for one page |
| `review.html` | You | Accept intended differences (see below); above 100 pages an index, with one `review/<page>.html` per page that did not pass |

Both reports read top to bottom:

1. **Source → destination**, date, pages and viewports.
2. A one-line **verdict**: `Not ready: N blockers`, `Ready after fixes`, `Incomplete` (pages could not be compared), `Nothing compared` (no pairs matched the filters) or `No blocking differences found`; with `--baseline`, progress since that run.
3. A **scorecard**: content parity (share of source text found on the destination), visual parity (share of sections that match), functional parity (share of source controls that behave the same, with `--interact`) and the P1/P2/P3 count per area. There is no overall score: the verdict is the gate.
4. **Content parity**, then **Visual parity**, then **Functional parity**, then **Integration & SEO**: one fix per page section and cause, named by the heading it sits under ("FAQs: 6 text blocks missing", "Key features: figures changed (32gb → 64gb)") or by its shared cause ("Files under img.example.com/dev/image/ fail to load"), with Source says / Destination says, or source / destination / diff screenshots. A single-page run also gets a metadata table, and the integration section lists broken links.
5. **Expected on preview**: robots.txt, canonical and analytics differences that are normal on a preview or publish host.
6. **Fixed since last run** (with `--baseline`).

Priorities: 🔴 **P1** must be fixed before launch. Content is non-negotiable: lost main-content text, changed figures, placeholder text, missing images, sections and form fields are P1, as are broken pages, noindex, `Disallow: /` and a canonical pointing to another host on a production host. 🟠 **P2** should be fixed (rewritten or reworded copy, broken links, large visual or speed differences, smaller robots/canonical changes). 🟡 **P3** is polish (navigation, header/footer text and sections, small visual shifts). ⚪ **Expected** is fine on a preview host and must be rechecked on the launch domain. The map is `priority` in `scripts/lib/rules.js` and can be changed per customer with `--rules`; priority is worked out when the report is written, so `--resume --rules` re-prioritises without reloading pages (detection changes such as changed figures need a fresh run).

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

Work through the fixes top down: P1 first, then P2. For each, say what changed and whether it looks like a regression or an intended change, using the source and destination values and the screenshots. Never call a fix done or intended without checking it. When the after site is a preview or publish host (`*.aem.page`, `*.aem.live`, `author/publish/preview-p…-e….adobeaemcloud.com`), the robots.txt, canonical, sitemap and analytics differences listed under "Expected on preview" are normal there; say they must be checked again on the launch domain. See `references/checks.md` for what each check means and `references/report.md` for the report layout and the full priority table.

## Fix mode (agents fixing from a report)

When asked to fix what a report found:

1. Read `report.md` for the verdict, then `fixes.json`. Each fix has `id`, `priority`, `area`, `title`, `section` (the heading it sits under), `component` (e.g. `div.cmp-accordion`), `pages` (source and destination URLs), `expected` (the source value), `actual` (the destination value), `fixType` and `items` (every affected text, image or link).
2. Take fixes by priority, P1 first. Skip `expected`: those are fine on a preview host. On a large run, read one slice at a time instead of the whole file: `node scripts/fixes.js <out> --priority P1 --type content` (also `--area`, `--page <path text>`, `--id`) prints only the matching fixes, with each fix's pages narrowed to the filter.
3. Only take a `fixType` you can change: `content` needs author or repository access to the AEM content (text, images, links), `code` needs the front-end code, `config` needs Dispatcher, CDN, SEO or analytics setup. Report the others with their ids instead of guessing.
4. Fix one id at a time. Fixes that share a cause (all images under one path, one broken link on many pages) are already one fix: fix the cause once.
5. Verify: run the comparison again with `--baseline <the earlier --out folder>`, covering every page the fix lists. A fix is done when its id is listed under "Fixed since last run"; an id listed as "not rechecked" means some of its pages were not in the rerun. Never claim a fix is done before that.

## Accepting differences

Intended differences are recorded in `accepted.json`; the **Accept** button in `review.html` copies an entry. Add it to the file with a `reason`, then rerun the same command with `--resume --accept accepted.json`: captures are reused and only the acceptance is reapplied. Accepted findings stay in the report, greyed out.

Never add entries on the user's behalf without them saying a difference is intended. A `reason` is required.

## Limits to state in your summary

Chromium only; without `--interact` pages are only loaded, never clicked, and with it forms are dry runs (never sent) and logins, payments and multi-step flows are not tested; analytics checks cover page-view tags and values, not interaction events, consent behaviour or data arriving in reporting; no security or SEO-ranking audit. The report lists these under "Not tested". Do not describe a `pass` as proof that the page is correct, only as "no differences found by these checks".

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
