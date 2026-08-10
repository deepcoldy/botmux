# Core-only (apiOnly) API Control

> Embed botmux as a **controlled HTTP service** inside your own system: one process, a fixed port, bound to `127.0.0.1`, with **no Feishu credentials / bots.json / pm2 / dashboard**. Your orchestrator (task runner, CI, backend, sandbox) drives it over HTTP to run a CLI (codex / claude-code / …), poll results, and get a writable web terminal on demand.

This doc is for integrators **embedding botmux into their own product** (e.g. an in-sandbox botmux running codex). If you just want an external system to trigger a **normal bot already running in a Feishu group**, see [Triggering Tasks via API](/en/api-task-trigger) — that covers the trigger/poll/cancel four-state contract. The two are complementary: **the same trigger/poll contract applies under core-only**; this doc only covers the core-only-specific startup, auth, route boundary, writable terminal, and security model.

---

## 1. core-only vs the normal fleet

| | `botmux start` (fleet) | `botmux serve --api-only` (core-only) |
|---|---|---|
| Process model | pm2 + dashboard + one daemon per bot | **single process**, foreground; process lifetime = service lifetime |
| Feishu creds | requires `larkAppSecret`, fails without | **none needed**; never constructs a Feishu Client |
| Bot identity/config source | `~/.botmux/bots.json` / `BOTS_CONFIG` | **ignores bots.json and `BOTS_CONFIG`**; synthesizes exactly one apiOnly bot (still reads the global `~/.botmux/.env` and global config) |
| Outbound | replies posted to a Feishu topic | **no Feishu transport**; results retrieved over HTTP only |
| Bind | dashboard/IPC ports probe as needed | fixed port, `127.0.0.1`, bind-or-fail |
| State dir | `~/.botmux/data` | dedicated `~/.botmux/core-only/<botId>/data` (isolated) |

In one line: **core-only is a headless, single-tenant, loopback-only botmux**. It keeps the full daemon IPC contract but drops the Feishu side.

---

## 2. Startup

Two equivalent ways to start:

```bash
# Option 1: CLI subcommand (recommended — foreground, inherits stdio so a
# launcher can watch the ready line; process lifetime IS the service)
BOTMUX_API_PORT=8930 botmux serve --api-only

# Option 2: run the entrypoint directly (equivalent; for embedded spawn)
BOTMUX_CORE_ONLY=1 BOTMUX_API_PORT=8930 node <pkg>/dist/index-core-only.js
```

Optional env vars / flags (`--flag` wins over the env var):

| Flag | Env var | Default | Meaning |
|---|---|---|---|
| `--port` | `BOTMUX_API_PORT` | (required) | Fixed listen port, bind-or-fail |
| `--bot` | `BOTMUX_API_ONLY_BOT` | `local_riff` | Synthetic bot id; must be `local_<slug>` |
| `--cli` | `BOTMUX_CORE_CLI` | `codex-app` | Which CLI to run (`codex` / `claude-code` / …) |
| `--working-dir` | `BOTMUX_CORE_WORKING_DIR` | cwd | CLI working directory |
| `--state-dir` | `BOTMUX_CORE_STATE_DIR` | `~/.botmux/core-only/<botId>/data` | Dedicated state root |
| (no flag) | `BOTMUX_CORE_MODEL` | unset | Override the synthetic bot's default model (env-only; no matching flag) |

