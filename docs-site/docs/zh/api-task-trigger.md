# 通过 API 触发 botmux 任务

> 想让外部系统（任务编排器、CI、后端服务等）把一段指令交给某个 botmux 机器人执行，并用程序拿回结果？用 `POST /api/trigger`。机器人照常跑它的 CLI；任务可以完全不进飞书，也可以落在真实群聊或话题里。

本文面向**调用方开发者**。前三节是最常用的写法，后面是完整的字段、状态码和边界说明，需要时再查。

---

## 1. 三分钟上手

最常见的用法：**异步触发 → 轮询结果**，全程不打扰飞书。

**第 1 步：拿 token。** 运行 `botmux dashboard`，输出的登录链接里 `?t=` 后面那段就是 token（详见 §3）。

**第 2 步：触发任务。**

```bash
curl -X POST "http://<daemon-host>:7891/api/trigger" \
  -H 'content-type: application/json' \
  -H "Cookie: botmux_dashboard_token=$TOKEN" \
  -d '{
    "source":{"type":"webhook"},
    "target":{"kind":"turn","botId":"cli_xxx"},
    "instruction":"回复恰好一行: ASYNC_DEMO_OK",
    "envelope":{"format":"json","sourceName":"demo","trusted":false},
    "options":{"asyncReturnSessionId":true}
  }'
```

`botId` 是目标机器人的飞书应用 ID（`bots.json` 里的 `larkAppId`）。响应会立刻返回，记下 `target.sessionId`：

```json
{
  "ok": true,
  "triggerId": "trg_87e7b415-...",
  "action": "queued",
  "target": { "kind": "turn", "sessionId": "2eed60c4-...", "chatId": "http_async_..." },
  "async": { "status": "pending", "sessionId": "2eed60c4-..." }
}
```

**第 3 步：轮询结果。**

```bash
curl "http://<daemon-host>:7891/api/sessions/2eed60c4-.../trigger-result" \
  -H "Cookie: botmux_dashboard_token=$TOKEN"
```

看 `state` 字段：`running` 就过几秒再查，`completed` 时答案在 `output.content`。完整状态见 §9。

---

## 2. 先想清楚两件事：怎么拿结果、落在哪

一次触发由两个**互不影响**的维度决定。**是否进飞书群只由 `target` 决定，和同步/异步无关。**

**怎么拿结果（`options`）**

| 模式 | 怎么开 | HTTP 行为 | 能轮询 | 能停止 |
|------|--------|----------|:-----:|:-----:|
| **异步**（推荐） | `asyncReturnSessionId: true` | 立即返回 `sessionId` | ✓ | ✓ |
| **同步** | `waitForFinalOutput: true` | 连接挂住，直到出结果或超时 | — | ✗ |
| **即发即忘** | 两个都不传 | 立即返回，结果走飞书正常回复 | ✗（见 §6.3） | 只能关会话 |

**落在哪（`target`）**

| 形状 | 传什么 | 落点 |
|------|-------|------|
| **虚拟会话** | 不传 `chatId` / `sessionId` / `rootMessageId` | 合成会话，完全不进飞书 |
| **真实群聊** | `chatId` | 该群的真实会话 |
| **已有话题** | `chatId` + `rootMessageId` | 追加到那条话题 |
| **已有会话** | `sessionId` | 给那个会话追加一轮 |

常见组合：

| 想做的事 | 组合 |
|---------|------|
| 纯后台任务，飞书零打扰 | 虚拟 + 异步（或同步） |
| 像 webhook 一样把事件丢进群，答案发在群里 | 真群 + 即发即忘 |
| 群里能看到机器人在干活，但答案交给程序 | 真群 + 异步/同步（⚠️ 群里看不到最终答案，见 §5.5） |
| 对同一个会话连续追问 | 已有会话 + 异步，配合 `turnIdempotencyKey` |

> 硬约束：**三个目标字段都不传时，必须开异步或同步之一**，否则 400 `target_required`——不然这个任务既没有飞书出口，也没有 HTTP 出口。

---

## 3. 鉴权

请求发给 Dashboard（默认端口 `7891`），用 Dashboard 的登录 token 鉴权：

- **把 token 放在 Cookie 头**：`Cookie: botmux_dashboard_token=<TOKEN>`。
- ⚠️ 不要用 `?t=<TOKEN>`：那是浏览器登录用的，会返回 **302 跳转**并种 cookie，程序调用会失败。
- 获取 token：运行 `botmux dashboard`。还没有 token 时它会自动创建一个。
- token 一直有效，直到你运行 `botmux dashboard rotate` 主动换掉（旧 token 立刻失效）。

---

## 4. 请求体

```jsonc
{
  "source":   { "type": "webhook" },                  // 见 4.1
  "target":   { "kind": "turn", "botId": "cli_xxx" }, // 见 4.2
  "instruction": "你要机器人执行的指令",              // 可信，作为顶层任务
  "envelope": {                                        // 见 4.3
    "format": "json",
    "sourceName": "your-system",
    "trusted": false                                   // 必须为 false
  },
  "presentation": { "title": "…", "topicMessage": "…" },  // 可选，见 4.4
  "options": { /* 见 4.5 */ }
}
```

