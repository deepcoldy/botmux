# 延迟挂起（Deferred Suspend）

`botmux suspend` 在会话正在产出回复时会直接杀掉 worker，把那一轮回复丢掉。
本文要求把它改成：**正在忙的会话先排队，等它自己结束后自动挂起。**

## 1. 背景与证据

### 现状

`suspend all` 走的路径（`dashboard-ipc-server.ts` 的 `POST /api/sessions/:sessionId/suspend`）
只有四道守卫：`session_not_active` / `session_transferring` / `adopt` / `backend_not_suspendable`。
**没有任何 busy 检查** —— 会话正在生成回复时照杀不误，用户那条消息的回复就此丢失。

对比：同文件里的 `POST /api/host-overload/sweep` 有守卫
`if (ds.lastScreenStatus !== 'idle') continue;`，说明这个概念在代码库里已经存在，
只是没用在 suspend 路由上。

### 触发频率

生产机（Mac mini, 24GB）上 `suspend all` 由凭证轮换 cron 驱动，
`7,37 * * * *` 里 `SUSPEND=1`，实际约每 6 小时执行一次（00:07 / 06:07 / 12:07 / 18:07）。

31 小时探针数据：并发 busy 会话数 `p99=4, max=5`。
即**每次 `suspend all` 大约打断 0–5 个正在生成的回复，每天 4 次**。

### 为什么现在要改

这台机器的内存余量正在收紧（8月7日峰值 56 会话，距估算上限仅 2–5 个会话），
候选缓解方案是把清理窗口从 6 小时缩短到 3 小时。但那会让"打断回复"的次数翻倍。
先修掉这个副作用，缓解方案才可用。

## 2. 目标与非目标

**目标**

- 挂起请求不再切断**正在产出中**的回合 —— 等它产完再挂
- 不漏掉任何会话 —— 语义从"立即挂起"变成"最终挂起"
- 调用方能看到有多少被排队

**非目标**

- 不做持久化（daemon 重启丢失排队状态，见 §4 决策 4）
- 不改 `suspend` 之外的挂起路径（`idle-worker-sweeper` / `host_overload_sweep`
  本来就有 busy 守卫，无需改动）
- 不引入新的配置项或环境变量
- **不保证「一条回复都不丢」** —— 见下方「交付边界仍是 best-effort」

### ⚠️ 交付边界仍是 best-effort（已知残留窗口）

本设计解决的是「**回合还在产出时被一刀切断**」。它**没有**建立
「回复交付完成 → 才撤销 worker ownership」这个 happens-before，因此
idle 与交付的交界处仍有一个窗口会丢回复：

1. worker 在 idle 路径先 drain bridge、依次 `process.send(final_output)`，再发 idle `screen_update`；
2. daemon 收到 `final_output` 后**并不立即投递** —— `deliverFinalOutput()` 把真正的
   `sessionReply` 放进 `setTimeout(...)`，同步返回；
3. daemon 随后收到 idle，排一个 `queueMicrotask` 兑现挂起；
4. **微任务先于 timer 执行**（JS 事件循环规范）：挂起先跑，同一同步栈里 `ds.worker = null`；
5. `setTimeout` 的投递这才运行，首行 `isStillOwned()` 已为假 → 放弃投递，
   日志留下 `Bridge final_output abandoned — worker/session ownership changed`。

即使 worker→daemon 的 IPC 是 FIFO（`final_output` 先于 idle 到达），只要两者落在
**同一轮事件循环**批量到达，这个顺序就是确定的，不是概率窗口。另外若本轮
transcript terminal 在 idle 时尚未落盘，`stopBridgeWatcher()` 的 `clearPending()`
会让答案同样消失。

几点必须说清楚：

- **这不是本设计引入的**。`idle-worker-sweeper` / `host_overload_sweep` 同样按
  `lastScreenStatus === 'idle'` 挂起，窗口一直存在，只是它们跑在定时器上、有几秒
  余量遮着。
- **但本设计放大了它**：排队兑现把挂起时机从「定时器几秒后」拉到了「idle 的那一刻」，
  正好贴着窗口边界。
