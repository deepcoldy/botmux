# a2a 任务依赖边：planned 状态 + 多依赖 + 安全自动释放

- 状态：设计稿 **v2**（v1 经 codex 契约审查，4 blocker + 5 修正全部收进；待 codex 终审；实施等老滕拍板）
- 讨论线：2026-07-17 老滕提出「a2a 不支持流程固化、丢 DAG 后依赖无保证」→ claude 提案 → codex 四点收紧 + 三个契约钉子 → v1 → codex 契约审查（H1 多进程互斥 / H2 重开语义 / H3 冻结不足 / H4 状态机硬约束）→ 本稿
- 范围：短期方案。**不**并入 workflow v3；长期 v3 跨 bot 节点直接调用本稿定义的交付原语。

## 1. 背景与问题

A2A 编排（goal 群 + dispatch + delivery ledger）固化的是交付协议（任务生命周期事件 + 验收 + 账本），不固化流程。「workerA 依赖 workerB 的结果」目前只有一个保证机制：L2 监管者串行派活的行为约定（skill 教的，靠 LLM 自觉）。`TaskView` 无依赖字段；L2 上下文丢失后，依赖边若没写进 charter 就永久丢失；worker 侧无 gate，dispatch 出去就开跑。

风险：提前派发下游、下游拿不到上游产物、L2 复活后凭记忆重建依赖出错。

## 2. 目标 / 非目标

**目标**
- 依赖边进账本，由机制而非 LLM 记忆承担「A 依赖 B」。
- 下游任务在依赖全部 accepted 前不打扰 worker（不发消息）。
- 依赖满足后自动派发，且派发具备崩溃一致性与**多进程一致性**（账本被 CLI 与多个 daemon 共享访问，见 §5.1）。
- 上游异常不机械级联，决策留给监管者。
- 对端零升级：接收端看到的就是普通 dispatch，不加新 a2a capability。

**非目标**
- 不做跨 goal 依赖（依赖只能指向同 goal 任务）。
- 不做流程模板/固化复跑（那是 v3 跨 bot 节点的事）。
- 不做产物文件自动搬运（默认只传元数据，见 §6）。
- 不做 worker 侧 gate（v1 由监管者侧 daemon 延迟物化，不改接收协议）。

## 3. 账本事件与状态机

actor 沿用现有 `LedgerActor = 'orchestrator' | 'worker'`，不扩类型；人/daemon 的身份记在 payload（`plannedBy` / `releasedBy` / `confirmedBy`）。

### 3.1 新事件

```
TaskPlanned            actor: 'orchestrator'
  payload: {
    taskId, chatId, title,
    dependsOnTaskIds: string[],      // 声明序保留，≥1，去重
    planGeneration: number,          // 1 起；重开 +1（§4.2）
    reopenOfCancelEventId?: string,  // gen≥2 必填：被重开的那次 cancel 的 eventId
    dispatchSpec: {                  // 冻结的派发参数（除 brief 注入部分）
      briefBase: string,
      workers: DispatchWorkerMeta[], // --bot 解析结果（openId/name/larkAppId/cliId/unionId/role）
      senderLarkAppId: string,
      needsRepo?, acceptance?, timeoutMinutes?, ...
    },
    plannedBy: string,               // openId / session
  }
  idempotencyKey:
    gen 1: `planned:<taskId>`
    gen≥2: `planned:<taskId>:<reopenOfCancelEventId>`   // 每次 cancel 只允许重开一次的重试幂等

TaskDispatchIntent     actor: 'orchestrator'
  payload: {
    taskId,
    releaseId: string,               // §5.4，同时用作飞书 uuid
    attempt: number,                 // 0=自动；≥1=人工重试释放（§5.6）
    planEventId: string,             // 当前代 TaskPlanned 的 eventId
    planGeneration: number,
    satisfiedBy: Array<{ taskId, acceptedEventId }>,    // 按 dependsOn 声明序；取 TaskView.acceptedEventId（§5.3）
    // —— 完整恢复发送所需的冻结面（H3）——
    senderLarkAppId: string,
    goalChatId: string,
    frozenKickoffText: string,       // 注入上游元数据后的最终发送字节（§6）
    frozenWorkerSpecs: DispatchWorkerMeta[],            // 含 role/身份元数据
    frozenDispatchedPayload: TaskDispatchedPayload,     // 成功后要 append 的最终 payload（除 dispatchMessageId）
    releasedBy: string,              // 'daemon:<larkAppId>' 或人工重试时的 openId
  }
  idempotencyKey: `intent:<releaseId>`

TaskDispatched（现有）payload 追加：
  releaseId?: string                 // 自动释放路径必填，关联 Intent
  dispatchMessageId?: string         // 飞书回执 message_id（人工「确认已派」时可缺省）
  confirmedBy?: string               // 人工确认路径记录 openId
  自动释放路径 idempotencyKey: `dispatched:release:<releaseId>`
```

