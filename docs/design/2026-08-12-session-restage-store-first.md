---
title: Session 架构拆解回收与 store-first 重新分步
type: design
date: 2026-08-12
updated: 2026-08-19（Step 3 第一 PR rebase 到 origin/master@47b2c11a 后，按现行基线修订口径与收益判定）
topic: session-restage-store-first
status: proposed
baseline: origin/master@47b2c11a（0819 复核基线；0813 复核基线 16fde8a27；原始基线 723c79ade）
references:
  - feat/virtual_actor_stage2@b6a4982ea（不合入；仅作参考实现、竞态清单与写点地图）
  - docs/design/2026-08-08-virtual-actor-session-runtime.md（原始提案；本目录保留未跟踪副本）
  - PR #846（Step 1+2 产出）
  - PR #852（Step 3 第一 PR：引擎替换 + 导入 + 混合窗口；JSON 净删除另立第二 PR）
---

# Session 架构拆解回收与 store-first 重新分步

> 本文取代 stage2 分支上的 `2026-08-11-session-actor-core-implementation.md` 成为
> 后续实施的唯一口径。原 0811 文档随其分支一并归档，不再维护。
>
> **2026-08-13 修订**：Step 1 执行后发现 7 项候选中 6 项的「缺陷」是 stage2
> runtime 分层自身引入的回归（master 无此缺陷或机制仍活），只有 1 项在 master
> 真实存在。这暴露了原计划的一个方法论缺陷：**Step 1 的候选清单直接采信了
> stage2 的修复记录，而 stage2 的修复大多是在收拾迁移自己造成的回归**（§0 的
> 「fix(session) 15 个」判断在候选粒度上再次得到证实）。据此本次修订：
> ① 记录 Step 1 实际产出与逐项处置；② **以 master 为唯一证据源重新核实
> Step 2/3/4 的全部前提**——核实结论是三步全部成立，且 Step 3 的收益比原文
> 写的更大，但两处前提表述需要修正（见各节【master 复核】）。
>
> **2026-08-19 修订**：#831 / virtual-actor 仍不合入；现行范式是 store-first，
> 不是把 actor 缝隙再包一层。Step 3 第一 PR（#852）rebase 到
> `origin/master@47b2c11a` 后复核：引擎替换与行级写的收益成立，但原文收益
> 第 1 条（「仲裁不再依赖 findDaemon-TOCTOU」）过满——SQLite 只排序写者，
> daemon 在位探测仍必须保留；净删除未在本 PR 兑现（JSON 机器仍在，留给灰度
> 稳定后的第二 PR）。0813 之后 master 还叠了 Remote lineage 改名、Mojo close
> journal、`SessionStoreUnavailableError` 写门，Step 3 必须带着这些 API 一起
> 换引擎，不能只按 0813 的 JSON store 形状施工。

## 0. 背景与决策

对 feat/virtual_actor_stage2（含第一、二阶段全部工作，37 个分支独有提交）以
origin/master 为基线的综合评估结论：

- 会话态 1,408 个 mutation 中仅 453（32%）收进 SessionRuntime 缝隙，910（65%）仍直写；
  最大写面（worker-pool 530、daemon 221、session-manager 135）未动。
- 零个 src 文件被删除，legacy 公共文件体量持平——新层是包上去的，不是换出来的。
  （补充精确化：`session-store.ts` 在 stage2 上从 832 行**增长到 1,387 行**——
  在 JSON 全量文件之上叠了一套 owner-bound typed-transition + readback 的平行
  API，旧 API 原封保留。这正是本计划要反着做的事。）
- 过渡资产（`current-*` 适配层 17k 行 src + 26k 行绑定测试）按设计将来整体报废；
  审计脚手架 23k 行挂在 build gate 上，master 每合入一个碰会话态的 PR 都要人工入册。
- 37 个提交中 fix(session) 15 个（多为迁移自身回归的收束）；identity 子系统经历完整
  的「建成—修复—拆除」往返。
- 结论：按调用方群组横切的 staging 使共存面不随进度收窄、收益全部递延到 Target-B，
  中间态负担大于收益。**决策：#831 不合入，拆解回收，按 store-first 重新分步。**

## 1. 分步原则（硬性判据）

