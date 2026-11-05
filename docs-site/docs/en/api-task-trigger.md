# Trigger botmux Tasks via API

> Want an external system (task orchestrator, CI, backend service…) to hand an instruction to a botmux bot and get the result back programmatically? Use `POST /api/trigger`. The bot runs its CLI as usual; the task can stay entirely out of Feishu, or land in a real group or thread.

This page is for **client developers**. The first three sections cover the common case; the rest is the full reference for fields, status codes and edge cases — look things up as you need them.

---

## 1. Quick start

The most common pattern: **trigger async → poll for the result**, without touching Feishu at all.

**Step 1: get a token.** Run `botmux dashboard`. The part after `?t=` in the printed login URL is your token (see §3).

**Step 2: trigger the task.**

```bash
curl -X POST "http://<daemon-host>:7891/api/trigger" \
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

`botId` is the target bot's Feishu app ID (`larkAppId` in `bots.json`). The response comes back immediately — keep `target.sessionId`:

```json
{
  "ok": true,
  "triggerId": "trg_87e7b415-...",
  "action": "queued",
  "target": { "kind": "turn", "sessionId": "2eed60c4-...", "chatId": "http_async_..." },
  "async": { "status": "pending", "sessionId": "2eed60c4-..." }
}
```

**Step 3: poll for the result.**

```bash
curl "http://<daemon-host>:7891/api/sessions/2eed60c4-.../trigger-result" \
  -H "Cookie: botmux_dashboard_token=$TOKEN"
