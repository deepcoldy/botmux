# 跨部署联邦协作设计（Federation）

> 目标：让**独立的多套 botmux 部署**（同一飞书租户、各自单 owner）组成一个共享协作团队——
> 互相发现对方的 bot + 能力，并最终把跨部署的 bot 拉进同一个飞书群协作。
>
> 三方共识（申晗 / Claude / Codex）。本文是 [[platform-design]] 的跨部署扩展。

## 前提（已确认）

1. **同一飞书租户**：`union_id` 跨部署稳定、不同部署的 bot 能进同一个飞书群、能互相 @。
2. **网络可达**：spoke 能通过 HTTP 访问 hub（公司内网）。方向以 **spoke → hub** 为主，spoke 不需要对外暴露端口。
3. **一套部署 = 一个 owner = 一个团队成员**。单 daemon 单 owner，不存在多人共操作同一 dashboard，因此**跨部署不需要 /pair**——每个人在自己的 dashboard 里本就是已认证的 owner（dashboard token 即代表他）。

## 核心洞察

真正的协作发生在**飞书群**里：不同部署的 bot 本就能共处一个飞书群，botmux 已支持多 bot @（observed-bots 交叉引用）。
所以「跨部署」要解决的只有两件事：

- **发现**：看到彼此的 bot + 能力（聚合花名册）
- **建群**：把跨部署选中的 bot 拉进同一个飞书群（唯一的跨部署「写」）

## 拓扑：Hub + Spoke，各用各的 dashboard

- 每个人的 dashboard 仍然**只管自己本机的 daemon/bot**（localhost IPC 代理不变）——不把任何人的 daemon 暴露给别人。
- **Hub** = 建队的那套部署，持有团队 / 成员 / 聚合花名册。
- **Spoke** = 用邀请码加入某个 hub 团队的部署。
- 团队相关的数据走 hub 的联邦 API；各方在**自己的 dashboard**「团队」板块里读写。

```
  申晗 dashboard ──(本机IPC)── 申晗的 daemon/bot
       │
       │  /api/federation/*  (注册/同步/拉聚合花名册)
       ▼
  ┌─────────── Hub（申晗这套）持有 team + 联邦 bot ───────────┐
       ▲
       │  /api/federation/*  (spoke 主动 → hub)
       │
  别人 dashboard ──(本机IPC)── 别人的 daemon/bot
```

## 身份与信任

- **部署身份**：每套部署生成一次性 `deploymentId`（`{dataDir}/deployment-identity.json`，uuid）+ 一个可读 `name`（owner 自己填，默认机器名/owner 名）。
- **加入凭证**：复用现有**邀请码**（[[invite-store]]，单次/24h）。spoke 用邀请码向 hub 注册一次，hub 换发一个**长期 `syncToken`**（每 spoke 一个）用于后续同步/拉花名册。
- **信任边界仍是「团队」**：团队内互信，不做逐操作鉴权。邀请码=部署级准入；syncToken=该 spoke 的持续凭证。

## 数据模型

### Hub 侧：`federation-store.ts` → `{dataDir}/federations.json`
按 teamId 存已加入的远端部署：
```ts
interface FederatedDeployment {
  deploymentId: string;
  name: string;            // 展示用（owner/部署名）
  syncToken: string;       // 该 spoke 的持续凭证（高熵，不外泄）
  bots: FederatedBot[];    // 最近一次同步推上来的 bot
  joinedAt: number;
  lastSeenAt: number;      // 心跳
}
interface FederatedBot {
  larkAppId: string; botName: string; cliId: string;
  botUnionId?: string;     // 租户稳定，P2 拉群按此加 bot
  capability?: string; hasTeamRole?: boolean;
}
```

### Spoke 侧：`federation-membership-store.ts` → `{dataDir}/federation-memberships.json`
本部署加入了哪些远端团队：
```ts
interface RemoteMembership {
  hubUrl: string; teamId: string; teamName: string;
  syncToken: string; deploymentId: string; joinedAt: number;
}
```

## API

### Hub 侧（挂在 dashboard，**在 token 网关之前**，跨部署可达；用邀请码/syncToken 自鉴权）
- `POST /api/federation/join` — `{ inviteCode, deployment:{deploymentId,name,bots[]} }`
  → 校验并消费邀请码（→teamId）；**新**部署 → 换发 `syncToken`，回 `{ ok, teamId, teamName, syncToken }`。
  ⚠️ `deploymentId` 是公开的（进 roster），所以**重复 deploymentId 不回吐已有 token、也不覆盖记录**，回 `409 deployment_already_joined`；重绑/轮转留待后续显式 reset（凭旧 syncToken）。
