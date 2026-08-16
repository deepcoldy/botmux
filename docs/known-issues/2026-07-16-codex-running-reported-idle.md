# Codex 任务运行中误报“等待输入 / idle”

> 状态：已 rebase 到 origin/master（commit 12678852 基底 19893f1e）；冲突已消解；focused unit 135/135 PASS；tsc 仅见上游 desktop/electron 既有噪声；尚未 push / 开 PR / live E2E
> 日期：2026-07-16 ｜ 严重度：高 ｜ 建议 PR：`fix(codex): pending turn 不再误报等待输入`

## 用户反馈与证据边界

问题入口是外层转发的飞书消息 `om_x100b6a4c39de2cb4c37ceab580a1735`，其中用户原话为：

> “但是我看他已经是等待我输入状态了？真的在工作吗。。”

已确认的观察是：转发上下文中 Codex rollout 仍继续产生进展，而 Dashboard API 已把会话投影为 `idle`，飞书流式卡片同时显示“等待输入”。

证据存在以下边界：

- 上述 ID 是外层转发消息 ID，不是原会话 source message ID；原消息 ID 与精确时间未保留。
- 当时的 worker 日志、完整 rollout、Dashboard 原始响应和卡片 payload 没有形成统一时间线。
- 因此这是有真实用户反馈与运行观察支撑的缺陷，但不是已经补齐的线上可复现包；本文不会把本地测试称为线上复现或 E2E 证据。

## 问题现象

当结构化 transcript 中仍有已提交或已开始、但尚未出现 `assistant_final` / `turn_aborted` 终态的 turn 时，CLI 屏幕可能短暂出现 prompt，或 PTY 进入静默。旧逻辑随后会：

1. `IdleDetector` 把屏幕 prompt / 静默判断为 ready；
2. `markPromptReady()` 立即把 `isPromptReady` 设为 `true`、发送 `prompt_ready` 并清空 in-flight 输入；
3. 即时 `screen_update`、后续周期 tick 与截图上传把状态投影为 `idle`；
4. Dashboard 与飞书卡片共同消费该投影，因此同时误报“等待输入”。

实际 runner 并没有完成。这是 **false idle（假空闲）**，可能诱发重复提问、不必要的重启，或把仍在运行的会话当作可回收空闲 worker。

## 根因

旧实现混淆了两类信号：

| 信号 | 实际含义 | 可靠性边界 |
| --- | --- | --- |
| screen prompt / PTY quiescence | 当前 UI 看起来可输入或暂时静默 | 启发式；不能证明 turn 已结束 |
| adapter/history submit confirmation | 输入已被 CLI 的提交历史明确记录，但 type-ahead 时 transcript user event 可能尚未写入 | 可作为短时 hand-off 证据；必须有界，不能永久压制 ready |
| structured transcript lifecycle | transcript 已出现 user/start，直到 `assistant_final` 或 `turn_aborted` 关闭 | 对任务完成更权威；worker 侧 mark 本身不能证明输入已进入 CLI；中断终态不应伪造回复 |

`CodexBridgeQueue` 已经维护了 pending、started 和 terminal 的 turn 生命周期，但状态投影没有使用它作为门控。即使只在 `markPromptReady()` 的即时 idle 更新上补条件，`startScreenUpdates()` 的周期 tick 和截图路径仍能重新写入 `idle`，所以零散条件不是完整修复。

## 修复方案

本修复让结构化 turn 生命周期优先于屏幕启发式，并把所有展示入口收敛到同一个状态投影：

