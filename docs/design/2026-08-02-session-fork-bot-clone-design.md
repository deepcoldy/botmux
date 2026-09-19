# botmux 会话 Fork / Branch（Bot 分身 & 断点）设计文档

> 状态：设计定稿（PR1 待开工 / PR2 待产品讨论）
> 作者：Relay-Claude
> 基线：`origin/master` @ `d441baac`
> 关联：`/relay`（最近亲）、`transferSession`（worker-pool.ts:1787）
> 分支：`feat/session-fork`

---

## 0. 一句话结论

在 botmux 里引入 **`/fork`**：把一个正在跑的会话，在**当前上下文节点**复制出一条**带完整记忆的独立会话**，源会话原封不动照常跑。

- **技术上**：能依赖 CLI 原生 fork 就依赖原生（Claude `--fork-session`、`codex fork`），botmux 只做 ① 后端能力适配、② 与现有框架的"套壳关联"（新建会话壳 + IM anchor 分裂 + resume）。botmux **不碰上下文文件**。
- **产品上**：`/fork` 有**两种模式**，同一个底层原语、按"当前位置有没有地方落"自动分流：

  - **并行分身模式（Fork）**——落到别的群/话题，两条会话并行。对齐官方 `/branch` 语义、无破坏性 → **PR1，先落地**。
  - **原地切换模式（Branch）**——非话题群没法并行时，关掉当前会话、在新分支上继续（可恢复）。是自创用法、有风险 → **PR2，先与仓库管理员对齐产品原型再做**。

> 实测已确认（2026-08-02）：Claude 冷启动 `--resume <父id> --fork-session`（带 botmux 全部限制 flag）**不触发交互式 /fork 的提权门禁**，正常 fork、继承上下文、父不动、内部逐行 id 由 CLI 官方改写；`codex fork` 用户实测正常。两个主力后端都能纯用原生原语。

---

## 1. 背景与需求

### 1.1 触发场景（用户原话提炼）

> 在 A 群聊一个任务，任务还在跑；B 群也要用它积累的上下文继续对话。A 群原会话继续、不受影响；B 不需要把新进展同步回 A（**单向**）。

### 1.2 现有能力的缺口

| 能力 | 行为 | 为什么不够 |
|-|-|-|
| `/relay` | 把会话**搬迁**到另一个群 | 是**移动**：原会话被冻结、worker 被 kill、路由改写，原地不能继续。用户要"A 还继续" |
| `/t 新话题` | 开全新会话 | **不继承**任何上下文 |
| `resume` | 恢复**已关闭**的会话 | 不是复制，且要求先关原会话 |
| 手工 handoff | 会话把状态写文件、新会话读 | 只继承**摘要**，丢失逐字工具输出；且要人工操作 |

**结论**：用户要的"非破坏性 + 带完整上下文 + 单向复制"，现有能力无一覆盖。仓库里也**没有任何 fork/branch/断点相关的提交或在途 PR**（已核查 git 历史 + 全部 PR 到 #702），是一块空白。

### 1.3 定位

**会话 fork = 从某一时刻切一份带记忆的独立会话，父子各走各的、互不影响。** 不是"实时镜像"（无双向同步），不是"移动"（源不消失）。落在 fork 语义里最简单的一档：单向、非破坏性。

### 1.4 明确不做：原地 rewind

调研过官方做法（见附录 A）：Claude Code 有 `/rewind`（每个 prompt 自动检查点、可逐步回退代码/对话）。但它粒度过细、要双轨追踪 + 一堆边界（bash/subagent/符号链接不追踪），**透传到 botmux 成本高**。本设计**不做原地 rewind**，只做"分支式"——由人主动在干净点切一份。

|  | 分支式（**做**） | 原地 rewind（**不做**） |
|-|-|-|
| 行为 | 复制出第二条会话，原的继续 | 把同一条倒带回更早点、丢弃之后 |
| 类比 | git branch、`codex fork` | git reset、ChatGPT 编辑重发 |
| 原生 | `--fork-session` / `codex fork` 天然支持 | 原生 fork 都不做，需截断 transcript，重且危险 |

---

## 2. 核心概念：Fork 与 Branch 是同一原语的两种模式

这是整个设计的主心骨。**底层只有一个"复制一条会话"的原语（`forkSession`），Fork 和 Branch 只是它的两种落地形态**，由一条物理约束决定走哪种：

