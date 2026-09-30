# Programmatic Task Trigger API

> Let an external system (task orchestrator, CI, backend service…) hand an instruction to a botmux bot over HTTP. The bot runs its CLI as usual; the caller gets a purely programmatic "request → result". The task can stay entirely out of Feishu, or land in a real group / thread — **those two things are independent**.

This page is for **client developers**: the full contract of `POST /api/trigger` — request fields, delivery targets, execution modes, idempotency, four-state polling, status/error codes, limits and traps.

---

## 1. Two orthogonal dimensions

A trigger is defined by two **independent** dimensions, each owned by its own part of the request body. The old version of this page conflated them ("both modes never enter a Feishu group"), which was inaccurate: **whether the task enters a Feishu group is decided solely by `target`, and has nothing to do with sync vs async.**

**Dimension A — execution mode (`options`; how you get the result)**

| Mode | Trigger | HTTP behavior | Pollable | Cancellable |
|------|---------|---------------|:--------:|:-----------:|
| **Sync** | `options.waitForFinalOutput=true` | Connection is held until output or timeout; result in `output.content` | — | ✗ |
| **Async** | `options.asyncReturnSessionId=true` | Returns a `sessionId` immediately | ✓ | ✓ |
| **Fire-and-forget** | neither flag | Returns immediately; output goes out through the normal Feishu reply path | ✗ (see §8) | ✓ |

**Dimension B — delivery target (`target`; where it lands, and what Feishu sees)**

| Shape | `target` fields | Lands on |
|-------|-----------------|----------|
| **Virtual session** | no `chatId` / `sessionId` / `rootMessageId` | A synthetic session; never enters Feishu |
| **Real group** | `chatId` | A real session in that group |
| **Existing thread** | `chatId` + `rootMessageId` | That thread's anchor |
| **Existing session** | `sessionId` | Appends a turn to that session |

The two dimensions **combine freely**. Common pairings:

| Combination | Effect |
|-------------|--------|
| virtual + sync/async | Pure API task, zero Feishu noise (the common case) |
| real group + fire-and-forget | Equivalent to a webhook delivery; the answer is posted in the group |
| real group + sync/async | The group sees the topic seed and the streaming card, but **the final answer goes only to the HTTP caller** (see §4) |
| existing session + async | Follow-up turns on one session, paired with `turnIdempotencyKey` |

> Hard constraint: **when you pass none of `chatId` / `sessionId` / `rootMessageId`, `options` must contain either `waitForFinalOutput` or `asyncReturnSessionId`**, otherwise 400 `target_required` — such a task would have neither a Feishu exit nor an HTTP exit, so its output would have nowhere to go.

---

## 2. Authentication

Calls go through the dashboard (default `http://<daemon-host>:7891`), authenticated with the dashboard's rotating token:

- **Programmatic calls must put the token in a Cookie header**: `Cookie: botmux_dashboard_token=<TOKEN>`
- ⚠️ Do not use `?t=<TOKEN>`: that is the browser login form, and a `POST` carrying it gets a **302 redirect** (set-cookie), which breaks programmatic callers.
- Getting the token: run `botmux dashboard` to print the current login URL; the part after `?t=` is the token. The command creates the first token if none exists; only run `botmux dashboard rotate` when you actually want to invalidate the existing one.

> The token persists until explicitly rotated. Standalone API-key auth (e.g. `X-Botmux-Api-Key`) is planned; this page will be updated when it lands.

---

## 3. Request body

```jsonc
{
  "source":   { "type": "webhook" },                  // §3.1
  "target":   { "kind": "turn", "botId": "cli_xxx" }, // §3.2
  "instruction": "what you want the bot to do (trusted; rendered as the top-level task)",
  "envelope": {                                        // §3.3
    "format": "json",
    "sourceName": "your-system",
    "trusted": false                                   // must be false
  },
  "presentation": { "title": "…", "topicMessage": "…" },  // optional, §3.4
  "options": { /* §3.5 */ }
}
```

### 3.1 `source`

| Field | Required | Meaning |
|-------|:--------:|---------|
| `type` | ✓ | Declared value: `webhook` / `ui` / `workflow` / `schedule` / `vc_meeting` / `headless` |
| `connectorId` | | Connector identifier; used for the default session title when `envelope.sourceName` is absent |
| `requestId` | | Your request id; recorded in the trigger audit log |
| `receivedAt` | | When the upstream received the event |

> ⚠️ **`source.type` is not validated at all** — any string passes. Only two values change behavior: `headless` (the local-CLI headless branch, which renders a different prompt block) and `vc_meeting` (compact event-JSON rendering). For ordinary external callers, **always send `"webhook"`**; do not expect other values to do anything.

### 3.2 `target`

| Field | Required | Meaning |
|-------|:--------:|---------|
| `kind` | ✓ | Must be `"turn"`. `"workflow"` is retired: it passes validation but the daemon answers **410 `legacy_workflow_retired`** |
| `botId` | ✓ | The target bot's `larkAppId`. Missing → 400 `target_required`; mismatched daemon → 400 `bot_not_found` |
| `chatId` | | A real group id. Passing it makes this a real-group session (see §4) |
| `sessionId` | | Continue an existing session. Unknown session → 404 `session_not_found` |
| `rootMessageId` | | An existing thread anchor. Non-empty string; **requires `chatId`** unless `sessionId` is also given |

### 3.3 `envelope` (untrusted event data)

