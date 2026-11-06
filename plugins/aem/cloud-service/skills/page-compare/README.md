# page-compare (beta)

Compares live **before** and **after** pages after an AEM migration or redesign and writes a static report. Handles one pair or 100+ (CSV or sitemap).

- **Content**: text (including text hidden in tabs), headings, meta, images, links, navigation, forms, structured data
- **Visual**: per-section screenshots at 1440/768/375 with a noise baseline so animated, rotating or volatile areas do not cause false failures
- **Functional**: JavaScript and console errors, failed assets, load/LCP timing, accessibility deltas, Adobe Analytics / Web SDK / GA4 / Launch values and data layer
- **Cut-over**: downloads, broken links, redirects, robots.txt, sitemap, and pages on the after site that were not compared

Pages are only loaded (GET); nothing is clicked, submitted or sent to another service. Pages behind bot protection are reported as `blocked`, not as failures; with the site owner's agreement, `--cdp-url` captures them with a real Chrome instead (see [SKILL.md](SKILL.md)).

## Quick start

```bash
cd scripts && npm run setup
node compare.js --before https://www.example.com/en/page --after https://stage.example.com/en/page --out ./out
open out/report.md      # one-page summary: content, visual, integration, top issues
open out/report.html    # interactive version
```

For many pages use `--pairs pages.xlsx` or `--pairs pages.csv` (before URLs in column A, after URLs in column B, optional label and group; a header row `before,after[,label][,group]` is optional) or `--sitemap <url> --map www.example.com=stage.example.com`, and start with `--per-group 2` to sample each template. The run also writes `issues.csv` (each issue once, with pages affected), `pages.csv` (one row per page) and `pages/<page>.md` (detail per page).

See [SKILL.md](SKILL.md) for how an agent runs and triages it, [references/checks.md](references/checks.md) for every check and threshold, and [references/report.md](references/report.md) for the report, `accepted.json` and scaling notes.

## Tests

```bash
cd scripts && npm test
```

The end-to-end test starts a local server and drives Chromium; it is skipped if Chromium is not installed.