> **botmux 铁律：一个 anchor（群 / 话题）对同一个 bot 只能挂一个活跃会话**（`activeSessions` 以 `sessionKey(anchor, larkAppId)` 为 key，入站消息一个 anchor 只 resolve 出一个会话）。

所以关键就看 **`/fork` 时当前位置有没有"空闲 anchor"给分身落**：

| 你在哪 `/fork` | 有空闲 anchor？ | 行为 | 概念 | 交付 |
|-|-|-|-|-|
| 话题群本群 | ✅ 能开新话题 | 就地开新话题放**并行**分身 | **Fork** | PR1 |
| 别的群 / `--create` 新群 | ✅ 别处/新群 | 落到别处**并行**分身 | **Fork** | PR1 |
| **非话题群本群** | ❌ 唯一 anchor 被占 | 问你要不要 **close 当前、切到新分支**（可恢复） | **Branch** | PR2 |

### 2.1 两种模式的本质区别

|  | 并行分身模式（Fork） | 原地切换模式（Branch） |
|-|-|-|
| 落点 | 不同群/话题 | 同群（非话题群），同一 anchor |
| 并行性 | 父子**同时活跃**、各聊各的 | 同一时刻**只一条活**，其余休眠 |
| 源会话 | 原封不动继续 | 被 **close**（可恢复），让位给新分支 |
| 切换 | 不用切，各群各聊 | 靠 close + resume 在分支间**切换**（像 git checkout） |
| 破坏性 | **无**（源不动） | **有**（关掉当前会话） |
| 官方背书 | = 官方 `/branch` 语义 | 自创组合，无原生对应 |

### 2.2 关于"断点"：它就是原地切换模式（Branch）

用户最初的"打断点"诉求（怕后续操作弄脏上下文，先存一档）——本质就是原地切换模式（Branch）：

- **断点可以有多个**：每次 fork 都是独立 session（独立 id + 独立 transcript），磁盘上不互相覆盖，能存任意多个。
- **同群同一时刻只激活一条**：受 anchor 铁律约束，多个断点不能在同一群同时挂着。
- **恢复靠"切换"不是"并列"**：每个断点都能恢复，但恢复到某群前要先 close 当前那条——完全是 git branch 的心智（多分支都存着，工作区一次 checkout 一条）。

> 所以"断点只能一个 / 只能恢复一次"是误解：**断点可存多个、一次激活一条、靠切换**。想同时看多个断点 → 把它们 fork 到不同群/话题，那就变回并行分身模式（Fork）了。

### 2.3 两种模式的信息连接（普通群顶层「双出路卡」）

Fork 和 Branch 在**普通群顶层 chat-scope 会话的 `/fork`** 这个分支交汇。此处不是直接拒绝，而是提供两种处理方式（PR2 完整形态）：

> **本群是普通群，放不下并行分身。你可以：**
> ① **关闭当前会话、在新分支继续（Branch，可恢复）** — 适合"存个断点、换条干净的走"
> ② **Fork 到新群（保留当前会话并行）** — 适合"两边都要"

一张卡同时提供两种处理方式。**已有独立会话的话题直接走 Fork，不显示这张卡；承载群可以是普通群，也可以是话题群。**

> PR1 阶段：普通群顶层 chat-scope 会话暂时只提供「② Fork 到新群」，并提示「原地断点 Branch 待后续版本」；PR2 再接入 ①（含二次确认与风险提示，见 §7）。

---

## 3. 使用路径与卡片流（PR1 · 并行分身模式 Fork）

设计原则：**贴着 `/relay` 已有的寻址方式**，用户不学新范式。

### 3.1 路径 A：`/fork --create <群名> @bot` — 分身到新建群

对标 `/relay --create`。在源会话处输入 → botmux `createGroupWithBots` 建群拉 bot → 复制上下文到新 sessionId 落新群、发新会话卡 → **源会话不动** → 用户去新群 `@bot` 直接聊，带完整上下文。
（私聊变体：不 @ 任何人 → fork 到该 bot 单聊。）

### 3.2 路径 B：在目标群 B 里 `/fork` — 分身到已有群

对标 `/relay` 选择器。B 群 `/fork` → 弹**选择器卡**（列本人名下可 fork 的活跃会话）→ 选中确认 → 上下文复制进 B 群成新会话，源不动。文案为"复制/分身"（区别于 relay 的"搬迁"）。

### 3.3 路径 C（已有会话话题）：`/fork` 开新话题

