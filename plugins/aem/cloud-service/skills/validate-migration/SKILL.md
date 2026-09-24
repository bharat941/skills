---
name: validate-migration
description: |
  Deploys migrated AEM Cloud Service code to a local Cloud SDK and confirms it
  actually runs. Diffs the current branch against `main`, classifies the changed
  files into supported patterns (scheduler, asset-manager, event-migration,
  resource-change-listener, replication, legacy-ui), then per pattern: `mvn` build → `-PautoInstallBundle`
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

Two Node scripts invoked via plugin-relative paths from the customer's project
root. The skill drives them; the customer never types either directly.

```bash
# Local readiness check (mvn, unzip, SDK reachable). Idempotent.
node ../../validate-migration/init.js

# Two-stage validation flow. See "The flow the skill runs" below.
node ../../validate-migration/check.js --stage prepare     # build + deploy, list BSNs
node ../../validate-migration/check.js --stage verify      # consume MCP diagnosis, emit outcome

# Manual override: run a single pattern instead of auto-diffing the branch.
node ../../validate-migration/check.js --pattern <name>
```

Paths are relative to the SKILL.md location
(`plugins/aem/cloud-service/skills/validate-migration/`). No `npm link`, no
global bin — the scripts run in place.

## The flow the skill runs

1. **Readiness.** Run `node ../../validate-migration/init.js` once per
   environment. It verifies `mvn` + `unzip` on `PATH` and that an SDK is
   reachable on `AEM_SDK_URL` (default `http://localhost:4502`). It does not
   speak MCP — the coding assistant is expected to already have the AEM
   Quickstart MCP server configured (see Adobe MCP setup link at the bottom).
   No SDK boot. No credentials or state on disk.

2. **Prepare (build + deploy).** From the customer's project root:
   `node ../../validate-migration/check.js --stage prepare`. It calls
   `plan.js` internally to diff against `origin/main` (fallback `main`),
   including committed, staged, unstaged, and untracked changes — so runs
   immediately after the `migration` skill (which edits without committing)
   still detect the pending work. Each detected task is built with `mvn` and
   deployed via the customer's own `-PautoInstallBundle` /
   `-PautoInstallPackage` profile (fallback: `sling-maven-plugin:install-file`).
   Prepare writes `<project>/.validate-migration/state.json` and prints the
   Bundle-SymbolicNames the agent must diagnose next.

3. **Diagnose (agent-driven MCP).** For each BSN emitted by prepare, invoke
   the `diagnose-osgi-bundle` tool on the agent-configured AEM Quickstart MCP
   server. Concatenate the raw text output per bundle into a JSON map:
   ```json
   {
     "com.customer.core": "<full text output of diagnose-osgi-bundle for that BSN>",
     "com.customer.ui.apps": "<...>"
   }
   ```
   Write it to `<project>/.validate-migration/diagnosis-map.json`. If the MCP
   tool is not available, stop with setup guidance — do not proceed.

4. **Verify.** Run `node ../../validate-migration/check.js --stage verify`.
   The script reads `state.json` + `diagnosis-map.json`, evaluates the
   bundle-runtime contract (bundle Active, component Active, plus offline
   manifest / DS-descriptor checks read from the built artifact), and emits
   one aggregated outcome. Any BSN missing from the map is reported with
   `failure_class: setup.mcp_unavailable` and setup guidance. Contract signals
   the MCP tool does not expose today (e.g. component DS properties like
   `scheduler.expression` / `scheduler.runOn`, Distributor service list) are
   reported as `restricted: true` on an otherwise-passing outcome — tracked
   upstream as MCP feature requests, never patched around with direct Felix
   Web Console calls.

5. **Report outcome (optional).** If a CAM `project-id` is available — passed
   as `--project-id <id>` or picked up from
   `<project>/.validate-migration/context.json` written by the analyze /
   migration skill — verify prints a delimited `report-migration-outcome` payload
   block. Invoke the `report-migration-outcome` MCP tool with that payload once. If
   no project-id is configured, skip this step — local validation does not
   require CAM integration.

6. **Retry policy.** Wait 5s and retry only transient classes on the failed
   task: `sdk.unreachable`, or `deploy.failed` whose evidence ends in
   "timeout". Never retry runtime contract failures
   (`runtime.bundle_not_active`, `runtime.component_unsatisfied`,
   `runtime.activation_error`, `runtime.contract_mismatch`,
   `source.contract_mismatch`, `tests.failed`, `input.jar_missing`,
   `discovery.no_pattern_match`) — the deploy is stable, the code needs a
   real fix. Hand back to the `migration` skill with the structured evidence.

   `setup.mcp_unavailable` is a setup problem, not a code problem — stop and
   surface the setup guidance to the user; do not silently retry.

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
  `report-migration-outcome` MCP tool. Contract stays frozen even when the local sink
  is swapped for the real service.