- **影响面**：只涉及靠 bridge 兜底投递的回合（模型自己调了 `botmux send` 的回合，
  消息在挂起前早已发出，不受影响）。某台生产机器上这个比例约 4.3%
  （`Bridge fallback suppressed` 3935 次 vs `kind=bridge` 175 次），
  且该机器至今 `final_output abandoned` **0 次** —— 属于「理论真实、尚未观测」。

彻底解法是做两阶段 barrier：先进 retiring（保留 ownership、禁止 refork）→ worker
drain 并 ACK → daemon 等此前 `final_output` 的**实际投递完成** → 再 commit suspend、
清 `ds.worker`；配一条把 `final_output + idle` 同批送入、断言 `sessionReply` 完成
先于 ownership 撤销的行为测试。**这属于 ownership 生命周期的改动，比本设计大一个
量级，留作后续单独的改动**，不在本设计范围内。

## 3. 机制

会话状态类型：`ScreenStatus = 'working' | 'idle' | 'analyzing' | 'limited'`（`src/types.ts`）。

**排队**：IPC suspend 路由收到请求时，若 `ds.lastScreenStatus` 为 `working` 或 `analyzing`，
不杀 worker，在 `DaemonSession` 上记 `pendingSuspendReason`，返回
`{ ok: true, suspended: false, reason: 'deferred' }`。

**兑现**：`worker-pool.ts` 处理 `screen_update` 时，状态转入 `idle` 或 `limited` 后，
若 `pendingSuspendReason` 存在则调用 `suspendWorker(ds, reason)` 并清除标志。

`limited`（被限流）纳入兑现条件：该状态同样没有在产出内容，挂起不切断任何东西，
而且这类会话正是内存回收最该清理的。

## 4. 设计决策

### 决策 1：改默认行为，不加开关

有了"延迟兑现"之后默认开启是站得住的 —— **目标会话不会因为 busy 就被跳过**
（claim 记下来，转 idle 必兑现），只是晚几十秒到几分钟。注意这说的是「挂起请求
不丢」，不等于「回复不丢」：交付边界仍有一个已知窗口，见 §2。

对凭证轮换而言，延迟兑现**通常优于**现在的立即切断：正在跑的那一轮本来就已经
持有旧凭证，切断它并不能让那一轮用上新凭证，只是白白丢掉一次回复。
两种做法对"该会话何时开始用新凭证"的结果相同（都是下一轮），
区别只在于当前这一轮是完成还是被丢弃。

**最坏情况下退化为与立即切断相同**：若这一轮的回复正好落进 §2 那个交付窗口，
它同样会丢 —— 那时两种做法的结果一样，延迟兑现并不更差，但也不再更好。

因此不加 `--defer-busy` 之类的开关，直接改默认。

### 决策 2：不设兑现上限

会话长时间卡在 `working` 时，排队的挂起会一直不兑现。**接受这一点**，理由：

- 设 deadline 强制挂起 = 又回到切断回复，把本次改动的收益抵消掉
- 标志本来就会被下一个 `suspend all` 周期重新设上，不会永久丢失
- 安全阀是**可见性**而非超时：CLI 必须明确报出排队数（见 §5.4）

### 决策 3：排队期间来了新消息不取消排队

那一轮结束转入 idle 时照常挂起，用户下条消息冷启动续上下文
（生产实测冷恢复 `source=resume` 约 2.2 秒）。

如果取消排队，会出现"对话频繁的会话永远挂不掉"—— 而那恰恰是内存占用最大、
最需要回收的一类。

### 决策 4：只存内存，不持久化

`pendingSuspendReason` 存在 daemon 进程内存里，daemon 重启即丢。
不做持久化，因为下一个 `suspend all` 周期会重新排队，代价只是延后一个周期；
而持久化需要改 session store 的 schema，不成比例。

## 5. 改动清单

### 5.1 `src/core/types.ts`

`DaemonSession` 接口，紧挨 `lastScreenStatus`（当前在第 202 行附近）新增：

