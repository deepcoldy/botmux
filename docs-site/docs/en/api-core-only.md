# Core-only (apiOnly) API Control

> Want to embed botmux in your own system and drive a CLI over HTTP, without touching Feishu? Use core-only.
>
> It is botmux as **one process, on a fixed port, listening only on `127.0.0.1`**: no Feishu credentials, no `bots.json`, no supervisor or dashboard. Your orchestrator (task runner, CI, backend service, sandbox) asks it over HTTP to run a CLI (codex / claude-code / …), polls the result, and opens a web terminal when it needs to see what's happening.

This page is for integrators **embedding botmux into their own product**, for example a botmux inside a sandbox running codex.

If you only want an external system to trigger a **normal bot already running in a Feishu group**, see [Triggering Tasks via API](/en/api-task-trigger). The two pages complement each other: the request body, idempotency and polling states work exactly the same under core-only. This page only covers what's specific to core-only: startup, readiness, interrupting a turn, the web terminal, auth, and the security boundary.

Two related entry points: to start sessions and fetch results from a local script or CI, use [Headless Automation Sessions](/en/headless-session); to let OpenAI-protocol tools reuse a CLI's model login, use [Model Proxy](/en/model-proxy) (it runs a core-only instance underneath).

---

## At a glance

```
Your orchestrator                         botmux serve --api-only (127.0.0.1:8930)
─────────────────                         ─────────────────────────────────────────
1. Start the process, wait for       ──▶  bind port → restore old sessions → print ready line
   GET /healthz → 200
2. POST /api/trigger (async)         ──▶  start the CLI (codex / claude-code …) on the task
                                     ◀──  { sessionId, triggerId }
3. GET  …/trigger-result (poll)      ──▶  running → completed / failed / interrupted
   (optional) POST …/turns/<triggerId>/interrupt  stop only this turn, keep the session
4. (optional) GET …/write-link       ──▶  returns an interactive web terminal URL
   (signed)
```

A typical integration only needs steps 1–3, and none of them require signing.

---

## 1. How it differs from normal botmux

| | `botmux start` (fleet) | `botmux serve --api-only` (core-only) |
|---|---|---|
| Processes | supervisor + dashboard + one daemon per bot | **one process**, in the foreground; the service lives as long as the process |
| Feishu credentials | `larkAppSecret` required | **not needed at all**; never connects to Feishu |
| Bot config | `~/.botmux/bots.json` / `BOTS_CONFIG` | **ignores both**; generates exactly one apiOnly bot (still reads the global `~/.botmux/.env` and global config) |
| Where results go | replies posted to a Feishu topic | **nothing is sent to Feishu**; results are only available over HTTP |
| Port | probes upward if taken | fixed port, `127.0.0.1` only, **exits if it can't bind** |
| Data directory | `~/.botmux/data` | its own `~/.botmux/core-only/<botId>/data` |

In one line: core-only is a **headless, single-tenant, loopback-only** botmux. It keeps the full daemon HTTP interface and just drops the Feishu side.

---

## 2. Startup

```bash
# Recommended: the CLI subcommand. Runs in the foreground and inherits stdout,
# so your launcher can watch for the ready line
BOTMUX_API_PORT=8930 botmux serve --api-only

# Same thing with flags
botmux serve --api-only --port 8930 --cli codex --working-dir /path/to/repo

# With an npm install you can also run the entry file directly (for embedded spawn;
# the single-file binary has no dist/, so use the subcommand above)
BOTMUX_API_PORT=8930 node <pkg>/dist/index-core-only.js
```

Flags and env vars (a flag wins when both are given):

| Flag | Env var | Default | Meaning |
|---|---|---|---|
| `--port` | `BOTMUX_API_PORT` | none, **required** | Listen port; exits if it can't bind |
| `--bot` | `BOTMUX_API_ONLY_BOT` | `local_riff` | Bot id; must look like `local_<name>` (letters, digits, `.`, `_`, `-`) |
| `--cli` | `BOTMUX_CORE_CLI` | `codex-app` | Which CLI to run, e.g. `codex`, `claude-code` |
| `--working-dir` | `BOTMUX_CORE_WORKING_DIR` | current directory | The CLI's working directory |
| `--state-dir` | `BOTMUX_CORE_STATE_DIR` | `~/.botmux/core-only/<botId>/data` | Where session data lives |
| `--backend` | `BOTMUX_CORE_BACKEND` | `tmux` | `tmux` or `pty`. Pick `pty` only if the host can't run a reliable tmux server; with `pty` the terminal can't be reattached after a daemon restart |
| none | `BOTMUX_CORE_MODEL` | unset | Override the default model |
| none | `BOTMUX_CORE_CODEX_AUTH_SYNC` | unset (shared) | Set to `isolated` to make Codex use only this bot's own `CODEX_HOME`, never reading or copying the machine's global login |

