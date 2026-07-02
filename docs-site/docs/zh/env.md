# 环境变量与文件位置

绝大多数配置走 `bots.json` / dashboard，**不需要动环境变量**。只有少数机器级开关（绑定地址 / 端口 / 后端类型 / 外网地址）走 `~/.botmux/.env`。本页也列出 botmux 的关键文件位置，方便备份 / 排查。

**适用**：dashboard / Web 终端打不开或要改绑定地址、要指定端口、要换 pty/tmux 后端、找配置 / 日志 / 凭证在哪。

## 环境变量（写在 `~/.botmux/.env`）

| 变量 | 默认 | 说明 |
|------|------|------|
| `BOTS_CONFIG` | _(未设置)_ | 指定 bots.json 路径（覆盖默认位置） |
| `WEB_HOST` | `0.0.0.0` | HTTP 服务绑定地址 |
| `WEB_EXTERNAL_HOST` | _(自动探测局域网 IP)_ | 终端链接中的外部主机名/IP（公网/内网域名访问见 [Web 终端](/web-terminal)） |
| `WEB_EXTERNAL_PORT` | _(取本机代理端口)_ | 终端链接中的外部端口，覆盖本机代理端口（`8800 + botIndex`），让中转主机可监听不同端口号；多 bot 时为基准端口，实际取 `WEB_EXTERNAL_PORT + botIndex`（见 [Web 终端](/web-terminal)） |
| `SESSION_DATA_DIR` | `~/.botmux/data` | 会话和队列存储目录 |
| `BACKEND_TYPE` | _(默认 tmux)_ | 显式设 `pty` 用纯 pty 后端兜底（默认始终 tmux，不再自动回落 pty；tmux 不可用会硬拦截弹卡）。pty 不跨 daemon 重启存活 |
| `BOTMUX_FORWARD_FOLLOWUP_WAIT_MS` | `1500` | 话题群新消息等待补充说明的毫秒数；命中同用户、同群且 `root_id` 指向首条消息时合并，设为 `0` 关闭，最大 `10000` |
| `DEBUG` | _(未设置)_ | 设为 `1` 启用调试日志 |
| `GITHUB_TOKEN` | _(未设置)_ | GitHub Releases API 认证 token。用于 Dashboard changelog、更新检查、restart-report 等 botmux 自身发起的 GitHub 请求。优先级高于 `GH_TOKEN`。 |
| `GH_TOKEN` | _(未设置)_ | GitHub Releases API 认证 token 后备变量。仅在 `GITHUB_TOKEN` 未设置时使用。 |

> `GITHUB_TOKEN` / `GH_TOKEN` 可写在调用进程环境，或写入 `~/.botmux/.env` 供 daemon 与独立 Dashboard 进程读取。
> botmux 只把它们用于自身 GitHub 请求，不会自动下发给 worker / agent；如需某个 bot 显式继承 token，需在该 bot 的 `env` 中单独配置。

### Dashboard 相关

| 变量 | 默认 | 说明 |
|------|------|------|
| `BOTMUX_DASHBOARD_HOST` | `0.0.0.0` | dashboard HTTP 绑定地址 |
| `BOTMUX_DASHBOARD_PORT` | `7891` | dashboard HTTP 端口 |
| `BOTMUX_DASHBOARD_EXTERNAL_HOST` | `WEB_EXTERNAL_HOST` 或自动探测 | CLI 输出 URL 用的 host |
| `BOTMUX_PUBLIC_URL` | _(未设置)_ | 自建反代对外基址（`scheme://host[:port]`）。没接中心平台、但自己用 nginx 等把 dashboard 反代到单一公网/内网域名时设它，dashboard / 卡片终端链接改吐 `<基址>/…`、`<基址>/s/<sessionId>`，走 dashboard 前门、无需 per-bot 端口。未设回退本地 `host:port`。必须写在 `~/.botmux/.env`（会话内发起的重启只读文件、不继承 shell） |
| `BOTMUX_DAEMON_IPC_BASE_PORT` | `7892` | 每个 daemon 的 IPC 端口 = base + botIndex |
| `BOTMUX_WORKFLOW_RUNS_DIR` | `~/.botmux/workflow-runs` | workflow run 存储目录 |
| `BOTMUX_DASHBOARD_PUBLIC_READONLY` | `true` | 是否允许无 token 访问 Dashboard 白名单只读 API / SSE；一旦在 Dashboard 设置页保存过该开关，`~/.botmux/config.json` 中的值优先于本环境变量 |

## 文件位置

| 路径 | 说明 |
|------|------|
| `~/.botmux/bots.json` | 机器人配置 |
| `~/.botmux/.env` | 环境变量 |
| `~/.botmux/data/` | 会话数据、消息队列 |
| `~/.botmux/logs/` | Daemon 日志 |
| `~/.botmux/bin/botmux` | 会话内 wrapper 脚本（自动写入） |
| `~/.botmux/lark-scopes.json` | 完整权限申请 JSON |
| `~/.botmux/.dashboard-secret` | dashboard HMAC 密钥（0600） |
