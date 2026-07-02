# Dashboard 管控面

命令行 `botmux dashboard` 出一个一次性 token URL，浏览器里跨所有 daemon / 机器人统一管控。

```bash
botmux dashboard
# 输出: http://<lan-ip>:7891/?t=<token>
```

> 每次跑都换一个 token，老 URL 立即失效——一次一密的取链方式。

![Dashboard Groups 面板](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780033300739_dash-groups.png)
<p class="cap">Groups 面板：chat × bot 矩阵，一眼看清哪个群里有哪些机器人</p>

## 功能

- **Sessions**：跨所有 bot 列出活跃 + 已关闭会话，可按 CLI / 状态 / adopt / 文本过滤。点进 detail 可「定位到飞书话题」（机器人在原话题发 📍 标记 + 自动开 chat AppLink）、复制各种 ID、关闭会话；支持多选批量关闭。
- **Schedules**：列出所有定时任务，可 Run now / Pause / Resume。
- **Groups**：一键拉新群、拉 bot 入群、自动转让群主、@ 提醒；解散群聊、bot 退群（关联会话自动清理）。
- **团队 / Roles / Bot Defaults**：团队面板做[跨部署协作](/roles)（邀请别人的部署进团队、跨部署拉群）；Roles 管理各 bot 按群人设；Bot Defaults（Bot 配置）配默认行为（新群 oncall、卡片签名、**默认角色**等）。
- **Workflows 管控面**：Run List 轮询；Run Detail 看 summary / dangling 红区 / node-activity / event timeline / 并发执行 timeline；可直接 cancel run、批准/拒绝 humanGate；Workflow Catalog 列出所有 workflow 并可带参触发。

## 对外只读查询

Dashboard HTTP 服务提供两个可供看板或外部观测端消费的会话读接口：

- `GET /api/sessions`：当前聚合的 active + closed session rows。
- `GET /events`：Dashboard 对外 SSE 流，其中 `session.spawned` 的 `body.session` 和 `session.update` 的 `body.patch` 会携带对应的完整值/变更值。每个 daemon 内部还有只绑定 loopback 的 `/api/events`，这是 Dashboard 聚合器的 IPC，不是对外地址。

会话输出中的下列字段都是**可选字段**，消费者必须兼容旧会话/旧 daemon 不返回它们：

| 字段 | 语义 |
|------|------|
| `backendType` | 最近一次 worker spawn 时记录的有效后端（`pty` / `tmux` / `herdr` / `zellij` / `zmx`），用于过滤/展示；cold resume 后可能随配置切换 |
| `backendSessionName` | 仅受管的持久后端会话才有，当前规则为 `bmx-<sessionId 前 8 位>`；PTY、adopt 会话和部分 legacy row 没有该字段。它是确定性定位信息，**不代表对应进程/socket 当前存活** |
| `titleUpdatedAt` | 标题最后更新的 ISO-8601 时间字符串 |
| `titleSource` | 标题来源标签：`initial` / `user` / `agent` / `cli` / `dashboard` / `system`。仅供展示和调试，**不是可信的身份/审计字段** |

### `publicReadOnly` 与 token 边界

`publicReadOnly` 默认开启。开启时，`GET /api/sessions` 和 `GET /events` 在 Dashboard 监听地址上可以**无 token** 访问，因此会话名称、标题、后端和 row 中的其它元数据都应按可公开信息对待。

- 全部 POST / PATCH / DELETE 写操作、不在只读白名单中的 GET，以及原始 PTY / 诊断日志，始终需要 `botmux dashboard` 生成的当前 token。白名单是 fail-closed 的：新增 GET 不会因公开只读开启就自动暴露。
- 每次运行 `botmux dashboard` 都会轮换 token，之前的链接失效。token 只提供 Dashboard 应用层访问权，不代替主机防火墙、VPN 或反向代理鉴权。
- 不需要无 token 观测时，在 Dashboard 「设置」中关闭「公开只读」。也可先设 `BOTMUX_DASHBOARD_PUBLIC_READONLY=false`；但设置页一旦保存过该开关，`~/.botmux/config.json` 的持久值会优先于环境变量。

## 部署细节

dashboard 走单独 pm2 进程 `botmux-dashboard`，跟 daemon 一起起停。每个 daemon 在 `127.0.0.1` 暴露内部 IPC（仅本机），dashboard 进程做反向代理 + HMAC 鉴权（`~/.botmux/.dashboard-secret`，mode 0600，不下发给浏览器）。
