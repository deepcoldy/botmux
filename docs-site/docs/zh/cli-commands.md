# CLI 命令

`botmux` 命令分两类：

- **运维命令**：你在服务器终端里用，管理 daemon（后台常驻进程）、机器人和会话。
- **会话内命令**：AI 在会话里调用，用来发消息、读历史、建定时任务等。你一般不用手敲。

忘了参数时，跑 `botmux --help` 看总览，或 `botmux <子命令> --help` 看某个命令的完整参数。

## 最常用的命令

| 想做什么 | 命令 |
|------|------|
| 首次配置 / 添加机器人 | `botmux setup` |
| 启动 / 停止 / 重启 | `botmux start` / `botmux stop` / `botmux restart` |
| 看是否在跑 | `botmux status` |
| 看日志 | `botmux logs` |
| 升级 | `botmux upgrade` |
| 看活跃会话、进终端 | `botmux list` |
| 打开 Dashboard | `botmux dashboard` |
| 开机自启 | `botmux autostart enable` |

## 配置机器人

### 交互式配置

```bash
botmux setup
```

打开交互界面，可以首次配置、添加、编辑或删除机器人。默认会用飞书扫码登录，自动帮你建应用、开权限、配回调和发版本；不想自动配置开放平台可以加 `--no-open-platform-auto`。

### 脚本化配置（不进交互界面）

适合写脚本或让 AI 帮你操作：

| 命令 | 用途 |
|------|------|
| `botmux setup list [--json]` | 列出已配置的机器人（密钥脱敏） |
| `botmux setup add --create-app --allowed-users <owner>` | 扫码新建一个飞书应用并添加 |
| `botmux setup add --app-id <cli_xxx> --app-secret <secret> --allowed-users <owner>` | 用已有应用的凭证添加 |
| `botmux setup configure <进程名\|AppID>` | 对已添加的机器人重跑权限、事件、发版等开放平台配置（上次没配完时用） |
| `botmux setup edit <进程名\|AppID> --cli codex` | 按字段修改，例如换 CLI；值传 `-` 表示清空 |
| `botmux setup remove <进程名\|AppID> --yes` | 删除机器人 |

`--allowed-users` 填机器人主人。新建应用时请用**完整邮箱、手机号或 `on_` 开头的 union_id**，不要填 `ou_` 开头的 open_id：open_id 只在签发它的那个飞书应用里有效，新应用还不存在，不可能有合法的 open_id。完整字段列表见 `botmux setup help`。

### 复制一个机器人

```bash
botmux clone <机器人名> [--name <新名称>]
```

新建一个飞书应用，并复制原机器人的行为配置。不填名称时自动命名为「源名称-copy-时间戳」。

### 导出可分享的预设

```bash
botmux preset export <机器人> [--from-chat <chatId>] [--out <文件>] [--yes]
```

把一个机器人的 CLI、模型、角色和能力标签导出成 JSON，附带接入指引，发给同事后对方的 AI 可以照着配一个同样的机器人。

- `<机器人>` 填进程名（`botmux-xxx`）或 AppID。
- 默认导出团队级角色；加 `--from-chat <chatId>` 改为导出某个群里的角色内容（群 ID 本身不会写进文件）。
- 默认写到当前目录的 `<名称>.botmux-preset.json`；`--out -` 输出到 stdout。
- 导出前会把角色内容给你确认一遍；非交互环境（比如让 AI 来跑）需要加 `--yes`。
- 文件**不含任何密钥**：AppID、Secret、`allowedUsers`、工作目录等都不会导出。

### 切换界面语言

```bash
botmux lang          # 查看当前语言
botmux lang en       # 切成英文（zh / en）
botmux lang en --bot 0   # 只改 bots.json 里第 0 个机器人
```

#### 安装向导里切换中英文 {#setup-lang}

跑 `botmux setup` 时，在第一步的选择菜单里直接按 **L** 键（搜索框为空时），界面立刻在中文和英文之间切换，选择也会存成本机的全局语言。用编号输入的简易模式时，输入 `L` 回车效果一样。

也可以启动时直接指定：`botmux setup --lang en`（或 `zh`），同样会存成全局语言。之后想改界面语言，用上面的 `botmux lang`。

## 启停 daemon

| 命令 | 说明 |
|------|------|
| `botmux start` | 启动 daemon，同时启动 `mode=auto` 的插件服务 |
| `botmux stop` | 停止 daemon。默认不停插件服务，加 `--with-plugin` 才一起停 |
| `botmux restart` | 重启 daemon，活跃会话会自动恢复 |
| `botmux status` | 查看 daemon 和各机器人的运行状态 |
| `botmux logs` | 查看日志，默认显示最后 50 行并持续跟随 |
| `botmux start-bot <AppID>` | 只拉起一个机器人，不重启其它机器人。daemon 整体没在跑时会提示先用 `botmux start` |
| `botmux stop-bot <AppID>` | 只停一个机器人，其它机器人不受影响 |

