# botmux webhook `rootMessageId` 技术方案

## 1. 背景

当前 botmux webhook 支持通过 connector 将外部事件投递到指定 bot 的会话中，但只能通过 `chatId` 或 `sessionId` 定位：

- `chatId`：按群会话模式决定复用 chat-scope session，或在话题群 / new-topic 模式下新开一个话题。
- `sessionId`：显式复用某个已存在的 active session。

新增需求：外部 webhook 能指定 `rootMessageId`，让新会话或后续回复落到指定飞书消息线程下。

核心安全要求：

1. **归属校验**：`rootMessageId` 必须属于目标 `chatId`，不能跨群投递。
2. **会话语义**：如果该 root 下已有 botmux session，则复用当前会话。

## 2. 目标与边界

### 2.1 目标

- webhook turn target 支持 `rootMessageId`。
- 指定 `rootMessageId` 后：
  - 若该 root 下已有本 bot 的 session，复用该 session。
  - 若没有，则创建 thread-scope session，anchor 为该 `rootMessageId`。
  - 后续卡片、final output、`botmux send` 默认回复都落到该 root 线程下。
- 严格校验 `rootMessageId` 属于 `chatId`。

### 2.2 第一版边界

- 指定 `rootMessageId` 时必须同时指定 `chatId`。
- `sessionId` 的优先级仍高于 `rootMessageId`，保持现有显式复用语义。
- 不改变无 `rootMessageId` 的现有 webhook 行为。
- 不跨 bot 复用 session：同一 root 下不同 bot 仍按 `larkAppId` 隔离。

## 3. 现状分析

### 3.1 webhook 入口

文件：`src/dashboard/webhook-routes.ts`

当前能力：

- 动态解析 `chatId`：query/header/payload。
- 动态解析 `sessionId`：query/header/payload。
- 组装 `TriggerRequest` 后转发到目标 bot daemon 的 `/api/trigger`。

### 3.2 daemon 投递

文件：`src/core/trigger-session.ts`

当前能力：

- `target.sessionId`：按 sessionId 找 active session。
- `target.chatId`：按 chatId 复用或创建会话。
- 对话题群 / 普通群 `new-topic` 模式，会通过 `sendMessage` 新开一个 root，再创建 thread-scope session。

缺口：

- `TriggerRequest.target` 没有 `rootMessageId`。
- 无法把外部事件投递到已有指定 root。
- `ds` 存在但 `worker=null` 或 `worker.killed` 时，当前逻辑会落到新建路径，存在覆盖/重复创建风险。

### 3.3 session key

文件：`src/core/types.ts`

- thread-scope：`sessionAnchorId(ds) = session.rootMessageId`
- chat-scope：`sessionAnchorId(ds) = chatId`
- active key：`sessionKey(anchor, larkAppId)`

因此以 `rootMessageId` 作为 anchor 创建/复用 thread session，与现有路由模型一致。

## 4. 方案设计

## 4.1 协议扩展

文件：`src/services/trigger-types.ts`

在 `TriggerRequest.target` 增加字段：

```ts
rootMessageId?: string;
```

校验规则：

- `target.kind === 'turn'` 时，`chatId` / `sessionId` / `rootMessageId` 至少一个存在。
- `rootMessageId` 若存在必须是非空字符串。
- `rootMessageId` 若存在但 `chatId` 不存在，返回 `400 target_required`。

原因：第一版要求 root 与 chat 同时提供，避免绕过 `allowChats` 或无法做归属校验。

## 4.2 webhook 入参解析

文件：`src/dashboard/webhook-routes.ts`

新增 `dynamicRootMessageId(req, url, payload)`，解析优先级：

1. query：`?rootMessageId=om_xxx`
2. header：`x-botmux-root-message-id`
3. body：`rootMessageId`
4. body：`target.rootMessageId`

组装 `TriggerRequest.target` 时透传：

```ts
target: {
  kind: connector.target.kind,
  botId: connector.target.botId,
  ...(chatId ? { chatId } : {}),
  ...(sessionId ? { sessionId } : {}),
  ...(rootMessageId ? { rootMessageId } : {}),
}
```

`allowChats` 仍只基于 `chatId` 校验；由于 `rootMessageId` 必须同时带 `chatId`，不会绕过。

## 4.3 rootMessageId 归属校验

文件：`src/im/lark/client.ts`

新增：

```ts
export async function getMessageChatId(larkAppId: string, messageId: string): Promise<string | null>
```

实现：

- 复用现有 `getMessageDetail(larkAppId, messageId, { userCardContent: false })`。
- 兼容提取：
  - `detail.items?.[0]?.chat_id`
  - `detail.chat_id`
  - `detail.message?.chat_id`
- 异常、不可见、不存在、撤回均返回 `null`。

文件：`src/core/trigger-session.ts`

新增校验函数：

```ts
async function validateRootMessageTarget(larkAppId, chatId, rootMessageId)
```

规则：

1. `rootMessageId` 存在但 `chatId` 缺失：`target_required`
2. `getMessageChatId` 返回 `null`：`target_required`
3. 返回 chatId 与目标 chatId 不一致：`chat_not_allowed`
4. 校验通过后才允许按 root 创建/复用 session

该校验必须在 daemon 侧执行，使用目标 bot 自己的 Lark app token，不能信任 webhook payload。

## 4.4 会话定位优先级

文件：`src/core/trigger-session.ts`

优先级：

