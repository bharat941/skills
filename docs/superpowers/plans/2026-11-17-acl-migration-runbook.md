# ACL-aware Migration Runbook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `aclPermissions` pattern to the migration runbook. It reports ACL entries defined in code (`_rep_policy.xml`, inline `rep:policy`, RepoInit) on the migration paths, their ancestors and their descendants, with conservative import-eligibility labels and a customer checklist.

**Architecture:** A new zero-dependency `scripts/acl-scan-runner.js` exposes `runAclScan(root, {migrationPaths})` and returns the standard runner contract. `runbook-generator.js` gains an `acl-scan` strategy block, an `alwaysRender` and checklist rendering path, a per-pattern `scanStatus` that an LLM merge can never clear, and a validated, repeatable `--migration-path` CLI flag.

**Tech Stack:** Node.js CommonJS (`'use strict'`, `require`); no new dependencies; tests use `node:test` and `node:assert` with temp-dir fixtures.

**Spec:** `docs/superpowers/specs/2026-11-17-acl-migration-runbook-design.md`. Section references (§) below point to it.

## Global Constraints

- Zero runtime dependencies. Scripts must keep running on the `package.json` `engines` floor (Node ≥14), so don't use `??=`, `Array.prototype.at`, or `structuredClone` in runtime code.
- **Read-only:**
  - never write ACLs, RepoInit, filters or any file other than the runbook and cache;
  - never connect to a JCR, AEM or Cloud Manager.
- **Unknown or ambiguous input stays `unknown` and is never reported clean.** Never drop an entry the scanner can't parse.
- Use the conservative import labels exactly: `eligible-for-acl-import`, `not-eligible-for-acl-import`, `acl-clear-review`, `repoinit-defined`, `unknown`. Never use the word "deploys".
- Ancestor ACEs are labelled `potentially relevant (inherited)` and are never described as effective access.
- Test fixtures are synthetic. Don't copy customer files, and don't use the customer names (Cox/Signify) as principal or path values.
- ACL restriction values are rendered verbatim. They are not secrets.
- All existing tests (82 at baseline) keep passing. The only existing test that changes is the registry-count test, which goes from 13 to 14 patterns.
- **Test command (from `plugins/aem/cloud-service/skills/migration/scripts`):** `node --test runbook-generator.test.js`.
  - In this environment `node` may not be on `PATH`; use `/opt/homebrew/bin/node`.
  - All new test names start with `acl:` so `--test-name-pattern "^acl"` selects them.
- **Commits:** conventional-commit subjects, ending with the trailer `Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`. Don't push.

## Review Focus

1. **Sibling-prefix paths:** migration path `/content/site` vs policy `/content/site2`. This must be `unrelated`, not `descendant` or `ancestor`. Test: Task 4 `acl: relationTo does not treat sibling prefixes as related`.
2. **Sibling-prefix filter roots:** filter root `/conf/acme/list` vs policy `/conf/acme/lists/x`. This must be `not-covered`. Test: Task 2 `acl: filter root sibling prefix does not cover`.
3. **Escaped commas and typed values in FileVault arrays:** for example `rep:glob="{String}[a\,b]"`. The value must be kept as the single value `a,b`. Test: Task 1 `acl: parseFileVaultValue handles types, escaped commas and entities`.
4. **Build output copies:** a `_rep_policy.xml` copied under `target/` or `dist/` must not produce duplicate entries. Test: Task 4 `acl: runAclScan skips build and VCS directories`.
5. **CRLF line endings:** line numbers on Windows-authored XML and RepoInit must be correct. Test: Task 1 `acl: parsePolicyXml reports ACE line numbers with CRLF`.

---

## File map

| File | Responsibility |
|---|---|
| Create `plugins/aem/cloud-service/skills/migration/scripts/acl-scan-runner.js` | All ACL parsing, package resolution, scoping, and the `runAclScan` entry point |
| Modify `.../scripts/runbook-generator.js` | Pattern registry, `acl-scan` block, scan status, rendering, cache, LLM merge, CLI |
| Modify `.../scripts/runbook-generator.test.js` | All new tests (`acl:` prefix) plus the registry test update |
| Modify `.../scripts/README.md` | Runner section and strategy-table row |
| Modify `.../migration/SKILL.md` | Step 0 strategy row and `--migration-path`; Step 3 "no apply flow" |

## Shared types (`acl-scan-runner.js`)

`AceEntry` uses exactly the fields in spec §4.2, plus these RepoInit-only fields:

- `scriptIndex: number|null`: index into the config's `scripts`.
- `scriptLine: number|null`: 1-based line within that script.

Parsers fill `kind`, `sourceType`, `line`, `policyPath`, `order`, `effect`, `principals`, `privileges`, `restrictions`, `runmode`, `status` and `reason`. `runAclScan` fills `file`, `relation`, `matchedPaths`, `filterStatus`, `acHandling` and `importVerdict`.

For `acl-unknown` entries:

- `effect` is `null`;
- `principals`, `privileges` and `restrictions` are empty;
- `status` is `'unknown'`;
- `reason` is a non-empty string.

> Plan refinement of spec §3.2: parsers return unknowns *inside* `entries` as `kind: 'acl-unknown'` (not a separate `unknown` array), plus `fatal: string|null` for whole-file failures. This keeps the "never drop" rule to a single code path.

---

### Task 1: Policy XML parsing

**Files:**
- Create: `plugins/aem/cloud-service/skills/migration/scripts/acl-scan-runner.js`
- Test: `plugins/aem/cloud-service/skills/migration/scripts/runbook-generator.test.js` (append a `// ── ACL scan ──` section and add a `require('./acl-scan-runner.js')` import at the top)

