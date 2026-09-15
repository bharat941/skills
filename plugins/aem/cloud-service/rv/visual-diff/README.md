# visual-diff — pixel-perfect UI validation for AEM migrations

Companion to RV. Proves a template migration didn't break rendering by:

1. Creating a synthetic page from the migrated template
2. Populating it with fixture-driven mock content
3. Screenshotting the rendered page with headless Chrome
4. Comparing pixel-by-pixel against a stored baseline
5. Cleaning up the synthetic page
6. Emitting the same outcome shape as `rv-check` so `report-rv-outcome` can consume it

## Install

```bash
cd plugins/aem/cloud-service/rv/visual-diff
npm install
npm link          # exposes `visual-check` globally
```

## Capture a baseline (one time, per template, per SDK version)

Point at a known-good SDK, save the golden screenshot:

```bash
visual-check \
  --fixture ./fixtures/wknd-article/fixture.json \
  --sdk http://localhost:4502 \
  --auth admin:admin \
  --capture-baseline \
  --baseline ./fixtures/wknd-article/baseline.png
```

Commit the baseline PNG next to the fixture.

## Verify a migration

```bash
visual-check \
  --fixture ./fixtures/wknd-article/fixture.json \
  --baseline ./fixtures/wknd-article/baseline.png \
  --sdk http://localhost:4502 \
  --auth admin:admin \
  --out ./out
```

Exit code: `0` on pass, `1` on visual mismatch, `2` on bad args, `3` on runtime error.

## Fixture shape

Each template ships one `fixture.json` beside its baseline:

```jsonc
{
  "template": "/conf/wknd/settings/wcm/templates/article-page",
  "viewport": { "width": 1440, "height": 900 },
  "mockContent": {
    "jcr:title": "...",
    "root/container/hero/fileReference": "/content/dam/.../hero.jpg",
    "root/container/title/jcr:title": "The Long Way Back"
  },
  "assertions": {
    "maxDiffPct": 0.5
  }
}
```

- `template` — full path to the template used by `wcmcommand createPage`
- `mockContent` — flat property writes on `jcr:content` (Sling-style, slash-delimited paths)
- `viewport` — screenshot size; must match the baseline
- `assertions.maxDiffPct` — % of pixels allowed to differ before failing (default 0.5)

## Outcome payload

Same envelope as `rv-check`:

```json
{
  "run_id": "vdc-1789456...",
  "skill_pattern": "template-visual",
  "result": "pass",
  "summary": { "classes_total": 1, "classes_pass": 1, "classes_fail": 0 },
  "classes": [{
    "class_name": "/conf/wknd/settings/wcm/templates/article-page",
    "result": "pass",
    "checks": {
      "diff_pct": 0.021,
      "diff_pixels": 268,
      "total_pixels": 1296000,
      "max_diff_pct_allowed": 0.5
    }
  }]
}
```

On failure, `classes[0].failure_class` is one of:

| failure_class | Meaning |
|---|---|
| `input.baseline_missing` | Baseline PNG not found — run `--capture-baseline` first |
| `runtime.render_failed` | Page creation, load, or screenshot threw (see `evidence`) |
| `runtime.visual_mismatch` | Diff exceeded `--max-diff-pct` (see `checks.diff_pct`) |

## How this fits with the RV skill

The RV skill picks the mode based on pattern:

| Pattern | Mode | Tool |
|---|---|---|
| `scheduler`, `asset-manager`, `event-migration`, `replication` | bundle-runtime | `rv-check <pattern>` |
| `legacy-ui` | source-only | `rv-check legacy-ui` |
| **template-visual** | **runtime + pixel-diff** | **`visual-check --fixture ...`** |

A future extension of `rv-check` can dispatch to `visual-check` when the pattern's `mode` is `template-visual`, keeping one CLI surface for the customer.
