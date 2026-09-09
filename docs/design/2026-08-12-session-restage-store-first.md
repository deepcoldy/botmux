---
title: Session 终态：非分布式 virtual actor（持久化仅 SQLite）
type: design
date: 2026-08-12
updated: 2026-09-08（基线切到含 Stage 3 的 master；升级窗口改为「用户手动重启 + 新代码 fail closed 并提示重启」，不再等 fleet 自动重启；按此重写现状差距、收尾 PR 分解与测试面收缩清单。同日二次修订：三项待定项落定——放弃扁平 legacy 行、只读库 fail-fast、导入删除条件；补阅读指引、决策记录与验收标准。三次修订：会话内定位改为 daemon 优先、库兜底（A-9），常态可见性提前进前置 PR（B-11）。2026-09-09 四次修订：撤回「daemon 内部 updateSession 命令化」，Stage 2 结束条件改为事务原语唯一 + 进程边界只走命令）
topic: session-virtual-actor
status: active
baseline: origin/master@0aba0fdd（含已合入的 #852、#1073、#1093、#1051、#1202、#1280、#1308）
references:
  - PR #846（会话行唯一写入入口）
  - PR #852（per-bot SQLite + JSON 导入 + 混合窗口；v3.18.0）
  - PR #1051（删除 daemon 侧 JSON 写路径 + 行级持久化；v3.18.12）
  - PR #1202（Stage 1 occupancy：库内 `occupancy` 租约；v3.19.0）
  - PR #1280（Stage 2 单一 apply：`services/session-commands.ts`；v3.19.2）
  - PR #1308（Stage 3 per-session turn：`core/session-turn-queue.ts`；已合入 master，尚未发版）
  - PR #1342（收尾 A+B：跨进程只认 SQLite、心跳只拒绝带原因、descriptor 能力位、daemon 优先定位、常态可见性）
  - PR #1344（A-8：删扁平 legacy store，`init(appId)` 必填；叠在 #1342 之上）
  - #831 / feat/virtual_actor_stage2（不合入；SessionRuntime 只覆盖部分写点的失败记录）
---

# Session 终态：非分布式 virtual actor（持久化仅 SQLite）

本文是会话态后续实施的唯一口径。#852 已把会话行持久化换到 SQLite，Stage 1–3 已把 occupancy、单一 apply、开场窗口的 per-session 串行落地。本次更新做三件事：把基线切到含 #1308 的 master；把升级窗口的处理方式从「等 fleet 自动重启」改成「用户手动重启，新代码遇到旧 daemon 时 fail closed 并提示重启」，并据此把所有跨进程兼容路径列为可删；按终态重新度量现状差距，给出收尾 PR 的拆分和可以收缩的测试面。

## 阅读指引（给实施者，含 agent）

本文既是设计口径也是施工清单。按要做的事读对应的节，不必通读：

| 要做的事 | 先读 | 再读 |
|---|---|---|
| 理解终态与不变量 | §0、§1 | §2.2 差距表 |
| 开收尾 PR（删跨进程 JSON 读写、心跳改语义、unmigrated 文案、mojo 修复、会话内定位 daemon 优先） | §5 A、§3.3、§3.4、§3.6、§3.9 | §6 测试面、下方验收标准 |
| 开前置 PR 里的常态可见性（status 版本列、dashboard 提示、安装提示） | §3.8、§5 B-11 | — |
| 开前置 PR（descriptor 能力位、supervisor killTimeout、宿主侧租约规则） | §5 B、§3.5、§3.7 | 验收标准 |
| daemon 侧租约不变量 / lineage 事务收口 / Stage 3 残留 | §5 C、§4 对应 stage | §7 |
| 判断某条兼容分支能不能删 | §0 原则 7、8；§3.1、§3.2 | 决策记录 |

**决策记录**（已拍板，不要在 PR 里重新讨论；改变需要更新本表）：

| 日期 | 决策 | 依据 |
|---|---|---|
| 2026-09-07 | 会话库升级窗口按已关闭处理，不再等 fleet 自动重启 | v3.18.0 于 08-28 进 latest |
| 2026-09-08 | 升级后由用户手动 `botmux restart`；新代码遇旧 daemon 时 fail closed 并提示；不为窗口保留读旧格式分支；不设复核日期 | §3.1 |
| 2026-09-08 | 心跳探针保留，语义改为「只拒绝、带原因」，不删除 | §3.4：删它会开与版本无关的丢更新窗口 |
| 2026-09-08 | descriptor 加 presence-based 能力位与仅用于文案的版本号；任何地方不做版本大小比较 | §3.5 |
| 2026-09-08 | 无 `larkAppId` 的扁平 legacy 行直接放弃；扁平 store 的全部支持点随收尾 PR 删除 | 扁平 store 只存在于 2026-03-11 至 03-22（首次发布到 per-bot 拆分），早于第一个发布 tag v2.16.1（2026-05-07），没有任何发布版本写过它 |
| 2026-09-08 | 只读库 / `loadFailure` 的 daemon 从「降级运行」改为「有界重试后 fail-fast」 | §3.7：写不了会话库的 daemon 不能服务，降级运行只会让宿主与它竞争 |
| 2026-09-08 | 一次性导入 + 中毒库恢复的删除条件：latest ≥ v3.19 满 90 天（2026-12-06 之后）且线上 `session-stores/` 的 `*.tmp*` 孤儿核查为零 | §5 C-15 |
| 2026-09-08 | 会话内定位（`botmux send` 与 detectCurrentSession / resolveSessionAppId）改为「先问活着的 daemon，问不到再读库」；daemon 侧路由补全路由字段 | §3.9：daemon 在时内存行才是权威（原则 4）；顺带让旧 daemon 窗口里的 send 降级可达 |
| 2026-09-08 | 常态可见性（status 版本列、dashboard 提示、安装后提示）从单独排期提前进前置 PR | §3.8：会话里 agent 背后的人看不到事后报错，只能靠事前提醒 |
| 2026-09-09 | A-8（删扁平 store）拆成紧随 A+B 之后的独立 PR，与 A+B 同时开、先后合；其验收 grep 在 A-8 PR 达标 | 实际改动面是 35 个测试文件、99 处无参 `init()`，会把 A-1 / A-2 / A-9 的协议删除淹没在夹具改写里；扁平 store 在生产上零调用，多留一个 PR 不构成半套协议 |
| 2026-09-09 | descriptor 的 `supervisorShutdownProtocol` 字段停写，dashboard 前端 `bootstrapRequired` 死分支与 i18n、`RestartLifecycleFlags` 一起删；关停协议常量与关停状态机不动 | 该字段零读者（白名单过滤），前端文案指向已不存在的 flag；「旧进程要重启」由 B-11 的版本可见性覆盖。将来若关停协议再 bump 且需要广告能力，加进与 `sessionStoreProtocol` 同一组能力位并同时加读者 |
| 2026-09-09 | dashboard 历史弹层的 `sessions.history.staleHint` 改成真判定：仅当该 bot 的 `descriptor.botmuxVersion` 存在、非 `0.0.0`、且与 dashboard 磁盘版本不相等时提示重启；其余只显示原始错误。猜测式原文删除 | 历史 404 是会话里的人会撞到的面；判定只比「是否相等」，不比大小 |
| 2026-09-09 | **不做** daemon 内部 `updateSession` 的命令化。类型化命令只用于两种转换：跨进程边界的，或多字段必须原子成立且有多个写者的 | 命令化消不掉任何真实故障（丢更新靠租约、交错靠队列、per-field 命令没有 tsc 能守的不变量）；138 处必然长期两套写法并存，是 #831 的形状 |

**验收标准**（收尾 PR 与前置 PR 合并前必须全部成立）：

```bash
# A：跨进程 JSON 读写与心跳回落已删
grep -nE "kind: 'json'|loadFromFrozenJson|abortIf|legacyHeartbeatHeld" src/services/session-store.ts src/services/session-command-host.ts   # 期望 0 行
grep -nF 'sessions-${ctx.currentAppId}.json' src/adapters/cli/fs-policy.ts                                                           # 期望 0 行
grep -nF 'sessions(-[^.]+)?' src/core/mojo-containment-command.ts                                                                    # 期望 0 行
grep -nE "withFileLockSync" src/services/session-store.ts                                                                             # 期望只剩导入与中毒恢复两处
grep -nE "sessions\.get\(sid\)" src/cli.ts                                                                                           # 期望 0（cmdSend 与会话内定位底座已改走 resolveSessionById）
grep -rnE "sessionStore\.init\(\s*\)" test | wc -l                                                                                    # 期望 0（PR #1344 已达标；#1342 单独看时允许非 0）
# B：descriptor 能力位与关停预算
grep -nE "sessionStoreProtocol|botmuxVersion" src/daemon.ts src/utils/daemon-discovery.ts src/dashboard/registry.ts                   # 三个文件都应命中
grep -nE "PM2_DAEMON_KILL_TIMEOUT_MS" src/core/shutdown-budgets.ts                                                                    # 断言对象应换成 fleet supervisor 的 killTimeoutMs
# 构建与测试（与 master 基线 diff，见 memory「botmux 测试基线 diff」）
bun run build
bun run test -- test/session-store.test.ts test/session-store-sqlite.test.ts test/session-occupancy.test.ts test/session-delete-cli.test.ts test/whiteboard-unbind-session.test.ts test/fs-policy.test.ts test/mojo-containment.test.ts test/session-turn-queue.test.ts
```