`start-bot` / `stop-bot` 加 `--json` 输出机器可读结果，适合脚本调用。`botmux setup add` 和 Dashboard 新建机器人后就是用 `start-bot` 把它拉起来的。

`botmux logs` 常用参数：

- `--lines N`：显示最后 N 行。
- `--bot <序号|名称|AppID>`：只看某个机器人（序号从 0 开始）。
- `--no-follow`：打印完就退出，不持续跟随。

`start` / `restart` 还接受 `--companion-secret-file <绝对路径> --companion-bot <appId>`，两个一起给时会为一个隔离测试机器人开启封闭的本机 API，见 [本地 Companion API](/companion-api)。

## 升级

```bash
botmux upgrade            # 升级到最新正式版（别名 botmux update）
botmux upgrade canary     # 切到预览频道：canary / beta / rc / next
botmux upgrade 3.28.0     # 安装指定版本
```

升级完成后按提示运行 `botmux restart` 让新版本生效。如果你是从源码 checkout 运行的，`upgrade` 会改为 `git pull` + 重新构建 + 重启。v3.18.0 之前的老版本请改用 curl 安装脚本升级，见 [FAQ · 怎么升级？](/faq#怎么升级)。

## 管理会话

### 查看会话：`botmux list`

```bash
botmux list          # 交互式列表（别名 ls）
botmux list --plain  # 纯文本表格，适合脚本 / 管道
botmux list --json   # JSON 输出
```

交互式列表里的按键：

| 按键 | 作用 |
|------|------|
| `↑` / `↓`（或 `k` / `j`） | 选择会话 |
| `Enter` | 连接到受管的 tmux / ZMX 终端；会话休眠时会先恢复再连接 |
| `d`（或 `x`） | 删除选中的会话（按 `y` 确认） |
| `q` / `Esc` | 退出 |

`list` 会顺手清理已失效的会话：外部进程已退出的 adopt 会话，以及从没真正拉起过 CLI 的临时会话。普通会话即使 CLI 进程退出也会保留，下条消息自动续上。

### 关闭、恢复、挂起

| 命令 | 说明 |
|------|------|
| `botmux delete <id>` | 关闭指定会话（别名 `del` / `rm`）。ID 写前几位即可，匹配到多个会提示你写长一点 |
| `botmux delete all` | 关闭所有活跃会话 |
| `botmux delete stopped` | 清理进程已退出的僵尸会话（休眠中、还能恢复的不动） |
| `botmux resume <id>` | 恢复一个已关闭的会话，带着原上下文重新拉起 CLI（本地会话在下一条消息到来时拉起） |
| `botmux suspend <id\|all>` | 挂起会话：结束 CLI 进程，但会话保留，下条消息自动续上上下文 |
| `botmux suspend --bot <appId>` | 挂起某个机器人的全部会话 |
| `botmux suspend --isolated` | 挂起所有开了读隔离的机器人的会话。更新 CLI 登录凭证后用，下次启动会同步新凭证 |

`suspend` 都可以加 `--dry-run` 先看会影响哪些会话。

`delete` 的效果和在飞书里发 `/close` 一样。daemon 在线时由它来收尾；daemon 拒绝或连不上时命令直接报错，不会在本地强行杀进程。只有确认 daemon 已经离线，才会在本地清理。

### 批量休眠长期空闲的会话

```bash
botmux maintenance suspend-idle --older-than 7d --dry-run   # 先预览
botmux maintenance suspend-idle --older-than 7d --yes       # 确认执行
```

- `--older-than` 是「最后活动时间」阈值，支持 `ms/s/m/h/d/w`，默认 `7d`。
- `--dry-run` 只列出候选（会话、机器人、标题、最后活动时间、会被结束的进程），不改任何东西；真正执行必须显式加 `--yes`。
- `--bot <appId>` 只处理一个机器人，`--json` 输出机器可读结果。
- 休眠后会话仍然保留，下一条消息会从历史记录冷启动续上。
- 只挑「明确空闲、可以恢复」的会话。正在回复、有排队消息、等你处理、被锁定或通过 adopt 接入的会话都会跳过。

想让它定期自动跑，在 Dashboard 的机器人配置里打开「空闲自动休眠」。这个命令用于手动预览和一次性批量处理。

### 拿可操作的终端链接

```bash
botmux term-link [id]
```

获取会话的可写 Web 终端。链接不会打印在终端里，而是由 daemon 以私密卡片发给机器人主人（群里只有你能看到，话题或单聊里退回私聊发送）。只有一个活跃会话时可以省略 `id`。详见 [Web 终端](/web-terminal)。

## Dashboard 登录链接

```bash
botmux dashboard           # 获取当前登录 URL（等同 dashboard current；没有就新建）
botmux dashboard rotate    # 换一个新 token，旧链接失效
```

Dashboard 的功能见 [Dashboard](/dashboard)。

## 开机自启

```bash
botmux autostart enable   # 注册开机自启（不需要 sudo）
botmux autostart disable  # 取消
botmux autostart status   # 查看状态
```

| 系统 | 实现方式 |
|------|------|
| macOS | `~/Library/LaunchAgents/com.botmux.daemon.plist`（launchd） |
| Linux | `~/.config/systemd/user/botmux.service`（用户级 systemd），另加崩溃守护 `botmux-watchdog.timer` |
| Windows | 当前用户的计划任务；没有权限注册时改用「启动」文件夹 |

注意几点：

- **Linux 服务器登出后服务会停**。想一直跑，执行一次 `sudo loginctl enable-linger <用户名>`。
- 启动项里记录的是当前 Node（或单文件二进制）路径。用 nvm / fnm 换了 Node 版本后，再跑一次 `enable` 即可；`start` / `restart` 也会自动检测并刷新。
- `enable` / `disable` **只管开机自启，不会启停正在运行的 daemon**。
- Linux 上 `enable` 会同时启用 `botmux-watchdog.timer`：每 30 秒检查一次，daemon 意外挂掉时自动拉起；`disable` 会一并关掉它。你主动执行 `botmux stop` 后守护不会把它拉回来，下次 `start` / `restart` 恢复正常守护。`botmux autostart status` 能看到守护是否启用。

## 会话内命令（给 AI 用）

这些命令在 botmux 会话里运行时，会自动识别当前是哪个会话、哪个群，不需要额外参数。AI 会按需调用，你了解一下有哪些能力即可。

### 消息与卡片

| 命令 | 说明 |
|------|------|
| `botmux send [正文]` | 往当前话题发消息。正文可以走 stdin / heredoc / `--content-file`。常用参数：`--images`、`--files`、`--videos`（配 `--video-covers`）、`--card-file` / `--card-json`（自定义卡片）、`--mention` / `--mention-back` / `--no-mention`（@ 谁）、`--diff`（代码改动折叠预览）、`--voice`（语音气泡）、`--dry-run`（只渲染不发送）。完整参数见 `botmux send --help` |
| `botmux card patch --message-id <om_xxx> (--card-file <path> \| --card-json <json>)` | 原地更新之前 `send` 发出的自定义卡片，不发新消息。messageId 取自 `send` 的输出 |
| `botmux card stream open/write/finish ...` | 让一张自定义卡片里的文字以打字机效果流式更新，还可以把 daemon 的运行状态绑到卡片上。完整流程见 `botmux card stream --help` |
| `botmux ask buttons --options "a,b" "<问题>"` | 把选择题做成按钮卡片发给用户，等对方点选后返回结果。`--multi` 允许多选 |
| `botmux ask buttons --questions-file <文件>` | 一张卡片里放多道题（选择、文本、数值，可预选），一次提交，返回全部答案 |
| `botmux ask buttons --answerer <open_id> ...` | 只允许指定的人提交答案（只限制谁能答，不代表业务上的批准） |
| `botmux history [--limit N]` | 读当前会话的消息历史（JSON）。话题里读话题内，普通群读整个群 |
| `botmux history --scope ambient` | 在话题会话里读话题外的群聊上下文。`--scope` 可选 `session` / `thread` / `chat` / `ambient` |
| `botmux history --with-card-json` | 给每张卡片附上原始结构化 JSON |
| `botmux quoted <message_id>` | 读被引用的那一条消息，附件会下载到本地 |
| `botmux bots list` | 列出当前群里的机器人（含 open_id，供 `--mention` 使用） |
| `botmux bots list --scope team` | 跨机器发现同团队、已主动公开的机器人（按专长），用来拉群或补人 |
| `botmux bots invite --chat <chatId> --team <id> --agent <appId>...` | 把同团队的机器人连同各自主人一起拉进已有的群，详见 `botmux bots invite --help` |

### 会话与群

| 命令 | 说明 |
|------|------|
| `botmux session rename "<标题>"` | 改**当前会话**的标题，Dashboard 和 `/sessions` 列表立即更新。飞书群名、话题名不变。建议写成「类型｜具体事项」，最长 200 字 |
| `botmux chat rename <新群名> [--proactive]` | 改当前会话所在**飞书群**的群名（话题群里改的是整个群，所有成员可见）。`--proactive` 表示 AI 主动改名，10 分钟内只改一次 |
| `botmux top-notice set <message_id>` | 把当前群里的一条消息设为群置顶。只能在群会话里用，或用 `--chat-id` 指定群 |
| `botmux slash "/命令"` | 等 CLI 空闲后，向本会话的 CLI 注入一条原生斜杠命令（如 `/compact`），见下方说明 |
| `botmux preview <端口>` | 把会话里启动的本机网页服务登记进来，登录 Dashboard 后即可预览，不暴露本机地址 |
| `botmux role switch <角色目录>` | 把当前话题切换到某个角色（目录必须在 `~/botmux-roles` 下），见 [角色](/roles) |
| `botmux skill list` / `skill show <名称>` | 列出 / 读取可用的技能说明 |

`botmux slash` 默认**全部拒绝**，要先在 [bots.json](/bots-json) 里给该机器人配 `tuiSlashAllow`，列出允许注入的命令名，例如 `["/compact"]`（不区分大小写，可省略开头的 `/`）。另外：

- 只接受单行、以 `/` 开头的命令；参数可以跟在后面，按命令名匹配名单。
- `/cd` 永远拒绝，即使写进名单：它会改变 daemon 记录的会话目录，只能走专用命令。
- 命令会排队到 CLI 空闲时才执行；执行前 CLI 进程重启的话，这条命令会被丢弃。

### 飞书授权

| 命令 | 说明 |
|------|------|
| `botmux auth request [--scope "<scope1 scope2>"] [--json]` | 为本轮发消息的人生成飞书授权链接，返回 JSON。AI 把链接发给用户去点 |
| `botmux auth wait --request-id <id> [--json]` | 等这次授权完成，最多等 5 分钟。成功后再重试原来的操作 |

#### Agent 自助发起授权 {#agent-auth-request}

**用户不用做任何设置。** AI 在会话里用 `lark-cli --as user` 调飞书接口、发现缺你的授权时，会自己跑 `botmux auth request`（需要的权限用 `--scope` 一次带齐），把授权链接发给**本轮发消息的那个人**：

- 私聊里，AI 把链接直接回给你；
- 群里，botmux 私聊把链接发给你本人，不会贴到群里。

你点开链接完成授权后，AI 用 `botmux auth wait` 在同一轮里等授权生效（最多 5 分钟），然后重试原来的操作。这一轮已经结束也没关系：链接有效期内授权完，再发一条消息就能接着做。不想等 AI 发链接，也可以自己在话题里发 `/login`（或 `/login --scope <权限名>`）。

前提：这个 Bot 的 `lark-cli` 走 botmux 的应用绑定（`larkToolBinding`，默认开），或者 Bot 开了[按触发人身份调用 CLI](/bots-json#trigger-user-auth) 且覆盖 `lark-cli`。两者都关时 daemon 会拒绝，返回 `lark_user_auth_disabled`。链接只发给本轮经过验证的真人，AI 不能替别人申请。

### 只读查询

这些命令只查状态，不改任何东西。

| 命令 | 说明 |
|------|------|
| `botmux observe [--session <id>] [--lark-app <appId>]` | 通过 daemon 实时查询会话和 worker 状态（JSON）。查不到就显示 unknown，不读缓存 |
| `botmux execution current --json` | 核对当前进程属于哪个机器人、会话、轮次和 worker |
| `botmux actor current --json` | 返回经 daemon 验证的本轮发起人企业邮箱，以及当前群 ID 和轮次 ID（不含 open_id）。不在会话进程里运行时会拒绝 |

### 进阶能力（各有专页）

| 命令 | 用途 | 详见 |
|------|------|------|
| `botmux schedule add/list/update/remove/pause/resume/run/done` | 定时任务 | [定时任务](/schedule) |
| `botmux dispatch` / `botmux report` | 开子话题把任务派给别的机器人，并回报结果 | [多话题协作](/multi-topic) |
| `botmux project ...` | 在普通群里维护一张置顶的项目进度卡 | [项目进度卡](/project-card) |
| `botmux workflow ...` | 多步骤编排流程 | [Workflow](/workflow) |
| `botmux goal run <目标>` | 在命令行无头跑一个目标，`--json` 输出结果 | [Workflow](/workflow) |
| `botmux create-group --bot <名称> [--bot ...]` | 用一个或多个机器人新建飞书群 | [多机器人](/multi-bot) |
| `botmux board ...` | 决策看板（只有管家机器人的会话可用） | [决策看板](/decision-board) |
| `botmux whiteboard ...` | 本地项目白板 | [白板](/whiteboard) |

AI 怎么发现和使用这些命令，见 [Skill + CLI 交互](/skill-cli)。

### 建群后自动开工、直接建话题群 {#create-group}

`botmux create-group` 在宿主终端或会话里都能跑，不用额外开关：

```bash
botmux create-group --bot reviewer-a --bot reviewer-b --name "PR #123 评审" \
  --chat-mode topic \
  --kickoff-bot ou_xxx --kickoff-prompt "请 review PR #123"
```

- `--bot`：至少一个，可重复。推荐写 Bot 显示名或完整 AppID。**第一个是建群人（creator）**。
- `--chat-mode topic`：直接建成话题群（每条顶层消息自成一个话题）；`group` 或不写就是普通群。群形态只在建群那一刻能定，之后改不了。
- `--kickoff-bot` + `--kickoff-prompt`：建群成功后，由建群人 @ 这个 Bot 发出这段 prompt，让它自动开始干活（比如 PR review）。两个参数要一起给；`--kickoff-bot` 填那个 Bot 的 open_id（会话里可用 `botmux bots list` 查），它必须在 `--bot` 列表里，而且不能是第一个。
- `--working-dir <路径>`：把新群给所有入群 Bot 绑定到这个目录，开话题时不再弹选仓卡片。
- `--json-status`：在输出的 chatId 后追加一行结构化状态。不管带不带它，指定了 kickoff 却没发出去时命令都以非零退出。

完整参数见 `botmux create-group --help`，跨机器的团队建群（`--team` / `--agent`）也在里面。

## 其它配置命令

| 命令 | 用途 | 详见 |
|------|------|------|
| `botmux voice` | 配置语音总结与语音识别 | [语音](/voice) |
| `botmux plugin ...` | 创建、安装、启用插件 | [插件](/plugins) |
| `botmux sandbox-network-policy ...` | 配置 Linux 本地会话的网络访问策略 | [沙盒](/sandbox) |
| `botmux env-policy get\|set\|unset` | 配置机器人进程继承哪些环境变量 | [bots.json](/bots-json) |
| `botmux worker-budget status\|set\|unset` | 查看或调整会话启动前的内存检查 | [全局设置](/global-settings) |
| `botmux feedback storage ...` | 查看或切换反馈数据的存储（SQLite / PostgreSQL） | [反馈数据存储与迁移](/feedback-storage) |
| `botmux session start/send/publish ...` / `botmux headless ...` | 脚本、CI 不进飞书群也能起会话、取结果 | [无群自动化会话](/headless-session) |
| `botmux model-proxy serve` | 在本机起 OpenAI 协议兼容入口（实验） | [模型协议代理](/model-proxy) |

## 进阶：多副本部署（primary 模式）

普通单机部署可以跳过这一节。

设置 `BOTMUX_COORDINATION_MODE=primary` 后，会话状态以 PostgreSQL 里的记录为准，多台机器（副本）共享。这时：

- 本地的 `delete`、`resume`、`suspend`（`--dry-run` 除外）、`maintenance suspend-idle`，以及 `list` 里的删除 / 恢复都会被拒绝。请到原话题用会话卡片关闭或恢复，保证操作经过统一的会话控制通道。
- `list` 仍可用，但只做展示，不会自动清理本地会话。

会话只在持有它的那台副本上运行，飞书回调和浏览器请求却可能落到任意副本：

- **「显示 / 隐藏输出」按钮**：由持有会话的副本执行并更新原卡片。只有有权操作该会话的人点击才生效；点到旧卡片或没有权限时，会提示改用最新卡片。
- **Web 终端跨副本访问**：请求落到别的副本时，会转发一跳到持有会话的副本。需要配置：
  - `BOTMUX_TERMINAL_ROUTE_HOST`：其它副本能访问到本副本的 IP（如 Pod IP），必须是 IP。不设置则不参与转发。
  - `BOTMUX_TERMINAL_ROUTE_PORT`：其它副本访问本 Dashboard 用的端口（如 NodePort），默认取 `BOTMUX_DASHBOARD_PORT`。
  - 转发时不会带上 Cookie、Authorization 等登录凭据。
- **哪些能跨副本**：只有飞书卡片里自带凭据的终端链接能跨副本打开。Dashboard 里内嵌的终端、触屏动态链接、需要写权限的接管，都必须直接访问持有会话的副本（例如让负载均衡按会话粘滞），否则会返回 403。
- 没开 primary 的部署不受以上影响。