1. `sessionId`
2. `rootMessageId`
3. 现有 `chatId` 默认逻辑

### 4.4.1 `sessionId` 存在

沿用现有行为：

- 找 active session。
- 找不到返回 `session_not_found`。
- 找到则复用。

### 4.4.2 `rootMessageId` 存在

流程：

1. 要求 `chatId` 存在。
2. 校验 `rootMessageId` 属于 `chatId`。
3. `anchor = rootMessageId`，`scope = 'thread'`。
4. 查 `activeSessions.get(sessionKey(rootMessageId, larkAppId))`。
5. 若存在：复用该 session。
6. 若不存在：创建 thread-scope session。

创建 session 时：

```ts
const session = sessionStore.createSession(chatId, rootMessageId, triggerTitle(req), 'group');
session.scope = 'thread';
```

不调用 `sendMessage` 新开 topic。

### 4.4.3 没有 `rootMessageId`

保持现有逻辑：

- 普通群 chat/chat-topic/shared：复用 chat-scope session。
- 普通群 new-topic / 话题群：`sendMessage` 新开 topic。

## 4.5 已有 session 但 worker 不可用的复用

这是实现重点。

当前逻辑只有：

- `ds?.worker && !ds.worker.killed`：发送到 worker。
- 否则：创建新 session。

新增 `else if (ds)` 分支，处理：

- `worker === null`
- `worker.killed === true`

流程：

1. `markSessionActivity(ds)`
2. `ensureSessionWhiteboard(ds)`
3. `buildFollowUpContent(prompt, ds.session.sessionId, ...)`
4. `rememberLastCliInput(ds, prompt, content)`
5. `forkWorker(ds, content, triggerId 或 ds.hasHistory)`
6. 返回已有 `sessionId`

不同 response mode：

- `waitForFinalOutput`：先注册 wait promise，再 fork。
- `asyncReturnSessionId`：`beginAsyncTrigger` 后 fork。
- 普通投递：直接 fork。

关键约束：不调用 `sessionStore.createSession`，不覆盖 `activeSessions`。

## 5. 错误码约定

| 场景 | HTTP | errorCode |
| --- | --- | --- |
| rootMessageId 缺 chatId | 400 | target_required |
| rootMessageId 不可见 / 不存在 / 撤回 / 无法确认归属 | 400 | target_required |
| rootMessageId 属于另一个 chatId | 403 | chat_not_allowed |
| sessionId 指向不存在 active session | 404 | session_not_found |
| bot 不在 chat | 403 | bot_not_in_chat |

## 6. 测试计划

### 6.1 trigger-types / trigger-api

- `target.rootMessageId + target.chatId` 校验通过。
- `target.rootMessageId` 无 `target.chatId` 返回 `400 target_required`。
- 旧请求仅 `chatId` 或 `sessionId` 仍通过。

### 6.2 webhook-routes

- query/header/payload 三种来源能解析并透传 `rootMessageId`。
- `allowChats` 对 `chatId` 仍生效。
- fixed chatId + dynamic rootMessageId 能透传。

### 6.3 trigger-session

- root 属于 chat：创建 thread-scope session，anchor 为 root，不调用 `sendMessage`。
- root 属于其他 chat：返回 `chat_not_allowed`，不创建 session。
- root 不可见 / 已撤回：返回 `target_required`，不创建 session。
- root 下已有 live session：复用，不 createSession。
- root 下已有 worker=null session：复用并 refork，不 createSession。
- wait/async 模式在 existing worker=null 场景下仍返回 existing sessionId。

### 6.4 回归

- 无 rootMessageId 的原 webhook 行为不变。
- 普通群 chat-scope、新 topic 模式、话题群新开 topic 均保持。

执行：

```bash
pnpm test -- trigger-session webhook-routes trigger-api
pnpm build
```

## 7. 实现顺序

1. 扩展 `TriggerRequest` 类型与校验。
2. `webhook-routes` 增加 `rootMessageId` 动态解析与透传。
3. `client.ts` 增加 `getMessageChatId`。
4. `trigger-session.ts` 增加 root 校验和 root anchor 定位。
5. `trigger-session.ts` 补齐 `ds` 存在但 worker 不可用时的 refork 分支。
6. 补单测。
7. 跑测试和构建。
8. 交给 Codex 做代码 review。

## 8. 风险与应对

### 8.1 allowChats 绕过

风险：只给 `rootMessageId` 不给 `chatId` 时，webhook-routes 无法做 allowChats。

应对：第一版硬性要求 `rootMessageId` 必须同时带 `chatId`。

### 8.2 worker=null 时误新建 session

风险：已有 root session 但 worker 不可用时，误创建第二个 session。

应对：新增 `else if (ds)` refork/resume 分支。

### 8.3 rootMessageId 跨群投递

风险：外部伪造 root，导致消息投到其他群。

应对：daemon 侧用 bot 的 Lark app token 调 `message.get` 校验 chatId。

### 8.4 Lark message.get 不可用

风险：权限缺失、消息撤回、跨租户导致无法确认归属。

应对：默认拒绝投递，返回 `target_required`。

## 9. 最终结论

该方案是对现有 webhook turn target 的增量扩展，不破坏现有 `chatId` / `sessionId` 语义。关键安全点通过“`rootMessageId` 必须同时带 `chatId`”和 daemon 侧归属校验收敛；关键会话语义通过 root anchor 查找和 worker-null refork 分支保证不会重复创建 session。