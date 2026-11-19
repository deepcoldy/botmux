# 私聊专属群的可视化协作配置、角色就绪确认与自动开工

日期：2026-11-20
状态：**设计稿**（对应 issue #3588；本文是设计验证，未实现）
作者：Alma
基线：master `9fc065f53`（2026-11-19 核对为 `678251d3e`，本文行号以 `9fc065f53` 为准）

## 1. 背景与目标

现状：私聊机器人发任务会自动建一个专属群（`p2pMode='group'`，`src/core/session-group-birth.ts`），但群里只有当前 bot + 发起人。想加 Builder/Reviewer 协作，需要手动邀请、应用角色、点名启动，且「消息已发送」无法证明角色已就绪。

目标体验（issue 原文）：**页面预配置 → 私聊发任务 → 自动建专属群 → 拉入额外 Agent → 分别应用本群 Role → 确认就绪 → 按分工自动开工。**

本文给出配置模型、就绪确认协议、初始化状态机、幂等与恢复、额度归属五个核心设计项的方案，并对照 issue 的验收表逐条核对。

## 2. 现状盘点（代码事实）

| # | 事实 | 位置 |
|---|---|---|
| 1 | 私聊专属群建群只拉当前 bot：`larkAppIds: [larkAppId]` | `src/core/session-group-birth.ts:147` |
| 2 | `createGroupWithBots` 已支持多 bot 邀请、分批 5 个、失败逐个重试 | `src/services/group-creator.ts:204-222` |
| 3 | 建群后 creator 自己的 profile 条目**直接落盘**（`writeRoleFile`）；peer bot 只发一条 `/role profile apply <id> --quiet` 群消息，结果字段记录的是**消息发送结果** | `src/services/group-creator.ts:398-427`（发送在 `:420`） |
| 4 | 本群角色 = 本地文件 `{dataDir}/roles/{larkAppId}/{chatId}.md`；同部署所有 bot 的角色文件在同一 dataDir，daemon 可直接读写 | `src/core/role-resolver.ts:10-14,132-160` |
| 5 | `/role profile apply` 的完整实现是 daemon 内本地文件操作（读 profile → `writeRoleFile`），已有角色且无 `--force` 时拒绝（`apply_refused`） | `src/core/command-handler.ts:777-814` |
| 6 | Role profile 存储：`{dataDir}/role-profiles/{profileId}/{larkAppId}.md`，按 App ID 寻址，32KB/条上限 | `src/services/role-profile-store.ts` |
| 7 | 本机多 bot 免审批对话授权矩阵已有：`ensureLocalBotChatGrantMatrix`（经 `ensureBotCollaboration` 钩子在 owner 转移后、角色消息前执行） | `src/core/dashboard-ipc-server.ts:13519,13547`；`src/services/group-creator.ts:367-378` |
| 8 | `createChat` 尚不支持 `uuid` 幂等参数（#3405 的方向未落地） | `src/services/groups-store.ts:229-258` |
| 9 | 专属群注册表持久化 origin 授权 provenance（reason/quotaKey/originChatId），dispatcher 每条群内消息重放同一授权 | `src/services/session-groups-store.ts:50-90` |
| 10 | `GroupCreationDefaults`（`/g` 用）只有 `agents/tag/avatar`；私聊专属群配置是独立的 `SessionGroupConfig`（naming/namePrefix/workingDir/dmReceipt/forwardOrigin/onClose/tag/avatar） | `src/services/group-creation-options.ts:4-10`；`src/bot-registry.ts:1395-1461` |
| 11 | daemon 间已有 HMAC 认证的内部 API（`/api/roles` 等）可作跨部署通道的底座 | `src/dashboard/daemon-internal-api.ts:477-512` |
| 12 | #3518（open，未合入）提供 `/g --start` 建群即开工、准入顺序（talk 授权 → prompt.submit → 扣费）与 queued 激活积木；`startGroupTask` 负责转发+开新会话 | PR #3518 `src/core/group-task-start.ts` |

## 3. 设计总览

