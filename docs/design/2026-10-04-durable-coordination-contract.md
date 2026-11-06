# Durable coordination contract

## 背景

BotMux 当前把入站去重、同会话串行、Session 状态和投递回执分别保存在进程内结构、本地文件或 SQLite 中。这些实现适合单 daemon，但不能直接把同一份打开的 SQLite 交给多个主机，也不能用进程内 Promise queue 证明跨副本串行。

本设计先抽出与具体数据库无关的最小协调合同，并提供 SQLite 参考实现。现有单机路径保持不变；后续实现可以在不改变状态机的前提下接入远程事务数据库。

## 不变量

1. 入站平台事件以稳定 `eventId` 幂等；同键同 payload 是 duplicate，同键不同 payload 是 conflict。
2. inbox 使用 `partitionKey` 保序。同一分区同一时刻最多一个有效 claim，不同分区可并行；分区内顺序必须由 store 在插入事务中分配，不能信任不同 leader 的客户端时间戳或 event id 字典序。
3. 逻辑 Session 由 owner lease 保护；每次过期接管或释放后重领都会递增 `epoch`。所有 Session 写入和 outbox 创建必须携带未过期的 `(sessionKey, ownerId, epoch)`。
4. 租约时间由 store 自己决定。本地实现使用注入时钟；远程实现必须在事务内使用服务端时间，不能信任不同 worker 的墙钟。
5. Session 状态使用 revision compare-and-set，避免新 owner 的更新被旧快照覆盖。
6. outbox 先 reserve，再显式 begin attempt。`reserved` 尚未越过副作用边界，租约过期后可以重新领取；`attempting` 已可能产生外部副作用，租约过期后只能进入 `ambiguous`，不能自动重放。
7. 同一 Session 的 outbox 严格按 store 在插入事务中分配的序号投递；`createdAt` 和 `messageId` 都是客户端输入，不能作为跨副本 FIFO 的事实源。
8. confirmed receipt 可以结算精确的旧 attempt；不同 claim epoch 或 attempt number 的迟到结果必须被拒绝。

## ACK 边界

Lark WebSocket handler 当前依赖 `claimMessageOnce` 与 `setImmediate` 之间没有 `await`：同一 chat 的事件按到达顺序进入 raw ingress lane，并在 SDK 的 ACK 预算内返回。这个约束继续适用于现有 SQLite 路径和 shadow mirror；shadow 的远程协调调用不能进入同步热路径。

Shadow 路径保持两层：

```text
WS callback (shadow)
  ├─ 同步本地 quick claim（只用于挡当前进程重推）
  ├─ 同步 schedule + 返回 ACK
  └─ setImmediate 后 durable enqueue(eventId, partitionKey, payload)
        └─ worker claim partition
             └─ 解析 canonical Session
                  └─ acquire Session lease / epoch
                       ├─ CAS Session state
                       └─ enqueue outbox
```

本地 quick claim 不是分布式正确性来源；跨副本幂等由 durable inbox 唯一键提供。ACK 后 enqueue 失败时，调用方必须可见地重试或进入降级策略，不能把本地 quick claim 当作已经持久接收。因此这条 shadow 路径不能直接升级为 primary。

Primary 路径必须把 durable enqueue 移到 ACK 之前，并且同一个 Lark App 同一时刻只能有一个 WS ingress owner：

```text
App ingress lease leader
  └─ owns the only active WS client for this App
       └─ WS callback
            ├─ validate stable app/message/partition identity
            ├─ await durable enqueue within the ACK budget
            ├─ inserted/duplicate → return ACK
            └─ timeout/conflict/provider failure/lease loss → reject, let Lark redeliver
```

`DurableLarkPrimaryIngress` 复用 Session lease 的 epoch fencing，但使用保留的 App 级 key。leader 在本地单调时钟证明接近过期前停止接纳；renew stale、provider error、durable enqueue error 或 conflict 都会立即失去本地领导权并中止 WS lifecycle signal。`onLeadershipAcquired` 和 `onLeadershipLost` 是未来 daemon 接线唯一允许启停 WS client 的边界，优雅退出会先 drain 已接纳的分区写入并完成 lost callback，再释放 lease；整个过程共享同一个 shutdown deadline。

同一 `partitionKey` 在 API 入口同步挂入 FIFO。即使 ACK wait 超时，实际 enqueue 仍保留在 tail 中，因此 N+1 不能越过仍在进行的 N；Lark 重推最终只会得到 duplicate。客户端 `createdAt` 只在一个进程生命周期内严格递增，不能冒充跨 leader epoch 的数据库全序。跨 epoch 若未来需要严格全序，仍必须增加 store-generated sequence 或等价证明。

