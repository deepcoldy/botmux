# a2a 任务依赖边：planned 状态 + 多依赖 + 安全自动释放

- 状态：设计稿（claude 起草，codex 契约审查后实现，claude review；实施等老滕拍板）
- 讨论线：2026-07-17 老滕提出「a2a 不支持流程固化、丢 DAG 后依赖无保证」→ claude 提案 → codex 四点收紧 + 三个契约钉子 → 本稿
- 范围：短期方案。**不**并入 workflow v3；长期 v3 跨 bot 节点直接调用本稿定义的交付原语。

## 1. 背景与问题

A2A 编排（goal 群 + dispatch + delivery ledger）固化的是交付协议（任务生命周期事件 + 验收 + 账本），不固化流程。「workerA 依赖 workerB 的结果」目前只有一个保证机制：L2 监管者串行派活的行为约定（skill 教的，靠 LLM 自觉）。`TaskView` 无依赖字段；L2 上下文丢失后，依赖边若没写进 charter 就永久丢失；worker 侧无 gate，dispatch 出去就开跑。

风险：提前派发下游、下游拿不到上游产物、L2 复活后凭记忆重建依赖出错。

## 2. 目标 / 非目标

**目标**
- 依赖边进账本，由机制而非 LLM 记忆承担「A 依赖 B」。
- 下游任务在依赖全部 accepted 前不打扰 worker（不发消息）。
- 依赖满足后自动派发，且派发具备崩溃一致性（不出现「账本说已派、实际没发」或反之）。
- 上游异常不机械级联，决策留给监管者。
- 对端零升级：接收端看到的就是普通 dispatch，不加新 a2a capability。

**非目标**
- 不做跨 goal 依赖（依赖只能指向同 goal 任务）。
- 不做流程模板/固化复跑（那是 v3 跨 bot 节点的事）。
- 不做产物文件自动搬运（默认只传元数据，见 §6）。
- 不做 worker 侧 gate（v1 由监管者侧 daemon 延迟物化，不改接收协议）。

## 3. 账本事件与状态机

### 3.1 新事件

```
TaskPlanned            actor: supervisor
  payload: {
    taskId, chatId, title,
    dependsOnTaskIds: string[],      // 声明序保留，≥1，去重
    dispatchSpec: {                  // 冻结的派发参数（除 brief 注入部分）
      briefBase: string,             // 用户写的 brief 原文
      workers: DispatchWorkerMeta[], // --bot 解析结果（openId/name/larkAppId/cliId/unionId）
      needsRepo?, acceptance?, timeoutMinutes?, ...
    },
    plannedBy: string,               // openId / session
  }
  idempotencyKey: `planned:<taskId>`

TaskDispatchIntent     actor: daemon（自动释放执行体）
  payload: {
    taskId,
    releaseId: string,               // §5.3，同时用作飞书 uuid
    attempt: number,                 // 0=自动；≥1=人工重试释放（§5.5）
    satisfiedBy: Array<{ taskId, acceptEventId }>,  // 按 dependsOn 声明序
    frozenKickoffText: string,       // 注入上游元数据后的最终发送字节（§6）
    frozenWorkerOpenIds: string[],
  }
  idempotencyKey: `intent:<releaseId>`

TaskDispatched（现有）追加可选字段 payload.releaseId?: string 关联释放链。
  自动释放路径的 idempotencyKey: `dispatched:release:<releaseId>`
```

### 3.2 状态机

`TaskStatus` 增加 `'planned'`：

```
planned ──(所有依赖 accepted，三段式完成)──▶ dispatched ──▶ 现有生命周期不变
planned ──(TaskCancelled)──▶ cancelled ──(同 taskId 重开=新 TaskPlanned? 否，见 §4)──
```

Reducer 规则：
- `TaskPlanned` 创建 task，status='planned'，记录 dependsOnTaskIds（**只**从该事件读取，后续任何事件不得修改依赖边）。
- `TaskDispatchIntent` 不改变 status（planned 保持），只挂 pendingRelease 元数据到 view。
- planned 任务收到 `TaskDispatched`（带匹配 releaseId）→ status='dispatched'，之后走现有 reducer 分支。
- `TaskCancelled` 对 planned 任务同样生效（status='cancelled'）。cancel 后同 taskId 重开（现有语义 TaskDispatched 重入）见 §4 的不可变约束。

### 3.3 watchdog 隔离（codex 收紧 #1）