在已有独立会话的话题里 `/fork` → 同群开一个新话题放分身，原话题会话不动。承载群可以是话题群，也可以是包含原生话题的普通群；权限和会话隔离取决于 thread-scope 会话锚点，不取决于群类型。

### 3.4 卡片流全景

| 场景 | 命令/位置 | 弹卡 | 结果 | 交付 |
|-|-|-|-|-|
| 建新群 | `/fork --create <群名> @bot` | 不弹选择器 | 新群 1 张会话卡 + M1；源不动 | PR1 |
| 到已有群 | 在 B 群 `/fork` | **选择器卡** | 选中确认 → B 群新会话卡；源不动 | PR1 |
| 已有会话话题（普通群或话题群） | `@bot /fork` | 不弹卡 | 本群新话题会话卡；原话题不动 | PR1 |
| 普通群顶层 chat-scope 会话 | `@bot /fork` | PR1：仅「Fork 到新群」引导；PR2：**双出路卡** | 见 §2.3 | PR1 部分 / PR2 |

> **新会话卡本身就是「创建成功」信号**，不再单发「已创建」文本。只有「到已有群选择器」和「普通群顶层双出路卡」才显示操作卡。

### 3.5 血缘与区分标题

fork 出的 child 自动写区分标题 `🔱 <原标题>`（source=`system`，复用 `updateSessionTitle`）+ 血缘字段 `forkedFrom`。避免父子在选择器/看板里标题雷同分不清。父是谁放 provenance 字段（详情里看），不塞进标题以免过长。

---

## 4. 能力门控（单层：按后端能力，不加 per-bot 开关）

`/fork` 是 opt-in 命令，不用不触发，所以**不需要 per-bot 开关**。唯一判断是"这个后端物理上能不能 fork"，内置在命令里：

| 后端 | 上下文存储 | Fork | 说明 |
|-|-|-|-|
| Claude 系（claude-code/seed/relay/aiden） | 本地 `<id>.jsonl` | ✅ | 原生 `--fork-session`（已实测） |
| Codex CLI 终端模式 | 本地 `rollout-*.jsonl` | ✅ | 原生 `codex fork`（已实测） |
| CoCo | 本地目录 | ⚠️ 后续 | 目录拷贝可行，但共享全局 history.jsonl |
| Codex App / Codex CLI 开了 Hybrid RPC | app-server 进程 + SQLite 活会话 | ❌ 默认关 | 拷 rollout 让 app-server 认新 thread 未验证 |
| Riff 等纯远端 | 远端沙箱 | ❌ | 本地无可复制 rollout（可选走原生 parentTaskId，后续） |

**不支持的后端输 `/fork`**：复用现成 typed-refusal 范式，handler 开头判 `cliId`，回一句明确中文并 break，**不误跑、不污染会话**：

> `ℹ️ 当前 {cli} 会话走 app-server 活会话，暂不支持 fork（目前仅 Claude 系 / Codex 终端模式）。`

---

## 5. 技术方案（优雅 = 最大化复用 transferSession + CLI 原生 fork）

### 5.1 核心洞察：Fork = transferSession 的非破坏性兄弟

`transferSession`（worker-pool.ts:1787，即 `/relay` 底层）已经把"跨群/跨话题重新落一个会话"的全部机制写好了。**但 relay 是"移动同一个会话壳"（sessionId 不变、CLI 进程不新建、只改路由 + kill 旧 pane 重 attach）**。Fork 要做的是它的**非破坏性 + 复制版**：

| transferSession 步骤 | Fork 是否保留 |
|-|-|
| 前置守卫（not_started / adopt / busy / vc-receiver / anchor 冲突） | ✅ 全保留 |
| 冻结源卡片 `buildRelayedFrozenCard` | ❌ 不做（源会话继续） |
| `killWorker(源)` | ❌ 不做（源 worker 继续跑） |
| `activeSessionsRegistry.delete(源 anchor)` | ❌ 不做（源留在注册表） |
| 改写路由字段 | ❌ 不改源，改**新建的 child** |
| `setActiveSessionSafe` + `forkWorker(resume=true)` | ✅ 但作用于 **child** |

### 5.2 双 id 模型（为什么 native fork 能干净接入）

一个会话记两个 id（session-store.ts:360）：`sessionId`（botmux 自己的壳 id）与 `cliSessionId`（CLI 原生 id，随 resume/rotation 更新）。`persistCliSessionId()`（worker.ts:6131）在 CLI 换 id 时把新原生 id 写回 `cliSessionId`，壳 id 不变。所以 **native fork 由 CLI mint 的新原生 id，botmux 只需回读并存进 child 的 `cliSessionId`，与壳 id 解耦**——与现有 Codex 实现同构。

