# validate-migration

Deploys migrated AEM Cloud Service bundles to a local Cloud SDK and confirms they
actually run — bundle Active, OSGi component Active, Cloud Service contract
properties correct.

Companion to the `migration` skill: `migration` applies the fix,
`validate-migration` proves it works.

> Status: Beta. Verified end-to-end against AEM SDK 2026.8+ with the
> [AEM Quickstart MCP content package](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/ai-in-aem/local-development-with-ai-tools#aem-quickstart-mcp-server).

## Two commands

```bash
# Once, per environment — check readiness (mvn/unzip, SDK reachable, MCP tools present)
validate-migration-init

# Per branch, from your project root — auto-diff mode
validate-migration-check
```

Auto-diff mode diffs `HEAD` against `origin/main` (fallback `main`), classifies
the changed files into supported patterns, then builds → deploys → verifies each
one on the running SDK. Results aggregate into a single outcome + a single
`report-rv-outcome` MCP payload.

Manual override: `validate-migration-check <pattern>` to run one pattern
explicitly.

## Prerequisites

- Local AEM Cloud SDK running (start it however you already do — this tool does
  not boot it).
- [AEM Quickstart MCP content package](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/ai-in-aem/local-development-with-ai-tools#aem-quickstart-mcp-server)
  installed once via Package Manager (`/crx/packmgr`).
- `mvn` and `unzip` on `PATH`.
- Node 18+.

## Config

Zero config for standard local dev. Overrides via env or CLI:

| Env | CLI | Default | Notes |
|---|---|---|---|
| `RV_SDK_URL` | `--sdk <url>` | auto-discover on 4502 / 4602 / 4503 | first SDK to answer wins |
| `RV_SDK_USER` | `--user <name>` | `admin` | refused on non-localhost URLs |
| `RV_SDK_PASS` | `--password <pw>` | `admin` | refused on non-localhost URLs |

Nothing is persisted to disk. No `~/.validate-migration/setup.json` (deleted - never written now). No credentials in
config files.

## Deploy strategy

Prefers the customer project's `-PautoInstallBundle` (or `-PautoInstallPackage`)
Maven profile — the AEM archetype standard, which uses whatever install plugin
the project itself configures. Auto-falls-back to
`sling-maven-plugin:install-file` if the profile install fails (e.g. WKND legacy
pins `maven-sling-plugin:2.1.0` with a WebDAV config that returns 409). Both
attempts are captured in the outcome log so the reviewer sees exactly what ran.

## Runtime verification via MCP

Bundle + component state come from the
[AEM Quickstart MCP server](https://github.com/adobe/cq-quickstart-mcp-server)'s
`diagnose-osgi-bundle` tool (documented tool catalog — see the Adobe doc linked
above). validate-migration falls back to the Felix Web Console only for signals the MCP server
does not expose today: component *properties* (e.g. `scheduler.expression`,
`job.topics`), manifest `Import-Package` headers, and the OSGi service list. In
code, these fallbacks are documented; ideally they land upstream in
[`apache/sling-org-apache-sling-mcp-server-contributions`](https://github.com/apache/sling-org-apache-sling-mcp-server-contributions).

## Files that ship with this plugin

- `init.js` — readiness check (does NOT boot the SDK).
- `check.js` — per-branch or per-pattern pipeline: build → discover → deploy →
  verify → emit outcome payload.
- `plan.js` — branch-diff scoping. Classifies changed files into supported
  patterns.
- `build.js`, `deploy.js` — reusable helpers.
- `mcp-client.js` — minimal JSON-RPC 2.0 client for `POST {sdkUrl}/bin/mcp`.
- `failure-classes.js` — frozen failure taxonomy shared with the MCP tool and
  adoption-service.