| Field | Required | Meaning |
|-------|:--------:|---------|
| `sourceName` | ✓ | Caller identity; used for the default session title and default topic-seed text |
| `trusted` | ✓ | **Must be literally `false`** |
| `format` | ✓ | A label only; **nothing in the code reads it**. Send `"json"` |
| `headers` | | Raw request headers, handed to the model with the event JSON |
| `payload` | | Raw event body |
| `rawText` | | Raw text |

**`envelope.trusted` must be `false`** by design: it declares "the envelope below is untrusted external data", which is what makes the daemon wrap the whole envelope in `<botmux_external_event trusted="false">` and explicitly tell the model not to execute instructions smuggled inside it. **Put what you actually want done in the top-level `instruction`** — it is rendered as `<botmux_task trusted="true">` above the event data.

### 3.4 `presentation` (optional; controls how it looks in Feishu)

| Field | Value | Default |
|-------|-------|---------|
| `title` | 1–200 chars | `[External] <sourceName or connectorId or source.type>` |
| `topicMessage` | 1–200 chars, or `null` | `External event: {sourceName}` |

- `title` is the **session title** (dashboard / Feishu thread name), truncated to 50 chars.
- `topicMessage` is the **seed message posted when a new thread is opened**. Pass `null` to say explicitly "do not post a seed" — the session then sits at the group's chat scope.
- ⚠️ Both matter **only when a new thread is actually opened**: a virtual session posts nothing at all, and neither a `rootMessageId` delivery into an existing thread nor a fold-in to an existing session posts a seed.
- Out of range (empty string / >200 chars / wrong type) → 400 `bad_request`.

### 3.5 `options`

**Effective fields**

| Field | Validation | Meaning |
|-------|------------|---------|
| `waitForFinalOutput` | strict boolean | Sync mode. `kind:"turn"` only; combined with `asyncReturnSessionId` → 400 |
| `asyncReturnSessionId` | strict boolean | Async mode |
| `dryRun` | strict boolean | Render without dispatching, see §5.4 |
| `steer` | strict boolean | Authorize native in-flight `turn/steer` (codex-app only), see §5.5. Mutually exclusive with `dryRun` → 400 |
| `timeoutMs` | `[1000, 300000]` | Sync wait cap, default `120000`. Out of range → 400 |
| `idempotencyKey` | non-empty ≤200 chars | Fresh-session idempotency, see §7.1 |
| `turnIdempotencyKey` | non-empty ≤200 chars | Follow-up-turn idempotency, see §7.2. Mutually exclusive with the above |
| `suppressFinalOutput` | boolean | **Effective in fire-and-forget mode only**, see the traps below |
| `model` | ≤200 chars | codex / codex-app / traex / grok only; new sessions only |
| `reasoningEffort` | `low`\|`medium`\|`high`\|`xhigh`\|`max`\|`ultra` | Same scope |

Details for `model` / `reasoningEffort`:
- `model` is that CLI's model id. `reasoningEffort` is validated against the CLI/model capability; when unconfigured or unknown only the common safe tiers are allowed, and an explicitly unsupported value is a 400.
- **New sessions only**: a follow-up turn folded into a live worker does not rewrite them.
- `model` **lives in memory only, never on disk**: after a daemon restart the session starts on the bot's configured model. `reasoningEffort` is still persisted with the session.
- Both fields are ignored when the target bot is not codex / codex-app / traex / grok (they never change the model of Claude / Gemini / CoCo and friends).

**⚠️ Three trap fields (present in the type, but not what you think)**

| Field | Actual behavior |
|-------|-----------------|
| `dedupKey` | **Nothing on the trigger path consumes it.** It is only rendered into the model prompt along with the rest of the options JSON, and it participates in the idempotency `requestHash`. Real event dedupe lives on the [Webhook connector](/en/webhook)'s dedupe field, not here. |
| `status` | Also **has no reader** (`'firing'` / `'resolved'` or any string). Prompt-only + `requestHash`-only — which means changing `status` under the same `idempotencyKey` is a payload change and gets a **409**. |
| `suppressFinalOutput` | **Deliberately inert in sync and async modes.** This is a design constraint, not a bug: the entire contract of wait/async is to return the final output to the caller, so suppressing it would starve the HTTP caller until its timeout. It only takes effect for **fire-and-forget + a real group**, and even then it drops only the closing reply in the group — the streaming card and the start notice still show. |

---

## 4. Delivery targets: where the task lands and what Feishu sees

