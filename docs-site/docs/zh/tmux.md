# Tmux 会话常驻

**tmux 是 botmux 的默认后端**（PTY 已退役、不再自动兜底）。装好 tmux 后，CLI 进程常驻在 tmux session 内，**daemon 重启不中断 CLI**——这是「重启会不会丢上下文」这个高频顾虑的答案：不会。

![tmux 会话管理](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780033301974_tmux.gif)

## 为什么重要

`botmux restart` 时 worker 进程退出，但 tmux session（及其中的 CLI 进程）保持运行。下次收到消息时 worker 自动 re-attach，**无需 `--resume` 重载上下文**——上下文一直活着，省 token、省时间、不丢状态。

> 恢复是「re-attach 到活着的进程」，不是「用 `--resume` 冷启一个新进程」：daemon 重启后会对存活的常驻会话预先以**空 prompt** 重新 fork（只接管、不触发新回合），后续消息或打开终端时也会按需惰性重连。

| 事件 | tmux session | CLI 进程 |
|------|-------------|---------|
| `botmux restart` | 存活 | 存活（下次消息 re-attach，不重载上下文） |
| `/close` 或关闭按钮 | 销毁 | 随 session 一起终止 |
| CLI 自行退出 / 崩溃 | 随之关闭 | 已退出（在同一 worker 内自动用新 session 重启；每分钟崩溃 >3 次则停止自动重启，避免崩溃循环） |

> `/close` / 关闭按钮走的是 `tmux kill-session`——由 tmux 向 pane 内进程发 SIGHUP 收尾，会话与 CLI 一起消失。

## tmux 不可用会怎样

不会静默降级 pty，而是**硬拦截**：起新会话时若本机 tmux 不可用，botmux 拒绝启动并弹一张卡告诉你装 tmux（`brew install tmux` / `apt-get install -y tmux`），附上 `BACKEND_TYPE=pty` 应急开关。已经活着的常驻会话不受一次性探测失败影响，仍可重连。详见 [前置要求](/prerequisites)。

## 直接 attach

```bash
# 交互式会话列表，选择后直接 attach
botmux list

# 手动 attach（会话名 = bmx-<sessionId 前 8 位>）
tmux attach -t bmx-<前8位>
# Ctrl+B, D 退出 attach，不影响 CLI 继续运行
```

attach 进去后你看到的就是和本地开发完全一致的终端——这也是 botmux 相比"只读输出"方案的关键区别。飞书话题、Web 终端、本地 tmux 三处看到的是同一个进程，见 [Web 终端](/web-terminal)。

## 其它后端与显式 pty

默认只有 tmux（默认）与 pty（应急）与你日常相关；`zellij` / `herdr` 也是可选后端，按需通过 `BACKEND_TYPE` 或 per-bot `backendType` 显式启用，不影响默认。`riff` 则不同——它**随 riff CLI 配对启用**（`cliId===riff ⇔ backendType===riff`，强制绑定），不能像 zellij/herdr 那样给普通 CLI 单独选。

```bash
# 显式用纯 pty 模式（不使用 tmux）——仅应急
BACKEND_TYPE=pty botmux start
```

> ⚠️ pty 会话**不跨 daemon 重启存活**：pty 没有可 re-attach 的常驻进程，重启后会话需重载。要「重启不丢上下文」请用默认的 tmux。也可 per-bot 配 `"backendType": "pty"`（见 [bots.json 配置](/bots-json)）。