行为层面的验收：① 用只有 `sessions-<appId>.json`、无 `.db` 的数据目录跑 `botmux list` / `botmux delete <id>` / 会话内 `botmux send`，三者都必须给出 unmigrated 文案而不是「没有活跃会话」或裸栈；② 在库里写一条有效租约、不写 descriptor，`botmux delete` 必须报「daemon 在线」而不是离线关闭；③ 写一个新鲜但无能力位的 descriptor、库里无租约，`botmux delete` 必须报「旧版本 daemon，请先 botmux restart」且行未变、worker 未被 SIGTERM；④ 同③但 descriptor 带能力位，文案必须是「未持有租约」而不是「旧版本」；⑤ 在带 `BOTMUX_SESSION_ID` 的子进程里触发③，输出不得含 `botmux restart`、pid、端口或版本号；⑥ 数据目录只有 `sessions-<appId>.json`、无 `.db`，但有一个新鲜 descriptor 指向一个会回答 `GET /api/sessions/:id` 的 daemon（可用测试桩）时，`botmux send` 必须发出（降级到话题根），且返回行的 `larkAppId` 与 env 不一致时必须拒绝；同样场景 daemon 不回答时才落到 unmigrated 提示。

**施工约束**：`/Users/fancy/Code/botmux` 是 live daemon 的运行 checkout，收尾 PR 在 worktree 做，验证止于 build + 单测，不 `switch:here`、不重启；PR 描述用直白中文、写清动了哪些共用路径与各会话类型的验证，不写群内人名与机器人协作花名；行号以本文基线 master@0aba0fdd 为准，动手前先 `git grep` 复核。

## 0. 原则

核心判据是 **架构简明、可维护、可读**：稳态下需要同时理解的协议要少。不要求每个 PR 的 diff 行数立刻变负。

1. **终态优先。** 步骤为终态服务。允许一步只做其中一块，但禁止引入「旧路径完整保留、新层按设计将来整段删除」的平行实现。
2. **禁止只覆盖部分写点的 actor 层。** 不再引入 `SessionRuntime` / `SessionProjection`、按调用方群组横切、写点台账、审计 gate。occupancy / apply / turn 必须走同一条命令路径，CLI 与 daemon 共用。新增协议时必须写明将被替换的旧协议，以及旧协议的删除条件。
3. **边界必须是结构性的**（模块导出、tsc 可检查）。禁止只靠约定维护的边界。
4. **修改会话状态 = 向该 session 发命令；同一时刻至多一个激活。** daemon 未运行时，不是另开一套磁盘写入协议，而是由宿主 CLI（或 dashboard）在本进程成为该行的短生命周期激活、执行同一套 apply。产品语义「daemon 未运行时仍能 close / abandon」保留。沙盒内的 CLI 不在此列（见 §1）。
5. **不把旁路存储并入会话库。** turn-sends、frozen-card、whiteboard 文件、usage-ledger、idempotency、vc-meeting-*、`utils/file-lock.ts` 保持独立生命周期。会话行上的 `whiteboardId` 等字段走会话命令；白板正文仍走 whiteboard store。
6. **BotId 仍由地址推导，不引入分配式注册表。** 会话库内的占位租约只表示 occupancy，不是身份注册表。
7. **低完整性信号只能让判定更严，不能放行写入。** `dashboard-daemons/<appId>.json` descriptor 是任何有 `BOTMUX_HOME` 写权限的进程（含 credential-only 沙盒里的会话 CLI）都能改写的文件；它可以作为「拒绝并提示」的依据，绝不能作为「可以写」或「对方是旧版本所以可以绕过」的依据。会话行的权威只有库内租约与已应答的 daemon。
8. **升级窗口由用户手动关闭。** 升级后不自动重启 fleet。新代码遇到仍在运行的旧 daemon 时，不兼容旧数据格式或旧协议，而是明确失败并提示 `botmux restart`。存储/协议改格式时不再为窗口保留读写兼容分支（见 §3）。

施工可以分 stage；**稳态下的协议种类必须减少。** 稳态下会话行的权威判定只有两种输入：库内租约、已应答的 daemon。descriptor 心跳只保留「拒绝」一种作用。

## 1. 终态

产品单元是 **一条话题对应一个 CLI 会话**。运行时按这个单元寻址和串行，而不是按「本机上的一份会话文件」来理解。

```
飞书事件 / botmux CLI / dashboard / worker IPC
        ↓
   按 sessionId 寻址（bot 级操作按 botId）
        ↓
   在 SQLite 事务内读取并判定 occupancy 租约
        ↓
   执行同一套 command apply（与当前 host 进程无关）
        ↓
   行级写入 SQLite；PTY / worker 由该会话激活持有，不另作状态权威
```

三部分必须同时成立，不能当成可以无限期分开交付的独立功能：

| 部分 | 稳态含义 |
|---|---|
| **身份** | `sessionId` 即寻址键 |
| **occupancy** | 同一时刻至多一个激活；租约与会话行在同一 SQLite 事务中读写；**持有租约是 daemon 写行的前提** |
| **turn** | 针对该 `sessionId` 的命令在跨 `await` 后仍串行执行。实现是按 session 的 Promise 链 / 队列，不引入新的类型层 |

Host 进程可以更换，apply 实现不能分叉：

- **daemon 运行中**：由该 bot 的长驻 daemon 持有激活。进程拓扑与现状相同。
- **daemon 未运行**：宿主 CLI 或 dashboard 在本进程执行**同一模块**的 close / abandon / prune / 白板解绑（`services/session-commands.ts#applySessionRowCommand`）。临时 host 的激活 = 一次排他的 store 事务（`BEGIN IMMEDIATE`）：事务内读 `occupancy` 行判权威、读新鲜行、apply、发布。**不写租约行**。多步命令的每一步在各自事务内重验权威。非 owner 进程只能对行施加 `HostSessionCommand`。
- **沙盒内的 CLI 不能成为 host。** 判定用正向信号（`core/managed-origin-capability.ts#isIsolatedCliProcess`），**不用「读不到 secret」**。
  ⚠️ 这道闸的依据是 **confused-deputy**，不是「它反正写不了盘」：credential-only 的 bwrap / Seatbelt 下 `BOTMUX_HOME`（含 `session-stores/` 与 `dashboard-daemons/`）对子进程**仍然可写**。**不要按「反正写不了」把 origin-channel 那条判定删掉**。隔离判定必须在任何所有权判定之前执行（今天 `cli.ts` 里它排在 IPC 连接失败后的 `occupancyHeld` 之后，见 §3.6）。

持久化：

- 运行时唯一的会话行存储是 per-bot `session-stores/<appId>/sessions.db`。打开连接必须走 `sqlite-compat`，禁止直连。
- 写入是行级 upsert；`journal_mode=WAL`、`synchronous=NORMAL`。
- **跨进程读写只认 `.db`。** 磁盘上的 `sessions-*.json` 只有两个用途：owner daemon 首次启动的一次性导入源、回退到旧版本时的副本。发布产物里不再包含跨进程 JSON 读写实现。
- 「某个 bot 没有 `.db`」有两种含义，必须区分：① 该 bot 从未启动过 daemon（`sessions-<appId>.json` 也不存在）→ 空 store，读为空、写为 `missing`；② 该 bot 的 daemon 仍在跑迁移前的版本，尚未导入（`sessions-<appId>.json` 存在）→ 非 owner 进程一律明确失败：「会话库尚未迁移到 SQLite，请重启 daemon（`botmux restart`）后重试」。区分只看文件是否存在，不读内容。

descriptor（`dashboard-daemons/<appId>.json`）在终态只有三个角色：IPC 地址发现、dashboard 展示、以及 §3.4 的「拒绝」信号。它不参与放行。

粒度：

- **寻址和 turn 的键是 session。** 激活可以仍由 per-bot daemon 进程承载。
- 现状是整个 bot 的 `Map<string, Session>` 共用一个进程：该进程退出后，此 bot 下所有会话的内存权威同时失效。终态允许只激活单个 session；SQLite 行级读写已支持这一点。
- `DaemonSession` 的共享可变别名可以保留，直到有独立的重构理由。

Mailbox 在本仓库里要解决的问题：飞书、dashboard、CLI、worker 会并发进入同一 `sessionId`，但一条会话一次只应执行一个 turn。终态用按 `sessionId` 的命令队列（`runSessionTurn`）替换分散的串行化实现，而不是再包一层 runtime 类型。