1. `CodexBridgeQueue.hasBlockingTurn()` 把 transcript 已 started、且尚无 `assistant_final` / `turn_aborted` 的 Codex turn 视为强运行证据。单纯 worker mark 不参与状态门控。强门控通过显式 allowlist **只对 Codex 开启**；其他 structured driver 继续使用共享队列做归属与输出，但在补齐全部正常、异常和中断终态契约前，不用 started turn 永久压制 screen-ready。
2. worker 在每一条 fresh/type-ahead 输入和每一次 adopt 输入写入前，都先同步把 `isPromptReady` 置为 false 并 re-arm `IdleDetector`，再记录 `submitVerificationStartedAtMs`、进入 `await writeInput()`。在 Codex strong-gate 路径，history 轮询的数秒内若 screen-ready 先到，会被 30 秒的有界 verification lease 拦住；若极快 turn 的 `assistant_final` 先于 history 轮询返回，final edge 也已经有可用的 detector 接收，不会在 await 返回后被一次迟到 reset 擦掉。若 adapter 提供 20 秒 deferred recheck，则正常复核路径内 verification lease 保留到复核结束；状态门控硬上限仍为 30 秒，adapter promise / recheck 卡死时不会永久压制 ready。
3. 对 adapter/history 已明确验证成功的提交，verification lease 原子切换为 `submitConfirmedAtMs`，在 transcript start 之前提供 20 秒的 hand-off lease。Codex 与 CoCo 只有实际 history 命中才返回 `submitted: true`；CoCo 新安装、history 尚不存在的“信任 Enter”路径仍返回 `undefined`，不会被误当成强证据。只有 Codex allowlist 会把该 lease 投影为 `working`。
4. CoCo 等 type-ahead 时，下一条提交可能在上一条运行期间一直没有 transcript user event。上一条 `assistant_final` 到达时，会以**本机观察到该事件的时间**刷新下一条 confirmed lease 或 attribution-only lease，从真实 dequeue 边界重新计时；不使用 transcript 自带时间戳，避免外部时钟偏移把 lease 拉长到分钟/小时或让它立即过期。这是共享队列归属与清理语义；非 Codex driver 不因此获得 screen-status strong gate。
5. `markPromptReady()` 遇到 blocking turn 时拒绝本次 screen-ready 信号，不发送 `prompt_ready`、不清空 in-flight 输入，并保存这次 ready evidence、重置 `IdleDetector`。started turn 由后续 `assistant_final` 或 `turn_aborted` 重驱；verification/confirmed lease 在状态切换或到期时主动重驱。如果期间出现新 PTY 输出，则重新检查当前 screen，而不是盲信旧 prompt。新输出证据使用单调递增的 PTY generation，而不是毫秒时间戳，因此同一毫秒内先后到达的两个 chunk 也不会被误判成“没有新输出”。grace timer 同时绑定创建时的 backend 对象和 `cliSpawnGeneration`，并拒绝 `cliRestartInProgress`；即使 restart 的 async teardown 尚未替换 backend 对象，旧 timer 也不会 prune/replay 或重驱新 generation。
6. 即时更新、周期 `screen_update` 和截图上传统一调用 `projectRuntimeScreenStatus()`：在 Codex strong-gate 路径，即使 prompt 可见，只要存在 started turn、仍在验证中或仍在 confirmed lease 内，就保持 `working`；`analyzing` 与 usage-limit 的既有优先级保留。周期 tick 还把异步 tmux / observe snapshot 和状态投影绑定成“先完成 snapshot、再读取最新 lifecycle”，避免 tick 以 idle 开始、snapshot 期间新 turn 已启动、最后却晚发旧 idle。
7. submit 的延迟复核确认失败时，只删除仍未 started 的结构化 mark；不会凭空触发 `fireIdle()`。延迟复核若确认成功，则原子切换到 confirmed lease；若 history 仍未命中、但 PTY / structured transcript / `botmux send` 已证明 CLI 活跃，也转成同样有界的 confirmed lease，而不是留下无法过期的 bare head。其他未确认结果结束 verification、刷新 attribution-only lease，并重驱此前被拒绝的 ready。已经 started 的 turn 不允许被失败清理路径删除。所有 begin / confirm / finish / drop 都匹配 `(turnId, dispatchAttempt)`；延迟复核同时绑定创建时的 CLI generation 与 backend，并在 adapter recheck 的 await 前后重复核对。Claude fallback 的 turn ID 属于 `BridgeTurnQueue`，只有 Codex structured mark 才启用 `CodexBridgeQueue` exact-target 检查，避免把所有 Claude deferred recheck 误判为 stale。
8. 删除失败的队首 mark 后，会把因 head-of-line fingerprint 不匹配而缓存的近期 user / assistant / abort events 继续保留并重新匹配到下一 turn；即使连续两个队首都失败，第三个成功 turn 也不会在第一次重放时丢失。对 confirmed 或 attribution-only lease 到期、但仍未 started 的**队首**也执行同样清理：若有 started predecessor 则绝不提前清理，等待其 terminal event 刷新下一条 lease；若到期边界恰好到达的是该队首自己的 matching user event，则先允许它转为 started；只有不匹配的 stale head 才会被移除并重放 buffered successor。状态查询保持纯读取；所有 prune 都只发生在 worker 的显式 ingest / timer 边界，并在同一调用栈立刻 drain 可发送 completion，避免重放出 user+terminal 后反而把 completion 留在队列里等“下一条事件”。CoCo adopt 改为走同一 adapter/history 确认路径，但其 screen-status strong gate 仍未开启。
9. Codex transcript 新增 `event_msg.payload.type=turn_aborted` 解析。中断会关闭 started lifecycle、释放 ready gate，但不会生成假的 assistant 输出；非 adopt 路径中暂时无法归属的 abort 会与其他近期 event 一起缓存，stale head 清理后再重放给正确 successor。
10. 最新上游 native `/rename` 与 adopt 输入共用 TUI，需要避免管理员命令和用户消息交错。rename 使用 `idle → reserved → writing → sent` 四阶段：排队等待期间进入 `reserved`，从开始写文字到 Enter 的 await 完成前保持 `writing`，只有 Enter 真正落地后才进入 `sent`，且只有 `sent` 状态观察到的新 prompt 才能释放。异常写入也只通过同一 bounded fail-open window 释放，避免把半条命令与后续输入拼接。raw input、bundled follow-up、adopt message 与 rename 共用串行顺序；旧 turn 的快速 final 无法误清尚未发送或尚未完成 Enter 的 rename。
11. adopt serial queue 是 process-lifetime 对象，因此每个排队任务都捕获 `{ cliSpawnGeneration, backend }`，并在真正 dequeue、transcript mark、raw Enter、bundled follow-up 与 adapter await 返回后核对；`cliRestartInProgress` 和 `rawInputRestartGate` 也属于 replacement-ready fence。尚未开始任何写入的 stale bundle 才能整包回队；若 raw command 写入期间检测到 generation/backend 已变化，则明确提示 ambiguous，并 withholding 依赖它的 follow-up，要求用户核对后整包重试。绝不把 `/cd ...` 等前置命令的 follow-up 单独投进不确定 repo/session 的 replacement CLI。既有 write exception 路径即使可能已部分写入，也仍只记日志并 withholding follow-up；本文不把它误写成已经具备用户可见 reconciliation。
12. normal non-adopt flush 同样在 `await writeInput()` 前捕获 generation、backend 和 adapter，并把 await 成功/异常后的 generation check 放在 busy probe、session ID 持久化、bridge notify、ready redrive、deferred timer 与用户提示之前。旧 ordinary continuation 不修改全局 bridge queue、也不额外告警，因为 crash carryover 可能已用同一 `turnId + dispatchAttempt=undefined` 在新代重建 mark；durable input 不走 ordinary carryover，只发送对应 exact-attempt ambiguous terminal。
13. `assistant phase=final_answer` 即使 `output_text` 为空也保留为正常 terminal event。queue 用空 `finalText` 表示“完成但无可见输出”，worker 跳过 `final_output`，但仍发送 exact-attempt `completed turn_terminal`，避免把合法空答复误留成永久 running。
14. confirmed / attribution-only 的 pre-start lease 到期并删除 stale head 时，该 prune boundary 同时是 durable delivery 的终态边界：每个带 `dispatchAttempt` 的 dropped turn 先发送 exact `ambiguous / structured_start_timeout` terminal，再 drain 因 replay 暴露的 successor completion。这样 attempt N 在约 20 秒有界自愈时就交还 receiver，而不是让 `durableTurnInFlight` 继续阻塞到 daemon 的 15 分钟 watchdog；无 `dispatchAttempt` 的普通 turn 仍只记录日志。

