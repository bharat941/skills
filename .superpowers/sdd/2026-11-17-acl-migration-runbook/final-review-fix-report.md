# ACL migration runbook — final-review fix report

## Final-review fix wave — 2026-11-19

**Base:** `6e95f2c3509529ec7aeda2107f50ae5e6badf8e8`

**Branch:** `bwadhwa-adobe-acl-migration-runbook-design`

**Outcome:** All nine Important and six listed Minor findings addressed. Eighteen focused synthetic tests added, with existing ACL cases strengthened. No subagents dispatched and no push performed.

The binding spec, implementation plan, and `review-6dd7a228..6e95f2c3.diff` were read before changes. No listed finding conflicts with the spec.

### Findings addressed

| # | Repair and regression evidence |
|---|---|
| 1 | Find the nearest ancestor containing sibling `jcr_root/` and `META-INF/vault/` directories. Corrected the shared package fixture and verified both conventional `src/main/content` and direct package layouts retain explicit `clear` / `acl-clear-review`. |
| 2 | Read multiline Felix string arrays and legacy property continuations. Validate JSON roots and `scripts` / `references` types; invalid values produce a fatal diagnostic and unknown finding rather than an empty success. Valid strings in mixed JSON arrays remain available alongside the unknown. |
| 3 | Append LLM ACL results regardless of scan completeness. The end-to-end regression combines valid policy XML, malformed XML and malformed RepoInit JSON, merges an empty LLM result, and checks that all three findings survive in markdown and cache; a subsequent nonempty merge also preserves them. |
| 4 | Initialize ACL status as incomplete. Missing explicit API workspace roots warn instead of silently scanning the current directory; synchronous and asynchronous scanner exceptions still generate an incomplete markdown review and cache. Empty LLM merges cannot clear this status. Existing non-ACL workspace defaults are unchanged; the CLI still supplies its current directory. |
| 5 | Emit an unknown for each literal target of an unrecognized statement in a multi-path `set ACL on` block. Scoping to the second path now retains its unknown. |
| 6 | Consume the entire supported ACE/restriction syntax. Unterminated restrictions, trailing text, duplicate clauses, missing restriction values and misplaced restrictions produce unresolved unknowns. An additional RED→GREEN boundary case prevents restriction parsing from consuming part of a path. |
| 7 | Preserve raw inline element segments until the single path-decoding boundary. A scoped inline policy under escaped filesystem and XML names retains `_site/_x`, rather than decoding underscores twice. |
| 8 | Tokenize the raw POM, ignoring XML comments and inspecting only relevant FileVault/content-package plugin configurations. Unrelated plugin settings cannot establish eligibility; conflicting, conditional or unresolved settings remain unknown. No effective-POM resolution added. |
| 9 | Sort by file, script index, script-relative line, then ACE order. A two-script regression has later line numbers in the first script and verifies source order is not interleaved. |
| 10 | Use `path(s)` in incomplete-read warnings. A directory-traversal permission failure verifies the warning and incomplete status. |
| 11 | Fatal RepoInit configs now emit the required parse warning as well as an unknown finding. Dedicated invalid-JSON coverage and the empty-LLM end-to-end regression exercise this path. |
| 12 | Normalize ACE status to `parsed` / `unknown`, with declared empty/null fields for unknown entries and null reasons for parsed entries. Undecodable policy paths become unknown. Unreadable policy/config inputs and referenced scripts retain per-file unknown entries while preserving parsed findings and incomplete status. |
| 13 | Accept the standard Java-properties SYSTEM DOCTYPE by discarding that fixed declaration locally. No DTD/resource fetching or entity expansion is performed; a nonstandard DTD remains unknown. |
| 14 | Explain `not-set` as FileVault defaulting to `ignore`, while noting that build/install configuration is not visible. The covering-filter test still receives verdict `unknown`, not inferred eligibility. |
| 15 | Add an early ACL-review-only route before generic branch/catalog handling. Reuse or refresh the runbook and checklist, then stop; bypass apply handling, never edit ACL/RepoInit/filter inputs, and never connect to JCR. The later pattern-id route explicitly points to it. |

### Spec-over-plan rulings

- Preserve deterministic ACL evidence even for complete scans: the plan's incomplete-only append condition could erase malformed-input unknowns, contradicting the spec's unknown-never-clean requirement.
- Use relevant plugin configuration rather than the plan's whole-POM regex. This is bounded raw-source inspection, not effective Maven configuration resolution.
- Put script index before line when sorting RepoInit entries, following the spec's source-order requirement instead of the plan's generic file/line/order recipe.
- Retain unreadable-file unknown entries in addition to the incomplete scan marker, following the spec's per-file error behavior rather than only listing unreadable inputs.
- Require an explicit workspace root for the ACL API; preserve existing defaults for other patterns and the CLI.

### TDD evidence

