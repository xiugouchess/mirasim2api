#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

ENV_FILE=.env

if command -v flock >/dev/null 2>&1; then
  exec 9<.
  if ! flock -n 9; then
    echo "已有另一个 start.sh 正在操作此项目，请等待其结束后重试。" >&2
    exit 1
  fi
fi

if [ ! -f "$ENV_FILE" ]; then
  cp .env.example "$ENV_FILE"
fi

get_env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n1 | tr -d '\r'
}

set_env_value() {
  local key="$1"
  local value="$2"
  local tmp
  tmp=$(mktemp "${ENV_FILE}.tmp.XXXXXX")

  if ! awk -v key="$key" -v value="$value" '
    $0 ~ ("^" key "=") {
      if (!updated) print key "=" value
      updated = 1
      next
    }
    { print }
    END {
      if (!updated) print key "=" value
    }
  ' "$ENV_FILE" > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi

  chmod --reference="$ENV_FILE" "$tmp" 2>/dev/null || true
  mv "$tmp" "$ENV_FILE"
}

trim() {
  sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

docker_name=$(get_env_value DOCKER_NAME | trim)
if [ -z "$docker_name" ]; then
  while true; do
    printf '请输入 Docker 名称后缀（例如 demo，将生成 mirasim-demo）: '
    if ! IFS= read -r docker_name; then
      echo "无法读取 DOCKER_NAME。" >&2
      exit 1
    fi
    docker_name=$(printf '%s' "$docker_name" | trim)
    if [[ "$docker_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
      break
    fi
    echo "名称只能包含小写字母、数字、下划线和连字符，并且必须以字母或数字开头。" >&2
  done
elif [[ ! "$docker_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo "无效的 DOCKER_NAME=$docker_name；只能包含小写字母、数字、下划线和连字符。" >&2
  exit 1
fi
set_env_value DOCKER_NAME "$docker_name"

proxy_url=$(get_env_value MIRASIM_PROXY | trim)
case "$proxy_url" in
  "")
    mirasim_curl_proxy_args=(--proxy "" --noproxy "*")
    ;;
  socks5://*)
    proxy_url="socks5h://${proxy_url#socks5://}"
    mirasim_curl_proxy_args=(--proxy "$proxy_url" --noproxy "")
    echo "Mirasim SOCKS5 代理: 已启用。"
    ;;
  socks5h://*)
    mirasim_curl_proxy_args=(--proxy "$proxy_url" --noproxy "")
    echo "Mirasim SOCKS5 代理: 已启用。"
    ;;
  *)
    echo "无效的 MIRASIM_PROXY；仅支持 socks5:// 或 socks5h:// 地址。" >&2
    exit 1
    ;;
esac

echo "正在从 https://mirasim.ai/download 检查最新版本..."
release_versions=()
release_urls=()
for attempt in 1 2 3; do
  cache_buster="$(date +%s)-${RANDOM}-${attempt}"
  if ! download_page=$(curl -q -fsSL "${mirasim_curl_proxy_args[@]}" \
    --retry 3 --retry-delay 2 --connect-timeout 10 --max-time 30 \
    -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
    "https://mirasim.ai/download?docker-release-check=${cache_buster}"); then
    continue
  fi

  candidate_url=$(
    awk '
      BEGIN { RS = "<a" }
      /class="[^"]*dl-plat[^"]*"/ && /Mirasim-[0-9.]+-arm64\.dmg/ {
        if (match($0, /href="[^"]*Mirasim-[0-9.]+-arm64\.dmg"/)) {
          print substr($0, RSTART + 6, RLENGTH - 7)
          exit
        }
      }
    ' <<< "$download_page"
  )

  case "$candidate_url" in
    https://cdn-assets.mirasim.ai/mirasim/releases/*/Mirasim-*-arm64.dmg) ;;
    *) continue ;;
  esac

  candidate_file=${candidate_url##*/}
  candidate_version=${candidate_file#Mirasim-}
  candidate_version=${candidate_version%-arm64.dmg}
  if [[ "$candidate_version" =~ ^[0-9]+(\.[0-9]+)+$ ]]; then
    release_versions+=("$candidate_version")
    release_urls+=("$candidate_url")
  fi
done

if [ "${#release_urls[@]}" -eq 0 ]; then
  echo "未能从官网的 dl-plat 下载链接解析 Mirasim ARM64 DMG。" >&2
  exit 1
fi

best_index=0
for ((i = 1; i < ${#release_versions[@]}; i++)); do
  if [ "${release_versions[$i]}" != "${release_versions[$best_index]}" ] &&
     [ "$(printf '%s\n%s\n' "${release_versions[$best_index]}" "${release_versions[$i]}" | sort -V | tail -n1)" = "${release_versions[$i]}" ]; then
    best_index=$i
  fi
done
dmg_url=${release_urls[$best_index]}
version=${release_versions[$best_index]}

current_url=$(get_env_value MIRASIM_DMG_URL)
current_image=$(get_env_value MIRASIM_IMAGE)
current_version=${current_image##*:}
if [[ "$current_version" =~ ^[0-9]+(\.[0-9]+)+$ ]] &&
   [ "$current_url" = "https://cdn-assets.mirasim.ai/mirasim/releases/v${current_version}/Mirasim-${current_version}-arm64.dmg" ] &&
   [ "$(printf '%s\n%s\n' "$current_version" "$version" | sort -V | tail -n1)" = "$current_version" ] &&
   [ "$current_version" != "$version" ]; then
  echo "官网节点返回较旧版本 $version，保留当前已记录的 $current_version。"
  version=$current_version
  dmg_url=$current_url
fi

image="mirasim-node-bridge:${version}"
set_env_value MIRASIM_DMG_URL "$dmg_url"
set_env_value MIRASIM_IMAGE "$image"

echo "最新版本: $version"
echo "容器名称: mirasim-$docker_name"
exec bash ./scripts/up.sh "$@"
