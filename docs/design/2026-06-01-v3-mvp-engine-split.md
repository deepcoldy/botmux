# v3 MVP 引擎 —— claude × codex 分工 + 接口契约

- 日期：2026-06-01
- 上游设计：`2026-06-01-next-gen-workflow-design.md`（v2，老滕已拍：A 方案先做引擎 / v0.2 不管 / v3 独立新功能）
- 目标：**端到端跑通一个 hand-written `dag.json`**，验证三件最不确定的事 —— ephemeral worker + 文件 IPC + 并发调度。grill/architect 自动化壳**本期不做**。
- 协作：claude-loopy（调度+持久化侧）× codex-loopy（执行+IPC 侧），共享同一 working tree。

## 0. 本期范围（= 设计稿 Q12 的 ✅ 部分）

✅ 做：`botmux-goal` skill + 注入；ephemeral worker pool（PtyBackend，1 worker 1 节点）+ 三层并发 cap；journal.ndjson + STATE + attempts/NNN 不可变 + LOCK；manifest contract；static `dag.json`（手写）；humanGate（v0.2 UI + v3 file wait）。

❌ 不做：grill-me 主控、architect 自动合成、dynamic expand、botmux-orchestrate 升级。

新代码放 **`src/workflows/v3/`**（跟 v0.2 的 `src/workflows/` 并行，不动 v0.2 一行）。

## 1. 模块清单（9 块）

| # | 模块 | 归属 | 文件（建议） |
|---|---|---|---|
| 0 | **共享契约**（runNode 类型 / Manifest 接口 / GoalInputs / BotSnapshot / GOAL_ENV 常量） | **claude 起草、两侧 import** | `v3/contract.ts` ✅已落盘 |
| 1 | dag.json schema + loader/validator | **claude** | `v3/dag.ts` ✅已落盘 |
| 2 | orchestrator（拓扑排序 + deps gating + 可调度集计算，纯函数） | **claude** | `v3/orchestrator.ts` ✅已落盘 |
| 3 | journal + STATE（append/物化/atomic rename/resume） | **claude** | `v3/journal.ts` `v3/state.ts` ✅已落盘 |
| 4 | runtime 主循环（调度 + 三层并发 cap + journal/STATE + 文件 IPC） | **claude** | `v3/runtime.ts` ✅已落盘，与 codex 真实 validator 联调通过（`test/v3-runtime.test.ts`）。LOCK/heartbeat 留给多 worker 抢占场景，MVP 单 daemon 暂不需要 |
| 5 | ephemeral worker pool（spawn 临时 worker 跑一个 goal，走完整 spawn 链路，跑完销毁） | **codex** | `v3/ephemeral-pool.ts` |
| 6 | goal-mode skill（`botmux-goal` SKILL.md + bootstrap prompt + `BOTMUX_GOAL_*` env + AskUserQuestion 硬拦 hook） | **codex** | `src/skills/botmux-goal/` |
| 7 | manifest contract（schema + 校验：path 越权 / kind 枚举 / sha256·bytes·mime / preview 限长） | **codex** | `v3/manifest.ts` |
| 8 | humanGate（waits/<id>.json 持久化 + journal event + 复用 v0.2 卡片 builder/handler） | **claude** | `v3/human-gate.ts` |
| 9 | CLI 入口 `botmux v3 run <dag.json>` | **claude** | `src/cli.ts` 加子命令 |

切分逻辑：claude 拿「调度/持久化/编排」一条内聚链（1/2/3/4/8/9），codex 拿「执行/IPC」一条内聚链（5/6/7）。接口窄、文件零重叠、能真并行。

## 2. 接口契约（两侧唯一对接点）—— codex round-1 收紧版，已落进 `v3/contract.ts`

> **类型真相在 `src/workflows/v3/contract.ts`**（claude 起草、两侧 import，禁止各自重定义）。下面是契约说明；签名以 contract.ts 为准。typecheck 已过。

### 2.1 runtime → ephemeral pool（`runNode`）

claude 侧负责：run start 冻结 `botSnapshot`、建节点/attempt 目录、写 goal 文件 + `inputs.json`、填 `GOAL_ENV`、算并发额度、决定「该跑节点 X 了」。然后调 codex 侧（codex round-1 加了 5 个字段，已采纳）：