```

Look at `state`: on `running`, check again in a few seconds; on `completed`, the answer is in `output.content`. All states are in §9.

---

## 2. Two decisions: how you get the result, and where it lands

A trigger is defined by two **independent** dimensions. **Whether the task enters a Feishu group is decided only by `target`, not by sync vs async.**

**How you get the result (`options`)**

| Mode | How | HTTP behavior | Pollable | Stoppable |
|------|-----|---------------|:--------:|:---------:|
| **Async** (recommended) | `asyncReturnSessionId: true` | Returns a `sessionId` immediately | ✓ | ✓ |
| **Sync** | `waitForFinalOutput: true` | Holds the connection until output or timeout | — | ✗ |
| **Fire-and-forget** | neither flag | Returns immediately; the answer goes out as a normal Feishu reply | ✗ (see §6.3) | Close the session only |

**Where it lands (`target`)**

| Shape | What to pass | Lands on |
|-------|--------------|----------|
| **Virtual session** | none of `chatId` / `sessionId` / `rootMessageId` | A synthetic session that never enters Feishu |
| **Real group** | `chatId` | A real session in that group |
| **Existing thread** | `chatId` + `rootMessageId` | Appended to that thread |
| **Existing session** | `sessionId` | A new turn on that session |

Common combinations:

| You want to… | Use |
|--------------|-----|
| Run a pure background task with zero Feishu noise | virtual + async (or sync) |
| Drop an event into a group like a webhook and have the answer posted there | real group + fire-and-forget |
| Let the group watch the bot work, but hand the answer to your program | real group + async/sync (⚠️ the group never sees the final answer, see §5.5) |
| Ask follow-ups on the same session | existing session + async, with `turnIdempotencyKey` |

> Hard rule: **if you pass none of the three target fields, you must enable async or sync**, otherwise 400 `target_required` — the task would have neither a Feishu exit nor an HTTP exit.

---

## 3. Authentication

Requests go to the Dashboard (default port `7891`) and use the Dashboard login token:

- **Send the token as a cookie**: `Cookie: botmux_dashboard_token=<TOKEN>`.
- ⚠️ Don't use `?t=<TOKEN>`: that's for browser login. It answers with a **302 redirect** that sets a cookie, so programmatic calls fail.
- Get the token by running `botmux dashboard`. If there's no token yet, it creates one.
- The token stays valid until you run `botmux dashboard rotate` to replace it (the old one stops working immediately).

---

## 4. Request body

```jsonc
{
  "source":   { "type": "webhook" },                  // see 4.1
  "target":   { "kind": "turn", "botId": "cli_xxx" }, // see 4.2
  "instruction": "What you want the bot to do",       // trusted; rendered as the top-level task
  "envelope": {                                        // see 4.3
    "format": "json",
    "sourceName": "your-system",
    "trusted": false                                   // must be false
  },
  "presentation": { "title": "…", "topicMessage": "…" },  // optional, see 4.4
  "options": { /* see 4.5 */ }
}
```

### 4.1 `source`

| Field | Required | Notes |
|-------|:--------:|-------|
| `type` | ✓ | Only `webhook` / `ui` / `workflow` / `schedule` / `vc_meeting` / `headless`; anything else (including typos) is 400 `bad_request` |
| `connectorId` | | Connector ID; used for the default title when `envelope.sourceName` is missing |
| `requestId` | | Your request ID; written to the call log |
| `receivedAt` | | When the upstream received the event |

For ordinary external calls, **always use `"webhook"`**. Only two values change behavior: `headless` (takes the local headless path, see [Headless Automation Sessions](/en/headless-session)) and `vc_meeting` (compact rendering of event content).

### 4.2 `target`

| Field | Required | Notes |
|-------|:--------:|-------|
| `kind` | ✓ | Use `"turn"`. `"workflow"` is retired and returns **410 `legacy_workflow_retired`** |
| `botId` | ✓ | The target bot's `larkAppId`. Missing → 400 `target_required`; doesn't match the target daemon → 400 `bot_not_found` |
| `chatId` | | A real group ID, see §5.2 |
| `sessionId` | | Continue an existing session. Not found → 404 `session_not_found` |
| `rootMessageId` | | Root message ID of an existing thread. Without `sessionId`, **`chatId` is also required** |

### 4.3 `envelope` (external event data, untrusted by default)

| Field | Required | Notes |
|-------|:--------:|-------|
| `sourceName` | ✓ | Your system's name; used for the default title and topic seed |
| `trusted` | ✓ | **Must be literally `false`** |
| `format` | ✓ | Informational; use `"json"` (the daemon doesn't read it) |
| `headers` | | Raw request headers |
| `payload` | | Raw event body |
| `rawText` | | Raw text |

Why `trusted` must be `false`: prompt-injection protection. The daemon wraps the whole envelope as "untrusted external data" and tells the model not to follow instructions hidden inside it. **Put what you actually want the bot to do in the top-level `instruction`** — it's rendered as a trusted task above the event data.

> Exception: when a [Webhook connector](/en/webhook) enables "treat event content as trusted instructions", the Dashboard adds a top-level `payloadTrusted: true` when forwarding (`envelope.trusted` stays `false`), and the event content is rendered as a trusted task. It's only accepted with `source.type: "webhook"` + `target.kind: "turn"`; other combinations get 400. You don't need it when calling this API directly — just put the task in `instruction`.

### 4.4 `presentation` (optional; how it shows up in Feishu)

| Field | Values | Default / notes |
|-------|--------|-----------------|
| `title` | 1–200 chars | Session title (Dashboard / thread name), truncated to 50 chars. Default `[External] <sourceName>` |
| `topicMessage` | 1–200 chars, or `null` | The seed message posted when a new thread is opened. Default `外部事件触发：{sourceName}` ("External event: …"); `null` means no seed |
| `thinking` | `"hidden"` | Hides only this turn's "thinking" bubble; business messages and the HTTP result are unaffected |
| `liveCard` | `"on-start"` | Only for chat-level sessions in regular groups: posts a fresh streaming card once this turn's input is actually handed to the CLI |

- A non-empty explicit `topicMessage` asks for a dedicated thread (except in regular groups in `shared` mode, which keep the shared session).
- `title` and `topicMessage` **only matter when a new thread is opened**: virtual sessions post nothing to Feishu, and existing threads/sessions get no seed.
- Out of range (empty, over 200 chars, wrong type) → 400 `bad_request`.

### 4.5 `options`

**Common fields**

| Field | Validation | Notes |
|-------|------------|-------|
| `asyncReturnSessionId` | boolean | Async mode |
| `waitForFinalOutput` | boolean | Sync mode. Both together → 400 |
| `timeoutMs` | `1000`–`300000` | Sync wait limit, default `120000` (2 minutes) |
| `idempotencyKey` | non-empty, ≤200 chars | Prevent duplicate new sessions, see §8.1 |
| `turnIdempotencyKey` | non-empty, ≤200 chars | Prevent duplicate follow-up turns, see §8.2. Mutually exclusive with the previous one |
| `dryRun` | boolean | Preview the prompt without dispatching, see §6.4 |

**Advanced fields**

| Field | Validation | Notes |
|-------|------------|-------|
| `model` | ≤200 chars | Model ID for this new session |
| `reasoningEffort` | `low` / `medium` / `high` / `xhigh` / `max` / `ultra` | Reasoning effort for this new session |
| `steer` | boolean | Allow a follow-up to be merged into the running turn (Codex App only), see §6.5. Mutually exclusive with `dryRun` |
| `allowChatMessages` | boolean | Let this turn post messages to the group, see §6.6 |
| `suppressFinalOutput` | boolean | Only effective for **fire-and-forget + real group**: skip the closing reply in the group |

All boolean fields must be real booleans: `"true"` or `1` is a 400.

About `model` / `reasoningEffort`:

- Only these CLIs honor them: Codex, Codex App, TraeX, Remote Runner, Grok, Claude Code, Kimi, ZCode. Other CLIs ignore both fields.
- **Only for newly created sessions**: a turn appended to an existing session doesn't change the model.
- `reasoningEffort` is checked against the CLI/model; a level that's clearly unsupported returns 400.
- `model` only applies to this run and isn't saved on the session; after a daemon restart the bot's configured model is used. `reasoningEffort` is saved with the session.

**Two fields that look useful but nothing reads**

| Field | What actually happens |
|-------|------------------------|
| `dedupKey` | The trigger flow doesn't read it. It's only written into the model prompt and included in the idempotency payload comparison. Real event dedup lives in the [Webhook connector](/en/webhook)'s "dedup field" |
| `status` | Same (`firing` / `resolved` or any string). Note: changing `status` under the same `idempotencyKey` also yields **409** |

---

## 5. Where the task lands, and what Feishu shows

### 5.1 No target → virtual session (zero Feishu noise)

With none of the three target fields, the daemon creates a synthetic session:

| Mode | Session ID prefix |
|------|-------------------|
| Sync | `http_wait_` |
| Async | `http_async_` |
| `source.type: "headless"` | `headless_` |

These sessions **post no topic seed, no streaming card, no messages at all, and skip the group-membership check**. `target.chatId` in the response is this synthetic ID.

### 5.2 `chatId` → real group session

A real group ID is **never** a virtual session, even in sync/async mode:

- The daemon first checks the bot is in the group; if not → **403 `bot_not_in_chat`**.
- **Topic groups** (or regular groups in `new-topic` mode) get a new thread: the seed message is posted first and the session anchors on it.
- **Regular groups** follow the group's reply mode: an existing shared session is continued, `new-topic` opens a thread. A non-empty explicit `topicMessage` opens a dedicated thread in every mode except `shared`.

### 5.3 `chatId` + `rootMessageId` → append to an existing thread

No seed is posted. Rejected when:

- No `sessionId` and no `chatId` → 400 `target_required`.
- The message isn't visible or its group can't be resolved → 400 `target_required`.
- The message **doesn't belong** to the group you passed → `chat_not_allowed` (⚠️ currently **500** on this endpoint, see §11.3).

### 5.4 `sessionId` → add a turn to an existing session

The group is inherited from the session; no need to pass it.

- Session doesn't exist → **404 `session_not_found`**.
- Session can't take input yet (still picking a directory, first start, building a worktree, or waiting in the backlog) → `session_not_runnable` (currently HTTP 500). The input did **not** reach the CLI; retry later.
- With `turnIdempotencyKey` while the session is still in its opening activation → `trigger_failed` (message contains `session activation in progress`); retry later with the same key.

### 5.5 What the group actually sees

| Target × mode | Topic seed | Streaming card | Answer posted to Feishu | Answer returned to program |
|---|:---:|:---:|:---:|:---:|
| virtual + sync/async | ✗ | ✗ | ✗ | ✓ |
| real group + fire-and-forget | ✓ (topic groups) | ✓ | ✓ | ✗ |
| **real group + sync/async** | ✓ (topic groups) | ✓ | **✗** | ✓ |
| existing thread + fire-and-forget | ✗ | ✓ | ✓ | ✗ |
| **existing thread + sync/async** | ✗ | ✓ | **✗** | ✓ |

> ⚠️ **The two bold rows are the usual trap**: in a real group with sync/async, members see the bot working but **never get the final answer** — it went to the HTTP caller. To show the answer in the group: use fire-and-forget, have your program post `output.content` back yourself, or use `allowChatMessages` on an existing group session (§6.6).

### 5.6 Want a new group created every time? Use a Webhook connector

`chatId` here must be an existing group. "Create a new group per event" is a delivery mode unique to [Webhook connectors](/en/webhook) (it also adds authorized users to the group and supports dedup by event field).

### 5.7 Two differences from chatting in Feishu

- **No worktree**: even if the bot has "auto-create worktree" on, virtual and sync/async sessions **always run in the base directory**, so programmatic calls don't leave a worktree behind each time. Only "real group + fire-and-forget + the bot's own default directory" gets an auto worktree.
- **Simpler working-directory choice**: oncall-bound directory → bot default directory (including `defaultOncall.workingDir`) → bot `workingDir` → `~`. Directories aren't inherited from sibling sessions (`botToBotSameDir` doesn't apply here), and oncall isn't auto-bound. If you need a fixed directory, configure it on the bot or oncall.

---

## 6. Execution modes in detail

### 6.1 Sync (`waitForFinalOutput`)

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

One request, one response; the result is right in `output.content`:

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

> Past `timeoutMs` you get **HTTP 504** + `wait_timeout`. The task **keeps running in the background**, but the timeout response has no `sessionId`, so you can never look it up. If you need a fallback query, use async.

### 6.2 Async (`asyncReturnSessionId`)

See §1 for the request. **Async is recommended for production**: you get a `sessionId` right away, can poll and stop, and results survive daemon restarts (§9, §10).

### 6.3 Fire-and-forget (neither flag)

Requires one of `chatId` / `sessionId` / `rootMessageId`. Returns immediately (`action` is `queued` or `delivered`); the answer goes out as a **normal Feishu reply**.

> ⚠️ This mode **doesn't record a result**. `trigger-result` only ever shows `running`, then `failed` once the session closes — **you never get `output.content`**. Use async or sync if your program needs the result.

### 6.4 `dryRun`: preview the prompt, don't dispatch

With `dryRun: true` no session is created and nothing is dispatched; you get back the prompt the model would receive:

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

- `promptPreview` is truncated past 4000 chars, with `...[truncated]` appended.
- `message` tells you where it would land: `would inject into existing session` for an existing session, otherwise `would create or deliver a new session turn`.

### 6.5 `steer`: merge a follow-up into the running turn (Codex App only)

`steer: true` allows a new message to be **merged into the Codex App turn that's currently running**, instead of queueing behind it. Handy for "also handle X" or "stop doing that, do Y instead" mid-task.

It's a **best-effort** permission, not a guarantee:

- **Send it on the first turn too**: Codex requires both the opening turn and later follow-ups to be explicitly authorized, so pass `steer: true` on the very first request.
- **Falls back automatically**: if there's no running turn, the turn is closing, it's a review/compaction turn, or the worker is cold-starting, the message becomes an ordinary queued follow-up. The request never fails because of `steer`.
- **Other CLIs**: the flag does nothing; messages queue as usual.

The response echoes `steer: true` only when the request was actually dispatched (not on idempotent reuse). The echo only means the daemon carried the permission — **not that the merge succeeded**.

**How results are attributed after a merge**: Codex produces **one merged answer** for the group. Every earlier request ends up with **the same merged text**:

- Async: earlier members poll to `completed` with the merged `output.content`, **without `usage`** (usage is recorded only on the newest trigger). A daemon restart during the merge is handled correctly.
- Sync: earlier members return together when the answer lands. Sync results live only in memory, though — if the daemon restarts mid-group, they just wait until their own timeout.

### 6.6 `allowChatMessages`: let this turn post to the group

By default, sync/async tasks are told "don't call `botmux send`, don't post to Feishu". If you want a turn to post to the group on its own (for example, to notify people), pass `allowChatMessages: true`:

- Applies to this turn only; it doesn't carry over to later turns.
- The final answer **still** goes back to the HTTP caller.
- Requirements: async mode + `target.sessionId` pointing to an **existing real group session** (not a DM, not a virtual session); can't be combined with sync, `steer`, or `source.type: "headless"`. Otherwise → 400 `bad_request`.

---

## 7. When there's nothing to say (`BOTMUX_NOTHING_TO_SEND`)

In sync/async mode (first turn and follow-ups alike), the daemon tells the model:

- Your reply is **returned verbatim to a program**, not shown in a chat.
- **Output only the final answer** — no preamble, no talk about these system notes.
- Don't call `botmux send` or post to Feishu (unless `allowChatMessages` is on).
- **If there's nothing to answer, output only `BOTMUX_NOTHING_TO_SEND`**; the program gets an empty result.

This token directly affects how the turn settles:

| Mode | When the model outputs only this token |
|------|-----------------------------------------|
| **Async** | Settles as `completed` with an **empty** `output.content` |
| **Sync** | There's no settle path for it; it waits until `timeoutMs`, then **504 `wait_timeout`** |

> ⚠️ This is the only semantic difference between sync and async. If a task **may not need an answer** (health checks, "report only if something's wrong"), use **async** — otherwise every "nothing happened" costs a full timeout.

If the model writes an answer and also ends with the token, the answer is returned and the token stripped. Only "nothing but the token" counts as an empty result.

---

## 8. Preventing duplicate runs (idempotency keys)

### 8.1 `idempotencyKey`: new sessions

**Problem**: after an async trigger, if the HTTP response is lost on the network (while the task is in fact running), your retry creates **a second session and runs the task again**.

**Fix**: generate a stable key and store it **before** sending the request; retry with the same key. The daemon returns **the same session and `triggerId` without dispatching again**:

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

- Hit on an existing key: response has `idempotent: true`; first creation: `idempotent: false`. Then poll with `sessionId` as usual.
- **Only for brand-new async virtual sessions**: `asyncReturnSessionId: true`, with no `sessionId` / `rootMessageId` / `chatId` and no `waitForFinalOutput` / `dryRun`. Any other combination with this key → 400.
- **Same key, different content → 409 `idempotency_conflict`**. The comparison covers `instruction`, `envelope`, `source`, `presentation` and the entire `options` (except the key itself), so changing `model`, `status` or `timeoutMs` also gives 409. Always retry with **the same key and the same content**.
- **On a daemon crash it prefers not running over running twice**: if the daemon crashes between "started dispatching" and "confirmed the result", it won't blindly rerun after restart; the key settles as `failed` (`no_output`, with `error` saying the previous dispatch outcome is unknown). Treat it as failed.
- The key → session mapping is kept permanently, so a late retry after completion still gets the same session.

### 8.2 `turnIdempotencyKey`: follow-up turns on an existing session

Use this key when appending a turn to an existing session (with `target.sessionId`). A retry with the same key lands on **the same turn (same `triggerId`) instead of injecting twice**, and the response has `idempotent: true`.

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

- Requirements: `target.sessionId` set, no `waitForFinalOutput` / `dryRun`. Works for both async and fire-and-forget: async results are polled as usual, fire-and-forget answers still go to Feishu.
- **Mutually exclusive** with `idempotencyKey`; both → 400. The two key spaces are separate — the same string never collides.
- Same key, different content → 409; crash behavior and retention match §8.1.

---

## 9. Polling for results

```
GET /api/sessions/:sessionId/trigger-result
    optional ?triggerId=<trg_...>: a specific trigger; otherwise the session's latest
