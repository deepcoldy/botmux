# v3 第一刀设计稿：blocked/failed 两档终态 + opt-in 输出契约

> 2026-06-03 claude 起草（md-first）。借鉴来源：acpus 对比笔记 `docs/design/2026-06-03-acpus-vs-v3-comparison.md` backlog ①②。
> 范围锁定 **slice 1（blocked vs failed）+ slice 2（opt-in result.json schema）**，二者互相依赖，一刀做。
> 实现排期：**等 grill 真机 e2e + `feat/v3-workflow` push/PR 之后**再开新分支落地；本稿只定方案 + 给 codex review。
>
> **v2（2026-06-03）**：合入 codex review 4 点——Blocker1（resume 必须走 `nodeRetryRequested` journal 事件，不能内存过滤，§2.6）；Blocker2（attemptId 从 journal 算 NNN，§2.7）；result.json 必须列进 manifest.files 经 validator（§3.2）；保留原始 errorCode + 枚举全部 runStatus union 站点含 V3RunOutcome/cli-run（§2.1）。另加 resultSchema 大小上限（§3.1）。
>
> **v3（2026-06-03，codex LGTM）**：合入 codex v2 的 4 点加固——nodeRetryRequested 带审计字段 previousErrorClass?/previousErrorCode?（§2.1）；attempt counter dispatch 权威 + retry intent 优先 + 入口幂等（§2.7）；resume **先 recovery 再 append retry** + 幂等护栏（§2.6）；schema 子集更严（required⊆properties、unknown keyword reject、array/object 只校验顶层类型，§3.1）；resume 第一刀只做 CLI/host 入口、dashboard 按钮后补（§7）。**codex 已 LGTM，设计定稿，排队等实现。**

---

## 0. 一句话

把节点终态从单一 `failed` 拆成 **`blocked`（语义/契约失败，可 resume 重跑）** 和 **`failed`（基建错，需介入）**；并给节点加一个 **可选** 的结构化输出契约（声明 `resultSchema` → agent 写 `result.json` → 校验失败=blocked）。**未声明 `resultSchema` 的节点零行为变化。**

**刻意不抄 acpus 的**：单轮「解析最后一个 JSON 块 + 1 次 repair」（v3 是多轮 `/goal` + manifest 完成协议，硬塞会变两套完成信号打架）；修复交给 resume/重跑节点或 `/goal` 同轮自纠。

---

## 1. 现状锚点（代码事实，方案就接在这上面）

| 关注点 | 现状 | 文件 |
|---|---|---|
| 节点状态 | `pending/gateWaiting/running/done/failed` | `orchestrator.ts` `V3NodeStatus` |
| run 状态 | `running/succeeded/failed` | `state.ts` `V3RunStatus` |
| 错误分类 | `workerError/manifestInvalid/timeout/gateRejected/cancelled` | `journal.ts` `V3ErrorClass` |
| 节点判定 | runNode 结果 AND manifest 校验 → `nodeSucceeded` 或 `nodeFailed{errorClass,message}` | `runtime.ts:341-368` |
| manifest | `status:'ok'|'fail'` + `error?:{code,message,retryable?}` | `contract.ts` `Manifest` |
| 节点 schema | `V3Node{id,type,goal?,bot?,depends,inputs,timeoutSec?,humanGate?}` | `dag.ts` `V3Node` |
| goal.txt | 从 contract 常量渲染的单一模板 | `runtime.ts` `renderGoalFile(goal)` |
| fail-fast | 任一 failed → `completeRunFailed`，最早 topo 序定 failedNodeId | `orchestrator.ts:64-108` |
| 投影 | `RunNodeView.status` 映射节点状态 | `ops-projection.ts` |

**两个现成钩子**（不用从零造）：
- `V3ErrorClass` 已经把失败原因枚举好了 → blocked/failed 只是给每个 class 贴一个「终态种类」标签。
- `Manifest.error.retryable?` 已存在 → agent 自报失败时用它区分软/硬。

---

## 2. Slice 1：blocked vs failed

### 2.1 新增 schema
- `orchestrator.ts` `V3NodeStatus` += `'blocked'`
- `state.ts` `V3RunStatus` += `'blocked'`；`V3RunSnapshot` += `blockedNodeId?: string`
- `journal.ts`：
  - `V3Event` += `{ type:'nodeBlocked'; nodeId; attemptId; errorClass; errorCode?; message? }`
  - `V3Event` += `{ type:'runBlocked'; blockedNodeId }`
  - `V3Event` += `{ type:'nodeRetryRequested'; nodeId; previousAttemptId; nextAttemptId; reason:'blockedResume'; previousErrorClass?; previousErrorCode? }`（**resume 恢复事件，见 §2.6——这是 blocked 可恢复的底层支点，不是 UI 语义**）。`previousErrorClass?`/`previousErrorCode?` 从被恢复的 blocked 事件复制，**不参与状态机、纯审计**（codex v2）——grep journal 能直接看出这次 retry 为何发生，不用回扫前文。
  - `V3ErrorClass` += `'resultInvalid'`（slice 2 用）
