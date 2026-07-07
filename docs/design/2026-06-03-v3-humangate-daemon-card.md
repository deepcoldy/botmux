# v3 humanGate → 飞书审批卡（daemon 接线）设计稿

> 2026-06-03 claude 起草（md-first）。用户指令「和 codex 一起，把 humanGate 的逻辑加上」。
> codex 已先给方向（同意 Fork A + 6 条钉死点），本稿把它们落成可实现方案 + 给 codex 二轮 review。
> 范围：**让 v3 的 humanGate 节点在飞书弹审批卡、点了才继续、daemon 重启能恢复**。
>
> **v2（2026-06-03，合 codex 二轮 review，codex 认 → 开工）**：① **blocker：wait file 原子窗口**——runtime suspend 模式 append `gateDispatched` 后**同步** `writePendingWait`（runtime import human-gate 纯文件 store），再返回 awaitingGate；daemon 不再负责首写 wait（§3）。② **cold-attach reconcile**——不只扫 listPendingWaits，还从 journal materialize 出 gateWaiting 节点，对缺失 wait file 用 dag `humanGate.prompt` 补写（修 append/write 中间崩的恢复窗口，§4.5）。③ runtime 加 `gateMode:'blocking'|'suspend'`（默认 blocking 保 CLI/dev，daemon 传 suspend，§3）。④ `V3RunOutcome` 改 **discriminated union**（reason:'terminal'|'awaitingGate'），防 awaitingGate 被折成 failed（§3）。⑤ OQ-1~5 全 resolved（§8）。⑥ card handler 点击先查 run 是否 terminal/不存在 → stale toast（§4.4）。

---

## 0. 一句话 + 范围

v3 引擎的 humanGate 在 runtime/human-gate.ts 早就 seam 好了（`createFileGate({awaitDecision})` + waits/<id>.json 持久化 + listPendingWaits），**唯一缺的是 daemon 那侧的 `awaitDecision`（发卡 + 点击 resolve + 重启重挂）以及一个 daemon 驱动 run 的执行路径**。本刀补齐这两块，让 grill 编出来的、带 risk_gate 的 DAG 在飞书话题里真的「停下等人点批准」。

**不在这一刀**（§7 详列）：gate 超时/allow-list/多人审批、decisionGate 分支、cancel 期间的 gate、CLI 路径改造（保留终端 y/N 当 dev 入口）。

---

## 1. 现状锚点（代码事实）

| 关注点 | 现状 | 文件 |
|---|---|---|
| gate 文件存储 | `writePendingWait`/`readWait`/`resolveWait`/`listPendingWaits`，原子写 | `v3/human-gate.ts` |
| gate resolver seam | `createFileGate({awaitDecision})` — 唯一 daemon 耦合点 | `v3/human-gate.ts:132` |
| runtime gate 派发 | 节点有 humanGate → 要求 `deps.resolveGate`；append `gateDispatched` → 调 resolveGate → append `gateResolved` | `runtime.ts:384-401` |
| orchestrator gate 决策 | `pending`+humanGate+`!gateCleared` → `dispatchGate`；`gateWaiting` 当 in-flight，**不再 emit** | `orchestrator.ts:87-98` |
| gate 清除语义 | `gateResolved{approved}` → 节点回 `pending`+`gateCleared=true` → 下 tick 派 work 不再派 gate；`rejected` → 节点 `failed` | `orchestrator.ts:29-33` |
| v3 run 入口 | **仅 CLI**（`cli-run.ts`，终端 y/N，非 TTY 自动拒 `cli:non-tty`） | `cli-run.ts:100-119` |
| grill approve-dag | 只推进状态 + **打印**「开跑 botmux v3 run」，不自动跑 | `host.ts:314-318` |
| grill run 触发 | skill 让 agent 在 worker shell 里 CLI 跑 `botmux v3 run`（非 TTY） | `definitions.ts:1147` |
| v0.2 daemon 驱动 run（参照样板） | `driveWorkflowRun(runId)` 进程内跑 runLoop；terminal → patch 卡 + cleanup；card 点击后 re-enter | `daemon.ts:678-707` |
| v0.2 审批卡 | `buildWorkflowApprovalCard`；action `wf_approve`/`wf_reject`；card-handler `resolveWait` | `workflow-cards.ts` / `workflow-card-handler.ts` |