### 4.1 `source`

| 字段 | 必填 | 说明 |
|------|:---:|------|
| `type` | ✓ | 只接受 `webhook` / `ui` / `workflow` / `schedule` / `vc_meeting` / `headless`，其它值（包括笔误）直接 400 `bad_request` |
| `connectorId` | | 接入点标识；没有 `envelope.sourceName` 时用来生成默认标题 |
| `requestId` | | 你这边的请求 ID，会写进调用日志 |
| `receivedAt` | | 上游收到事件的时间 |

普通外部调用**一律填 `"webhook"`**。真正会改变行为的只有 `headless`（走本机 headless 分支，见 [无群自动化会话](/headless-session)）和 `vc_meeting`（事件内容紧凑渲染）。

### 4.2 `target`

| 字段 | 必填 | 说明 |
|------|:---:|------|
| `kind` | ✓ | 填 `"turn"`。`"workflow"` 已退役，会返回 **410 `legacy_workflow_retired`** |
| `botId` | ✓ | 目标机器人的 `larkAppId`。缺失 → 400 `target_required`；和目标 daemon 对不上 → 400 `bot_not_found` |
| `chatId` | | 真实群 ID，见 §5.2 |
| `sessionId` | | 续已有会话。不存在 → 404 `session_not_found` |
| `rootMessageId` | | 已有话题的根消息 ID。不带 `sessionId` 时**必须同时传 `chatId`** |

### 4.3 `envelope`（外部事件数据，默认不可信）

| 字段 | 必填 | 说明 |
|------|:---:|------|
| `sourceName` | ✓ | 调用方名字，用于默认标题和默认话题引子 |
| `trusted` | ✓ | **必须字面为 `false`** |
| `format` | ✓ | 标注用，填 `"json"` 即可（daemon 不读它） |
| `headers` | | 原始请求头 |
| `payload` | | 原始事件体 |
| `rawText` | | 原始文本 |

为什么 `trusted` 必须是 `false`：这是防提示词注入。daemon 会把整个 envelope 包成「不可信外部数据」交给模型，并告诉模型不要执行里面夹带的指令。**真正要机器人做的事，写在顶层 `instruction`**，它会作为可信任务放在事件数据之上。

> 例外：[Webhook 接入点](/webhook)打开「把事件内容当作可信指令」后，Dashboard 转发时会在请求顶层带 `payloadTrusted: true`（`envelope.trusted` 仍是 `false`），事件内容按可信任务渲染。它只接受 `source.type: "webhook"` + `target.kind: "turn"`，其它组合 400。直接调用本接口时用不到它，把任务写进 `instruction` 就行。

### 4.4 `presentation`（可选，控制飞书里怎么显示）

| 字段 | 取值 | 默认 / 说明 |
|------|------|------|
| `title` | 1–200 字符 | 会话标题（Dashboard / 话题名），最终截到 50 字符。默认 `[External] <sourceName>` |
| `topicMessage` | 1–200 字符，或 `null` | 新开话题时发的那条引子消息。默认 `外部事件触发：{sourceName}`；传 `null` 表示不发引子 |
| `thinking` | `"hidden"` | 只隐藏这一轮的「思考中」气泡，业务消息和 HTTP 结果不受影响 |
| `liveCard` | `"on-start"` | 只对普通群的群级会话生效：等这一轮输入真正交给 CLI 时，再发一张新的流式卡片 |

- 显式传了非空 `topicMessage`，会要求开独立话题（普通群的 `shared` 模式除外，仍复用共享会话）。
- `title` 和 `topicMessage` **只在真正新开话题时有意义**：虚拟会话不发任何飞书消息；落到已有话题或已有会话时也不发引子。
- 越界（空串、超 200 字符、类型不对）→ 400 `bad_request`。

### 4.5 `options`

**常用字段**

| 字段 | 校验 | 说明 |
|------|------|------|
| `asyncReturnSessionId` | 布尔 | 异步模式 |
| `waitForFinalOutput` | 布尔 | 同步模式。和异步同传 → 400 |
| `timeoutMs` | `1000`–`300000` | 同步模式的等待上限，默认 `120000`（2 分钟） |
| `idempotencyKey` | 非空，≤200 字符 | 新建会话防重复，见 §8.1 |
| `turnIdempotencyKey` | 非空，≤200 字符 | 续轮防重复，见 §8.2。和上一项互斥 |
| `dryRun` | 布尔 | 只看提示词、不真正派发，见 §6.4 |

**进阶字段**

| 字段 | 校验 | 说明 |
|------|------|------|
| `model` | ≤200 字符 | 本次新会话用的模型 ID |
| `reasoningEffort` | `low` / `medium` / `high` / `xhigh` / `max` / `ultra` | 本次新会话的思考强度 |
| `steer` | 布尔 | 允许把追问插进正在跑的那一轮（仅 Codex App），见 §6.5。和 `dryRun` 互斥 |
| `allowChatMessages` | 布尔 | 允许这一轮主动往群里发消息，见 §6.6 |
| `suppressFinalOutput` | 布尔 | 只在**即发即忘 + 真群**时生效：不发群里那条收尾回复 |

