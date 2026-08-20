#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const AUTH_FILE = process.env.MIRASIM_AUTH_FILE || path.resolve(process.cwd(), 'mirasim_relay_auth.full.local.json');
const HOST = process.env.HOST || process.env.MIRASIM_DIRECT_RELAY_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || process.env.MIRASIM_DIRECT_RELAY_PORT || 12016);
const INBOUND_API_KEY = (process.env.INBOUND_API_KEY || process.env.MIRASIM_INBOUND_API_KEY || '').trim();
const REFRESH_BEFORE_SEC = Number(process.env.MIRASIM_REFRESH_BEFORE_SEC || 300);
const TICKET_REFRESH_BEFORE_MS = Number(process.env.MIRASIM_TICKET_REFRESH_BEFORE_MS || 120000);
const DEFAULT_RELAY_BASE = 'https://mirasim-relay.mirofish.ai';
const DEFAULT_LOGIN_BASE = 'https://admin.test.mirofish.ai';
const CLIENT_HEADER = process.env.MIRASIM_CLIENT_HEADER || '';
const DISABLE_LOGIN_REFRESH = String(process.env.MIRASIM_DISABLE_LOGIN_REFRESH ?? '1') !== '0';
const LIVE_SETTING_FILE = process.env.MIRASIM_LIVE_SETTING_FILE || (process.env.MIRASIM_HOME ? path.join(process.env.MIRASIM_HOME, 'setting.json') : '');

let ticketState = null;
let mintInFlight = null;
let refreshInFlight = null;
let authDoc = loadAuthDoc();

