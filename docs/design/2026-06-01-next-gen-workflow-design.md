# 下一代 workflow：LLM-driven DAG + 文件系统 IPC（设计 brief）

- 日期：2026-06-01
- 状态：**v2 — codex review 已合入，待用户 grill**
- 工作模式：md-first（暂不上飞书文档，本机 md 做 codex review 载体）
- 关联：v0.2 schema-driven workflow（已发版 v2.36.0，PR #47）
- 评审：codex-loopy 已 review v1（5 条意见 + 逐 Q 投票 + §7 默认建议），结论见 §0.5

## 0. 用户原话（不改写）

> 现在打算在 botmux 上做下一代 workflow 不依托固定流程, 由 llm 来决策流程. 问题描述/需求澄清阶段用 grill-me（在 github 上找一下）这个 skill 的流程来做需求分析, 然后根据分析出来的任务拆解来设计工作流, 流程调度走 dag 的模式来实现并发执行, 然后每个 sub agent 执行任务都需要用/goal 命令来一步到位 然后 dag 流程中的上下文传递通过文件系统完成 写文件 透传文件地址到下一个流程这样 dag 流程的保证也通过 file 来处理

后续指示：

> 你和 codex-loopy 讨论一下 一会儿我来 review 有问题再找我

## 0.5 codex review 结论（已合入 v2）

codex 整体同意三层拆分（grill/spec → architect/dag → runtime）和「MVP 先跑 hand-written dag.json、先验证 ephemeral worker + 文件 IPC + 并发调度」。

**4 个 blocker（已钉进本 v2）：**

1. **journal + materialized STATE，不是「只有 mutable STATE」**。并发 / retry / humanGate / cancel / 失败根因都需要审计顺序。runDir 同时保留 append-only `journal.ndjson`（audit truth）+ `STATE`（materialized checkpoint，grep & 快速恢复）+ `LOCK`/heartbeat（抢占 & stale 检测）。完全 file-based，但不丢 v0.2 event-sourcing 的经验。→ 见 §4.3 / Q9
2. **goal-mode 不依赖「真实 slash command」能力**。不同 CLI 对 slash/skill 支持不一致。实现 = `botmux-goal` skill + 固定 bootstrap prompt + `BOTMUX_GOAL_*` env。产品上可以叫 `/goal`，实现上不要求 CLI 真认识 slash。→ 见 §4.2 / Q6
3. **retry 不删 `<nodeId>/` 重跑**。删目录丢审计 + debug 现场。改为 `<nodeId>/attempts/001/`、`002/` 不可变，`<nodeId>/STATE`（或 `current` 指针）指向当前 attempt，retry 新建 attempt、旧的保留。→ 见 §4.3 / Q9
4. **humanGate 必须持久化到 runDir，不能用 ask-broker 内存态**。ask-broker 适合 chat 临时 ask；workflow gate 是 runtime 语义，pending/resolved 必须落 `waits/<waitId>.json` + journal event，否则 daemon restart 丢审批。复用 Lark 卡片 builder/handler 的 UX，但持久化语义按 v3 file wait。→ 见 §4.3 / Q10

**逐 Q 投票（codex）：** Q1 并行✓ / Q2 spec.md✓（须含验收标准+非目标）/ Q3 static✓（expand 只 deferred 不半露出）/ Q4 保留 hostExecutor✓ / Q5 ephemeral pool✓（别复用 active session 模型）/ Q6 skill 注入✓（叫 goal-mode 不押注 slash）/ Q7 禁工具✓（写成 best-effort + hook 能力矩阵）/ Q8 manifest✓（schema 要更硬）/ Q9 → journal+checkpoint / Q10 gate✓（runtime 不让 LLM 增删 gate）/ Q12 MVP✓（humanGate 改为「复用 UI/handler + v3 file wait 持久化」）。

## 1. 设计意图（我的解读）

| 维度 | v0.2 现状 | 下一代设想 |
|---|---|---|
| DAG 来源 | 用户/skill 手写 `workflow.json`（schema-driven） | grill-me 拷问需求 → LLM 自动合成 DAG |
| 节点抽象 | `subagent` (bot + prompt) / `hostExecutor` | goal-mode 节点（`/goal` 语义，env 驱动）+ 保留 hostExecutor |
| IPC | `output.<path>` JSON + `$ref` / `${...}` 引用 | 节点写文件 → 路径透传给下游 → 下游 Read |
| 流程保证 | runtime journal + `attempts/<id>/sidecar.json` | **journal.ndjson（audit）+ STATE（checkpoint）+ LOCK，全 file-based** |
| 并发执行 | 拓扑排序 + deps gating（已支持） | 同左，但 worker pool 需支持「一个 bot 并发跑多 sub agent」+ 三层并发 cap |
| 人类介入 | `humanGate.stage="before"` + 飞书审批卡 | 保留 humanGate（grill 阶段决定哪些节点 gate），**pending/resolved 落 file** |

