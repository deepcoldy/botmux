# 持久会话后端

Botmux 可以把 CLI 进程放在持久后端里运行。这样 daemon/worker 重启时，底层 CLI 仍留在原 session 中；下一条消息到来时，worker 会重新接上同一个进程。

## 后端选择

`backendType` 为空时，botmux 会优先自动使用 tmux；没有 tmux 时回落到 `pty`。Herdr 和 Zellij 不会被自动选择，需要在 bot 配置里显式设置：

```json
{
  "backendType": "herdr"
}
```

`tmux`、`herdr`、`zellij` 都是持久后端；`pty` 是直连进程，不跨 daemon 重启持久。

## 生命周期

| 事件 | 持久 session | CLI 进程 |
|------|-------------|---------|
| `botmux restart` | 存活 | 存活（下次消息 re-attach） |
| `/close`、关闭按钮、`botmux delete` | 销毁 | 终止 |
| CLI 自行退出 / 崩溃 | 随之关闭 | 已退出（自动用新 session 重启） |

## 连接会话

```bash
# 交互式会话列表，选择后连接该 bot 的后端
botmux list

# 手动连接 tmux 后端
tmux attach -t bmx-<前8位>

# 手动连接 Herdr 后端
herdr session attach bmx-<前8位>
```

`botmux list` 会根据 bot 的 `backendType` 识别目标后端；`botmux delete` 也会关闭对应的后端 session。

如果想在 Herdr 客户端内运行 `botmux list` 并跳进另一个 Herdr session，需要在 Herdr 配置里开启 `[experimental] allow_nested = true`。进入目标 session 后请使用 Herdr detach 退出视图；关闭 pane/workspace 会关闭真实 agent。