**Which CLI?**

- `codex-app` (default): runs through the app-server, returns structured results, **no visible terminal**.
- `codex`, `claude-code`, etc.: run the real TUI in tmux, which you can watch or take over through the web terminal (see section 4).

### When is it "up"?

The daemon **binds the port first, then restores old sessions**. A port that accepts connections isn't ready for tasks yet — wait for readiness:

- **The stdout ready line** (fixed format; match with the regex `^\[core-only\] listening on `), printed only after restore completes:
  ```
  [core-only] listening on 127.0.0.1:8930 (bot local_riff, cli codex-app)
  ```
- **`GET /healthz`** (no signing):
  - not ready → `503 {"ok":false,"status":"starting"}`
  - ready → `200 {"ok":true}`

While not ready, `/api/trigger`, `trigger-result`, `insight`, `host-facts` and the interrupt route also return `503 starting` right away, so even if you skip the probe you can't send a task into a session that is still being restored. Still, the recommended flow is: **poll `/healthz` until 200, then send the first task**.

> `/__health` is public too, but it **always returns 200**. It only tells you the process is alive, not whether it can take tasks.

---

## 3. Running tasks: trigger, poll, interrupt

For the full request body, idempotency keys and polling states, see [Triggering Tasks via API](/en/api-task-trigger). Core-only adds a few rules:

| Rule | Details |
|---|---|
| An HTTP response mode is required | Set `options.waitForFinalOutput` (wait for the result) or `options.asyncReturnSessionId` (get a sessionId back). With neither → `400 bad_request`, since there's no Feishu group to reply into |
| No Feishu targets | A real Feishu `chatId` or `rootMessageId` → `400` |
| You can continue your own session | `target.sessionId` must be one of this service's own sessions; use it to add another turn to the same session |
| The instruction goes in top-level `instruction` | Not `prompt` |
| Poll with the full sessionId | It's a UUID, not the `[worker:xxxxxxxx]` short tag in the logs; the short tag gives `session_not_found` |
| `options.model` / `options.reasoningEffort` | Only apply to CLIs that support switching model / reasoning effort, and only for new sessions; see the trigger docs |

### Trigger and poll

```bash
# Trigger (async): no signing
curl -s http://127.0.0.1:8930/api/trigger -X POST -H 'content-type: application/json' -d '{
  "source": {"type": "webhook"},
  "target": {"kind": "turn", "botId": "local_riff"},
  "envelope": {"format": "text", "sourceName": "my-runner", "trusted": false},
  "instruction": "Run the tests and report results",
  "options": {"asyncReturnSessionId": true}
}'
# → {"ok":true, "triggerId":"trg_...", "async":{"sessionId":"<uuid>", ...}}

# Poll: no signing
curl -s "http://127.0.0.1:8930/api/sessions/<uuid>/trigger-result"
# → state: running / completed / failed / not_found; an interrupted turn is interrupted
```

> Use **v3.9.0 or later**. On older versions, a core-only claude-code first turn could stay `running` forever.

### Stop just this turn (keep the session)

If a task goes off track and you want to stop it but keep the session for more turns, use the interrupt route (no signing):

```bash
curl -s -X POST "http://127.0.0.1:8930/api/sessions/<uuid>/turns/<triggerId>/interrupt"
# → {"ok":true, "action":"interrupted", "sessionId":"<uuid>", "triggerId":"trg_..."}
```