## 接口与状态机

公共接口位于 `src/services/durable-coordination.ts`，包括四组原语：

- Session lease：`acquire`、`renew`、`release`，返回单调 `epoch`。
- Session state：`read` 与 fenced revision CAS `write`。
- Inbox：幂等 enqueue、分区 claim、renew、complete、retry。
- Outbox：fenced enqueue、reserve、begin attempt、delivered/retry/ambiguous 结算。

SQLite 参考实现位于 `src/services/sqlite-durable-coordination.ts`，使用独立 schema 和短事务。长 turn 不持有数据库事务，只持有可续租的 Session lease。

SQLite inbox 和 outbox 分别使用独立的 autoincrement order 表，在 row insert 的同一事务内分配全局 sequence；inbox 的 per-partition earlier fence、outbox 的 per-Session earlier fence 与候选排序都使用对应 sequence。旧 version-1 数据库首次打开时分别按已有 `created_at,event_id` 和 `created_at,message_id` 做一次确定性 backfill，之后所有新事件和消息不再依赖客户端时间。远程 provider 必须用数据库 sequence/identity 或等价的事务序号实现同一语义。

```text
inbox:  queued ──claim──> claimed ──complete──> completed
           ▲                 │
           └──── retry ──────┘
           └── expired claim 可被另一 worker 重新领取

outbox: pending ──reserve──> reserved ──begin──> attempting ──receipt──> delivered
            ▲                    │                    │
            └── safe retry ──────┴────────────────────┘
                                                     └── lease expires ──> ambiguous
```

`retryOutboxAttempt` 只适用于调用方能够证明未产生副作用，或目标 transport 对稳定 `messageId` 提供幂等的场景。普通超时不能自动归类为 retryable。

## 与现有原语的关系

这不是另起一套互不相干的状态机：

- outbox 的 `reserved → attempting` 边界沿用现有 idempotency store 对“尚未产生副作用”和“结果可能不明”的区分。
- Session `epoch` 沿用现有 generation/fencing 思路；旧 owner 的迟到写入只能得到 `stale_lease`。
- SQLite 实现复用现有 `sqlite-compat` 与 canonical JSON，不引入第二套数据库运行时或序列化规则。
- workflow `AttemptLeaseProvider` 仍负责单次 workflow attempt；本合同负责 IM ingress、逻辑 Session 和投递回执，二者生命周期不同，不互相冒充。

## 本次边界

本次只新增 provider-neutral 合同、SQLite 参考实现和合同测试，不做以下行为变更：

- 不替换现有 `session-store.ts`。
- 不把远程调用放进 ACK 前同步段。
- 不改变现有单 daemon 默认配置。
- 不增加具体远程数据库依赖、连接信息或部署语义。

后续接入按小步完成：`shadow` 在 ACK 后镜像 `im.message.receive_v1` 到 durable inbox，并由无用户可见副作用的 shadow consumer 完成 claim、身份校验和 complete；现有 SQLite 路径仍负责真实处理。`primary` 则把 provider-neutral consumer、durable outbox pump、Lark payload/receipt adapter，以及 App 级 ingress leader/ACK 前 enqueue 状态机组成 daemon 的真实路径。默认仍为 `disabled`，disabled/shadow 的现有行为保持回归覆盖。

Session shadow projection 只包含版本、稳定 `sessionId`、应用与路由 anchor、scope、active/closed 生命周期和时间戳。标题、prompt、owner、工作目录、附件、token、CLI/provider lineage 与终端状态都不复制；这些字段在形成明确的多副本合同前仍只属于现有 Session store。Facade 按 stable session key 顺序化并合并排队更新，执行 `acquire lease → read revision → CAS write`，显式返回 occupied、conflict 和 stale lease。不同 key 可并行；优雅退出有界等待并释放本 boot 持有的 lease。

Primary admission 不能复用 shadow 的 last-write-wins 合并：两个 inbox event 若被合并为一次写入，前一事件会拿到后一事件的 revision，形成伪 receipt。Facade 因此额外提供 `writeExact`：同 Session key 严格 FIFO，每个事件独立 acquire/read/CAS 并返回实际 `SessionLease + DurableSessionRecord`，即使重试后的值完全相同也强制递增 revision。需要保留已有 per-turn 状态时使用 `writeExactFromCurrent`，builder 只在 lane 已取得 lease 并读到当前 revision 后执行，避免调用方 read→merge→write 的竞态。原有 `write` 的 shadow 合并语义保持不变。

