#!/usr/bin/env node
'use strict';
const http = require('http');
const net = require('net');

const LISTEN_HOST = process.env.MIRASIM_WEB_PROXY_HOST || process.env.MIRASIM_HOST || '0.0.0.0';
const LISTEN_PORT = Number(process.env.MIRASIM_WEB_PROXY_PORT || process.env.MIRASIM_PORT || 4939);
const TARGET_HOST = process.env.MIRASIM_WEB_TARGET_HOST || '127.0.0.1';
const TARGET_PORT = Number(process.env.MIRASIM_WEB_TARGET_PORT || process.env.MIRASIM_INTERNAL_PORT || 4938);

function log(...args) { console.error('[mirasim-web-loopback-proxy]', ...args); }

function copyHeaders(headers) {
  const out = { ...headers };
  out.host = `${TARGET_HOST}:${TARGET_PORT}`;
  out['x-forwarded-host'] = headers.host || '';
  out['x-forwarded-proto'] = 'http';
  return out;
}

const server = http.createServer((req, res) => {
  const upstream = http.request({
    host: TARGET_HOST,
    port: TARGET_PORT,
    method: req.method,
    path: req.url,
    headers: copyHeaders(req.headers),
  }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.statusMessage, upRes.headers);
    upRes.on('error', () => { try { res.destroy(); } catch {} });
    res.on('error', () => { try { upRes.destroy(); } catch {} });
    upRes.pipe(res);
  });
  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'mirasim internal server unavailable', detail: err.message }));
    } else {
      try { res.destroy(); } catch {}
    }
  });
  req.on('error', () => { try { upstream.destroy(); } catch {} });
  res.on('close', () => { try { upstream.destroy(); } catch {} });
  req.pipe(upstream);
});

server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(TARGET_PORT, TARGET_HOST);
  let settled = false;
  const destroyUp = () => { try { upstream.destroy(); } catch {} };
  const destroyDown = () => { try { socket.destroy(); } catch {} };
  socket.on('error', destroyUp);
  upstream.on('error', () => {
    if (!settled && !socket.destroyed) {
      try { socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); } catch {}
    } else {
      destroyDown();
    }
  });
  socket.on('close', destroyUp);
  upstream.on('close', destroyDown);
  upstream.on('connect', () => {
    settled = true;
    const headers = copyHeaders(req.headers);
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      if (Array.isArray(v)) for (const vv of v) raw += `${k}: ${vv}\r\n`;
      else if (v != null) raw += `${k}: ${v}\r\n`;
    }
    raw += '\r\n';
    upstream.write(raw);
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
});

server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch {}
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`listening http://${LISTEN_HOST}:${LISTEN_PORT} -> http://${TARGET_HOST}:${TARGET_PORT}`);
});