## 2. 现状与终态的距离（2026-09-08，master@0aba0fdd）

### 2.1 版本时间线

| 版本 | 日期 | 会话库形态 | 对升级窗口的意义 |
|---|---|---|---|
| < v3.18.0 | — | 只有 JSON | 无 `.db`；这类 daemon 在跑时新 CLI 读不到任何会话 |
| v3.18.0 – v3.18.14 | 08-28 – 09-06 | 写 SQLite，不建 `occupancy` 表、不写租约（v3.18.0–11 保留了 JSON 写实现但 owner 导入后不再触发） | 有 `.db`、无租约；新 CLI 只能靠 descriptor 心跳知道它活着 |
| v3.19.0 – v3.19.3（当前 latest） | 09-07 | 写租约 | 租约是权威 |
| master（含 #1308） | 09-08 | 同上 + 开场窗口 per-session turn | 尚未发版 |

### 2.2 差距表

| 部分 | 已落地 | 相对终态仍缺 |
|---|---|---|
| **身份** | `sessionId` 寻址；跨 store 只读发现（`getSession` → `findInOtherFiles`） | 扁平 legacy store 的支持点已随 PR #1344（A-8）删除：`init(appId)` 必填，无 `larkAppId` 的行不再被任何读写路径认领。该 store 只存在于项目最初 11 天（2026-03-11 首次发布到 2026-03-22 per-bot 拆分，e5aa28e6），早于第一个发布 tag v2.16.1（2026-05-07）。遗留：`cli.ts` 里 cmdResume 等 6 处「行缺 larkAppId」的用户可见分支在快照无条件补齐 `larkAppId` 后已不可达，可随后续 CLI 清理删除。 |
| **occupancy** | 同库 `occupancy` 表；首次 `load()` 的 `BEGIN IMMEDIATE` 内领取；有效租约一票否决宿主写；接管规则看过期与 `ownerPid` 存活 | ① daemon 侧没有任何消费者：`occupancyState` 只用于日志去重（`daemon.ts:22673-22692`），`restoreActiveSessions` 不看 claim 结果，`persistRow` 不查租约——被判 `displaced` 的 daemon 照常 restore / fork / 写行。设计 §1「至多一个激活」在运行时层面没有实现点，今天的租约只是给宿主看的互斥锁。② claim 失败 / displaced 只 warn 并随 30s 心跳重试；`'unavailable'` 连日志都没有。③ 关停期 `claimOccupancy()` 返回值被丢弃（`daemon.ts:23683`）。④ 宿主侧 `occupancyLeaseIsActive` 只看 `leaseUntil`，不看 `ownerPid` 是否存活。⑤ supervisor 默认 `killTimeoutMs` 8s（`fleet-supervisor.ts:138`，`index-supervisor.ts` 未传）小于 daemon 关停预算 28s（`shutdown-budgets.ts:39`），超 8s 的关停被 SIGKILL、租约不释放，留下最长 90s 的「未过期但进程已死」的行；`shutdown-budgets.ts:53-55` 仍在对着 PM2 常量做断言。⑥ 心跳仍作为 `abortIf` 参与判定（§3.4）。 |
| **apply** | `applySessionRowCommand` 是 close / prune / whiteboard / worker-exited 的唯一变换；宿主与 daemon 的 `closeSession` 都走它；`HostSessionCommand` 用 `never` 把 daemon 专属字段挡在 tsc 边界外 | ① daemon 内部的 `sessionStore.updateSession(session)` 全仓 138 处 / 14 个模块，形态是「就地改对象 + 整行 upsert」。这是激活自己改自己的状态，**不要求命令化**（决策记录 2026-09-09）：对它们的约束只有三条——写前持有租约（C-11）、有交错证据的段落用 `runSessionTurn` 包住（它入队的是闭包，不需要命令类型）、多字段必须原子成立的转换用 `closeSession` 那种「副本 → 变换 → 落盘 → 合并回内存」的形态（`reactivateClosedSession`、mojo journal 已是；`admit` / `promote` 见 Stage 3 残留）。② `persistActiveRemoteLineage*` 三个函数（`session-store.ts:1435/1498/2203`，约 240 行）是第二套手写行级事务，`SessionRowCommand` 没有 lineage 命令；`'postrename_ambiguity'` 是 JSON 时代的命名。③ `whiteboard-store.ts:466-486`：daemon 应答了非 2xx 非 409（如 400/500）也落到宿主 apply，与 `cli.ts:3856` 的「已应答即权威」不同构。 |
| **turn** | `runSessionTurn` 按 `sessionId` 的 Promise 链；开场激活窗口内的 follower 落盘、开场释放都走它；`hasPendingSessionTurns` 替代计数 | ① `admitQueuedActivationTail` / `promoteQueuedActivationTail` 仍在 store 外备份再回滚（promote 4 份快照），且 promote 的回滚漏还原 `ds.session.queued`（`worker-pool.ts:9742` vs `9784-9787`；对照同文件 `10294` 有还原）。② `initialStartClaimToken` 在 worker-pool 有 4 处绕过 token fence 的裸清除（`9159/10670/11585/14246`）。③ `utils/anchor-serializer.ts#serializeByAnchor` 仍是第二套按会话串行（键是 anchor 不是 sessionId），5s 后主动放弃排序，4 个消费点在 `event-dispatcher.ts`。④ `session-store.ts:1660` 的 `bridgeMarkerCleanupFences` 是第三个 per-session Promise fence，给旁路文件排序却住在会话库模块里。⑤ `hasQueuedActivationAdmissionGate` 有 5 个消费点、4 类后果：两处改路由进 durable tail，一处抑制 live takeover，`daemon.ts:19886` 直接拒绝 passthrough 命令，`trigger-session.ts:1191` 对带幂等 key 的 HTTP trigger 回 `trigger_failed`——Stage 3 之后队列上一条几毫秒的 release 命令就能让后两处在正常时序下拒绝用户。⑥ `hasPendingSessionTurns` 把正在运行的命令自己也算 pending，「命令内不得对同 session 再入队」只靠注释维护。 |
| **持久化仅 SQLite** | daemon 只写 SQLite（#1051） | 跨进程 db-else-json 仍在：`StoreFileRef.kind` 分流 11 处（含 `session-store.ts:1700` 的内联字面量）、`resolveStoreFile` / `listStoreRefs` 的 JSON 登记、三个读原语（`readStoreEntries` / `readStoreRowByKey` / `readStoreActiveRows`）与 `countActiveSessionsOnDisk` 的 JSON 分支、`getSessionFresh` 的 JSON 文件锁读、`owner:false` 无库时的 `loadFromFrozenJson`、`runUnownedRowTxn` 的 JSON 文件锁写分支、`fs-policy.ts:825-828/1002-1007` 对 `sessions-<self>.json` 的只读授权。 |
| **host 可更换 / 沙盒只发命令** | CLI、dashboard 都能做宿主；沙盒 CLI 用正向信号拒绝离线写 | `cli.ts` 里隔离判定（`3924`、`3823`）排在 IPC 连接失败后的 `occupancyHeld`（`3915`、`3850`）之后：隔离 CLI 可能先拿到宿主专用的报错文案。 |

### 2.3 与升级窗口无关、现在就错的项

这些不依赖任何删除条件，应先于收尾 PR 或与之同 PR 修掉：

- `core/mojo-containment-command.ts:68-94#defaultIsSessionActive` 仍扫 `sessions*.json`。导入后新建的会话在 JSON 里不存在 → 返回 `false`（「已证明不活跃」）→ revoke 安全闸静默放行；导入前就存在的会话读到冻结快照里的陈旧 status。它还无视注入的 `deps.dataDir`。测试 `mojo-containment.test.ts:422` 用 `sessions-app.json` 播种，把这个错误实现锁死了。
- ~~扁平 `sessions.json` 与 per-bot `.db` 被算成两份身份拷贝~~：JSON 那一半随 PR #1342 消失（冻结 JSON 不再登记为 store），扁平 `.db` 那一半随 PR #1344 消失。
- `promoteQueuedActivationTail` 回滚漏 `queued`（见 2.2 turn 行）。
- `test/trigger-session-root-message.test.ts:72-74` 手抄的 `hasQueuedActivationAdmissionGate` 缺 `hasPendingSessionTurns` 一项，master 上已与生产分叉。
- descriptor 字段 `supervisorShutdownProtocol` 写入但零读者（`daemon-discovery.ts:78-91` 的字段白名单把它过滤掉了）；dashboard 前端仍保留服务端已删的 `bootstrapRequired` 分支，文案指向已不存在的 `botmux restart --bootstrap-shutdown-protocol` flag；`cli.ts:2650-2655` 的 `RestartLifecycleFlags` 零引用。
- 死代码：`session-store.ts:632-635` `__testOnly_setAfterRemoteBatchRename` 零调用方；`test/session-store.test.ts:25` 拦截 `sessions.json.` 写入的 fs mock 注入今天就永不触发。
- 过时注释：`daemon.ts:4212-4214`「mtime drives offline detection」（实际判据是 `daemon-discovery.ts:77` 的 `lastHeartbeat` 字段）；`dashboard-ipc-server.ts:2247`「cross-scans every bot's sessions-*.json」。