```
私聊消息（非命令）
  │
  ▼
maybeBirthSessionGroup ── sessionGroup.collaboration 未启用 → 现状行为（字节不变）
  │ 启用
  ▼
┌─ CollabGroupInitOrchestrator（新增，状态机驱动）────────────────────────┐
│ S0 plan      预检配置版本/名单/Profile/授权 → 不通过则回退现状并私聊告知   │
│ S1 create    uuid 幂等建群（复用 createGroupWithBots，多 bot 一次拉齐）    │
│ S2 invite    校验实际成员（invalidBotIds/成员回读），缺员 → 失败可重试      │
│ S3 grants    ensureLocalBotChatGrantMatrix（对话授权矩阵，已有积木）        │
│ S4 roles     本地代写各 bot 本群角色文件 + 回读哈希校验（§5，核心）        │
│ S5 kickoff   按分工启动：immediate 的先起；依赖型挂起等信号（§6）          │
│ 每步结果原子落盘 collab-init-store；群内卡片实时展示进度/失败/重试入口      │
└──────────────────────────────────────────────────────────────────────┘
  │
  ▼
专属群按角色协作（Builder 产出 → 产物就绪信号 → Reviewer 启动）
```

两条铁律贯穿全程：

- **群已建（S1 完成）后任何失败都不重建群**——恢复一律从持久化状态继续（对应 issue「外部调用结果未知时不盲目重建」）。
- **S4 未全绿之前，任何群内任务消息不得启动 CLI**（对应「初始化未就绪时不得绕过门槛」，见 §7）。

## 4. 配置模型与页面

### 4.1 存储模型（建议，字段名未冻结）

挂在 `SessionGroupConfig`（`src/bot-registry.ts:1395`）下新增可选块 `collaboration`，缺省不存在 = 完全关闭（兼容性要求）：

```ts
interface SessionGroupCollaborationConfig {
  enabled: true;                       // 必须显式 true，不存在/false 均视为关闭
  roleProfileId?: string;              // 整群角色套件（复用 role-profile-store）
  agents: Array<{                      // 额外 Agent 名单，按稳定 App ID 寻址
    appId: string;                     // 必须是 bots.json 里存在的 cli-app id（非 localIdentity）
    profileId?: string;                // 覆盖整群 profileId 的单 bot 条目
  }>;
  kickoff: Array<{
    appId: string;                     // 启动对象（含 creator 自己）
    trigger: 'immediate' | 'afterAgentTurn';
    afterAppId?: string;               // trigger=afterAgentTurn 时依赖的 agent
    prompt?: string;                   // 可选附加指令模板，支持 {task} 占位
  }>;
  workingDir?: string;                 // 覆盖 sessionGroup.workingDir
  gatePolicy?: 'queue' | 'reject';     // S4 未就绪时群内任务消息策略，默认 'queue'
}
```

要点：

- **App ID 寻址**，不依赖展示名。保存时校验每个 `appId` 存在于 bots.json 且非 `apiOnly`（复用 `resolveGroupCreationAgents` 同源判定，`src/services/group-creation-options.ts:220-233`），重名场景天然消除。
- Profile 条目存在性在**保存时预检**（每个 agent 在 `roleProfileId`/自身 `profileId` 下有非空条目，或显式声明「该 bot 无角色」），缺失项在页面逐条列出。运行时 S4 再检一次，防保存后条目被删。
- Profiles 页面继续用现有 role-profile 编辑能力（`roles-page.tsx` + `role-profile-store.ts`），本设计不新增第二套角色存储。

### 4.2 页面

- **Botconfig（bot-defaults-page）**：「专属群」区块下新增「协作」子区块——开关、Agent 多选（复用 `bot-multi-select`，值为 appId）、Profile 选择（读 `listRoleProfiles`）、每个成员的首轮分工与启动方式、workingDir、gatePolicy。保存走现有 `saveBotField` 通道，服务端做 §4.1 预检后落盘，预检结果随保存回执返回。
- **Profiles 页**：现有能力够用，只补一条提示——「用于协作群的 Profile 需为每个协作 Agent 配置条目」。
- 存储模型与页面字段一一对应，无仅页面态。

## 5. 角色就绪确认协议（核心设计项）

### 5.1 为什么本地代写 + 回读是正确通道

issue 列的三个候选：受信任本地通道 / 内部事件 / 应用结果回读。**同部署首期场景下三者合一**：