**Interfaces:**
- Produces:
  - `decodeFileVaultPath(segments: string[]) -> string|null`
  - `parseFileVaultValue(raw: string) -> string[]|null`
  - `parsePolicyXml(text: string, { nodePath: string|null, inline?: boolean }) -> { entries: AceEntry[], fatal: string|null }`

- [ ] **Step 1: Write the failing tests**

```js
test('acl: decodeFileVaultPath decodes namespaces, double underscores and %xx', () => {
  assert.strictEqual(decodeFileVaultPath(['content', '_jcr_content', 'a%3Ab']), '/content/jcr:content/a:b');
  assert.strictEqual(decodeFileVaultPath(['__x']), '/_x');
  assert.strictEqual(decodeFileVaultPath([]), '/');
  assert.strictEqual(decodeFileVaultPath(['bad%E0%A4']), null);
});

test('acl: parseFileVaultValue handles types, escaped commas and entities', () => {
  assert.deepStrictEqual(parseFileVaultValue('{Name}[jcr:read,rep:write]'), ['jcr:read', 'rep:write']);
  assert.deepStrictEqual(parseFileVaultValue('{String}[a\\,b]'), ['a,b']);
  assert.deepStrictEqual(parseFileVaultValue('*/jcr:content*'), ['*/jcr:content*']);
  assert.deepStrictEqual(parseFileVaultValue('[]'), []);
  assert.strictEqual(parseFileVaultValue('[unterminated'), null);
});
```

Add `acl: parsePolicyXml parses grant/deny ACEs in order with restrictions`. Fixture: a `jcr:root` element (`rep:ACL`) with three children:

1. `allow` (`rep:GrantACE`): `rep:principalName="example-editors"`, `rep:privileges="{Name}[jcr:read,rep:write]"`, `rep:glob="*/jcr:content*"`.
2. `deny` (`rep:DenyACE`): `example-guests`, `{Name}[jcr:all]`, with a child `rep:restrictions` that has `rep:ntNames="{Name}[cq:Page,dam:Asset]"`.
3. `allow1` with `jcr:primaryType="rep:UnknownACE"`.

Assert:

```js
const { entries, fatal } = parsePolicyXml(xml, { nodePath: '/content/x' });
assert.strictEqual(fatal, null);
assert.deepStrictEqual(entries.map(e => [e.order, e.effect, e.kind]), [[0, 'allow', 'acl-entry'], [1, 'deny', 'acl-entry'], [2, null, 'acl-unknown']]);
assert.deepStrictEqual(entries[0].restrictions, { 'rep:glob': ['*/jcr:content*'] });
assert.deepStrictEqual(entries[1].restrictions, { 'rep:ntNames': ['cq:Page', 'dam:Asset'] });
assert.deepStrictEqual(entries[0].privileges, ['jcr:read', 'rep:write']);
assert.ok(entries.every(e => e.policyPath === '/content/x' && e.sourceType === 'policy-xml'));
assert.match(entries[2].reason, /unexpected ACE type rep:UnknownACE/);
```

Also add:

- `acl: parsePolicyXml marks ACEs missing principal or privileges unknown`: `reason` matches `/missing rep:principalName/` and `/missing rep:privileges/` respectively.
- `acl: parsePolicyXml inline rep:policy resolves nested node path`: a `.content.xml` text with `<jcr:root><jcr:content><rep:policy jcr:primaryType="rep:ACL">…`, parsed with `{ nodePath: '/content/site', inline: true }`. Every entry has `policyPath === '/content/site/jcr:content'` and `sourceType === 'inline-policy'`. An element named `rep:policy` whose type is not `rep:ACL` yields one `acl-unknown`.
- `acl: parsePolicyXml returns fatal for malformed XML`: an unclosed `<allow`. `fatal` is a non-empty string and `entries` is `[]`.
- `acl: parsePolicyXml reports ACE line numbers with CRLF`: the same fixture joined with `\r\n`. `entries[1].line` equals the 1-based line of the `<deny` tag.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern "^acl" runbook-generator.test.js`
Expected: FAIL with `Cannot find module './acl-scan-runner.js'`.

- [ ] **Step 3: Implement the three functions in `acl-scan-runner.js`**

**Tokenizer:** a regex tag tokenizer (`<!--…-->`, `<?…?>`, start, self-closing and end tags) with an element stack.

- `fatal` covers mismatched or unclosed tags and stray `<`.
- Decode attribute entities `&amp; &lt; &gt; &quot; &apos; &#N; &#xN;`.
- Line = count of `\n` before the tag start, plus 1.

**`parseFileVaultValue`:**
- Strip an optional leading `{Type}`.
- A bracketed value splits on unescaped `,` and unescapes `\,` and `\\`.
- An unbracketed value is a single value.
- An unbalanced `[` returns `null`.

**ACE rules:**
- **Effect:** `rep:GrantACE` → `allow`; `rep:DenyACE` → `deny`.
- **Restrictions:** every ACE attribute except `jcr:primaryType`, `rep:principalName`, `rep:privileges` and `xmlns:*`, plus every attribute of a `rep:restrictions` child except `jcr:primaryType`. Merge them by name. Values come from `parseFileVaultValue`.
- **Order:** the 0-based index among the ACL element's children.
- **`_rep_policy.xml`:** the root must have type `rep:ACL`. Otherwise emit one `acl-unknown` with reason `root is not rep:ACL`.
- **Inline:** process only elements named `rep:policy`. The policy path is `nodePath` plus the decoded names of the enclosing elements below `jcr:root`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-name-pattern "^acl" runbook-generator.test.js`
Expected: PASS (all `acl:` tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/aem/cloud-service/skills/migration/scripts/acl-scan-runner.js plugins/aem/cloud-service/skills/migration/scripts/runbook-generator.test.js
git commit -m "feat(migration): parse FileVault ACL policy XML for ACL scan"
```

