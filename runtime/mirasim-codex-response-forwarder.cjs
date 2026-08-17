#!/usr/bin/env node
'use strict';

// Fixed Codex Responses forwarder for Mirasim.
// Chain:
//   sub2api/Codex -> 127.0.0.1:12017/v1/responses
//     -> current Mirasim model-bridge (/v1 router, or legacy /u router)
//     -> official Mirasim relay

const http = require('node:http');
const { execFile } = require('node:child_process');
const { Buffer } = require('node:buffer');

const LISTEN_HOST = process.env.MIRASIM_CODEX_FORWARD_HOST || process.env.HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.MIRASIM_CODEX_FORWARD_PORT || process.env.PORT || 12017);
const TARGET_BASE = (process.env.MIRASIM_CODEX_TARGET_BASE || 'http://127.0.0.1:12016/v1').replace(/\/+$/, '');
const TARGET_ENC = Buffer.from(TARGET_BASE).toString('base64').replace(/=+$/, '');
const RESOLVE_TIMEOUT_MS = Number(process.env.MIRASIM_BRIDGE_RESOLVE_TIMEOUT_MS || 8000);
const BRIDGE_WAIT_MS = Number(process.env.MIRASIM_CODEX_BRIDGE_WAIT_MS || 180000);
const REQUEST_TIMEOUT_MS = Number(process.env.MIRASIM_CODEX_FORWARD_REQUEST_TIMEOUT_MS || 0); // 0 = no timeout for SSE
const DEFAULT_EFFORT = process.env.MIRASIM_CODEX_DEFAULT_EFFORT || 'low';