- It only stops **the turn you name**. botmux first confirms the CLI is really running that turn before sending the interrupt; if it can't confirm, it refuses rather than stopping some other turn.
- Polling that turn afterwards returns `state: "interrupted"`. The session stays open, so you can send the next turn with `target.sessionId`.
- Interrupting the same turn again just returns success (with `idempotent: true`).
- Possible failures: `404` (session doesn't exist or is closed, or this session has no such turn), `409` (the turn already finished, isn't running in the current daemon process, or the CLI has already moved past it), `503` (the interrupt wasn't delivered; retry later).

To **close the whole session**, use `POST /api/sessions/:id/close`. It needs signing; see "Close the whole session" in [Triggering Tasks via API](/en/api-task-trigger).

### Reading session-host facts

If you use botmux as a host for CLI sessions and need to know "is this session still there?", read:

```bash
curl -s "http://127.0.0.1:8930/api/sessions/<uuid>/host-facts"
```

It returns `{ ok: true, facts: {...} }` with:

| Field | Meaning |
|---|---|
| `sessionId` / `cli` / `backend` / `sessionStatus` | Session id, CLI, backend (tmux/pty), and whether the session is `active` or `closed` |
| `liveness` | One of `exists` / `missing` / `unknown` |
| `worker.present` / `ready` / `generation` | Whether a worker exists, whether it's ready, and which generation it is |
| `native.sessionId` | The CLI's own session/thread id |
| `native.activeTurnId` | botmux's id for the current turn (not the CLI's internal turn id) |

It **never** returns a tmux socket, PID, worker token, environment variables, or terminal write access.

Two things to keep in mind:

- `unknown` is not `missing`. Don't start a replacement session because of it.
- A CLI turn ending doesn't mean your business task is done. Your orchestrator should still validate the result and save its own evidence before moving its state forward.

---

## 4. Web terminal

With a visible CLI (`--cli codex`, `claude-code`, etc.) you can watch the CLI live in a browser, or even type into it.

### Read-only: already in the poll result

As long as the session's worker is alive, the `trigger-result` response also carries `readOnlyUrl` and `viewToken`. Open `readOnlyUrl` to watch; you can't type.

Once the session is closed, or after a restart before a live worker exists, these fields are left out, so any link you get can actually connect. This is core-only only; a normal fleet's poll response never carries them.

The `viewToken` belongs to the current worker: when the worker restarts it gets a new one and the old link stops working. Use the read-only link from your latest poll; don't cache it long-term.

### Interactive: call `write-link` (signed)

```bash
# write-link needs the section 6 signature headers
curl -s "http://127.0.0.1:8930/api/sessions/<sid>/write-link" \
  -H "X-Botmux-Cli-Ts: ..." -H "X-Botmux-Cli-Nonce: ..." -H "X-Botmux-Cli-Auth: ..."
# → {"ok":true, "url":"http://127.0.0.1:<proxyPort>/s/<sid>?token=<write-token>"}
```