> This is the section the old page was missing most. Read it alongside the [Webhook connector's "Which group does it go to"](/en/webhook).

### 4.1 No `chatId` → virtual session (zero Feishu noise)

When you pass none of `chatId` / `sessionId` / `rootMessageId`, the daemon mints a synthetic session id by mode:

- `waitForFinalOutput` → `http_wait_<uuid>`
- `asyncReturnSessionId` → `http_async_<uuid>`
- `source.type:"headless"` → `headless_<id>`

Such a session is recognized as an **HTTP virtual session**: Feishu transport is disabled wholesale — **no topic seed, no streaming card, no messages at all, and no group-membership check**. The response's `target.chatId` is that synthetic id.

### 4.2 A real `chatId` → real group session

Whenever `target.chatId` is a real group id, this is **never** a virtual session — sync and async included. In that case:

- The bot's membership in that group is checked first; if it is not a member → **403 `bot_not_in_chat`**.
- **Topic groups** (or regular groups configured in `new-topic` mode) open a new thread: a seed message is posted first (`presentation.topicMessage`, customizable, or `null` to suppress), and the session is anchored to it.
- **Regular groups in `chat` mode**: no new thread; the turn folds into that group's single chat-scope session (appending a turn if one already exists).

### 4.3 `chatId` + `rootMessageId` → into an existing thread

The task is appended to that thread; no seed is posted. Validation:

- Without `sessionId`, `chatId` must also be present, otherwise 400 `target_required`.
- Message not visible / chat_id unreadable → 400 `target_required`.
- The message does **not** belong to the `chatId` you passed → `chat_not_allowed` (⚠️ see §11.3 — on this endpoint that code currently lands as **500**).

### 4.4 `sessionId` → append a turn to an existing session

`chatId` is inherited from that session; you do not need to pass it. Unknown session → **404 `session_not_found`**. If the target session is still finishing its **opening activation**, the turn is rejected **retryably** (`trigger_failed`, with `session activation in progress` in the message) — just retry shortly.

### 4.5 Delivery matrix: what the group actually sees

| Target × mode | Topic seed | Streaming card | Final answer to Feishu | Final answer to HTTP |
|---|:---:|:---:|:---:|:---:|
| virtual + sync/async | ✗ | ✗ | ✗ | ✓ |
| real group + fire-and-forget | ✓ (topic groups) | ✓ | ✓ | ✗ |
| **real group + sync/async** | ✓ (topic groups) | ✓ | **✗** | ✓ |
| existing thread + fire-and-forget | ✗ | ✓ | ✓ | ✗ |
| **existing thread + sync/async** | ✗ | ✓ | **✗** | ✓ |

> ⚠️ **The two bold rows are the easiest trap.** Running wait/async against a real group means members watch the thread open and watch the bot work in the streaming card, **but the final reply never arrives** — the final output is intercepted inside the daemon by the sync/async channel and returned to the HTTP caller instead of being posted as a Feishu message. If you want the group to see the answer too, either use fire-and-forget, or have your program post `output.content` back to the group itself.

### 4.6 "Auto-create a group" is not on this endpoint

`/api/trigger` has **no** "spin up a fresh group per event" capability — `chatId` must be an existing group. That capability exists only as the [Webhook connector](/en/webhook)'s "new group each time" delivery mode (which also pulls the bot's authorized users in automatically and supports dedupe by a dot-path into the event body). Use a connector for that; do not look for it here.

### 4.7 Two behavioral differences from interactive sessions

- **No worktree is built**: even when the bot has "auto-create worktree" enabled, sync / async / virtual sessions **always run directly in the base directory**. This is deliberate — creating a worktree per programmatic request-response call is both counter-intuitive and leaky (nothing reclaims them). Only the "real group + fire-and-forget + resolved from the bot's own default directory" shape (i.e. the plain-webhook shape) goes through auto-worktree.
- **A shorter working-directory ladder**: HTTP triggers resolve `oncall-bound dir → bot defaultWorkingDir (including defaultOncall.workingDir) → bot workingDir → ~`. Unlike an interactive session, it does **not** consult sibling-session inheritance (`botToBotSameDir` / "bot@bot same dir" has no effect on this path), and a group is never auto-bound to oncall here.
  > Unlike the previous item, this difference carries **no explanatory comment in the source**, and whether it is intended is still undecided — if you need directory semantics identical to an interactive session, pin the directory explicitly rather than relying on inheritance.

---

## 5. Execution modes

### 5.1 Sync (`waitForFinalOutput`)

```bash
curl -X POST "http://<host>:7891/api/trigger" \
  -H 'content-type: application/json' \
  -H "Cookie: botmux_dashboard_token=$TOKEN" \
  -d '{
    "source":{"type":"webhook"},
    "target":{"kind":"turn","botId":"cli_xxx"},
    "instruction":"Reply with exactly one line: SYNC_DEMO_OK",
    "envelope":{"format":"json","sourceName":"demo","trusted":false},
    "options":{"waitForFinalOutput":true,"timeoutMs":60000}
  }'
```

Response (HTTP 200; one request, one result, in `output.content`):

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

> Waiting past `timeoutMs` returns **HTTP 504** + `errorCode:"wait_timeout"`. The task **does keep running in the background** — only this HTTP call ended. In sync mode the `sessionId` is only returned on completion, so the timeout response does not carry one: **a timeout means you lose the handle.** If you need a fallback query path, use async mode.

### 5.2 Async (`asyncReturnSessionId`)

```bash
curl -X POST "http://<host>:7891/api/trigger" \
  -H 'content-type: application/json' \
  -H "Cookie: botmux_dashboard_token=$TOKEN" \
  -d '{
    "source":{"type":"webhook"},
    "target":{"kind":"turn","botId":"cli_xxx"},
    "instruction":"Reply with exactly one line: ASYNC_DEMO_OK",
    "envelope":{"format":"json","sourceName":"demo","trusted":false},
    "options":{"asyncReturnSessionId":true}
  }'
```

Response (HTTP 200, immediate; **keep `target.sessionId` as your correlation key**):

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

> **Async is the recommended mode for production task scheduling**: you get a `sessionId` immediately, you can poll, you can cancel, and results survive a daemon restart (§8, §9).

### 5.3 Fire-and-forget (neither mode flag)

Requires one of `chatId` / `sessionId` / `rootMessageId` (otherwise 400 `target_required`). Returns immediately (`action` is `queued` or `delivered`, see §10.1); the output goes out through the **normal Feishu reply path**.

