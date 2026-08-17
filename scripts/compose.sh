#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [ ! -f .env ]; then
  cp .env.example .env
fi

get_env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" .env | tail -n1 | tr -d '\r'
}

export DOCKER_NAME="$(get_env_value DOCKER_NAME)"
export MIRASIM_DMG_URL="$(get_env_value MIRASIM_DMG_URL)"
export MIRASIM_IMAGE="$(get_env_value MIRASIM_IMAGE)"
export MIRASIM_PROXY="$(get_env_value MIRASIM_PROXY)"

if [ -z "$DOCKER_NAME" ]; then
  echo "DOCKER_NAME 未配置，请先运行 bash ./start.sh。" >&2
  exit 1
fi

bash ./scripts/render-ports.sh >/dev/null
exec docker compose -f docker-compose.yml -f .compose.ports.yml "$@"
