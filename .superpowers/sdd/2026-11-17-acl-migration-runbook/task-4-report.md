# Task 4 implementation report — ACL scan runner

## Status

Implemented Task 4 on `bwadhwa-adobe-acl-migration-runbook-design`. The scanner remains read-only, uses only Node built-ins, and makes no JCR connection.

## Implementation

- Added migration-path validation and relationship classification, with the specified actionable `TypeError` messages and path-boundary-safe ancestor/descendant matching.
- Added conservative severity and detail formatting. Ancestor policies are explicitly described as potentially relevant through inheritance; unknown entries remain high severity.
- Implemented `runAclScan` to discover FileVault policy XML, inline content policies, and RepoInit initializer configs/references. It skips build/VCS directories, decodes FileVault names, resolves XML package filter/acHandling metadata, scopes findings, sorts outputs deterministically, and returns relative file paths.
- Preserved malformed XML and unresolved RepoInit references as `acl-unknown`; undecodable FileVault paths remain findings marked as unresolved. Unreadable inputs produce an incomplete scan status while retaining findings already parsed; a missing root returns `ok: false` and an explicit error.
- Documented the ACL strategy and runner in `scripts/README.md`.
- Added focused coverage for validation, scoping precedence and sibling boundaries, severity, package-resolution outcomes, inherited ACL labeling, inline policies, RepoInit configs/references, malformed XML, skipped directories, undecodable paths, partial reads, and missing roots.

## TDD and verification

Commands were run from `plugins/aem/cloud-service/skills/migration/scripts`.

### RED

1. `/opt/homebrew/bin/node --test --test-name-pattern "^acl" runbook-generator.test.js`
   - Expected failure: 19 passed, 12 failed.
   - The new runner/API tests failed with `... is not a function`, confirming the requested APIs were absent before implementation.
2. After adding a regression test for ACL files with undecodable FileVault paths:
   `/opt/homebrew/bin/node --test --test-name-pattern "^acl: runAclScan retains ACL files" runbook-generator.test.js`
   - Expected failure: `0 !== 1`; the scanner was dropping the unresolved path.

### GREEN

`/opt/homebrew/bin/node --test --test-name-pattern "^acl" runbook-generator.test.js`

```text
tests 32
pass 32
fail 0
skipped 0
```

### Full suite

`/opt/homebrew/bin/node --test runbook-generator.test.js`

```text
tests 114
pass 114
fail 0
skipped 0
```

`git diff --check` and `/opt/homebrew/bin/node --check` for both changed JavaScript files also passed.

## Files changed

- `plugins/aem/cloud-service/skills/migration/scripts/acl-scan-runner.js`
- `plugins/aem/cloud-service/skills/migration/scripts/runbook-generator.test.js`
- `plugins/aem/cloud-service/skills/migration/scripts/README.md`
- `.superpowers/sdd/2026-11-17-acl-migration-runbook/task-4-report.md`

## Self-review and concerns

- Confirmed findings use workspace-relative paths; package-root absolute paths are not included in raw findings.
- Confirmed unknown/malformed entries are not silently treated as clean, unrelated entries are counted in the exact skip warning, and incomplete reads preserve previously parsed entries.
- No implementation blockers or unresolved requirements. The scanner is intentionally heuristic and cannot establish effective access: restrictions, other policies, and principal memberships still require runtime validation.
- No push performed.