## 2. grill-me 方法论摘录（mattpocock/skills）

完整原文（短得很，全文照搬以免失真）：

> Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.
>
> Ask the questions one at a time.
>
> If a question can be answered by exploring the codebase, explore the codebase instead.

**操作含义：**
1. 一次问一个问题（不要 fan-out）
2. 每问必须给推荐答案（不是开放问"你想怎样"，是带 default 让用户改）
3. 决策树沿分支走，先父决策再子决策
4. 能从代码查到的不要问，直接 explore

**应用：** 我和 codex 把"下一代 workflow"的决策树画出来，每个分支给推荐答案，用户 review 时按分支顺序逐个推翻或确认。

**grill「够了」的判定标准（codex 建议，已采纳）：** 拷问到能为每个节点产出 `goal / inputs / expected outputs / acceptance criteria / risk gates` 五件套，否则继续问。

## 3. botmux 现有边界（已 Explore 摸过，证据见 §3.x）

### 3.1 workflow runtime（src/workflows/）

- `orchestrator.ts` (862 LOC) — 纯决策层：拓扑排序 + deps gating（`depsOk = node.depends.every(...)`）
- `runtime.ts` (962 LOC) — 边界层：dispatchGate / dispatchWork → 写 event log → invoke spawn / executor
- `definition.ts` (1250 LOC) — schema：subagent / hostExecutor 两种节点类型
- `output-binding.ts` — `<nodeId>.output.<path>` 字符串模板 + `$ref`
- `blob.ts` — output 落盘到 `.botmux/workflows/<id>/attempts/<attemptId>/sidecar.json`

合计核心 ~3100 LOC，可读性不错，不是要全部推翻。**v0.2 已有 event log + attempts/<id>/ 落盘**，这正是 codex 说的「别丢 event-sourcing 经验」的来源——v3 的 journal+attempts 是它的演进，不是另起炉灶。

### 3.2 worker pool（src/core/worker-pool.ts）

- `forkWorker(ds, prompt)`：1 worker = 1 PTY/tmux session = 1 CLI 进程
- `ds.worker` 是单个 ChildProcess —— **1 个 bot 不能并发跑多个 sub agent**（这是下一代的关键阻塞点）
- 后端可选 TmuxBackend（常驻）或 PtyBackend（短命）
- spawn 一个 worker 不只是开进程：要走 **adapter config 解析 / bot snapshot / workingDir / skills plugin 注入 / hook install** 这一整套链路（codex 提醒，v3 ephemeral worker 不能省这条链）。

### 3.3 `/goal` 命令现状

**仓库内、用户级 skills 目录都没有 `/goal`**（已 grep）。这是要新建的抽象，不是复用已有命令。codex 关键提醒：**不要把它实现成依赖 CLI 真认识 slash command**——不同 CLI（Claude / Codex / Gemini / OpenCode / Antigravity）对 slash/skill 支持不一致。落地为 skill + bootstrap prompt + env（见 §4.2）。

### 3.4 botmux-orchestrate skill

是个 skill（教主 bot 把项目拆给多话题/多 bot 并行干活，飞书话题级编排），**不是 workflow runtime**。下一代 v3 如果落地，botmux-orchestrate 可能升级为「主控调用 v3 runtime 的入口」，不是替代关系。

## 4. 推荐架构（codex review 后 v2）

> Follow-up design: structured rework loops are intentionally modeled as a
> composite loop node while the outer workflow remains a DAG. See
> `docs/design/2026-06-06-v3-structured-loop-design.md`.

### 4.1 三层分工

