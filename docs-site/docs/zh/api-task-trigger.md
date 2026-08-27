# 通过 API 编程式触发 botmux 任务

> 让外部系统（任务编排器、CI、后端服务等）通过 HTTP API 把一段指令交给某个 botmux 机器人执行，并拿回最终结果——机器人在飞书话题里正常跑 CLI，但整个调用是纯程序化的「请求 → 拿结果」，可选完全不打扰飞书。

本文面向**调用方开发者**，介绍两种执行模式、四态轮询契约、鉴权、取消与故障恢复，并附可直接运行的 curl 示例与客户端伪代码。

---

## 1. 两种执行模式

所有调用都走同一个端点 `POST /api/trigger`，区别只在 `options`：

| 模式 | 触发方式 | 适用场景 | 能否中途取消 |
|------|---------|---------|:-----------:|
| **同步** | `options.waitForFinalOutput=true` | 一发一收、任务短（≤5 分钟）、不需要中途取消 | ✗ |
| **异步** | `options.asyncReturnSessionId=true` | 快速接单 + 轮询、需要中途取消、需要故障恢复 | ✓ |

两种模式都会开一个「虚拟会话」（不传 `chatId` 时），**完全不进飞书群、不发任何消息**——纯 HTTP 请求-应答。

> ⚠️ 生产级任务调度**推荐异步模式**：同步模式的 `sessionId` 只在完成时才返回，运行中拿不到、无法中途取消，且 HTTP 连接要挂最长 5 分钟。异步模式立即返回 `sessionId`，可轮询、可取消、可恢复。

---

## 2. 鉴权

调用走 dashboard（默认 `http://<daemon-host>:7891`）。当前用 dashboard 轮换式 token 鉴权：

- **程序化调用必须把 token 放在 Cookie 头**：`Cookie: botmux_dashboard_token=<TOKEN>`
- ⚠️ 不要用 `?t=<TOKEN>` query：那是给浏览器登录用的，`POST` 带它会返回 **302 重定向**（set-cookie），程序化调用会失败。
- token 获取：运行 `botmux dashboard` 获取当前登录 URL，其中 `?t=` 后面那段就是 token。尚无 token 时命令会创建第一个；仅在确实要让已有 token 失效时才运行 `botmux dashboard rotate`。

> token 会一直保留到显式轮换。独立 API Key 认证（如 `X-Botmux-Api-Key`）在规划中，届时本文更新。

---

## 3. 触发任务

### 请求体结构

```jsonc
{
  "source":   { "type": "webhook" },          // 来源类型
  "target":   { "kind": "turn", "botId": "cli_xxx" },  // 目标机器人的 larkAppId
  "instruction": "你要机器人执行的指令（可信，作为顶层指令渲染）",
  "envelope": {
    "format": "json",
    "sourceName": "your-system",               // 调用方标识
    "trusted": false                           // 必须为 false，见下
  },
  "options": { /* 见下 */ }
}
```

关键约束（都是硬校验，违反直接 400）：

- **`envelope.trusted` 必须是 `false`**。这是防注入设计：`trusted:false` 声明「以下 envelope 内容是不可信外部数据」，daemon 才会把它包成 untrusted event、不执行里面夹带的指令。你要机器人真正执行的东西放在顶层 `instruction`（可信指令），不要放进 envelope。
- **不传 `chatId`** 时，`options` 必须含 `waitForFinalOutput` 或 `asyncReturnSessionId` 之一，否则报 `target_required`。
- **`options.timeoutMs` 范围 `[1000, 300000]`**（1 秒 ~ 5 分钟），越界报 400。不传默认 120000。
- **`options.model`** / **`options.reasoningEffort`**（可选，**仅对 codex / codex-app / traex / grok 机器人生效**）：按本次触发覆盖模型与推理档位。
  - `model`：该 CLI 的模型 id（≤200 字符）；`reasoningEffort` 按 CLI/模型能力校验。常用档位是 `low` / `medium` / `high` / `xhigh`，部分模型还支持 `max` / `ultra`。未配置或未知模型只开放公共安全档位；明确不支持或超过档位时请求 400。
  - **仅新建会话生效**：只在这次触发**创建新会话**时记录；折叠进已有 worker 的续轮不改写。
  - `model` **只驻内存、不落盘**：它在该会话本次生命周期内的每次启动生效，daemon 重启后不恢复——之后按机器人配置的模型启动。`reasoningEffort` 仍随会话持久化。
  - **作用域收窄到带思考强度控制的 CLI**：目标机器人不是 codex/codex-app/traex/grok 时，这两个字段被忽略（不会改动 Claude/Gemini/CoCo 等的模型）。