```ts
type RunNode = (req: {
  runId: string;
  attemptId: string;           // 如 research/attempts/001，用于 sessionId/log 命名
  node: V3GoalNode;            // 已收窄到 goal 节点
  botSnapshot: BotSnapshot;    // run start 冻结、持久化；pool 不在执行期重读 bots.json
  runDir: string;
  attemptDir: string;
  inputsPath: string;
  outputDir: string;
  env: Record<string, string>; // 已含 GOAL_ENV 各键
  timeoutMs: number;
  cancelSignal?: AbortSignal;
  stdoutPath?: string;         // 默认 attemptDir/stdout.log
  stderrPath?: string;         // 默认 attemptDir/stderr.log
}) => Promise<{ status: 'ok' | 'fail'; manifestPath: string; sessionInfo?: WorkerSessionInfo }>;
```

- 并发 cap（global/perBot/perCli）在 runtime 这侧，pool 只管「起一个 worker 把这个节点跑完」。
- **结果判定 = 进程结束 + manifest validate**（codex point 4）：`runNode` 的 `status` 是进程级结果，最终节点成败由 runtime 拿 `manifestPath` 跑 validator 决定 —— **不套 v0.2 的 final_output JSON 语义**。
- **`botSnapshot` 冻结**（codex point 1）：claude 在 run start 把 bot 的 spawn 相关配置（cliId/cliPathOverride/model/workingDir/larkAppId）快照进 runDir，retry/restart 复现原配置，不受 bots.json 漂移影响。`larkAppSecret` **不进快照**（不把密钥写盘），pool spawn 时按 larkAppId 现读 —— 这点请 codex 确认能接受。

### 2.2 manifest schema（codex 定 validator / claude 消费），codex round-1 收紧

```ts
interface Manifest {
  schemaVersion: 1;
  status: 'ok' | 'fail';
  summary: string;             // 限长 4KB
  error?: { code: string; message: string; retryable?: boolean };
  files: Array<{
    name: string;
    path: string;              // 只接受相对 outputDir 的相对路径；validator canonicalize 后 isPathInside 校验
    kind: 'markdown'|'json'|'text'|'code'|'log'|'binary'|'directory';
    bytes: number;
    sha256: string;            // directory 约定 sha256=''
    mime: string;
    preview?: string;          // 限长 4KB
  }>;
}
```

不变式：`status:'ok'` → `files.length>=1` 且无 `error`；`status:'fail'` → `error` 必填、`files` 可空。

### 2.3 inputs.json（claude 写 / goal-mode 读，`GoalInputs`）

claude 把上游各节点 manifest 的 files 汇成下游 inputs，**path 由相对转绝对**（manifest 存相对、inputs 存绝对，下游直接 Read）：

```ts
interface GoalInputs {
  inputs: Array<{
    from: string;     // 上游 nodeId
    name: string;
    path: string;     // 绝对路径
    kind: ManifestFileKind;
    preview?: string;
  }>;
}
```

### 2.4 goal-mode env 契约（runtime 填 / `botmux-goal` skill 读）

固定 6 个键（codex point 3，已落进 `GOAL_ENV` 常量）：

| 键 | 含义 |
|---|---|
| `BOTMUX_GOAL_PATH` | goal 文本文件 |
| `BOTMUX_GOAL_INPUTS_PATH` | 本节点 `GoalInputs` JSON |
| `BOTMUX_GOAL_OUTPUT_DIR` | 唯一可写产物目录 |
| `BOTMUX_GOAL_MANIFEST_PATH` | worker 退出前必须写 manifest 到这 |
| `BOTMUX_GOAL_ATTEMPT_DIR` | 本 attempt 目录（logs/manifest/work 都在下面） |
| `BOTMUX_V3_GOAL` | `'1'`，标记 goal-mode 运行，worker 的 chat/card/ask 副作用静默（codex point 4） |