- **`errorCode` 保留原始 `manifest.error.code`**（codex review）：nodeBlocked/nodeFailed 都带，否则 dashboard 只看到粗粒度的 errorClass（workerError/resultInvalid），看不到节点自报的真实 code。`nodeFailed` 事件也同步加 `errorCode?`。
- 沿用现有 `nodeFailed`/`runFailed` 不动，新种类各自一组事件，跟现有模式对称。

**⚠️ runStatus union 的全部站点（codex review：不止 state/orchestrator）**——`'blocked'` 必须每处都接，否则被悄悄塌成 failed：
- `orchestrator.ts` `V3NodeStatus`、`state.ts` `V3RunStatus`（已列）
- **`runtime.ts:126` `V3RunOutcome.runStatus`**（现 `'succeeded'|'failed'`）+= `'blocked'`，且**修 runtime.ts:257 的 `=== 'succeeded' ? 'succeeded':'failed'` 强塌**（现会把 blocked 变 failed）
- `ops-projection.ts` `RunNodeView.status` / `RunView.runStatus`（§4）
- **`cli-run.ts:256`** 加 blocked 分支（打印「blocked，可 resume 重跑」而非按 failed 退出）
- `v3-runs-api.ts` 枚举随类型流过（无独立硬编码，确认即可）

### 2.2 终态分类（纯函数，单测友好）
```
classifyTerminal(errorClass, opts?: {retryable?: boolean}) → 'blocked' | 'failed'
```
| errorClass | 种类 | 理由 |
|---|---|---|
| `workerError` | **failed** | 进程崩/非0退出=基建 |
| `timeout` | **failed** | 超预算=基建（重跑给更多时间是 slice⑤/未来策略） |
| `cancelled` | **failed**（保持现有 cancel 路径，不重分类） | 用户主动取消，非自然终态 |
| `gateRejected` | **failed** | 人主动否决，重跑改变不了「不」，不可恢复 |
| `manifestInvalid` | **blocked** | agent 写了坏 manifest，重跑可能修好 |
| `resultInvalid` | **blocked** | result.json 缺/不符 schema，契约违反、可恢复 |

特例：manifest **结构合法但自报 `status:'fail'`**（runtime.ts:362-366 现走 workerError）改为按 `error.retryable` 分：
- `retryable === false` → **failed**
- 否则（true/undefined）→ **blocked**

### 2.3 runtime 判定改写（runtime.ts:351-368）
现在算出 `errorClass` 后无脑 `nodeFailed`。改成：算出 `errorClass`(+ manifest 的 retryable) → `classifyTerminal` → 发 `nodeBlocked` 或 `nodeFailed`。两种事件都带上 **`errorCode`（取 `manifest.error?.code`，缺则省略）** 供 dashboard 看真实 code（codex review）。`.catch` 兜底分支（373）仍 `workerError`→failed。

### 2.4 orchestrator 决策（orchestrator.ts decideNext）
- 失败扫描扩成两段，**failed 优先于 blocked**（基建错比契约错更严重）：
  1. 有 failed 节点 → `completeRunFailed{failedNodeId}`（不变）
  2. 否则有 blocked 节点 → **新 action** `completeRunBlocked{blockedNodeId}`（最早 topo 序）
- blocked 跟 failed 一样**halt 新派发**；in-flight peer 由 runtime/cancel 拆除（沿用 fail-fast 现有行为）。
- runtime 把 `completeRunBlocked` 翻译成 `runBlocked` 事件。

### 2.5 materialize（state.ts:62-92）
- `nodeBlocked` → set status `'blocked'`
- `runBlocked` → `runStatus='blocked'` + `blockedNodeId`
- `nodeRetryRequested` → node 状态重置 `'pending'`、`attempts.set(nodeId, nextAttemptId)`、若 `runStatus==='blocked'` 清回 `'running'`（见 §2.6）。**顺序敏感**：retry 事件在 nodeBlocked 之后、新 nodeDispatched 之前，replay 顺序天然正确。

### 2.6 resume 语义（这是 blocked 的回报）—— **codex Blocker 1 修订**