---

### Task 2: Package filter, acHandling and import verdict

**Files:**
- Modify: `.../scripts/acl-scan-runner.js`
- Test: `.../scripts/runbook-generator.test.js`

**Interfaces:**
- Produces:
  - `resolvePackage(fileAbs: string, policyPath: string|null, workspaceRoot: string) -> { packageRoot: string|null, filterStatus: 'covered'|'not-covered'|'unknown', acHandling: 'ignore'|'overwrite'|'merge'|'merge_preserve'|'clear'|'not-set'|'unknown', importVerdict: string }`
  - `importVerdict(filterStatus: string, acHandling: string) -> 'acl-clear-review'|'not-eligible-for-acl-import'|'eligible-for-acl-import'|'unknown'`

- [ ] **Step 1: Write the failing tests**

Add a test helper:

```js
function writeContentPackage(root, mod, { filters, acHandling, acIn = 'properties' } = {})
```

It writes:
- `<mod>/src/main/content/jcr_root/.keep`;
- `META-INF/vault/filter.xml`, from `filters: [{ root, rules?: [['include'|'exclude', pattern]] }]`, but only when `filters` is set;
- `acHandling`, either into `META-INF/vault/properties.xml` (`<entry key="acHandling">`) or into `<mod>/pom.xml` (`<accessControlHandling>`), depending on `acIn`.

It returns `<mod>/src/main/content`.

Tests:

- `acl: importVerdict follows first-match table`: assert every row of spec §4.4:
  ```js
  assert.strictEqual(importVerdict('covered', 'clear'), 'acl-clear-review');
  assert.strictEqual(importVerdict('not-covered', 'clear'), 'acl-clear-review');
  assert.strictEqual(importVerdict('not-covered', 'merge'), 'not-eligible-for-acl-import');
  assert.strictEqual(importVerdict('covered', 'ignore'), 'not-eligible-for-acl-import');
  assert.strictEqual(importVerdict('unknown', 'ignore'), 'not-eligible-for-acl-import');
  for (const h of ['overwrite', 'merge', 'merge_preserve']) assert.strictEqual(importVerdict('covered', h), 'eligible-for-acl-import');
  assert.strictEqual(importVerdict('covered', 'not-set'), 'unknown');
  assert.strictEqual(importVerdict('unknown', 'merge'), 'unknown');
  ```
- `acl: resolvePackage reports not-covered when filter misses the policy path` (Cox shape): filter root `/conf/acme/other`, policy `/conf/acme/lists/x`, no acHandling. Expect `filterStatus: 'not-covered'`, `acHandling: 'not-set'` and `importVerdict: 'not-eligible-for-acl-import'`.
- `acl: filter root sibling prefix does not cover`: root `/conf/acme/list`, policy `/conf/acme/lists/x` → `not-covered`.
- `acl: resolvePackage include/exclude rules, last match wins`: root `/content/a` with rules `[['exclude', '/content/a/b(/.*)?'], ['include', '/content/a/b/c(/.*)?']]`.
  - Policy `/content/a/b/c` → `covered`.
  - Policy `/content/a/b` → `not-covered`.
- `acl: resolvePackage unknown filter cases`:
  - No `filter.xml` → `unknown`.
  - Malformed `filter.xml` → `unknown`.
  - Pattern `'('` (invalid regex) → `unknown`.
  - No `jcr_root`/`META-INF` ancestor → `packageRoot: null`, `filterStatus: 'unknown'`, `acHandling: 'unknown'` and verdict `unknown`.
- `acl: resolvePackage acHandling sources and clear`:
  - `properties.xml` `merge_preserve` with a covering filter → `eligible-for-acl-import`.
  - pom-only `Overwrite` (case-insensitive) → `overwrite`.
  - `properties.xml` wins over the pom when both are set.
  - `clear`, whether the filter covers or not → `acl-clear-review`.
  - An unrecognized value `foo` → `acHandling: 'unknown'`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern "^acl" runbook-generator.test.js`
Expected: the new tests FAIL with `resolvePackage is not a function` or `importVerdict is not a function`.

- [ ] **Step 3: Implement in `acl-scan-runner.js`**

**Package root:** the nearest ancestor directory (bounded by `workspaceRoot`) that contains both a `jcr_root/` directory and a `META-INF/vault/` directory.

**Filter coverage:**
- Target is `<policyPath>/rep:policy`, or `/rep:policy` for `/`.
- A filter applies when target `=== root` or `startsWith(root === '/' ? '/' : root + '/')`.
- With no rules the target is included. Otherwise the initial state is the opposite of the first rule's type. Each rule whose `new RegExp('^(?:' + p + ')$')` matches sets the state, and the last match wins.
- `covered` if any applicable filter includes the target; otherwise `not-covered`.
- Use the Task 1 tokenizer for `filter.xml`.

**acHandling:**
- Read `properties.xml` `<entry key="acHandling">` first.
- Then the nearest `pom.xml` at or above the package root, inside `workspaceRoot`, using a text regex for `<accessControlHandling>` or `<acHandling>`.
- Lower-case the value. Values outside the six known names → `unknown`.
- Not found anywhere → `not-set`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-name-pattern "^acl" runbook-generator.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/aem/cloud-service/skills/migration/scripts/acl-scan-runner.js plugins/aem/cloud-service/skills/migration/scripts/runbook-generator.test.js
git commit -m "feat(migration): assess package filter and acHandling for code ACLs"
```