- `POST /api/federation/sync` — `{ syncToken, bots[] }` → 刷新该部署 bot + `lastSeenAt`；回 `{ ok }`。
- `GET /api/federation/roster` — **syncToken 走 `Authorization: Bearer <token>` 头**（不进 URL，避免落 access/proxy log）；Hub 短期兼容 `?syncToken=` 查询作 fallback。回聚合花名册（hub 本地 bot + 各 spoke 的 bot，按部署分组）。
- `POST /api/federation/leave` — `{ syncToken }`（或 Bearer 头）→ 删除该部署（`removeDeploymentByToken`），spoke 主动退出/撤销时调用。幂等。

所有出站调用（spoke→hub）统一 `fetchWithTimeout`（AbortController，8s），错误面稳定区分 `hub_timeout`(504) / `hub_unreachable`(502)。

### Spoke 侧（挂在 dashboard，**dashboard token 鉴权**，owner 操作）
- `POST /api/team/join-remote` — `{ hubUrl, inviteCode }`
  → 收集本机 bot（bots-info + 能力 + 尽力解析 botUnionId）→ 调 `hubUrl/api/federation/join` → 存 `RemoteMembership` → 回结果（hub 拒绝时透出 409 `deployment_already_joined` / 403 invite 错 / 504 `hub_timeout` / 502 `hub_unreachable`）。
- `GET /api/team/remote-roster` → 对每个已加入的 hub 拉 `/api/federation/roster`（Bearer 头带 syncToken），汇总展示。
- `POST /api/team/sync-remote` → 手动触发向各 hub 推 bot+心跳。
- `POST /api/team/leave-remote` — `{ hubUrl, teamId }` → 先 best-effort 调 hub `/api/federation/leave` 撤销（回 `hubRevoked`），再忘掉本地 `RemoteMembership`。
- 周期同步：dashboard 进程内 timer（2min）向各 hub `POST /api/federation/sync` 推 bot + 心跳。

## 聚合花名册

Hub 的团队花名册 = 本地 bot（[[team-roster]]，按 bots.json 顺序）+ 各 spoke 的 `FederatedBot`，
每条带 `deployment: { id, name, local, stale }`，按部署分组展示（本地置顶，远端按 name）。
远端部署超过 `FEDERATION_STALE_MS`（5min）未同步即标 `stale`（疑似离线）——不硬隐藏，留 UI 降级展示。
`AggregatedRosterBot` 保留 `botUnionId?`（P2 拉群按 union_id 加 bot 时免改接口）。

## 拉群（跨部署，P2 — 已实现）

**关键事实**：飞书加 bot 进群用的是 **app_id**（`im/v1/chats` 的 `bot_id_list`、`im/v1/chats/:id/members` 的 `member_id_type=app_id`），**不是 union_id**。
而 botmux 每个 bot 本就是独立飞书 app，现有 `/group` 早已在「同一个群里加多个不同 app 的 bot」——「跨 app 加 bot」在本部署已验证可用。**联邦 bot 也是同租户的另一个 app，加法完全相同。**（早先 union_id 的顾虑是误解，已纠正。）

所以 P2 直接**复用现有建群链路**，无需新机制、无需 spike：
- Hub 的建群由它**自己某个在线本地 bot** 当 creator（创建 chat 必须本机 daemon 发起）。
- 选中的 bot（本地 + 联邦）全部按 **larkAppId** 进 `bot_id_list`；联邦 bot 由 Feishu 按 app_id 加入，加不上的进 `invalid_bot_id_list`。
- 联邦 bot 被加进群后，它**自己部署的 daemon**（订阅了该 app 事件）自动感知该群并参与——Hub 不碰对方 daemon。
- 校验：选中 app_id 必须都在**聚合花名册**里；至少一个本地在线 bot 作 creator（否则 `no_online_daemon`）。

实现：`POST /api/team/federated-group {name, larkAppIds}`（dashboard token），校验聚合花名册后复用 `createTeamGroup`（pickCreator 只从本地在线 bot 里选，联邦 bot 自然只作被加成员）。