### 同步模式（waitForFinalOutput）

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

> 同步模式超时（等待超过 `timeoutMs`）返回 **HTTP 504** + `errorCode:"wait_timeout"`。此时任务其实**仍在后台跑完**——只是这条 HTTP 断了。若你留了 `sessionId`，可后续查询兜底，别直接判失败。

### 异步模式（asyncReturnSessionId）

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

### 幂等键（`options.idempotencyKey`）—— 防止重试重复执行

**问题**：异步触发后如果 HTTP 响应在网络中丢了（daemon 其实已建 session、任务已在跑），你的重试会建一个**全新 session**、把同一个任务**跑第二遍**（重复的外部副作用：发两次消息、迁移跑两遍……）。你自己的去重挡不住——第一个 session 是真的在执行。

**解法**：在 `options.idempotencyKey` 传一个你侧稳定生成、且**在发起 trigger 之前就持久化**的键。同键重试时 daemon 返回**同一个 session/triggerId、不新建也不重派**：

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

**适用范围（重要）**：`idempotencyKey` 仅支持 **fresh async virtual** 触发，即 `target.kind:'turn'` + `options.asyncReturnSessionId:true`，且**不带** `target.sessionId` / `rootMessageId` / `chatId`、不带 `waitForFinalOutput` / `dryRun`。任何其它组合带 key 会 **400**（其它派发路径本 PR 未接入 lease，故契约不对外开放，以免误判为幂等）。

**同键、不同 payload → 409 `idempotency_conflict`**：键与其业务 payload（`instruction`/`envelope`/影响执行的 `options`）绑定；同键换了 payload 是调用方 bug，daemon 明确报 409，**绝不**把新请求静默串进旧任务。所以重试务必用**同键配同 payload**。

**崩溃语义（at-most-once）**：daemon 在真正派发前会把该键的 lease durable 标记为 `attempting`（commit-unknown 屏障）。若 daemon 恰好在「已开始派发」与「拿到完成证据」之间崩溃，重启后**不会盲目重派**（`forkWorker` 返回并不证明模型没开始跑）——该键会收敛到终态、`trigger-result` 报 `failed`（错误码 `no_output`，语义为「上次派发结果未知、按至多一次不重跑」）。你的 recovery 把它当 **Failed** 处理即可（宁可让你看到明确失败去新建重试，也不双跑）。

**保留**：键→session 映射只增不删（与异步结果同策略，保证完成后的迟到重试仍复用同一 session、不重建）。

---

### 续会话轮幂等键（`options.turnIdempotencyKey`）—— 给追问轮同样的保证

上面的 `idempotencyKey` 只覆盖 **fresh 新会话**。当你往**已存在的会话追加一轮追问**（带 `target.sessionId`）时，改用 `options.turnIdempotencyKey`——追加轮的 HTTP 回包一旦丢失，你无法判断 daemon 是否已受理该轮，重试就可能**重复注入两次**。

传一个**在发起前就持久化**的稳定键。同键重试到同一会话时，daemon 解析到**同一轮（同 `triggerId`）、不二次注入**：

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

命中带 `idempotent:true`；照常用 `sessionId`/`triggerId` 轮询 `trigger-result`。

**适用范围**：`turnIdempotencyKey` 仅支持**已存在会话上的续会话异步轮**——`target.kind:'turn'` + 带 `target.sessionId` + `options.asyncReturnSessionId:true`，不带 `waitForFinalOutput` / `dryRun`。它与 `idempotencyKey` **互斥**（同时传返回 **400**），且两者位于**互不碰撞的独立键空间**——即便 `turnIdempotencyKey` 和 `idempotencyKey` 取相同字符串也绝不会共用同一 lease。

**同键异 payload → 409 `idempotency_conflict`**；**崩溃语义（at-most-once）**与**保留**策略与上面的 `idempotencyKey` 完全一致（派发结果未知的追问轮收敛为 `failed` / `no_output`，绝不盲目重跑）。另有一个瞬时情况：若目标会话仍在完成其**开场激活**，该追问轮会被**可重试地**拒绝（errorCode `trigger_failed`，提示含 “session activation in progress”）——稍后重试即可。