- `/role profile apply` 的全部副作用就是 daemon 写一个本地文件（盘点 #4/#5）。peer bot「收到消息再自己写」在同部署里是绕远：消息要出 daemon → 飞书 → 飞书再推回 daemon → command-handler 落盘，每一跳都可能丢，「发送成功」到「落盘成功」之间没有因果保证（盘点 #3 的缺口）。
- 同部署所有 bot 共享同一 dataDir 与同一 daemon 进程信任域。Orchestrator 直接对每个成员调 `writeRoleFile(appId, chatId, content)`，随后 `resolveRoleFile` 回读并比对内容哈希（sha256(normalize(content))）。「明确的应用结果回读」由此成立：写失败、写后被篡改、磁盘只读，全部在回读处暴露。
- 这**不是绕过权限**：现状里 `/role profile apply` 也是 daemon 代码在写文件，代写只是去掉消息中转；授权门槛体现在 §5.3（谁有权触发带协作的建群）与配置预检。
- 跨部署（后续）：peer 的 dataDir 不在本机，代写不可达。那时降级为「内部事件」协议——经 daemon-internal-api（盘点 #11，HMAC 已有）向对方 daemon 发 `role.apply(chatId, profileId, contentHash)`，对方落盘后回 `role.applied(contentHash)` 回执，哈希一致才算就绪。协议字段本期定名，首期不实现跨部署。

### 5.2 冲突与幂等语义

代写前先回读现状，决策表：

| 回读结果 | 动作 |
|---|---|
| 无文件 | 写入 → 回读校验 → 就绪 |
| 内容哈希 == 期望 | 幂等成功（重试/恢复场景常见） |
| 内容哈希 != 期望 | **冲突**：不覆盖。按 `gatePolicy` 停在 S4，卡片列出冲突 bot + 现有角色摘要，提供「以配置为准（--force 语义）」与「取消」两个人工入口 |

人工在重试窗口内改了角色 → 下轮回读发现哈希变化 → 按冲突行处理，不做无条件覆盖（对应验收「人工中途干预不被旧初始化覆盖」）。

新群是刚建的，正常路径不会有旧角色文件；冲突行主要保护恢复/重试/人工干预交叠的序列。

### 5.3 就绪回执与配置版本绑定

每次初始化请求生成 `initId = sha256(dmChatId + messageId + configVersion)`，`configVersion` 取保存协作配置时的 mtime+内容哈希。S4 的就绪记录持久化为 `{initId, configVersion, appId → {contentHash, verifiedAt}}`：

- 迟到的重试拿着旧 `configVersion` 来，与当前落盘配置版本比对不一致 → 拒绝继续开工，提示重新发起（对应「避免过期回执启动旧任务」）。
- 角色文件后续被人工改动**不影响已在跑的任务**——就绪确认只守门 S5 kickoff，不锁定群后续生命周期（`/role` 仍是运行时可用的管理命令）。

## 6. 初始化状态机与启动依赖

### 6.1 状态机与持久化

新 store：`{dataDir}/collab-group-init-{appId}.json`（沿用 session-groups-store 的 per-appId 单例 + 原子写模式）：

```ts
interface CollabGroupInitEntry {
  initId: string; dmChatId: string; sourceMessageId: string;
  configVersion: string; configSnapshot: SessionGroupCollaborationConfig;
  chatId?: string;                 // S1 落盘，此后永不重建
  createUuid?: string;             // §6.2 幂等键
  steps: Record<StepName, { status: 'pending'|'running'|'done'|'failed'|'skipped';
                            result?: unknown; error?: string; at: number }>;
  state: 'running'|'awaiting-input'|'done'|'failed'|'cancelled';
  kickoffPending?: Array<{appId: string; trigger: ...; satisfiedBy?: string}>;
  createdAt/updatedAt/cancelReason?: ...
}
```

步骤名固定有序：`create → invite → grants → roles → kickoff`。写放大极小（单文件原子写），每步迁移前后各写一次。

### 6.2 建群幂等（S1）