## 3. 升级策略：手动重启 + fail closed 提示

### 3.1 决定

- 不再实现、也不再等待「升级后自动重启 fleet」。删除条件里所有「fleet 自动重启落地」的表述作废；原定 2026-11-26 的兜底复核点也作废。
- 升级后由用户手动 `botmux restart`。在此之前，新代码（CLI、dashboard、由旧 daemon 从新 dist 拉起的 worker）遇到旧 daemon 时**不兼容旧格式、不兼容旧协议**：明确失败，给出一句带命令的中文提示。
- 提示是产品行为，不是兼容路径：它不读旧格式、不代旧 daemon 做任何事，只把「你还欠一次重启」告诉人。
- 今天升级链路上只有 `botmux upgrade`（`cli.ts:3189/3222`）与 dashboard 的更新确认框说过「请 botmux restart」；npm/bun 的 postinstall 与 `install.sh` 零提示；自动更新（`maintenance.ts`）与 `autoRestart` 默认都关。

### 3.2 三类旧 daemon 在新代码下的表现

| 仍在运行的 daemon | 新 CLI / dashboard / worker 的表现 |
|---|---|
| < v3.18.0（无 `.db`，有 `sessions-<appId>.json`） | 会话内定位走 daemon 优先（§3.9）：`botmux send` 与会话内的 history / whiteboard / schedule 等从活着的旧 daemon 拿到路由，降级但可达。其余跨进程读（`botmux list`、`delete` 的离线路径、dashboard 删板、worker `owner:false` 的 `load()`）遇到该 bot 时得到 `unmigrated`：读侧不把该 bot 计入结果并在 stderr 打一行提示；写侧返回独立判别值并提示。IPC 路径不受影响。 |
| v3.18.0 – v3.18.14（有 `.db`，无租约） | IPC 能应答的走 IPC，daemon 权威。IPC 不可达而落到宿主写时：无有效租约 + descriptor 新鲜 → 拒绝，提示「后台 daemon 是升级前的旧进程，请先运行 `botmux restart`」。 |
| ≥ v3.19.0 | 租约是权威；descriptor 新鲜但无租约时同样拒绝，但文案是「daemon 在线但暂未持有会话库租约」（见 §3.5）。 |

会话内 agent 的 `botmux send` 今天读会话库取 `chatId` / `larkAppId`（`cli.ts:8571-8613`；Linux bwrap 下由宿主 re-exec 读，riff 沙盒例外用 env）。按 §3.9 改为先问活着的 daemon 之后，它在 < v3.18.0 的 daemon 下**降级但可达**：消息落在正确的话题里，但旧 daemon 返回的行没有每轮的精确回复锚点与 codex 派发台账，回复可能落到话题根、@回发送者不精确。仍然发不出的只剩两个角落：macOS 凭证隔离的会话 CLI 读不到 IPC secret、只能读库；v2.x（2026-07-16 之前）的 daemon 不认宿主 HMAC。两者都退回 unmigrated 提示。

### 3.3 「无 `.db`」的判别与文案落点

- `session-store` 对每个 store 给出三态：`ready`（有 `.db`）、`unmigrated`（无 `.db`、有 `sessions-<appId>.json`）、`absent`（两者都无）。判别只做 `existsSync`，不解析 JSON。**只对仍然存在的 bot 判 `unmigrated`**：bots.json 里配置的、当前有 descriptor 在线的、以及本进程所属的 appId（`services/known-bot-app-ids.ts`）。被移出 bots.json 的 bot 留下的 `sessions-<appId>.json` 是废弃数据，没有任何 daemon 会再导入它，不能让 `botmux list` 永远提示「请重启 daemon」（dogfooding 时本机就有 4 份这样的残留）。这是删除 JSON 读路径后 store 对 JSON 文件名仅存的两处认知之一（另一处是导入源）。
- `UnownedRowBlocked` 增加 `unmigrated` 判别值，与 `missing`（行不存在）分开；`loadAllSessionsSnapshot` 的返回带上 `unmigratedAppIds`。
- 一条共享文案常量，三个落点：`cli.ts#loadSessions()` 之上做一次「本次命令涉及哪些 appId」的统一判定并打印；`offlineBlockedError` 映射 `unmigrated`；`whiteboard-store#deleteWhiteboard` 的返回增加 reason 通道（今天只有 `unresolvedSessions` 计数，dashboard 看不到原因）。
- 「没有活跃会话。」这句话有 4 个出口（`cli.ts:4960` cmdList、`4985` cmdDelete、`6061` cmdTermLink、`4565` TUI 空态）；有 `unmigrated` store 时都不得打它。
- 跨 bot **读**路径（`inherit-peer.ts:62-63` 继承 workingDir、`schedule-follow-active.ts:126` 落点选择、`command-handler.ts:5259` /adopt 去重、`restart-report.ts:132` 计数）在删除 JSON 读后对未迁移 bot 静默降级：不继承、不排除、少计。它们不是话题接管判定，接受降级，但 `restart-report` 要接住 `SessionStoreSqliteUnavailableError`（`countActiveSessionsOnDisk` 会把它抛出）。

### 3.4 心跳的定性：只拒绝、不放行

设计文档原计划「删 `abortIf` 心跳回落，`isOccupancyHeld` 只看租约」。**这一条按字面执行是回归**，原因与升级窗口无关：

- `sqliteOccupancyBlocksWrite = 租约有效 || abortIf()`（`session-store.ts:354-360`）。`abortIf` 是**收紧**信号，删掉它等于放宽。
- 存在与版本无关的「daemon 活着但库里没有有效租约」：被判 `displaced` 的 daemon 只 warn、每 30s 重试、期间 `persistRow` 照常写；claim 抛错（`'error'`）的 daemon 同样握着完整内存缓存照常写。今天挡住宿主写的只有 descriptor 心跳。（`'unavailable'` 的三个条件与 `persistRow` 的两条 throw 互斥，不构成缺口。）
- 正常 `botmux restart` 是 stop-then-start，supervisor 等每个子进程 exit 后才退出，不产生重叠；但 daemon 关停超过 supervisor 的 8s `killTimeoutMs` 就会被 SIGKILL，租约不释放。这不是罕见异常（remote backend 的 drain 就有 12s），先修 killTimeout 再评估剩余窗口。
- 宿主写不是通用路径：`cli.ts` 的 delete / prune / whiteboard 都先走 IPC，已应答的 daemon 无论租约如何都是权威（`3856-3858`、`3908-3912`）。心跳只在「descriptor 新鲜但 IPC 连不上」这一子集里起作用。但这个子集里 `botmux delete` 会先 SIGTERM 行上记录的 worker、拆 tmux/backing（`cli.ts:3719-3725`、`3750-3785`），再写行——不可回滚。

因此心跳探针**保留**，但定性从「升级窗口的兼容回落」改为「只会拒绝、永不放行的存活兜底」，并把结果从静默 `owned` 改成带原因的拒绝：

```
在 BEGIN IMMEDIATE 内：
  lease = 读 occupancy 行
  若 lease 存在 且 (leaseUntil > now 或 processAlive(ownerPid))
      → owned{heldBy:'lease'}                       # 调用方走 IPC / 报「daemon 在线」
  否则 若 descriptor 新鲜（lastHeartbeat 90s 内）
      → descriptor 声明了 sessionStoreProtocol      → owned{heldBy:'daemon_without_lease'}
      → descriptor 未声明（旧版本）                  → owned{heldBy:'legacy_daemon'}
  否则 → 宿主在同一事务内 apply（保留的产品语义）
  库不可读 / 无 SQLite 引擎 → owned{heldBy:'store_unreadable'}（不再抛裸栈）
```

- `UnownedRowOptions.abortIf: () => boolean` 换成 `probeHolder: () => HolderReason | undefined`，`UnownedRowBlocked` 的 `owned` 带 `heldBy`。这是把已有的 boolean 换成有信息量的枚举，不新增协议。
- 探针仍在事务内、只判一次。`session-store.ts:2625` 发布前的第二次判定随之删除：租约在 `2617` 只读一次、两次判定复用同一个快照，事务内其它连接改不了 occupancy 行，第二次判定的唯一活项就是 `abortIf`。
- 宿主侧租约有效性从「只看 `leaseUntil`」改为「未过期 或 `ownerPid` 存活」。方向是 fail closed：进程卡住 / 休眠导致两个信号同时过期时仍拒绝。PID 复用会导致误拒（表现为宿主暂时不能离线 close），要彻底解决需在 occupancy 行里存 `processStartIdentity`（schema 是 `CREATE TABLE IF NOT EXISTS`，加列要显式 ALTER），留到 §5 C 项。daemon 侧 `claimOccupancyInTxn` 的接管规则（未过期且进程存活才让路）方向不同，不改。
- `isOccupancyHeld` 只剩 `cli.ts:3696` 一个调用方，改为返回同一个枚举；`hostOptions` 里「无 `larkAppId` 的行不探测」随扁平 store 一起删除（§5 A-8）。
- 宿主的 `openDbForOwnStore` 在判定之前就对目标库执行 `CREATE TABLE IF NOT EXISTS occupancy`：在 v3.18.x 的库上这是一次真实的 schema 变更，也抹掉了「有没有 occupancy 表」这个版本判据。收尾时先用 `openDbForRead` 读租约与 descriptor，确认无人持有再升级为 own-store open。

