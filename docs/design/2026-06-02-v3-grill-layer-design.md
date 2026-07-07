# v3 grill 层设计（grill-me 主控 → spec.md → architect 交接）

- 日期：2026-06-02
- 状态：**v2 定稿 — codex review 合入 + 用户 grill 完毕 LGTM（2026-06-02），进实现**
- 用户已拍：入口=skill（不污染 ~/.claude/skills，落私有 plugin）｜ 命名 B（/workflow run vs /workflow new）｜ grill 逐问(a) ｜ 进 grill 前确认句保留 ｜ 两道 gate 保留 ｜ spec=叙事+节点草图yaml + host parse
- 工作模式：md-first（本机 md 做讨论载体，不上飞书文档）
- 关联：`2026-06-01-next-gen-workflow-design.md`（v3 总设计，grill 在其 §2 / §4.1 Layer A / Q2 / Q10 / §7 已有方法论级定调）；execution runtime 已真机跑通（1/2 节点全绿）

## 0. 范围

只设计 **grill 这一层（Layer A）**。execution runtime（ephemeral worker + 文件 IPC + 调度）已建好。architect（Layer B）这里只定**边界与交接形态**，细节另开稿。

用户指令：「grill 这一层」+「和 codex-loopy 一起讨论搞」。本稿即讨论起点。

## 1. 核心洞察：grill 跟 execution 是两种生物

| | execution worker（已建） | grill |
|---|---|---|
| 形态 | 自主、无人值守 | **交互、人在环** |
| 寿命 | ephemeral，一节点一次性 | 一次需求澄清会话，多轮 |
| 在哪跑 | runtime fork 的临时进程 | **用户当前正聊的那个飞书话题 + bot** |
| IPC | 文件（manifest/inputs.json） | 飞书消息一来一回 |
| 终态 | 写 manifest 即完成 | 自评「够了」→ 写 spec.md |

**推论 1：grill 不该建在 ephemeral pool 上。** 它本质就是「现有 live-session（daemon 已经把每个话题路由到一个 CLI worker）+ 一个 grill 人格 / skill」。botmux 本来就是 chat 桥，grill 是最贴合这个原语的——bot 问一句、daemon 把用户飞书回复送回来、再问，直到 bot 判定够了写 spec.md。**不需要新 worker 模型。**

**推论 2：architect 反而像 execution。** 它读 spec.md、写 dag.json，自主、无人、读文件写文件——**正好是一个 goal-worker 任务**。所以 architect 可以直接复用我们刚建好的 v3 引擎（一个 ephemeral goal-worker，goal = "读 spec.md 按 DAG schema 合成 dag.json"），产物再走人类 review。

→ **三层里真正全新的交互机器只有 grill。** architect = 复用引擎 + 一个固定 goal + 强制人 review。这把要新建的面积压到最小。

## 2. grill 怎么跑（关键决策，每条带推荐答案）

### G1 运行形态 → live-session skill，不是新 worker 模式
grill 注入到用户**当前话题的活会话**里：一个 `botmux-grill` 人格（skill + bootstrap）。bot 进入 grill 模式后，按 grill-me 方法论一次问一个，用户在飞书答，多轮，直到够了写 spec.md。
- 理由：grill 是人在环交互，ephemeral pool（自主无人）模型套不上；live-session 路径 daemon 已有。
- 备选（否）：专门的 `botmux v3 grill` 交互进程——重造一套 chat 循环，没必要。

### G2 入口 / 触发 → 一个 v3 skill（天然 LLM 可触发，详见 §5.2 OQ-G）
入口做成 **skill**（不是写死命令）。botmux skill 自带「触发场景」描述，bot 读描述自主决定要不要用——所以一个 skill 天然给两条路：
- ① **显式**：用户打 `/workflow new <目标>`（或直接喊 skill）。
- ② **LLM 自主**：bot 读到"复合可拆解任务"的请求，自己触发 grill（用户不必知道命令）。这正是 v3「由 LLM 决策流程」想要的，且是 skill 机制免费给的（不需自造分类器）。
- 防过度触发：描述别太宽 + 真进 grill 前确认一句（见 OQ-G）。`botmux-orchestrate` 暂不动。

