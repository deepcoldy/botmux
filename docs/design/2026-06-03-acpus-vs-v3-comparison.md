# acpus vs botmux v3 workflow —— 调研对比 + 借鉴 backlog

> 2026-06-03 claude 调研。源：https://github.com/kelvinschen/acpus（精读 README/specs/ADR/示例 spec/能力 roadmap）。

## 0. 一句话

同一个问题（多 agent 编排）的两种哲学：
- **acpus** 赌「声明式 spec → 编译成确定性 execution-plan → 调度器跑」，智能在**写 spec**，运行时纯确定性。
- **botmux v3** 赌「模糊目标 → grill 一问一答 → architect LLM 生成 dag.json → ephemeral worker 跑 `/goal` 自主多轮」，智能在**生成流程**。

最该抄的不是它的流程生成（它恰恰把这块砍了），而是它**节点执行层的确定性纪律**。

## 1. acpus 是什么

- "Runtime-driven workflow orchestrator for ACP agents, built on acpx runtime"。"Every run is an opus."
- 链路：手写/agent 写 `workflow.spec.json` → Zod 校验 + graph lint（JSON Pointer 报错）→ 编译成 `execution-plan.json`（确定性快照）→ runtime scheduler 调度 stage → 经 acpx runtime API 驱动 agent session。
- **不**生成/执行 acpx flow 文件，只走 runtime API。
- run 目录 `.acpus/runs/<id>/`：workflow.spec.json / execution-plan.json / input.json / outputs/ / attempts/ / acpx-state/ / sessions/ / events.ndjson / run.json。
- 7 种 stage：`agentTask` / `discover` / `fanout` / `reduce` / `decisionGate` / `gate` / `loop`。
- role = agent + category(planning/implementation/validation/review/research/...) + mode(denyAll/readOnly/edit)；category 决定 output contract。
- 一套 condition DSL（gate 判定 / decisionGate 路由 / fanout lane 选择 / loop continueWhen 共用），source root：`input.* / outputs.* / item.* / loop.* / run.*`。
- 变量 = source + transform，`${var}` 插值。
- CLI 四组动词：Compose(validate/preview/save/generate) / Conduct(run/follow/monitor/resume) / Recover(recover/diagnose) / Catalogue(list/show)。Ink 三栏 TUI 监控。

## 2. 关键区别

| 维度 | acpus | botmux v3 |
|---|---|---|
| 流程怎么来 | 预先写好 spec，编译期定死 | LLM 现场 grill + architect 生成 |
| 节点 = 什么 | 一次 agent turn（单轮）+ 最多 1 次 repair，强结构化输出 | 一整段 `/goal` 自主多轮，跑到产出 manifest |
| 节点间传数据 | `outputs.<stage>.<字段>` 强类型 JSON，编排器聚合 | 写文件 + manifest，下游 inputs.json 拿绝对路径自己 Read |
| 控制流 | decisionGate 分支 / gate 终判 / loop 有界循环 / fanout(all\|oneOf) + 条件 DSL，丰富 | 纯 depends DAG + 人工 gate，无原生分支/循环 |
| 底座 | acpx(ACP 协议) 跑 agent，本地 CLI/TUI | 飞书 daemon + PTY 跑真 CLI + web 终端 |
| 恢复 | pid+generation fencing / heartbeat 60s stale / resume 细粒度策略 / diagnose-recover-resume 三动词 | journal+STATE / attempts 不可变 / waits 持久化 |
| 人在环 | CLI / Ink TUI | 飞书聊天 + 审批卡 |
| 并发控制 | stage-local `limits.maxConcurrency`（删了全局 budget），agent call 数只做 usage 记账不当调度预算 | 三层 cap（per-bot / per-cli / global） |

## 3. 值得借鉴（按价值排序）

1. **输出契约 Output Contract ⭐ 最该抄**。每节点按 role 推一个 Zod schema，descriptor 塞进 prompt，解析「最后一个平衡 JSON 块」，校验失败给**且仅给 1 次** schema-aware repair，还失败 = `blocked`。我们 manifest 只管「哪些文件存在」，不管「产出的结构化结果是什么」，下游只能整文件 slurp。加一层结构化结果契约 → gate/分支判断 + 下游绑定都可靠。关键纪律：契约只在 schema，禁藏在 prompt 文本里；parser 不做字段重命名/alias。

