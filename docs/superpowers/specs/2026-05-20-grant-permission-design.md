# 群内授权（`/grant` · `/revoke` · 授权卡片）设计

日期：2026-05-20
状态：待评审（Codex review）

## 背景与动机

botmux 的使用权限由每个 bot 的 `allowedUsers`（`bots.json` 中的字符串数组）控制：
启动时把 email 前缀解析成 `open_id` 写入内存 `resolvedAllowedUsers`，`canTalk` /
`canOperate` 两个闸门都查它。

**痛点**：要给新成员开权限，必须在启动前拿到对方的 `open_id`，而 `open_id` 无法
从 email 直接查到。于是「给别人加权限」非常不便。

**核心洞察**：飞书消息里只要出现 `@某人`，那条 mention 就**自带对方的 `open_id`**
（`message.mentions[].id.open_id`）。因此「在群里 @ 一下就能授权」天然绕开 email→open_id
的查询，这是本方案成立的根基。

## 目标

1. 新增 `/grant`（授权）、`/revoke`（撤销）两个群内命令，**仅 owner 可用**。
2. 支持两种授权范围：**授权本群**、**全局授权**。
3. 一张「授权卡片」，两种入口都弹它：
   - **入口 A（自助申请）**：无权限者 @机器人 时，不再静默/回「无操作权限」，而是自动弹卡片并 @owner。
   - **入口 B（owner 主动）**：owner 发 `/grant @张三`，弹同一张卡片，owner 直接点范围按钮。
4. 变更即时生效（同步内存），并持久化到 `bots.json`（重启保留）。

## 非目标

- 不做基于角色/分组的细粒度 RBAC，只有「本群」「全局」两档。
- 不引入 per-chat owner 列表；owner 始终等于 bot 的 `resolvedAllowedUsers[0]`（首个 `ou_`）。
- 不改动 oncall 的 chat 级开放语义；本方案是 per-user 授权，与 oncall 正交叠加。

## 术语：谁是 owner

owner = bot 的首个已授权用户，即 `resolvedAllowedUsers.find(u => u.startsWith('ou_'))`，
与现有「缺权限警告私信对象」（`bot-registry.ts:120`）同一口径。新增 `getOwnerOpenId(larkAppId)`
封装这一查询，全程复用。

**开放模式特例**：当 `allowedUsers` 为空时，现有语义是「所有人可用」。此时没有 owner，
也无需授权——`/grant` / `/revoke` 直接回一句「当前未设置 allowedUsers，所有人可用，无需授权」，
入口 A 的卡片也不触发。

## 数据模型

### 全局授权
复用现有机制：把 `open_id` 追加进 `bots.json` 对应 bot 条目的 `allowedUsers`（去重），
并同步追加到内存 `resolvedAllowedUsers`。

### 本群授权（新增）
`BotConfig` 新增字段：

```ts
/** Per-chat per-user grants: chat_id → 被授权的 open_id 列表。
 *  与全局 allowedUsers 正交：命中任一即放行。 */
chatGrants?: { [chatId: string]: string[] };
```

`BotState` 不新增字段——`chatGrants` 直接读 `bot.config.chatGrants`（与 oncall 的
`oncallChats` 一样走 in-memory config）。

### 闸门改动
`canTalk` 和 `canOperate` 各加一条放行规则（在现有 `allowedUsers` 检查之外）：

```ts
function hasChatGrant(larkAppId, chatId, openId): boolean {
  return !!chatId && !!openId &&
    !!getBot(larkAppId).config.chatGrants?.[chatId]?.includes(openId);
}
```

- `canTalk`：oncall 放行 → known peer bot 放行 → `allowedUsers` 命中 → **`chatGrants` 命中** → 否则拒。
- `canOperate`：`allowedUsers` 命中 → **`chatGrants` 命中** → 否则拒。

注意：开放模式（`allowedUsers` 为空）下两个闸门本就返回 `true`，`chatGrants` 不影响。

## 持久化层：`grant-store.ts`

