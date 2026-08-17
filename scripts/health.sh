#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
get_env() {
  key="$1"
  if [ -f .env ]; then
    sed -n "s/^${key}=//p" .env | tail -n1
  fi
}
is_enabled() {
  v=$(get_env "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
  case "$v" in 1|true|yes|on|enable|enabled) return 0 ;; *) return 1 ;; esac
}
if [ $# -eq 0 ] && ! is_enabled MIRASIM_PUBLISH_UNIFIED; then
  echo "MIRASIM_PUBLISH_UNIFIED=0, unified port is not published. Pass an explicit base URL if needed." >&2
  exit 2
fi
host=$(get_env MIRASIM_UNIFIED_HOST)
host=${host:-127.0.0.1}
if [ "$host" = "0.0.0.0" ] || [ "$host" = "::" ]; then host=127.0.0.1; fi
port=$(get_env MIRASIM_UNIFIED_HOST_PORT)
port=${port:-12015}
base=${1:-http://${host}:${port}}
key=$(get_env MIRASIM_BRIDGE_API_KEY)
key=${key:-password}
echo "health: $base/__mira/health"
curl -q -sS --proxy '' --noproxy '*' -H "x-api-key: $key" "$base/__mira/health" | sed -n '1,160p'