1. **每一步合入后，系统必须比之前更简单，或至少删掉了东西。** 不满足即不立项。
2. **边界必须是结构性的**（interface / 唯一导出点，tsc 可执法）；禁止台账式纪律
   边界与随附的审计 gate。
3. **收益不许递延超过一步。** 任何「为了第 N+2 步铺路」的纯铺垫不单独成步。
4. 每一步是一个可独立发布、可独立回退的 PR；事务/串行化语义只在有实测竞态处
   逐个引入（ROI gate，I1 的教训）。
5. **（0813 新增）证据只认 master。** stage2 的修复记录、竞态清单、写点地图
   一律只当「去哪里看」的线索，不当「那里有问题」的证明——Step 1 的执行证明
   照抄会把 runtime 层自己的回归误判成 master 缺陷。任何一步立项前，其前提
   必须在 master 代码/实测上独立复核。

## 2. 步骤

### Step 1 — 独立修复摘取【已完成，PR #846】

以 stage2 实现为对照，逐条核实 7 项候选「能否脱离 runtime 层在 master 最小重做」。
**执行结论：6 项不成立，1 项重做落地。**

| 候选 | 处置 | 判定依据（均已在 master 代码上核实） |
|---|---|---|
| bot listing 热路径 | 无需重做 | master 所有 `getAvailableBots` 调用点本就只在 opening/initial 路径；每消息放大是 C1 切换自身回归（stage2 注释自证 "master parity"） |
| generation reconcile 单调判定 | 不适用 | 整行深比较 + 隔离台账只存在于 `current-session-executor-runtime.ts`；master `reserveWorkerGeneration` 写失败即回滚重抛（worker-pool.ts:10119），无永久封禁路径 |
| /close 竞态 VC reconcile 时序 | 不适用 | 竞态由 C1 把 exit 回调改 context-only + `findActiveBySessionId` 早退引入；master 回调闭包 `ds` 直调（daemon.ts:20743/20765），reconcile 不过守卫 |
| 幂等台账/executor slot 有界回收 | 不适用 | 被 cap 的 Map 全是 runtime 层新建物；master 对应物本已有界（`eventClaims` TTL+prune、`dispatchInputReceipts` cap 64、delivery/fence settle 即删） |
| 删 async tail-admission | **降级 Step 4 素材** | master 上是活代码：daemon.ts:18766/18825/19370 三个生产投递点仍在调用（见 Step 4 候选 d） |
| classify/gate 三份收敛 | 不适用 | 重复是 staging 自身制造；master gate 唯一定义（worker-pool.ts:6055），「孤儿 import」在 master 均为活引用 |
| ingress 终态失败回可行动提示 | **✅ 已重做** | master 真实缺陷：dispatcher 对两个消息入口只有 log-only catch，transport ACK 后异常 = 静默吞消息。PR #846（src +29/−2，回归测试 +273） |

**教训入库**：Step 1 比预期薄——这本身是对 §0「stage2 的 fix 多为迁移自身回归」
判断的正面验证，不动摇 store-first 决策；动摇的是「拿 stage2 记录当候选清单」
的做法，已固化为分步原则 5。

### Step 2 — 存储缝隙收口【已完成，并入 PR #846】

`services/session-store.ts` 已在 master 存在（832 行、18 个消费模块、全仓 119 处
`updateSession` 调用）。本步把它变成**唯一的门**：收编绕过它直接触碰会话行持久化
的路径，persistence 细节（文件布局、锁、tmp+rename）全部内部化为私有。行为零变化。

【master 复核 ✅ 前提成立；实施中的事实修正见「执行结果」】

绕过写者：

- `cli.ts saveSession()` —— **无锁**的整文件 read-modify-write（连 tmp 文件名
  都是固定 `.tmp`）。**实施期修正**：其唯一调用链
  `closeSessionForDelete → closeSessionOffline → saveSession` 在 master 上已是
  **死代码**（活的 delete 流早已换到 `abandonSessionAuthoritatively →
  abandonSessionOffline`，全程走带锁的 `mutateSessionOffline`）。处置从「修复
  无锁缺口」改为**整链净删除**（连同孤儿 `loadSessionFresh` 与
  `SessionDeleteCloseResult`）。
- `cli.ts mutateSessionOffline()` —— 带锁 + `findDaemon` fail-closed 的离线
  CAS。语义正确，但它是 store 之外第二份「锁 + 读改写 + strip legacy 字段」的
  拷贝；收编为 store 导出的唯一离线突变入口。
