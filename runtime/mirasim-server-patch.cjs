#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const target = process.argv[2];
if (!target) throw new Error('usage: mirasim-server-patch.cjs /path/to/server.cjs');

const guard = "if(process['env']['MIRASIM_CODEX_KEEP_WARM']==='1')return;";
let source = fs.readFileSync(target, 'utf8');

if (source.includes(guard)) {
  console.log('[patch] Mirasim Codex keep-warm patch already applied');
  process.exit(0);
}

const logNeedles = [
  "'[codex]\\x20warm\\x20app-server\\x20evicted\\x20('",
  "'[codex] warm app-server evicted ('",
];
const logIndex = logNeedles.map(needle => source.indexOf(needle)).find(index => index >= 0) ?? -1;
if (logIndex < 0) throw new Error('Mirasim Codex warm-pool marker not found');

const methodIndex = source.lastIndexOf("['scheduleExpiry'](", logIndex);
if (methodIndex < 0) throw new Error('Mirasim Codex scheduleExpiry method not found');

const bodyIndex = source.indexOf('{', methodIndex);
if (bodyIndex < 0 || bodyIndex > logIndex) throw new Error('Mirasim Codex scheduleExpiry body not found');

source = source.slice(0, bodyIndex + 1) + guard + source.slice(bodyIndex + 1);

const stat = fs.statSync(target);
const temp = `${target}.mirasim-patch-${process.pid}`;
try {
  fs.writeFileSync(temp, source, { mode: stat.mode });
  fs.renameSync(temp, target);
} catch (error) {
  try { fs.unlinkSync(temp); } catch {}
  throw error;
}

console.log('[patch] disabled Mirasim Codex warm app-server idle eviction when MIRASIM_CODEX_KEEP_WARM=1');