### 3.5 descriptor 能力位与版本号

- `DaemonDescriptor` 增加 `sessionStoreProtocol: 'occupancy-v1'`（presence-based，与已有的 `workflowIpcProtocol: 'v1'` 同构），随每次 30s 心跳整体重写。旧 daemon 天然不写它。**它只决定文案，不决定是否放行**：新 daemon 在启动窗口（`daemon.ts:22671` 先写 descriptor，`22694` 才 claim）与 claim 持续失败时同样是「有字段、无租约、活着」。
- 另加 `botmuxVersion: string`（取 `utils/install-info.ts#botmuxVersion()`），**只用于文案**。不做版本大小比较：`package.json` 的 version 是 `0.0.0`，源码 checkout 与本地编译的二进制都报 `0.0.0`，而 live fleet 就是从 checkout 起的；canary/beta 后缀与回滚场景也让「谁新」没有唯一答案。
- 读侧两处都要改：`daemon-discovery.ts:19-30/78-91`（字段白名单）与 `dashboard/registry.ts:5-28`（整体 cast）。`supervisorShutdownProtocol` 字段停写并删除其前端死路径（决策记录 2026-09-09）；`core/supervisor-shutdown-protocol.ts` 的常量与关停状态机不动，`test/shutdown-supervisor-contract.test.ts` 改为不再断言该字段。
- descriptor 的新鲜度只看文件内 `lastHeartbeat` 字段，不看 mtime、不查 pid。`cli.ts:2578` 按 mtime 清 5 分钟前的 descriptor 不会把「拦住」翻成「放行」。闸绝不能把「descriptor 文件不存在」解读成「旧版本 daemon」。

### 3.6 受众与文案

- 提示只给**写命令**：`botmux delete`、`botmux list` 的自动 prune（按命令去重，只打一次）、`botmux whiteboard` 绑定、dashboard 删板。`botmux send` 不写会话行，它的失败只有 `unmigrated` 一种（§3.3）。`restart / stop / start / status / upgrade / setup / dashboard` 必须无条件放行。
- 按「是否会话子进程」分流：有 `BOTMUX_SESSION_ID` 或 origin channel 的进程只陈述状态（「daemon 当前不接受会话库写入，本次未做任何修改」），**不给 `botmux restart` 这样的 fleet 级指令**，也不带 pid / 端口 / 版本号——完全不开沙盒的会话里 CLI 子进程是合法宿主，会读到这段文案，一个照做的 agent 会重启整个 bot。带版本号与命令的文案只在操作员 shell 输出。
- 隔离判定（`isolatedCliProcess()`）前移到 `cli.ts:3850` / `3915` 的 `occupancyHeld` 之前，保证隔离会话只看到通用文案。
- 本机多 checkout 场景：CLI 的 dist 与 daemon 的 dist 经常来自不同 checkout（`bun run build` 故意不认领全局指向）。文案要说清是「运行中的 daemon」旧，不能一律建议 `botmux restart`（那会让 review worktree 抢走全局指向）；`0.0.0` 一律按「无法判定」处理。
- 现成先例：`cli.ts:3690` `ISOLATED_CLI_OFFLINE_ERROR`、`core/session-marker.ts:118`。

### 3.7 daemon 侧不变量：持有租约才写

租约要从「给宿主看的公告牌」变成 daemon 自己的前提，否则 §1 的「至多一个激活」只是一句话：

1. `claimOccupancy` 改成状态机：`held` / `pending` / `lost`。启动阶段 claim 失败（displaced / unavailable / error）进入 `pending`，按 1s 间隔重试（今天只有 30s 心跳一个重试点）；重试上限取关停预算上界加一个 TTL（2–3 分钟量级）；超窗 `logger.error` 后非零退出，文案区分「另一个 daemon 仍持有本 bot 的会话库」与「会话库不可写/不可读：{原因}」。`'unavailable'` 必须记日志。
2. 运行阶段 renew 返回 `displaced`（bootId 与 pid 都不同、对方未过期且存活，是真被接管）⇒ 停止接受新 turn、停止 restore / fork，走 shutdown，不再 `persistRow`。
3. `persistRow` 断言本 boot 仍持有租约（内存里的 `leaseHeldUntil` 时间戳，由 claim 更新），超期未续 ⇒ 抛 `SessionStoreUnavailableError`，不静默写。`owner:false` 的 worker 与不配 holder 的测试夹具排除在外。
4. 关停期 `daemon.ts:23683` 的 `claimOccupancy()` 返回值必须检查；teardown 期间保留一个只做续租的短定时器（今天 `23675` 清掉心跳后只靠一次 90s 续租）。
5. supervisor `killTimeoutMs` 与 daemon 关停预算对齐（≥ 28s + 余量），`shutdown-budgets.ts:53-55` 的断言改成对 fleet supervisor 生效。
6. `restoreActiveSessions` 与 tmux adopt 以 `held` 为前置：被 displaced 的 boot 不得 re-attach 同一批 tmux 会话（今天两个 daemon 会同时向同一个 pane 写）。

**已决定的行为变更**：只读库 / `loadFailure` 的 daemon 从「降级运行（`claimOccupancyOnLoad` 注释明写有意容忍，收尾时改掉这段注释）」变成「有界重试后 fail-fast」。写不了会话库的 daemon 本来就不能服务，降级运行只会让它与宿主竞争同一批行；退出时的错误信息要带上 `loadFailure.message`，让 `botmux status` 与 supervisor 日志能直接看到原因。

不变量落地后，宿主侧仍然不能只看租约：它管不了 ≤ v3.18.14 的存量 daemon，也管不了进程卡死 > 90s。两者互补：不变量把 displaced 窗口压到 1s 量级并让 daemon 自杀，心跳探针把旧 daemon 与卡死的 daemon 挡在门外。

### 3.8 常态可见性

升级窗口从「自动关闭」改成「用户手动关闭」后长度没有上界，只在失败时提示等于把发现时机推给一次失败操作；而会话里 agent 背后的人根本看不到事后报错。所以这一节随前置 PR 一起做（§5 B-11）：

- `botmux status` 增加 VERSION 列（`listOnlineDaemons` 按 appId join fleet 行），表尾提示「N 个 daemon 仍在跑 vX（磁盘 vY），运行 `botmux restart` 应用」。
- dashboard「版本与更新」卡增加「运行中的 daemon：n 个 v3.20.0 / m 个 v3.19.3 ⇒ 需要重启」，数据源 `registry.list()`，对照量是 `currentInstalledVersion()`。版本不进 `botsRosterSignature`，靠轮询刷新。
- `postinstall-bin.mjs` 与 `install.sh` 在升级成功后无条件打一行「若 daemon 正在运行，请执行 `botmux restart` 应用新版本」（它们读不到、也不该读 `~/.botmux/data`）。
- dashboard 历史弹层的 `sessions.history.staleHint` 改成真判定（决策记录 2026-09-09）：仅当该 bot 的 `descriptor.botmuxVersion` 存在、非 `0.0.0`、且与 `currentInstalledVersion()` 不相等时，附一句「运行中的 daemon vX 与磁盘 vY 不一致，运行 `botmux restart` 应用」；否则只显示原始 not_found。文案与版本卡共用同一个 helper，不比版本大小。dashboard 面向操作员，带 `botmux restart` 指令合法。

### 3.9 会话内定位：先问活着的 daemon，问不到再读库

`botmux send`、`detectCurrentSession`、`currentWhiteboardContext`、`resolveSessionAppId` 今天都用 `loadSessions().get(sid)` 从磁盘上的会话库定位自己，即使 daemon 正活着。这是「文件即权威」时代的遗留：daemon 在时，它内存里的行才是权威（§0 原则 4），跨进程读库只该发生在 daemon 不在时。改法：

1. 新增一个解析器 `resolveSessionById(sid)`，替换上述入口里的 `loadSessions().get(sid)`：
   - 先定位 bot：env `BOTMUX_LARK_APP_ID`（worker 注入，`worker.ts:1249`）；没有时按在线 descriptor 逐个询问。
   - 向该 bot 的 daemon 发 `GET /api/sessions/:id`（`dashboard-ipc-server.ts:1189`，2026-04-30 起存在，早于第一个发布 tag；宿主 HMAC 鉴权，2026-07-16 起所有 v3.x daemon 都认）。200 → 用它返回的行；**404 来自已应答的 daemon，是权威的「不存在」**，不再回落读库；连接失败 / 无 descriptor / 本进程读不到 secret（隔离 CLI）→ 读库（含 §3.3 的 unmigrated 判别）。
   - 返回行的 `larkAppId` 必须与 env 一致、`sessionId` 必须等于请求的 id，否则拒绝。descriptor 只用于寻址（§0 原则 7）：伪造 descriptor 至多让请求打到一个假端口，返回的行过不了这两条核对。