---

### Task 3: RepoInit discovery and parsing

**Files:**
- Modify: `.../scripts/acl-scan-runner.js`
- Test: `.../scripts/runbook-generator.test.js`

**Interfaces:**
- Produces:
  - `isRepoInitConfigName(fileName: string) -> boolean`
  - `readRepoInitConfig(fileAbs: string, text: string) -> { scripts: string[], references: string[], runmode: string|null, fatal: string|null }`
  - `parseRepoInit(text: string, { runmode?: string|null }) -> { entries: AceEntry[] }`. Entries carry `scriptLine`; the caller sets `scriptIndex`, `file` and `line`.

- [ ] **Step 1: Write the failing tests**

- `acl: isRepoInitConfigName matches ~, legacy - and bare PIDs only`:
  ```js
  const P = 'org.apache.sling.jcr.repoinit.RepositoryInitializer';
  for (const n of [`${P}~a.cfg.json`, `${P}-b.config`, `${P}.cfg`, `${P}~x-y.cfg.json`]) assert.ok(isRepoInitConfigName(n), n);
  for (const n of [`${P}Factory~a.cfg.json`, `${P}Extra.cfg.json`, `${P}~a.json`, `other.${P}~a.cfg.json`]) assert.ok(!isRepoInitConfigName(n), n);
  ```
- `acl: readRepoInitConfig reads cfg.json, .config and .cfg`:
  - `.cfg.json` with `scripts` as a string and as an array, plus `references`.
  - Felix `.config` `scripts=["set ACL for a\n  allow jcr:read on /x\nend"]`, unescaping `\n` and `\"`.
  - `.cfg` `scripts=...`.
  - A file under `config.author/` gives `runmode: 'author'`; a file under `config/` gives `null`.
  - Invalid JSON gives a non-empty `fatal`.
- `acl: parseRepoInit parses set ACL for/on with restrictions and multi-path`: a script with three blocks.
  ```
  set ACL for example-svc, example-editors
    allow jcr:read,rep:write on /content/a,/content/b restriction(rep:glob,*/jcr:content*)
  end
  set ACL on /conf/x
    deny jcr:all for everyone restriction(rep:ntNames,cq:Page,dam:Asset)
    remove * for example-svc
  end
  set principal ACL for example-svc
    allow jcr:read on /content/c
  end
  ```
  Assert:
  - The first block yields two `allow` entries (`/content/a`, `/content/b`) with `principals ['example-svc','example-editors']` and `restrictions {'rep:glob':['*/jcr:content*']}`.
  - The deny entry is on `/conf/x` with `principals ['everyone']` and `restrictions {'rep:ntNames':['cq:Page','dam:Asset']}`.
  - The `remove` line becomes `acl-unknown` with `scriptLine` 6 and `reason` matching `/unrecognized/`.
  - The principal block becomes one `acl-unknown` with `reason` matching `/principal-based/`.
  - All parsed entries have `sourceType 'repoinit'` and `runmode` passed through.
- `acl: parseRepoInit flags home(), :repository and unterminated blocks unknown`: each yields an `acl-unknown` whose `policyPath` is `null` and whose `reason` is non-empty.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern "^acl" runbook-generator.test.js`
Expected: the new tests FAIL with `isRepoInitConfigName is not a function`.

- [ ] **Step 3: Implement in `acl-scan-runner.js`**

**Config name:** `isRepoInitConfigName` uses `/^org\.apache\.sling\.jcr\.repoinit\.RepositoryInitializer(?:[~-][^/\\]+)?\.(?:cfg\.json|config|cfg)$/`.

**Run mode:** the parent folder name matches `/^config(?:\.(.+))?$/` → group 1, else `null`.

**Parsing:**
- Line-based over `text.split(/\r?\n/)`. Ignore blank lines and lines starting with `#`.
- Outside an ACL block, ignore other statements.
- `for`/`on` lists split on `,` with whitespace trimmed.
- `restriction(name,v1,v2…)` may repeat.
- ACE line grammar inside a block:
  ```
  (allow|deny) <privs> [on <paths>] [for <principals>] (restriction(...))*
  ```
  Inside `set ACL for`, `on` is required. Inside `set ACL on`, `for` is required.
- Any other line inside a block → `acl-unknown` `unrecognized RepoInit ACL line: <text>`.
- A path that is not absolute (`home(…)`, `:repository`) → `acl-unknown` with `policyPath: null`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-name-pattern "^acl" runbook-generator.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/aem/cloud-service/skills/migration/scripts/acl-scan-runner.js plugins/aem/cloud-service/skills/migration/scripts/runbook-generator.test.js
git commit -m "feat(migration): discover and parse RepoInit ACL statements"
```

---

### Task 4: Scoping, severity, display, and `runAclScan`

**Files:**
- Modify: `.../scripts/acl-scan-runner.js` (add `module.exports`)
- Modify: `.../scripts/README.md` (new `### acl-scan-runner.js` section after `osgi-config-runner.js`, plus a strategy-table row `aclPermissions | acl-scan | acl-scan-runner.js (code ACLs — review-only, heuristic)`)
- Test: `.../scripts/runbook-generator.test.js`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces (all exported from `acl-scan-runner.js`, along with the Task 1–3 functions):
  - `validateMigrationPaths(paths: unknown[]) -> string[]`. Normalized; throws `TypeError`.
  - `relationTo(policyPath: string|null, migrationPaths: string[]) -> { relation: 'self'|'ancestor'|'descendant'|'unrelated'|'unscoped'|null, matchedPaths: string[] }`
  - `aceSeverity(entry: AceEntry) -> 'high'|'medium'`
  - `formatAceDetail(entry: AceEntry) -> string`
  - `runAclScan(workspaceRoot: string, { migrationPaths?: string[] }) -> { ok: boolean, findings: {location, detail, severity}[], rawFindings: object[], warnings: string[], scanStatus: 'complete'|'incomplete', unreadable: string[], error?: string }`