```

**Normal responses are all HTTP 200 + `ok: true`; read the task state from `state` only**, not from `ok` or the HTTP status.

| `state` | Meaning | What to do |
|---------|---------|------------|
| `running` | Still running | Check again in a few seconds |
| `completed` | Result is ready | Read `output.content` (may be empty, see §7) |
| `interrupted` | You stopped this turn (§10.2); the session is still there | Treat as cancelled |
| `failed` | Session ended without a result | Soft terminal, see 9.2 |
| `not_found` | No such session | See 9.3 |

`completed` example:

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

About `usage` (this turn's token usage):

- **Codex App tasks only**, and only when it was captured; otherwise the whole field is omitted. **No `usage` means "unknown", not 0.**
- The four numbers don't overlap: `inputTokens` (new input excluding cache), `outputTokens`, `cacheReadTokens`, `cacheCreateTokens`, all for this turn only.
- After a daemon restart, `usage` and `output` are restored from disk together.

### 9.1 Which triggers can reach `completed`

| Trigger | Can reach `completed` |
|---------|:---------------------:|
| Async (any target) | ✓ |
| Sync | ✗ (the result is in the trigger response) |
| Fire-and-forget | ✗ (stays `running`, then `failed` once the session closes) |

### 9.2 Don't give up on `failed` too quickly

| Situation | Returns |
|-----------|---------|
| Session ended without a result — **a real failure, or you closed the session yourself** | `errorCode: "no_output"` |
| Idempotency key hit a daemon crash; not rerun (at-most-once) | `no_output`, `error` says the previous dispatch outcome is unknown |
| The CLI explicitly reported this turn as failed | `errorCode: "trigger_failed"`, with the reason in `terminalErrorCode` |

Tips:

- Decide whether *you* cancelled it from your own records, not from `failed`.
- Treat `no_output` as "needs a second look": confirm there's really no result and you didn't cancel it, then mark it as finally failed.

### 9.3 `not_found` comes in two shapes

When querying through the Dashboard, treat both as "not found":

1. `HTTP 404` + `{ "ok": false, "error": "unknown_session" }`: the Dashboard has never seen this ID (usually a wrong or stale ID).
2. `HTTP 200` + `{ "ok": true, "state": "not_found" }`: the request reached the daemon, but there's nothing on disk either.

### 9.4 `?triggerId=` doesn't match

The session exists but never had the `triggerId` you gave → HTTP 400 + `ok: false` + `errorCode: "bad_request"`, **with no `state` field**. That's a malformed request, not "not found".

### 9.5 Webhook connector polling has a different shape

The [Webhook connector](/en/webhook)'s own polling endpoint rewrites `failed` and `not_found` into `ok: false` + **HTTP 404** (keeping `state`). This page's `/api/sessions/:id/trigger-result` doesn't. If you integrate with both, handle them separately.

---

## 10. Do results survive restarts? How do I stop a task?

### 10.1 Results survive restarts

**After a daemon restart, a finished async task still reads as `completed` (with `output.content`), never `not_found`.** The result is written to disk when it completes (`data/async-triggers/<sessionId>.json`).

So **don't conclude the task is lost** after one miss. Only start compensation once it's confirmed missing (`unknown_session` / `not_found`) and your own timeout has also expired.

### 10.2 Stop just this turn (keep the session)

```bash
curl -X POST "http://<host>:7891/api/sessions/:sessionId/turns/:triggerId/interrupt" \
  -H "Cookie: botmux_dashboard_token=$TOKEN"