2. daemon 侧把路由返回补全为 send 需要的字段：当前轮的 `replyTargets` 条目、`currentReplyTarget`、`quoteTargetId` / `quoteTargetSenderOpenId`、`codexAppDispatchLedger`。旧 daemon 只返回基础行（`sessionId` / `larkAppId` / `chatId` / `chatType` / `rootMessageId` / `scope` / `status`），send 据此降级：无每轮锚点时回到话题根，`--mention-back` 退回会话级发送者。
3. `botmux list` 仍是快照，但组装方式改成 dashboard 已经在用的那种：在线 daemon 走 `GET /api/sessions`，只对离线 bot 读库。这一步不在收尾 PR 里（§5 C-16 的枚举器收敛时一起做）。
4. 沙盒：Linux bwrap 的 send 由宿主侧 re-exec 完成，能读 secret，走 daemon 优先；macOS 凭证隔离的 CLI 读不到 secret，保持读库。不为它新开一条免鉴权的读路由——那等于把会话路由暴露给任何本机进程。

效果：正常状态下 send 不再依赖跨进程读库，会话库的跨进程读只剩「daemon 不在」这一种情形；旧 daemon 窗口里的 send 从「未找到 session」变成降级可达。这不是兼容分支：它不读任何旧格式，走的是首发就有的正式通道，窗口关闭后仍是主路径。

## 4. 后续 stage

### Stage 0 — 删除 daemon JSON 写路径【#1051 已合入；收尾：删除跨进程 JSON 读写】

**删除条件已满足**（按 §3 的策略，不再等 fleet 自动重启，也不设复核日期）。收尾范围见 §5 A-1。

删除后保留的 JSON 认知只有两处：owner daemon 首次 `load()` 的一次性导入（含文件锁、中毒库恢复），以及 §3.3 的 `unmigrated` 判别（只看文件是否存在）。导入的删除条件见 §5 C-15。

### Stage 1 — Occupancy 写入 SQLite【已落地；收尾：daemon 侧不变量 + 心跳定性】

已落地内容见 2.2。收尾：

1. 心跳探针按 §3.4 改语义与返回值，不删除。原文「删除该回落的条件与 Stage 0 相同」作废。
2. daemon 侧不变量按 §3.7。
3. `occupancy` 行增加 `owner_start_identity`（显式 ALTER，须能在 v3.18.x 建出的库上安全运行），之后宿主侧 `processAlive` 判定改用它，消除 PID 复用误拒。

### Stage 2 — 单一 apply 路径【已落地；缺口：lineage 事务收口】

已落地内容见 2.2。类型化命令的适用范围（决策记录 2026-09-09）：**只用于跨进程边界的转换，或多字段必须原子成立且有多个写者的转换**。close / prune / whiteboard / worker-exited 属前者，close / reactivate / mojo journal 属后者；daemon 内部的 activity bump / pid / 流式卡片状态两者都不是，保持就地改、行级落盘。

仍未纳入且必须写明结束条件的：

1. `persistActiveRemoteLineage*` 三函数（`session-store.ts:1435/1498/2203`）是第二套手写「`BEGIN IMMEDIATE` → 读新鲜行 → CAS 前检 → UPDATE → 回读」。收口为与宿主路径 `runUnownedRowTxn` 共用的一个事务原语（读新鲜行 → 变换 → CAS 写回），不强求进 `SessionRowCommand` 联合；删除 `'postrename_ambiguity'` 命名。结束条件：`session-store.ts` 里手写的行级事务只剩这一个原语。
2. `whiteboard-store#unbindSessionWhiteboard`：daemon 已应答（任何状态码）即终态，不再落到宿主 apply（收尾 PR A-5）。

结束条件里**不包含**「`updateSession` 变 internal / 对外只暴露命令入口」。非 owner 进程只能施加 `HostSessionCommand` 这条边界已由 tsc 成立，这就是 Stage 2 在进程边界上的全部要求。

### Stage 3 — Per-session turn【已落地：开场激活窗口】

已落地内容不变（`runSessionTurn`、`admitFollowerBehindOpening`、`releaseQueuedActivationReservation` 入队、`hasQueuedActivationAdmissionGate` 用 `hasPendingSessionTurns`、删除分散计数 / 延迟交接 / 回放）。

有意保留、不入队的（理由不变）：`initialStartClaimToken` / `initialStartPending` 是 fork 边界的所有权状态，输家立刻落 durable tail 而不是排队；`pendingRepo` 等待期的缓冲；generation / exit 路径上的 `updateSession`（无复现证据不改）。

残留（按 §5 D 项排期）：

1. `admitQueuedActivationTail` / `promoteQueuedActivationTail` 改成 `closeSession` 已有的副本形态：session-store 内部抽一个 helper（`next` 副本 → 变换 → `persistRow(next)` → `Object.assign(session, next)` 保别名），三处共用；**不新增命令类型**（决策记录 2026-09-09）。promote 依赖的 `acceptCodexAppDispatch` 不纯（读 bot 配置与 delivery sink），ledger entry 在变换外算好再传入。做完后 5 份 store 外备份与 `queued` 回滚遗漏一起消失。测试面：4 个文件必改（`session-lifecycle-start` 的字面量工厂只列 6 个导出、`daemon-rename-route` 与 `daemon-ordinary-ingress-failure-notice` 把 `updateSession` 换成内存 Map、`trigger-session-root-message` 手抄了实现），helper 内部仍走 `updateSession` 可把前三个文件的改动降到零。
2. `initialStartClaimToken` 的 4 处裸清除改为调用带 token 的导出入口；`worker-pool.ts:11584-11585` 在 daemon 内不可达，删除。搭车在上一项。
3. `hasQueuedActivationAdmissionGate` 的两处用户可见拒绝（`daemon.ts:19886` passthrough、`trigger-session.ts:1191` HTTP trigger）改为排进 durable tail 或等待队列排空，而不是回一条提示。
4. `serializeByAnchor` 并入 `runSessionTurn`：键从 anchor 换成 sessionId，去掉 5s 放弃排序。这是 §1 点名要被替换的「FIFO」。
5. `bridgeMarkerCleanupFences` 移出 `session-store`（旁路存储独立生命周期，§0.5）。
6. `hasPendingSessionTurns` 的自锁约束改成结构性的（例如命令体内拿到的句柄不提供再入队），或至少在 `runSessionTurn` 内检测同 session 重入并抛错。

后续再有证据的交错路径，用 `runSessionTurn` 包住那一段即可，不再新增计数或标志。

### Stage 4 — （低优先级）按 session 隔离激活

**暂不立项。** 触发条件与理由不变：目前没有「同一 bot 进程容纳全部会话导致事件循环或崩溃域不可接受」的证据；2026-08-23 的恢复风暴发生在共享 tmux server 层。

### 不做

- 合入 #831，或任何只把部分写点迁入新层、旧路径完整保留的 runtime。
- 把旁路文件并入会话库。
- 为 actor 引入 BotId 分配或注册表。
- 为升级窗口保留跨进程 JSON 读写、或任何「新代码读旧格式」的分支。
- 用 descriptor 或版本号比较作为放行依据。
- 把 daemon 内部的 `updateSession` 收成命令联合（ActivityBumpCommand / SetPidCommand 一类）。它消不掉任何真实故障，per-field 命令没有 tsc 能守的不变量，138 处的迁移必然长期两套写法并存——那正是 #831 的形状，对以 agent 为主的改码者更糟：agent 就近复制模式，两套并存会被无限延续。
- 以「本 PR 净行数未减少」否决朝终态收敛的改动。

## 5. 收尾分解（PR 粒度）

### A. 收尾 PR（一次装下；彼此耦合，拆开会留半套协议）