### creator 不限本部署：hub→spoke 委托建群
建群必须由「持有该 bot app 凭证」的进程发起，所以 creator 必须是**某部署的本地在线 bot**。为不强制「发起方必须有本地在线 bot」：
- 优先用**本地**在线 bot 建群；
- 本地无在线 creator（`no_online_daemon`）→ **委托**给一个「拥有所选 bot、且可达」的联邦部署：hub→spoke `POST {callbackUrl}/api/federation/delegate-group`，对方用自己的在线 bot 建群、加全部 app_id + owners，回 chatId/shareLink（结果带 `delegatedTo`）。都不行 → `no_creator_available`。
- **互信凭证**：spoke join 时给 hub `callbackUrl`（自己 dashboard 地址）+ `delegationToken`（spoke 生成）；hub 存 FederatedDeployment、spoke 存 RemoteMembership。delegate 调用带 `Authorization: Bearer <delegationToken>`，spoke 用 `findMembershipByDelegationToken` 校验「确是我 join 过的 hub」（团队内互信）。
- **命令通道护栏**（delegate-group 是有副作用的 pre-auth 端点）：
  - **幂等**：hub 每次 federated-group 生成一个 `requestId` 传给每个 delegate；spoke 按 `delegationToken+requestId` 短 TTL 缓存结果，重放/重试返回同一结果，不重复建群。
  - hub **超时不试下一个**：delegate 超时＝对方可能已建群（响应丢失），hub 停止、回 `delegation_timeout`，不再委托别的部署（否则重复群）；仅在「拿到响应的明确失败」或「连接被拒（从未到达）」时才试下一个。
  - spoke 侧 delegate 校验：必须含 ≥1 个**本部署本地 bot**（否则与本部署无关→`no_local_bot`）；`larkAppIds`/`ownerUnionIds` 去重 + 上限（200/100，超出 400）。

### owner 一并拉群（按 union_id）
拉群把**所选 bot 的 owner（人）**也拉进群：聚合花名册带 owner（本地查 bot-owner-store、远端由联邦同步的 `ownerUnionId/ownerName`）；建群后用 **union_id**（租户稳定、跨 app 通用，避开 open_id app-scope）加 owners（`addUsersToChatByUnionId`，`member_id_type=union_id`），加不上的回 `invalidOwnerUnionIds`。

## 分期

- **P1**：联邦基础——部署身份 + 邀请注册 + 同步/心跳 + 聚合花名册 + spoke 加入/拉花名册 API。让大家「看到彼此的 bot」。
- **P2**：跨部署拉群——复用现有 createChat 按 app_id 加联邦 bot（见上，已实现）。
- **P3**：跨部署共享 connector / 团队角色（按需）。

## 与现有代码的关系

- 复用：`invite-store`（邀请码）、`team-store`（团队/teamId）、`team-roster`（本地花名册）、`bot-profile-store`（能力）。
- 新增：`deployment-identity`、`federation-store`（hub）、`federation-membership-store`（spoke）、`dashboard/federation-api`（hub 端点）、`dashboard/team-routes` 增 spoke 端点。
- `/pair` + 单部署多用户那条线在联邦模型下非主路径；本次不删除，后续按需退役。

---

# v2 设计：对称花名册 + 操作者身份拉群（待评审 → 实现）

申晗实测暴露三问，本节是修复方案（先 Codex review 设计，再实现）：
- #1 spoke 看不到 hub 的机器人、不能操作它们拉群（当前 hub-centric、不对称）
- #2 「我的 bot + 对方 bot 一起拉群」：对方 **bot 进群了、人没进**（→ app_id 加 bot 是 OK 的；问题是 owner 没被邀请）
- #3 「只拉对方 bot」：对方和我（操作者）都没进群（→ 联邦丢了 /pair 身份，系统不知道 owner / 操作者是谁）

## A. 对称花名册（#1）

**目标**：一个团队对所有成员呈现**同一份聚合花名册**，任一成员都能勾选任意成员的机器人发起拉群。

**现状**：聚合只在 hub。hub 的 `/api/team/local` 是全量；spoke 的 `/api/team/local` 只有「自己本地 + 加入了自己 hub 的 spoke」，它加入的那个 team 的全量在 `/api/team/remote-roster`（只读、埋在另一区）。

