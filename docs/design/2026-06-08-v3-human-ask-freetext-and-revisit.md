# v3 HITL 自由文本 human-ask + 跨节点 revisit feedback 设计

- 日期：2026-06-08
- 状态：设计稿（claude × 菲菲公主 收敛，王皓已拍板转增量），待实现
- 关联：
  - `67742d8 feat(workflow): v3 goal-mode 运行时 human-ask（骑 blocked+retry 轨）` —— 本设计的**实现基线**
  - `docs/design/2026-06-03-v3-blocked-resultschema-design.md`（blocked/retry 轨）
  - `docs/design/2026-06-06-v3-structured-loop-design.md`（loop / feedback / 有界回溯）

## 0. 一句话

`67742d8` 已经把 HITL 的 MVP 实现了（goal worker 写 `ask.json`+`ASK_HUMAN` fail manifest → blocked → 飞书选项卡 → `answer.json` + `nodeRetryRequested.answer` → `buildInputs` 注入 `from:"human", name:"answer"` → 重跑）。本设计**不重造**，只做两个增量：

- **增量 1**：human-ask 从「2–6 选项按钮」扩到**自由文本答案**（补 PRD/计费规则这类填空场景）。
- **增量 2**：**跨节点 revisit feedback** —— 下游回溯上游时，把「为什么回 + 哪里错 + 你上次写了啥」注入给上游目标节点；加 revisit 预算安全闸。

两者复用同一根 rail：**事件钉指针路径 → `buildInputs` 读事件注入 → 目标节点 goal.txt 强制消费**。

---

## 1. 实现基线（`67742d8` 现状，代码事实）

| 关注点 | 现状 | 文件 |
|---|---|---|
| ask 协议 | `GoalAsk{question, options[2..6]}` / `GoalAnswer{selected, by}` | `contract.ts` |
| 触发 | worker 写 `ask.json`(`GOAL_ASK_FILE`) + `error.code=ASK_HUMAN`(`ASK_HUMAN_ERROR_CODE`) fail manifest，正常退出 | `contract.ts` / goal 侧 |
| 判定 | `classifyTerminal` 自报 fail+retryable → **blocked** | `runtime.ts` |
| 事件 | `nodeBlocked.ask = {question, options}` | `journal.ts` |
| 答案 | daemon 写 `answer.json`(`GOAL_ANSWER_FILE`) 于受阻 attempt 旁；`nodeRetryRequested.answer = {path, preview, by}` 指针 | `daemon-run.ts` `requestV3Retry` |
| 注入 | `buildInputs` 读 `answer.path` → 注入 `from:"human"`、`name:"answer"` | `runtime.ts` |
| 卡片 | `v3-blocked-card` 三态（受阻/拍板/已答）+ handler | `im/lark/v3-blocked-card*.ts` |
| adapter | goal-mode(`BOTMUX_V3_GOAL=1`) 禁原生 `AskUserQuestion`；`botmux-goal-ask` skill 教 agent 怎么问 | `adapters/cli/claude-code.ts` / `skills/definitions.ts` |
| 写序 | `writeFileSync(answer.json)` **在** `appendEvent(nodeRetryRequested)` **之前**（崩溃安全）；但是 **plain 写，非原子** | `daemon-run.ts` |

**局限（commit 自陈）**：单问题 + 选项按钮，未上多选 / 自由文本；revisit 完全未碰。

---

## 2. 增量 1：自由文本 human-ask

### 2.1 协议扩展（`contract.ts`）
`GoalAsk` 支持两种形态（二选一）：
```jsonc
// 选择题（现状，保留）
{ "question": "...", "options": ["A", "B"] }
// 填空题（新增）
{ "question": "...", "freeText": true }
```
`GoalAnswer` 对应二选一：
```jsonc
{ "selected": "A", "by": "ou_xxx" }      // 选择题
{ "text": "用户填写的内容", "by": "ou_xxx" } // 填空题
```
- 校验：`options` 与 `freeText` **互斥且必居其一**；`freeText:true` 时不得带 `options`。
- `readGoalAsk()`：识别 `freeText`，不再把「无 options」降级成普通 blocked 卡。

### 2.2 卡片（`v3-blocked-card` + handler）
- ask 卡新增**输入框形态**（`freeText` 时渲染文本输入 + 「提交」按钮；`options` 时维持按钮）。
- handler：`freeText` 提交 → `GoalAnswer.text`；选项点击 → `GoalAnswer.selected`。
- 三态不变（受阻/拍板/已答），「已答」冻结卡展示用户填的文本预览（限长）。