> ⚠️ **This mode records no async entry.** Polling `trigger-result` by `sessionId` will only ever show `running`, turning into `failed`/`no_output` once the session closes — **it never becomes `completed`, and you never get `output.content`**. Its only output channel is Feishu. Use sync or async if you need the result programmatically.

### 5.4 `dryRun`: render without dispatching

With `options.dryRun=true` nothing is created and nothing is dispatched:

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

`promptPreview` is the **exact prompt that would be fed to the model** (truncated past 4000 chars with `\n...[truncated]` appended). `message` distinguishes the two landing shapes: an existing session gives `would inject into existing session`, otherwise `would create or deliver a new session turn`.

> Note: `dry_run` is an **`action`, not an error code**. The error-code enum does contain a `dry_run` value, but nothing ever emits it.

### 5.5 `steer`: inject a follow-up into the running turn (codex-app native `turn/steer`)

`options.steer=true` authorizes the daemon to merge a new message INTO the currently active codex-app turn instead of queueing it as a serial follow-up — useful for headless callers that want to adjust a task while it is still running ("also handle X", "stop that and do Y").

It is a **best-effort authorization, not a guarantee**:

- **Fresh turn**: pass it on the first request too. The opening turn is marked steerable; the codex `canSteer` contract requires BOTH the root and the follow-up head to be explicitly authorized.
- **Follow-up while a turn is live**: the runner injects the message into the active turn via native `turn/steer`. If injection is not possible at that instant (no active turn / turn already closing / review or compaction turn / worker cold-starting), the request **silently degrades to an ordinary queued follow-up** — acceptance never fails because of `steer` alone.
- **Non-codex-app CLIs**: the flag is a no-op; the existing type-ahead queue semantics apply.

The response echoes `steer: true` only when the request was actually accepted for dispatch (not on an idempotent reuse). The echo confirms the daemon carried the authorization — it does NOT mean a `turn/steer` RPC was already admitted by the runner.

**Result attribution for a merged group.** When several steered messages merge, codex produces ONE merged final for the whole group: earlier members receive an empty `steer_superseded` marker and only the newest trigger owns the real final + token usage. The daemon makes every earlier HTTP member resolve with the SAME merged content:

- `http_async`: the parked member's `trigger-result` eventually reports `completed` with the merged `output.content` and **no `usage`** (usage is recorded against the newest trigger only). The park relation is also persisted, so a daemon restart in the merge window resolves the parked member by walking to the group's terminal record.
- `http_wait`: the parked sync request resolves with the merged content as soon as the real final lands. Wait mode remains in-memory only (its existing contract); if the daemon restarts mid-group the parked wait simply hits its own timeout.

`steer` is mutually exclusive with `dryRun` (there is no dispatch to steer into) → 400 `bad_request`. It adds no route or capability: `/api/trigger` stays the loopback, drive-your-own-turn surface, and steering only ever injects into the SAME tenant's own turn.

---

## 6. The empty-answer contract (`BOTMUX_NOTHING_TO_SEND`)

In sync and async modes (**on both the first turn and follow-up turns**), the daemon appends a `<botmux_http_response_mode trusted="true">` block to the prompt saying, in substance:

- Your entire reply is **returned verbatim to a program**, not shown in a chat.
- **Output only the final answer** — no preamble, no meta-commentary, nothing about these routing headers / system context.
- Do not call `botmux send`; do not post to Feishu/Lark.
- **If you have nothing to answer, output only the single token `BOTMUX_NOTHING_TO_SEND`** — the program receives an empty result.

That sentinel is **part of the settlement contract**, not decoration:

| Mode | When the model emits only the sentinel |
|------|----------------------------------------|
| **Async** | Settles as `state:"completed"` with an **empty string** `output.content`, and is persisted |
| **Sync** | **There is no matching settle path** — the turn hangs until `timeoutMs` and ends in **504 `wait_timeout`** |

> ⚠️ This is the **only semantic asymmetry** between sync and async. If your task **may legitimately have nothing to answer** (conditional triggers, health sweeps, "only report if there's a problem"), use **async mode**; otherwise every "nothing happened" costs you a full timeout. If you must use sync, set `timeoutMs` to a tolerable low value.

**Body + trailing sentinel ≠ silence**: if the model writes a real answer and then appends the sentinel on its own line, the answer is returned normally and the token is stripped. Only "nothing but the sentinel" counts as genuine silence.

**About preamble**: the prompt above already steers the model to emit only the final answer, and the vast majority of replies are clean — but this is prompt-level steering, not a hard guarantee. See §14.

---

## 7. Idempotency keys

### 7.1 `options.idempotencyKey` (fresh sessions)

**The problem**: if the HTTP response to an async trigger is lost in the network (while the daemon did create the session and the task is already running), your retry creates a **brand-new session** and runs the same task **a second time** — duplicated external side effects (two messages sent, a migration run twice…). Your own dedupe cannot help: the first session really is executing.

**The fix**: pass a key you generate stably and **persist before issuing the trigger**. A retry with the same key returns **the same session/triggerId, with no new session and no second dispatch**:

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

A hit on an existing key responds with `idempotent:true` (reused, nothing dispatched); the first creation carries `idempotent:false`. With the (reused or new) `sessionId` in hand, poll `trigger-result` as usual — **no separate lookup endpoint is needed**.

