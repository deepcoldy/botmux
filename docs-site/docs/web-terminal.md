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
