---
title: Session 终态：非分布式 virtual actor（持久化仅 SQLite）
type: design
date: 2026-08-12
updated: 2026-09-01（rebase 到 origin/master@7bd2e974；基线含 #852 / #1073 / #1093）
topic: session-virtual-actor
status: active
baseline: origin/master@7bd2e974（含已合入的 #852、#1073 导入 WAL 空壳、#1093 中毒库恢复）；#1051 删除 daemon 侧 JSON 写路径（进行中）
references:
  - PR #846（会话行唯一写入入口）
  - PR #852（per-bot SQLite + JSON 导入 + 混合窗口；已合入 master）
  - PR #1051（删除 daemon 侧 JSON 写路径 + 行级持久化；进行中）
  - #831 / feat/virtual_actor_stage2（不合入；SessionRuntime 只覆盖部分写点的失败记录）
---

# Session 终态：非分布式 virtual actor（持久化仅 SQLite）

本文是会话态后续实施的唯一口径。旧标题「store-first 重新分步」以及「每步合入必须立刻变简单」不再适用。#852 已把会话行持久化换到 SQLite；后续按终态收拢 occupancy、命令路径和 per-session 串行，不再把这三件事拆成互不相关的独立轨道。

## 0. 原则

核心判据是 **架构简明、可维护、可读**：稳态下需要同时理解的协议要少。不要求每个 PR 的 diff 行数立刻变负。

1. **终态优先。** 步骤为终态服务。允许一步只做其中一块，但禁止引入「旧路径完整保留、新层按设计将来整段删除」的平行实现。
2. **禁止只覆盖部分写点的 actor 层。** 不再引入 `SessionRuntime` / `SessionProjection`、按调用方群组横切、写点台账、审计 gate。occupancy / apply / turn 必须走同一条命令路径，CLI 与 daemon 共用。新增协议时必须写明将被替换的旧协议，以及旧协议的删除条件（可以分 PR 删除，但不能两套所有权长期并存且没有结束条件）。
3. **边界必须是结构性的**（模块导出、tsc 可检查）。禁止只靠约定维护的边界。
4. **修改会话状态 = 向该 session 发命令；同一时刻至多一个激活。** daemon 未运行时，不是另开一套磁盘写入协议，而是由宿主 CLI 或 supervisor 取得租约、在本进程执行同一套 apply。产品语义「daemon 未运行时仍能 close / abandon」保留。沙盒内的 CLI 不在此列（见 §1）。
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
- **daemon 未运行**：宿主 CLI 或 supervisor 获取租约，在本进程执行同一段 close / abandon / 解绑白板，写入同一行后释放租约。不再使用 `mutateSessionRowOffline` 作为另一套权威写入。
- **沙盒内的 CLI 取不到租约。** `botmux send` 一类跑在 bwrap / Seatbelt 里的进程对会话库只有 readOnly 授权，也读不到 daemon IPC secret（改用本轮的 origin capability 证明身份）。它只能发命令；daemon 不在时它只能失败，不能退化成自己写盘。因此「取租约就地 apply」的主体是宿主 CLI 与 supervisor，不是全部 CLI 进程——Stage 2 的设计必须显式区分这两类调用方。

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

- **occupancy 存在旁路文件里。** `utils/daemon-discovery.ts` 的 `findOnlineDaemon` 读 `dashboard-daemons/*.json` 心跳（90s 过期），写入目标却是会话行。SQLite 锁只串行化写者，不能判断「另一进程是否仍持有将要 `persistRow` 的内存缓存」。在租约写入 SQLite 之前，必须保留 `abortIf` 双次探测。
- **两套 apply。** daemon 使用 `updateSession` / `persistRow`；其它进程使用 `services/session-offline-write.ts` 的 `mutateSessionRowWhenUnowned`（心跳探测 + `mutateSessionRowOffline`）。后者是第二套权威，不是「临时 host 执行同一套命令」。#1051 已把它收敛成一份实现，删除时只有一个入口。
- **没有 per-session turn。** 进程内仍依赖多处独立的 fence。
- **跨进程仍可能读 JSON**（#1051 保留）：当 CLI 已升级、daemon 仍在写 JSON 时，快照、点读、身份扫描、worker、`owner: false` 走 db-else-json。这是迁移兼容，不是终态。删除这些分支的条件见 Stage 0（fleet 自动重启落地，或 2026-11-26 的兜底复核点）。磁盘上的冻结 JSON 文件可以保留。

#831 / `SessionRuntime` **不合入**。失败原因是只把约 32% 的写点迁入新层、旧 API 完整保留、约 17k 行适配层按设计要整段删除，并在 build 上挂审计脚本。这不能证明会话桥不该用 virtual actor。写点地图和 receipts/lane 只作线索，立项前在现行代码上复核。

## 3. 后续 stage（#852 之后）

从会话行已在 SQLite 起重新划分。旧 Step 1–5（摘取缺陷 / 唯一写入入口 / 换引擎 / 按痛点加事务 / 归档）只记录已完成工作，不再当路线图。