**Scope (important)**: only **fresh async virtual** triggers are supported, i.e. `target.kind:"turn"` + `options.asyncReturnSessionId:true`, **without** `target.sessionId` / `rootMessageId` / `chatId` and without `waitForFinalOutput` / `dryRun`. Any other combination carrying the key is a **400** (the lease is implemented only on that one seam; the API refuses to imply idempotency on paths that do not have it).

**Same key, different payload → 409 `idempotency_conflict`**: the key binds to its **entire business payload** — `instruction`, `envelope`, `source`, `presentation`, and **all of `options` except `idempotencyKey` itself**. So changing any one of `model`, `status`, `dedupKey`, `timeoutMs` makes a same-key request 409. Always **retry with the same key AND the same payload**.

**Crash semantics (at-most-once)**: before the real dispatch, the daemon durably marks that key's lease `attempting` (the commit-unknown barrier). If the daemon crashes exactly between "dispatch started" and "completion evidence obtained", it **does not blindly re-dispatch** on restart — the key converges to a terminal state and `trigger-result` reports `failed` (`no_output`, meaning "the previous dispatch outcome is unknown; not re-run under at-most-once"). Your recovery should treat that as **Failed**.

**Retention**: the key → session mapping is append-only, so a late retry after completion still reuses the same session.

### 7.2 `options.turnIdempotencyKey` (follow-up turns)

`idempotencyKey` above covers **fresh sessions** only. When **appending a turn to an existing session** (with `target.sessionId`), use this key instead — if the HTTP response for the appended turn is lost, you cannot tell whether the daemon accepted it, and a retry may **inject it twice**.

```bash
curl -X POST "http://<host>:7891/api/trigger" -H 'content-type: application/json' \
  -H "Cookie: botmux_dashboard_token=$TOKEN" \
  -d '{
    "source":{"type":"webhook"},
    "target":{"kind":"turn","botId":"cli_xxx","sessionId":"<existing session>"},
    "instruction":"...",
    "envelope":{"format":"json","sourceName":"demo","trusted":false},
    "options":{"asyncReturnSessionId":true, "turnIdempotencyKey":"my-followup-7"}
  }'
```

A same-key retry against the same session resolves to **the same turn (same `triggerId`), with no second injection**, and responds with `idempotent:true`.

**Scope**: `target.kind:"turn"` + `target.sessionId` + `asyncReturnSessionId:true`, without `waitForFinalOutput` / `dryRun`.

