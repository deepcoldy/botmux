# 全局对话授权（globalGrants）— 设计

日期：2026-05-26
分支：`feat/global-talk-grant`（基于已并入 master 的 `/grant @bot` 之后）

## 背景与动机

PR #46 确立了权限二分：`canTalk`（普通对话）可由 allowedUsers / allowedChatGroups / chatGrants / oncall / peer 任一放行；`canOperate`（/restart、/close、终端写入、卡片敏感按钮）**仅** allowedUsers。普通对话权绝不能膨胀成敏感操作权。

此前「全局对话授权」存在缺口：
- **人**：全局只有 allowedUsers，而它是 talk+operate 一体——没有「全局只给对话、不给 operate」的选项。
- **bot**：刚合并的 `/grant @bot` 写 chatGrants，仅本群；外部 bot 要全局协作没有入口（isKnownPeerBot 只认同机注册的 peer）。

本设计补上这个缺口：一个**全局 talk-only 授权名单**，人与 bot 统一，作用域全局，talk-only 性质不变。

## 方案

新增配置字段 `globalGrants: string[]`（open_id 列表，人/bot 通用），与 chatGrants 同源——只是作用域从本群升到全局。**canOperate 绝不读它**。

### 权限模型（在 PR #46 基础上扩展）

| 作用域 | 字段 | 被谁读 | 授什么 |
|---|---|---|---|
| 本群对话 | `chatGrants[chatId]` | canTalk（人）+ bot 路由闸 | talk |
| **全局对话** | **`globalGrants`** | **canTalk（人）+ bot 路由闸** | **talk** |
| 操作/owner | `allowedUsers` | canOperate | talk+operate |

### 改动点

1. **配置层** `bot-registry.ts`：BotConfig 加 `globalGrants?: string[]`；加载时校验为非空 string[]（逐项 `typeof==='string' && trim`），否则 undefined。
2. **canTalk** `event-dispatcher.ts`：命中 globalGrants → 任意群放行；并把 globalGrants 计入 `hasAllowlist`（只配 globalGrants 也算限制态，不 fall through 到全开放）。
3. **canOperate** `event-dispatcher.ts`：**只把 globalGrants 计入 hasAllowlist**（堵住「只配 globalGrants → operate fall through 到全开放」的洞，正是 PR #46 要防的），operate 命中**仍只认 allowedUsers**。
4. **bot 路由闸** `event-dispatcher.ts`：外部 bot chat-scope 新会话闸的 drop 条件追加 `&& !hasGlobalGrant(...)`——命中 globalGrants 的 bot 在任意群放行。
5. **grant-store** `grant-store.ts`：`addGlobalGrant(larkAppId, openId)`（写 globalGrants，绝不碰 allowedUsers）；`revokeGrant` 同一 RMW 内多删一支 globalGrants（result 加 `globalTalk`）。globalGrants 删空不触发 would_open_bot 守卫（talk-only，删空不放大 operate）。
6. **授权卡** `card-builder.ts`：owner 模式的卡片加「全局授权对话」按钮（action `grant_global`，`type:default`）；request 模式（成员自助申请）**不含**全局按钮，防成员自助申请全局。
7. **card-handler** `card-handler.ts`：处理 `grant_global` → owner 强闸门 + nonce → `addGlobalGrant` → 通知卡（kind=global）+ 撤回。
8. **i18n** zh/en：`card.grant.btn_global`、`cmd.revoke.scope_global_talk`；note 文案改成「本群或全局」。`result_global`/`notify_global` 复用既有键。
9. **README** zh/en：配置表加 `globalGrants` 行。

## 不变量 / 边界

- **talk-only**：globalGrants 永不进 canOperate 命中判定（敏感操作仍仅限 allowedUsers）——与 PR #46 严丝合缝。
- **人/bot 统一**：同一字段存 open_id，差异只在「谁读它」（人走 canTalk，bot 走路由闸），不在存储。
- **owner 强闸门**：`/grant` 命令与卡片回调都仅 owner；request 模式无全局按钮。
- **全局 operate** 仍走 bots.json 手配 allowedUsers，与本设计无关、未改动。
- **/revoke** 一次清 chatGrants + globalGrants + allowedUsers（三支，allowedUsers 一支保留 would_open 守卫）。

## 测试

- `test/bot-registry-grant.test.ts`：globalGrants 解析（过滤非字符串/空串）、缺省 undefined。
- `test/grant-store.test.ts`：addGlobalGrant 持久化+幂等+不碰 allowedUsers；revoke 移除 globalGrants-only 目标（不被 would_open 拦）、删空删键；既有 revoke 用例补 `globalTalk` 字段。
- `test/event-dispatcher.test.ts`：canTalk 全局放行/建立白名单；canOperate **不**授 operate、且不留全开放洞、allowedUsers 仍授 operate；bot 路由闸命中 globalGrants 在任意群放行。
- `test/card-handler-grant.test.ts`：owner grant_global 写 globalGrants（不碰 chatGrants/allowedUsers）+ 通知撤回；非 owner 被拦。
- `test/grant-card.test.ts`：owner 卡含 chat+global+deny 三按钮；request 卡无 global。

## 验证

`tsc --noEmit` 通过；非 e2e 单元全跑 2665 passed，唯一失败 `bridge-final-output-retry.test.ts`（已确认在 clean base 上同样失败，预存在、与本改动无关）。
