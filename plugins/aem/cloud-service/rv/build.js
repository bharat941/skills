'use strict';

/**
 * build.js — wraps `mvn clean package -DskipTests` for an RV project.
 *
 * Input : { projectDir }
 * Output: { ok, artifactPath, log, elapsedMs }
 *
 * Uses whatever `java` / JAVA_HOME the customer has. Set RV_JAVA_HOME to pin
 * a specific JDK for RV builds without touching JAVA_HOME globally.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function build({ projectDir }) {
  const t0 = Date.now();
  if (!fs.existsSync(path.join(projectDir, 'pom.xml'))) {
    return { ok: false, log: `no pom.xml at ${projectDir}` };
  }
  const env = { ...process.env };
  if (process.env.RV_JAVA_HOME) env.JAVA_HOME = process.env.RV_JAVA_HOME;

  let log;
  try {
    // RV verifies runtime contract on the SDK, not customer test correctness.
    log = execFileSync('mvn', ['-q', '-B', '-DskipTests', 'clean', 'package'],
      { cwd: projectDir, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    return { ok: false, log: (e.stdout || '') + (e.stderr || e.message), elapsedMs: Date.now() - t0 };
  }

  const targetDir = path.join(projectDir, 'target');
  const jar = fs.readdirSync(targetDir).find(f => f.endsWith('.jar') && !f.endsWith('-sources.jar'));
  if (!jar) return { ok: false, log: 'no artifact under target/', elapsedMs: Date.now() - t0 };
  return { ok: true, artifactPath: path.join(targetDir, jar), log, elapsedMs: Date.now() - t0 };
}

module.exports = { build };