### G3 生命周期 / 状态机
```
START   用户给模糊需求 → grill 诞生一个 runId + 建 $RUN_DIR/<runId>/
LOOP    bot 问 1 个问题（带推荐默认值）
        ├─ 能从代码/文件查到的 → 自己 explore，不问（grill-me 规则 4）
        ├─ 用户答 → bot 更新 working spec（重写 spec.draft.md，落盘）
        └─ 自评「够了」没？（§G5 标准）没 → 继续 LOOP
TERM    够了 → 写 spec.md（结构化，§3）→ 给用户看摘要 + 请确认（gate-1）
HANDOFF 用户确认 → 触发 architect（goal-worker 读 spec.md 写 dag.json）
```

### G4 working spec 持久化 → 活在文件，daemon restart 可 resume
grill 每轮把当前理解重写进 `$RUN_DIR/<runId>/spec.draft.md`（+ 一个 `grill.state.json` 记进度：已答分支、待问队列）。
- 理由：grill 可能持续很久、用户中途跑路、daemon 可能重启。状态不能只在 bot 的对话上下文里（会丢）。落盘 → 重进话题能 resume「我们聊到哪了」。
- **runId 在 grill 开始时诞生**——grill 是一个 run 的出生点（spec.md 和后面的 dag.json 都落在同一个 `<runId>/`，对齐总设计 §4.3 布局）。

### G5 「够了」判定 → 5 件套 per prospective node（沿用 §7）
能为**每个**预想节点产出 `goal / inputs / expected outputs / acceptance criteria / risk gates` 五件套，否则继续问。bot 每轮自查这个 bar。
- 加一条**逃生阀**：用户可随时说「够了 / 用默认 / 别问了」强制收尾——防止过度拷问惹烦（R3）。收尾时 bot 用当前推荐默认填满缺口并在 spec.md 标注「未确认，用默认」。

## 3. spec.md 契约（grill 的产物 = architect 的输入）

划线原则：**grill 管 WHAT，architect 管 HOW。**
- grill：需求是什么 + **需求分解草图**（有哪些活、各自需要什么信息/产出什么、验收标准、不做什么、有哪些没定的）
- architect：正式 DAG（节点 id、**依赖边**、节点类型 goal/host、gate 落在哪、拓扑校验、防环）

**codex 关键收紧（v2）：草图是「需求分解草图」，不是「半 DAG」。** 字段保持 WHAT，**绝不提前画边**——所以没有 `inputs: [上游sketchId]`（那是 grill 偷偷画拓扑）。改用 `input_needs`（文本：本活需要哪些信息/产物），architect 负责把 `input_needs` 解析成正式 `depends`。用户在 grill 阶段就说清「报告依赖调研」也只写进 `input_needs` 文本，**不要求 grill 产出合法拓扑**。

spec.md 结构 = **人读叙事 + 可解析的节点草图 fenced yaml**（固定 7 字段）：

```markdown
# Spec: <一句话需求标题>   (runId: <id>)

## 需求
<用户到底想要什么，grill 收敛后的清晰陈述>

## 决策树
- Q: <决策点> → A: <结论>（拒绝的备选：<...>）

## 验收标准（整体）
- <可验证的成功条件>

## 非目标
- <明确不做的>

## 节点草图（architect 据此合成 dag.json）
```yaml
nodes:
  - sketchId: research
    goal: 调研 3 家竞品的定价与核心功能，写成 facts.md
    input_needs: []                      # 文本：需要哪些信息/产物（不是上游 id 列表）
    expected_outputs: [facts.md]         # 期望产物
    acceptance: 每家含定价档位+功能矩阵
    risk_gate: false                     # 执行期是否需人工审批（→ dag.json humanGate）
    unknowns: []                         # grill 没定/用默认/待 architect 决的点
  - sketchId: report
    goal: 基于调研产物写竞品分析报告 report.md
    input_needs: ["research 阶段产出的竞品事实"]   # 文本描述，architect 解析成 depends
    expected_outputs: [report.md]
    acceptance: 含结论与建议，引用事实
    risk_gate: true                      # 发出前要人看
    unknowns: ["报告目标读者是谁，暂按内部团队"]