**Exact copy pinned here:**
- `TypeError` messages:
  - Missing value: `--migration-path requires a value, e.g. --migration-path /content/site`.
  - Otherwise: `Invalid --migration-path "<value>": expected an absolute JCR path such as --migration-path /content/site (no "..", "//", or wildcards *?[]).`
- Unscoped warning: `No --migration-path given: ACL entries are reported unscoped and inheritance relevance was not assessed. Re-run with --migration-path <jcrPath> (repeatable) for each migration-set path.`
- Skip warning: `<N> ACL entries outside the migration paths were skipped.`
- Malformed-file warning: `ACL file could not be parsed: <relFile> — <fatal>`.
- Incomplete warning: `ACL scan incomplete: <N> file(s) could not be read: <relFiles joined ', '>`.

**Detail format (spec §5):**

```
<policyPath|file> [<rel>] <effect> <principals ,-joined> <privileges ,-joined> restrictions{<name>=[<v,…>]; …} | filter: <s> | acHandling: <a> | import: <v>
```

- `[<rel>]` is one of:
  - `self <P>`
  - `ancestor of <P,…> — potentially relevant (inherited)`
  - `descendant of <P,…>`
  - `unscoped`
  - `path unresolved` (when `relation` is null)
- `restrictions{}` is printed when the entry has no restrictions.
- RepoInit entries replace the `filter`/`acHandling` part with `runmode: <rm|any>`, so the tail reads `| runmode: <rm|any> | import: repoinit-defined`.
- Unknown entries: `<policyPath|file> UNKNOWN — <reason>`.
- Finding `location` is `file:line`. For RepoInit config files it is `file (scripts[i]:scriptLine)`.

- [ ] **Step 1: Write the failing tests**

- `acl: validateMigrationPaths normalizes and rejects invalid values`:
  - `['/content/site/', '/']` → `['/content/site', '/']`.
  - Each of `'content/x'`, `''`, `'/a/../b'`, `'/a//b'`, `'/a/*'` throws a `TypeError` whose message includes that value and `--migration-path /content/site`.
  - `[undefined]` throws `/requires a value/`.
- `acl: relationTo classifies self/ancestor/descendant/unrelated with precedence`:
  ```js
  assert.deepStrictEqual(relationTo('/content/site', ['/content/site']), { relation: 'self', matchedPaths: ['/content/site'] });
  assert.deepStrictEqual(relationTo('/', ['/content/site']).relation, 'ancestor');
  assert.deepStrictEqual(relationTo('/content/site/en', ['/content/site']).relation, 'descendant');
  assert.deepStrictEqual(relationTo('/content', ['/content/site/en', '/content']), { relation: 'self', matchedPaths: ['/content/site/en', '/content'] });
  assert.deepStrictEqual(relationTo('/x', []), { relation: 'unscoped', matchedPaths: [] });
  assert.deepStrictEqual(relationTo(null, ['/content']), { relation: null, matchedPaths: [] });
  ```
- `acl: relationTo does not treat sibling prefixes as related`: `relationTo('/content/site2', ['/content/site']).relation === 'unrelated'`, and also with the two paths swapped.
- `acl: aceSeverity follows spec §4.5`:
  - `high` for any of: ancestor, `status 'unknown'`, and each of the three risky verdicts.
  - `medium` for `self` + `eligible-for-acl-import` and for `unscoped` + `repoinit-defined`.
- `acl: runAclScan Cox shape reports not-covered with glob preserved`:
  - Package via `writeContentPackage` with filter root `/conf/acme/other`.
  - `jcr_root/conf/acme/lists/x/_rep_policy.xml` with a grant ACE `rep:glob="*/jcr:content*"`.
  - Run with `migrationPaths: ['/conf/acme/lists/x']`.
  - Expect one raw entry: `kind 'acl-entry'`, `relation 'self'`, `filterStatus 'not-covered'`, `importVerdict 'not-eligible-for-acl-import'`, finding `severity 'high'`, and `detail` containing `rep:glob=[*/jcr:content*]` and `import: not-eligible-for-acl-import`.
  - `file` is workspace-relative: it does not start with the root.
- `acl: runAclScan Signify shape marks ancestor potentially relevant`:
  - `jcr_root/content/experience-fragments/_rep_policy.xml`, a covering filter, and `acHandling merge_preserve`.
  - Run with `migrationPaths ['/content/experience-fragments/site']`.
  - Expect `relation 'ancestor'`, `importVerdict 'eligible-for-acl-import'` and severity `high`.
  - `detail` matches `/potentially relevant \(inherited\)/` and does not match `/effective/i`.
