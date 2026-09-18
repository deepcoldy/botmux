# 通过 API 编程式触发 botmux 任务

> 让外部系统（任务编排器、CI、后端服务等）通过 HTTP API 把一段指令交给某个 botmux 机器人执行。机器人照常跑它的 CLI，调用方拿到的是一次纯程序化的「请求 → 结果」。任务可以完全不进飞书，也可以落在真实群聊/话题里——这两件事是**互相独立**的。

本文面向**调用方开发者**，是 `POST /api/trigger` 的完整契约：请求字段、投递目标、执行模式、幂等、四态轮询、状态码与错误码、边界与陷阱。

---

## 1. 先分清两个正交维度

一次触发由两个**互不影响**的维度决定，请求体里各管各的。老版本文档把它们混在一起说（「两种模式都不进飞书群」），那是不准确的：**是否进飞书群只由 `target` 决定，和同步/异步无关。**

**维度 A — 执行模式（`options`，决定你怎么拿结果）**

| 模式 | 怎么触发 | HTTP 行为 | 能轮询 | 能中途取消 |
|------|---------|----------|:-----:|:---------:|
| **同步** | `options.waitForFinalOutput=true` | 连接挂住直到产出或超时，结果在 `output.content` | — | ✗ |
| **异步** | `options.asyncReturnSessionId=true` | 立即返回 `sessionId` | ✓ | ✓ |
| **即发即忘** | 两个都不传 | 立即返回 `queued`/`delivered`，产出走飞书正常回复 | ✗（见 §8） | ✓ |

**维度 B — 投递目标（`target`，决定任务落在哪、飞书里看不看得见）**

| 形状 | `target` 字段 | 落点 |
|------|--------------|------|
| **虚拟会话** | 不传 `chatId`/`sessionId`/`rootMessageId` | 合成会话，完全不进飞书 |
| **真实群聊** | `chatId` | 该群的真实会话 |
| **已有话题** | `chatId` + `rootMessageId` | 该话题锚点 |
| **已有会话** | `sessionId` | 给那个会话追加一轮 |

两个维度**可以自由组合**。常见组合：

| 组合 | 效果 |
|------|------|
| 虚拟 + 同步/异步 | 纯 API 任务，飞书零打扰（最常用） |
| 真群 + 即发即忘 | 等价于一次 webhook 投递，答案发在群里 |
| 真群 + 同步/异步 | 群里能看到话题引子和流式卡片，但**最终答案只回给 HTTP 调用方**（详见 §4） |
| 已有会话 + 异步 | 对同一个会话连续追问，配合 `turnIdempotencyKey` |

> 硬约束：**不传 `chatId`/`sessionId`/`rootMessageId` 时，`options` 必须含 `waitForFinalOutput` 或 `asyncReturnSessionId` 之一**，否则 400 `target_required`——否则这个任务既没有飞书出口、也没有 HTTP 出口，产出无处可去。

---

## 2. 鉴权

调用走 dashboard（默认 `http://<daemon-host>:7891`）。当前用 dashboard 轮换式 token 鉴权：

- **程序化调用必须把 token 放在 Cookie 头**：`Cookie: botmux_dashboard_token=<TOKEN>`
- ⚠️ 不要用 `?t=<TOKEN>` query：那是给浏览器登录用的，`POST` 带它会返回 **302 重定向**（set-cookie），程序化调用会失败。
- token 获取：运行 `botmux dashboard` 获取当前登录 URL，其中 `?t=` 后面那段就是 token。尚无 token 时命令会创建第一个；仅在确实要让已有 token 失效时才运行 `botmux dashboard rotate`。

> token 会一直保留到显式轮换。独立 API Key 认证（如 `X-Botmux-Api-Key`）在规划中，届时本文更新。

---

## 3. 请求体完整字段

```jsonc
{
  "source":   { "type": "webhook" },                  // 见 3.1
  "target":   { "kind": "turn", "botId": "cli_xxx" }, // 见 3.2
  "instruction": "你要机器人执行的指令（可信，作为顶层指令渲染）",
  "envelope": {                                        // 见 3.3
    "format": "json",
    "sourceName": "your-system",
    "trusted": false                                   // 必须为 false
  },
  "presentation": { "title": "…", "topicMessage": "…" },  // 可选，见 3.4
  "options": { /* 见 3.5 */ }
}
```

### 3.1 `source`

| 字段 | 必填 | 说明 |
|------|:---:|------|
| `type` | ✓ | 声明值：`webhook` / `ui` / `workflow` / `schedule` / `vc_meeting` / `headless` |
| `connectorId` | | 接入点标识，无 `envelope.sourceName` 时用于生成默认会话标题 |
| `requestId` | | 调用方请求 id，写进调用日志 |
| `receivedAt` | | 上游收到事件的时间 |

> ⚠️ **`source.type` 不做任何校验**——任意字符串都能通过。真正影响行为的只有两个值：`headless`（走本机 CLI 的 headless 分支，渲染另一套提示块）与 `vc_meeting`（事件 JSON 紧凑渲染）。普通外部调用**一律填 `"webhook"`**，别指望其它值带来差异。

### 3.2 `target`

