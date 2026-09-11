# 命令路由器：统一解析、会话相位与头部 worktree

把飞书消息进入 daemon 之后的命令处理收敛成一条链：**分类 → 解析 → 计划 → 执行**。分类决定"这条消息是转发给 coding agent，还是 botmux 要响应"；解析把标题、指令、透传命令、正文一次拣出；计划按会话相位把每一项绑定到生命周期里正确的时间点；执行只做效果。本设计是 [话题指令头](./2026-09-10-topic-directive-header.md)（`#1361`）的延续：保留它的声明式执行模型，去掉"每条指令只吃一个 token"的限制，把散在十余层里的路由判定与参数解析收进一份命令 schema。

直接动因：`/t /repo wt botmux ci/temp_split /model sonnet[1m] 任务` 这一行今天被 `repo_worktree_unsupported` 拒绝。根因不是缺一个 `wt` 分支，而是 `#1361` 的 D2（空白不敏感）与 D4（参数单 token）绑在一起后，解析器只能靠固定 arity 找正文起点，可选参数（`[分支]`）无解。

代码位置以 `origin/master` `7de08289` 为准；行号只是定位线索，实现时以当时代码为准。

## 1. 决策记录

| # | 决策 | 理由 |
|---|---|---|
| R1 | 四段式：**分类 → 解析 → 计划 → 执行**，前三段是纯函数 | 今天一条消息要过 11 层判定、至少 4 个独立参数解析器（§2）。把"是不是命令、命令是什么、什么时候做"从"怎么做"里拆出来，前三段可以表驱动单测与差分测试，执行层只消费一张效果列表 |
| R2 | 分类规则：**一个命令 token 都没有 → 短路转发**（拼 `<user_message>` 给 agent）；透传命令（`/compact` `/clear` `/model`）**是命令**，进解析与计划，只是执行效果是"逐字送给 CLI" | 透传不是转发：它有时机（要等 CLI 空闲）、有参数形状（§6）、要参与排序。"有没有命令"的判定需要 bot 配置（自定义透传集）、adapter 能力（有无 raw 输入面）、会话相位三样输入——今天这些散在各层各取各的，收进分类器是这一层的价值 |
| R3 | 消息形状：`[标题] 命令块 正文`。命令**只在行首认**；命令块是从 `/t`（新话题）或第一个命令 token（会话内）起的**连续前缀块**；一行内可放多条指令；从第一条不以命令开头的行起全是正文，**不再回头认命令** | 与 `#1361` 的形状一致，只是把"指令"推广为"命令行"。同时覆盖三类误触：`关于 /t 这个命令`（不在行首）、长文第 40 行的 `/t`（前缀块早已结束）、正文里提到的 `/adopt <pane>`。代价是"正文之后再写命令"不支持——`#1361` 今天同样不支持，维持 |
| R4 | **命令 schema 是唯一事实源**：名字、别名、子命令、参数类型与 arity、允许的相位、help 键。三处消费：头部/会话内解析器、`/help` 与用法串生成、文档同步守卫 | 今天 `/repo wt` 的用法串与帮助行已经互相矛盾（`src/i18n/zh.ts:389` 写 `<编号\|项目名\|路径>`，`:738` 写 `<编号\|项目名>`）。`test/slash-commands-doc-sync.test.ts` 的注释原话是"把漂移从人眼审查变成红灯"，而它自己承认手抄名单又过期了一次。schema 是这条思路的自然下一步：用法串从 `forms` 生成，漂移在机制上消失 |
| R5 | 可选参数两条规则：①只在下一个 token **匹配该参数类型的模式**时才吃；②**不跨行**（`#1361` D2 收窄为 D2′：换行仍等价于空格，唯一例外是行尾终止当前指令的可选参数）。**不引入 `--` 之类的终止符** | 分支名按 git ref 规则（latin/数字开头、`[\w./-]`、无 `..`、无 CJK），中文正文永远不匹配，单行最常见写法无歧义；多行写法一行一指令，一眼确定。终止符是为"单行 + latin 正文 + 不给分支"一个角落发明的语法，所有人都得学，撤掉。残余角落（`/repo wt botmux fix login bug` 单行）行为确定：`fix` 是分支名，用法串写明"latin 正文请换行" |
| R6 | 定义 `SessionPhase`，**由现有旗标推导，不新增存储**；命令合法性 = `phase × command` 矩阵 | 持久化的会话状态只有 `'active' \| 'closed'`（`src/types.ts:333`）；"选仓中 / 建 worktree 中 / 首轮待发 / 运行中"全是 `DaemonSession` 上的瞬态旗标（`worker`、`pendingRepo`、`pendingRepoCommitInFlight`、`worktreeCreating`、`initialUserTurnPending`）。矩阵是数据，能测、能生成文档；它取代 `SESSIONLESS_DAEMON_COMMANDS` / `EXISTING_SESSION_ONLY_DAEMON_COMMANDS` / `isInitialSessionPassthrough` / `topicHeaderDeclaresSpec` 以及路由里为了不产生幽灵会话而前置的 5 个特判。不动存储 ⟹ 回滚免费 |
| R7 | 计划：**跨相位按生命周期定序**（pre-spawn → spawn-args → post-ready → runtime），与文本顺序无关；**runtime 相位内按书写顺序，逐条等 CLI 空闲** | 这是 `#1361` D1 与"级联"的和解：启动期声明、运行期级联，分界就是 CLI ready。执行原语都在：`raw_input` 送透传、`idle-detector` 判空闲、按 session 的命令队列（`#1308`）、`pendingFollowUps` |
| R8 | 透传命令的参数形状由 **adapter 声明**：`none` / `token` / `freeText`；未声明一律 `freeText` | CLI 自己的斜杠命令吃参数（Claude Code `/compact [聚焦说明]`、`/model <名>`），botmux 猜不出同一行里哪部分归 CLI、哪部分是下一轮，猜错比不猜更糟。`freeText` 就是今天"整行逐字"的契约，作为默认零变化；形状是 CLI 的交互语义，探测不了，只能手工声明 + doc-sync 式守卫 |
| R9 | 头部 `/repo wt <目标> [分支]` 复用现有 **pre-fork worktree 路径**（`pendingRepo` 幽灵会话 → `createRepoWorktree` → `commitRepoSelection` → `forkPendingCli`）；`#1361` D5 只在 **git 运行期失败**一处放宽 | 不需要新机制：auto-worktree 与会话内 `/repo wt` 都走这条路，全在 spawn 之前。能提前查的（目标可解析、分支名合法、目标目录不存在）全部 fail closed；git fetch 最长 30s 只能在话题建好后跑，失败时会话停在 `pendingRepo` 并回错误——与今天会话内 `/repo wt` 失败留下的是同一个状态，用户在话题内重发即可 |
| R10 | 兼容原则：**严格扩宽**——老路径接受的每条输入，新路径产生相同效果；新路径只在老路径拒绝的地方增加行为。做不到的地方**显式列出**（§8） | 这是差分测试能直接断言的性质，不靠感觉。头部 `wt` 今天被拒 ⟹ R5 两条规则影响的输入集合为空 |
| R11 | 验证不依赖线上观测：老解析器逐字冻结为**测试内 oracle**，对小字母表**穷举**差分；发布走既有 canary 通道 + 本机 fleet dogfood | botmux 是装在用户机器上的 npm 包，没有上报通道，影子模式/黄金语料/分命令切流在这里是空话。老路由的全部行为在源码里，有限且可读，~20 个现有路由层测试就是兼容契约 |
| R12 | **一刀切**：线上不并存新老路径、无开关；风险按两个各自完整的 PR 分序（§11） | 并存意味着两套语义要同时维护、同时测；开关意味着矩阵翻倍。PR-1 先解决头部 `wt`，不碰路由层；PR-2 换路由器并删老层 |

