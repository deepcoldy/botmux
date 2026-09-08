# JS as runtime：botmux 原生多 agent 编排设计（第七稿）

> 状态：第七稿，回应了第六轮 review 的 3 项 P1 与 2 项 P2（对照表见 §14；前五轮见 §15）。第七轮 review 结论：无阻塞 M1 的新问题，进入实现；唯一提醒（`RLIMIT_CPU` 须设有限硬限制）已并入 §9。动词/模块名占位 `flow`。
> 本文自包含；相关证据在附录。

## 0. 给 reviewer 的说明

**背景。** v3 workflow 被反馈难用且会自动触发；围绕 acpus 的 spike 已用真 CLI 跑通 PTY worker 与飞书卡片链路（附录 C），但 acpus 引擎 56k 行 Effect 代码砍不动（附录 A），作者本人也认为「js as runtime 就够了」。另一份分析 Claude Code Workflow 工具的文档给出了纯控制平面 + 内容寻址 journal 的设计核心与失败静默数据（附录 B）。

**六轮 review 已确认：** JS 控制流、PTY 执行层、只显式触发；`flow` 占位名、`.mjs`、合并进度卡、子 agent 不成为 DaemonSession；三档会话恢复；`uncertain` 默认暂停；runner 单独裁决信号且中断期间拒绝提交；M1 范围；显式分支 ctx 的位置设计；`paused` 下 runner 常驻；`send.intent` 的提交顺序；跨代次继承历史；追加即核对解决意图被丢弃；缓存按请求即时返回；`contained` 收窄到命名空间边界；共享元数据与容器操作纳入所有权核对。

**第六轮 review 的结论：** 所有权核对的方向成立；静止协议的前提不成立，槽位回收与锁超时处理各有一处错误，文档里两个锁路径实际是两把锁。本稿改动：

- **撤回 `quiescent` 协议**：`vm` 受限 global 证明不了「激活只有两种来源」（`Atomics.waitAsync` 用纯内建就能自主唤醒；ctx 宿主函数经 `constructor` 可取回宿主 API；Node 官方声明 `vm` 不是安全隔离）。改为**只用 runner 自己掌握的事实**：在途 attempt 数、外部等待数、脚本是否返回。走表 ⇔ 有在途 attempt，或既无外部等待又未返回；无外部等待、无在途 attempt、又未返回超过 60 秒 → `script_stalled`（覆盖死循环、`await new Promise(() => {})` 与只自我唤醒不调 ctx 的脚本）；纯计算的上限改由 **CPU 预算**承担：runner 采样 script host CPU 时间（`maxScriptCpuMs`），内核 `RLIMIT_CPU` 兜底。`vm` 受限 global 降为卫生措施，另删 `SharedArrayBuffer`/`Atomics`/`FinalizationRegistry`/`WeakRef`（§9、§10）
- **槽位释放只认容器为空**：条目关联 `runId/gen/container`；holder 死亡只把条目置为 `pending_reclaim`，由该 run 的下一任 runner 或 daemon 清扫器确认容器子树为空后才释放（§9）
- **锁持有者假死按同一锁实例的连续占有计时**：以锁文件 inode + 持有者 pid/出生身份识别实例，实例或持有者变化即重置，发信号前重新核验，杀死并确认退出后交给 `withFileLock` 陈旧回收；「接管最多等 60 秒」改为「连续占有 60 秒到期启动回收」（§6.2）
- **锁 target 唯一**：`withFileLock` 自动追加 `.lock`，统一以 `run.lease` 为 target（实际锁文件 `run.lease.lock`），封装唯一的所有权入口 `withRunOwnership`（§6.2、§13）

**本稿请重点 review：** §9 三条 runner 侧事实是否足以定义走表/停表/失速，CPU 预算与 `RLIMIT_CPU` 的取值；§9 槽位 `pending_reclaim` 与 daemon 清扫器回收容器是否与 run 的所有权协议冲突；§6.2 锁实例的识别方式（inode + 持有者 payload）是否有误判。

**代码指针（worktree `.claude/worktrees/acpus-pty-worker`，未提交）：** 复用 `src/acpus/pty-turn-runner.ts`、`worker-evidence.ts`、`cli-quirks.ts`、`output-contract.ts`、`src/utils/claude-folder-trust.ts`、`src/im/lark/acpus-run-card.ts`、`acpus-card-handler.ts`、`src/acpus/run-registry.ts`；删除 `src/acpus/{worker-protocol,hook-payload,hook-client,daemon-hook-route,acpus-cli,acpus-config}.ts`、`src/cli/acpus.ts`，acpus fork 放弃。借用 `src/utils/file-lock.ts`（`withFileLock(path, fn, {maxWaitMs, minStaleAgeMs})`，**非重入**，超时抛 `FileLockTimeoutError`）、`src/utils/process-identity.ts`（`readProcessStartIdentity`、`readLinuxBootIdentity`）、`src/core/session-discovery.ts`（`findLaunchedCliPid`、`getChildPids`）、`src/adapters/backend/sandbox.ts`（outbox 绑定、`materializeOutboxFile`）、`src/utils/child-env.ts`（`applySessionOwnerEnv`、`WORKFLOW_WORKER_ENV_KEYS` 的边界清理模式）、`src/workflows/shared/worker-process.ts`、`src/workflows/v3/journal.ts`、`src/core/self-spawn.ts`、`src/adapters/cli/fs-policy.ts`、`src/workflows/shared/sandbox-policy.ts`。

**仓库约束（CLAUDE.md）：** 新增子进程经 `applySessionOwnerEnv` 注入并冻结 owner 身份，ownerless 删除两个变量；`ou_` 是 app-scoped；编译态不拼 `dist/*.js`；改共用层评估跨 CLI、跨后端、跨会话类型影响面。

## 1. 一句话

一个 workflow 就是一个普通的 async JS 函数。botmux 给它四个副作用原语和一本 journal，控制流交给 JS。引擎的全部工作是：给每个副作用一个稳定身份、在所有权临界区内记下意图、记录结果、恢复时忠实重放，不能保证忠实时停下来问人。

## 2. 为什么走到这一步

| 方案 | 智能在哪 | 运行时 | 问题 |
|---|---|---|---|
| v3 | architect LLM 生成 `dag.json` | 静态 DAG + ephemeral worker 跑 `/goal` | 难用；自动触发；改 prompt 不失效缓存；36k 行 |
| acpus | agent 写 TS DSL | IR → 持久化调度器 → per-workspace daemon | 56k 行 Effect；在 JS 里再造表达式语言；作者自认冗余 |
| Claude Code Workflow | 模型现写 JS | 纯控制平面 + 内容寻址 journal | 只有 Claude；失败静默 28.6%；无人在环 |

我们要的六件事：零仪式、首输出快、失败一眼可见、跨 20+ CLI、飞书人在环、只显式触发。

## 3. 承重原则

1. 脚本是纯控制平面，唯一副作用是 `ctx` 原语。
2. 并发只能由组合器创建；每个分支有自己的 ctx，分支只改局部状态。
3. 每个副作用有稳定身份并进 journal；发出前先在所有权临界区内持久化意图；重跑等于重放。
4. 失败是一等公民：类别、重试策略、副作用确定性三维度落盘；聚合层拿不到 `null`。
5. 恢复宁可停下也不撒谎：不能证明忠实重放或清理完成时 `paused`，选择交给人并持久化。
6. 进程归属必须可验证：没有内核级容器就不运行；只有已建立的命名空间边界才叫 `contained`，其余如实记为 `cooperative`。
7. 证据优先。
8. 脚本权限不超过话题里 CLI 的权限。
9. 只显式触发。
10. 不造语言。

## 4. 编程模型

### 4.1 脚本

```js
// slogan.mjs —— 纯 ESM，无 import，无 Node API
export default async function (ctx) {
  const { input, parallel, signal, agent } = ctx;

  // 并发必须经组合器；每个分支拿到自己的 ctx（c），只改分支局部状态，结果靠返回值汇总
  const drafts = await parallel(['warm', 'bold', 'minimal'].map((tone) => (c) =>
    c.agent({
      cli: 'claude-code',
      prompt: `Write one ${tone} slogan for ${input.topic}. Reply as JSON.`,
      schema: { type: 'object', required: ['slogan'], properties: { slogan: { type: 'string' } } },
    })));

  const ok = drafts.filter((d) => d.ok);
  if (ok.length === 0) return { result: 'no drafts', failures: drafts };

  const pick = await signal({
    prompt: `Pick one:\n${ok.map((d, i) => `${i + 1}. ${d.value.slogan}`).join('\n')}`,
    schema: { type: 'object', required: ['index'], properties: { index: { type: 'integer', minimum: 1 } } },
  });
  if (!pick.ok) return { result: 'canceled' };

  const chosen = ok[pick.value.index - 1].value.slogan;
  const review = await agent({ cli: 'codex', session: 'reviewer', prompt: `Critique in two sentences: ${chosen}` });
  return { slogan: chosen, review: review.ok ? review.value : review };
}
```

触发：`botmux flow run slogan.mjs --input '{"topic":"tea"}' [--follow] [--concurrency 4] [--require-containment]`。

### 4.2 `ctx`

| 成员 | 语义 | journal |
|---|---|---|
| `agent(spec)` | 独立 PTY 跑一个 CLI 回合，返回 `Outcome` | 是 |
| `signal(spec)` | 发信号卡等人，返回 `Outcome` | 是 |
| `parallel(thunks)` | `thunk(branchCtx)`；等全部结束返回 `Outcome[]`（按输入顺序）；不捕获异常 | 占位置 |
| `pipeline(items, ...stages)` | `stage(value, item, branchCtx)`；每 item 独立流水线；stage 返回 `ok:false` 则该 item 短路 | 占位置 |
| `input` | `--input` JSON | `run.started` |
| `log(text)` | 写 `note` 行 | 是 |

**ctx 就是 scope。** 根 ctx 由默认导出接收；组合器为每个分支创建分支 ctx。规则：

- 任何 ctx 上同一时刻只允许一个在途的副作用或组合器；第二个到达即硬错误 `concurrency_outside_combinator`。
- **生命周期**：分支 thunk 返回时其 ctx 被撤销；之后任何调用是硬错误 `ctx_revoked`。thunk 返回时该 ctx 仍有在途副作用（未 `await`）是硬错误 `unawaited_effect`，runner 取消该 attempt（成为 `interrupted / uncertain`）后终止脚本。根 ctx 在脚本返回后同样撤销。
- 这些检查由 script host 在调用时刻执行，不依赖 AsyncLocalStorage。

`agent(spec)`：`cli`、`prompt` 必填；`schema`（§4.7）、`session`、`model`、`cwd`（默认触发时 cwd）、`timeoutMs`（默认 30 分钟）可选。`signal(spec)`：`prompt`、`schema` 必填；`timeoutMs` 默认 7 天。

### 4.3 Outcome

