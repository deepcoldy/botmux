# a2a 任务依赖边：planned 状态 + 多依赖 + 安全自动释放

- 状态：设计稿 **v3**（v2 终审 4 缺口 + 2 实现钉全部收进；codex 按 PR-1 开始实现，claude review）
- 讨论线：2026-07-17 老滕提出「a2a 不支持流程固化、丢 DAG 后依赖无保证」→ claude 提案 → codex 四点收紧 + 三钉子 → v1 → 契约审查（H1-H4）→ v2 → 终审（失败持久化 / append-replay 分层 / claim 精确绑定 / cancel 幂等）→ 本稿
- 范围：短期方案。**不**并入 workflow v3；长期 v3 跨 bot 节点直接调用本稿定义的交付原语。

## 1. 背景与问题

A2A 编排（goal 群 + dispatch + delivery ledger）固化的是交付协议（任务生命周期事件 + 验收 + 账本），不固化流程。「workerA 依赖 workerB 的结果」目前只有一个保证机制：L2 监管者串行派活的行为约定（skill 教的，靠 LLM 自觉）。`TaskView` 无依赖字段；L2 上下文丢失后，依赖边若没写进 charter 就永久丢失；worker 侧无 gate，dispatch 出去就开跑。

风险：提前派发下游、下游拿不到上游产物、L2 复活后凭记忆重建依赖出错。

## 2. 目标 / 非目标

**目标**
- 依赖边进账本，由机制而非 LLM 记忆承担「A 依赖 B」。
- 下游任务在依赖全部 accepted 前不打扰 worker（不发消息）。
- 依赖满足后自动派发，且派发具备崩溃一致性与多进程一致性；**释放的每个结局（成功/确定失败/不确定）都持久化在账本里**，daemon 重启后行为完全由账本决定。
- 上游异常不机械级联，决策留给监管者。
- 对端零升级：接收端看到的就是普通 dispatch，不加新 a2a capability。

**非目标**
- 不做跨 goal 依赖（依赖只能指向同 goal 任务）。
- 不做流程模板/固化复跑（那是 v3 跨 bot 节点的事）。
- 不做产物文件自动搬运（默认只传元数据，见 §6）。
- 不做 worker 侧 gate（v1 由监管者侧 daemon 延迟物化，不改接收协议）。

## 3. 账本事件与状态机

actor 沿用现有 `LedgerActor = 'orchestrator' | 'worker'`，不扩类型；人/daemon 的身份记在 payload（`plannedBy` / `releasedBy` / `confirmedBy` / `failedBy`）。

### 3.1 新事件