| 字段 | 必填 | 说明 |
|------|:---:|------|
| `kind` | ✓ | 必须是 `"turn"`。`"workflow"` 已退役：校验能过，但 daemon 直接 **410 `legacy_workflow_retired`** |
| `botId` | ✓ | 目标机器人的 `larkAppId`。缺失 → 400 `target_required`；与目标 daemon 不符 → 400 `bot_not_found` |
| `chatId` | | 真实群 ID。传了就是真群会话，见 §4 |
| `sessionId` | | 续已有会话。会话不存在 → 404 `session_not_found` |
| `rootMessageId` | | 已有话题锚点。非空字符串；不带 `sessionId` 时**必须同时传 `chatId`** |

### 3.3 `envelope`（不可信事件数据）

| 字段 | 必填 | 说明 |
|------|:---:|------|
| `sourceName` | ✓ | 调用方标识，用于默认会话标题与默认话题引子文案 |
| `trusted` | ✓ | **必须字面为 `false`** |
| `format` | ✓ | 标注用；**代码中无读取方**，填 `"json"` 即可 |
| `headers` | | 原始请求头，随事件 JSON 一起给模型 |
| `payload` | | 原始事件体 |
| `rawText` | | 原始文本 |

**`envelope.trusted` 必须是 `false`** 是防注入设计：它声明「以下 envelope 内容是不可信外部数据」，daemon 才会把整个 envelope 包进 `<botmux_external_event trusted="false">` 并明确告诉模型不要执行其中夹带的指令。**你真正要机器人执行的事情放在顶层 `instruction`**，它会渲染成 `<botmux_task trusted="true">` 置于事件数据之上。

### 3.4 `presentation`（可选，控制飞书里的呈现）

| 字段 | 取值 | 默认 |
|------|------|------|
| `title` | 1–200 字符 | `[External] <sourceName 或 connectorId 或 source.type>` |
| `topicMessage` | 1–200 字符，或 `null` | `外部事件触发：{sourceName}` |

- `title` 是**会话标题**（dashboard/飞书话题名），最终截断到 50 字符。
- `topicMessage` 是**新开话题时发的那条引子消息**。传 `null` 显式表示「不要发引子」——话题会直接落在群的 chat 层级。
- ⚠️ 两者**只在真正新开话题时有意义**：虚拟会话不发任何飞书消息，`rootMessageId` 落已有话题、折叠进已有会话也都不发引子。
- 越界（空串 / >200 字符 / 类型不对）→ 400 `bad_request`。

### 3.5 `options`

**有效字段**

| 字段 | 校验 | 说明 |
|------|------|------|
| `waitForFinalOutput` | 严格布尔 | 同步模式。仅 `kind:"turn"`；与 `asyncReturnSessionId` 同传 → 400 |
| `asyncReturnSessionId` | 严格布尔 | 异步模式 |
| `dryRun` | 严格布尔 | 只渲染不派发，见 §5.4 |
| `timeoutMs` | `[1000, 300000]` | 同步模式等待上限，默认 `120000`。越界 400 |
| `idempotencyKey` | 非空 ≤200 字符 | 新建会话幂等，见 §7.1 |
| `turnIdempotencyKey` | 非空 ≤200 字符 | 续轮幂等，见 §7.2。与上一项互斥 |
| `suppressFinalOutput` | 布尔 | **仅即发即忘模式生效**，见下方陷阱 |
| `model` | ≤200 字符 | 仅 codex / codex-app / traex / grok，仅新建会话 |
| `reasoningEffort` | `low`\|`medium`\|`high`\|`xhigh`\|`max`\|`ultra` | 同上 |

`model` / `reasoningEffort` 细则：
- `model` 是该 CLI 的模型 id；`reasoningEffort` 按 CLI/模型能力校验，未配置或未知模型只开放公共安全档位，明确不支持时 400。
- **仅新建会话生效**：折叠进已有 worker 的续轮不改写。
- `model` **只驻内存、不落盘**：daemon 重启后按机器人配置的模型启动；`reasoningEffort` 仍随会话持久化。
- 目标机器人不是 codex/codex-app/traex/grok 时这两个字段被忽略（不会改动 Claude/Gemini/CoCo 等的模型）。

**⚠️ 三个陷阱字段（类型里有，但和你想的不一样）**

| 字段 | 真实行为 |
|------|---------|
| `dedupKey` | **触发路径没有任何消费方**。它只会随 options JSON 一起渲染进模型提示词，并参与幂等 `requestHash`。真正的事件去重在 [Webhook 接入点](/webhook)的「去重字段」上，不在这里。 |
| `status` | 同样**没有读取方**（`'firing'` / `'resolved'` 或任意字符串）。只进提示词 + 参与 `requestHash`——所以同一个 `idempotencyKey` 改了 `status` 会因 payload 变化而 **409**。 |
| `suppressFinalOutput` | **在同步/异步模式下刻意无效**。这是设计约束不是 bug：wait/async 的整个契约就是把最终产出返回给调用方，抑制它会让 HTTP 调用方一直饿到超时。只有**即发即忘 + 真群**时它才生效，且只丢弃群里那条收尾回复，流式卡片与开场提示照常。 |

---

## 4. 投递目标：任务落在哪、飞书里看得见什么

> 这是老文档缺失最多的一节。对照 [Webhook 接入点的「投递到哪个群」](/webhook)阅读。

