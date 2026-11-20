# 私聊专属群的可视化协作配置、角色就绪确认与自动开工

日期：2026-11-20（同日按设计复核意见修订）
状态：**设计稿**（对应 issue #3588；本文是设计验证，未实现）
作者：Alma
基线：master `c53cf97c0`（本文代码位置以此为准）

## 1. 背景与目标

现状：私聊机器人发任务会自动建一个专属群（`p2pMode='group'`，`src/core/session-group-birth.ts`），但群里只有当前 bot + 发起人。想加 Builder/Reviewer 协作，需要手动邀请、应用角色、点名启动，且「消息已发送」无法证明角色已就绪。

目标体验：**页面预配置 → 私聊发任务 → 自动建专属群 → 拉入额外 Agent → 分别应用本群 Role → 确认就绪 → 按分工自动开工。**

本文给出配置模型、私聊入口契约、角色就绪协议、跨 daemon 启动/回合回执、分阶段 gate、持久幂等与恢复、额度归属的设计，并对照 issue 的验收表逐条核对。

## 2. 现状盘点（代码事实）

| # | 事实 | 位置 |
|---|---|---|
| 1 | 私聊专属群建群只拉当前 bot；成功后返回重写上下文，调用方递归 `handleNewTopic` 并启动 creator；返回 `null` 则落回 DM thread | `src/core/session-group-birth.ts:101-154,293-310`；`src/daemon.ts:27065-27135` |
| 2 | DM 在建群前已执行授权、`prompt.submit` 与扣费；重写后的回合用 `sessionGroupQuotaConsumed` 避免第二次扣费 | `src/daemon.ts:27094-27134,27469-27486` |
| 3 | `createGroupWithBots` 把 create、邀请、授权、角色消息和可选 kickoff 串在一个函数里，不能直接把整个函数当作可恢复的单一 create 步骤 | `src/services/group-creator.ts:169-510` |
| 4 | 本群角色文件是 `{dataDir}/roles/{larkAppId}/{chatId}.md`；同部署各 daemon 共用 dataDir，可以读写同一文件 | `src/core/role-resolver.ts:1-14,43-47` |
| 5 | `writeRoleFile` 落盘前 trim + UTF-8 32KB 截断；`resolveRole` 是 chat ＞ team ＞ none，「无本群文件」不等于「无有效角色」 | `src/core/role-resolver.ts:68-79,148-157,208-218` |
| 6 | Profile `null` 表示条目不存在，`''` 是显式清空条目；apply 空条目会删除本群文件，而非写空文件 | `src/services/role-profile-store.ts:90-112,151-167`；`src/core/command-handler.ts:821-858` |
| 7 | **生产是 one daemon per bot**，不是全部 bot 同进程；各 daemon 通过 `dashboard-daemons/` 心跳描述符发现 peer，并用 host HMAC 调 loopback IPC | `src/daemon.ts:33678-33685`；`src/utils/daemon-discovery.ts:1-13,83-141`；`src/core/daemon-ipc-auth.ts` |
| 8 | `session-groups-{appId}.json` 是 per-app 注册表；现有出生流程只写 creator 的注册表，peer 不会自动得到该 entry | `src/services/session-groups-store.ts:22-25,82-149`；`src/core/session-group-birth.ts:185-193` |
| 9 | 本机多 bot talk-only 授权矩阵通过各接收方 daemon 落地；普通群路由在 session-group miss 后可继续走 oncall/peer/grant 等腿 | `src/core/dashboard-ipc-server.ts:13545-13551`；`src/im/lark/event-dispatcher.ts:2501-2553` |
| 10 | `createChat` 尚无 `uuid` 参数；飞书建群同 uuid 10 小时去重（#3405 尚未落地） | `src/services/groups-store.ts:229-257`；issue #3405 |
| 11 | `sendMessage` / `forwardMessage` 已支持调用方传稳定 uuid，但**消息 uuid 去重窗口是 1 小时**，与建群 10 小时不同；缺省 uuid 只保证单次调用内重试去重 | `src/im/lark/client.ts:238-247,350-369,549-583` |
| 12 | 专属群 origin provenance 只在 creator 的注册表回放；open_id 是 app-scoped，不能把 creator 的 owner/open_id/quotaKey 原样当成 peer 的身份 | `src/services/session-groups-store.ts:33-80`；`src/im/lark/event-dispatcher.ts:2399-2444` |
| 13 | 已有双向认证的 dispatch-launch IPC v1：`prepare/start/query/cancel`、target-owned durable admission receipt、操作查询与取消，可作为协作 kickoff 的协议底座 | `src/core/dispatch-launch-ipc-client.ts`；`src/core/dispatch-launch-source.ts`；`src/core/dispatch-launch-admission-store.ts` |
| 14 | daemon 已有执行终态与输出投递记录；`turn.finished` 本身是进程内去重通知，不能单独充当跨 daemon 持久回执 | `src/services/session-contract.ts:53-75,117-134`；`src/core/turn-finished-event.ts:1-21`；`src/services/output-delivery-journal.ts` |
| 15 | `GroupCreationDefaults` 已含 `agents/tag/avatar/autoStart`；#3518 已合入 `837dcd54a7`，`startGroupTask` 与 queued activation 积木可复用 | `src/services/group-creation-options.ts:6-16`；`src/core/group-task-start.ts:137-155`；`src/core/session-manager.ts:6343-6419` |

