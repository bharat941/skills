'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runAcsCommonsScan, featureOf } = require('./acs-commons-scan-runner.js');
const { gatherFindings, renderRunbook, PATTERN_META, CANONICAL_PATTERNS } = require('./runbook-generator.js');

function mkworkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acs-scan-test-'));
}
function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

const POM = [
  '<project>',
  '  <properties><acs.version>5.3.4</acs.version></properties>',
  '  <dependencies>',
  '    <dependency>',
  '      <groupId>com.adobe.acs</groupId>',
  '      <artifactId>acs-aem-commons-all</artifactId>',
  '      <version>${acs.version}</version>',
  '      <type>zip</type>',
  '    </dependency>',
  '  </dependencies>',
  '</project>',
].join('\n');

function acsProject() {
  const root = mkworkspace();
  write(root, 'pom.xml', POM);
  write(root, 'core/src/main/java/com/acme/A.java', 'package com.acme;\nimport com.adobe.acs.commons.genericlists.GenericList;\nclass A {}\n');
  write(root, 'core/src/main/java/com/acme/B.java', 'package com.acme;\nimport com.adobe.acs.commons.genericlists.GenericList;\nimport com.adobe.acs.commons.util.ParameterUtil;\nclass B {}\n');
  write(root, 'ui.config/src/main/content/jcr_root/apps/acme/osgiconfig/config/com.adobe.acs.commons.users.impl.EnsureServiceUser~acme.cfg.json', '{ "principalName": "acme-service" }\n');
  const rows = [1, 2, 3].map((i) => `<rule${i} jcr:primaryType="nt:unstructured" sling:resourceType="acs-commons/components/utilities/manage-redirects/redirect-row" source="/old${i}" target="/new${i}"/>`).join('\n');
  write(root, 'ui.content/src/main/content/jcr_root/conf/acme/settings/redirects/.content.xml', `<jcr:root>\n${rows}\n</jcr:root>\n`);
  write(root, 'core/target/classes/Skip.java', 'import com.adobe.acs.commons.mcp.ProcessDefinition;\n');
  write(root, 'node_modules/x/Skip.java', 'import com.adobe.acs.commons.mcp.ProcessDefinition;\n');
  return root;
}

test('acsCommons is a report-only, heuristic content-scan pattern with no BPA tier', () => {
  assert.ok(CANONICAL_PATTERNS.includes('acsCommons'));
  const meta = PATTERN_META.acsCommons;
  assert.strictEqual(meta.strategy, 'content-scan');
  assert.deepStrictEqual(meta.bpaSlugs, []);
  assert.ok(meta.heuristic);
  assert.ok(meta.reportOnly);
  assert.match(meta.description, /customer-owned/i);
});

test('runAcsCommonsScan reports the dependency version, resolving a ${property}', () => {
  const res = runAcsCommonsScan(acsProject());
  assert.ok(res.ok);
  const dep = res.rawFindings.find((f) => f.kind === 'dependency');
  assert.strictEqual(dep.version, '5.3.4');
  assert.strictEqual(dep.artifactId, 'acs-aem-commons-all');
  assert.match(dep.snippet, /acs-aem-commons-all 5\.3\.4/);
  assert.match(res.findings.find((f) => /acs-aem-commons-all/.test(f.detail)).detail, /no `cloud` classifier/);
  assert.match(res.findings.find((f) => /acs-aem-commons-all/.test(f.detail)).location, /pom\.xml:6$/);
});

test('runAcsCommonsScan groups Java imports by feature and counts files', () => {
  const res = runAcsCommonsScan(acsProject());
  const lists = res.rawFindings.find((f) => f.kind === 'java' && f.feature === 'genericlists');
  assert.strictEqual(lists.count, 2);
  assert.match(res.findings.find((f) => /Generic Lists/.test(f.detail)).detail, /2 Java file\(s\)/);
  assert.ok(res.rawFindings.some((f) => f.kind === 'java' && f.feature === 'util'));
  assert.ok(!res.rawFindings.some((f) => f.feature === 'mcp'), 'target/ and node_modules/ are skipped');
});

test('runAcsCommonsScan finds ACS OSGi configs and names the feature', () => {
  const res = runAcsCommonsScan(acsProject());
  const cfg = res.rawFindings.find((f) => f.kind === 'osgi-config');
  assert.strictEqual(cfg.feature, 'users');
  assert.match(res.findings.find((f) => /Ensure Service User/.test(f.detail)).detail, /repoinit/);
});

test('runAcsCommonsScan counts redirect rules in content', () => {
  const res = runAcsCommonsScan(acsProject());
  const redirects = res.rawFindings.find((f) => f.kind === 'content' && f.feature === 'redirects');
  assert.strictEqual(redirects.count, 3);
  assert.match(res.findings.find((f) => /Redirect Manager/.test(f.detail)).detail, /3 redirect rule\(s\)/);
});

test('runAcsCommonsScan on a project without ACS Commons is clean', () => {
  const root = mkworkspace();
  write(root, 'pom.xml', '<project><dependencies><dependency><groupId>org.apache.sling</groupId><artifactId>x</artifactId><version>1</version></dependency></dependencies></project>');
  write(root, 'core/src/main/java/com/acme/A.java', 'import org.apache.sling.api.SlingHttpServletRequest;\n');
  const res = runAcsCommonsScan(root);
  assert.deepStrictEqual([res.ok, res.findings.length], [true, 0]);
});

test('featureOf maps packages and PIDs to readable features', () => {
  assert.deepStrictEqual(featureOf('com.adobe.acs.commons.redirects.models.RedirectRule'), { key: 'redirects', label: 'Redirect Manager' });
  assert.strictEqual(featureOf('com.adobe.acs.commons.oak.impl.EnsureOakIndex~acme').label, 'Ensure Oak Index');
  assert.strictEqual(featureOf('com.adobe.acs.commons.somethingnew.Foo').label, 'somethingnew');
});

test('gatherFindings runs the ACS scan and the runbook marks it report-only and customer-owned', async () => {
  const root = acsProject();
  const gathered = await gatherFindings({ workspaceRoot: root, getEffectivePom: () => ({ ok: false, error: 'stub' }) });
  assert.strictEqual(gathered.sourceByPattern.acsCommons, 'content-scan');
  const md = renderRunbook(gathered, { workspaceRoot: root, generatedAt: 'now' });
  const section = md.split('## ACS AEM Commons')[1].split('\n## ')[0];
  assert.match(section, /Report only/);
  assert.match(section, /never upgrades/i);
  assert.match(section, /references\/third-party\/acs-commons\.md/);
  assert.match(section, /acs-aem-commons-all 5\.3\.4/);
  assert.doesNotMatch(section, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'paths are workspace-relative');
});

test('cli: node acs-commons-scan-runner.js <root> prints workspace-relative findings as JSON; no root is exit 2', () => {
  const { spawnSync } = require('child_process');
  const root = acsProject();
  const r = spawnSync(process.execPath, [path.join(__dirname, 'acs-commons-scan-runner.js'), root], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.findings.length >= 4);
  assert.ok(out.findings.every((f) => !f.location.startsWith(root)), 'locations are relative to the workspace');
  assert.strictEqual(spawnSync(process.execPath, [path.join(__dirname, 'acs-commons-scan-runner.js')], { encoding: 'utf8' }).status, 2);
});