```
TaskPlanned            actor: 'orchestrator'
  payload: {
    taskId, chatId, title,
    dependsOnTaskIds: string[],      // 声明序保留，≥1，去重
    planGeneration: number,          // 1 起；重开 +1（§4.2）
    reopenOfCancelEventId?: string,  // gen≥2 必填：被重开的那次 cancel 的 eventId
    dispatchSpec: {                  // 冻结的派发参数——下表即全集，无省略；
                                     // 新增派发参数必须显式进此表并更新回归
      title: string,
      briefBase: string,             // 用户写的 brief 原文（未注入上游元数据）
      workers: DispatchWorkerMeta[], // --bot 解析结果（openId/name/larkAppId/cliId/unionId/role）
      senderLarkAppId: string,
      requiredRepo?: string,         // --needs-repo 归一化结果
      acceptanceHint?: string,
      acceptanceCriteria?: AcceptanceCriteria,
    },
    plannedBy: string,               // openId / session
  }
  idempotencyKey:
    gen 1: `planned:<taskId>`
    gen≥2: `planned:<taskId>:<reopenOfCancelEventId>`

TaskDispatchIntent     actor: 'orchestrator'
  语义：**已认领本次释放**（排他），不代表消息已发。
  payload: {
    taskId,
    releaseId: string,               // §5.4，同时用作飞书 uuid
    attempt: number,                 // 0=自动；≥1=人工重试释放（§5.6）
    planEventId: string,
    planGeneration: number,
    satisfiedBy: Array<{ taskId, acceptedEventId }>,    // 按 dependsOn 声明序（§5.3）
    senderLarkAppId: string,
    goalChatId: string,
    frozenKickoffText: string,       // 注入上游元数据后的最终发送字节（§6）
    frozenWorkerSpecs: DispatchWorkerMeta[],
    frozenDispatchedPayload: TaskDispatchedPayload,     // 成功后 append 的最终 payload（除 dispatchMessageId）
    releasedBy: string,              // 'daemon:<larkAppId>' 或人工重试的 openId
  }
  idempotencyKey: `intent:<releaseId>`

TaskDispatchFailed     actor: 'orchestrator'          // 终审缺口 1：释放失败持久化
  payload: {
    taskId,
    releaseId, planEventId, planGeneration, attempt,
    failureClass: 'definite' | 'ambiguous',
      // definite  = 确定未送达（readiness error 级、飞书 4xx、参数拒绝）→ 本 releaseId 永不自动重试
      // ambiguous = 消息可能已发（超时、5xx、网络中断）→ 55min 窗内同 uuid 重试，窗外转人工
    code: string,                    // 如 'readiness:worker_not_in_chat' / 'lark:99992351' / 'net:timeout'
    detail: string,
    failedBy: string,
  }
  idempotencyKey: `dispatch-failed:<releaseId>:<failureClass>`
    // 每 releaseId 每类别至多一条；窗内同 uuid 重试再次超时不重复记账。
    // pendingRelease 投影取该 releaseId 的最新失败事件。

TaskDispatched（现有）payload 追加：
  releaseId?: string                 // 自动释放路径必填
  dispatchMessageId?: string         // 飞书回执；人工「确认已派」可缺省
  confirmedBy?: string               // 人工确认路径记录 openId
  自动释放路径 idempotencyKey: `dispatched:release:<releaseId>`
```

### 3.2 状态机与双层守卫（终审缺口 2）

`TaskStatus` 增加 `'planned'`：

```
planned ──(当前代所有依赖 accepted，三段式完成)──▶ dispatched ──▶ 现有生命周期不变
planned ──(TaskCancelled)──▶ cancelled ──(TaskPlanned gen+1，§4.2)──▶ planned
```

守卫分**两层**，规则相同、反应不同，测试分开覆盖：

**append 层（锁内拒绝，新写入不落账）**：`ledger.append` 在 withLock 临界区内先 materialize 当前投影，以下非法 draft 直接返回结构化错误，调用方转成用户/信封反馈：
- planned 任务上的 `TaskReported` / `TaskAccepted` / `TaskRejected` / `TaskHelpRequested` / `TaskEscalated`（envelope-ingest 前置返回新 outcome `task_not_dispatched`）；
- 曾 planned 的 taskId、无匹配当前代 open Intent 的 `TaskDispatched`（普通 CLI 不能旁路依赖门）；
- gen≥2 `TaskPlanned` 但当前状态非 cancelled，或 dependsOnTaskIds 与 gen1 不一致；
- `TaskDispatchIntent` 但校验不过（§5.1 claim 是唯一写入口）。

**replay 层（防御，绝不 throw）**：materialize 对历史事件中的同类非法组合 ignore + warning——旧账本 / 被外部篡改的账本不能打爆读者。

其余 reducer 规则：
- `TaskPlanned` gen1 创建 task，status='planned'；gen≥2 生效时 status 回 'planned'，dispatchSpec 以新代为准；依赖边只认 gen1。
- `TaskDispatchIntent` / `TaskDispatchFailed` 不改 status，投影进 view.pendingRelease（releaseId/attempt/最新 failureClass/时间）。
- `TaskDispatched`（带匹配 releaseId）把 planned→dispatched，之后走现有生命周期。
- `TaskCancelled` 对 planned 生效（status='cancelled'）。从未 planned 的任务全部现有语义不变。