### 4.1 不传 `chatId` → 虚拟会话（飞书零打扰）

不传任何 `chatId`/`sessionId`/`rootMessageId` 时，daemon 按模式铸造一个合成会话 id：

- `waitForFinalOutput` → `http_wait_<uuid>`
- `asyncReturnSessionId` → `http_async_<uuid>`
- `source.type:"headless"` → `headless_<id>`

这类会话被识别为 **HTTP 虚拟会话**：飞书传输能力整体关闭，**不发话题引子、不发流式卡片、不发任何消息、不做群成员校验**。响应里 `target.chatId` 就是这个合成 id。

### 4.2 传真 `chatId` → 真实群会话

只要 `target.chatId` 是真实群 ID，这**永远不是**虚拟会话——同步/异步也一样。此时：

- 会先校验机器人是否在该群，不在 → **403 `bot_not_in_chat`**。
- **话题群**（或普通群配置成 `new-topic` 模式）会新开一个话题：先发一条引子消息（`presentation.topicMessage`，可自定义、可传 `null` 抑制），会话锚在这条消息上。
- **普通群的 `chat` 模式**：不新开话题，折叠进该群那个唯一的 chat-scope 会话（已有会话就续轮）。

### 4.3 `chatId` + `rootMessageId` → 落到已有话题

任务追加到那条话题里，不发引子。校验：

- 不带 `sessionId` 时必须同时传 `chatId`，否则 400 `target_required`。
- 该消息不可见 / 取不到 chat_id → 400 `target_required`。
- 该消息**不属于**你传的 `chatId` → `chat_not_allowed`（⚠️ 见 §11.3，这个码在本端点当前落到 **500**）。

### 4.4 `sessionId` → 给已有会话追加一轮

`chatId` 从该会话继承，不需要再传。会话不存在 → **404 `session_not_found`**。若目标会话仍在完成**开场激活**，该轮会被**可重试地**拒绝（`trigger_failed`，提示含 `session activation in progress`），稍后重试即可。

### 4.5 交付矩阵：群里到底能看到什么

| 目标 × 模式 | 话题引子 | 流式卡片 | 最终答案发到飞书 | 最终答案回给 HTTP |
|---|:---:|:---:|:---:|:---:|
| 虚拟 + 同步/异步 | ✗ | ✗ | ✗ | ✓ |
| 真群 + 即发即忘 | ✓（话题群） | ✓ | ✓ | ✗ |
| **真群 + 同步/异步** | ✓（话题群） | ✓ | **✗** | ✓ |
| 已有话题 + 即发即忘 | ✗ | ✓ | ✓ | ✗ |
| **已有话题 + 同步/异步** | ✗ | ✓ | **✗** | ✓ |

> ⚠️ **加粗那两行是最容易踩的坑**：在真实群里跑 wait/async，群成员会看到话题被拉起、看到机器人在流式工作，**但永远等不到那条最终答复**——最终产出在 daemon 内部被同步/异步通道截走返回给 HTTP 调用方了，不会再作为飞书消息发出。想让群里也能看到答案，要么用即发即忘模式，要么由你的程序拿到 `output.content` 后自己发回群里。

### 4.6 「自动新建群」不在这个端点上

`/api/trigger` **没有**「每次自动拉个新群」的能力——`chatId` 必须是已存在的群。这个能力只存在于 [Webhook 接入点](/webhook)的「每次新建群」投递模式（它还会自动把机器人的授权用户拉进群，并支持按事件 body 的点号路径做去重）。需要自动建群请走接入点，不要走本端点。

### 4.7 与交互式会话的两处行为差异

- **不建 worktree**：即使机器人开了「自动创建 worktree」，同步/异步/虚拟会话也**一律在基目录直接跑**。这是刻意的——程序化「请求-应答」调用每次建一个 worktree 既反直觉又会泄漏（无回收机制）。只有「真群 + 即发即忘 + 命中机器人自己的默认目录」这一种形状（即普通 webhook 形状）才会走 auto-worktree。
- **工作目录阶梯更短**：HTTP 触发按 `oncall 绑定目录 → 机器人 defaultWorkingDir（含 defaultOncall.workingDir） → 机器人 workingDir → ~` 解析。相比交互式会话，它**不走兄弟会话继承**（`botToBotSameDir` / 「bot@bot 同目录拉起」在这条路径上不生效），群自动绑定 oncall 也不会在这里发生。
  > 与上一条不同，这处差异**源码里没有说明性注释**，是否属于有意设计尚未定论——需要与交互式会话完全一致的目录语义时，请显式把目录固定下来，不要依赖继承。

---

## 5. 执行模式

### 5.1 同步（`waitForFinalOutput`）

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

响应（HTTP 200，一发一收，结果就在 `output.content`）：

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

> 等待超过 `timeoutMs` 返回 **HTTP 504** + `errorCode:"wait_timeout"`。此时任务其实**仍在后台跑完**——只是这条 HTTP 断了。同步模式的 `sessionId` 只在完成时才返回，超时响应里没有它，所以**超时即失联**。需要兜底查询能力就该用异步模式。

### 5.2 异步（`asyncReturnSessionId`）

