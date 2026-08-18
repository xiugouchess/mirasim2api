#!/usr/bin/env node
'use strict';

// Unified Mirasim bridge.
// /v1/responses -> Codex Responses forwarder
// /v1/messages and other Anthropic/OpenAI-compatible relay paths -> Claude/direct relay forwarder

const http = require('node:http');
const { Buffer } = require('node:buffer');

const LISTEN_HOST = process.env.MIRASIM_UNIFIED_BRIDGE_HOST || process.env.HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.MIRASIM_UNIFIED_BRIDGE_PORT || process.env.PORT || 12015);
const CODEX_BASE = (process.env.MIRASIM_CODEX_FORWARD_BASE || 'http://127.0.0.1:12017').replace(/\/+$/, '');
const CLAUDE_BASE = (process.env.MIRASIM_CLAUDE_FORWARD_BASE || 'http://127.0.0.1:12018').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = Number(process.env.MIRASIM_UNIFIED_REQUEST_TIMEOUT_MS || 0);

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


function log(...a) { console.error('[mirasim-unified-bridge]', new Date().toISOString(), ...a); }
function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) });
  res.end(body);
}
function collect(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function routeBase(pathname) {
  if (pathname === '/v1/responses' || pathname === '/responses'
    || pathname === '/v1/responses/compact' || pathname === '/responses/compact') return CODEX_BASE;
  return CLAUDE_BASE;
}
function normalizePath(pathname) {
  if (!pathname.startsWith('/v1/') && ['/responses','/messages','/models','/chat/completions'].some(x => pathname === x || pathname.startsWith(x + '/'))) return '/v1' + pathname;
  return pathname;
}
function proxy(base, req, res, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    const target = new URL(base + normalizePath(u.pathname) + (u.search || ''));
    const h = { ...req.headers };
    delete h.host; delete h.connection; delete h['content-length']; delete h['transfer-encoding'];
    if (body.length) h['content-length'] = String(body.length);
    const up = http.request(target, { method: req.method, headers: h, timeout: REQUEST_TIMEOUT_MS }, (ur) => {
      res.writeHead(ur.statusCode || 502, ur.headers);
      ur.pipe(res);
      ur.on('end', resolve);
      ur.on('error', err => res.headersSent ? res.destroy(err) : reject(err));
    });
    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    up.on('error', err => res.headersSent ? res.destroy(err) : reject(err));
    res.on('close', () => { if (!up.destroyed) up.destroy(); });
    up.end(body.length ? body : undefined);
  });
}
function getJson(url) {
  return new Promise((resolve) => {
    const headers = BRIDGE_API_KEY ? { 'x-api-key': BRIDGE_API_KEY } : undefined;
    const req = http.request(new URL(url), { method: 'GET', timeout: 3000, headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolve({ ok: res.statusCode && res.statusCode < 500, status: res.statusCode, body });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (!requireBridgeAuth(req, res)) return;
    if (u.pathname === '/__mira/health') {
      const [codex, claude] = await Promise.all([
        getJson(CODEX_BASE + '/__mira/health'),
        getJson(CLAUDE_BASE + '/__mira/health'),
      ]);
      return json(res, codex.ok && claude.ok ? 200 : 503, {
        ok: codex.ok && claude.ok,
        listen: `${LISTEN_HOST}:${LISTEN_PORT}`,
        routes: { responses: CODEX_BASE, messages: CLAUDE_BASE, models: CLAUDE_BASE },
        codex, claude,
      });
    }
    const body = ['GET','HEAD'].includes((req.method || 'GET').toUpperCase()) ? Buffer.alloc(0) : await collect(req);
    await proxy(routeBase(u.pathname), req, res, body);
  } catch (e) {
    log('request failed:', e.stack || e.message || String(e));
    if (!res.headersSent) json(res, 502, { error: { message: e.message || String(e) } });
    else res.destroy(e);
  }
});
server.timeout = 0;
server.requestTimeout = 0;
server.headersTimeout = 0;
server.listen(LISTEN_PORT, LISTEN_HOST, () => log(`listening http://${LISTEN_HOST}:${LISTEN_PORT}; codex=${CODEX_BASE}; claude=${CLAUDE_BASE}; auth=${BRIDGE_API_KEY ? 'on' : 'off'}`));
for (const sig of ['SIGINT','SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
