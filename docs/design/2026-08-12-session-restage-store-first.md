---
title: Session 终态：非分布式 virtual actor（持久化仅 SQLite）
type: design
date: 2026-08-12
updated: 2026-09-07（Stage 3 per-session turn 落地：开场激活窗口内的命令走按 sessionId 的队列，分散的计数 / 延迟交接 / 回放删除；Stage 4 降为低优先级；Stage 0 / Stage 1 收尾按升级窗口已关闭排期）
topic: session-virtual-actor
status: active
baseline: origin/master@61dadb04c（含已合入的 #852、#1073、#1093、#1051、#1202、#1280）
references:
  - PR #846（会话行唯一写入入口）
  - PR #852（per-bot SQLite + JSON 导入 + 混合窗口；已合入 master）
  - PR #1051（删除 daemon 侧 JSON 写路径 + 行级持久化；已合入 master）
  - PR #1202（Stage 1 occupancy：库内 `occupancy` 租约；已合入 master）
  - PR #1280（Stage 2 单一 apply：`services/session-commands.ts`；已合入 master）
  - Stage 3 per-session turn（`core/session-turn-queue.ts`；本轮落地）
  - #831 / feat/virtual_actor_stage2（不合入；SessionRuntime 只覆盖部分写点的失败记录）
---

# Session 终态：非分布式 virtual actor（持久化仅 SQLite）

本文是会话态后续实施的唯一口径。旧标题「store-first 重新分步」以及「每步合入必须立刻变简单」不再适用。#852 已把会话行持久化换到 SQLite；后续按终态收拢 occupancy、命令路径和 per-session 串行，不再把这三件事拆成互不相关的独立轨道。

## 0. 原则

核心判据是 **架构简明、可维护、可读**：稳态下需要同时理解的协议要少。不要求每个 PR 的 diff 行数立刻变负。

1. **终态优先。** 步骤为终态服务。允许一步只做其中一块，但禁止引入「旧路径完整保留、新层按设计将来整段删除」的平行实现。
2. **禁止只覆盖部分写点的 actor 层。** 不再引入 `SessionRuntime` / `SessionProjection`、按调用方群组横切、写点台账、审计 gate。occupancy / apply / turn 必须走同一条命令路径，CLI 与 daemon 共用。新增协议时必须写明将被替换的旧协议，以及旧协议的删除条件（可以分 PR 删除，但不能两套所有权长期并存且没有结束条件）。
3. **边界必须是结构性的**（模块导出、tsc 可检查）。禁止只靠约定维护的边界。
4. **修改会话状态 = 向该 session 发命令；同一时刻至多一个激活。** daemon 未运行时，不是另开一套磁盘写入协议，而是由宿主 CLI（或同属非沙盒 host 的 supervisor）在本进程成为该行的短生命周期激活、执行同一套 apply。产品语义「daemon 未运行时仍能 close / abandon」保留。沙盒内的 CLI 不在此列（见 §1）。
5. **不把旁路存储并入会话库。** turn-sends、frozen-card、whiteboard 文件、usage-ledger、idempotency、vc-meeting-*、`utils/file-lock.ts` 保持独立生命周期。会话行上的 `whiteboardId` 等字段走会话命令；白板正文仍走 whiteboard store。
6. **BotId 仍由地址推导，不引入分配式注册表。** 会话库内的占位租约只表示 occupancy，不是身份注册表。

施工可以分 stage；**稳态下的协议种类必须减少。** occupancy、JSON 回落、离线写、IPC、`abortIf`、mailbox 若无限期并行，读者需要同时记住多套互斥规则。

## 1. 终态

产品单元是 **一条话题对应一个 CLI 会话**。运行时按这个单元寻址和串行，而不是按「本机上的一份会话文件」来理解。

```
飞书事件 / botmux CLI / dashboard / worker IPC
        ↓
   按 sessionId 寻址（bot 级操作按 botId）
        ↓
   在 SQLite 事务内读取并获取 occupancy 租约
        ↓
   执行同一套 command apply（与当前 host 进程无关）
        ↓
   行级写入 SQLite；PTY / worker 由该会话激活持有，不另作状态权威
```