```
┌─────────────────────────────────────────────────────────────┐
│ Layer A: grill-me 主控 bot                                  │
│   - 跟用户对话拷问需求                                       │
│   - 产出 spec.md（需求树 + 决策结论 + 验收标准 + 非目标）     │
└──────────────────────┬──────────────────────────────────────┘
                       │ spec.md
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer B: architect bot（可以是同一个 bot 换角色）            │
│   - 读 spec.md 合成 dag.json（节点 / 边 / humanGate 标记）  │
│   - 用户 review dag.json → 批准 / 重 grill                   │
└──────────────────────┬──────────────────────────────────────┘
                       │ dag.json
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer C: v3 runtime（并行于 v0.2 runtime）                  │
│   - 加载 dag.json → 拓扑排序 → 并发 dispatch（三层 cap）     │
│   - 每个节点 spawn ephemeral worker → goal-mode 跑单个 goal │
│   - 节点 work dir = $RUN_DIR/<runId>/<nodeId>/attempts/NNN/ │
│   - journal.ndjson（audit）+ STATE（checkpoint）+ LOCK      │
│   - manifest.json 声明节点产出文件列表 + summary             │
└─────────────────────────────────────────────────────────────┘
```

> **spec.md 必含**（codex Q2）：决策树 + 每分支结论 + 拒绝的备选 + **验收标准（acceptance criteria）** + **非目标（non-goals）**。缺这两块 architect 拆 DAG 会飘。

### 4.2 goal-mode（原 `/goal`）—— skill + bootstrap + env，不依赖 slash command

**实现形态（codex blocker #2）：** 一个 `botmux-goal` skill（沿用 `botmux-send` 等现成 skill 的 `SkillsDir` 注入路径）+ 一段固定 bootstrap prompt + 三个 env。产品上对外仍可叫 `/goal`，但 runtime 不要求 CLI 真识别 slash。

```
ephemeral worker 启动时 botmux 注入：
  env:
    BOTMUX_GOAL_PATH         → 本节点 goal 文本文件（单句 goal）
    BOTMUX_GOAL_INPUTS_PATH  → 上游产出解析后的 inputs.json
    BOTMUX_GOAL_OUTPUT_DIR   → 本节点 outputDir（写文件只能写这里）
  bootstrap prompt（固定模板，spawn 时作为首条 prompt）：
    "你这次启动只为完成一个 goal。读 $BOTMUX_GOAL_PATH 拿目标，
     读 $BOTMUX_GOAL_INPUTS_PATH 拿上游产出路径表，产物只写进
     $BOTMUX_GOAL_OUTPUT_DIR，结束前必须写 manifest.json。
     禁止 AskUserQuestion / TodoWrite（best-effort，见 Q7）。"

执行约束：
  - 严格 1 节点 = 1 goal（不支持 goal list，§7）
  - 允许 Read / Write / Edit / Bash / Grep / Glob + spawn 子 Agent（Task）
  - 必须在 outputDir 下产出 manifest.json + 至少 1 个产出文件

output（manifest.json，schema 见 Q8）:
  { status, summary, files: [{name, path, kind, bytes, sha256, mime, preview?}] }
```

### 4.3 文件系统布局（v2，codex blocker #1/#3/#4 合入）

```
$RUN_DIR/<runId>/
  spec.md                   ← Layer A 产出
  dag.json                  ← Layer B 产出
  journal.ndjson            ← append-only 事件流（audit truth；并发/retry/gate/cancel/失败根因都记）
  STATE                     ← 整体 run 状态（materialized checkpoint，atomic rename）
  waits/<waitId>.json       ← humanGate pending/resolved（持久化，daemon restart 不丢）
  <nodeId>/
    STATE                   ← 节点状态（pending/running/done/failed），指向 current attempt
    LOCK                    ← 抢占锁（O_CREAT|O_EXCL）+ heartbeat（stale 检测）
    inputs.json             ← runtime 写入：本节点 inputs 解析后的路径表
    attempts/
      001/                  ← 不可变：retry 新建 002/，旧 attempt 全保留
        manifest.json       ← 该 attempt 的 goal-mode 产出
        work/               ← 该 attempt 的 outputDir（任意文件）
        stdout.log
        stderr.log
      002/
        ...
```

**两层真相（codex blocker #1）：**
- `journal.ndjson` = source of audit truth（append-only，能重放出任意时刻状态）
- `STATE` / `<nodeId>/STATE` = materialized checkpoint（从 journal 物化出来，grep 友好 + daemon 重启快速恢复，不用重放整条 journal）

**retry = 新 attempt（codex blocker #3）：** 不删目录。`<nodeId>/STATE` 指向 `attempts/NNN/`，retry 时 `attempts/002/` 起，旧 attempt 保留供 debug / 审计。