## 3. 总体架构与铁律

```text
私聊消息（非命令）
  │
  ├─ collaboration 未启用 → 现有 maybeBirthSessionGroup 路径，行为不变
  │
  └─ 启用
     ▼
  入口预检（在 creator 扣费之前）
    ├─ 同 sourceMessageId 已存在 → 返回已有进度，不再次扣费/建群
    ├─ 同 dmChatId 有活动初始化 → busy，不再次扣费/建群
    ├─ 配置/DAG/Profile/peer preflight 失败 → DM 明示失败，不建群、不开 CLI
    └─ 全过 → creator 现有准入恰好一次，携带 admission receipt 进入编排
     ▼
  CollabGroupInitOrchestrator（creator daemon）
    S0 plan       冻结配置与角色期望，创建稳定 initId
    S1 create     uuid 建群；先持久 chatId + creator origin 注册 + per-chat gate，再转发原始任务一次
    S2 invite     邀请并按成员回读补缺；workingDir 绑定可重入
    S3 grants     各接收方 daemon 写 talk-only grant matrix
    S4 roles      共享文件代写/清空 + 严格回读有效角色；未全绿不启动
    S5 kickoff    creator 本地或 peer daemon prepare/start；逐 Agent 持久回执
                   afterAgentTurn 等显式 artifact-ready 回执，不等消息顺序
```

**控制通道不再是群内 @消息。** creator 的进度卡片负责可见性；目标 daemon 的 `prepare/start` 是唯一启动通道，因此不会把 S5 自己的 kickoff 送进 IM gate，也不会把「飞书发送成功」误记成「CLI 已启动」。

四条铁律：

1. 显式 enabled 时，预检或后续必需步骤失败都 **fail closed**；不得回退 legacy DM/普通专属群继续开工。只有未启用协作才走 legacy。
2. S4 未全绿前，任何用户任务消息不得启动任何 participant CLI；每个 kickoff 目标还必须收到自己的 `session-started` 回执后才对该目标开放普通消息。
3. 群已建后任何失败都不另建群；所有外部副作用按 operation 逐项持久化，恢复时先查证，不得靠整个步骤重做来「幂等」。
4. `awaiting-input` 永远等待对应人工动作，daemon 重启不得自动推进；`cancelled` 后迟到回执只可留证，不得再触发启动。

## 4. 配置模型、依赖图与页面

### 4.1 存储模型（字段名仍可在实现评审中冻结）

挂在 `SessionGroupConfig.collaboration` 下；缺省、不存在或非 `{enabled:true}` 都完全关闭：

```ts
interface SessionGroupCollaborationConfig {
  enabled: true;
  roleProfileId?: string;              // 整群默认 Profile，可被单 Agent 覆盖
  agents: Array<{                      // 全部 participant；creator 固定占一行
    appId: string;
    roleMode?: 'profile' | 'no-chat-role'; // 默认 profile
    profileId?: string;                 // roleMode=profile 时参与解析
  }>;
  kickoff: Array<{                     // 首期必须恰好覆盖 agents 中每个 appId 一次
    appId: string;
    trigger: 'immediate' | 'afterAgentTurn';
    afterAppId?: string;
    artifact?: {                       // afterAgentTurn 必填；首期只支持显式标记 URL
      type: 'marked-url';
      hosts: string[];                 // 非空、精确 hostname 小写匹配，不用正则
      marker?: string;                 // 默认 BOTMUX_ARTIFACT_READY
    };
    prompt?: string;                   // 支持 {task}；不得覆盖系统注入的 artifact 协议
  }>;
  workingDir?: string;
  gatePolicy?: 'queue' | 'reject';     // 默认 queue
}
```

### 4.2 保存与运行时校验

保存时和 S0 都执行同一套校验；保存失败不落盘，运行时失败不开工：