### 2.3 答案落盘（`daemon-run.ts` `requestV3Retry`）
- `input.answer` 扩成 `{ selected?: string; text?: string; by: string }`。
- **`answer.json` 改原子写（tmp + rename）**——硬要求，非优化。自由文本更长更易写到一半崩；对齐 `human-gate.ts` 既有的 `atomicWriteJson`。
- 写序不变：**先原子写 `answer.json`，再 append `nodeRetryRequested.answer`**。

### 2.4 注入 + 消费
- `buildInputs` 注入逻辑不变（读 `answer.path` → `from:"human"`/`name:"answer"`），文本/选项都走同一路径。
- `renderGoalFile` 的「Asking a human」段不变；agent 读 `from:"human", name:"answer"` 对应的 answer.json 拿决策续跑。

### 2.5 skill 文案（`botmux-goal-ask`）
- **必须同步改**：不能再写「只能 2–6 个选项」。新增：当答案无法用有限选项穷举（要用户补一段内容/规则/细节）时，用 `freeText:true`。给出选择题 vs 填空题的判据与示例。

### 2.6 不变量
- 写序：answer 先落盘、event 后写。
- 自由文本预览限长（卡片 + 投影），不外泄绝对路径/token。

---

## 3. 增量 2：跨节点 revisit feedback

### 3.1 现状缺口（代码事实）
现在 revisit 链路：节点 `result.json` 写 `status:revisit + revisitTo + reason` → `nodeRevisitRequested{toNodeId, reason}` → `affectedNodesFrom(toNodeId)` 把目标及下游标 `nodeInstanceSuperseded` → 目标新 instance 重跑。
**缺口**：`reason` 只进事件、从不注入；触发回溯的下游产出、目标自己旧产出都没带给目标的新 instance —— **上游瞎重跑**。

### 3.2 事件扩展（`journal.ts` `nodeRevisitRequested`）
在触发回溯那一刻钉死三个**快照路径（runDir 相对）**：
```jsonc
{
  "type": "nodeRevisitRequested",
  "nodeId": "review", "instanceId": "review#001", "attemptId": "review#001/attempts/001",
  "toNodeId": "prd",
  "reason": "PRD 缺少计费边界规则",
  "reasonPath": "revisits/review#001-attempt-001/reason.md",
  "sourceManifestPath": "review#001/attempts/001/manifest.json",
  "targetPreviousManifestPath": "prd#001/attempts/001/manifest.json"
}
```
- `reasonPath`：runtime 把 reason 落成 `reason.md`（reason 可能长，统一文件化）。
- `sourceManifestPath`：触发回溯节点（C）当时的 manifest 快照。
- `targetPreviousManifestPath`：回溯目标（A）当前 effective instance 的上一份**成功** manifest。
- v1 用 **manifest 快照模型**（不在事件里 stamp 选中的 file entries）；attempts 不可变 → manifestPath 是冻结指针，replay 确定。选择性 feedback 留后续（届时需 stamp「选择」决策）。

### 3.3 注入分两档（`runtime.ts` `buildInputs`）
调度**回溯目标 A 的新 instance** 时，新增 `from:"revisit"` 输入，注入**三件套**：
1. `revisit-reason` ← `reasonPath`
2. C 的产出 ← `sourceManifestPath` 的 manifest files
3. A 自己旧产出 ← `targetPreviousManifestPath` 的 manifest files

调度**中间被刷新节点**（target 与 C 之间）时：**只注入 `revisit-reason`**（它们要的是修正后的上游输入，不是完整反馈）。reason 全 cone 是低成本「指错靶」保险。

> 缺 A 旧产出，A 只会**重写**而非**在旧版上改** —— 三件套缺一不可。

### 3.4 强制消费（`runtime.ts` `renderGoalFile`）
target 的 goal.txt 追加硬指令：
> 这是一次由下游节点请求的回溯重跑。继续前必须先读 `from=revisit` 的 reason、source output、previous target output，并基于反馈修正当前节点产物。

非 target 的刷新节点：轻量说明「因上游回溯被刷新，可读 `revisit-reason` 了解背景，主要依据最新上游输入继续」。