### 3.3 watchdog 隔离

planned 状态对 goal watchdog 的**所有**探测不可见：不进失联判定、不进 stale 探测、不进重派预算。依赖相关的注意力提醒**全部由释放引擎产出**（§8），回归测试覆盖「planned 存在时 watchdog 零动作」。

## 4. 依赖声明与校验

### 4.1 声明

CLI 面：`botmux dispatch --after <taskId>`（可重复=多依赖）。带 `--after` 时走 planned 路径（写 TaskPlanned，不发消息）；不带则完全走现有路径，零行为变化。

创建时校验（任一失败即拒绝，不写账本）：
1. 所有 `--after` 的 taskId 在**同一 goal**（chatId 相同）的账本中已存在；
2. 不得自依赖；
3. `--after` 不与 `--standby` / `--into` / `--new-topic` 同用（v1 只走 chat-scope 单消息派发）；
4. `--after` 不与 `--skip-readiness-check` 同用——一次性人工绕过不应被数小时后的自动释放继承；释放时的 readiness 复检失败走 §5.5 的 definite failure + 人工处理。

**按构造无环**：依赖只能在创建时声明、只能指向已存在任务、无追加依赖操作、重开不得改边 ⇒ 账本 append 序即拓扑序，环在结构上不可能。环检测保留为防御性断言（发现即 escalate，说明账本被外部篡改）。

### 4.2 cancel 后同 taskId 重开（plan generation）

保持现有「同 taskId 重开」产品语义：
- planned/已释放任务被 cancel 后，重开 = 写 `TaskPlanned` gen+1：**依赖边必须与 gen1 完全一致**（CLI 显式重述同一 `--after` 集合，不一致报错并列出原始边）；dispatchSpec 可更新；status 回 'planned'，依赖门重新评估。
- idempotencyKey 绑定被重开的 cancel eventId：同一次 cancel 的重开重试幂等，每次新 cancel 允许一次新重开。
- releaseId 取最新代 planEventId，天然与旧代 Intent 区隔。
- CLI 守卫：对「曾 planned 且当前 cancelled」的 taskId 执行不带 `--after` 的 dispatch → 报错引导。

### 4.3 取消幂等键（终审缺口 4）

现状 `cancelled:<taskId>:<latestDispatch?.eventId ?? 'unknown'>` 对 planned 任务会落 `:unknown`——plan→cancel→replan(gen2)→cancel 时第二次取消被错误 dedupe。改为绑**当前 activation event**：

```
activationEventId = 最新 TaskPlanned eventId（planned 中的任务）
                  | 最新 TaskDispatched eventId（其余，与现状一致——从未 planned 的任务键值不变）
idempotencyKey = `cancelled:<taskId>:<activationEventId>`
```

## 5. 释放协议（三段式）

### 5.1 claimReadyPlan：锁内精确绑定（终审缺口 3）

账本被 CLI 与多个 daemon 共享访问，释放的唯一权威是 ledger 现有 `withLock`（exclusive-create spinlock，跨进程）。冻结面在锁外构造，**claim 入参携带构造时依据的快照坐标，锁内重算逐字比对**：

```
ledger.claimReadyPlan({
  taskId,
  expectedPlanEventId,                 // 冻结面构造所依据的当前代 plan eventId
  expectedAcceptedEventIds: string[],  // 按 dependsOn 声明序
  intentDraft,                         // §3.1 全字段（锁外备好）
}): 在 withLock 临界区内 materialize 后：
  - status!=='planned' 且已派 → { result: 'already-dispatched' }
  - status!=='planned' 其它 / 依赖未全 accepted → { result: 'not-ready' }
  - 当前代已有 open Intent → { result: 'open-intent', intent }
  - planEventId 或按声明序 acceptedEventIds 与 expected 逐字不等 → { result: 'stale' }
      // 不能只判断“现在也 accepted”——期间上游 cancel+重开/重验收会换 eventId，
      // 冻结字节已过时；调用方用新快照重建冻结面后重试 claim
  - 全部通过 → 同临界区 append TaskDispatchIntent → { result: 'created', intent }
```

