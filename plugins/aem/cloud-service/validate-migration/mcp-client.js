'use strict';

/**
 * mcp-client.js — minimal MCP (Model Context Protocol) client for the AEM
 * Quickstart MCP server. This is a content package the customer installs
 * once into their running local Quickstart via Package Manager (see
 * "Local Development with AI Tools" > AEM Quickstart MCP Server); validate-migration does
 * not install or manage it. Once installed it exposes a JSON-RPC 2.0
 * "Streamable HTTP" endpoint at `POST {sdkUrl}/bin/mcp` — no MCP SDK
 * dependency needed, just `fetch`.
 *
 * Documented tool catalog: `aem-logs`, `diagnose-osgi-bundle`,
 * `recent-requests`. validate-migration only uses `diagnose-osgi-bundle` today — a free-text
 * report keyed by `bundleSymbolicName` (no structured JSON, no
 * manifest-header or DS-property introspection, and no install/deploy tool).
 */

async function rpc(sdkUrl, auth, method, params, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (auth) headers.Authorization = auth;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: params || {} });

  const res = await fetch(`${sdkUrl.replace(/\/$/, '')}/bin/mcp`, { method: 'POST', headers, body });
  const newSessionId = res.headers.get('Mcp-Session-Id') || sessionId || null;
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP ${method} -> HTTP ${res.status}: ${text.slice(0, 300)}`);

  const json = parseResponse(text, res.headers.get('content-type') || '');
  if (json && json.error) throw new Error(`MCP ${method} failed: ${json.error.message || JSON.stringify(json.error)}`);
  return { result: json && json.result, sessionId: newSessionId };
}

// Streamable HTTP may reply with a single JSON object or an SSE stream of
// `data: {...}` events — handle both, taking the last event in the stream.
function parseResponse(text, contentType) {
  if (!text) return null;
  if (contentType.includes('text/event-stream')) {
    const events = text.split('\n').filter((l) => l.startsWith('data:'));
    const last = events[events.length - 1];
    return last ? JSON.parse(last.slice(5).trim()) : null;
  }
  return JSON.parse(text);
}

async function initSession(sdkUrl, auth) {
  const { sessionId } = await rpc(sdkUrl, auth, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'validate-migration-check', version: '1.0' },
  });
  return sessionId;
}

async function listTools(sdkUrl, auth, sessionId) {
  const { result } = await rpc(sdkUrl, auth, 'tools/list', {}, sessionId);
  return (result && result.tools) || [];
}

async function callTool(sdkUrl, auth, sessionId, name, args) {
  const { result } = await rpc(sdkUrl, auth, 'tools/call', { name, arguments: args || {} }, sessionId);
  if (!result || !Array.isArray(result.content)) return '';
  return result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

// "diagnose-osgi-bundle" per the documented tool catalog (adobe/cq-quickstart-mcp-server,
// see Local Development with AI Tools > AEM Quickstart MCP Server > Available Tools).
// Falls back to schema-sniffing in case a future release renames it.
function findBundleDiagnosticTool(tools) {
  return tools.find((t) => t.name === 'diagnose-osgi-bundle')
    || tools.find((t) => t.inputSchema && t.inputSchema.properties && 'bundleSymbolicName' in t.inputSchema.properties)
    || null;
}

module.exports = { initSession, listTools, callTool, findBundleDiagnosticTool };
