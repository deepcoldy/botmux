# Workflow（实验性）

一句话模糊目标 → 自动拷问澄清、编排 DAG、并发执行；跑通的流程可以存成 **Saved Workflow** 反复复用。run 存放在 `~/.botmux/v3-runs`，运行情况在 **Dashboard 的 v3 视图**看（每张飞书卡片都带「Web 详情」链接直达）。

> ⚠️ Workflow **默认关闭**。在 Dashboard 设置页打开「工作流功能」开关，或设置环境变量 `BOTMUX_WORKFLOW_ENABLED=true` 后才可用。关闭时即兴编排与 Saved Workflow 的运行/保存都会被拒绝，但进行中的 run 仍可用 `botmux workflow cancel / retry / grant` 管理。

## 即兴 workflow

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

architect 自动编排时能用上这些结构，所以你在 Gate-2 看到的流程可能不是简单的直线：

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
| `botmux workflow cancel <runId> [--reason <text>]` | 取消进行中的 run |

改主意：需求要改 → `botmux workflow revise-spec <runId>`（退回重新澄清，原 DAG 作废）；流程要改 → `botmux workflow revise-dag <runId>`（只重编流程）。

> 三个「续跑」入口不能混用：受阻节点用 `retry`、循环轮数耗尽用 `grant`；而「回溯额度耗尽」**只能点飞书卡片放行，没有对应 CLI 命令**。

### 节点交给群里的 Bot 执行（实验性，默认关闭）

默认情况下，每个节点由 daemon 起一个临时 CLI 进程执行，做完就销毁。Dashboard「全局设置 → 工作流」里紧挨「启用工作流功能」有一个实验性开关 **「节点交给群里的 Bot 执行」**，打开后：

- **只影响之后批准的 run**：Gate-2 批准（或 Saved Workflow 启动）时把执行方式写进 run 冻结，已经在跑的 run 按原方式跑完。
- **每个节点开一个节点话题**：主 Bot 在群里发一张节点卡作为新话题（不 @ 任何人），再在话题里发交接卡 @ 执行这个节点的 Bot（没指派时就是主 Bot 自己）。交接卡写明要做什么、完成标准、输入（上游产物会作为附件放进它的会话）、要交的产出、期限和交付命令；节点卡会随状态就地更新（交接中 / 进行中 / Bot 已停下未提交 / 已完成 / 已停下及原因 / 已取消）。
- **按结构化产物判定完成**：执行的 Bot 做完运行 `botmux report --dispatch-root <交接消息 id> --status completed --output <key>=<路径> --result-file result.json --content-file summary.md`，按节点契约校验通过才算完成；不通过会列出缺什么，补齐后在同一轮重新提交即可。做不了就 `--status blocked "原因"`，节点转受阻，在主话题发重试卡。单个文件 ≤4 MiB、一次合计 ≤8 MiB，更大的产物请把分支名或链接写进 result.json。
- **执行节点的会话只做这个节点**：它看不到工作流相关技能，也看不到把活再派给别的 Bot 的技能（`botmux-orchestrate`、`botmux-handoff`），用 `botmux skill show` 读取也会被拒绝。两种情况例外：在主话题交接时复用的已有会话（启动时已经加载了这些技能），以及技能注入方式设为「全局目录」的 CLI（技能文件在本机共享目录里，无法按会话区分）。
- **超时与取消**：节点超时（默认 30 分钟，从接单起算）转受阻并停掉执行 Bot 当前这一轮；取消工作流同样会停掉各节点当前这一轮，不关闭它们的会话。
- **何时仍用临时进程**：私聊发起的 run、没有话题根的 run，或本机关闭了「多话题协作」时，批准结果里会说明原因并照旧用临时进程。
- **批准前检查**：每个节点的执行 Bot 必须是本机配置的 Bot、已在本群、daemon 在线，并能和主 Bot 建立群内协作授权；普通群里它的回复模式不能是「整群一个会话」（chat / shared，节点话题会并进群会话）；节点不能声明目录型产出。不满足会拒绝批准并逐个列出原因。botmux 不会自动把 Bot 拉进群。此模式下暂不支持 `approve-dag --working-dir`（节点在执行 Bot 自己的工作目录里跑）。
- **主 Bot 离线时**：执行 Bot 照常提交，结果先暂存，主 Bot 上线后自动入账。
- **谁执行哪个节点**：澄清需求时说「这步让文档Bot 做」，会记成该节点的点名（`assignee`），编排时照用；没点名的节点由编排按群里当前可用的 Bot（在群、在线、CLI 支持）挑一个并写一句理由，拿不准就交给主 Bot。Gate-2 摘要逐个列出「节点 → 执行 Bot（CLI）：理由」，点名的 Bot 用不了（不在群、离线、找不到同名 Bot）会标 ⚠️。要改就退回改稿后改点名。
- **受阻卡上的「改派」**：节点受阻时，受阻卡多一个「改派」下拉框，列出本 run 批准时选定、现在仍可用的 Bot；只有发起人能确认改派，确认后节点以新 attempt 交给新 Bot。暂不支持改派给批准时没有的 Bot。