`DurablePrimarySessionProjection` 保存现有 Session store 的完整持久 `Session` JSON、兼容旧 reader 的最新单值 `admission`，以及按最老到最新排列、最多 64 项的 `admissions`。后者让同一 Session 的 N+1 已入会时，N 的 final 仍能按自己的 turn 找到 event/app/partition/message identity；重复 turn 会更新而不是复制，超出界限时淘汰最旧项。它不新增 runtime-only worker token 或进程对象；内容边界等同现有 Session row。每次 canonical admission 在 exact lane 内读取并合并 history，再从该次返回的 lease epoch 与 record revision 构造 `DurableLarkAdmissionReceipt`。restore parser 兼容没有 `admissions` 的 version-1 记录，重算 Session routing key，并校验全部 admission identity；损坏或错路由 snapshot fail closed。

Shadow projection 刻意只覆盖普通飞书新会话在 SQLite 更新和 `activeSessions` 注册都成功之后的审计写入。竞态失败的 scratch Session、全量 `persistRow`、多行事务、恢复、关闭和批量 lineage 写入不属于这个最小 projection；因此 shadow 本身不能用作完整 Session 事实源。Primary 不复用该 projection，而是每次 admission/output 写入完整持久 Session snapshot。

Primary consumer 的 dispatch callback 必须返回 `committed` 或带有有界原因的 `ignored`。`committed` 不再接受裸状态词，必须携带版本化 `DurableLarkAdmissionReceipt`：它把 inbox 的 `eventId`、`partitionKey` 和 App identity 绑定到 durable store 返回的 Session key、lease epoch、record revision 与 store timestamp。consumer 会在 complete inbox claim 前重新校验全部字段；复制自另一事件的 receipt、缺失 epoch/revision 的伪回执，以及只把任务追加到进程内 Promise queue 的 `{ kind: 'committed' }` 都进入 retry，不能冒充 durable admission。

`DurableLarkCanonicalDispatch` 把 consumer callback 与 canonical handler 的返回值收敛成同一边界：handler 必须显式返回 `admitted + Session snapshot` 或 `ignored + bounded reason`。admitted 路径通过 full Session exact admission 后才返回 committed receipt；ignored 不写 Session。claim 已 abort、handler 返回 queued/未知结果、Session occupied/conflict/stale 或 provider error 全部抛错给 consumer retry，不能降级成内存接纳。

这份 receipt 只证明 canonical Session mutation 已在 fenced owner 下提交，不代表整轮执行完成，也不保存 owner id、prompt、用户身份或 provider 凭据。Primary daemon handler 从实际 Session lease 与 CAS write 返回值构造它。长 dispatch 会续租 inbox claim；续租 stale 或失败立即触发 `AbortSignal`，之后既不 complete 也不 retry，由 claim 到期后交给新 owner。普通 dispatch 失败在仍持有 claim 时进入延迟 retry；不同 slot 可以并发领取不同 partition，同一 partition 的排他性仍由 store 保证。

Primary daemon 接线满足三个硬门禁：

1. daemon 只在 `DurableLarkPrimaryIngress` 领导权回调内启停该 App 的 WS client，并用 `enqueueBeforeAck` 替换、而不是旁路镜像现有 receive/update message callback。
2. handler 必须只在 durable inbox 返回 inserted/duplicate 后 ACK；timeout、conflict、provider failure 和 lease loss 必须保持可重推，不能回退到 ACK 后 fire-and-forget。
3. `processMessageEvent` 在 primary 下等待 canonical handler，并返回真实 admission receipt，不能把“已排进内存队列”当作 `committed`。

Runtime factory 默认仍拒绝 `primary`；只有完成上述组装的 daemon 调用点显式传入 `allowPrimary`。普通 worker final 与单消息 `botmux send` 均经 Session exact-write、outbox 和权威 settlement；多副作用形态的限制见 provider runtime 文档。

Durable outbox pump 严格复用合同已有的副作用边界：先 reserve，再在任何 transport 调用之前提交 `beginOutboxAttempt`。callback 只有三类显式结果：带 receipt 的 delivered；带 `no_side_effect` 或 `stable_target_idempotency` 证明的 safe retry；以及 ambiguous。callback 抛错、超时、非法结果或缺少安全证明的 retry 一律进入 ambiguous，不自动重发。Attempt timeout 小于 reservation lease 的一半，使正常 settlement 有独立余量；晚到成功只作为观测信号，不能把已经 ambiguous 的 attempt 改写成 delivered。

