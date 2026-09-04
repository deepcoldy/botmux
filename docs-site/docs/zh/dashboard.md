# Dashboard 管控面

命令行 `botmux dashboard` 输出当前的轮换式登录 token URL，浏览器里跨所有 daemon / 机器人统一管控。

```bash
botmux dashboard          # 获取当前 URL；尚无 token 时创建第一个
botmux dashboard current  # 同一操作的显式写法
botmux dashboard rotate   # 轮换 token 并输出新 URL
# 已绑定中心化平台: https://m-<machineId>.<平台域名>/          ← 不带 token
# 其余情况(局域网 / 自建反代 / Devbox 短链): …/?t=<token>      ← 带 token
```

> 这是**轮换式登录 token**：一条 URL 会一直有效，直到 `botmux dashboard rotate` 生成新 token、让旧 URL 失效；token 会持久化、`botmux restart` 后仍有效。裸命令/current 会复用这个 token，尚无 token 时创建第一个。成功访问 `?t=` 只是把同一 token 写进 cookie，不消费/作废它，轮换前同一 URL 可重复登录——所以分享链接≈分享登录态，注意保管。默认端口 `7891`，可用 `BOTMUX_DASHBOARD_PORT` 改。

### 链接里什么时候带 token

| 状态 | 主链接形态 | 为什么 |
|---|---|---|
| **已绑定中心化平台**（远程访问开 + 已 bind） | `https://m-<machineId>.<平台域名>/` —— **不带 token** | 走平台子域时身份由平台注入并先过 SSO，`?t=` 会被服务端压制成无效（带上也是 401），token 对访问零贡献、只剩泄漏风险。真人 owner 是被平台认出来的 |
| 自建反代 `BOTMUX_PUBLIC_URL` / Devbox 短链 | `https://<你的域名>/?t=<token>` —— **带 token** | 这两条只是把请求反代到本机 dashboard，**没有人注入身份**，token 仍是唯一凭证；且平台登录出口在未绑定时不存在，去掉就进不去了 |
| 未配任何远程基址（纯局域网 `ip:port`） | `http://<lan-ip>:7891/?t=<token>` —— **带 token** | 同上：去掉后只剩一个静态壳 |

⚠️ 判据是「**是否由中心平台托管**」，不是「有没有远程基址」—— 后者会把自建反代和 Devbox 短链一起误判成可以去 token，而那两条路去掉 token 会变成打不开的死链。

这个判据由 **dashboard 进程在 `/__cli/*` 响应里如实标注**（`platformHosted` 字段），CLI 不自己推断：只有 dashboard 知道它实际用了哪条基址，调用方各自推断会与它不一致。字段缺失（旧版 dashboard）或不是严格 `true` 时一律**保留** token —— 少去一次只是维持现状，多去一次可能让 owner 完全进不去。

绑定平台后，那条带 token 的本地直连链接**默认不再打印**（它是平台异常时的兜底）。确实需要用 `ip:port + token` 方式管理时，加一个刻意起得很长的参数即可取回——参数名会在命令输出里提示，只给人看，不进 `--help`：这是为了避免 AI 顺手带上它、把 token 带进思考过程或聊天记录。

⚠️ **Dashboard 链接等同管理员凭证**：只发给 owner 本人，不要在多人群里发带 `?t=` 的链接（聊天记录会长期留存、可被转发截图）。给别人指路时只说「在服务器上运行 `botmux dashboard`」，让对方自己取。命令输出末尾也钉了一段给 AI 读的安全提示，让模型在决定「要不要把这条链接发出去」时就能读到这条规则。怀疑泄漏时 `botmux dashboard rotate`，所有旧链接当场失效。

![Dashboard Groups 面板](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780033300739_dash-groups.png)
<p class="cap">Groups 面板：chat × bot 矩阵，一眼看清哪个群里有哪些机器人</p>

## 功能

