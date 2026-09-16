---
title: 私密回复审核发布
type: design
date: 2026-09-08
topic: private-reply-review
status: draft
references:
  - 飞书开放平台：发送仅特定人可见的消息卡片
  - 飞书开放平台：删除仅特定人可见的消息卡片
  - src/im/lark/client.ts#sendEphemeralCard
  - src/core/worker-pool.ts#deliverFinalOutput
  - src/cli.ts#cmdSend
---

# 私密回复审核发布

## 1. 背景

botmux 当前最终回复默认直接发到飞书会话中：模型主动调用 `botmux send`
时由 CLI 侧发送；模型没有显式发送时，daemon 从 worker 的 `final_output`
兜底转成飞书回复卡片。这个行为适合协作群，但在以下场景风险偏高：

- 回复中可能包含未经确认的结论、内部路径、排障细节或误判，需要提问者先看一眼。
- 群里有人只需要最终可确认结论，不需要看到中间版本。
- 需要把「先私密预览，确认后公开」做成产品能力，而不是要求模型自己记住不要发群。

飞书开放平台提供「仅特定人可见的消息卡片」接口：

- `POST /open-apis/ephemeral/v1/send`
- `POST /open-apis/ephemeral/v1/delete`

仓库已有封装 `sendEphemeralCard` / `deleteEphemeralCard`。临时卡片只适合作为
审核态载体，不能 PATCH 成公开消息；确认公开必须重新发送一条普通飞书消息。

## 2. User Story

主要应用场景是 oncall 群。用户在 oncall 群里 @ botmux bot 提问或触发排障任务时，
bot 可以先执行分析，但不能把大段中间思考过程、噪声日志摘要、未确认的推断或错误结论直接刷到群里，
以免影响求助用户和旁观成员的体验。值班人需要先收到一张仅自己可见的审核卡，确认内容准确、表达合适、
不包含不该公开的信息后，再点击按钮把最终答复发布到原群或原话题。

典型流程：

1. oncall 用户在群里描述问题并 @ 对应 bot。
2. botmux 启动或复用会话，agent 完成排查并产出最终回复。
3. 最终回复不会立即公开，而是先以「仅特定人可见」审核卡发送给本轮值班人或配置指定的审核人。
4. 值班人确认回复正确后点击「公开到群里」，群成员才看到最终答复。
5. 如果值班人认为结论错误、内容过长或包含敏感信息，可以点击「丢弃」，再追问 agent 或人工回复。

验收口径：

- 群成员在确认前看不到 agent 的最终回复正文。
- 值班人确认后，公开消息落在原会话语境中：普通群回原群，话题群回原话题。
- 错误结论被丢弃时，不在群里留下可见痕迹。
- 这个能力必须按 bot 单独开启；一个 oncall bot 开启不影响其它协作 bot 的默认公开回复体验。
- 配置入口放在 Dashboard 的「消息卡片 -> 任务卡片」区域，和任务执行状态卡片、手动私有快照等卡片行为放在同一上下文里。

## 3. 目标

新增一个 bot 维度的回复审核能力：

1. 当配置开启时，botmux 的最终回复先发送为「仅特定人可见」的审核卡片。
2. 审核卡片带「公开到群里」和「丢弃」按钮。
3. 被授权用户点击「公开到群里」后，botmux 在原会话落点发送一条全员可见的普通消息。
4. 公开成功或丢弃后，best-effort 删除临时卡片。
5. 重复点击、长连接重投、daemon 重启后的重试不得导致重复公开。

第一版只覆盖「最终回复」。流式状态卡、思考过程消息、终端快照等过程输出不纳入本能力。
如果用户要求全过程私密，应同时关闭公开流式卡，或另行设计不能依赖 PATCH 的私有进度体验。

## 4. 非目标

- 不把临时卡片原地变成公开卡片。飞书临时卡片没有公开化语义，也不能按普通消息 PATCH。
- 不改变 `privateCard` 的语义。`privateCard` 仍只控制手动 `/card` 的私有快照。
- 不让模型决定谁能审核。审核对象由 daemon 根据本轮发送者、owner 和配置解析。
- 不覆盖 doc comment、HTTP virtual、apiOnly、VC meeting managed delivery 等非普通飞书会话落点。
- 不为临时卡片做持续流式更新。ephemeral 卡片不能 PATCH，强行模拟会带来刷屏和乱序。

