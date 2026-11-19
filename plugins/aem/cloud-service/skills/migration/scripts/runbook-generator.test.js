'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { runHtlLint, classify } = require('./htl-lint-runner.js');
const { runOsgiConfigScan, validateRunmodeFolder, scanUnsupportedRunmodes, reorderRunmodeFolder, planRunmodeReorders } = require('./osgi-config-runner.js');
const { runVaultPackageScan, isLegacyGroup } = require('./vault-package-scan-runner.js');
const { runLuiScan, runCdwScan } = require('./legacy-ui-runner.js');
const { runTemplateScan, classifyStaticTemplate } = require('./template-scan-runner.js');
const { runAnalyzer, isAnalyzerAvailable, DEFAULT_ANALYZE_SCRIPT } = require('./analyzer-runner.js');
const { getBpaFindings } = require('./bpa-findings-helper.js');
const {
  decodeFileVaultPath,
  parseFileVaultValue,
  parsePolicyXml,
  resolvePackage,
  importVerdict,
  isRepoInitConfigName,
  readRepoInitConfig,
  parseRepoInit,
  validateMigrationPaths,
  relationTo,
  aceSeverity,
  formatAceDetail,
  runAclScan,
} = require('./acl-scan-runner.js');
const {
  gatherFindings, generateRunbook, renderRunbook, writeRunbookCache, mergeLlmFindings,
  samplePrompt, relPath, classKey, sourceLabel, CANONICAL_PATTERNS, PATTERN_META,
} = require('./runbook-generator.js');

function mkworkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runbook-test-'));
}
function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

// ── Pattern registry ────────────────────────────────────────────────────────

test('registry includes all 14 migration patterns with a valid strategy', () => {
  const expected = [
    'scheduler', 'resourceChangeListener', 'event-migration', 'assetApi', 'replication',
    'vault-package-dependencies', 'htlLint', 'osgiConfig', 'lui', 'cdw', 'templateModernization',
    'guavaCache', 'dispatcherConversion', 'aclPermissions',
  ];
  assert.strictEqual(CANONICAL_PATTERNS.length, expected.length, 'no unexpected patterns');
  for (const key of expected) {
    assert.ok(CANONICAL_PATTERNS.includes(key), `${key} in CANONICAL_PATTERNS`);
    assert.ok(
      ['cascade', 'html-scan', 'config-scan', 'content-scan', 'pom-scan', 'bpa-only', 'acl-scan'].includes(PATTERN_META[key].strategy),
      `${key} has a valid strategy`
    );
  }
  assert.strictEqual(PATTERN_META.dispatcherConversion.strategy, 'content-scan');
  assert.deepStrictEqual(PATTERN_META.dispatcherConversion.bpaSlugs, []);
});

test('guavaCache has no analyzer/content-scan fallback — bpaSlugs only, no heuristic flag', () => {
  assert.strictEqual(PATTERN_META.guavaCache.strategy, 'bpa-only');
  assert.deepStrictEqual(PATTERN_META.guavaCache.bpaSlugs, ['guavaCache']);
  assert.ok(!PATTERN_META.guavaCache.heuristic, 'guavaCache findings are BPA-authoritative, not heuristic');
});

test('inject-in-sling-model and outdated-dependencies stay out of scope', () => {
  assert.ok(!CANONICAL_PATTERNS.includes('inject-in-sling-model'));
  assert.ok(!CANONICAL_PATTERNS.includes('outdated-dependencies'));
});

test('vault-package-dependencies is pom-scan with no BPA tier and no analyzer', () => {
  assert.strictEqual(PATTERN_META['vault-package-dependencies'].strategy, 'pom-scan');
  assert.deepStrictEqual(PATTERN_META['vault-package-dependencies'].bpaSlugs, []);
  assert.ok(PATTERN_META['vault-package-dependencies'].heuristic, 'regex/text scan, not compiler-validated');
});

// ── vault-package-scan-runner ────────────────────────────────────────────────
//
// The runner delegates POM resolution to `mvn help:effective-pom`, so tests
// inject a stub `getEffectivePom` that returns canned effective-POM XML. The
// source `pom.xml` is still written to the workspace so the runner can look
// up the source line for the legacy `<group>` tag.

/** Build a stub getEffectivePom that returns canned XML per projectDir. */
function stubEffective(byDir) {
  return (projectDir) => {
    if (Object.prototype.hasOwnProperty.call(byDir, projectDir)) {
      return { ok: true, xml: byDir[projectDir] };
    }
    return { ok: false, error: `no stub for ${projectDir}` };
  };
}

test('isLegacyGroup matches day/cq60, day/cq560, adobe/cq60 prefixes only', () => {
  assert.ok(isLegacyGroup('day/cq60/product'));
  assert.ok(isLegacyGroup('day/cq560/social/commons'));
  assert.ok(isLegacyGroup('adobe/cq60'));
  assert.ok(!isLegacyGroup('adobe/aem6/sample'));
  assert.ok(!isLegacyGroup('com.example'));
  assert.ok(!isLegacyGroup(null));
});

test('runVaultPackageScan flags a legacy <dependencies> block, one finding per block', () => {
  const root = mkworkspace();
  const module = path.join(root, 'ui.apps');
  const pom = [
    '<project>', '  <build>', '    <plugins>', '      <plugin>',
    '        <artifactId>content-package-maven-plugin</artifactId>',
    '        <configuration>', '          <dependencies>',
    '            <dependency><group>day/cq60/product</group><name>cq-content</name></dependency>',
    '            <dependency><group>day/cq60/product</group><name>cq-commerce-content</name></dependency>',
    '          </dependencies>', '        </configuration>', '      </plugin>',
    '    </plugins>', '  </build>', '</project>',
  ].join('\n');
  write(root, 'ui.apps/pom.xml', pom);
  const res = runVaultPackageScan(root, { getEffectivePom: stubEffective({ [module]: pom }) });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.findings.length, 1, 'one finding per <dependencies> block, not per <dependency>');
  assert.match(res.findings[0].detail, /day\/cq60\/product/);
  assert.strictEqual(res.rawFindings[0].pattern, 'vault-package-dependencies');
});

test('runVaultPackageScan flags a legacy <dependencies> block under filevault-package-maven-plugin', () => {
  const root = mkworkspace();
  const module = path.join(root, 'ui.apps');
  const pom = [
    '<project>', '  <build>', '    <plugins>', '      <plugin>',
    '        <artifactId>filevault-package-maven-plugin</artifactId>',
    '        <configuration>', '          <dependencies>',
    '            <dependency><group>day/cq60/product</group><name>cq-content</name></dependency>',
    '          </dependencies>', '        </configuration>', '      </plugin>',
    '    </plugins>', '  </build>', '</project>',
  ].join('\n');
  write(root, 'ui.apps/pom.xml', pom);
  const res = runVaultPackageScan(root, { getEffectivePom: stubEffective({ [module]: pom }) });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.findings.length, 1, 'filevault-package-maven-plugin must be matched, not silently skipped');
  assert.match(res.findings[0].detail, /day\/cq60\/product/);
  assert.match(res.findings[0].detail, /^filevault-package-maven-plugin:/, 'snippet must name the plugin that matched');
});

test('runVaultPackageScan flags the block after <pluginManagement> is merged by Maven', () => {
  // Source pom declares the plugin in both <pluginManagement> (no deps) and
  // <build> (with deps). Maven's effective pom is what the runner sees: a
  // single merged <build> entry — no shadow <pluginManagement> occurrence.
  const root = mkworkspace();
  const sourcePom = [
    '<project>', '  <build>',
    '    <pluginManagement>', '      <plugins>', '        <plugin>',
    '          <artifactId>content-package-maven-plugin</artifactId>',
    '          <configuration><verbose>true</verbose></configuration>',
    '        </plugin>', '      </plugins>', '    </pluginManagement>',
    '    <plugins>', '      <plugin>',
    '        <artifactId>content-package-maven-plugin</artifactId>',
    '        <configuration>', '          <dependencies>',
    '            <dependency><group>day/cq60/product</group><name>cq-content</name></dependency>',
    '          </dependencies>', '        </configuration>', '      </plugin>',
    '    </plugins>', '  </build>', '</project>',
  ].join('\n');
  const effectivePom = [
    '<project>', '  <build>', '    <plugins>', '      <plugin>',
    '        <artifactId>content-package-maven-plugin</artifactId>',
    '        <configuration>',
    '          <verbose>true</verbose>',
    '          <dependencies>',
    '            <dependency><group>day/cq60/product</group><name>cq-content</name></dependency>',
    '          </dependencies>', '        </configuration>', '      </plugin>',
    '    </plugins>', '  </build>', '</project>',
  ].join('\n');
  write(root, 'pom.xml', sourcePom);
  const res = runVaultPackageScan(root, { getEffectivePom: stubEffective({ [root]: effectivePom }) });
  assert.strictEqual(res.findings.length, 1);
  assert.match(res.findings[0].detail, /day\/cq60\/product/);
});

test('runVaultPackageScan flags plugins that only appear in an activated <profile>', () => {
  // Profiles are not merged into <build> in the effective pom unless activated
  // — the runner must still scan every <plugin> occurrence, including those
  // inside a <profiles><profile><build> section.
  const root = mkworkspace();
  const pom = [
    '<project>', '  <build>', '    <plugins>', '      <plugin>',
    '        <artifactId>content-package-maven-plugin</artifactId>',
    '        <configuration>', '          <dependencies>',
    '            <dependency><group>day/cq60/product</group></dependency>',
    '          </dependencies>', '        </configuration>', '      </plugin>',
    '    </plugins>', '  </build>',
    '  <profiles>', '    <profile>', '      <id>legacy-6x</id>', '      <build>', '        <plugins>', '          <plugin>',
    '            <artifactId>filevault-package-maven-plugin</artifactId>',
    '            <configuration>', '              <dependencies>',
    '                <dependency><group>day/cq560/social/commons</group></dependency>',
    '              </dependencies>', '            </configuration>', '          </plugin>',
    '        </plugins>', '      </build>', '    </profile>', '  </profiles>',
    '</project>',
  ].join('\n');
  write(root, 'pom.xml', pom);
  const res = runVaultPackageScan(root, { getEffectivePom: stubEffective({ [root]: pom }) });
  assert.strictEqual(res.findings.length, 2, 'both <build> and <profiles> plugin blocks must be flagged');
  const groups = res.findings.map(f => f.detail).join(' | ');
  assert.match(groups, /day\/cq60\/product/);
  assert.match(groups, /day\/cq560\/social\/commons/);
});

test('runVaultPackageScan ignores a per-<execution> <configuration> — only plugin-level counts', () => {
  // Maven's effective pom keeps executions separate from the plugin-level
  // configuration. The runner explicitly scopes to everything before
  // <executions>, so a per-execution <configuration> with a legacy-looking
  // <dependencies> can't shadow or forge a finding at plugin-level.
  const root = mkworkspace();
  const effectivePom = [
    '<project>', '  <build>', '    <plugins>', '      <plugin>',
    '        <artifactId>content-package-maven-plugin</artifactId>',
    '        <configuration>',
    '          <verbose>true</verbose>',
    '        </configuration>',
    '        <executions>', '          <execution>', '            <id>install-package</id>',
    '            <configuration>',
    '              <dependencies>',
    '                <dependency><group>day/cq60/product</group></dependency>',
    '              </dependencies>',
    '            </configuration>',
    '          </execution>', '        </executions>',
    '      </plugin>', '    </plugins>', '  </build>', '</project>',
  ].join('\n');
  write(root, 'pom.xml', effectivePom);
  const res = runVaultPackageScan(root, { getEffectivePom: stubEffective({ [root]: effectivePom }) });
  assert.strictEqual(res.findings.length, 0, 'per-execution <configuration> is not install-time deps');
});

test('runVaultPackageScan reports the source-pom line where the legacy <group> appears', () => {
  const root = mkworkspace();
  const lines = [
    '<project>',                                                     //  1
    '  <build>',                                                     //  2
    '    <plugins>',                                                 //  3
    '      <plugin>',                                                //  4
    '        <artifactId>content-package-maven-plugin</artifactId>', //  5  <- artifactId line
    '        <configuration>',                                       //  6
    '          <dependencies>',                                      //  7
    '            <dependency><group>day/cq60/product</group></dependency>', //  8  <- legacy group line
    '          </dependencies>',                                     //  9
    '        </configuration>',                                      // 10
    '      </plugin>',                                               // 11
    '    </plugins>',                                                // 12
    '  </build>',                                                    // 13
    '</project>',                                                    // 14
  ];
  const pom = lines.join('\n');
  write(root, 'pom.xml', pom);
  const res = runVaultPackageScan(root, { getEffectivePom: stubEffective({ [root]: pom }) });
  assert.strictEqual(res.findings.length, 1);
  assert.strictEqual(res.rawFindings[0].line, 8, 'expected line 8 (the legacy <group> tag), not the <artifactId> line');
});

test('runVaultPackageScan flags inherited blocks with (inherited) marker and line 1', () => {
  // The customer's own pom.xml doesn't contain the legacy block — it comes
  // from a parent pom Maven pulls in. The runner still detects it via the
  // effective pom and reports the source pom with the (inherited) marker.
  const root = mkworkspace();
  const sourcePom = [
    '<project>',
    '  <parent><groupId>com.example</groupId><artifactId>legacy-parent</artifactId><version>1.0</version></parent>',
    '  <artifactId>my-module</artifactId>',
    '</project>',
  ].join('\n');
  const effectivePom = [
    '<project>', '  <build>', '    <plugins>', '      <plugin>',
    '        <artifactId>content-package-maven-plugin</artifactId>',
    '        <configuration>', '          <dependencies>',
    '            <dependency><group>day/cq60/product</group><name>cq-content</name></dependency>',
    '          </dependencies>', '        </configuration>', '      </plugin>',
    '    </plugins>', '  </build>', '</project>',
  ].join('\n');
  write(root, 'pom.xml', sourcePom);
  const res = runVaultPackageScan(root, { getEffectivePom: stubEffective({ [root]: effectivePom }) });
  assert.strictEqual(res.findings.length, 1);
  assert.match(res.findings[0].detail, /\(inherited\)/, 'inherited blocks must be marked');
  assert.strictEqual(res.rawFindings[0].line, 1, 'inherited blocks anchor at line 1 of the source pom');
});

test('runVaultPackageScan does not flag a legacy group under an unrelated plugin', () => {
  const root = mkworkspace();
  const pom = [
    '<project>', '  <build>', '    <plugins>', '      <plugin>',
    '        <artifactId>some-other-plugin</artifactId>',
    '        <configuration>', '          <dependencies>',
    '            <dependency><group>day/cq60/product</group></dependency>',
    '          </dependencies>', '        </configuration>', '      </plugin>',
    '      <plugin>', '        <artifactId>content-package-maven-plugin</artifactId>',
    '        <configuration><group>adobe/aem6/sample</group></configuration>',
    '      </plugin>', '    </plugins>', '  </build>', '</project>',
  ].join('\n');
  write(root, 'pom.xml', pom);
  const res = runVaultPackageScan(root, { getEffectivePom: stubEffective({ [root]: pom }) });
  assert.strictEqual(res.findings.length, 0, 'legacy group under a different plugin must not match');
});

test('runVaultPackageScan returns empty (ok) when no pom.xml has the plugin', () => {
  const root = mkworkspace();
  const pom = '<project></project>\n';
  write(root, 'pom.xml', pom);
  const res = runVaultPackageScan(root, { getEffectivePom: stubEffective({ [root]: pom }) });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.findings.length, 0);
});

test('runVaultPackageScan surfaces effective-pom resolution failures as warnings, not errors', () => {
  const root = mkworkspace();
  write(root, 'pom.xml', '<project><parent><artifactId>missing</artifactId></parent></project>\n');
  const res = runVaultPackageScan(root, {
    getEffectivePom: () => ({ ok: false, error: 'could not resolve parent com.example:missing:1.0' }),
  });
  assert.strictEqual(res.ok, true, 'a single unresolvable pom does not fail the whole scan');
  assert.strictEqual(res.findings.length, 0);
  assert.strictEqual(res.warnings.length, 1);
  assert.match(res.warnings[0], /could not resolve/);
});