Pump 本身不包含 Lark 语义。Lark adapter 使用版本化 envelope 冻结 app、send chat 或 reply parent、`replyInThread`、message type/content、稳定 provider UUID 与 JSON hook context；outbox row 的 message id 必须与 envelope identity 一致。UUID 限制沿用现有 Feishu 合同（URL-safe、最多 50 字符），去重 TTL 复用 `PROVIDER_TTL_MS['feishu-im']` 的 1 小时，并在到期前保留 60 秒 guard，超出窗口后不再自动 retry。

`enqueueDurableOutboxWithSettlement` 在 fenced enqueue 后返回一个权威 settlement Promise。它轮询 store 中的 outbox row，直到 `delivered` 或 `ambiguous`；不依赖进程内 pump observer，因此另一副本 takeover 后完成的投递也能释放原进程的 final-drain 等待。duplicate 会跟随现有 row，conflict/stale lease 不启动等待；shutdown abort 只终止本地等待，不改写 durable row 状态。

`enqueueDurableLarkSessionOutput` 把 Session 与 output 绑在同一 fencing 证明上：先 exact-write 最新完整 Session snapshot，取得新 lease/record，再用该 lease enqueue frozen outbox message，最后返回跨副本 settlement。outbox `sessionKey` 在任何写入前必须与 canonical Session key 一致；Session occupied/conflict/stale 时不创建 output，outbox conflict/stale 显式返回，不能回退到直接 transport。

Session write 与 outbox enqueue 是两个短事务，二者之间的进程硬崩不能伪装成原子提交。调用侧因此必须把 final 的 provider UUID 绑定到逻辑 app/scope/anchor/turn，而不是本地 Session UUID，并在 owning daemon 连接中断或启动期 5xx 时做有界重试。重试携带完全相同的 turn、payload 与 UUID：若首轮尚未 enqueue，重试补齐 outbox；若首轮已 enqueue 或已投递，message id 唯一键与 provider UUID 会返回 duplicate/原 provider receipt；`ambiguous`、payload conflict 与非重试状态始终 fail closed。

`enqueueDurableLarkFinalOutput` 在任何异步 Session/outbox 操作前同步注册现有 daemon final-output drain fence。只有 outbox 权威 settlement 到达 `delivered`/`ambiguous`，或 pre-enqueue 明确失败/本地等待被 abort，才释放 fence；因此 shutdown snapshot 不会漏掉正在写 Session 或等待另一副本投递的 final output。

Adapter 复用现有 `sendMessage` / `replyMessage`、`classifyFeishuError` 和 outbound hook fencing。Session/epoch authority 在每次 provider 调用前重新验证；首次尝试只有拿到动态 hook authority 才发 hook，后续 UUID reconciliation 一律 `suppressHook`，避免 provider 去重成功时重复本地 hook。持久 payload 只保存普通 JSON hook context，不保存 IPC capability；`hookOrigin` 与 `beforeHook` 必须由当前 owner 在投递时重新证明。父消息已撤回时不能拿同一个 UUID 改投 top-level send：Feishu UUID 去重不把 parent 纳入 key，这样 retarget 可能静默返回旧父消息下的结果；adapter 因此保持 ambiguous，新的 fallback 必须重新取得 authority 并创建新的 outbox identity。

现有 final delivery drain、turn idempotency 和 outbound hook fencing 作为接线依赖复用，而不是平行实现第二套回执。Primary 已接入单消息 adapter；附件、多条分块消息、卡片 patch 与非 IM 副作用不被这份 envelope 偷偷概括，当前版本会在这些形态产生任何外部副作用前显式拒绝。

非内置 store 通过独立 JSONL provider 进程接入，握手、配置和 fail-closed 边界见 [durable coordination provider runtime](./2026-10-05-durable-coordination-provider-runtime.md)。该进程边界只承载公共合同，不允许把具体数据库或部署平台语义引入 daemon。

## 验证

`test/durable-coordination.test.ts` 覆盖：

- 幂等键 duplicate/conflict；
- 同分区串行、跨分区并行；
- claim 过期重领；
- lease takeover 与 epoch fencing；
- Session revision CAS；
- outbox safe retry、稳定 message id、迟到 receipt；
- attempting 超时进入 ambiguous 而非自动重放；
- SQLite reopen 后状态和 epoch 保持。

