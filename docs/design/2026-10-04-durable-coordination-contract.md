# Durable coordination contract

## 背景

BotMux 当前把入站去重、同会话串行、Session 状态和投递回执分别保存在进程内结构、本地文件或 SQLite 中。这些实现适合单 daemon，但不能直接把同一份打开的 SQLite 交给多个主机，也不能用进程内 Promise queue 证明跨副本串行。

本设计先抽出与具体数据库无关的最小协调合同，并提供 SQLite 参考实现。现有单机路径保持不变；后续实现可以在不改变状态机的前提下接入远程事务数据库。

## 不变量

1. 入站平台事件以稳定 `eventId` 幂等；同键同 payload 是 duplicate，同键不同 payload 是 conflict。
2. inbox 使用 `partitionKey` 保序。同一分区同一时刻最多一个有效 claim，不同分区可并行。
3. 逻辑 Session 由 owner lease 保护；每次过期接管或释放后重领都会递增 `epoch`。所有 Session 写入和 outbox 创建必须携带未过期的 `(sessionKey, ownerId, epoch)`。
4. 租约时间由 store 自己决定。本地实现使用注入时钟；远程实现必须在事务内使用服务端时间，不能信任不同 worker 的墙钟。
5. Session 状态使用 revision compare-and-set，避免新 owner 的更新被旧快照覆盖。
6. outbox 先 reserve，再显式 begin attempt。`reserved` 尚未越过副作用边界，租约过期后可以重新领取；`attempting` 已可能产生外部副作用，租约过期后只能进入 `ambiguous`，不能自动重放。
7. confirmed receipt 可以结算精确的旧 attempt；不同 claim epoch 或 attempt number 的迟到结果必须被拒绝。

## ACK 边界

Lark WebSocket handler 当前依赖 `claimMessageOnce` 与 `setImmediate` 之间没有 `await`：同一 chat 的事件按到达顺序进入 raw ingress lane，并在 SDK 的 ACK 预算内返回。远程协调调用不能进入这段同步热路径。

后续接线必须保持两层：

```text
WS callback
  ├─ 同步本地 quick claim（只用于挡当前进程重推）
  ├─ 同步 schedule + 返回 ACK
  └─ setImmediate 后 durable enqueue(eventId, partitionKey, payload)
        └─ worker claim partition
             └─ 解析 canonical Session
                  └─ acquire Session lease / epoch
                       ├─ CAS Session state
                       └─ enqueue outbox
```

本地 quick claim 不是分布式正确性来源；跨副本幂等由 durable inbox 唯一键提供。ACK 后 enqueue 失败时，调用方必须可见地重试或进入降级策略，不能把本地 quick claim 当作已经持久接收。

## 接口与状态机

公共接口位于 `src/services/durable-coordination.ts`，包括四组原语：

- Session lease：`acquire`、`renew`、`release`，返回单调 `epoch`。
- Session state：`read` 与 fenced revision CAS `write`。
- Inbox：幂等 enqueue、分区 claim、renew、complete、retry。
- Outbox：fenced enqueue、reserve、begin attempt、delivered/retry/ambiguous 结算。

SQLite 参考实现位于 `src/services/sqlite-durable-coordination.ts`，使用独立 schema 和短事务。长 turn 不持有数据库事务，只持有可续租的 Session lease。

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

后续接入按小步完成：先在 ACK 后增加可选 durable inbox，再迁移 Session 状态调用面，最后启用 durable outbox pump。每一步都必须保留关闭开关和现有 SQLite 行为回归。

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