```bash
curl -X POST "http://<host>:7891/api/trigger" \
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

响应（HTTP 200，立即返回，**记下 `target.sessionId` 作为关联键**）：

```json
{
  "ok": true,
  "triggerId": "trg_87e7b415-...",
  "action": "queued",
  "target": { "kind": "turn", "sessionId": "2eed60c4-...", "chatId": "http_async_..." },
  "async": { "status": "pending", "sessionId": "2eed60c4-..." },
  "message": "queued new session turn; poll by sessionId or triggerId for final output"
}
```

> **生产级任务调度推荐异步模式**：立即拿到 `sessionId`，可轮询、可取消、daemon 重启也能恢复结果（§8、§9）。

### 5.3 即发即忘（两个模式开关都不传）

必须带 `chatId` / `sessionId` / `rootMessageId` 之一（否则 400 `target_required`）。立即返回（`action` 为 `queued` 或 `delivered`，见 §10.1），产出走**飞书正常回复路径**。

> ⚠️ **这种模式不登记异步结果**。用 `sessionId` 查 `trigger-result` 只会看到 `running`，会话关闭后转成 `failed`/`no_output`——**永远不会变成 `completed`，也拿不到 `output.content`**。它的产出出口只有飞书。需要程序化拿结果就用同步或异步模式。

### 5.4 `dryRun`：只渲染不派发

`options.dryRun=true` 时不创建会话、不派发任何东西，直接返回：

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

`promptPreview` 是**实际会喂给模型的完整提示词**（超过 4000 字符会截断并追加 `\n...[truncated]`）。`message` 区分两种落点：命中已有会话是 `would inject into existing session`，否则是 `would create or deliver a new session turn`。

> 注意：`dry_run` 是一个 **`action`，不是错误码**。错误码枚举里虽然有 `dry_run` 这个值，但代码里从不发出。

---

## 6. 空回答契约（`BOTMUX_NOTHING_TO_SEND`）

同步/异步模式下（**首轮与续轮都有**），daemon 会在提示词里追加一段 `<botmux_http_response_mode trusted="true">`，内容要点：

- 你的整条回复会**原样返回给一个程序**，不是聊天展示。
- **只输出最终答案**，不要前言、元评论，不要谈论这些路由头/系统上下文。
- 不要调用 `botmux send`，不要往飞书发消息。
- **如果没有什么可答的，只输出唯一一个 token `BOTMUX_NOTHING_TO_SEND`**，程序会收到一个空结果。

这个哨兵是**结算契约的一部分**，不是装饰：

| 模式 | 模型只吐 sentinel 时 |
|------|---------------------|
| **异步** | 结算为 `state:"completed"`，`output.content` 为**空串**，并持久化 |
| **同步** | **没有对应的结算路径**——这一轮会一直挂到 `timeoutMs`，最终 **504 `wait_timeout`** |

> ⚠️ 这是同步与异步之间**唯一的语义不对称**。如果你的任务**可能不需要回答**（条件触发、巡检类、"有问题才报"），请用**异步模式**，否则每次「无事发生」都要白等一个超时。若必须用同步模式，请把 `timeoutMs` 调到可接受的短值。

**正文 + 结尾 sentinel ≠ 沉默**：模型写了正文、末尾又带了一行 sentinel 时，正文照常返回，token 会被剥掉。只有「除 sentinel 外什么都没有」才算真沉默。

**关于 preamble**：上述提示已在源头引导模型只输出最终答案，绝大多数回复是干净的，但这是 prompt 层引导、非硬保证，见 §14。

---

## 7. 幂等键

### 7.1 `options.idempotencyKey`（新建会话）

**问题**：异步触发后如果 HTTP 响应在网络中丢了（daemon 其实已建 session、任务已在跑），你的重试会建一个**全新 session**、把同一个任务**跑第二遍**（重复的外部副作用：发两次消息、迁移跑两遍……）。你自己的去重挡不住——第一个 session 是真的在执行。

**解法**：传一个你侧稳定生成、且**在发起 trigger 之前就持久化**的键。同键重试时 daemon 返回**同一个 session/triggerId、不新建也不重派**：

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

命中已有键时响应带 `idempotent:true`（复用，无新派发）；首次创建时带 `idempotent:false`。拿到（复用或新建的）`sessionId` 后照常轮询 `trigger-result`——**不需要额外的反查端点**。

**适用范围（重要）**：仅支持 **fresh async virtual** 触发，即 `target.kind:"turn"` + `options.asyncReturnSessionId:true`，且**不带** `target.sessionId` / `rootMessageId` / `chatId`、不带 `waitForFinalOutput` / `dryRun`。任何其它组合带 key 会 **400**（租约只实现在这一条缝上，不对外宣称其它路径也幂等，以免误判）。

**同键、不同 payload → 409 `idempotency_conflict`**：键绑定到它的**完整业务 payload**——`instruction`、`envelope`、`source`、`presentation`，以及**整个 `options`（除 `idempotencyKey` 自身）**。所以改 `model`、`status`、`dedupKey`、`timeoutMs` 中的任何一个都会让同键请求 409。重试务必**同键配同 payload**。

**崩溃语义（at-most-once）**：daemon 在真正派发前会把该键的 lease durable 标记为 `attempting`（commit-unknown 屏障）。若 daemon 恰好在「已开始派发」与「拿到完成证据」之间崩溃，重启后**不会盲目重派**——该键会收敛到终态、`trigger-result` 报 `failed`（`no_output`，语义为「上次派发结果未知、按至多一次不重跑」）。你的 recovery 把它当 **Failed** 处理即可。

**保留**：键→session 映射只增不删，保证完成后的迟到重试仍复用同一 session。

### 7.2 `options.turnIdempotencyKey`（续会话轮）

上面的 `idempotencyKey` 只覆盖 **fresh 新会话**。往**已存在的会话追加一轮**（带 `target.sessionId`）时改用这个键——追加轮的 HTTP 回包一旦丢失，你无法判断 daemon 是否已受理该轮，重试就可能**重复注入两次**。

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

同键重试到同一会话时，daemon 解析到**同一轮（同 `triggerId`）、不二次注入**，响应带 `idempotent:true`。

**适用范围**：`target.kind:"turn"` + 带 `target.sessionId` + `asyncReturnSessionId:true`，不带 `waitForFinalOutput` / `dryRun`。

**与 `idempotencyKey` 互斥**：同时传 → **400**（这条互斥检查刻意排在两个键各自的范围检查之前，所以无论 target 形状如何，你拿到的都是精确的「互斥」报错，而不是被某个范围锁的报错盖掉）。两者位于**互不碰撞的独立键空间**——即便取相同字符串也绝不会共用同一 lease。

**同键异 payload → 409**；**崩溃语义**与**保留**策略与 `idempotencyKey` 完全一致。

---

## 8. 轮询结果（四态契约）

异步模式下，用 `sessionId` 轮询：

```
GET /api/sessions/:sessionId/trigger-result
   （可选 ?triggerId=<trg_...> 精确匹配某次触发；不传则取该会话最新一次）