---

## 4. 轮询结果（四态契约）

异步模式下，用 `sessionId` 轮询：

```
GET /api/sessions/:sessionId/trigger-result
   （可选 ?triggerId=<trg_...> 精确匹配某次触发；不传则取该会话最新一次）
```

**四态全部返回 HTTP 200 + `ok:true`；任务状态只看 `state` 字段，不要用 `ok` 或 HTTP 状态码判定。**

| `state` | 含义 | 你该做什么 | 关键字段 |
|---------|------|-----------|---------|
| `running` | 任务还在跑 | 继续轮询 | — |
| `completed` | 有最终产出 | 落终态，读 `output.content`（codex-app 还会带 `usage`） | `output.content`、`finishedAt`、`usage?` |
| `failed` | 会话已终止但没捕获到产出（软终态） | 见下方说明 | `errorCode:"no_output"`、`error`、`finishedAt` |
| `not_found` | 查无此会话（从未存在/非法 id） | 见下方两种物理表现 | `errorCode:"session_not_found"` |

`completed` 响应示例（`usage` 仅 codex-app、且成功采集到时出现）：

```json
{
  "ok": true,
  "state": "completed",
  "triggerId": "trg_87e7b415-...",
  "output": { "content": "ASYNC_DEMO_OK" },
  "usage": { "inputTokens": 60, "outputTokens": 30, "cacheReadTokens": 40, "cacheCreateTokens": 0 },
  "finishedAt": "2026-07-24T08:43:17.126Z",
  "target": { "kind": "turn", "sessionId": "2eed60c4-...", "chatId": "http_async_..." },
  "async": { "status": "completed", "sessionId": "2eed60c4-...", "completedAt": "..." }
}
```

关于 `usage`（本轮 token 用量，四桶互斥）：
- **仅 codex-app 任务**、且本轮成功采集到用量时出现；其它 CLI（含纯 codex）或未采集到时**整段省略**。
- **omit ≠ 0**：拿不到用量就没有 `usage` 字段，而不是四个 0——请按"字段缺失=未知"处理，不要把缺失当成真实 0 用量。
- 四桶：`inputTokens`（纯新增输入，已扣除缓存读/写）、`outputTokens`、`cacheReadTokens`、`cacheCreateTokens`，均为本轮增量（非会话累计）。
- **随重启持久化**：daemon 重启后再查该已完成会话，`usage` 与 `output` 一并从磁盘恢复。


### `failed` 是软终态，不要立即判死

`failed`（`no_output`）表示「会话已终止但没捕获到最终产出」，它**既可能是真失败，也可能是你自己取消（close）的**——两者从这个信号上无法区分。建议：

- **取消判定用你自己的意图**（比如你发起 cancel 时本就有记录），不要靠这里的 `failed` 反推「是不是我取消的」。
- 把 `failed` 当作「需要二次确认」的软终态：先标记待核对，确认确实无产出、且不是自己取消，再落最终失败态。

### `not_found` 的两种物理表现

调用方走 dashboard 代理，`not_found` 会以两种形式出现，**都应归一成 not_found 终态**：

1. `HTTP 404` + `{ "ok": false, "error": "unknown_session" }` —— 代理层短路（sessionId 从没被聚合器见过，通常是传了非法/过期 id）。
2. `HTTP 200` + `{ "ok": true, "state": "not_found" }` —— 请求到了 daemon，但磁盘查无此会话。

---

## 5. 重启存活保证（重要）

**daemon 重启后，一个已经跑完的任务再查仍返回 `completed`（带 `output.content`），不会误报成 `not_found`。**

实现上，异步结果在任务完成时会持久化到磁盘（`data/async-triggers/<sessionId>.json`），轮询时优先读持久化结果，不依赖内存态。所以：

- 你的恢复逻辑**不应因为单次查询拿不到就判任务丢失**。
- 只有「代理确认查无（`unknown_session`）」+「你自己的租约/超时也过期」才走补偿判定。

这条是异步模式故障恢复的地基——轮询期间即使 daemon 重启，已完成的结果不丢。

---

## 6. 取消任务

异步模式下，用 close 取消：