### Stage 0 — 删除 daemon JSON 写路径【进行中：#1051】

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

条件满足后，再开一个仍属 Stage 0 的 PR，从代码中删除 JSON 读路径（不必等 occupancy）：

- 删除跨进程 JSON 读/写、`StoreFileRef.kind` 分流、沙盒对冻结 JSON 的授权。
- 若无 `.db` 且尚未导入：失败并提示重启 daemon 完成迁移，不再实现完整的 JSON 离线写。
- 线上不再有仍在写 JSON 的 daemon 之后，删除导入实现及其文件锁；新 bot 直接创建空库。
- 磁盘上的冻结 JSON 文件可以保留，供回退旧版本读取。

删除条件满足之前，#1051 保留 db-else-json：升级窗口内 `botmux send` 必须仍能读到会话。这不是终态要求。

### Stage 1 — Occupancy 写入 SQLite

**目标**：occupancy 与会话行在同一事务中读写。这是 grain directory（哪个进程持有激活），不是 actor 框架。

实现要点：

1. 库内保存占位：`owner_pid` / `boot_id` / `lease_until`（或等价的 SQLite 锁会话）。第一版粒度可以 per-bot（与当前 daemon 进程同构）；表结构不要排除将来改为 per-session。
2. daemon 在首次 `load()` 的同一事务里写入占位。现状是先写 descriptor 文件再 `load()`，两者不在同一原子操作中。
3. 非当前 host 的写入：`BEGIN IMMEDIATE` → 读租约 → 租约有效则中止并走 IPC（或等待）；租约过期才进入 Stage 2 的短生命周期激活。探测与写入在同一事务内完成。
4. 租约按心跳续期。90s 过期已有实现，只是心跳文件与会话行不在同一事务。

验收：`findOnlineDaemon` **不再作为所有权判断**（仍可用于发现 IPC 地址）。#1051 已把 CLI 私有的那份心跳探测并进 `utils/daemon-discovery.ts`，所以验收只需盯住这一个实现的调用点——`services/session-offline-write.ts` 的 `abortIf`、`cli.ts` 的 close / abandon / prune、`whiteboard-store` 的解绑。`dashboard/registry.ts` 读同一批心跳文件，但只用于展示和路由，不参与所有权判断。

长期同时使用心跳探测和库内租约不算完成。仅用 `BEGIN IMMEDIATE` 替换心跳探测也不算完成：锁不能表示「另一进程仍持有待写回的内存缓存」。禁止 daemon 未运行时提交 close / abandon 也不算完成：产品语义保留，实现改为获取租约后在本进程 apply。

#852 之后，这一 stage 的架构收益最大。不做它，turn 队列和单一 apply 无法约束 CLI / dashboard 进程。

### Stage 2 — 单一 apply 路径

**目标**：close / abandon / 解绑白板 / prune 等命令只有一份实现。依赖 Stage 1。

- CLI、dashboard 只发送命令。daemon 运行中：经 IPC 进入当前激活。daemon 未运行：宿主 CLI / supervisor 获取租约，在本进程调用 **同一模块** 的 apply，然后释放租约。
- 沙盒内的 CLI 没有租约能力（§1）：它只发命令，daemon 不在时明确失败。别把它和宿主 CLI 当成同一类调用方。
- 删除 `mutateSessionRowWhenUnowned` / `mutateSessionRowOffline` 作为对外权威写入的语义（若仍存在，只能是短生命周期激活的内部实现，不再是第二条公共写协议）。
- `abortIf` + `findOnlineDaemon` 的所有权探测随 Stage 1 删除。
- daemon 持有激活时，其它进程不得直接更新会话行。

这一步才把「daemon 未运行仍能修改会话」做成与终态一致的实现。若只完成 Stage 1、CLI 仍作为另一套权威写 SQLite，需要理解的协议几乎没有减少。

### Stage 3 — Per-session turn

**目标**：同一 `sessionId` 上的命令在跨 `await` 后仍串行。按 session 排队，不引入 `SessionRuntime`。

- 按 `sessionId` 将命令闭包入队（或等价的 Promise 链）。host 仍是 bot 进程。
- 用队列替换已有测试或线上证据的分散 fence（async tail-admission、worker generation / exit 路径上无保护的 `updateSession`、队首激活 FIFO 等）。没有复现的路径不要为了「更像 actor」而改。
- stage2 的 receipts / lane 只作线索，立项前在现行代码复核。

daemon 进程内部可以先于 Stage 2 排队；**对外保证**要等所有外部入口都走同一 apply，否则队列覆盖不到 CLI / dashboard。

`admitQueuedActivationTail` 一类在 store 外做字段备份再回滚的逻辑：在「按命令更新且不替换 `ds.session` 引用」的 apply 入口出现后删除。不要为少写几行回滚代码单独增加一个公共 patch API。