**核心缺口**：v3 没有 daemon 驱动的 run 路径。Feishu 卡片是 daemon 的活（有 Lark client + card-handler + 重启恢复），所以 humanGate 卡必须由 daemon 驱动的 run 来发。

---

## 2. 架构选型：Fork A（daemon 驱动 run），B 仅作 rejected alternative

**A（采纳）**：daemon 进程内驱动 v3 run（仿 `driveWorkflowRun`），gate → daemon 发 v3 审批卡 → 点击 resolve + re-drive → 重启 re-arm。运行时所有权单源在 daemon，复用 v0.2 卡/handler/recovery 形态，有真重启恢复。

**B（拒绝）**：v3 run 仍跑在 grill agent 的 worker CLI 里，awaitDecision 写 wait 文件阻塞轮询，daemon 起全局 waits-watcher 发卡、card-handler 写回。**拒绝理由（codex）**：把「运行时所有权」拆到 worker CLI + daemon watcher 两边，后面 recovery / cancel / dashboard live terminal / gate 卡片全变双源协调；worker CLI 进程死了 run 成孤儿。长期成本高。

`botmux v3 run` 终端 y/N 路径**保留**，当 daemon 外的本地/dev 调试入口（codex #6）。飞书产品路径走 daemon-driver。

---

## 3. 关键决策：gate 模型 = suspend-and-redrive（X2），不是 blocking-promise（X1）

这是这刀**最容易漏、最该花笔墨的恢复语义**（codex #3 点名）。

**问题**：现在 runtime 的 `resolveGate` 是 **blocking promise**（runtime 内 `await` 住，整个 run 挂在内存 promise 上）。CLI 终端 y/N 阻塞、daemon 若也用「卡片点击 resolve 内存 promise」——**重启后内存 promise 没了**。而 journal replay 到 `gateWaiting` 时 `decideNext` 不再 emit `dispatchGate`（orchestrator.ts:87），naive re-drive `runWorkflow` 直接 no-progress。所以 blocking 模型重启恢复天然断。

**X2（采纳）—— runtime 返回 `awaitingGate` 而非阻塞**（对齐 v0.2 runLoop 的 `awaiting-wait`）。由 `gateMode` 开关控制（codex OQ-2）：

```
gateMode?: 'blocking' | 'suspend'   // 默认 'blocking'（CLI/dev 现状不变）；daemon 传 'suspend'
```

- **blocking（默认，CLI/dev）**：现状不变——runtime `await` resolveGate（终端 y/N）。零回归。
- **suspend（daemon）**：
  - dispatchWork 照常启动并发节点；遇到 dispatchGate **不 await**——append `gateDispatched` 后**立刻同步 `writePendingWait(runDir,{waitId,nodeId,prompt})`**（runtime import `human-gate.ts` 纯文件 store，非 daemon 耦合），再标节点 gateWaiting。
  - **⭐ wait file 原子窗口（codex v2 blocker）**：append `gateDispatched` 和 `writePendingWait` 都在 runtime suspend 路径里**连续做完**，daemon 不再负责首写 wait。这样「journal=gateWaiting 但 wait file 缺失」的窗口被压到最小（仍非严格原子，§4.5 cold-attach reconcile 兜底补写）。
  - 当**没有 inFlight 且 snapshot 存在 gateWaiting** → 返回 `{reason:'awaitingGate', pendingWaits:[{nodeId,waitId,prompt}], runDir}`，**不 no-progress throw**。in-flight 并发节点先跑完才返回（不撞第一个 gate 就 abort）。
- daemon driver 收到 `awaitingGate` → wait file 已由 runtime 写好 → 只**发 v3 审批卡**到绑定话题 → 挂起，不持有 run 内存态。
- 点击 → resolveWait + append `gateResolved` → **driveV3Run(runId) 重入**：fresh replay → 节点 `gateCleared`(approved)→`dispatchWork` / `rejected`→failed fail-fast。可能再撞下一 gate → 再返回 awaitingGate。
- **统一**：happy path 和重启恢复**同一条 click→redrive 路径**；恢复只需「重发卡」。