### 后续审计发现并关闭的十八个 blocker

1. **Deferred activity 只 suppress 告警、没有收口 lifecycle**：延迟复核未命中 history、但出现 CLI activity 时，旧补丁会清掉 verification，却把 bare fingerprint 永久留在队首。现在由 `settleDeferredSubmitConfirmation()` 统一完成“决策 + lifecycle 结算”；activity evidence 会建立有界 confirmed lease，其他未确认结果进入有界 attribution-only lease。
2. **Adopt 并发写会交错 composer 与 Enter**：两个 IPC listener 可同时进入 CoCo/Codex 的 paste → wait → Enter/history 流程，造成后一条内容覆盖前一条 composer、确认结果串 turn。现在普通 adopt message 与 adopt `raw_input` 共用同一个异步串行队列，队列覆盖 transcript mark、完整 adapter write、确认/失败处理；`raw_input` 的 bundled follow-up 不再走 `sendToPty()` 的 fire-and-forget flush，而是在同一个 queue task 内直接 `await writeAdoptMessage()`，直到 adapter write、history verification 与 structured lifecycle 结算全部完成，才允许下一条 adopt message 使用 composer。非 adopt 仍保留原 pending/type-ahead 路径。
3. **同毫秒 PTY 输出绕过 rejected-ready 失效判断**：只比较 `Date.now()` 时，两个 chunk 可能共享毫秒时间戳，timer 会误信旧 prompt。现在每个真正送入 `IdleDetector` 的 chunk 都递增 generation；重驱只接受仍为当前 generation 的 evidence，spawn/kill 时一并重置。
4. **Hermes / Pi / MTR 的 `writeInput()` 返回 `undefined` 会留下永久 bare head**：每个 mark 现在从创建起都有 20 秒 attribution-only lease；它不参与 `hasBlockingTurn()`、不制造 false busy，verification 活跃的 30 秒内又不会被提前清理。verification 无确认结束时从本机完成时间刷新该 lease，started predecessor 完成时再刷新下一合法 head。1 秒 bridge ticker 的 `finally` 无条件执行显式 prune → replay → 同栈 emit，因此即使 transcript 尚未 attach、offset 没推进或本 tick 没有新 event，也能自动清掉 silent-write head；同一边界到达的 matching event 始终先 ingest、后 prune。
5. **迁到最新上游后 native `/rename` 会与 adopt composer 竞态**：最初实现只用布尔 in-flight，排队等待期间的旧 final 可以过早清锁。现在先用 `reserved / sent` 区分“已占位但未写入”和“Enter 已写入”，并让 rename、raw follow-up 与 adopt message 走同一串行写队列；第 11 项继续封住实际 text→Enter await 窗口。
6. **Codex interrupt 只写 `turn_aborted`，没有 `assistant_final`**：若只认 final，started turn 会永久阻塞。现在把 abort 作为无输出 terminal event，既释放 lifecycle，又不伪造回答。
7. **把强 started gate 扩到所有 structured CLI 会制造新的永久假忙**：TRAE、CoCo、Hermes、MTR、Pi、Grok、Cursor 的正常/异常/中断终态契约并不都完整。现在强 gate 是 Codex-only allowlist；共享队列的归属、清理和输出能力不等于这些 CLI 已获得完成态保证。
8. **split-live late attach 一次读到 terminal 时 ready 重驱会延迟**：late attach 直接 ingest 已完成 live turn 时，原实现可能等 20–30 秒 lease timer。现在同一批次观察到 final/abort 后立即 `fireIdle()`，与正常增量 ingest 的终态路径一致。
9. **最新上游把 Codex 标成 reliable terminal 后，abort 只释放 idle gate 却不结算 durable receipt**：早期 Issue2 语义为 `turn_aborted` 直接删除 started lifecycle，确实不会伪造 assistant 回复，但 `fa9914f2` 的 Codex adapter 已声明 `reliableTurnTerminal=true`，这样会让会议投递一直等不到 exact-attempt `turn_terminal`。现在 abort 以空 `finalText`、`ambiguous` terminal 和安全错误码关闭 queue：worker 的空文本 guard 不发送 `final_output`，随后 terminal loop 仍发送带原 `dispatchAttempt` 的 `turn_terminal`；后继 lease 刷新语义保持不变。
10. **Attempt N 的延迟 submit callback 会落到 replay N+1**：只按 `turnId` begin / confirm / finish / drop 时，N 到期重启后复用同一 delivery key 的 N+1 会被旧 timer 修改。现在所有 lifecycle 方法与 deferred target check 都匹配 exact `(turnId, dispatchAttempt)`；generation/backend fence 在 recheck await 前后核对，stale callback 不再持久化旧 session ID、redrive、递归设 timer、发 terminal 或告警。
11. **Rename 的 `sent` 状态在 Enter await 前过早建立**：旧 final 若恰好落在 text→200ms→Enter 窗口，就能释放 gate，让用户输入插进半条命令。现在该窗口显式为 `writing`，仅 Enter promise resolve 后进入 `sent`；异常也通过 bounded fail-open 收口。
12. **Process-lifetime adopt queue 可能跨 CLI generation 写入**：旧排队任务在 restart 后可能对 `backend=null` 做 mark，或直接写到 replacement CLI。现在 ordinary adopt、raw command 和 bundled follow-up 都使用 generation/backend/restart-ready fence；dequeue 前 stale 可安全重排，检测到 generation gap 的 partial write 会明确 ambiguous。与 generation 无关的既有 raw write exception 仍仅写日志并 withholding follow-up，不在本 blocker 中宣称已补通知。
13. **空的正常 `final_answer` 被 parser 当成“没有终态”**：`if (!text) continue` 会让无输出但正常完成的 turn 永久阻塞 reliable terminal。现在 parser 保留空 normal final，queue 关闭 completed lifecycle，worker 只抑制空 `final_output` 而不抑制 exact terminal。
14. **Normal `writeInput()` 的 await continuation 会跨代产生副作用**：旧 backend await 返回时可能已经完成 restart，随后却用新全局 backend 做 busy probe、持久化旧 session ID、notify/redrive 或再设 timer。现在 resolve 与 reject 两条 continuation 都先检查捕获的 generation/backend/adapter。ordinary stale continuation完全交给已有 crash carryover，不删除新代同 ID mark、不诱导手动重复重试；durable stale continuation只发 exact ambiguous terminal。
15. **Claude deferred recheck 被 Codex exact-target 检查误杀**：Claude 与 structured path 共用 schedule，但 Claude `bridgeTurnId` 只存在 `BridgeTurnQueue`。现在 exact structured target 是显式 opt-in；Claude 仍受通用 generation fence 保护，同时会正常执行 `submitted:false` recheck、告警与 mark cleanup。
16. **Adopt raw bundle 在前置命令不确定后单独重放 follow-up**：例如 `/cd <repo>` 已向旧 backend 写入后 generation 改变，旧实现会把 dependent prompt 单独 push 到 replacement，可能在错误 repo/session 自动执行。现在只有 raw 写入前 stale 才整包 requeue；raw 已写或 Enter 后的任何 generation gap 都 withholding follow-up、提示核对并要求显式整包重试。
17. **Structured ready-grace timer 只比较 backend 对象**：`restartCliProcess()` 在 jitter/async teardown 前已经递增 generation、拉起 restart fence，但 backend 仍可能是同一个对象；旧 timer 会在此窗口 prune/replay 旧 queue。现在 timer 捕获 generation + backend，并要求 `!cliRestartInProgress`；stale callback 无 queue/status/redrive 副作用。
18. **Durable pre-start lease 到期只 prune、不发 terminal**：旧 common helper 会删除 attempt N 并先 emit replay 暴露的 successor，却不发送 N 的 exact terminal；`durableTurnInFlight` 因而可能继续阻塞相邻输入，直到 15 分钟 daemon lease 强制重启。现在七个 prune callsite 仍统一进入同一 helper，但 helper 在 successor emit 前先回调 dropped turns；worker 只对带 `dispatchAttempt` 的项发送 `ambiguous / structured_start_timeout`，并用 exact attempt 与顺序测试锁定 N terminal → N+1 completion。

