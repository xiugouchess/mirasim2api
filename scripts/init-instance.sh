#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -f .env ]; then
  cp .env.example .env
fi

docker_name=""
case "${1:-}" in
  ""|--force|--new) ;;
  *) docker_name=$1 ;;
esac

if [ -z "$docker_name" ]; then
  docker_name=$(sed -n 's/^DOCKER_NAME=//p' .env | tail -n1 | tr -d '\r' |
    sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
fi

while [ -z "$docker_name" ]; do
  printf '请输入 Docker 名称后缀（例如 demo，将生成 mirasim-demo）: '
  IFS= read -r docker_name
  docker_name=$(printf '%s' "$docker_name" |
    sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
done

if [[ ! "$docker_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo "无效的名称；只能包含小写字母、数字、下划线和连字符。" >&2
  exit 1
fi

tmp=$(mktemp .env.tmp.XXXXXX)
awk -v value="$docker_name" '
  /^DOCKER_NAME=/ {
    if (!updated) print "DOCKER_NAME=" value
    updated = 1
    next
  }
  { print }
  END {
    if (!updated) print "DOCKER_NAME=" value
  }
' .env > "$tmp"
chmod --reference=.env "$tmp" 2>/dev/null || true
mv "$tmp" .env

echo "DOCKER_NAME=$docker_name"
echo "MIRASIM_CONTAINER_NAME=mirasim-$docker_name"