```

**四态全部返回 HTTP 200 + `ok:true`；任务状态只看 `state` 字段，不要用 `ok` 或 HTTP 状态码判定。**

| `state` | 含义 | 你该做什么 | 关键字段 |
|---------|------|-----------|---------|
| `running` | 任务还在跑 | 继续轮询 | `action:"queued"`、`async.status:"pending"` |
| `completed` | 有最终产出 | 落终态，读 `output.content` | `output.content`、`finishedAt`、`usage?` |
| `failed` | 会话已终止但没捕获到产出（软终态） | 见 8.2 | `errorCode`、`error`、`finishedAt` |
| `not_found` | 查无此会话 | 见 8.3 | `errorCode:"session_not_found"` |

`completed` 响应示例（`usage` 仅 codex-app、且成功采集到时出现）：

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

关于 `usage`（本轮 token 用量，四桶互斥）：
- **仅 codex-app 任务**、且本轮成功采集到用量时出现；其它 CLI（含纯 codex）或未采集到时**整段省略**。
- **omit ≠ 0**：拿不到用量就没有 `usage` 字段，而不是四个 0——按「字段缺失=未知」处理。
- 四桶：`inputTokens`（纯新增输入，已扣除缓存读/写）、`outputTokens`、`cacheReadTokens`、`cacheCreateTokens`，均为本轮增量（非会话累计）。
- **随重启持久化**：daemon 重启后再查该已完成会话，`usage` 与 `output` 一并从磁盘恢复。

### 8.1 哪些触发是可轮询的

| 触发形状 | 能查到 `completed` |
|---------|:----------------:|
| 异步模式（任何目标） | ✓ |
| 同步模式 | ✗（结果直接在触发响应里；轮询看到的是会话状态） |
| 即发即忘 | ✗（见 §5.3，永远停在 `running` → 关闭后 `failed`） |

### 8.2 `failed` 是软终态，不要立即判死

`failed` 有三个来源，`errorCode` 可区分：

| `errorCode` | 来源 |
|------------|------|
| `no_output` | 会话终止但没捕获到最终产出——**可能是真失败，也可能是你自己 close 取消的** |
| `no_output`（`error` 含「上一次派发结果未知」） | 幂等 at-most-once 的歧义崩溃收敛，按语义不重跑 |
| `trigger_failed` | worker 明确上报了终态失败（`error` 含 `worker reported terminal failure:`） |

建议：
- **取消判定用你自己的意图**（发起 cancel 时本就有记录），不要靠这里的 `failed` 反推。
- 把 `no_output` 的 `failed` 当作「需要二次确认」的软终态：先标记待核对，确认确实无产出、且不是自己取消，再落最终失败态。

### 8.3 `not_found` 的两种物理表现

调用方走 dashboard 代理，`not_found` 会以两种形式出现，**都应归一成 not_found 终态**：

1. `HTTP 404` + `{ "ok": false, "error": "unknown_session" }` —— 代理层短路（sessionId 从没被聚合器见过，通常是传了非法/过期 id）。
2. `HTTP 200` + `{ "ok": true, "state": "not_found" }` —— 请求到了 daemon，但磁盘查无此会话。

### 8.4 精确 `?triggerId=` 未命中

会话存在、但它从来没有过你指定的那个 `triggerId` → `ok:false` + `errorCode:"bad_request"`，**且响应里没有 `state` 字段**。这是**请求形状错误**，不是四态之一，别和 `state:"not_found"` 混淆。

### 8.5 ⚠️ 另一条轮询路径的形状不一样

上面描述的是**原生四态契约**（dashboard 裸代理 → 任务编排器调用方）。[Webhook 接入点](/webhook)自己的异步轮询路由走了一层**遗留消费者适配**：它会把 `failed` 与 `not_found` 改写成 `ok:false`，并把 HTTP 200 改成 **404**（`.state` 字段保留）。

如果你用的是本文的 `/api/sessions/:id/trigger-result`，**不受这层改写影响**；但如果你的客户端同时对接两条路径，要按各自形状处理。

---

## 9. 重启存活、取消

### 9.1 重启存活保证

**daemon 重启后，一个已经跑完的异步任务再查仍返回 `completed`（带 `output.content`），不会误报成 `not_found`。**

异步结果在任务完成时会持久化到磁盘（`data/async-triggers/<sessionId>.json`），轮询时优先读持久化结果，不依赖内存态。所以：

- 你的恢复逻辑**不应因为单次查询拿不到就判任务丢失**。
- 只有「代理确认查无（`unknown_session`）」+「你自己的租约/超时也过期」才走补偿判定。

### 9.2 取消任务

```bash
curl -X POST "http://<host>:7891/api/sessions/:sessionId/close" \
  -H "Cookie: botmux_dashboard_token=$TOKEN"