- **Sessions**：跨所有 bot 列出活跃 + 已关闭会话，可按 CLI / 状态 / adopt / 文本过滤。点进 detail 可复制各种 ID、关闭会话、多选批量关闭；「定位话题」会让机器人在原话题发一条 **@会话 owner** 的提醒（纯 @、无其它正文）帮你跳回上下文。chat-scope 的会话行还带一个飞书群 AppLink 直达群聊。
- **Schedules**：新建、编辑和管理定时任务，支持立即运行、暂停/恢复、多个目标群、执行日志，以及可测试的 [Bash 前置条件](/schedule#bash-前置条件dashboard)。
- **Groups**：一键拉新群（自动 @ 通知被邀请人）、拉 bot 入群、自动转让群主；解散群聊、bot 退群（关联会话自动清理）。
- **团队 / Roles / Bot Defaults**：团队面板做[跨部署协作](/roles)（邀请别人的部署进团队、跨部署拉群）；Roles 管理各 bot 按群人设；Bot Defaults（Bot 配置）配默认行为（新群 oncall、卡片签名、**默认角色**等）。
- **Workflows 管控面**：Run List 轮询；Run Detail 看 summary / dangling 红区 / node-activity / event timeline / 并发执行 timeline；可直接 **cancel run**。
- **设置 / 系统与维护**：已认证管理员可管理「开机启动 botmux 后台服务」。

> **两件事在 Dashboard 之外**：v3 workflow 的 **humanGate 批准 / 拒绝** 走**飞书审批卡**（不在 Dashboard 上点）；带参触发 workflow 目前是**接入点（Webhook）** 那条路径（见 [接入点](/webhook)），Dashboard 没有「Workflow Catalog 带参触发」页。Dashboard 的 Workflows 面板专注观测与 cancel。

## 后台服务开机启动

已认证管理员可在「设置 → 系统与维护」中管理 botmux 后台服务的开机自启；匿名用户不能查看或修改这项设置。

该开关复用现有 `botmux autostart` 能力，只管理下次开机/登录时使用的启动项，不会启动、停止或重启当前 daemon。

## 对外只读查询

这里重点说明三个对外观测接口：

- `GET /api/dashboard/v1/summary`：版本化、强脱敏的 fleet 运行摘要。
- `GET /api/sessions`：当前聚合的 active + closed session rows。
- `GET /events`：Dashboard 对外 SSE 流，其中 `session.spawned` 的 `body.session` 和 `session.update` 的 `body.patch` 会携带对应的完整值/变更值。每个 daemon 内部还有只绑定 loopback 的 `/api/events`，这是 Dashboard 聚合器的 IPC，不是对外地址。

### Dashboard Summary API

`GET /api/dashboard/v1/summary` 用于把普通 botmux fleet 的守护进程作为常驻服务接入外部状态页、监控或编排器。它直接汇总当前在线 daemon 的 live sessions / schedules，只输出正向白名单中的状态和计数；不会返回 bot / session ID、标题、群名、工作目录、提示词、排程内容或诊断日志。它的 200、429、503 响应都带 `Cache-Control: no-store`。

> 这是普通 fleet 模式的 **Dashboard facade**，由 `botmux start` 一同启动的 `botmux-dashboard` 提供。`botmux serve --api-only` 是不启动 Dashboard 的 core-only 单进程模式，因此没有这个路由；该模式的健康检查和控制接口见 [Core-only API 控制](/api-core-only)。

成功生成快照时返回 HTTP 200。200 只表示快照生成成功；fleet 里有已配置但不在线的 bot 时，`service.status` 仍会是 `degraded`：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-09T02:30:00.000Z",
  "service": { "status": "healthy" },
  "bots": { "online": 3 },
  "sessions": { "active": 7, "attention": 1 },
  "schedules": {
    "enabled": 2,
    "nextRunAt": "2026-08-09T04:00:00.000Z"
  },
  "dashboard": { "href": "/" }
}
```

| 字段 | 语义 |
|------|------|
| `schemaVersion` | 响应契约版本，当前为 `1` |
| `generatedAt` | Dashboard 生成本次 live 快照的 ISO-8601 时间 |
| `service.status` | 在线 bot 数等于已配置 bot 数时为 `healthy`，否则为 `degraded` |
| `bots.online` | 当前在线 daemon / bot 数 |
| `sessions.active` | 在线 daemon 中状态不是 `closed` 的会话数 |
| `sessions.attention` | active 会话中需要处理的数量，包括待选仓库、TUI 提示、agent attention，以及 `limited` / `stalled` 状态 |
| `schedules.enabled` | 在线 daemon 中已启用的排程数 |
| `schedules.nextRunAt` | 已启用排程里最早的有效下次运行时间（ISO-8601）；没有时为 `null` |
| `dashboard.href` | Dashboard 根页面的相对路径；消费者应相对当前 Dashboard origin 解析 |

只要任一 live daemon 的 sessions / schedules 快照超时、返回错误或格式不合法，接口就返回 HTTP 503。计数字段会刻意省略，避免把缺失状态伪装成零：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-09T02:30:00.000Z",
  "service": { "status": "degraded" }
}
```