三部分必须同时成立，不能当成可以无限期分开交付的独立功能：

| 部分 | 稳态含义 |
|---|---|
| **身份** | `sessionId` 即寻址键 |
| **occupancy** | 同一时刻至多一个激活；租约与会话行在同一 SQLite 事务中读写 |
| **turn** | 针对该 `sessionId` 的命令在跨 `await` 后仍串行执行。实现是按 session 的 Promise 链 / 队列，不引入新的类型层 |

Host 进程可以更换，apply 实现不能分叉：

- **daemon 运行中**：由该 bot 的长驻 daemon（或 supervisor 下的 bot 进程）持有激活。进程拓扑与现状相同。
- **daemon 未运行**：宿主 CLI（或 supervisor）在本进程执行**同一模块**的 close / abandon / prune / 白板绑定（`services/session-commands.ts#applySessionRowCommand`）。临时 host 的激活 = 一次排他的 store 事务（SQLite `BEGIN IMMEDIATE`，或升级窗口内 JSON 的文件锁）：事务内读 `occupancy` 行判权威、读新鲜行、apply、发布。**不写租约行**——同一事务内的 claim + release 对其它连接不可观测；而跨多步 abandon 持有租约只会让期间启动的 daemon 按接管规则被判 `displaced`，直到下一个心跳 tick 才重试。多步命令的每一步在各自事务内重验权威。`mutateSessionRowOffline` 这种「任意闭包改行」的入口已删除；非 owner 进程只能对行施加 `HostSessionCommand`。今天走这条路径的只有宿主 CLI 与 dashboard 进程（删板解绑）——supervisor 不写会话行。
- **沙盒内的 CLI 不能成为 host。** `botmux send` 一类跑在 bwrap / Seatbelt 里的进程读不到 daemon IPC secret（改用本轮的 origin capability 证明身份）。它只能发命令；daemon 不在时它明确失败，不能退化成自己写盘。判定用正向信号（`core/managed-origin-capability.ts#isIsolatedCliProcess`：沙盒 outbox env、宿主打的 read-isolation env、宿主给每种隔离形态都打的 origin channel env、探针 inode 上的内核拒绝），**不用「读不到 secret」**——从未跑过 daemon 的机器上宿主 shell 也读不到 secret，它必须保留离线 close。
  ⚠️ 这道闸的依据是 **confused-deputy**，不是「它反正写不了盘」：只有 full sandbox 对会话库是 readOnly；credential-only 的 bwrap / Seatbelt 只掩掉 `device-auth` 与根级凭据文件，`BOTMUX_HOME`（含 `session-stores/`）对子进程**仍然可写**（见 `worker.ts` 挂载处 “leaving BOTMUX_HOME itself live and writable” 的注释，以及 `isIsolatedCliProcess` 的 docstring）。挡的是被 prompt 注入的 agent 借官方原语离线改会话行——**不要按「反正写不了」把 origin-channel 那条判定删掉**。

持久化：

- 运行时唯一的会话行存储是 per-bot `session-stores/<appId>/sessions.db`。打开连接必须走 `sqlite-compat`（Node `node:sqlite` / Bun `bun:sqlite`），禁止直连。
- 写入是行级 upsert；`journal_mode=WAL`、`synchronous=NORMAL`（不低于历史上 JSON `tmp+rename` 且不 fsync 的耐久性；本阶段不提高 durability）。
- 磁盘上可能仍有导入后未删除的 `sessions-*.json`，只作回退到旧版本时的副本，运行时不读不写。发布产物里不再包含 JSON 会话读写实现。

粒度：

- **寻址和 turn 的键是 session。** 激活可以仍由 per-bot daemon 进程承载（不必引入 Orleans 或跨机器调度）。
- 现状是整个 bot 的 `Map<string, Session>` 共用一个进程：该进程退出后，此 bot 下所有会话的内存权威同时失效。终态允许只激活单个 session；SQLite 行级读写已支持这一点。
- `DaemonSession` 的共享可变别名可以保留，直到有独立的重构理由。去掉别名既不能实现 occupancy，也不等于 mailbox。

