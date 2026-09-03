# 斜杠命令

在话题里直接发这些命令即可，由 daemon 拦截处理。只有[透传章节](#-透传给底层-cli)里白名单内的命令会**原样透传**给底层 CLI；其余 daemon 不认识的 `/xxx` 会被当作普通对话文本按普通消息转发。随时发 `/help` 查看完整清单。

## 📌 会话管理

| 命令 | 说明 |
|------|------|
| `/repo` | 仓库待选时用默认 workingDir 启动；会话进行中则弹项目选择卡片 |
| `/repo <N>` | 切换到上次扫描的第 N 个项目 |
| `/repo <路径\|项目名>` | 直接指定路径或 workingDir 下的一级项目名 |
| `/cd <路径>` | 切换工作目录并重启 CLI 进程 |
| `/status` | 查看会话信息（运行时间、终端地址等） |
| `/retry` | 重试最近一个失败或被中断的 turn（10s 冷却） |
| `/restart` | 重启 CLI 进程（保留 session 上下文） |
| `/close` | 关闭会话并发送可恢复卡片（含 CLI 自身 resume 命令） |
| `/fork <任务>` | 继承当前会话的完整上下文，在同一话题群新建并行子话题；源会话原样继续（仅 Claude 系 / Codex 终端模式） |
| `/forklist` | 重发当前会话的分身任务面板，显示运行/结束状态和子话题链接 |
| `/fork --create <群名>` | 不建子话题，改为把当前会话分身到一个新建群 |
| `/rename <标题>` | 重命名当前 Botmux 会话，并同步运行中的 Codex/Claude 原生会话名 |
| `/fork --create <新群名>` | 把当前空闲会话分身到一个新建群，源会话原样保留继续（仅 Claude 系 / Codex 终端模式；需在源会话所在话题内发起） |
| `/card` | 手动召唤当前会话的流式卡片（关流式时也能召唤并恢复实时刷新；私密卡片模式下改发仅授权人可见的静态快照）。`/card off`、`/card on` 控制本群是否出流式卡；`/card pin off`、`/card pin on`、`/card pin status` 控制当前群的流式卡片置顶开关 |
| `/cot` | 思考过程消息开关：`/cot off` 关闭本群的思考气泡，`/cot on` 恢复，`/cot show` 在开关关闭时临时召唤一次当前回合的思考气泡，`/cot status` 查看状态（bot 级总开关 `thinkingCard` 默认 on；仅 claude-code / codex 支持） |
| `/term` | 获取当前会话的「可操作终端」（带写权限）链接，私密发给 owner（群内仅你可见，话题/单聊回退私信，不在群里暴露） |
| `/dashboard [模块]` | 在飞书里打开 Dashboard 控制卡片（sessions/schedules/groups/settings/help 等） |
| `/insight` | owner 专用：在当前会话即时回一张「本会话洞察摘要」卡片（聚合指标 + 规则建议；动作 span 明细 / 逐轮对账 / 对话回放在 Dashboard「洞察」页看） |
| `/vc prepare <会议链接或会议号>` | 将当前普通群设为会议准备群，并在开会后复用同一 Agent 会话 |
| `/introduce` | 让本群机器人互相登记 `open_id`，用于协作时精确 @ 对方 |
| `@机器人 /summary` | 读取当前话题（或普通群配置范围内）的历史消息并生成总结（默认最近 50 条 / 24 小时）。若该 bot 开启了 `summaryMemory`，总结会追加写入配置的记忆文件（`summaryMemoryPath`，默认 `summary.md`），且 `/summary` 后跟随的文字会作为「只总结从这条起」的硬边界；未开启记忆时，后随文字仅作为本次总结的侧重提示 |
| `/t [<内容>]` `/topic [<内容>]` | 普通群内强制新开话题；带内容提交首轮任务（需选仓则选择后开工），裸命令进入话题设置 |
| `/issue` | 打开 Issue Board 看板卡片，直接在卡片上领取 botmux 平台任务：选好仓库后自动建群、拉你进去、绑定平台任务并开工。需要本机已绑定平台，且发起人在该 bot 的 `allowedUsers` 里；卡片只有发起人能操作 |
| `/issue status` | 在任务群里发，查这个群绑着哪条平台任务、现在什么状态：平台状态 / 领取人 / 本机绑定 / 有没有回写还堵在发件箱里。只读，同样限该 bot 的 `allowedUsers` |
| `/issue done` | 在任务群里发，**验收通过**，把任务推到平台终态。agent 交付只能到「待验收」，标完成是人的决策。完成后 claim 被平台清掉，这条领取不能再释放。同样限该 bot 的 `allowedUsers` |
| `/issue release` | 在领取任务时建出来的那个群里发，把任务退回平台「待领取」，别人可以重新领。群和会话**不会自动解散**，对话记录保留。同样限该 bot 的 `allowedUsers` |

裸 `/t` 的选仓/固定目录分支见[会话与话题模型](/session-model)。也可以把 `/repo` 作为新话题的首条命令：

- `/t /repo <路径|项目名>`
- `/t /repo wt <路径|项目名> [分支]`

这两种组合会直接完成建话题与选仓/创建 worktree，不会先启动空会话再切库；任务在话题内下一条发送。

## 💬 回复模式（`/reply-mode`）

控制 bot 被 @ 触发时如何开会话。无参数（或 `status`）查看当前模式；带参数修改需 `canOperate`，仅查看需 `canTalk`。群聊中均需 @ 目标 bot 才生效，多 bot 群须 @ 到具体 bot。仅普通群与 1:1 私聊支持；话题群无需设置（本就是话题），命令会被拒绝。

**私聊（1:1 DM）**——模式对该 bot 的**所有 DM 生效**（bot 级全局配置，非 per-chat），但不同用户与该 bot 的 DM 仍各自隔离会话、互不共享。只有 `chat` / `topic` 两态（`new-topic` 是 `topic` 的兼容别名）：

| 命令 | 说明 |
|------|------|
| `/reply-mode` `/reply-mode status` | 查看当前私聊会话模式 |
| `/reply-mode chat` | 每个 1:1 私聊内部扁平连续会话，同一 DM 的消息共用一个会话（**默认**） |
| `/reply-mode topic` `/reply-mode new-topic` | 每条**顶层** DM 开独立会话/线程；同一已有 thread 内的回复继续该 thread 会话 |
| `/reply-mode group` | 每条**顶层** DM 自动创建一个「你+bot」专属会话群并把会话落在群里（AI 自动命名、回群续聊自动恢复上下文；详见私聊会话模式 `p2pMode=group`） |

`shared` / `chat-topic` 依赖群内原生话题，私聊不支持，会被拒绝。

**普通群**——顶层 @ 的开会话方式（per-chat 覆盖，优先级高于 dashboard 默认值）：

| 命令 | 说明 |
|------|------|
| `/reply-mode` `/reply-mode status` | 查看当前群回复模式 |
| `/reply-mode chat` | 整群连续会话（顶层 @ 都进同一个会话） |
| `/reply-mode chat-topic` | 顶层连续、原生话题各自独立会话 |
| `/reply-mode new-topic` | 每次 @ 新建话题与独立会话 |
| `/reply-mode topic` `/reply-mode shared` | 话题展示但共享同一会话（`topic` 是 `shared` 的兼容别名） |

群级设置会覆盖 dashboard「Bot 配置 → 普通群模式」的默认值。

`/substitute [status|on|off]` —— 查看或切换当前群的**替身模式**开关（修改需 owner）。

## 🔀 透传给底层 CLI

`/compact` `/model` `/clear` `/plugin` `/usage` `/new` `/context` `/cost` `/mcp` `/diff` `/code-review` `/security-review` `/review` `/btw` `/effort` `/fast` —— 字面送达底层 CLI，交给它的内置命令处理。

`/fast` 仅对 Codex 生效：切换 Codex 原生的 service tier 档位，流式卡片会显示只读的 `⚡ <档位>` 徽标，如实反映 Codex 实际运行的档位。在 RPC 输入模式或 Riff 后端上，按键到不了 Codex 执行器，因此 `/fast` 在这些后端会 fail-closed 给出明确提示，而非静默失效。

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
| `/detach` | 断开本话题与 adopt 会话的桥接（原 CLI 不受影响，`/disconnect` 同义） |

## 🔐 用户授权

| 命令 | 说明 |
|------|------|
| `/login` | 飞书用户授权，授权后可下载第三方卡片图片、以你身份调云文档/日历等 API |
| `/login status` | 查看授权状态 |
| `/login tags` | 会话群标签专项授权（消息分组权限），授权后新建会话群自动进入侧边栏分组（p2pMode=group + feed-group 标签模式用，feed-group 为默认标签模式） |
| `/pair <配对码>` | 把 Web/Dashboard 端的会话与你的飞书身份配对（在网页端拿配对码，话题里发 `/pair <码>` 认领） |

## 🎭 角色（人设）

| 命令 | 说明 |
|------|------|
| `/role` | 查看当前生效的 Role（本群覆盖 > 默认角色 > 无） |
| `/role set <Markdown>` | 设置**本群** Role（覆盖默认角色） |
| `/role delete` | 删除本群 Role |
| `/role team set <Markdown>` | 设置**默认角色**（跨群默认人设；命令名沿用 `team`，= dashboard「Bot 配置 → 默认角色」） |
| `/role cap set <一句话>` / `/role cap clear` | 设置/清除花名册里的能力标签 |
| `/role profile list` | 列出本地 role profiles |
| `/role profile show <profile> [--all]` | 查看当前 bot 的 profile entry，或本 daemon 已知的全部本地 entries |
| `/role profile set <profile> <Markdown>` | 设置当前 bot 在 profile 里的 entry |
| `/role profile save <profile>` | 把当前 bot 的生效 Role 保存到 profile |
| `/role profile apply <profile> [--preview] [--force] [--quiet]` | 把当前 bot 的 profile entry 写成本群 Role |

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
| `/vc-auth @成员` | 会议监听中临时授权本场指令源；`/vc-auth revoke @成员` 撤销；`/vc-auth list` 查看 |

## ⚙️ 远程改配置 & 技能（owner 专用）

写盘即热更新，无需重启。

| 命令 | 说明 |
|------|------|
| `/botconfig get` | 查看本机器人当前运营配置 |
| `/botconfig set <字段> <值>` | 改 model/cli/lang/开关等；`/botconfig help` 看全部字段 |
| `/skills ...` | 查看/管理本 bot 的技能策略（`attach`/`detach` 需 owner） |

## 🆕 一键新建会话群

`/group <群名>`（别名 `/g`）：自动新建飞书群、邀请你进群、转让群主，整个群作为一个独立 CLI 会话。`@botA @botB /g <群名>` 可把多个机器人一并拉进新群。

加上 `--role-profile <profile>` 可以在新群里自动 bootstrap 一套按 bot 区分的角色：

```bash
@botA @botB /g --role-profile collab-main War Room
```

详见 [一键建会话群](/group)。

## 📄 飞书文档评论入口

`/watch-comment`：监听飞书文档评论、绑定 AI 会话并把回复发回评论串；支持 `<文档链接> [--dir <路径>] [--all|--mentions-only]` 与 `list/off`。`/subscribe-lark-doc` 保留原有的飞书逐文件 API 订阅流程。详见 [飞书文档评论入口](/doc-comment)。

## 🔧 Workflow（流程编排，实验性）

| 命令 | 说明 |
|------|------|
| `/workflow <目标>`（= `/workflow new <目标>`） | 发起**即兴 workflow**：bot 拷问澄清需求 → 自动编排成 DAG → 你确认后并发跑完，风险节点执行期弹审批卡 |
| `/workflow run <名称> [key=value ...]` | 运行一个 Saved Workflow |
| `/workflow save last [名称]` · `/workflow list\|show\|cancel` | 保存 / 列出 / 查看 / 取消 workflow（v2 资产仅支持离线 `migrate-v3` / `archive-runs`） |

> 旧的 `/template run|cancel` 已退役；现在发 `/template` 只返回退役提示。

详见 [Workflow](/workflow)。

## 👥 多机器人协作

`@botA @botB /t <prompt>`（各自开新话题）· `@botA @botB /introduce`（让本群机器人互相登记 open_id，协作时可精确 @ 对方）· `botmux bots list`（查看当前群可协作 bot）

## ⏰ 定时 & ❓帮助

`/schedule ...`（见 [定时任务](/schedule)）· `/help`（话题内显示完整清单）