```ts
type Outcome<T> =
  | { ok: true;  value: T; identity: string; attempt: number; evidence: Evidence }
  | { ok: false; identity: string; attempt: number; evidence: Evidence;
      error: string; category: FailureCategory; retry: 'auto' | 'manual'; effects: 'none' | 'uncertain' };
```

`agent()` / `signal()` 永远返回 Outcome；`null` 不出现在任何返回值里。抛错只留给硬错误（§4.5）。

### 4.4 失败的三个维度

| 维度 | 取值 | 含义 |
|---|---|---|
| `category` | `setup_required` / `spawn_failed` / `container_unavailable` / `slot_timeout` / `schema_mismatch` / `timeout` / `crashed` / `interrupted` / `canceled` / `wait_timeout` / `delivery_failed` | 诊断与文案 |
| `retry` | `auto` / `manual` | resume 时是否自动重跑；`manual` 等人选择 |
| `effects` | `none` / `uncertain` | **由是否存在有效的 `send.intent` 行决定**（§5.5）：无意图为 `none`；有意图无结果一律 `uncertain`，即使实际未发出 |

**本设计提供的是可能重复执行的恢复语义**，是否重跑由人在知情下选择并持久化。

### 4.5 硬错误与组合器

硬错误：`cli` 未知、`schema` 非法、超上限（含 `maxNotes`）、default export 不是函数、静态检查不过、无话题绑定时调用 `signal`、结构外并发、ctx 撤销后调用、未等待的副作用、同名会话并发或配置不一致、容器不可用、`script_stalled` 与 `script_cpu_exceeded`（§9）、脚本自身抛出的异常。硬错误穿透一切组合器：runner 记 `run.error`，取消在途 attempt，run 状态 `failed`。组合器不做任何 catch。

- `parallel(thunks)`：thunk 返回 Outcome 原样保留；普通值包成 `{ok:true, value}`；抛错穿透。
- `pipeline(items, ...stages)`：stage 返回 `ok:false` 时该 item 短路；普通值或 `ok:true` 解包继续。

### 4.6 run 状态与健康度

- `settled`：按 §5.4 投影，每个 `started` 都有 `result` 或 `failed`。
- `status`：`running` / `paused` / `interrupted` / `completed` / `partial` / `failed` / `canceled`（定义见 §7.1 与 §5.4）。
- `health`：`ok` / `degraded` / `all_failed`；**`all_failed` 强制 `status = failed`**。

### 4.7 结构化输出与 schema

JSON Schema draft-07 子集：`type`、`properties`、`required`、`additionalProperties`、`items`、`enum`、`const`、`minimum`/`maximum`、`minLength`/`maxLength`、`anyOf`/`oneOf`。**不含 `pattern`**。校验器线性时间；上限：agent 响应 256KB、信号 payload 16KB、schema 32KB、深度 32。契约文件的最终回复解析最后一个平衡 JSON 块 → 校验 → 同一会话内且仅一次 repair → 仍不符 `{ok:false, category:'schema_mismatch', retry:'manual', effects:'uncertain'}`。

## 5. 身份、journal 与重放

### 5.1 身份必须来自结构

两轮反例（流水线相同 prompt；裸 Promise 分支相同 prompt）的共同点是相同内容的副作用来自无结构区分的并发 lineage，任何身份方案都分不开，只能禁止这种并发存在。第三轮又指出：即使不绕过组合器，分支间共享可变状态也会让返回值在重放时不同。位置身份保证的是**调用归属**；返回值确定性由 §5.2 的编程约束承诺，且只对遵守约束的脚本成立。

### 5.2 显式 scope、位置与确定性

**位置。** 每个 ctx 携带 `scopePath` 与计数器；副作用与组合器都在调用时刻消费序号。组合器位置 `P#k` 派生子 scope：`P#k/par:i`、`P#k/pipe:i:s`；子 scope 计数器从 0 开始。

```
identity = scopePath + '#' + seq
content  = sha256(kind, cli, model, realpath(cwd), execConfigDigest, prompt, canonical(schema), sessionChain?)
```

**编程约束（skill 文档明示，静态检查不能保证）。** 分支只修改自己的局部状态；分支之间通过返回值按输入顺序汇总；不跨分支读写共享可变状态；不依赖分支完成的先后。

**确定性承诺与边界。** 第四稿曾承诺按原始结算顺序释放缓存以复现分支交错，第四轮 review 用两个实验推翻：① 顺序脚本 `await agent(A); await agent(B)` 在「gen 1：A 失败且可自动重试、B 成功；gen 2：A 重试成功、B 复用」之后，有效结果的物理结算顺序是 B、A，而脚本的请求顺序是 A、B——严格按顺序释放则 A 等 B、B 又等脚本拿到 A，死锁；放宽为「不等未请求的 identity」则跳过 B，违反顺序保证。② Bun 1.4.0 下保持 A、B 的 resolve 顺序不变、只改变两次投递之间是否排空微任务，共享 `rank` 的结果就从 `[1,2]` 变成 `[2,1]`——结算顺序本来就决定不了全部 JS 交错。本稿撤回该机制，不为违规脚本提供确定性调度器：

- 重放时缓存**按请求即时返回**，与首次执行时的结算先后无关，不存在等待。
- 确定性只对遵守约束的脚本承诺：分支返回值只依赖本分支的 Outcome，Outcome 按 identity 缓存，组合器按输入顺序汇总，因此聚合结果与交错无关；顺序脚本天然满足。
- 违反约束的脚本：调用归属仍正确（identity 不依赖交错），返回值可能与首次不同。`--check-replay`（M1）对已完成的 run 做只读重放，比较脚本返回值与投影，用于检出违规脚本；`inspect` 的 `replay` 字段只表示缓存命中程度（`full` 零 spawn / `mixed` / `none`），不表示交错复现。

**残余洞明示。** 违反编程约束的脚本返回值不确定，靠 `--check-replay` 与 skill 文档兜底，不靠运行时；两条首次执行恰好不重叠又内容相同的无结构 lineage 需先绕过组合器才能写出来。

### 5.3 命名会话

会话首次使用时冻结 `cli/model/cwd`，之后不一致是硬错误；同一会话同一时刻只能有一个在途回合，跨分支并发使用是硬错误，不排队。第 n 轮 `content` 含 `sessionChain[n-1]`：

```
sessionChain[0] = sha256(session, cli, model, realpath(cwd), execConfigDigest, contextGen)
sessionChain[n] = sha256(sessionChain[n-1], identity_n, outcomeDigest_n)
```

`--continue-session` 使 `contextGen + 1`，旧上下文缓存全部失效。恢复协议见 §6.5。不在 M1。

### 5.4 journal 行与投影

```jsonl
{"t":"run.started","gen":1,"runId":"…","script":"…","scriptHash":"…","input":{…},"binding":{…},"cwd":"…","execConfigDigest":"…","bootId":"…","containment":"contained|cooperative","boundary":"none|cgroupns+userns","probe":{…},"ts":…}
{"t":"run.takeover","gen":2,"from":{"pid":…,"identity":"…"},"reason":"holder_dead|heartbeat_stale|lease_missing|lock_holder_stale","containment":"…","boundary":"…","probe":{…},"ts":…}
{"t":"container.created","gen":1,"container":"c-1-0","kind":"cgroup2-kill|cgroup2-freeze|cgroup1-freezer","path":"…","ts":…}
{"t":"attempt.state","gen":1,"identity":"#1/par:0#0","attempt":1,"container":"c-1-0","state":"queued|spawning|ready|settling","pid":…,"pidIdentity":"…","ts":…}
{"t":"started","gen":1,"identity":"#1/par:0#0","attempt":1,"content":"…","kind":"agent","cli":"claude-code","ts":…}
{"t":"send.intent","gen":1,"identity":"#1/par:0#0","attempt":1,"container":"c-1-0","turn":1,"outboxFile":"response-1-1-3f9a2c1d7e0b.md","ts":…}
{"t":"send.confirmed","gen":1,"identity":"#1/par:0#0","attempt":1,"ts":…}
{"t":"result","gen":1,"identity":"#1/par:0#0","attempt":1,"value":{…},"evidence":{…},"ts":…}
{"t":"failed","gen":1,"identity":"#1/par:1#0","attempt":1,"category":"timeout","retry":"auto","effects":"uncertain","error":"…","evidence":{…},"ts":…}
{"t":"decision","gen":2,"scope":{"identity":"#1/par:1#0","content":"…","attempt":1},"choice":"accept-failed|retry|timeout","by":"…","ts":…}
{"t":"wait","gen":1,"identity":"#3","content":"…","version":1,"schema":{…},"prompt":"…","ts":…}
{"t":"wait.delivery","gen":1,"identity":"#3","version":1,"state":"delivered|failed|resent","card":{"messageId":"om_…"},"error":"…","ts":…}
{"t":"wait.superseded","gen":1,"identity":"#3","version":1,"ts":…}
{"t":"signal","gen":1,"identity":"#3","content":"…","version":1,"by":"ou_…","value":{…},"ts":…}
{"t":"session.opened","gen":1,"session":"reviewer","contextGen":0,"container":"c-1-2","handle":{…},"restore":"exact|verify|none","ts":…}
{"t":"session.checkpoint","gen":1,"session":"reviewer","turn":1,"identity":"#4","chain":"…","fingerprint":{"len":…,"sha256":"…"},"stable":true,"ts":…}
{"t":"divergence","gen":2,"identity":"…","expected":"…","actual":"…","ts":…}
{"t":"escape","gen":2,"container":"c-1-0","pids":[…],"ts":…}
{"t":"activity","gen":1,"activeMs":184213,"ts":…}
{"t":"note","gen":1,"text":"…","ts":…}
{"t":"run.error","gen":1,"error":"…","stack":"…","ts":…}
{"t":"run.interrupted","gen":1,"reason":"daemon_disconnect","inflight":["…"],"ts":…}
{"t":"run.finished","gen":2,"status":"failed","health":"all_failed","counts":{"started":3,"ok":0,"failed":3},"returned":{…},"replay":"full|mixed|none","ts":…}
```

**每一行都带 `gen`**，包括 `decision`、`wait`、`signal`、`note`、`divergence` 与会话行。单行不超过 4KB，大 value 落 attempt 目录并在行内引用路径。写入为单次 `O_APPEND`，且**每次追加都在 §6.2 的所有权临界区内完成**。

**投影算法（两步）：**

1. **完整性校验。** 按文件顺序扫描，`currentGen` 初始为 0；遇到 `run.started` 或 `run.takeover` 行，若其 `gen > currentGen` 则 `currentGen = gen`，否则该行无效。其它任何行，`gen !== currentGen` 即无效。**在 §6.2 协议下这一步不应剔除任何行**：所有追加都在临界区内核对过 lease，被围栏的写者写不进 journal。剔除计数 > 0 说明协议被绕过（手工编辑、旧版本 runner、未知 bug）：`inspect` 报告明细；resume 与接管进入 `paused`，原因 `journal_integrity`，需 `--accept-journal` 才继续，该决定写成 `decision` 行。
2. **跨代次投影。** 在有效行上，按 `identity` 取最新 `attempt`（以行顺序为准），取该 attempt 的最终状态（`result`/`failed`/在途）；`decision` 按 `{identity, content, attempt}` 索引，跨代次有效；`wait`/`signal`/`session` 行同样跨代次。gen 2 完整继承 gen 1 的成功结果、失败记录与决策。

