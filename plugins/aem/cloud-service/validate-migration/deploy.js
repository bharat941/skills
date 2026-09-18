'use strict';

/**
 * deploy.js — install an OSGi bundle on a running AEM Cloud SDK.
 *
 * Preferred path: use the customer project's own `autoInstallBundle` (or
 * `autoInstallPackage`) Maven profile — the AEM archetype standard, which
 * binds `sling-maven-plugin:install` into the Maven install lifecycle. This
 * respects whatever the customer's build already does (bnd, embedding rules,
 * feature flags), needs zero pinned plugin versions, and works for both
 * bundles and content packages via a single flag.
 *
 * Fallback: if no profile is detected in the module or its pom ancestors,
 * we shell out to `sling-maven-plugin:install-file` directly against the
 * built artifact. Works for jar bundles even in projects without the
 * archetype convention.
 *
 * Bundle/component *state* is not asserted here; that's the runtime verify
 * step's job (it re-checks via the diagnose-osgi-bundle MCP tool).
 *
 * Input : { projectDir?, artifactPath, sdkUrl, user='admin', password='admin', timeoutMs=180000 }
 * Output: { ok, symbolicName, mode, elapsedMs, log }
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Fallback pin only — matches the version cq-quickstart-mcp-server builds with.
const SLING_MAVEN_PLUGIN = 'org.apache.sling:sling-maven-plugin:3.0.4';

function deploy({ projectDir, artifactPath, sdkUrl, user = 'admin', password = 'admin', timeoutMs = 180_000 } = {}) {
  const t0 = Date.now();
  if (!fs.existsSync(artifactPath)) return { ok: false, log: `artifact missing: ${artifactPath}` };
  const symbolicName = readBundleSymbolicName(artifactPath);
  if (!symbolicName) return { ok: false, log: 'could not read Bundle-SymbolicName from artifact' };

  const slingUrl = sdkUrl.replace(/\/$/, '') + '/system/console';
  const profile = projectDir ? detectAutoInstallProfile(projectDir) : null;
  let profileLog = '';

  if (profile) {
    // Customer's own profile — invoke `install` through the lifecycle. Package
    // step is skipped by Maven if target/ artifact is already up-to-date.
    const args = [
      '-q', '-B', '-DskipTests',
      '-P', profile,
      '-Dsling.url=' + slingUrl,
      '-Dsling.user=' + user,
      '-Dsling.password=' + password,
      'install',
    ];
    try {
      const log = execFileSync('mvn', args, { cwd: projectDir, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
      return { ok: true, symbolicName, mode: 'profile:' + profile, log, elapsedMs: Date.now() - t0 };
    } catch (e) {
      // Auto-fall-through to install-file so a project-specific quirk doesn't
      // block validate-migration (e.g. WKND legacy pins maven-sling-plugin:2.1.0 with a WebDAV
      // config that ignores our -Dsling.url override). Record the profile
      // attempt so the reviewer can see we tried.
      profileLog = '[deploy] profile:' + profile + ' failed, falling back to install-file:\n' + ((e.stdout || '') + (e.stderr || e.message)) + '\n---\n';
    }
  }

  // Fallback: no archetype profile in this module's pom hierarchy, or the
  // profile install failed. Use sling-maven-plugin standalone against the jar.
  const args = [
    '-q', '-B',
    SLING_MAVEN_PLUGIN + ':install-file',
    '-Dsling.file=' + artifactPath,
    '-Dsling.url=' + slingUrl,
    '-Dsling.user=' + user,
    '-Dsling.password=' + password,
  ];
  try {
    const log = execFileSync('mvn', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, symbolicName, mode: profile ? 'profile-fallback:install-file' : 'install-file', log: profileLog + log, elapsedMs: Date.now() - t0 };
  } catch (e) {
    const log = profileLog + (e.stdout || '') + (e.stderr || e.message);
    return { ok: false, symbolicName, mode: 'install-file', log, elapsedMs: Date.now() - t0 };
  }
}

// Walks up from projectDir looking for the AEM archetype's install profile in
// any pom.xml. Prefers `autoInstallBundle` for jar packaging and
// `autoInstallPackage` for content-package packaging. Returns null when
// neither is defined anywhere in the ancestor chain.
function detectAutoInstallProfile(projectDir) {
  const modulePkg = readPackagingType(path.join(projectDir, 'pom.xml'));
  const preferred = modulePkg === 'content-package' || modulePkg === 'zip' ? 'autoInstallPackage' : 'autoInstallBundle';
  let dir = projectDir;
  for (let i = 0; i < 6; i++) {
    const pom = path.join(dir, 'pom.xml');
    if (fs.existsSync(pom)) {
      const xml = fs.readFileSync(pom, 'utf8');
      if (new RegExp(`<id>\\s*${preferred}\\s*</id>`).test(xml)) return preferred;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readPackagingType(pomPath) {
  try {
    const xml = fs.readFileSync(pomPath, 'utf8');
    const m = xml.match(/<packaging>\s*([\w-]+)\s*<\/packaging>/);
    return m ? m[1] : 'jar';
  } catch { return 'jar'; }
}

// Reads Bundle-SymbolicName from the jar's MANIFEST.MF via `unzip -p`.
function readBundleSymbolicName(jarPath) {
  try {
    const mf = execFileSync('unzip', ['-p', jarPath, 'META-INF/MANIFEST.MF'], { encoding: 'utf8' });
    // MANIFEST folds long lines with "\r\n " continuations — unfold before matching
    const unfolded = mf.replace(/\r?\n /g, '');
    const m = unfolded.match(/^Bundle-SymbolicName:\s*(.+?)\s*$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

module.exports = { deploy };
