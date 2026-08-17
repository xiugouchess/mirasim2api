#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const raw = String(process.env.MIRASIM_PROXY || '').trim();
const output = process.argv[2] || '/run/mirasim-proxychains.conf';

if (!raw) process.exit(0);

let url;
try {
  url = new URL(raw);
} catch {
  throw new Error('MIRASIM_PROXY is not a valid URL');
}

if (url.protocol !== 'socks5:' && url.protocol !== 'socks5h:') {
  throw new Error('MIRASIM_PROXY only supports socks5:// or socks5h://');
}
if (!url.hostname || !url.port) {
  throw new Error('MIRASIM_PROXY must include a host and port');
}
if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
  throw new Error('MIRASIM_PROXY must not include a path, query, or fragment');
}

const host = url.hostname.replace(/^\[|\]$/g, '');
const username = decodeURIComponent(url.username);
const password = decodeURIComponent(url.password);
for (const [name, value] of Object.entries({ host, username, password })) {
  if (/\s/.test(value)) throw new Error(`MIRASIM_PROXY ${name} must not contain whitespace`);
}

const auth = username ? ` ${username}${password ? ` ${password}` : ''}` : '';
const config = [
  'strict_chain',
  'proxy_dns',
  'remote_dns_subnet 224',
  'tcp_read_time_out 15000',
  'tcp_connect_time_out 8000',
  'localnet 127.0.0.0/255.0.0.0',
  '',
  '[ProxyList]',
  `socks5 ${host} ${url.port}${auth}`,
  '',
].join('\n');

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, config, { mode: 0o600 });
