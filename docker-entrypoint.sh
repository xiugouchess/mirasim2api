#!/usr/bin/env bash
set -euo pipefail

APP_ROOT=${APP_ROOT:-/app}
RES="$APP_ROOT/Mirasim.app/Contents/Resources"
DATA=${MIRASIM_DATA_DIR:-/data}
AUTH_EXPORT=${MIRASIM_AUTH_EXPORT:-$DATA/mirasim_relay_auth.full.local.json}
AUTH_SEED=${MIRASIM_AUTH_SEED:-$APP_ROOT/runtime/mirasim_relay_auth.full.local.json}
PROXY_CONFIG=${MIRASIM_PROXY_CONFIG:-/run/mirasim-proxychains.conf}

proxy_value=${MIRASIM_PROXY:-}
if [ -n "${MIRASIM_PROXY_FILE:-}" ] && [ -f "$MIRASIM_PROXY_FILE" ]; then
  proxy_value=$(cat "$MIRASIM_PROXY_FILE")
fi
unset MIRASIM_PROXY

PROXY_COMMAND=()
if [ -n "$proxy_value" ]; then
  MIRASIM_PROXY="$proxy_value" node "$APP_ROOT/runtime/mirasim-proxychains-config.cjs" "$PROXY_CONFIG"
  PROXY_COMMAND=(proxychains4 -q -f "$PROXY_CONFIG")
  echo "[entrypoint] Mirasim SOCKS5 proxy enabled (strict chain, remote DNS)" >&2
fi

run_with_proxy() {
  "${PROXY_COMMAND[@]}" "$@"
}