Codex 状态顺序变为：

```text
message written
  → bridge mark（本身不覆盖 screen 状态）
  → submit verification begins（bounded；先于 await writeInput）
  → adapter/history 明确确认提交
  → verification 原子切换为 bounded confirmed-start lease = working
  ↘ 若 adapter 无权威返回：bounded attribution-only lease（不改变 screen 状态）
     → matching transcript user，或到期后显式 prune/replay
  → transcript user event started
  → started + unfinished = working（不再受 lease 到期影响）
  → screen prompt / quiet (只作为启发式，状态仍 working)
  → assistant_final（正常完成并可输出）
     或 turn_aborted（中断完成，不伪造输出）
  → 若有下一条 type-ahead：刷新其 confirmed / attribution-only bounded lease
  → 否则 blocking turn = false
  → transcript terminal fireIdle
  → prompt_ready + idle
```

## 前后效果

### 修复前

- prompt glyph 或静默可以先于 rollout 完成把状态切到 `idle`；
- 即时更新即使被局部抑制，下一次周期 tick 或截图仍可覆盖为 `idle`；
- false idle 会提前清空 in-flight tracker，并可能释放仅应在真实 ready 后投递的输入；
- Dashboard 和飞书卡片使用同一错误状态，无法互相校正。

### 修复后