All commands ran from the repository root using `/opt/homebrew/bin/node` (`v26.3.1`). Every test run set `TMPDIR` to the workspace-local `.superpowers/sdd/2026-11-17-acl-migration-runbook/test-fixtures` directory; it was removed after verification. Evidence logs remain alongside this report.

The RED commands used this form, with selectors listed below:

```bash
TMPDIR="$PWD/.superpowers/sdd/2026-11-17-acl-migration-runbook/test-fixtures" \
  /opt/homebrew/bin/node --test --test-name-pattern '<selector>' \
  plugins/aem/cloud-service/skills/migration/scripts/runbook-generator.test.js
```

| Evidence log prefix (`final-review-…`) | RED selector | RED result | Subsequent ACL GREEN |
|---|---|---|---|
| `package-layout` | `^acl: (package metadata\|resolvePackage\|filter root)` | 1 passed, 5 failed | 42 passed, 0 failed |
| `package-metadata` | `^acl: (package POM\|Java-properties\|not-set)` | 0 passed, 3 failed | 45 passed, 0 failed |
| `config` | `^acl: (multiline RepoInit\|RepoInit config type\|fatal RepoInit)` | 0 passed, 3 failed | 48 passed, 0 failed |
| `syntax` | `^acl: (unknown RepoInit\|malformed or unconsumed)` | 0 passed, 2 failed | 50 passed, 0 failed |
| `shape-order` | `^acl` | 46 passed, 9 failed | 55 passed, 0 failed |
| `generator` | `^acl: (direct scans\|scanner exceptions\|missing workspace\|complete scans)` | 0 passed, 4 failed | 59 passed, 0 failed |
| `syntax-boundary` | `^acl: malformed or unconsumed` | 0 passed, 1 failed | Final ACL run: 59 passed, 0 failed |

RED failures reproduced lost package metadata, `scripts: ["["]`, silently ignored non-string script values, missing parse warnings, dropped/misparsed statements, double decoding, interleaved scripts, absent ACE fields/unreadable entries, scanner rejection and erased deterministic findings.

### Final verification before commit

```bash
TMPDIR="$PWD/.superpowers/sdd/2026-11-17-acl-migration-runbook/test-fixtures" \
  /opt/homebrew/bin/node --test --test-name-pattern '^acl' \
  plugins/aem/cloud-service/skills/migration/scripts/runbook-generator.test.js
# tests 59; pass 59; fail 0; skipped 0

PATH="/opt/homebrew/bin:$PATH" \
TMPDIR="$PWD/.superpowers/sdd/2026-11-17-acl-migration-runbook/test-fixtures" \
  npm --prefix plugins/aem/cloud-service/skills/migration/scripts test
# tests 217; pass 215; fail 0; skipped 2
```

The full npm test command runs all six migration script test files. The baseline was 199 tests: 197 passed, 0 failed, 2 skipped. The same two opt-in Dispatcher E2E cases remain skipped because `DISPATCHER_E2E_SRC` / `DISPATCHER_SDK_SRC` are not configured:

- `E2E: convert a real flexible config, and the verify gate catches filter loss`
- `E2E: render conversion-report.md from the real converted output`

Full final output is captured in `final-review-acl-final.log` and `final-review-full-final.log`. `git diff --check` and `node --check` passed for all three changed JavaScript files.

### Files changed

- `plugins/aem/cloud-service/skills/migration/scripts/acl-scan-runner.js`
- `plugins/aem/cloud-service/skills/migration/scripts/runbook-generator.js`
- `plugins/aem/cloud-service/skills/migration/scripts/runbook-generator.test.js`
- `plugins/aem/cloud-service/skills/migration/scripts/README.md`
- `plugins/aem/cloud-service/skills/migration/SKILL.md`
- This report.

### Self-review and residual concerns

- Self-reviewed the complete fix diff against all 15 findings and spec sections 3.3, 4.1–4.5, 5–7. No deferred listed findings or known fix-wave blockers.
- Verified exact conservative verdict labels and clear-handling precedence remain unchanged. Unknowns remain actionable; incomplete reviews cannot display the no-definitions notice. Ancestor descriptions remain “potentially relevant (inherited),” not assertions of effective access.
- Confirmed no runtime dependencies, JCR/network operations, customer fixtures, source-input writes, or out-of-workspace test scratch were added. Production changes use Node 14-supported syntax/APIs; execution was verified on Node 26.3.1, not a Node 14 binary.
- Manually traced `aclPermissions`, “ACL review” and the generated explanation prompt through the early review-only route. No fresh-agent skill pressure test or separate re-review was run, honoring the explicit no-subagents requirement.
- Remaining validation limits are the two pre-existing opt-in Dispatcher E2E skips and lack of an executable Node 14 test run. Raw POM inspection remains intentionally conservative and does not resolve effective Maven configuration or prove runtime permissions.
- Preserved this plan's review artifacts and report as requested; removed only the synthetic fixture directory created by this fix wave.