- The URL carries a write token; opening it gives you a terminal you can type into. The write token is **only** available here and never appears in poll results.
- Common errors: `401` (bad signature), `404 session_not_active` (session not running), `409 terminal_unavailable` (the worker terminal isn't available right now).

**Fetch the URL each time you "open the terminal", and store only the sessionId.** A session's write token stays the same across worker cycles and daemon restarts, but the port, host and whether the worker is online can change. Fetching is cheap (a local request plus a signature) and always gives you an address that connects.

> A single core-only session isn't reclaimed for being idle (up to 30 live workers by default, and no idle timeout by default), so the terminal normally stays available.

---

## 5. Which routes need signing

Core-only routes come in three layers. **Integrators only need the first**; the other two help you understand the security boundary.

**Layer 1: public routes (no signing)** — only these:

| Route | Method | Purpose |
|---|---|---|
| `/healthz` | GET | Readiness probe |
| `/api/trigger` | POST | Start a turn |
| `/api/sessions/:id/trigger-result` | GET | Poll the result |
| `/api/sessions/:id/insight` | GET | Poll conversation and progress |
| `/api/sessions/:id/host-facts` | GET | Read session-host facts |
| `/api/sessions/:id/turns/:triggerId/interrupt` | POST | Interrupt only the named turn |

`/__health` is also public in every mode, but it only means the process is alive.

This list is deliberately narrow: other processes on the same machine (including commands the model itself runs) can reach `127.0.0.1` too, so only "drive your own task, read your own result" is open. For example `/api/asks/answer`, which answers an AskUserQuestion, is **not** on the list: it isn't tied to a session, so opening it would let another process answer on your behalf.

**Layer 2: in-session routes (the CLI proves who it is)**. For example `POST /api/session-ready`, `POST /api/asks`, `POST /api/sessions/:id/{slash,cd,close,…}`, `POST /api/hooks/emit`. The caller is the CLI inside the session, using a per-turn rotating credential bound to its session, so it can only act on its own session. Integrators normally don't call these.

**Layer 3: host / operator routes (need the section 6 signature)**. Everything not in the first two layers, e.g. `GET /api/sessions/:id/write-link`, `GET /api/sessions/:id` (session details), `POST /api/sessions/:id/close`.

> `close` is a special case: external callers must sign, and the in-session CLI can also close itself with its layer-2 credential.

---

## 6. How to sign (the usual mistake is the bind)

Signed requests carry three headers:

| Header | Value |
|---|---|
| `X-Botmux-Cli-Ts` | Unix timestamp in **seconds**; allowed skew ±30 seconds |
| `X-Botmux-Cli-Nonce` | Random hex string; must not repeat within 60 seconds |
| `X-Botmux-Cli-Auth` | `HMAC_SHA256(secret, msg)`, encoded as **base64url** |

`secret` is the 43-character base64url text in `~/.botmux/.dashboard-secret`. **Use it as-is as the key; don't base64-decode it first.** The request must come from a loopback address.

`msg` must include the bind, which ties the signature to "method + path + port" so it can't be replayed against another route:

```
bind = `${METHOD} ${pathname} ${port}`     // e.g. "GET /api/sessions/<sid>/write-link 8930"
msg  = `${ts}:${nonce}:${bind}`
```

Three common mistakes:

1. `port` is the port the service **actually listens on** (e.g. `8930`), not the value in the Host header.
2. `pathname` **has no query string** (use `new URL(...).pathname`).
3. `secret` is the raw string; don't decode it.

> If you sign only `ts:nonce` and forget the bind, you get `401 {"reason":"sig_mismatch"}`. Because public routes don't check signatures, this usually shows up **the first time you call write-link**, and it's easy to mistake for a wrong secret or clock. Other `reason` values: `ts_window` (clock off by more than 30 seconds), `replay` (repeated nonce), `missing_headers`.

Reference implementation (same logic as `daemonIpcAuthHeaders()` in `src/core/daemon-ipc-auth.ts`):

```js
import { createHmac, randomBytes } from 'node:crypto';

function coreOnlyAuthHeaders(secret, method, path, port) {
  const pathname = new URL(path, `http://127.0.0.1:${port}`).pathname; // strip the query string
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

## 7. Security boundary

Core-only doesn't talk to Feishu, serves a single tenant, and only uses loopback. Around that, it isolates itself by default:

- **No Feishu**: never creates a Feishu client, and never hands `larkAppSecret` to CLI child processes.
- **No real bot config**: ignores `~/.botmux/bots.json` and removes `BOTS_CONFIG` from the environment, so the CLI can't read other bots' credentials on the same machine.
- **Separate data directory**: session data always lives in `~/.botmux/core-only/<botId>/data` (or your `--state-dir`). An inherited `SESSION_DATA_DIR` from a parent process can't point it at the real fleet's data. The internal signing key used for task reports also lives separately in this directory and is never shared with a fleet on the same machine. (The `~/.botmux/.dashboard-secret` used for section 6 signatures is a different thing.)
- **Local only**: the worker's web server and the advertised terminal address are both fixed to `127.0.0.1`, never exposed on other interfaces.
- **Leaves the host install alone**: no auto-update, auto-restart or `botmux restart`. The `botmux` command wrapper for the CLI goes into `bin/` under its own data directory and never overwrites the machine's `~/.botmux/bin`.
- **Loopback isn't trust**: other processes on the machine (including sandboxes that share the network by default) can also reach `127.0.0.1`, so every route outside layer 1 requires auth.

---

## Appendix: route cheat-sheet

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/healthz` | GET | public | Readiness probe (503 starting / 200 ok) |
| `/api/trigger` | POST | public | Start a turn (an HTTP response mode is required) |
| `/api/sessions/:id/trigger-result` | GET | public | Poll the result; carries `readOnlyUrl` + `viewToken` while the worker is alive |
| `/api/sessions/:id/insight` | GET | public | Poll conversation and progress |
| `/api/sessions/:id/host-facts` | GET | public | Session, CLI, backend and liveness |
| `/api/sessions/:id/turns/:triggerId/interrupt` | POST | public | Interrupt only the named turn; the session stays open |
| `/api/sessions/:id/write-link` | GET | **signed** | Interactive web terminal URL (fetch when opening) |
| `/api/sessions/:id` | GET | **signed** | Session details |
| `/api/sessions/:id/close` | POST | **signed**, or the in-session CLI's own credential | Close the session |

For request fields, error codes, what each polling state means and restart behavior, see [Triggering Tasks via API](/en/api-task-trigger).