```
```

- 固定 7 字段（codex）：`sketchId / goal / input_needs / expected_outputs / acceptance / risk_gate / unknowns`。
- **机器可读 + handoff 前必过 parse（codex 补 5）**：薄命令在 handoff 时从 spec.md 抽出这段 fenced yaml、parse + 字段校验，**parse 失败禁止 handoff**（退回让 grill 修）。校验通过后物化一份 canonical `spec.json` 供 architect 干净消费（architect 读 spec.json 拿结构 + spec.md 拿叙事上下文）。光靠 markdown 让 architect 自己读，后续做不了稳定校验/回放。

## 4. 边界与交接（grill → architect → runtime）

```
grill ──spec.md/spec.json──▶ [gate-1 确认 spec] ──▶ architect(goal-worker) ──dag.json──▶ host 跑 validateDag ──▶ [gate-2 review dag] ──▶ runtime
```

**4.1 architect = 复用 v3 引擎的单个 goal-worker，但强约束（codex 3）**
- goal 固定：「读 `spec.json`（结构）+ `spec.md`（叙事），按 v3 DAG schema（dag.ts）合成 dag.json：节点草图→正式节点、`input_needs`→`depends` 边、定节点类型(goal/host)、`risk_gate`→`humanGate`、防环」。
- **只读** spec.md/spec.json，**只写** `dag.json` + `architect-notes.md`（决策理由），**不得启动 runtime**、不得碰别的。
- **dag 校验不信 architect 自称 valid**：handoff 后由 **host 侧**跑 `validateDag(dag.json)`（dag.ts 已有的拓扑/环/字段校验）。architect 说"valid"不算数，host 校验过才算。校验失败 → 退回（重 architect 或回 grill 补 spec）。

**4.2 两道人 gate 保留，不合并（codex 4）** —— 它们防的是两类不同的风险：
- **gate-1 spec 确认**：「需求理解对不对」。grill 写完 spec → 给用户看摘要 → 用户确认才进 architect。
- **gate-2 dag review**：「LLM 有没有把需求编译错」。host validateDag 通过后 → 展示 dag 摘要 → 用户确认才 run。
- 合并的后果：architect 漂移直接变成自动执行风险（总设计 R1）。gate-2 MVP 可以朴素（展示 dag 摘要文本 + 确认即可，先不强求复杂卡片），但**必须存在**。

**4.3 三种 gate 别混淆**（本设计引入两道流程 gate + 沿用一种执行期 gate）：
| gate | 时机 | 防什么 | 持久化 |
|---|---|---|---|
| gate-1 spec 确认 | architect 之前 | 需求对不对 | grill.state.json status（§4.4） |
| gate-2 dag review | run 之前 | DAG 编译对不对 | grill.state.json status（§4.4） |
| 执行期 humanGate（risk_gate 节点） | runtime 跑到该节点 | 副作用要不要放行 | runtime `waits/<id>.json`+journal（总设计 §4.3/Q10） |

**4.4 host 控制器 + 生命周期 status（codex 6）**
grill→architect→run 这条流水线由一个 **host 侧控制器**驱动（薄命令的延伸，不是新 runtime）。状态机记在 `$RUN_DIR/<runId>/grill.state.json`：
```
status: grilling | spec_ready | spec_approved | architect_running | dag_ready | dag_approved
```
- daemon/session 重启后，控制器读 status 就知道该**继续问 / 等 spec 确认 / 跑 architect / 等 dag review**，**不靠聊天上下文猜**。
- `dag_approved` 是交接点：之后 runtime 接管，用它自己的 journal/STATE（execution 真相），grill.state.json 不再变。**两套状态各管一段，seam 在 dag_approved。**
- gate-1/gate-2 的"等待"就是 status 停在 `spec_ready`/`dag_ready`——用户在飞书确认的消息让控制器推进 status，**不需要 runtime 的 waits/ 文件**（那是执行期 humanGate 专用）。这跟「grill 不写 journal」（codex 2）一致。

