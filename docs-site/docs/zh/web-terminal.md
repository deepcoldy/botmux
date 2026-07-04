# Web 终端（可交互）

每个会话都带一个基于 xterm.js 的 Web 终端，地址形如 `http://<WEB_EXTERNAL_HOST>:<端口>`。

![Web 终端](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780033301701_web_terminal.gif)

## 两种链接

| 链接 | 来源 | 能力 |
|------|------|------|
| **只读链接** | 自动展示在流式卡片上 | 随时查看进度，不能输入 |
| **可操作链接** | 点卡片「🔑 获取操作链接」，经私聊发送 | 可直接在浏览器里操作 CLI |

## 移动端

平板/手机上提供**悬浮快捷键工具栏**：`Esc`、`Ctrl+C`、`Tab`、方向键等，手机上也能流畅操控 CLI（比如在 Claude Code 里选菜单、确认权限）。

## 三端同步

飞书话题、Web 终端、本地 tmux 三处看到的是**同一个** CLI 进程的实时状态。在电脑 tmux 里敲、在手机 Web 终端里敲、在飞书里发消息，效果一致。

## 远程访问（公网 / 内网域名）

默认链接使用自动探测的局域网 IP，仅同网段可达。手机不与运行 botmux 的机器同网时，可把链接指向一台双方都可达的主机：

**情形一：botmux 直接跑在云主机上**

在 `~/.botmux/.env` 设置 `WEB_EXTERNAL_HOST=<云主机公网域名或IP>`，`botmux restart` 后卡片上的终端链接即对外可用。

**情形二：botmux 跑在本地，经中转主机转发**（云主机 / 公司内网机器均可）

```bash
# 1. 终端链接指向中转主机（写入 ~/.botmux/.env 后 botmux restart）
WEB_EXTERNAL_HOST=<中转主机域名或IP>

# 2. 本机 → 中转主机 反向隧道（在运行 botmux 的机器上执行）
autossh -M 0 -f -N -R 18800:localhost:8800 user@relay-host

# 3. 中转主机把对外端口桥接到隧道（sshd 多默认禁 GatewayPorts，故用用户态桥接）
socat TCP-LISTEN:8800,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:18800
```

注意事项：

- 链接中的端口默认取本机终端代理实际监听的端口（`8800 + botIndex`），此时**中转主机须监听同号端口**（如上例两端都用 `8800`）
- 想让中转主机用**不同端口号**对外（如本机代理在 `8800`、中转主机想用 `9000`），在 `~/.botmux/.env` 设 `WEB_EXTERNAL_PORT=9000` 后 `botmux restart`，卡片链接即改用该端口（上例 socat 改成 `TCP-LISTEN:9000`）；多 bot 部署时它是**基准端口**，第 N 个 bot 实际取 `WEB_EXTERNAL_PORT + botIndex`，与本机 `8800 + botIndex` 一一对应，中转主机按各自端口分别桥接即可
- Web 终端的 WebSocket 按页面地址同源连接，TCP 级转发即可透传，无需额外配置
- 只读链接无凭证即可查看；把端口暴露到更大网络前请评估可见范围，可写操作始终需要 🔑 链接中的 token
