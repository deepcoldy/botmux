# CLI 命令

在终端里管理 daemon 和会话。

| 命令 | 说明 |
|------|------|
| `botmux setup` | 交互式配置（首次 / 添加 / 编辑 / 删除机器人） |
| `botmux start` | 启动 daemon（PM2 管理） |
| `botmux stop` | 停止 daemon |
| `botmux restart [--include-pm2]` | 重启 daemon（自动恢复活跃会话）；`--include-pm2` 会同时重启 botmux 专用 PM2 God daemon |
| `botmux logs [--lines N]` | 查看日志 |
| `botmux status` | 查看 daemon 状态 |
| `botmux upgrade` | 升级到最新版本 |
| `botmux list` (别名 `ls`) | 列出所有活跃会话 |
| `botmux delete <id>` (别名 `del`/`rm`) | 关闭指定会话，支持 ID 前缀匹配 |
| `botmux delete all` | 关闭所有活跃会话 |
| `botmux delete stopped` | 清理进程已退出的僵尸会话 |
| `botmux dashboard` | 输出一次 Web Dashboard URL（每次刷 token） |

## 开机自启

```bash
botmux autostart enable   # 注册（macOS launchd / Linux user systemd，无需 sudo）
botmux autostart disable  # 注销
botmux autostart status   # 查看状态
```

- **macOS**：写 `~/Library/LaunchAgents/com.botmux.daemon.plist`，`launchctl bootstrap` 加载。
- **Linux**：写 `~/.config/systemd/user/botmux.service`，`systemctl --user enable --now`。
  - 服务器/无桌面环境登出会停服务，需跨登出常驻请 `sudo loginctl enable-linger <用户名>`。
- 单元文件里的 `node`/`cli.js` 路径来自当前 `process.execPath`，nvm/fnm 切版本后跑一次 `enable` 重写即可（`start`/`restart` 也会自动检测路径变化原地刷新）。
- `enable`/`disable` **只管自启钩子，不动正在跑的 daemon**——避免"只想关自启结果服务也被干掉"。

## 会话内子命令（给 CLI agent 用）

session 信息通过祖先进程标记自动推断，agent 直接调：

| 命令 | 说明 |
|------|------|
| `botmux send [content]` | 向当前话题发消息（stdin / heredoc / `--content-file`；`--images`/`--files`/`--mention`） |
| `botmux bots list` | 列出当前群里的机器人（含 open_id） |
| `botmux history [--limit N]` | 拉会话历史（JSON） |
| `botmux quoted <message_id>` | 拉被引用的单条消息（JSON） |
| `botmux schedule add/list/remove/pause/resume/run` | 管理定时任务 |