planned 状态对 goal watchdog 的**所有**探测不可见：不进失联判定、不进 stale 探测、不进重派预算。watchdog 现有逻辑按 status 过滤时显式排除 `'planned'`。回归测试必须覆盖「planned 任务存在时 watchdog 不产生任何动作」。

## 4. 依赖声明与校验

CLI 面：`botmux dispatch --after <taskId>`（可重复=多依赖）。带 `--after` 时走 planned 路径（写 TaskPlanned，不发消息）；不带则完全走现有路径，零行为变化。

创建时校验（任一失败即拒绝，不写账本）：
1. 所有 `--after` 的 taskId 在**同一 goal**（chatId 相同）的账本中已存在；
2. 不得自依赖（含 `--after` 自身 taskId）；
3. `--after` 不与 `--standby` / `--into` 同用（planned 是新任务派发语义）。

**按构造无环**：依赖只能在创建时声明、只能指向已存在任务、无追加依赖操作 ⇒ 账本 append 序即拓扑序，环在结构上不可能。环检测保留为防御性断言（发现即 escalate，说明账本被外部篡改）。

**依赖边对 taskId 生命周期不可变**（codex 钉子 #2）：cancel 后同 taskId 重开（重新 dispatch/planned）仍保留原依赖门；要改依赖必须换新 taskId。这是「按构造无环」成立的前提——若允许改边，晚创建的任务可以把边指回早任务形成环。实现上：reducer 遇到同 taskId 的第二条 TaskPlanned，忽略其 dependsOnTaskIds（沿用首条），并记 warning。

## 5. 释放协议（三段式）

### 5.1 触发点

- `TaskAccepted` 落账后的同 tick 评估（主路径，低延迟）；
- daemon 启动 reconcile（崩溃恢复）；
- 周期 tick 兜底（复用 maintenance/watchdog 的 tick 基础设施，独立判定函数）。

释放执行体 = 监管者所属 daemon（账本在其机器上，天然单点）。daemon 内同 goal 串行 tick：评估→写 Intent→发送在同一 tick 完成，无并发释放竞态。

### 5.2 释放条件

task.status === 'planned' 且 dependsOnTaskIds 每一个对应任务当前 status === 'accepted'。部分满足不释放、不通知（正常等待，见 §8）。

### 5.3 releaseId 规范（codex 钉子 #1）

```
canonical = 'arel1:' + planEventId + ':' +
            dependsOn 声明序逐个「满足该依赖的 TaskAccepted eventId」join(':') +
            (attempt > 0 ? ':retry' + attempt : '')
releaseId = 'rel1-' + sha256(canonical).hex.slice(0, 40)    // 45 字符 ≤ 飞书 uuid 上限 50
```

- 用 plan eventId + 逐依赖 accept eventId 做 canonical hash：多依赖、以及「依赖早已 accepted 后才建 plan」都只有一个答案；
- 跨 daemon 重启的重试推导出同一 releaseId ⇒ 同一飞书 uuid ⇒ 幂等；
- attempt=0 不进 hash（保持首次答案唯一）；人工重试释放 attempt≥1 追加后缀（§5.5）。
- **注意飞书 uuid 硬约束：≤50 字符、1 小时 TTL**（client.ts 已支持 sendMessage/replyMessage 传 uuid）。

### 5.4 三段式时序

```
1. 写 TaskDispatchIntent（冻结 frozenKickoffText + releaseId + satisfiedBy）
2. sendMessage(appId, goalChatId, frozenKickoffText, 'text', uuid=releaseId)
   —— v1 限定 chat-scope 单消息派发（协议默认路径）。new-topic 是 seed+prime+kickoff
      多消息，多 uuid 的部分成功状态空间不进 v1；--after 与 --new-topic 同用直接拒绝。
3. 写 TaskDispatched（payload.releaseId 关联；idempotencyKey dispatched:release:<releaseId>）
```

冻结语义：frozenKickoffText 以 Intent 时刻的账本快照生成（含注入的上游元数据 §6）；重试重放同一字节；上游后续补报**不**回写已冻结的 release。

### 5.5 崩溃恢复与幂等窗

boot/tick 扫描「有 Intent、无对应 TaskDispatched」的任务：

- Intent 创建至今 **< 55 分钟**（对 1h TTL 留安全边际）：用同一 uuid 原样重发（服务端幂等去重），成功后补写 TaskDispatched。
- **≥ 55 分钟**且无法确认消息是否已达：**不盲重发**。走现有 attention/escalate 链路唤醒监管者，卡片给两个动作：
  - 「确认已派」：人工核实消息已在群里 → 补写 TaskDispatched（actor: human）；
  - 「重试释放」：写新 Intent（attempt+1，releaseId 带 :retryN 后缀=新 uuid）→ 重发。重复消息风险由人工确认承担。