Mailbox 在本仓库里要解决的问题：飞书、dashboard、CLI、worker 会并发进入同一 `sessionId`，但一条会话一次只应执行一个 turn。JavaScript 单线程不能防止这一点——`await` 之后另一条请求可以插进同一 session。现有 FIFO、generation、inflight、gate、tail-admission 是分散的串行化实现；终态用按 `sessionId` 的命令队列替换它们，而不是再包一层 runtime 类型。

## 2. 当前基线

以 **#852 合入 master（会话行已在 SQLite）** 为基线。#1051 合入后，daemon 进程不再写 JSON。

已具备：

- 会话行的落盘入口在 `session-store.ts`（#846）。其它模块不应再按路径拼装并直接写 `sessions*.json`。
- per-bot SQLite：整行 JSON 列 + VIRTUAL 生成列；首次 `load()` 使用 `BEGIN IMMEDIATE`；worker `owner: false` 不执行导入。
- 行级 `persistRow`：不再每次把整个 `Map` 序列化覆盖文件，因此不再出现「外部已提交的行被陈旧整图覆盖」。
- `closeSession` / `reactivateClosedSession` / mojo journal：先写入副本，成功后再 `Object.assign` 到内存对象（别名保持）。
- bun 单文件二进制；打开库走 `sqlite-compat`。损坏的 `.db` 与「运行时没有 SQLite 引擎」分开处理。

相对终态仍缺：

- **occupancy 已在同库 `occupancy` 表。** 租约在 `BEGIN IMMEDIATE` 内判定，有效租约一票否决离线写；`findOnlineDaemon` 不再是唯一所有权来源。没有有效租约（缺行 / 过期 / 不可读）时心跳仍参与判定——这是升级窗口（只写会话行、不写 occupancy 的 daemon，含回滚后的旧构建）。删除该回落的条件与 Stage 0 JSON 读路径相同。
- **apply 已收成一份**（Stage 2）。行级变换只在 `services/session-commands.ts`：daemon 的 `closeSession` / `/whiteboard` 路由与宿主的 `services/session-command-host.ts`（`applySessionCommandAsHost` / `readSessionRowAsHost`）都调用它。仍分开的是**运行时拆除**（daemon 的 killWorker / remote cancel prepare vs 宿主 CLI 的 SIGTERM + backing 销毁）与 close 后的旁路清理（宿主只做 dashboard 图片目录清理；turn-sends / prompt-ctx / frozen-card 仍由 daemon 清）。
- **per-session turn 已有（Stage 3）。** `core/session-turn-queue.ts#runSessionTurn` 是按 `sessionId` 的 Promise 链；开场激活窗口内的命令（后到消息的 prompt 构造 + durable tail 落盘、开场 ACK 对路由的释放）都走它。仍在队列外的是 fork 边界的所有权 `initialStartClaimToken`（跨越整段资源准备，见 Stage 3「有意保留」）与 pendingRepo 等待期的缓冲（等人，不是等 `await`）。
- **跨进程仍可能读 JSON**（#1051 保留）：当 CLI 已升级、daemon 仍在写 JSON 时，快照、点读、身份扫描、worker、`owner: false` 走 db-else-json。这是迁移兼容，不是终态。升级窗口已按关闭处理（见 Stage 0 的状态记录），这些分支在收尾 PR 里删除。磁盘上的冻结 JSON 文件可以保留。

#831 / `SessionRuntime` **不合入**。失败原因是只把约 32% 的写点迁入新层、旧 API 完整保留、约 17k 行适配层按设计要整段删除，并在 build 上挂审计脚本。这不能证明会话桥不该用 virtual actor。写点地图和 receipts/lane 只作线索，立项前在现行代码上复核。

## 3. 后续 stage（#852 之后）

从会话行已在 SQLite 起重新划分。旧 Step 1–5（摘取缺陷 / 唯一写入入口 / 换引擎 / 按痛点加事务 / 归档）只记录已完成工作，不再当路线图。

### Stage 0 — 删除 daemon JSON 写路径【#1051 已合入；收尾：JSON 读路径】

**目标**：daemon 只写 SQLite；JSON → SQLite 导入正确；运行时更新走行级 upsert。