```ts
  /** 排队中的挂起：请求到达时会话正在产出（working/analyzing），杀 worker 会丢掉
   *  这一轮回复。改为记下原因，等 screen_update 转入 idle/limited 时再兑现
   *  （见 worker-pool.ts runPendingSuspendIfSettled）。仅存内存：daemon 重启即丢，
   *  下一个 `suspend all` 周期会重新排队，代价只是延后一个周期。 */
  pendingSuspendReason?: string;
  /** 排队时那一代 worker 的 generation。claim 只针对「当时正在产出的那一代」，
   *  绝不能活过它：该 generation 一旦被挂起（任何路径）或退出，目标态即达成、
   *  claim 就地消费。否则兑现 checkpoint 没跑到的场景（worker 崩溃、或 `/cd` /
   *  读隔离切换先挂起）会让标志活到下一代，在它第一次 idle 时把它平白挂掉。
   *  见 worker-pool.ts clearPendingSuspendClaim。 */
  pendingSuspendGeneration?: number;
```

### 5.2 `src/core/worker-pool.ts`

**(a) 新增兑现函数**，放在 `suspendWorker`（当前 2229 行 `export function suspendWorker`）附近：

```ts
/**
 * 兑现排队中的挂起。会话转入非产出状态（idle/limited）后调用。
 * working/analyzing 期间是空操作 —— 那正是当初排队的原因。
 */
function runPendingSuspendIfSettled(ds: DaemonSession, ownsGeneration?: () => boolean): void {
  const reason = ds.pendingSuspendReason;
  if (!reason) return;
  if (ownsGeneration && !ownsGeneration()) return;
  // claim 属于排队时那一代；到了更晚的 generation 说明它自己的兑现点没跑到，
  // 就地消费而不是挂起一个它从未指向过的 worker（兜底，正常由下面两处消费）。
  if (ds.pendingSuspendGeneration !== undefined
      && ds.workerGeneration !== undefined
      && ds.pendingSuspendGeneration !== ds.workerGeneration) {
    clearPendingSuspendClaim(ds, 'generation changed');
    return;
  }
  const st = ds.lastScreenStatus;
  if (st !== 'idle' && st !== 'limited') return;
  // worker 已经没了（崩溃 / 被别的路径挂起）：目标态已达成，清 claim 即可。
  if (!ds.worker || ds.worker.killed) {
    clearPendingSuspendClaim(ds, 'worker already gone');
    return;
  }
  // 成功时 claim 由 suspendWorker 内部的 clearPendingSuspendClaim 消费，这里只补一条可区分的日志。
  if (suspendWorker(ds, reason)) {
    logger.info(`[${tag(ds)}] Deferred suspend fulfilled (${reason}) after turn completed`);
    return;
  }
  // 被进行中的 transfer 拒绝：光保留标志不够，还要有重试触发点（见下）。
  deferUntilSessionTransferSettled(ds, () => runPendingSuspendIfSettled(ds, ownsGeneration));
}
```

三个细节都是正确性要求，不是讲究：

**`ownsGeneration` 要传，但它是 defense-in-depth，不是防一个已证实可达的 race。**
本文先后写过两版「具体 race」的论证，两版都不成立，为免第三次重蹈，把结论记在这里：

- **不是**「旧 worker 的陈旧消息进入 `screenshot_uploaded`」：message handler 的统一
  fence（`if (ds.worker !== worker) return`）排在 switch **之前**，被替换 worker 的
  消息一条也进不来。
- **也不是**「同一 tick 两条微任务，第一条挂起并 refork、第二条撞上新 worker」：
  `suspendWorker` 只把 `ds.worker` 置 null，**它不 refork**（refork 由外部输入驱动，
  属于之后的宏任务），而微任务队列连续 drain 期间宏任务插不进来。所以第二条微任务
  面对的是 `ds.worker === null`，`ownsGeneration` 判假直接早退 —— 不是一个新 worker。

它真正买到的是：排队的回调**只可能在自己那一代仍持有会话时执行**。消费 claim 是对
一个存活 worker 的破坏性操作，即便今天没有可达的 race，也值得为将来的调用方、
enqueue 与 drain 之间新增的同步副作用、以及任何比现在更早开始 refork 的路径留住
这道门。不属于当前 generation 的 checkpoint **保留标志直接返回**。

（不要改成给 `screenshot_uploaded` 加前置 `ownsLifecycleMutation()` break：那会改掉
该 case 的既有行为，影响面不明。把判定传进兑现函数是最小且封闭的改法。）

