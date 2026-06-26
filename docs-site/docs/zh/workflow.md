# Workflow（实验性）

botmux 有两套 workflow 引擎，共享 `botmux workflow` 命令前缀，但定位不同：

| 引擎 | 是什么 | 入口 | run 存放 |
|------|--------|------|----------|
| **v3 即兴 workflow**（LLM-driven，推荐） | 一句话模糊目标 → 自动拷问澄清、编排 DAG、并发执行 | 飞书 `/workflow <目标>` | `~/.botmux/v3-runs` |
| **v0.2 模板 workflow**（schema-driven） | 手写 / 生成可复用的 `workflow.json`，反复跑 | `/template run <id>` | `~/.botmux/workflow-runs` |

> ⚠️ 两套引擎的 run **不互通**：`botmux workflow ls / tail / show / resume / cancel` 只看 v0.2 模板 run；v3 即兴 workflow 的运行情况在 **Dashboard 的 v3 视图**看（每张飞书卡片都带「Web 详情」链接直达）。

## 即兴 workflow（v3，推荐）

### 怎么用

在飞书话题里直接说出你的目标，或显式发 `/workflow <目标>`（等价于 `/workflow new <目标>`）。bot 带你走一条龙，整个过程在当前话题里一问一答，你只需回答问题和点确认：

1. **拷问澄清（grill）**：bot 一次问一个问题，每个都给推荐默认答案。觉得够了随时说「用默认 / 别问了」。
2. **Gate-1 确认需求**：bot 给一份需求摘要（做哪几步、各自产出、验收标准、明确不做什么），你确认。
3. **自动编排 DAG**：系统把需求编译成一张可执行的依赖图。
4. **Gate-2 确认流程**：bot 讲清楚节点、依赖顺序、哪些节点执行期要停下等审批，你确认就开跑。
5. **并发执行**：节点按依赖顺序并发跑（默认最多 4 个并发），过程中按需在本话题弹卡片（见下）。

### 运行起来后会遇到什么（人机协作）

节点跑起来后，可能在本话题弹这几类卡片等你处理：

- **审批卡**：编排时标了审批的节点（如对外发送）干活**前**弹卡，你点「✅ 通过 / ❌ 拒绝」。可自定义选项、限定谁能批。
- **运行中提问**：节点干到一半若需要你拍板或补信息，会弹卡问你——选项题（点按钮）或填空题（输入框打字），你答完它带着答案重跑这步继续。
- **追加循环轮次**：返工循环（见下）跑满设定轮数仍没达标，弹卡问你「➕ 追加 1 轮」，不点就停在受阻。
- **准许回溯**：下游把上游打回重做的次数到上限时，弹卡问你「➕ 准许回溯 +1」。
- **节点重试**：节点因契约 / 语义问题受阻（blocked）时弹卡，你点「🔄 重试」以新一轮重跑。

> 这些卡片都持久化到磁盘，daemon 重启后仍在 / 会重发，不会因重启丢审批。

### workflow 能表达什么（节点能力）

architect 自动编排时（或你在 v0.2 模板里声明）能用上这些结构，所以你在 Gate-2 看到的流程可能不是简单的直线：

- **顺序依赖 + 并发**：无依赖的节点并行跑。
- **条件分支**：某节点产出结构化结果后，下游边按结果激活——只走命中的分支，没走的分支零成本跳过；多个上游可按「全部 / 任一 / 法定票数」汇合。
- **结构化返工循环（loop）**：把「改到验收通过」建模成一个循环节点（如 `code → test` 反复跑到测试通过），到设定上限会停下问你是否追加轮次。
- **自动返工（revisit）**：下游发现上游产物不行，可把上游连同其下游一起打回重做，并带上「为什么、哪里错」的反馈；有次数上限防死循环。

### 运行中介入（CLI）

除了点卡片，也能用命令驱动（`runId` 是贯穿全程的钥匙）：

| 命令 | 作用 |
|------|------|
| `botmux workflow start <runId>` | approve-dag 后交 daemon 开跑（带飞书审批卡） |
| `botmux workflow retry <runId> [--node <id>]` | 重跑受阻（blocked）节点 |
| `botmux workflow grant <runId> [--loop <id>]` | 给轮数耗尽的循环追加一轮 |

改主意：需求要改 → `botmux workflow revise-spec <runId>`（退回重新澄清，原 DAG 作废）；流程要改 → `botmux workflow revise-dag <runId>`（只重编流程）。