2. **blocked vs failed 两档终态 ⭐**。语义/契约失败 = `blocked`（可恢复、可 resume）；基础设施错 = `failed`。我们现在只有 fail，resume 语义模糊。分两档，恢复模型立刻清晰。gate verdict 同理：pass/pass_with_warnings 完成，blocked/failed/unknown 阻塞。

3. **worker fencing**。pid+generation 双重 fence + 10s heartbeat / 60s 判 stale + 单 worker 守卫；且把 stale recovery 和真 runtime failure 用不同 error code 严格分（`AGENT_STAGE_STALE_RECOVERY` / `FANOUT_ITEM_STALE_RECOVERY` vs runtime 失败码）。stale 触发还要等「最近心跳 / 起始时间 > stage timeout + 60s grace」。我们 ephemeral pool 踩过一堆时序坑（/goal 发太早、init/ready 死锁、完成检测），这套生命周期纪律正好治。

4. **受约束的控制流词汇 + 克制哲学**。故意只给 decisionGate（唯一分支）/ loop（唯一有界循环、禁任意环）/ 一个 root 一个 terminal gate + 统一 condition DSL。"既能表达分支循环、又不退化成无约束引擎"——正好当 architect 生成 DAG 的目标词汇，LLM 生成的图还能被静态分析。edit-mode fanout 强制后接 readOnly reduce 也是好约束。

5. **Fanout Core 纯内存模块边界**（ADR 0004）。fanout 语义（item/lane 展开、lane group 选择、聚合、skip/block 语义）抽成纯函数，不碰 IO/调度/并发/retry/事件；调度池另算。将来做 map/over-items 并行时照搬这个 pure-core 分层。

6. **观测严格只读**。monitor 视图只从 run.json 投影，**绝不**回放 events.ndjson 算状态（事件流只给 diagnose）。dashboard 接 journal 时照这条更快更稳。follow/monitor/diagnose 永不 mutate（syncRun startPending:false 是只读的）。

7. **能力缺口 roadmap 文档**本身就是现成 backlog：① 普通并行分支/汇合 ② 条件汇合（选中路由 join）③ route output alias（读「被选中分支的输出」）④ per-item subgraph / map pipeline ⑤ 原生 tool/MCP task 节点 ⑥ 自定义 program/command task 节点 ⑦ 动态 worklist 扩展。v3 同样缺这些——我们现在**所有节点都是 agent `/goal`，没有任何确定性节点**。

## 4. 战略信号（重点）

仓里 `docs/archive/dynamic-workflow-design.md` 状态 = **"superseded / 已废弃，被 runtime orchestrator refactor 取代"**。即他们试过 LLM-driven 动态流程，最后**主动退回**到「写死 spec → 编译 → 确定性跑」。

不是说 LLM-driven 错了，而是提醒：**价值在确定性、可校验、契约化的执行底座；LLM 留在 grill/architect 边界，边界之后越确定越好**。这跟 v3 架构其实兼容（grill/architect=LLM，runtime=确定性）。借鉴方向：往 runtime 层多压确定性——输出契约、blocked/failed、execution-plan 校验。

## 5. v3 反过来强于 acpus

- LLM 现场 grill→architect 从模糊目标生成流程（acpus 没有，且主动放弃）。
- 节点是完整 `/goal` 自主多轮，比 acpus 单轮+1repair 更能干。
- 飞书原生人在环（grill 对话、审批卡），acpus 只有 CLI/TUI。
- 复用真 CLI（claude/codex/seed）+ 每节点 live web 终端可视化。

## 6. 落地建议

优先级：**①输出契约 + ②blocked/failed 两档** 一起做（互相依赖，价值最高，改动集中在 contract.ts + runtime + manifest 校验）。其次 ③worker fencing（治 ephemeral pool 时序坑）。④受约束控制流（decisionGate/loop/condition DSL）作为 architect 词汇升级，是更大的 feature，单列。