以上布尔字段都要求严格布尔值：传 `"true"`、`1` 会 400。

`model` / `reasoningEffort` 的细节：

- 只对这些 CLI 生效：Codex、Codex App、TraeX、Remote Runner、Grok、Claude Code、Kimi、ZCode。其它 CLI 会忽略这两个字段。
- **只对新建的会话生效**：追加到已有会话的那一轮不会改模型。
- `reasoningEffort` 会按 CLI 和模型的能力校验，明确不支持的档位返回 400。
- `model` 只在本次运行中生效，不写进会话记录；daemon 重启后会按机器人配置的模型启动。`reasoningEffort` 会随会话保存。

**两个「看着有用、其实没人读」的字段**

| 字段 | 实际行为 |
|------|---------|
| `dedupKey` | 触发流程不读它，只会写进给模型的提示词，并参与幂等的 payload 比对。真正的事件去重在 [Webhook 接入点](/webhook)的「去重字段」上 |
| `status` | 同上（`firing` / `resolved` 或任意字符串）。注意：同一个 `idempotencyKey` 改了 `status` 也会 **409** |

---

## 5. 任务落在哪、飞书里能看到什么

### 5.1 不传目标 → 虚拟会话（飞书零打扰）

三个目标字段都不传时，daemon 生成一个合成会话：

| 模式 | 会话 ID 前缀 |
|------|------|
| 同步 | `http_wait_` |
| 异步 | `http_async_` |
| `source.type: "headless"` | `headless_` |

这类会话**不发话题引子、不发流式卡片、不发任何消息、不做群成员校验**。响应里的 `target.chatId` 就是这个合成 ID。

### 5.2 传 `chatId` → 真实群会话

只要传了真实群 ID，就**一定不是**虚拟会话，同步/异步也一样：

- 先校验机器人在不在群里，不在 → **403 `bot_not_in_chat`**。
- **话题群**（或普通群设成 `new-topic` 模式）会新开一个话题：先发引子消息，会话挂在这条消息上。
- **普通群**按群的回复模式走：已有共享会话就续上，`new-topic` 新开话题。显式传了非空 `topicMessage` 时，除 `shared` 模式外都会开独立话题。

### 5.3 `chatId` + `rootMessageId` → 追加到已有话题

不发引子。以下情况会被拒绝：

- 不带 `sessionId` 又没传 `chatId` → 400 `target_required`。
- 这条消息看不到或取不到所属群 → 400 `target_required`。
- 这条消息**不属于**你传的群 → `chat_not_allowed`（⚠️ 本接口当前返回 **500**，见 §11.3）。

### 5.4 `sessionId` → 给已有会话追加一轮

群 ID 从会话继承，不用再传。

- 会话不存在 → **404 `session_not_found`**。
- 会话还没准备好接收输入（还在选目录、首次启动、建 worktree、或在待办队列里）→ `session_not_runnable`（当前 HTTP 500）。这说明输入**没有**送达 CLI，稍后重试即可。
- 带 `turnIdempotencyKey` 且会话还在开场激活中 → `trigger_failed`（提示含 `session activation in progress`），稍后用同一个键重试。

### 5.5 一张表看清：群里到底能看到什么

| 目标 × 模式 | 话题引子 | 流式卡片 | 答案发到飞书 | 答案回给程序 |
|---|:---:|:---:|:---:|:---:|
| 虚拟 + 同步/异步 | ✗ | ✗ | ✗ | ✓ |
| 真群 + 即发即忘 | ✓（话题群） | ✓ | ✓ | ✗ |
| **真群 + 同步/异步** | ✓（话题群） | ✓ | **✗** | ✓ |
| 已有话题 + 即发即忘 | ✗ | ✓ | ✓ | ✗ |
| **已有话题 + 同步/异步** | ✗ | ✓ | **✗** | ✓ |

> ⚠️ **加粗两行最容易踩坑**：在真群里跑同步/异步，群成员能看到机器人在工作，**但永远等不到最终答复**——答案被交给了 HTTP 调用方。想让群里也看到答案：用即发即忘模式，或者程序拿到 `output.content` 后自己发回群里，或者在已有群会话上用 `allowChatMessages`（§6.6）。

### 5.6 想「每次自动建一个新群」？用 Webhook 接入点

本接口的 `chatId` 必须是已存在的群。「每次新建群」是 [Webhook 接入点](/webhook)独有的投递模式（会自动拉授权用户进群，还支持按事件字段去重）。

### 5.7 和在飞书里聊天的两点不同

- **不建 worktree**：即使机器人开了「自动创建 worktree」，虚拟会话和同步/异步会话也**一律在基础目录直接跑**，避免每次程序调用都留下一个 worktree。只有「真群 + 即发即忘 + 落在机器人自己的默认目录」才会自动建 worktree。
- **工作目录的选法更简单**：依次取 oncall 绑定目录 → 机器人默认目录（含 `defaultOncall.workingDir`）→ 机器人 `workingDir` → `~`。不会从兄弟会话继承目录（`botToBotSameDir` 在这里不生效），也不会自动绑定 oncall。需要固定目录时，请直接在机器人或 oncall 上配置好。

