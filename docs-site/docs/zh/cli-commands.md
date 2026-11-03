# CLI 命令

在终端里管理 daemon 和会话。

| 命令 | 说明 |
|------|------|
| `botmux setup` | 交互式配置（首次 / 添加 / 编辑 / 删除机器人） |
| `botmux start [--companion-secret-file <path> --companion-bot <appId>]` | 启动 daemon；两个 companion 参数同时提供时，为唯一绑定的隔离测试 Bot 开启封闭本机 API（见[本地 Companion API](/companion-api)） |
| `botmux stop` | 停止 daemon |
| `botmux restart [--companion-secret-file <path> --companion-bot <appId>]` | 重启 daemon（自动恢复活跃会话）；接受与 `start` 相同的封闭 Companion API 参数 |
| `botmux logs [--lines N]` | 查看日志 |
| `botmux status` | 查看 daemon 状态 |
| `botmux upgrade` | 升级到最新版本 |
| `botmux list` (别名 `ls`) | 交互式列出活跃会话；选中受管 tmux / ZMX 会话后按 Enter 可 attach（脚本使用 `--plain`） |
| `botmux delete <id>` (别名 `del`/`rm`) | 关闭指定会话，支持 ID 前缀匹配 |
| `botmux delete all` | 关闭所有活跃会话 |
| `botmux delete stopped` | 清理进程已退出的僵尸会话 |
| `botmux maintenance suspend-idle --dry-run\|--yes` | 按最后活动时间预览或批量休眠长期空闲会话（默认 7 天） |
| `botmux dashboard [current\|rotate]` | 获取当前 Dashboard 登录 URL，尚无 token 时创建第一个；`rotate` 才显式替换已有 token |

daemon 在线时，`botmux delete` 会先请求会话所属 daemon 执行与 `/close`
一致的生命周期收口：移除内存中的活跃会话、持久化关闭状态，并回收
worker、后端与订阅。仅当所属 daemon 确认不在线时才使用本地收口；在线
daemon 拒绝或 IPC 连接失败时命令返回失败，不会继续本地强杀。

当 `BOTMUX_COORDINATION_MODE=primary` 时，PostgreSQL 中的 durable Session 才是 canonical truth。此模式下 `delete`、`resume`、非 dry-run 的 `suspend`、`maintenance suspend-idle`，以及交互式 `list` 中的删除/唤醒都会明确拒绝；`list` 仍可只读展示，但会跳过本地自动清理。关闭或恢复请在原话题使用会话卡片，确保操作经过带 fencing 的 durable session-control 通道。

## 空闲会话维护

```bash
botmux maintenance suspend-idle --older-than 7d --dry-run
botmux maintenance suspend-idle --older-than 7d --yes
```

`--dry-run` 只读取在线 daemon 的权威运行态，不会修改会话或进程；输出包含会话、Bot、标题、最后活动时间、worker PID、持久后端目标与预计回收的进程类型。执行必须显式传 `--yes`，并通过 daemon 内部的同一 `suspendWorker` 路径完成：先精确销毁持久后端并 post-probe 确认 missing，才把逻辑会话持久化为 active + dormant；下一条消息从 transcript 冷恢复。销毁结果为 `exists` 或 `unknown` 时 fail closed，不会谎报休眠成功。

候选会 fail closed：只选择 worker 已就绪、屏幕明确 idle、后端可恢复且最后活动时间已知的会话；adopt、锁定、待选仓库、排队输入、未结算 dispatch、需要用户处理和正在转移的会话都会跳过。`--bot <appId>` 可限定单个 Bot，`--json` 输出机器可读结果。Dashboard 的 per-bot「空闲自动休眠」配置仍负责周期策略；本命令提供人工预览和批量执行入口。

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
| `botmux send [content]` | 向当前话题发消息（stdin / heredoc / `--content-file`；`--images`/`--files`/`--videos`/`--card-file`/`--card-json`/`--mention`） |
| `botmux card patch --message-id <om_xxx> (--card-file <path> \| --card-json <json>)` | 原地更新之前 send 发出的自定义卡片（不发新消息，messageId 取自 send 输出） |
| `botmux bots list` | 列出当前群里的机器人（含 open_id）；`--scope team [--team <id>]` 跨机发现同团队、已 opt-in 的 agent（按专长） |
| `botmux bots invite --chat <chatId> --team <id> --agent <appId>...` | 往「你已在场」的群补入同团队 agent + 各自 owner（平台 app 不在时自动拉进群再补） |
| `botmux history [--limit N]` | 拉会话历史（JSON） |
| `botmux quoted <message_id>` | 拉被引用的单条消息（JSON） |
| `botmux schedule add/list/update/remove/pause/resume/run` | 管理定时任务 |
| `botmux session rename "<标题>"` | 改**当前会话**的 botmux 规范标题（会话自动识别，不接受 `--session-id` 指定他人会话）；Dashboard 与 `/sessions` 列表即时更新，并 best-effort 同步 CLI 原生会话名。飞书群名、omt 话题名均不变（话题名平台无接口）。建议「类型｜具体事项」，最长 200 字符 |
| `botmux chat rename <新群名称> [--proactive]` | 改**当前会话所在飞书群**的群名（话题群里是整个 `oc_` 群，全部话题/成员可见）；`--proactive` 用于 agent 因阶段变化主动改名，带 10 分钟防抖 |