拿不准、或群里不希望多出节点话题和 Bot 之间的对话时，保持关闭。

#### 在飞书侧边栏看流程图

这种模式下的任务消息——节点卡、交接卡、执行 Bot 在节点话题里的回复卡和回报卡——签名行最右侧有一个「工作流 ›」按钮，主话题的进度卡里原来的「Web 详情（需登录）」也换成同一个按钮。点开在飞书侧边栏看这个 run 的实时流程图（竖排，每 2 秒刷新，点节点展开详情）。临时进程执行的 run 和普通会话的卡片没有这个按钮；Dashboard 地址确定不了时也不出按钮。

链接本身不带任何凭证，打开时按身份决定能看到什么：

- **Dashboard 管理员**：完整视图，和 Dashboard 详情页一样，含终端和日志入口。
- **本群当前成员**：精简视图，只有节点名、目标、负责 Bot、状态、耗时和落点链接；不含终端、日志、产物内容、参数值和错误详情。是否在群由主 Bot 实时核对，退群后最多一分钟内失去访问。
- **其他人**：无权查看。

群成员靠「飞书 H5 免登」确认身份，不另加开关：配了 H5 免登（`BOTMUX_DASHBOARD_FEISHU_H5_*`）时，不在免登名单里的成员也能打开，但只拿到「只能看工作流侧边栏」的会话，进不了 Dashboard 的其它页面。免登名单里的人在 Dashboard 里本来就看不到运行详情，侧边栏里同样按群成员给精简视图。

**没配 H5 免登时只有管理员能看**：侧边栏是独立的浏览器环境，带不过去 Dashboard 的登录态，所以这时按钮改为在浏览器里打开 Dashboard 的运行详情页（和原来进度卡上的「Web 详情」一样），用已有的 Dashboard 登录查看。

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

## 保存与复用（Saved Workflow）

即兴 workflow 跑通后，可以把它存成 Saved Workflow，之后带不同参数反复跑：

| 入口 | 作用 |
|------|------|
| 飞书 `/workflow save last [名称]` / CLI `botmux workflow save [last\|runId] [名称]` | 把最近一次（或指定 runId）的 run 存为 Saved Workflow |
| 飞书 `/workflow run <名称> [key=value ...]` / CLI `botmux workflow run <名称\|workflowId> [--param key=value ...]` | 运行 Saved Workflow |
| 飞书 `/workflow list` / CLI `botmux workflow list [--json]` | 列出已保存的 workflow |
| 飞书 `/workflow show <名称>` / CLI `botmux workflow show <名称\|workflowId>` | 查看定义 |

入参（params）：CLI 用 `--param key=value` 传标量，用 `--param-json key=<json>` 传 object / array（如 `--param-json tags='["urgent","cn"]'`）。params 适合传**业务变量**（chat id、模式开关、阈值），不要把整段任务指令通过 params 传——节点的任务定义应固化在 workflow 里。

## 旧版 v2 模板（已下线）

v2 模板 runtime 已下线：`/template run`、`botmux workflow ls / tail / resume / validate` 等命令都会直接报错。仍有旧 `~/.botmux/workflows/*.workflow.json` 定义或历史 run 的，用离线工具处理：

| 命令 | 说明 |
|------|------|
| `botmux template migrate-v3 [workflowId\|path ...] [--all]` | 默认 dry-run；加 `--commit` 把可转换的 v2 定义固化为 v3 Saved Workflow |
| `botmux template archive-runs [--commit] [--verify <archiveId\|path>]` | 扫描、归档或校验已终态的 v2 历史 run；不会执行 v2 workflow，也不直接删除历史数据 |

## 开发 / 自测：`botmux v3 run`

`botmux v3 run <dag.json> [--max-parallel <n>]` 在本地真实 ephemeral worker 池上跑一张**手写的** v3 dag.json，humanGate 走终端 y/N，**无飞书卡片**。仅用于开发 / 调试 v3 编排；正式跑即兴 workflow 请走飞书 `/workflow` + `start`。

> Workflow 是实验性能力，仍在演进。日常用法在飞书里 `/workflow <目标>` 即可；本页其余命令面向运维 / 排障与编排开发。