### 3.2 状态机

`TaskStatus` 增加 `'planned'`：

```
planned ──(当前代所有依赖 accepted，三段式完成)──▶ dispatched ──▶ 现有生命周期不变
planned ──(TaskCancelled)──▶ cancelled ──(TaskPlanned gen+1，§4.2)──▶ planned
```

Reducer 硬规则（H4，replay 时同样生效，防旁路/防坏账本）：
- `TaskPlanned` gen1 创建 task，status='planned'。gen≥2 仅当当前 status==='cancelled' 且 dependsOnTaskIds 与 gen1 **完全一致**才生效（status 回 'planned'，dispatchSpec 以新代为准）；否则忽略 + warning。依赖边只认 gen1，生命周期不可变。
- `TaskDispatchIntent` 仅当 task 当前 status==='planned'、planGeneration 匹配当前代、且 satisfiedBy 与「当前各依赖的 acceptedEventId」一致时生效（挂 pendingRelease 到 view，不改 status）；否则忽略 + warning。
- **曾 planned 的 taskId**：`TaskDispatched` 仅当 payload.releaseId 匹配当前代最新 open Intent 才把 planned→dispatched；无匹配 releaseId 的直接 TaskDispatched 一律忽略 + warning（普通 CLI 不能旁路依赖门）。从未 planned 的 taskId 走现有语义不变（含 reject 后 re-dispatch、cancel 后直接重开）。
- planned 任务收到 `TaskReported` / `TaskAccepted` / `TaskRejected` / `TaskHelpRequested` / `TaskEscalated`：**hard reject**（忽略 + warning）。外部信封不得提前推进未派发任务的状态；envelope-ingest 同步加前置拒绝（新 outcome `task_not_dispatched`，回给 sender 结构化说明），reducer 守卫做纵深。
- `TaskCancelled` 对 planned 任务生效（status='cancelled'）。

### 3.3 watchdog 隔离

planned 状态对 goal watchdog 的**所有**探测不可见：不进失联判定、不进 stale 探测、不进重派预算。依赖相关的注意力提醒**全部由释放引擎产出**（§8），不依赖 watchdog——两者职责分离，回归测试覆盖「planned 存在时 watchdog 零动作」。

## 4. 依赖声明与校验

### 4.1 声明

CLI 面：`botmux dispatch --after <taskId>`（可重复=多依赖）。带 `--after` 时走 planned 路径（写 TaskPlanned，不发消息）；不带则完全走现有路径，零行为变化。

创建时校验（任一失败即拒绝，不写账本）：
1. 所有 `--after` 的 taskId 在**同一 goal**（chatId 相同）的账本中已存在；
2. 不得自依赖；
3. `--after` 不与 `--standby` / `--into` / `--new-topic` 同用（v1 只走 chat-scope 单消息派发）。

**按构造无环**：依赖只能在创建时声明、只能指向已存在任务、无追加依赖操作、重开不得改边 ⇒ 账本 append 序即拓扑序，环在结构上不可能。环检测保留为防御性断言（发现即 escalate，说明账本被外部篡改）。