#1051 已覆盖本 stage 中收益最大的部分（§4）。本 stage 只收尾，不要把 occupancy 放进同一 PR。

已纳入 #1051 的 Stage 0 缺口：

- dashboard 删除白板：daemon 运行中经 IPC 解绑，daemon 不可见时才离线写。两条路径都对板 id 做比对后再改——删板已经先把板移出 index，daemon 的 `ensureSessionWhiteboard` 会在该会话下一轮立刻补一块新板，无条件清除会把这块新绑定一起抹掉。IPC 侧的比对是路由新增的 `expectWhiteboardId`（不匹配返回 409）。
- 因 daemon 可见而没能解绑的会话计入 `unresolvedSessions` 返回，不再和「没有会话引用这块板」一样报 0。
- 解绑的 daemon IPC 带超时：心跳新鲜但 socket 不响应的 daemon 不能把 dashboard 的删除请求一直挂住。
- 离线写收敛为一个入口 `services/session-offline-write.ts#mutateSessionRowWhenUnowned`（`mutateSessionRowOffline` + 心跳探测），CLI 与 whiteboard-store 共用；CLI 私有的那份心跳解析与 90s 判定删除，改用 `utils/daemon-discovery.ts`。探测与 store 读写用同一个 dataDir。
- `mutateSessionRowOffline` 的 sqlite 路径在 `openDbForOwnStore` 前再做一次 `existsSync`：读写 open 会创建空库，导致导入门把尚未导入的 store 当成已导入。
- PR 标题与描述以「daemon 不再写 JSON；跨进程在升级窗口内仍可读 JSON」为准，不再写全仓 db-only。

**JSON 读路径的删除条件（两条，先到先算）：**

1. 升级后自动重启 fleet 落地——线上不再有仍在写 JSON 的 daemon。
2. 兜底复核点 **2026-11-26**（本文 2026-08-28 定稿起 90 天）。届时若 fleet 自动重启仍未落地，就按当时 latest 与「`sessions.db` 首次进入 latest 的版本」之间的跨度，决定直接删除还是再延一期，并把结论写回本节。

第 2 条是必需的：fleet 自动重启不在本文范围，也没有承诺时间点。只写第 1 条，等于把跨进程 JSON 读做成 §不做 明令禁止的「长期不变量」。

**状态（2026-09-07）**：SQLite 引擎首次进入 latest 是 v3.18.0（2026-08-28），daemon 不再写 JSON 的版本是 v3.18.12（2026-09-02），occupancy 租约的版本是 v3.19.0（2026-09-06）。维护者已决定不再等 fleet 自动重启，按升级窗口已关闭处理；收尾 PR（本节的 JSON 读路径删除 + Stage 1 的心跳回落删除）排在 Stage 3 之后统一做，范围见 §5。

条件满足后，再开一个仍属 Stage 0 的 PR，从代码中删除 JSON 读路径（不必等 occupancy）：

- 删除跨进程 JSON 读/写、`StoreFileRef.kind` 分流、沙盒对冻结 JSON 的授权。
- 若无 `.db` 且尚未导入：失败并提示重启 daemon 完成迁移，不再实现完整的 JSON 离线写。
- 线上不再有仍在写 JSON 的 daemon 之后，删除导入实现及其文件锁；新 bot 直接创建空库。
- 磁盘上的冻结 JSON 文件可以保留，供回退旧版本读取。

删除条件满足之前，#1051 保留 db-else-json：升级窗口内 `botmux send` 必须仍能读到会话。这不是终态要求。

### Stage 1 — Occupancy 写入 SQLite【已落地】

**目标**：occupancy 与会话行在同一事务中读写。这是 grain directory（哪个进程持有激活），不是 actor 框架。

已落地：