**四态分工（实现钉 1）**：只有 `created` 由当前调用方立即执行发送；`open-intent` 一律只由恢复器（boot reconcile / 周期兜底）按 §5.6 接手，触发路径不得抢——保证任意时刻单一执行体持有一次释放。`already-dispatched` / `not-ready` no-op。

### 5.2 触发点

- **accept 写入点触发（主路径）**：`TaskAccepted` 共两个写入点——CLI `delivery accept`（cli.ts）与机械 reconciler（reconcile.ts）。CLI 写完后 best-effort POST 监管者 daemon IPC `/api/goal/release-check {goalChatId, taskId}`（照 `triggerGoalWatchdogFromCli` 模式）；reconciler 在 daemon 内直连。IPC 丢失只影响延迟。
- daemon 启动 reconcile（扫 open Intent + ready planned）。
- 周期扫描**只做兜底**。

### 5.3 acceptedEventId 投影

`TaskView` 新增 `acceptedEventId?: string`：由**真正把该任务变成 accepted 的那条** `TaskAccepted` 写入（现有 `reportId === latestReportId && status!=='cancelled'` 转移分支）；迟到 verdict、对非最新 report 的 accept 不写。satisfiedBy 只取此投影。

### 5.4 releaseId 规范

```
canonical = 'arel1:' + <当前代 planEventId> + ':' +
            dependsOn 声明序逐个 acceptedEventId join(':') +
            (attempt > 0 ? ':retry' + attempt : '')
releaseId = 'rel1-' + sha256(canonical).hex.slice(0, 40)    // 45 字符 ≤ 飞书 uuid 上限 50
```

跨 daemon 重启重试推导出同一 releaseId ⇒ 同一飞书 uuid ⇒ 幂等；attempt=0 不进 hash；飞书 uuid 硬约束 ≤50 字符、1h TTL。

### 5.5 释放时序（claim → readiness → send，终审缺口 1 调序）

```
1. 锁外构造冻结面（基于快照 planEventId + acceptedEventIds + dispatchSpec）
2. claimReadyPlan（§5.1）→ created 才继续；stale 则重建冻结面重试
3. 锁外动态 readiness 复检（群成员/对端能力在等待期间可能变化）
   —— error 级 → append TaskDispatchFailed(definite, code='readiness:...')
      → §8 提升；本 releaseId 永不自动重试。claim 先于 readiness：失败有归属
      （认领的 daemon 记账），多 daemon 不会重复探测、重复报警
4. sendMessage(senderLarkAppId, goalChatId, frozenKickoffText, 'text', uuid=releaseId)
   —— 飞书 4xx/参数拒绝 → TaskDispatchFailed(definite)
   —— 超时/5xx/网络中断 → TaskDispatchFailed(ambiguous)
5. 成功 → append TaskDispatched（frozenDispatchedPayload + releaseId + dispatchMessageId）
```

冻结语义：重试重放同一字节；上游后续补报不回写已冻结的 release。

### 5.6 恢复：行为完全由账本投影决定（终审缺口 1）

pendingRelease 投影 = 当前代最新 open Intent + 该 releaseId 最新 TaskDispatchFailed。恢复器（boot reconcile / 周期兜底）按投影分流：

| 投影状态 | 行为 |
| --- | --- |
| open Intent、无 failure（崩溃在发送前后） | 视为 ambiguous：<55min 同 uuid 重发（幂等安全），成功补写 TaskDispatched |
| 最新 failure = ambiguous、Intent 创建 <55min | 同 uuid 重发；再超时不重复记账（幂等键按类别） |
| 最新 failure = ambiguous、≥55min | 不盲重发；§8 提升，两动作：「确认已派」（补写 TaskDispatched，confirmedBy=openId）/「重试释放」（attempt+1 ⇒ 新 releaseId=新 uuid，重复消息风险由人工确认承担） |
| 最新 failure = definite | **永不自动重试**；§8 提升附 code/detail 与修复指引；人工修复后「重试释放」（attempt+1 新 Intent） |

