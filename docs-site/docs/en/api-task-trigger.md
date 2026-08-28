# Triggering botmux Tasks Programmatically via API

> Let an external system (task orchestrator, CI, backend service, etc.) hand an instruction to a botmux bot over an HTTP API and get the final result back — the bot runs its CLI in a Feishu topic as usual, but the whole call is a pure programmatic "request → result", optionally with zero Feishu noise.

This doc is for **caller-side developers**: two execution modes, the four-state polling contract, auth, cancellation, and failure recovery — with copy-pasteable curl and client pseudocode.

---

## 1. Two execution modes

Every call hits the same endpoint `POST /api/trigger`; the difference is only in `options`:

| Mode | How to trigger | When to use | Cancelable mid-run |
|------|---------------|-------------|:------------------:|
| **Sync** | `options.waitForFinalOutput=true` | one-shot, short task (≤5 min), no mid-run cancel | ✗ |
| **Async** | `options.asyncReturnSessionId=true` | fast dispatch + polling, needs cancel, needs recovery | ✓ |

Both modes open a "virtual session" (when no `chatId` is given) that **never enters a Feishu group and posts nothing** — a pure HTTP request/response.

> ⚠️ Production-grade dispatch should use **async mode**: in sync mode the `sessionId` is only returned on completion, so you cannot obtain it mid-run to cancel, and the HTTP connection blocks up to 5 minutes. Async mode returns `sessionId` immediately — pollable, cancelable, recoverable.

---

## 2. Authentication

Calls go through the dashboard (default `http://<daemon-host>:7891`). Auth currently uses the rotating dashboard token:

- **Programmatic calls MUST send the token as a Cookie header**: `Cookie: botmux_dashboard_token=<TOKEN>`
- ⚠️ Do NOT use `?t=<TOKEN>` query: that's for browser login; a `POST` carrying it returns a **302 redirect** (set-cookie) and the call fails.
- Getting a token: run `botmux dashboard` to get the current login URL — the part after `?t=` is the token. The command creates the first token when absent; use `botmux dashboard rotate` only when you intend to invalidate an existing token.

> The token persists until explicit rotation. Dedicated API-key auth (e.g. `X-Botmux-Api-Key`) is planned; this doc will be updated when it lands.

---

## 3. Triggering a task

### Request body

```jsonc
{
  "source":   { "type": "webhook" },                    // source type
  "target":   { "kind": "turn", "botId": "cli_xxx" },   // target bot's larkAppId
  "instruction": "the instruction for the bot (trusted; rendered as a top-level directive)",
  "envelope": {
    "format": "json",
    "sourceName": "your-system",                         // caller identity
    "trusted": false                                     // must be false, see below
  },
  "options": { /* see below */ }
}
```

Hard constraints (all validated; violations return 400):