1. 同库表 `occupancy(scope, owner_pid, boot_id, lease_until)`。v1 只有 `scope='bot'`；主键是 `scope`，不排除将来 `session:<id>`。
2. 拥有 store 的 daemon 在首次 `load()` 的 `BEGIN IMMEDIATE` 事务里领取占位（`init(..., { occupancy })`）。领取是有条件的：别的 boot 的租约只有在过期、或其 `owner_pid` 已不存在时才会被接管；仍然存活的前任保留所有权，后任记 warn 并在心跳里重试。领取失败（如只读库）只记 error，不阻止快照加载。descriptor 文件仍写，只作 IPC 发现。
3. 非当前 host 的 SQLite 写入：`BEGIN IMMEDIATE` → 读租约 → 有效则中止；没有有效租约时再看心跳（`abortIf`）；两者都不在场才允许宿主在同一事务内 apply（不写租约行，见 §1）。
4. 领取与续期是同一条语句（`claimOccupancyLease`），随 descriptor 心跳每 30s 执行，首次 load 之后立即执行一次（reconcile 可能已经提前触发过 load）。TTL 与心跳 staleness 共用 `DAEMON_HEARTBEAT_STALE_MS`（90s）。优雅关停期间租约一直持有到 `process.exit` 前才按 `boot_id` 释放——teardown 中 worker 仍在写回缓存；`exit` handler 兜底。
5. 所有权调用点：`applySessionCommandUnowned` / `applySessionCommandAsHost`、CLI close / abandon / prune、whiteboard 离线解绑。`findOnlineDaemon` 用于 IPC 地址、dashboard 展示，以及无有效租约时的心跳回落。已经**应答**的 daemon（任何 HTTP 状态）始终权威：它的拒绝是终态，不因租约状态回落到离线写；只有连接失败时才用 `isOccupancyHeld` 区分「daemon 在但不可达」与「descriptor 是残留」。

**心跳回落（不是长期双协议）**：没有有效租约时，仍用心跳判断「未写 occupancy 的 daemon 是否在线」——包括未升级的 #1051 daemon，也包括新构建崩溃留下过期行后回滚运行的旧构建。有效租约存在时心跳不再能放行（心跳陈旧也中止）。删除该回落的条件与 Stage 0 JSON 读路径相同（fleet 自动重启落地，或 2026-11-26 复核）。

仅用 `BEGIN IMMEDIATE` 替换心跳探测不算完成（已用租约表达「另一进程仍持有内存缓存」）。禁止 daemon 未运行时提交 close / abandon 也不算完成：产品语义保留，Stage 2 改为宿主在本进程执行同一 apply。

### Stage 2 — 单一 apply 路径【已落地】

**目标**：close / abandon / 解绑白板 / prune 等命令只有一份实现。依赖 Stage 1。

已落地：

1. `services/session-commands.ts#applySessionRowCommand(row, command, { now })`：`close` / `prune` / `whiteboard` / `worker-exited` 四条命令对行的唯一变换。纯函数、不做任何 I/O（它在宿主路径上跑在 `BEGIN IMMEDIATE` / 文件锁之内）；close 时的 token 快照由调用方在锁外采样后作为命令字段传入。幂等：对已关闭行再 close **不刷新 `closedAt`**；宿主 close（无 daemon 专属字段、无残留 runtime 字段）是 `noop`。daemon 专属的 park / journal wipe 在已关闭行上仍可落地——并发二次 close 输掉 status 竞态时不能把 residual 丢掉。
2. daemon 侧 `session-store.closeSession` 与 `/api/sessions/:id/whiteboard` 路由改为调用它；daemon 独有的 close 输入（`tokenUsage`、`parkMojoLineage`、`parkLocalResidual`、`clearRiffParentTaskId`、`clearMojoCloseJournal`）在 `HostSessionCommand` 上被类型化为 `never`——宿主构造不出能抹掉 mojo 对账栅栏或钉死 token 快照的命令，边界由 tsc 检查。
3. `session-store.mutateSessionRowOffline(target, 闭包)` 删除，替换为 `applySessionCommandUnowned(target, HostSessionCommand)` 与 `readSessionRowUnowned(target)`（同一事务、同一权威判定、不写）。结果是判别联合：`applied` / `noop` / `refused(reason)` / `owned` / `missing` / `contended`——不再用 `undefined` 混同「被占用」「行不存在」「锁竞争」。
4. `services/session-offline-write.ts` 改名为 `services/session-command-host.ts`：`applySessionCommandAsHost` / `readSessionRowAsHost` / `isOccupancyHeld`，补心跳回落探针、并在 commit 后做 close 释放的 dashboard 图片目录清理（与 daemon 的 close 后清理同一函数）。CLI 的 delete / prune / whiteboard 与 dashboard 删板解绑都走它；CLI 私有的三份字段清单删除。
5. 沙盒 / 读隔离 CLI：daemon 不可达时 `botmux delete` 明确报错、`list` 自动 prune 与 `whiteboard` 绑定返回失败并保留行，不再尝试离线写（以前会在只读挂载上抛 SQLite 错误栈）。
6. 有意保留的差异：宿主 close 不写 `tokenUsage`（宿主 shell 未必能解析 BOT_HOME 下的 transcript，落一个永久 `null` 会让 dashboard 停止实时计算）；宿主 close 不抹 `mojoCloseJournal`（与改前离线 close 一致）。以前离线 close 额外删除的 `codexAppDispatchLedger` / `queuedActivation*` / `pendingRepoSetup` 现在与 daemon 一致地保留在已关闭行上（daemon 从未删过它们，resume 时由 `reactivateClosedSession` 清）。
7. `abortIf` + `findOnlineDaemon` 仍是无有效租约时的回落；该回落随升级窗口关闭一并删（条件同 Stage 0 / Stage 1）。

