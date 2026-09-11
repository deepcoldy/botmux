# 话题指令头：一条消息完成开话题、选仓库、选模型与首轮任务

让用户在飞书里用一条消息就把一个新会话需要的东西全部交代清楚：可读标题、目标仓库、模型、推理强度、首轮任务。今天这些要拆成四五条消息分步发，而且顺序和时机都有讲究；本设计把它们收敛成一份"开话题时的会话声明"，由 daemon 一次解析、逐项落到会话生命周期里正确的时间点。

代码位置以 `origin/master` `60b460c1` 为准；行号只是定位线索，实现时以当时代码为准。

## 1. 决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | 做成**声明**，不做成级联执行 | `/repo` 要在 CLI spawn 之前、`/model` 本质是启动参数、标题理想上从出生就对、正文要等 CLI ready——四样东西各有时间窗，顺序执行的管道模型只会把重排和延迟做进解析器里。daemon 内部已有同一概念：trigger API 与定时任务都以 `{prompt, model, reasoningEffort, workingDir}` 建会话，落到 `ds.spawnModelOverride` / `pendingPrompt` / `workingDir`。本设计只是给这份"会话规格"加一个 IM 输入面 |
| D2 | 语法：`[标题] /t 指令* 正文`，**空白不敏感**（换行等价于空格），正文按原始偏移原样保留 | 单行、多行是同一个解析器的两种排版，用户按不按 Enter 结果一样；唯一的观感差异在飞书话题列表的预览（见 §7） |
| D3 | 可读标题放在 `/t` **之前** | 飞书话题列表显示的是根消息原文，bot 既改不了也删不了用户的消息，所以可读文字必须是根消息最前面的内容。`/rename` 只改 `session.title` 并同步 CLI 原生 resume 名，对话题列表无能为力 |
| D4 | 头部白名单只有 `/repo` `/model` `/effort`，参数都是**单 token** | `/rename` 不进头部：标题行已经取代它（一个来源，两处消费）。`/role` `/cd` 第一版不进。参数单 token 是行内可解析的前提；带空格的路径用双引号 |
| D5 | **fail closed**：头部任一项校验失败，回一句用法错误，零副作用 | 人就在键盘前，改完重发的成本远低于半截状态（卡片弹了、模型拼错了）。定时任务那条路选 fail-soft（`resolveScheduleModelOverride`：模型名过期就降级并警告）是因为触发时没人在场——同一份规格，按"有没有人在场"选策略 |
| D6 | 只在**尚无会话**的场景生效 | 普通群新话题、还没有会话的 thread（包括用户手动把消息转成话题后发的第一条）。已有会话的 thread 里出现带头部的 `/t` → 拒绝，边界清楚。**实现时按评审收窄了两处**：①「有没有会话」按 `activeSessions` 判，不按消息形状判——机器人发送方不过 dispatcher 的 `isSessionOwner` 分叉，全新话题的第一条也会落到 thread 路径，按形状拒会把它整条丢掉；②「只有标题 + 非空正文 + 零指令」（`关于 /t 这个命令`）放行给 CLI，那多半是在聊 `/t` 这个命令本身，整条吞掉比漏判一次改标题意图糟得多（改标题另有 `/rename`）。只有标题、正文为空（`新标题 /t`）仍然拒绝 |
| D7 | 头部里的 `/repo` 吃一个 token；会话中途单发的 `/repo` 保持吃整行 | 中途换仓是低频操作，带空格路径靠整行语义，改它收益小；差异写进帮助文案 |
| D8 | `@` 位置无关 | 路由判定本来就按 `mentions` 数组（`isBotMentioned`），与文本位置无关。解析前剥掉**对本 bot** 的所有 @（现有 `stripLeadingMentions` 只剥前导）；对其他成员/bot 的 @ 保留在正文，那是内容 |
| D9 | 向后兼容 | `/t`、`/t 文案`、`/t /repo X` 三种现有用法的外部行为不变。`/t /repo X` 从"当成 `/repo` 命令丢给 `handleCommand`"改为走指令头，结果等价：钉仓库、CLI 空转等下一条 |