- `agents` 按 App ID 寻址，每个都存在、非 `apiOnly`；creator 恰好一行，其他 appId 不重复。邀请时过滤 creator，复用 `resolveGroupCreationAgents` 的同源判定。
- 每个 `roleMode='profile'` 的 Agent 都能解析到一个 Profile 条目；`null`（条目不存在）是失败。`no-chat-role` 是用户显式选择「不设置本群覆盖，沿用 team 或 none」，**不是声称有效角色一定为空**。
- `kickoff` 恰好覆盖全部 participant 且 appId 不重复；`immediate` 不得带 `afterAppId/artifact`，`afterAgentTurn` 必须各带一个合法的 `afterAppId/artifact`。
- 依赖对象必须是 kickoff 中另一行，禁止自依赖、环、重复 target、无 immediate root 和不可达节点。artifact hosts 必须是非空合法 hostname 列表。
- 各 peer daemon 的 preflight 必须确认：在线且协议版本匹配、目标 appId 匹配、Profile/角色期望可解析、workingDir 可接受、能走本机授权矩阵与目标侧准入。peer 离线是明确未就绪，不是「群成员仍在就算可用」。含 afterAgentTurn 时，目标还必须声明 `durable-turn-output-receipt-v1` 能力，证明其 CLI/backend 组合能持久提供执行相位、终态和 delivered messageId；不支持的组合在保存/S0 拒绝，不得退化成屏幕轮询或「任意消息即完成」。

`configVersion = sha256(canonicalJSON({ collaboration, resolvedProfileEntries, referencedTeamRoles }))`，只取确定内容，不含 mtime。Profile 或被显式沿用的 team role 改内容也会改变版本；备份恢复不会造成假变化。

### 4.3 页面

- Botconfig 的「专属群 → 协作」展示 creator 固定行和额外 Agent 行，字段与存储一一对应：角色模式、Profile、启动依赖、artifact hosts、prompt、workingDir、gatePolicy。
- 依赖编辑直接显示 DAG 校验错误；`afterAgentTurn` 未填 artifact hosts 时不能保存。
- Profiles 页继续维护现有条目，提示空条目与 `no-chat-role` 都会沿用 team/none，而不是制造「绝对无角色」。
- 预检回执逐 Agent 展示 daemon 离线、协议过旧、缺 Profile、目录或授权不可用等原因。

## 5. 私聊入口、请求身份与扣费契约

### 5.1 稳定请求身份

```ts
sourceKey   = canonicalJSON([creatorAppId, dmChatId, sourceMessageId]);
initId      = sha256(sourceKey);                    // 不含 configVersion
configVersion = sha256(canonicalResolvedConfig);    // 单独校验
createAttempt = 0;                                  // 仅在人工接受超窗风险后递增
createUuid  = sha256(canonicalJSON([initId, createAttempt])).slice(0, 32);
```

同一 sourceMessageId 的重投永远归到同一 initId；配置从 v1 改为 v2 不会生成第二个请求或第二个建群 uuid。configVersion 只回答「这份回执/快照是否仍匹配」，不回答「是不是同一个请求」。

store 原子维护 `sourceKey → initId` 唯一索引和 `dmChatId → activeInitId` 在途索引：

- 同 source 重投：返回已有进度；即使配置已改，也不另建请求。
- 同 DM 不同 source 且上一请求仍活动：返回 `busy` 与当前进度链接，不扣费、不启动；上一请求到 `done/failed/cancelled` 后可重新发送新任务。
- 配置变化：当前 entry 进 `awaiting-input('CONFIG_CHANGED')`，可取消后由用户发新消息；不得拿旧回执启动新配置，也不得把重复通知当成新任务。

### 5.2 入口拆分

现有「先 creator 扣费，再 maybeBirth」拆成三个明确阶段：

1. `preflightCollabGroupBirth(data, ctx)` 全程在 creator 扣费之前：关闭协作直接返回 `legacy`；启用时先做无副作用的配置/DAG/Profile 结构校验，再在 per-app mutex 内完成 source/DM 判重并原子占位（`state='running'`、S0 在途，永久占用 sourceIndex、临时占用 activeByDmChat），随后才做 peer preflight。占位时写入 `creatorAdmissionOperationId = sha256(canonicalJSON([initId, 'creator-admission']))`，然后才允许进入扣费阶段；这样「已扣费但尚未建群」的崩溃重投也能找到原 operation。结构或 peer 预检失败返回 `failed`，同 source 返回 `existing`，同 DM 冲突返回 `busy`；都由 DM 回执结束并释放该释放的 DM 占位，**不进入任何 legacy CLI 路径**。
2. 新请求预检全过后，沿用 `enforceMessageQuotaForCliInput` 对 creator 恰好执行一次 talk 授权、`prompt.submit`、扣费，使用上一步 operation id 持久化授权/扣费回执，生成不可复用到其他 bot 的 `creatorAdmissionReceipt`。恢复时先查该 receipt，不得因 entry 尚无 chatId 再扣一次；明确拒绝则落 `failed` 并释放 activeByDmChat。
3. `startCollabGroupBirth(..., creatorAdmissionReceipt)` 返回 discriminated result：