---

## 6. 执行模式详解

### 6.1 同步（`waitForFinalOutput`）

```bash
curl -X POST "http://<host>:7891/api/trigger" \
  -H 'content-type: application/json' \
  -H "Cookie: botmux_dashboard_token=$TOKEN" \
  -d '{
    "source":{"type":"webhook"},
    "target":{"kind":"turn","botId":"cli_xxx"},
    "instruction":"回复恰好一行: SYNC_DEMO_OK",
    "envelope":{"format":"json","sourceName":"demo","trusted":false},
    "options":{"waitForFinalOutput":true,"timeoutMs":60000}
  }'
```

一发一收，结果直接在 `output.content`：

```json
{
  "ok": true,
  "triggerId": "trg_dcbd124a-...",
  "action": "completed",
  "target": { "kind": "turn", "sessionId": "0bc442ef-...", "chatId": "http_wait_..." },
  "output": { "content": "SYNC_DEMO_OK" },
  "message": "queued new session turn and completed"
}
```

> 超过 `timeoutMs` 返回 **HTTP 504** + `wait_timeout`。任务其实**还在后台继续跑**，但超时响应里没有 `sessionId`，你就再也查不到它了。需要兜底查询，请用异步模式。

### 6.2 异步（`asyncReturnSessionId`）

写法见 §1。**生产环境推荐异步**：立即拿到 `sessionId`，可以轮询、可以停止，daemon 重启后结果也还在（§9、§10）。

### 6.3 即发即忘（两个开关都不传）

必须带 `chatId` / `sessionId` / `rootMessageId` 之一。立即返回（`action` 是 `queued` 或 `delivered`），答案走**飞书正常回复**。

> ⚠️ 这种模式**不登记结果**。用 `trigger-result` 查只会看到 `running`，会话关闭后变成 `failed`——**永远拿不到 `output.content`**。需要程序拿结果，请用异步或同步。

### 6.4 `dryRun`：只看提示词，不派发

`dryRun: true` 时不建会话、不派发，直接返回最终会喂给模型的提示词：

```json
{
  "ok": true,
  "triggerId": "trg_...",
  "action": "dry_run",
  "target": { "kind": "turn", "sessionId": null, "chatId": "oc_xxx" },
  "message": "would create or deliver a new session turn",
  "promptPreview": "<botmux_task trusted=\"true\">…"
}
```

- `promptPreview` 超过 4000 字符会截断，末尾加 `...[truncated]`。
- `message` 告诉你会落到哪：命中已有会话是 `would inject into existing session`，否则是 `would create or deliver a new session turn`。

### 6.5 `steer`：把追问插进正在跑的那一轮（仅 Codex App）

`steer: true` 允许把新消息**合并进 Codex App 当前正在进行的那一轮**，而不是排队等它跑完。适合任务进行中补一句「顺便再处理 X」「别做那个了，改成 Y」。

这是**尽力而为**的授权，不保证一定插得进去：

- **第一轮也要带**：Codex 要求开场那一轮和后续插话都显式授权，所以首个请求就要传 `steer: true`。
- **插不进去时自动降级**：没有正在跑的轮次、轮次正在收尾、处于 review/压缩轮、或 worker 还在冷启动，这条消息会变成普通排队追问。请求不会因为 `steer` 而失败。
- **其它 CLI**：这个开关不起作用，照常排队。

响应只在请求真正被派发时回显 `steer: true`（幂等复用时不回显）。回显只说明 daemon 带上了授权，**不代表已经插入成功**。

**合并后的结果怎么算**：几条插话合并后，Codex 只产出**一条合并答案**。每个较早的请求最终都会拿到**同一份合并正文**：

- 异步：较早成员轮询到 `completed` + 合并后的 `output.content`，**不带 `usage`**（用量只记在最新那次触发上）。daemon 在合并期间重启也能正确补上。
- 同步：较早成员在答案出来时一起返回。但同步结果只在内存里，daemon 中途重启的话，它只会等到自己超时。

### 6.6 `allowChatMessages`：允许这一轮往群里发消息

默认情况下，同步/异步任务会被告知「不要调用 `botmux send`、不要往飞书发消息」。如果你希望某一轮任务能在群里主动发消息（比如通知相关人），传 `allowChatMessages: true`：

- 只这一轮有效，不会带到后续轮次。
- 最终答案**仍然**返回给 HTTP 调用方。
- 条件：异步模式 + `target.sessionId` 指向一个**已有的真实群会话**（不是私聊、不是虚拟会话）；不能和同步、`steer`、`source.type: "headless"` 一起用。不满足 → 400 `bad_request`。

---

## 7. 「没什么可答」时怎么办（`BOTMUX_NOTHING_TO_SEND`）

同步/异步模式下（首轮和续轮都一样），daemon 会在提示词里告诉模型：

- 你的回复会**原样交给一个程序**，不是聊天展示。
- **只输出最终答案**，不要开场白、不要谈论这些系统提示。
- 不要调用 `botmux send`、不要往飞书发消息（开了 `allowChatMessages` 时除外）。
- **没什么可答时，只输出 `BOTMUX_NOTHING_TO_SEND`**，程序会收到空结果。