> **Visible TUI vs structured return**: `--cli codex-app` uses the app-server runner — structured return, no visible terminal; `--cli codex` (or `claude-code`) runs a visible TUI in a tmux pane you can watch/operate via the web terminal (see [§6](#6-writable-web-terminal)).

### Readiness contract

The daemon **binds the port first, then completes durable restore**. So "port accepts a connection" ≠ "ready to trigger" — wait for readiness:

- **stdout ready line** (locked contract, regex `^\[core-only\] listening on `):
  ```
  [core-only] listening on 127.0.0.1:8930 (bot local_riff, cli codex-app)
  ```
  This line is printed **only after restore completes**.
- **`GET /healthz`** (public, no auth):
  - not ready → `503 {"ok":false,"status":"starting"}`
  - ready → `200 {"ok":true}`

The readiness barrier **also gates the public control routes**: while restore is incomplete, `/api/trigger`, `/api/sessions/:id/trigger-result`, and `/api/sessions/:id/insight` also return `503 {status:'starting'}` — so even a client that skips the `/healthz` probe cannot trigger into a racing restore. **Recommended: poll `/healthz` until 200 before the first trigger.**

---

## 3. Route boundary: three auth layers

core-only's IPC routes are not a "public vs everything-HMAC" split — there are **three layers**. Integrators only need the first; understanding the other two helps you reason about the threat surface correctly.

**Layer 1 · no-credential integrator surface** (core-only-specific, no HMAC) — this is all you need to integrate botmux:

| Route | Method | Purpose |
|---|---|---|
| `/api/trigger` | POST | Start a turn |
| `/api/sessions/:id/trigger-result` | GET | Poll the final result (four states) |
| `/api/sessions/:id/insight` | GET | Poll conversation / progress |
| `/healthz` | GET | Readiness probe (core-only alias) |

(`/__health` is also **permanently public** in every mode, but it is a **legacy liveness probe that always returns 200** — it is **not** equivalent to `/healthz`: `/healthz` returns `503 {status:'starting'}` until restore/attach/scheduler finish, i.e. it is the core-only **readiness barrier**. To decide "may I start triggering", you **must** use `/healthz`; using `/__health` would read as ready-when-not and trigger too early into a racing restore.)

The three control routes' no-auth is a tight, core-only-specific allowlist — deliberately narrow: an earlier "auth off for all routes" would let a co-resident model turn read/perturb sessions, the scheduler, and mutations. `/api/asks/answer` is **deliberately excluded** (askId-keyed with no session binding — exposing it would let a co-resident turn hijack another pending ask).

**Layer 2 · internal capability / signature routes** (bypass the outer trusted-host HMAC, but each self-authenticates in its handler) — these are **not** public, yet they do **not** require the §4 trusted-host HMAC either. They are verified by a **per-session rotating per-turn capability** (bound to the sessionId in the URL) or by an **independent strong-signature protocol** inside the handler. Examples: `POST /api/session-ready`, `POST /api/asks`, `POST /api/sessions/:id/{slash,cd,close,chat-rename}`, `POST /api/hooks/emit`, `POST /api/attention`, `POST /api/vc-meetings/action-request`, the workflow-v3 mutation prefix. The legitimate caller is the **in-session CLI itself** (which, under sandbox/read-isolation, cannot read the host secret); the capability only proves "I am this session's current-turn CLI" and cannot select another session. Integrators normally don't call this layer.

**Layer 3 · host / operator routes** (require the §4 route+port-bound HMAC) — everything else, including the writable terminal `GET /api/sessions/:id/write-link` and `GET /api/sessions/:id` (metadata). The next section shows how to sign correctly.

> Note on `POST /api/sessions/:id/close`: it can be called by an external host caller with the §4 HMAC, **and** also has a Layer-2 per-session capability channel (the in-session CLI closing itself) — so it isn't part of a blanket "everything else is HMAC-only".

---

## 4. HMAC signing (**the easy trap: bind**)

Signed routes use a loopback HMAC. The request carries three headers:

| Header | Value |
|---|---|
| `X-Botmux-Cli-Ts` | Unix **seconds** timestamp (string); verified within ±30s |
| `X-Botmux-Cli-Nonce` | Random hex (no replay within 60s) |
| `X-Botmux-Cli-Auth` | `HMAC_SHA256(secret, msg)` as **base64url** |

The secret is the **raw 43-char base64url string** in `~/.botmux/.dashboard-secret` — **use it directly as the HMAC key; do NOT base64-decode it to bytes**.

### ⚠️ Key point: `msg` must include the bind

For **Layer-3 host/operator routes** (the third layer in §3, e.g. write-link), core-only runs a **bind-carrying** check at the server layer before the route handler. (Layer-1 public routes verify no signature; Layer-2 internal routes bypass this check and are verified by their handler's own capability / independent signature — neither uses the bind HMAC described here.) The bind ties the signature to "method + path + port", so a captured signature can't be replayed to a different route/port.

```
bind = `${METHOD} ${pathname} ${port}`     // e.g. "GET /api/sessions/<sid>/write-link 8930"
msg  = `${ts}:${nonce}:${bind}`
```

Three things people get wrong:

1. **`port` is the port the service actually bound** (e.g. `8930`), **not** the value in the Host header — the verifier rebuilds the bind with the port it bound.
2. **`pathname` excludes the query string** (use `URL().pathname`).
3. **`secret` is used as a raw string** key; don't decode it.

> Symptom: if you sign bare `ts:nonce` (missing the bind), you get **HTTP 401 `{reason:"sig_mismatch"}`**. Because public routes (trigger-result etc.) verify no signature at all, the bind gap often **surfaces for the first time on write-link** — easy to misdiagnose as a secret/time-window issue.

### Reference implementation

`src/core/daemon-ipc-auth.ts` `daemonIpcAuthHeaders()` in the repo is the authoritative implementation; mirror its logic:

```js
import { createHmac, randomBytes } from 'node:crypto';

function coreOnlyAuthHeaders(secret, method, path, port) {
  const pathname = new URL(path, `http://127.0.0.1:${port}`).pathname; // strip query
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(8).toString('hex');
  const bind = `${method.toUpperCase()} ${pathname} ${port}`;
  const sig = createHmac('sha256', secret)          // secret = raw base64url string
    .update(`${ts}:${nonce}:${bind}`)
    .digest('base64url');
  return {
    'X-Botmux-Cli-Ts': ts,
    'X-Botmux-Cli-Nonce': nonce,
    'X-Botmux-Cli-Auth': sig,
  };
}
```

---

## 5. Trigger & poll

The trigger/poll/cancel **four-state contract is identical to a normal bot** — see [Triggering Tasks via API](/en/api-task-trigger). The core-only-specific differences:

- **An HTTP response mode is mandatory**: an apiOnly bot's trigger must set `options.waitForFinalOutput` (sync) or `options.asyncReturnSessionId` (async), else `400 bad_request` (apiOnly has no Feishu group to reply into, so the result must come back over HTTP).
- An async trigger returns a synthetic `http_async_*` chatId plus a real `sessionId`; poll `trigger-result` with that `sessionId`.
- The user instruction goes in the top-level **`instruction`** field (rendered as a trusted `<botmux_task>`) — not `prompt`.
- `options.model` / `options.reasoningEffort` apply to codex-family fresh triggers.
- **Poll `trigger-result` with the full sessionId** (UUID), not the `[worker:xxxxxxxx]` short tag from logs — the short tag ≠ sessionId and yields `session_not_found`.

```bash
# Trigger (async) — public route, no signature
curl -s http://127.0.0.1:8930/api/trigger -X POST -H 'content-type: application/json' -d '{
  "source": {"type": "custom"},
  "target": {"kind": "turn", "botId": "local_riff"},
  "envelope": {"format": "text", "sourceName": "my-runner", "trusted": false},
  "instruction": "Run the tests and report results",
  "options": {"asyncReturnSessionId": true}
}'
# → {"ok":true, "async":{"sessionId":"<uuid>", ...}}

# Poll — public route, no signature, full sessionId
curl -s "http://127.0.0.1:8930/api/sessions/<uuid>/trigger-result"
# → running / completed / failed / not_found (four states: see api-task-trigger)
```

> **Completion mechanism**: `trigger-result` flips to `completed` when botmux extracts final_output from the CLI transcript. core-only claude-code once had a bug where, after the first-turn ready-gate timed out and fell back, the persisted user line was head-truncated → the completion signal never bound → permanent `running`. Fixed in **v3.9.0** (suffix-anchored content proof to bind the durable mark). Use **v3.9.0 or later**.

---

## 6. Writable web terminal

core-only (tmux backend + a visible CLI) can expose an **operable** web terminal. Get the link via `GET /api/sessions/:id/write-link` (**requires HMAC signing — see §4**):

```bash
# Note: write-link is a signed route; headers must carry the §4 bind signature
curl -s "http://127.0.0.1:8930/api/sessions/<sid>/write-link" \
  -H "X-Botmux-Cli-Ts: ..." -H "X-Botmux-Cli-Nonce: ..." -H "X-Botmux-Cli-Auth: ..."
# → {"ok":true, "url":"http://127.0.0.1:<proxyPort>/s/<sid>?token=<write-token>"}
```

- The returned URL carries a **write token**; opening it gives an editable xterm (`readonly=false`).
- Read-only variant: the read link (`readableTerminalUrlFor` / the card link) carries a `viewToken` (view, no input).
- Backend `zmx` has no web terminal (`409 terminal_unsupported`); tmux/pty support it.

### core-only also ships `readOnlyUrl` / `viewToken` in trigger-result

In core-only, whenever the session has a **live worker terminal** (`workerPort` bound + a view capability minted), the public `GET /api/sessions/:id/trigger-result` response also carries `readOnlyUrl` + `viewToken` (a read-only entry, so riff's in-sandbox runner can open the visible TUI directly). This is core-only-specific: a normal/mixed fleet's trigger-result does **not** emit these fields (there trigger-result is HMAC-gated, and we must not push a terminal read-capability into a poll response); closed / restored sessions with no live worker don't emit them either, so no stale URL is ever advertised. The **write token is only ever obtained via the §4 HMAC `write-link`** — it never appears in trigger-result.

### ⚠️ Prefer "fetch on open" over caching the URL

**The token itself is stable**: production view/write tokens are a **domain-separated HMAC** of the host dashboard secret + sessionId (`deriveTerminalViewToken` / `deriveTerminalWriteToken`, each with a distinct domain prefix), recomputed by `refreshTerminal*Token()` at worker init — so **the same session derives the same token across worker / daemon restart** (`randomBytes` is only the standalone/test fallback when the secret is unavailable). A cached token does not break just because the worker cycled.

Still, **fetch `write-link` fresh on each "open terminal"** — not because the token changes, but because the **rest of the URL does**: proxy port / advertised host / deployment topology, plus whether the worker is currently available (the terminal page must connect to a live worker). Fetching fresh is cheap (loopback + HMAC) and yields a URL that matches the current topology and a worker that is actually online.

- ✅ Recommended: persist only the **stable sessionId**, fetch the URL on "open".
- ⚠️ If you must cache: the token part is reusable, but port/host/worker-availability changes will make a stale URL fail to connect — fetching fresh is simpler.

> A single core-only session is **not idle-reaped** (live-worker cap defaults to 30, with **no idle timeout**; one session is always ≤ cap), so normally the worker stays resident and the terminal remains reachable.

---

## 7. Security boundary (no-transport)

core-only is "no Feishu outbound + single-tenant loopback", with a ring of deliberate hardening around that. Integrators should know:

- **No Feishu Client**: an apiOnly bot never constructs a `Lark.Client`; `larkAppSecret` is **withheld** from workers (not injected into the child env).
- **Config authority**: ignores `~/.botmux/bots.json` and `BOTS_CONFIG`, and the entrypoint **deletes** `process.env.BOTS_CONFIG` — so a forked worker can't `cat $BOTS_CONFIG` to read a real fleet's sibling credentials.
- **State isolation**: the entrypoint **freezes** `SESSION_DATA_DIR` to a dedicated `~/.botmux/core-only/<botId>/data` — a managed turn carrying the host's `SESSION_DATA_DIR` can't point core-only at the real fleet's sessions/pid/descriptor.
- **Loopback freeze**: `BOTMUX_WORKER_HTTP_HOST` and `WEB_EXTERNAL_HOST` are both frozen to `127.0.0.1` (bind and advertised host agree), so the worker web server is never exposed on all interfaces.
- **Skips host maintenance**: core-only does not run fleet-level auto-restart / `botmux restart` / shared-HOME breadcrumb writes; it never touches the global botmux install on the same machine.
- **Auth is still the hard gate**: loopback is connectivity, not identity — same-machine processes (incl. bwrap sandboxes, which normally share the network namespace) can also dial `127.0.0.1`. So beyond §3's Layer-1 three control routes + `/healthz`/`/__health`, every route is authenticated: Layer 2 by a per-session capability / independent strong signature verified in the handler, and Layer-3 host/operator routes by the §4 route+port-bound HMAC. No layer is "bare loopback is enough".

---

## Appendix: core-only endpoint cheat-sheet

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/healthz` | GET | public (layer 1) | Readiness probe (503 starting / 200 ok) |
| `/api/trigger` | POST | public (layer 1) | Start a turn (must set an HTTP response mode) |
| `/api/sessions/:id/trigger-result` | GET | public (layer 1) | Poll the final result (four states); core-only live worker also carries `readOnlyUrl`+`viewToken` |
| `/api/sessions/:id/insight` | GET | public (layer 1) | Poll conversation / progress |
| `/api/sessions/:id/write-link` | GET | **HMAC + bind** (layer 3) | Get the writable terminal URL (fetch on open) |
| `/api/sessions/:id` | GET | **HMAC + bind** (layer 3) | Session metadata |
| `/api/sessions/:id/close` | POST | HMAC + bind (layer 3) **or** in-session capability (layer 2) | Cancel / close the session |

- Three-layer auth model: see §3; integrators only use layer 1.
- Trigger request shape, `errorCode`s, four-state semantics, restart-survival guarantee: see [Triggering Tasks via API](/en/api-task-trigger).
- Reference signing implementation: `src/core/daemon-ipc-auth.ts` (`daemonIpcAuthHeaders`).