**只在 `suspendWorker` 返回 true 时清标志。** 它在 routing transfer 期间会拒绝并
返回 false —— 那是**暂时**拒绝，先清后调会把这次请求静默吞掉，一直丢到下一个
`suspend all` 周期才补回来。

**transfer 拒绝后必须显式重试，光保留标志不够。** 传进去的是纯 generation 判定
`ownsWorkerSession`，**不是 `ownsLifecycleMutation`**（后者把「不在 transfer 中」也
折了进去）。原因：transfer 是暂时拒绝、不是"这个 generation 不是我们的"，该由
`suspendWorker` 自己那道守卫来判。若用 `ownsLifecycleMutation`，transfer 期间会被
当成"不归我们"而直接 return —— 而**会话安静下来后屏幕分析器就不再发 `screen_update`**
（只在 `changed || status 变化` 时发），于是可能再也没有下一个 checkpoint 来唤醒它，
标志一直挂到下一个 `suspend all` 周期。所以拒绝后用**已导出的**
`deferUntilSessionTransferSettled` 注册重试；它在没有进行中的 transfer 时返回 false，
所以非 transfer 的拒绝（如 pty）不会注册多余回调。

日志用该文件既有的 `logger`（`import { logger } from '../utils/logger.js'`，第 34 行）
与 `tag(ds)` 前缀 —— 对齐 `suspendWorker` 内部
`logger.warn(\`[${tag(ds)}] Suspend refused while ...\`)` 的写法。

**(b) 在两处状态赋值后调用它**（`screen_update` 主路径约 5451–5454 行，
`screenshot_uploaded` 第二条路径约 5658–5660 行）。两处都已经捕获了 `prevStatus`
并给 `ds.lastScreenStatus` 赋值。

⚠️ **必须用 `queueMicrotask` 推迟一拍，不能同步调**：

```ts
queueMicrotask(() => runPendingSuspendIfSettled(ds, ownsWorkerSession));
```

（`ownsWorkerSession` 是这两个 handler 闭包里已有的纯 generation 判定，直接传即可。
为什么必须传、以及为什么不能传 `ownsLifecycleMutation`，见上面 (a)。）

`suspendWorker` 是同步的，且会把 `ds.worker` 和 `ds.lastScreenStatus` 清空。
而同一个 handler 在赋值之后还要读这两个字段做**回合收尾**：

- `recordUsageForDaemonSession(ds)` 与 `void finishTurnReactions(ds)`（✋→✅）
  都门控在 `lastScreenStatus === 'idle' || 'limited'` 上 —— 同步挂起会让它们**整段跳过**
- `emitSessionStateTransitionHook(ds, prevStatus, ds.lastScreenStatus, ...)`
  会把新状态报成 `undefined`
- 末尾 `buildStreamingCard(..., ds.lastScreenStatus, ...)` 拿到 `undefined`

同步调用等于为了不切断回复，反手切掉了这一轮的收尾记账 —— 正是本设计要保护的东西。
`queueMicrotask` 是这个文件既有的惯用法：同一段里 `queueMicrotask(cb.enforceLiveSessionCap)`
的注释写的就是「Defer until this screen_update has finished using process state」。

⚠️ 也不要挂到 `emitSessionStateTransitionHook()` 上。那个函数是给外部 hook 事件用的，
带去重窗口且对 `vcMeetingReceiver` 等提前 return，会漏触发。

### 5.3 `src/core/dashboard-ipc-server.ts`

`POST /api/sessions/:sessionId/suspend` 路由（当前 743 行附近）。
在现有的 `!ds.worker || ds.worker.killed` 幂等分支**之后**、
`suspendWorker(...)` 调用**之前**插入：

```ts
  // 正在产出回复时不杀 worker —— 那会把这一轮丢掉。改为排队，等
  // screen_update 转入 idle/limited 时由 runPendingSuspendIfSettled 兑现。
  if (
    (ds.lastScreenStatus === 'working' || ds.lastScreenStatus === 'analyzing')
    && isSuspendableBackendType(ds.initConfig?.backendType)
  ) {
    ds.pendingSuspendReason = 'manual_suspend';
    return jsonRes(res, 200, {
      ok: true, sessionId: params.sessionId, suspended: false, reason: 'deferred',
    });
  }
```