# → { "ok": true, "alreadyClosed": false }
```

> `close` 的语义是**关闭整个会话**，不是「中断当前这一轮 turn」。对一次性的虚拟异步会话（一个会话只有一轮 turn），二者等价；但对**真实群会话**（可能还有别人在用）请慎用。

取消后再轮询该 `sessionId`，若它在关闭前没产出，会返回 `state:"failed"`（`no_output`）。**这符合预期**——按自己的取消意图落 `cancelled` 终态即可。

---

## 10. 响应字段

| 字段 | 出现时机 |
|------|---------|
| `ok` | 总是。**注意**：终态 `failed` 在触发端点上是 `ok:false`+HTTP 200，在轮询端点上是 `ok:true`+HTTP 200 |
| `triggerId` | 几乎总是（`trg_<uuid>`） |
| `action` | `queued` / `delivered` / `completed` / `dry_run`，取值与 `message` 的对应见 §10.1。枚举里还有 `ignored`，**只出现在 webhook 接入点的幂等折叠**，本端点从不返回 |
| `state` | 仅轮询响应（四态）。触发响应上只在幂等收敛到终态时出现 |
| `target` | `{ kind, sessionId?, chatId?, workflowRunId? }` |
| `output.content` | 同步完成、或轮询到 `completed` |
| `usage` | 见 §8 |
| `async` | `{ status: 'pending'\|'completed', sessionId, completedAt? }` |
| `finishedAt` | `completed` / `failed` 的 ISO8601 时间 |
| `message` | 人类可读说明（`queued new session turn`、`delivered to existing session and completed` 等） |
| `errorCode` / `error` | 失败时，见 §11 |
| `promptPreview` | 仅 `dryRun` |
| `idempotent` | 带幂等键时：`true` 表示复用已有会话/轮，`false`/缺失表示首次创建 |
| `idempotencyKey` / `turnIdempotencyKey` | 回显你传的键 |
| `reason` / `targetWorkflowId` / `targetRevisionId` | 仅已退役的 workflow 目标 |
| `idempotency` | `{ key, action:'accepted'\|'duplicate', firstTriggerId? }`——**仅 webhook 接入点**的重复投递抑制结果，与 `options.idempotencyKey` 无关 |
| `readOnlyUrl` / `viewToken` | 仅 core-only 部署（`BOTMUX_CORE_ONLY=1`）且存在活的 worker 终端时，轮询响应上附带只读终端链接 |

### 10.1 `action` + `message` 对照

| `action` | `message` | 触发形状 |
|---------|-----------|---------|
| `delivered` | `delivered to existing session` | 即发即忘，注入一个 worker 还活着的已有会话 |
| `queued` | `durably queued behind the existing activation` | 同上，但该会话还在开场激活中，本轮被持久排队 |
| `queued` | `queued existing session turn` | 即发即忘，已有会话的 worker 处于休眠，需重新 fork |
| `queued` | `delivered to existing session; poll by sessionId or triggerId for final output` | 异步 + 已有会话 |
| `queued` | `queued new session turn` | 即发即忘，新建会话 |
| `queued` | `queued new session turn (building worktree)` | 同上，且正在建 worktree |
| `queued` | `queued new session turn; poll by sessionId or triggerId for final output` | 异步 + 新建会话 |
| `completed` | `delivered to existing session and completed` | 同步 + 已有会话 |
| `completed` | `queued new session turn and completed` | 同步 + 新建会话 |
| `dry_run` | `would inject into existing session` / `would create or deliver a new session turn` | `dryRun` |

> `action` 只描述**派发结果**，不描述任务成败：`delivered`/`queued` 都只说明「已受理」。要拿产出只有两条路——同步的 `output.content`，或异步轮询到 `completed`。

---

## 11. HTTP 状态码与错误码

### 11.1 状态码映射

**代理层（dashboard）**

| 状态 | `errorCode` | 条件 |
|:---:|------------|------|
| 400 | `bad_json` | JSON 非法（`invalid JSON body`），或请求体超 512 KiB（`request body too large`） |
| 400 | `target_required` | 缺 `target.botId` |
| 400 | 各种 | 校验层拒绝（见 §3） |
| 502 | `daemon_offline` | 代理调用抛错 |
| 503 | `daemon_offline` | 目标 daemon 未注册 |

**daemon 层**

| 状态 | `errorCode` | 条件 |
|:---:|------------|------|
| 200 | — | `ok:true`（`queued` / `completed` / `dry_run`） |
| 200 | `no_output` 等 | `ok:false` 但 `state:"failed"`——**这是成功的 HTTP 调用在汇报终态**，按 `state` 读 |
| 400 | `bad_json` | JSON 非法 |
| 400 | `bad_request` / `target_required` | 校验失败、apiOnly 形状违规 |
| 400 | `bot_not_found` | `target.botId` 与该 daemon 不符 |
| 403 | `bot_not_in_chat` | 机器人不在目标群 |
| 404 | `session_not_found` | `target.sessionId` 查无活跃会话 |
| 409 | `idempotency_conflict` | 同键异 payload |
| 410 | `legacy_workflow_retired` | `target.kind:"workflow"`（已退役） |
| 503 | `bot_not_found` / `trigger_failed` | daemon 尚未就绪（appId 未设 / 会话注册表不可用） |
| 504 | `wait_timeout` | 同步模式等待超时 |
| 500 | `trigger_failed` 等 | 未分类失败（含下面 11.3 的 `chat_not_allowed`） |

### 11.2 错误码全表（20 个，按归属分）

**本端点会遇到的（13 个）**

`bad_json`、`bad_request`、`bot_not_found`、`bot_not_in_chat`、`chat_not_allowed`、`daemon_offline`、`idempotency_conflict`、`legacy_workflow_retired`、`no_output`、`session_not_found`、`target_required`、`trigger_failed`、`wait_timeout`

**仅 [Webhook 接入点](/webhook) 会遇到的（5 个）**

| 码 | 状态 | 含义 |
|---|:---:|---|
| `invalid_signature` | 401 | 令牌或 HMAC 校验失败 |
| `replay` | 401 | 签名时间戳超出容忍窗口 |
| `rate_limited` | 429 | 超过接入点限流 |
| `group_create_failed` | 501 / 502 | 「每次新建群」模式建群失败 |
| `lifecycle_extract_failed` | 400 | 配了去重字段但事件 body 里取不到 |

**枚举里有、但从不发出的（2 个）**

- `dry_run` —— `dryRun` 是一个 `action`，不是错误。
- `workflow_trigger_not_implemented` —— 被 daemon 路由层的 410 先挡住，结构上不可达。

### 11.3 已知不一致

`chat_not_allowed`（`rootMessageId` 不属于你传的 `chatId`）**没有被列进 daemon 的状态码阶梯**，因此落到兜底的 **HTTP 500**——而 webhook 接入点对同一个码返回 403。客户端在本端点上不要把 500 一律当作「服务端故障可重试」：先读 `errorCode`，`chat_not_allowed` 是**请求错误，重试无用**。

---

## 12. 传输层与边界

- **请求体上限 512 KiB**，只在 dashboard 代理层强制（超限 → 400 `bad_json` / `request body too large`）。直连 daemon IPC 的内部调用不受此限。
- **代理层对 dashboard→daemon 这一跳不设超时**。同步模式传 `timeoutMs: 300000` 就是真的会把 HTTP 连接挂满 5 分钟，唯一的兜底是 daemon 自己那个定时器。**客户端必须自己设连接/读取超时**，不要依赖代理帮你断。
- **apiOnly（core-only）机器人的四条硬约束**，违反都是 400 `bad_request`：
  1. 必须带 `waitForFinalOutput` 或 `asyncReturnSessionId`；
  2. 不能传 `rootMessageId`；
  3. 不能传真实 `chatId`；
  4. 传 `sessionId` 时只能指向它自己的 HTTP 虚拟会话。

---

## 13. 客户端伪代码

```ts
// 触发 + 轮询到终态的最小骨架
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
    const r = await getTriggerResult(sessionId); // 见下方分类
    switch (r.state) {
      case 'running':   await sleep(3000); continue;
      case 'unknown':   await sleep(3000); continue; // 可重试：网络/超时/5xx/非JSON，任务可能仍在跑
      case 'completed': return { ok: true, content: r.output?.content ?? '' }; // ⚠️ 空串是合法结果
      case 'failed':    return { ok: false, needsReconcile: true }; // 软终态，二次确认
      case 'not_found': return { ok: false, notFound: true };        // 终止：确认查无
      case 'error':     return { ok: false, fatal: true, why: r.why }; // 终止：请求/鉴权错误，重试也没用
    }
  }
}