test('runVaultPackageScan text-scans raw pom.xml when effective-pom fails, so legacy blocks still surface', () => {
  // Legacy AEM 6.x / AMS projects (the target audience) frequently can't
  // resolve a Maven build anymore. The runner falls back to a raw text
  // scan so the pattern doesn't silently report clean, and emits a warning
  // announcing the degraded coverage.
  const root = mkworkspace();
  const pom = [
    '<project>', '  <build>', '    <plugins>', '      <plugin>',
    '        <artifactId>content-package-maven-plugin</artifactId>',
    '        <configuration>', '          <dependencies>',
    '            <dependency><group>day/cq60/product</group><name>cq-content</name></dependency>',
    '          </dependencies>', '        </configuration>', '      </plugin>',
    '    </plugins>', '  </build>', '</project>',
  ].join('\n');
  write(root, 'pom.xml', pom);
  const res = runVaultPackageScan(root, {
    getEffectivePom: () => ({ ok: false, error: 'offline: cannot download parent' }),
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.findings.length, 1, 'raw text-scan must still detect the legacy block');
  assert.match(res.findings[0].detail, /day\/cq60\/product/);
  assert.strictEqual(res.warnings.length, 1);
  assert.match(res.warnings[0], /text-scanning raw pom\.xml/);
});

test('runVaultPackageScan skips <pluginManagement> so effective-pom does not double-report', () => {
  // Effective POM retains <pluginManagement> even after merging its config
  // into <build><plugins>. Without the skip the same block is reported
  // once from pluginManagement and once from the merged <build> entry.
  const root = mkworkspace();
  const effectivePom = [
    '<project>', '  <build>',
    '    <pluginManagement>', '      <plugins>', '        <plugin>',
    '          <artifactId>content-package-maven-plugin</artifactId>',
    '          <configuration>', '            <dependencies>',
    '              <dependency><group>day/cq60/product</group></dependency>',
    '            </dependencies>', '          </configuration>',
    '        </plugin>', '      </plugins>', '    </pluginManagement>',
    '    <plugins>', '      <plugin>',
    '        <artifactId>content-package-maven-plugin</artifactId>',
    '        <configuration>', '          <dependencies>',
    '            <dependency><group>day/cq60/product</group></dependency>',
    '          </dependencies>', '        </configuration>',
    '      </plugin>',
    '    </plugins>', '  </build>', '</project>',
  ].join('\n');
  write(root, 'pom.xml', effectivePom);
  const res = runVaultPackageScan(root, { getEffectivePom: stubEffective({ [root]: effectivePom }) });
  assert.strictEqual(res.findings.length, 1, '<pluginManagement> copy must not create a duplicate finding');
});

test('runVaultPackageScan returns ok:false when no module could be scanned (false-clean guard)', () => {
  // Effective POM fails AND the raw pom.xml can't be read — the pattern
  // was NOT scanned, so the runner must return ok:false rather than
  // ok:true / zero findings, otherwise the runbook would mark the
  // pattern as clean.
  const root = mkworkspace();
  const pomPath = path.join(root, 'pom.xml');
  write(root, 'pom.xml', '<project/>');
  // Break read access so the text-scan fallback can't succeed either.
  const originalRead = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => {
    if (p === pomPath) throw new Error('EACCES: permission denied');
    return originalRead(p, ...rest);
  };
  try {
    const res = runVaultPackageScan(root, {
      getEffectivePom: () => ({ ok: false, error: 'mvn missing' }),
    });
    assert.strictEqual(res.ok, false, 'a scan that ran against 0 modules must not report ok:true');
    assert.match(res.error || '', /not scanned/);
  } finally {
    fs.readFileSync = originalRead;
  }
});

test('runVaultPackageScan uses the reactor bulk path when a <modules> pom is present', () => {
  // A reactor invocation costs one mvn call for every module in the
  // reactor, not one per module. The runner picks up the reactor via
  // the source pom's <modules> declaration and pairs modules to their
  // effective-pom slice via <artifactId>.
  const root = mkworkspace();
  const rootPom = [
    '<project>',
    '  <artifactId>myapp-reactor</artifactId>',
    '  <modules><module>ui.apps</module><module>ui.content</module></modules>',
    '</project>',
  ].join('\n');
  const uiAppsPom = '<project><artifactId>myapp-ui.apps</artifactId></project>\n';
  const uiContentPom = '<project><artifactId>myapp-ui.content</artifactId></project>\n';
  write(root, 'pom.xml', rootPom);
  write(root, 'ui.apps/pom.xml', uiAppsPom);
  write(root, 'ui.content/pom.xml', uiContentPom);
  const uiAppsEffective = [
    '<project>', '  <artifactId>myapp-ui.apps</artifactId>',
    '  <build><plugins><plugin>',
    '    <artifactId>content-package-maven-plugin</artifactId>',
    '    <configuration><dependencies>',
    '      <dependency><group>day/cq60/product</group></dependency>',
    '    </dependencies></configuration>',
    '  </plugin></plugins></build>', '</project>',
  ].join('\n');
  const uiContentEffective = '<project><artifactId>myapp-ui.content</artifactId></project>';
  const rootEffective = '<project><artifactId>myapp-reactor</artifactId></project>';
  let reactorCalls = 0;
  let perModuleCalls = 0;
  const res = runVaultPackageScan(root, {
    getReactorEffectivePoms: (dir) => {
      reactorCalls++;
      assert.strictEqual(dir, root, 'reactor call must fire at the reactor root, not per-module');
      return { ok: true, byArtifactId: {
        'myapp-reactor': rootEffective,
        'myapp-ui.apps': uiAppsEffective,
        'myapp-ui.content': uiContentEffective,
      } };
    },
    getEffectivePom: () => { perModuleCalls++; return { ok: false, error: 'should not be called' }; },
  });
  assert.strictEqual(reactorCalls, 1, 'exactly one reactor mvn call, not per-module');
  assert.strictEqual(perModuleCalls, 0, 'per-module fallback must not run when reactor bulk covers every module');
  assert.strictEqual(res.findings.length, 1);
  assert.match(res.findings[0].location, /ui\.apps\/pom\.xml/);
});

// ── htl-lint-runner ───────────────────────────────────────────────────────

test('classify labels each anti-pattern class', () => {
  assert.strictEqual(classify('<div data-sly-test="${x == true}">'), 'boolean-literal');
  assert.strictEqual(classify("<div data-sly-test='/apps/foo'>"), 'apps-string-as-test');
  assert.strictEqual(classify('<div data-sly-test="${a} || ${b}">'), 'split-logical-across-expr');
  assert.strictEqual(classify('<div data-sly-test="${x == 5}">'), 'numeric-literal');
});

test('runHtlLint finds data-sly-test anti-patterns in .html', () => {
  const root = mkworkspace();
  write(root, 'ui.apps/jcr_root/apps/comp/hero.html', '<div data-sly-test="${properties.x == true}">hi</div>\n');
  write(root, 'ui.apps/jcr_root/apps/comp/clean.html', '<div data-sly-test="${properties.enabled}">ok</div>\n');
  const res = runHtlLint(root);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.findings.length, 1);
  assert.match(res.findings[0].detail, /boolean-literal/);
  assert.strictEqual(res.rawFindings[0].pattern, 'htlLint');
  assert.ok(res.rawFindings[0].line > 0);
});

test('runHtlLint returns empty (ok) when nothing matches', () => {
  const root = mkworkspace();
  write(root, 'ui.apps/jcr_root/apps/comp/clean.html', '<div data-sly-test="${properties.enabled}">ok</div>\n');
  const res = runHtlLint(root);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.findings.length, 0);
});

// ── osgi-config-runner ──────────────────────────────────────────────────────

test('runOsgiConfigScan flags plaintext secret keys WITHOUT leaking the value', () => {
  const root = mkworkspace();
  const secretValue = 'sup3rSecretP@ss';
  write(root, 'ui.config/src/main/content/jcr_root/apps/my/config/com.my.Svc.cfg.json',
    `{\n  "api-key": "${secretValue}",\n  "endpoint": "https://example.com"\n}\n`);
  const res = runOsgiConfigScan(root);
  assert.strictEqual(res.ok, true);
  const secretFinding = res.rawFindings.find(f => f.kind === 'plaintext-secret');
  assert.ok(secretFinding, 'a plaintext-secret finding is produced');
  assert.match(secretFinding.snippet, /<redacted>/);
  // The value must never appear anywhere in the output.
  const blob = JSON.stringify(res);
  assert.ok(!blob.includes(secretValue), 'secret value must not leak into findings');
});

test('runOsgiConfigScan flags already-placeholdered files and legacy formats', () => {
  const root = mkworkspace();
  write(root, 'ui.config/src/main/content/jcr_root/apps/my/config.publish/com.my.Placeheld.cfg.json',
    '{\n  "password": "$[secret:my-pw]"\n}\n');
  write(root, 'ui.config/src/main/content/jcr_root/apps/my/config/com.my.Legacy.config',
    'my.prop="value"\n');
  const res = runOsgiConfigScan(root);
  const kinds = res.rawFindings.map(f => f.kind);
  assert.ok(kinds.includes('already-placeholdered'));
  assert.ok(kinds.includes('legacy-format'));
  // A key already using a placeholder is NOT flagged as plaintext-secret.
  assert.ok(!kinds.includes('plaintext-secret'));
});

test('runOsgiConfigScan ignores non-config folders and repoinit secret keys', () => {
  const root = mkworkspace();
  write(root, 'ui.apps/jcr_root/apps/my/components/notaconfig.cfg.json', '{ "password": "x" }\n');
  write(root, 'ui.config/jcr_root/apps/my/config/org.apache.sling.jcr.repoinit.RepositoryInitializer-my.cfg.json',
    '{ "scripts": ["create user with password abc"] }\n');
  const res = runOsgiConfigScan(root);
  assert.ok(!res.rawFindings.some(f => f.kind === 'plaintext-secret'),
    'files outside config folders and repoinit files are not flagged for plaintext secrets');
});

// ── URC: run-mode folder validation ─────────────────────────────────────────

test('validateRunmodeFolder accepts valid supported run-mode folders', () => {
  for (const name of ['config', 'install', 'config.author', 'config.publish',
    'config.dev', 'config.stage', 'config.prod', 'config.author.dev',
    'config.publish.prod', 'install.author', 'install.publish.stage']) {
    assert.strictEqual(validateRunmodeFolder(name), null, `${name} should be valid`);
  }
});

test('validateRunmodeFolder flags tier-after-environment ordering violations', () => {
  const bad = validateRunmodeFolder('config.dev.author');
  assert.ok(bad, 'config.dev.author is unsupported');
  assert.strictEqual(bad.runmode, 'dev.author');
  assert.match(bad.reason, /must precede/i);
});

test('validateRunmodeFolder flags unknown tokens and preview', () => {
  assert.ok(validateRunmodeFolder('config.preprod'), 'preprod is unknown');
  assert.ok(validateRunmodeFolder('config.author.preprod'), 'preprod after author still unknown');
  assert.ok(validateRunmodeFolder('install.local'), 'local is unknown');
  assert.ok(validateRunmodeFolder('config.preview'), 'preview cannot be declared');
});

test('validateRunmodeFolder flags duplicate tier/environment tokens', () => {
  assert.match(validateRunmodeFolder('config.author.publish').reason, /tier/i);
  assert.match(validateRunmodeFolder('config.author.dev.stage').reason, /environment/i);
});

test('validateRunmodeFolder is case-sensitive — capitalized tokens are unsupported', () => {
  const bad1 = validateRunmodeFolder('config.Author.dev');
  assert.ok(bad1, 'config.Author.dev is unsupported (case-sensitive)');
  assert.match(bad1.reason, /'Author'/);
  const bad2 = validateRunmodeFolder('config.PUBLISH');
  assert.ok(bad2, 'config.PUBLISH is unsupported (case-sensitive)');
  assert.match(bad2.reason, /'PUBLISH'/);
});

test('scanUnsupportedRunmodes flags unsupported config/install folders only', () => {
  const root = mkworkspace();
  write(root, 'ui.config/jcr_root/apps/my/config.dev.author/com.my.Svc.cfg.json', '{ "a": 1 }\n');
  write(root, 'ui.apps/jcr_root/apps/my/install.local/my-bundle.jar', 'x');
  write(root, 'ui.config/jcr_root/apps/my/config.author.dev/com.my.Ok.cfg.json', '{ "a": 1 }\n');
  write(root, 'ui.apps/jcr_root/apps/my/install.publish/ok-bundle.jar', 'x');
  const res = scanUnsupportedRunmodes(root);
  assert.strictEqual(res.ok, true);
  const kinds = res.rawFindings.map(f => f.kind);
  assert.ok(kinds.every(k => k === 'unsupported-runmode'));
  const runmodes = res.rawFindings.map(f => f.runmode).sort();
  assert.deepStrictEqual(runmodes, ['dev.author', 'local']);
});

test('validateRunmodeFolder flags malformed run-mode folder names', () => {
  assert.match(validateRunmodeFolder('config.').reason, /malformed/i);
  assert.match(validateRunmodeFolder('config..dev').reason, /malformed/i);
  // Bare config/install (no dot) and non-config names stay out of scope.
  assert.strictEqual(validateRunmodeFolder('config'), null);
  assert.strictEqual(validateRunmodeFolder('install'), null);
  assert.strictEqual(validateRunmodeFolder('configuration'), null);
});

test('scanUnsupportedRunmodes flags a malformed run-mode folder on disk', () => {
  const root = mkworkspace();
  write(root, 'ui.config/jcr_root/apps/my/config./com.my.Svc.cfg.json', '{ "a": 1 }\n');
  const res = scanUnsupportedRunmodes(root);
  assert.strictEqual(res.ok, true);
  const malformedRaw = res.rawFindings.find(f => f.kind === 'unsupported-runmode');
  assert.ok(malformedRaw, 'a finding is produced for the malformed folder');
  const malformedFinding = res.findings.find(f => /malformed/i.test(f.detail));
  assert.ok(malformedFinding, 'reason mentions the malformed folder name');
});

test('scanUnsupportedRunmodes returns ok with no findings for a clean tree', () => {
  const root = mkworkspace();
  write(root, 'ui.config/jcr_root/apps/my/config.author.stage/com.my.Ok.cfg.json', '{ "a": 1 }\n');
  const res = scanUnsupportedRunmodes(root);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.rawFindings.length, 0);
});

// ── URC: safe auto-reorder fix (emit git mv commands, read-only) ─────────────

test('reorderRunmodeFolder fixes ordering-only violations and skips the rest', () => {
  assert.deepStrictEqual(reorderRunmodeFolder('config.dev.author'), { from: 'config.dev.author', to: 'config.author.dev' });
  assert.deepStrictEqual(reorderRunmodeFolder('install.stage.publish'), { from: 'install.stage.publish', to: 'install.publish.stage' });
  assert.strictEqual(reorderRunmodeFolder('config.author.dev'), null, 'already valid');
  assert.strictEqual(reorderRunmodeFolder('config.preprod'), null, 'unknown token — not auto-fixable');
  assert.strictEqual(reorderRunmodeFolder('config.author.publish'), null, 'two tiers — not auto-fixable');
});

test('reorderRunmodeFolder does not silently case-fold a capitalized token', () => {
  assert.strictEqual(reorderRunmodeFolder('config.DEV.author'), null, 'mixed-case token routed to manual, not auto-folded');
  assert.deepStrictEqual(reorderRunmodeFolder('config.dev.author'), { from: 'config.dev.author', to: 'config.author.dev' },
    'lowercase ordering violation is still auto-fixed');
});

test('planRunmodeReorders emits a git mv command and never touches disk', () => {
  const root = mkworkspace();
  const bad = write(root, 'ui.config/jcr_root/apps/my/config.dev.author/com.my.Svc.cfg.json', '{ "a": 1 }\n');
  const badDir = path.dirname(bad);
  const res = planRunmodeReorders(root);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.reorders.length, 1);
  // Relative paths (not absolute) in a runnable git mv command.
  assert.match(res.reorders[0].command, /^git mv "ui\.config\/.*config\.dev\.author" "ui\.config\/.*config\.author\.dev"$/);
  assert.ok(!path.isAbsolute(res.reorders[0].from), 'from path is workspace-relative');
  assert.ok(fs.existsSync(badDir), 'plan is read-only — nothing renamed on disk');
});

test('planRunmodeReorders routes collisions and unknown tokens to manual', () => {
  const root = mkworkspace();
  // Collision: valid target already exists next to the bad folder.
  const collidedTarget = write(root, 'ui.config/jcr_root/apps/my/config.author.dev/com.my.Other.cfg.json', '{ "b": 2 }\n');
  write(root, 'ui.config/jcr_root/apps/my/config.dev.author/com.my.Svc.cfg.json', '{ "a": 1 }\n');
  // Unknown token: never a command.
  const unknown = write(root, 'ui.config/jcr_root/apps/my/config.preprod/com.my.Svc.cfg.json', '{ "a": 1 }\n');
  const res = planRunmodeReorders(root);
  assert.strictEqual(res.reorders.length, 0, 'no git mv commands emitted');
  const reasons = res.manual.map(s => s.reason).join(' | ');
  assert.match(reasons, /already exists/i);
  assert.match(reasons, /not auto-fixable/i);
  assert.ok(fs.existsSync(path.dirname(collidedTarget)), 'existing target untouched');
  assert.ok(fs.existsSync(path.dirname(unknown)), 'unknown-token folder untouched');
});

// ── orchestrator dispatch + cache tagging ────────────────────────────────────

test('gatherFindings dispatches rg + config-scan + pom-scan and tags heuristic in cache', async () => {
  const root = mkworkspace();
  write(root, 'ui.apps/jcr_root/apps/comp/hero.html', '<div data-sly-test="${x == false}">x</div>\n');
  write(root, 'ui.config/jcr_root/apps/my/config/com.my.Svc.cfg.json', '{ "secret-token": "abc123" }\n');
  const pom = [
    '<project><build><plugins><plugin>',
    '<artifactId>content-package-maven-plugin</artifactId>',
    '<configuration><dependencies>',
    '<dependency><group>day/cq60/product</group></dependency>',
    '</dependencies></configuration></plugin></plugins></build></project>',
  ].join('\n');
  write(root, 'pom.xml', pom);
  // No BPA source, no Java project → cascade patterns go to needsLlmScan or analyzer(empty).
  // The vault-package scan delegates POM resolution to Maven; inject a stub that
  // returns the source as the effective pom so this stays a unit test.
  const gathered = await gatherFindings({
    workspaceRoot: root,
    getEffectivePom: (dir) => (dir === root ? { ok: true, xml: pom } : { ok: false, error: 'no stub' }),
  });

  assert.strictEqual(gathered.sourceByPattern.htlLint, 'html-scan');
  assert.ok(gathered.findingsByPattern.htlLint.length >= 1);
  assert.strictEqual(gathered.sourceByPattern.osgiConfig, 'config-scan');
  assert.ok(gathered.findingsByPattern.osgiConfig.length >= 1);
  assert.strictEqual(gathered.sourceByPattern['vault-package-dependencies'], 'pom-scan');
  assert.ok(gathered.findingsByPattern['vault-package-dependencies'].length >= 1);

  const cachePath = path.join(root, 'cache.json');
  writeRunbookCache(gathered, { generatedAt: 'now' }, cachePath);
  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  for (const f of cache.findingsByPattern.osgiConfig) {
    assert.strictEqual(f.confidence, 'heuristic');
  }
  for (const f of cache.findingsByPattern.htlLint) {
    assert.strictEqual(f.confidence, 'heuristic');
  }
  for (const f of cache.findingsByPattern['vault-package-dependencies']) {
    assert.strictEqual(f.confidence, 'heuristic');
  }
});

