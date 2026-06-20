# 斜杠命令

在话题里直接发这些命令即可，由 daemon 拦截处理。botmux 不认识的 `/xxx` 会**原样透传**给底层 CLI（与 CLI 自身的 slash 命令互不冲突）。随时发 `/help` 查看完整清单。

## 📌 会话管理

| 命令 | 说明 |
|------|------|
| `/repo` | 仓库待选时用默认 workingDir 启动；会话进行中则弹项目选择卡片 |
| `/repo <N>` | 切换到上次扫描的第 N 个项目 |
| `/repo <路径\|项目名>` | 直接指定路径或 workingDir 下的一级项目名 |
| `/cd <路径>` | 切换工作目录并重启 CLI 进程 |
| `/status` | 查看会话信息（运行时间、终端地址等） |
| `/restart` | 重启 CLI 进程（保留 session 上下文） |
| `/close` | 关闭会话并发送可恢复卡片（含 CLI 自身 resume 命令） |
| `/card` | 手动召唤当前会话的流式卡片（关流式时也能召唤并恢复实时刷新；私密卡片模式下改发仅授权人可见的静态快照） |
| `/t <prompt>` `/topic <prompt>` | 普通群内强制开新话题 |

## 🔀 透传给底层 CLI

`/compact` `/model` `/clear` `/plugin` `/usage` `/context` `/cost` `/mcp` `/diff` `/code-review` `/security-review` `/review` `/btw` —— 字面送达底层 CLI，交给它的内置命令处理。

部分 CLI 还有 adapter 默认放行的命令：Claude Code / Codex 默认放行 `/goal`，因此新话题第一条发 `/goal ...` 也会先启动/选择仓库，再把 `/goal ...` 原样投给 CLI。

想放行更多命令，给该 bot 配 [`customPassthroughCommands`](/bots-json)（如 `["/export"]`）即可在上面白名单之外按需扩展。会遮蔽 botmux daemon 命令的项（如 `/status`、`/help`、`/cd`）会被自动丢弃——daemon 命令始终保留自身语义，无法被透传覆盖。

## 🧩 查看可用命令

`/list-slash-command`（别名 `/slash`）：在卡片里分四段列出当前可用的 slash 命令——

1. botmux 固定放行的透传白名单；
2. 当前 CLI adapter 默认放行的命令；
3. 本 bot 在 bots.json 用 `customPassthroughCommands` 自定义放行的命令；
4. 从 `.claude` 目录（项目级 + `~/.claude` + 插件缓存）自动发现的自定义命令 / skill / 插件，以「命令 ｜ 说明」分页表格展示，并提示检测到的 MCP server 名。

权限同 `/help`，不占用会话槽位。

## 📡 会话接入

| 命令 | 说明 |
|------|------|
| `/adopt` | 扫描本机 tmux，弹卡片选择要接入的已运行会话 |
| `/adopt <tmux_pane>` | 直接接入指定 pane（如 `/adopt 0:2.0`） |

## 🔐 用户授权

| 命令 | 说明 |
|------|------|
| `/login` | 飞书用户授权，授权后可下载第三方卡片图片、以你身份调云文档/日历等 API |
| `/login status` | 查看授权状态 |
| `/pair <配对码>` | 把 Web/Dashboard 端的会话与你的飞书身份配对（在网页端拿配对码，话题里发 `/pair <码>` 认领） |

## 🎭 角色（人设）

| 命令 | 说明 |
|------|------|
| `/role` | 查看当前生效的 Role（本群覆盖 > 默认角色 > 无） |
| `/role set <Markdown>` | 设置**本群** Role（覆盖默认角色） |
| `/role delete` | 删除本群 Role |
| `/role team set <Markdown>` | 设置**默认角色**（跨群默认人设；命令名沿用 `team`，= dashboard「Bot 配置 → 默认角色」） |
| `/role cap set <一句话>` / `/role cap clear` | 设置/清除花名册里的能力标签 |

详见 [角色与团队](/roles)。

## 🔀 会话接力（普通群）

| 命令 | 说明 |
|------|------|
| `/relay` | 在目标群弹卡片，把你在其它群的活跃会话**拉**过来继续 |
| `@botA @botB /relay --create` | 把当前会话（带协作伙伴）**搬**到一个新建的群 |

详见 [会话接力 Relay](/relay)。

## 🛎️ Oncall（群聊）

`/oncall bind <path>` · `/oncall unbind` · `/oncall status`

## 🔑 使用授权（owner 专用）

| 命令 | 说明 |
|------|------|
| `@机器人 /grant @某人` | 授权对方在本群对话；`/grant`（不带人）则授权**本群所有成员**对话 |
| `@机器人 /revoke @某人` | 撤销对方本群对话权；`/revoke`（不带人）撤销整群授权 |

## 🆕 一键新建会话群

`/group <群名>`（别名 `/g`）：自动新建飞书群、邀请你进群、转让群主，整个群作为一个独立 CLI 会话。`@botA @botB /g <群名>` 可把多个机器人一并拉进新群。详见 [一键建会话群](/group)。

## 📄 飞书文档评论入口

`/subscribe-lark-doc <文档链接>`：订阅一篇飞书文档，文档评论喂进本会话、机器人回复发回评论讨论串 · `/subscribe-lark-doc list` 查看已订阅 · `/subscribe-lark-doc off` 退订。详见 [飞书文档评论入口](/doc-comment)。

## 👥 多机器人协作

`@botA @botB /t <prompt>`（各自开新话题）· `@botA @botB /introduce`（互相登记 open_id）

## ⏰ 定时 & ❓帮助

`/schedule ...`（见 [定时任务](/schedule)）· `/help`（话题内显示完整清单）