## 2. 现状与它为什么不够

今天这套流程是：发一条可读文案 → 手动转成话题 → @bot → 分别发 `/repo`、`/rename`、`/model`。每条命令必须独占一条消息，原因有三，都在代码里：

1. `parseSlashCommandInvocation`（`src/core/command-handler.ts`）对多行消息，只要第二行起有以 `/` 开头的行就整条判为"讨论文本"返回 `null`（`MULTILINE_COMMANDS` 里的 `/schedule` `/role` `/fork` 除外）。这是防误触发的刻意设计：讨论里提到 `/adopt <pane>` 不应真的执行。
2. `/repo` 处理器把命令词之后的**全部**剩余内容当仓库参数（`message.content.replace(/^\/repo\s*/, '').trim()`），再交给 `resolveRepoSelection` 按路径/名字匹配。`/repo botmux 开始运维` 会去找一个叫 `botmux 开始运维` 的仓库。
3. `/model` `/effort` 在 `PASSTHROUGH_COMMANDS`（`src/core/passthrough-commands.ts`）里，daemon 只把它原样敲进已经在跑的 CLI；空话题里没有进程可接收，也刻意不给冷启动能力（只有 `/goal` 通过 adapter 的 `defaultPassthroughCommands` 拿到冷启动，见 `isInitialSessionPassthrough`）。

`/t`（`parseForceTopicInvocation`，同文件）是命令表之前拦截的路由元命令：把 `/t` 之后的全部文字当首轮任务，`/t` 单独发则进入选仓卡片或空转等待。文档已经承诺 `/t /repo X` 可以直接选仓，但那之后不能再跟任何东西。

## 3. 语法

单行：

```text
botmux 日常运维 /t /repo botmux /model sonnet[1m] 今天例行看一下 daemon 日志里的重启记录 @Claude
```

多行（与上面等价）：

```text
botmux 日常运维
/t
/repo botmux
/model sonnet[1m]

今天例行看一下 daemon 日志里的重启记录 @Claude
```

形式化：

```text
message   := [title] SENTINEL directive* body
SENTINEL  := "/t" | "/topic"            （大小写不敏感，必须是完整 token）
directive := ("/repo" | "/model" | "/effort") WS arg
arg       := token | '"' … '"'          （双引号包裹的参数可含空白）
title     := 不含以 "/" 开头 token 的文字，≤ 3 行，归一化后 ≤ SESSION_TITLE_MAX（200）
body      := 从第一个非指令 token 的原始偏移起的全部原文，原样保留
```

解析步骤：

1. 剥掉对本 bot 的所有 @mention（按 `mentions` 列表里本 bot 的名字，任意位置）。
2. 按空白切 token，同时记录每个 token 在原文中的偏移。找第一个 `/t` / `/topic` token 作为分隔符；找不到 → 不是指令头，走普通消息路径。
3. 分隔符之前的文字是标题：其中不能有以 `/` 开头的 token，且满足长度上限；不满足 → 不是指令头，走普通消息路径（这是防误触的护栏：长文里第 40 行恰好有个 `/t` 不会被当成开话题）。
4. 分隔符之后循环：下一个 token 在白名单里 → 连同紧跟的一个参数一起消费为一条指令；否则指令块结束。
5. 从第一个非指令 token 的原始偏移起，剩余原文就是正文，包括其中的换行和之后出现的任何 `/xxx`。

边界情况（都要有单测）：