注意顺序：幂等分支在前，这样"worker 早就没了"仍然返回 `reason: 'no_live_worker'`，
不会被误报成 deferred。

`isSuspendableBackendType` 是**排队条件的一部分，而不是排在它前面的新守卫** ——
现状是 busy + pty 直接 409（`suspendWorker` 返回 false），把它写成独立的前置 return
有两个坏处：① busy 的 pty 会话若先排队，就变成「200 deferred，然后到点静默失败」；
② 独立前置 return 会**改掉非 busy 会话的行为**，因为 `isSuspendableBackendType(undefined)`
返回 false，而 `test/dashboard-ipc.test.ts` 里那条 mock 掉 `suspendWorker` 的既有用例
用的 fixture 没有 `initConfig`。写成合取式则不可挂起的 backend 照旧穿透到
`suspendWorker` 的 409，非 busy 路径一行行为都不变。
`isSuspendableBackendType` 该文件已导入（第 75 行）。

### 5.4 `src/cli.ts`

`cmdSuspend()`（当前 4504 行）里的结果分类。现有逻辑：

```ts
if (body.suspended) { console.log(`✓ 已挂起: ${label}`); suspended++; }
else { console.log(`· 本就无存活 CLI（目标态已达成）: ${label}`); skipped++; }
```

需要把 `reason === 'deferred'` 单独分出来计数，不要混进 `skipped`：

```ts
if (body.suspended) { console.log(`✓ 已挂起: ${label}`); suspended++; }
else if (body.reason === 'deferred') {
  console.log(`⏳ 已排队（正在回复，完成后自动挂起）: ${label}`); deferred++;
}
else { console.log(`· 本就无存活 CLI（目标态已达成）: ${label}`); skipped++; }
```

结尾汇总行同步加上排队数：

```
完成：挂起 N 个，排队 M 个，跳过 K 个[，失败 J 个]。
```

**这个计数是决策 2 的安全阀**，必须实现 —— 排队数持续不降就是会话卡住的信号。

`--dry-run` 分支也要跟上，而且**必须复刻 suspend 路由的完整分类，不能只看忙不忙**。
只按屏幕状态判断的话，busy 的 pty / adopt 会话会被预告成"将排队"，实际请求拿到的是
`backend_not_suspendable` / `adopt_suspend_unsupported`；没有存活 worker 的会话会被
预告成"将挂起"，实际是跳过 —— 一个说得斩钉截铁的错误预告比不预告更坏。

CLI 本地的 session store 这些判据一个都没有，要按 daemon 拉一次 `GET /api/sessions`：
该路由的 dashboard 行同时带 `status`（即 `lastScreenStatus`，无 worker 时为 `dormant`）、
`adopt`、`backendType`，**足够完整复刻**路由的分支顺序（adopt → 无 worker →
不可挂起 backend → busy → 挂起）。每个 daemon 只拉一次。

**"读不到"要分成两种，不能混成一个"未知"**（这是 live 验证才暴露出来的 —— 单测和
两轮 codex 都没看出来，因为它只在真实多 bot 环境里显形）：

- **daemon 不在线**（`findDaemon()` 为空）→ 结果是**确定可知**的：真实循环在发请求
  之前就会因为同一个条件跳过。预告成"将跳过（daemon 不在线）"。
  实测本机 516 个目标里有 20 个属于此类（`cli_listener_status` / `cli_listener_run`
  这两个伪 app id 下的 Message Listener Preview 会话），报"未知"是实打实的信息损失。
- **daemon 在线但 `/api/sessions` 读失败**（非 2xx / 非 JSON）→ 这才是真未知，
  预告为"未知"并在结尾打一行 warning。

同理，真实循环里排在 daemon 查找**之前**的那道
`!s.larkAppId && online.length > 1` 跳过，dry-run 也要照抄，否则这类会被误报。

原则不变：dry-run 不该因为某个 daemon 抽风而失败，但也绝不该把"读不到"伪装成
"已确认"——反过来，把**本来可确定**的结果报成"未知"同样是失职。

### 5.5 挂起前 flush 输出：**已从本改动移除**

早先的草案在 `case 'suspend'` 里插入 `await flushBridgeOutputBeforeSuspend()`，
想在 teardown 前把 bridge 队列里已就绪的回复推出去。**该实现已整体删除**，原因是
它的产物在 daemon 侧会被确定性丢弃：