## 5. 配置

配置落在 bot 维度，建议字段名为 `privateReplyReview`：

```json
{
  "privateReplyReview": {
    "enabled": false,
    "audience": "requester",
    "fallback": "dm",
    "expireHours": 24
  }
}
```

字段含义：

| 字段 | 类型 | 缺省 | 含义 |
|---|---|---|---|
| `enabled` | boolean | `false` | 是否开启最终回复审核发布 |
| `audience` | `'requester' \| 'owners' \| 'allowedUsers'` | `'requester'` | 私密审核卡片接收者 |
| `fallback` | `'dm' \| 'public' \| 'drop'` | `'dm'` | ephemeral 不可用时的降级策略 |
| `expireHours` | number | `24` | 审核记录过期时间，建议限制在 1 到 168 小时 |

受众解析规则：

- `requester`：优先取本轮触发者 `open_id`；缺失时回退到 owner/allowedUsers 中的 `ou_`。
- `owners`：只发给 owner / co-owner，对应已解析的 `ou_`。
- `allowedUsers`：发给 bot 的 `resolvedAllowedUsers` 中所有 `ou_`。

`audience` 为空时不进入私密审核：按 `fallback` 执行。默认 `fallback=dm` 仍然需要至少
一个可投递的审核对象，否则应该 fail closed 并记录日志，避免意外公开。

Dashboard 入口放在单个 bot 的配置页：

```text
Bot Defaults -> 消息卡片 -> 任务卡片 -> 最终回复审核发布
```

这是 by bot 开关，不提供全局默认开关。oncall bot 可以开启审核发布，普通协作 bot 继续保持
现有直接公开回复行为。

## 6. 数据模型

新增持久化 store：

```text
~/.botmux/data/private-reply-publications/<larkAppId>/<publishId>.json
```

记录结构：

```ts
interface PrivateReplyPublication {
  schemaVersion: 1;
  publishId: string;
  nonceHash: string;
  larkAppId: string;
  chatId: string;
  sessionId: string;
  turnId?: string;
  placement:
    | { mode: 'plain'; chatId: string }
    | { mode: 'reply'; rootMessageId: string; replyInThread: false }
    | { mode: 'thread'; rootMessageId: string; replyInThread: true };
  msgType: 'interactive' | 'post' | 'text';
  content: string;
  audienceOpenIds: string[];
  ephemeralMessageIds: string[];
  publicUuid: string;
  publicMessageId?: string;
  state: 'pending' | 'published' | 'discarded' | 'expired';
  createdAt: number;
  expiresAt: number;
  publishedAt?: number;
  publishedByOpenId?: string;
}
```

约束：

- `content` 是待公开的最终消息内容。普通最终回复建议继续使用 interactive card JSON。
- `nonceHash` 存 hash，不存明文 nonce。按钮 payload 带明文 nonce，点击时 hash 后比较。
- `publicUuid` 使用稳定值，例如 `pr_${sha256(publishId).slice(0, 47)}`，用于飞书普通消息发送幂等。
- store 写入使用 `tmp + rename` 或现有原子写工具；publish/discard 必须用文件锁或 compare-and-set。
- record 里不存 reviewer 姓名、群成员真名或 prompt 原文之外的额外敏感身份说明。

按钮 value 只带不可直接复原正文的短字段：

```json
{
  "action": "private_reply_publish",
  "publish_id": "prv_xxx",
  "nonce": "..."
}
```

`action.value` 是不可信输入，操作者身份只能来自飞书回调 envelope 的 `operator.open_id` /
`operator.union_id`。

## 7. 发送流程

最终回复进入发送前，先调用统一的 staging 函数：

```ts
stagePrivateReplyForReview(input): Promise<
  | { staged: true; publishId: string; privateMessageIds: string[] }
  | { staged: false; reason: 'disabled' | 'unsupported' | 'no_audience' | 'delivery_failed' }
>
```

输入应包含：

- `larkAppId`
- `chatId`
- `sessionId`
- `turnId`
- 原始公开落点 `placement`
- `msgType`
- `content`
- 本轮触发者 `requesterOpenId`
- 幂等种子

执行步骤：