镜像 `oncall-store.ts` 的并发安全写法（`withFileLock` + 原子 rename + 内存同步）。

**先做一个小重构**：把 `oncall-store.ts` 里私有的 `rmwBotEntry` / `readRawConfig` /
`writeRawConfigAtomic` / `findEntryIndex` / `requireConfigPath` 抽到共享模块
`src/services/config-store.ts`，`oncall-store.ts` 与新 `grant-store.ts` 都从它 import。
（纯提取，不改行为；让两个 store 共享同一把跨进程文件锁。）

`grant-store.ts` 暴露：

```ts
// 全局
addGlobalGrant(larkAppId, openId): Promise<{ok:true; created:boolean} | {ok:false; reason}>
removeGlobalGrant(larkAppId, openId): Promise<{ok:true; existed:boolean} | {ok:false; reason}>
// 本群
addChatGrant(larkAppId, chatId, openId): Promise<{ok:true; created:boolean} | {ok:false; reason}>
removeChatGrant(larkAppId, chatId, openId): Promise<{ok:true; existed:boolean} | {ok:false; reason}>
```

每个写函数：`rmwBotEntry` 改 `bots.json` → 成功后同步内存（`resolvedAllowedUsers` 或
`config.chatGrants`）→ `logger.info`。`removeGlobalGrant` 同时从 `allowedUsers` 和
`resolvedAllowedUsers` 删除。

**revoke 语义**：`/revoke @user` 做「彻底撤销」——同时调用 `removeChatGrant(本群)` 和
`removeGlobalGrant`，回执里说明实际移除了哪些范围（本群/全局/无）。理由：撤销应彻底切断，
不留半开状态；用户明确要的就是 `/revoke @xx` 这种一键收回。

## 命令层：`im/lark/grant-command.ts`

`/grant`、`/revoke` 是**元命令**，必须在 dispatcher 路由/spawn 之前拦截（与 `/introduce`
同款，`event-dispatcher.ts:782`），否则会被当成 prompt 喂给 CLI 会话。

新增 `tryHandleGrantCommand(larkAppId, message, senderOpenId, chatId, ...)`，在 introduce
拦截之后调用；命中 `/grant` 或 `/revoke` 则处理并返回 `true`（短路）。

### `/grant`
- 解析文本（容忍 `@_user_N` 占位符 → 从 `message.mentions` 取 `open_id`，与 message-parser 同款解析）。
- **owner 闸门**：`senderOpenId !== getOwnerOpenId(larkAppId)` → 回「仅 owner 可授权」。
- 无 mention（`/grant` 单发）→ 回用法提示。
- 有 mention（`/grant @张三`）→ 弹**授权卡片**（owner 发起态），owner 点范围按钮完成。
- （可选增强，先不做）`/grant @张三 here` / `/grant @张三 global` 直接授权跳过卡片。

### `/revoke`
- 同样 owner 闸门 + mention 解析。
- `/revoke @张三` → 调用彻底撤销，回执说明移除范围。直接执行，不弹卡片。
- 同时把该用户从入口 A 的「pending 节流表」里清掉（见下）。

### 命令注册
- `DAEMON_COMMANDS`（command-handler.ts:29）**不加** `/grant` `/revoke`——它们走 dispatcher 拦截，不进 command-handler 的 session 分支。
- 但需确保 dispatcher 的 `/grant` `/revoke` 拦截在「命中 daemon 命令」判断之前，避免误入 CLI。

## 授权卡片

复用 `card-builder.ts` 的卡片构造风格，新增 `buildGrantCard(...)`：

- 文案：「用户 @<申请人> 申请使用我，请 @<owner> 选择授权范围」（卡片正文 mention owner，
  保证 owner 收到红点）。
- 按钮三枚，`value` 各带 action + 上下文：
  - `[ 授权本群 ]` → `{ action: 'grant_chat', target_open_id, chat_id }`
  - `[ 全局授权 ]` → `{ action: 'grant_global', target_open_id, chat_id }`
  - `[ 拒绝 ]` → `{ action: 'grant_deny', target_open_id, chat_id }`