这个标记直接影响结算：

| 模式 | 模型只输出这个标记时 |
|------|---------------------|
| **异步** | 结算为 `completed`，`output.content` 是**空串** |
| **同步** | 没有对应的结算路径，会一直等到 `timeoutMs`，最后 **504 `wait_timeout`** |

> ⚠️ 这是同步和异步唯一的语义差别。如果任务**可能不需要回答**（巡检类、「有问题才报」），请用**异步**，否则每次「无事发生」都要白等一个超时。

模型写了正文、结尾又带一行标记时，正文照常返回，标记会被去掉。只有「除了标记什么都没有」才算空结果。

---

## 8. 防止重复执行（幂等键）

### 8.1 `idempotencyKey`：新建会话

**问题**：异步触发后，如果 HTTP 响应在网络上丢了（其实任务已经在跑），你一重试就会建**第二个会话、把任务再跑一遍**。

**做法**：在发请求**之前**生成一个稳定的键并存下来，重试时用同一个键。daemon 会返回**同一个会话和 `triggerId`，不会重新派发**：

```bash
curl -X POST "http://<host>:7891/api/trigger" -H 'content-type: application/json' \
  -H "Cookie: botmux_dashboard_token=$TOKEN" \
  -d '{
    "source":{"type":"webhook"},
    "target":{"kind":"turn","botId":"cli_xxx"},
    "instruction":"...",
    "envelope":{"format":"json","sourceName":"demo","trusted":false},
    "options":{"asyncReturnSessionId":true, "idempotencyKey":"my-task-42"}
  }'
```

- 命中已有键：响应带 `idempotent: true`；首次创建：`idempotent: false`。之后照常用 `sessionId` 轮询。
- **只支持「全新的异步虚拟会话」**：`asyncReturnSessionId: true`，且不带 `sessionId` / `rootMessageId` / `chatId`、不带 `waitForFinalOutput` / `dryRun`。其它组合带这个键 → 400。
- **同键、不同内容 → 409 `idempotency_conflict`**。比对范围是 `instruction`、`envelope`、`source`、`presentation` 和整个 `options`（键本身除外），所以改了 `model`、`status`、`timeoutMs` 任何一个都会 409。重试务必**同键同内容**。
- **daemon 崩溃时宁可不跑，也不跑两次**：如果 daemon 恰好在「开始派发」和「确认结果」之间崩溃，重启后不会盲目重跑，这个键会收敛为 `failed`（`no_output`，`error` 说明「上一次派发结果未知」）。按失败处理即可。
- 键和会话的对应关系会一直保留，任务完成后迟到的重试也能拿到同一个会话。

### 8.2 `turnIdempotencyKey`：给已有会话追加一轮

往已有会话追加一轮（带 `target.sessionId`）时用这个键。同键重试会落到**同一轮（同一个 `triggerId`），不会注入两次**，响应带 `idempotent: true`。

```bash
curl -X POST "http://<host>:7891/api/trigger" -H 'content-type: application/json' \
  -H "Cookie: botmux_dashboard_token=$TOKEN" \
  -d '{
    "source":{"type":"webhook"},
    "target":{"kind":"turn","botId":"cli_xxx","sessionId":"<已存在会话>"},
    "instruction":"...",
    "envelope":{"format":"json","sourceName":"demo","trusted":false},
    "options":{"asyncReturnSessionId":true, "turnIdempotencyKey":"my-followup-7"}
  }'
```

- 条件：带 `target.sessionId`，不带 `waitForFinalOutput` / `dryRun`。异步和即发即忘都支持：异步照常轮询结果，即发即忘的答案照常发到飞书。
- 和 `idempotencyKey` **互斥**，同传 → 400。两种键互不干扰，取相同字符串也不会串。
- 同键不同内容 → 409；崩溃语义和保留策略同 §8.1。

---

## 9. 轮询结果

```
GET /api/sessions/:sessionId/trigger-result
    可选 ?triggerId=<trg_...>：查某一次触发；不传则查该会话最近一次
```

**正常情况都返回 HTTP 200 + `ok: true`，任务状态只看 `state`**，不要用 `ok` 或 HTTP 状态码判断。

| `state` | 意思 | 你该做什么 |
|---------|------|-----------|
| `running` | 还在跑 | 过几秒再查 |
| `completed` | 有结果了 | 读 `output.content`（可能是空串，见 §7） |
| `interrupted` | 你主动停掉了这一轮（§10.2），会话还在 | 按「已取消」处理 |
| `failed` | 会话结束了但没拿到结果 | 软终态，见 9.2 |
| `not_found` | 查不到这个会话 | 见 9.3 |

`completed` 示例：

```json
{
  "ok": true,
  "state": "completed",
  "triggerId": "trg_87e7b415-...",
  "action": "completed",
  "output": { "content": "ASYNC_DEMO_OK" },
  "usage": { "inputTokens": 60, "outputTokens": 30, "cacheReadTokens": 40, "cacheCreateTokens": 0 },
  "finishedAt": "2026-07-24T08:43:17.126Z",
  "target": { "kind": "turn", "sessionId": "2eed60c4-...", "chatId": "http_async_..." },
  "async": { "status": "completed", "sessionId": "2eed60c4-...", "completedAt": "..." }
}
```