### 5.3 `forkSession()` 步骤（新增于 worker-pool.ts）

1. **能力门控**：判 `cliId`，不支持返回 typed error（上层转 refusal）。
2. **前置守卫**：复用 transferSession 的 not_started / adopt / busy / vc-receiver / 目标 anchor 冲突。
3. **mint 子会话**：`sessionStore.createSession` 出新 UUID 作 childSessionId；记 `forkedFrom`。
4. **继承上下文（crux）——优先 CLI 原生 fork**：

   - Claude 系：spawn 传 `--resume <srcCliSessionId> --fork-session`；CLI 自己 mint 新 id、改写内部逐行 id、父文件不动。botmux 回读 childCliSessionId 并持久化。
   - Codex 终端：`codex fork <srcCliSessionId>`；新建 rollout、拷父到分叉点、记 `forked_from_id`。
   - 兜底（仅个别变体不支持时）：手动 `atomicCopyClaudeResumeTranscript` + `checkResumeTargetExists`。
5. **构造 child DaemonSession**：按 restore 模板建 `worker:null` child，路由字段设成**目标 anchor**，`streamCardId=undefined`（发新卡）；**源 ds 完全不碰**。
6. **注册 + resume-spawn**：`setActiveSessionSafe(目标 anchor, childDs)` → `forkWorker(childDs,'',resume=true)`。child 独立 pane/webPort/workerGeneration。

### 5.4 命令接线 + 复用清单

- `passthrough-commands.ts`：`/fork` 加进 `DAEMON_COMMANDS`；`command-handler.ts`：加 `case '/fork'`，参数解析仿 `/relay`。dispatch 现有路由无需新接线。

| 复用件 | 位置 |
|-|-|
| 守卫 / anchor 冲突 / 路由骨架 | `transferSession` worker-pool.ts:1787 |
| 建群拉 bot | `createGroupWithBots` |
| 目标 anchor/scope 解析 | `resolveRelayTargetRouting` |
| CLI 原生 fork（首选） | `--fork-session` / `codex fork` |
| transcript 定位 / 拷贝 / 校验（仅兜底） | `resolveSessionTranscriptPath` / `atomicCopyClaudeResumeTranscript` / `checkResumeTargetExists` |
| childCliSessionId 回读 | `resolveJsonlFromPid` / native-title 机制 |
| worker 重连 | `forkWorker(resume=true)` |
| typed refusal | 现有 relay/insight/rename + i18n |

**真正新增**：一个 `forkSession()`、一个 `/fork` command case、选择器确认分支、若干 i18n。**上下文复制交给 CLI 原生，botmux 不重造。**

---

## 6. 边界情况（实现必须处理）

1. **源会话 mid-turn**：切点不完整 → 复用 `worker_busy` 守卫拒绝，提示等 idle。（全场景）
2. **目标 anchor 占用校验**（per-bot，`sessionKey` 带 larkAppId，同群不同 bot 互不冲突）：

   - `--create` 新群：正常空群不撞；万一拉入 bot 已在新群有会话 → 拒绝并如实报告"未落入"，不留半吊子。
   - 选择器到已有群：目标群已有该 bot 会话 → **必拒**，提示先 close。
   - 话题群新话题：新 anchor 天然不撞。
   - 关键区分：跨群"目标已有会话 → 拒绝，不覆盖别人"；非话题群本群"已有会话 → 提示 close 换"（原地切换模式 Branch，PR2）。
3. **权限**：只有会话发起人（ownerOpenId）能 fork（复用 relay picker 门）。
4. **连续 fork / 卡片堆叠**：靠 `🔱` 血缘标题 + 来源标注区分；注意选择器别被自己 fork 出的一堆占满。
5. **【原地切换模式 Branch / PR2】确认卡 TOCTOU**：弹卡到点击间源状态可能变（busy / 被 close / anchor 易主）→ **点击时刻重校验**，不凭旧状态执行（照抄 relay confirm）。
6. **【原地切换模式 Branch / PR2】顺序安全（最危险）**：必须**先 fork 起成功、再 close 原会话**；先 close 后 fork 失败 = 用户两头空。失败须能把原会话恢复回来。
7. **【原地切换模式 Branch / PR2】恢复撞 anchor**：点「▶️恢复会话」时本群已有活会话 → 命中 `resume_anchor_occupied` 被拒；恢复卡文案须提示"先 close 当前"。