`suspendWorker` 发出 `{ type: 'suspend' }` 之后，在**同一同步调用栈内**就把
`ds.worker = null`；worker 要收到该消息后才开始 flush，等 `final_output` /
`suspend_ready` 回到 daemon 时，message handler 在 switch **之前**的统一 fence
（`if (ds.worker !== worker) return`）已经把它们全部丢弃。也就是说那条路径在当前
接线下**无法成功**，不是「尚未观测到正向场景」。

要让 flush 真正落地，需要在那道 fence 上开一个「正在 suspend 的这一个 worker」的
定向例外 —— 那道 fence 护着 cards / tokens / readiness / durable turn state，属于
安全边界，值得单独一个改动连同 daemon 侧行为测试一起做。

由此带来的残留窗口已在 §2「交付边界仍是 best-effort」如实记录。


## 6. 边界情况

| 情况 | 期望行为 |
|---|---|
| 排队期间 worker 崩溃 | 兑现函数发现 `!ds.worker \|\| killed`，清标志，不报错 |
| 排队期间会话被 `delete` 关闭 | 会话记录消失，标志随之消失，无副作用 |
| 排队期间被 `idle-worker-sweeper` 挂起 | 同上：worker 已 killed，兑现函数清标志即可 |
| 同一会话重复请求挂起 | 幂等 —— 覆写同一个 `pendingSuspendReason` |
| adopt / 不可挂起 backend | 保持现有守卫，**在排队检查之前** return，不排队 |
| 会话状态为 `undefined` | 不排队，走原有立即挂起路径（`undefined` 不属于 working/analyzing） |
| daemon 重启 | 排队丢失，下一周期重新排队（决策 4） |
| 兑现时 bridge 队列还有未发的回复 | **仍可能丢** —— 交付边界是 best-effort，见 §2 的已知残留窗口 |
| 排队期间会话 refork | claim 绑定在排队那一代，`suspendWorker` 成功或 worker exit 时即被消费；漏网的到下一代由 generation 门控就地消费，**绝不挂新 worker**（§5.1 / §5.2a） |
| 兑现时 `suspendWorker` 拒绝（routing transfer 中） | 保留标志，并注册 `deferUntilSessionTransferSettled` 重试 —— 不能只靠"下一个 checkpoint"，安静会话可能再也没有（§5.2a） |
| dry-run 遇到正在 routing transfer 的会话 | **预告不准**：会报"将排队/将挂起"，实际是 409 `session_transferring`。`/api/sessions` 行不暴露该状态，已在代码注释标明（§5.4） |

## 7. 测试

### 单元测试

仓库用 vitest（`pnpm vitest run --project unit`）。参考既有测试风格。

`runPendingSuspendIfSettled` 是 `worker-pool.ts` 的模块内函数。仿照同文件既有的
`export const __testOnly_deliverFinalOutput`，导出 `__testOnly_runPendingSuspendIfSettled`
做**真行为断言**（mock 掉 session-store / dashboard-events / logger，写法照抄
`test/worker-suspend.test.ts`），比源码断言可靠得多。

`test/deferred-suspend.test.ts` — 兑现半边：

1. 兑现函数在 `working` / `analyzing` 时是空操作，**且标志必须留着**（否则排队被静默吞掉）
2. 转入 `idle` 和 `limited` 都会兑现
3. `worker` 已 killed / 缺失时只清标志、不走 `suspendWorker`（它的 no-worker 分支会
   顺手清 `managedTurnOrigin`/`workerReady`，那是这次排队从未拥有的 generation）
4. 兑现后标志被清除，第二个 idle tick 不会重复挂起
5. **reason 真的被透传**（断言被 mock 的 `logger.info` 收到该 reason；只断言"标志被清"
   是空测试 —— 实现把 reason 写死也会绿）
6. **`ownsGeneration` 为假时不挂 worker 且保留标志**；为真时正常兑现
7. **`suspendWorker` 拒绝时保留标志**（routing transfer 的门是模块私有的，用同样
   「早退且零副作用」的 pty 分支钉这条不变式）