open Intent 判定：当前代最新一条 Intent；attempt+1 写入后旧 Intent 视为 superseded。

## 6. 产物注入：开工依赖 ≠ 产物传递

释放时注入 frozenKickoffText 的上游信息，默认**只传元数据**：

| 证据类型 | 注入内容 |
| --- | --- |
| url | 原样透传（本身跨设备可达） |
| inline | 只传摘要 + reportId（防 brief 膨胀与敏感内容扩散；worker 需要时向 L2 要） |
| path | 只传存在性描述（`<机器>上的 <path>`），明确标注「路径不可跨设备访问」 |

模板（追加在 briefBase 之后）：

```
— 上游产出 —
本任务依赖以下已验收任务：
- <taskId> <title>（report <reportId>）：<summary>
  证据：<按上表分级渲染>
需要完整产物时向监管者索取；不要假设上述路径在本机可达。
```

真正的文件传递必须是 URL / inline / 共享存储，属后续显式 opt-in 功能，不进默认路径。

## 7. 上游异常语义

上游进入 rejected / blocked / escalated / cancelled 时，**不自动取消下游**：下游保持 planned（惰性零成本，无 worker 被占用）。理由：cancelled 可同 taskId 重开（§4.2）、rejected 可补交，机械级联会把可恢复态放大成不可恢复。

监管者被唤醒后可选：重派/修复上游（下游依赖门自然重新评估）、以新 taskId 改依赖重建下游、或显式 cancel 下游。

## 8. 呈现与注意力（风险行从账本派生，实现钉 2）

planned 是一等状态：进 `delivery list`、board counts、goal「未完成」判定；行内显示「等待 <上游短名>」。

**正常依赖等待不产生任何 attention**。依赖异常提醒由**释放引擎**产出（watchdog 不看 planned）：

| 触发 | 动作 |
| --- | --- |
| 上游 blocked | **无新提醒**——上游求助本身已在注意力带 |
| 上游 escalated | 不为下游单独报警；上游注意力行展示「影响 N 个下游」计数 |
| 上游 cancelled | 下游 planned 提升为需监管者处理（重开上游 / 改依赖 / 取消下游） |
| 上游 rejected 滞留 | rejected 后无重派亦无新 report 超阈值（默认 30min，`BOTMUX_A2A_DEP_REJECTED_STALL_MS` 可配）才提升——正常「驳回→补交」有静默窗口；reject 是监管者自己的动作、现有注意力带不覆盖滞留，不算重复报警 |
| TaskDispatchFailed(definite) | 即时提升（附 code/detail/修复动作） |
| TaskDispatchFailed(ambiguous) 窗外 | 提升（两动作卡片，§5.6） |

**持久化来源**：风险行**从账本事件派生**（TaskDispatchFailed / 上游异常事件 + planned 投影），天然幂等可重建——同一（下游, 上游/releaseId, 异常 eventId）为一行稳定风险行，不依赖 daemon 内存去重；通知投递复用现有 goal-notification-retry-store 的持久重试/死信机制（attention 已消费该 store 的 dead-letter 行）。

## 9. 兼容性

- **对端零升级**：planned/Intent/Failed 只发生在监管者侧账本与 daemon；接收端收到的是普通 dispatch 消息，无新 capability、readiness 不变。
- **旧版本读者**：materialize 对未知事件类型直接跳过、不建 task（已核实现有行为）。补一条回归测试锁住该行为。旧版本 CLI 读到新事件 ⇒ 该任务在旧视图不存在，不产生误判。
- `--after` 要求监管者本机 botmux ≥ 本特性版本（CLI 自身校验，天然满足）。

## 10. 边界用例清单（测试必须覆盖）