test('cascade findings are NOT tagged heuristic', async () => {
  const root = mkworkspace();
  const gathered = await gatherFindings({ workspaceRoot: root });
  const cachePath = path.join(root, 'cache.json');
  writeRunbookCache(gathered, { generatedAt: 'now' }, cachePath);
  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  for (const f of cache.findingsByPattern.scheduler || []) {
    assert.notStrictEqual(f.confidence, 'heuristic');
  }
});

test('samplePrompt uses the OSGi natural-language override', () => {
  assert.match(samplePrompt('osgiConfig', {}), /scan my config files/i);
  assert.match(samplePrompt('scheduler', {}), /migration skill: \*\*scheduler\*\* only/);
});

test('samplePrompt never leaks the internal code-assessment handoff to the user', () => {
  // The runbook's copy-paste prompts are user-facing; reading the code-assessment
  // pattern guide is the migration skill's own job (Branch B), not the user's.
  for (const pattern of CANONICAL_PATTERNS) {
    assert.doesNotMatch(samplePrompt(pattern, {}), /code-assessment/, pattern);
    assert.doesNotMatch(samplePrompt(pattern, { bpaFilePath: './bpa.csv' }), /code-assessment/, pattern);
  }
});

test('renderRunbook shows a heuristic note and never emits secret values', async () => {
  const root = mkworkspace();
  write(root, 'ui.config/jcr_root/apps/my/config/com.my.Svc.cfg.json', '{ "password": "leakme-please-9000" }\n');
  const gathered = await gatherFindings({ workspaceRoot: root });
  const md = renderRunbook(gathered, { generatedAt: 'now' });
  assert.match(md, /Heuristic detection/);
  assert.ok(!md.includes('leakme-please-9000'), 'secret value must not appear in the rendered runbook');
});

// ── regression: compact / multi-property JSON must not hide secrets ─────────

test('runOsgiConfigScan catches a secret that is not the first property on a line', () => {
  const root = mkworkspace();
  write(root, 'ui.config/jcr_root/apps/my/config/com.my.Svc.cfg.json',
    '{"endpoint":"https://x","apiPassword":"HUNTER2_LEAK","token":"$[secret:t]"}');
  const res = runOsgiConfigScan(root);
  assert.ok(res.rawFindings.some(f => f.kind === 'plaintext-secret' && /apiPassword/.test(f.snippet)),
    'secret after the first property on a compact line must be caught');
  assert.ok(!JSON.stringify(res).includes('HUNTER2_LEAK'), 'secret value must not leak');
});

test('runOsgiConfigScan emits no XML warning when there are no config files', () => {
  const root = mkworkspace();
  write(root, 'core/src/main/java/J.java', 'class J {}\n');
  const res = runOsgiConfigScan(root);
  assert.strictEqual(res.warnings.length, 0);
});

// ── already-placeholdered is informational, not counted as work ─────────────

test('already-placeholdered findings do not count as outstanding work', async () => {
  const root = mkworkspace();
  write(root, 'ui.config/jcr_root/apps/my/config/com.my.Done.cfg.json', '{ "password": "$[secret:pw]" }\n');
  const out = path.join(root, 'rb.md');
  const cache = path.join(root, 'rb.json');
  const result = await generateRunbook({ workspaceRoot: root, outputPath: out, cachePath: cache });
  // informational only → zero actionable findings for osgiConfig
  assert.strictEqual(result.patternCounts.osgiConfig, 0);
  // but the informational row is still present in the gathered findings + cache
  assert.ok(result.gathered.findingsByPattern.osgiConfig.some(f => f.informational));
  const cached = JSON.parse(fs.readFileSync(cache, 'utf8'));
  assert.ok(cached.findingsByPattern.osgiConfig.some(f => f.kind === 'already-placeholdered' && f.informational));
});

// ── paths are workspace-relative in both the runbook and the cache ──────────

test('generateRunbook writes workspace-relative paths, not absolute', async () => {
  const root = mkworkspace();
  write(root, 'ui.apps/jcr_root/apps/comp/hero.html', '<div data-sly-test="${x == true}">x</div>\n');
  const out = path.join(root, 'rb.md');
  const cache = path.join(root, 'rb.json');
  await generateRunbook({ workspaceRoot: root, outputPath: out, cachePath: cache });

  const md = fs.readFileSync(out, 'utf8');
  assert.ok(!md.includes(root), 'rendered runbook must not contain the absolute workspace path');
  assert.match(md, /ui\.apps\/jcr_root\/apps\/comp\/hero\.html/);

  const cached = JSON.parse(fs.readFileSync(cache, 'utf8'));
  assert.strictEqual(cached.workspaceRoot, root);
  for (const f of cached.findingsByPattern.htlLint) {
    assert.ok(!path.isAbsolute(f.file), 'cache file paths must be relative');
  }
});

// ── htlLint word boundary: identifiers starting with true/false not flagged ─

test('classify does not flag identifiers like trueFlag / falseHood', () => {
  assert.strictEqual(classify('<div data-sly-test="${x == trueFlag}">'), null);
  assert.strictEqual(classify('<div data-sly-test="${x != falseHood}">'), null);
  assert.strictEqual(classify('<div data-sly-test="${x == true}">'), 'boolean-literal');
});

// ── content-scan: lui / cdw / template ──────────────────────────────────────

test('runCdwScan flags custom xtypes but not known-safe ones', () => {
  const root = mkworkspace();
  write(root, 'ui.apps/jcr_root/apps/my/components/c/dialog/.content.xml',
    '<jcr:root><items><a jcr:primaryType="cq:Widget" xtype="textfield"/><b jcr:primaryType="cq:Widget" xtype="my-colorpicker"/></items></jcr:root>');
  const res = runCdwScan(root);
  const xtypes = res.rawFindings.map(f => f.xtype);
  assert.ok(xtypes.includes('my-colorpicker'), 'custom xtype flagged');
  assert.ok(!xtypes.includes('textfield'), 'known-safe xtype not flagged');
});

test('runLuiScan flags classic and coral2 dialogs, not coral3', () => {
  const root = mkworkspace();
  write(root, 'a/dialog/.content.xml', '<jcr:root jcr:primaryType="cq:Dialog"/>');
  write(root, 'b/_cq_dialog/.content.xml', '<jcr:root sling:resourceType="granite/ui/components/foundation/container"/>');
  write(root, 'c/_cq_dialog/.content.xml', '<jcr:root sling:resourceType="granite/ui/components/coral/foundation/container"/>');
  const res = runLuiScan(root);
  const subs = res.rawFindings.map(f => f.subType);
  assert.ok(subs.includes('legacy.dialog.classic'));
  assert.ok(subs.includes('legacy.dialog.coral2'));
  assert.strictEqual(res.rawFindings.length, 2, 'coral3 dialog must not be flagged');
});

test('runTemplateScan flags static templates under apps/*/templates/*', () => {
  const root = mkworkspace();
  write(root, 'ui.apps/jcr_root/apps/my/templates/content-page/.content.xml',
    '<jcr:root jcr:primaryType="cq:Template"/>');
  write(root, 'ui.apps/jcr_root/apps/my/components/foo/.content.xml',
    '<jcr:root jcr:primaryType="cq:Template"/>'); // not under templates/ → ignored
  const res = runTemplateScan(root);
  assert.strictEqual(res.rawFindings.length, 1);
  // No foundation resource type → project-authored custom template.
  assert.strictEqual(res.rawFindings[0].subType, 'custom.static.template');
  assert.match(res.findings[0].detail, /content-page/);
  assert.match(res.findings[0].detail, /custom/);
});

test('runTemplateScan classifies foundation-derived templates as legacy', () => {
  const root = mkworkspace();
  write(root, 'ui.apps/jcr_root/apps/my/templates/legacy-page/.content.xml',
    '<jcr:root jcr:primaryType="cq:Template"><jcr:content sling:resourceType="wcm/foundation/components/page"/></jcr:root>');
  write(root, 'ui.apps/jcr_root/apps/my/templates/custom-page/.content.xml',
    '<jcr:root jcr:primaryType="cq:Template"><jcr:content sling:resourceType="my/components/structure/page"/></jcr:root>');
  const res = runTemplateScan(root);
  const bySub = Object.fromEntries(res.rawFindings.map(f => [f.subType, f]));
  assert.ok(bySub['legacy.static.template'], 'foundation RT → legacy');
  assert.ok(bySub['custom.static.template'], 'project RT → custom');
  assert.match(bySub['legacy.static.template'].file, /legacy-page/);
  assert.match(bySub['custom.static.template'].file, /custom-page/);
});

test('classifyStaticTemplate strips leading /libs and /apps prefixes', () => {
  assert.strictEqual(
    classifyStaticTemplate('<jcr:content sling:resourceType="/libs/wcm/foundation/components/page"/>'),
    'legacy.static.template');
  assert.strictEqual(
    classifyStaticTemplate('<jcr:content sling:resourceType="/apps/my/components/page"/>'),
    'custom.static.template');
});

test('classifyStaticTemplate prefers jcr:content over a descendant parsys', () => {
  // jcr:content has no RT of its own but a child parsys is foundation-derived;
  // the template is still project-authored → must not be flagged legacy.
  const xml = '<jcr:root jcr:primaryType="cq:Template">' +
    '<jcr:content jcr:primaryType="cq:PageContent">' +
    '<par sling:resourceType="wcm/foundation/components/responsivegrid"/>' +
    '</jcr:content></jcr:root>';
  assert.strictEqual(classifyStaticTemplate(xml), 'custom.static.template');
  // When jcr:content itself is foundation-derived, it is legacy.
  const legacy = '<jcr:content sling:resourceType="wcm/foundation/components/page">' +
    '<par sling:resourceType="my/components/parsys"/></jcr:content>';
  assert.strictEqual(classifyStaticTemplate(legacy), 'legacy.static.template');
});

test('runTemplateScan detects nested static templates', () => {
  const root = mkworkspace();
  write(root, 'ui.apps/jcr_root/apps/my/templates/marketing/hero/.content.xml',
    '<jcr:root jcr:primaryType="cq:Template"/>');
  const res = runTemplateScan(root);
  assert.strictEqual(res.rawFindings.length, 1, 'nested template must be found');
  assert.match(res.findings[0].detail, /hero/);
});

test('gatherFindings dispatches content-scan patterns as heuristic', async () => {
  const root = mkworkspace();
  write(root, 'ui.apps/jcr_root/apps/my/components/c/dialog/.content.xml',
    '<jcr:root jcr:primaryType="cq:Dialog"><items><w jcr:primaryType="cq:Widget" xtype="my-widget"/></items></jcr:root>');
  write(root, 'ui.apps/jcr_root/apps/my/templates/t/.content.xml', '<jcr:root jcr:primaryType="cq:Template"/>');
  // Isolate collectionsDir so no ambient BPA collection pre-empts content-scan.
  const gathered = await gatherFindings({ workspaceRoot: root, collectionsDir: path.join(root, 'no-collections') });
  for (const p of ['lui', 'cdw', 'templateModernization']) {
    assert.strictEqual(gathered.sourceByPattern[p], 'content-scan', `${p} scanned via content-scan`);
    assert.ok(gathered.findingsByPattern[p].length >= 1, `${p} has a finding`);
  }
  const cache = path.join(root, 'c.json');
  writeRunbookCache(gathered, { generatedAt: 'now', workspaceRoot: root }, cache);
  const cached = JSON.parse(fs.readFileSync(cache, 'utf8'));
  for (const p of ['lui', 'cdw', 'templateModernization']) {
    for (const f of cached.findingsByPattern[p]) assert.strictEqual(f.confidence, 'heuristic');
  }
});

test('lui/cdw/template sample prompts route to the migration branches', () => {
  assert.match(samplePrompt('lui', {}), /LUI dialog|Coral 3/i);
  assert.match(samplePrompt('cdw', {}), /CDW|custom ExtJS/i);
  assert.match(samplePrompt('templateModernization', {}), /editable templates/i);
});

// ── analyzer-runner: slug normalization + ok:false branches (stub analyze.sh) ─

function writeAnalyzeStub(root, body) {
  const p = path.join(root, 'analyze.sh');
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

test('runAnalyzer normalizes analyzer slugs and skips non-migration patterns', () => {
  const root = mkworkspace();
  const payload = { findings: [
    { pattern: 'scheduler', file: 'A.java', line: 3, snippet: 'Scheduler s;' },
    { pattern: 'resource-change-listener', file: 'B.java', line: 5, snippet: 'impl RCL' },
    { pattern: 'asset-manager', file: 'C.java', line: 7, snippet: 'AssetManager.createAsset' },
    { pattern: 'inject-in-sling-model', file: 'D.java', line: 9, snippet: '@Inject' },
    { pattern: 'vault-package-dependencies', file: 'pom.xml', line: 12, snippet: '<group>day/cq60/product</group>' },
  ], warnings: ['w1'] };
  const stub = writeAnalyzeStub(root, `#!/usr/bin/env bash\ncat <<'JSON'\n${JSON.stringify(payload)}\nJSON\n`);
  const res = runAnalyzer(root, { analyzeScript: stub });
  assert.strictEqual(res.ok, true);
  assert.ok(res.findingsByPattern.scheduler, 'scheduler kept');
  assert.ok(res.findingsByPattern.resourceChangeListener, 'resource-change-listener → resourceChangeListener');
  assert.ok(res.findingsByPattern.assetApi, 'asset-manager → assetApi');
  assert.ok(!res.findingsByPattern['inject-in-sling-model'], 'non-migration slug dropped');
  assert.ok(!res.findingsByPattern['vault-package-dependencies'], 'vault-package-dependencies has no analyzer detector — dropped like non-migration slugs, detected via pom-scan instead');
  assert.deepStrictEqual(res.warnings, ['w1']);
  assert.strictEqual(res.rawFindingsByPattern.scheduler[0].line, 3);
});

test('runAnalyzer returns ok:false on non-zero exit', () => {
  const root = mkworkspace();
  const stub = writeAnalyzeStub(root, '#!/usr/bin/env bash\necho "compile error" >&2\nexit 5\n');
  const res = runAnalyzer(root, { analyzeScript: stub });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /compile error|code 5/);
});

test('runAnalyzer returns ok:false on unparseable output', () => {
  const root = mkworkspace();
  const stub = writeAnalyzeStub(root, '#!/usr/bin/env bash\necho "not json at all"\n');
  const res = runAnalyzer(root, { analyzeScript: stub });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /parse/i);
});

// ── BPA parsing of the new subtypes (parser + reader) ───────────────────────

function writeBpaCsv(root) {
  const rows = [
    'code,type,subtype,importance,identifier,message,context',
    // CDW — note underscore in path (design_dialog) must survive round-trip.
    'CDW,custom.dialog.widget,custom.classic.widget,MAJOR,/apps/x/components/c/design_dialog/items/w1,Custom widget,ctx',
    'CDW,custom.dialog.widget,custom.classic.widget,MAJOR,/apps/x/components/c/dialog/items/w2,Custom widget,ctx',
    // LUI — dialogs + a static-template sub-type (should NOT count under lui).
    'LUI,legacy.user.interface,legacy.dialog.classic,MAJOR,/apps/x/components/c/dialog,Classic dialog,ctx',
    'LUI,legacy.user.interface,legacy.dialog.coral2,MAJOR,/apps/x/components/c/_cq_dialog,Coral2 dialog,ctx',
    'LUI,legacy.user.interface,legacy.static.template,MINOR,/apps/x/templates/t1,Static template,ctx',
    // CTEM — another static template.
    'CTEM,custom.template,custom.static.template,MINOR,/apps/x/templates/t2,Static template,ctx',
    // REP — one real forward finding + a summary row that must be excluded.
    'REP,replication.agent,forward.replication,MAJOR,agent-1,Forward replication agent,ctx',
    '_COUNT_REP,_count.replication.agent,forward.replication,INFO,\\N,summary,ctx',
  ];
  const p = path.join(root, 'bpa.csv');
  fs.writeFileSync(p, rows.join('\n') + '\n', 'utf8');
  return p;
}

test('BPA parser extracts cdw/lui/template/replication and excludes _COUNT rows', async () => {
  const root = mkworkspace();
  const csv = writeBpaCsv(root);
  const opts = { bpaFilePath: csv, collectionsDir: path.join(root, 'uc'), limit: null, offset: 0 };

  const cdw = await getBpaFindings('cdw', opts);
  assert.strictEqual(cdw.targets.length, 2);
  // Underscore path must survive the unified round-trip (no design_dialog → design.dialog).
  assert.ok(cdw.targets.some(t => t.className.includes('design_dialog')), 'underscore path preserved');

  const rep = await getBpaFindings('replication', opts);
  assert.strictEqual(rep.targets.length, 1, '_COUNT_REP summary row excluded');

  const tpl = await getBpaFindings('templateModernization', opts);
  assert.strictEqual(tpl.targets.length, 2, 'legacy.static.template + custom.static.template');
});