```ts
type SessionGroupBirthResult =
  | { kind: 'legacy'; ctx: RoutingContext | null }
  | { kind: 'collab-handled'; initId: string; chatId?: string; status: string };
```

调用方收到 `collab-handled` 后不再递归 `handleNewTopic`，也不落 DM thread。creator 是否 `immediate`、是否 `afterAgentTurn`，都只由 S5 决定；不会出现 creator 被 legacy 首启抢先启动的情况。S5 对 creator 复用 #3518 的 queued session + `startGroupTask` 时携带第 2 步 receipt，跳过重复授权/扣费，但保留目标会话自己的准入记录。

原始任务与附件由 creator 在 S1 用独立 operation **只转发一次**。所有 peer 的首轮 prompt 引用新群里的转发消息和原始 source locator；不让每个 peer 再转发同一附件。creator 不在 immediate 名单也不影响上下文先到群。

## 6. 角色就绪确认协议

### 6.1 规范化与严格回读

定义唯一规范化函数，与 `writeRoleFile` 完全同源：

```ts
normalizeRole(content) = truncateUtf8(content.trim(), MAX_ROLE_BYTES);
expectedHash(content)  = sha256(utf8Bytes(normalizeRole(content)));
```

非空 Profile 的期望哈希按规范化后的实际落盘字节计算，不按原始输入、JS 字符数或未截断内容计算。新增严格读取 seam，区分 `missing / empty / readable / read-error`；现有 `resolveRoleFile()` 把部分读取失败归一成 `null`，不能单独用于冲突与就绪判定。

S4 同时记录 `{initId, configVersion, appId, expectedSource, expectedHash, actualSource, actualHash, verifiedAt}`。目标 daemon 接受 kickoff 前还要在自己进程重新解析有效角色并比对，防止只信 creator 的一张回执。

### 6.2 三类配置与冲突

| 配置/Profile 值 | 动作 | 就绪判据 |
|---|---|---|
| `profile` + 非空条目 | 写本群文件并回读 | `resolveRole.source='chat'`，内容等于规范化条目，哈希一致 |
| `profile` + `''` | 显式清空本群覆盖（新群通常无需 delete） | 记录并核对实际 `team` 或 `none`；team 内容与 configVersion 中快照一致 |
| `no-chat-role` | 不设置本群覆盖 | 同上；UI 明示「沿用 team 或 none」，不伪称「绝对无角色」 |
| `profile` + `null` | 必需条目缺失 | S0/S4 失败，不启动 |

代写/清空前先严格回读：无冲突才执行；已是期望状态则幂等成功；不同内容停在 S4 并进 `awaiting-input('ROLE_CONFLICT')`。gatePolicy 只决定用户消息排队或拒绝，**不决定冲突是否覆盖**。

「以配置为准」人工按钮相当于 `--force`：重新核对 initId、当前 configVersion、操作人权限和当前文件哈希；只有页面展示的冲突版本仍一致才允许覆盖，防止把人工刚改的新内容用旧按钮覆盖。取消则持久取消整个初始化。

角色在运行后被人工修改不回滚已跑任务；但在 S5 前的每次状态迁移和目标 kickoff 准入前，都必须重新校验有效角色与 configVersion。

## 7. 跨 daemon kickoff 与回执协议

### 7.1 通道与身份

复用 `findOnlineDaemon` + 双向认证的 dispatch-launch IPC v1 模式：请求/响应签名、目标 bootInstanceId、`prepare/start/query/cancel` 和 target-owned durable receipt。新增 collab payload 时使用 `initId/kickoffId/sourceMessageId` 作为来源身份；不把普通 dispatch task 的 sourceSessionId 硬套到 DM 出生流程。

每个 kickoff：

```ts
kickoffId = sha256(canonicalJSON([initId, appId, configVersion]));
```

- `collab.preflight`：S0 的只读检查；返回目标协议版本与能力（含 `durable-turn-output-receipt-v1`），不创建会话、不扣费。
- `collab.kickoff.prepare`：目标 daemon 校验目标 appId、gate/configVersion/角色、依赖满足证明、workingDir 和本机 talk/quota；持久化 target-owned operation + admission receipt + queued session 后返回。重复 kickoffId + 相同 payload hash 返回原 operation；同 key 不同 payload 拒绝。
- `collab.kickoff.start`：目标在 fork/activate 边界再次检查取消代际、角色和 admission，激活已预留会话；只有目标持久化 `{sessionId, turnId, acceptedAt}` 后才返回 `session-started`。
- `collab.kickoff.query/cancel`：网络结果未知、daemon 重启或超时后的查证/取消入口。query 返回目标持久 operation，而不是 creator 的猜测。