1. 读取 bot 当前配置，未开启则返回 `disabled`。
2. 排除非普通飞书会话、apiOnly、HTTP virtual、doc-native、VC managed delivery 等不支持场景。
3. 解析审核受众，生成 `publishId`、nonce、`publicUuid`。
4. 先持久化 pending record，再发送临时审核卡。
5. 在原 reply card 底部追加审核按钮，不改正文渲染。
6. 对普通群优先调用 `sendEphemeralCard(larkAppId, chatId, openId, cardJson)`。
7. 对话题群、p2p 或 ephemeral 失败，根据 `fallback` 处理：
   - `dm`：调用 `sendUserMessage(..., 'interactive')` 私信审核卡。
   - `public`：返回 `staged:false`，调用方继续原公开发送。
   - `drop`：记录失败，调用方不公开。
8. 至少一个私密审核卡发送成功后，本轮视为已交付审核，不再继续公开发送。

临时审核卡发送成功但后续删除失败只算清理失败，不影响公开结果。

## 8. 确认公开流程

在 Lark card action handler 增加两个内置 action：

- `private_reply_publish`
- `private_reply_discard`

`private_reply_publish`：

1. 从 `action.value` 读取 `publish_id` 和 `nonce`。
2. 读取 record，校验 `state === 'pending'`、未过期、nonce 匹配。
3. 校验 `operator.open_id` 属于 `audienceOpenIds`，或仍是当前 bot 的 owner/allowed user。
4. 原子 claim 该 record，进入 publishing 状态或直接在锁内标记本次处理拥有发布权。
5. 根据 `placement` 调用普通公开发送：
   - `plain`：`sendMessage(larkAppId, chatId, content, msgType, publicUuid)`
   - `reply`：`replyMessage(larkAppId, rootMessageId, content, msgType, false, publicUuid)`
   - `thread`：`replyMessage(larkAppId, rootMessageId, content, msgType, true, publicUuid)`
6. 公开发送成功后写回 `state='published'`、`publicMessageId`、`publishedByOpenId`。
7. best-effort 删除所有 `ephemeralMessageIds`。
8. 返回成功 toast；若飞书同步 ACK 已超时，则记录日志即可，不再补发额外公开说明。

重复点击时：

- record 已 `published` 且有 `publicMessageId`：返回“已公开”，不再发送。
- record 已 `discarded`：返回“已丢弃”。
- record 已过期：标记 `expired`，返回“审核已过期”。

`private_reply_discard`：

1. 进行同样的 record、nonce、操作者校验。
2. 原子写 `state='discarded'`。
3. best-effort 删除临时卡片。
4. 不发送公开消息。

## 9. 接入点

### 9.1 `botmux send`

`cmdSend` 当前在解析会话、构建消息内容和确定 placement 后，直接调用
`sendMessage` / `replyMessage`。新增逻辑应插在普通飞书发送之前：

```ts
const staged = await stagePrivateReplyForReview(...);
if (staged.staged) {
  appendTurnSendMarker(...);
  printSuccess(...);
  return;
}
```

注意：

- staging 成功必须继续写 turn-sends marker。否则 worker 的 transcript fallback 会认为本轮未发送，
  再把同一内容走 daemon 兜底公开。
- sandbox relay 模式应由 host 侧执行 staging，沙盒内 CLI 不直接持有飞书副作用。
- custom card、reply layout、图片上传后的 interactive card 都应保持原内容，只在外层追加审核按钮。

### 9.2 `final_output` 兜底

`deliverFinalOutput` 在构建 `cardJson` 并计算 `canonicalOutput` 后、调用 `scopedReply`
前进入 staging。staging 成功后：

- 设置 `ds.lastBridgeEmittedUuid = finalOutputDedupeKey(ds, msg)`。
- 执行需要的 feedback 持久化时，状态应记录为 `pending_review` 或新增等价状态，不能伪装成已公开。
- 调用 `onComplete(true)`，避免会话生命周期卡在等待人工确认。

如果 staging 失败且配置 `fallback=public`，保持现有 `scopedReply` 路径。

### 9.3 card-handler

`card-handler` 已集中处理飞书卡片回调，并明确操作者身份信任边界。新增 action 应作为
botmux 内置 action 处理，优先于 plugin card action gateway，避免插件抢占发布按钮。

### 9.4 Dashboard

在单个 bot 的 Bot Defaults「消息卡片 -> 任务卡片」区域新增「最终回复审核发布」配置：