mkdir -p "$DATA/home" "$DATA/mirasim-home" "$DATA/codex-home" "$DATA/workdir" "$DATA/npm-cache" "$DATA/logs"
export HOME="$DATA/home"
export MIRASIM_HOME="$DATA/mirasim-home"
export CODEX_HOME="$DATA/codex-home"
export NPM_CONFIG_CACHE="$DATA/npm-cache"
export MIRASIM_RECORD=${MIRASIM_RECORD:-0}
export MIRASIM_QUIET=${MIRASIM_QUIET:-0}
export MIRASIM_SECRET_STORE=off
export MIRASIM_RESOURCES="$RES"
export NODE_PATH="$RES/node_modules:${NODE_PATH:-}"
export MIRASIM_CODEX_BIN=${MIRASIM_CODEX_BIN:-/usr/local/bin/codex}
export MIRASIM_CLAUDE_BIN=${MIRASIM_CLAUDE_BIN:-/usr/local/bin/claude}
MIRASIM_APP_VERSION=$(RES="$RES" node -e '
const fs = require("fs");
const res = process.env.RES;
try {
  const b = fs.readFileSync(res + "/app.asar");
  const dir = JSON.parse(b.slice(16, 16 + b.readUInt32LE(12)).toString("utf8").replace(/\0+$/, ""));
  const base = 8 + b.readUInt32LE(4);
  const f = dir.files["package.json"];
  const v = JSON.parse(b.slice(base + Number(f.offset), base + Number(f.offset) + f.size).toString("utf8")).version;
  if (/^[0-9]+(\.[0-9]+)+$/.test(v)) { console.log(v); process.exit(0); }
} catch {}
// The bundle keeps the version inlined behind an obfuscated alias.
const m = fs.readFileSync(res + "/server.cjs", "utf8").match(/=(?:\x27|")([0-9]+(?:\.[0-9]+)+)(?:\x27|")\?\.\[\x27trim\x27\]/);
if (m) console.log(m[1]);
' 2>/dev/null)
CLAUDE_CLI_VERSION=$("$MIRASIM_CLAUDE_BIN" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)
CLAUDE_SDK_VERSION=$(node -e "try{console.log(require('/usr/local/lib/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/sdk/package.json').version)}catch{}" 2>/dev/null)
export MIRASIM_APP_VERSION CLAUDE_CLI_VERSION CLAUDE_SDK_VERSION
export NO_PROXY="127.0.0.1,localhost,::1${NO_PROXY:+,$NO_PROXY}"
export no_proxy="127.0.0.1,localhost,::1${no_proxy:+,$no_proxy}"
export MIRASIM_PUBLIC_PORT=${MIRASIM_PUBLIC_PORT:-${MIRASIM_PORT:-4939}}
export MIRASIM_INTERNAL_PORT=${MIRASIM_INTERNAL_PORT:-4938}
if [ "$MIRASIM_PUBLIC_PORT" = "$MIRASIM_INTERNAL_PORT" ]; then
  echo "[entrypoint] MIRASIM_PUBLIC_PORT and MIRASIM_INTERNAL_PORT must be different" >&2
  exit 1
fi


if [ ! -f "$RES/server.cjs" ]; then
  echo "[entrypoint] missing $RES/server.cjs; DMG unpack may have failed" >&2
  find "$APP_ROOT" -maxdepth 4 -type f -name server.cjs -print >&2 || true
  exit 1
fi

if [ ! -f "$AUTH_EXPORT" ] && [ -f "$AUTH_SEED" ]; then
  cp "$AUTH_SEED" "$AUTH_EXPORT"
  chmod 600 "$AUTH_EXPORT" || true
  echo "[entrypoint] copied auth seed to $AUTH_EXPORT" >&2
fi

if [ -f "$AUTH_EXPORT" ]; then
  AUTH_EXPORT="$AUTH_EXPORT" MIRASIM_HOME="$MIRASIM_HOME" CODEX_HOME="$CODEX_HOME" DATA="$DATA" MIRASIM_APP_VERSION="$MIRASIM_APP_VERSION" node <<'NODE'
const fs = require('fs');
const path = require('path');
const authPath = process.env.AUTH_EXPORT;
const home = process.env.MIRASIM_HOME;
const codexHome = process.env.CODEX_HOME;
const data = process.env.DATA;
const appVersion = process.env.MIRASIM_APP_VERSION || '0.0.150';
const doc = JSON.parse(fs.readFileSync(authPath, 'utf8'));
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(codexHome, { recursive: true });
const now = Math.floor(Date.now() / 1000);
const setting = {
  record: { enabled: false, blobs: 'all', redactHeaders: true },
  auth: {
    token: doc.auth?.token || '',
    userId: doc.auth?.userId || '',
    exp: doc.auth?.exp || doc.auth?.tokenJwt?.payload?.exp || null,
    refreshToken: doc.auth?.refreshToken || '',
    tenant: doc.auth?.tenant || 'external',
    tenantAt: doc.auth?.tenantAt || now,
    name: doc.auth?.name || '',
    capture: doc.auth?.capture || 'relay'
  },
  agent_accounts: [],
  current_agent_account: {},
  failover: { enabled: true, manualKey: '', threshold: 0.95, on5h: true, on7d: true, reactive: true, always: true },
  onboarding: { seenVersion: appVersion },
  version: appVersion,
  mirachannelToken: '',
  mirachannelNodeId: '',
  mirachannelE2eKey: '',
  device: { privateKey: doc.device?.privateKeyPem || doc.settingDecrypted?.device?.privateKey || '' },
  managedStores: {},
  workspaces: [{ path: path.join(data, 'workdir'), name: 'workdir', order: 0, addedAt: new Date().toISOString() }]
};
fs.writeFileSync(path.join(home, 'setting.json'), JSON.stringify(setting, null, 2));
fs.writeFileSync(path.join(codexHome, 'config.toml'), `[projects.'${path.join(data, 'workdir').replace(/\\/g, '/')}']\ntrust_level = "trusted"\n`);
console.error('[entrypoint] wrote', path.join(home, 'setting.json'));
NODE
else
  echo "[entrypoint] auth export not found; login via Web UI. bridge will retry until $MIRASIM_HOME/setting.json exists" >&2
fi

start_node_loop() {
  local name=$1; shift
  local log="$MIRASIM_HOME/logs/${name}.log"
  mkdir -p "$(dirname "$log")"
  (
    while true; do
      echo "[$(date -Iseconds)] starting $name: $*"
      set +e
      run_with_proxy "$@"
      code=$?
      set -e
      echo "[$(date -Iseconds)] $name exited code=$code; restart in 2s"
      sleep 2
    done
  ) >>"$log" 2>&1 &
  echo "[entrypoint] $name loop pid=$! log=$log" >&2
}

start_node_loop mirasim-web-loopback-proxy env   MIRASIM_WEB_PROXY_HOST="${MIRASIM_HOST:-0.0.0.0}"   MIRASIM_WEB_PROXY_PORT="$MIRASIM_PUBLIC_PORT"   MIRASIM_WEB_TARGET_HOST=127.0.0.1   MIRASIM_WEB_TARGET_PORT="$MIRASIM_INTERNAL_PORT"   node "$APP_ROOT/runtime/mirasim-web-loopback-proxy.cjs"

if [ "${MIRASIM_BRIDGE_ENABLED:-1}" != "0" ]; then
  DIRECT_PORT=${MIRASIM_DIRECT_RELAY_PORT:-12016}
  UNIFIED_PORT=${MIRASIM_UNIFIED_BRIDGE_PORT:-12015}
  CODEX_PORT=${MIRASIM_CODEX_FORWARD_PORT:-12017}
  CLAUDE_PORT=${MIRASIM_CLAUDE_FORWARD_PORT:-12018}
  BRIDGE_HOST=${MIRASIM_BRIDGE_HOST:-0.0.0.0}

  start_node_loop mirasim-direct-relay env \
    MIRASIM_AUTH_FILE="$AUTH_EXPORT" \
    MIRASIM_DISABLE_LOGIN_REFRESH=${MIRASIM_DISABLE_LOGIN_REFRESH:-1} \
    MIRASIM_LIVE_SETTING_FILE="$MIRASIM_HOME/setting.json" \
    MIRASIM_DIRECT_RELAY_HOST=127.0.0.1 \
    MIRASIM_DIRECT_RELAY_PORT="$DIRECT_PORT" \
    MIRASIM_CLIENT_HEADER="${MIRASIM_CLIENT_HEADER:-$MIRASIM_APP_VERSION}" \
    MIRASIM_CLAUDE_CLI_VERSION="$CLAUDE_CLI_VERSION" \
    MIRASIM_CLAUDE_SDK_VERSION="$CLAUDE_SDK_VERSION" \
    node "$APP_ROOT/runtime/mirasim-direct-relay.cjs"

  start_node_loop mirasim-codex-forwarder env \
    MIRASIM_CODEX_FORWARD_HOST="$BRIDGE_HOST" \
    MIRASIM_CODEX_FORWARD_PORT="$CODEX_PORT" \
    MIRASIM_CODEX_TARGET_BASE="http://127.0.0.1:${DIRECT_PORT}/v1" \
    MIRASIM_BRIDGE_API_KEY="${MIRASIM_BRIDGE_API_KEY:-}" \
    node "$APP_ROOT/runtime/mirasim-codex-response-forwarder.cjs"

  start_node_loop mirasim-claude-forwarder env \
    MIRASIM_CLAUDE_FORWARD_HOST="$BRIDGE_HOST" \
    MIRASIM_CLAUDE_FORWARD_PORT="$CLAUDE_PORT" \
    MIRASIM_CLAUDE_TARGET_BASE="http://127.0.0.1:${DIRECT_PORT}" \
    MIRASIM_BRIDGE_API_KEY="${MIRASIM_BRIDGE_API_KEY:-}" \
    node "$APP_ROOT/runtime/mirasim-claude-anthropic-forwarder.cjs"

  start_node_loop mirasim-unified-bridge env \
    MIRASIM_UNIFIED_BRIDGE_HOST="$BRIDGE_HOST" \
    MIRASIM_UNIFIED_BRIDGE_PORT="$UNIFIED_PORT" \
    MIRASIM_CODEX_FORWARD_BASE="http://127.0.0.1:${CODEX_PORT}" \
    MIRASIM_CLAUDE_FORWARD_BASE="http://127.0.0.1:${CLAUDE_PORT}" \
    MIRASIM_BRIDGE_API_KEY="${MIRASIM_BRIDGE_API_KEY:-}" \
    node "$APP_ROOT/runtime/mirasim-unified-bridge.cjs"
fi

if [ "${MIRASIM_CODEX_BRIDGE_WARMUP:-1}" != "0" ]; then
  (
    log="$MIRASIM_HOME/logs/mirasim-codex-warmup.log"
    mkdir -p "$(dirname "$log")"
    echo "[$(date -Iseconds)] waiting for Mirasim web proxy on $MIRASIM_PUBLIC_PORT -> internal $MIRASIM_INTERNAL_PORT" >>"$log" 2>&1
    for i in $(seq 1 60); do
      if curl -sf --max-time 2 "http://127.0.0.1:${MIRASIM_PUBLIC_PORT}/" >/dev/null 2>&1; then break; fi
      sleep 2
    done
    cd "$RES"
    model=${MIRASIM_CODEX_DEFAULT_MODEL:-kimi-k3}
    effort=${MIRASIM_CODEX_DEFAULT_EFFORT:-low}
    echo "[$(date -Iseconds)] warming Codex model-bridge model=$model effort=$effort" >>"$log" 2>&1
    node server.cjs ui-cli --port "$MIRASIM_PUBLIC_PORT" set-default --agent codex --model "$model" --effort "$effort" >>"$log" 2>&1 || true
    node server.cjs ui-cli --port "$MIRASIM_PUBLIC_PORT" prompt --agent codex --cwd "$DATA/workdir" --model "$model" --effort "$effort" --text "Reply exactly WARMED. Do not use tools." --timeout 180000 >>"$log" 2>&1 || true
    echo "[$(date -Iseconds)] warmup done" >>"$log" 2>&1
  ) &
  echo "[entrypoint] codex bridge warmup scheduled" >&2
fi

cd "$RES"
echo "[entrypoint] node=$(node --version) codex=$($MIRASIM_CODEX_BIN --version 2>/dev/null || true) claude=$($MIRASIM_CLAUDE_BIN --version 2>/dev/null || true)" >&2
echo "[entrypoint] web proxy on ${MIRASIM_HOST:-0.0.0.0}:$MIRASIM_PUBLIC_PORT -> Mirasim internal 127.0.0.1:$MIRASIM_INTERNAL_PORT, workdir=$DATA/workdir" >&2
exec "${PROXY_COMMAND[@]}" node ./server.cjs serve --host 127.0.0.1 --port "$MIRASIM_INTERNAL_PORT" --workdir "$DATA/workdir" --no-open --no-im
