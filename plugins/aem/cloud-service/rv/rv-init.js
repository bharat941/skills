#!/usr/bin/env node
'use strict';

/**
 * rv init — spin up (or attach to) a local AEM Cloud Service SDK for RV.
 *
 * Usage:
 *   node rv-init.js [--sdk-home <path>] [--sdk <url>] [--port <n>]
 *
 * If --sdk points at a reachable instance, attaches without booting. Otherwise
 * requires --sdk-home (or RV_SDK_HOME env var) pointing at the SDK install that
 * contains aem-sdk-quickstart-*.jar (SDK boots in evaluation mode without a
 * license.properties).
 *
 * Writes .rv/setup.json on success so subsequent rv-check runs know where the
 * SDK is. Writes .rv/sdk.pid when it booted the SDK (so the caller can stop it).
 *
 * Phase 1 does SDK spin-up only. Probe deploy + bundle reinstall dance lives
 * in rv-check.
 */

if (typeof fetch !== 'function') {
  console.error('[rv-init] Node 18+ required (needs global fetch).');
  process.exit(2);
}

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const DEFAULT_PORT = 4602;
const COMMON_PORTS = [4502, 4602, 4503];
const BOOT_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 3_000;
const SETUP_DIR = path.join(process.env.HOME || process.cwd(), '.rv');
const SETUP_FILE = path.join(SETUP_DIR, 'setup.json');
const PID_FILE = path.join(SETUP_DIR, 'sdk.pid');
const LOG_DIR = path.join(SETUP_DIR, 'logs');

const HOME = process.env.HOME || '';
const SDK_HOME_CANDIDATES = [
  path.join(HOME, 'aem-sdk'),
  path.join(HOME, 'aem-cs-sdk'),
  path.join(HOME, 'Adobe', 'aem-sdk'),
  path.join(HOME, 'Downloads', 'aem-sdk'),
];

function fatal(msg) {
  console.error(`[rv-init] ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith('--') ? argv[++i] : true;
  }
  return out;
}

async function isReachable(url) {
  try {
    // Cheap "port answering" check — any < 500 means the process is up (even 401/302).
    const res = await fetch(`${url}/system/console`, { redirect: 'manual' });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function isOsgiReady(url, user, password) {
  try {
    const auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
    const res = await fetch(`${url}/system/console/bundles.json`, { headers: { Authorization: auth } });
    return res.status === 200;
  } catch {
    return false;
  }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

function checkJava() {
  let text = '';
  try {
    // java -version writes to stderr on exit 0 — capture both streams.
    const out = execFileSync('java', ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    text = String(out || '');
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, error: 'java not found on PATH' };
    text = String(e.stderr || e.stdout || '');
  }
  // Try again with stderr redirected to stdout, in case the first call swallowed it.
  if (!text) {
    try {
      text = execFileSync('sh', ['-c', 'java -version 2>&1'], { encoding: 'utf8' });
    } catch (e) {
      text = String(e.stdout || e.stderr || '');
    }
  }
  const m = text.match(/version "?(\d+)/);
  if (!m) return { ok: false, error: `could not parse java -version output: ${text.slice(0, 120)}` };
  const major = Number(m[1]);
  if (major < 11) return { ok: false, error: `Java ${major} detected — need >= 11` };
  return { ok: true, major };
}

function findQuickstart(sdkHome) {
  if (!sdkHome || !fs.existsSync(sdkHome)) return null;
  if (!fs.statSync(sdkHome).isDirectory()) return null;
  const jar = fs.readdirSync(sdkHome).find((f) => /^aem-sdk-quickstart-.*\.jar$/.test(f));
  return jar ? path.join(sdkHome, jar) : null;
}

function printDownloadHelp() {
  const url = 'https://experience.adobe.com/#/downloads/content/software-distribution/en/aemcloud.html';
  const lines = [
    '',
    '[rv-init] AEM SDK not found on this machine.',
    '',
    `  Download from: ${url}`,
    '',
    '  1. Sign in with your Adobe ID (needs AEM Cloud Service entitlement)',
    '  2. Download the AEM SDK zip → unzip to ~/aem-sdk/',
    '  3. Run: node rv-init.js',
    '',
  ];
  console.error(lines.join('\n'));
}

async function discoverRunningSdk() {
  for (const port of COMMON_PORTS) {
    const url = `http://localhost:${port}`;
    if (await isReachable(url)) return url;
  }
  return null;
}

function discoverSdkHome() {
  // Env var wins.
  const fromEnv = process.env.RV_SDK_HOME || process.env.AEM_SDK_HOME;
  if (fromEnv && findQuickstart(fromEnv)) return fromEnv;

  // Fixed candidate dirs.
  for (const cand of SDK_HOME_CANDIDATES) {
    if (findQuickstart(cand)) return cand;
  }

  // Glob-ish: any ~/Downloads/aem-sdk-* dir that contains a quickstart. Prefer the newest.
  const downloads = path.join(HOME, 'Downloads');
  if (fs.existsSync(downloads)) {
    const candidates = fs.readdirSync(downloads)
      .filter((name) => /^aem-sdk/i.test(name))
      .map((name) => path.join(downloads, name))
      .filter((p) => findQuickstart(p))
      .sort()
      .reverse();
    if (candidates[0]) return candidates[0];
  }
  return null;
}