- `cli.ts loadSessions()` —— 第二份「读全部会话文件 + repair」实现；由 store
  的读 API 替代。

绕过读者（改为 store 导出的读 API，语义不变）：

- `daemon.ts readSessionFreshFromDisk()` —— daemon 自己的无锁直读（per-bot +
  legacy 双文件）。热回复路径上无锁快照读是正确语义（atomic rename 保证单文件
  自洽；带锁的 `getSessionFresh` 会阻塞且超时抛错），故收编为 store 的无锁点读
  导出，与 worker 用的带锁 `getSessionFresh`（刻意要求写序）并存、各守其义。
- `core/current-turn-provenance.ts readPersistedSession()` —— 跨全部会话文件的
  只读身份证明扫描。安全敏感：扫描机制收编进 store（数据目录不可枚举 →
  fail-closed 抛错；单个损坏文件跳过），「恰好解析一次」的判定策略留在原模块。

**执行结果（2026-08-13）**：store 新增 4 个导出——`loadAllSessionsSnapshot`
（跨文件快照读，含 sandbox fallback）、`mutateSessionRowOffline`（带锁离线行
突变，`abortIf` 在锁内入口与发布前各探测一次 daemon 在位）、
`readSessionRowFromDisk`（无锁点读）、`readSessionRowCopiesAcrossStores`
（fail-closed 逐文件身份扫描）；cli.ts 的平行持久化实现与死链整体删除
（cli.ts +29/−250），daemon/provenance 直读改走 store（−16/−20）。src 全仓
不再有 session 文件路径拼装点（rg 验证为零）。新增回归 14 例（快照合并/sandbox fallback、
点读回退、fail-closed 扫描、离线突变的 fresh-row/abortIf 双探测/收敛清理）。

**范围边界（防蔓延）**：本步只管**会话行**store。以 sessionId 为键的旁路存储
（turn-sends jsonl、frozen-card-store、whiteboard-store、usage-ledger、
idempotency-store、vc-meeting-* 系列）不动——它们各自有独立文件与生命周期，
不属于「会话行持久化」。`utils/file-lock.ts`（1,004 行）是 ~30 个 store 共用的
基础设施，同样不动。

验收：会话行落盘入口收敛为 1 个模块导出面；删除 cli.ts 分散拷贝与死链。
**无台账、无审计脚本。** ✅

### Step 3 — SQLite 引擎替换（1~2 个 PR）

在 Step 2 的门后把 JSON 换成 per-bot SQLite（`node:sqlite`：免 flag 线
v22.13.0 / v23.4.0；仓库先例 `adapters/cli/opencode.ts`，但现行门是 daemon
`assertSqliteSupported()`，不是 opencode 注释里的 experimental）。

【master 复核 ⚠️ 前提表述需修正，但修正后收益更大】

原文「每 bot daemon 本来就是自身会话文件的唯一写者——单写者拓扑现成」**不准确**。
实际写者拓扑：

- per-bot daemon 是唯一**在线**写者（一 bot 一 daemon 进程）；
- **CLI 是离线维护写者**（offline close/abandon 等），今天靠
  「`withFileLockSync` + 锁内 `findDaemon` 探测」维持互斥，存在 TOCTOU 窗口，
  且 `saveSession` 这条腿连锁都没有（Step 2 先收口）；
- worker 子进程与其它 bot 的 daemon 是跨文件**读者**（`findInOtherFiles`、
  `findActiveSessionsMatching`、`countActiveSessionsOnDisk` 等）。

这个修正不削弱反而加强 Step 3 的立项理由——SQLite 在 master 上可核实的收益：

1. **写者互斥从文件锁换成引擎锁**：WAL 下多读者成立；离线 CLI 与 daemon 的
   **写排序**由 `BEGIN IMMEDIATE` 承担。**不是**「findDaemon 探测可以删」——
   SQLite 锁只排序写者，防的是写写交错；探测防的是「daemon 内存缓存与磁盘
   分叉」，二者不可互替。残余 probe-vs-publish TOCTOU 与 JSON 时代等宽，仍
   是 Step 4 的事务化候选，不是本步验收项。