- Codex transcript-started unfinished turn，或处于 bounded start lease 的已确认提交存在期间，即时、周期和截图三条路径都不会报告 `idle`；
- screen-ready 不再提前发送 `prompt_ready` 或清空 in-flight 输入；
- `assistant_final` 或 `turn_aborted` 到达后都能正常收敛为 `idle`，不会因为拒绝过一次 false-ready 而丢失真正的 ready edge；abort 只关闭 lifecycle，不生成不存在的 assistant 回复；
- history 轮询 / deferred recheck 尚未返回期间，不会先发布 ready 再迟到确认；
- 极快 turn 即使在 `writeInput` 的 submit verification 返回前已经产生 `assistant_final`，完成 edge 也不会被迟到 reset 吞掉；同一轮 flush 中的每条 type-ahead 输入都会单独 re-arm，不复用上一条已 idle 的 detector 状态；
- type-ahead 的下一条已确认提交不会在上一条刚结束、transcript 尚未 dequeue 的间隙误报 idle；
- 已确认但始终未 started 的 stale 队首在 bounded lease 到期后会被安全清理并重放 buffered successor，不会继续挡住后续真实 turn 的 started lifecycle；started predecessor 和边界上刚到达的 matching user event 都受保护；
- durable stale 队首被 bounded prune 时会先发送 exact `structured_start_timeout` ambiguous terminal、释放 receiver ownership，再发送 replay 后已完成的 successor；不会从约 20 秒自愈退化为 15 分钟 watchdog 等待；
- adapter 返回 `undefined` 或 silent write 时，unconfirmed mark 只在 attribution-only lease 内保留且从不压制真实 prompt；1 秒 bridge tick 即使没有新 event 也会显式清理到期 head，并重放/发送完整 buffered successor；
- deferred activity evidence 不再只 suppress 告警而遗留永久 head；它被结算成有界 lease，确认失败时仍只清理对应 unstarted mark，不伪造 ready；
- adopt 的普通消息、slash command 和 bundled follow-up 不会再跨 IPC 交错 composer / Enter / history confirmation；raw Enter → follow-up 完整 settle → 下一 adopt message 的顺序由同一个 serial queue transaction 保证；
- native `/rename` 在 idle、排队 reserved、text→Enter writing、等待新 prompt 的 sent 四个阶段间保持明确状态边界，不会与用户输入交错；旧 turn 的快速 final 不能提前释放尚未发送或尚未完成 Enter 的 rename；
- CLI restart / replacement 期间，旧 deferred timer、structured grace timer、normal write continuation、adopt/raw queued task 都不会把旧 generation 的 session、terminal、queue prune 或输入副作用落到新 generation；ordinary crash carryover 重建的同 ID mark也不会被旧 continuation 删除；
- raw command 与 dependent follow-up 保持语义原子：只有完全没写入时才整包重排；前置命令可能已落入旧 backend 后，follow-up 会被 withholding，不会在 replacement 的未知 repo/session 自动执行；
- 正常空 `final_answer` 会完成 lifecycle 和 durable receipt，但不会生成假的空回复；Claude 的 deferred submit recheck 仍沿用其自己的 BridgeTurnQueue 归属，不被 Codex queue 的 exact-attempt 检查误杀；
- split-live late attach 若一次读到已完成 turn，会在同一批次立即重驱 ready，不再无谓等待 lease timer；
- rejected-ready 在同一毫秒出现后续 PTY chunk 时也会失效并重新检查当前 screen；
- 周期 snapshot 期间若新 turn 启动，tick 会按 snapshot 完成后的最新 lifecycle 发 `working`，不会晚发 snapshot 前缓存的 `idle`。

