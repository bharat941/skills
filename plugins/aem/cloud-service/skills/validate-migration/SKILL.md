---
name: validate-migration
description: |
  Deploys migrated AEM Cloud Service code to a local Cloud SDK and confirms it
  actually runs. Diffs the current branch against `main`, classifies the changed
  files into supported patterns (scheduler, asset-manager, event-migration,
  replication, legacy-ui), then per pattern: `mvn` build → `-PautoInstallBundle`
  deploy → runtime verify via the AEM Quickstart MCP server's
  `diagnose-osgi-bundle` tool → emit outcome payload. Companion to the
  `migration` skill: `migration` applies the fix, `validate-migration` proves it
  works. Activate when the user says things like "validate my migration",
  "smoke-test my branch", "did my scheduler fix land", "check my migration on
  the SDK", or immediately after a `migration` / `code-assessment/<pattern>`
  skill produces a Java code change targeting AEM as a Cloud Service. Do NOT
  activate for content-package patterns without a wired verify path yet
  (dispatcher, unsupported-runmodes, filevault-deps, custom-templates).
license: Apache-2.0
metadata:
  status: beta
  author: AEM Cloud Service Team
  version: "0.2"
  aem_version: "Cloud Service"
---

# validate-migration

Proves that an AEM Cloud Service migration works on a real local Cloud SDK.
Turns "my code compiled" into "the bundle is Active and the OSGi component
satisfies the Cloud Service contract."

## When to activate

- User asks to validate, verify, or "smoke-test" a migration.
- User asks whether the recent fix "works", "activated", or is "running on the
  SDK".
- Immediately after `migration` (or `code-assessment/<pattern>`) applies a Java
  code change that produces a bundle-runtime pattern.

## When NOT to activate

- Content-package patterns with no verify path yet (dispatcher converter,
  unsupported runmodes, filevault-deps, custom-templates).
- Any request that is really "apply a migration" — hand off to the `migration`
  skill, then `validate-migration` afterwards.

## The customer contract

Two CLI commands, exposed via `npm link` (or by adding
`plugins/aem/cloud-service/validate-migration/` to `PATH`). The skill drives
them; the customer never types either directly.

```bash
validate-migration-init            # readiness check: mvn/unzip, SDK reachable, MCP tools registered
validate-migration-check           # from project root: auto-diff mode
validate-migration-check <pattern> # optional: run one pattern manually
```

## The flow the skill runs

1. **Readiness.** Run `validate-migration-init` once per environment. It
   verifies `mvn` + `unzip` on `PATH`, that an SDK is reachable on ports 4502 /
   4602 / 4503 (auto-discovered), and that the AEM Quickstart MCP content
   package is installed (`diagnose-osgi-bundle` tool appears in `tools/list`).
   No SDK boot — the customer starts their SDK however they normally do. No
   credentials or state on disk.

2. **Plan.** Run `validate-migration-check` from the customer's project root.
   It calls `plan.js` internally to diff `HEAD` against `origin/main` (fallback
   `main`), classify each changed file into a supported pattern, and group hits
   by Maven module. `--pattern <name>` overrides for manual runs.

3. **Per-pattern pipeline** (`check.js` `runTask`):
    - **Build** — `mvn -q -B -DskipTests clean package` on the module.
    - **Discover** — auto-locate the migrated class from the built jar's OSGi
      DS descriptors, preferring signals that only appear post-migration (e.g.
      `scheduler.runOn`).
    - **Deploy** — prefer the customer's own `-PautoInstallBundle` (archetype
      standard). Auto-fall-back to `sling-maven-plugin:install-file` if the
      profile install fails. Never Felix multipart POST.
    - **Verify** — bundle + component state from the MCP `diagnose-osgi-bundle`
      tool (per-run cache, one call per BSN). Pattern-specific contract
      properties (`scheduler.expression`, `scheduler.runOn`, `job.topics`,
      `Import-Package` headers, Distributor service) come from the Felix Web
      Console only for signals the MCP tool doesn't expose today — a
      documented gap.

4. **Aggregate outcome.** All patterns' outcomes merge into a single record
   with one `run_id`, one `classes[]` array (per-class detail), and one
   `report-rv-outcome` payload block on stdout.

5. **Call the `report-rv-outcome` MCP tool** with the payload block, once, on
   the final attempt. Same MCP session used for `fetch-cam-bpa-findings-*`.
   `validate-migration-check` does not speak MCP itself for outcome reporting;
   **you (the agent) do**.

6. **Retry policy.** Wait 5s and retry once on transient classes only:
   `sdk.unreachable`, `deploy.failed` (only if the log ends in "timeout").
   Never retry runtime contract failures (`runtime.bundle_not_active`,
   `runtime.component_unsatisfied`, `runtime.activation_error`,
   `runtime.contract_mismatch`, `source.contract_mismatch`, `tests.failed`,
   `input.jar_missing`, `discovery.no_pattern_match`) — the deploy is stable,
   the code needs a real fix. Hand back to the `migration` skill with the
   structured evidence.