2. **消灭整图覆盖丢失更新这一整类问题**：今天 daemon 进程终身持有一份
   `Map<string, Session>` 缓存（`load()` 仅一次），每次 `save()` 把**整个 map**
   序列化重写文件——任何外部进程在窗口内写入的行都会被陈旧整图覆盖。改成
   行级 upsert 后该类问题在 SQLite 路径上结构性消失。首次 load 必须与离线
   写者走同一排他协议（`BEGIN IMMEDIATE` 快照读），否则仍会把提交前旧行读进
   终身缓存。
3. **热路径成本**：`updateSession` 全仓约 125 个 src 调用点（0813 计 119；
   0819 基线因 Mojo/dashboard 等新增约 +6）、每条入站消息触发多次，
   每次 `JSON.stringify` 全部会话行（live 数据实测：单 bot 文件 228KB/40 行、
   closed 行从不回收、只增不减）再做 byte-identical 跳写。行级写把 O(全部行)
   变 O(1)。
4. **净删除**（本步的删除项，兑现原则 1；**第一 PR 不兑现，灰度稳定后的
   第二 PR 才删**）：store 内 JSON 机器全部私有报废——`withFileLockSync`
   编排、tmp+rename 原子替换、byte-identical 跳写、legacy `sessions.json`
   迁移分支、`repairMissingChatScopes`（转为导入期一次性步骤）；以及
   **Remote lineage CAS + readback 的 JSON 实现**（0813 时名为 Riff；0819
   基线已改名为 Remote，含 Mojo 共用）。第一 PR 只在 SQLite 上等价重写，
   JSON 实现与 db-else-json 分流逻辑必须留到回滚窗口关闭。因此第一 PR
   **暂时违反原则 1 的「合入即更简单」**——这是设计允许的 1~2 PR 切分，
   不是另起 actor 层；验收以第二 PR 的净删除为准。
5. durability 口径修正：今天的语义是 **tmp+rename、无 fsync**；SQLite WAL +
   `synchronous=NORMAL` 首版即不弱于现状，不顺带升级（维持原验收）。

实施要点（0819 按现行基线补齐，不改目标）：

- 首启从既有 JSON **确定性自动导入**（per-bot 文件 + legacy `sessions.json`
  中属于本 bot 的行；`repairMissingChatScope` 在导入时执行一次）：无操作员
  仪式、无 promotion、无 HIL。JSON 不可读则 **fail-closed**（`loadFailure` +
  `SessionStoreUnavailableError`），禁止导入出空库把唯一副本毁掉。
- **保持 `updateSession(session)` 等既有签名不变**（内部变行级 upsert）。
  0819 基线门面已比 0813 宽：`listSessionsStrict` / `loadForWrite` /
  `persistActiveRemoteLineage*`（原 Riff）/ Mojo close journal 必须走同一
  引擎，不能只换 `updateSession`。
- 跨 bot 发现类读者改为只读打开兄弟 bot 的 `.db`；扫描函数按 db-else-json
  解析每个 store。远程 sandbox 无本地 store 的路径（cli.ts `loadSessions`
  走 `loadAllSessionsSnapshot` + sandbox fallback）语义不变。
- per-bot 库放 `session-stores/<appId>/sessions.db`（目录 bind，避免 bwrap
  单文件 inode 钉死 WAL sidecar）；legacy 无 appId 库保持平铺、不进沙盒。
- worker `owner: false`：混合窗口内旧 daemon 从新 dist spawn 的 worker 不得
  首启导入。
- Node 门：`node:sqlite` 免 flag 线为 v22.13.0 / v23.4.0；`engines` 收紧为
  `^22.13.0 || >=23.4.0`，daemon 启动 `assertSqliteSupported()` 才是真门
  （opencode.ts 仍标注 experimental，那是先例不是现行能力边界）。
- 经 npm canary 渠道灰度；稳定后删除 JSON 会话持久化路径（第二 PR）。

验收：第一 PR = 引擎互换 + 混合窗口 + 行为等价（含 0819 基线新增 API）；
第二 PR = 上述净删除。durability 首版与今日等价。

**执行结果（2026-08-19，#852 rebase onto origin/master@47b2c11a）**：