**goal-mode 交付（老滕 2026-06-01 指令后改定，as-built）**：用 **Claude Code / Codex 原生 `/goal` 命令**，不做其他 CLI 适配；v3 goal 节点只支持 `claude-code` + `codex`（`V3_SUPPORTED_CLIS`，runtime run-start 守卫）。
- ⚠️ 原生 `/goal` 语义是「设完成条件、持续干到满足」，**不**认识 `BOTMUX_GOAL_*`。所以 ephemeral-pool 不发裸 `/goal`，而是 `buildGoalCommand(req)`：把契约塞进 goal 内容当完成条件——「目标在 `$BOTMUX_GOAL_PATH`、inputs 在 `$BOTMUX_GOAL_INPUTS_PATH`、只写 `$BOTMUX_GOAL_OUTPUT_DIR`、完成条件=写 `$BOTMUX_GOAL_MANIFEST_PATH` 的 schemaVersion=1 manifest」。命令文案里的 env 名 / schemaVersion / kind 枚举都从 `contract.ts` 常量生成，不漂。
- worker init `prompt=''`，`ready` 后走 `raw_input` 发 `/goal <contract>`（原生 slash passthrough，不走普通聊天包装）。
- 这**反转了 v1 的 blocker #2**（原为兼容所有 CLI 才用 skill+bootstrap、绕开 slash）——收窄到只支持有 `/goal` 的两家后，该顾虑消失；`botmux-goal` skill 已移除。
- Codex CLI 的 `/goal` 语义未经权威确认，当前两家共用同一段 `/goal <contract>`；真机 dogfood 若 Codex 不认，再做 adapter-specific 命令内容 / commands installer（不在 MVP scope）。

## 3. dag.json schema（已落进 `v3/dag.ts`，validate + 拓扑 + 环检测齐活）

```jsonc
{
  "runId": "demo-001",                // 路径安全 [A-Za-z0-9._-]，用作 runDir 名
  "nodes": [
    {
      "id": "research",               // 唯一、路径安全（用作目录段）
      "type": "goal",                 // MVP 只跑 goal；type:"host" 当前 validate 直接 reject（执行器未落地）
      "goal": "调研 X，把结论写成 markdown",  // goal 节点必填非空
      "bot": "claude",                // 只支持 claude-code / codex 两家（V3_SUPPORTED_CLIS）；MVP dogfood 先 Claude
      "depends": [],
      "inputs": [],                   // [{ from:"<nodeId>" }]；每个 from 必须 ⊆ depends（只能读你依赖的节点产物）
      "timeoutSec": 600,              // 默认 600
      "humanGate": null               // 或 { "prompt": "审批文案" }
    },
    {
      "id": "summarize",
      "type": "goal",
      "goal": "读 research 的产物，写一页摘要",
      "bot": "claude",
      "depends": ["research"],
      "inputs": [{ "from": "research" }]
    }
  ]
}
```

validate 失败一次性吐全部问题（`DagValidationError`），不是只报第一条。环检测走 Kahn 拓扑（确定性 tie-break by id）。

## 4. 第一个 milestone（端到端最小闭环）

跑通这个 2 节点 dag：`research`（无依赖，写一个 .md）→ `summarize`（依赖 research，读它的 .md 写摘要）。
验收：journal.ndjson 有完整事件流、两节点 STATE=done、summarize 的 inputs.json 正确指到 research 的产物、attempts/001 现场完整。这条通了，并发/gate/retry 都是加法。

## 5. 协作约定（共享 working tree）

- 各改各文件（见 §1 文件列），零重叠；`src/workflows/v3/` 是新目录，互不踩。
- **别在共享 tree 上 `git stash` / `git reset --hard`**（会清掉对方的活）。
- 各自 `pnpm build` 自测自己模块；联调由 claude 串（拿 codex 的 runNode + manifest 接）。
- **类型真相在 `v3/contract.ts`**：codex 的 `manifest.ts` / `ephemeral-pool.ts` 从它 import `Manifest`/`RunNodeRequest`/`BotSnapshot`/`GoalInputs`/`GOAL_ENV`，别各自重定义。接口若要改，先改 contract.ts + 本 md + 群里吱一声，别闷头改签名。

## 6. 待 codex 确认

1. §1 分工你认领 5/6/7 这条线 OK 吗？
2. §2.1 `runNode` 签名 / §2.2 manifest schema 接得住吗？要加字段现在提。
3. ephemeral pool 走完整 spawn 链路（adapter config / bot snapshot / workingDir / skills 注入 / hook install）——这块你比我熟 worker 侧，有坑先喊。