## 2. 现状：十一层判定与四个解析器

一条新话题消息进 daemon 后按序经过（thread 路径有对应的孪生分支）：

| # | 层 | 位置 | 判"是不是我的"的方式 | 参数怎么解析 |
|---|---|---|---|---|
| 1 | `/summary` 正则 | `src/im/lark/event-dispatcher.ts`（regex 在 `summary-command.ts` 又抄一份） | `^/summary(\s\|$)` | — |
| 2 | 免@ 命令触发 `matchCommandTrigger` | `src/services/command-trigger.ts` | chat 白名单 ∩ 配置命令 ∩ `reservedCommandKind` 兜底 | 第 3 种解析：`commandTriggerArgs` 剥首 token |
| 3 | 话题指令头 `parseTopicHeader` | `src/core/topic-header.ts`，`src/daemon.ts` 新话题入口 | 首 token 为 `/t` `/topic`，标题护栏 | 表驱动，参数单 token |
| 4 | commandTrigger 模板渲染 | `src/daemon.ts` | — | 改写 `parsed.content` **但不改** `cmdContent`（两条平行文本 lane） |
| 5 | messageListener | `src/services/message-listener.ts` | 配置 | 两条 lane 一起整体覆盖 |
| 6 | v3 saved workflow | `src/im/lark/v3-saved-workflow-command.ts` | 自带 `^/workflow` 正则 | 自带 token 切分与每子命令 arity（`cancel` 要 2 个、`list` 要 1 个、`show` 拼尾、`save` 嗅 `--` 旗标） |
| 7 | workflow grill / 旧模板 | `src/im/lark/workflow-slash-command.ts` | **再抄一遍** `/workflow` 正则并重列保留动词 | — |
| 8 | `parseSlashCommandInvocation` | `src/core/command-handler.ts` | 首 token 为 `/` 开头；多行仅 `MULTILINE_COMMANDS` 豁免；含 `<…>` 占位符拒绝 | 只取**首 token** 为 cmd，`content` 是整条原文 |
| 9 | 路由内前置特判 | `src/daemon.ts` | `/sessions` `/vc-auth` `/card` `/cot` `/term` 逐个 `if` | 各自 |
| 10 | 透传 `resolvePassthroughCommands` | `src/core/command-handler.ts`、`src/core/passthrough-commands.ts` | 基础集 ∪ adapter `defaultPassthroughCommands` ∪ bot `customPassthroughCommands`；无 raw 面的 CLI 为空集；**先于** `DAEMON_COMMANDS` 检查 | 不解析，整行 `raw_input` 逐字送 |
| 11 | `DAEMON_COMMANDS` → `handleCommand` 大 `switch` | `src/core/command-handler.ts` | 集合成员 | **~36 个 case 各自** `replace(/^\/cmd\s*/)` + 正则 + split |