function nowSec() { return Math.floor(Date.now() / 1000); }
function log(...args) { console.error('[mirasim-direct-relay]', new Date().toISOString(), ...args); }
function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) });
  res.end(body);
}
function loadAuthDoc() {
  let doc = null;
  if (fs.existsSync(AUTH_FILE)) {
    const text = fs.readFileSync(AUTH_FILE, 'utf8');
    doc = JSON.parse(text);
  } else {
    doc = buildAuthDocFromLiveSetting();
    if (!doc) {
      throw new Error(`auth file not found (${AUTH_FILE}) and live Mirasim setting is not ready (${LIVE_SETTING_FILE || 'unset'}). Login Mirasim Web first, or provide mirasim_relay_auth.full.local.json.`);
    }
    try {
      fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
      fs.writeFileSync(AUTH_FILE, JSON.stringify(doc, null, 2), 'utf8');
      log('created auth file from live Mirasim setting:', AUTH_FILE);
    } catch (e) {
      log('write derived auth file failed:', e.message);
    }
  }
  if (!doc.auth?.token) throw new Error(`auth.token missing in ${AUTH_FILE}`);
  if (!DISABLE_LOGIN_REFRESH && !doc.auth?.refreshToken) throw new Error(`auth.refreshToken missing in ${AUTH_FILE}`);
  if (!doc.device?.privateKeyPem) throw new Error(`device.privateKeyPem missing in ${AUTH_FILE}`);
  doc.relay = doc.relay || {};
  doc.relay.baseURL = (process.env.MIRASIM_RELAY_URL || doc.relay.baseURL || DEFAULT_RELAY_BASE).replace(/\/+$/, '');
  doc.login = doc.login || {};
  doc.login.baseURL = (process.env.MIRASIM_LOGIN_URL || doc.login.baseURL || DEFAULT_LOGIN_BASE).replace(/\/+$/, '');
  doc.device = deriveDevice(doc.device.privateKeyPem, doc.device.deviceId);
  if (doc.relay?.mintedTicket?.ok && doc.relay.mintedTicket.ticket) {
    ticketState = {
      ticket: doc.relay.mintedTicket.ticket,
      expiresAtMs: parseTicketExpiryMs(doc.relay.mintedTicket.ticket) || (doc.relay.mintedTicket.expiresAtIso ? Date.parse(doc.relay.mintedTicket.expiresAtIso) : 0),
    };
  }
  return doc;
}
function buildAuthDocFromLiveSetting() {
  try {
    if (!LIVE_SETTING_FILE || !fs.existsSync(LIVE_SETTING_FILE)) return null;
    const setting = JSON.parse(fs.readFileSync(LIVE_SETTING_FILE, 'utf8'));
    const a = setting.auth || {};
    const privateKeyPem = setting.device?.privateKey || setting.device?.privateKeyPem || '';
    if (!a.token || !privateKeyPem) return null;
    const p = parseJwt(a.token) || {};
    return {
      generatedAt: new Date().toISOString(),
      auth: {
        token: a.token,
        refreshToken: a.refreshToken || '',
        userId: a.userId || p.sub || '',
        exp: a.exp || p.exp || null,
        expIso: (a.exp || p.exp) ? new Date((a.exp || p.exp) * 1000).toISOString() : null,
        tenant: a.tenant || 'external',
        tenantAt: a.tenantAt || Math.floor(Date.now() / 1000),
        name: a.name || '',
        capture: a.capture || 'live-setting',
        tokenJwt: { payload: p },
        refreshTokenJwt: a.refreshToken ? { payload: parseJwt(a.refreshToken) } : null,
      },
      device: { privateKeyPem },
      relay: { baseURL: process.env.MIRASIM_RELAY_URL || DEFAULT_RELAY_BASE },
      login: { baseURL: process.env.MIRASIM_LOGIN_URL || DEFAULT_LOGIN_BASE },
      settingDecrypted: setting,
    };
  } catch (e) {
    log('build auth doc from live setting failed:', e.message);
    return null;
  }
}
function loadLiveAuthFromSetting() {
  if (!LIVE_SETTING_FILE) return false;
  try {
    if (!fs.existsSync(LIVE_SETTING_FILE)) return false;
    const setting = JSON.parse(fs.readFileSync(LIVE_SETTING_FILE, 'utf8'));
    const a = setting && setting.auth;
    if (!a || !a.token) return false;
    const oldToken = authDoc.auth.token;
    authDoc.auth.token = a.token;
    if (a.refreshToken) authDoc.auth.refreshToken = a.refreshToken;
    if (a.exp) authDoc.auth.exp = a.exp;
    const p = parseJwt(authDoc.auth.token) || {};
    authDoc.auth.exp = p.exp || authDoc.auth.exp || null;
    authDoc.auth.expIso = p.exp ? new Date(p.exp * 1000).toISOString() : null;
    authDoc.auth.tokenJwt = { payload: p };
    if (oldToken !== authDoc.auth.token) {
      ticketState = null;
      log('loaded newer access token from live Mirasim setting; exp=', authDoc.auth.expIso || authDoc.auth.exp);
    }
    return true;
  } catch (e) {
    log('load live Mirasim setting failed:', e.message);
    return false;
  }
}
function saveAuthDoc() {
  try {
    authDoc.generatedAt = new Date().toISOString();
    if (authDoc.settingDecrypted?.auth) {
      authDoc.settingDecrypted.auth.token = authDoc.auth.token;
      authDoc.settingDecrypted.auth.refreshToken = authDoc.auth.refreshToken;
      authDoc.settingDecrypted.auth.exp = authDoc.auth.exp;
    }
    fs.writeFileSync(AUTH_FILE, JSON.stringify(authDoc, null, 2), 'utf8');
  } catch (e) {
    log('save auth file failed:', e.message);
  }
}
function parseJwt(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { return null; }
}
function parseTicketExpiryMs(token) {
  const p = parseJwt(token);
  return p?.exp ? p.exp * 1000 : 0;
}
function deriveDevice(privateKeyPem, expectedDeviceId) {
  const privateKeyObject = crypto.createPrivateKey(privateKeyPem);
  const publicKeyB64 = crypto.createPublicKey(privateKeyObject).export({ format: 'der', type: 'spki' }).toString('base64');
  const deviceId = crypto.createHash('sha256').update(publicKeyB64).digest('base64url').slice(0, 22);
  if (expectedDeviceId && expectedDeviceId !== deviceId) log(`deviceId mismatch: file=${expectedDeviceId} derived=${deviceId}; using derived`);
  return { privateKeyPem, privateKeyObject, publicKeyB64, deviceId, algorithm: 'ed25519' };
}
function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function signHeaders(method, pathname, body) {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('base64url');
  const baseString = ['mrs-sig-v1', method.toUpperCase(), pathname, ts, nonce, sha256Hex(body)].join('\n');
  const sig = crypto.sign(null, Buffer.from(baseString, 'utf8'), authDoc.device.privateKeyObject).toString('base64url');
  const h = {
    'x-mirasim-device': authDoc.device.deviceId,
    'x-mirasim-ts': ts,
    'x-mirasim-nonce': nonce,
    'x-mirasim-sig': sig,
  };
  if (CLIENT_HEADER) h['x-mirasim-client'] = CLIENT_HEADER;
  return h;
}
async function refreshAccessTokenIfNeeded() {
  // Never rotate Mirasim refreshToken from the bridge by default.
  // The desktop/server app owns login refresh. Rotating RT here can invalidate
  // Mirasim's own stored login state and force re-login.
  loadLiveAuthFromSetting();
  let payload = parseJwt(authDoc.auth.token);
  if (payload?.exp && payload.exp - nowSec() > REFRESH_BEFORE_SEC) return authDoc.auth.token;

  // Try one more live reload in case Mirasim refreshed just now.
  loadLiveAuthFromSetting();
  payload = parseJwt(authDoc.auth.token);
  if (payload?.exp && payload.exp - nowSec() > REFRESH_BEFORE_SEC) return authDoc.auth.token;

  if (DISABLE_LOGIN_REFRESH) {
    const expIso = payload?.exp ? new Date(payload.exp * 1000).toISOString() : null;
    throw new Error('Mirasim access token is expired/near expiry and bridge-side /auth/refresh is disabled to avoid rotating refreshToken. Let Mirasim refresh it, restart the Mirasim container after Mirasim has a fresh setting.json, or re-export auth. exp=' + (expIso || 'unknown'));
  }

  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const url = authDoc.login.baseURL + '/auth/refresh';
    log('refreshing access token via', url);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: authDoc.auth.refreshToken }),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok || !data?.access_token) throw new Error(`refresh failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    authDoc.auth.token = data.access_token;
    if (data.refresh_token) authDoc.auth.refreshToken = data.refresh_token;
    const p = parseJwt(authDoc.auth.token) || {};
    authDoc.auth.exp = p.exp || authDoc.auth.exp || null;
    authDoc.auth.expIso = p.exp ? new Date(p.exp * 1000).toISOString() : null;
    authDoc.auth.tokenJwt = { payload: p };
    authDoc.auth.refreshTokenJwt = { payload: parseJwt(authDoc.auth.refreshToken) };
    saveAuthDoc();
    log('access token refreshed; exp=', authDoc.auth.expIso || authDoc.auth.exp);
    ticketState = null;
    return authDoc.auth.token;
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}
async function mintTicketIfNeeded() {
  const now = Date.now();
  if (ticketState?.ticket && ticketState.expiresAtMs && now < ticketState.expiresAtMs - TICKET_REFRESH_BEFORE_MS) return ticketState.ticket;
  if (mintInFlight) return mintInFlight;
  mintInFlight = (async () => {
    const accessToken = await refreshAccessTokenIfNeeded();
    const endpointPath = '/v1/device/session';
    const body = Buffer.from(JSON.stringify({ publicKey: authDoc.device.publicKeyB64, deviceId: authDoc.device.deviceId }), 'utf8');
    const headers = {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + accessToken,
      ...signHeaders('POST', endpointPath, body),
    };
    const url = authDoc.relay.baseURL + endpointPath;
    log('minting relay ticket via', url);
    const res = await fetch(url, { method: 'POST', headers, body });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok || !data?.ticket) {
      log(`ticket mint failed HTTP ${res.status}; fallback to access token`);
      ticketState = { ticket: accessToken, expiresAtMs: (parseJwt(accessToken)?.exp || (nowSec() + 600)) * 1000 };
      return accessToken;
    }
    const expiresAtMs = typeof data.expiresIn === 'number' ? Date.now() + data.expiresIn * 1000
      : typeof data.expiresAt === 'number' ? data.expiresAt * 1000
      : parseTicketExpiryMs(data.ticket) || Date.now() + 15 * 60 * 1000;
    ticketState = { ticket: data.ticket, expiresAtMs };
    authDoc.relay.mintedTicket = {
      ok: true,
      status: res.status,
      ticket: data.ticket,
      expiresIn: data.expiresIn ?? null,
      expiresAt: data.expiresAt ?? null,
      expiresAtIso: new Date(expiresAtMs).toISOString(),
      raw: data,
    };
    saveAuthDoc();
    log('relay ticket ready; expires=', authDoc.relay.mintedTicket.expiresAtIso);
    return data.ticket;
  })().finally(() => { mintInFlight = null; });
  return mintInFlight;
}
function checkInboundAuth(req) {
  if (!INBOUND_API_KEY) return true;
  const auth = String(req.headers.authorization || '').trim();
  const xkey = String(req.headers['x-api-key'] || '').trim();
  return xkey === INBOUND_API_KEY || auth === INBOUND_API_KEY || auth.toLowerCase() === ('bearer ' + INBOUND_API_KEY).toLowerCase();
}
function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const hopByHop = new Set(['host','connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','content-length']);
function buildForwardHeaders(req, token, body, pathname) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (hopByHop.has(lk)) continue;
    if (lk === 'authorization' || lk === 'x-api-key') continue;
    if (lk.startsWith('x-mirasim-')) continue;
    out[lk] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  out.authorization = 'Bearer ' + token;
  Object.assign(out, signHeaders(req.method || 'GET', pathname, body));
  if (body.length) out['content-length'] = String(body.length);
  return out;
}
function normalizePath(reqUrl) {
  const u = new URL(reqUrl || '/', 'http://127.0.0.1');
  let pathname = u.pathname || '/';
  if (!pathname.startsWith('/v1/') && ['/models','/responses','/chat/completions','/messages'].some(p => pathname === p || pathname.startsWith(p + '/'))) {
    pathname = '/v1' + pathname;
  }
  return { pathname, search: u.search || '', upstreamUrl: authDoc.relay.baseURL + pathname + (u.search || '') };
}
function normalizeClaudeBody(pathname, body) {
  if (pathname !== '/v1/messages' || body.length === 0) return body;
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); } catch { return body; }
  if (!payload || typeof payload !== 'object' || !Object.prototype.hasOwnProperty.call(payload, 'thinking')) return body;
  // The current Mirasim relay rejects Anthropic's top-level thinking option.
  delete payload.thinking;
  return Buffer.from(JSON.stringify(payload), 'utf8');
}
async function sendUpstream(req, route, body) {
  const token = await mintTicketIfNeeded();
  const headers = buildForwardHeaders(req, token, body, route.pathname);
  const init = { method: req.method, headers };
  if (!['GET','HEAD'].includes((req.method || 'GET').toUpperCase())) init.body = body;
  return fetch(route.upstreamUrl, init);
}
async function handle(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type,x-api-key,anthropic-version,anthropic-beta,openai-beta',
      'access-control-max-age': '86400',
    });
    return res.end();
  }
  if (req.url === '/health' || req.url === '/healthz') {
    const accessPayload = parseJwt(authDoc.auth.token);
    return json(res, 200, {
      ok: true,
      relayBaseURL: authDoc.relay.baseURL,
      loginBaseURL: authDoc.login.baseURL,
      authExpIso: accessPayload?.exp ? new Date(accessPayload.exp * 1000).toISOString() : null,
      ticketExpiresIso: ticketState?.expiresAtMs ? new Date(ticketState.expiresAtMs).toISOString() : null,
      deviceId: authDoc.device.deviceId,
      bridgeSideLoginRefreshDisabled: DISABLE_LOGIN_REFRESH,
      liveSettingFile: LIVE_SETTING_FILE || null,
    });
  }
  if (!checkInboundAuth(req)) return json(res, 401, { error: { message: 'invalid inbound api key' } });

  const route = normalizePath(req.url);
  const rawBody = ['GET','HEAD'].includes((req.method || 'GET').toUpperCase()) ? Buffer.alloc(0) : await collectBody(req);
  const body = normalizeClaudeBody(route.pathname, rawBody);
  let upstream = await sendUpstream(req, route, body);
  // The relay answers 401 when the signed ticket is rejected, and the pool
  // behind it can answer 403 for a freshly minted ticket. Both clear up after
  // re-minting, so retry once. A still-failing status is passed through.
  if (upstream.status === 401 || upstream.status === 403) {
    log(`upstream ${upstream.status}; clearing cached relay ticket and retrying once`);
    upstream.body?.cancel().catch(() => {});
    ticketState = null;
    upstream = await sendUpstream(req, route, body);
  }
  const responseHeaders = {};
  upstream.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (hopByHop.has(lk)) return;
    responseHeaders[k] = v;
  });
  responseHeaders['access-control-allow-origin'] = '*';
  res.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).on('error', e => res.destroy(e)).pipe(res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    log('request failed:', err.stack || err.message || String(err));
    if (!res.headersSent) json(res, 502, { error: { message: String(err.message || err) } });
    else res.destroy(err);
  });
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
  log(`sub2api base_url: http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/v1`);
  log(`auth file: ${AUTH_FILE}`);
});