# → { "ok": true, "action": "interrupted", "sessionId": "...", "triggerId": "..." }
```

Interrupts only the turn behind this one **async** trigger; the session stays and you can keep asking follow-ups. The daemon first confirms the CLI is running exactly this turn before sending the interrupt, so it never stops a different turn by mistake.

| Response | Meaning |
|----------|---------|
| 200 `action: "interrupted"` | Stopped; `trigger-result` now shows `state: "interrupted"`. Repeated calls return `idempotent: true` |
| 404 `session_not_found` | Session doesn't exist or is closed |
| 404 `bad_request` | No async trigger with this `triggerId` in the session |
| 409 `trigger_failed` | The turn already ended, isn't running in this daemon generation, or the session is being transferred |
| 503 `trigger_failed` | The interrupt wasn't delivered or couldn't be saved; retry later or keep polling |

### 10.3 Close the whole session

```bash
curl -X POST "http://<host>:7891/api/sessions/:sessionId/close" \
  -H "Cookie: botmux_dashboard_token=$TOKEN"
# → { "ok": true, ... }
```

`close` **shuts down the whole session**. That's fine for a one-shot virtual session (one turn only); for a **real group session**, other people may be using it, so be careful — use §10.2 if you only want to stop one turn.

If there was no result before closing, polling afterwards returns `state: "failed"` (`no_output`). That's expected; handle it from your own cancellation records.

---

## 11. Response fields and status codes

### 11.1 Response fields

| Field | When present |
|-------|--------------|
| `ok` | Always |
| `triggerId` | Almost always (`trg_<uuid>`) |
| `action` | `queued` / `delivered` / `completed` / `dry_run`, see 11.2; the stop endpoint (§10.2) returns `interrupted` |
| `state` | Polling responses; on trigger responses only when an idempotency key hits an already finished task |
| `target` | `{ kind, sessionId?, chatId? }` |
| `output.content` | Sync completion, or polling reaches `completed` |
| `usage` | See §9 |
| `async` | `{ status: 'pending' \| 'completed', sessionId, completedAt? }` |
| `finishedAt` | End time (ISO 8601) |
| `message` | Human-readable explanation |
| `errorCode` / `error` | On errors, see 11.3 |
| `terminalErrorCode` | The specific reason when the CLI explicitly reported failure |
| `promptPreview` | `dryRun` only |
| `idempotent` | With an idempotency key: `true` = reused an existing session/turn |
| `idempotencyKey` / `turnIdempotencyKey` | Echo of your key |
| `steer` | See §6.5 |
| `readOnlyUrl` / `viewToken` | Only in core-only deployments (`BOTMUX_CORE_ONLY=1`) while the CLI terminal is alive: a read-only terminal link on polling responses, see [Core-only embedding](/en/api-core-only) |

### 11.2 `action` vs `message`

`action` only describes **dispatch** ("accepted"), not whether the task succeeded. There are only two ways to get the result: sync `output.content`, or async polling to `completed`.

| `action` | `message` | When |
|----------|-----------|------|
| `delivered` | `delivered to existing session` | Fire-and-forget; the existing session's CLI is running |
| `queued` | `durably queued behind the existing activation` | Same, but the session is still opening; this turn queues first |
| `queued` | `queued existing session turn` | Fire-and-forget; the existing session's CLI must be restarted |
| `queued` | `delivered to existing session; poll by sessionId or triggerId for final output` | Async + existing session |
| `queued` | `queued new session turn` | Fire-and-forget, new session |
| `queued` | `queued new session turn (building worktree)` | Same, worktree being built |
| `queued` | `queued new session turn; poll by sessionId or triggerId for final output` | Async + new session |
| `completed` | `delivered to existing session and completed` | Sync + existing session |
| `completed` | `queued new session turn and completed` | Sync + new session |
| `dry_run` | `would inject into existing session` / `would create or deliver a new session turn` | `dryRun` |

### 11.3 HTTP status codes

**Dashboard layer**

| Status | `errorCode` | Cause |
|:------:|-------------|-------|
| 400 | `bad_json` | Malformed JSON, or the body exceeds 512 KiB |
| 400 | `target_required` | Missing `target.botId` |
| 400 | others | Field validation failed (see §4) |
| 502 | `daemon_offline` | Forwarding to the daemon failed |
| 503 | `daemon_offline` | Target daemon isn't online |

**Daemon layer**

| Status | `errorCode` | Cause |
|:------:|-------------|-------|
| 200 | — | Success (`queued` / `delivered` / `completed` / `dry_run`) |
| 200 | `no_output` etc. | `ok: false` but `state: "failed"`: an idempotency key hit an already failed task. The HTTP call itself succeeded; read `state` |
| 400 | `bad_json` / `bad_request` / `target_required` | Malformed request or invalid combination |
| 400 | `bot_not_found` | `botId` doesn't match this daemon |
| 403 | `bot_not_in_chat` | Bot isn't in the target group |
| 404 | `session_not_found` | `target.sessionId` doesn't exist |
| 409 | `idempotency_conflict` | Same key, different content |
| 410 | `legacy_workflow_retired` | `target.kind: "workflow"` (retired) |
| 503 | `bot_not_found` / `trigger_failed` | Daemon isn't ready yet |
| 504 | `wait_timeout` | Sync wait timed out |
| 500 | `trigger_failed` / `session_not_runnable` / `chat_not_allowed` etc. | Other failures |

⚠️ **On a 500, read `errorCode` before retrying**:

- `chat_not_allowed` (`rootMessageId` doesn't belong to the group you passed) is a **request error; retrying won't help**. Webhook connectors return 403 for the same code; this endpoint currently returns 500.
- `session_not_runnable` means the input wasn't delivered, so retrying later is safe.

### 11.4 Error codes

**You may see these on this endpoint**: `bad_json`, `bad_request`, `bot_not_found`, `bot_not_in_chat`, `chat_not_allowed`, `daemon_offline`, `idempotency_conflict`, `legacy_workflow_retired`, `no_output`, `session_not_found`, `session_not_runnable`, `target_required`, `trigger_failed`, `wait_timeout`

**Only on [Webhook connectors](/en/webhook)**

| Code | Status | Meaning |
|------|:------:|---------|
| `invalid_signature` | 401 | Token or signature check failed |
| `replay` | 401 | Signature timestamp outside the allowed window |
| `rate_limited` | 429 | Rate limit exceeded |
| `group_create_failed` | 501 / 502 | Group creation failed in "new group per event" mode |
| `lifecycle_extract_failed` | 400 | A dedup field is configured but missing from the event |

`dry_run` and `workflow_trigger_not_implemented` are also in the error-code list but are never returned.

---

## 12. Limits and caveats

- **Request body max 512 KiB** (checked at the Dashboard).
- **The Dashboard → daemon hop has no timeout**. A sync call with `timeoutMs: 300000` really holds for 5 minutes. **Set your own timeout on your HTTP client.**
- **API-only bots** (`apiOnly`, no Feishu transport) have four rules; breaking any is 400 `bad_request`:
  1. Sync or async is required;
  2. No `rootMessageId`;
  3. No real `chatId`;
  4. `sessionId` may only point to its own virtual session.
- **Async result files aren't cleaned up automatically yet**: files under `data/async-triggers/` only accumulate, so results stay queryable after a session closes.
- **`output.content` may occasionally start with a preamble line**. botmux tells the model to output only the answer and most results are clean, but it's not a hard guarantee. When showing it to users:
  - ✅ Strip only known fixed prefixes (e.g. `here's my answer:`) and keep everything after.
  - ❌ Don't "keep only the last paragraph": answers can legitimately be multi-paragraph or include code blocks.
  - Store the raw `content` for archives and audits.