### Stage 4 — （可选）按 session 隔离激活

仅当「同一 bot 进程内容纳全部会话」导致事件循环或崩溃域不可接受时立项。Stage 1–3 不依赖本 stage。调度仍在本机，不引入跨机器放置。

### 不做

- 合入 #831，或任何只把部分写点迁入新层、旧路径完整保留的 runtime。
- 把旁路文件并入会话库。
- 为 actor 引入 BotId 分配或注册表。
- 把跨进程 JSON 读取写成长期不变量。
- 以「本 PR 净行数未减少」否决朝终态收敛的改动。

## 4. #1051 与终态的关系

**Stage 0 中收益最大的部分已经覆盖，应当合入；不要在本 PR 做 Stage 1。** 增补仅限 Stage 0 缺口。

已覆盖：

- 删除 daemon 的 JSON 写路径（整图 `save()`、JSON CAS、运行时 JSON 迁移写入）。这是换引擎之后减少协议种类最多的一块。
- 行级 upsert，不再用陈旧整图覆盖已提交行。
- 导入：暂存库使用 `journal_mode=DELETE`（避免 bun:sqlite 在 WAL 下 `rename` 出只有文件头的库）、按文件 key 插入而不按行内 `sessionId` 重键、`owner: false` 只读、不因探测路径创建空库而跳过导入。
- close 路径先写 SQLite 再合并回内存对象，与单一 apply 方向一致，保留。
- 测试夹具写入真实 SQLite，不再靠写 JSON 让「唯一写入入口」测试误绿。
- 删除白板：daemon 运行中 IPC 解绑，未运行时离线写，两侧都对板 id 比对；无法解绑的会话计入返回。sqlite 离线写打开前拒绝缺文件。
- 离线写与 daemon 发现各收敛成一份实现（见 §3 Stage 0 缺口）。Stage 1 / Stage 2 的删除面因此只剩一个入口。

本 PR 明确不做、也不应做：

- occupancy（Stage 1）。与「删除 JSON 写路径」风险和范围都不同。
- 跨进程改为只读 SQLite。在升级窗口关闭前删除 JSON 回落，会让窗口内的 `botmux send` 失败。删除条件见 Stage 0，不是本 PR 的前置。

合入后的实际状态：daemon 只写 SQLite；其它进程在升级窗口内仍可能读 JSON；occupancy 仍在心跳文件；apply 仍有两套——daemon 的 `updateSession`，和 `mutateSessionRowWhenUnowned` 这一个离线入口。之后按 Stage 1 → 2 → 3 推进。

## 5. 建议顺序

```
现在          #1051 合入        删除条件满足          occupancy      单一 apply       turn
 |               |          (fleet 落地 / 复核点)         |              |              |
 |-- Stage 0 ----+-- Stage 0 收尾 -----|                  |              |              |
 |  (本 PR)      |  删除 JSON 读路径   |----- Stage 1 -----+-- Stage 2 ---+-- Stage 3 ---|
```

- **#1051**：删除 daemon JSON 写路径；含白板解绑的 compare-and-set、离线写打开前拒绝缺文件、离线写与 daemon 发现各收敛成一份实现。
- **删除 JSON 读路径**：条件见 Stage 0（fleet 自动重启落地，或 2026-11-26 的兜底复核点）。fleet 实现不在本文范围。
- **下一个架构主 PR**：Stage 1 occupancy。先写能失败的测试覆盖「读心跳文件与写会话行之间的窗口」，合入后 `findOnlineDaemon` 不再用于所有权判断。
- **再下一个**：Stage 2，daemon 未运行时获取租约并执行同一 apply，删除第二套对外写协议。这一阶段减少的概念最多。
- **Stage 3**：按已有证据把分散 fence 收进 per-session 队列。不设「迁完全部写点」的完成门。

`closeSession` 的字段级回滚已在 #1051 替换。`admitQueuedActivationTail`、async tail-admission、generation / exit 上无保护的写入归 Stage 3。`initial-user-turn` 在落盘失败时仅更新内存：有复现再进入 Stage 2 或 3，不单独开事务修复轨道。

## 6. 历史

2026-08 曾用 `SessionRuntime` 包装会话写入（#831）。按调用方群组迁移导致新旧路径长期并存，大部分写点未迁入，适配层按设计要整段删除，审计脚本挂在 build 上。**不合入。** 从中保留并已落地的是：会话行唯一写入入口（#846）、JSON 换成 SQLite（#852）。当时记录的多数「缺陷」是那次包装自己引入的回归，不作为现行证据。

同期口径要求「每步合入必须立刻更简单、收益不得递延、先做存储且不实现 actor」。它避免了再次合入只覆盖部分写点的 runtime，也把 occupancy、单一 apply、turn 拆成互不相关的步骤。本文取代该口径。会话行已由 SQLite 持久化之后，终态是本机 virtual actor：命令、库内租约、按 session 串行；host 进程可更换；不存在第二套权威写入。