## What to show the user on success

```
✓ VALIDATED on Cloud SDK
run: <run_id>
patterns: N pass / 0 fail
  • scheduler       → pass  (SimpleScheduledTask, runOn=LEADER)
  • asset-manager   → pass
outcome recorded via MCP
```

Also write `<project-root>/validate-migration/<run_id>.md` — customer-facing
report next to the code.

## What to show on a real (non-transient) failure

Never retry these. **Do not dump raw `evidence` at the user** — it's structured
for the MCP payload and adoption-service. **You (the LLM) translate each failed
class's `failure_class` + `evidence` into a short natural-language explanation
of what went wrong and what to do next.** Iterate over `classes[]` where
`result === 'fail'`; keep it to 3-5 lines per failed class.

Structure per failed class:

1. One sentence naming the failure in plain terms.
2. One or two bullets pulled from that class's structured fields with the
   specific values.
3. One line telling the user what typically fixes it, or handing back to the
   `migration` skill.

Fields to pull from each `classes[i]` (never paste raw):

- `class_name`
- `failure_class` (frozen enum)
- `bundle_state` (Installed | Resolved | Active | Fragment)
- `component_state` (Active | Satisfied | Unsatisfied)
- `unsatisfied_references[]`
- `activation_error` (≤512 chars)
- `evidence` (mvn / MCP output — for your own diagnosis; do not paste verbatim;
  extract the one line that names the root cause)

## Guardrails

- **Never modify customer code.** `validate-migration` verifies. Fixes belong to
  the `migration` skill.
- **Never touch adoption-service directly.** Every outcome goes through the
  `report-rv-outcome` MCP tool. Contract stays frozen even when the local sink
  is swapped for the real service.
- **Never invent a `failure_class`.** Use only the frozen enum in
  `plugins/aem/cloud-service/validate-migration/failure-classes.js`.
- **Never boot the SDK.** Rely on the customer's normal SDK workflow. `init`
  only checks readiness.
- **Never store credentials.** No `~/.rv/setup.json`, no `~/.validate-migration/`
  — nothing persistent in the user's HOME.
- **Never bypass the Maven profile check.** Customer projects have their own
  install plugin config; delegate to it.

## Config surface (all optional)

| Env | CLI | Default |
|---|---|---|
| `RV_SDK_URL` | `--sdk <url>` | auto-discover on 4502 / 4602 / 4503 |
| `RV_SDK_USER` | `--user <name>` | `admin` — refused on non-localhost |
| `RV_SDK_PASS` | `--password <pw>` | `admin` — refused on non-localhost |

## Supported patterns today

Five patterns are wired in `check.js`. All share the same CLI shape
(`validate-migration-check <pattern>`) and the same MCP payload — only the
per-pattern discover + verify functions differ.

**bundle-runtime** (`mode: bundle-runtime`) — build → deploy → check
bundle_state + component_state on the SDK:

- **scheduler** — Sling Scheduler Cloud Service contract:
  `scheduler.expression`, `scheduler.concurrent:Boolean`,
  `scheduler.runOn ∈ {SINGLE, LEADER}` on the migrated DS component.
- **asset-manager** — `AssetManager → ResourceResolver`. Bundle must be Active,
  component Active, and manifest must not import `com.day.cq.dam.api.AssetManager`.
- **event-migration** — `OSGi EventHandler → Sling JobConsumer`. Bundle Active,
  JobConsumer component Active, and its `job.topics` property present.
- **replication** — `CQ Replicator / Sling Replicator → Sling Distribution API`.
  Bundle Active, manifest imports `org.apache.sling.distribution` and not
  `com.day.cq.replication`, and the `Distributor` service is present on the SDK.

**source-only** (`mode: source-only`) — build → inspect artifact; no SDK
touched, no bundle deploy:

- **legacy-ui** — Classic UI / Coral 2 → Coral 3. Flags any remaining Classic
  UI `xtype=` attributes or Coral 2 resource types in `cq:dialog/.content.xml`.

## Patterns not yet wired

- `dispatcher-converter`, `unsupported-runmodes`, `filevault-deps` — will land
  as source-only entries.
- `custom-templates` — needs a content-package deploy pipeline
  (`POST /crx/packmgr/service.jsp` via `content-package-maven-plugin`).

## Reference

- Frozen failure taxonomy:
  `plugins/aem/cloud-service/validate-migration/failure-classes.js`
- MCP tool: `aemcs-migration-mcp/src/tools/report-rv-outcome.ts`
- Primitives:
  `plugins/aem/cloud-service/validate-migration/init.js`, `check.js`
- Optional on-disk input from the sibling migration skill:
  `<project>/.validate-migration/context.json` — `{ projectId, pendingFindings }`
- Adobe MCP setup:
  https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/ai-in-aem/local-development-with-ai-tools#aem-quickstart-mcp-server