// getTriggerResult 把响应分成 5 类，关键是别把「未知/可重试」和「确定终止」搞混：
//  - not_found  : 确认查无 → 终止（(a) 404 unknown_session；(b) 200 state:not_found）
//  - completed/running/failed : daemon 四态原样透传
//  - error      : 请求错误(400)/鉴权(401/403) → 终止，重试无意义
//  - unknown    : 网络异常/超时/5xx/502/非JSON → 可重试，任务可能仍在后台跑
async function getTriggerResult(sessionId: string) {
  let res: Response;
  try {
    res = await fetch(`/api/sessions/${sessionId}/trigger-result`, { headers: cookie() });
  } catch (e) {
    // fetch 直接 throw：网络不可达 / DNS / 连接重置 / 超时 → 可重试
    return { state: 'unknown', why: `network: ${String(e)}` };
  }

  // 鉴权错误：token 失效/无权 → 终止（重试同样会被拒），交人处理
  if (res.status === 401 || res.status === 403) return { state: 'error', why: `auth ${res.status}` };

  // 代理层短路 / 适配层 404
  if (res.status === 404) {
    const b = await res.json().catch(() => ({}));
    if (b?.error === 'unknown_session') return { state: 'not_found' }; // (a) 确认查无
    if (b?.state === 'not_found') return { state: 'not_found' };       // (b) 适配层翻译的查无
    if (b?.state) return b; // 适配层把 failed 等翻成 404 时按 body 的 state 走（透传，见 §8.5）
    // ⚠️ 其它 404（网关/旧路由返回的 HTML、非 JSON → 解析成 {}）**不是**确认查无，
    // 当可重试 unknown——否则会把「网关抽风」误判成任务丢失而补偿重派、双执行。
    return { state: 'unknown', why: 'opaque 404' };
  }

  // 请求错误：如精确 triggerId 未命中的 400 bad_request（无 state 字段，见 §8.4）→ 终止
  if (res.status === 400) return { state: 'error', why: 'bad_request' };

  // 5xx / 502 daemon 不可达 → 可重试（原任务可能仍在跑，绝不能当查无重派）
  if (res.status >= 500) return { state: 'unknown', why: `upstream ${res.status}` };

  // 2xx：解析 JSON；非 JSON（网关/代理返回 HTML 等）当可重试 unknown
  let body: any;
  try { body = await res.json(); } catch { return { state: 'unknown', why: 'non-json 2xx' }; }
  if (body?.state) return body; // { state, output?, errorCode?, finishedAt? }
  return { state: 'unknown', why: 'no state field' };
}
```

健壮性要点（都来自实测契约）：

- `timeoutMs` 传参前先 clamp 到 `[1000, 300000]`；并且**自己设 HTTP 客户端超时**（§12）。
- 同步模式把 `504/wait_timeout` 当「可能仍在运行」，但要知道**响应里没有 `sessionId`**，无法兜底查——在意这点就用异步。
- `completed` 的 `output.content` **可能是空串**（模型判定无需回答，见 §6），这是合法终态，不要当失败。
- 轮询按 5 类分流，别把「可重试」和「终止」混为一谈：**not_found**（404 unknown_session / `state:not_found`）与 **error**（400 请求错误、401/403 鉴权）是终止态；**unknown**（网络异常/超时/5xx/502/非 JSON）是可重试态——原任务可能仍在后台跑，误当查无补偿重派会导致重复执行。
- 在本端点上收到 **500** 时先读 `errorCode`：`chat_not_allowed` 是请求错误、重试无用（§11.3）。
- `fetch` 与 `res.json()` 都要包 try/catch，别让异常冒泡打断轮询。

---

## 14. 已知项

- **异步结果磁盘文件目前不自动回收**：`data/async-triggers/<sessionId>.json` 只增不删（故意——否则会话关闭后 `completed` 结果会丢，破坏重启存活）。好处是即便会话记录将来被清理，只要该文件在，`completed` 仍查得到；代价是文件长期累积。后续会加保守 TTL 清扫（完成超过 N 天才清），届时本文更新。

- **`output.content` 极少数情况可能带一段前言**：botmux 已在源头（§6 的 HTTP 应答模式提示块）引导模型「只输出最终答案、不要 preamble/元推理」，绝大多数回复是干净的。但这是 prompt 层引导、非硬保证。若你要把 `output.content` 直接展示给用户且要求「绝对干净」，可在**展示层**叠一层**保守裁剪**作为兜底：
  - ✅ 只裁**已知的确定性前言前缀**（如匹配到 `This is a system routing header…` / `here's my answer:` 这类固定模式才裁，裁完保留其后**全部**内容）。
  - ❌ **不要**用「只取最后一个非空段落」这类激进截取——`output.content` 可能是合法多段（分点回答、含代码块），激进截取会把正文裁没，这是比偶发前言严重得多的正确性问题。
  - 裁剪只在**展示层**做；**持久化/审计/回放请存原始 `content`**。

- **同步模式在「真沉默」上会超时**（§6）。异步模式没有这个问题。

- **`chat_not_allowed` 在本端点映射成 500**（§11.3），与 webhook 接入点的 403 不一致。

- **`source.type` 不校验**（§3.1）；`envelope.format`、`options.dedupKey`、`options.status` 均无读取方（§3.5）。

---

## 附：端点速查

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/trigger` | POST | 触发任务（执行模式由 `options` 决定，投递目标由 `target` 决定） |
| `/api/sessions/:id/trigger-result` | GET | 异步轮询结果（四态，可选 `?triggerId=`） |
| `/api/sessions/:id` | GET | 查会话元信息（状态/标题等） |
| `/api/sessions/:id/close` | POST | 取消/关闭会话 |

想要「每次自动新建一个群来处置事件」，见 [Webhook 接入点](/webhook)——那是它独有的投递模式，本端点没有。