- **Never invent a `failure_class`.** Use only the frozen enum in
  `plugins/aem/cloud-service/validate-migration/failure-classes.js`.
- **Never boot the SDK.** Rely on the customer's normal SDK workflow. `init`
  only checks readiness.
- **Never store credentials.** No `~/.validate-migration/` — nothing
  persistent in the user's HOME.
- **Never bypass the Maven profile check.** Customer projects have their own
  install plugin config; delegate to it.

## Config surface (all optional)

| Env | CLI | Default |
|---|---|---|
| `AEM_SDK_URL` | `--sdk <url>` | auto-discover on 4502 / 4602 / 4503 |
| `AEM_SDK_USER` | `--user <name>` | `admin` — refused on non-localhost |
| `AEM_SDK_PASS` | `--password <pw>` | `admin` — refused on non-localhost |
| — | `--project-id <id>` | picked up from `.validate-migration/context.json`; optional |
| — | `--diagnosis-map <file>` | default `<project>/.validate-migration/diagnosis-map.json` |
| — | `--stage prepare\|verify\|all` | `all` |

## Supported patterns today

Five patterns are wired in `check.js`. All share the same CLI shape
(`node ../../validate-migration/check.js --pattern <name>`) and the same MCP
payload — only the per-pattern discover + verify functions differ.

**bundle-runtime** (`mode: bundle-runtime`) — build → deploy → check
bundle_state + component_state via MCP `diagnose-osgi-bundle`:

- **scheduler** — Sling Scheduler Cloud Service contract. Verifies bundle
  Active + component Active via MCP. DS-property checks
  (`scheduler.expression`, `scheduler.concurrent:Boolean`, `scheduler.runOn`)
  are `restricted: true` on the outcome because the MCP tool does not expose
  component properties today — tracked upstream.
- **asset-manager** — `AssetManager → ResourceResolver`. Bundle Active +
  component Active via MCP, and offline manifest check that
  `com.day.cq.dam.api.AssetManager` is no longer imported.
- **event-migration** — `OSGi EventHandler → Sling JobConsumer`. Bundle Active
  + JobConsumer component Active via MCP; `job.topics` presence is read
  offline from the DS descriptor in the built jar.
- **resource-change-listener** — `JCR EventListener / resource EventHandler →
  Sling ResourceChangeListener`. Bundle Active + component Active via MCP;
  `resource.paths` + `resource.change.types` presence is read offline from the
  DS descriptor in the built jar (full contract verifiable, not restricted).
- **replication** — `CQ Replicator / Sling Replicator → Sling Distribution
  API`. Bundle Active via MCP, and offline manifest check that
  `org.apache.sling.distribution` is imported and `com.day.cq.replication` is
  not. `Distributor` service registration on the SDK is `restricted: true`
  (tracked upstream).

**source-only** (`mode: source-only`) — build → inspect artifact; no SDK
touched, no bundle deploy:

- **legacy-ui** — Classic UI / Coral 2 → Coral 3. Flags any remaining Classic
  UI `xtype=` attributes or Coral 2 resource types in `cq:dialog/.content.xml`.
- **cdw** — Custom Classic Widgets (ExtJS xtypes) → Coral 3. Flags any remaining
  `jcr:primaryType="cq:Widget"` nodes or custom `xtype=` in dialog XMLs. Invoke
  explicitly (`check.js cdw`): at branch-diff time it is path-indistinguishable
  from legacy-ui, so auto-planning classifies shared dialog changes as legacy-ui
  (which already flags remaining xtypes).

## Patterns not yet wired

- `dispatcher-converter`, `unsupported-runmodes`, `filevault-deps` — will land
  as source-only entries.
- `custom-templates` — needs a content-package deploy pipeline
  (`POST /crx/packmgr/service.jsp` via `content-package-maven-plugin`).

## Reference

- Frozen failure taxonomy:
  `plugins/aem/cloud-service/validate-migration/failure-classes.js`
- MCP tool: `aemcs-migration-mcp/src/tools/report-migration-outcome.ts`
- Primitives:
  `plugins/aem/cloud-service/validate-migration/init.js`, `check.js`
- Optional on-disk input from the sibling migration skill:
  `<project>/.validate-migration/context.json` — `{ projectId, pendingFindings }`
- Adobe MCP setup:
  https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/ai-in-aem/local-development-with-ai-tools#aem-quickstart-mcp-server