## 5. OPEN QUESTIONS

### 5.1 已和 codex 收敛（v2 定稿，用户可推翻）
- **OQ-A 运行形态** → grill = live-session skill（非新 worker）。✓ codex 认
- **OQ-B spec 粒度** → 「需求分解草图」非「半 DAG」；7 字段；`input_needs` 文本不画边；机器可读 + handoff 前必过 parse。✓ codex 收紧
- **OQ-C grill 不进 runtime** → 纯 skill + 薄命令（建 run / 写 spec / handoff）；不写 journal、不进 scheduler。✓ codex 认
- **OQ-E architect = goal-worker** → 复用引擎，强约束（只读 spec、只写 dag.json+notes、不起 runtime）；host 侧 validateDag 不信自称。✓ codex 认 + 加约束
- **OQ-F gate 数** → 两道保留不合并（gate-1 需求对不对 / gate-2 编译对不对）。✓ codex 认

### 5.2 留给用户 grill 的
- **OQ-D run 出生点 / runId 命名**：grill 开始即诞生 runId+runDir。命名建议 `<slug>-<yymmdd-hhmm>`（slug 从需求一句话取）。grill 是普通 live 会话，不受 workflow 脚本里 Date.now 禁用限制，可正常取时间。用户认不？
- **OQ-G 触发入口 + 跟 v0.2 区分**【用户 2026-06-02 拍：入口=skill，命名走 B 默认】：v0.2 在飞书已有入口 `/workflow run <模板名>`（`botmux-workflow-create` 设计存模板 → 按名反复跑，节点写死 prompt）。v3 入口必须跟它区分清楚。
  - **✓ 锁：v3 入口 = 一个 botmux 内置 skill**（既能显式 `/workflow new` 打、也能 bot 读描述自主触发）。
  - **✓ 隔离确认（用户追问"会注册进 ~/.claude/skills 吗"）**：不会。botmux 给 claude 的 skill 全落 `~/.botmux/claude-plugin/skills/<name>/SKILL.md`（私有目录），靠 spawn 时 `--plugin-dir`(claude-code.ts:464, CLAUDE_PLUGIN_DIR=~/.botmux/claude-plugin) flag 挂载，**不碰 ~/.claude/skills**；另有 `removeGlobalBotmuxSkills` 清老版本误装。standalone claude/seed 不带 flag 加载不到；codex 根本没走磁盘 skill 安装；只有 gemini/cursor/opencode/mtr 因无 per-launch plugin 能力写进它们全局 skillsDir（既有妥协，非 v3 引入，且都不在 v3 执行支持集）。
  - **命名 B 默认（可推翻）**：`/workflow run <模板>`(v0.2不动) ｜ `/workflow new <目标>`(v3，名 new/auto/goal 待定)。备选 A 单开 `/goal`|`/plan` 彻底分家。
  - **本质区别**：v0.2 =「模板模式」（已知流程、反复跑、参数化）；v3 =「即兴模式」（模糊一次性目标、当场 grill+编排+跑一次、节点 /goal 自主）。
  - **claude 推荐 B（子命令区分，同一 /workflow 家族）**：`/workflow run <模板名>`（v0.2 不动）｜ `/workflow new <一句话目标>`（v3，子命令名 new/auto/goal 待定）。用户脑里一个 workflow 概念，run=老模板 / new=现场来。
  - 备选 A：v3 单开 `/goal`|`/plan <目标>`，彻底分家（更清晰、多记一词）。备选 C：裸 `/workflow <目标>` 默认 v3，`run <名>` 才 v0.2（省字、语义压两层）。
  - **入口本质是 skill，不是写死命令（用户 2026-06-02 关切「命令启动 LLM 还能触发吗」）**：botmux skill 自带「触发场景」描述，bot 读描述自主判断要不要用（botmux-schedule/workflow-create 已如此）。所以 v3 入口 skill 天然两条触发路径：① 用户显式打 `/workflow new <目标>`；② bot 读 skill 描述、识别到"复合可拆解任务"**自主触发 grill**——用户不用知道命令。→ 之前说的"不做意图识别"措辞不准，**纠正为：不另造自定义分类器，直接用 skill 描述自带的匹配（这就是 LLM 触发，免费可靠）**，贴合 v3「由 LLM 决策流程」内核。
  - **防过度触发（默认保留确认句）**：skill 描述别写太宽，否则普通求助（"看下这 bug"）也被卷进 grill。缓解 = 真进 grill 前 bot 先确认一句「我理解你想做一整套 workflow（先问几个问题再自动跑），对吗？」，确认才进。**默认保留这句**（用户未要求去掉；想更激进直接进可后调）。
  - `botmux-orchestrate` 暂不动。