未纳入本 stage：daemon 与宿主各自的运行时拆除（worker / backing 的杀法）本来就分属两种进程形态，不是行级 apply；IPC 传输层（`postSessionCliIpc` 的 capability 鉴权 vs `fetchDaemonIpc` 的 host HMAC）承载不同的鉴权语义，不合并。

### Stage 3 — Per-session turn【已落地：开场激活窗口】

**目标**：同一 `sessionId` 上的命令在跨 `await` 后仍串行。按 session 排队，不引入 `SessionRuntime`。

已落地：

1. `core/session-turn-queue.ts#runSessionTurn(sessionId, command)`：按 `sessionId` 的 Promise 链，命令按入队顺序执行、跨自身 `await` 不交错，前一条失败不阻塞后一条；链空即回收。没有 mailbox 类型、没有 actor 对象。`hasPendingSessionTurns(sessionId)` 供入口判定「这条 session 上还有命令没跑完」。
2. 收进队列的命令，全部在**开场激活窗口**——到达 → 构造 prompt（`await` 发送者查询）→ 落 durable tail：
   - 同 anchor 后到消息的两处入口（`initialStartPending` 下的 follower；worker 已死、带 retained journal 的 refork 前置 staging）统一走 `admitFollowerBehindOpening`：到达时同步取 FIFO 序号，构造 + 落盘作为一条命令入队。若开场的释放在它之前跑完（tail 为空、路由已放开），同一条命令内联 promote，不再排队。pendingRepo 分支从到达到落盘没有 `await`，不需入队。
   - 开场的路由释放 `releaseQueuedActivationReservation`（worker `queued_activation_submitted` ACK、普通冷 fork 后的交接、失败重试）入队，因此必然在先到的 follower 落盘之后执行。
   - `hasQueuedActivationAdmissionGate` 用 `hasPendingSessionTurns` 代替计数：队列上有命令时，live worker 的普通 turn 也进 durable tail，不得插队。
3. 删除的分散 fence：`queuedActivationTailAdmissionsOutstanding` 计数、`queuedActivationTailReleasePending` 延迟交接、`reserveAsync… / settleAsync…` 回放；`forkReservedInitialSession` 与原始命令冷启动对计数的判定改为查队列。保留的 100ms 重试定时器只负责「promote 落盘 / IPC 失败后重试」，不再承担排序。
4. 顺手删除的死代码：`pendingQueuedActivationFollowUps` 与 `reparkQueuedActivationFollowUpTail`——#597 的 durable tail 落地后没有任何写入方，repark 恒返回 false。

有意保留、不入队的：