- 入口 A 与入口 B 用同一张卡，仅文案前缀略不同（「申请使用」vs「请选择对 @X 的授权范围」）。

### 卡片点击处理（card-handler.ts）

在 `handleCardAction` **靠前**处理这三个 action（在现有 session 解析逻辑之前），
因为它们不绑定 DaemonSession（无 `root_id`/`ds`）：

1. **owner 闸门（强）**：`operatorOpenId !== getOwnerOpenId(larkAppId)` → toast「仅 owner 可操作」，不改任何状态。
   注意：这里比现有 `isSensitive` 的 `allowedUsers` 闸门更严，必须等于 owner 本人。
2. `grant_chat` → `addChatGrant`；`grant_global` → `addGlobalGrant`；`grant_deny` → 不授权。
3. 三种都更新卡片为终态（「✅ 已授权本群 / ✅ 已全局授权 / 🚫 已拒绝」），按钮置灰/移除，避免重复点击。
4. 清理该 `(bot,chat,target)` 的 pending 节流记录。

## 入口 A：无权限者自助申请

改 `event-dispatcher.ts:884` 的 `access === 'not_allowed'` 分支（`!ownsSession` 时）：
原本回「⚠️ 无操作权限」，改为：

- 若**开放模式**（无 owner）→ 维持原逻辑（理论上开放模式不会进 not_allowed，但兜底保留）。
- 否则：发**授权卡片**（@owner，申请人 = `senderOpenId`），代替「无操作权限」文本。

### 节流（必须）
避免无权限者每发一句就刷一张卡。用**内存** Map：

```ts
key = `${larkAppId}:${chatId}:${requesterOpenId}`
```

- 已有 pending（卡片已发、owner 未处置）或在冷却窗口内（如 10 分钟）→ 静默不再发。
- owner 处置（授权/拒绝）或 `/revoke` → 清除该 key，允许将来再次申请。
- 仅内存（daemon 重启后重置可接受——重启后第一条会重新弹卡，符合直觉）。

## 模块清单

| 文件 | 改动 |
| --- | --- |
| `src/services/config-store.ts` | **新增**：从 oncall-store 提取的共享 rmw/锁/IO helper |
| `src/services/oncall-store.ts` | 改为 import 共享 helper（纯重构） |
| `src/services/grant-store.ts` | **新增**：add/removeGlobalGrant、add/removeChatGrant |
| `src/bot-registry.ts` | `BotConfig.chatGrants` 字段；`getOwnerOpenId()` |
| `src/im/lark/event-dispatcher.ts` | `canTalk`/`canOperate` 加 chatGrants 放行；not_allowed 分支改弹卡片 + 节流；引入 grant-command 拦截 |
| `src/im/lark/grant-command.ts` | **新增**：`tryHandleGrantCommand`（/grant、/revoke） |
| `src/im/lark/card-builder.ts` | **新增**：`buildGrantCard` |
| `src/im/lark/card-handler.ts` | 处理 `grant_chat`/`grant_global`/`grant_deny`，owner 强闸门 |
| `src/i18n/zh.ts` `en.ts` | 命令回执、卡片、toast 文案 |
| `src/core/command-handler.ts` `/help` | 文档里补 `/grant` `/revoke` 说明 |

## 测试要点

- `grant-store`：add/remove 全局与本群，去重、幂等、内存与 `bots.json` 同步、并发锁（与 oncall 测试同款）。
- 闸门：`chatGrants` 命中放行；跨 chat 不串；开放模式不受影响。
- 命令解析：`/grant @x`、`/revoke @x`、无 mention、非 owner 调用被拒。
- 卡片点击：非 owner 点击被拦（toast）；三种 action 终态正确；节流清除。
- 入口 A：not_allowed → 弹卡（@owner）；同人重复发不刷屏；revoke 后可再次申请。

## 待评审决策点（已与用户确认）

1. 命令名：`/grant` ✔
2. 谁能批准卡片：**仅 owner** ✔
3. 撤销：`/revoke @xx`（彻底撤销本群+全局）✔
