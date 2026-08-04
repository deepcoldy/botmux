# Codex 自动续跑时恢复卡片执行中状态 — 设计

日期：2026-08-04　分支：`fix/codex-autoresume-card-status`

## 背景与现象

Codex 在一次回合结束、botmux 已把飞书卡片标记为「等待输入」后，可能由本地 `/goal` 等机制自动开始下一轮工作。实测会话中，worker 先记录 `Prompt detected (idle)` 并发布 idle，随后同一个 Codex 会话重新显示 `Working (... esc to interrupt)`、继续执行命令，但飞书卡片仍停留在「等待输入」。

这不是任务仍在运行却提前结束，而是 worker 的 prompt 状态只完成了 `working → idle`，没有观察并发布自动续跑产生的 `idle → working` 反向边沿。

## 根因

`IdleDetector.feed()` 在 idle 后收到新的 PTY 输出时，会把自身的 `isIdle` 清回 false、开始下一轮检测；但这个状态变化没有回调给 worker。

worker 的 `isPromptReady` 因此仍为 true，而定时 `screen_update` 又通过 `isPromptReady ? 'idle' : 'working'` 计算卡片状态。由 botmux 投递用户输入时，`flushPending()` 会显式把 `isPromptReady` 置 false；Herdr 的结构化 `working` 事件也会这样做。Codex 自动续跑既不经过前者，也没有后者，状态便永久落后于终端实际状态。

不能把「idle 后出现任意 PTY 字节」直接视为 working：终端 resize、光标移动、状态栏重绘也会产生输出，容易让真正空闲的会话误闪为执行中。

## 方案（采纳）

复用 `CliAdapter.busyPattern` 作为显式忙碌证据，给 `IdleDetector` 增加一次性 busy 边沿回调。

### 1. IdleDetector 暴露显式 busy 边沿

- 构造时保存 adapter 的 `busyPattern`，新增 `onBusy(callback)`。
- 只有 detector 已经报告过 idle，且随后收到的去 ANSI 输出（当前 chunk 或短尾缓存）命中 `busyPattern` 时，才触发 busy 回调。
- 一个活动周期最多回调一次；`markIdle()` 后重新允许下一次 busy 回调。
- botmux 主动提交前调用的 `reset()`、启动边界使用的 `resetReadyEvidence()` 不产生 busy 回调，因为这些路径已经由 worker 显式发布 working，且尚不存在可恢复的 idle 状态。
- idle 后若只有普通重绘且未命中 busy marker，detector 可以照常再次进入 idle，不改变 worker 状态。

这样既支持 busy 文案被拆到相邻 PTY chunk（通过现有短尾缓存匹配），也不把无语义的终端输出提升为状态切换。

### 2. Codex 声明显式 busy marker

在 Codex adapter 增加 `busyPattern`，匹配当前已验证的忙碌 UI：`Working` 与同一状态行中的 `esc to interrupt`。匹配保持大小写不敏感，并覆盖 TUI 在计时、状态字符变化时的重绘。

采用两个语义明确的文本锚点，避免仅凭通用 spinner 字符误判历史正文或普通状态栏。`busyPattern` 同时可被既有的 reattach/screen idle probe 复用，使 Codex 与已经声明该字段的 Genius、Grok、Pi 保持一致。

### 3. Worker 恢复 prompt/card 状态

普通 spawn 与 adopt 两种 IdleDetector 初始化路径都注册 busy 回调。回调执行以下动作：

1. 若 `isPromptReady` 已为 false，直接返回，避免重复 working 更新。
2. 将 `isPromptReady` 置 false。
3. 立即强制发布一次 `screen_update: working`，不等待 2 秒屏幕采样周期。

回调不再调用 `idleDetector.reset()`：`feed()` 已经开启新活动周期，保留当前 chunk 的 ready/spinner/尾缓存，才能在自动续跑真正结束后继续检测并发布下一次 idle。

### 状态转换

| 起始状态 | 证据 | 结果 |
| --- | --- | --- |
| idle | botmux 正常投递用户输入 | 沿用 `flushPending()`，立即 working |
| idle | 普通 PTY 重绘，未命中 busy marker | 保持 worker idle；detector 可重新确认 idle |
| idle | PTY 命中 Codex busy marker | `isPromptReady=false`，立即发布 working |
| working | 重复 busy marker | 不重复发布 working |
| working | ready/completion/结构化终止证据 | 沿用 `markPromptReady()`，发布 idle |

## 测试策略

先补失败回归测试，再实现：

1. `IdleDetector`：idle 后普通重绘不触发 busy；busy marker 单个 chunk 命中时触发一次。
2. `IdleDetector`：busy marker 跨 chunk 时仍触发；同一活动周期的重复 marker 不重复触发；再次 idle 后可再次触发。
3. `IdleDetector`：主动 `reset()` 后直接出现 busy marker 不产生伪 busy 边沿。
4. Codex adapter：匹配真实 `Working (... esc to interrupt)`，不匹配 idle composer / 普通回答文本。
5. Worker wiring：spawn 与 adopt 两条路径都注册 busy 回调，且回调恢复 `isPromptReady` 并强制发布 working。
6. 回归链路：覆盖 `idle → 自动 busy → idle`，确认卡片状态可恢复且后续完成仍能回到等待输入。

验证命令：相关 Vitest 用例、完整 `pnpm test`、`pnpm build`。

## 改动范围

- `src/utils/idle-detector.ts`：busy 边沿检测与回调。
- `src/adapters/cli/codex.ts`：Codex busy marker。
- `src/worker.ts`：spawn/adopt 两条路径的 prompt/card 状态恢复。
- 对应测试文件：上述行为回归。

## 风险与约束

- Codex 将来若改变 busy 文案，边沿可能再次漏报；adapter 单测固定当前真实 UI，升级 CLI 时能显式暴露漂移。
- 本次不把任意 PTY 活动泛化为 working，不修改卡片生命周期、turn 归因、消息投递或其他 CLI 的 adapter 行为。
- PR 阶段只执行测试和构建，不切换或重启当前正在承载业务会话的全局 botmux daemon；合并/发布后再按正常升级流程做在线验证。

## 验收标准

- Codex 已显示 idle 后自动续跑时，飞书卡片可在明确 busy UI 出现后恢复为「执行中」。
- 普通 idle 重绘不会造成「执行中」误闪。
- 自动续跑结束后仍能再次回到「等待输入」。
- 新增回归测试、完整单测与构建均通过。