**`V3RunOutcome` 改 discriminated union（codex v2）**——别只在 `runStatus` 上扩，否则 CLI/daemon 分支会把 awaitingGate 误折成 failed（正好踩 runtime.ts:257 那个强塌）：
```
type V3RunOutcome =
  | { reason: 'terminal'; runStatus: 'succeeded' | 'failed'; ... }
  | { reason: 'awaitingGate'; pendingWaits: {nodeId,waitId,prompt}[]; runDir: string }
```

**X1（拒绝）**：保留 blocking resolveGate，重启 recovery 重置 gateWaiting + 重新 dispatchGate 再 await。缺点：happy/restart 两条 click 路径、重置状态 hacky、gateDispatched 重复幂等麻烦。

⚠️ **runtime 改动归属 codex**（执行/runtime 侧，codex OQ-2 评估=中等偏小、不重写调度）：加 `gateMode` 开关；suspend 模式 dispatchGate 只 append+writeWait 不 await；无 inFlight 且有 gateWaiting → 返回 awaitingGate。blocking 默认保 CLI dogfood 零回归。

---

## 4. Fork A 详细设计

### 4.1 run 触发（codex #1）
`botmux workflow approve-dag <id>` **只做 Gate-2 状态推进**（dag_ready→dag_approved），不变。新增明确启动动作，二选一（请 codex/用户 拍）：
- **(a) daemon HTTP IPC**：`POST /api/v3/runs/:id/start`（dashboard / grill skill 都能调）。daemon 读 runDir 的 spec/dag/botsSnapshot/chatBinding → 创建 `v3Runs` entry → `driveV3Run(id)`。
- **(b) approve-dag --start**：CLI flag，但 approve-dag 跑在 agent worker（非 daemon 进程），仍要 IPC 到 daemon 才能进程内驱动 → 本质还是绕到 (a)。

**倾向 (a)**：单一 daemon 入口，dashboard「开跑」按钮 + grill skill 都走它；grill skill step 7 从「让 agent CLI 跑 v3 run」改成「调 start IPC（或提示用户点 dashboard 开跑）」。standalone `botmux v3 run` 不变（dev）。

### 4.2 run binding 必须持久化（codex #2）
daemon 能发卡**不是因为进程内有上下文**，而是 runDir 落了 chatBinding。否则重启后 listPendingWaits 找到 wait 也不知道往哪张话题发。
- grill **run 出生时**（host.ts `workflow new` / grill-state）记录 `{larkAppId, chatId, anchor(rootMessageId), ownerOpenId}` 到 runDir（新 `run-binding.json` 或并进 grill.state.json）。
- daemon driver 启动 / 重启恢复都从这里读 binding。
- ✅ **OQ-1 已查证可行**：worker 给每个 CLI 子进程注入 `BOTMUX_SESSION_ID`/`BOTMUX_CHAT_ID`/`BOTMUX_LARK_APP_ID`（`worker.ts:3073-3075`）+ `BOTMUX_ROOT_MESSAGE_ID`（herdr-backend.ts:185）。所以 grill 的 `workflow new` 跑在 worker shell 里时，env 里就有话题上下文，host 直接读 env 落 chatBinding 即可。ownerOpenId 同理（session owner，worker 知道）。**整个发卡链路因此可行，不被卡。**

### 4.3 gate → 发卡（codex #4：复用视觉，不复用 action namespace）
- 抄 v0.2 卡片的 builder / freeze / toast / nonce 模式，但**新建 v3 卡 + 新 action**：`v3_gate_approve` / `v3_gate_reject`，value 带 `{runId, waitId, nonce}`。
- **不**塞进 v0.2 `workflow-card-handler` 的 wait path——v3 wait 权威是 `waits/<id>.json + journal.ndjson`，跟 v0.2 events schema 不同。新 `v3-gate-card-handler.ts`。
- 卡内容：节点 id + gate prompt + 批准/拒绝按钮；点完 freeze 成已批准/已拒绝态。