`test/durable-session-facade.test.ts` 与 `test/durable-session-shadow.test.ts` 额外覆盖：

- lease/read/revision-CAS 与 unchanged 去重；
- 同 key 顺序化、排队更新 last-write-wins 合并和跨 key 并行；
- occupied、conflict、stale lease 显式结果；
- 有界 stop 与 lease release；
- thread/chat stable key 以及敏感/高频字段不进入 shadow projection。

`test/durable-session-primary.test.ts` 额外覆盖：

- 完整 Session JSON 与 admission identity 的 round-trip / routing key 重校验；
- 同 Session 并发 event 的 exact FIFO revision 与 event-bound receipt；
- type-ahead 后旧 turn admission 仍可查、64 项上限和旧 version-1 单值兼容；
- `im.message.updated_v1` 首次补 @ 的 admission identity；
- 同事件 retry 也产生新 revision，不把旧 revision 冒充本次写入；
- receipt 不携带 owner、workingDir、title 等 Session payload 字段。

`test/durable-inbox-primary-consumer.test.ts` 覆盖：

- committed/ignored receipt 后才 complete；
- committed receipt 必须绑定当前 event/app/partition 与正数 Session epoch/revision；
- 裸 committed 和复制自另一 inbox event 的 receipt 进入 retry；
- 非法 envelope、dispatch failure 和非法 receipt 进入 retry；
- 长 dispatch claim renew 与最新 claim proof；
- stale renewal 触发 abort，且不 complete、不 retry；
- bounded shutdown 中止未结算 dispatch，不伪造完成回执。

`test/durable-lark-admission.test.ts` 覆盖 receipt 的 lease/record 构造、JSON round-trip、inbox identity 重校验，以及非法 epoch/revision/timestamp 与 Session key mismatch。

`test/durable-lark-canonical-dispatch.test.ts` 覆盖 admitted→Session CAS→receipt、显式 ignored 不写 Session，以及 abort、非法 handler 结果与 Session conflict 的 fail-closed 行为。

`test/durable-outbox-pump.test.ts` 覆盖：

- begin attempt 先于 transport callback，成功 receipt 结算 delivered；
- 只有显式安全证明允许 retry，非法证明降级 ambiguous；
- transport throw、timeout 与未知结果默认 ambiguous；
- timeout 后迟到成功不覆盖 ambiguous；
- stale begin、瞬时 reserve 失败与 bounded shutdown。

`test/durable-lark-outbox.test.ts` 覆盖：

- frozen send/reply identity、row/envelope 一致性与 UUID 长度；
- 首次 hook authority、重试 suppressHook 与 provider receipt；
- 网络错误在 UUID TTL 内 safe retry，临近过期保持 ambiguous；
- withdrawn reply 不在同一 UUID 下 retarget；
- provider 前 authority/abort 失败证明 no-side-effect；
- corrupt payload containment。

`test/durable-lark-primary-ingress.test.ts` 额外覆盖：

- App lease acquire/occupied standby、按配置续租和 stale/error 失去领导权；
- stable app/message/partition identity 校验，以及 inserted/duplicate/conflict ACK 边界；
- `im.message.updated_v1` 与 receive 使用同一 ingress fencing；
- 同分区 FIFO、单调时间戳和 ACK timeout 后 tail 不越序；
- enqueue failure、activation callback failure 与 leadership-lost lifecycle；
- drain-before-release、lost callback-before-release，以及覆盖 release 的单一 shutdown deadline。

`test/durable-outbox-settlement.test.ts` 覆盖 fenced enqueue、跨副本 pending→attempting→delivered、duplicate/ambiguous、conflict/stale lease 与本地 abort 不篡改 durable row。

`test/cli-durable-session-send.test.ts` 覆盖逻辑会话稳定 final UUID、daemon 连接丢失/启动期 5xx 的同 payload 有界重试，以及 durable ambiguous 不重试。

`test/durable-lark-session-output.test.ts` 覆盖 Session-before-outbox 顺序、同一 epoch fencing、type-ahead N+1 入会后 N 仍精确 enqueue 一次、权威 settlement、跨 Session target 预写拒绝，以及 Session occupied/outbox conflict/stale containment。

`test/durable-lark-final-output.test.ts` 覆盖 final-drain 同步注册、terminal settlement 后释放、pre-enqueue failure 与 shutdown abort 的有界释放。
