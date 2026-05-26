# `/grant` 支持授权机器人 — 设计

日期：2026-05-26
分支：`worktree-feat+grant-bot`

## 背景

botmux 的授权（`/grant`、`allowedUsers`、`chatGrants`）此前只对**真人**生效。外部机器人（非本机 daemon 注册的同伴 bot）消息走 `event-dispatcher` 里一条独立分支，不经过 `canTalk`/`allowedUsers`：

- self bot → 仅处理 `/close`
- foreign bot → 仅在 @ 本 bot 时路由
- **普通群/p2p 新建 chat-scope 会话 → 受 `isKnownPeerBot` 闸限制**（非 oncall 群）。外部 bot 不在 cross-ref 里，恒被 drop。
- oncall 群 → 任何 bot 放行

唯一阻止「授权某个外部 bot 在本群协作」的，就是上面那道 `isKnownPeerBot` 闸。

## 目标

让 owner 能用 `/grant @某bot` 授权一个外部 bot 在**本群**拉起 chat-scope 会话，语义与真人 `/grant` 完全对齐（仅本群、talk-only、全局仍走 bots.json 手配）。

## 方案

复用现有 `/grant` 全套机制，**零新存储字段**：

1. **核心逻辑改动（1 处）** — `src/im/lark/event-dispatcher.ts` 外部 bot 的 chat-scope 新会话闸：在 drop 条件里追加 `&& !hasChatGrant(larkAppId, chatId, senderOpenId)`。命中本群 `chatGrants` 的 bot 与已注册 peer 同等放行。`hasChatGrant` 已存在，直接复用。

2. **授权入口** — `/grant @bot`：
   - `parseGrantTarget` 已能选中 bot mention（只排除本 bot 自身），无需改逻辑，仅更新注释（"人类对象" → "人或 bot"）。
   - owner 发命令 → 弹现有授权卡 → owner 点「授权本群对话」→ `addChatGrant` 写入 `chatGrants[chatId]`（talk-only，不碰 `allowedUsers`/operate 权限）。

3. **撤销** — `/revoke @bot`：复用 `revokeGrant`，从 `chatGrants` 移除。无需改动。

4. **文案** — owner 发起路径用 `card.grant.body_owner`（"是否授权 **{name}** 在本群与我对话？"）与 `notify_*`（`{at}`），本就中性，对人对 bot 都通顺。`body_request`（"用户 {name}"）只用于真人自助申请卡，bot 永不触发，不改。

## 边界与不变量

- **仅本群**：`chatGrants` 是 per-chat，A 群授权不泄漏到 B 群。
- **仅 talk**：授权 bot 只能拉起/参与会话，拿不到 operate 权限（`/restart`、`/close`、终端写入仍限 `allowedUsers`）——与真人 chat-grant 一致。
- **仍需 @**：被授权 bot 仍须 @ 本 bot 才路由（`isBotMentioned` 闸不变）。
- **oncall 群无变化**：本就对任何 bot 放行，不经过这道闸。
- **owner 强闸门不变**：只有 owner 能 `/grant`、`/revoke`。

## 测试

`test/event-dispatcher.test.ts` 新增：

1. 外部未注册 bot @ 本 bot、命中本群 `chatGrants` → 路由到 `handleThreadReply`（chat-scope，auto-create）。
2. per-chat 隔离：在 chat-001 授权的 bot 到 chat-999 仍被 drop。

## 改动文件

- `src/im/lark/event-dispatcher.ts` — 闸加 `hasChatGrant` 放行 + 注释
- `src/im/lark/grant-command.ts` — `parseGrantTarget` 注释
- `test/event-dispatcher.test.ts` — `setupBotState` 支持 `chatGrants` + 2 个用例