### 4.2 cancel 后同 taskId 重开（H2，方案 B：plan generation）

保持现有「同 taskId 重开」产品语义：
- planned/已释放任务被 cancel 后，重开 = 写 `TaskPlanned` gen+1：**依赖边必须与 gen1 完全一致**（CLI 要求显式重述同一 `--after` 集合，不一致时报错并列出原始边供复制）；dispatchSpec 可更新（改 brief/换 worker）；status 回 'planned'，依赖门重新评估。
- idempotencyKey 绑定被重开的 cancel eventId：同一次 cancel 的重开重试幂等，每次新 cancel 允许一次新重开。
- releaseId 取**最新代** plan eventId（§5.4），天然与旧代 Intent 区隔。
- CLI 守卫：对「曾 planned 且当前 cancelled」的 taskId 执行不带 `--after` 的 dispatch → 报错引导（重开须走 plan gen+1 或换新 taskId）。

## 5. 释放协议（三段式）

### 5.1 多进程互斥：claimReadyPlan（H1）

账本被 CLI 进程与多个 daemon 共享访问，**进程内串行不构成互斥**。释放的唯一权威是 ledger 现有的文件级排他锁（`withLock`，exclusive-create spinlock）：

```
ledger.claimReadyPlan(taskId): 在 withLock 临界区内
  1. 重读全量事件 → materialize
  2. 再次校验：status==='planned'（当前代）
             && 每个 dependsOn 的任务 status==='accepted'（取 acceptedEventId）
             && 当前代无 open Intent
  3. 通过 → 同一临界区内 append TaskDispatchIntent（冻结面在进锁前备好，锁内只做校验+append）
  4. 返回 claimed Intent；任何一步不过 → 返回 not-ready/already-claimed，调用方放弃
```

任何释放执行体（accept 触发、boot reconcile、周期扫描）都必须经 claimReadyPlan 拿到 Intent 才能发送；两个进程同时算出 ready 时只有一个能 claim 成功。

### 5.2 触发点

- **accept 写入点触发（主路径）**：`TaskAccepted` 共两个写入点——CLI `delivery accept`（cli.ts）与机械 reconciler（reconcile.ts）。CLI 写完后 best-effort POST 监管者 daemon IPC `/api/goal/release-check {goalChatId, taskId}`（参考现 `triggerGoalWatchdogFromCli` 模式）；reconciler 在 daemon 内直接调用释放检查。IPC 丢失不影响正确性，只影响延迟。
- daemon 启动 reconcile（崩溃恢复，扫 open Intent + ready planned）。
- 周期扫描**只做兜底**（复用 tick 基础设施，独立判定函数）。

释放执行体 = 监管者所属 daemon。发送动作（网络）一律在锁外。

### 5.3 acceptedEventId 投影（H4）

`TaskView` 新增 `acceptedEventId?: string`：由**真正把该任务变成 accepted 的那条** `TaskAccepted` 事件写入（即 reducer 现有 `reportId === latestReportId && status!=='cancelled'` 转移分支）；迟到 verdict、对非最新 report 的 accept 不改状态也不写此字段。satisfiedBy 只取此投影，禁止「随便找一条历史 TaskAccepted」。

### 5.4 releaseId 规范

```
canonical = 'arel1:' + <当前代 planEventId> + ':' +
            dependsOn 声明序逐个 acceptedEventId join(':') +
            (attempt > 0 ? ':retry' + attempt : '')
releaseId = 'rel1-' + sha256(canonical).hex.slice(0, 40)    // 45 字符 ≤ 飞书 uuid 上限 50
```