命令的"注册"只有五个裸集合：`DAEMON_COMMANDS`、`PASSTHROUGH_COMMANDS`、`SESSIONLESS_DAEMON_COMMANDS`、`EXISTING_SESSION_ONLY_DAEMON_COMMANDS`、`FORCE_TOPIC_COMMANDS`，外加 `MULTILINE_COMMANDS`。没有任何一处声明 arity 或子命令。`/help` 是 ~60 个手写 `t('help.*')` 按固定顺序拼的，只有透传节是算出来的。

同一件事写了两遍的例子：`/repo` 的目标解析（编号 → `lastRepoScan`；否则 `resolveRepoSelection`）在 `wt` 分支与普通分支各实现一次（`src/core/command-handler.ts` `/repo` case 内两处）。

"会话规格"也有三份并行类型：`TopicSpec`（`src/core/topic-spec.ts`）、`ScheduleModelOverride`（`src/core/schedule-model-override.ts`）、`TriggerRequest.options`（`src/services/trigger-types.ts`；`workingDir` 还不是请求字段，由 `resolveWorkingDir` 另算）。

## 3. 语法

单行：

```text
botmux 日常运维 /t /repo wt botmux ci/temp_split /model sonnet[1m] 简单确认下当前依赖的 bun 的版本号
```

多行（等价）：

```text
botmux 日常运维
/t
/repo wt botmux ci/temp_split
/model sonnet[1m]

简单确认下当前依赖的 bun 的版本号
```