`settled`、`status`、`health` 都在第二步的投影上计算。

### 5.5 attempt 生命周期与 `effects`

第三稿把「拿到真实 pid」转为 `prompted` 并据此推导 `effects`，存在「CLI 已执行操作但 `prompted` 未写就崩溃 → 判 `none` → 自动重跑」的窗口。状态机消除不了这个窗口，改为发送前持久化意图：

```
queued ──槽位──▶ spawning ──进程就绪，真实 pid 已登记──▶ ready
ready ──runner 在所有权临界区内追加 send.intent 并 fsync──▶ intent ──出临界区后授权 worker 写 PTY──▶ worker 写入 ──▶ send.confirmed（尽力）
──契约文件出现或 CLI 退出──▶ settling ──▶ result | failed
```

- `send.intent` 是 `effects` 的唯一依据：**存在有效 `send.intent` 且无 `result`/`failed` 结算 → `uncertain`**，包括 runner 在 fsync 后、授权前崩溃，以及 worker 在收到授权后、写入前崩溃的情况。这是必须保留的保守窗口。
- `send.intent` 的追加遵守 §6.2：临界区内核对 lease 后写入并 fsync，出临界区后才向 worker 发授权；授权消息携带 `gen`、`attempt` 与 `outboxFile`，worker 只接受与自己登记一致的授权。核对失败则不写、不授权，attempt 随被围栏的 runner 一起终止。
- 只有停在 `queued`/`spawning`/`ready` 且无 `send.intent` 的 attempt，恢复时才判 `none` 并自动重跑。
- `send.confirmed` 只用于诊断（区分「意图已写但未发出」与「已发出」），不参与 `effects` 推导。
- 进程就绪（`ready`）与 prompt 提交是两件事：真实 pid 与出生身份在 `spawning → ready` 时登记；`ready` 阶段的 CLI 只到达提示符，未收到任何输入。

重放规则：

| identity 的投影结果 | 处置 |
|---|---|
| `result` 且 content 相同 | 直接返回缓存，不 spawn |
| `failed`，`retry:auto`，`effects:none` | 自动重跑 |
| `failed`，其余组合，无匹配 `decision` | 待决策，run `paused` |
| `failed` 且 `decision: accept-failed` | 以该失败 Outcome 返回 |
| `failed` 且 `decision: retry` | 重跑一次；新 attempt 的失败不继承授权 |
| 在途且无 `send.intent` | 自动重跑（`effects:none`） |
| 在途且有 `send.intent` | `interrupted / uncertain` → 待决策 |
| `signal` 且 content 相同 | 直接返回 |
| `wait` 逻辑上仍 open 且 content 相同 | 复用等待（§7.3） |
| `wait`/`signal` 但 content 不同 | 旧 wait `superseded`，新 wait `version+1` |
| content 不同 | 记 `divergence`，执行 |
| 无记录 | 执行 |

`decision` 按 `{identity, content, attempt}` 持久生效；`--retry-uncertain` 写入时展开为当前列出 attempt 的逐条 `retry` 决策，之后新发生的失败不被覆盖。

### 5.6 重放验收

同一 run 连续执行两遍（第二遍为 resume），断言：① 第二遍 spawn 为 0；② `identity → 最终 Outcome` 投影逐项相等；③ 遵守约束的脚本返回值深度相等；④ 每个 `signal` 行的 identity、content、value 相等；⑤ `run.finished.replay = full`。固定单测：四轮 review 的对抗用例（流水线相同 prompt；裸 Promise 分支相同 prompt 须在首次即被拒；**顺序脚本「A 失败重试、B 复用」三代次不死锁且返回值相等**；**`++rank` 共享状态作为负例，由 `--check-replay` 报告返回值不一致**；逃逸的分支 ctx 与未等待的副作用被拒）。

## 6. 进程模型

### 6.1 三个角色

```
daemon ──resolveEntrySpawn('flow-runner')──▶ runner（特权，一个 run 一个，持 lease）
             │                                 ├─ journal、宿主 IPC 发卡、信号裁决、决策、槽位、心跳、容器管理、秒表与 CPU 采样
             │                                 ├─ resolveEntrySpawn('flow-script') ▶ script host（受限，RLIMIT_CPU）
             │                                 │     跑脚本快照；ctx 是 IPC RPC；无文件、无网络
             │                                 └─ resolveEntrySpawn('flow-agent')  ▶ agent worker（每 attempt 或每会话，由 runner 移入容器）
             │                                       PtyTurnRunner + 契约 + 证据
             └─ 入站：卡片回调、控制命令 → IPC → runner
```

三个入口都是新增 `BotmuxEntry`。两层子进程都经 `applySessionOwnerEnv`。总时限与取消由 runner 在进程外执行。runner 与 daemon 的 IPC 携带 `runId` 与 `gen`。

### 6.2 lease、代次、接管与「写即核对」

- `run.lease`：`{holderPid, holderIdentity, gen, heartbeatAt, acquiredAt}`，`holderIdentity` 来自 `readProcessStartIdentity`。**锁 target 唯一**：`withFileLock` 会给 target 自动追加 `.lock`（`src/utils/file-lock.ts`），第六稿同时写了 `withFileLock(<run>/lease.lock)` 与 `withFileLock(run.lease)`，实际是 `lease.lock.lock` 与 `run.lease.lock` 两把锁，review 在临时目录里证实两段「临界区」可同时进入。本稿只有一个入口 `withRunOwnership(runDir, expectedGen, fn)`：内部 `withFileLock(join(runDir, 'run.lease'), …)`（锁文件 `run.lease.lock`，内容是 `{pid, procStart, bootId}`），读 lease 核对 gen 与身份，通过才执行 `fn`；所有共享状态写入都只经它。lease 内容可以无锁读取（用于判断陈旧），但**任何写都在临界区内**。`withFileLock` 非重入，runner 内所有临界区操作排在一个串行队列上；临界区内不做 IPC、不等待子进程，只做文件读写、fsync 与 cgroup 目录操作（毫秒级）。
- **代次单调**：`persistedMaxGen = max(lease.gen, run.json.gen, journal 中最后一条有效 run.started/run.takeover 的 gen)`。新 runner 的 `gen = persistedMaxGen + 1`；只有 journal 为空的全新 run 才是 `gen = 1`。lease 缺失、丢失或损坏都不会让代次回退。
- **追加即核对（第四轮）**：第四稿让追加以「最近一次心跳确认的 gen」为前提，review 指出这留下最多 5 秒窗口：新 runner 写入 `run.takeover(gen=2)` 后，旧 runner 在下次心跳前仍能追加 `send.intent(gen=1)` 并授权发送，而投影会剔除这条意图，attempt 被判 `none` 自动重跑——过滤旧结果替代不了阻止旧执行。本稿改为：**runner 对 journal 的每一次追加都在 `withFileLock(run.lease)` 临界区内完成**：读 lease → 核对 `gen === 自己的 gen && holderIdentity === 自己的出生身份` → `O_APPEND` 写行 → `send.intent` / `signal` / `decision` / `run.takeover` / `container.created` 额外 fsync → 出临界区。核对失败即被围栏；锁等待超时（`FileLockTimeoutError`，默认 5 秒）视为追加失败，该副作用不得继续，连续三次失败 runner 自认围栏。
- 于是 **journal 的文件顺序就是所有权顺序**。对第四轮的时序：若旧 runner 的 `send.intent(1)` 先于 `run.takeover(2)` 进入临界区，它在文件中位于 takeover 之前，投影有效，attempt 判 `uncertain`；若后于 takeover，核对失败，不写入、不授权。不存在「已授权发送但意图行被剔除」的路径。投影第一步因此降级为完整性校验（§5.4）。
- **写即核对（第五轮推广）**：第五稿只把 journal 追加放进临界区，`run.json` 仍在出临界区后更新，于是存在「gen 1 提交后暂停 → lease 丢失、gen 2 接管并更新元数据 → gen 1 恢复执行、写回旧 gen/holder」的回退，daemon、`inspect` 与下一次接管读到的元数据就是旧的。本稿把规则推广为：**run 目录下所有共享状态的每一次写入都在同一临界区内先核对 lease**——journal 追加、`run.json`（gen、holder、status、health、containment、`activeMs` 缓存）、`processes.json`、cgroup 目录的创建与入容器写入。原子替换文件挡不住旧内容覆盖新内容，核对才挡得住。`activeMs` 以 journal 的 `activity` 行为真相源（§9），`run.json` 只是缓存：接管时若 `run.json.gen` 小于 journal 的最新有效代次，整个 `run.json` 由 journal 重建。宿主级槽位文件 `flow-host-slots.json` 不在 run 目录内、有自己的锁；第六稿写的「陈旧条目按 holder 存活性回收」是错的，会在容器清空前释放容量，改法见 §9「槽位释放」。
- **旧写者的其它副作用路径**逐条封住：worker 授权只在 `send.intent` 追加成功后发出，且授权携带 gen；容器的 `container.created` 追加与 mkdir 在**同一临界区**内完成（§6.3，第五轮：只「先记录后 mkdir」时，旧 runner 可能在新 runner 宣布清理完成之后才 mkdir 并起 worker）；worker 入容器的写入与 `attempt.state: spawning` 追加也在临界区内核对，核对失败即终止那个尚未起 CLI 的 worker；信号裁决的 `signal` 行、`decision` 行同样经核对；结果接收（`result`/`failed`）追加失败则丢弃，对应 attempt 在新代次按 `uncertain` 处理，方向保守；被围栏的 runner 回收自己代次的容器（容器名含 gen，不会碰新代次的容器）后退出，script host 随之终止。
- **接管条件**：holder 身份匹配且存活：心跳新鲜 → 拒绝；心跳陈旧超过 60 秒 → 按身份 TERM→KILL holder，确认消失后接管。holder 身份不匹配或不存在 → 接管。`lease_missing` 时从 `run.json.holder` 找上一持有者，身份匹配且存活则 TERM→KILL——这是尽力释放资源，正确性不依赖它：存活的旧持有者会在下一次写入或心跳时被围栏。
- **锁持有者假死**：临界区极短，正常情况下锁等待远小于 `withFileLock` 的 5 秒上限。第六稿按「自首次超时起累计 60 秒」杀持有者是错的：等待期间锁可能已释放、换人或被同一进程重新获取，累计到期时读到的可能是刚拿到锁的新持有者；出生身份只能证明是同一个进程，证明不了它连续占着同一次锁。改为**按同一锁实例的连续占有时间计时**：每次超时后 `lstat` 锁文件 `run.lease.lock` 取 inode 与 ctime，读其 payload `{pid, procStart, bootId}`，三者合起来标识一个锁实例；接管者记 `{instance, firstSeenAt}`，下一次超时时实例任一分量变化、或 lease 心跳有进展 → 重置计时；同一实例连续占有满 60 秒 → **发信号前再核验一次实例未变** → TERM → 5 秒 → KILL → 确认该 pid 已退出或出生身份已不匹配 → 再交给 `withFileLock` 对死持有者做陈旧回收 → 重试接管，`run.takeover.reason = lock_holder_stale`。持有者已死的情况 `withFileLock` 自己回收，不需要这条。因此不是「接管最多等 60 秒」，而是「同一实例连续占有 60 秒到期启动回收」：初次锁等待、终止宽限与确认退出各自还要时间，典型总耗时 70–80 秒。被杀的持有者若正处在临界区中间，其半途状态由下一条的崩溃点分析覆盖。
- **提交顺序**：同一临界区内读 lease、计算新 gen、写 lease、追加 `run.takeover {gen}` 并 fsync、重写 `run.json`（gen、holder）。临界区内崩溃只可能是 lease 已写而 takeover 未写、或 takeover 已写而 `run.json` 未写：前者下一接管者从 lease 读到更大的 gen，继续 +1，被跳过的代次没有任何行；后者 `persistedMaxGen` 从 journal 取到，`run.json` 由接管者重建。
- **心跳与围栏**：每 5 秒在临界区内核对 `lease.gen === 自己的 gen` 再刷新心跳（同一临界区顺带写 `activeMs` 缓存），用于让别人判断自己是否存活；核对失败即被围栏：拒收 RPC 与结果、拒绝裁决、回收本代次容器、退出。写入的正确性不依赖心跳，只依赖写入时的核对。