- `acl: runAclScan scoping excludes unrelated, warns unscoped, decodes names`:
  - Policies on `/content/site`, `/content/site/en/_jcr_content` (decoded to `jcr:content`) and `/content/other`.
  - With `['/content/site']`: 2 entries kept, and a warning `1 ACL entries outside the migration paths were skipped.`
  - With no paths: 3 `unscoped` entries plus the exact unscoped warning.
- `acl: runAclScan includes inline policies, RepoInit and unknown files`:
  - Fixtures:
    - a `.content.xml` with an inline policy;
    - `config.author/…RepositoryInitializer~a.cfg.json`;
    - `config/…RepositoryInitializer-b.config`;
    - `…RepositoryInitializerExtra.cfg.json`, which must be ignored;
    - a malformed `_rep_policy.xml` under `/content/site/bad`.
  - Expect:
    - an `inline-policy` entry;
    - RepoInit entries from both `~a` and `-b`, with `importVerdict 'repoinit-defined'` and `runmode 'author'` / `null`;
    - none from `Extra`;
    - one `acl-unknown` for the malformed file with `policyPath '/content/site/bad'`, plus the malformed-file warning;
    - `scanStatus 'complete'`.
- `acl: runAclScan resolves in-workspace RepoInit references and flags others unknown`:
  - `references: ['file:repoinit/acl.txt', 'https://example.invalid/x']`.
  - The file's ACEs are reported with `file` pointing at the `.txt` and real `line` numbers.
  - The URL yields `acl-unknown` with `reason` matching `/unresolved RepoInit reference/`.
- `acl: runAclScan skips build and VCS directories`: identical `_rep_policy.xml` files under `jcr_root/content/a`, `target/classes/jcr_root/content/a`, `dist/jcr_root/content/a` and `node_modules/x/jcr_root/content/a` produce exactly 1 entry.
- `acl: runAclScan partial read is incomplete but keeps parsed entries`:
  - Create two policies, then `fs.chmodSync(file2, 0o000)`.
  - Skip with `t.skip()` when `process.getuid && process.getuid() === 0`.
  - Expect `ok true`, `scanStatus 'incomplete'`, `unreadable` length 1, the incomplete warning, and 1 entry kept.
  - Restore the permissions in `finally`.
- `acl: runAclScan with missing root returns ok false`: `runAclScan('/nonexistent-' + Date.now())` → `ok: false`, `scanStatus 'incomplete'`, `error` non-empty.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern "^acl" runbook-generator.test.js`
Expected: the new tests FAIL with `runAclScan is not a function`.

- [ ] **Step 3: Implement in `acl-scan-runner.js`**

**Walk:**
- Recursive `fs.readdirSync(..., { withFileTypes: true })`.
- Skip `node_modules`, `.git`, `target` and `dist`, matching `legacy-ui-runner.js`.
- Collect `_rep_policy.xml` files and `.content.xml` files that live under a `jcr_root` segment, plus files that satisfy `isRepoInitConfigName`.
- For `.content.xml`, call `parsePolicyXml` only when the text contains `rep:policy`.

**Node paths:** derive them from the path segments after the last `jcr_root`, split on `/[\\/]/`. Then:
- `_rep_policy.xml` → the decoded parent directory;
- `.content.xml` → its decoded directory.

**Errors:**
- `readFileSync` errors add the file to `unreadable`.
- A parser `fatal` adds one `acl-unknown` entry with reason `malformed: <fatal>`.

**Assembly and scoping:**
- Call `resolvePackage` for XML entries.
- RepoInit entries get `filterStatus`/`acHandling` of `null` and the `repoinit-defined` verdict. `unknown` RepoInit entries keep `importVerdict 'unknown'`.
- Run `relationTo` and drop `unrelated`.
- Sort by `file`, then `line`, then `order`.

**Raw findings:** `{ pattern: 'aclPermissions', snippet: null, ...entry }` with a workspace-relative `file`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-name-pattern "^acl" runbook-generator.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/aem/cloud-service/skills/migration/scripts/acl-scan-runner.js plugins/aem/cloud-service/skills/migration/scripts/runbook-generator.test.js plugins/aem/cloud-service/skills/migration/scripts/README.md
git commit -m "feat(migration): add read-only ACL scan runner with migration-path scoping"
```

---

### Task 5: Generator integration (pattern, gather, render, cache, LLM merge)

**Files:**
- Modify: `.../scripts/runbook-generator.js`
  - `PATTERN_META` (~95–238)
  - imports (~69–78)
  - `gatherFindings` (~318–565)
  - `renderRunbook` (~612–718)
  - `SOURCE_LABEL` (~720)
  - `writeRunbookCache` (~753)
  - `mergeLlmFindings` (~788)
  - `generateRunbook` (~818)
- Test: `.../scripts/runbook-generator.test.js`; update `registry includes all 13 migration patterns…` (~line 32)

**Interfaces:**
- Consumes: `runAclScan` and `validateMigrationPaths` from Task 4.
- Produces:
  - `gatherFindings(options)` accepts `migrationPaths?: string[]` (validated; throws `TypeError` before any scan) and `aclScan?: typeof runAclScan` (test seam, defaults to `runAclScan`).
  - The gathered result gains `migrationPaths: string[]` and `scanStatusByPattern: Record<string, 'complete'|'incomplete'>` (only set for `aclPermissions`).
  - `generateRunbook(options)` forwards `migrationPaths`.
  - The cache gains top-level `migrationPaths` and `scanStatusByPattern`.

- [ ] **Step 1: Update the registry test and write the failing tests**

Registry test:
- Title becomes `14`.
- Add `'aclPermissions'` to `expected`.
- Add `'acl-scan'` to the valid-strategy list.

