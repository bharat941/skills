# Task 5 implementation report — ACL runbook integration

## Status

Implemented Task 5 on `bwadhwa-adobe-acl-migration-runbook-design`. The runbook generator now consumes the read-only ACL scanner and preserves its findings, scan status, and migration paths through rendering and cache output.

## Implementation

- Added the `aclPermissions` pattern as the fourteenth pattern, with its review-only metadata, heuristic and always-render flags, `acl-scan` strategy, sample prompt, and the eight customer checklist items from the binding spec.
- Added `migrationPaths` validation at the start of `gatherFindings`, and injected `aclScan` as a test seam with `runAclScan` as the default. ACL scan warnings and incomplete results are preserved; partial findings remain available and incomplete scans stay in `needsLlmScan`.
- Updated rendering to always include the ACL section and checklist. Empty results use the pinned no-definitions notice and JCR-verification summary; incomplete scans retain an explicit JCR-verification warning after LLM merging. Always-render patterns are excluded from the clean-pattern block.
- Updated LLM merging to append to incomplete scanner results, retain their status, and combine sources where a scanner source exists.
- Added `migrationPaths` and `scanStatusByPattern` to the cache. Raw ACE fields are preserved and heuristic ACL cache findings are tagged with `confidence: 'heuristic'`.
- Expanded the registry test and added focused coverage for metadata, scanner integration and validation, empty and incomplete rendering, partial-scan LLM merge, and cache output.

## TDD and verification

Commands were run from `plugins/aem/cloud-service/skills/migration/scripts`. Test scratch data was directed to a workspace-local directory and removed after each run.

### RED

`/opt/homebrew/bin/node --test --test-name-pattern "^acl" runbook-generator.test.js`

- Expected failures before implementation: 32 passed, 7 failed.
- The new integration tests failed because the pattern, scan seam/status, always-render output, and cache integration were absent.

### GREEN

`/opt/homebrew/bin/node --test --test-name-pattern "^acl" runbook-generator.test.js`

```text
tests 39
pass 39
fail 0
skipped 0
```

### Full suite

`/opt/homebrew/bin/node --test runbook-generator.test.js`

```text
tests 121
pass 121
fail 0
skipped 0
```

`node --check` passed for both changed JavaScript files, and `git diff --check` passed.

## Files changed

- `plugins/aem/cloud-service/skills/migration/scripts/runbook-generator.js`
- `plugins/aem/cloud-service/skills/migration/scripts/runbook-generator.test.js`
- `.superpowers/sdd/2026-11-17-acl-migration-runbook/task-5-report.md`

## Self-review and concerns

- Confirmed the rendered section characterizes package filter and `acHandling` data as a conservative eligibility signal, states that code is not the source JCR of truth, and does not present package metadata as proof of runtime execution or effective permissions.
- Scanner-provided ancestor detail remains “potentially relevant (inherited)”; the description and checklist explicitly distinguish this from effective access and call out runtime restrictions, policy ordering, and memberships.
- Confirmed failed and partial scans remain explicitly incomplete after LLM findings are merged; LLM fallback cannot present them as clean.
- No JCR operations or runtime dependencies were added. No unresolved concerns. No push performed.

## Commit

`feat(migration): render ACL review section and checklist in runbook`

## Follow-up fix — incomplete ACL scan rendering

The ACL section now says `No ACL findings are available because the scan was incomplete.` when the scan status is incomplete and no findings are available. The pinned no-definitions notice remains limited to completed scans. Added assertions to the failed-scan rendering test for both behaviors.

### TDD and verification

From `plugins/aem/cloud-service/skills/migration/scripts`:

- RED: `/opt/homebrew/bin/node --test --test-name-pattern '^acl' runbook-generator.test.js` — 38 passed, 1 failed, as expected. The new failed-scan assertion failed because the renderer emitted the no-definitions notice instead of the incomplete-scan message.
- GREEN: same targeted command — 39 passed, 0 failed.
- Full suite: `/opt/homebrew/bin/node --test runbook-generator.test.js` — 121 passed, 0 failed.

`node` was not on `PATH`; the tests were run using `/opt/homebrew/bin/node`.