---

## 13. Client example

```ts
// Minimal skeleton: async trigger + poll until done
async function runAndAwait(instruction: string, botId: string): Promise<Result> {
  // 1) Trigger async, get sessionId
  const trg = await post('/api/trigger', {
    source: { type: 'webhook' },
    target: { kind: 'turn', botId },
    instruction,
    envelope: { format: 'json', sourceName: 'my-system', trusted: false },
    options: { asyncReturnSessionId: true },
  });
  const sessionId = trg.target.sessionId;

  // 2) Poll, looking only at state
  for (;;) {
    const r = await getTriggerResult(sessionId);
    switch (r.state) {
      case 'running':
      case 'unknown':     await sleep(3000); continue;       // unknown: network/5xx, task may still be running
      case 'completed':   return { ok: true, content: r.output?.content ?? '' }; // empty string is a valid result
      case 'interrupted': return { ok: false, cancelled: true };
      case 'failed':      return { ok: false, needsReconcile: true }; // soft terminal; double-check
      case 'not_found':   return { ok: false, notFound: true };
      case 'error':       return { ok: false, fatal: true, why: r.why }; // request/auth error; retrying won't help
    }
  }
}

// Key point: separate "can't tell yet, retry" from "definitely over"
async function getTriggerResult(sessionId: string) {
  let res: Response;
  try {
    res = await fetch(`/api/sessions/${sessionId}/trigger-result`, { headers: cookie() });
  } catch (e) {
    return { state: 'unknown', why: `network: ${String(e)}` }; // network error → retry
  }

  if (res.status === 401 || res.status === 403) return { state: 'error', why: `auth ${res.status}` };

  if (res.status === 404) {
    const b = await res.json().catch(() => ({}));
    if (b?.error === 'unknown_session') return { state: 'not_found' };
    if (b?.state) return b; // Webhook connector polling rewrites failed/not_found to 404 (§9.5)
    // Any other 404 (e.g. HTML from a gateway) does NOT mean not found — retry it,
    // otherwise a gateway hiccup looks like a lost task and you dispatch it twice.
    return { state: 'unknown', why: 'opaque 404' };
  }

  if (res.status === 400) return { state: 'error', why: 'bad_request' }; // e.g. triggerId mismatch (§9.4)
  if (res.status >= 500) return { state: 'unknown', why: `upstream ${res.status}` };

  let body: any;
  try { body = await res.json(); } catch { return { state: 'unknown', why: 'non-json 2xx' }; }
  return body?.state ? body : { state: 'unknown', why: 'no state field' };
}
```

Key points:

- Clamp `timeoutMs` to `1000`–`300000`, and **set your own HTTP client timeout** (§12).
- On a sync 504 the task may still be running, but you have no `sessionId` to look it up. Use async if that matters.
- `output.content` on `completed` may be an empty string (§7) — that's a normal result.
- Keep **retryable** (network errors, 5xx, non-JSON) and **definitely over** (`not_found`, 400, 401/403) strictly apart, or you may dispatch twice.
- On a 500 from this endpoint, read `errorCode` first (§11.3).

---

## Appendix: endpoint cheat sheet

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/trigger` | POST | Trigger a task |
| `/api/sessions/:id/trigger-result` | GET | Poll async results (optional `?triggerId=`) |
| `/api/sessions/:id/turns/:triggerId/interrupt` | POST | Stop one async trigger; keep the session |
| `/api/sessions/:id` | GET | Session info (status, title, …) |
| `/api/sessions/:id/close` | POST | Close the whole session |

Related pages: [Webhook connectors](/en/webhook) (auto-created groups, signatures, dedup), [Core-only embedding](/en/api-core-only) (API-only deployment without Feishu).
