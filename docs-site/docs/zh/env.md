# 环境变量与文件位置

## 环境变量（写在 `~/.botmux/.env`）

| 变量 | 默认 | 说明 |
|------|------|------|
| `BOTS_CONFIG` | _(未设置)_ | 指定 bots.json 路径（覆盖默认位置） |
| `WEB_HOST` | `0.0.0.0` | HTTP 服务绑定地址 |
| `WEB_EXTERNAL_HOST` | _(自动探测局域网 IP)_ | 终端链接中的外部主机名/IP（公网/内网域名访问见 [Web 终端](/web-terminal)） |
| `WEB_EXTERNAL_PORT` | _(取本机代理端口)_ | 终端链接中的外部端口，覆盖本机代理端口（`8800 + botIndex`），让中转主机可监听不同端口号；多 bot 时为基准端口，实际取 `WEB_EXTERNAL_PORT + botIndex`（见 [Web 终端](/web-terminal)） |
| `SESSION_DATA_DIR` | `~/.botmux/data` | 会话和队列存储目录 |
| `BACKEND_TYPE` | _(自动检测)_ | `pty` 强制降级到纯 pty 模式 |
| `DEBUG` | _(未设置)_ | 设为 `1` 启用调试日志 |

### Dashboard 相关

| 变量 | 默认 | 说明 |
|------|------|------|
| `BOTMUX_DASHBOARD_HOST` | `0.0.0.0` | dashboard HTTP 绑定地址 |
| `BOTMUX_DASHBOARD_PORT` | `7891` | dashboard HTTP 端口 |
| `BOTMUX_DASHBOARD_EXTERNAL_HOST` | `WEB_EXTERNAL_HOST` 或自动探测 | CLI 输出 URL 用的 host |
| `BOTMUX_DAEMON_IPC_BASE_PORT` | `7892` | 每个 daemon 的 IPC 端口 = base + botIndex |
| `BOTMUX_WORKFLOW_RUNS_DIR` | `~/.botmux/workflow-runs` | workflow run 存储目录 |

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