**坑（codex 抓的）**：journal 是权威源，`materialize(readJournal)` 会稳定回放出 `nodeBlocked`+`runBlocked`。**不能**靠「内存里把 blocked 当 pending 喂给 orchestrator」——下一轮 materialize 还是 blocked，replay 不成立，"可恢复" 只剩 UI 语义。**解锁必须也是一个 journal 事件。**

正确做法（**顺序敏感，codex v2：先 recovery 再 retry**）：
1. `workflow resume <runId>` **先**重放 journal + 跑现有 recovery/attach/dangling cleanup（v3 当前若无完整 recovery，至少重新 `materialize(readJournal)` 拿最新事实），把「其实已在跑/已写完但 STATE 旧」的节点先收敛——否则可能给一个实际已成功、只是投影滞后的节点错误地追加 retry。
2. 确认节点**仍是 blocked** 后，再 append **`nodeRetryRequested{nodeId, previousAttemptId, nextAttemptId, reason:'blockedResume', previousErrorClass?, previousErrorCode?}`**。
3. **幂等护栏（codex v2）**：append 前校验 ① 该 node materialized 状态仍 blocked ② `previousAttemptId` 匹配 latest attempt；不匹配 → no-op / 报 already-advanced。同一 blocked node 已有**未消费的** nodeRetryRequested 时**不再 append 第二条**（CLI/host 入口幂等；第一刀并发重跑不做全局锁，靠入口幂等兜）。
- `materialize` 看到 `nodeRetryRequested` → 把该 node 状态重置为 `pending`，并把 `attempts.set(nodeId, nextAttemptId)` 记成最新 attempt intent；run 若处于 `blocked` 也清回 `running`（有可恢复节点）。
- 之后 orchestrator 自然重派（decideNext 看到 pending+deps done → dispatchWork），runtime 用 `nextAttemptId` 落 `attempts/NNN`。
- failed 不自动重试（基建需人介入）；failed run 的 resume 维持现状，显式 `--retry-failed` 留后续 slice。**第一刀只支持 blocked retry。**

### 2.7 attemptId 从 journal 算 —— **codex Blocker 2 修订**

现状 `runtime.ts:270` 硬编码 `attempts/001`（注释 "MVP: no retry"）。承诺了 blocked resume 就**必须**一起改，否则重跑的 log/manifest/pty/STATE 会覆盖 001、语义混淆。
- 新 helper `nextAttemptId(journal, nodeId) → 'NNN'`：扫该 node 已有的 `nodeDispatched`/`nodeRetryRequested`，取 max NNN + 1（首派=001，blocked 重跑=002…）。**dispatch 事件为权威，retryRequested 只是 reservation**（codex v2）。
- **runtime 派发取数顺序（codex v2，防半写/restart 退回 001 或与 retry command 双算）**：若 `attempts` map 里已有该 node 的 retry intent（nextAttemptId），**用它**作为本次 attempt；否则自己 `max(dispatched, retryRequested)+1`。
- runtime 派发时用它替换硬编码 001；attemptDir/outputDir/各 path 跟着走 NNN。
- architect 的单发路径（architect.ts `ARCHITECT_ATTEMPT_ID='architect/attempts/001'`）**不在重试循环里，保持 001 不动**——只有 runtime 的逐节点派发要算 counter。
- 范围控制：第一刀 counter 只服务 blocked retry，不引入 failed retry / 任意重跑入口。

---

## 3. Slice 2：opt-in 输出契约（result.json）

### 3.1 节点 schema（dag.ts `V3Node`）
- += `resultSchema?: ResultSchema`（**可选**；声明了才启用整条契约）
- `ResultSchema` = JSON-Schema 的**极小子集**（手写校验器，沿用本仓无依赖风格）：
  ```
  { type:'object', properties: { <field>: { type:'string'|'number'|'boolean'|'array'|'object' } }, required?: string[] }
  ```
  - `validateDag` 里校验 resultSchema 形态本身：只接受这个子集，遇到不认识的构造**编排期就拒**（architect 不能写出校验器执行不了的 schema）。
  - 不支持嵌套/正则/枚举等——第一刀够用，后面 decisionGate 真要消费再扩。
  - **大小上限（codex review）**：`validateDag` 强制 schema 子集的上限——`properties` 字段数 ≤ ~32、序列化字节 ≤ ~4KB、depth=1（flat 子集天然 depth 1）。防 architect 生成巨型 schema 拖垮 prompt 和校验器。超限编排期拒。
  - **更严的子集约束（codex v2）**：`required` 数量 ≤ properties 数量、且 `required` 只能引用已声明的 properties；**unknown keyword 直接 reject**（不静默忽略）。
  - **明确不校验嵌套（codex v2，写清防误解）**：`type:'array'|'object'` 第一刀**只校验顶层类型**，不校验 array item / object 内部结构——子集是 flat 的，别误以为支持嵌套 schema。