**Mutually exclusive with `idempotencyKey`**: sending both is a **400** (this exclusivity check deliberately runs *before* either key's own scope check, so whatever your target shape is you get the precise "mutually exclusive" error rather than one masked by a scope lock). The two live in **separate, non-colliding key spaces** — even identical strings never share a lease.

**Same key, different payload → 409**; the **crash semantics** and **retention** policy are identical to `idempotencyKey`.

---

## 8. Polling the result (four-state contract)

In async mode, poll by `sessionId`:

```
GET /api/sessions/:sessionId/trigger-result
   (optional ?triggerId=<trg_...> to match one specific trigger; otherwise the session's latest)
```

**All four states return HTTP 200 with `ok:true`; read the task state from `state` alone — never from `ok` or the HTTP status.**

| `state` | Meaning | What to do | Key fields |
|---------|---------|------------|------------|
| `running` | Still running | Keep polling | `action:"queued"`, `async.status:"pending"` |
| `completed` | Final output available | Settle; read `output.content` | `output.content`, `finishedAt`, `usage?` |
| `failed` | Session ended without captured output (soft terminal) | See 8.2 | `errorCode`, `error`, `finishedAt` |
| `not_found` | No such session | See 8.3 | `errorCode:"session_not_found"` |

A `completed` response (`usage` appears for codex-app only, and only when collected):

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

About `usage` (this turn's token usage, four disjoint buckets):
- Present for **codex-app tasks only**, and only when usage was successfully collected this turn. Other CLIs (including plain codex), or a failed collection, **omit the whole block**.
- **omit ≠ 0**: when usage is unavailable the field is absent rather than four zeros — treat "field missing" as "unknown".
- Buckets: `inputTokens` (net new input, cache read/write already deducted), `outputTokens`, `cacheReadTokens`, `cacheCreateTokens`, all per-turn deltas (not session totals).
- **Persisted across restarts**: querying a finished session after a daemon restart restores `usage` alongside `output` from disk.

### 8.1 Which triggers are pollable

| Trigger shape | Can reach `completed` |
|---------------|:---------------------:|
| Async mode (any target) | ✓ |
| Sync mode | ✗ (the result is in the trigger response; polling shows session state) |
| Fire-and-forget | ✗ (see §5.3 — stays `running`, then `failed` once closed) |

### 8.2 `failed` is a soft terminal — do not declare death immediately

`failed` has three sources, distinguishable by `errorCode`:

| `errorCode` | Source |
|-------------|--------|
| `no_output` | The session ended with no captured final output — **could be a real failure, or simply that you closed/cancelled it** |
| `no_output` (with `previous dispatch was interrupted` in `error`) | At-most-once convergence of an ambiguous crash; deliberately not re-run |
| `trigger_failed` | The worker explicitly reported a terminal failure (`error` contains `worker reported terminal failure:`) |

Recommendations:
- **Decide "cancelled" from your own intent** (you recorded it when you issued the cancel); do not infer it from this `failed`.
- Treat a `no_output` `failed` as a soft terminal needing a second look: mark it for reconciliation, confirm there really is no output and that you did not cancel it, then settle as failed.

### 8.3 The two physical forms of `not_found`

Callers go through the dashboard proxy, so `not_found` shows up in two shapes; **normalize both to the not_found terminal**:

1. `HTTP 404` + `{ "ok": false, "error": "unknown_session" }` — short-circuited at the proxy (the aggregator has never seen that sessionId; usually an invalid/expired id).
2. `HTTP 200` + `{ "ok": true, "state": "not_found" }` — the request reached the daemon, which found no such session on disk.

### 8.4 A precise `?triggerId=` miss

If the session exists but never had the `triggerId` you named → `ok:false` + `errorCode:"bad_request"`, and **no `state` field in the response**. That is a **malformed lookup**, not one of the four states; do not confuse it with `state:"not_found"`.

### 8.5 ⚠️ The other polling path has a different shape

Everything above describes the **native four-state contract** (raw dashboard proxy → task-orchestrator callers). The [Webhook connector](/en/webhook)'s own async-poll route goes through a **legacy-consumer adapter**: it rewrites `failed` and `not_found` to `ok:false` and turns HTTP 200 into **404** (the `.state` field is preserved).

If you use this page's `/api/sessions/:id/trigger-result`, **that rewrite does not apply to you** — but a client wired to both paths must handle each shape on its own terms.

---

## 9. Restart survival, cancellation

### 9.1 Restart survival guarantee

**After a daemon restart, an async task that already finished still answers `completed` (with `output.content`) — it is never mis-reported as `not_found`.**

Async results are persisted to disk on completion (`data/async-triggers/<sessionId>.json`), and polling reads the persisted result first rather than relying on in-memory state. Therefore:

- Your recovery logic **must not** declare a task lost just because one query came back empty.
- Only "the proxy confirms unknown (`unknown_session`)" **plus** "your own lease/deadline has also expired" should trigger compensation.

### 9.2 Cancelling a task

```bash
curl -X POST "http://<host>:7891/api/sessions/:sessionId/close" \
  -H "Cookie: botmux_dashboard_token=$TOKEN"
# → { "ok": true, "alreadyClosed": false }
```

> `close` means **close the whole session**, not "interrupt the current turn". For a one-shot virtual async session (one session, one turn) the two are equivalent; be careful with **real group sessions**, where other people may still be using it.

Polling that `sessionId` after cancelling returns `state:"failed"` (`no_output`) if it produced nothing before closing. **That is expected** — settle it as `cancelled` based on your own intent.

---

## 10. Response fields

| Field | When it appears |
|-------|-----------------|
| `ok` | Always. **Note**: a `failed` terminal is `ok:false` + HTTP 200 on the trigger endpoint, and `ok:true` + HTTP 200 on the polling endpoint |
| `triggerId` | Almost always (`trg_<uuid>`) |
| `action` | `queued` / `delivered` / `completed` / `dry_run`; see §10.1 for how each pairs with `message`. The enum also has `ignored`, emitted **only by the webhook connector's idempotent fold** — never by this endpoint |
| `state` | Polling responses (the four states). On trigger responses only when idempotency converges to a terminal |
| `target` | `{ kind, sessionId?, chatId?, workflowRunId? }` |
| `output.content` | Sync completion, or polling reaching `completed` |
| `usage` | See §8 |
| `async` | `{ status: 'pending'\|'completed', sessionId, completedAt? }` |
| `finishedAt` | ISO8601 for `completed` / `failed` |
| `message` | Human-readable note (`queued new session turn`, `delivered to existing session and completed`, …) |
| `errorCode` / `error` | On failure, see §11 |
| `promptPreview` | `dryRun` only |
| `idempotent` | With an idempotency key: `true` means an existing session/turn was reused, `false`/absent means first creation |
| `idempotencyKey` / `turnIdempotencyKey` | Echo of the key you sent |
| `reason` / `targetWorkflowId` / `targetRevisionId` | Retired workflow targets only |
| `idempotency` | `{ key, action:'accepted'\|'duplicate', firstTriggerId? }` — the **webhook connector's** duplicate-delivery suppression result, unrelated to `options.idempotencyKey` |
| `readOnlyUrl` / `viewToken` | Core-only deployments (`BOTMUX_CORE_ONLY=1`) with a live worker terminal: a read-only terminal link on polling responses |

### 10.1 `action` + `message` pairs

| `action` | `message` | Trigger shape |
|----------|-----------|---------------|
| `delivered` | `delivered to existing session` | Fire-and-forget into an existing session whose worker is alive |
| `queued` | `durably queued behind the existing activation` | Same, but that session is still activating, so the turn is durably queued |
| `queued` | `queued existing session turn` | Fire-and-forget into an existing session whose worker is dormant (needs a re-fork) |
| `queued` | `delivered to existing session; poll by sessionId or triggerId for final output` | Async + existing session |
| `queued` | `queued new session turn` | Fire-and-forget, new session |
| `queued` | `queued new session turn (building worktree)` | Same, while a worktree is being built |
| `queued` | `queued new session turn; poll by sessionId or triggerId for final output` | Async + new session |
| `completed` | `delivered to existing session and completed` | Sync + existing session |
| `completed` | `queued new session turn and completed` | Sync + new session |
| `dry_run` | `would inject into existing session` / `would create or deliver a new session turn` | `dryRun` |

> `action` describes the **dispatch outcome**, not task success: both `delivered` and `queued` only mean "accepted". There are exactly two ways to obtain output — sync's `output.content`, or polling async to `completed`.

---

## 11. HTTP status and error codes

### 11.1 Status mapping

**Proxy layer (dashboard)**

| Status | `errorCode` | Condition |
|:------:|-------------|-----------|
| 400 | `bad_json` | Malformed JSON (`invalid JSON body`), or a body over 512 KiB (`request body too large`) |
| 400 | `target_required` | Missing `target.botId` |
| 400 | various | Rejected by validation (see §3) |
| 502 | `daemon_offline` | The proxy call threw |
| 503 | `daemon_offline` | The target daemon is not registered |

**Daemon layer**

| Status | `errorCode` | Condition |
|:------:|-------------|-----------|
| 200 | — | `ok:true` (`queued` / `delivered` / `completed` / `dry_run`) |
| 200 | `no_output` etc. | `ok:false` with `state:"failed"` — **a successful HTTP call reporting a terminal state**; read `state` |
| 400 | `bad_json` | Malformed JSON |
| 400 | `bad_request` / `target_required` | Validation failure, or an apiOnly shape violation |
| 400 | `bot_not_found` | `target.botId` does not match this daemon |
| 403 | `bot_not_in_chat` | The bot is not in the target group |
| 404 | `session_not_found` | No active session for `target.sessionId` |
| 409 | `idempotency_conflict` | Same key, different payload |
| 410 | `legacy_workflow_retired` | `target.kind:"workflow"` (retired) |
| 503 | `bot_not_found` / `trigger_failed` | Daemon not ready (appId unset / session registry unavailable) |
| 504 | `wait_timeout` | Sync wait timed out |
| 500 | `trigger_failed` etc. | Unclassified failure (including `chat_not_allowed`, see 11.3) |

### 11.2 Full error-code list (20, grouped by owner)

**Reachable on this endpoint (13)**

`bad_json`, `bad_request`, `bot_not_found`, `bot_not_in_chat`, `chat_not_allowed`, `daemon_offline`, `idempotency_conflict`, `legacy_workflow_retired`, `no_output`, `session_not_found`, `target_required`, `trigger_failed`, `wait_timeout`

**[Webhook connector](/en/webhook) only (5)**

| Code | Status | Meaning |
|------|:------:|---------|
| `invalid_signature` | 401 | Token or HMAC verification failed |
| `replay` | 401 | Signature timestamp outside the tolerance window |
| `rate_limited` | 429 | Connector rate limit exceeded |
| `group_create_failed` | 501 / 502 | "New group each time" mode failed to create the group |
| `lifecycle_extract_failed` | 400 | A dedupe field is configured but absent from the event body |

**In the enum but never emitted (2)**

- `dry_run` — `dryRun` produces an `action`, not an error.
- `workflow_trigger_not_implemented` — the daemon route's 410 fires first, making it structurally unreachable.

### 11.3 A known inconsistency

`chat_not_allowed` (the `rootMessageId` does not belong to the `chatId` you passed) **is missing from the daemon's status ladder**, so it falls through to the catch-all **HTTP 500** — while the webhook connector answers 403 for the same code. On this endpoint, do not treat every 500 as "server fault, retry": read `errorCode` first; `chat_not_allowed` is a **request error and retrying will not help**.

---

## 12. Transport limits

- **512 KiB request body cap**, enforced only at the dashboard proxy (over the cap → 400 `bad_json` / `request body too large`). Internal callers hitting the daemon IPC directly are not subject to it.
- **There is no proxy-side timeout on the dashboard→daemon hop.** In sync mode, `timeoutMs: 300000` really will hold the HTTP connection for a full 5 minutes, bounded only by the daemon's own timer. **Clients must set their own connect/read timeouts** — do not expect the proxy to cut it for you.
- **Four hard constraints for apiOnly (core-only) bots**, each violation a 400 `bad_request`:
  1. `waitForFinalOutput` or `asyncReturnSessionId` is required;
  2. `rootMessageId` is not allowed;
  3. a real `chatId` is not allowed;
  4. `sessionId`, if given, must point at that bot's own HTTP virtual session.

---

## 13. Client pseudocode

```ts
// Minimal skeleton: trigger, then poll to a terminal state
async function runAndAwait(instruction: string, botId: string): Promise<Result> {
  // 1) Async trigger; keep the sessionId
  const trg = await post('/api/trigger', {
    source: { type: 'webhook' },
    target: { kind: 'turn', botId },
    instruction,
    envelope: { format: 'json', sourceName: 'my-system', trusted: false },
    options: { asyncReturnSessionId: true },
  });
  const sessionId = trg.target.sessionId;

  // 2) Poll; look only at state
  for (;;) {
    const r = await getTriggerResult(sessionId); // classification below
    switch (r.state) {
      case 'running':   await sleep(3000); continue;
      case 'unknown':   await sleep(3000); continue; // retryable: network/timeout/5xx/non-JSON; the task may still be running
      case 'completed': return { ok: true, content: r.output?.content ?? '' }; // ⚠️ an empty string is a valid result
      case 'failed':    return { ok: false, needsReconcile: true }; // soft terminal; reconcile
      case 'not_found': return { ok: false, notFound: true };        // terminal: confirmed absent
      case 'error':     return { ok: false, fatal: true, why: r.why }; // terminal: request/auth error, retrying won't help
    }
  }
}

// getTriggerResult sorts responses into 5 classes. The crucial part is never
// confusing "unknown / retryable" with "definitely terminal":
//  - not_found  : confirmed absent → terminal ((a) 404 unknown_session; (b) 200 state:not_found)
//  - completed/running/failed : the daemon's four states, passed through
//  - error      : request error (400) / auth (401/403) → terminal, retrying is pointless
//  - unknown    : network error/timeout/5xx/502/non-JSON → retryable; the task may still be running
async function getTriggerResult(sessionId: string) {
  let res: Response;
  try {
    res = await fetch(`/api/sessions/${sessionId}/trigger-result`, { headers: cookie() });
  } catch (e) {
    // fetch threw: unreachable / DNS / reset / timeout → retryable
    return { state: 'unknown', why: `network: ${String(e)}` };
  }

  // Auth errors: token invalid/unauthorized → terminal (a retry is refused too); escalate to a human
  if (res.status === 401 || res.status === 403) return { state: 'error', why: `auth ${res.status}` };

  // Proxy short-circuit / adapter 404
  if (res.status === 404) {
    const b = await res.json().catch(() => ({}));
    if (b?.error === 'unknown_session') return { state: 'not_found' }; // (a) confirmed absent
    if (b?.state === 'not_found') return { state: 'not_found' };       // (b) adapter-translated absent
    if (b?.state) return b; // adapter turning failed etc. into 404: follow the body's state (§8.5)
    // ⚠️ Any OTHER 404 (gateway/legacy-route HTML, non-JSON → parsed as {}) is **not** a confirmed
    // absence. Treat it as retryable unknown — otherwise a flaky gateway looks like a lost task,
    // and your compensation re-dispatches it: double execution.
    return { state: 'unknown', why: 'opaque 404' };
  }

  // Request errors, e.g. the 400 bad_request from a precise triggerId miss (no state field, §8.4) → terminal
  if (res.status === 400) return { state: 'error', why: 'bad_request' };

  // 5xx / 502 daemon unreachable → retryable (the task may still be running; never treat as absent)
  if (res.status >= 500) return { state: 'unknown', why: `upstream ${res.status}` };

  // 2xx: parse JSON; non-JSON (gateway HTML, etc.) is retryable unknown
  let body: any;
  try { body = await res.json(); } catch { return { state: 'unknown', why: 'non-json 2xx' }; }
  if (body?.state) return body; // { state, output?, errorCode?, finishedAt? }
  return { state: 'unknown', why: 'no state field' };
}
```

Robustness notes (all straight from the measured contract):

- Clamp `timeoutMs` into `[1000, 300000]` before sending, and **set your own HTTP client timeout** (§12).
- Treat sync `504/wait_timeout` as "possibly still running", but remember the response carries **no `sessionId`**, so there is no fallback query — if that matters, use async.
- `output.content` on `completed` **may be an empty string** (the model judged that no answer was needed, §6). That is a valid terminal, not a failure.
- Sort polling results into the 5 classes above; never blur "retryable" into "terminal". **not_found** (404 unknown_session / `state:not_found`) and **error** (400 request errors, 401/403 auth) are terminal; **unknown** (network error, timeout, 5xx, 502, non-JSON) is retryable — the task may still be running, and compensating as if it were absent causes duplicate execution.
- On a **500** from this endpoint, read `errorCode` first: `chat_not_allowed` is a request error and retrying will not help (§11.3).
- Wrap both `fetch` and `res.json()` in try/catch so an exception never breaks the polling loop.

---

## 14. Known items

- **Async result files are not reclaimed yet**: `data/async-triggers/<sessionId>.json` is append-only (deliberately — otherwise a `completed` result would be lost once the session closes, breaking restart survival). The upside is that `completed` stays queryable even if the session record is later cleaned up; the cost is that files accumulate. A conservative TTL sweep (only files finished more than N days ago) is planned; this page will be updated then.

- **`output.content` may rarely carry a preamble**: botmux already steers the model at the source (the HTTP response-mode block in §6) to emit only the final answer with no preamble or meta-reasoning, and the vast majority of replies are clean. But this is prompt-level steering, not a hard guarantee. If you render `output.content` directly to users and need it "absolutely clean", add a **conservative trim** at the **presentation layer** as a backstop:
  - ✅ Strip only **known deterministic preamble prefixes** (trim only on matching a fixed pattern such as `This is a system routing header…` / `here's my answer:`, and keep **everything** after it).
  - ❌ **Do not** use aggressive heuristics like "take only the last non-empty paragraph" — `output.content` may legitimately be multi-paragraph (bulleted answers, code blocks), and aggressive truncation deletes the answer, a far worse correctness problem than an occasional preamble.
  - Trim at the **presentation layer** only; **persist/audit/replay the raw `content`**.

- **Sync mode times out on genuine silence** (§6). Async mode does not have this problem.

- **`chat_not_allowed` maps to 500 on this endpoint** (§11.3), inconsistent with the webhook connector's 403.

- **`source.type` is not validated** (§3.1); `envelope.format`, `options.dedupKey` and `options.status` have no readers (§3.5).

---

## Appendix: endpoint cheatsheet

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/trigger` | POST | Trigger a task (execution mode from `options`, delivery target from `target`) |
| `/api/sessions/:id/trigger-result` | GET | Poll an async result (four states; optional `?triggerId=`) |
| `/api/sessions/:id` | GET | Session metadata (status, title, …) |
| `/api/sessions/:id/close` | POST | Cancel / close a session |

For "spin up a fresh group per event", see the [Webhook connector](/en/webhook) — that is its own delivery mode and does not exist on this endpoint.