无当前 token 的匿名请求受 **Dashboard 进程全局**滚动窗口限流：所有匿名调用方共享配额，任意 10 秒内最多 5 次。第 6 次返回 HTTP 429：

```json
{
  "error": "rate_limited",
  "retryAfterSeconds": 7
}
```

响应头 `Retry-After` 是同一个十进制秒数（最少为 `1`，通常为 `1`–`10`）；等待该时长后再重试。携带当前 Dashboard token 的已认证请求不计入匿名限流。认证沿用 Dashboard 登录态：正确的 `?t=<token>` 会先返回 302、设置 `botmux_dashboard_token` cookie，再跳转到无 query 的 URL；纯 API 客户端若要使用豁免，需要保存并回传该 cookie。这里不接受 `Authorization: Bearer`。

### 会话 row 可选字段

下列字段只属于信息更丰富的 `/api/sessions` rows 和 `/events` 会话 payload，summary 接口绝不会返回它们。它们都是**可选字段**，消费者必须兼容旧会话/旧 daemon 不返回：

| 字段 | 语义 |
|------|------|
| `backendType` | 最近一次 worker spawn 时记录的有效后端（`pty` / `tmux` / `herdr` / `zellij` / `zmx`），用于过滤/展示；cold resume 后可能随配置切换 |
| `backendSessionName` | 仅受管的持久后端会话才有，当前规则为 `bmx-<sessionId 前 8 位>`；PTY、adopt 会话和部分 legacy row 没有该字段。它是确定性定位信息，**不代表对应进程/socket 当前存活** |
| `titleUpdatedAt` | 标题最后更新的 ISO-8601 时间字符串 |
| `titleSource` | 标题来源标签：`initial` / `user` / `agent` / `cli` / `dashboard` / `system`。仅供展示和调试，**不是可信的身份/审计字段** |

### `publicReadOnly` 与 token 边界

`publicReadOnly` 默认开启。开启时，`GET /api/dashboard/v1/summary`、`GET /api/sessions` 和 `GET /events` 等只读白名单接口在 Dashboard 监听地址上可以**无 token** 访问。summary 只含上述强脱敏聚合；会话名称、标题、后端和 session / event row 中的其它元数据都应按可公开信息对待。

- 全部 POST / PATCH / DELETE 写操作、不在只读白名单中的 GET，以及原始 PTY / 诊断日志，始终需要 `botmux dashboard` 生成的当前 token。白名单是 fail-closed 的：新增 GET 不会因公开只读开启就自动暴露。
- 关闭 `publicReadOnly` 后，无 token 的 summary 请求会返回 401；持当前 token 的请求仍可访问，且不受上面的匿名限流。错误或已轮换的旧 token 在公开只读开启时按匿名请求处理。
- `botmux dashboard` 和 `botmux dashboard current` 会复用当前 token（尚无时创建第一个）；`botmux dashboard rotate` 才会显式替换 token、让之前的链接失效。token 只提供 Dashboard 应用层访问权，不代替主机防火墙、VPN 或反向代理鉴权。
- 不需要无 token 观测时，在 Dashboard 「设置」中关闭「公开只读」。也可先设 `BOTMUX_DASHBOARD_PUBLIC_READONLY=false`；但设置页一旦保存过该开关，`~/.botmux/config.json` 的持久值会优先于环境变量。

## 部署细节

dashboard 走单独 pm2 进程 `botmux-dashboard`，跟 daemon 一起起停。每个 daemon 在 `127.0.0.1` 暴露内部 IPC（仅本机），dashboard 进程做反向代理 + HMAC 鉴权：密钥文件 `~/.botmux/.dashboard-secret`（mode 0600），是 daemon↔dashboard 的内部签名密钥，**不下发给浏览器**（浏览器侧走上面的轮换登录 token）。