function writeGuavaCacheBpaCsv(root) {
  const rows = [
    'code,type,subtype,importance,identifier,message,context',
    // Three Guava-internal-class rows for the SAME bundle — must dedupe to one target.
    'GC,development.guideline,custom.guava.cache,INFO,com.google.common.cache.AbstractCache,The com.google.common.cache.AbstractCache class in the com.example.bundle-a bundle uses com.google.common.cache.Cache.,ctx',
    'GC,development.guideline,custom.guava.cache,INFO,com.google.common.cache.CacheBuilder,The com.google.common.cache.CacheBuilder class in the com.example.bundle-a bundle uses com.google.common.cache.CacheBuilder.,ctx',
    'GC,development.guideline,custom.guava.cache,INFO,com.google.common.cache.LoadingCache,The com.google.common.cache.LoadingCache class in the com.example.bundle-a bundle uses com.google.common.cache.LoadingCache.,ctx',
    // A row that matches the subtype but whose message does not match the
    // "in the <bundle> bundle" phrasing — must be dropped, not counted, with a warning.
    'GC,development.guideline,custom.guava.cache,INFO,com.google.common.cache.Foo,Some unexpected BPA message format with no bundle phrase.,ctx',
  ];
  const p = path.join(root, 'guava.csv');
  fs.writeFileSync(p, rows.join('\n') + '\n', 'utf8');
  return p;
}

test('guavaCache dedupes multiple rows for one bundle to a single target, and warns (not drops silently) on an unparseable message', async () => {
  const root = mkworkspace();
  const csv = writeGuavaCacheBpaCsv(root);
  const opts = { bpaFilePath: csv, collectionsDir: path.join(root, 'uc'), limit: null, offset: 0 };

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let result;
  try {
    result = await getBpaFindings('guavaCache', opts);
  } finally {
    console.warn = originalWarn;
  }

  assert.strictEqual(result.targets.length, 1, 'three rows for the same bundle dedupe to one target');
  assert.strictEqual(result.targets[0].className, 'com.example.bundle-a');
  assert.ok(
    warnings.some(w => /could not be parsed for a bundle name/.test(w)),
    'the unparseable row emits a warning instead of vanishing silently'
  );
});

test('a real BPA fetch failure is surfaced (warning + needsLlmScan), NOT reported clean', async () => {
  const root = mkworkspace();
  const gathered = await gatherFindings({
    workspaceRoot: root,
    collectionsDir: path.join(root, 'uc'),                 // no cached collection
    projectId: 'proj-1',                                   // + mcpFetcher ⇒ bpaMode='mcp'
    mcpFetcher: async () => { throw new Error('MCP down'); },
    analyzeScript: path.join(root, 'missing-analyze.sh'),  // analyzer unavailable
  });
  // scheduler is a cascade BPA pattern; the fetch threw — it must NOT be marked
  // as cleanly scanned by BPA, and must be surfaced for follow-up.
  assert.notStrictEqual(gathered.sourceByPattern.scheduler, 'mcp');
  assert.ok(gathered.needsLlmScan.includes('scheduler'), 'failed pattern surfaced in needsLlmScan');
  assert.ok(
    gathered.analyzerWarnings.some(w => /BPA fetch failed.*scheduler/.test(w)),
    'a Scan-warnings entry names the failed pattern'
  );
});

test('benign "pattern not in CSV" stays silent and counts as clean', async () => {
  const root = mkworkspace();
  const csv = writeBpaCsv(root); // has cdw/lui/etc but NOT scheduler
  const gathered = await gatherFindings({
    workspaceRoot: root, bpaFilePath: csv, collectionsDir: path.join(root, 'uc'),
    analyzeScript: path.join(root, 'missing-analyze.sh'),
  });
  // scheduler is absent from the report → genuinely clean, sourced from csv, no warning.
  assert.strictEqual(gathered.sourceByPattern.scheduler, 'csv');
  assert.strictEqual(gathered.findingsByPattern.scheduler.length, 0);
  assert.ok(!gathered.needsLlmScan.includes('scheduler'));
  assert.ok(!gathered.analyzerWarnings.some(w => /scheduler/.test(w)), 'no warning for a benign absence');
});

test('runbook lui is filtered to dialog sub-types when sourced from BPA', async () => {
  const root = mkworkspace();
  const csv = writeBpaCsv(root);
  const out = path.join(root, 'rb.md');
  const cache = path.join(root, 'rb.json');
  const result = await generateRunbook({
    workspaceRoot: root, bpaFilePath: csv, collectionsDir: path.join(root, 'uc'),
    outputPath: out, cachePath: cache,
  });
  assert.strictEqual(result.patternCounts.lui, 2, 'only classic + coral2, not static.template');
  assert.strictEqual(result.patternCounts.cdw, 2);
  assert.strictEqual(result.patternCounts.templateModernization, 2);
  assert.strictEqual(result.gathered.sourceByPattern.lui, 'csv');
});

// ── URC: BPA report mapping ─────────────────────────────────────────────────

test('getBpaFindings resolves the urc pattern from a BPA CSV, excluding count rows', async () => {
  const dir = mkworkspace();
  const csv = path.join(dir, 'bpa.csv');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'urc-bpa.csv'), csv);
  const collectionsDir = path.join(dir, 'collections');
  const res = await getBpaFindings('urc', { bpaFilePath: csv, collectionsDir, limit: null, offset: 0 });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.targets.length, 2, 'two URC detail rows, count row excluded');
  const locations = res.targets.map(t => t.className).sort();
  assert.deepStrictEqual(locations, ['/apps/demo/config.dev.author', '/apps/demo/config.preprod']);
});

// ── URC: report-first with local fallback (end to end) ──────────────────────

test('URC comes from the BPA report when a report is present (report owns it)', async () => {
  const root = mkworkspace();
  // Bad folder on disk that the report does NOT list — report ownership means
  // it is treated as clean and the local scanner is not consulted.
  write(root, 'ui.config/jcr_root/apps/my/config.stage.author/com.my.Svc.cfg.json', '{ "a": 1 }\n');
  const csv = path.join(root, 'bpa.csv');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'urc-bpa.csv'), csv);
  const gathered = await gatherFindings({ workspaceRoot: root, bpaFilePath: csv, collectionsDir: path.join(root, 'collections') });
  const urc = gathered.rawFindingsByPattern.osgiConfig.filter(f => f.kind === 'unsupported-runmode');
  // BPA-sourced URC findings now carry the same `kind`/`runmode` shape as the
  // local scanner — two report rows, not the on-disk bad folder the test
  // planted (which the report does NOT list).
  assert.strictEqual(urc.length, 2, 'both report URC rows enriched with kind: unsupported-runmode');
  const urcFiles = urc.map(f => f.file).sort();
  assert.deepStrictEqual(
    urcFiles,
    ['/apps/demo/config.dev.author', '/apps/demo/config.preprod'],
    'URC raw findings come from the report paths, not the on-disk config.stage.author folder — proving report ownership'
  );
  const devAuthor = urc.find(f => f.file === '/apps/demo/config.dev.author');
  assert.strictEqual(devAuthor.runmode, 'dev.author', 'runmode derived from the folder basename via validateRunmodeFolder');

  // …and the report URC folders are present as osgiConfig findings, with a
  // rich detail carrying the folder basename (not the bare BPA identifier
  // string 'unsupported.runmode').
  const finding = gathered.findingsByPattern.osgiConfig.find(f => String(f.location).includes('config.dev.author'));
  assert.ok(finding, 'URC from report present');
  assert.ok(finding.detail.includes('config.dev.author'), 'detail contains the folder basename');
  assert.ok(!finding.detail.includes('unsupported.runmode'), 'detail is not the bare BPA identifier string');
});

test('URC falls back to local detection when no BPA source is present', async () => {
  const root = mkworkspace();
  write(root, 'ui.config/jcr_root/apps/my/config.dev.author/com.my.Svc.cfg.json', '{ "a": 1 }\n');
  const gathered = await gatherFindings({ workspaceRoot: root });
  const urc = gathered.rawFindingsByPattern.osgiConfig.filter(f => f.kind === 'unsupported-runmode');
  assert.strictEqual(urc.length, 1, 'local scanner produced the URC finding');
  assert.strictEqual(urc[0].runmode, 'dev.author');
});

// ── URC: MCP path (the masking hole also exists via MCP, not just CSV) ──────

test('URC comes from MCP when the mcpFetcher reports URC targets', async () => {
  const root = mkworkspace();
  const mcpFetcher = async ({ pattern }) => {
    if (pattern === 'urc') {
      return {
        success: true,
        targets: [
          { className: '/apps/demo/config.dev.author', identifier: 'unsupported.runmode', issue: 'bad runmode' },
        ],
      };
    }
    // Any other pattern (scheduler, resourceChangeListener, ...) — report clean.
    return { success: true, targets: [] };
  };
  const gathered = await gatherFindings({
    workspaceRoot: root,
    collectionsDir: path.join(root, 'mcp-collections'),
    projectId: 'proj-mcp-urc',
    mcpFetcher,
  });
  const urc = gathered.rawFindingsByPattern.osgiConfig.filter(f => f.kind === 'unsupported-runmode');
  assert.strictEqual(urc.length, 1, 'MCP-sourced URC finding surfaces');
  assert.strictEqual(urc[0].file, '/apps/demo/config.dev.author');
  assert.strictEqual(urc[0].runmode, 'dev.author');
  assert.ok(!gathered.analyzerWarnings.some(w => w.includes('safety net')),
    'no safety-net warning when MCP actually reports URC findings');
});

test('URC safety-net scan also runs when the mcpFetcher reports success with EMPTY URC targets', async () => {
  const root = mkworkspace();
  // On-disk unsupported folder the (URC-empty) MCP response does not mention.
  write(root, 'ui.config/jcr_root/apps/my/config.qa/com.my.Svc.cfg.json', '{ "a": 1 }\n');
  const mcpFetcher = async ({ pattern }) => {
    if (pattern === 'urc') return { success: true, targets: [] };
    return { success: true, targets: [] };
  };
  const gathered = await gatherFindings({
    workspaceRoot: root,
    collectionsDir: path.join(root, 'mcp-collections'),
    projectId: 'proj-mcp-urc-empty',
    mcpFetcher,
  });
  const urc = gathered.rawFindingsByPattern.osgiConfig.filter(f => f.kind === 'unsupported-runmode');
  assert.ok(urc.some(f => String(f.file).includes('config.qa')),
    'on-disk URC finding surfaces via the local safety-net scan even though MCP is configured');
  assert.ok(
    gathered.analyzerWarnings.some(w => w.includes(
      'BPA source present but reported no URC (unsupported.runmode) findings — running the local config.*/install.* run-mode scan as a safety net (the report may predate URC detection or be scoped to other patterns).'
    )),
    'a safety-net warning is surfaced for the MCP masking path too'
  );
});

test('a BPA report present but with NO URC rows warns and still runs the local safety-net scan', async () => {
  const root = mkworkspace();
  // On-disk unsupported folder the (URC-less) BPA report does not mention.
  write(root, 'ui.config/jcr_root/apps/my/config.qa/com.my.Svc.cfg.json', '{ "a": 1 }\n');
  const bpaFilePath = path.join(__dirname, 'fixtures', 'minimal-scheduler-bpa.csv');
  const gathered = await gatherFindings({
    workspaceRoot: root, bpaFilePath, collectionsDir: path.join(root, 'uc'),
  });
  const urc = gathered.rawFindingsByPattern.osgiConfig.filter(f => f.kind === 'unsupported-runmode');
  assert.ok(urc.some(f => String(f.file).includes('config.qa')),
    'on-disk URC finding surfaces even though a BPA source is present');
  assert.ok(
    gathered.analyzerWarnings.some(w => w.includes(
      'BPA source present but reported no URC (unsupported.runmode) findings — running the local config.*/install.* run-mode scan as a safety net (the report may predate URC detection or be scoped to other patterns).'
    )),
    'a safety-net warning is surfaced'
  );
});

// ── Performance-fix behaviors: relPath, classKey, sourceLabel, preFetchedBpa, LLM merge ──

test('relPath collapses a finding AT the workspace root to "." (no absolute-path leak)', () => {
  const ws = '/Users/me/project';
  assert.strictEqual(relPath('/Users/me/project', ws), '.');       // config at root — was the leak
  assert.strictEqual(relPath('/Users/me/project/', ws), '.');      // trailing separator
  assert.strictEqual(relPath('/Users/me/project/dispatcher', ws), 'dispatcher');
  assert.strictEqual(relPath('com.acme.MyJob', ws), 'com.acme.MyJob'); // non-path value untouched
});

test('classKey normalizes a BPA className and an analyzer file path to the same key', () => {
  assert.strictEqual(classKey('com.acme.jobs.MyJob'), 'myjob');
  assert.strictEqual(classKey('core/src/main/java/com/acme/jobs/MyJob.java'), 'myjob');
  assert.strictEqual(classKey('com.acme.jobs.MyJob'), classKey('core/src/main/java/com/acme/jobs/MyJob.java'));
  assert.strictEqual(classKey(null), null);
});

test('sourceLabel renders unioned sources (mcp+analyzer) with both labels', () => {
  assert.strictEqual(sourceLabel('mcp'), 'BPA / CAM');
  assert.strictEqual(sourceLabel('mcp+analyzer'), 'BPA / CAM + analyzer');
  assert.strictEqual(sourceLabel('csv+analyzer'), 'BPA CSV + analyzer');
  assert.strictEqual(sourceLabel(undefined), '—');
});

test('preFetchedBpa drives BPA findings with no mcpFetcher bridge (CLI --bpa-json path)', async () => {
  const root = mkworkspace();
  // Pre-fetched CAM/MCP result: slug → raw BPA targets, exactly what the agent dumps to JSON.
  const preFetchedBpa = {
    scheduler: [{ className: 'com.acme.MySchedulerJob', identifier: 'scheduler', severity: 'high' }],
  };
  const gathered = await gatherFindings({ workspaceRoot: root, preFetchedBpa });
  assert.strictEqual(gathered.bpaMode, 'mcp', 'pre-fetched BPA counts as a CAM/MCP source');
  assert.strictEqual(gathered.sourceByPattern.scheduler, 'mcp');
  assert.strictEqual(gathered.findingsByPattern.scheduler.length, 1);
  assert.strictEqual(gathered.findingsByPattern.scheduler[0].location, 'com.acme.MySchedulerJob');
  // A slug absent from the map is a benign "clean" — not an error, not needsLlmScan.
  assert.ok(!gathered.needsLlmScan.includes('scheduler'));
  assert.ok(!gathered.analyzerWarnings.some(w => /scheduler/.test(w)), 'absent slug does not raise a fetch error');
});

test('mergeLlmFindings folds Tier-4 results in one pass (source llm, dropped from needsLlmScan)', () => {
  const gathered = {
    findingsByPattern: { guavaCache: [] },
    rawFindingsByPattern: { guavaCache: [] },
    sourceByPattern: {},
    needsLlmScan: ['guavaCache', 'replication'],
  };
  mergeLlmFindings(gathered, {
    guavaCache: [{ file: 'core/src/main/java/com/acme/Cache.java', line: 42, snippet: 'import com.google.common.cache.CacheBuilder' }],
  });
  assert.strictEqual(gathered.sourceByPattern.guavaCache, 'llm');
  assert.strictEqual(gathered.findingsByPattern.guavaCache.length, 1);
  assert.strictEqual(gathered.findingsByPattern.guavaCache[0].location, 'core/src/main/java/com/acme/Cache.java:42');
  assert.strictEqual(gathered.rawFindingsByPattern.guavaCache[0].snippet, 'import com.google.common.cache.CacheBuilder');
  assert.deepStrictEqual(gathered.needsLlmScan, ['replication'], 'merged pattern is removed; others remain');
});

test('generateRunbook applies llmByPattern end to end (one command, no re-render)', async () => {
  const root = mkworkspace();
  const out = path.join(root, 'runbook.md');
  const cache = path.join(root, 'runbook.json');
  const result = await generateRunbook({
    workspaceRoot: root, outputPath: out, cachePath: cache,
    llmByPattern: { guavaCache: [{ file: 'bundle/Foo.java', line: 3, snippet: 'com.google.common.cache' }] },
  });
  assert.strictEqual(result.gathered.sourceByPattern.guavaCache, 'llm');
  assert.ok(!result.needsLlmScan.includes('guavaCache'));
  const md = fs.readFileSync(out, 'utf8');
  assert.match(md, /LLM scan/);            // rendered "Detected via: LLM scan"
  assert.match(md, /bundle\/Foo\.java:3/);
});

test('acl: CLI rejects invalid --migration-path with exit 2 and writes nothing', () => {
  const cases = [
    { args: ['--migration-path', 'content/x'], expected: /Invalid --migration-path "content\/x"/ },
    { args: ['--migration-path', ''], expected: /Invalid --migration-path ""/ },
    { args: ['--migration-path'], expected: /requires a value/ },
  ];

  for (const { args, expected } of cases) {
    const ws = mkworkspace();
    const out = path.join(ws, 'migration-runbook.md');
    const cache = path.join(ws, 'migration-runbook.json');
    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'runbook-generator.js'), ws, ...args, '--out', out, '--cache', cache,
    ], { cwd: ws, encoding: 'utf8' });

    assert.strictEqual(result.status, 2, result.stderr);
    assert.match(result.stderr, expected);
    assert.match(result.stderr, /--migration-path \/content\/site/);
    assert.ok(!fs.existsSync(out) && !fs.existsSync(cache), 'invalid paths must not write output');
  }
});

test('acl: CLI accepts repeatable --migration-path', () => {
  const ws = mkworkspace();
  const out = path.join(ws, 'migration-runbook.md');
  const cache = path.join(ws, 'migration-runbook.json');
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'runbook-generator.js'), ws,
    '--migration-path', '/content/a', '--migration-path', '/content/b/',
    '--out', out, '--cache', cache,
  ], { cwd: ws, encoding: 'utf8' });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /Migration paths: \/content\/a, \/content\/b/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(cache, 'utf8')).migrationPaths, ['/content/a', '/content/b']);
});