- store 公共签名保持；内部 SQLite 单表 + 整行 JSON 列 + VIRTUAL 生成列索引。
- 混合窗口统一 db-else-json；abortIf 双探测保留；首次 load 走 BEGIN IMMEDIATE。
- 0819 基线新增面已接上：Remote lineage CAS、Mojo journal 经 `persistRow`、
  损坏 store 的写门对 .db 同样 fail-closed。`BEGIN IMMEDIATE` 超时
  （SQLITE_BUSY）**不得**收成空投影：daemon restore 走 `listSessions()`，
  锁等待必须抛错而不能当成「没有会话」。
- 体量：master `session-store.ts` 1390 行 → 本 PR ~2135 行。这是「JSON 机器
  + SQLite 机器」共存的中间态，印证原则 1 的兑现点在第二 PR，不在本 PR。
- src 无 SessionRuntime / virtual-actor 缝隙回流。

### Step 4 — 按痛点上事务（N 个独立小 PR，ROI gate）

仅对**在 master 上有实测复现**的竞态，用 SQLite 事务原语逐个重做。
**（0813 收紧）复现要求 test-first：每个候选先在 master 写出能红的竞态测试或
给出线上事故指针，才允许立项——stage2 竞态清单只指路，不作数。**
每个 PR 必须删掉它所替代的 ad-hoc 防御——不删旧的，就不上新的。

【master 复核 ✅ 事务形状的 ad-hoc 防御真实存在，候选素材如下（未验复现，
仅为「去哪里看」清单）】

- (a) `closeSession`/`reactivateClosedSession` 的手工回滚（session-store.ts
  `closeSession` / `reactivateClosedSession` / `mutateMojoCloseJournal` 的
  persistRow 失败还原）——save 抛错时逐字段还原。Step 3 落地后事务化即天然
  替代，可能不需要独立 PR。行号随 master 漂移，以符号名为准。
- (b) `reserveWorkerGeneration` 回滚重抛（0819：worker-pool.ts `reserveWorkerGeneration`）
  与 worker exit fence 的**无保护** `updateSession`——后者是 Step 1 分析中发现
  的疑似真实脆弱点。立项前必须在现行 master 重新定位行号并写出能红的测试。
- (c) `admitQueuedActivationTail` 的 priorTail 回滚舞蹈（0819：worker-pool.ts
  `admitQueuedActivationTail`）。
- (d) **async tail-admission 整套**（0819：daemon.ts
  `queuedActivationTailAdmissionsOutstanding` / ReleasePending / RetryTimer
  三件套 + DaemonSession 三字段 + gate 分支）——Step 1 候选 5 的降级素材归位处：
  若队首激活的 FIFO 语义由事务表达，这套进程内计数器机器就是它替代并删除的
  ad-hoc 防御。
- (e) `initial-user-turn` 的 best-effort persist（落盘失败退化为进程内生效）。

stage2 的 receipts / per-session lane 语义仍作设计参考，代码不搬。

### Step 5 — 资产归档（无代码）

- feat/virtual_actor_stage2 打 tag 归档，#831 关闭并留结论指针；
- 两份审计台账转为一次性《会话写点地图》静态文档（1,408 写点分布本身有诊断
  价值），声明停止维护，审计脚本不迁移。

## 3. 非目标

- 不迁移调用方群组，不建 actor 抽象层，不引入 SessionRuntime/SessionProjection 缝隙；
  virtual-actor（#831 / feat/virtual_actor_stage2）维持不合入，不在 Step 3/4
  「顺便固化」。store-first 就是对它的替代，不是前置。
- 不引入分配式身份或任何注册表（BotId 保持地址纯推导）；
- 不动内存 DaemonSession 的共享可变语义——它在单 daemon 进程内工作正常，
  重构它需要独立的实测理由；
- （0813 明确）不把 sessionId 旁路存储（turn-sends、frozen-card、whiteboard、
  usage-ledger、idempotency、vc-meeting-*）卷进 Step 2/3 的范围。

## 4. 与 stage2 资产的关系

代码不搬，知识全收：1,408 写点地图（台账坐标）、竞态与幂等语义清单
（receipts/lane 设计）、以及「纪律性边界必然演化出监视系统」这条反面教训。
**（0813 追加）使用方式收紧：全部按「线索」使用，逐条在 master 复核后才可
立项——Step 1 的执行记录（7 项候选 6 项不成立）就是这条规则的成因。**