**改法**：
- spoke 的「团队」页：当本部署**已加入某个远端团队**时，主花名册显示**该远端团队的聚合花名册**（继续用 remote-roster 从 hub 拉），与 hub 端体验一致（分组/折叠/搜索/筛选）。本部署既是某些人的 hub、又是别人的 spoke 时，分别展示（「我建的团队」+「我加入的团队」），**不合并成一张大列表**；每个团队的操作绑定明确的 `{hubUrl, teamId}`。
- **可编辑性判断（Codex #4）**：hub 返回的聚合花名册里 `deployment.local` 是「**hub** 本地」，不是「**当前浏览者** 本地」。UI 判断哪些 bot 可编辑能力/角色，必须比较 `bot.deployment.id === 本部署 deploymentId`（用 `/api/team/local` 带出的本部署 id），**不能看 `local` flag**。联邦 bot 只读。
- **从 spoke 发起拉群**：新增 hub 端点 `POST /api/federation/group`（spoke 凭 `syncToken` 调用），body=`{name, larkAppIds, requestId}`；hub 校验 syncToken→该 team 成员，再走与 hub 自身 `federated-group` 相同的编排（本地有在线 bot 就本地建、否则委托）。spoke 端 `POST /api/team/remote-group {hubUrl, teamId, name, larkAppIds}` 转调之。
  - **鉴权/护栏（Codex #1 + 回答）**：**只接受 `Authorization: Bearer <syncToken>`**（不继承 query token fallback）；`larkAppIds` 必须是该 team 聚合花名册子集、去重 + 上限；**`requestId` 必填 + 幂等**——hub 按 `syncToken + requestId` 短 TTL 缓存编排结果，重放同 requestId 返回同一结果、不再编排第二次（语义同 delegate-group）。

## B. 操作者身份 + 拉群邀请人（#2 / #3）

**根因**：联邦改 dashboard token 后没有「操作者是谁」的飞书身份；owner 也常未记录（bot-owner-store 空）→ 拉群的 ownerUnionIds 取不到 → 人不进群。

**B1 绑定部署 owner 的飞书身份（复用 /pair）**：
- 团队页加「绑定我的飞书身份」：`POST /api/team/identity/start`(dashboard token)→ 复用 `pairing-store` 出码；owner 在飞书给**本部署任一 bot** 发 `/pair <码>`；`POST /api/team/identity/consume` 拿到 claimedBy 的 `unionId/name`。
- 存：`deployment-identity` 增 `ownerUnionId/ownerName`（本部署 owner=操作者）。
- **身份要随联邦上行（Codex #2，必须）**：`ownerUnionId/ownerName` 要进 join/sync 的 deployment payload + hub 侧 `FederatedDeployment` 存储。这样 hub 能从 `syncToken → FederatedDeployment → ownerUnionId` **可信推导**发起方是谁（不靠间接的「本部署 bot owner 都同步上来」）。
- **归属用 no-steal（Codex #3）**：绑定时把本部署 bot 归属到该 owner，**只填未归属的 bot**，已有 owner 的保持不动（不洗掉手工归属）；要覆盖走显式「归到我名下」。

**B2 拉群邀请人**：`createTeamGroup` / `federated-group` / `federation/group` / delegate-group 统一：
- 邀请集合（union_id 去重）= **操作者本人** + **所选每个 bot 的 owner**（本地查 bot-owner-store、联邦取 FederatedBot.ownerUnionId）。
- **操作者 union_id 必须由 hub 从认证推导**（Codex #2）：本地发起→本部署 deployment-identity.ownerUnionId；spoke 发起→hub 从 `syncToken → FederatedDeployment.ownerUnionId`。**不信任请求体传入的 operatorUnionId**；委托建群时 hub 把推导出的 operatorUnionId 作 trusted assertion 传给被委托方一起 `addUsersToChatByUnionId`。
- 仍用 union_id 加人（租户稳定、跨 app）。

**效果**：#2 对方 owner（绑定后有 union_id）被邀请进群；#3 操作者本人 + 对方 owner 都进群。

## 风险 / 待确认
- 跨 app 加 bot 已验证可行（#2 实测 bot 进群）；加人按 union_id 亦为现有路径。
- **未绑定身份降级（Codex 回答）**：未绑定的部署拉群仍可建群+加 bot，但邀请不到「未知 owner」的人。响应/界面**显式标出** `missingOperatorIdentity`（发起方未绑定）+ 哪些 bot 的 owner 未知，避免用户误以为「人应进群却失败」。
- spoke 发起拉群需 hub 在线可达（同 P2 委托的可达前提）。