```bash
curl -X POST "http://<host>:7891/api/sessions/:sessionId/close" \
  -H "Cookie: botmux_dashboard_token=$TOKEN"
# → { "ok": true, "alreadyClosed": false }
```

> `close` 的语义是**关闭整个会话**，不是「中断当前这一轮 turn」。对一次性的虚拟异步会话（一个会话只有一轮 turn），二者等价。

取消后再轮询该 `sessionId`，若它在关闭前没产出，会返回 `state:"failed"`（`no_output`）。**这符合预期**——你按自己的取消意图落 `cancelled` 终态即可，不必依赖这个 `failed`。

---

## 7. 客户端伪代码

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
      case 'completed': return { ok: true, content: r.output.content };
      case 'failed':    return { ok: false, needsReconcile: true }; // 软终态，二次确认
      case 'not_found': return { ok: false, notFound: true };        // 终止：确认查无
      case 'error':     return { ok: false, fatal: true, why: r.why }; // 终止：请求/鉴权错误，重试也没用
    }
  }
}

// getTriggerResult 把响应分成 5 类，关键是别把"未知/可重试"和"确定终止"搞混：
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
    if (b?.state) return b; // 适配层把 failed 等翻成 404 时按 body 的 state 走（透传）
    // ⚠️ 其它 404（网关/旧路由返回的 HTML、非 JSON → 解析成 {}）**不是**确认查无，
    // 当可重试 unknown——否则会把「网关抽风」误判成任务丢失而补偿重派、双执行。
    return { state: 'unknown', why: 'opaque 404' };
  }

  // 请求错误：如精确 triggerId 未命中的 400 bad_request → 终止
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

- `timeoutMs` 传参前先 clamp 到 `[1000, 300000]`。
- 同步模式把 `504/wait_timeout` 当「可能仍在运行」，留 `sessionId` 兜底查，别判死。
- 轮询按 5 类分流，别把「可重试」和「终止」混为一谈：**not_found**（404 unknown_session / `state:not_found`）与 **error**（400 请求错误、401/403 鉴权）是终止态；**unknown**（网络异常/超时/5xx/502/非 JSON）是可重试态——原任务可能仍在后台跑，误当查无补偿重派会导致重复执行。`fetch` 与 `res.json()` 都要包 try/catch，别让异常冒泡打断轮询。

---

## 8. 已知项

- **异步结果磁盘文件目前不自动回收**：`data/async-triggers/<sessionId>.json` 只增不删（故意——否则会话关闭后 `completed` 结果会丢，破坏重启存活）。好处是即便会话记录将来被清理，只要该文件在，`completed` 仍查得到；代价是文件长期累积。后续会加保守 TTL 清扫（完成超过 N 天才清），届时本文更新。

- **`output.content` 极少数情况可能带一段前言**：botmux 已在源头（HTTP 应答模式 prompt）引导模型「只输出最终答案、不要 preamble/元推理」，绝大多数回复是干净的。但这是 prompt 层引导、非硬保证——个别情况仍可能冒出一句前言。若你要把 `output.content` 直接展示给用户且要求「绝对干净」，可在**展示层**叠一层**保守裁剪**作为兜底：
  - ✅ 只裁**已知的确定性前言前缀**（如匹配到 `This is a system routing header…` / `here's my answer:` 这类固定模式才裁，裁完保留其后**全部**内容）。
  - ❌ **不要**用「只取最后一个非空段落」这类激进截取——`output.content` 可能是合法多段（分点回答、含代码块），激进截取会把正文裁没，这是比偶发前言严重得多的正确性问题。宁可展示带一句前言的完整答案，也不能丢正文。
  - 裁剪只在**展示层**做；**持久化/审计/回放请存原始 `content`**。

---

## 附：端点速查

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/trigger` | POST | 触发任务（同步/异步由 `options` 决定） |
| `/api/sessions/:id/trigger-result` | GET | 异步轮询结果（四态） |
| `/api/sessions/:id` | GET | 查会话元信息（状态/标题等） |
| `/api/sessions/:id/close` | POST | 取消/关闭会话 |

关键 `errorCode`：`target_required`、`bad_request`（含 `trusted` 校验、`timeoutMs` 越界、`idempotencyKey` 超范围）、`idempotency_conflict`（同键异 payload）、`bot_not_found`、`bot_not_in_chat`、`wait_timeout`、`no_output`、`session_not_found`。
