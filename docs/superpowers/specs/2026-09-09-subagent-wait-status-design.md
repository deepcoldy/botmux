# 子 Agent 等待态状态设计

## 目标

Botmux 的 DONE reaction 与完成态卡片表示“当前聚合任务已经结束”，不能仅表示父 CLI 已恢复输入框。父 agent 等待仍在运行的子 agent 时，界面可以继续交互，但 Botmux 必须保持工作中。

## 根因

Botmux 当前把 CLI 的屏幕 idle 作为回合完成投影。Claude Code 在主 agent 等待后台子 agent 时会恢复 `❯`，并移除主 agent footer 中的 `esc to interrupt`；现有 `CLAUDE_BUSY_FOOTER_RE` 因而不命中。2 秒静默后 IdleDetector 发布 `working → idle`，worker-pool 随即完成 reaction 并把卡片投影为空闲/完成，即使任务面板仍有 `◯ Explore … 6m … tokens` 的活动子 agent。

## 状态语义

区分两个正交概念：

- **可交互**：父 CLI 当前接受用户输入；由 `❯` 等 composer 信号表示。
- **任务完成**：当前聚合 turn 及其子工作均已结束；才允许 DONE reaction 和完成态卡片。

父 agent 等待子 agent 时属于“可交互但未完成”。

## 方案

### Claude Code / Seed / Relay

扩展共享的 Claude busy pattern，增加任务面板活动行作为 busy 正证据。匹配必须同时具备：

- 行首缩进后的活动标记 `◯`；
- agent 名称/类型与任务描述；
- 行尾持续时长；可选 token 计数。

不匹配：

- `✔` 已完成项；
- `◻` 未开始待办；
- 普通正文中出现的圆圈、时间或 token 文本；
- 没有运行时长的静态任务标题。

该证据并入既有 `busyPattern` 与 `idleToBusyPattern`：idle 前的 viewport probe 会阻止误完成；若已经误 idle，新的 PTY redraw 也会恢复 working。最后一个活动行消失后，原有 `❯ + 静默` 逻辑重新允许 idle。

### Codex / TraeX

不复用 Claude UI 正则。两者均声明 `reliableTurnTerminal: true`：

- Codex 以 rollout `assistant_final` / `turn_terminal` 为完成依据；
- TraeX 以 rollout `task_complete` / `turn_terminal` 为完成依据。

新增行为测试验证子 agent/后台工作期间不会产生结构化 terminal。若 fixture 或真实验证显示 terminal 会提前，再为对应 CLI 增加其结构化子任务计数或专属 UI 信号；不使用进程树猜测，也不把 Claude 文案硬编码到其他适配器。

## 测试

1. Claude busy pattern 命中真实活动子 agent 行。
2. Claude busy pattern 不命中完成项、待办项和正文伪例。
3. IdleDetector 在 `❯` 与活动子 agent 行共存时不发布 idle。
4. 活动行消失且 composer 保留时，正常发布 idle。
5. Codex/TraeX 的可靠 terminal 测试明确锁定：仅结构化终态触发完成，屏幕暂时 idle 不提前完成。
6. 运行相关适配器、idle detector、turn reaction 测试与生产构建。

## 影响范围

仅调整各 CLI 的完成证据，不改变输入、子 agent 创建、调度或任务面板 UI。Claude 家族共享正则；Codex/TraeX 先验证既有结构化边界，不在无证据时修改生产逻辑。
