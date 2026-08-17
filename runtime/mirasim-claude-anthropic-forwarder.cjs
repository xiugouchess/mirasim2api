#!/usr/bin/env node
'use strict';

// Stable Anthropic/Claude forwarder for Mirasim direct relay.
// Chain: Claude Code/sub2api -> this port -> mirasim-direct-relay -> Mirasim relay.

const http = require('node:http');
const { Buffer } = require('node:buffer');

const LISTEN_HOST = process.env.MIRASIM_CLAUDE_FORWARD_HOST || process.env.HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.MIRASIM_CLAUDE_FORWARD_PORT || process.env.PORT || 12018);
const TARGET_BASE = (process.env.MIRASIM_CLAUDE_TARGET_BASE || 'http://127.0.0.1:12016').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = Number(process.env.MIRASIM_CLAUDE_FORWARD_REQUEST_TIMEOUT_MS || 0);

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


function log(...a) { console.error('[mirasim-claude-forwarder]', new Date().toISOString(), ...a); }
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
function normalizePath(reqUrl) {
  const u = new URL(reqUrl || '/', 'http://127.0.0.1');
  let p = u.pathname || '/';
  if (!p.startsWith('/v1/') && ['/messages','/models','/chat/completions','/responses'].some(x => p === x || p.startsWith(x + '/'))) p = '/v1' + p;
  return p + (u.search || '');
}
function proxyToTarget(req, res, body) {
  return new Promise((resolve, reject) => {
    const path = normalizePath(req.url);
    const target = new URL(TARGET_BASE + path);
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
async function health() {
  return new Promise((resolve) => {
    const req = http.request(new URL(TARGET_BASE + '/health'), { method: 'GET', timeout: 3000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let upstream = null;
        try { upstream = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolve({ ok: res.statusCode && res.statusCode < 500, upstreamStatus: res.statusCode, upstream });
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
      const h = await health();
      return json(res, h.ok ? 200 : 503, { ...h, listen: `${LISTEN_HOST}:${LISTEN_PORT}`, targetBase: TARGET_BASE });
    }
    const body = ['GET','HEAD'].includes((req.method || 'GET').toUpperCase()) ? Buffer.alloc(0) : await collect(req);
    await proxyToTarget(req, res, body);
  } catch (e) {
    log('request failed:', e.stack || e.message || String(e));
    if (!res.headersSent) json(res, 502, { error: { message: e.message || String(e) } });
    else res.destroy(e);
  }
});
server.timeout = 0;
server.requestTimeout = 0;
server.headersTimeout = 0;
server.listen(LISTEN_PORT, LISTEN_HOST, () => log(`listening http://${LISTEN_HOST}:${LISTEN_PORT} -> ${TARGET_BASE}; auth=${BRIDGE_API_KEY ? 'on' : 'off'}`));
for (const sig of ['SIGINT','SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));