### 6.3 进程容器、归属边界与回收

第三稿依赖 env 标记扫描，第三轮用实验证伪：带标记的父进程用空 env 启动子进程后退出，孤儿既无标记也不在原进程树里。第四稿改为 cgroup，第四轮指出还缺「CLI 无权迁出」这一权限条件：进程可以通过写别的组的 `cgroup.procs` 把自己迁出，容器为空就证明不了后代已清理。

**容器 = cgroup，由 runner 放入。** 创建与入容器都在所有权临界区内（§6.2）：① 临界区内核对 lease → 追加 `container.created` → mkdir 容器目录；② 出临界区 spawn worker，worker 启动后只等握手，10 秒等不到即自行退出；③ 临界区内核对 lease → 把 worker pid 写入容器 `cgroup.procs` → 追加 `attempt.state: spawning`；核对失败则 TERM→KILL 那个 worker（它还没起 CLI，也不在任何容器里，是 runner 自己的直接子进程）；④ 出临界区经 IPC 告知「已入容器」，worker 才 spawn CLI。worker 与 CLI 对 cgroup 文件不需要任何写权限。CLI 及其后代无论 fork、setsid、双重 fork、清空 env，都留在容器内。第五轮的时序（旧 runner 写完记录后暂停，新 runner 发现目录不存在、宣布清理完成，旧 runner 随后才 mkdir 并起 worker）在此顺序下不成立：mkdir 与记录在同一临界区，被围栏的旧 runner 既建不了目录，也把不了 worker 放进容器，它已 spawn 的 worker 要么被它自己杀掉、要么握手超时自退、要么随父进程死亡而退出。

**归属的权限条件与分档。** 迁出需要写目标组的 `cgroup.procs`（v1：对目标文件的 DAC 写权限；v2：还需对源与目标公共祖先 `cgroup.procs` 的写权限；root 与 CAP_DAC_OVERRIDE 绕过 DAC；v2 `nsdelegate` 挂载下命名空间根之外的迁移被内核直接拒绝，且按写者的 cgroup namespace 判定，与经哪个挂载点写无关）。第五稿用「迁入父组失败 + 建子组失败」授予 `contained`，第五轮给出 v1 反例：父组与探测容器归 root，CLI 用户既写不了父组也建不了子组，但同一层级里另一个组已委托给该用户，它写那个组的 `cgroup.procs` 就迁出了。**探测成功能证伪 containment，探测失败只证明那两个操作被拒。** 因此：

- `contained` 只来自**已建立、可核验的命名空间边界**：v2 `nsdelegate` 挂载 + 进程在容器内 `unshare` 出 cgroup namespace（bwrap `--unshare-cgroup`，容器即其 cgroupns 根）+ user namespace（bwrap `--unshare-user`，`setns` 回宿主 cgroupns 需要的 CAP_SYS_ADMIN 已被剥夺）。核验方法是读取事实而非探测：`/proc/self/mountinfo` 中 cgroup2 带 `nsdelegate`；CLI 的 `/proc/<pid>/ns/cgroup` 与 `/proc/<pid>/ns/user` 都不同于 runner 的；从宿主看 CLI 的 `/proc/<pid>/cgroup` 是容器路径、从 CLI 内看是 `/`。三项都成立记 `boundary: cgroupns+userns`。这是 M3 沙箱的能力，**M1 一律 `cooperative`**。
- 基于 uid 的边界（CLI 以非 root uid 运行，且整个层级里没有任何 `cgroup.procs`/`tasks` 对该 uid 可写）在 v1 上需要遍历整个层级、并在每次回收前重新核验，仍挡不住之后新增的委托。本稿不把它列为 `contained` 的来源；是否作为 M1 之后的中间档，见 §16。
- 探测改为**证伪测试**：runner 每次启动在探测容器里用与 CLI 相同的凭证（同 uid/gid/caps，沙箱下在同一沙箱内）跑探测进程，真实尝试把自己迁出到 run 级父组（不用 `access(W_OK)`，root 下恒真）。迁出成功 → `cooperative`；在核验为 `contained` 的沙箱内迁出成功 → 边界被证伪，拒绝运行，`container_unavailable`。迁出失败不改变档位。建子组只作为信息记录（子组在容器子树内，递归回收始终开启，不影响档位）。结果与 errno 写入 `run.started` / `run.takeover` 的 `containment`、`boundary`、`probe` 字段，`inspect` 与 `flow run` 输出都标注。

| 档 | 来源 | 清理保证 |
|---|---|---|
| `contained` | 已核验的 cgroupns + userns 边界（M3 沙箱，v2 `nsdelegate` 宿主） | 容器子树为空 ⇔ 该 attempt 派生的所有进程都已不存在 |
| `cooperative` | 其余一切，含 M1 全部与 v1 宿主 | 容器子树为空 ⇔ 所有进程都已不存在，**前提是整个派生进程树从未有任何一员迁出**。迁出的进程随后 fork 的后代自己没改写归属，却同样在容器外，所以前提落在整棵树上。普通 CLI、工具与 daemonize 手法都不改写 cgroup 归属；迁出需要显式写 cgroupfs |

`--require-containment`（或配置 `flow.requireContainment`）打开时 `cooperative` 直接拒绝运行，错误 `container_unavailable` 并附探测与核验详情；M1 默认关闭，M3 沙箱落地后评估翻转（§16）。

`cooperative` 档附加**逃逸检测**（只是检测，不是清理证明）：回收后扫描 `/proc/*/cgroup` 与 env 标记，发现带本 run 标记但 cgroup 路径不在 `botmux-flow/<runId>` 之下的进程 → 记 `escape` 行，resume 进入 `paused` 并列出 pid；扫描为空不改变档位表述。

**回收协议。** `cooperative` 档的 CLI 可能建出子组，父组 `cgroup.procs` 不递归列举子组，因此回收一律按子树处理，自叶向根删除：

| 环境 | 创建 | 回收 | 清理完成判定 |
|---|---|---|---|
| v2，`cgroup.kill` 可用（5.14+） | runner 自身 cgroup 下 `botmux-flow/<runId>/c-<gen>-<n>` | 写 `cgroup.kill = 1`。内核文档：杀死该组与所有后代组内的进程，「处理并发 fork 并防止迁移」 | 子树每个节点 `cgroup.events` `populated 0`，然后自叶向根 rmdir |
| v2，仅 `cgroup.freeze`（5.2–5.13） | 同上 | `cgroup.freeze = 1` → 轮询 `cgroup.events` 直到 `frozen 1` → 递归枚举子树 `cgroup.procs` → SIGKILL 全部 → `cgroup.freeze = 0` → 等待 | 同上 |
| v1 freezer | `/sys/fs/cgroup/freezer/botmux-flow/<runId>/c-<gen>-<n>` | 写 `freezer.state = FROZEN` → **轮询读回直到为 `FROZEN`**（写入后先是 `FREEZING`；有新任务加入会从 FROZEN 退回 FREEZING；冻结是层级的，覆盖后代组）→ 递归枚举子树 `cgroup.procs` → 再读一次确认仍为 `FROZEN`，否则重新枚举 → SIGKILL 全部 → `THAWED` → 等待子树 `cgroup.procs` 全部为空 | 子树每个节点 `cgroup.procs` 为空，然后自叶向根 rmdir |

- 冻结确认超时（默认 5 秒）、枚举失败、kill 后等待清空超时（默认 10 秒，其间重做「冻结-枚举-kill」循环最多 3 次）、rmdir 失败（EBUSY）都是**未清理**：`paused`，报告残留 pid 与节点，不猜。
- `bootId` 与记录不同（`readLinuxBootIdentity`）→ 宿主已重启，容器与进程都不存在，直接判清理完成。
- 清理未完成不得执行任何 `ctx` 调用；槽位不释放。
- **run 级树扫描**：接管后与每次心跳时列举 `botmux-flow/<runId>/`，任何非本代次的容器目录一律回收。有了「记录与 mkdir 同临界区」，被围栏的旧 runner 建不出新容器，这一步只兜底旧 runner 退出前来不及自清的既有容器；接管时「清理完成」的宣布以记录中的容器与树扫描都为空为准。
- **能力探测**：runner 启动时探测 v2 `cgroup.kill`、v2 `cgroup.freeze`、v1 freezer 三条路径（本宿主：5.15 内核、cgroup v1 混合模式、root 下 freezer/pids 层级可写，走 v1 路径）。三者都不可用 → `flow run` 直接拒绝，错误 `container_unavailable`，除非显式 `--unsafe-no-container`；该模式下任何带在途 attempt 的恢复都进入 `paused`，要求 `--assume-clean` 才继续，且 journal 记录该决定。**扫描为空永远不是清理成功的证据。**
- **M1 平台限定**：Linux + 上述三条路径之一。macOS 与其它形态不在 M1；`isStandaloneBinary()` 与 node 形态都走同一实现。
- **沙箱会话**：bwrap 进程本身也在容器内，`--unshare-pid` 与否不影响回收判定。
- **标记降级为辅助**：`BOTMUX_FLOW_ATTEMPT=<runId>/<identity>/<gen>-<attempt>` 仍随 env 下发，用于 CLI 内的 `botmux` 命令识别自己处于 flow agent 中（拒绝嵌套 `flow run`）、逃逸检测与诊断交叉核对，不参与清理完成判定。
- **边界清理**：新增 `FLOW_WORKER_ENV_KEYS`（`BOTMUX_FLOW_*`），在 `child-env.ts` 与 `WORKFLOW_WORKER_ENV_KEYS` 相同的边界（daemon/supervisor 启动、`botmux restart` 的 pm2 持久化路径）一并清除，避免经 `botmux restart` 污染 fleet。
- **父死子亡**仍保留为快速路径：IPC `disconnect` 即自杀、`getppid()` 轮询、TERM → 5 秒 → KILL；但清理完成的判定只认容器子树为空。