- plan eventId + 逐依赖 acceptedEventId 做 canonical hash：多依赖、「依赖早已 accepted 后才建 plan」、重开新代，都只有一个答案；
- 跨 daemon 重启的重试推导出同一 releaseId ⇒ 同一飞书 uuid ⇒ 幂等；
- attempt=0 不进 hash；人工重试释放 attempt≥1 追加后缀（§5.6）。
- 飞书 uuid 硬约束：≤50 字符、1 小时 TTL（client.ts 的 sendMessage/replyMessage 已支持）。

### 5.5 释放时序

```
0. 锁外：动态 readiness 复检（群成员/对端能力在等待期间可能变化，H3）
   —— error 级问题（worker 不在群、能力显式缺失等确定性失败）→ 不写 Intent，
      直接进人工处理（§8 提升，附修复指引）；readiness 与锁之间的 TOCTOU 可接受
      （readiness 是咨询性预检，账本状态才是硬门）
1. claimReadyPlan：锁内校验 + append TaskDispatchIntent（冻结 §3.1 全部字段）
2. sendMessage(senderLarkAppId, goalChatId, frozenKickoffText, 'text', uuid=releaseId)
   —— chat-scope 单消息；--after 已在 §4.1 禁与 new-topic 同用
3. append TaskDispatched（frozenDispatchedPayload + releaseId + dispatchMessageId；
   idempotencyKey dispatched:release:<releaseId>）
```

冻结语义：frozenKickoffText / frozenDispatchedPayload 以 Intent 时刻账本快照生成；重试重放同一字节；上游后续补报不回写已冻结的 release。

### 5.6 失败分类与恢复（H3 收紧）

对「有 open Intent、无对应 TaskDispatched」的任务，按失败性质分流：

- **确定性失败**（飞书 4xx、成员缺失、参数拒绝）：**不重试发送**，立即走 §8 提升进人工处理；修复后由人工「重试释放」。
- **不确定结果**（超时、5xx、网络中断——消息可能已发）：
  - Intent 创建至今 **< 55 分钟**（对 1h TTL 留安全边际）：同一 uuid 原样重发（服务端幂等去重，重复请求返回原 message_id），成功后补写 TaskDispatched。
  - **≥ 55 分钟**：不盲重发。§8 提升，卡片两动作：
    - 「确认已派」：人工核实消息已在群里 → 补写 TaskDispatched（payload.confirmedBy=openId，dispatchMessageId 可缺省）；
    - 「重试释放」：写新 Intent（attempt+1 ⇒ 新 releaseId=新 uuid，旧 uuid TTL 已过失去幂等）→ 重发。重复消息风险由人工确认承担。
- open Intent 判定：当前代最新一条 Intent；attempt+1 写入后旧 Intent 视为 superseded。

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

## 8. 呈现与注意力

planned 是一等状态：进 `delivery list`、board counts、goal「未完成」判定；行内显示「等待 <上游短名>」。

**正常依赖等待不产生任何 attention**。依赖异常提醒由**释放引擎**单独产出（watchdog 不看 planned，§3.3），按上游异常态分级、避免注意力带重复报警：

| 上游状态 | 动作 |
| --- | --- |
| blocked | **无新提醒**——上游求助本身已在注意力带，不为每个下游重复报警 |
| escalated | 不为下游单独报警；上游注意力行展示「影响 N 个下游」计数 |
| cancelled | 下游 planned 提升为需监管者处理（重开上游 / 改依赖 / 取消下游） |
| rejected 滞留 | 上游 rejected 后无重派亦无新 report 持续超阈值（默认 30 分钟，`BOTMUX_A2A_DEP_REJECTED_STALL_MS` 可配）才提升——正常「驳回→补交」有静默窗口；此场景现有注意力带没有覆盖（reject 是监管者自己做的动作，不产生 attention），不算重复报警 |
| 释放失败（§5.6） | 确定性失败即时提升（附失败原因与修复动作）；幂等窗外不确定结果提升（附两动作卡片） |

同一（下游, 上游, 异常事件）只提升一次，去重键 `dep-stall:<下游taskId>:<上游taskId>:<异常eventId>`。