关于 `usage`（这一轮的 token 用量）：

- **只有 Codex App 任务**、且成功采集到时才有；其它情况整段省略。**没有 `usage` 表示「不知道」，不是 0。**
- 四个数互不重叠：`inputTokens`（不含缓存的新输入）、`outputTokens`、`cacheReadTokens`、`cacheCreateTokens`，都是这一轮的增量。
- daemon 重启后再查，`usage` 和 `output` 一起从磁盘恢复。

### 9.1 哪些触发能查到 `completed`

| 触发方式 | 能查到 `completed` |
|---------|:----------------:|
| 异步（任何目标） | ✓ |
| 同步 | ✗（结果直接在触发响应里） |
| 即发即忘 | ✗（一直 `running`，会话关闭后变 `failed`） |

### 9.2 `failed` 别急着判死

| 情况 | 返回 |
|------|------|
| 会话结束但没拿到结果——**可能是真失败，也可能是你自己关掉了会话** | `errorCode: "no_output"` |
| 幂等键遇到 daemon 崩溃，按「至多一次」不重跑 | `no_output`，`error` 说明「上一次派发结果未知」 |
| CLI 明确报告这一轮失败 | `errorCode: "trigger_failed"`，`terminalErrorCode` 给出具体原因 |

建议：

- 是不是你自己取消的，按你自己的记录判断，别从 `failed` 反推。
- 把 `no_output` 当作「待核对」：确认确实没结果、也不是自己取消的，再标成最终失败。

### 9.3 `not_found` 有两种样子

经 Dashboard 查询时，下面两种都应当成「查不到」：

1. `HTTP 404` + `{ "ok": false, "error": "unknown_session" }`：Dashboard 从没见过这个 ID（通常是 ID 写错或已过期）。
2. `HTTP 200` + `{ "ok": true, "state": "not_found" }`：请求到了 daemon，但磁盘上也没有。

### 9.4 `?triggerId=` 对不上

会话存在、但从没有过你给的 `triggerId` → HTTP 400 + `ok: false` + `errorCode: "bad_request"`，**没有 `state` 字段**。这是请求写错了，不是「查不到」。

### 9.5 Webhook 接入点的轮询格式不一样

[Webhook 接入点](/webhook)自带的轮询接口会把 `failed` 和 `not_found` 改成 `ok: false` + **HTTP 404**（`state` 字段保留）。本文的 `/api/sessions/:id/trigger-result` 不做这种改写。两边都对接的话，要分开处理。

---

## 10. 重启后还在吗？怎么停止？

### 10.1 重启不丢结果

**daemon 重启后，已经跑完的异步任务再查仍是 `completed`（带 `output.content`），不会变成 `not_found`。** 结果在完成时就写到了磁盘（`data/async-triggers/<sessionId>.json`）。

所以：单次查不到时**别急着判定任务丢了**。只有确认查无（`unknown_session` / `not_found`），且你自己的超时也到了，再走补偿。

### 10.2 只停这一轮（会话保留）

```bash
curl -X POST "http://<host>:7891/api/sessions/:sessionId/turns/:triggerId/interrupt" \
  -H "Cookie: botmux_dashboard_token=$TOKEN"
# → { "ok": true, "action": "interrupted", "sessionId": "...", "triggerId": "..." }
```

只中断这一次**异步**触发对应的那一轮，会话保留，之后还能继续追问。daemon 会先确认 CLI 正在跑的就是这一轮，才发送中断；不会误停别的轮次。

| 返回 | 意思 |
|------|------|
| 200 `action: "interrupted"` | 已停止；再查 `trigger-result` 是 `state: "interrupted"`。重复调用返回 `idempotent: true` |
| 404 `session_not_found` | 会话不存在或已关闭 |
| 404 `bad_request` | 这个会话里没有这个 `triggerId` 的异步触发 |
| 409 `trigger_failed` | 这一轮已经结束、不在本代 daemon 里运行，或会话正在迁移 |
| 503 `trigger_failed` | 中断没送达或没能保存，稍后重试或继续轮询 |

### 10.3 关闭整个会话

```bash
curl -X POST "http://<host>:7891/api/sessions/:sessionId/close" \
  -H "Cookie: botmux_dashboard_token=$TOKEN"
# → { "ok": true, ... }
```

`close` 会**关掉整个会话**。一次性的虚拟会话（只有一轮）关掉没问题；**真实群会话**可能还有别人在用，请慎用，只想停一轮就用 §10.2。

关闭后再查，如果关之前没出结果，会返回 `state: "failed"`（`no_output`）。这是正常的，按你自己的取消记录处理即可。

---

## 11. 响应字段与状态码

### 11.1 响应字段