### 6.4 中断与恢复

- daemon 重启：runner 与 daemon 的 IPC 断开 → 写 `run.interrupted`、回收容器、释放 lease、退出；状态 `interrupted`。
- daemon 启动时扫描未结束的 run，发「run 已中断」卡；按钮或 `botmux flow resume` 才起新 runner。
- 新 runner 顺序：能力探测 → 获取 lease 与代次、追加 `run.takeover`、重写 `run.json`（同一临界区，§6.2）→ 边界核验与证伪探测（§6.3）→ 回收记录中的容器与 run 级树扫描 → 完整性校验（§5.4）→ 从最后一条 `activity` 行恢复 `activeMs`（§9）→ 加载脚本快照 → 按 §5.5 重放 → 到达待决策点则 `paused`。

### 6.5 命名会话的恢复协议（不在 M1）

| 能力 | 含义 | 恢复做法 |
|---|---|---|
| `exact` | adapter 能把可恢复状态精确回滚到记录的稳定边界 | 在副本上回滚后继续 |
| `verify` | 能读出状态指纹比对，不能回滚 | 相同继续；不同待决策 |
| `none` | 读不出指纹 | 需重开会话即待决策 |

- `result` 在契约文件结算时写；`session.checkpoint` 在稳定边界到达后写（状态文件 N 秒不变且 CLI 空闲）；未稳定则 `stable:false`，该会话降为 `verify`。
- 指纹 `{len, sha256(前 len 字节)}`；恢复先备份原始文件到 `sessions/<name>/orig.gen<g>`，在副本上截断并核对。
- 只恢复 adapter 声明的状态文件。Claude 的上下文还含 memory、指令与压缩状态，**暂列「候选 exact」**，spike 结论前按 `verify` 对待。
- 待决策选项：`--rebuild-session`（重复副作用）、`--continue-session`（`contextGen + 1`）、`--cancel`。

## 7. 控制路径与信号协议

### 7.1 `paused` 与 `interrupted`

- **`paused`**：runner 与 script host 存活、持 lease、心跳照常，脚本在某些 identity 上等待（人的决策、信号、投递失败）。接受全部控制命令；其它分支照常推进（秒表、失速与 CPU 预算规则见 §9）。常驻的是两个进程（runner 与保存执行栈的 script host），代价见 §9。
- **`interrupted`**：runner 不在。任何控制命令先 `resume`；中断期间拒绝信号提交，卡片回复「run 已中断，先恢复」并给出命令。

### 7.2 裁决者与原子性

runner 是唯一裁决者。daemon 卡片处理器做前置门（action 白名单、nonce、`canOperate`、run 登记、version 存在），把提交经 IPC 交给 runner。runner 对同一 identity 串行处理：核对 `content` 与 `version` 与当前逻辑 open 的 wait 一致 → 按持久化 schema 校验 → 首个合法提交**先在所有权临界区内追加 `signal` 行并 fsync（§6.2），再向 daemon 确认，再释放脚本**。之后的提交以「已消费」拒绝并冻结 stale 卡；取消与提交谁先被处理谁生效。

### 7.3 逻辑等待与卡片投递分离

第三稿把投递失败写成 wait 的状态，导致「终端提交只接受 open wait」与「投递失败后状态已变」冲突。分开两个状态：

- **逻辑等待状态**（`wait` / `signal` / `wait.superseded` 行）：`open` → `consumed` 或 `superseded`。只有它决定是否接受提交。
- **卡片投递状态**（`wait.delivery` 行）：`delivered` / `failed` / `resent`，只影响卡片与 `inspect` 的显示。投递失败**不关闭逻辑等待**，终端提交与重发都照常。

`wait` 绑定 `content` 与 `version`；上游重试改变 content → 旧 wait `superseded`、旧卡作废、新 wait `version + 1`；旧 version 回调一律拒绝。`signal.timeoutMs`（默认 7 天）到期 → `{ok:false, category:'wait_timeout', retry:'manual', effects:'none'}`。

### 7.4 投递失败与重发

`wait.delivery = failed` 时 run `paused`，`inspect` 显示原因。处置：`botmux flow signal <runId> <identity> --payload '<json>'`、`botmux flow resend <runId> <identity>`（`version + 1`）。resume 后逻辑 open 的 wait：先 updateMessage 旧卡为「run 已恢复，仍在等待」，失败则重发。

### 7.5 ACK 预算

前置门与 IPC 往返在 3 秒内；超预算沿用「先回提交中冻结卡、再补写」。

## 8. 输出契约、outbox 与 attempt

沿用现有沙箱 outbox 的模式：`<dataDir>/sandboxes/<sessionId>/outbox` 被显式 rw 绑定，宿主用 `materializeOutboxFile`（O_NOFOLLOW、O_NONBLOCK、fstat 拒非常规文件、从 fd 读、O_EXCL 写副本）收取。第三轮指出该 helper 只保护最后一级文件名，CLI 可写区内的中间目录可被换成 symlink 引导宿主收取目录外文件；第四轮指出扁平化后 `response-<gen>-<attempt>.md` 在命名会话的不同回合间碰撞（两个 identity 的首次执行都是 gen 1、attempt 1，第二回合不重新 spawn，「spawn 前 unlink」清不掉第一回合的文件，而收取逻辑接受非空旧文件）。因此：

- **outbox 扁平化**：每个容器一个绑定目录 `<run>/outbox/<container>/`，由宿主创建并绑定；**目录内不再有任何子目录**，`materializeOutboxFile` 直接作用于绑定目录。
- **文件名唯一到每次提交**：`response-<gen>-<turn>-<idhash>.md`，`turn` 是该容器内的提交序号（runner 分配、单调递增），`idhash` 是 `sha256(identity)` 前 12 位。文件名记录在 `send.intent` 行的 `outboxFile` 字段并随授权发给 worker，prompt 里也写明该文件名；收取只认该行记录的文件名，校验为纯 basename。同一命名会话的不同回合因此互不读到。
- **清理边界是每次提交**：追加 `send.intent` 前 unlink 该文件名（若存在则记 `note` 异常）；结算后收取到宿主私有的 `<run>/agents/<identity>/attempts/<gen>-<n>/response.md` 并删除源文件；不 rename；容器回收后删除 outbox 目录。
- 命名会话的后续回合写同一扁平目录下的新文件名，不需要给已运行的沙箱追加绑定。
- M1 非沙箱下契约文件直接写 attempt 目录，命名与收取规则相同。
- journal、`signals/`、`run.lease`、`processes.json` 对 CLI 不可见。

## 9. 资源上限、时限与常驻代价

- 计数对象是活的 CLI 进程：每个在途 attempt 与每个打开的命名会话各占一个。**槽位在容器子树确认为空后才释放**，不在结算时释放。
- run 级：`maxConcurrency` 4、`maxSessions` 4、`maxAgents` 50、`maxDurationMs` 4 小时、`maxScriptCpuMs` 5 分钟、`maxNotes` 1000。

**活动时间只用 runner 自己掌握的事实。** 第四轮指出按 run 级 `paused` 停表会让仍在推进的分支绕过时限；第五轮指出「未应答调用数」分不开「全部在等待」与「部分等待、部分执行」；第六稿的 `quiescent` 协议要求 script host 报告静止，第六轮证伪了它的前提：`await Atomics.waitAsync(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80).value` 只用允许的内建就能在 Node 22 与 Bun 1.4.0 下先发出静止、约 80 毫秒后自主继续，每次只做少量工作也躲得过 CPU 阈值；注入的 ctx 宿主函数经 `constructor` 可取回宿主 `setImmediate`，Bun 下 `codeGeneration.strings=false` 也挡不住；Node 官方说明 `vm` 不是安全隔离机制。结论：任何来自 script host 的自述都不能作为前提，本稿撤回 `quiescent` 协议，改用三条 runner 侧事实——**在途 attempt 数**（`queued` 到 `settling`）、**外部等待数**（runner 收到且未应答的 `signal` 等待、待决策、投递失败等待）、**脚本是否已返回**：

| 状态 | 条件 | 秒表 | 看门狗 |
|---|---|---|---|
| 推进中 | 在途 attempt ≥ 1 | 走 | attempt 各自的 `timeoutMs` |
| 外部等待 | 在途 attempt = 0，外部等待 ≥ 1 | 停 | `signal.timeoutMs` / `decisionTimeoutMs` |
| 无锚点 | 在途 attempt = 0，外部等待 = 0，脚本未返回 | 走 | 连续 60 秒（`scriptSliceMs`）无新的 ctx 调用 → 硬错误 `script_stalled` |

- 「无锚点」覆盖了死循环、`await new Promise(() => {})`（第六轮 P2：静止但没有任何可恢复的外部事件，旧规则会停表、解除看门狗并永久占用常驻名额）以及只自我唤醒、不调 ctx 的脚本：runner 控制的任何事件都无法让这样的脚本推进，60 秒后终止。计时器在每次新的 ctx 调用到达时重置，诚实脚本在两次副作用之间的计算远短于此。
- 「外部等待」下脚本仍可能在计算或自我唤醒（第五轮的场景）。这类工作没有副作用可言——脚本唯一的副作用是 ctx 调用，一旦调用就进入「推进中」——它能消耗的只有 CPU，所以由 **CPU 预算**而不是秒表约束：runner 每次心跳读 `/proc/<scriptHostPid>/stat` 的 utime+stime，累计超过 `maxScriptCpuMs`（默认 5 分钟，纯控制平面正常用量是秒级）→ 硬错误 `script_cpu_exceeded`；script host 启动时另设内核 `RLIMIT_CPU` 作为不依赖 runner 存活的兜底：**软限制取预算的两倍，硬限制取预算的三倍且必须有限**——到达软限制内核发 SIGXCPU，进程可以捕获或忽略，只有到达硬限制后的 SIGKILL 才是强制终止（第七轮提醒，`getrlimit(2)`）。CPU 采样不依赖 script host 的任何配合。
- 第五轮的场景在此规则下：决策等待期间，计算分支消耗 CPU 直到预算耗尽，或调用 ctx 进入「推进中」使秒表走表；两条路都有上限。第六轮的 `waitAsync` 脚本同理。
- `log()` 是唯一即时应答的 ctx 调用，为防止用它刷 journal，超过 `maxNotes` 即硬错误；单条仍受 4KB 限制。
- RPC 携带 `scopePath`，`inspect` 能按分支列出「在等什么」，但秒表与看门狗只用上面三个数。
- **`activeMs` 的真相源是 journal**：runner 每 60 秒与每次走表/停表切换时追加 `activity {activeMs, cpuMs}` 行（经 §6.2 写即核对），心跳顺带写 `run.json` 缓存。接管时从最后一条有效 `activity` 行恢复，最多少计 60 秒；`run.json` 陈旧或缺失不影响预算。CPU 预算跨代次累计，新代次的 script host 从 0 开始采样、加上历史值。