> 三个「续跑」入口不能混用：受阻节点用 `retry`、循环轮数耗尽用 `grant`；而「回溯额度耗尽」**只能点飞书卡片放行，没有对应 CLI 命令**。

### 限制

- 即兴 workflow 的节点目前只能用 **claude-code / codex / seed** 三种 CLI 的 bot；编排到其它 CLI 的 bot 会在启动时报错。
- `host` 节点（feishu-send 等不走 LLM 的确定性副作用节点）schema 里保留了，但目前未启用——一切产出由 `goal`（LLM）节点完成。
- `botmux workflow start` 才是带飞书审批卡的正式跑法；`botmux v3 run` 是开发态终端路径（见末节），没有审批卡。

### 底层状态机（进阶）

即兴 workflow 在底层是一串 `botmux workflow` 子命令推动的状态机——通常由 bot 自动调用，排障时也能手动驱动：

| 命令 | 状态流转 |
|------|----------|
| `botmux workflow new "<目标>"` | 建 run，返回 `runId` / `specPath` → `grilling` |
| `botmux workflow spec-finalize <runId>` | 校验 spec.md → `spec_ready` |
| `botmux workflow approve-spec <runId>` | Gate-1 通过 → `spec_approved` |
| `botmux workflow architect <runId>` | 编排并校验 DAG → `dag_ready` |
| `botmux workflow approve-dag <runId>` | Gate-2 通过 → `dag_approved` |
| `botmux workflow start <runId>` | 交 daemon 驱动开跑 |

## 可复用模板（v0.2）

反复要跑的固定流程，做成模板存起来复用：

- 用 `botmux-workflow-create` skill 把你的描述翻译成 `~/.botmux/workflows/<id>.workflow.json`（**绝对路径的全局位置**，不是当前目录的 `./workflows/`——CLI agent 与 daemon 的 cwd 不一定一致）。
- `botmux workflow validate <path>` 校验定义文件。
- 跑模板：飞书 `/template run <id> key=value`（daemon 真实执行），或 CLI `botmux workflow run <id> --param key=value`（**离线 stub，不起真实 worker，仅端到端冒烟测试**）。

入参（params）：CLI 用 `--param key=value` 传标量，用 `--param-json key=<json>` 传 object / array（如 `--param-json tags='["urgent","cn"]'`）；IM `/template run` 暂不支持 object / array 入参。params 适合传**业务变量**（chat id、模式开关、阈值），不要把整段任务指令通过 params 传——节点任务定义应写死在 `workflow.json` 里。

### 模板 run 的运维 & 调试命令

以下命令管的是 **v0.2 模板 run**（读写 `~/.botmux/workflow-runs`，可用 `BOTMUX_WORKFLOW_RUNS_DIR` 覆盖），**不需要 daemon 在线**，**看不到 v3 即兴 workflow 的 run**：

| 命令 | 说明 |
|------|------|
| `botmux workflow ls [--all] [--status ...] [--wide] [--json]` | 列出模板 run；默认仅未结束的 |
| `botmux workflow tail <runId> [--from N] [--follow] [--json]` | 打印事件简表；`--follow` 持续跟随 |
| `botmux workflow show <runId>` | replay 事件，打印 Snapshot 摘要 JSON |
| `botmux workflow resume <runId>` | 从磁盘 runDir 冷恢复（CLI 不 spawn 新 worker） |
| `botmux workflow cancel <runId> [--reason <text>]` | 写入 cancelRequested 并驱动 cancel recovery |

```bash
botmux workflow ls                         # 看哪些模板 run 在跑
botmux workflow tail wf-abc-123 --follow   # 跟一个 run 的事件流
botmux workflow resume wf-abc-123          # run 卡住/重启过 → 冷恢复
botmux workflow cancel wf-abc-123 --reason '依赖外部超时'
```

## 开发 / 自测：`botmux v3 run`

`botmux v3 run <dag.json> [--max-parallel <n>]` 在本地真实 ephemeral worker 池上跑一张**手写的** v3 dag.json，humanGate 走终端 y/N，**无飞书卡片**。仅用于开发 / 调试 v3 编排；正式跑即兴 workflow 请走飞书 `/workflow` + `start`。

> Workflow 是实验性能力，仍在演进。日常用法在飞书里 `/workflow <目标>` 即可；本页其余命令面向运维 / 排障与编排开发。