- `initialStartClaimToken` / `initialStartPending`：fork 边界的所有权，跨越 `handleNewTopic` 从资源准备到 fork 的整段异步（秒级）。期间到达的 follower 必须**立刻**落 durable tail 才扛得住 daemon 崩溃；把整段准备做成队列命令会让 follower 在内存里等待、失去这层持久化。它是状态，不是 `await` 间隙。
- `pendingRepo` 等待期的 `pendingFollowUps*` 缓冲：等人点卡片，队列不能被人拿着。
- `admitQueuedActivationTail` / `promoteQueuedActivationTail` 里「store 外备份再回滚」的写法：删除条件不变——daemon 侧出现「按命令更新且不替换 `ds.session` 引用」的 apply 入口（`closeSession` 已是该形态）。让 admit 走它需要新的 store 导出，并改动多个 stub 了 `updateSession` 的测试夹具；本轮未做，与 promote 的四份备份一起处理。
- worker generation / exit 路径上的 `updateSession`：没有复现证据（相关回归测试覆盖的是重启协调器）。按本节「没有复现的路径不改」不动。

后续再有证据的交错路径，用 `runSessionTurn` 包住那一段即可，不再新增计数或标志。

### Stage 4 — （低优先级）按 session 隔离激活

**暂不立项。** 触发条件是「同一 bot 进程容纳全部会话导致事件循环或崩溃域不可接受」，目前没有证据：2026-08-23 的恢复风暴发生在共享 tmux server 层（见 `test/tmux-startup-storm-recovery.test.ts`），按 session 拆进程解决不了它。Stage 0–3 不依赖本 stage；调度仍在本机，不引入跨机器放置。只有出现上述证据时再评估。

### 不做

- 合入 #831，或任何只把部分写点迁入新层、旧路径完整保留的 runtime。
- 把旁路文件并入会话库。
- 为 actor 引入 BotId 分配或注册表。
- 把跨进程 JSON 读取写成长期不变量。
- 以「本 PR 净行数未减少」否决朝终态收敛的改动。

## 4. #1051 与终态的关系

**#1051 已合入 master。** Stage 0 主体完成；不要回头在后续 PR 里把 occupancy 和 JSON 读路径删除搅在一起。

已覆盖：

- 删除 daemon 的 JSON 写路径（整图 `save()`、JSON CAS、运行时 JSON 迁移写入）。这是换引擎之后减少协议种类最多的一块。
- 行级 upsert，不再用陈旧整图覆盖已提交行。
- 导入：暂存库使用 `journal_mode=DELETE`（避免 bun:sqlite 在 WAL 下 `rename` 出只有文件头的库）、按文件 key 插入而不按行内 `sessionId` 重键、`owner: false` 只读、不因探测路径创建空库而跳过导入。
- close 路径先写 SQLite 再合并回内存对象，与单一 apply 方向一致，保留。
- 测试夹具写入真实 SQLite，不再靠写 JSON 让「唯一写入入口」测试误绿。
- 删除白板：daemon 运行中 IPC 解绑，未运行时离线写，两侧都对板 id 比对；无法解绑的会话计入返回。sqlite 离线写打开前拒绝缺文件。
- 离线写与 daemon 发现各收敛成一份实现（见 §3 Stage 0 缺口）。Stage 1 / Stage 2 的删除面因此只剩一个入口。

#1051 明确没做、也不该做的（现仍成立）：

- 跨进程改为只读 SQLite。在升级窗口关闭前删除 JSON 回落，会让窗口内的 `botmux send` 失败。删除条件见 Stage 0。

合入 #1051 后的状态：daemon 只写 SQLite；其它进程在升级窗口内仍可能读 JSON。Stage 1 之后：occupancy 在同库租约。Stage 2 之后：行级 apply 只有 `session-commands.ts` 一份，非 owner 进程只能施加命令。之后按 Stage 3 推进。

## 5. 建议顺序

```
#1051 合入     Stage 1 落地     删除条件满足          单一 apply       turn
    |               |        (fleet 落地 / 复核点)         |              |
    +-- Stage 0 ----+-- Stage 0 收尾 -----|                |              |
    |  JSON 写删除  |  删 JSON 读 / 缺行回落               |              |
    +-- Stage 1 ----+----------------------+-- Stage 2 ----+-- Stage 3 ---|
       occupancy
```