**槽位释放只认容器为空。** 第六稿「按 holder 存活性回收陈旧条目」会在 runner 被 SIGKILL、容器里仍有后代时释放容量，与「容器子树确认为空后才释放」冲突。改为：

- 宿主级槽位文件 `<dataDir>/flow-host-slots.json`（`withFileLock` 保护）的条目是 `{runId, gen, container, cgroupPath, holderPid, holderIdentity, state: held | pending_reclaim}`；per-daemon 槽位在 daemon 内存中用同样的结构。
- holder 死亡（pid 不存在或出生身份不匹配）只把条目置为 `pending_reclaim`，**不释放**。释放只有两条路，都以「确认该容器子树为空」为前提：① 该 run 的下一任 runner（resume 或接管）在 §6.2 临界区内先把本 run 的旧条目改记到自己名下，回收容器（§6.3），确认为空后释放；② daemon 清扫器每 30 秒扫描 `pending_reclaim` 条目，对 holder 仍然死亡的条目按 `cgroupPath` 直接执行 §6.3 的回收协议（内核级、幂等，不写该 run 的 journal），确认为空后在槽位文件锁内比较条目未被新 runner 改记再删除；清空失败的条目保持 `pending_reclaim` 并在 daemon 日志报告。两条路同时发生时都只是对同一 cgroup 做幂等 kill，释放由锁内的比较保证只发生一次。
- 清扫器回收的是 `interrupted` run 的残留：其 runner 已死，在途 attempt 已按 §5.5 判 `uncertain`，提前杀掉残留 CLI 不改变任何 journal 结论；下一任 runner 的回收会发现容器已不存在，直接判清理完成。
- 申请槽位时 `pending_reclaim` 条目照常计入占用；被围栏的旧 runner 在退出前释放不了任何东西，它的条目由上面两条路处理。
- **决策等待上限**：`decisionTimeoutMs` 默认 7 天，到期写 `decision {choice: 'timeout'}`，run `canceled`。信号等待由 `signal.timeoutMs` 约束。
- **常驻 run 上限**：`paused` 或等待信号的 run 各常驻 runner + script host 两个进程。M1 引入 `maxResidentRuns`（每 daemon 默认 8），超出时新 `flow run` 拒绝并提示；M1 验收测量两进程的 RSS。不做卸载执行栈的机制。
- 会话闲置挂起：`restore:exact` 的 adapter 上闲置 10 分钟终止 CLI、保留 handle。
- per-daemon 槽位默认 8；宿主级默认 16；两者都拿到才准 spawn；排队超时 → `slot_timeout / none / auto`。

## 10. 脚本权限边界与静态检查

- 脚本只在 script host 里执行，权限不超过触发它的话题里 CLI 的权限：沙箱话题下经同一套沙箱策略启动且更严（无工作目录写、无网络）；非沙箱话题下是独立进程，与该话题 CLI 同用户。
- script host 与 runner 之间只有 `ctx` RPC。
- **脚本在受限 global 下加载，这是卫生措施，不是边界**：script host 用 `vm` context 加载脚本快照，global 对象只含 ECMAScript 内建与 `ctx`，不含 Node/Bun 的 `process`、定时器、`setImmediate`、`queueMicrotask`、`MessageChannel`、`Worker`、`fetch` 等宿主 API，并额外删除能自主异步唤醒或引入不确定性的内建：`SharedArrayBuffer`、`Atomics`、`FinalizationRegistry`、`WeakRef`。ctx 桥接函数由 context 内创建的 Proxy 包裹，`get`/`getPrototypeOf` 陷阱只暴露 `apply`，不暴露 `constructor` 与原型链。第六轮已证明这些挡不住有意的绕过（`Atomics.waitAsync` 自主唤醒、经宿主函数 `constructor` 取回宿主 API；Node 官方声明 `vm` 不是安全隔离机制），所以本设计**不把任何 script host 内部的观察当作前提**：时限、失速与 CPU 由 §9 的 runner 侧事实与内核 `RLIMIT_CPU` 约束，权限由 §10 第一条的进程边界约束，受限 global 只负责让诚实脚本不会无意中用到时间、随机与定时器。
- **静态检查是 lint**：拒绝 `import`/`export`（default export 除外）、`require(`、`process`、`globalThis`、`eval`、`Function(`、`Date`、`performance`、`Math.random`、`fetch(`、`setTimeout`/`setInterval`/`setImmediate`/`queueMicrotask`、`SharedArrayBuffer`/`Atomics`/`FinalizationRegistry`/`WeakRef`、`Promise.all`/`allSettled`/`race`/`any`、`.then(`。lint 负责早报错，不是边界。正确性来源是 §5.2 的 ctx 规则、§5.5 的意图持久化、§6.2 的写即核对与 §4.4 的诚实恢复语义。

## 11. 里程碑

**M1 重放正确的核心（范围不变，验收为故障注入）**

包含：三个 `BotmuxEntry`；显式分支 ctx、位置身份、scope 生命周期；`agent()`、`parallel`、`pipeline`、`log`；失败三维度与 attempt 生命周期（`send.intent`）；journal、写即核对（journal、`run.json`、`processes.json`、容器创建与入容器）、两步投影与 `journal_integrity`；lease、代次单调、接管提交顺序、锁持有者假死处理、心跳围栏；cgroup 容器三条路径、能力探测、证伪探测（M1 一律 `cooperative`）、`--require-containment`、递归回收、run 级树扫描、逃逸检测；`resume`、待决策与 `decision` 持久化；`--check-replay`；`inspect`、`ls`、`cancel`；`vm` 受限 global（卫生）、三状态秒表与 `activity` 行、无锚点失速看门狗、CPU 预算采样与 `RLIMIT_CPU`、`maxNotes`、`decisionTimeoutMs`、`maxResidentRuns`；`withRunOwnership` 唯一入口与锁实例假死处理；槽位条目结构、`pending_reclaim` 与清扫器（daemon 侧申请接口可 stub，清扫器不可 stub）。

不包含：命名会话、沙箱下的 script host、outbox 绑定（M1 非沙箱下契约文件直接写 attempt 目录）、飞书卡片与 `signal()`（M1 调用即硬错误）。

验收（故障注入为主）：

1. §5.6 五条重放断言与全部对抗用例，含顺序脚本三代次用例与 `++rank` 负例。
2. **发送意图三点崩溃**：在 `send.intent` 写入前、写入后授权前、PTY 写入后 `send.confirmed` 前分别 `kill -9` runner 或 worker；前者 resume 自动重跑，后两者标 `uncertain` 待决策。
3. **接管与存活旧写者竞争**：删除 lease 后起新 runner，旧 runner 存活并在下次心跳前尝试追加 `send.intent`：若晚于 takeover 则追加被拒、不授权；若早于 takeover 则投影为 `uncertain`。两种情况都不出现自动重跑；旧 runner 随后被围栏退出，其容器被 run 级树扫描回收。
4. **旧写者的元数据回退**：gen 1 在更新 `run.json` 之前 SIGSTOP，gen 2 接管并更新后 SIGCONT gen 1：`run.json` 的 gen/holder/`activeMs` 不回退；`inspect` 与下一次接管读到 gen 2 的值。
5. **容器创建与接管的资源边界**：分别在「追加 `container.created` 与 mkdir 的临界区内」「mkdir 后、worker 入容器前」「入容器后、告知 worker 前」SIGSTOP 旧 runner，等心跳陈旧后接管：新 runner 宣布清理完成之后，旧代次不再出现任何进程；待握手的 worker 被杀或握手超时自退。
6. **锁实例假死**：临界区内 SIGSTOP 持有者 → 同一锁实例连续占有 60 秒后被 TERM→KILL，确认退出后 `withFileLock` 回收，接管成功（`lock_holder_stale`）；对照用例：持有者每 30 秒释放并重新获取锁（实例变化）→ 计时重置、不被杀；持有者在接管者累计等待 59 秒时释放、另一进程立刻获取 → 新持有者不被杀。
7. **槽位不早于容器清空释放**：旧 runner 被 SIGKILL、容器内留有后代、run 未 resume，另一 run 申请槽位 → 申请失败并排队；daemon 清扫器回收该容器并确认为空后槽位才可用；改为先 resume 旧 run 时，新 runner 改记条目并在自己回收后释放，清扫器不重复释放。
8. **脱离父进程且无标记的后代**：CLI 用空 env 启动 `setsid` 子进程后退出；resume 时该子进程被容器回收，子树为空后才继续；容器不可用时 resume 进入 `paused`。
9. **冻结期间持续 fork 与子组**：容器内进程循环 fork，回收仍以子树为空结束；`cooperative` 档下进程建出子组并放入后代，回收后子树为空且 rmdir 干净。v1 与 v2 各跑一遍（本宿主 v1，CI 上 v2）。
10. **归属证伪探测**：root 下迁出成功 → `cooperative` 且 `inspect` 标注；非 root 且迁出被拒 → 仍是 `cooperative`（不升级，第五轮的委托组反例作为说明用例）；`--require-containment` 在 `cooperative` 下拒绝运行；`cooperative` 下主动迁出的探测进程被逃逸检测发现，resume `paused` 并列出 pid。
11. **连续多次 resume**：gen 严格单调；gen 1 的成功结果与 `accept-failed` 决策在 gen 3 仍被复用；lease 被人为删除后代次不回退；手工追加 gen 不匹配的行 → `journal_integrity`，resume `paused`。
12. 两个终端同时 resume 只有一个成功；心跳陈旧的假死 runner 被接管并杀死。
13. 三 agent 全失败得到 `failed / all_failed`；坏 cliPath 与登录向导两种失败 `effects:none` 且带证据。
14. 裸 `Promise.all`、分支内误用根 ctx、逃逸的分支 ctx、未等待的副作用在首次执行时即被拒绝。
15. **时限、失速与 CPU 预算**：一个分支等待决策、另一个分支纯计算（第五轮的复现脚本）→ 秒表停止但 CPU 累计，超过 `maxScriptCpuMs` 即 `script_cpu_exceeded`；`Atomics.waitAsync` 自我唤醒脚本（第六轮）同样只受 CPU 预算约束且不能延长秒表停表以外的任何东西；计算分支调用 `agent()` 的瞬间秒表走表；无 `await` 的死循环、`await new Promise(() => {})`、只自我唤醒不调 ctx 的脚本三者都在 60 秒内 `script_stalled`；`RLIMIT_CPU` 在 runner 被 SIGKILL 后仍终止失控的 script host；`log()` 刷到 `maxNotes` 即硬错误；接管后 `activeMs` 与 `cpuMs` 从 `activity` 行恢复，误差不超过 60 秒。
16. **契约文件名**：同一容器两次提交文件名不同，第二次收取不读到第一次的内容。
17. `maxResidentRuns` 生效；`paused` 下两进程 RSS 有测量记录。