### 3.5 安全闸：revisit 预算（两级）
1. **per `source→target` pair，默认 1 次**：主信号，blocked 时精确定位哪条边 ping-pong。`C→A` 与 `C→B` 是**独立计数器**。
2. **per-run 全局上限，默认 8**：总闸，防多目标横跳 / 多节点齐回溯把成本拖垮。
- 任一耗尽 → **run blocked**（不是某 attempt） → 发**预算耗尽卡**，人工 grant：补某条 pair +1，或抬全局上限。
- grant 卡复用 `loopIterationGranted` / blocked-retry 的 **expected 守卫**（带 expected pair + 当前计数 / 全局计数 + nonce），防过期卡 / 重复点击多放预算。
- 计数从 journal 的 `nodeRevisitRequested` 事件算（确定、可重放），不靠内存。

### 3.6 不变量
- `supersede` 只写 `nodeInstanceSuperseded` 标记，**永不删**旧 instance / 旧 attempt 文件（否则钉住的快照悬空）。
- 事件路径一律 runDir 相对；注入 `inputs.json` 时才转绝对；投影 / 卡片不泄露绝对路径 / token。
- revisit 仍是 DAG 外的运行时回跳，定义图永不成环。

### 3.7 和 loop 的边界
loop = 预先已知的局部反复（implement→test→fix），有 `maxIterations`，可视化好；revisit = 运行中才发现的不规则跨层回跳。**预期多轮打磨的固定链路用 loop，不要用 revisit。** 两者共享「feedback 注入 + 有界预算」的思路，不平行造轮子。

---

## 4. 改动文件清单 + 分工

| 文件 | 增量 1（自由文本 ask） | 增量 2（revisit feedback） |
|---|---|---|
| `contract.ts` | GoalAsk.freeText / GoalAnswer.text + 互斥校验 | （revisit 输入 label 常量，如需） |
| `journal.ts` | — | nodeRevisitRequested +reasonPath/sourceManifestPath/targetPreviousManifestPath |
| `runtime.ts` | readGoalAsk 识别 freeText；buildInputs 注入不变 | appendRevisitEvents 钉三路径 + 落 reason.md；buildInputs 加 `from:"revisit"` 注入；renderGoalFile revisit 段；预算计数 |
| `daemon-run.ts` | requestV3Retry 收 text + **answer.json 原子写** | 预算耗尽 → 发 grant 卡；requestRevisitGrant 入口 |
| `im/lark/v3-blocked-card*.ts` | ask 卡输入框形态 + handler text | revisit 预算 grant 卡 + handler（复用 expected 守卫） |
| `skills/definitions.ts` | botmux-goal-ask 文案改（允许 freeText） | — |
| `dag.ts` | — | revisit 预算默认值常量 / 校验（如需） |

**建议分工**（待与菲菲公主敲定）：
- **增量 1（自由文本 human-ask）** —— 内聚在「ask 协议 + 卡片 + skill + answer 落盘」，contract/card/handler/skill/daemon-run.requestV3Retry。
- **增量 2（revisit feedback + 预算）** —— 内聚在「journal 事件 + buildInputs 注入 + supersede 快照 + 预算/grant」，journal/runtime/daemon-run grant/grant 卡。
- **共享文件防冲突**：两者都动 `runtime.ts`(buildInputs) 和 `v3-blocked-card`——各自加**独立的 `from:` 分支 / 独立卡类型**，函数级隔离，不改对方分支。接口若要改先群里吱一声。

## 5. 测试计划
- 增量 1：freeText ask → blocked 卡渲染输入框；提交 text → answer.json 原子落盘 + 事件指针；buildInputs 注入 `from:"human", name:"answer"` 文本；skill 文案回归；options 形态不回归。
- 增量 2：`nodeRevisitRequested` 三路径 stamp；target 新 instance 注入三件套、中间节点只拿 reason；renderGoalFile revisit 段；per-pair 耗尽 → blocked + grant 卡；per-run 全局耗尽 → blocked；grant expected 守卫挡过期卡；supersede 不删文件（快照可读）；路径 runDir 相对、投影不漏绝对路径。

## 6. 明确不做（防 scope 蔓延）
- 批量多问题 / 一次 blocked 问多个。
- 多轮滚动 block-context（自由文本 ask 的多轮累积语义，先按现有单 answer 注入）。
- confirm_required（产出候选→求确认→候选回灌）。
- revisit 选择性 feedback（下游点名带哪几个文件）。
- 路径约定收敛（human-ask 的 answer.path 绝对 vs revisit 相对）—— 记 tech-debt，本轮不回改 human-ask。