creator 自己走同语义的本地实现；peer 走 IPC。原始任务不再逐个 @广播，群内卡片只展示分工与状态。

### 7.2 目标侧授权与额度

creator 的 origin provenance 和 admission receipt 永不复制给 peer。每个 peer 在自己 daemon 内：

1. 用接收方视角已有 cross-ref/grant matrix 解析 creator bot 的身份；不接收 creator 传来的 app-scoped open_id 作为事实。
2. 走与 bot 发送者相同的 `evaluateBotTalk` / `prompt.submit` / quota 路径，得到**目标 daemon 自己生成**的 `talkReason/quotaKey/grantChatId/quotaReceiptId`。
3. 以 kickoffId 为 admission/扣费幂等键；重复 prepare/query 返回同一 receipt，不能再扣一次。取消按 target receipt commit/release 语义结算。

因此 creator DM 的 quota 只支付 creator；peer 的消耗记在各 peer daemon 的授权与账本路径中，不转移发起人或任何 bot owner 的人类配额。

### 7.3 回合/产物回执

目标 daemon 在本地持久化 `turn/output` 事实后，生成带稳定 `receiptId` 的回执并放入 target-owned outbox：

```ts
{ receiptId, initId, configVersion, kickoffId, appId,
  sessionId, turnId, terminalStatus, executionPhase,
  outputId?, messageId?, artifact?: { url, marker, contentHash },
  occurredAt, payloadHash }
```

- 推送 creator 后，creator **先持久化再 ACK**；重复 receiptId 返回已有结果。
- 未 ACK 推送按有界退避重试，目标重启后继续；creator 重启也主动 query 拉取，避免只靠推送或内存事件。
- creator 校验 initId、configVersion、kickoffId、session/turn 对应关系和 payloadHash。迟到但不匹配的回执只留审计，不改变状态；已取消则永久作废。

## 8. 分阶段 gate 与用户队列

### 8.1 per-chat 共享 gate

S1 得到 chatId 后、任何邀请/转发之前，creator 原子写 `{dataDir}/collab-gates/{chatId}.json`：

```ts
{ schemaVersion, initId, configVersion, creatorAppId, chatId,
  phase: 'initializing'|'active'|'awaiting-input'|'failed'|'cancelled'|'done',
  participants: Record<appId, {
    roleReady: boolean;
    kickoffState: 'pending'|'prepared'|'started'|'failed'|'cancelled';
    acceptingUserTasks: boolean;
  }>, revision: number }
```

该文件一个 chat 一个 writer（creator orchestrator），所有 participant daemon 只读，不做多进程 Map 读改写。peer 收到消息时直接按 chatId 查 gate，**不依赖自己是否有 session-group registry entry**。gate 写盘必须先于 bot 邀请，消除「peer 已能收消息但还没 gate」的窗口。

### 8.2 开放顺序

- S4 全绿只表示 `roleReady`，允许内部 kickoff，不自动对用户开放。
- immediate Agent 收到自己的 `session-started` 后，才设置 `acceptingUserTasks=true`。
- afterAgentTurn Agent 还必须等 §9 的 artifact-ready 并完成自己的 kickoff，才开放。
- 因而用户消息不会在目标首轮会话尚未建立时抢先进去；Reviewer 也不能被用户消息绕过依赖提前启动。
- `done` 表示所有必需 kickoff 均已启动或显式终结，不再兼任 gate 的唯一开关。

### 8.3 每个接收方自己的持久队列

gate 检查放在各 daemon 的消息准入之前、扣费之前：

- `queue`：目标 daemon 将规范化路由事件、sourceMessageId、目标 appId 和投递状态写入自己的 per-chat 持久队列，回复可见排队位置；同一 sourceMessageId 去重。
- `reject`：返回明确原因、当前步骤和重试入口，不启动、不扣费。
- `awaiting-input/failed`：只提示原因与人工入口，不新增排队；`cancelled` 禁止旧初始化及排队消息自动释放，群保留供查看和管理。
- gate open 后，目标 daemon 按 sourceMessageId 顺序重新进入正常准入，使用原有 turn/admission 幂等键，不重新发一条飞书用户消息。目标重启扫描自己的队列并以 gate 文件为准对账。
- 排队/拒绝通知等外发消息各自有稳定 operation uuid；1 小时外结果未知时不得盲目补发。

命令豁免不能复用「任何 `/` 都豁免」的宽谓词：只对 `command-schema/classifySlash` 明确判定为不创建/恢复会话、不注入 CLI 的管理命令放行；未知 slash 和 passthrough 仍受 gate 限制。

## 9. 启动依赖与 artifact-ready

### 9.1 immediate