| 输入 | 结果 |
|---|---|
| 没有 `/t` token | 普通消息，与今天一致 |
| `/t` 在位置 0，后面没有指令 | 今天的 `/t [文案]` 行为，标题走现有推导 |
| 有标题行，没有指令 | 标题 + 正文 |
| 指令缺参数（`… /t /repo` 结尾） | 拒绝：用法错误 |
| 指令位置出现白名单外的 `/xxx` | 拒绝：未知指令（用户已经写了 `/t`，意图明确，宁可报错不猜） |
| 同一指令出现两次 | 拒绝 |
| 正文恰好以白名单词开头（`/t /repo botmux /model 命令为啥坏了`） | `命令为啥坏了` 被当模型名消费 → 模型校验失败 → 拒绝。不会静默变成错误行为 |
| 标题区出现第二个 `/t` | 第一个 `/t` token 是分隔符；标题里含 `/` 开头 token 会在第 3 步判为非指令头 |
| `/repo 2`（数字形式） | 拒绝：数字形式只对选仓卡片有意义，头部里没有卡片 |
| 带空格的仓库路径 | `/repo "~/Code/my project"` |

## 4. 语义：每条指令落到哪

| 项 | 落点 | 复用的现有机制 | 实现时要核对的点 |
|---|---|---|---|
| 标题 | 建会话时写 `session.title`，来源 `user` | `updateSessionTitle(session, title, 'user')`（`src/core/session-title.ts`），它会置 `nativeSessionTitleUserDefined`，CLI 原生会话名随之同步 | 建会话时 worker 还没起，`requestAgentSessionRename` 会返回 `not_running`；要确认首次 spawn 时通过 `initConfig.nativeSessionTitle` 那条路把原生名带上，而不是等第二次 rename |
| `/repo X` | fork 之前钉 `ds.workingDir`，跳过选仓卡片 | `resolveRepoSelection(arg, getProjectScanDirs(ds))`（`src/core/command-handler.ts`）；之后现有 `forkOrShowRepoCard` / `pendingRepo → forkPendingCli` 路径原样跑（`src/core/session-manager.ts`） | 与点卡片选仓的 `commitRepoSelection` 保持同一套 auto-worktree 语义（`forkOrShowRepoCard` 在 `ds.workingDir` 命中 bot 默认目录时会走 `runAutoWorktreeCommit`） |
| `/model X` | 本次 spawn 的启动模型 | `ds.spawnModelOverride`（`src/core/types.ts`，内存态、每次 spawn 读取、不持久化），`resolveSessionLaunchModel`（`src/core/session-model.ts`）已把它排在最高优先级；trigger API 与定时任务都走这个字段 | trigger API 用 `isConfigurableReasoningCliId` 做**策略**门（只让有显式推理控制的 CLI 接受每次触发的模型覆盖）。头部需要的是**能力**门：adapter 能否在启动参数里带模型（bot 配置的 `model` 已经走这条路，Claude Code 应当可以）。确认后定义一个 adapter 级谓词，不能带的 CLI 直接拒绝头部里的 `/model` |
| `/effort X` | `session.reasoningEffort`（持久化，与 trigger 一致） | `cliModelSupportsReasoningEffort`（`src/services/codex-reasoning-effort.ts`）按解析后的模型校验 | 与 `/model` 一起校验，模型不支持该档位 → 拒绝 |
| 正文 | 首轮任务 | 与今天 `/t 文案` 完全相同：`pendingPrompt`，由 `buildNewTopicCliInput` 包装 | 无 |

远端后端（riff / mojo / codex-app RPC）没有 PTY，`requestAgentSessionRename` 对它们已经返回 `unsupported`；头部里的 `/model` 对这些后端如果 adapter 不能在启动参数里带模型，就按 D5 拒绝，**不要**退化成往 pane 敲字（`startupCommands` 在 `src/worker.ts` 里对远端后端有专门分支，说明这条坑已经踩过）。

## 5. 实现落点