- **`envelope.trusted` must be `false`**. This is an injection-defense design: `trusted:false` declares "the envelope content is untrusted external data", so the daemon wraps it as an untrusted event and does not execute instructions embedded inside it. Put what you actually want the bot to do in the top-level `instruction` (the trusted directive), not in the envelope.
- **Omitting `chatId`** requires `options` to contain either `waitForFinalOutput` or `asyncReturnSessionId`, else `target_required`.
- **`options.timeoutMs` range `[1000, 300000]`** (1s–5min); out of range returns 400. Defaults to 120000.
- **`options.model`** / **`options.reasoningEffort`** (optional, **codex / codex-app / traex / grok bots only**): override the model and reasoning level for this trigger.
  - `model`: a model id for that CLI (≤200 chars); `reasoningEffort` is validated against the selected CLI/model. Common levels are `low` / `medium` / `high` / `xhigh`, with `max` / `ultra` available on some models. Missing or unknown models expose only the safe common levels; explicitly unsupported or out-of-range efforts return 400.
  - **Fresh-session only**: recorded only when this trigger **creates a new session**; a fold-in to an existing worker does not rewrite it.
  - `model` is **held in memory, never persisted**: it applies to every launch of that session within this daemon's lifetime and is not restored after a daemon restart — later launches use the bot's configured model. `reasoningEffort` is still persisted with the session.
  - **Scoped to CLIs with an explicit reasoning control**: ignored when the target bot is not codex/codex-app/traex/grok (never changes a Claude/Gemini/CoCo bot's model).

### Sync mode (waitForFinalOutput)

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

Response (HTTP 200, one-shot, result in `output.content`):

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

> A sync-mode timeout (waited longer than `timeoutMs`) returns **HTTP 504** + `errorCode:"wait_timeout"`. The task is in fact **still running in the background** — only this HTTP call ended. If you kept the `sessionId`, query it later as a fallback; don't treat it as a failure.

### Async mode (asyncReturnSessionId)

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

Response (HTTP 200, returns immediately — **keep `target.sessionId` as the correlation key**):

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

### Idempotency key (`options.idempotencyKey`) — prevent a retry from running twice

**Problem**: if the HTTP response to an async trigger is lost in transit (the daemon already created the session and the task is running), your retry builds a **brand-new session** and runs the same task a **second time** (duplicate external side effects: two messages sent, a migration run twice…). Your own dedup can't stop this — the first session is genuinely already executing.

**Fix**: pass a stable key in `options.idempotencyKey` that you **persist before issuing the trigger**. On a same-key retry the daemon returns the **same session/triggerId — no new session, no re-dispatch**:

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

A hit carries `idempotent:true` (reused, no new dispatch); the first create carries `idempotent:false`. Poll `trigger-result` with the (reused or new) `sessionId` as usual — **no extra lookup endpoint needed**.

**Scope (important)**: `idempotencyKey` is supported only for a **fresh async virtual** trigger — `target.kind:'turn'` + `options.asyncReturnSessionId:true`, with **no** `target.sessionId` / `rootMessageId` / `chatId`, and no `waitForFinalOutput` / `dryRun`. Any other combination carrying a key returns **400** (the lease is implemented only on this seam, so the contract does not advertise it elsewhere).

**Same key, different payload → 409 `idempotency_conflict`**: the key is bound to its business payload (`instruction` / `envelope` / execution-affecting `options`); reusing a key with a changed payload is a caller bug and the daemon returns 409 rather than silently joining the old task. Retry with the **same key AND the same payload**.

**Crash semantics (at-most-once)**: before dispatching, the daemon durably marks the key's lease `attempting` (a commit-unknown barrier). If the daemon crashes between "dispatch started" and "completion proven", it will **not** blindly re-dispatch on restart (`forkWorker` returning is not proof the model didn't start). The key converges to a terminal state and `trigger-result` reports `failed` (errorCode `no_output`, meaning "previous dispatch outcome unknown; not re-run under at-most-once"). Treat it as **Failed** in your recovery (better a visible failure you retry as a new task than a double run).

**Retention**: the key→session mapping is append-only (same policy as async results), so a late retry after completion still reuses the same session instead of rebuilding it.

---

### Turn idempotency key (`options.turnIdempotencyKey`) — same guarantee for a follow-up turn

`idempotencyKey` above only covers a **fresh** session. When you append a **follow-up turn to an existing session** (`target.sessionId` set), use `options.turnIdempotencyKey` instead — a lost HTTP response on the append otherwise can't tell you whether the daemon already accepted that turn, so a retry risks injecting it **twice**.

Pass a stable key you **persist before issuing the follow-up**. On a same-key retry to the same session, the daemon resolves to the **same turn (same `triggerId`) — no second injection**:

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

A hit carries `idempotent:true`; poll `trigger-result` by `sessionId`/`triggerId` as usual.

**Scope**: `turnIdempotencyKey` is supported only for a **follow-up async turn on an existing session** — `target.kind:'turn'` + `target.sessionId` set + `options.asyncReturnSessionId:true`, no `waitForFinalOutput` / `dryRun`. It is **mutually exclusive** with `idempotencyKey` (a request carrying both returns **400**), and the two live in separate, non-collidable key spaces — a `turnIdempotencyKey` and an `idempotencyKey` with the same string never share a lease.

**Same key, different payload → 409 `idempotency_conflict`**; **crash semantics (at-most-once)** and **retention** are identical to `idempotencyKey` above (a follow-up whose dispatch outcome is unknown converges to `failed` / `no_output` and is never blindly re-run). One extra transient case: if the target session is still finishing its **opening activation**, the follow-up is refused **retryably** (errorCode `trigger_failed`, message mentions "session activation in progress") — retry shortly.

---

## 4. Polling for the result (four-state contract)

In async mode, poll by `sessionId`:

```
GET /api/sessions/:sessionId/trigger-result
   (optional ?triggerId=<trg_...> to match a specific trigger; omitted → the session's latest)
```

**All four states return HTTP 200 + `ok:true`; read task state from the `state` field only — do NOT judge by `ok` or the HTTP status.**

| `state` | Meaning | What to do | Key fields |
|---------|---------|-----------|-----------|
| `running` | still running | keep polling | — |
| `completed` | final output ready | terminal; read `output.content` (codex-app also brings `usage`) | `output.content`, `finishedAt`, `usage?` |
| `failed` | session terminated with no captured output (soft terminal) | see below | `errorCode:"no_output"`, `error`, `finishedAt` |
| `not_found` | no such session (never existed / invalid id) | see two physical forms below | `errorCode:"session_not_found"` |