---

## 7. 交付拆分

### PR1 — 并行分身模式 Fork（跨群 / 跨话题并行分身）· 先做，可独立落地

- **范围**：`/fork --create <群名> @bot`（建新群）+ `/fork` 选择器（到已有群）+ 已有会话话题在同群开新话题（普通群或话题群均可）；普通群顶层 chat-scope 会话暂给「Fork 到新群」引导。
- **后端**：Claude 系 `--fork-session` + Codex 终端 `codex fork`；app-server / 不支持后端 typed-refusal。
- **实现**：`forkSession()` = transferSession 非破坏性兄弟 + CLI 原生 fork；child 自动 `🔱` 标题 + `forkedFrom` 血缘。
- **验收（真实流程，非实现细节）**：A 群 fork 到 B 群 → ① B 群分身记得 fork 前完整上下文 → ② A 群原会话照常跑不受影响 → ③ A、B 双活并发各写各的不串扰。
- **依据**：对齐官方 `/branch` 语义、无破坏性、与 relay 框架同构，不需产品拍板即可推进。

### PR2 — 原地切换模式 Branch（普通群顶层 close-换-fork 断点）· 先与仓库管理员确认产品原型再做

- **玩法**：普通群顶层 chat-scope 会话执行 `/fork` 时显示**双出路卡**（§2.3）；选择「关闭当前、在新分支继续」→ close 当前会话（自动保留「▶️恢复会话」卡）→ 在同一 anchor 启动新分支。无需新增指令，复用现有 close 和恢复卡。
- **为何单独 PR**：Codex（`resume/fork/archive/delete/unarchive`）与 Claude（`--fork-session`）**都无原生 checkpoint/restore**，这是自创组合，方向须先与上游/产品对齐；且它**会关掉用户当前会话**，有破坏性。
- **必须向用户披露的风险**（自创用法，不能默默引导）：

  1. **非官方**：CLI 升级 / botmux 会话模型重构可能失效，不保证长期稳定。
  2. **不能并行**：同 anchor 一次一条活，回原会话须先 close 当前（`resume_anchor_occupied`）——与"分身并行"不同。
  3. **恢复非事务级**：走 CLI resume，transcript 清理 / CLI 版本变化可能失败；"大概率能回"，非可靠存档。
  4. **心智易混**：是"换一条、旧的睡了"，不是又多个分身。
- **落法**：双出路卡内嵌风险提示（"⚠️ 实验性用法：关闭的会话可尝试恢复但不保证成功，且本群同时只能有一个活跃会话"），知情后选择。
- **复用**：底层仍是 PR1 的 `forkSession` + 现成 close/恢复卡，PR1 落地后 PR2 主要加"双出路卡 + close-then-fork 编排 + 风险文案"。

### Fast-follow

CoCo 目录拷贝；Riff 原生 parentTaskId 分支；`/fork` 同话题快速分身。

### 明确不做

原地 rewind（§1.4）；双向同步；app-server 活会话字节级 fork；PR1 阶段任何 close-换-fork 行为（归 PR2）。

---

## 8. 待确认

1. 命令名 `/fork`（还是 `/clone`）？
2. PR1 后端范围（Claude 系 + Codex 终端）、app-server 默认 refusal，是否 OK？
3. PR2 的双出路卡形态与风险文案，是否需要先出一版给管理员评审？

---

## 附录 A：官方/主流"保护上下文"方案调研（2026-08-02）

| 方案 | 谁有 | 作用 | 与本设计关系 |
|-|-|-|-|
| `/rewind` 检查点 | Claude Code | 每 prompt 自动打点，可只回退对话/代码 | 粒度太细、透传复杂，**不做** |
| `/branch` / `--fork-session` | Claude Code | 复制对话到新会话、原会话不动 | **= 我们的并行分身模式（Fork）**，官方背书 |
| subagent 隔离 | Claude Code / Codex | 脏活丢给子 agent，只带结论回主上下文 | 更优的"预防"思路，未来可借鉴 |
| `/clear/compact` plan mode | Claude Code | 上下文卫生常规手段 | 辅助 |
| `codex fork` / `resume` | Codex | fork 出新 rollout、resume 历史 | **= 我们的并行分身模式（Fork）**（Codex 侧） |
| `/undo` + git | Aider | 回退 git commit、清对话 | 偏 git，无会话分支 |