- **OQ-H 异步飞书 grill UX**【用户 2026-06-02 拍：a 逐问】：锁定 grill-me 原法「一次只问一个问题」（不走"先甩完整 spec 挑刺"）。配套：允许用户批量回答（bot 自己拆对应）、working spec 落盘可 resume、逃生阀随时收尾（G5）。

## 6. grill 层 MVP scope（v2）

- ✅ `botmux-grill` skill + bootstrap（grill-me 方法论 + 5 件套 bar + 逃生阀）
- ✅ working spec 持久化（spec.draft.md + grill.state.json，可 resume）
- ✅ spec.md 契约（叙事 + 节点草图 fenced yaml 7 字段）+ handoff 前 host parse → canonical spec.json，parse 失败禁 handoff
- ✅ run birth（薄命令建 runDir + runId）+ host 控制器（status 状态机驱动 grill→architect→run）
- ✅ architect = 复用引擎的 goal-worker（强约束：只读 spec、只写 dag.json+architect-notes.md、不起 runtime）
- ✅ host 侧 `validateDag(dag.json)`（不信 architect 自称 valid）
- ✅ gate-1 spec 确认 + gate-2 dag review（**两道都做**；飞书消息层，先不强求复杂卡片）
- ❌ 主 bot 意图识别触发（先显式 skill）
- ❌ spec 版本 diff / 多人协作 grill
- ❌ gate-2 复杂审批卡片（先朴素文本摘要 + 确认，但 gate 本身必须在）

**实现拆分建议（待用户拍后细化）**：grill skill（人格+bootstrap，纯 prompt）｜ host 控制器（薄命令：run birth / spec parse+校验 / status 状态机 / 驱动 architect+validateDag+两道 gate / 末了 kick `botmux v3 run`）｜ architect goal（固定 goal 模板，复用引擎）。grill 侧 claude 起、host 控制器 claude×codex 分（沿用引擎那次的 owner 边界），architect goal 模板谁起待定。

## 7. 风险

- **GR1 用户飞书中途跑路** → working spec 落盘，重进话题 resume（G4）。
- **GR2 异步一问一答慢 / 用户批量回** → 允许批量答 + bot 拆解；逃生阀收尾。
- **GR3 grill 过度拷问惹烦** → 5 件套 bar 是上限不是下限，逃生阀 + 推荐默认随时可收。
- **GR4 节点草图过细 → architect 沦为格式转换 / 过粗 → architect 漂移**（R1 的变体）→ OQ-B 要 codex 一起校准草图粒度。
- **GR5 grill 跟 v0.2/普通 chat 抢同一个会话上下文** → grill 是显式进入/退出的模式，进入时 bot 切人格、退出（写完 spec）时还原。