`completed` example (`usage` present only for codex-app, and only when captured):

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

About `usage` (this turn's token usage, four mutually-exclusive buckets):
- Present only for **codex-app tasks** and only when the turn's usage was captured; **omitted entirely** for other CLIs (including plain codex) or when not captured.
- **omit ≠ 0**: no usage means no `usage` field, not four zeros — treat "field absent = unknown", don't read a missing field as a real 0.
- Buckets: `inputTokens` (fresh input, cache read/write already subtracted), `outputTokens`, `cacheReadTokens`, `cacheCreateTokens`, all per-turn deltas (not session totals).
- **Survives restart**: after a daemon restart, re-querying a completed session restores `usage` alongside `output` from disk.


### `failed` is a soft terminal — don't kill immediately

`failed` (`no_output`) means "the session terminated without a captured final output". It **could be a genuine failure OR a cancel (close) you initiated** — the two are indistinguishable from this signal. Recommended:

- **Decide cancellation from your own intent** (e.g. you recorded the cancel when you issued it); do not infer "was this my cancel?" from this `failed`.
- Treat `failed` as "needs reconciliation": flag it, confirm there really is no output and it wasn't your own cancel, then commit the final failed state.

### The two physical forms of `not_found`

Callers go through the dashboard proxy, so `not_found` surfaces two ways — **normalize both to a not_found terminal**:

1. `HTTP 404` + `{ "ok": false, "error": "unknown_session" }` — proxy short-circuit (the sessionId was never seen by the aggregator, usually an invalid/expired id).
2. `HTTP 200` + `{ "ok": true, "state": "not_found" }` — the request reached the daemon but no session record exists on disk.

---

## 5. Restart-survival guarantee (important)

**After a daemon restart, a task that already completed still returns `completed` (with `output.content`) — it is NOT misreported as `not_found`.**

Under the hood, the async result is persisted to disk on completion (`data/async-triggers/<sessionId>.json`), and polling reads the persisted result first rather than in-memory state. Therefore:

- Your recovery logic **must not treat a single missed lookup as a lost task**.
- Only "the proxy confirms unknown (`unknown_session`)" plus "your own lease/timeout also expired" should trigger compensating logic.

This is the foundation of async-mode failure recovery — even if the daemon restarts mid-poll, a completed result is not lost.

---

## 6. Cancelling a task

In async mode, cancel via close:

```bash
curl -X POST "http://<host>:7891/api/sessions/:sessionId/close" \
  -H "Cookie: botmux_dashboard_token=$TOKEN"
# → { "ok": true, "alreadyClosed": false }
```

> `close` means **close the whole session**, not "interrupt the current turn". For a one-shot virtual async session (one session, one turn) the two are equivalent.

After cancelling, polling that `sessionId` returns `state:"failed"` (`no_output`) if it had no output before closing. **This is expected** — commit your own `cancelled` terminal per your recorded intent; you don't need to rely on this `failed`.

---

## 7. Client pseudocode

```ts
// Minimal skeleton: trigger + poll to a terminal state
async function runAndAwait(instruction: string, botId: string): Promise<Result> {
  // 1) async trigger, get sessionId
  const trg = await post('/api/trigger', {
    source: { type: 'webhook' },
    target: { kind: 'turn', botId },
    instruction,
    envelope: { format: 'json', sourceName: 'my-system', trusted: false },
    options: { asyncReturnSessionId: true },
  });
  const sessionId = trg.target.sessionId;

  // 2) poll, read state only
  for (;;) {
    const r = await getTriggerResult(sessionId); // classified below
    switch (r.state) {
      case 'running':   await sleep(3000); continue;
      case 'unknown':   await sleep(3000); continue; // retryable: network/timeout/5xx/non-JSON, task may still run
      case 'completed': return { ok: true, content: r.output.content };
      case 'failed':    return { ok: false, needsReconcile: true };  // soft terminal
      case 'not_found': return { ok: false, notFound: true };        // terminal: confirmed no such session
      case 'error':     return { ok: false, fatal: true, why: r.why }; // terminal: request/auth error, retrying won't help
    }
  }
}

// getTriggerResult sorts the response into 5 classes. The point is to never
// conflate "unknown/retryable" with "definitely terminal":
//  - not_found  : confirmed missing → terminal  ((a) 404 unknown_session; (b) 200 state:not_found)
//  - completed/running/failed : the daemon's four states, passed through
//  - error      : request error (400) / auth (401/403) → terminal, retry is pointless
//  - unknown    : network/timeout/5xx/502/non-JSON → retryable, task may still be running
async function getTriggerResult(sessionId: string) {
  let res: Response;
  try {
    res = await fetch(`/api/sessions/${sessionId}/trigger-result`, { headers: cookie() });
  } catch (e) {
    // fetch itself threw: unreachable / DNS / reset / timeout → retryable
    return { state: 'unknown', why: `network: ${String(e)}` };
  }

  // Auth error: token expired / not permitted → terminal (retry is refused too)
  if (res.status === 401 || res.status === 403) return { state: 'error', why: `auth ${res.status}` };

  // Proxy short-circuit / adapter 404
  if (res.status === 404) {
    const b = await res.json().catch(() => ({}));
    if (b?.error === 'unknown_session') return { state: 'not_found' }; // (a) confirmed missing
    if (b?.state === 'not_found') return { state: 'not_found' };       // (b) adapter-translated missing
    if (b?.state) return b; // adapter translated failed etc. to 404 → honor body.state (pass through)
    // ⚠️ Any other 404 (gateway/old-route HTML, non-JSON → parsed to {}) is NOT
    // a confirmed miss; treat as retryable unknown — otherwise a flaky gateway
    // gets misread as a lost task and triggers re-dispatch / double execution.
    return { state: 'unknown', why: 'opaque 404' };
  }

  // Request error, e.g. the 400 bad_request for a precise-triggerId miss → terminal
  if (res.status === 400) return { state: 'error', why: 'bad_request' };

  // 5xx / 502 daemon-unreachable → retryable (the task may still be running; never re-dispatch)
  if (res.status >= 500) return { state: 'unknown', why: `upstream ${res.status}` };

  // 2xx: parse JSON; non-JSON (gateway/proxy HTML etc.) → retryable unknown
  let body: any;
  try { body = await res.json(); } catch { return { state: 'unknown', why: 'non-json 2xx' }; }
  if (body?.state) return body; // { state, output?, errorCode?, finishedAt? }
  return { state: 'unknown', why: 'no state field' };
}
```

Robustness notes (all from the tested contract):

- Clamp `timeoutMs` to `[1000, 300000]` before sending.
- In sync mode, treat `504/wait_timeout` as "possibly still running"; keep `sessionId` for a fallback query, don't kill it.
- Sort polls into 5 classes; never conflate "retryable" with "terminal": **not_found** (404 unknown_session / `state:not_found`) and **error** (400 request error, 401/403 auth) are terminal; **unknown** (network/timeout/5xx/502/non-JSON) is retryable — the task may still be running, and treating it as missing + re-dispatch causes double execution. Wrap both `fetch` and `res.json()` in try/catch so an exception never bubbles up and breaks the poll loop.

---

## 8. Known limitations

- **Async result files are not auto-reclaimed yet**: `data/async-triggers/<sessionId>.json` grows monotonically (intentional — deleting on session close would drop the `completed` result and break restart-survival). The upside: even if the session record is later cleaned up, `completed` is still queryable as long as the file exists; the cost is unbounded accumulation. A conservative TTL sweep (clean only after N days completed) is planned; this doc will be updated then.

- **`output.content` may rarely carry a preamble**: botmux already steers the model at the source (the HTTP-response-mode prompt) to "output only the final answer, no preamble/meta-commentary", so the vast majority of replies are clean. But this is prompt-level guidance, not a hard guarantee — an occasional preamble line can still slip through. If you render `output.content` directly to users and need it "guaranteed clean", add a **conservative trim** at the **presentation layer** as a fallback:
  - ✅ Strip only **known, deterministic preamble prefixes** (e.g. match fixed patterns like `This is a system routing header…` / `here's my answer:`, and keep **everything** after the match).
  - ❌ **Do NOT** use aggressive extraction like "take the last non-empty paragraph" — `output.content` can be legitimately multi-paragraph (bulleted answers, code blocks), and aggressive extraction would drop the real body, a far worse correctness bug than an occasional preamble. Prefer showing a full answer with one stray preamble line over losing the body.
  - Trim at the **presentation layer only**; **persist/audit/replay the raw `content`**.

---

## Appendix: endpoint cheatsheet

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/trigger` | POST | trigger a task (sync/async chosen by `options`) |
| `/api/sessions/:id/trigger-result` | GET | async result polling (four states) |
| `/api/sessions/:id` | GET | session metadata (status/title/etc.) |
| `/api/sessions/:id/close` | POST | cancel/close a session |

Key `errorCode`s: `target_required`, `bad_request` (incl. `trusted` check, `timeoutMs` out of range, `idempotencyKey` out of scope), `idempotency_conflict` (same key, different payload), `bot_not_found`, `bot_not_in_chat`, `wait_timeout`, `no_output`, `session_not_found`.