S4 全绿后按 DAG 拓扑序执行每个 immediate kickoff。每个目标独立持久 `prepare/start` operation 与回执；A 已成功、B 未完成时崩溃，恢复只 query A 的原 kickoffId 并继续 B，绝不重新发送 A。

### 9.2 afterAgentTurn

首期不接受「回合结束 + 任意输出」作为产物就绪。只有 preflight 已声明 `durable-turn-output-receipt-v1` 的目标 CLI/backend 才能进入该路径；目标 daemon 必须同时看到：

1. 被依赖 kickoff 对应的 session/turn 进入 `succeeded`，不是 `waiting_input/blocked/failed/cancelled/reconciling`；
2. 最终输出已由 `OutputDeliveryJournal` 结算为 delivered，且有 messageId；
3. 已交付内容含配置 marker（默认 `BOTMUX_ARTIFACT_READY <url>`）；
4. URL 是合法 http(s) URL，hostname 精确命中该依赖配置的 hosts allowlist；
5. artifact 内容与 URL 的哈希、turn/message id 写入持久回执。

Orchestrator 在编译 prompt 时强制加入上述标记协议，Builder 只有在产物确实可评审后才应输出标记；daemon 仍检查成功终态、投递回执和 URL，不把模型一句「完成了」当信号。

`satisfiedBy = {receiptId, kickoffId, sessionId, turnId, messageId, artifactUrl, contentHash}`。只有它满足后，才 prepare/start 下一跳。

- 澄清或等待用户：保持依赖挂起并显示「等待 Builder 补充输入」，不启动 Reviewer；后续同 session 的新 turn 可继续产生回执。
- 成功但没有合法 marker、失败/取消、artifact 回执无法查证：进 `awaiting-input`，提供重试 Builder、人工指定有效 artifact 回执、取消三个入口。
- 默认 30 分钟无进展进 `awaiting-input('KICKOFF_TIMEOUT')`；重启不会自行解除。人工选择继续等待后才重新计时。

## 10. 持久状态机、幂等与恢复

### 10.1 store 与逐 operation 账本

creator 使用 `{dataDir}/collab-group-init-{creatorAppId}.json`：

```ts
interface CollabInitStore {
  schemaVersion: number;
  entries: Record<string, CollabGroupInitEntry>; // initId → entry
  sourceIndex: Record<string, string>;           // sourceKey → initId，永久唯一
  activeByDmChat: Record<string, string>;        // dmChatId → active initId
}

interface CollabGroupInitEntry {
  initId: string;
  dmChatId: string;
  sourceMessageId: string;
  configVersion: string;
  configSnapshot: SessionGroupCollaborationConfig;
  creatorAdmissionOperationId: string;
  creatorAdmissionReceipt?: unknown;
  chatId?: string;
  createAttempt: number;
  state: 'running'|'awaiting-input'|'done'|'failed'|'cancelled';
  awaiting?: { reason: string; operationId?: string; since: number; detail?: unknown };
  steps: Record<'create'|'invite'|'grants'|'roles'|'kickoff',
    { status: 'pending'|'running'|'done'|'failed'; at: number; error?: string }>;
  operations: Record<string, {
    kind: 'admission'|'create'|'forward'|'invite'|'grant'|'role'|'kickoff'|'notice';
    status: 'planned'|'attempting'|'done'|'unknown'|'failed';
    uuid?: string;
    firstAttemptAt?: number;
    payloadHash: string;
    receipt?: unknown;
    error?: string;
  }>;
  kickoffPending?: Record<string, { appId: string; satisfiedBy?: unknown }>;
  createdAt: number;
  updatedAt: number;
  cancelReason?: string;
}
```

同一 creator daemon 内所有「读 entry → 判重 → 写 entry」由 per-app 异步 mutex 串行化；每次原子写 tmp+rename、0600。不同 initId 也不能并发覆盖同一文件。peer 的 kickoff/queue/receipt 由各自 daemon 持久化，不与 creator 共享一个多写者 JSON。

**任何外部调用前先写 operation + stable uuid + payloadHash，成功后写 receipt。** 重入时 payloadHash 不同即冲突，不能拿同 key 做另一件事。

### 10.2 各步骤恢复

