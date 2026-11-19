# Antigravity 在 Botmux 中的实现差异

结论：Antigravity 已有恢复、原生 fork、结构化 transcript、取消与基础用量观察，并非只有终端文本转发。相较 Codex / Codex App 与 Claude Code，它的主要差距在输入提交与完成判定的维护成本、原生 Skill 安装接入，以及控制面的能力覆盖。比较的是 Botmux 集成，不评价底层模型质量或推理速度。

## 1. 输入与完成判定

默认 terminal 路径通过逐行输入、M-Enter 和 history 增量确认提交，长消息的传输成本随行数增加；完成与忙闲需要 transcript、屏幕与 Worker 的补充判定。Codex App 和新 ACP 路径提供结构化输入/回执，减少终端呈现变化带来的适配成本。证据：`src/adapters/cli/antigravity.ts` 的 `writeInput` / `isSessionBusy`、`src/worker.ts` 的 Antigravity transcript bridge、`antigravity-bridge-decision.ts`。

ACP 已显式支持按 Bot 启用，但不是默认；每轮起受管进程并精确加载原生 session，存在初始化成本。既有验证记录中 18,090 字节、403 行的原生接收约 3 秒，只是单机样本，不能据此推断不同 Agent 的模型响应速度。证据：`docs/plans/2026-11-09-antigravity-acp-input.md`。

## 2. 原生交互与 ACP 的兼容取舍

terminal 支持原生 TUI、slash 命令、会话恢复、历史导入以及 `/fork` 后确认新 session ID；忙时输入与交互菜单之间仍存在适配注释标出的未统一控制问题，须以具体场景复现后再修复。

ACP 支持整段输入、结构化进度/终态、精确恢复、取消与子进程组回收，且不提供原生交互选择器、原生 slash 操作、fork、wrapper、startupCommands、零注入与交互审批模式。它只适用于原本自动批准工具的 Bot；不应为了性能自动修改权限。证据：`antigravity-acp.ts`、`antigravity-acp.ts` 服务、`antigravity-transport.ts` 与相关 ACP 回归测试。

## 3. 模型与思考强度控制面

当前发布版 Antigravity 候选来自静态快照；前一项 PR 接入 `agy models`，沿用 10 分钟缓存。角色管理这项改动进一步接通群级模型与 low / medium / high 思考强度，且对新话题保存快照。更高等级虽出现在当前 CLI help 中，terminal 适配器并未传递，暂不作为已支持能力公布。

任务级模型覆盖的显式准入 `TASK_MODEL_OVERRIDE_CLI_IDS` 仍不含 Antigravity；因此“启动可以选模型”不意味着“所有 trigger / schedule 的模型覆盖都已接通”。新的 dispatch launch v1 只支持官方 Codex TUI，也不能按名字类推到 Antigravity。证据：`launch-model-capability.ts`、`dispatch-launch-identity.ts`、`dispatch-launch-contract.ts`。

## 4. Skill 与生态接入

Antigravity 适配器不声明 `skillsDir`：当前注释描述其原生 Skill 依赖插件包布局，与 Botmux 的平铺 Skill 安装结构不同，现有通用路由提示通过 systemHints 注入。因此 Skill 的原生自动发现与安装接入不如已明确声明 Skill 目录的 Codex / Claude Code 完整。需区分 Botmux 的提示词注入可用，与原生 Skill 插件安装已完成。

模型列表、原生 fork 与恢复已有实现，不能列为缺失；ACP 没有原生 fork 则是传输模式差异。原生 CLI 1.5.3 及现有适配代码为本次核对依据，不声称覆盖所有未来版本或所有 Agent 的同一能力。

## 5. 建议优先级

1. 先验收动态模型目录与角色群级模型/思考强度，本次已实现并加回归。
2. 对长消息场景验证 ACP，保留 terminal 给需要 TUI / fork / 交互审批的 Bot。
3. 单独补齐原生 Skill 插件布局接入与更高 effort 等级，先证明 CLI 实际接受和生效。
4. 如需调度任务逐次选择模型，再扩展显式任务策略和对应测试；不借 UI 开放隐式改变策略。
5. 终端交互菜单、busy raw_input、权限确认与完成检测建立专项复现场景，避免只修改正则后宣称与结构化后端等价。