1. `src/core/command-handler.ts`：`parseForceTopicInvocation` 升级为 `parseTopicHeader(content): TopicHeader | TopicHeaderError | null`，返回 `{ title?, directives: { repo?, model?, effort? }, prompt }`。纯函数，表驱动单测覆盖 §3 全部边界。现有单行 `/t /repo X` 归一成一条 directive。
2. 新增 `src/core/topic-spec.ts`：`resolveTopicSpec(header, { botCfg, scanDirs, adapter }) → { ok, workingDir?, model?, reasoningEffort?, title? } | { ok: false, errors }`。除仓库目录 `stat` 外无 I/O；形状对齐 `resolveScheduleModelOverride`，但策略是 fail closed。
3. `src/im/lark/message-parser.ts`：新增剥全部本 bot @ 的函数；`stripLeadingMentions` 保留给其它调用方。
4. `src/daemon.ts` 新话题路径（`parseForceTopicInvocation(cmdContent)` 那段）与 thread 路径（`threadForceTopic` 那段）：解析 → 校验 → 建 `ds` 时直接写 `workingDir` / `title` / `spawnModelOverride` / `reasoningEffort` / `pendingPrompt` → 交给现有 fork 路径。校验失败只回复用法错误。thread 里已有会话 + 带头部 → 拒绝。
5. `/t /repo X` 不再进入 `handleCommand('/repo')`（那是中途换仓语义：close + refork），`cardlessForceTopicSeed` 等既有旗标语义保持。
6. i18n：`help.topic`（`src/i18n/zh.ts` / `en.ts`）改写；新增拒绝提示文案。
7. `src/services/command-trigger.ts` 的 `FORCE_TOPIC_COMMANDS` 不变，`/t` 仍是必须 @ 才能触发的保留命令。

分三段落地，每段独立可合：

- 第一段：解析器 + 规格解析器 + 单测（纯函数，不碰 daemon）。
- 第二段：接入普通群新话题路径，迁移 `/t /repo X`，i18n，e2e。
- 第三段：thread 路径、`/model` 能力门与远端后端拒绝、剩余 e2e。

## 6. 影响面

- **共用层**：`command-handler.ts` 解析器、`daemon.ts` 两条入口、`message-parser.ts` 的 @ 剥离——所有 20+ 个 CLI 都经过。按仓库惯例至少在一个非 Claude 的 CLI（如 codex）上验证仍可用。
- **后端**：PTY 后端 vs riff / mojo / codex-app：`/model` 的能力门与拒绝路径。
- **会话类型**：普通群 `/t` 开出的 thread、话题群、p2p、手动转话题后的第一条；adopt / restore 不涉及。`handleV3SavedWorkflowCommandIfAny` 在 `/t` 剥离之后运行，顺序不动。
- **消息监听 / 免@ 命令**：`listenerPrompt` 与 `commandTrigger` 在 `/t` 处理之后覆盖 `cmdContent`，顺序不动；`reservedCommandKind` 继续把 `/t` 归为保留命令。
- **不改**：会话中途的 `/repo` `/rename` `/model` `/effort` 行为一律不变。

## 7. 验收标准

- 单测：§3 边界表逐条；`resolveTopicSpec` 的每个拒绝分支；@ 剥离（任意位置、多 bot、无 mentions 列表）。
- e2e：`/t`、`/t 文案`、`/t /repo X` 行为与改前一致；带头部的消息建出的会话 `workingDir`、`title`（来源 `user`）、启动参数里的模型、持久化的 `reasoningEffort` 逐项断言；拒绝路径断言零副作用（没有 thread 回复、没有卡片、没有会话记录）。
- 手动（飞书内，部署时机由用户决定）：单行与多行各发一条；观察话题列表预览如何截断多行根消息——这决定要不要建议用户在标题和 `/t` 之间空一行，属于文案建议，不影响解析。
- 文档：`help.topic` 双语；README 若列有 `/t` 用法同步。

## 8. 未决

- 话题列表对多行根消息的预览截断方式（见 §7 手动项）。
- 预设别名（`/t ops 文案` 展开成一组指令）：等指令头用一阵再看是否需要。如果做，必须在结构化层展开，不能走文本模板再解析——`commandTrigger` 的模板渲染结果刻意不再进解析器（`/solve /clear` 那条安全说明）。