- **#1051**：删除 daemon JSON 写路径；含白板解绑的 compare-and-set、离线写打开前拒绝缺文件、离线写与 daemon 发现各收敛成一份实现。
- **Stage 1**：occupancy 写入 SQLite；有效租约一票否决，`findOnlineDaemon` 降为无有效租约时的回落。回落的删除条件见上。
- **删除 JSON 读路径**：升级窗口已按关闭处理（见 Stage 0 的状态记录），与 Stage 1 心跳回落一起进下面的收尾 PR。
- **Stage 2（已落地）**：daemon 未运行时宿主在同一事务内执行同一 apply，删除第二套对外写协议（任意闭包改行）。这一阶段减少的概念最多。
- **Stage 3（已落地）**：开场激活窗口内的命令收进按 `sessionId` 的队列；计数 / 延迟交接 / 回放删除。不设「迁完全部写点」的完成门。
- **下一个 PR：Stage 0 / Stage 1 收尾（净删除）**，升级窗口已按关闭处理（见 Stage 0 状态）：
  - `session-store`：删 db-else-json 分流（`StoreFileRef.kind`、`resolveStoreFile` / `listStoreRefs` 的 JSON 分支、`readStoreEntries` / `readStoreRowByKey` / `readStoreActiveRows` / `countActiveSessionsOnDisk` 的 JSON 分支）、`getSessionFresh` 的 JSON 文件锁读、非 owner 进程无库时的 `loadFromFrozenJson`、宿主命令的 JSON 文件锁写路径。无 `.db` 且尚未导入时非 owner 进程明确报「会话库尚未迁移，请重启 daemon」。
  - 删 `abortIf` 心跳回落：`session-command-host` 的 `legacyHeartbeatHeld` / `hostOptions`，`isOccupancyHeld` 只看租约；`sqliteOccupancyBlocksWrite` 去掉 `abortIf`。
  - 沙盒 `fs-policy`：不再授权 `sessions-<self>.json` 只读（两处）。
  - `core/mojo-containment-command.ts#defaultIsSessionActive` 仍直接扫 `sessions*.json`：SQLite 后它对所有会话都答「不活跃」，revoke 的安全闸静默失效。改为读 store（严格跨 store 点读，保留「有库读不了 → 未知」的三态）。
  - 保留：owner daemon 首次 load 的一次性导入及其文件锁、中毒库恢复。它不是跨进程协议；删掉会让从 3.17.x 直接升到新版的用户静默丢会话。其删除条件是「升级来源不可能低于 3.18.0」，晚于本次。
  - 测试：`session-store` / `session-store-sqlite` / `session-occupancy` / `session-delete-cli` / `whiteboard-unbind-session` / `fs-policy` / `mojo-containment` 里的 JSON 窗口与心跳回落用例改为 fail-closed 断言。

`closeSession` 的字段级回滚已在 #1051 替换；async tail-admission 已在 Stage 3 收进队列。`admitQueuedActivationTail` / `promoteQueuedActivationTail` 的回滚写法与 generation / exit 上无保护的写入仍归 Stage 3 的后续（见其「有意保留」）。`initial-user-turn` 在落盘失败时仅更新内存：有复现再进入 Stage 2 或 3，不单独开事务修复轨道。

## 6. 历史

2026-08 曾用 `SessionRuntime` 包装会话写入（#831）。按调用方群组迁移导致新旧路径长期并存，大部分写点未迁入，适配层按设计要整段删除，审计脚本挂在 build 上。**不合入。** 从中保留并已落地的是：会话行唯一写入入口（#846）、JSON 换成 SQLite（#852）。当时记录的多数「缺陷」是那次包装自己引入的回归，不作为现行证据。

同期口径要求「每步合入必须立刻更简单、收益不得递延、先做存储且不实现 actor」。它避免了再次合入只覆盖部分写点的 runtime，也把 occupancy、单一 apply、turn 拆成互不相关的步骤。本文取代该口径。会话行已由 SQLite 持久化之后，终态是本机 virtual actor：命令、库内租约、按 session 串行；host 进程可更换；不存在第二套权威写入。