## 影响面与兼容性

- **CLI**：强 started-turn 状态门控目前只对 **Codex** 开启，因为 Codex parser 已覆盖正常 `assistant_final` 与中断 `turn_aborted`。TRAE、CoCo、Hermes、MTR、Pi、Grok 和 Cursor adopt 仍可使用共享 `CodexBridgeQueue` 做 turn 归属、输出与 stale-head 清理，但不声称它们已具备完整终态契约，也不会用 started turn 永久压制 screen-ready。bounded verification/confirmation 只有在 Codex strong-gate 路径才影响状态；本修复对 CoCo adopt 的 adapter/history 串行化属于共享输入安全，不等于为 CoCo 开启 strong gate。
- **Backend**：不依赖 PTY、tmux、pipe-pane 或 observe backend 的截图节奏；这些 backend 仍产生原有 screen 信号，在 Codex 路径不能越过更权威的 lifecycle / bounded-confirmation 门控。没有可靠 submit 确认或 bridge 尚未 attach 时，未 started mark 不会造成永久假忙或永久 head-of-line 阻塞；1 秒 tick 会清理 attribution lease，ready 重驱会用 PTY generation 检查期间是否出现新输出。
- **Session**：Codex 覆盖新会话、resume/restore、late attach、type-ahead，以及可验证 adapter 的 adopt 结构化 turn；同时与最新上游 native `/rename` 生命周期协调。worker teardown 仍由既有 `clearPending()` 清理队列和 timer；deferred submit、normal flush continuation 与 process-lifetime adopt queue 都绑定 CLI/backend generation，replacement-ready 还要求 restart gate 已释放。
- **展示**：不增加状态枚举，也不修改卡片 schema、Dashboard API 或持久化格式；仍使用既有 `working / idle / analyzing / limited`。
- **输入**：新会话不改变 adapter 的按键、重试或 type-ahead 策略；Codex/CoCo 的“history 已命中但没有 sessionId”返回值从 `undefined` 明确化为 `{ submitted: true }`，只用于 bounded lifecycle hand-off。CoCo adopt 从通用 raw sendText 路径切到其已有的 bracketed-paste + history verification adapter，解决 adopt type-ahead 的同一空窗；所有 adopt 写通过共享 serial queue 保持原子顺序。无法验证的 fresh-install 以及 Hermes/Pi/MTR 返回 `undefined` 的路径使用 attribution-only lease，不冒充权威提交。
- **Adopt replacement 边界**：当前 worker 不支持 adopt backend 的 in-place replacement；restart/crash 路径不会把退出的 adopted CLI 换成新 generation 后继续 drain。因此“写入前 stale 可整包 park”只描述当前安全兜底，不声称未来 replacement 场景已经证明跨多个 stale raw bundle 的 FIFO。若后续引入 in-place replacement，需要用 sequence ID 或专用 stale-front FIFO 保序，不能用逐项 `unshift()`。

## 与 PR #443 的关系