| 字段 | 什么时候有 |
|------|---------|
| `ok` | 总是有 |
| `triggerId` | 几乎总是（`trg_<uuid>`） |
| `action` | `queued` / `delivered` / `completed` / `dry_run`，见 11.2；停止接口（§10.2）返回 `interrupted` |
| `state` | 轮询响应；触发响应只在幂等命中已结束的任务时出现 |
| `target` | `{ kind, sessionId?, chatId? }` |
| `output.content` | 同步完成，或轮询到 `completed` |
| `usage` | 见 §9 |
| `async` | `{ status: 'pending' \| 'completed', sessionId, completedAt? }` |
| `finishedAt` | 结束时间（ISO 8601） |
| `message` | 给人看的说明 |
| `errorCode` / `error` | 出错时，见 11.3 |
| `terminalErrorCode` | CLI 明确报告失败时的具体原因 |
| `promptPreview` | 仅 `dryRun` |
| `idempotent` | 带幂等键时：`true` = 复用了已有会话/轮次 |
| `idempotencyKey` / `turnIdempotencyKey` | 回显你传的键 |
| `steer` | 见 §6.5 |
| `readOnlyUrl` / `viewToken` | 仅 core-only 部署（`BOTMUX_CORE_ONLY=1`）、且 CLI 终端还活着时，轮询响应附带只读终端链接，见 [Core-only 嵌入](/api-core-only) |

### 11.2 `action` 和 `message` 对照

`action` 只说明**派发结果**（「受理了」），不代表任务成功。要拿结果只有两条路：同步的 `output.content`，或异步轮询到 `completed`。

| `action` | `message` | 场景 |
|---------|-----------|------|
| `delivered` | `delivered to existing session` | 即发即忘，已有会话的 CLI 正在运行 |
| `queued` | `durably queued behind the existing activation` | 同上，但会话还在开场，这一轮先排队 |
| `queued` | `queued existing session turn` | 即发即忘，已有会话需要重新拉起 CLI |
| `queued` | `delivered to existing session; poll by sessionId or triggerId for final output` | 异步 + 已有会话 |
| `queued` | `queued new session turn` | 即发即忘，新建会话 |
| `queued` | `queued new session turn (building worktree)` | 同上，正在建 worktree |
| `queued` | `queued new session turn; poll by sessionId or triggerId for final output` | 异步 + 新建会话 |
| `completed` | `delivered to existing session and completed` | 同步 + 已有会话 |
| `completed` | `queued new session turn and completed` | 同步 + 新建会话 |
| `dry_run` | `would inject into existing session` / `would create or deliver a new session turn` | `dryRun` |

### 11.3 HTTP 状态码

**Dashboard 这一层**

| 状态 | `errorCode` | 原因 |
|:---:|------------|------|
| 400 | `bad_json` | JSON 写错，或请求体超过 512 KiB |
| 400 | `target_required` | 缺 `target.botId` |
| 400 | 其它 | 字段校验不通过（见 §4） |
| 502 | `daemon_offline` | 转发给 daemon 失败 |
| 503 | `daemon_offline` | 目标 daemon 没在线 |

**daemon 这一层**

| 状态 | `errorCode` | 原因 |
|:---:|------------|------|
| 200 | — | 成功（`queued` / `delivered` / `completed` / `dry_run`） |
| 200 | `no_output` 等 | `ok: false` 但 `state: "failed"`：幂等命中了一个已失败的任务。HTTP 调用本身成功，按 `state` 读 |
| 400 | `bad_json` / `bad_request` / `target_required` | 请求格式或组合不对 |
| 400 | `bot_not_found` | `botId` 和这个 daemon 对不上 |
| 403 | `bot_not_in_chat` | 机器人不在目标群 |
| 404 | `session_not_found` | `target.sessionId` 不存在 |
| 409 | `idempotency_conflict` | 同键不同内容 |
| 410 | `legacy_workflow_retired` | `target.kind: "workflow"`（已退役） |
| 503 | `bot_not_found` / `trigger_failed` | daemon 还没准备好 |
| 504 | `wait_timeout` | 同步等待超时 |
| 500 | `trigger_failed` / `session_not_runnable` / `chat_not_allowed` 等 | 其它失败 |

⚠️ **收到 500 先看 `errorCode`，不要一律重试**：

- `chat_not_allowed`（`rootMessageId` 不属于你传的群）是**请求错误，重试没用**。Webhook 接入点对同一个码返回 403，本接口目前是 500。
- `session_not_runnable` 说明输入没送达，稍后重试是安全的。

### 11.4 错误码一览

**本接口会遇到的**：`bad_json`、`bad_request`、`bot_not_found`、`bot_not_in_chat`、`chat_not_allowed`、`daemon_offline`、`idempotency_conflict`、`legacy_workflow_retired`、`no_output`、`session_not_found`、`session_not_runnable`、`target_required`、`trigger_failed`、`wait_timeout`

**只有 [Webhook 接入点](/webhook) 会遇到的**

| 码 | 状态 | 含义 |
|---|:---:|---|
| `invalid_signature` | 401 | 令牌或签名校验失败 |
| `replay` | 401 | 签名时间戳超出允许范围 |
| `rate_limited` | 429 | 超过限流 |
| `group_create_failed` | 501 / 502 | 「每次新建群」时建群失败 |
| `lifecycle_extract_failed` | 400 | 配了去重字段，但事件里取不到 |