**M2 飞书**：触发绑定、四种卡片、`signal()` 协议（裁决、content/version、逻辑等待与投递分离、持久化后确认、终端入口、重发）、取消、中断卡、控制命令走卡片。验收：slogan demo（去掉命名会话）；陌生人/旧 version/重复提交/content 变化分别被拒或作废；投递失败时终端仍能提交；daemon 重启后中断卡可续跑。

**M2 补充：webhook 触发。** 接入点新增 `target.kind: 'flow'`（`src/flow/trigger.ts`，daemon 经 `setFlowTriggerHandler` 注册进 `POST /api/trigger`）。前置链路（connector 校验、限流、幂等、目标群解析、审计）与 turn 触发共用；daemon 内：目标群须为本 bot 所在真实群（core-only / 沙箱 bot 拒绝）→ 发话题种子拿 rootId（或复用请求指定的 rootMessageId，须属于目标群）→ 绑定 `{sessionId: null, ownerOpenId: null, triggeredBy: 'webhook:<connectorId>', trigger: {...}}` 起 run → 事件 `{triggerId, source, envelope, instruction?}` 作为 `input`。脚本路径只来自 connector 配置，事件体决定不了跑什么。`waitForFinalOutput` 等终局：结束（含 failed/canceled）返回 `ok:true` 与 `flow.returned`；超时 `wait_timeout`、runner 中途退出 `flow_interrupted`，二者都被幂等层视为「已投递」，重试不再起第二个 run。验收：`test/flow-trigger.test.ts`（纯层）、`test/webhook-routes.test.ts`「flow connector target」、`test/connector-api.test.ts`「flow targets」、`test/ipc-trigger-flow-route.test.ts`、`test/flow-daemon-manager-e2e.test.ts`「webhook 触发」（真 runner：无 owner 绑定、事件进 input、wait 超时、群成员在卡上提交、同步拿回返回值）。

**M3 沙箱与 outbox**：script host 进沙箱；扁平 outbox 绑定与收取；owner env 两层；bwrap `--unshare-user --unshare-cgroup` 下的 `contained` 档（v2 `nsdelegate` 宿主），含三项边界核验。验收：沙箱话题下三路扇出；脚本内 `fetch`/读文件被拒；outbox 内放置 symlink 与子目录不影响收取；同 identity 两个 attempt 证据互不覆盖；核验三项成立才记 `contained`，缺任一项记 `cooperative`；沙箱内探测进程迁出成功 → 拒绝运行；沙箱内建出的子组被递归回收。

**M4 命名会话**：key 链、并发拒绝与配置冻结、checkpoint 协议、`verify` 档、闲置挂起。并行 spike：Claude 候选 `exact`（含 compaction）。验收：「第 1 轮超时后第 2 轮不得命中」；`verify` 不一致进入待决策；`--continue-session` 后旧缓存全部失效；同一会话多回合契约文件互不串读。

**M5 宿主资源与作者体验**：daemon 侧槽位、宿主级槽位文件、host-overload 集成；skill 文档（原语、分支 ctx、编程约束、错误代数、待决策处置）。验收：两个 bot 的 run 合计不超过宿主槽位；一个 bot 只凭 skill 写出并跑通新脚本。

## 12. 体量

| 模块 | 估算（行） |
|---|---|
| runner：`withRunOwnership`、代次、接管、锁实例假死、心跳、journal、两步投影与完整性校验、重放决策、决策持久化、三状态秒表与失速看门狗、CPU 采样 | 1,700 |
| 容器：三条回收路径、能力探测、证伪探测与边界核验、递归回收、run 级树扫描、逃逸检测、bootId | 650 |
| script host：`vm` 受限 global 与 Proxy 桥接、`RLIMIT_CPU`、ctx RPC、显式 scope 与生命周期、组合器、静态检查 | 700 |
| agent worker 协议与 glue（复用 PtyTurnRunner）、attempt 生命周期、入容器握手、意图授权握手 | 550 |
| 命名会话：key 链、checkpoint、三档恢复、闲置挂起 | 600 |
| 信号协议：裁决、content/version、逻辑与投递分离、终端命令、卡片改造 | 700 |
| JSON Schema 子集校验器 + repair | 350 |
| outbox 绑定与收取、沙箱下 script host | 450 |
| 槽位与常驻上限：条目结构、`pending_reclaim`、daemon 清扫器 | 450 |
| CLI 与 skill | 750 |
| 合计 | 约 6,900 |

测试约 3,600 行（故障注入用例占比高）。复用现有约 2,000 行。不引入新依赖。

## 13. 运行目录

```
~/.botmux/data/flow-runs/<runId>/
  run.json              # 缓存：元数据、binding、status、health、gen、holder、containment、activeMs（daemon 启动时扫描；写即核对，陈旧时由 journal 重建）
  run.lease             # {holderPid, holderIdentity, gen, heartbeatAt, acquiredAt}；唯一的 withFileLock target
  run.lease.lock        # withFileLock 自动生成的锁文件（{pid, procStart, bootId}），保护本目录内全部共享状态的写入
  journal.jsonl
  script.snapshot.mjs
  processes.json        # 容器登记：container、cgroup 路径、attempt、pid、pidIdentity
  outbox/<container>/response-<gen>-<turn>-<idhash>.md   # 扁平，绑定给 CLI 的可写区
  agents/<identity>/attempts/<gen>-<n>/                   # 宿主私有：pty.log、screen.txt、response.md、evidence.json
  sessions/<name>/      # handle、checkpoint、orig.gen<g>
~/.botmux/data/flow-host-slots.json   # 条目 {runId, gen, container, cgroupPath, holderPid, holderIdentity, state}
/sys/fs/cgroup/.../botmux-flow/<runId>/c-<gen>-<n>/   # 容器（含探测容器 c-<gen>-probe）
```

## 14. 第六轮 review 意见对照

| # | 意见 | 处置 | 章节 |
|---|---|---|---|
| 1 (P1) | `vm` 受限 global 保证不了只有两种激活来源：`Atomics.waitAsync` 纯内建自主唤醒（Node 22 / Bun 1.4.0 实测先发静止、80 ms 后继续）；ctx 宿主函数经 `constructor` 取回宿主 API；Node 官方声明 `vm` 非安全隔离 | 撤回 `quiescent` 协议；秒表与看门狗只用 runner 侧三条事实（在途 attempt 数、外部等待数、脚本是否返回）；纯计算由 CPU 预算约束（runner 采样 `maxScriptCpuMs` + 内核 `RLIMIT_CPU` 兜底）；`vm` 受限 global 降为卫生措施，另删 `SharedArrayBuffer`/`Atomics`/`FinalizationRegistry`/`WeakRef`，桥接函数用 context 内 Proxy 包裹但不当边界 | §9、§10 |
| 2 (P1) | 按 holder 存活性回收槽位会在容器清空前释放容量，与「容器为空后才释放」冲突 | 条目关联 `runId/gen/container/cgroupPath`；holder 死亡只置 `pending_reclaim` 并继续计入占用；释放只由「该 run 的下一任 runner 改记后回收」或「daemon 清扫器按 cgroupPath 幂等回收」确认子树为空后进行，锁内比较保证只释放一次；验收补「旧 runner 已死、容器非空、另一 run 申请」用例 | §9、§11 |
| 3 (P1) | 自首次超时累计 60 秒不能作为杀当前持锁者的依据：锁可能已释放、换人或被同一进程重新获取 | 按同一锁实例（锁文件 inode + ctime + payload `{pid, procStart, bootId}`）的连续占有计时，实例或持有者变化、心跳有进展即重置；发信号前重新核验；杀死并确认退出后交 `withFileLock` 陈旧回收；「最多等 60 秒」改为「连续占有 60 秒到期启动回收」，典型总耗时 70–80 秒；验收补实例变化与换人两条对照用例 | §6.2、§11 |
| 4 (P2) | 静止 ≠ 等待可恢复的外部事件：`await new Promise(() => {})` 会停表、解除看门狗并永久占常驻名额 | 「无锚点」状态：无在途 attempt、无外部等待、脚本未返回 → 走表，连续 60 秒无新 ctx 调用即 `script_stalled`；该状态完全由 runner 判定 | §9 |
| 5 (P2) | `withFileLock(<run>/lease.lock)` 与 `withFileLock(run.lease)` 实际是两把锁（helper 自动追加 `.lock`），临界区可同时进入 | 唯一 target `run.lease`（锁文件 `run.lease.lock`），唯一入口 `withRunOwnership(runDir, expectedGen, fn)`；假死检查读同一把锁；目录示意同步修正 | §6.2、§13 |

## 15. 前五轮意见对照（摘要）