test('Fix D: analyzer union fills a BPA-clean cascade pattern and dedups by class name', async (t) => {
  const root = mkworkspace();
  write(root, 'core/src/main/java/com/acme/LegacyJob.java',
    'package com.acme;\n' +
    'import org.apache.sling.commons.scheduler.Scheduler;\n' +
    'import org.osgi.service.component.annotations.Component;\n' +
    '@Component(service = Runnable.class, property = {"scheduler.expression=0 0 * * * ?"})\n' +
    'public class LegacyJob implements Runnable { private Scheduler scheduler; public void run() {} }\n');

  // Probe: with no BPA source the analyzer owns scheduler. If it can't run here
  // (no JDK / analyzer), skip — this behavior needs the real analyzer.
  const probe = await gatherFindings({ workspaceRoot: root });
  if (!isAnalyzerAvailable(DEFAULT_ANALYZE_SCRIPT) || probe.sourceByPattern.scheduler !== 'analyzer' || probe.findingsByPattern.scheduler.length < 1) {
    t.skip('analyzer/JDK not available in this environment');
    return;
  }

  // BPA reports scheduler CLEAN → the union must still surface the analyzer's finding.
  const unioned = await gatherFindings({ workspaceRoot: root, preFetchedBpa: { scheduler: [] } });
  assert.strictEqual(unioned.findingsByPattern.scheduler.length, 1, 'analyzer finding unioned into a BPA-clean pattern');
  assert.strictEqual(unioned.sourceByPattern.scheduler, 'mcp+analyzer');

  // BPA already reports the SAME class → deduped by class name, no double count.
  const deduped = await gatherFindings({ workspaceRoot: root, preFetchedBpa: { scheduler: [{ className: 'com.acme.LegacyJob', identifier: 'scheduler' }] } });
  assert.strictEqual(deduped.findingsByPattern.scheduler.length, 1, 'same class is deduped');
  assert.strictEqual(deduped.sourceByPattern.scheduler, 'mcp', 'no analyzer suffix when nothing new was added');
});

// ── bpaIncomplete: a BPA source that structurally can't report a pattern must not mark it clean ──

test('bpaIncomplete: BPA-clean templateModernization still runs the content-scan fallback (CAM cannot see templates)', async () => {
  const root = mkworkspace();
  write(root, 'ui.apps/jcr_root/apps/my/templates/content-page/.content.xml',
    '<jcr:root jcr:primaryType="cq:Template"/>');
  // A BPA source is present (isolated collectionsDir) but reports nothing for
  // templateModernization — CAM can't report templates, so this must NOT be clean.
  const gathered = await gatherFindings({
    workspaceRoot: root,
    collectionsDir: path.join(root, 'nocollections'),
    preFetchedBpa: { templateModernization: [] },
  });
  assert.strictEqual(gathered.bpaMode, 'mcp');
  assert.strictEqual(gathered.sourceByPattern.templateModernization, 'content-scan',
    'content-scan ran despite the BPA source');
  assert.strictEqual(gathered.findingsByPattern.templateModernization.length, 1);
  assert.ok(!gathered.needsLlmScan.includes('templateModernization'));
});

test('bpaIncomplete: BPA-clean guavaCache falls through to needsLlmScan (own bundle may be filtered out)', async () => {
  const root = mkworkspace();
  const gathered = await gatherFindings({
    workspaceRoot: root,
    collectionsDir: path.join(root, 'nocollections'),
    preFetchedBpa: { guavaCache: [] },
  });
  assert.ok(gathered.needsLlmScan.includes('guavaCache'),
    'a zero BPA result for a bpaIncomplete bpa-only pattern is not treated as clean');
  assert.notStrictEqual(gathered.sourceByPattern.guavaCache, 'mcp');
});

test('bpaIncomplete does NOT change lui/cdw: CAM reports those reliably, so BPA-clean stays clean', async () => {
  const root = mkworkspace();
  const gathered = await gatherFindings({
    workspaceRoot: root,
    collectionsDir: path.join(root, 'nocollections'),
    preFetchedBpa: { lui: [], cdw: [] },
  });
  for (const p of ['lui', 'cdw']) {
    assert.strictEqual(gathered.sourceByPattern[p], 'mcp', `${p} owned by BPA`);
    assert.ok(!gathered.needsLlmScan.includes(p), `${p} not pushed to LLM tier`);
  }
});

test('bpaIncomplete: when BPA DOES report the pattern, BPA still owns it (no fallback override)', async () => {
  const root = mkworkspace();
  write(root, 'ui.apps/jcr_root/apps/my/templates/content-page/.content.xml',
    '<jcr:root jcr:primaryType="cq:Template"/>');
  const gathered = await gatherFindings({
    workspaceRoot: root,
    collectionsDir: path.join(root, 'nocollections'),
    preFetchedBpa: { templateModernization: [{ className: '/apps/my/templates/reported', identifier: 'legacy.static.template' }] },
  });
  assert.strictEqual(gathered.sourceByPattern.templateModernization, 'mcp', 'BPA owns it when it reports findings');
  assert.strictEqual(gathered.findingsByPattern.templateModernization.length, 1, 'BPA finding, not the content-scan one');
});

// ── ACL scan ──

test('acl: decodeFileVaultPath decodes namespaces, double underscores and %xx', () => {
  assert.strictEqual(decodeFileVaultPath(['content', '_jcr_content', 'a%3Ab']), '/content/jcr:content/a:b');
  assert.strictEqual(decodeFileVaultPath(['__x']), '/_x');
  assert.strictEqual(decodeFileVaultPath([]), '/');
  assert.strictEqual(decodeFileVaultPath(['bad%E0%A4']), null);
});

test('acl: parseFileVaultValue handles types, escaped commas and entities', () => {
  assert.deepStrictEqual(parseFileVaultValue('{Name}[jcr:read,rep:write]'), ['jcr:read', 'rep:write']);
  assert.deepStrictEqual(parseFileVaultValue('{String}[a\\,b]'), ['a,b']);
  assert.deepStrictEqual(parseFileVaultValue('{String}[a\\\\b]'), ['a\\b']);
  assert.deepStrictEqual(parseFileVaultValue('*/jcr:content*'), ['*/jcr:content*']);
  assert.deepStrictEqual(parseFileVaultValue('[]'), []);
  assert.strictEqual(parseFileVaultValue('[unterminated'), null);
  assert.strictEqual(parseFileVaultValue('[nested[bracket]'), null);
});

function aclPolicyXml(children) {
  return `<jcr:root xmlns:jcr="http://www.jcp.org/jcr/1.0" xmlns:rep="internal" jcr:primaryType="rep:ACL">${children}</jcr:root>`;
}

function writeContentPackage(root, mod, { filters, acHandling, acIn = 'properties' } = {}) {
  const contentRoot = path.join(mod, 'src/main/content');
  write(root, `${contentRoot}/jcr_root/.keep`, '');
  fs.mkdirSync(path.join(root, contentRoot, 'META-INF/vault'), { recursive: true });
  if (filters) {
    const xml = [
      '<workspaceFilter version="1.0">',
      ...filters.map(({ root: filterRoot, rules }) => {
        const lines = [`  <filter root="${filterRoot}">`];
        if (Array.isArray(rules)) {
          for (const [kind, pattern] of rules) {
            lines.push(`    <${kind} pattern="${pattern}"/>`);
          }
        }
        lines.push('  </filter>');
        return lines.join('\n');
      }),
      '</workspaceFilter>',
    ].join('\n');
    write(root, `${contentRoot}/META-INF/vault/filter.xml`, xml);
  }
  if (acHandling) {
    if (acIn === 'properties') {
      const propertiesXml = [
        '<properties>',
        `  <entry key="acHandling">${acHandling}</entry>`,
        '</properties>',
      ].join('\n');
      write(root, `${contentRoot}/META-INF/vault/properties.xml`, propertiesXml);
    } else if (acIn === 'pom') {
      const pom = [
        '<project>',
        '  <build><plugins><plugin>',
        '    <artifactId>filevault-package-maven-plugin</artifactId><configuration>',
        `    <accessControlHandling>${acHandling}</accessControlHandling>`,
        '  </configuration></plugin></plugins></build>',
        '</project>',
      ].join('\n');
      write(root, `${mod}/pom.xml`, pom);
    }
  }
  return path.join(root, contentRoot);
}

test('acl: parsePolicyXml parses grant/deny ACEs in order with restrictions', () => {
  const xml = aclPolicyXml([
    '<allow jcr:primaryType="rep:GrantACE" rep:principalName="example-editors" rep:privileges="{Name}[jcr:read,rep:write]" rep:glob="*/jcr:content*"/>',
    '<deny jcr:primaryType="rep:DenyACE" rep:principalName="example-guests" rep:privileges="{Name}[jcr:all]"><rep:restrictions rep:ntNames="{Name}[cq:Page,dam:Asset]"/></deny>',
    '<allow1 jcr:primaryType="rep:UnknownACE"/>',
  ].join(''));
  const { entries, fatal } = parsePolicyXml(xml, { nodePath: '/content/x' });
  assert.strictEqual(fatal, null);
  assert.deepStrictEqual(entries.map(e => [e.order, e.effect, e.kind]), [[0, 'allow', 'acl-entry'], [1, 'deny', 'acl-entry'], [2, null, 'acl-unknown']]);
  assert.deepStrictEqual(entries[0].restrictions, { 'rep:glob': ['*/jcr:content*'] });
  assert.deepStrictEqual(entries[1].restrictions, { 'rep:ntNames': ['cq:Page', 'dam:Asset'] });
  assert.deepStrictEqual(entries[0].privileges, ['jcr:read', 'rep:write']);
  assert.ok(entries.every(e => e.policyPath === '/content/x' && e.sourceType === 'policy-xml'));
  assert.deepStrictEqual(entries.map(entry => entry.status), ['parsed', 'parsed', 'unknown']);
  assert.ok(entries.every(entry => entry.runmode === null));
  assert.strictEqual(entries[0].reason, null);
  assert.match(entries[2].reason, /unexpected ACE type rep:UnknownACE/);
});

test('acl: parsePolicyXml decodes XML attribute entities', () => {
  const xml = aclPolicyXml('<allow jcr:primaryType="rep:GrantACE" rep:principalName="example-editors" rep:privileges="{Name}[jcr:read]" rep:glob="a&amp;b&lt;c&gt;&quot;d&apos;e&#58;&#x21;"/>');
  const { entries, fatal } = parsePolicyXml(xml, { nodePath: '/content/x' });
  assert.strictEqual(fatal, null);
  assert.deepStrictEqual(entries[0].restrictions, { 'rep:glob': ['a&b<c>"d\'e:!'] });
});

test('acl: parsePolicyXml reports a non-ACL policy-file root as unknown', () => {
  const xml = '<jcr:root jcr:primaryType="rep:Unrelated"/>';
  const { entries, fatal } = parsePolicyXml(xml, { nodePath: '/content/x' });
  assert.strictEqual(fatal, null);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].kind, 'acl-unknown');
  assert.strictEqual(entries[0].reason, 'root is not rep:ACL');
});

test('acl: parsePolicyXml marks ACEs missing principal or privileges unknown', () => {
  const xml = aclPolicyXml([
    '<missingPrincipal jcr:primaryType="rep:GrantACE" rep:privileges="{Name}[jcr:read]"/>',
    '<missingPrivileges jcr:primaryType="rep:DenyACE" rep:principalName="example-viewers"/>',
  ].join(''));
  const { entries, fatal } = parsePolicyXml(xml, { nodePath: '/content/x' });
  assert.strictEqual(fatal, null);
  assert.strictEqual(entries.length, 2);
  assert.ok(entries.every(e => e.kind === 'acl-unknown'));
  assert.match(entries[0].reason, /missing rep:principalName/);
  assert.match(entries[1].reason, /missing rep:privileges/);
});

test('acl: parsePolicyXml inline rep:policy resolves nested node path', () => {
  const ace = '<allow jcr:primaryType="rep:GrantACE" rep:principalName="example-editors" rep:privileges="{Name}[jcr:read]"/>';
  const xml = `<jcr:root><jcr:content><rep:policy jcr:primaryType="rep:ACL">${ace}</rep:policy></jcr:content></jcr:root>`;
  const { entries, fatal } = parsePolicyXml(xml, { nodePath: '/content/site', inline: true });
  assert.strictEqual(fatal, null);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].policyPath, '/content/site/jcr:content');
  assert.strictEqual(entries[0].sourceType, 'inline-policy');
  const rootPath = parsePolicyXml(xml, { nodePath: '/', inline: true });
  assert.strictEqual(rootPath.entries[0].policyPath, '/jcr:content');

  const wrongType = '<jcr:root><rep:policy jcr:primaryType="rep:Unrelated"/></jcr:root>';
  const unknown = parsePolicyXml(wrongType, { nodePath: '/content/site', inline: true });
  assert.strictEqual(unknown.fatal, null);
  assert.strictEqual(unknown.entries.length, 1);
  assert.strictEqual(unknown.entries[0].kind, 'acl-unknown');
});

test('acl: parsePolicyXml returns fatal for malformed XML', () => {
  const malformed = [
    '<jcr:root jcr:primaryType="rep:ACL"><allow',
    '<jcr:root jcr:primaryType="rep:ACL"></not-root>',
    '<jcr:root jcr:primaryType="rep:ACL"><</jcr:root>',
    '<jcr:root jcr:primaryType="rep:ACL"><allow jcr:primaryType="rep:GrantACE"rep:principalName="example-editors"/></jcr:root>',
  ];
  for (const xml of malformed) {
    const { entries, fatal } = parsePolicyXml(xml, { nodePath: '/content/x' });
    assert.ok(typeof fatal === 'string' && fatal.length > 0);
    assert.deepStrictEqual(entries, []);
  }
});

test('acl: parsePolicyXml reports ACE line numbers with CRLF', () => {
  const xml = [
    '<jcr:root jcr:primaryType="rep:ACL">',
    '  <allow jcr:primaryType="rep:GrantACE" rep:principalName="example-editors" rep:privileges="{Name}[jcr:read]"/>',
    '  <deny jcr:primaryType="rep:DenyACE" rep:principalName="example-guests" rep:privileges="{Name}[jcr:all]"/>',
    '</jcr:root>',
  ].join('\r\n');
  const { entries, fatal } = parsePolicyXml(xml, { nodePath: '/content/x' });
  assert.strictEqual(fatal, null);
  assert.strictEqual(entries[1].line, 3);
});

test('acl: importVerdict follows first-match table', () => {
  assert.strictEqual(importVerdict('covered', 'clear'), 'acl-clear-review');
  assert.strictEqual(importVerdict('not-covered', 'clear'), 'acl-clear-review');
  assert.strictEqual(importVerdict('not-covered', 'merge'), 'not-eligible-for-acl-import');
  assert.strictEqual(importVerdict('covered', 'ignore'), 'not-eligible-for-acl-import');
  assert.strictEqual(importVerdict('unknown', 'ignore'), 'not-eligible-for-acl-import');
  for (const h of ['overwrite', 'merge', 'merge_preserve']) {
    assert.strictEqual(importVerdict('covered', h), 'eligible-for-acl-import');
  }
  assert.strictEqual(importVerdict('covered', 'not-set'), 'unknown');
  assert.strictEqual(importVerdict('unknown', 'merge'), 'unknown');
});

test('acl: resolvePackage reports not-covered when filter misses the policy path', () => {
  const root = mkworkspace();
  const contentRoot = writeContentPackage(root, 'ui.apps', { filters: [{ root: '/conf/acme/other' }] });
  const result = resolvePackage(path.join(contentRoot, 'jcr_root/conf/acme/other/.keep'), '/conf/acme/lists/x', root);
  assert.strictEqual(result.filterStatus, 'not-covered');
  assert.strictEqual(result.acHandling, 'not-set');
  assert.strictEqual(result.importVerdict, 'not-eligible-for-acl-import');
});

test('acl: filter root sibling prefix does not cover', () => {
  const root = mkworkspace();
  const contentRoot = writeContentPackage(root, 'ui.apps', { filters: [{ root: '/conf/acme/list' }] });
  const result = resolvePackage(path.join(contentRoot, 'jcr_root/conf/acme/list/.keep'), '/conf/acme/lists/x', root);
  assert.strictEqual(result.filterStatus, 'not-covered');
});

test('acl: resolvePackage include/exclude rules, last match wins', () => {
  const root = mkworkspace();
  const contentRoot = writeContentPackage(root, 'ui.apps', {
    filters: [{ root: '/content/a', rules: [['exclude', '/content/a/b(/.*)?'], ['include', '/content/a/b/c(/.*)?']] }],
  });
  const covered = resolvePackage(path.join(contentRoot, 'jcr_root/content/a/.keep'), '/content/a/b/c', root);
  const notCovered = resolvePackage(path.join(contentRoot, 'jcr_root/content/a/.keep'), '/content/a/b', root);
  assert.strictEqual(covered.filterStatus, 'covered');
  assert.strictEqual(notCovered.filterStatus, 'not-covered');
});