1. **S** 删 db-else-json：`StoreFileRef.kind`（11 处，含 `session-store.ts:1700` 内联字面量）、`resolveStoreFile` / `listStoreRefs` 的 JSON 登记、`readStoreEntries` / `readStoreRowByKey` / `readStoreActiveRows` / `countActiveSessionsOnDisk` 的 JSON 分支、`getSessionFresh` 的文件锁读、`loadFromFrozenJson`、`runUnownedRowTxn` 的 JSON 写分支、`fs-policy.ts` 两处授权、`worker.ts:19228` 注释。`readOccupancyLease` 简化为 `existsSync(dbPath)`。`writeFileSync` import 随之无调用方。`stripLegacyPendingCardFields` / `parseSessionsProjectionStrict` / `storeJsonFileName` / `isTransientStoreContentionError` 仍被导入用，**不会变死**。**排序约束**：JSON 写分支里 `abortIf` 是唯一的所有权判定，删 `abortIf` 必须与删 JSON 写分支同 PR 或在其之后。
2. **S** `abortIf` → `probeHolder` 枚举（§3.4），删 `session-store.ts:2625` 第二次判定，`isOccupancyHeld` 返回枚举，`UnownedRowBlocked.owned` 带 `heldBy`。
3. **M** `unmigrated` 三态 + 共享文案 + 三个落点 + `deleteWhiteboard` reason 通道（§3.3）；`loadFailure` 下 `getSession` / `getSessionFresh` 改为抛而不是跨 store 静默回落（worker 侧 fail closed 才完整）。
4. **S** `defaultIsSessionActive` 改读 store：`readSessionRowCopiesAcrossStores` 的返回扩成 `{ matches, unreadableStores }`；任一 `active` → `true`，无命中且有不可读 store 或 `SessionStoreSqliteUnavailableError` → `undefined`，否则 `false`；透传 `deps.dataDir`。
5. **S** 隔离判定前移（§3.6）；`whiteboard-store` 的「已应答即终态」。
6. **S** 死代码与过时注释：`__testOnly_setAfterRemoteBatchRename`、`test/session-store.test.ts:25` 的 fs mock 注入、`daemon.ts:4212-4214`、`dashboard-ipc-server.ts:2247`。
7. **S** 测试改造，按 §6。
8. **M** 删扁平 legacy store（**已实现：PR #1344**，叠在 #1342 之上先后合）：`init(appId: string)` 必填并拒绝空串，删扁平 `sessions.db` / `sessions.json` 的全部支持点与 `hostOptions` 的无 `larkAppId` 分支、`cli.ts` 离线路径特例；store 层 `runUnownedRowTxn` 等的 target 类型同步收紧为 `larkAppId: string`。实际改动面 35 个测试文件、99 处无参 `init()`（`session-store.test.ts` 42、`dashboard-ipc.test.ts` 22、`restore-zombie-close.test.ts` 12，另有 9 个文件原本就没 init、需要补），全是机械补 appId。无 `larkAppId` 的行已放弃。注意：一次性导入的 `readFrozenSnapshotForImport` 不再回落扁平 `sessions.json`，因此中毒库恢复的「快照佐证」只认 `sessions-<appId>.json`——SQLite 之后新建、从未有过 JSON 的 bot 若同时缺 WAL 重放证据与 receipt，会 fail closed 而不是空恢复（与 C-15 的删除方向一致）。
9. **M** 会话内定位改为 daemon 优先（§3.9）：`resolveSessionById` 替换 `cmdSend` / `detectCurrentSession` / `currentWhiteboardContext` / `resolveSessionAppId` 里的 `loadSessions().get(sid)`；daemon 侧 `GET /api/sessions/:id` 补全路由字段；返回行与 env 的一致性核对；测试补「daemon 应答 200 / 404 / 连接失败」三种分支与 larkAppId 不一致拒绝。

### B. 必须同 PR 或紧邻的前置 PR（否则 A-2 是回归）

8. **M** descriptor 加 `sessionStoreProtocol` 与 `botmuxVersion`，读侧两处同步（§3.5）；停写 descriptor 的 `supervisorShutdownProtocol` 字段，删 dashboard 前端 `bootstrapRequired` 死分支及其 i18n、`cli.ts` 的 `RestartLifecycleFlags`；关停协议常量与关停状态机不动，合同测试改为不再断言该字段。
9. **M** supervisor `killTimeoutMs` 对齐关停预算；`shutdown-budgets.ts:53-55` 断言改对象（§3.7-5）。
10. **M** 宿主侧租约有效性两段规则（§3.4）。
11. **S** 常态可见性（§3.8，依赖 B-8 的 `botmuxVersion`）：`botmux status` 的 VERSION 列与表尾提示、dashboard「版本与更新」卡的「运行中的 daemon 需要重启」、`postinstall-bin.mjs` 与 `install.sh` 升级后的一行提示；历史弹层 `staleHint` 改为基于 `botmuxVersion` 的真判定（§3.8）。

### C. 单独排期

11. **M** daemon 侧租约状态机 + `persistRow` 断言 + 关停期续租检查（§3.7-1/2/3/4），含只读库 fail-fast（已决定）。
12. **L** occupancy 接进 daemon runtime：restore / fork / tmux adopt 的 boot gate（§3.7-6）。这是 §1「至多一个激活」第一次真正成立。
13. **L** `occupancy` 加 `owner_start_identity` 列 + 宿主侧改用它（Stage 1-3）。
14. **M** `persistActiveRemoteLineage*` 与宿主路径共用一个事务原语（Stage 2-1）；`bridgeMarkerCleanupFences` 移出 session-store（Stage 3-5）。
15. **M** 删除一次性导入、其文件锁与中毒库恢复（约 400 行）以及 `frozenJsonRows` 一族测试夹具；届时 `storeJsonFileName` 只剩 §3.3 的 `unmigrated` 判别一个用途，`utils/file-lock.ts` 对会话库的依赖整体解除。**条件（已决定）**：latest ≥ v3.19 满 90 天（2026-12-06 之后），且对线上 `session-stores/` 做一次 `find … -name '*.tmp*'` 孤儿核查为零。
16. **M** 6 个跨 store 枚举入口（顺带把 `botmux list` 改成「在线 daemon 走 IPC、离线 bot 读库」，§3.9-3）（`findInOtherFiles` / `countActiveSessionsOnDisk` / `collectBotmuxSessionIdentities` / `loadAllSessionsSnapshot` / `readSessionRowCopiesAcrossStores` / `findActiveSessionsMatching`）收成一个带显式失败策略的枚举器 + 一个投影，并借此给跨 bot 读加「该 store 不可读 / 未迁移」的返回通道。
17. **M** Stage 3 残留 1–3（admit / promote 改为副本形态、claim token 清除、gate 的两处用户可见拒绝）。
18. **L** Stage 3 残留 4（`serializeByAnchor` 并入 `runSessionTurn`）。

## 6. 测试面收缩

以下按逐条读过正文后的分类，行号以 master@0aba0fdd 为准。测试总数：`session-store.test.ts` 98 个 `it`（运行时 106）、`session-store-sqlite.test.ts` 21、`session-store-sqlite-poisoned-recovery.test.ts` 18、`session-occupancy.test.ts` 18、`session-delete-cli.test.ts` 14、`whiteboard-unbind-session.test.ts` 6。Stage 3 删除的六个标识符在 `test/` 与 `src/` 零残留；`abortIf` 的测试面是 3 个文件 13 处。

### 6.1 直接删除（被测对象随收尾 PR 消失，或今天就已恒真）

| 用例 | 理由 |
|---|---|
| `session-store.test.ts:273` keeps loaded sessions available when persisting a scope repair fails | 注入永不触发（唯一 `writeFileSync` 在 JSON 离线写，导入走 `renameSync`），断言恒真 |
| `session-store.test.ts:1442` should handle atomic writes (tmp file rename) | 断言 `sessions.json.tmp` 不存在，全仓无代码创建它 |
| `session-store.test.ts:1630` a frozen pre-SQLite JSON is not a second copy | 与 `session-store-sqlite.test.ts:225` 重复；保留后者作为「冻结 JSON 不是 store」的唯一护栏 |
| `session-store.test.ts:1726` re-checks abortIf immediately before publication | 第二次判定随 `abortIf` 一起删除 |
| `session-store.test.ts:1782` contended when the JSON store file lock is held | JSON 文件锁来源消失；SQLite 侧的 contended 由 `session-store-sqlite.test.ts:337` 覆盖 |
| `session-store-sqlite.test.ts:281` offline mutation targets the .db and leaves the frozen JSON untouched | 前半与 `:323` 重复，后半恒真 |
| `session-store-sqlite.test.ts:298` keeps the abortIf entry + pre-publication probes | `expect(probes).toBe(2)` 没有可保留的一半 |
| `session-store-sqlite.test.ts:535` an un-imported peer store still resolves for the identity scan | 与 `:249` 同场景；`:249` 改写后保留 `collectBotmuxSessionIdentities` 的唯一真实覆盖 |
| `session-occupancy.test.ts:353-377` describe「JSON upgrade-window path still uses abortIf」 | 整段随 JSON 写路径删除；文件头 4-7 行的升级窗口注释一并撤 |

### 6.2 改写为终态断言