会话内（runtime 级联）：

```text
/model opus
/clear
接下来看一下 PR #1361 的评审意见
```

形式化：

```text
message   := [title] command-block body
title     := 仅新话题语境；不含 "/" 开头 token 的文字，≤ 3 行，归一化后 ≤ SESSION_TITLE_MAX
command-block := command-line+          （连续前缀块；新话题以 SENTINEL 开头）
command-line  := command (WS command)* EOL
command   := name [sub] arg*            （name/sub/arg 的 arity 与类型来自 schema）
arg       := token | '"' … '"'
body      := 第一条非命令行起的全部原文，原样保留
```

解析规则：

1. 剥掉对本 bot 的所有 @（沿用 `stripBotMentions`）。
2. 新话题语境：找 `/t` `/topic` 分隔符，之前是标题（护栏不满足 → 不是指令头，整条按普通消息）。会话内语境：无标题，命令块从消息开头起。
3. 逐行读命令块：行首 token 查 schema；命中 → 按 `forms` 消费子命令与参数（最长匹配优先）；同一行余下 token 继续尝试下一条命令。
4. **必选参数**无条件吃；**可选参数**只在下一个 token 匹配其类型模式时吃，且不跨行（R5）。
5. 行首 token 不是命令 → 命令块结束，从该行原始偏移起为正文。
6. 命令块内出现未知 `/xxx`：新话题且已写标题/指令 → 拒绝（`#1361` §3 的"宁可报错不猜"）；裸 `/t` 后紧跟未知 `/xxx` → 正文（D9 兼容，`/t /goal 干活` 落到冷启动路径）。

schema 形状（示意）：

```ts
{
  name: 'repo',
  forms: [
    { args: [] },                                                          // 裸 /repo：默认目录直接开
    { args: [{ kind: 'repoTarget' }] },
    { sub: 'wt', args: [{ kind: 'repoTarget' }, { kind: 'branchName', optional: true }] },
  ],
  runtimeGreedyTail: true,   // #1361 D7：会话内 `/repo <带空格路径>` 整行当路径，只在 runtime 相位生效
  help: 'help.repo',
}
```

参数类型与模式：`repoTarget`（路径/项目名/编号，编号仅 runtime）、`branchName`（git ref 规则）、`modelToken`（`MODEL_TOKEN_RE`，≤ 64）、`effortLevel`（枚举）、`path`。

## 4. 会话相位与合法性矩阵

```ts
type SessionPhase =
  | 'none'              // 无会话（新话题第一条）
  | 'pendingRepo'       // 幽灵会话，等选仓/建 worktree，worker 未起
  | 'worktreeCreating'  // pendingRepo 且 worktreeCreating
  | 'spawning'          // worker 已起、CLI 未 ready
  | 'ready'             // CLI ready、首轮未发（initialUserTurnPending）
  | 'running'           // 正常运行
  | 'closed';           // 持久化 status = closed
```

推导自现有旗标，不新增字段。矩阵初版（实现时逐格补齐，每格一条用例）：

| 命令 | none | pendingRepo / worktreeCreating | spawning | ready / running | closed |
|---|---|---|---|---|---|
| 标题、`/t` 指令头 | 声明 | 拒（`#1361` D6） | 拒 | 拒；"标题+正文+零指令"放行为正文 | 拒 |
| `/repo X`、`/repo wt …` | pre-spawn 钉目录 | 提交选仓（今天的 `commitRepoSelection`） | 排队至 ready | close + refork（今天语义） | 拒 |
| `/model` `/effort` | spawn-args | spawn-args | 排队至 ready 后透传 | 透传（形状见 §6） | 拒 |
| 透传其它（`/compact` `/clear` …） | 拒（无进程；`/goal` 类冷启动例外按 adapter `defaultPassthroughCommands`） | 排队至 ready | 排队至 ready | 透传 | 拒 |
| `/sessions` `/card` `/cot` `/term` `/vc-auth` | 允许，**不建会话** | 允许 | 允许 | 允许 | 允许 |
| `/rename` `/role` `/cd` … | 按今天 `SESSIONLESS_*` / `EXISTING_SESSION_ONLY_*` 归入 | | | | |