**humanGate 持久化（codex blocker #4）：** gate 触发写 `waits/<waitId>.json`（pending）+ journal event；用户在 Lark 卡片点批准 → 更新该文件（resolved）+ journal event。卡片 UI 复用 v0.2 的 builder/handler，但 pending/resolved 真相在 file，不在 ask-broker 内存。

## 5. OPEN QUESTIONS（grill-me 决策树）—— 每题带 [codex 投票] + v2 推荐答案

按依赖排序，用户逐个 review：

### Q1（根节点）：定位 — 替代还是并行？ [codex: 同意并行]

- **v2 推荐：并行**。v0.2 留给「流程已知、可重复跑」（周报、固定 ETL），v3 用于「探索性、流程不确定」（一次性研究、复杂需求拆解）。两套 runtime 共存，CLI 入口区分（`botmux workflow run` vs `botmux v3 run`）。
- codex：**不建议现在就承诺下线 v0.2**，已发版用户会受伤。

### Q2：grill 阶段产物形态 [codex: 同意 spec.md，须含验收标准+非目标]

- **v2 推荐：** `spec.md`（人类可读 markdown，含决策树 + 每分支结论 + 拒绝的备选 + **验收标准** + **非目标**）。不直接产 DAG，让 architect 阶段翻译，给用户一次 review 机会。
- 备选（已否）：grill 完直接产 dag.json —— 一次合成 spec+DAG 容错差。

### Q3：DAG 静态还是动态 [codex: 同意 static，expand 只 deferred]

- **v2 推荐：起步 static**。MVP dag.json 一次生成跑完。`expand` 能力**只在文档里留 deferred 设计**，**MVP schema 不半露出**（codex 明确：别在 schema 里露半截，免得 LLM 试探）。
- 备选（已否）：fully dynamic —— 太复杂、易死循环。

### Q4：节点抽象 — goal-mode 唯一还是 + hostExecutor [codex: 同意保留 hostExecutor]

- **v2 推荐：保留 hostExecutor**。goal-mode 用于 LLM 节点；hostExecutor 用于副作用确定的操作（feishu-send / botmux-schedule / base write）。architect 阶段决定每个节点类型。
- codex：副作用 API 不该绕 LLM（省 token + 降不确定性）。

### Q5：worker pool 并发模型 [codex: 同意 ephemeral pool，别复用 active session 模型]

- **v2 推荐：v3 单独搞 ephemeral worker pool**。runtime 拿到可调度节点列表后按需 fork 临时 worker（PtyBackend，节点跑完即销毁）。每个 worker 1 节点 1 次性。
- **不复用 core worker-pool 的 active session 模型**（codex），但 **ephemeral worker 仍要走完整 spawn 链路**：adapter config / bot snapshot / workingDir / skills plugin 注入 / hook install。「bot 身份只是 env」说轻了。
- **三层并发 cap（codex 新增，已采纳）：** `globalConcurrency` + `perBotConcurrency` + `perCliConcurrency`，默认保守：**global=4、perBot=1~2**，可配。
- 备选（已否）：复用 ds.worker（破坏 v0.2）/ 1 worker 跑多节点（state 管理大坑）。

### Q6：goal-mode 怎么注入到 sub agent [codex: 同意 skill，命名 goal-mode 不押注 slash]

- **v2 推荐：`botmux-goal` skill + bootstrap prompt + `BOTMUX_GOAL_*` env**（见 §4.2）。沿用现成 skill 的 `SkillsDir` 注入路径。**不依赖 CLI 真认识 slash command**。
- 备选（已否）：CLI flag —— 不通用，每个 CLI 都要改。

### Q7：goal-mode 执行约束（一步到位）[codex: 方向同意，写成 best-effort + hook 能力矩阵]

- **v2 推荐：**
  - 禁 `AskUserQuestion`、`TodoWrite` —— 但**实现是 best-effort，按 CLI hook 能力分级**（codex 关键修正）：
    - **Claude Code**：`PreToolUse` hook 可**硬拦**（拦下直接短路返回错误，并把上下文 dump 进 manifest summary）
    - **其它 CLI**：没有等价硬拦能力 → 只能靠 **bootstrap instruction（软约束）+ 超时兜底**
  - 允许 `Read / Write / Edit / Bash / Grep / Glob` + spawn 子 Agent（Task）—— 节点内部 fan-out 跟 DAG 并发是两个 layer
  - 时间上限：默认 10 分钟（dag.json 节点级可覆盖）