## 6. 产物注入：开工依赖 ≠ 产物传递（codex 收紧 #2）

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

## 7. 上游异常语义（codex 收紧 #4）

上游进入 rejected / blocked / escalated / cancelled 时，**不自动取消下游**：下游保持 planned（惰性零成本，无 worker 被占用）。理由：cancelled 可同 taskId 重开、rejected 可补交，机械级联会把可恢复态放大成不可恢复。

监管者被唤醒后可选：重派/修复上游（下游依赖门自然重新评估）、以新 taskId 改依赖重建下游、或显式 cancel 下游。

## 8. 呈现与注意力（codex 钉子 #3）

- **正常依赖等待不进 blocked/求助桶**：delivery list / board 的任务行内显示「等待 <上游短名>」，不产生 attention、不打扰人。
- 仅当依赖进入异常态才把 planned 任务提升为需监管者处理：
  - cancelled / escalated：即时提升；
  - rejected：滞留超阈值（上游 rejected 后无重派亦无新 report 持续 30 分钟，`BOTMUX_A2A_DEP_REJECTED_STALL_MS` 可配）才提升——给正常「驳回→补交」留静默窗口。
- 提升复用现有 attention/goal 看板「待处理」通道，同一依赖异常对同一下游只提升一次（去重键 `dep-stall:<下游taskId>:<上游taskId>:<异常事件id>`），避免注意力带重复报警。

## 9. 兼容性

- **对端零升级**：planned/Intent 只发生在监管者侧账本与 daemon；接收端收到的是普通 dispatch 消息，无新 capability、readiness 不变。
- **旧版本读者**：现有 reducer 对未知事件类型会走「默认创建 status='dispatched'」分支（ledger.ts 首见事件即建 task）。旧版本 CLI 读到 TaskPlanned 会把未派发任务显示为 dispatched。账本是监管者单机私有、同机多版本共读场景罕见，接受为已知权衡；实现时在 reducer 加「未知类型跳过不建 task」的前向兼容加固（本次一并做，泽及以后所有新事件）。
- `--after` 要求监管者本机 botmux ≥ 本特性版本（CLI 自身校验，天然满足）。

## 10. 边界用例清单（测试必须覆盖）

1. 多依赖部分满足：只 accept 其一 → 不释放、无消息、无 attention。
2. 依赖早已 accepted 后才建 plan：建 plan 的同 tick 释放；releaseId 取已存在的 accept eventId，答案唯一。
3. 上游 accepted → 下游释放中 daemon 崩溃（Intent 已写、消息未发）：boot 重发同 uuid，账本最终一致，群里只有一条派发消息。
4. Intent 写后消息已发但 TaskDispatched 未写即崩溃：boot 同 uuid 重发（服务端去重返回原 message_id）→ 补写 TaskDispatched，无重复消息。
5. 幂等窗外（≥55min）恢复：不重发，产生一次 attention，卡片两动作行为正确。
6. 上游 cancel → 同 taskId 重开 → 再 accepted：下游依赖门用新 accept eventId 重新评估并释放；依赖边未变。
7. 下游 planned 被显式 cancel：不再参与释放评估；上游后续 accepted 无副作用。
8. watchdog 全程静默：存在 planned 任务时失联判定/stale 探测/重派预算均无动作。
9. 上游 rejected 滞留阈值内补交→accepted：无 attention 打扰，正常释放。
10. reducer 对同 taskId 第二条 TaskPlanned：依赖边沿用首条，warning 落日志。
11. 双部署回归（test/a2a-dual-deploy.test.ts 扩展）：A 机监管者 planned→B 机 worker 完成上游→A 机自动释放下游→B 机收到普通 dispatch 并正常回报。

## 11. 实施拆分建议

1. **PR-1 账本层**：TaskStatus+'planned'、三个事件 schema、reducer（含未知类型前向兼容加固）、不可变依赖边、按构造无环断言。纯类型+纯函数，单测密集。
2. **PR-2 CLI 面**：`dispatch --after` 校验与 TaskPlanned 写入、delivery list「等待 X」渲染。
3. **PR-3 释放执行体**：三段式 + releaseId + 幂等重发 + 窗外转人工卡片；watchdog 排除 planned；attention 提升规则。
4. **PR-4 回归**：边界清单 + 双部署扩展。

依赖顺序 1→2→3→4；1/2 可并行评审。