New tests:

- `acl: aclPermissions meta is review-only, always rendered, heuristic`:
  - `strategy 'acl-scan'`, `bpaSlugs []`, `heuristic true`, `alwaysRender true`, `severity 'high'`.
  - `checklist.length === 8`.
  - `sourceLabel('acl-scan') === 'ACL scan'`.
- `acl: gatherFindings runs the ACL scan with migrationPaths`:
  - Cox-shaped workspace and `migrationPaths ['/conf/acme/lists/x']`.
  - Expect `sourceByPattern.aclPermissions === 'acl-scan'`, `findingsByPattern.aclPermissions.length === 1`, `scanStatusByPattern.aclPermissions === 'complete'`, `!needsLlmScan.includes('aclPermissions')`, and `migrationPaths` deep-equal to the input.
- `acl: gatherFindings rejects invalid migrationPaths before scanning`: `await assert.rejects(gatherFindings({ workspaceRoot: ws, migrationPaths: ['content/x'] }), TypeError)`.
- `acl: zero findings still render section and checklist, never clean`:
  - Empty workspace, then `renderRunbook`.
  - The markdown contains:
    - the `## ACLs / Permissions for Migrated Content (\`aclPermissions\`)` section;
    - `No ACL definitions found in code for the scoped paths. This does not mean the source repository has no ACLs.`;
    - `### Customer checklist` and a `- [ ] ` line for each checklist item;
    - the summary row containing `— (verify in JCR)`.
  - The `## Scanned — no findings` block does not mention `aclPermissions`.
- `acl: scanner failure is incomplete and stays incomplete after LLM merge`:
  - Set `aclScan: () => ({ ok: false, error: 'boom', findings: [], rawFindings: [], warnings: [], scanStatus: 'incomplete', unreadable: [] })`.
  - Expect `needsLlmScan` to include `aclPermissions`, `scanStatusByPattern.aclPermissions === 'incomplete'`, and the warnings to include `aclPermissions scan did not run: boom`.
  - Then `mergeLlmFindings(g, { aclPermissions: [{ file: 'a.xml', line: 3, detail: 'x' }] })`.
  - Status is still `incomplete` and `needsLlmScan` no longer includes it.
  - The rendered markdown contains `incomplete — verify in JCR` in both the summary row and the section.
- `acl: partial ACL scan keeps findings, is incomplete, and LLM findings are appended`:
  - `aclScan` returns `ok: true`, one finding and `scanStatus 'incomplete'`.
  - `needsLlmScan` includes `aclPermissions` while its finding is kept.
  - After the merge: 2 findings, `sourceByPattern.aclPermissions === 'acl-scan+llm'`, and the status is still `incomplete`.
- `acl: cache includes migrationPaths, scanStatus and full ACE fields`:
  - `generateRunbook` to temp out/cache.
  - Expect `cache.migrationPaths` deep-equal, `cache.scanStatusByPattern.aclPermissions === 'complete'`, and `cache.findingsByPattern.aclPermissions[0]` has `restrictions`, `importVerdict` and `confidence: 'heuristic'`.
- Unchanged behavior of the non-ACL patterns is covered by the existing suite, which Step 4 runs in full. No new test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test runbook-generator.test.js`
Expected: the registry test and the new `acl:` generator tests FAIL. Pre-existing tests still PASS.

- [ ] **Step 3: Implement in `runbook-generator.js`**

**Pattern registry:**
- Add `aclPermissions` to `PATTERN_META` exactly as spec §3.1, placed last so the existing pattern order is unchanged.
- `checklist` holds the eight bullets of spec §5 item 2 as plain strings (keep the bold markup).
- `SOURCE_LABEL['acl-scan'] = 'ACL scan'`.

**`gatherFindings`:**
- Validate `migrationPaths` at the very top.
- Add the `acl-scan` block after the `pom-scan` block:
  - always push `res.warnings`;
  - on `res.ok`, set findings, raw findings, `sourceByPattern`/`scannedBy = 'acl-scan'` and `scanStatusByPattern.aclPermissions = res.scanStatus`;
  - on `!res.ok`, push `aclPermissions scan did not run: <error>` and set the status to `incomplete`.
- `needsLlmScan` = unscanned patterns **plus** patterns whose status is `incomplete`.

**`mergeLlmFindings`:** when `gathered.scanStatusByPattern?.[pattern] === 'incomplete'`, append instead of replacing. `sourceByPattern` becomes `<existing>+llm`, or `llm` when there was none. Keep the status unchanged. Other patterns behave exactly as before.

**`renderRunbook`:**
- **Summary cell:** `— (verify in JCR)` for a zero-count `alwaysRender` pattern. Append ` — **incomplete — verify in JCR**` to the source cell when the pattern is incomplete.
- **Section loop:** don't skip `alwaysRender` patterns with zero findings. In that case, print the pinned no-ACL sentence instead of the Affected table.
- **Incomplete banner:** when incomplete, print `> ⚠️ **ACL scan incomplete — verify in JCR.** Treat the ACL review as not done.` after the description.
- **Checklist:** print `### Customer checklist` with `- [ ] <item>` lines before the sample prompt, whenever `meta.checklist` is set.
- **Scanned — no findings:** exclude `alwaysRender` patterns.

**`writeRunbookCache`:** add `migrationPaths: gathered.migrationPaths || []` and `scanStatusByPattern: gathered.scanStatusByPattern || {}`.

- [ ] **Step 4: Run the full suite**