- **S1 create**：抽取 `createChatWithUuid` 等步骤原语，legacy `createGroupWithBots` 保留原包装；collab 不调用一个暗中连邀请/角色/kickoff 都做了的 monolith。首次 create 必须 `botIds=[]、userIds=[]`，先建 creator-only 群。`onChatCreated` 先落 chatId，再调用 creator 自己的 `registerSessionGroup`（ownerOpenId 来自原 DM 事件，originReason/originQuotaKey/originChatId 来自 creatorAdmissionReceipt），随后写全关闭 gate，最后才做转发和 S2 的真人/peer 邀请。注册与 gate 都可重入，任一失败都不得邀请；这样既保证任何可能收到消息的成员入群前 gate 已存在，也保证 creator 的 workingDir/oncall 绑定不会把后续消息切到无限额 oncall，而仍按原 DM provenance 授权与扣费。
- **原始上下文 forward**：独立 operation，成功记录 messageId；重试不能因整个 S1 未完成而再转一次。
- **S2 invite**：成员回读 + 对缺员重发邀请；不是只校验不修复。邀请与 workingDir 绑定按 appId 分项记录并可重入。
- **S3 grants**：各接收方 daemon 按 appId 回读/补齐 grant；某 peer 离线会阻塞并可见，不能默认全员成功。
- **S4 roles**：按 §6 哈希与有效角色幂等；已完成项不重复覆盖。
- **S5 kickoff**：逐 kickoffId query/prepare/start；逐项记录 session/turn/artifact 回执，禁止整步重放。

### 10.3 两套 uuid 窗口不能混用

| 副作用 | 窗口内结果未知 | 超出窗口 |
|---|---|---|
| 建群 uuid（10h） | 用同 createUuid 重试，并查本 store/session-groups/gate；同 uuid 返回原 chatId | 进 `awaiting-input('CREATE_UNKNOWN_EXPIRED')`，不自动重建。人工可新建 createAttempt（新 uuid），页面明确旧群可能已存在；也可终止 |
| 消息/转发 uuid（1h） | 用同 operation uuid 重试，取得原 messageId 后落 receipt | 进 `awaiting-input('MESSAGE_UNKNOWN_EXPIRED')`，由人工核对群内结果后选择「确认未发送再重试」或「不再补发并继续」 |
| 本地文件/授权/kickoff RPC | 以文件哈希、target query、target-owned receipt 对账 | 不依赖飞书 uuid；无法确定目标状态时保持 awaiting-input，不伪造成功 |

所有超时判定以 operation 的 `firstAttemptAt` 为准，而不是 daemon 重启时间。

### 10.4 重启、重试与取消

- 启动只自动扫描 `state='running'`。先对账 `attempting/unknown` operation，再从首个未完成动作继续；`done` operation 不重复执行。
- `awaiting-input` 原样停放并恢复卡片。只有对应人工动作（force、确认重发、继续等待、重试、取消）才把 entry 置回 `running`；配置版本不匹配、超窗、角色冲突、依赖超时均不得自动越过。
- 重试前重新做授权、Profile、peer preflight 和 configVersion 检查。旧按钮带 expectedRevision，期间有人改配置/角色/撤授权则拒绝旧动作。
- 取消先原子写 `state=cancelled` + gate + 新 cancelGeneration，再逐目标发送 cancel。每个外部副作用前和目标 admission/fork 边界都检查该代际；已经 accepted 的会话按目标 cancel 语义处理，尚未启动的不得再启动。
- S1 在途时取消，迟到 create 成功仍必须记录 chatId/gate 与「已建群但未继续」事实，不能因 cancelled 丢弃外部结果；后续不邀请、不授权、不 kickoff。
- 迟到回执在持久审计后按 initId + cancelGeneration + state 判定，只留证、不推进依赖、不释放队列。

## 11. 权限、身份与额度边界

- creator 的 origin* provenance 仅用于 creator 自己；S1 必须通过 creator 的 `registerSessionGroup` 持久化它，不能只写 collab entry/gate。peer 不复制 `ownerOpenId/originQuotaKey/originChatId`，其授权与 quota 由接收方 daemon 重新求值并持久化。
- S3 只建立本群 talk-only bot grant matrix，不授予 `canOperate`、群管理或用户级权限。`managerUserIds` 仍只有发起人，peer bot 不是群管理员。
- open_id 不跨应用复制。建群、邀请、群主/管理员操作使用 creator 视角 ID；目标侧准入使用目标 daemon 自己解析的 bot 身份和 grant。确需指认同一位真人时使用已验证的 union_id，不复制 `ou_`。
- 每次扣费都有目标侧持久 `quotaReceiptId + kickoffId`；重复通知、query、恢复、重试先查 receipt。creator 的预扣 receipt 只用于 creator，不能被多个 kickoff 分摊或重复使用。
- 同部署 HMAC 只是通道认证，不代替业务授权。目标 daemon 必须校验目标 appId、gate participant、payloadHash、grant/talk、角色和取消代际，不能让任意本地调用者伪造成已授权用户。

## 12. 验收对照