- `resultPath?` 暂**不做**，固定 `result.json`（少一个变量；真要自定义留后续）。

### 3.2 result.json ↔ manifest 串法（关键：seam 干净）—— **codex strong suggestion 修订**

**坑（codex 抓的）**：原方案让 runtime 直接读 `outputDir/result.json`，但若 agent 没把它列进 manifest，这文件就**绕过了 manifest validator 的 path/hash/bytes 检查**，也不进审计/下游文件列表。

修订规则：**声明 `resultSchema` 时，manifest 必须包含一个 `path:'result.json'` 的 file 项**，让它跟其它产物一样过 manifest validator。
- **codex 的 `manifest.ts` 仍完全不动**——它照常校验 `files[]` 里列出的每个文件。"manifest 必须含 result.json 项" 这条断言是 **runtime 侧**对已校验 manifest 的检查，不是 manifest.ts 的新规则。
- **runtime 侧步骤（claude，runtime.ts）**：manifest 校验过且 `status:'ok'` 后，若 `node.resultSchema` 存在：
  1. 在已校验的 `manifest.files` 里找 `path:'result.json'` 的项——**没有 → `nodeBlocked`/`resultInvalid`**。
  2. 用该项**已被 validator 核过的相对 path** 定位文件（不再裸读 outputDir/result.json）。
  3. 新 `validateResult(filePath, resultSchema) → {ok, problems?}` 做 schema 校验。
  4. 缺项/parse 错/不符 schema → `nodeBlocked` errorClass=`resultInvalid`。
- goal.txt 注入文案（§3.3）相应强调：必须把 result.json **列进 manifest 的 files[]**。
- 把 result schema 校验放 runtime 而非 manifest.ts：resultSchema 来自 dag 节点（runtime 才有），manifest.ts 只认 outputDir 不认 node——放 runtime 既自然又让 codex 的契约零改动。

### 3.3 goal.txt 注入（runtime.ts `renderGoalFile`）
- 签名 `renderGoalFile(goal)` → `renderGoalFile(goal, resultSchema?)`。
- **只在 `resultSchema` 存在时**追加一段：
  > 额外要求：把结构化结果写到 `$BOTMUX_GOAL_OUTPUT_DIR/result.json`，须匹配此 schema：`<schema JSON>`；并把 `result.json` 列进 manifest 的 files[]。
- 未声明 resultSchema → goal.txt **逐字节不变**（golden test 锁这条）。

---

## 4. dashboard / 观测（最小改）

- `ops-projection.ts` `RunNodeView.status` += `'blocked'`；`RunView.runStatus` += `'blocked'`。投影把 `nodeBlocked`/`runBlocked` 映出来（materialize 已产出，projection 跟随）。
- `v3-runs-api.ts` 无形态改动（只多个枚举值）。
- 前端 `v3-page.tsx` / `v3-components.tsx`：blocked 节点独立配色（建议**琥珀/橙**，区别于 failed 红 / done 绿 / running 蓝）；节点面板显示 errorClass + message + 一句「可 `workflow resume` 重跑」。
- **安全不变量沿用**：投影 JSON 仍不含绝对路径/token（codex 之前钉的，blocked 不引入新字段泄漏）。

---

## 5. 兼容性 / 迁移（必须 review 的点）

✅ **零改动保证**：未声明 `resultSchema` 的节点——goal.txt 不变、不跑 result 校验、行为完全等同今天。旧 `dag.json` 无 resultSchema 字段 → 不变。

⚠️ **终态重分类（这是 feature 不是 bug，但是行为变更，需评审 + 改测试）**：
- `manifestInvalid` 现在 → `nodeFailed`/`runFailed`，**之后 → `nodeBlocked`/`runBlocked`**。
- manifest 结构合法但 `status:'fail'` 且 retryable≠false 同理转 blocked。
- 后果：断言「manifest 坏 → nodeFailed」的现有测试要改成 nodeBlocked。这正是我们要的语义升级，但 codex review 时要确认没有别处逻辑默认「失败=failed」。

---

## 6. 测试计划

