# Mirasim Docker 使用说明

启动后打开 Web 页面登录 Mirasim 账号即可。登录数据保存在当前目录的 `./data`，包里不内置账号凭据。

## 启动

Linux：

```bash
bash ./start.sh
```

`start.sh` 每次启动都会从 `https://mirasim.ai/` 获取当前 macOS ARM64 DMG，提取版本号并更新 `.env` 中的 `MIRASIM_DMG_URL` 和 `MIRASIM_IMAGE`。

第一次启动时，如果 `.env` 没有配置 `DOCKER_NAME`，脚本会提示输入名称。例如输入 `demo` 后：

```env
DOCKER_NAME=demo
```

最终容器名固定为 `mirasim-demo`。

本地没有最新版镜像时会自动构建。如果同名容器仍使用旧版镜像，脚本会用最新版镜像重建并启动该容器，然后尝试以非强制方式清理旧镜像。旧镜像仍被其他容器使用时会保留，不影响其他容器运行。

同一项目目录只允许一个 `start.sh` 运行；重复启动会直接退出，避免并发构建或替换同一容器。

Codex API bridge 默认在容器启动时预热，并保持 Mirasim 的 model-bridge 常驻，避免其空闲 10 分钟后被回收而返回 `503 no Mirasim model-bridge found`。启动期间的 API 请求会等待最多 180 秒让预热完成；对应配置为：

预热只在每次容器启动时发送一次固定的 Codex 请求；进入常驻状态后不会定时调用模型。

Codex forwarder 也会把带顶层 `instructions`、简化 `input` 消息或流式字符串 `input` 的兼容请求转换为 Mirasim 0.0.197 router 接受的原生 Responses 结构。

```env
MIRASIM_CODEX_BRIDGE_WARMUP=1
MIRASIM_CODEX_KEEP_WARM=1
MIRASIM_CODEX_BRIDGE_WAIT_MS=180000
```

## 出站代理

`.env` 只使用一个代理配置：

```env
MIRASIM_PROXY=socks5://username:password@proxy.example.com:1080
```

留空时，官网版本检查、官方 DMG 下载和容器运行时均不使用项目代理：

```env
MIRASIM_PROXY=
```

填写 `socks5://` 或 `socks5h://` 后：

- `start.sh` 访问 `mirasim.ai` 时强制使用该代理，并通过代理解析 DNS。
- 构建阶段下载 Mirasim 官方 DMG 时通过 BuildKit secret 使用该代理，凭据不会写入镜像层。
- 容器内 Mirasim、Direct Relay、Codex/Claude forwarder 通过 `proxychains4` 的严格链和远端 DNS 运行；代理不可用时不会回退直连。
- `127.0.0.1`、`localhost` 和 `::1` 保持容器内部直连，确保本地 bridge 正常通信。

Docker 基础镜像拉取和安装 `proxychains4` 的引导步骤由 Docker daemon/系统包管理器负责，不受项目内 `MIRASIM_PROXY` 控制。如这些流量也必须代理，需要另外配置 Docker daemon 的代理。

## 登录

启动后访问 Web：

```text
http://服务器IP:4939
```

如果改了 `.env` 里的 `MIRASIM_WEB_HOST_PORT`，就访问对应端口。

## 端口开关

默认只发布两个端口：

```text
4939   Web UI
12015  Unified Bridge
```

专用 Codex / Claude 端口默认不发布。如果需要，改 `.env`：

```env
MIRASIM_PUBLISH_WEB=1
MIRASIM_PUBLISH_UNIFIED=1
MIRASIM_PUBLISH_CODEX=0
MIRASIM_PUBLISH_CLAUDE=0
```

含义：

| 开关 | 默认 | 说明 |
|---|---:|---|
| `MIRASIM_PUBLISH_WEB` | `1` | 发布 Web UI |
| `MIRASIM_PUBLISH_UNIFIED` | `1` | 发布通用 bridge |
| `MIRASIM_PUBLISH_CODEX` | `0` | 发布 Codex 专用 bridge |
| `MIRASIM_PUBLISH_CLAUDE` | `0` | 发布 Claude 专用 bridge |

`1` 表示发布到宿主机，`0` 表示关闭映射。

修改 `.env` 后，用脚本启动或重启：

```bash
bash ./scripts/compose.sh up -d
```

脚本会根据 `.env` 自动生成 `.compose.ports.yml`。不要直接手改 `.compose.ports.yml`。

## 端口配置

`.env` 里配置的是宿主机外部监听地址和端口：

```env
MIRASIM_WEB_HOST=0.0.0.0
MIRASIM_WEB_HOST_PORT=4939

MIRASIM_UNIFIED_HOST=127.0.0.1
MIRASIM_UNIFIED_HOST_PORT=12015

MIRASIM_CODEX_HOST=127.0.0.1
MIRASIM_CODEX_HOST_PORT=12017

MIRASIM_CLAUDE_HOST=127.0.0.1
MIRASIM_CLAUDE_HOST_PORT=12018
```

容器内部端口固定：

| 内部端口 | 用途 |
|---:|---|
| `4939` | Web UI，对外入口；内部会代理到 Mirasim `127.0.0.1:4938` |
| `12015` | Unified Bridge，同时支持 Codex / Claude |
| `12017` | Codex Bridge，OpenAI/Codex 格式 |
| `12018` | Claude Bridge，Anthropic/Claude Code 格式 |
| `12016` | 内部 Direct Relay，不映射宿主机 |

## Bridge API Key

公网暴露 bridge 时改这个：

```env
MIRASIM_BRIDGE_API_KEY=password
```

它只保护 `12015 / 12017 / 12018`，不影响 Web UI 登录。

请求头任选一种：

```text
Authorization: Bearer <MIRASIM_BRIDGE_API_KEY>
x-api-key: <MIRASIM_BRIDGE_API_KEY>
api-key: <MIRASIM_BRIDGE_API_KEY>
```

## 客户端地址

默认推荐用 Unified Bridge。

Codex：

```text
Base URL: http://服务器IP:12015/v1
API Key:  .env 里的 MIRASIM_BRIDGE_API_KEY
```

Claude Code：

```text
Base URL: http://服务器IP:12015
API Key:  .env 里的 MIRASIM_BRIDGE_API_KEY
```

如果开启了专用端口，也可以用：

```text
Codex:  http://服务器IP:12017/v1
Claude: http://服务器IP:12018
```

## 多开

每份项目目录在 `.env` 中设置不同的 `DOCKER_NAME`，即可得到不同的固定容器名：

```env
DOCKER_NAME=demo
```

对应容器名为 `mirasim-demo`。多开时除了 `DOCKER_NAME` 不同，外部端口也必须不同，否则会冲突。

## 常用命令

```bash
bash ./scripts/compose.sh ps
bash ./scripts/compose.sh logs -f
bash ./scripts/compose.sh down
bash ./scripts/health.sh
```
