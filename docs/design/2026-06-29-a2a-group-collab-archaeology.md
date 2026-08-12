# a2a-group-collab 设计考古 — 只读设计参考

> **定位（重要）**：本文件是对已废弃分支 `feat/a2a-group-collab` 的**只读考古**。
> **不代表要合并 `feat/a2a-group-collab`**——该分支正式按 **superseded** 处理，不做任何代码层 merge。
> 本 doc 是这套旧设计**唯一的未来参考入口**。是否将其中某条转为 implementation，由 codex review 后逐条决定。
> 维护：claude-loopy（backup lane）｜成文：2026-06-29
>
> 两套模型一句话对照：
> - **verified-delivery（live）**：L2 监管化身 *自上而下派活* → 追加式 ledger（TaskDispatched/Reported/Accepted/Rejected/Help/Escalated）→ watchdog+reconciler 机械验收。真相 = append-only 事件流。
> - **a2a-group-collab（archive）**：worker *自下而上提案* → 可变 board（proposals[]）+ 确定性 referee 收口 → 独占区 CAS 并发控制。真相 = 可重放 board 快照。

---

## 优先级（codex 2026-06-29 拍版）

| 优先级 | 模式 | 口径 |
| --- | --- | --- |
| **P0 第一** | **P3 ledger append seam invariant** | 低成本高收益、与现有架构完全同向。下一步先做「append 前结构校验清单」，再决定哪些从 soft warn 升为 hard reject。 |
| **第二** | **P1 worker 自下而上 task proposal** | **先做设计、不搬旧 board/proposal 代码**。落成 verified-delivery 新 ledger 语义：worker 提议 → L2 审核/采纳 → TaskDispatched；不复活旧 referee/board。 |
| **第三** | **P2 progress vs completion + stall 提前升级** | 可与 watchdog/L2 统揽合并设计。 |
| 性能后置 | **P4 event-driven reconcile gate** | 仅作性能优化，等有实际开销再做。 |
| 不吸收 | **P5 exclusive CAS** | append-only ledger 下不是当前问题。 |

> 实现范围（尤其 P3 invariant 的 soft-warn vs hard-reject 拆分）由 codex review 本 doc 后再拆出。

---

## P1 — Worker 侧任务提案（bottom-up 涌现工作） ⭐最大能力缺口

- **①值得吸收**：a2a 侧 `botmux collab propose --title --spec --why` 让 **worker 自己识别涌现出来的必要工作并向上提案**，控制面再决定是否 ratify（两段式：`TaskProposed` → `TaskProposalResolved` → `TaskCreated`/`TaskAssigned`，把「发现工作」与「授权工作」解耦）。verified-delivery 目前 worker 只能 help/escalate，**没有「我发现还需要做 X，建议加个子任务」这条通道**——遇到漏项只能升级给人，L2 也只能全量重新规划。
  - 来源：`src/collab/cli.ts cmdCollab('propose')`、`src/collab/contract.ts TaskProposedEventSchema`、`src/collab/materialize.ts`、`src/core/worker-pool.ts acceptPendingTaskProposals()`
- **②不建议直接合并**：a2a 的 proposal 是挂在**可变 board 的 `proposals[]`** 上、状态原地改写；verified-delivery 是**追加式 ledger**，事件不可变。直接搬会把两套真相载体混在一起。
- **③落点**：新增 `TaskProposed` / `TaskProposalResolved` 两个事件类型进 `src/verified-delivery/types.ts`；ratify 决策进 `src/verified-delivery/reconcile.ts`（或 L2 prompt，`src/core/goal-supervisor.ts buildGoalSupervisorPrompt`）；提案展示进 `src/verified-delivery/goal-board.ts GoalBoardTask`。**完全可用 ledger 语义重新实现，无需 board。**（= codex 第二优先级：先做设计、新 ledger 语义、不复活旧 referee/board。）

## P2 — 进度 vs 完成「双信号」+ stall 升级（赶在 budget 烧完前喊人）

- **①值得吸收**：a2a referee 每次评估输出两路——**completion**（done/not-done，唯一终止条件）与 **progress**（improved/regressed/flat/unknown）。progress 连续 flat 达阈值(=3) 触发 `ProgressStallRaised` → 主动喊人，**而不是干等 budget 耗尽**。verified-delivery 现在靠 watchdog 周期巡 + reassign budget 兜底，缺一个「在没失败、但也没进展时提前升级」的显式信号。
  - 来源：`src/collab/referee.ts runReferee()`（dual-output + stall streak）