async function waitForBoot(url, child, stderrPath) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let childExited = false;
  child.once('exit', () => { childExited = true; });
  while (Date.now() < deadline) {
    if (await isOsgiReady(url, 'admin', 'admin')) return { ok: true };
    if (childExited) {
      const tail = readTail(stderrPath, 8);
      return { ok: false, reason: 'child_exited', tail };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { ok: false, reason: 'timeout' };
}

function readTail(file, lines) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function writeSetup(data) {
  fs.mkdirSync(SETUP_DIR, { recursive: true });
  fs.writeFileSync(SETUP_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function prettyPath(p) {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port) || DEFAULT_PORT;
  const explicitSdk = args.sdk || null;
  let sdkHome = args['sdk-home'] || null;

  // 1. If an SDK is already running, attach.
  const targetUrl = (explicitSdk || `http://localhost:${port}`).replace(/\/$/, '');
  console.log(`[rv-init] checking ${targetUrl} …`);
  if (await isReachable(targetUrl)) {
    console.log(`[rv-init] SDK already up at ${targetUrl} — attaching`);
    writeSetup({ sdkUrl: targetUrl, sdkHome, user: 'admin', password: 'admin', mode: 'attached', initializedAt: new Date().toISOString() });
    console.log(`[rv-init] wrote ${prettyPath(SETUP_FILE)}`);
    console.log(`[rv-init] ready. Fix a pattern, then run rv-check <pattern> (e.g. rv-check scheduler).`);
    return;
  }

  // 2. No target reachable — try discovery on other common ports.
  if (!explicitSdk) {
    const running = await discoverRunningSdk();
    if (running) {
      console.log(`[rv-init] found running SDK at ${running} — attaching`);
      writeSetup({ sdkUrl: running, sdkHome, user: 'admin', password: 'admin', mode: 'attached', initializedAt: new Date().toISOString() });
      console.log(`[rv-init] wrote ${prettyPath(SETUP_FILE)}`);
      console.log(`[rv-init] ready. Fix a pattern, then run rv-check <pattern> (e.g. rv-check scheduler).`);
      return;
    }
  }

  // 3. No SDK running — need to boot. Discover sdk-home if not given.
  if (!sdkHome) sdkHome = discoverSdkHome();
  if (!sdkHome) {
    printDownloadHelp();
    process.exit(1);
  }
  console.log(`[rv-init] found SDK install at ${sdkHome}`);

  // 4. Preflight
  const java = checkJava();
  if (!java.ok) fatal(java.error);

  const jar = findQuickstart(sdkHome);
  if (!jar) fatal(`no aem-sdk-quickstart-*.jar found in ${sdkHome}`);

  if (!(await isPortFree(port))) {
    fatal(`port ${port} is busy but no AEM answered on it. Free the port, or pass --sdk to the existing service.`);
  }

  console.log(`[rv-init] preflight ok · Java ${java.major} · ${path.basename(jar)}`);

  // 5. Boot in background
  console.log(`[rv-init] booting SDK on port ${port} (this can take ~60s) …`);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const outLog = fs.openSync(path.join(LOG_DIR, 'sdk-stdout.log'), 'a');
  const errLog = fs.openSync(path.join(LOG_DIR, 'sdk-stderr.log'), 'a');
  const child = spawn('java', ['-jar', jar, '-p', String(port), '-nointeractive'], {
    cwd: sdkHome,
    detached: true,
    stdio: ['ignore', outLog, errLog],
  });
  fs.writeFileSync(PID_FILE, String(child.pid) + '\n', 'utf8');

  // 6. Wait for readiness (or child exit)
  const bootedUrl = `http://localhost:${port}`;
  const stderrPath = path.join(LOG_DIR, 'sdk-stderr.log');
  const boot = await waitForBoot(bootedUrl, child, stderrPath);
  if (!boot.ok) {
    if (boot.reason === 'child_exited') {
      const hint = /Java Specification 11/.test(boot.tail)
        ? '\n  This SDK build is too old — it requires Java 11 exactly. Download the latest AEM Cloud SDK\n  from https://experience.adobe.com/#/downloads (recent builds support Java 21).'
        : '';
      fatal(`SDK process exited before it was ready.${hint}\n\n--- ${path.relative(process.cwd(), stderrPath)} tail ---\n${boot.tail}`);
    }
    fatal(`SDK did not respond within ${BOOT_TIMEOUT_MS / 1000}s. Check ${path.relative(process.cwd(), LOG_DIR)}/sdk-stderr.log`);
  }

  writeSetup({
    sdkUrl: bootedUrl,
    sdkHome,
    user: 'admin',
    password: 'admin',
    mode: 'booted',
    pid: child.pid,
    initializedAt: new Date().toISOString(),
  });
  child.unref();
  console.log(`[rv-init] SDK up at ${bootedUrl} (pid ${child.pid})`);
  console.log(`[rv-init] wrote ${prettyPath(SETUP_FILE)}`);
  console.log(`[rv-init] ready. Fix a pattern, then run rv-check <pattern> (e.g. rv-check scheduler).`);
}

main().catch((e) => fatal(e.stack || e.message));