| 轮次 | 意见 | 处置 |
|---|---|---|
| 一 | 会话序号不代表状态；cwd 入 key | 会话 key 链；`realpath(cwd)` 与 `execConfigDigest` 入 content |
| 一 | occurrence 不可互换 | 结构化身份 → 显式分支 ctx |
| 一 | terminal 混合两件事 | category / retry / effects 三维度 |
| 一 | 聚合吞错；守恒不足 | 组合器不 catch；settled 与 status/health 分离 |
| 一 | 排他与父死子亡 | lease + 心跳 + 出生身份 + 代次；容器回收 |
| 一 | 信号迁移 | runner 裁决、持久化、version、content 绑定 |
| 一 | 脚本权限边界 | script host 受限进程 |
| 一 | outbox 与 attempt 隔离 | 扁平 outbox，attempt 目录 |
| 二 | 裸 `Promise.all` 静默错配 | 显式分支 ctx，同 ctx 重叠即硬错误 |
| 二 | O_EXCL + gen 不完整 | `withFileLock` + 出生身份 + 心跳围栏 + 握手 |
| 二 | 会话缺顺序与真实边界；Claude 非 exact | 拒绝并发、冻结配置；checkpoint 协议；候选 exact 单列 spike |
| 二 | `paused` 死锁；信号缺 content 约束 | `paused` ≠ `interrupted`；wait/signal 绑定 content 与 version |
| 二 | 决策持久化 | `decision` 行；`--retry-uncertain` 有限集合 |
| 二 | per-host 实为 per-daemon；outbox 位置；`pattern` | 宿主级槽位文件；沿用沙箱 outbox；移除 `pattern` |
| 三 | `prompted` 判 `effects:none` 有窗口 | `send.intent` 先持久化再授权；有意图无结果一律 `uncertain` |
| 三 | 标记扫描证明不了回收；标记污染 fleet | cgroup 容器；探测失败拒绝；`FLOW_WORKER_ENV_KEYS` 边界清理 |
| 三 | 合法组合器下共享状态仍不确定；scope 缺生命周期 | 编程约束；ctx 撤销与未等待副作用报错（顺序释放已在第四轮撤回） |
| 三 | 代次投影冲突；gen 回退；示例缺 gen | 两步投影；所有行带 gen；`persistedMaxGen + 1`；提交顺序 |
| 三 | 常驻代价；时限口径；槽位释放；投递与等待；中间目录 symlink | `maxResidentRuns`；容器为空后释放；逻辑等待与投递分离；outbox 扁平 |
| 四 | 代次过滤丢掉已执行的意图 | 追加即核对；takeover 与 lease 同临界区；投影第一步降为完整性校验 |
| 四 | 按结算顺序释放缓存死锁；结算顺序决定不了交错 | 撤回；缓存按请求返回；确定性只对守约束脚本承诺；`--check-replay` |
| 四 | cgroup 缺「无权迁出」条件 | 分档（第五轮再收窄为命名空间边界）；worker 由 runner 移入容器 |
| 四 | v1 freezer 未等 FROZEN、不递归；outbox 文件名碰撞；`paused` 停表绕过时限 | 读回确认 + 递归回收；`response-<gen>-<turn>-<idhash>.md`；活动时间（第五、六轮两次修正） |
| 五 | 未应答数判不了可运行 | `quiescent` 协议（第六轮证伪后撤回，改为 runner 侧三事实 + CPU 预算） |
| 五 | 两项探测失败不足以授予 `contained` | 只认命名空间边界；探测只证伪；M1 一律 `cooperative` |
| 五 | `run.json` 在临界区外；容器可在清理完成后重建 | 写即核对推广到全部共享状态；记录与 mkdir 同临界区；入容器握手核对 |

## 16. 待定决策

1. `maxResidentRuns` 默认 8 是否合适，以及超出时是拒绝还是排队。
2. 宿主级槽位默认 16 与 per-daemon 默认 8 的取值。
3. `--unsafe-no-container` 是否保留，还是 M1 直接不提供。
4. `flow.requireContainment` 何时翻转为默认打开：M3 沙箱落地后？这意味着 v1 宿主（含当前 daemon 所在机器）永远只能 `cooperative`，是否接受。
5. 是否引入基于 uid 的中间档（非 root CLI + 全层级 `cgroup.procs` 权限遍历 + 每次回收前复核），还是维持两档。
6. v2 仅 `cgroup.freeze` 的路径（5.2–5.13 内核）是否值得保留。
7. `scriptSliceMs` 60 秒、`maxScriptCpuMs` 5 分钟（`RLIMIT_CPU` 取两倍）、`maxNotes` 1000、`decisionTimeoutMs` 7 天的取值。
8. daemon 清扫器是否允许对 `pending_reclaim` 条目直接回收容器（本稿：允许，理由见 §9），还是只标记、等 resume。
9. Claude 候选 `exact` spike 的通过标准。
10. 三个 `BotmuxEntry` 与 `src/flow/` 的最终命名。
11. 是否补 v3 的「按名保存 / 复用」：轻量档（约定目录 `<工作目录>/.botmux/flow/<名>.mjs` + 脚本 `export const inputs` 声明参数 schema + `/flow run <名> k=v` + `/flow ls` 列脚本，持久化仍是 git）还是完整档（`~/.botmux/flow-library/`，复刻 owner/scope/不可变 revision 与 `/flow save`）。本稿倾向轻量档（原则 1、10）。
12. webhook 触发（M2 已落地为接入点 `target.kind: 'flow'`）里事件体的注入防护放在哪一层：现在是脚本作者自己在拼 prompt 时标注 `envelope` 为不可信数据（文档约定）；是否要在 `ctx` 层提供一个把 `input` 包成 `<event trusted="false">` 的辅助，或在 launch 层强制。

## 17. 三方对比

| 维度 | v3 | acpus | Claude Code Workflow | 本设计 |
|---|---|---|---|---|
| 编排描述 | 静态 `dag.json` | TS DSL → IR | JS 脚本 | JS 脚本，显式分支 ctx |
| 执行单元 | `/goal` 多轮 | ACP 单回合 | SDK 内 Task agent | PTY 单回合 + 命名会话 |
| 调用身份 | nodeId | 图节点 | 内容哈希 | scope 位置 + 内容哈希 + 会话链 |
| 副作用确定性 | manifest | 状态机 | 无（失败不写行） | 所有权临界区内持久化意图 |
| 恢复 | journal + STATE | 持久化图状态 | 重放，失败自动重跑 | 重放；不确定即待决策并持久化 |
| 进程归属 | fence 文件 | daemon 锁 | 无 | cgroup 容器（命名空间边界才算 contained）+ lease + 写即核对 |
| 人在环 | 审批卡 | `runs signal` | 无 | `signal()`，逻辑等待与投递分离 |
| 跨 CLI | 是 | ACP 适配 | 否 | 是 |
| 引擎体量 | 36k | 56k（Effect） | 0 | 约 6.9k 新 + 2k 复用 |
| 触发 | 有自动触发 | 显式 | 显式 | 只显式 |
| 外部触发（webhook） | v2 有，退役 | 无 | 无 | 接入点 `target.kind: 'flow'`：事件 → 开话题 → 绑定 run，事件体为 `input`，可同步等返回值 |
| 按名保存 / 复用 | `workflow-library` + `/workflow save\|run <名>` + 蒸馏参数化 | 无 | 无 | **未做**：脚本是工作目录里的文件，靠 git 持久；无库、无 owner/scope、无参数声明（待定，见 §16） |

---

## 附录 A：acpus 体量与可达性分析（2026-09-04）

对 fork（上游 `kelvinschen/acpus` 0.15.1，单作者，2026-08 以来 114 提交，基于 `effect` 4.0.0-rc、TypeScript 7、`node:sqlite`）从三个入口做 import 可达性分析：全部 src 87.6k 行；删 web/dsh/tasks 与非核心 CLI 命令后 61.7k；再去 ACP 传输/会话、workflow import、runs delete/artifacts/picker 后 56.7k；进 runtime 内部砍 fork/steer/retry、generation 迁移、forensics 约 52k 但需读懂 Effect 调度代码。runtime 39.7k 行是引擎本体；workflow-compiler 4.8k 是 `workflow run` 必经的类型检查 + IR 校验；`expression` 包 1.2k 行是表达式语言。TypeScript 7 是原生 Go 二进制；esbuild 单文件 bundle 仅 4.0MB。我们对 fork 的改动只有 5 个文件 +130 行。

## 附录 B：《把 Claude Code Workflow 移植进 botmux：设计与取舍》要点

分析对象是 Claude Code 自带的 Workflow 工具，基于 botmux master `2fac180c`（2026-08-17）；引用的 botmux 代码位置已核对。设计核心：脚本是无 I/O 的纯控制平面；journal key 是内容哈希；默认 `pipeline`；schema 强制让下游 hash 稳定。实测缺陷：失败 agent 不写 result 行，350 started / 250 result 丢 28.6% 无一上报；全灭 run 仍 `completed`；`null` + `filter(Boolean)` 让 17 个脚本里 16 个判空都错。必改清单：`failed` 行、run 级断言与 `partial`、`{ok:false}` 哨兵、预算计 input+output、同脚本跑两遍第二遍 0 次调用。集成障碍 C（idle sweeper 竞态）、D（ephemeral 无 cap）、F（`workflow` 命名冲突）、G（`AskUserQuestion` 被禁、沙箱 journal 位置）对本设计同样成立，已在 §9、§10、§8 处理。

## 附录 C：spike 已验证的事实与 review 实验

- 隔离 HOME、真 acpus fork + 真 claude CLI：PTY 单回合执行、契约文件、结构化输出、sessionKey resume 复现前文（**未验证**能恢复到指定回合边界）、取消、坏 cliPath 证据；登录向导识别（`cli_needs_setup`，真 CLI 23 秒内失败）；飞书卡片链路与点击处理（mock 的是 acpus 裁决，§7 需新测试）。真飞书未验。
- review 实验：首轮 4 个测试文件 56 用例通过；第二轮 `test/file-lock.test.ts` 32 用例通过，模拟复现两版身份方案的结果互换；第三轮模拟 `++rank` 共享状态反例、临时进程验证空 env 后代逃逸标记扫描、临时目录验证 `materializeOutboxFile` 跟随父目录 symlink；第四轮最小投影模拟复现「物理 journal 有 `send.intent`、有效投影没有」、顺序脚本三代次模拟复现顺序释放的矛盾、Bun 1.4.0 微任务实验证明结算顺序决定不了交错；第五轮子进程实验复现「未应答数 1、两个条件皆假、script host 仍消耗约 44 ms CPU」；第六轮实验：`Atomics.waitAsync` 在 Node 22.22.2 与 Bun 1.4.0 下先发静止、81–82 ms 后自主继续；Bun 下 `codeGeneration.strings=false` 仍能经 ctx 函数 `constructor` 取到外层 `setImmediate`；`await new Promise(() => {})` 使旧模型停表并解除看门狗；临时目录证实 `lease.lock.lock` 与 `run.lease.lock` 两把锁可同时进入；临时子进程验证「按锁实例连续占有计时 → 核验 → 杀死 → 确认退出 → `withFileLock` 陈旧回收」的组合可行。
- 第六稿核对（保留为卫生措施的依据）：`node:vm` 的 `createContext` 在 bun 1.4.0 与 node 22 下，context 内 `setTimeout`/`setImmediate`/`process`/`fetch`/`queueMicrotask`/`MessageChannel` 均为 `undefined`，`Promise`/`Array`/`JSON` 可用，微任务正常执行（scratchpad `vm-probe.mjs`）。这只说明宿主全局不可见，不说明没有其它激活来源。
- 宿主核对：daemon 所在宿主 Linux 5.15、cgroup v1 混合模式、root 下 `/sys/fs/cgroup/freezer` 与 `pids` 层级可写。
- 内核文档核对（本稿）：v2 `cgroup.kill` 「杀死该组与所有后代组内进程……处理并发 fork 并防止迁移」；v2 `cgroup.freeze` 冻结完成体现在 `cgroup.events` 的 `frozen 1`；`cgroup.events` 的 `populated` 表示本组或后代组是否仍有活进程；v1 freezer 写 FROZEN 后读回可能为 `FREEZING`，「所有任务冻结后才转为 FROZEN」，「新任务加入本组或后代组后从 FROZEN 退回 FREEZING 直到该任务冻结」，冻结覆盖后代组；v2 委托限制：非 root 写者需对目标与公共祖先的 `cgroup.procs` 都有写权限，`nsdelegate` 下命名空间是委托边界。