矩阵一旦成文，路由里的前置特判、`isInitialSessionPassthrough`、`topicHeaderDeclaresSpec` 都由它替代。

## 5. 计划与执行

解析结果（AST）经 planner 变成有序效果列表：

| 相位 | 效果 | 复用机制 |
|---|---|---|
| pre-spawn | 钉 `workingDir`；建 worktree | `resolveRepoSelection`、`createRepoWorktree`、`commitRepoSelection` 的 `pendingRepo` 分支 |
| spawn-args | 启动模型、推理档位、原生会话名 | `ds.spawnModelOverride`、`session.reasoningEffort`、`updateSessionTitle(…, 'user')`（顺序要求见 `#1361` §4） |
| post-ready | 首轮正文 | `pendingPrompt` + `buildNewTopicCliInput`，`markInitialUserTurnPending` |
| runtime | 透传命令、随后的正文，**按书写顺序逐条**，每条等 CLI 空闲 | `raw_input`、`idle-detector`、按 session 的命令队列、`pendingFollowUps` |

跨相位顺序由相位决定，文本里 `/model` 写在 `/repo` 前后无关。runtime 相位内 `/model opus ⏎ /clear ⏎ 正文` = 送 `/model opus` → 等空闲 → 送 `/clear` → 等空闲 → 送正文。

## 6. 透传命令的参数形状

adapter 上声明（今天 adapter 已声明 `defaultPassthroughCommands`、`modelChoices`、有无 raw 面、`/fast` 的后端限制、能否带 `--model` 启动）：

```ts
passthroughCommands: {
  '/compact': { args: 'freeText' },
  '/clear':   { args: 'none' },
  '/model':   { args: 'token', choices: modelChoices },
  '/fast':    { args: 'none', backend: ['pty'] },
}
```

| 形状 | 同行其余部分 | 例 |
|---|---|---|
| `none` | 作为下一轮排队 | `/clear 接下来看 PR` → 送 `/clear`，空闲后送第二段 |
| `token` | 吃 1 个 token，其余排队 | `/model opus 然后继续修` → 送 `/model opus`，空闲后送 `然后继续修` |
| `freeText` | 整行逐字归 CLI | `/compact 只留登录上下文` → 原样送 |

- bot `customPassthroughCommands` 未声明形状 → `freeText`（今天契约，零变化）。
- 无 raw 面的 CLI（codex-app / RPC / riff）透传集为空集，`/compact` 在那里不是命令，短路转发，与今天一致。
- `/model` 同名两相位：头部是 `--model` 启动参数（能力门 `launch-model-capability.ts`，riff 一律否），会话内是透传键入；schema 的相位区分，adapter 两处各声明。
- 首版只把 Claude Code 与 Codex 两家填准，其余 CLI 默认 `freeText`，逐个补；形状表加 doc-sync 式守卫。

## 7. 头部 `/repo wt` 的落地

1. `resolveTopicSpec` 新增 `worktree?: { repoPath, branch? }`。前置校验 fail closed：目标可解析（`resolveRepoSelection`，编号形式仍拒）、分支名合法、`<repo>-wt-<分支>` 不存在。
2. 把会话内 `/repo wt` 的核心（`createRepoWorktree(repoPath, { branch, slug })` → riff 推分支 → `commitRepoSelection`，含 `worktreeCreating` / `pendingRepoCommitInFlight` 守卫）抽成 `src/services/session-worktree.ts` 的一个函数，头部路径与会话内共用；顺手消掉 `/repo` 两处重复的目标解析。
3. daemon 新话题路径：钉目录 + worktree → 注册 `pendingRepo` → 调共享函数 → commit → fork。`pinnedFromBotDefault=false` 沿用 `#1361`，不会与 auto-worktree 重复建。
4. 无分支时 slug 沿用 `worktreeSlugFromContextAI(title, prompt)`——头部恰好两样都有。

## 8. 兼容性