2026-07-16 在迁移到 `fa9914f2` 后重新通过 GitHub API 核对：PR #443（`fix(codex): 修复提交重试和告警锚点`）仍为 `OPEN / Draft`，head `f6b4e0fb`，`mergeable=CONFLICTING / mergeStateStatus=DIRTY`、`reviewDecision=REVIEW_REQUIRED`，已有 `build=SUCCESS`。它处理 Codex composer 重驱、提交确认与告警 turnId，未建立 pending-turn 到展示状态的 lifecycle gate，也未覆盖周期 screen tick / screenshot 投影。

两者功能正交，但都触及 `worker.ts` 的 submit-failure 附近，后合并者可能需要做文本冲突处理。本修复没有复制或改变 #443 的重试节奏；如果 #443 后续合入，应保留“失败提交清理未 started structured mark”的语义并重新运行双方测试。

## 验证结果

### 已完成：最新上游迁移、重叠语义审计、focused / TypeScript / build 与 full A/B

最终工作树已迁到并重新验证于：

```text
origin/master = fa9914f2023e26833ceba6058e7364e4454c5c8e
branch HEAD   = fa9914f2023e26833ceba6058e7364e4454c5c8e
```

2026-07-16 收尾时重新执行 `git ls-remote origin refs/heads/master`，远端仍为上述 commit。全程没有 commit、push、开 PR、切换 live runtime 或 drop/pop stash。迁移前新的 include-untracked 快照 `8a14edf5bcdc85079365e36cde9a0241951a67b1`、上一轮快照 `110c00b1353c42da3aaa179b153b144e71de7947`，以及更早的 `8dd44143…`、`1e92e03f…`、`9d85b891…` 均保留。`stash apply --index` 没有修改工作树，随后使用不带 `--index` 的 `apply` 恢复并手工解决冲突，始终未 pop/drop。

`1b397073..fa9914f2` 是 1 个大型 merge commit，共 162 个文件（`+48193/-1961`）。它与本修复直接交叉 10 个路径：

```text
src/adapters/cli/codex.ts
src/services/codex-bridge-queue.ts
src/services/codex-transcript.ts
src/worker.ts
test/claude-turn-terminal-contract.test.ts
test/codex-bridge-queue.test.ts
test/raw-input-followup-atomicity.test.ts
test/session-rename-worker.test.ts
test/worker-durable-expiry-order.test.ts
test/write-input.test.ts
```

实际冲突位于 `codex-bridge-queue.ts`、`worker.ts`、`raw-input-followup-atomicity.test.ts` 与 `session-rename-worker.test.ts`。最终合并同时保留：

- 本修复的 Codex-only lifecycle gate、有界 verification/confirmed/attribution lease、terminal ready 重驱、PTY/backend generation、统一状态投影、串行 adopt/rename 写入；
- 上游的 durable `dispatchAttempt`、terminal status/error、restart fence、VC meeting IM turn origin、独立 TRAE-X rollout parser，以及 adopt/follow-up 的最新 worker 契约；
- submit failure 默认只能删除 exact-attempt 且尚未 started 的 mark；只有权威 failed/ambiguous terminal 才允许删除对应 started attempt，并刷新下一条 pre-start lease；
- `assistant_final` 继续保留上游 terminal metadata，`turn_aborted` 继续作为无输出终态释放 lifecycle；
- 两个上游 source-contract tests（`claude-turn-terminal-contract`、`worker-durable-expiry-order`）按合并后的等价语义更新，而非放宽为无约束匹配。

当前 staged code/test patch 共 23 个文件（`+3009/-296`），SHA-256=`6ffb1cd9da6d0850d0cf064348ad656382cd19c3af552985459332c987d250b5`。Focused 覆盖 Issue2 原测试及本次重叠的 queue、worker、durable terminal、TRAE-X、Grok、Codex App、backend crash/suspend 等 31 个文件：

```text
31 test files: 31 passed / 0 failed
754 tests: 753 passed / 0 failed / 1 skipped
success: true
```

Focused JSON 为 `/private/tmp/botmux-false-idle-fa991-focused-prune-fix.json`，SHA-256=`47523d8cecf97a45251f2469688ca48a508fca856812f9c6efadedbe1ab3c909`。关键覆盖包括 Codex-only strong gate、正常/空 final 与 abort、stale-head prune/replay、同栈 completion drain、周期 snapshot 竞态、deferred submit exact-attempt/generation settlement、Claude non-structured recheck、normal await continuation、raw bundle withholding、adopt generation/restart gate、native rename 四阶段、same-backend restart grace timer、split-live late attach、exact `dispatchAttempt` terminal 清理与 successor lease 刷新，以及 abort 无 `final_output` 但仍结算 `ambiguous turn_terminal` 的 durable 契约。durable prune 的 4-file 定向复核为 93/93 PASS，JSON `/private/tmp/botmux-false-idle-prune-terminal-fix.json`，SHA-256=`e135db1f7a6c7244509831498446842bcf513c4a3a99f8e247721dd2ac50e63f`，覆盖 exact attempt 与 N terminal 先于 N+1 completion。

