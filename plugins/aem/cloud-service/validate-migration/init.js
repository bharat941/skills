#!/usr/bin/env node
'use strict';

/**
 * validate-migration init — readiness check. Does NOT boot the SDK.
 *
 * Confirms the developer's environment is ready to run validate-migration check:
 *   • RV_SDK_URL  (default http://localhost:4502) is reachable
 *   • the AEM Quickstart MCP content package is installed
 *     (POST /bin/mcp answers, and `diagnose-osgi-bundle` is in tools/list)
 *   • `mvn` and `unzip` are on PATH
 *
 * The SDK itself is a developer responsibility (start it however you already
 * do — `java -jar aem-sdk-quickstart-*.jar` or your usual workflow). validate-migration never
 * spawns Java, never writes (removed - no on-disk config), never stores credentials.
 *
 * Config, all optional:
 *   RV_SDK_URL       SDK base URL (default http://localhost:4502)
 *   RV_SDK_USER      admin (default 'admin')
 *   RV_SDK_PASS      admin password (default 'admin')
 *   --sdk <url> / --user / --password  — CLI overrides
 */

if (typeof fetch !== 'function') {
  console.error('[validate-migration] Node 18+ required (needs global fetch).');
  process.exit(2);
}

const { execFileSync } = require('child_process');
const mcp = require('./mcp-client.js');

const MCP_INSTALL_DOC = 'https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/ai-in-aem/local-development-with-ai-tools#aem-quickstart-mcp-server';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].replace(/^--/, '');
    out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

function hasCommand(cmd) {
  try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

async function isReachable(url) {
  try {
    const res = await fetch(`${url}/system/console`, { redirect: 'manual' });
    return res.status < 500;
  } catch { return false; }
}

function fatal(msg) { console.error(msg); process.exit(1); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sdkUrl = (args.sdk || process.env.RV_SDK_URL || 'http://localhost:4502').replace(/\/$/, '');
  const user = args.user || process.env.RV_SDK_USER || 'admin';
  const password = args.password || process.env.RV_SDK_PASS || 'admin';
  const auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');

  console.log(`[validate-migration] SDK URL:  ${sdkUrl}`);

  const checks = [
    { name: 'mvn on PATH', ok: hasCommand('mvn'), hint: 'install Maven 3.8+' },
    { name: 'unzip on PATH', ok: hasCommand('unzip'), hint: 'install unzip' },
  ];

  const sdkUp = await isReachable(sdkUrl);
  checks.push({ name: `SDK reachable (${sdkUrl})`, ok: sdkUp, hint: 'start your local Cloud SDK before running validate-migration check' });

  let mcpAvailable = false;
  if (sdkUp) {
    try {
      const sessionId = await mcp.initSession(sdkUrl, auth);
      const tools = await mcp.listTools(sdkUrl, auth, sessionId);
      mcpAvailable = mcp.findBundleDiagnosticTool(tools) != null;
    } catch { mcpAvailable = false; }
  }
  checks.push({ name: 'AEM Quickstart MCP content package', ok: mcpAvailable, hint: `install via Package Manager (/crx/packmgr): ${MCP_INSTALL_DOC}` });

  for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : `  — ${c.hint}`}`);

  const missing = checks.filter((c) => !c.ok);
  if (missing.length) fatal(`\n[validate-migration] ${missing.length} check(s) failed. Fix the above and retry.`);
  console.log(`\n[validate-migration] ready. Run validate-migration check from your project (auto-diff mode) or validate-migration check <pattern>.`);
}

main().catch((e) => fatal(`[validate-migration] ${e.stack || e.message}`));