## 9. 兼容性

- **对端零升级**：planned/Intent 只发生在监管者侧账本与 daemon；接收端收到的是普通 dispatch 消息，无新 capability、readiness 不变。
- **旧版本读者**：materialize 对未知事件类型直接跳过、不建 task（已核实现有行为）。补一条回归测试把「未知类型跳过」锁住即可，无需额外加固。旧版本 CLI 读到新事件 ⇒ 该任务在旧视图中不存在，不产生误判。
- `--after` 要求监管者本机 botmux ≥ 本特性版本（CLI 自身校验，天然满足）。

## 10. 边界用例清单（测试必须覆盖）

1. 多依赖部分满足：只 accept 其一 → 不释放、无消息、无 attention。
2. 依赖早已 accepted 后才建 plan：建 plan 后首次评估即释放；releaseId 取已存在的 acceptedEventId，答案唯一。
3. **claim 竞态**：两个进程同时判定 ready（如 CLI IPC 触发与周期扫描并发）→ 只有一条 Intent 落账、只发一条消息。
4. 上游 accepted → Intent 已写、消息未发即崩溃：boot 以同 uuid 重发，账本最终一致，群里只有一条派发消息。
5. Intent 写后消息已发但 TaskDispatched 未写即崩溃：boot 同 uuid 重发（服务端去重返回原 message_id）→ 补写 TaskDispatched，无重复消息。
6. 幂等窗外（≥55min）不确定结果：不重发，产生一次 attention；「确认已派」补写 confirmedBy；「重试释放」生成 attempt+1 新 uuid。
7. **确定性失败**（worker 已退群）：不重试发送，即时 attention；修复入群后人工重试释放成功。
8. **重开代际**：上游 cancel → 下游 planned 保持 → 上游同 taskId 重开（gen2，同边）→ 再 accepted → 下游用新 acceptedEventId 释放；改边重开被拒；同一 cancel 的重复重开幂等。
9. **迟到 verdict**：对旧 report 的 TaskAccepted 不改状态、不写 acceptedEventId、不触发释放。
10. **信封防提前推进**：worker 对 planned taskId 提交 report/help → envelope-ingest 返回 task_not_dispatched，账本无状态变化。
11. **依赖门防旁路**：对曾 planned 任务直接 append 无 releaseId 的 TaskDispatched → reducer 忽略 + warning，状态仍 planned。
12. 下游 planned 被显式 cancel：不再参与释放评估；上游后续 accepted 无副作用。
13. watchdog 全程静默：存在 planned 任务时失联判定/stale 探测/重派预算均无动作。
14. 上游 rejected 阈值内补交 → accepted：无 attention 打扰，正常释放。
15. materialize 未知事件类型跳过、不建 task（锁现状回归）。
16. 双部署回归（test/a2a-dual-deploy.test.ts 扩展）：A 机监管者 planned → B 机 worker 完成上游 → A 机 claimReadyPlan 自动释放 → B 机收到普通 dispatch 并正常回报。

## 11. 实施拆分建议

1. **PR-1 账本层**：TaskStatus+'planned'、三个事件 schema、reducer 硬规则（§3.2 全部守卫）、acceptedEventId 投影、plan generation、`claimReadyPlan`（锁内 read-validate-append）、未知类型跳过回归。纯类型+纯函数+锁临界区，单测密集。
2. **PR-2 CLI 面**：`dispatch --after` 校验与 TaskPlanned 写入、重开守卫与报错引导、delivery list/board「等待 X」渲染、envelope-ingest `task_not_dispatched`、accept 写入点 IPC 触发。
3. **PR-3 释放执行体**：readiness 复检 + 三段式 + 失败分类（确定性/不确定）+ 幂等重发 + 窗外两动作卡片 + §8 注意力分级；boot reconcile + 周期兜底。
4. **PR-4 回归**：边界清单 16 条 + 双部署扩展。

依赖顺序 1→2→3→4；1/2 可并行评审。