Run: `node --test runbook-generator.test.js`
Expected: PASS with 0 failures. The total is the baseline 82 plus the new `acl:` tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/aem/cloud-service/skills/migration/scripts/runbook-generator.js plugins/aem/cloud-service/skills/migration/scripts/runbook-generator.test.js
git commit -m "feat(migration): render ACL review section and checklist in runbook"
```

---

### Task 6: CLI `--migration-path` and skill docs

**Files:**
- Modify: `.../scripts/runbook-generator.js` (`parseArgs` ~855, `main` ~870)
- Modify: `plugins/aem/cloud-service/skills/migration/SKILL.md`
  - Step 0 strategy table (~247)
  - heuristic note (~253)
  - command examples (~265–288)
  - Step 3 (~316)
- Test: `.../scripts/runbook-generator.test.js`

**Interfaces:**
- Consumes: `validateMigrationPaths` (Task 4) and `generateRunbook({ migrationPaths })` (Task 5).
- Produces:
  - **CLI:** `node runbook-generator.js <ws> [--migration-path <jcrPath>]...`.
  - **Exit code 2:** on an invalid or missing value, with `Error: <TypeError message>` on stderr and nothing written.
  - **Output:** prints `Migration paths: <p1>, <p2>` when supplied.

- [ ] **Step 1: Write the failing tests**

All tests use a helper that runs `spawnSync(process.execPath, [path.join(__dirname, 'runbook-generator.js'), ws, ...args, '--out', out, '--cache', cache], { cwd: ws, encoding: 'utf8' })`.

- `acl: CLI rejects invalid --migration-path with exit 2 and writes nothing`. For each case:
  - `['--migration-path', 'content/x']` → stderr includes `Invalid --migration-path "content/x"`.
  - `['--migration-path', '']` → stderr includes `Invalid --migration-path ""`.
  - `['--migration-path']` (last arg) → stderr matches `/requires a value/`.

  Each case expects `status === 2`, stderr includes `--migration-path /content/site`, and `!fs.existsSync(out) && !fs.existsSync(cache)`.
- `acl: CLI accepts repeatable --migration-path`:
  - Args `--migration-path /content/a --migration-path /content/b/`.
  - Expect `status === 0`, stdout includes `Migration paths: /content/a, /content/b`, and the cache `migrationPaths` deep-equals `['/content/a', '/content/b']`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern "^acl: CLI" runbook-generator.test.js`
Expected: FAIL. The invalid cases exit 0 and write files, and stdout lacks `Migration paths:`.

- [ ] **Step 3: Implement**

**`parseArgs`:** push `argv[++i]` (possibly `undefined`) into `out.migrationPaths` for every `--migration-path`.

**`main`:**
- Validate before printing the header or doing any I/O. On `TypeError`, `console.error('Error: ' + e.message)`, set `process.exitCode = 2` and return.
- Print `Migration paths:` after `Workspace:`.
- Pass the normalized paths to `generateRunbook`.

**`SKILL.md` Step 0:**
- Strategy row: `aclPermissions | acl-scan | read-only scan of _rep_policy.xml / inline rep:policy / RepoInit ACLs on the migration paths, ancestors and descendants — principals, allow/deny, privileges, restrictions, conservative import label; never edits, never connects to a JCR`.
- Add `aclPermissions` to the heuristic list.
- Add `[--migration-path <jcrPath> ...]` to the command, with the sentence: "Pass `--migration-path` for every Content Transfer Tool migration-set path the user named; an invalid value fails with exit code 2."
- Add the sentence: "Absence of ACLs in code is not evidence of correct permissions — the runbook always includes the ACL checklist."

**`SKILL.md` Step 3:** add "`aclPermissions` has no apply flow: explain the findings and checklist; never edit `_rep_policy.xml`, RepoInit or filters, and never connect to a JCR."

**`README.md`:** add the flag to the CLI usage block.

- [ ] **Step 4: Run the full suite**

Run: `node --test runbook-generator.test.js`
Expected: PASS with 0 failures.

- [ ] **Step 5: Commit**

```bash
git add plugins/aem/cloud-service/skills/migration/scripts/runbook-generator.js plugins/aem/cloud-service/skills/migration/scripts/runbook-generator.test.js plugins/aem/cloud-service/skills/migration/SKILL.md plugins/aem/cloud-service/skills/migration/scripts/README.md
git commit -m "feat(migration): add --migration-path flag and document ACL review"
```

---

## Spec coverage

| Spec | Task |
|---|---|
| §3.1 pattern meta, `SOURCE_LABEL` | 5 |
| §3.2 runner and units | 1–4 |
| §3.3 generator: option, block, `incomplete` + LLM, render, cache, CLI print | 5, 6 |
| §4.1 inputs (policy XML, inline, RepoInit `~`/`-`/bare, references, run mode) | 1, 3, 4 |
| §4.2 ACE model and parsing rules | 1, 3 |
| §4.3 scoping, precedence, unrelated/unscoped warnings | 4 |
| §4.4 filter, acHandling, verdict table, `clear` | 2 |
| §4.5 severity | 4 |
| §5 output, zero-findings copy, checklist, summary cell | 4 (detail), 5 |
| §6 docs | 4 (README runner), 6 (SKILL, README CLI) |
| §7 error table | 1, 2, 4, 5, 6 |
| §9 test cases 1–12 | 1 → T4 Cox; 2 → T4 Signify; 3 → T1; 4 → T1/T4; 5 → T3; 6 → T1/T4; 7 → T2; 8 → T3/T4; 9 → T6; 10 → T5; 11 → T1/T4; 12 → T5/T6 |
