FROM debian:bookworm-slim AS unpacker

ARG MIRASIM_DMG_URL
ENV DEBIAN_FRONTEND=noninteractive

RUN unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; \
    apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl p7zip-full findutils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /work
RUN --mount=type=secret,id=mirasim_proxy \
    set -eu; \
    test -n "$MIRASIM_DMG_URL"; \
    unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; \
    proxy="$(cat /run/secrets/mirasim_proxy 2>/dev/null || true)"; \
    case "$proxy" in \
      socks5://*) proxy="socks5h://${proxy#socks5://}" ;; \
      socks5h://*|"") ;; \
      *) echo "MIRASIM_PROXY only supports socks5:// or socks5h://" >&2; exit 1 ;; \
    esac; \
    if [ -n "$proxy" ]; then \
      curl -q -fL --proxy "$proxy" --noproxy '' --retry 5 --retry-delay 2 \
        --write-out '\n[build] Mirasim DMG peer=%{remote_ip}\n' \
        "$MIRASIM_DMG_URL" -o /tmp/mirasim.dmg; \
    else \
      curl -q -fL --proxy '' --noproxy '*' --retry 5 --retry-delay 2 \
        --write-out '\n[build] Mirasim DMG peer=%{remote_ip}\n' \
        "$MIRASIM_DMG_URL" -o /tmp/mirasim.dmg; \
    fi; \
    mkdir -p /tmp/unpack1 /tmp/unpack2 /opt; \
    7z x -y /tmp/mirasim.dmg -o/tmp/unpack1 >/tmp/7z-dmg.log; \
    app="$(find /tmp/unpack1 -maxdepth 6 -type d -name 'Mirasim.app' | head -n 1)"; \
    if [ -z "$app" ]; then \
      inner="$(find /tmp/unpack1 -maxdepth 4 -type f \( -iname '*.hfs' -o -iname '*.img' -o -iname '*.dmg' \) | head -n 1)"; \
      test -n "$inner"; \
      7z x -y "$inner" -o/tmp/unpack2 >/tmp/7z-inner.log; \
      app="$(find /tmp/unpack2 -maxdepth 8 -type d -name 'Mirasim.app' | head -n 1)"; \
    fi; \
    test -n "$app"; \
    cp -a "$app" /opt/Mirasim.app; \
    test -f /opt/Mirasim.app/Contents/Resources/server.cjs; \
    rm -rf /tmp/mirasim.dmg /tmp/unpack1 /tmp/unpack2

FROM node:24-bookworm-slim

LABEL ai.mirasim.docker.revision="bridge-warm-v4"

ENV DEBIAN_FRONTEND=noninteractive \
    APP_ROOT=/app \
    MIRASIM_DATA_DIR=/data \
    MIRASIM_HOST=0.0.0.0 \
    MIRASIM_PORT=4939 \
    MIRASIM_BRIDGE_ENABLED=1 \
    MIRASIM_BRIDGE_HOST=0.0.0.0 \
    MIRASIM_RECORD=0 \
    MIRASIM_QUIET=0

RUN unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; \
    apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates bash curl procps git openssh-client proxychains4 \
 && rm -rf /var/lib/apt/lists/*

COPY runtime/mirasim-proxychains-config.cjs /usr/local/lib/mirasim-proxychains-config.cjs
RUN --mount=type=secret,id=mirasim_proxy \
    set -eu; \
    unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; \
    proxy="$(cat /run/secrets/mirasim_proxy 2>/dev/null || true)"; \
    if [ -n "$proxy" ]; then \
      MIRASIM_PROXY="$proxy" node /usr/local/lib/mirasim-proxychains-config.cjs /tmp/mirasim-proxychains.conf; \
      proxychains4 -q -f /tmp/mirasim-proxychains.conf npm install -g @openai/codex @anthropic-ai/claude-code; \
      rm -f /tmp/mirasim-proxychains.conf; \
    else \
      npm install -g @openai/codex @anthropic-ai/claude-code; \
    fi; \
    codex --version; \
    claude --version

WORKDIR /app
COPY --from=unpacker /opt/Mirasim.app /app/Mirasim.app
COPY runtime /app/runtime
COPY docker-entrypoint.sh /usr/local/bin/mirasim-docker-entrypoint
RUN node /app/runtime/mirasim-server-patch.cjs /app/Mirasim.app/Contents/Resources/server.cjs \
 && node --check /app/Mirasim.app/Contents/Resources/server.cjs \
 && chmod +x /usr/local/bin/mirasim-docker-entrypoint \
 && chmod +x /app/runtime/*.cjs

EXPOSE 4939 12015 12016 12017 12018
ENTRYPOINT ["/usr/local/bin/mirasim-docker-entrypoint"]
