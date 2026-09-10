# RV — Render & Validate

Verification layer for the AEM Cloud Service migration skills. Two commands, one
job: prove a migrated pattern actually works on a real Cloud SDK.

> Status: **Phase 2.** Both commands land, scheduler pattern proven end-to-end
> against the AEM Cloud SDK 2026.8+.

## Two-step flow

```bash
# 1. Once per session — boot the SDK (or attach if it's already up).
rv-init                                            # auto-discovers everything

# 2. Per pattern — verify one fix, from your customer module dir.
cd my/customer/module
rv-check scheduler                                 # auto-resolves finding + project-id
```

`rv-init` writes `~/.rv/setup.json` (machine-global). `rv-check` reads that plus
`<cwd>/.rv/context.json` for the finding and project id (written by the analyze /
migration skill).

## rv-init options

| Flag | Default | Notes |
|---|---|---|
| `--sdk <url>` | `http://localhost:<port>` | If reachable, attach without booting |
| `--sdk-home <path>` | `RV_SDK_HOME` env var | Required only when booting — must contain `aem-sdk-quickstart-*.jar` and `license.properties` |
| `--port <n>` | `4602` | Only used when booting |

Preflight (boot mode only): Java ≥ 11, port free, license file present. Fails
fast with an actionable message on any check.

Boot mode writes `.rv/sdk.pid` so the caller can stop the SDK later
(`kill $(cat .rv/sdk.pid)`). Boot logs land in `.rv/logs/`.

## Files that ship with the plugin

- `rv-init.js` — SDK spin-up / attach.
- `rv-check.js` — per-pattern verification: build → deploy → runtime check → MCP emit.
- `build.js`, `deploy.js` — reusable modules used by `rv-check`.
- `failure-classes.js` — frozen failure taxonomy shared with the MCP tool.