test('acl: resolvePackage unknown filter cases', () => {
  const root = mkworkspace();
  const c1 = writeContentPackage(root, 'ui.apps');
  const r1 = resolvePackage(path.join(c1, 'jcr_root/.keep'), '/content/a', root);
  assert.strictEqual(r1.filterStatus, 'unknown');

  const c2 = writeContentPackage(root, 'ui.apps2', { filters: [{ root: '/content/a' }] });
  write(root, 'ui.apps2/src/main/content/META-INF/vault/filter.xml', '<workspaceFilter><filter root="/content/a">');
  const r2 = resolvePackage(path.join(c2, 'jcr_root/.keep'), '/content/a', root);
  assert.strictEqual(r2.filterStatus, 'unknown');

  const c3 = writeContentPackage(root, 'ui.apps3', { filters: [{ root: '/content/a', rules: [['include', '(']] }] });
  const r3 = resolvePackage(path.join(c3, 'jcr_root/.keep'), '/content/a', root);
  assert.strictEqual(r3.filterStatus, 'unknown');

  const outside = write(root, 'outside/thing.xml', '<x/>');
  const r4 = resolvePackage(outside, '/content/a', root);
  assert.strictEqual(r4.packageRoot, null);
  assert.strictEqual(r4.filterStatus, 'unknown');
  assert.strictEqual(r4.acHandling, 'unknown');
  assert.strictEqual(r4.importVerdict, 'unknown');
});

test('acl: resolvePackage acHandling sources and clear', () => {
  const root = mkworkspace();
  const c1 = writeContentPackage(root, 'ui.apps', {
    filters: [{ root: '/conf/acme' }],
    acHandling: 'merge_preserve',
  });
  const r1 = resolvePackage(path.join(c1, 'jcr_root/.keep'), '/conf/acme/lists/x', root);
  assert.strictEqual(r1.acHandling, 'merge_preserve');
  assert.strictEqual(r1.importVerdict, 'eligible-for-acl-import');

  const c2 = writeContentPackage(root, 'ui.apps2', {
    filters: [{ root: '/conf/acme' }],
    acHandling: 'Overwrite',
    acIn: 'pom',
  });
  const r2 = resolvePackage(path.join(c2, 'jcr_root/.keep'), '/conf/acme/lists/x', root);
  assert.strictEqual(r2.acHandling, 'overwrite');

  const c3 = writeContentPackage(root, 'ui.apps3', {
    filters: [{ root: '/conf/acme' }],
    acHandling: 'merge',
  });
  write(root, 'ui.apps3/pom.xml', '<project><build><plugins><plugin><configuration><accessControlHandling>ignore</accessControlHandling></configuration></plugin></plugins></build></project>');
  const r3 = resolvePackage(path.join(c3, 'jcr_root/.keep'), '/conf/acme/lists/x', root);
  assert.strictEqual(r3.acHandling, 'merge');

  const c4 = writeContentPackage(root, 'ui.apps4', {
    filters: [{ root: '/conf/acme/other' }],
    acHandling: 'clear',
  });
  const r4 = resolvePackage(path.join(c4, 'jcr_root/.keep'), '/conf/acme/lists/x', root);
  assert.strictEqual(r4.importVerdict, 'acl-clear-review');
  const r5 = resolvePackage(path.join(c4, 'jcr_root/.keep'), '/content/x', root);
  assert.strictEqual(r5.importVerdict, 'acl-clear-review');

  const c6 = writeContentPackage(root, 'ui.apps6', {
    filters: [{ root: '/conf/acme' }],
    acHandling: 'foo',
  });
  const r6 = resolvePackage(path.join(c6, 'jcr_root/.keep'), '/conf/acme/lists/x', root);
  assert.strictEqual(r6.acHandling, 'unknown');
});

test('acl: package metadata preserves clear for sibling FileVault layouts', () => {
  for (const layout of ['ui.apps/src/main/content', 'package']) {
    const root = mkworkspace();
    const policy = write(root, `${layout}/jcr_root/content/site/_rep_policy.xml`,
      aclPolicyXml('<allow jcr:primaryType="rep:GrantACE" rep:principalName="example-editors" rep:privileges="{Name}[jcr:read]"/>'));
    write(root, `${layout}/META-INF/vault/filter.xml`, '<workspaceFilter><filter root="/content/site"/></workspaceFilter>');
    write(root, `${layout}/META-INF/vault/properties.xml`, '<properties><entry key="acHandling">clear</entry></properties>');

    const info = resolvePackage(policy, '/content/site', root);
    assert.strictEqual(info.packageRoot, path.join(root, layout));
    assert.strictEqual(info.filterStatus, 'covered');
    assert.strictEqual(info.acHandling, 'clear');
    assert.strictEqual(info.importVerdict, 'acl-clear-review');
    const scanned = runAclScan(root, { migrationPaths: ['/content/site'] });
    assert.strictEqual(scanned.rawFindings[0].importVerdict, 'acl-clear-review');
    assert.strictEqual(scanned.findings[0].severity, 'high');
  }
});

test('acl: package POM handling ignores comments and unrelated plugins, retaining ambiguity', () => {
  const plugin = (id, settings) => `<plugin><artifactId>${id}</artifactId><configuration>${settings}</configuration></plugin>`;
  const filevault = settings => plugin('filevault-package-maven-plugin', settings);
  const contentPackage = settings => plugin('content-package-maven-plugin', settings);
  const merge = '<accessControlHandling>merge</accessControlHandling>';
  const ignore = '<accessControlHandling>ignore</accessControlHandling>';
  const cases = [
    { plugins: `<!-- ${merge} -->${filevault(ignore)}`, handling: 'ignore', verdict: 'not-eligible-for-acl-import' },
    { plugins: `${plugin('unrelated-plugin', merge)}${filevault(ignore)}`, handling: 'ignore', verdict: 'not-eligible-for-acl-import' },
    { plugins: plugin('unrelated-plugin', merge), handling: 'not-set', verdict: 'unknown' },
    { plugins: contentPackage('<properties><acHandling>merge_preserve</acHandling></properties>'), handling: 'merge_preserve', verdict: 'eligible-for-acl-import' },
    { plugins: `${filevault(merge)}${contentPackage(ignore)}`, handling: 'unknown', verdict: 'unknown' },
    { plugins: filevault(`${merge}${ignore}`), handling: 'unknown', verdict: 'unknown' },
    { plugins: filevault('<accessControlHandling>${acl.mode}</accessControlHandling>'), handling: 'unknown', verdict: 'unknown' },
  ];
  for (const { plugins, handling, verdict } of cases) {
    const root = mkworkspace();
    const contentRoot = writeContentPackage(root, 'ui.apps', { filters: [{ root: '/content/site' }] });
    write(root, 'ui.apps/pom.xml', `<project><build><plugins>${plugins}</plugins></build></project>`);
    const info = resolvePackage(path.join(contentRoot, 'jcr_root/.keep'), '/content/site', root);
    assert.strictEqual(info.acHandling, handling, plugins);
    assert.strictEqual(info.importVerdict, verdict, plugins);
  }
});

test('acl: Java-properties declaration preserves clear without resolving a DTD', () => {
  const root = mkworkspace();
  const contentRoot = writeContentPackage(root, 'ui.apps', { filters: [{ root: '/content/site' }] });
  const properties = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE properties SYSTEM "http://java.sun.com/dtd/properties.dtd">',
    '<properties><entry key="acHandling">clear</entry></properties>',
  ].join('\n');
  write(root, 'ui.apps/src/main/content/META-INF/vault/properties.xml', properties);
  const policy = path.join(contentRoot, 'jcr_root/.keep');
  const info = resolvePackage(policy, '/content/site', root);
  assert.strictEqual(info.acHandling, 'clear');
  assert.strictEqual(info.importVerdict, 'acl-clear-review');

  write(root, 'ui.apps/src/main/content/META-INF/vault/properties.xml',
    properties.replace('http://java.sun.com/dtd/properties.dtd', 'https://example.invalid/custom.dtd'));
  assert.strictEqual(resolvePackage(policy, '/content/site', root).acHandling, 'unknown');
});

test('acl: not-set handling explains the FileVault default without inferring import eligibility', () => {
  const root = mkworkspace();
  const contentRoot = writeContentPackage(root, 'ui.apps', { filters: [{ root: '/content/site' }] });
  write(root, path.relative(root, path.join(contentRoot, 'jcr_root/content/site/_rep_policy.xml')),
    aclPolicyXml('<allow jcr:primaryType="rep:GrantACE" rep:principalName="example-editors" rep:privileges="{Name}[jcr:read]"/>'));
  const result = runAclScan(root, { migrationPaths: ['/content/site'] });
  assert.strictEqual(result.rawFindings[0].acHandling, 'not-set');
  assert.strictEqual(result.rawFindings[0].importVerdict, 'unknown');
  assert.match(result.findings[0].detail, /acHandling: not-set/);
  assert.match(result.findings[0].detail, /FileVault.*default.*ignore/);
  assert.match(result.findings[0].detail, /build.*install.*not visible/i);
});

test('acl: isRepoInitConfigName matches ~, legacy - and bare PIDs only', () => {
  const pid = 'org.apache.sling.jcr.repoinit.RepositoryInitializer';
  for (const name of [`${pid}~a.cfg.json`, `${pid}-b.config`, `${pid}.cfg`, `${pid}~x-y.cfg.json`]) {
    assert.ok(isRepoInitConfigName(name), name);
  }
  for (const name of [`${pid}Factory~a.cfg.json`, `${pid}Extra.cfg.json`, `${pid}~a.json`, `other.${pid}~a.cfg.json`]) {
    assert.ok(!isRepoInitConfigName(name), name);
  }
});

test('acl: readRepoInitConfig reads cfg.json, .config and .cfg', () => {
  const jsonOne = readRepoInitConfig(
    '/workspace/ui.config/src/main/content/jcr_root/apps/acme/config.author/org.apache.sling.jcr.repoinit.RepositoryInitializer~author.cfg.json',
    JSON.stringify({
      scripts: 'set ACL for example-svc\n  allow jcr:read on /content\nend',
      references: ['repoinit/a.txt'],
    })
  );
  assert.deepStrictEqual(jsonOne.scripts, ['set ACL for example-svc\n  allow jcr:read on /content\nend']);
  assert.deepStrictEqual(jsonOne.references, ['repoinit/a.txt']);
  assert.strictEqual(jsonOne.runmode, 'author');
  assert.strictEqual(jsonOne.fatal, null);

  const jsonMany = readRepoInitConfig(
    '/workspace/ui.config/src/main/content/jcr_root/apps/acme/config/org.apache.sling.jcr.repoinit.RepositoryInitializer.cfg.json',
    JSON.stringify({ scripts: ['a', 'b'], references: 'repoinit/single.txt' })
  );
  assert.deepStrictEqual(jsonMany.scripts, ['a', 'b']);
  assert.deepStrictEqual(jsonMany.references, ['repoinit/single.txt']);
  assert.strictEqual(jsonMany.runmode, null);

  const felixConfig = readRepoInitConfig(
    '/workspace/ui.config/src/main/content/jcr_root/apps/acme/config.publish/org.apache.sling.jcr.repoinit.RepositoryInitializer-b.config',
    'scripts=["set ACL for a\\n  allow jcr:read on /x\\nend"]\nreferences=["repoinit/x.txt"]\n'
  );
  assert.strictEqual(felixConfig.runmode, 'publish');
  assert.deepStrictEqual(felixConfig.scripts, ['set ACL for a\n  allow jcr:read on /x\nend']);
  assert.deepStrictEqual(felixConfig.references, ['repoinit/x.txt']);
  assert.strictEqual(felixConfig.fatal, null);

  const propsConfig = readRepoInitConfig(
    '/workspace/ui.config/src/main/content/jcr_root/apps/acme/config/org.apache.sling.jcr.repoinit.RepositoryInitializer.cfg',
    'scripts=set ACL for a\\n  allow jcr:read on /x\\nend\nreferences=repoinit/x.txt\n'
  );
  assert.deepStrictEqual(propsConfig.scripts, ['set ACL for a\n  allow jcr:read on /x\nend']);
  assert.deepStrictEqual(propsConfig.references, ['repoinit/x.txt']);
  assert.strictEqual(propsConfig.fatal, null);

  const badJson = readRepoInitConfig(
    '/workspace/ui.config/src/main/content/jcr_root/apps/acme/config/org.apache.sling.jcr.repoinit.RepositoryInitializer.cfg.json',
    '{ scripts: }'
  );
  assert.ok(typeof badJson.fatal === 'string' && badJson.fatal.length > 0);

  const nestedConfig = readRepoInitConfig(
    '/workspace/ui.config/src/main/content/jcr_root/apps/acme/config.author/nested/config/org.apache.sling.jcr.repoinit.RepositoryInitializer.cfg.json',
    JSON.stringify({ scripts: 'set ACL for example-svc\n  allow jcr:read on /content\nend' })
  );
  assert.strictEqual(nestedConfig.runmode, null, 'runmode must come from immediate parent folder only');
});

test('acl: multiline RepoInit config values retain their ACL definitions', () => {
  const first = 'set ACL for example-editors\n  allow jcr:read on /content/site\nend';
  const second = 'set ACL on /content/site\n  deny jcr:write for example-guests\nend';
  const cases = [
    { extension: 'config', text: `scripts=[\n  ${JSON.stringify(first)},\n  ${JSON.stringify(second)}\n]\n`, scripts: [first, second] },
    {
      extension: 'cfg',
      text: ['scripts=set ACL for example-editors\\n\\', '  allow jcr:read on /content/site\\n\\', '  end'].join('\n'),
      scripts: ['set ACL for example-editors\nallow jcr:read on /content/site\nend'],
    },
  ];
  for (const { extension, text, scripts } of cases) {
    const root = mkworkspace();
    const file = write(root, `config.author/org.apache.sling.jcr.repoinit.RepositoryInitializer~multiline.${extension}`, text);
    const config = readRepoInitConfig(file, text);
    assert.strictEqual(config.fatal, null);
    assert.deepStrictEqual(config.scripts, scripts);
    const scanned = runAclScan(root, { migrationPaths: ['/content/site'] });
    assert.strictEqual(scanned.rawFindings.length, scripts.length);
    assert.ok(scanned.rawFindings.every(entry => entry.kind === 'acl-entry' && entry.policyPath === '/content/site'));
    assert.deepStrictEqual(scanned.warnings, []);
  }
});

test('acl: RepoInit config type errors become unknown instead of being discarded', () => {
  const script = 'set ACL for example-editors\n  allow jcr:read on /content/site\nend';
  const cases = [
    { extension: 'cfg.json', text: JSON.stringify({ scripts: 42 }) },
    { extension: 'cfg.json', text: JSON.stringify({ scripts: null }) },
    { extension: 'cfg.json', text: JSON.stringify({ scripts: {} }) },
    { extension: 'cfg.json', text: JSON.stringify({ scripts: [script, 42] }), scripts: [script] },
    { extension: 'cfg.json', text: JSON.stringify({ references: [false] }) },
    { extension: 'cfg.json', text: '[]' },
    { extension: 'cfg.json', text: 'null' },
    { extension: 'config', text: 'scripts=[\n  "unterminated' },
    { extension: 'config', text: 'scripts=["valid"] garbage' },
    { extension: 'config', text: 'scripts=[42]' },
  ];
  for (const { extension, text, scripts = [] } of cases) {
    const root = mkworkspace();
    const file = write(root, `config/org.apache.sling.jcr.repoinit.RepositoryInitializer~invalid.${extension}`, text);
    const config = readRepoInitConfig(file, text);
    assert.ok(config.fatal, text);
    assert.deepStrictEqual(config.scripts, scripts);
    const scanned = runAclScan(root, { migrationPaths: ['/content/site'] });
    assert.strictEqual(scanned.rawFindings.filter(entry => entry.kind === 'acl-entry').length, scripts.length);
    const unknown = scanned.rawFindings.find(entry => entry.kind === 'acl-unknown');
    assert.ok(unknown, text);
    assert.strictEqual(unknown.status, 'unknown');
    assert.strictEqual(unknown.policyPath, null);
    assert.ok(scanned.warnings.some(warning => warning.includes(path.basename(file))));
  }
});

test('acl: fatal RepoInit configs produce an unknown entry and a parse warning', () => {
  const root = mkworkspace();
  const relative = 'config.author/org.apache.sling.jcr.repoinit.RepositoryInitializer~broken.cfg.json';
  write(root, relative, '{"scripts":');
  const scanned = runAclScan(root, { migrationPaths: ['/content/site'] });
  assert.strictEqual(scanned.scanStatus, 'complete');
  assert.strictEqual(scanned.rawFindings.length, 1);
  assert.strictEqual(scanned.rawFindings[0].kind, 'acl-unknown');
  assert.strictEqual(scanned.rawFindings[0].file, relative);
  assert.match(scanned.findings[0].detail, /UNKNOWN.*malformed RepoInit config/);
  assert.ok(scanned.warnings.some(warning => warning.startsWith(`ACL file could not be parsed: ${relative} — `)));
});

test('acl: parseRepoInit parses set ACL for/on with restrictions and multi-path', () => {
  const script = [
    'set ACL for example-svc, example-editors',
    '  allow jcr:read,rep:write on /content/a,/content/b restriction(rep:glob,*/jcr:content*)',
    'end',
    'set ACL on /conf/x',
    '  deny jcr:all for everyone restriction(rep:ntNames,cq:Page,dam:Asset)',
    '  remove * for example-svc',
    'end',
    'set principal ACL for example-svc',
    '  allow jcr:read on /content/c',
    'end',
  ].join('\n');
  const { entries } = parseRepoInit(script, { runmode: 'author' });
  const allows = entries.filter(e => e.kind === 'acl-entry' && e.effect === 'allow');
  assert.strictEqual(allows.length, 2);
  assert.deepStrictEqual(allows.map(e => e.policyPath), ['/content/a', '/content/b']);
  assert.deepStrictEqual(allows[0].principals, ['example-svc', 'example-editors']);
  assert.deepStrictEqual(allows[0].restrictions, { 'rep:glob': ['*/jcr:content*'] });
  assert.ok(entries.every(e => e.sourceType === 'repoinit'));
  assert.ok(entries.every(e => e.runmode === 'author'));
  assert.ok(allows.every(entry => entry.status === 'parsed' && entry.reason === null));
  assert.ok(entries.filter(entry => entry.kind === 'acl-unknown').every(entry => entry.status === 'unknown'));

  const deny = entries.find(e => e.kind === 'acl-entry' && e.effect === 'deny');
  assert.ok(deny);
  assert.strictEqual(deny.policyPath, '/conf/x');
  assert.deepStrictEqual(deny.principals, ['everyone']);
  assert.deepStrictEqual(deny.restrictions, { 'rep:ntNames': ['cq:Page', 'dam:Asset'] });

  const remove = entries.find(e => e.kind === 'acl-unknown' && e.scriptLine === 6);
  assert.ok(remove);
  assert.match(remove.reason, /unrecognized/);
  assert.strictEqual(remove.policyPath, '/conf/x');

  const principalBased = entries.find(e => e.kind === 'acl-unknown' && /principal-based/.test(e.reason));
  assert.ok(principalBased);
});