- 开关：开启 / 关闭。
- 审核对象：提问者 / owner / allowedUsers。
- 临时卡片不可用时：私信审核 / 直接公开 / 丢弃。
- 过期时间：数字输入，默认 24 小时。

文案必须说明：

- 该能力按 bot 开启，适合 oncall bot；不会影响其它 bot。
- 这只控制最终回复；如果运行过程卡片仍开启，过程信息仍可能在群里可见。
- 如需 oncall 群里完全不展示中间过程，应同时关闭「任务执行时显示状态卡片」。

## 10. 影响范围

### 跨平台

主要改动是本地 JSON store 和飞书 OpenAPI 调用，不依赖 macOS/Linux 专属能力。文件锁和原子写必须沿用仓库现有工具，避免 Windows 原生后端或 Bun 单文件二进制下路径异常。

### 跨 CLI

能力挂在 `botmux send` 和 daemon `final_output` 两个公共发送出口，对所有 CLI 生效。不能只在某个适配器里做，否则模型显式发送和 daemon 兜底发送会表现不一致。

### 跨后端 / 会话类型

- `PtyBackend` / `TmuxBackend` 普通飞书会话都应支持。
- chat-scope 普通群支持群内 ephemeral 审核。
- thread-scope / 话题群默认走 DM 审核，确认后回原 thread。
- p2p 默认不进入审核，或按配置仅 DM 自己；不应改变现有单聊体验。
- adopt/restore-adopt 只要最终回复经过 `botmux send` 或 `final_output`，就走同一策略。
- VC meeting managed delivery、doc comment、HTTP wait/async sink 暂不接入。

### 隐私与权限

- 私密卡片的正文只发给审核受众；按钮 payload 不携带正文。
- 公开动作只能由飞书 verified operator 执行。
- 非审核受众即使拿到 payload，也不能公开。
- 公开使用普通消息重新发送，因此会产生正常群通知和历史记录。
- 删除临时卡片失败不影响已经公开的事实，只记录 debug/warn。

## 11. 测试计划

单测：

- 配置关闭时，`botmux send` 和 `final_output` 保持原发送路径。
- 普通群 staging 成功时，只调用 `sendEphemeralCard`，不调用普通公开发送。
- 话题落点 ephemeral 不可用且 `fallback=dm` 时，调用 `sendUserMessage`，确认后仍 reply 到原 root。
- `private_reply_publish` 重复点击只公开一次。
- 非 audience 用户点击 publish/discard 返回拒绝。
- nonce 错误、record 过期、record 缺失均 fail closed。
- staging 成功后写 turn-sends marker，daemon 兜底不会重复公开。
- 开启该配置的 bot 进入审核发布流程，未开启的 bot 保持原公开回复。
- Dashboard 配置只在当前 bot 生效，不影响其它 bot。

集成或 mocked Lark API：

- `sendEphemeralCard` 成功返回 message_id 后，record 记录临时消息 id。
- 公开确认使用稳定 `uuid`，模拟网络重试不会产生两条公开消息。
- 删除 ephemeral 失败不影响 publish 成功。

手工验证：

```bash
bun run build
bun run daemon:restart
```

在普通群中验证：

- 提问者能看到「仅对你可见」审核卡片。
- 群内其他成员看不到审核卡片。
- 点击「公开到群里」后群里出现最终回复。
- 再次点击不会重复公开。

在话题群中验证：

- 审核卡片通过 DM 送达。
- 点击公开后回复落回原话题。

Dashboard 验证：

- 入口位于单个 bot 的「消息卡片 -> 任务卡片」。
- 开关保存后只更新该 bot 的 `privateReplyReview`。
- 关闭后下一轮回复恢复直接公开。

## 12. PR 切分建议

1. `feat(lark): 增加私密回复发布记录存储`
   - store、nonce、CAS、过期清理和单测。
2. `feat(lark): 支持最终回复私密审核卡`
   - 卡片按钮构建、`botmux send` staging、`final_output` staging。
3. `feat(lark): 支持私密回复确认公开`
   - card action handler、公开发送、重复点击和删除临时卡片。
4. `feat(dashboard): 增加最终回复审核发布配置`
   - bot 配置、Dashboard 表单、i18n 文案。

每个 PR 描述需要写清影响面：公共发送路径、不同 CLI、普通群/话题群/p2p、sandbox relay、daemon 兜底回复。
