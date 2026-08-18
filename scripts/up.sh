#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

get_env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" .env | tail -n1 | tr -d '\r'
}

docker_name=$(get_env_value DOCKER_NAME)
target_image=$(get_env_value MIRASIM_IMAGE)
target_container="mirasim-${docker_name}"
expected_project="mirasim-${docker_name}"
expected_image_revision="bridge-warm-v4"

if [ -z "$docker_name" ] || [ -z "$target_image" ]; then
  echo "DOCKER_NAME 或 MIRASIM_IMAGE 未配置，请通过 start.sh 启动。" >&2
  exit 1
fi

source_container="$target_container"
if ! docker container inspect "$source_container" >/dev/null 2>&1 && [ -f .instance.env ]; then
  legacy_container=$(sed -n 's/^MIRASIM_CONTAINER_NAME=//p' .instance.env | tail -n1 | tr -d '\r')
  if [[ "$legacy_container" =~ ^mirasim-[0-9]+-[a-f0-9]{4}$ ]] &&
     docker container inspect "$legacy_container" >/dev/null 2>&1; then
    source_container="$legacy_container"
    echo "发现旧容器 $legacy_container，将迁移为 $target_container。"
  fi
fi
if ! docker container inspect "$source_container" >/dev/null 2>&1; then
  legacy_container=$(docker ps -a \
    --filter "label=com.docker.compose.project.working_dir=$PWD" \
    --format '{{.Names}} {{.Image}}' | awk '
      $1 ~ /^mirasim-[0-9]+-[a-f0-9][a-f0-9][a-f0-9][a-f0-9]$/ && $2 ~ /^mirasim-node-bridge:/ {
        name = $1
        count++
      }
      END { if (count == 1) print name }
    ')
  if [ -n "$legacy_container" ] && docker container inspect "$legacy_container" >/dev/null 2>&1; then
    source_container="$legacy_container"
    echo "发现同一项目目录的旧容器 $legacy_container，将迁移为 $target_container。"
  fi
fi

previous_image_id=""
current_image_ref=""
current_project=""
if docker container inspect "$source_container" >/dev/null 2>&1; then
  previous_image_id=$(docker inspect --format '{{.Image}}' "$source_container")
  current_image_ref=$(docker inspect --format '{{.Config.Image}}' "$source_container")
  current_project=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$source_container")
fi

needs_recreate=0
if [ -n "$previous_image_id" ]; then
  needs_recreate=1
  if [ "$source_container" = "$target_container" ] &&
     [ "$current_image_ref" = "$target_image" ] &&
     [ "$current_project" = "$expected_project" ]; then
    needs_recreate=0
  fi
fi

target_image_id=$(docker image inspect --format '{{.Id}}' "$target_image" 2>/dev/null || true)
target_image_revision=$(docker image inspect --format '{{ index .Config.Labels "ai.mirasim.docker.revision" }}' "$target_image" 2>/dev/null || true)
if [ -z "$target_image_id" ] || [ "$target_image_revision" != "$expected_image_revision" ]; then
  if [ -z "$target_image_id" ]; then
    echo "本地没有 $target_image，开始构建。"
  else
    echo "$target_image 缺少当前 Docker 修订 $expected_image_revision，将重新构建。"
  fi
  bash ./scripts/compose.sh build mirasim
  target_image_id=$(docker image inspect --format '{{.Id}}' "$target_image")
  target_image_revision=$(docker image inspect --format '{{ index .Config.Labels "ai.mirasim.docker.revision" }}' "$target_image")
  if [ "$target_image_revision" != "$expected_image_revision" ]; then
    echo "构建后的镜像修订不正确：$target_image_revision" >&2
    exit 1
  fi
fi

bash ./scripts/compose.sh config >/dev/null

if [ -n "$previous_image_id" ]; then
  if [ "$source_container" != "$target_container" ] ||
     [ "$previous_image_id" != "$target_image_id" ] ||
     [ "$current_image_ref" != "$target_image" ] ||
     [ "$current_project" != "$expected_project" ]; then
    needs_recreate=1
  fi
fi

if [ "$needs_recreate" = "1" ]; then
  echo "使用 $target_image 替换容器 $source_container。"
  docker rm -f "$source_container" >/dev/null
fi

bash ./scripts/compose.sh up -d --no-build "$@"

# runtime/ is bind-mounted into the container. When the image and container
# identity are unchanged, restart the existing process so updated bridge code
# is loaded without rebuilding the Mirasim image.
if [ "$#" -eq 0 ] && [ -n "$previous_image_id" ] && [ "$needs_recreate" = "0" ]; then
  echo "镜像未变化，重启容器以加载映射的 runtime 代码。"
  bash ./scripts/compose.sh restart mirasim
fi

cleanup_image=""
if [ -n "$current_image_ref" ] && [ "$current_image_ref" != "$target_image" ]; then
  cleanup_image=$current_image_ref
elif [ -n "$previous_image_id" ] && [ "$previous_image_id" != "$target_image_id" ]; then
  cleanup_image=$previous_image_id
fi

if [ -n "$cleanup_image" ]; then
  if docker image rm "$cleanup_image" >/dev/null 2>&1; then
    echo "已清理旧镜像 $cleanup_image。"
  else
    echo "旧镜像 $cleanup_image 仍被使用或暂时无法删除，已保留。"
  fi
fi