落地 #3405 的 uuid 方向：`createChat` 增加 `uuid` 参数（`src/services/groups-store.ts:229` 签名扩展），值 = `sha256(initId)` 截断 32 位。飞书同 uuid 10 小时只建一个群：

- 调用超时/断连（结果未知）→ 不视为确定失败；用**同一 uuid** 重试，飞书去重返回同一 chatId；若仍拿不到，走「查证」：按 initId 查本 store（若 chatId 已落盘即恢复）、再查 session-groups 注册表。
- 超出 10h 幂等窗口且无本地记录 → 进入 `awaiting-input`，卡片给出「重新建群（新 uuid）」人工按钮，不自动重建（对应「超出远端幂等窗口的恢复策略」）。
- `onChatCreated` 钩子（`group-creator.ts:104-108`）继续作为持久化 side-effect 边界：chatId 第一时间写 store，后续任何步骤失败都不影响「群已存在」这一事实。

### 6.3 恢复、重试与取消

- **daemon 重启恢复**：启动时扫 `state ∈ {running, awaiting-input}` 的 entry，校验 `configVersion` 仍匹配当前配置（不匹配 → `awaiting-input` 提示配置已变），然后从第一个非 done 步骤继续。已 done 步骤直接跳过（幂等语义见各节：S2 重查成员、S3 矩阵可重入、S4 哈希比对、S5 见下）。
- **同一请求并发重入**：以 initId 为 key 的内存锁 + store 内 `running` 标记，重入直接返回进行中状态（对应「同一请求不会并发重入」）。
- **重试**：卡片按钮触发，重试前重新跑 S0 预检（授权、配置版本、Profile 条目），防止旧初始化覆盖中途的人为干预（关配置、删 Profile、撤授权都会被 S0 拦下）。
- **取消**：卡片按钮/关闭配置触发，`state=cancelled` 落盘后：未建群 → 终止；已建群 → 不解散群（用户可能还要用），但所有 pending kickoff 与迟到回执全部作废（判 initId + state）。

### 6.4 启动依赖（S5）

- `immediate`：S4 全绿后立即启动。启动方式复用 #3518 的准入积木（talk 授权 → prompt.submit → 扣费）与 `startGroupTask`（转发 + 新会话首轮输入 = `groupTaskPrompt` + 角色分工模板拼接）。
- `afterAgentTurn`：不靠消息顺序。**可信信号 = daemon 自己的会话状态**：被依赖 agent 在该群的 chat-scope 会话回合结束（daemon 的 session/turn 生命周期事件），且其最终产出消息已投递（有 messageId）。`satisfiedBy` 记录触发它的 turn/message id。「产物就绪」首期以「回合完成 + 产出已投递」为判据——不做对产出内容做语义判断（那是 Reviewer 自己的活）；可评审产物（PR 链接等）在 prompt 模板里让 Reviewer 自行从群里取。
- 依赖的 agent 初始化失败 → 依赖它的 kickoff 挂起，状态可见；不静默放弃也不无限等（默认 30 分钟超时进 `awaiting-input`）。
- **禁止无差别广播**：kickoff 只逐个 @ 目标 bot 发其分工 prompt（复用 `group-creator.ts:429-469` 的 mention 解析与校验），不发群发任务。

## 7. 未就绪门槛（gate）

群内任务消息在 `state ∉ {done}` 时的处理，挂在 event-dispatcher 的 session-group 路由（`evaluateSessionGroupTalk` 附近）：

- `gatePolicy='queue'`（默认）：消息持久化进该 entry 的 `queuedTaskMessages`，S5 完成后按序投递；卡片显示「初始化进行中，你的消息已排队（第 N 位）」。
- `gatePolicy='reject'`：回复明确拒绝原因 + 当前进度步骤。
- `state=failed/awaiting-input` 时二者都只提示失败原因与重试入口，不排队（防止永远没人消费的假排队）。
- `/close`、`/login` 等会话管理命令不受 gate 限制（与 `declinesSessionGroupBirthAsSlashCommand` 同一谓词家族，`session-group-birth.ts:89`）。

## 8. 权限与额度归属