**严格扩宽**（R10）。按构造保留的老行为（每条已有测试钉着，差分再压一层）：

- `#1361` D7：会话内 `/repo <带空格路径>` 整行当路径（`runtimeGreedyTail`）。
- D9：`/t /goal 修一下` 落到冷启动路径；`/t`、`/t 文案`、`/t /repo X` 三种外部行为不变。
- D6：已有会话里 `关于 /t 这个命令` 放行给 CLI。
- commandTrigger 改 `parsed.content` 不改 `cmdContent` 的双 lane → 路由器**显式输出两条 lane**（`promptText` / `commandText`），不再靠原地改写。
- 透传检查先于 `DAEMON_COMMANDS`；五个前置特判命令在 `none` 相位不建会话。
- `MULTILINE_COMMANDS`（`/schedule` `/role` `/fork`）多行豁免。
- `botAcceptsSlashFromBots`、`reservedCommandKind` 兜底、v3 workflow 在 `/t` 剥离之后运行——顺序不动。

**有意变化**（必须写进 PR 描述）：

| 变化 | 今天 | 之后 | 理由 |
|---|---|---|---|
| 头部 `/repo wt <目标> [分支]` | 拒（`repo_worktree_unsupported`） | 可用 | 直接动因 |
| 会话内"命令行 ⏎ 正文" | `parseSlashCommandInvocation` 因多行拒掉，整条当纯文本转发，`/xxx` 成为 prompt 里的字面文字 | 逐行排队（§5 runtime） | 今天的行为几乎不可能是用户意图；这是唯一一处对"今天已接受输入"的语义变化 |
| `/repo wt` 用法串与帮助行不一致 | 两条互相矛盾 | 由 schema 生成一条 | 自相矛盾的东西修好必然改掉一条 |

## 9. 验证

- **legacy oracle 差分**：把 `parseSlashCommandInvocation`、`parseTopicHeader`、`resolvePassthroughCommands`、`matchCommandTrigger`、`parseV3SavedWorkflowCommand`、`parseWorkflowGrillTrigger` 逐字拷到 `test/legacy-oracle/`（只进测试，不进 dist）。对四元组 `(文本, bot 配置, adapter, 相位)` 断言新路由决策 == oracle 决策：哪层认领、cmd、args、转发还是命令、两条 lane。
- **输入穷举而非语料**：字母表 `{/t, /repo, wt, /model, /effort, /goal, /foo, "带引号", 中文词, latin 词, 换行, @bot}` × 7 个相位 × 3 种 bot 配置（有/无自定义透传、有/无 commandTrigger），长度 ≤ 6 全排列。确定、可复现；仓库没有 fast-check，也不加。
- **严格扩宽断言**：对穷举集中 oracle 接受的每条输入，新路由效果相同；oracle 拒绝而新路由接受的输入必须落在 §8 有意变化表内，否则红灯。
- 现有 ~20 个路由层测试文件不改语义直接跑；`test/topic-directive-header.test.ts` 已跑真 `handleNewTopic` / `handleThreadReply` 只替身飞书副作用，作为 daemon 级基座扩展：头部 `wt` 后 `workingDir` 真落到新 worktree；runtime 级联三条输入按序送达、每条之间等到空闲。
- 透传形状表、schema 与 `slash-commands.md` / i18n 的对齐进 doc-sync 守卫。
- 发布：`-canary.N` tag → `npm i -g botmux@canary` → 本机 fleet dogfood → latest。不动持久化，回滚 = 装回上一版。
- 手动（飞书内）：§3 三个示例各发一条；在一个非 Claude 的 CLI（codex）上验证头部与 runtime 级联；riff 后端验证头部 `/model` 仍按能力门拒绝。

## 10. 影响面