| 用例 | 终态形态 |
|---|---|
| `session-store.test.ts:1578` still reads a store whose owning daemon has not imported it yet | 同夹具（只有 `sessions-appB.json`）下快照不含 b1、`unmigratedAppIds` 含 appB，点读 / 命令入口得到 `unmigrated` |
| `session-store.test.ts:1712` yields owned untouched when abortIf trips — for the read as well as the apply | 后半是全仓唯一「读路径也按同一所有权规则 yield owned」的覆盖。改用 `seedOccupancyLease` 播有效租约，同时断言 `applySessionCommandUnowned` 与 `readSessionRowUnowned` 都 `owned` 且行未变；迁到 `session-occupancy.test.ts` |
| `session-store.test.ts:1766` writes the JSON store while its owning daemon has not imported it yet | 不写 JSON、不建 `.db`，返回 `unmigrated` |
| `session-store-sqlite.test.ts:202` a non-owning process reads the JSON and never bootstraps the .db | `init('appA', { owner: false })` 无 `.db` 时 `listSessionsStrict` 抛 unmigrated，不建 `.db`、不回写 JSON；随后 owner init 仍完成导入 |
| `session-store-sqlite.test.ts:249` an un-imported peer store still composes with imported ones | `seedJson('sessions-appOld.json')` 换成 `seedPersistedSessionRows`，四个跨 store 断言原样保留 |
| `session-occupancy.test.ts:114` expired lease + fresh heartbeat still aborts | 断言 `owned{heldBy:'legacy_daemon'}`（descriptor 无能力位）与文案；行保持 active |
| `session-occupancy.test.ts:142` missing lease + fresh heartbeat aborts | 同上；再补一条 descriptor 带能力位 → `daemon_without_lease` |
| `session-occupancy.test.ts:158` isOccupancyHeld never throws — the heartbeat decides | 只保留「不可读库不抛、返回未持有」；`store_unreadable` 的文案断言可选 |
| `session-delete-cli.test.ts:613` closes a session whose owning daemon has not imported the store yet | exit 1，stderr 含 unmigrated 文案（不是「没有活跃会话」），JSON 不变，不生成 `.db` |
| `whiteboard-unbind-session.test.ts:131` unresolved when a daemon is visible but IPC fails | 同时 seed 有效租约 + 可见 descriptor + IPC 抛错 → `unresolved:1`、`whiteboardId` 保持；再补「daemon 应答 500 → 不回落宿主写」与「descriptor 新鲜但无租约 → unresolved 并带 reason」 |
| `mojo-containment.test.ts:422` defaultIsSessionActive is genuinely tri-state | 用 `seedPersistedSessionRows` 播 SQLite：active → true、closed → false、不存在 → false、库存在但打不开 / 引擎不可用 → undefined；残留 `sessions-*.json` 不影响任何答案 |
| `fs-policy.test.ts:313`、`:506` sessions-cli_self.json readOnly | 改 `'none'`；`:1653`（no-transport）改 `'deny'`（与同段 `:1655` 同源）。三处 `310-312` / `504-505` / `1651-1652` 的注释已经写着「不再授权」，与断言矛盾，一并修正 |

### 6.3 只改名 / 注释（断言在终态原样成立）

- （`session-store.test.ts:1315` 那条已随 PR #1344 删除）`:1570` / `:1753` 的「导入门」理由改成「空库会遮蔽 unmigrated 判定」；`:526` 末句 `sessions-app-A.json` 不存在的断言恒真，改断 per-bot `.db` 不被创建。
- `session-occupancy.test.ts:100` / `:128` 名字里的 heartbeat 子句与 `writeDaemonHeartbeat` setup 对结果无影响，摘掉。
- `session-delete-cli.test.ts:373` 名字里的「no heartbeat is fresh」从一开始就与用例体（没写 descriptor）不符。

### 6.4 保留（含删除条件）

- 导入与中毒库恢复用例（`session-store.test.ts:172/195/227/415/425/438/445/526/1322/1423/1453/1479`、`session-store-sqlite.test.ts:94-181`、`session-store-sqlite-poisoned-recovery.test.ts` 全部 18 条）随 §5 C-15 一起删除。`frozenJsonRows` 夹具在 poisoned-recovery 里有 10 处引用（`60/333/363/388/405/426/464/481/499/584`）。
- `session-store-sqlite.test.ts:225`（冻结 JSON 不是 store）、`:323`（改新鲜行）、`:337`（SQLITE_BUSY → contended）是终态保证，保留。
- `session-delete-cli.test.ts:312`（daemon 拒绝不因过期租约翻成离线写许可）、`:352`（无 descriptor 但有租约必须让位）、`:438` / `:462`（沙盒与 origin-channel 闸）是终态核心。
- `initial-user-turn-opening.test.ts`（28 条，运行时 38）与 `session-turn-queue.test.ts`（5 条）没有一条在钉 Stage 3 之前的排序机制，全部保留。

### 6.5 夹具缺陷

- `trigger-session-root-message.test.ts:72-74` 手抄的 gate 缺 `hasPendingSessionTurns`，已与生产分叉；`:184-187` 手抄了 admit 的写法。改为从生产模块取。
- `session-resume.test.ts:61/182/200-201/1158/1170` 与 `dashboard-create-session.test.ts:87` 把 `promoteQueuedActivationTail` 整个 mock 掉，改入口不会变红但也不验证任何真实行为。
- 本机 `session-store-sqlite-poisoned-recovery.test.ts` 因 bun 1.4.1 ≠ 钉住的 1.4.2 全部失败，属环境性失败，与分类无关。

## 7. 减负候选（面向终态，暂不立项）

- 「当前版本」有四份解析实现（`install-info.botmuxVersion`、`install-diagnostics.resolveCurrentVersionAt`、`version-info.resolveEffectiveBotmuxVersion`、`cli.ts#getVersion`），后两者的 git describe 逻辑逐字重复。descriptor 只写 `install-info` 那份。
- `lastCliInput` 在 `ds.lastCliInput` 与 `ds.session.lastCliInput` 双镜像维护（`session-manager.ts:1967-1980`，`daemon.ts:21041` 用 `??` 兜底）；行已在 SQLite 后内存镜像是冗余。
- 两套一次性认领并存：`initialUserTurnPending`（`core/initial-user-turn.ts` 同步 RMW + 落盘）与 `initialStartClaimToken`；admit / promote 命令化时可把 `claimInitialUserTurn` 一并包进 `runSessionTurn`。
- `queuedActivationTailReleaseRetryTimer` 的 100ms 定时器只剩「promote 落盘 / IPC 失败重试」一种职责，可做成队列上的一条命令。
- `session-command-host.ts` 在 A-2 之后只剩「转发 + close 后清理」，可并回 `session-store` 的导出面。
- fleet-state 里有每个子进程的 pid / generation，supervisor 在 spawn 时记录自己的 dist 身份比 descriptor 更早知道「谁在跑什么版本」，但只在 supervisor 自己也重启后才准，只能作为 §3.8 的补充信息源。

## 8. 历史

2026-08 曾用 `SessionRuntime` 包装会话写入（#831）。按调用方群组迁移导致新旧路径长期并存，大部分写点未迁入，适配层按设计要整段删除，审计脚本挂在 build 上。**不合入。** 从中保留并已落地的是：会话行唯一写入入口（#846）、JSON 换成 SQLite（#852）。

2026-08-28 至 09-08：#1051 删除 daemon 侧 JSON 写路径并把落盘改成行级 upsert，同时把删板解绑、离线写与 daemon 发现各收敛成一份实现；#1202 落地库内租约；#1280 落地单一 apply 并删除「任意闭包改行」的离线写入口；#1308 把开场激活窗口的串行化收进 `runSessionTurn`。期间跨进程读写按「升级窗口无上界」保留了 db-else-json 与心跳回落，删除条件曾定为「fleet 自动重启落地或 2026-11-26 复核」。

2026-09-08 起：维护者决定不再等 fleet 自动重启，升级窗口由用户手动重启关闭，新代码遇到旧 daemon 时 fail closed 并提示。据此跨进程 JSON 读写按 §5 A 净删除；心跳探针经复核不是兼容路径而是与版本无关的存活兜底，改为只拒绝、带原因，不删除（§3.4）。同日二次修订把三项待定项落定为决策（阅读指引的决策记录）：扁平 legacy 行放弃并随收尾 PR 删除支持点；只读库 daemon fail-fast；导入与中毒恢复按日期 + 磁盘核查删除。三次修订：会话内定位改为 daemon 优先、库兜底（§3.9、A-9），§3.2 中「会话内 agent 回不了消息」的代价改为「降级但可达」；常态可见性从单独排期提前进前置 PR（B-11）。

2026-09-09 四次修订：经评审撤回「daemon 内部 updateSession 命令化」（原 Stage 2-2 / C-15）。理由：`runSessionTurn` 入队的是闭包，Stage 3 止于开场窗口是因为没有更多有复现的交错，不是缺命令类型；per-field 命令没有 tsc 能守的不变量；138 处必然长期两套并存。类型化命令的适用范围收窄为「跨进程边界」与「多字段原子且多写者」两类；Stage 2 结束条件改为「手写行级事务只剩一个原语」。同日实施侧提出三处取舍并已裁定：A-8 拆为紧随其后的独立 PR；`supervisorShutdownProtocol` 字段停写、前端死路径删除；`staleHint` 改为版本真判定。