const BRIDGE_API_KEY = (process.env.MIRASIM_BRIDGE_API_KEY || process.env.INBOUND_API_KEY || '').trim();
function timingSafeEqualString(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ab.length === bb.length && require('node:crypto').timingSafeEqual(ab, bb);
}
function extractPresentedApiKey(req) {
  const auth = String(req.headers.authorization || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return (m && m[1]) || req.headers['x-api-key'] || req.headers['api-key'] || '';
}
function requireBridgeAuth(req, res) {
  if (!BRIDGE_API_KEY) return true;
  const presented = extractPresentedApiKey(req);
  if (timingSafeEqualString(presented, BRIDGE_API_KEY)) return true;
  json(res, 401, { error: { message: 'invalid or missing bridge api key' } });
  return false;
}


let cachedBridge = null;
let resolving = null;

function log(...a) { console.error('[mirasim-codex-forwarder]', new Date().toISOString(), ...a); }
function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) });
  res.end(body);
}
function execOut(cmd, args, timeout = RESOLVE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}
function collect(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function normalizeContent(content, role) {
  const textType = role === 'assistant' ? 'output_text' : 'input_text';
  if (typeof content === 'string') return [{ type: textType, text: content }];
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (typeof part === 'string') return { type: textType, text: part };
    if (!part || typeof part !== 'object') return part;
    if (part.type === 'text' || (!part.type && typeof part.text === 'string')) return { ...part, type: textType };
    return part;
  });
}
function messageItem(role, content) {
  const normalizedRole = role === 'system' ? 'developer' : role;
  return { type: 'message', role: normalizedRole, content: normalizeContent(content, normalizedRole) };
}
function normalizeResponsesRequest(body) {
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); } catch { return { body, changed: false }; }
  if (!payload || typeof payload !== 'object') return { body, changed: false };

  const legacyItems = Array.isArray(payload.input) && payload.input.some(item => item?.role && !item?.type);
  const needsNormalization = typeof payload.instructions === 'string'
    || legacyItems
    || (payload.stream === true && typeof payload.input === 'string');
  if (!needsNormalization) return { body, changed: false };

  const input = [];
  if (typeof payload.instructions === 'string' && payload.instructions) {
    input.push(messageItem('developer', payload.instructions));
  }
  if (typeof payload.input === 'string') {
    input.push(messageItem('user', payload.input));
  } else if (Array.isArray(payload.input)) {
    for (const item of payload.input) {
      if (typeof item === 'string') input.push(messageItem('user', item));
      else if (item?.role && !item?.type) input.push({ ...item, ...messageItem(item.role, item.content) });
      else input.push(item);
    }
  }

  const normalized = { ...payload, input };
  delete normalized.instructions;
  if (normalized.store === undefined) normalized.store = false;
  if (normalized.parallel_tool_calls === undefined) normalized.parallel_tool_calls = false;
  if (normalized.tool_choice === undefined) normalized.tool_choice = 'auto';
  if (normalized.reasoning === undefined) normalized.reasoning = { effort: DEFAULT_EFFORT };
  if (normalized.text === undefined) normalized.text = { verbosity: 'low' };
  if (normalized.include === undefined) normalized.include = ['reasoning.encrypted_content'];
  return { body: Buffer.from(JSON.stringify(normalized)), changed: true };
}
function probeUniversalBridge(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: `/u/${TARGET_ENC}/responses`, timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 405);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}
function probeRouterBridge(port) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/v1/models', timeout: 2000 }, (res) => {
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 256 * 1024) chunks.push(Buffer.from(chunk));
      });
      res.on('end', () => {
        if (res.statusCode !== 200 || size > 256 * 1024) return resolve(false);
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(Array.isArray(body.data) && body.data.some(model => model?.owned_by === 'mirasim-router'));
        } catch {
          resolve(false);
        }
      });
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}
async function probeBridge(candidate) {
  const kinds = candidate.kind === 'unknown' ? ['router', 'universal'] : [candidate.kind];
  for (const kind of kinds) {
    const ok = kind === 'router'
      ? await probeRouterBridge(candidate.port)
      : await probeUniversalBridge(candidate.port);
    if (ok) {
      return {
        port: candidate.port,
        kind,
        responsePath: kind === 'router' ? '/v1/responses' : `/u/${TARGET_ENC}/responses`,
      };
    }
  }
  return null;
}
async function candidatePorts() {
  const out = new Map();
  const excluded = new Set([LISTEN_PORT]);
  try { excluded.add(Number(new URL(TARGET_BASE).port)); } catch {}
  for (const name of ['MIRASIM_UNIFIED_BRIDGE_PORT', 'MIRASIM_CLAUDE_FORWARD_PORT']) {
    const port = Number(process.env[name] || 0);
    if (port > 0) excluded.add(port);
  }
  const add = (port, kind = 'unknown') => {
    if (!(port > 0 && port < 65536) || excluded.has(port)) return;
    const current = out.get(port);
    if (!current || current.kind === 'unknown') out.set(port, { port, kind });
  };
  const forced = Number(process.env.MIRASIM_MODEL_BRIDGE_PORT || 0);
  add(forced);

  // Mirasim passes its random local router URL to `codex app-server` on the command line.
  const ps = await execOut('ps', ['-ef']);
  for (const m of ps.matchAll(/model_providers\.mirasim\.base_url=http:\/\/127\.0\.0\.1:(\d+)(\/[^\s]*)?/g)) {
    const basePath = m[2] || '';
    const kind = basePath.startsWith('/v1') ? 'router' : (basePath.startsWith('/u/') ? 'universal' : 'unknown');
    add(Number(m[1]), kind);
  }

  // Fallback scan: candidates are accepted only after a Mirasim-specific HTTP probe.
  const ss = await execOut('ss', ['-lntH']);
  for (const line of ss.split(/\n/)) {
    const m = line.match(/127\.0\.0\.1:(\d+)\b/);
    if (m) add(Number(m[1]));
  }
  return [...out.values()];
}
async function resolveBridge() {
  if (cachedBridge) {
    const current = await probeBridge(cachedBridge);
    if (current) return current;
  }
  if (resolving) return resolving;
  resolving = (async () => {
    for (const candidate of await candidatePorts()) {
      const bridge = await probeBridge(candidate);
      if (bridge) {
        if (!cachedBridge || bridge.port !== cachedBridge.port || bridge.kind !== cachedBridge.kind) {
          log(`model-bridge -> ${bridge.port} (${bridge.kind})`);
        }
        cachedBridge = bridge;
        return bridge;
      }
    }
    cachedBridge = null;
    return null;
  })().finally(() => { resolving = null; });
  return resolving;
}
async function waitForBridge() {
  let bridge = await resolveBridge();
  if (bridge || BRIDGE_WAIT_MS <= 0) return bridge;

  const deadline = Date.now() + BRIDGE_WAIT_MS;
  log(`waiting up to ${BRIDGE_WAIT_MS}ms for Mirasim model-bridge`);
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(500, deadline - Date.now())));
    bridge = await resolveBridge();
    if (bridge) return bridge;
  }
  return null;
}
function forwardHttp({ port, path, method, headers, body }, res) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    delete h.host; delete h.connection; delete h['content-length']; delete h['transfer-encoding'];
    delete h.authorization; delete h['x-api-key']; delete h['api-key'];
    if (body && body.length) h['content-length'] = String(body.length);
    const up = http.request({ host: '127.0.0.1', port, path, method, headers: h, timeout: REQUEST_TIMEOUT_MS }, (ur) => {
      res.writeHead(ur.statusCode || 502, ur.headers);
      ur.pipe(res);
      ur.on('end', resolve);
      ur.on('error', err => res.headersSent ? res.destroy(err) : reject(err));
    });
    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    up.on('error', err => res.headersSent ? res.destroy(err) : reject(err));
    res.on('close', () => { if (!up.destroyed) up.destroy(); });
    up.end(body && body.length ? body : undefined);
  });
}
async function proxyModels(req, res) {
  const u = new URL(req.url || '/', 'http://127.0.0.1');
  const suffix = u.pathname.replace(/^\/v1\/?/, '/'); // /v1/models -> /models
  const target = new URL(TARGET_BASE + suffix + (u.search || ''));
  const body = await collect(req);
  return new Promise((resolve, reject) => {
    const h = { ...req.headers };
    delete h.host; delete h.connection; delete h['content-length']; delete h['transfer-encoding'];
    if (body.length) h['content-length'] = String(body.length);
    const up = http.request(target, { method: req.method, headers: h }, (ur) => {
      res.writeHead(ur.statusCode || 502, ur.headers);
      ur.pipe(res); ur.on('end', resolve); ur.on('error', reject);
    });
    up.on('error', reject);
    up.end(body.length ? body : undefined);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (!requireBridgeAuth(req, res)) return;
    if (url.pathname === '/__mira/health') {
      const bridge = await resolveBridge();
      return json(res, bridge ? 200 : 503, {
        ok: !!bridge,
        listen: `${LISTEN_HOST}:${LISTEN_PORT}`,
        bridgePort: bridge?.port || null,
        bridgeKind: bridge?.kind || null,
        targetBase: TARGET_BASE,
      });
    }
    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) return proxyModels(req, res);
    if (req.method !== 'POST' || !(url.pathname === '/v1/responses' || url.pathname === '/responses')) {
      return json(res, 404, { error: { message: 'supported: GET /v1/models, POST /v1/responses' } });
    }
    const body = await collect(req);
    const normalized = normalizeResponsesRequest(body);
    let bridge = await waitForBridge();
    if (!bridge) return json(res, 503, { error: { message: `Mirasim model-bridge did not become ready within ${BRIDGE_WAIT_MS}ms` } });
    try {
      await forwardHttp({ port: bridge.port, path: `${bridge.responsePath}${url.search || ''}`, method: 'POST', headers: req.headers, body: normalized.body }, res);
    } catch (e) {
      log('bridge failed, retrying after re-resolve:', e.code || e.message);
      cachedBridge = null;
      bridge = await waitForBridge();
      if (!bridge) return json(res, 503, { error: { message: 'Mirasim model-bridge did not restart' } });
      await forwardHttp({ port: bridge.port, path: `${bridge.responsePath}${url.search || ''}`, method: 'POST', headers: req.headers, body: normalized.body }, res);
    }
  } catch (e) {
    log('request failed:', e.stack || e.message || String(e));
    if (!res.headersSent) json(res, 502, { error: { message: e.message || String(e) } });
    else res.destroy(e);
  }
});
server.timeout = 0;
server.requestTimeout = 0;
server.headersTimeout = 0;
server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`listening http://${LISTEN_HOST}:${LISTEN_PORT} ; target=${TARGET_BASE}; auth=${BRIDGE_API_KEY ? 'on' : 'off'}`);
  resolveBridge().then(bridge => log(bridge ? `ready bridge=${bridge.port} (${bridge.kind})` : 'waiting for Mirasim model-bridge'));
});
for (const sig of ['SIGINT','SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