| issue 场景 | 本设计覆盖点 |
|---|---|
| 正常私聊发任务 | §5 入口返回 `collab-handled`；§7 目标启动回执；无需补命令 |
| Agent 离线/邀请失败/权限不足 | §4 peer preflight；§7 目标准入；§10.2 邀请补缺；未就绪不开工 |
| Profile 缺条目/应用失败/角色冲突 | §4 预检；§6 null/empty/no-chat-role、严格回读与冲突人工入口 |
| 角色就绪前群内新任务 | §8 per-chat gate + 每接收方持久队列；未 started 不开放 |
| 重复消息/超时/创建未知 | §5 稳定 source 唯一索引；§10.3 建群/消息分窗恢复 |
| 多步部分失败、daemon 重启 | §10 逐 operation 账本、target query/outbox；只恢复 running |
| 人工取消/改角色/撤授权 | §6 冲突 expected hash；§10.4 cancelGeneration、目标边界复查 |
| 重试窗口交叠/依赖未就绪 | §5 同 source/同 DM 判重；§7 目标幂等；§9 显式 artifact-ready |
| 多 bot 权限与额度 | §7.2、§11 接收方身份与持久 quota receipt |
| 未启用协作 | §3、§5 仅 disabled 走 legacy；契约测试钉住无关群/话题/adopt/restore |

## 13. 实施拆解与验证要求

1. **PR-1 配置与原语**：配置模型、DAG/Profile 校验、稳定 source store、create uuid、per-chat gate schema、入口 discriminated result。默认关闭及 creator 预扣/不重复扣费契约测试先行。
2. **PR-2 跨 daemon 初始化**：preflight、邀请/授权补缺、角色严格回读、per-participant gate 与持久队列、S0–S4 恢复/取消。
3. **PR-3 启动与依赖**：collab prepare/start/query/cancel、target admission/quota receipt、逐 kickoff outbox、artifact-ready 回执与依赖启动。
4. **PR-4 页面与收尾**：协作区块、进度/冲突/超窗/取消卡片、人工动作 expectedRevision、文档与 UI 截图。

每期都必须用真实 store、真实 daemon IPC（loopback + 签名）、可控飞书假实现与假时钟跑异常序列，至少覆盖：

- 同 source 在 config v1→v2 后重投、同 DM 不同 source 并发；断言一个 initId、一个群、creator 一次扣费。S1 配置 workingDir 时还必须断言 creator registerSessionGroup 的 originReason/originQuotaKey/originChatId 已恢复，后续 creator 消息不走无限额 oncall。
- S0 失败、creator afterAgentTurn、creator 不在 immediate：断言不递归 legacy、不落 DM thread、不提前启动。
- peer daemon 离线、peer 无 session-group entry、S4 前真人 @peer：断言 gate fail closed；补齐 gate 后 kickoff 仍可启动，无自死锁。对未声明 `durable-turn-output-receipt-v1` 的 CLI/backend 配置 afterAgentTurn，保存与 S0 均拒绝，immediate 不受影响。
- create 结果未知后第 9h59m / 10h01m 恢复；消息未知后第 59m / 61m 恢复；断言窗口内同 uuid、超窗不自动重发。
- 两个 kickoff 只完成 A 后崩溃、队列只释放一半后崩溃：query A/已回执项不重复，B/剩余项继续，quota receipt 不重复。
- force 后人工又改角色、取消时 create/kickoff 在途、旧回执在新 cancelGeneration 后到达：不得覆盖新状态或启动依赖。
- 澄清、等待输入、失败、成功但无 marker、marker URL host 不匹配：Reviewer 均不启动；合法 delivered artifact 才启动一次。能力声明覆盖的每种组合都要测 terminal+delivery 持久化，至少包含一个 PTY 家族后端与 TmuxBackend；未声明组合必须 fail closed。
- daemon 重启丢推送后由 query 拉回、重复 receipt ACK 后重投、peer 重启恢复自身队列：不永久静默、不重复投递。

变异复验至少包括：拆掉 preflight fail-closed、恢复 awaiting-input、把 configVersion 加回 initId、删 per-kickoff receipt、漏写 creator 的 registerSessionGroup、只在 creator registry 加 gate、让 gate 拦截内部启动、接受任意 turn terminal、忽略角色 team 回退、重复使用 creator quota receipt；对应用例必须咬红。

## 14. 首期边界与开放问题

- 仅同部署、同 dataDir 多 daemon；跨部署 federation 不在首期。跨部署不能复用「共享文件已写好」作为角色回执，需另做独立设计。
- 默认关闭，不改 `/g` 语义，不建设通用工作流引擎，不动无关群、话题、adopt/restore 和其他 CLI/后端行为。
- 首期 afterAgentTurn 只支持显式 marker + delivered URL；多产物择取、非 URL 产物和更复杂条件后续扩展，不能退回「任意输出即就绪」。
- kickoff prompt 的 i18n 与默认模板、群内进度卡与现有 session 卡的视觉共存仍需 UI 评审。