### 4.4 click 幂等 + 写序（codex #5）
card handler 收到 `v3_gate_approve|reject`：
1. 解析 `{runId, waitId, nonce}`，校 nonce。
2. **先查 run 是否已 terminal / 不存在**（codex OQ-5）：run 已 succeeded/failed/cancelled 或 runDir 没了 → 返回 stale/already-terminal toast，**不 redrive**（防旧 gate 卡把已结束 run 又拉起）。
3. **读 wait 文件**：非 pending → already-settled toast（幂等，防重复点 / 重启后旧卡）。
4. pending → **先原子写 `resolveWait(approved|rejected, by=点击人 open_id)`，再 append `gateResolved` journal**。append 失败 → warn + 允许下次点击/repair，**不把 UI 假装成功**。
5. resolve 成功 → 触发 `driveV3Run(runId)` 重入续跑。
- canOperate gate：谁能点批准？MVP 沿用话题 owner / allowedUsers（risk_gate 没 allow-list，§7）。

### 4.5 重启恢复（codex #3，这刀的真核心）
daemon 启动时 cold-attach（仿 v0.2 listPendingWaits 重挂）。**不能只扫 listPendingWaits（codex v2 blocker）**——若进程在 append gateDispatched 后、writePendingWait 前崩（即便 §3 把窗口压到最小，仍非严格原子），journal=gateWaiting 但 wait file 缺失，naive 扫描会漏。所以做 **reconcile**：
- 扫所有非终态 v3 run 的 runDir。
- 对每个 run：`materialize(readJournal)` 得 snapshot → 找出 **gateWaiting 节点**。
- 对每个 gateWaiting 节点：
  - 有对应 pending wait file → 直接用。
  - **wait file 缺失 → 用 dag 里该节点的 `humanGate.prompt` 补写一个 pending wait**（`writePendingWait`），修 append/write 中间崩的窗口。
  - wait 已 resolved（journal 也该有 gateResolved，理论不该停在这）→ 跳过，让正常 drive 续。
- 对每个最终 pending 的 wait：读 chatBinding → **重发审批卡**（runId/waitId/新 nonce）。**不主动 drive run**（X2 下无内存态要重建）。
- 之后等点击，走 §4.4 同一条 click→redrive 路径。卡片旧 message id 失效就重发新卡，幂等靠 wait pending 判定。

### 4.6 daemon driver（`driveV3Run`，仿 driveWorkflowRun）
- `v3Runs: Map<runId, {ctx, running?}>`（v3 专用，不复用 v0.2 workflowRuns）。
- `driveV3Run(runId)`：跑 runWorkflow → 收 outcome：
  - `succeeded|failed` → patch 终态卡 / 发结果 + cleanup。
  - `awaitingGate` → §4.3 发卡，挂起（不 cleanup，run entry 留着或丢弃由 X2 决定——X2 下可丢，靠 journal+wait 文件恢复）。
- 进度可复用现有 v3 journal 摘要 → botmux send（观测，可选，跟 dashboard 并行）。

---

## 5. owner 拆分（沿用引擎那次边界）

| 块 | owner |
|---|---|
| runtime `gateMode:'blocking'\|'suspend'`；suspend 下 dispatchGate **append gateDispatched + 同步 writePendingWait**（import human-gate）+ 无 inFlight 有 gateWaiting → 返回 awaitingGate；CLI 路径 blocking 零回归 | **codex**（执行/runtime） |
| `V3RunOutcome` 改 discriminated union（reason:'terminal'\|'awaitingGate'） | codex（定义）+ claude 投影/cli-run 跟随 |
| daemon `driveV3Run` + v3Runs 轻量 map + 终态/awaitingGate 分支（awaitingGate 只发卡，wait 已由 runtime 写好） | claude（daemon/调度） |
| 启动动作 IPC `POST /api/v3/runs/:id/start`（+ 可选 `botmux workflow start` CLI wrapper） | claude（daemon/API） |
| chatBinding 持久化（run birth 读 env 落盘 + 读取） | claude（持久化）；env 可行性已确认（OQ-1） |
| **cold-attach reconcile**（materialize gateWaiting + 补写缺失 wait + 重发卡） | claude（daemon/恢复） |
| v3 审批卡 builder（复用 v0.2 视觉）+ `v3-gate-card-handler`（新 action `v3_gate_approve/reject`）+ click 幂等 + terminal-check | claude（daemon/卡片） |
| grill skill step 7 改成调 start IPC（不再 CLI 跑） | claude（skill 文案） |