- `classifyTerminal` 纯函数：每个 errorClass(+retryable) → 期望种类。
- `materialize`：nodeBlocked→'blocked'、runBlocked→runStatus'blocked'+blockedNodeId；**`nodeRetryRequested`→pending+attempts 更新+run 清回 running（replay 顺序：blocked→retry→重派）**。
- orchestrator：failed 优先于 blocked；纯 blocked → completeRunBlocked。
- **`nextAttemptId`**：首派 001、blocked 重跑算出 002、多次重跑递增。
- **resume 全链路（replay 验证）**：blocked run → `workflow resume` append nodeRetryRequested → 重新 `materialize(readJournal)` 得 pending（**不是仍 blocked**）→ orchestrator 重派 attempts/002。**这条专门防 Blocker1 回归**。
- `validateResult`：缺文件 / parse 错 / schema 不符 / 通过 四态。
- **result.json 必须进 manifest.files**：resultSchema 声明但 manifest 无 result.json 项 → resultInvalid/blocked。
- runtime verdict：resultSchema 节点 result 坏 → nodeBlocked/resultInvalid；manifestInvalid → nodeBlocked；nodeBlocked/nodeFailed 带 errorCode。
- `validateDag`：resultSchema 合法子集接受、越界子集拒；**超大小上限拒**；无 resultSchema 节点不变。
- ops-projection：blocked 状态正确投出；JSON 无绝对路径（沿用安全断言）。
- **V3RunOutcome/cli-run**：blocked run 不被塌成 failed（盯 runtime.ts:257 + cli-run.ts:256 分支）。
- **compat golden**：无 resultSchema 节点的 goal.txt 逐字节不变。

---

## 7. 明确不在这一刀（边界，防 scope 蔓延）

- ❌ acpus 单轮「解析最后 JSON 块 + 1 次 orchestrator repair」——不做。
- ❌ decisionGate/loop/condition DSL 消费 result 做分支——slice ⑥ 单开。
- ❌ `command`/`host` 确定性节点——slice ③。
- ❌ worker fencing（pid/generation/heartbeat/stale）——slice ⑤。
- ❌ dashboard 从 STATE 快照投影替代回放 journal——slice ④（本刀只给 ops-projection 加枚举值，不改投影机制）。
- ❌ `resultPath` 自定义、嵌套/复杂 JSON-Schema——后续。
- ❌ **dashboard 的 resume 按钮——第一刀只做 CLI/host `workflow resume` 最小入口**（codex v2）。只要 journal 事件 + runtime replay 语义对，UI 按钮后补很安全。
- ❌ failed retry / 任意节点重跑入口 / 并发重跑全局锁——后续（第一刀靠 resume 入口幂等兜并发）。

---

## 8. 改动文件清单（实现时对照）

| 文件 | 改动 | owner |
|---|---|---|
| `orchestrator.ts` | V3NodeStatus+blocked；decideNext 加 blocked 扫描 + completeRunBlocked（failed 优先） | claude |
| `state.ts` | V3RunStatus+blocked；snapshot.blockedNodeId；materialize 折 nodeBlocked/runBlocked/**nodeRetryRequested** | claude |
| `journal.ts` | V3Event+nodeBlocked/runBlocked/**nodeRetryRequested**；nodeBlocked/nodeFailed+**errorCode?**；V3ErrorClass+resultInvalid | claude |
| `runtime.ts` | classifyTerminal；verdict 改发 blocked/failed+errorCode；renderGoalFile(resultSchema?)；validateResult 串入；completeRunBlocked→runBlocked；**V3RunOutcome.runStatus+blocked + 修 :257 强塌**；**nextAttemptId(journal,nodeId) 替换硬编码 001** | claude |
| `dag.ts` | V3Node.resultSchema?；validateDag 校验 resultSchema 子集 + **大小上限** | claude |
| `cli-run.ts` | **:256 加 blocked 分支**（打印「可 resume 重跑」） | claude |
| `ops-projection.ts` | RunNodeView/RunView 状态+blocked | claude |
| `v3-page.tsx` / `v3-components.tsx`(前端) | blocked 配色 + 面板提示（errorCode/message + 「可 resume」） | claude |
| resume 入口（host/cli `workflow resume`） | 对 blocked 节点 append nodeRetryRequested | claude |
| `manifest.ts` | **不动** | — |
| `ephemeral-pool.ts` | **不动**（result.json 走 manifest files[]，pool 无感） | — |

> **codex review v1 已合**（Blocker1 resume 事件 / Blocker2 attemptId / result.json 进 manifest / errorCode + union 站点 / schema 上限，见顶部 v2 changelog）。
> **留 codex review v2 关注点**：① `nodeRetryRequested` 字段够不够（要不要带 reason 之外的 errorClass 溯源）；② `nextAttemptId` 从 journal 算的边界（半写 attempt、并发重跑）；③ resume append retry 事件跟 R0 dangling recovery 的先后顺序（先收 dangling 再 append retry？）；④ schema 上限数值（32 字段 / 4KB）合不合适。