要点：Fork/branch 是 Claude Code 较独有的成套设计；Codex 有 fork 无 rewind；Aider 只有 git undo。**我们做的并行分身模式（Fork）有官方语义背书；原地切换模式（Branch，close-换-fork）是自创，故需产品讨论 + 风险披露。**

## 附录 B：关键实测结论（2026-08-02）

- Claude 交互式 TUI `/fork` 在带限制 flag 时**拒绝**（提权保护）；但**冷启动**`claude --resume <id> --fork-session <botmux 同款 flag>`**不拒绝**，正常 fork、继承上下文（暗号复制成功）、父文件 8→8 行不变、新文件内部逐行 id 全改写为新 id。→ Claude 路径用原生 `--fork-session` 成立，物理拷贝降为兜底。
- `codex fork` 用户实测：新 rollout id、`forked_from_id` 血缘、父不动、前缀一致后分岔。→ Codex 路径成立。
- **唯一待真实环境验证**：父子双活并发写（两个 worker 同时各写各文件不 clobber）——单机 CLI 复现不了，PR1 验收必测。

## 附录 C：真实 botmux 端到端测试记录（2026-08-02）

测试方式：把单个 bot 的 daemon 用 `stop-bot`/`start-bot` 隔离切到本分支 build，不影响其它 bot；发真实飞书消息，核对 daemon 日志 + on-disk transcript + 会话存储。

### Codex 端（seed0630 = `botmux-Seed-2.1-Pro-exp0630`，codex + super-relay-xhigh wrapper）

| 验证点 | 结果 |
|-|-|
| `/fork --create` 命令进入 handler | ✅ `[3e355eca] Command: /fork` |
| 原生 `codex fork <源id>` 真正调用 | ✅ `codex fork … 019fc216-6b41-…`（wrapper 透传 fork 子命令）|
| 独立新 rollout + `forked_from_id` 血缘 | ✅ `rollout-…-019fc216-f7a4-…` 头含 `forked_from_id=019fc216-6b41-…` |
| 分身在新群答出暗号 | ✅ 答「暗号是：PINEAPPLE-八六三一」 |
| 源会话不动 | ✅ 源 rollout 5 处暗号命中未变、id 不变 |
| child 持久化自己新 id | ✅ `cliSessionId=019fc216-f7a4-…`、`forkedFrom=3e355eca` |
| Dashboard 父子并存 | ✅ 源「记住暗号…」+ 分身「🔱 记住暗号…·fork测试群」两条独立 |
| 同源多次 fork | ✅ 连续 fork 多个 child，各自独立、源始终不动 |

### Claude 端（Relay-Claude2 = `cli_aae5948f82789ce4`，claude-code + super-relay-opus wrapper）

| 验证点 | 结果 |
|-|-|
| `/fork --create` 命令进入 handler | ✅ `[06d7815b] Command: /fork` |
| 原生 `--fork-session` 真正调用 | ✅ `claude-super-relay-opus --resume 06d7815b… --fork-session …`（wrapper 透传）|
| 分身继承上下文 | ✅ child transcript `f473c3a7…` 中暗号 MANGO 出现 6 次 |
| 源会话不动 | ✅ 源 `06d7815b` 17 行、暗号 5 处未变 |
| child 拿自己新 id + 血缘 | ✅ `cliSessionId=f473c3a7…`、`forkedFrom=06d7815b`、`🔱` 标题 |

### 测试中发现并修复的问题

| # | 问题 | 修复 |
|-|-|-|
| 1 | 建群后才做真实会话检查 → 拒绝时留空群 | 守卫全部提到建群前 |
| 2 | forkSession 建群后失败仍可能留空群（窄竞态）| 失败时 best-effort disband 空群 |
| 3 | 裸 `/fork` 复用"没会话"话术、误导 | 改为面向产品的"本群暂不支持原地 fork，用 --create"提示 |
| 4 | `/fork --create` 要求 @bot、当前 bot 还要 @ 自己一遍（冗余）| 无 @ 默认当前 bot；@ 别的 bot 才校验并拒 |
| 5 | child fork 后 `pendingForkSession` 未清（worker/daemon 抢写）| 在 worker 侧写 cliSessionId 的同一次写里清标记 |

### 仍未在真实环境验证

- **父子双活并发写**：父会话与分身同时各发消息、各写各的 transcript 不互相 clobber。已顺序验证父子独立；并发压测未做（单机 CLI 复现不了，需两个 live worker 同时活跃）。**建议合并前或紧接着补一次并发验收。**