Standalone `tsc --noEmit` 通过；完整 build pipeline（TypeScript、scope copy、Dashboard bundle、CLI executable）通过；`git diff --cached --check` 与 `git diff --check` 通过；冲突标记和 unmerged path 均为 0。

### Full unit 结果与上游基线 blocker

最新补丁树已完整执行 full JSON suite：

```text
560 test files: 559 passed / 1 failed
9202 tests: 9113 passed / 82 failed / 7 skipped
success: false
```

唯一失败文件是本次上游新加入、与 Issue2 patch 路径不相交的 `test/vc-meeting-daemon-session.test.ts`；其他 559 个文件全部通过。Full JSON 为 `/private/tmp/botmux-false-idle-fa991-full-prune-fix.json`，SHA-256=`deae9155cb2a50418bc9dd84acf59af78e762d8987092588dbe2fa9ef96633f8`。

为避免把真实回归误归因于上游，把最终补丁 full 中该文件的失败集合与纯净上游 standalone 做了 A/B：

| 工作树 | tests | 失败 title 集合 SHA-256 | 证据 |
| --- | ---: | --- | --- |
| 最终 Issue2 patch full 中的 VC 文件 | 35 pass / 82 fail | `3e85f5af02abaee3e450c07779f9cc5e48be4f54cfd70cd21fc57e6f5b9b4fa5` | `/private/tmp/botmux-false-idle-fa991-full-prune-fix.json`, SHA-256=`deae9155cb2a50418bc9dd84acf59af78e762d8987092588dbe2fa9ef96633f8` |
| 纯净 detached `fa9914f2`，无 Issue2 patch | 35 pass / 82 fail | `3e85f5af02abaee3e450c07779f9cc5e48be4f54cfd70cd21fc57e6f5b9b4fa5` | `/private/tmp/botmux-fa991-clean-vc.json`, SHA-256=`705492eee44bf17faee4378c6cda33471019d69c31136ba320de17cc20ea233a` |

两边失败数量和完整失败 title 集合完全一致，首批失败都是 VC consumer profile activation 未从“会议多 agent 设置中”收敛为“会议 agents 已启用”，随后产生级联断言失败。因此可以确认：**这 82 个失败在纯净最新上游即可独立复现，不是 Issue2 patch 引入**。但它仍然阻止本分支声称“最新 full suite 全绿”；在上游基线修复或明确调整运行前提之前，验证状态只能是“focused/tsc/build PASS，full 已执行且受可复现上游 blocker 阻断”。

### 尚未完成

- 目标开发机上的真实 Codex CLI / rollout local integration；
- live daemon 切换或重启；
- 真实飞书卡片与 Dashboard API 的统一时间线 E2E；
- generation-change ambiguity 的新增 `user_notify` 目前沿用 worker 既有硬编码通知风格，尚未补齐多语言 key；与 generation 无关的既有 raw write exception 即使可能发生在部分文本/Enter 已写入后，也仍只写 worker 日志，但 bundled follow-up 会被 withholding；
- PR CI、review、合入、发布和线上效果验证。

这些缺口必须在后续证据中单独标注，不能由本地 unit/build 推导为“已上线修复”。

## 回滚

该变更不改数据格式，可按独立 commit 回滚。回滚后 runner 本身仍可继续工作，但 screen heuristic 会重新获得覆盖 lifecycle 的优先级，本文所述 false idle 风险随之恢复。

## 关联文件

- `src/services/codex-bridge-queue.ts`
- `src/services/codex-transcript.ts`
- `src/services/structured-bridge-clis.ts`
- `src/services/submit-confirmation.ts`
- `src/services/adopt-input-sequence.ts`
- `src/utils/async-serial-queue.ts`
- `src/utils/runtime-screen-status.ts`
- `src/adapters/cli/codex.ts`
- `src/adapters/cli/coco.ts`
- `src/worker.ts`
- `test/codex-bridge-queue.test.ts`
- `test/codex-transcript.test.ts`
- `test/structured-bridge-clis.test.ts`
- `test/submit-confirmation.test.ts`
- `test/async-serial-queue.test.ts`
- `test/runtime-screen-status.test.ts`
- `test/worker-structured-lifecycle-status.test.ts`
- `test/raw-input-followup-atomicity.test.ts`
- `test/session-rename-worker.test.ts`
- `test/claude-turn-terminal-contract.test.ts`
- `test/worker-durable-expiry-order.test.ts`
- `test/worker-pipe-initial-screen-order.test.ts`
- `test/write-input.test.ts`
