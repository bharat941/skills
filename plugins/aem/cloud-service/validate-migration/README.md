# validate-migration

Deploys migrated AEM Cloud Service bundles to a local Cloud SDK and confirms they
actually run — bundle Active, OSGi component Active, Cloud Service contract
properties correct.

Companion to the `migration` skill: `migration` applies the fix,
`validate-migration` proves it works.

> Status: Beta. Verified end-to-end against AEM SDK 2026.8+ with the
> [AEM Quickstart MCP content package](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/ai-in-aem/local-development-with-ai-tools#aem-quickstart-mcp-server).

## Two-stage flow

The skill (`plugins/aem/cloud-service/skills/validate-migration/SKILL.md`)
drives the scripts via plugin-relative paths — there is no `npm link` and no
global bin.

```bash
# Once, per environment — check local readiness (mvn/unzip, SDK reachable)
node ../../validate-migration/init.js

# Per branch, from your project root:
#   1. build + deploy, list the Bundle-SymbolicNames to diagnose
node ../../validate-migration/check.js --stage prepare

#   2. the coding assistant now calls the AEM Quickstart MCP tool
#      `diagnose-osgi-bundle` for each BSN and writes the raw text outputs to
#      <project>/.validate-migration/diagnosis-map.json as { "<BSN>": "..." }

#   3. consume the diagnosis + emit outcome
node ../../validate-migration/check.js --stage verify
```

Auto-diff mode diffs `HEAD` against `origin/main` (fallback `main`),
**including staged, unstaged, and untracked changes** so runs immediately after
the sibling `migration` skill (which edits files without committing) still see
the pending work. Manual override: `--pattern <name>` runs one pattern only.

`--stage all` (the default) runs prepare + verify in one invocation — useful
if the diagnosis map is already populated. Any BSN missing from the map is
reported with `failure_class: setup.mcp_unavailable` and setup guidance; there
is no silent fallback to the Felix Web Console.

## Prerequisites

- Local AEM Cloud SDK running (start it however you already do — this tool does
  not boot it).
- [AEM Quickstart MCP server](https://github.com/adobe/cq-quickstart-mcp-server/)
  configured in the coding assistant. See the
  [Adobe setup docs](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/ai-in-aem/local-development-with-ai-tools#aem-quickstart-mcp-server).
- `mvn` and `unzip` on `PATH`.
- Node 18+.

## Config

Zero config for standard local dev. Overrides via env or CLI:

| Env | CLI | Default | Notes |
|---|---|---|---|
| `AEM_SDK_URL` | `--sdk <url>` | auto-discover on 4502 / 4602 / 4503 | first SDK to answer wins |
| `AEM_SDK_USER` | `--user <name>` | `admin` | refused on non-localhost URLs |
| `AEM_SDK_PASS` | `--password <pw>` | `admin` | refused on non-localhost URLs |
| — | `--project-id <id>` | optional; auto-loaded from `.validate-migration/context.json` | when unset, the `report-migration-outcome` payload block is not emitted |
| — | `--diagnosis-map <file>` | `<project>/.validate-migration/diagnosis-map.json` | agent-supplied BSN → raw MCP text output |
| — | `--stage prepare\|verify\|all` | `all` | two-stage flow support |

Nothing is persisted to `$HOME`. No `~/.validate-migration/*`, no credentials
on disk.

## Deploy strategy

Prefers the customer project's `-PautoInstallBundle` (or `-PautoInstallPackage`)
Maven profile — the AEM archetype standard, which uses whatever install plugin
the project itself configures. Auto-falls-back to
`sling-maven-plugin:install-file` if the profile install fails (e.g. WKND legacy
pins `maven-sling-plugin:2.1.0` with a WebDAV config that returns 409). Both
attempts are captured in the outcome log so the reviewer sees exactly what ran.

## Runtime verification via MCP

Bundle + component state come from the coding-assistant's own MCP session with
the [AEM Quickstart MCP server](https://github.com/adobe/cq-quickstart-mcp-server)
(`diagnose-osgi-bundle` tool). **This script does not speak MCP** — it consumes
a JSON map of `{ "<BSN>": "<raw tool text output>" }` written to
`.validate-migration/diagnosis-map.json` by the coding assistant between
`--stage prepare` and `--stage verify`.

Signals the MCP tool does not expose today (component DS properties like
`scheduler.expression`, `scheduler.runOn`, `job.topics` on the running
component; `Distributor` service registration) are reported as
`restricted: true` on an otherwise-passing outcome and tracked as upstream
feature requests against
[`apache/sling-org-apache-sling-mcp-server-contributions`](https://github.com/apache/sling-org-apache-sling-mcp-server-contributions).
There is no fallback to direct Felix Web Console access.

## Files that ship with this plugin

- `init.js` — local readiness check (does NOT boot the SDK, does NOT speak MCP).
- `check.js` — two-stage pipeline (prepare = build + discover + deploy;
  verify = consume MCP diagnosis + emit outcome).
- `plan.js` — branch-diff scoping. Includes committed, staged, unstaged, and
  untracked changes.
- `build.js`, `deploy.js` — reusable helpers.
- `failure-classes.js` — frozen failure taxonomy shared with the MCP tool and
  adoption-service.