- **发起人授权不扩大**：专属群消息继续按 origin* provenance 记账（盘点 #9），协作能力不新增发起人侧授权。
- **额外 Agent 的对话授权**：S3 的 `ensureLocalBotChatGrantMatrix` 只授「群内 bot 互相对话」权限（现有语义，盘点 #7），不携带任何用户级授权。
- **额度归属**：每个 kickoff 触发的会话回合，记在**被启动 bot 自己**的 quota/账本上（它的会话、它的 CLI 进程）；发起人不为 peer bot 的消耗买单，peer bot 也不隐式挂到某个 owner 的人类授权上。bot-to-bot 后续消息走 grant matrix 的对话授权（有 grant，无人类配额转移）。重复通知/恢复/重试的回合与普通回合同一记账路径，`initId` 记入账本元数据用于事后对账去重排查——不为同一 sourceMessageId 重复投递首轮（initId 幂等保证），自然不会重复扣首轮费用。
- **open_id 不跨应用复制**：mention 解析继续用 creator 视角的 `listChatBotMembers`（`group-creator.ts:437`），管理权限只授发起人（`managerUserIds`），peer bot 不获得群管理权。

## 9. 首期边界

- 仅同部署多 Agent（Builder/Reviewer 验证）。跨部署的 federation 协议只预留 §5.1 的接口形状，不实现。
- 默认关闭：`collaboration` 不存在/非 `{enabled:true}` 时，私聊专属群行为与现状字节一致（现有测试全绿即证明）。
- 不改 `/g` 语义、不建通用工作流引擎、不动话题/adopt/restore 等无关链路。
- 依赖 #3518 的积木（准入顺序、`startGroupTask`、queued 激活）；若 #3518 尚未合入，实现顺序上先等它落地（见 §11 排期注记）。

## 10. 验收对照（issue 验收表逐条）

| 场景 | 本设计覆盖点 |
|---|---|
| 正常私聊发任务 → 自动建群开工 | §3 状态机 + §6.4；无需用户补命令 |
| Agent 离线/邀请失败/权限不足 | S2 成员校验失败 → `failed` + 卡片原因；重试入口走 S0 重预检 |
| Profile 缺条目/应用失败/角色冲突 | §4.1 保存预检 + S4 运行时复检；冲突决策表（§5.2）不把默认角色当成功 |
| 角色就绪前群内新任务 | §7 gate，queue/reject 皆可见 |
| 重复消息/超时/创建结果未知 | §6.2 uuid 幂等 + 查证；不盲目重建 |
| 多步部分失败、daemon 重启 | §6.1 每步落盘 + §6.3 恢复从首个非 done 步骤继续 |
| 人工取消/改角色/撤授权 | 取消作废迟到回执（§6.3）；冲突不覆盖（§5.2）；重试前 S0 重预检（§6.3） |
| 重试窗口交叠、依赖未就绪不提前评审 | initId 并发锁（§6.3）；afterAgentTurn 可信信号（§6.4） |
| 多 bot 权限与额度 | §8 归属规则 |
| 未启用协作配置 | §9 缺省关闭，字节不变 |

## 11. 实施拆解（建议）

1. **PR-1 积木**：`createChat` uuid 参数（#3405 方向）；collab-init-store；配置模型 + 保存预检 + 页面区块（纯配置，无行为）。
2. **PR-2 编排**：Orchestrator S0–S4（含本地代写+回读协议、gate）；恢复/重试/取消；群内进度卡片。
3. **PR-3 分工启动**：S5（复用 #3518 积木）、afterAgentTurn 信号、排队投递。
4. 每期验证要求（issue 原则）：真实组件 + 可控网络/假时钟跑异常与并发序列——至少覆盖验收表 10 行各有对应用例；变异复验（拆掉 gate、拆掉回读校验、恢复时不跳过 done 步骤等，用例应变红）。

## 12. 已识别的开放问题

- `afterAgentTurn` 的「产出已投递」在多产物/长任务下粒度是否够用？若 Reviewer 需要等特定产物（如 PR 链接），可能需要 `outputContains` 匹配——首期不做，留到实测反馈。
- kickoff prompt 模板的 i18n 与默认值（Builder/Reviewer 只是示例角色，模板应通用化）。
- 群内进度卡片与现有 session 卡片的视觉共存（专属群首条卡片归属）需 UI 评审。