codex 共享 worktree **只读**，改动落 claude 这条 `feat/v3-workflow`（除 runtime awaitingGate 那块由 codex 改、claude 合）。

---

## 6. 测试计划

- **runtime（codex）**：suspend 模式撞 gate → append gateDispatched **+ 同步 writePendingWait（wait file 立即在盘上）** → 返回 `awaitingGate`+pendingWaits 正确；in-flight 并发节点先跑完才返回；**blocking 默认模式 CLI 终端 y/N 零回归**；V3RunOutcome union 分支 CLI 不把 awaitingGate 折成 failed。
- **human-gate 文件**：writePendingWait/resolveWait/listPendingWaits 已有，补 click 幂等（resolve 已 settled wait → no-op/报 already）。
- **card-handler（claude）**：approve→resolveWait(approved)+gateResolved+driveV3Run 被调；reject→failed；重复点 → already-settled toast 不重复 resolve；nonce 不匹配拒。
- **重启恢复**：造一个 pending wait 的 runDir → 模拟 cold-attach → 断言重发卡（读 chatBinding）、不 drive；点击后续跑。
- **⭐ reconcile 原子窗口（codex v2 blocker，专测）**：造一个 journal 有 `gateDispatched` 但 **wait file 缺失** 的 runDir（模拟 append 后 write 前崩）→ cold-attach reconcile → 断言用 dag `humanGate.prompt` **补写出 pending wait** + 重发卡，run 能恢复。
- **redrive 语义（防 no-progress 回归）**：gateWaiting journal → append gateResolved(approved) → re-materialize 节点 pending+gateCleared → decideNext 出 dispatchWork（**专测 codex #3**）；rejected → failed。
- **chatBinding**：run birth 落盘 + 读取；缺 binding 时 driver 优雅报错不崩。
- **端到端 dogfood**：grill 编一个带 risk_gate 的 DAG → start → 卡片落话题 → 点批准 → 续跑 → 终态；中途 restart daemon → 卡片重挂 → 点击仍能续。

---

## 7. 明确不在这一刀

- ❌ gate 超时 / deadline / allow-list / 多人会签（MVP 单人 owner 点）。
- ❌ decisionGate 分支路由（slice ⑥）。
- ❌ cancel 期间正 pending 的 gate 怎么收（先按现有 cancel 路径，gate wait 留着；精细化后续）。
- ❌ CLI 路径改造（保留终端 y/N 当 dev）。
- ❌ blocked/resultSchema 那刀（独立设计稿 `2026-06-03-v3-blocked-resultschema-design.md`，不混）。

---

## 8. 给 codex 的 review 关注点（OQ）

**全部 resolved（codex v2 回答）：**
- ✅ **OQ-1**：常规 worker spawn 注入 `BOTMUX_SESSION_ID/CHAT_ID/LARK_APP_ID/ROOT_MESSAGE_ID`；v3 ephemeral pool 才额外设 `BOTMUX_WORKFLOW=1`。grill 是 live-session skill 非 execution worker → 能读这些 env 落 chatBinding。**假设成立**。
- ✅ **OQ-2**：runtime 改动中等偏小、不重写调度 → `gateMode:'blocking'|'suspend'` 开关（§3）。
- ✅ **OQ-3**：选 (a) daemon HTTP IPC `POST /api/v3/runs/:id/start`（dashboard 复用）；可再包一个 `botmux workflow start <id>` CLI wrapper 去 POST，但**主入口是 IPC**，不把 `approve-dag --start` 做成主语义。
- ✅ **OQ-4**：awaitingGate 后**不保留重 runtime 上下文**，最多留轻量 card/update map；恢复源是 runDir 的 dag/journal/wait/chatBinding，每次点击 fresh replay。
- ✅ **OQ-5**：cancel 期间 pending gate deferred（§7）；但 card handler 点击时**必须查 run 是否 terminal/不存在 → stale toast**（已进 §4.4 step 2）。