test('acl: parseRepoInit flags home(), :repository and unterminated blocks unknown', () => {
  const home = parseRepoInit(['set ACL for example-svc', '  allow jcr:read on home(example)', 'end'].join('\n'), { runmode: null });
  assert.strictEqual(home.entries.length, 1);
  assert.strictEqual(home.entries[0].kind, 'acl-unknown');
  assert.strictEqual(home.entries[0].policyPath, null);
  assert.ok(home.entries[0].reason.length > 0);

  const repository = parseRepoInit(['set ACL for example-svc', '  allow jcr:read on :repository', 'end'].join('\n'), { runmode: null });
  assert.strictEqual(repository.entries.length, 1);
  assert.strictEqual(repository.entries[0].kind, 'acl-unknown');
  assert.strictEqual(repository.entries[0].policyPath, null);
  assert.ok(repository.entries[0].reason.length > 0);

  const unterminated = parseRepoInit(['set ACL for example-svc', '  allow jcr:read on /content/a'].join('\n'), { runmode: null });
  assert.strictEqual(unterminated.entries.length, 1);
  assert.strictEqual(unterminated.entries[0].kind, 'acl-unknown');
  assert.strictEqual(unterminated.entries[0].policyPath, null);
  assert.ok(unterminated.entries[0].reason.length > 0);
});

test('acl: unknown RepoInit statements cover every set-ACL-on target when scoped', () => {
  const root = mkworkspace();
  const script = 'set ACL on /content/other,/content/site\n  remove * for example-editors\nend';
  write(root, 'config/org.apache.sling.jcr.repoinit.RepositoryInitializer~targets.cfg.json', JSON.stringify({ scripts: [script] }));
  const parsed = parseRepoInit(script);
  assert.deepStrictEqual(parsed.entries.map(entry => entry.policyPath), ['/content/other', '/content/site']);
  assert.ok(parsed.entries.every(entry => entry.kind === 'acl-unknown' && entry.scriptLine === 2));
  const scanned = runAclScan(root, { migrationPaths: ['/content/site'] });
  assert.strictEqual(scanned.rawFindings.length, 1);
  assert.strictEqual(scanned.rawFindings[0].kind, 'acl-unknown');
  assert.strictEqual(scanned.rawFindings[0].policyPath, '/content/site');
  assert.match(scanned.findings[0].detail, /remove \* for example-editors/);
});

test('acl: malformed or unconsumed RepoInit ACE syntax remains an unresolved unknown', () => {
  const statements = [
    'allow jcr:read on /content/site restriction(rep:glob',
    'allow jcr:read on /content/site restriction(rep:glob,*) trailing',
    'allow jcr:read on /content/site trailing',
    'allow jcr:read on /content/site for example-editors for example-guests',
    'allow jcr:read on /content/site restriction(rep:glob)',
    'allow jcr:read restriction(rep:glob,*) on /content/site',
    'allow jcr:read on /content/site/restriction(rep:glob,*)',
  ];
  for (const statement of statements) {
    const root = mkworkspace();
    const script = `set ACL for example-editors\n  ${statement}\nend`;
    write(root, 'config/org.apache.sling.jcr.repoinit.RepositoryInitializer~syntax.cfg.json', JSON.stringify({ scripts: [script] }));
    const scanned = runAclScan(root, { migrationPaths: ['/content/site'] });
    assert.strictEqual(scanned.rawFindings.length, 1, statement);
    const entry = scanned.rawFindings[0];
    assert.strictEqual(entry.kind, 'acl-unknown', statement);
    assert.strictEqual(entry.policyPath, null, statement);
    assert.strictEqual(entry.scriptLine, 2);
    assert.ok(entry.reason.includes(statement));
    assert.strictEqual(scanned.findings[0].severity, 'high');
  }
});

test('acl: validateMigrationPaths normalizes and rejects invalid values', () => {
  assert.deepStrictEqual(validateMigrationPaths(['/content/site/', '/']), ['/content/site', '/']);
  for (const value of ['content/x', '', '/a/../b', '/a//b', '/a/*']) {
    assert.throws(
      () => validateMigrationPaths([value]),
      error => error instanceof TypeError
        && error.message.includes(value)
        && error.message.includes('--migration-path /content/site')
    );
  }
  assert.throws(() => validateMigrationPaths([undefined]), /requires a value/);
});

test('acl: relationTo classifies self/ancestor/descendant/unrelated with precedence', () => {
  assert.deepStrictEqual(relationTo('/content/site', ['/content/site']), {
    relation: 'self', matchedPaths: ['/content/site'],
  });
  assert.strictEqual(relationTo('/', ['/content/site']).relation, 'ancestor');
  assert.strictEqual(relationTo('/content/site/en', ['/content/site']).relation, 'descendant');
  assert.deepStrictEqual(relationTo('/content', ['/content/site/en', '/content']), {
    relation: 'self', matchedPaths: ['/content/site/en', '/content'],
  });
  assert.deepStrictEqual(relationTo('/x', []), { relation: 'unscoped', matchedPaths: [] });
  assert.deepStrictEqual(relationTo(null, ['/content']), { relation: null, matchedPaths: [] });
});

test('acl: relationTo does not treat sibling prefixes as related', () => {
  assert.strictEqual(relationTo('/content/site2', ['/content/site']).relation, 'unrelated');
  assert.strictEqual(relationTo('/content/site', ['/content/site2']).relation, 'unrelated');
});

test('acl: aceSeverity follows spec §4.5', () => {
  const base = { kind: 'acl-entry', relation: 'self', status: 'parsed', importVerdict: 'eligible-for-acl-import' };
  assert.strictEqual(aceSeverity({ ...base, relation: 'ancestor' }), 'high');
  assert.strictEqual(aceSeverity({ ...base, status: 'unknown' }), 'high');
  for (const importVerdict of ['acl-clear-review', 'not-eligible-for-acl-import', 'unknown']) {
    assert.strictEqual(aceSeverity({ ...base, importVerdict }), 'high');
  }
  assert.strictEqual(aceSeverity({ ...base, relation: 'self' }), 'medium');
  assert.strictEqual(aceSeverity({ ...base, relation: 'unscoped', importVerdict: 'repoinit-defined' }), 'medium');
});

test('acl: runAclScan excluded-filter shape reports not-covered with glob preserved', () => {
  const root = mkworkspace();
  const contentRoot = writeContentPackage(root, 'ui.apps', { filters: [{ root: '/conf/acme/other' }] });
  write(root, path.relative(root, path.join(contentRoot, 'jcr_root/conf/acme/lists/x/_rep_policy.xml')),
    aclPolicyXml('<allow jcr:primaryType="rep:GrantACE" rep:principalName="example-editors" rep:privileges="{Name}[jcr:read]" rep:glob="*/jcr:content*"/>'));
  const result = runAclScan(root, { migrationPaths: ['/conf/acme/lists/x'] });
  assert.strictEqual(result.rawFindings.length, 1);
  const entry = result.rawFindings[0];
  assert.strictEqual(entry.kind, 'acl-entry');
  assert.strictEqual(entry.relation, 'self');
  assert.strictEqual(entry.filterStatus, 'not-covered');
  assert.strictEqual(entry.importVerdict, 'not-eligible-for-acl-import');
  assert.strictEqual(result.findings[0].severity, 'high');
  assert.match(result.findings[0].detail, /rep:glob=\[\*\/jcr:content\*\]/);
  assert.match(result.findings[0].detail, /import: not-eligible-for-acl-import/);
  assert.ok(!entry.file.startsWith(root), 'file path is workspace-relative');
});

test('acl: runAclScan ancestor-policy shape marks ancestor potentially relevant', () => {
  const root = mkworkspace();
  const contentRoot = writeContentPackage(root, 'ui.apps', {
    filters: [{ root: '/content/experience-fragments' }],
    acHandling: 'merge_preserve',
  });
  write(root, path.relative(root, path.join(contentRoot, 'jcr_root/content/experience-fragments/_rep_policy.xml')),
    aclPolicyXml('<allow jcr:primaryType="rep:GrantACE" rep:principalName="example-editors" rep:privileges="{Name}[jcr:read]"/>'));
  const result = runAclScan(root, { migrationPaths: ['/content/experience-fragments/site'] });
  assert.strictEqual(result.rawFindings[0].relation, 'ancestor');
  assert.strictEqual(result.rawFindings[0].importVerdict, 'eligible-for-acl-import');
  assert.strictEqual(result.findings[0].severity, 'high');
  assert.match(result.findings[0].detail, /potentially relevant \(inherited\)/);
  assert.doesNotMatch(result.findings[0].detail, /effective/i);
});

test('acl: runAclScan scoping excludes unrelated, warns unscoped, decodes names', () => {
  const root = mkworkspace();
  const contentRoot = writeContentPackage(root, 'ui.apps', {
    filters: [{ root: '/content' }],
    acHandling: 'merge',
  });
  for (const rel of [
    'jcr_root/content/site/_rep_policy.xml',
    'jcr_root/content/site/en/_jcr_content/_rep_policy.xml',
    'jcr_root/content/other/_rep_policy.xml',
  ]) {
    write(root, path.relative(root, path.join(contentRoot, rel)),
      aclPolicyXml('<allow jcr:primaryType="rep:GrantACE" rep:principalName="example-editors" rep:privileges="{Name}[jcr:read]"/>'));
  }
  const scoped = runAclScan(root, { migrationPaths: ['/content/site'] });
  assert.strictEqual(scoped.rawFindings.length, 2);
  assert.ok(scoped.rawFindings.some(entry => entry.policyPath === '/content/site/en/jcr:content'));
  assert.ok(scoped.warnings.includes('1 ACL entries outside the migration paths were skipped.'));

  const unscoped = runAclScan(root);
  assert.strictEqual(unscoped.rawFindings.length, 3);
  assert.ok(unscoped.rawFindings.every(entry => entry.relation === 'unscoped'));
  assert.ok(unscoped.warnings.includes('No --migration-path given: ACL entries are reported unscoped and inheritance relevance was not assessed. Re-run with --migration-path <jcrPath> (repeatable) for each migration-set path.'));
});

test('acl: runAclScan includes inline policies, RepoInit and unknown files', () => {
  const root = mkworkspace();
  const contentRoot = writeContentPackage(root, 'ui.apps', {
    filters: [{ root: '/content/site' }],
    acHandling: 'merge',
  });
  const ace = '<allow jcr:primaryType="rep:GrantACE" rep:principalName="example-editors" rep:privileges="{Name}[jcr:read]"/>';
  write(root, path.relative(root, path.join(contentRoot, 'jcr_root/content/site/.content.xml')),
    `<jcr:root xmlns:jcr="http://www.jcp.org/jcr/1.0" xmlns:rep="internal"><jcr:content><rep:policy jcr:primaryType="rep:ACL">${ace}</rep:policy></jcr:content></jcr:root>`);
  const runScript = 'set ACL for example-editors\n  allow jcr:read on /content/site\nend';
  write(root, path.relative(root, path.join(contentRoot, 'jcr_root/apps/acme/config.author/org.apache.sling.jcr.repoinit.RepositoryInitializer~a.cfg.json')),
    JSON.stringify({ scripts: [runScript] }));
  write(root, path.relative(root, path.join(contentRoot, 'jcr_root/apps/acme/config/org.apache.sling.jcr.repoinit.RepositoryInitializer-b.config')),
    `scripts="${runScript.replace(/\n/g, '\\n')}"`);
  write(root, path.relative(root, path.join(contentRoot, 'jcr_root/apps/acme/config/org.apache.sling.jcr.repoinit.RepositoryInitializerExtra.cfg.json')),
    JSON.stringify({ scripts: [runScript] }));
  const malformed = path.join(contentRoot, 'jcr_root/content/site/bad/_rep_policy.xml');
  write(root, path.relative(root, malformed), '<jcr:root><broken></jcr:root>');

  const result = runAclScan(root, { migrationPaths: ['/content/site'] });
  assert.ok(result.rawFindings.some(entry => entry.sourceType === 'inline-policy'));
  const repoInit = result.rawFindings.filter(entry => entry.sourceType === 'repoinit');
  assert.strictEqual(repoInit.length, 2);
  assert.ok(repoInit.every(entry => entry.importVerdict === 'repoinit-defined'));
  assert.ok(repoInit.some(entry => entry.runmode === 'author'));
  assert.ok(repoInit.some(entry => entry.runmode === null));
  assert.strictEqual(result.rawFindings.some(entry => entry.file.includes('RepositoryInitializerExtra')), false);
  const malformedEntry = result.rawFindings.find(entry => entry.kind === 'acl-unknown' && entry.policyPath === '/content/site/bad');
  assert.ok(malformedEntry);
  assert.match(malformedEntry.reason, /^malformed:/);
  assert.ok(result.warnings.some(warning => warning.startsWith('ACL file could not be parsed: ')));
  assert.strictEqual(result.scanStatus, 'complete');
});

test('acl: runAclScan resolves in-workspace RepoInit references and flags others unknown', () => {
  const root = mkworkspace();
  const contentRoot = writeContentPackage(root, 'ui.apps');
  write(root, path.relative(root, path.join(contentRoot, 'jcr_root/apps/acme/config.author/org.apache.sling.jcr.repoinit.RepositoryInitializer.cfg.json')),
    JSON.stringify({ references: ['file:repoinit/acl.txt', 'https://example.invalid/x'] }));
  write(root, 'repoinit/acl.txt', [
    '# source',
    'set ACL for example-editors',
    '  allow jcr:read on /content/site',
    'end',
  ].join('\n'));
  const result = runAclScan(root, { migrationPaths: ['/content/site'] });
  const resolved = result.rawFindings.find(entry => entry.file === 'repoinit/acl.txt');
  assert.ok(resolved);
  assert.strictEqual(resolved.line, 3);
  const unresolved = result.rawFindings.find(entry => entry.kind === 'acl-unknown');
  assert.ok(unresolved);
  assert.match(unresolved.reason, /unresolved RepoInit reference/);
});

test('acl: runAclScan skips build and VCS directories', () => {
  const root = mkworkspace();
  const xml = aclPolicyXml('<allow jcr:primaryType="rep:GrantACE" rep:principalName="example-editors" rep:privileges="{Name}[jcr:read]"/>');
  for (const rel of [
    'jcr_root/content/a/_rep_policy.xml',
    'target/classes/jcr_root/content/a/_rep_policy.xml',
    'dist/jcr_root/content/a/_rep_policy.xml',
    'node_modules/x/jcr_root/content/a/_rep_policy.xml',
    '.git/jcr_root/content/a/_rep_policy.xml',
  ]) write(root, rel, xml);
  assert.strictEqual(runAclScan(root, { migrationPaths: ['/content/a'] }).rawFindings.length, 1);
});

test('acl: runAclScan retains ACL files with undecodable FileVault paths as unresolved', () => {
  const root = mkworkspace();
  write(root, 'jcr_root/content/bad%E0%A4/_rep_policy.xml',
    aclPolicyXml('<allow jcr:primaryType="rep:GrantACE" rep:principalName="example-editors" rep:privileges="{Name}[jcr:read]"/>'));
  const result = runAclScan(root, { migrationPaths: ['/content/site'] });
  assert.strictEqual(result.rawFindings.length, 1);
  assert.strictEqual(result.rawFindings[0].policyPath, null);
  assert.strictEqual(result.rawFindings[0].relation, null);
  assert.strictEqual(result.rawFindings[0].status, 'unknown');
  assert.strictEqual(result.rawFindings[0].kind, 'acl-unknown');
  assert.match(result.rawFindings[0].reason, /path unresolved/);
  assert.match(result.findings[0].detail, /path unresolved/);
});

test('acl: inline-policy scoping decodes each FileVault segment once', () => {
  const root = mkworkspace();
  const ace = '<allow jcr:primaryType="rep:GrantACE" rep:principalName="example-editors" rep:privileges="{Name}[jcr:read]"/>';
  write(root, 'jcr_root/content/__site/.content.xml',
    `<jcr:root><__x><rep:policy jcr:primaryType="rep:ACL">${ace}</rep:policy></__x></jcr:root>`);
  const scanned = runAclScan(root, { migrationPaths: ['/content/_site/_x/child'] });
  assert.strictEqual(scanned.rawFindings.length, 1);
  assert.strictEqual(scanned.rawFindings[0].policyPath, '/content/_site/_x');
  assert.strictEqual(scanned.rawFindings[0].relation, 'ancestor');
  assert.strictEqual(scanned.rawFindings[0].status, 'parsed');
  assert.strictEqual(scanned.rawFindings[0].reason, null);
});