8. **transfer 拒绝后注册了 `deferUntilSessionTransferSettled` 重试**，且两个 checkpoint
   传的是 `ownsWorkerSession` 而非 `ownsLifecycleMutation`（transfer 门是模块私有的，
   这条用源码断言钉）

`test/ipc-suspend-route.test.ts` — 排队半边（起真 IPC server + `vi.spyOn(workerPool, ...)`，
写法照抄 `test/ipc-close-route.test.ts`）：

8. `working`/`analyzing` 返回 `{suspended:false, reason:'deferred'}` 且**没有**调用 `suspendWorker`
9. `idle`/`limited` 仍立即挂起
10. 状态 `undefined` 不排队
11. 幂等分支（无 worker）仍返回 `reason:'no_live_worker'`，不被误判为 deferred
12. `backend_not_suspendable` / `adopt_suspend_unsupported` 两道守卫都排在排队之前

`test/worker-suspend-output-flush.test.ts` — **已随 §5.5 的实现一并删除。**
那组用例只对 worker 侧做源码顺序断言，完全没有跨过 daemon 的接收边界，所以即使
flush 产物在 daemon 侧被 fence 确定性丢弃，它依然全绿。这是个值得记住的教训：
**跨进程的承诺，必须由跨过那道边界的行为测试来钉，源码断言证明不了任何交付。**

`test/deferred-suspend.test.ts` 另有一组 claim 生命周期用例（真行为断言）：

13. 任何成功的 `suspendWorker` 都消费 claim —— 不只是兑现 checkpoint，`/cd` /
    读隔离切换 / idle sweeper 这些不路过 checkpoint 的路径同样算目标态达成
14. 被拒绝时 claim 与其 generation 一并保留（暂时性拒绝不能吃掉请求）
15. claim 属于更早的 generation 时**就地消费、绝不挂起新 worker**
16. 同代时照常兑现（上一条门控不能把正常路径也挡掉）

### 生产验证

改动部署后（`pnpm build`），本设计只涉及 daemon 侧（`src/worker.ts` 零 diff —— §5.5 的
worker 侧 flush 已移除），daemon 重启即全部生效。

1. 找一个正在生成回复的会话（`botmux list --plain` 里 status 为 online 且屏幕在动）
2. `botmux suspend <sid>` → 应输出 `⏳ 已排队`
3. 等该会话回复完成 → daemon 日志应出现 `Deferred suspend fulfilled`
4. `botmux list` 确认该会话已变成 dormant
5. 关键回归：确认那条回复**完整发到了飞书**，没有被截断

> ⚠️ 第 5 步观察到"完整送达"只是**一个样本的观测结果**，并不证明 §2 那个交付边界
> 窗口消失 —— 那个窗口要求 `final_output` 与 idle 落在同一轮事件循环，日常抽查大
> 概率碰不上。判断它是否发生，看 daemon 日志里有没有
> `Bridge final_output abandoned — worker/session ownership changed`。

也可直接观察下一次 6 小时周期的 `suspend all` 输出，排队数应与当时的
busy 会话数吻合（历史 `p99=4, max=5`）。

## 8. 回滚

改动集中在六个文件、且互相独立：`dashboard-ipc-server.ts` 的排队分支去掉后即恢复
原行为，`pendingSuspendReason` 永不被设置，兑现函数自然变成空操作。

§5.5 的 worker 侧 flush **已在本改动中删除**（原因见该节），所以不存在回滚它的问题；
它留下的交付边界窗口已在 §2 如实记录为已知项。

generation 绑定（`pendingSuspendGeneration` + `clearPendingSuspendClaim`）同样独立：
去掉它排队机制仍然工作，只是回到「claim 可能残留到下一代」的行为。

## 9. 参考：本文结论的数据来源

- 并发 busy 分布 `p99=4 / max=5`：`~/.botmux/probe/` 的 31 小时采样，
  用 `python3 ~/.botmux/probe/report.py` 复现
- 冷恢复耗时 2.2 秒：daemon 日志中 `SessionStart ready signal received (source=resume)`
  到 `Writing to PTY (flush)` 的间隔，n=2
- `suspend all` 实际频率：`crontab -l` 的 `7,37 * * * *` + `bot-cred-refresh-oauth.sh`
  中 `SUSPEND=1` 的触发条件（仅在 token 刷新成功后）