- **能力矩阵要写进设计**：哪个 CLI 能硬拦哪些工具，一目了然，别假设所有 CLI 都能强制。

### Q8：文件 IPC 的 contract [codex: 同意，schema 要更硬]

- **v2 推荐：上游写 manifest.json，schema 收紧（codex）：**
  ```
  {
    status: 'ok' | 'fail',
    summary: string,
    files: [{
      name:    string,
      path:    string,    // 必须相对 outputDir，或被 runtime canonicalize 后校验在 outputDir 内（防越权写）
      kind:    'markdown'|'json'|'text'|'code'|'log'|'binary'|'directory',  // 枚举，未知 → binary 或 validate reject
      bytes:   number,
      sha256:  string,
      mime:    string,
      preview?: string    // 可选人类可读摘要，runtime 限长（防 context bloat）
    }]
  }
  ```
- runtime 把上游 manifest 解析后写到下游 `inputs.json`；下游经 `BOTMUX_GOAL_INPUTS_PATH` Read。
- **核心：path 是契约**，不传内容；preview 限长，给下游判断要不要 Read 全文。

### Q9：DAG 流程保证 — 怎么用文件实现 [codex: 改成 journal + checkpoint]

- **v2 推荐（codex blocker #1/#3）：**
  1. **审计真相**：`journal.ndjson` append-only，记 dispatch/start/done/fail/gate-pending/gate-resolved/cancel/retry 等所有事件
  2. **materialized 状态**：`STATE` / `<nodeId>/STATE`，从 journal 物化（grep 友好、daemon 重启快速恢复，不用重放整条 journal）
  3. **idempotency / retry**：**不删目录**，新建 `attempts/NNN/`（不可变），`STATE` 指向 current attempt
  4. **lock**：`<nodeId>/LOCK`（O_CREAT|O_EXCL）+ heartbeat，抢占 + stale worker 检测
  5. **完成 barrier**：调度器看 deps 节点 STATE=done 才放下一个
- **跟 v0.2 区别：** v0.2 已有 event log + sidecar，v3 把它演进成 journal（audit）+ STATE（checkpoint）双层，**不是丢掉 event-sourcing 改用纯 mutable STATE**。

### Q10：humanGate 怎么塞进 LLM-DAG [codex: grill 决定 gate ✓，runtime 不让 LLM 增删 gate]

- **v2 推荐：grill 阶段决定哪些节点要 gate**（写 spec.md），architect 翻译成 dag.json `humanGate: {prompt}`。
- runtime 看到 humanGate → 写 `waits/<waitId>.json`（pending）+ journal event → 发 Lark 审批卡（复用 v0.2 builder/handler UX）→ 用户点批准 → 更新 file（resolved）+ journal event。**持久化语义按 v3 file wait，不靠 ask-broker 内存**（codex blocker #4）。
- **runtime 执行期不让 LLM 自己新增/跳过 gate**（codex）—— gate 集合在 grill/architect 阶段冻结。

### Q11：v3 跟 botmux-orchestrate skill 关系 [未单独投票，沿用 v1]

- **推荐：botmux-orchestrate 升级为「v3 入口 skill」**。skill 内容变成「告诉主 bot 怎么调用 grill-me + v3 runtime」，底下的多话题分发可选保留（只在「需要多人协作」场景必要，v3 自己有并发）。
- 注：这是 post-MVP，MVP 不动 orchestrate（见 Q12）。

### Q12（边界）：MVP scope [codex: 同意，humanGate 改为「复用 UI/handler + v3 file wait」]

- **v2 推荐 MVP：**
  - ✅ `botmux-goal` skill 定义 + `SkillsDir` 注入 + bootstrap + env
  - ✅ ephemeral worker pool（PtyBackend，1 worker 1 节点，走完整 spawn 链路）+ 三层并发 cap
  - ✅ journal.ndjson + STATE checkpoint + attempts/NNN 不可变 + LOCK
  - ✅ manifest.json contract（收紧 schema）
  - ✅ static DAG（dag.json 手写，先不做自动合成）
  - ✅ humanGate：**复用 v0.2 UI/handler，但持久化按 v3 file wait**（codex 修正，不是直接复用 ask-broker 内存）
  - ❌ grill-me 主控（先用 user 直接写 spec.md 验证 runtime）
  - ❌ architect 自动合成（先验证 hand-written dag.json）
  - ❌ dynamic DAG expand（schema 都不露出）
  - ❌ botmux-orchestrate 升级