test('acl: RepoInit script index precedes script-relative line in source order', () => {
  const root = mkworkspace();
  write(root, 'config/org.apache.sling.jcr.repoinit.RepositoryInitializer~ordered.cfg.json', JSON.stringify({
    scripts: [
      '# leading line\n\n# offset\nset ACL for example-editors\n  allow jcr:read on /content/site\n  deny jcr:write on /content/site\nend',
      'set ACL for example-guests\n  allow jcr:read on /content/site\nend',
    ],
  }));
  const scanned = runAclScan(root, { migrationPaths: ['/content/site'] });
  assert.deepStrictEqual(scanned.rawFindings.map(entry => [entry.scriptIndex, entry.line, entry.effect]), [
    [0, 5, 'allow'], [0, 6, 'deny'], [1, 2, 'allow'],
  ]);
  assert.match(scanned.findings[0].location, /\(scripts\[0\]:5\)$/);
});

test('acl: malformed XML entries retain the declared unknown ACE shape', () => {
  const root = mkworkspace();
  write(root, 'jcr_root/content/site/_rep_policy.xml', '<jcr:root><broken>');
  const scanned = runAclScan(root, { migrationPaths: ['/content/site'] });
  const entry = scanned.rawFindings[0];
  assert.strictEqual(entry.status, 'unknown');
  assert.strictEqual(entry.effect, null);
  assert.deepStrictEqual(entry.principals, []);
  assert.deepStrictEqual(entry.privileges, []);
  assert.deepStrictEqual(entry.restrictions, {});
  assert.strictEqual(entry.runmode, null);
  assert.ok(entry.reason);
});

test('acl: runAclScan partial read is incomplete but keeps parsed entries', t => {
  if (process.getuid && process.getuid() === 0) {
    t.skip('chmod does not make files unreadable to root');
    return;
  }
  const root = mkworkspace();
  const first = write(root, 'jcr_root/content/a/_rep_policy.xml',
    aclPolicyXml('<allow jcr:primaryType="rep:GrantACE" rep:principalName="example-editors" rep:privileges="{Name}[jcr:read]"/>'));
  const second = write(root, 'jcr_root/content/b/_rep_policy.xml',
    aclPolicyXml('<allow jcr:primaryType="rep:GrantACE" rep:principalName="example-editors" rep:privileges="{Name}[jcr:read]"/>'));
  fs.chmodSync(second, 0o000);
  try {
    const result = runAclScan(root, { migrationPaths: ['/content'] });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.scanStatus, 'incomplete');
    assert.strictEqual(result.unreadable.length, 1);
    assert.strictEqual(result.rawFindings.length, 2);
    const parsed = result.rawFindings.find(entry => entry.file === path.relative(root, first));
    const unreadable = result.rawFindings.find(entry => entry.file === path.relative(root, second));
    assert.strictEqual(parsed.status, 'parsed');
    assert.strictEqual(unreadable.kind, 'acl-unknown');
    assert.strictEqual(unreadable.status, 'unknown');
    assert.match(unreadable.reason, /unreadable/i);
    assert.ok(result.warnings.includes(`ACL scan incomplete: 1 path(s) could not be read: ${path.relative(root, second)}`));
  } finally {
    fs.chmodSync(second, 0o644);
    assert.ok(fs.existsSync(first));
  }
});

test('acl: unreadable RepoInit references have per-file unknown entries', t => {
  if (process.getuid && process.getuid() === 0) {
    t.skip('chmod does not make files unreadable to root');
    return;
  }
  const root = mkworkspace();
  const reference = write(root, 'repoinit/acl.txt', 'set ACL for example-editors\n  allow jcr:read on /content/site\nend');
  write(root, 'config/org.apache.sling.jcr.repoinit.RepositoryInitializer~reference.cfg.json',
    JSON.stringify({ references: ['file:repoinit/acl.txt'] }));
  fs.chmodSync(reference, 0o000);
  try {
    const scanned = runAclScan(root, { migrationPaths: ['/content/site'] });
    assert.strictEqual(scanned.scanStatus, 'incomplete');
    assert.deepStrictEqual(scanned.unreadable, ['repoinit/acl.txt']);
    assert.strictEqual(scanned.rawFindings.length, 1);
    assert.strictEqual(scanned.rawFindings[0].file, 'repoinit/acl.txt');
    assert.strictEqual(scanned.rawFindings[0].kind, 'acl-unknown');
    assert.strictEqual(scanned.rawFindings[0].status, 'unknown');
    assert.match(scanned.rawFindings[0].reason, /unreadable/i);
  } finally {
    fs.chmodSync(reference, 0o644);
  }
});

test('acl: unreadable directory warnings identify paths rather than only files', t => {
  if (process.getuid && process.getuid() === 0) {
    t.skip('chmod does not make directories unreadable to root');
    return;
  }
  const root = mkworkspace();
  const relative = 'jcr_root/content/private';
  write(root, `${relative}/_rep_policy.xml`, aclPolicyXml(''));
  const directory = path.join(root, relative);
  fs.chmodSync(directory, 0o000);
  try {
    const scanned = runAclScan(root, { migrationPaths: ['/content/site'] });
    assert.strictEqual(scanned.scanStatus, 'incomplete');
    assert.deepStrictEqual(scanned.unreadable, [relative]);
    assert.ok(scanned.warnings.includes(`ACL scan incomplete: 1 path(s) could not be read: ${relative}`));
  } finally {
    fs.chmodSync(directory, 0o755);
  }
});

test('acl: runAclScan with missing root returns ok false', () => {
  const result = runAclScan(`/nonexistent-${Date.now()}`);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.scanStatus, 'incomplete');
  assert.ok(result.error);
});

test('acl: direct scans without a workspace do not broaden to the current directory', () => {
  const previous = process.cwd();
  const root = mkworkspace();
  process.chdir(root);
  try {
    for (const workspaceRoot of [undefined, null, '']) {
      const scanned = runAclScan(workspaceRoot);
      assert.strictEqual(scanned.ok, false);
      assert.strictEqual(scanned.scanStatus, 'incomplete');
      assert.match(scanned.error, /workspace.*required/i);
    }
  } finally {
    process.chdir(previous);
  }
});

test('acl: aclPermissions meta is review-only, always rendered, heuristic', () => {
  const meta = PATTERN_META.aclPermissions;
  assert.strictEqual(meta.strategy, 'acl-scan');
  assert.deepStrictEqual(meta.bpaSlugs, []);
  assert.strictEqual(meta.heuristic, true);
  assert.strictEqual(meta.alwaysRender, true);
  assert.strictEqual(meta.severity, 'high');
  assert.strictEqual(meta.checklist.length, 8);
  assert.strictEqual(sourceLabel('acl-scan'), 'ACL scan');
  assert.match(meta.description, /not proof of effective access/);
  assert.match(meta.description, /Review-only: nothing is changed\./);
});

test('acl: gatherFindings runs the ACL scan with migrationPaths', async () => {
  const root = mkworkspace();
  const contentRoot = writeContentPackage(root, 'ui.apps', {
    filters: [{ root: '/conf/acme/other' }],
  });
  write(root, path.relative(root, path.join(contentRoot, 'jcr_root/conf/acme/lists/x/_rep_policy.xml')),
    aclPolicyXml('<allow jcr:primaryType="rep:GrantACE" rep:principalName="example-editors" rep:privileges="{Name}[jcr:read]"/>'));
  const migrationPaths = ['/conf/acme/lists/x'];

  const gathered = await gatherFindings({ workspaceRoot: root, migrationPaths });

  assert.strictEqual(gathered.sourceByPattern.aclPermissions, 'acl-scan');
  assert.strictEqual(gathered.findingsByPattern.aclPermissions.length, 1);
  assert.strictEqual(gathered.scanStatusByPattern.aclPermissions, 'complete');
  assert.ok(!gathered.needsLlmScan.includes('aclPermissions'));
  assert.deepStrictEqual(gathered.migrationPaths, migrationPaths);
});

test('acl: gatherFindings rejects invalid migrationPaths before scanning', async () => {
  const root = mkworkspace();
  let scanCalled = false;
  await assert.rejects(
    gatherFindings({
      workspaceRoot: root,
      migrationPaths: ['content/x'],
      aclScan: () => { scanCalled = true; },
    }),
    TypeError
  );
  assert.strictEqual(scanCalled, false);
});

test('acl: zero findings still render section and checklist, never clean', async () => {
  const root = mkworkspace();
  const gathered = await gatherFindings({ workspaceRoot: root, migrationPaths: ['/content/site'] });
  const markdown = renderRunbook(gathered, { workspaceRoot: root, generatedAt: 'now' });

  assert.match(markdown, /## ACLs \/ Permissions for Migrated Content \(`aclPermissions`\)/);
  assert.match(markdown, /No ACL definitions found in code for the scoped paths\. This does not mean the source repository has no ACLs\./);
  assert.match(markdown, /### Customer checklist/);
  const checklist = markdown.slice(markdown.indexOf('### Customer checklist'));
  assert.strictEqual((checklist.match(/^- \[ \] /gm) || []).length, 8);
  assert.match(markdown, /\| ACLs \/ Permissions for Migrated Content \| high \| — \(verify in JCR\) \| ACL scan \|/);
  const cleanBlock = markdown.split('## Scanned — no findings')[1] || '';
  assert.doesNotMatch(cleanBlock, /aclPermissions/);
});

test('acl: scanner failure is incomplete and stays incomplete after LLM merge', async () => {
  const root = mkworkspace();
  const gathered = await gatherFindings({
    workspaceRoot: root,
    migrationPaths: ['/content/site'],
    aclScan: () => ({
      ok: false,
      error: 'boom',
      findings: [],
      rawFindings: [],
      warnings: [],
      scanStatus: 'incomplete',
      unreadable: [],
    }),
  });
  assert.ok(gathered.needsLlmScan.includes('aclPermissions'));
  assert.strictEqual(gathered.scanStatusByPattern.aclPermissions, 'incomplete');
  assert.ok(gathered.analyzerWarnings.includes('aclPermissions scan did not run: boom'));

  const failedScanMarkdown = renderRunbook(gathered, { workspaceRoot: root, generatedAt: 'now' });
  assert.match(failedScanMarkdown, /No ACL findings are available because the scan was incomplete\./);
  assert.doesNotMatch(failedScanMarkdown, /No ACL definitions found in code for the scoped paths\./);

  mergeLlmFindings(gathered, {
    aclPermissions: [{ file: 'a.xml', line: 3, detail: 'x' }],
  });

  assert.strictEqual(gathered.scanStatusByPattern.aclPermissions, 'incomplete');
  assert.ok(!gathered.needsLlmScan.includes('aclPermissions'));
  const markdown = renderRunbook(gathered, { workspaceRoot: root, generatedAt: 'now' });
  assert.match(markdown, /\| ACLs \/ Permissions for Migrated Content \| high \| \*\*1\*\* \| LLM scan — \*\*incomplete — verify in JCR\*\* \|/);
  assert.match(markdown, /> ⚠️ \*\*ACL scan incomplete — verify in JCR\.\*\* Treat the ACL review as not done\./);
});

test('acl: partial ACL scan keeps findings, is incomplete, and LLM findings are appended', async () => {
  const root = mkworkspace();
  const gathered = await gatherFindings({
    workspaceRoot: root,
    migrationPaths: ['/content/site'],
    aclScan: () => ({
      ok: true,
      findings: [{ location: 'policy.xml', detail: 'source ACE', severity: 'high' }],
      rawFindings: [{ pattern: 'aclPermissions', file: 'policy.xml', restrictions: [] }],
      warnings: [],
      scanStatus: 'incomplete',
      unreadable: ['policy.xml'],
    }),
  });
  assert.strictEqual(gathered.findingsByPattern.aclPermissions.length, 1);
  assert.ok(gathered.needsLlmScan.includes('aclPermissions'));

  mergeLlmFindings(gathered, {
    aclPermissions: [{ file: 'a.xml', line: 3, detail: 'LLM ACE' }],
  });

  assert.strictEqual(gathered.findingsByPattern.aclPermissions.length, 2);
  assert.strictEqual(gathered.sourceByPattern.aclPermissions, 'acl-scan+llm');
  assert.strictEqual(gathered.scanStatusByPattern.aclPermissions, 'incomplete');
});

test('acl: scanner exceptions still generate an incomplete review and cache after empty LLM merge', async () => {
  for (const aclScan of [
    () => { throw new Error('synthetic scanner failure'); },
    async () => { throw new Error('synthetic scanner failure'); },
  ]) {
    const root = mkworkspace();
    const out = path.join(root, 'runbook.md');
    const cachePath = path.join(root, 'runbook.json');
    const result = await generateRunbook({
      workspaceRoot: root, migrationPaths: ['/content/site'], outputPath: out, cachePath,
      aclScan, llmByPattern: { aclPermissions: [] },
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.gathered.scanStatusByPattern.aclPermissions, 'incomplete');
    assert.ok(result.gathered.analyzerWarnings.includes('aclPermissions scan did not run: synthetic scanner failure'));
    const markdown = fs.readFileSync(out, 'utf8');
    assert.match(markdown, /ACL scan incomplete — verify in JCR/);
    assert.doesNotMatch(markdown, /No ACL definitions found in code/);
    assert.strictEqual(JSON.parse(fs.readFileSync(cachePath, 'utf8')).scanStatusByPattern.aclPermissions, 'incomplete');
  }
});

test('acl: missing workspace roots remain incomplete before and after LLM merge', async () => {
  const previous = process.cwd();
  const root = mkworkspace();
  process.chdir(root);
  try {
    for (const options of [{}, { workspaceRoot: undefined }, { workspaceRoot: null }, { workspaceRoot: '' }]) {
      const gathered = await gatherFindings({ ...options, migrationPaths: ['/content/site'] });
      assert.strictEqual(gathered.scanStatusByPattern.aclPermissions, 'incomplete');
      assert.ok(gathered.needsLlmScan.includes('aclPermissions'));
      assert.ok(gathered.analyzerWarnings.some(warning => /aclPermissions.*workspaceRoot.*required/.test(warning)));
      mergeLlmFindings(gathered, { aclPermissions: [] });
      assert.strictEqual(gathered.scanStatusByPattern.aclPermissions, 'incomplete');
      const markdown = renderRunbook(gathered, { workspaceRoot: options.workspaceRoot, generatedAt: 'now' });
      assert.match(markdown, /ACL scan incomplete — verify in JCR/);
      assert.doesNotMatch(markdown, /No ACL definitions found in code/);
    }
  } finally {
    process.chdir(previous);
  }
});

test('acl: complete scans retain parsed and malformed-input findings through empty LLM merge', async () => {
  const root = mkworkspace();
  write(root, 'jcr_root/content/site/_rep_policy.xml',
    aclPolicyXml('<allow jcr:primaryType="rep:GrantACE" rep:principalName="example-editors" rep:privileges="{Name}[jcr:read]"/>'));
  write(root, 'jcr_root/content/site/bad/_rep_policy.xml', '<jcr:root><broken>');
  write(root, 'config/org.apache.sling.jcr.repoinit.RepositoryInitializer~bad.cfg.json', '{"scripts":');
  const out = path.join(root, 'runbook.md');
  const cachePath = path.join(root, 'runbook.json');
  const result = await generateRunbook({
    workspaceRoot: root, migrationPaths: ['/content/site'], outputPath: out, cachePath,
    llmByPattern: { aclPermissions: [] },
  });
  assert.strictEqual(result.gathered.scanStatusByPattern.aclPermissions, 'complete');
  assert.strictEqual(result.patternCounts.aclPermissions, 3);
  const markdown = fs.readFileSync(out, 'utf8');
  assert.strictEqual((markdown.match(/UNKNOWN —/g) || []).length, 2);
  assert.doesNotMatch(markdown, /No ACL definitions found in code/);
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')).findingsByPattern.aclPermissions;
  assert.strictEqual(cached.filter(entry => entry.status === 'unknown').length, 2);
  assert.strictEqual(cached.filter(entry => entry.status === 'parsed').length, 1);
  assert.ok(cached.every(entry => entry.reason === null || typeof entry.reason === 'string'));

  mergeLlmFindings(result.gathered, { aclPermissions: [{ file: 'extra.xml', line: 1, detail: 'additional review' }] });
  assert.strictEqual(result.gathered.findingsByPattern.aclPermissions.length, 4);
  assert.strictEqual(result.gathered.rawFindingsByPattern.aclPermissions.filter(entry => entry.status === 'unknown').length, 2);
});

test('acl: cache includes migrationPaths, scanStatus and full ACE fields', async () => {
  const root = mkworkspace();
  const contentRoot = writeContentPackage(root, 'ui.apps', {
    filters: [{ root: '/content/site' }],
    acHandling: 'merge',
  });
  write(root, path.relative(root, path.join(contentRoot, 'jcr_root/content/site/_rep_policy.xml')),
    aclPolicyXml('<allow jcr:primaryType="rep:GrantACE" rep:principalName="example-editors" rep:privileges="{Name}[jcr:read]" rep:glob="*/jcr:content*"/>'));
  const migrationPaths = ['/content/site'];
  const out = path.join(root, 'runbook.md');
  const cachePath = path.join(root, 'runbook.json');

  await generateRunbook({ workspaceRoot: root, migrationPaths, outputPath: out, cachePath });

  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.deepStrictEqual(cache.migrationPaths, migrationPaths);
  assert.strictEqual(cache.scanStatusByPattern.aclPermissions, 'complete');
  assert.ok(Object.prototype.hasOwnProperty.call(cache.findingsByPattern.aclPermissions[0], 'restrictions'));
  assert.ok(Object.prototype.hasOwnProperty.call(cache.findingsByPattern.aclPermissions[0], 'importVerdict'));
  assert.strictEqual(cache.findingsByPattern.aclPermissions[0].confidence, 'heuristic');
});