1. 多依赖部分满足：只 accept 其一 → 不释放、无消息、无 attention。
2. 依赖早已 accepted 后才建 plan：建 plan 后首次评估即释放；releaseId 取已存在的 acceptedEventId，答案唯一。
3. claim 竞态：两个进程同时判定 ready → 只有一条 Intent 落账、只发一条消息。
4. Intent 已写、消息未发即崩溃：恢复器按「open Intent 无 failure=ambiguous」以同 uuid 重发，群里只有一条消息。
5. 消息已发、TaskDispatched 未写即崩溃：同 uuid 重发（服务端去重返回原 message_id）→ 补写，无重复消息。
6. 幂等窗外 ambiguous：不重发，一次 attention；「确认已派」补 confirmedBy；「重试释放」attempt+1 新 uuid。
7. 确定性失败（worker 已退群）：TaskDispatchFailed(definite) 落账；**daemon 重启后不自动重试、不重复报警**；修复后人工重试释放成功。
8. **claim stale**：冻结面构造与 claim 之间上游 cancel+重开（或重验收换 acceptedEventId）→ claim 返回 stale → 重建冻结面后成功释放，发送字节与新快照一致。
9. 重开代际：上游 cancel → 下游 planned 保持 → 上游 gen2 重开（同边）→ 再 accepted → 下游用新 acceptedEventId 释放；改边重开被拒；同一 cancel 重复重开幂等。
10. **plan→cancel→replan(gen2)→cancel**：第二次取消用 gen2 activation eventId，不被 dedupe（§4.3）。
11. 迟到 verdict：对旧 report 的 TaskAccepted 不改状态、不写 acceptedEventId、不触发释放。
12. 信封防提前推进：worker 对 planned taskId 提交 report/help → append 层拒绝，envelope-ingest 返回 task_not_dispatched，账本零变化。
13. 依赖门防旁路：对曾 planned 任务直接 append 无 releaseId 的 TaskDispatched → **append 层拒绝（新写入）**；同样组合出现在历史事件中 → **replay 层 ignore+warning（不 throw）**。双层分开断言。
14. **open-intent 所有权**：触发路径 claim 返回 open-intent → 不发送；仅恢复器处理该 Intent。
15. 下游 planned 被显式 cancel：不再参与释放评估；上游后续 accepted 无副作用。
16. watchdog 全程静默：存在 planned 任务时失联判定/stale 探测/重派预算均无动作。
17. 上游 rejected 阈值内补交 → accepted：无 attention 打扰，正常释放。
18. materialize 未知事件类型跳过、不建 task（锁现状回归）。
19. 风险行可重建：daemon 重启后 §8 风险行从账本完整重放，无重复通知（retry store 幂等）。
20. 双部署回归（test/a2a-dual-deploy.test.ts 扩展）：A 机监管者 planned → B 机 worker 完成上游 → A 机 claim 释放 → B 机收到普通 dispatch 并正常回报。

## 11. 实施拆分建议

1. **PR-1 账本层**：TaskStatus+'planned'、四个事件 schema（含 TaskDispatchFailed）、append/replay 双层守卫、acceptedEventId 投影、plan generation、取消幂等键换 activation event、`claimReadyPlan` 四态（锁内 expected 逐字比对）、pendingRelease 投影、未知类型跳过回归。纯类型+纯函数+锁临界区，单测密集。
2. **PR-2 CLI 面**：`dispatch --after` 校验（含 --skip-readiness-check 互斥）与 TaskPlanned 写入、重开守卫与报错引导、delivery list/board「等待 X」渲染、envelope-ingest `task_not_dispatched`、accept 写入点 IPC 触发。
3. **PR-3 释放执行体**：冻结面构造 + claim→readiness→send 时序 + 失败分类落账 + 恢复器（账本投影驱动）+ 窗外两动作卡片 + §8 风险行派生与 retry-store 投递。
4. **PR-4 回归**：边界清单 20 条 + 双部署扩展。

依赖顺序 1→2→3→4；1/2 可并行评审。