- **理由：** 验证「LLM-driven 节点 + 文件 IPC + 并发调度」这三件最不确定的事，再加自动化壳。

## 6. 跟 codex 协作的议题（已闭环，结论见 §0.5 / §5）

1. ~~架构方向（§4）三层 vs 两层~~ → codex 同意三层
2. ~~goal-mode 约束（Q6/Q7）~~ → 改成 skill+env+bootstrap，禁工具写成 best-effort + hook 能力矩阵
3. ~~worker pool 改造（Q5）~~ → ephemeral pool（别复用 active session），补全 spawn 链路 + 三层 cap
4. ~~file IPC contract（Q8/Q9）~~ → manifest schema 收紧；state 改 journal+checkpoint
5. ~~MVP scope（Q12）~~ → 共识达成，humanGate 持久化语义修正

## 7. §7 待答问题 —— codex 默认建议（已采纳为 v2 推荐，待用户 grill 拍板）

- [x] **goal-mode 输入不支持 list**，严格 1 节点 = 1 goal。
- [x] **DAG 跑中途**：MVP 只支持 **cancel / pause-on-gate / retry-node**，不支持用户改 DAG 拓扑。
- [x] **混用多 CLI 后端**：schema 上允许混用，但 **MVP dogfood 先只跑 Claude/CoCo 一种**，避免兼容矩阵爆炸。
- [x] **manifest `kind` 枚举**：`markdown | json | text | code | log | binary | directory`，未知 → `binary` 或 validate reject，**不允许自由字符串**。
- [x] **失败传播**：默认 **fail-fast**；后续再加 `optional: true` / `continueOnFailure`。
- [x] **grill「够了」标准**：能产出节点级 `goal / inputs / expected outputs / acceptance criteria / risk gates`，否则继续问。

> 以上为 codex 默认建议、claude 认可。用户 grill 时可逐条推翻。

## 8. 风险

- **R1：LLM 合成 DAG 不可靠**。Architect 产物质量决定一切；拆错则并发全是浪费。**缓解：** Layer B 后强制人类 review；spec.md 是可改的中间产物。
- **R2：file IPC debug 难追**。grep 不到调用链——但 v2 有 journal.ndjson 当 audit truth + attempts/NNN 保留现场，后续配 `botmux v3 trace <runId>` 重放。
- **R3：worker fan-out 资源占用**。三层并发 cap（global=4 / perBot=1~2 / perCli）控住。
- **R4：现有 v0.2 用户迁移成本**。并行架构规避，长期维护两套是负担（已知，不在 MVP 解）。
- **R5（codex 引申）：禁工具能力不均**。非 Claude CLI 没法硬拦 AskUserQuestion，只能软约束+超时——能力矩阵要写清，别假设强一致。

---

## 附录 A：现有 v0.2 文件 IPC 实现参考

`src/workflows/output-binding.ts`：

```
{ "$ref": "<nodeId>.output.<path>" }
"prompt": "基于天气 ${fetchWeather.output.summary} 出行建议"
```

v3 的 file-path 透传跟这个完全不一样——v0.2 引用是 JSON 字段，v3 是文件路径。v3 不需要 binding parser，但需要 manifest.json schema validator（含 path canonicalize 越权校验 + kind 枚举校验）。

## 附录 B：v1 → v2 变更摘要

| # | v1 | v2（codex review 后） |
|---|---|---|
| 状态保证 | 只有 mutable STATE 文件 | journal.ndjson（audit）+ STATE（checkpoint）双层 |
| `/goal` | 暗示像 slash command | `botmux-goal` skill + bootstrap + `BOTMUX_GOAL_*` env，不依赖 slash |
| retry | 删 `<nodeId>/` 重跑 | `attempts/NNN/` 不可变，新建 attempt，旧的保留 |
| humanGate | 复用 ask-broker | 落 `waits/<waitId>.json` + journal，UI 复用、持久化按 file wait |
| worker pool | 「bot 身份只是 env」 | 补全 spawn 链路（adapter/snapshot/skills/hook）+ 三层并发 cap |
| 禁工具 | 一刀切禁 | best-effort + hook 能力矩阵（Claude 硬拦 / 其它软约束） |
| manifest | name/path/kind/preview | + bytes/sha256/mime；path 越权校验；kind 枚举；preview 限长 |
| spec.md | 决策树+结论 | + 验收标准 + 非目标 |
| §7 | 6 条待答 | codex 默认建议全部填入，待用户拍板 |