`dry_run` 和 `workflow_trigger_not_implemented` 也在错误码列表里，但实际不会返回。

---

## 12. 限制与注意事项

- **请求体最大 512 KiB**（在 Dashboard 层检查）。
- **Dashboard 转发给 daemon 不设超时**。同步模式传 `timeoutMs: 300000` 就真的会挂满 5 分钟。**请在你的 HTTP 客户端上自己设超时。**
- **API-only 机器人**（`apiOnly`，没有飞书通道）有四条限制，违反都是 400 `bad_request`：
  1. 必须开同步或异步；
  2. 不能传 `rootMessageId`；
  3. 不能传真实 `chatId`；
  4. 传 `sessionId` 时只能指向它自己的虚拟会话。
- **异步结果文件目前不会自动清理**：`data/async-triggers/` 下的文件只增不删，这样会话关闭后结果仍可查。
- **`output.content` 偶尔可能带一句开场白**。botmux 已经在提示词里要求模型只输出答案，绝大多数结果是干净的，但不是硬保证。要展示给用户时：
  - ✅ 只裁掉已知的固定前缀（比如 `here's my answer:`），后面的内容全部保留。
  - ❌ 不要「只取最后一段」：答案可能本来就是多段或带代码块。
  - 存档、审计请保存原始 `content`。

---

## 13. 客户端示例

```ts
// 异步触发 + 轮询到结束的最小骨架
async function runAndAwait(instruction: string, botId: string): Promise<Result> {
  // 1) 异步触发，拿 sessionId
  const trg = await post('/api/trigger', {
    source: { type: 'webhook' },
    target: { kind: 'turn', botId },
    instruction,
    envelope: { format: 'json', sourceName: 'my-system', trusted: false },
    options: { asyncReturnSessionId: true },
  });
  const sessionId = trg.target.sessionId;

  // 2) 轮询，只看 state
  for (;;) {
    const r = await getTriggerResult(sessionId);
    switch (r.state) {
      case 'running':
      case 'unknown':     await sleep(3000); continue;       // unknown：网络/5xx，任务可能还在跑
      case 'completed':   return { ok: true, content: r.output?.content ?? '' }; // 空串也是合法结果
      case 'interrupted': return { ok: false, cancelled: true };
      case 'failed':      return { ok: false, needsReconcile: true }; // 软终态，再核对一次
      case 'not_found':   return { ok: false, notFound: true };
      case 'error':       return { ok: false, fatal: true, why: r.why }; // 请求/鉴权错误，重试没用
    }
  }
}

// 关键：分清「暂时查不到，可以重试」和「确定结束了」
async function getTriggerResult(sessionId: string) {
  let res: Response;
  try {
    res = await fetch(`/api/sessions/${sessionId}/trigger-result`, { headers: cookie() });
  } catch (e) {
    return { state: 'unknown', why: `network: ${String(e)}` }; // 网络异常 → 重试
  }

  if (res.status === 401 || res.status === 403) return { state: 'error', why: `auth ${res.status}` };

  if (res.status === 404) {
    const b = await res.json().catch(() => ({}));
    if (b?.error === 'unknown_session') return { state: 'not_found' };
    if (b?.state) return b; // Webhook 接入点的轮询会把 failed/not_found 改成 404（§9.5）
    // 其它 404（网关返回的 HTML 等）不代表查不到，按可重试处理，
    // 否则可能把「网关抽风」误判成任务丢失、重新派发导致跑两次。
    return { state: 'unknown', why: 'opaque 404' };
  }

  if (res.status === 400) return { state: 'error', why: 'bad_request' }; // 比如 triggerId 对不上（§9.4）
  if (res.status >= 500) return { state: 'unknown', why: `upstream ${res.status}` };

  let body: any;
  try { body = await res.json(); } catch { return { state: 'unknown', why: 'non-json 2xx' }; }
  return body?.state ? body : { state: 'unknown', why: 'no state field' };
}
```

要点：

- 先把 `timeoutMs` 限制在 `1000`–`300000`，并给 HTTP 客户端**自己设超时**（§12）。
- 同步模式遇到 504，任务可能还在跑，但你没有 `sessionId` 去查。在意这点就用异步。
- `completed` 的 `output.content` 可能是空串（§7），这是正常结果。
- **可重试**（网络异常、5xx、非 JSON）和**确定结束**（`not_found`、400、401/403）一定要分开，否则可能重复派发。
- 本接口收到 500 时先看 `errorCode`（§11.3）。

---

## 附：接口速查

| 接口 | 方法 | 用途 |
|------|------|------|
| `/api/trigger` | POST | 触发任务 |
| `/api/sessions/:id/trigger-result` | GET | 查异步结果（可选 `?triggerId=`） |
| `/api/sessions/:id/turns/:triggerId/interrupt` | POST | 只停止某一次异步触发，会话保留 |
| `/api/sessions/:id` | GET | 查会话信息（状态、标题等） |
| `/api/sessions/:id/close` | POST | 关闭整个会话 |

相关页面：[Webhook 接入点](/webhook)（自动建群、签名、去重）、[Core-only 嵌入](/api-core-only)（无飞书的纯 API 部署）。