- **共用层**：`daemon.ts` 两条入口、`command-handler.ts` 解析面、`event-dispatcher.ts` 路由判定、`command-trigger.ts`——所有 20+ 个 CLI 都经过。透传形状表按 adapter 声明，未声明按今天契约。
- **后端**：PTY vs riff / mojo / codex-app RPC：透传集为空的 CLI 不受 runtime 级联影响；头部 `/model` 的能力门不变。
- **会话类型**：普通群 `/t` 开出的 thread、话题群、p2p、手动转话题后的第一条；adopt / restore 只经过相位推导，不改语义。
- **不改**：会话中途单发的 `/repo` `/rename` `/model` `/effort` 单条行为一律不变；`commandTrigger` 模板结果不进解析器（`#1361` §8 的安全说明）。

## 11. 分期

两个 PR 各自完整、无开关、线上不并存：

- **PR-1 头部 `wt`**（小，先解痛点）：`topic-header.ts` 支持 `/repo` 的 `wt` 子形式与可选参数两条规则；`topic-spec.ts` 加 `worktree`；抽 `session-worktree.ts`；daemon 新话题路径接入。严格扩宽，不碰路由层。验证：`#1361` §3 边界表 + 本文 §12 新增行；daemon 级用例断言 worktree 落点。
- **PR-2 统一路由器**：`command-schema.ts`、`SessionPhase` 推导与矩阵、纯函数路由器（分类 + 解析 + 计划）、透传形状表、legacy oracle 差分穷举、`/help` 与用法串由 schema 生成、删除 §2 里被取代的层。§8、§9 全部在此兑现。

PR-1 独立有价值；PR-2 若延期，PR-1 不受影响。

## 12. 边界表（在 `#1361` §3 之上新增）

| 输入 | 结果 |
|---|---|
| `/t /repo wt botmux ci/temp_split 简单确认…`（单行，中文正文） | `ci/temp_split` 匹配分支模式 → 分支；正文从 `简单确认` 起 |
| `/t /repo wt botmux 简单确认…`（无分支） | `简单确认` 不匹配 → 无分支，slug 自动推导；正文从 `简单确认` 起 |
| `/t /repo wt botmux fix login bug`（单行 latin 正文） | `fix` 匹配分支模式 → 分支 `fix`，正文 `login bug`。行为确定，用法串提示"latin 正文请换行" |
| `/t ⏎ /repo wt botmux ⏎ fix login bug` | 可选参数不跨行 → 无分支；正文 `fix login bug` |
| `/t /repo wt`（缺目标） | 拒：缺参数 |
| `/t /repo wt 2 x` | 拒：编号形式只对卡片有意义 |
| `/t /repo wt botmux ci/temp_split /repo other` | 拒：重复指令 |
| `/t /repo wt botmux ci/temp_split`，目标目录已存在 | 拒（前置校验），零副作用 |
| 同上，git fetch 失败 | 话题已建，会话停 `pendingRepo` 并回错误；话题内重发 `/repo wt …` |
| 会话内 `/model opus 然后继续修` | `token` 形状：送 `/model opus`，空闲后送 `然后继续修` |
| 会话内 `/compact 只留登录上下文` | `freeText`：整行逐字送 |
| 会话内 `/clear ⏎ 接下来看 PR` | 送 `/clear`，空闲后送第二行 |
| 会话内 `帮我看看 ⏎ /compact` | `/compact` 不在前缀块 → 整条为正文（与今天一致） |
| 会话内 `/foo 干活`（未注册） | 无命令 token → 短路转发（与今天一致） |
| 无 raw 面的 CLI 收到 `/compact ⏎ 正文` | 透传集为空 → 整条为正文（与今天一致） |

## 13. 未决

- 透传形状表首版只覆盖 Claude Code / Codex；其余 CLI 的 `/model` 等命令是否吃参数需逐个核对，核对前默认 `freeText`。
- `SessionPhase` 中 `spawning` 与 `ready` 的边界以 `idle-detector` 首次 ready 信号为准，实现时确认各 backend（PTY / tmux / RPC）都能给出该信号；给不出的后端把 runtime 级联退化为"整条排队至首轮之后"。
- 头部 git 运行期失败留下的 `pendingRepo` 状态，是否需要一条"取消并关闭话题"的快捷命令，用一阵再看。
- 预设别名（`#1361` §8）在 schema 就位后成为"结构化展开"的自然扩展，本设计不做。
