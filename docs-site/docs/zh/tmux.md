# Tmux 会话常驻

安装 tmux 后自动启用。CLI 进程常驻在 tmux session 内，**daemon 重启不中断 CLI**。

![tmux 会话管理](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780033301974_tmux.gif)

## 为什么重要

`botmux restart` 时 worker 进程退出，但 tmux session（及其中的 CLI 进程）保持运行。下次收到消息时 worker 自动 re-attach，**无需 `--resume` 重载上下文**——上下文一直活着，省 token、省时间、不丢状态。

| 事件 | tmux session | CLI 进程 |
|------|-------------|---------|
| `botmux restart` | 存活 | 存活（下次消息 re-attach） |
| `/close` 或关闭按钮 | 销毁 | 终止（SIGHUP） |
| CLI 自行退出 / 崩溃 | 随之关闭 | 已退出（自动用新 session 重启） |

## 直接 attach

```bash
# 交互式会话列表，选择后直接 attach
botmux list

# 手动 attach（会话名 = bmx-<sessionId 前 8 位>）
tmux attach -t bmx-<前8位>
# Ctrl+B, D 退出 attach，不影响 CLI 继续运行

# 强制降级到纯 pty 模式（不使用 tmux）
BACKEND_TYPE=pty botmux start
```

attach 进去后你看到的就是和本地开发完全一致的终端——这也是 botmux 相比"只读输出"方案的关键区别。