- **②不建议直接合并**：a2a 的 referee 是为它自己那套 board+run 生命周期写的（自带 RunFinished/budget.exhausted 终态），与 verified-delivery 的 goal/task 生命周期不同构，整体搬过来会拖一套平行状态机。
- **③落点**：把「progress 趋势 + stall streak」做成 watchdog 的一个判定维度，落 `src/core/goal-watchdog.ts runGoalWatchdogOnce`；升级动作复用既有 `TaskEscalated` 事件（`src/verified-delivery/types.ts`）+ `src/verified-delivery/narration.ts` 的 escalated narration，不必新造终态机。

## P3 — 事件不变量在 ledger append seam 强校验（防脏数据落账） ⭐第一优先级

- **①值得吸收**：a2a 用 Zod `superRefine()` 在事件 schema 上做**跨字段不变量**——`accepted` 必带 `taskId`、`rejected` 不得带 `taskId`，且在**事件追加的接缝处**校验，buggy 外部 actor / 人误点都会被挡在账本之外。这是个好习惯：让不变量内建于 schema，而非散落在应用逻辑。
  - 来源：`src/collab/contract.ts TaskProposalResolvedEventSchema.superRefine()`、`src/collab/event-log.ts appendUnlessStale()`
- **②不建议直接合并**：这是「做法/规范」而非「功能模块」，没有可搬运的成品；直接 copy 它的 schema 没意义。
- **③落点**：在 `src/verified-delivery/ledger.ts .append()` 加一道事件级不变量校验，并在 `src/verified-delivery/types.ts` 的各 LedgerEventDraft 上补 zod refinement（例如 TaskAccepted 必带 checkedBy/evidenceChecked、TaskRejected 必带 reason code）。这条**今天就能低成本吸收**，且能直接加固现有可信交付账本。（= codex 第一优先级：先做「append 前结构校验清单」，再决定哪些从 soft warn 升为 hard reject。）

## P4 — 事件驱动的验收门控（referee self-gate，省掉无谓重跑）

- **①值得吸收**：a2a referee **只在「上次判定后发生过 work-triggering 事件」(WorkerTurnFinished / ArtifactRecorded / GoalChanged) 时才重跑验收命令**，避免空转重复执行昂贵的 acceptance command。
  - 来源：`src/collab/referee.ts runReferee()` 的 self-gate 逻辑
- **②不建议直接合并**：耦合 a2a 的事件种类命名，需重映射到 verified-delivery 的 ledger 事件。
- **③落点**：`src/core/goal-watchdog.ts` 现在是纯 5min interval 轮询；可加一个「自上次 reconcile 以来该 task 是否有新 TaskReported / 证据变化」的门控，无新事件就跳过 `reconcileTaskByCriteria`（`src/verified-delivery/reconcile.ts`），省 IO/命令执行。纯效率优化，等有实际开销再做。

## P5 —（不吸收）控制面独占字段的乐观并发 CAS

- **①模式描述**：a2a 对 `goal` / `acceptanceCriteria` 这类「控制面独占决策点」用 `baseRevision` 做 compare-and-swap（陈旧写入被拒并记 `ConflictRaised`），其余字段 last-write-wins。意图是保护少数关键字段不被并发/陈旧写覆盖。
  - 来源：`src/collab/contract.ts EXCLUSIVE_BOARD_PATHS`、`src/collab/board.ts CAS check`、`src/collab/event-log.ts appendUnlessStale()`
- **②不吸收的原因**：verified-delivery 的真相是**追加式 ledger**，事件天然不互相覆盖，CAS-on-mutable-field 这个问题在 append-only 模型里基本不存在。仅当未来引入「可变的 goal charter / acceptanceCriteria 原地编辑」且多 actor（L2/人/watchdog）并发改同一字段时才有意义。
- **③落点（如真要）**：给 charter / acceptanceCriteria 的更新加一个 `baseSeq` 乐观检查，落 `src/services/goal-chat-store.ts` 或 charter 更新路径；否则不动。

---

## 已被 verified-delivery 覆盖、无需吸收

- **Board-as-truth + 可重放（kill/resume、daemon 重启 → 同一状态）**：a2a 靠可变 board 快照重放；verified-delivery 的**追加式 ledger + materialize 读模型**已经做到同样的可重放性，且 append-only 比可变 board 更健壮（无覆盖、天然审计）。这点 verified-delivery 不退反进，**不吸收**。
