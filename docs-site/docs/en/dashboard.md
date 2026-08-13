# Dashboard Control Panel

The `botmux dashboard` command prints the current rotating login-token URL for unified control across all daemons / bots in the browser.

```bash
botmux dashboard          # Get the current URL, creating the first token if absent
botmux dashboard current  # Explicit form of the same operation
botmux dashboard rotate   # Rotate the token and print the new URL
# Output: http://<lan-ip>:7891/?t=<token>
```

> This is a **rotating login token**: a URL stays valid until `botmux dashboard rotate` replaces it and invalidates the old URL; the token is persisted and survives a `botmux restart`. The bare/current command reuses that token, creating the first one when absent. A successful `?t=` visit just writes the same token into a cookie — it does not consume or revoke it, so the same URL logs in repeatedly until rotation. Sharing the URL ≈ sharing the login state, so keep it safe. Default port `7891`, overridable via `BOTMUX_DASHBOARD_PORT`.

![Dashboard Groups panel](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780033300739_dash-groups.png)
<p class="cap">Groups panel: a chat × bot matrix that shows at a glance which bots are in which groups</p>

## Features

- **Sessions**: lists active + closed sessions across all bots, filterable by CLI / status / adopt / text. Open a detail view to copy various IDs, close sessions, and multi-select batch close; "locate topic" has the bot post an **@-mention of the session owner** in the original topic (a bare @, no other text) to help you jump back to the context. Chat-scope session rows also carry a Lark group AppLink straight to the chat.
- **Chat**: a conversation console over the whole session pool — the left rail groups every session by group, the center shows the session's archived conversation (user turns + bot final replies, Markdown-rendered), and the composer sends a message straight into the session without touching Feishu. Every turn (IM and console alike) is archived locally under `<dataDir>/messages/<sessionId>.jsonl`, so history keeps working even when the Lark API is unreachable; by default a console reply is suppressed from Feishu (uncheck **Keep reply out of Feishu** to post it like a normal IM turn), and the Feishu bot keeps working normally for everyone else.
- **Schedules**: lists all scheduled tasks, with Run now / Pause / Resume.
- **Groups**: one-click create a new group (auto @-notifies the invited user), add bots to a group, and auto-transfer group ownership; disband groups and have bots leave groups (associated sessions are cleaned up automatically).
- **Team / Roles / Bot Defaults**: the Team panel handles [cross-deployment collaboration](/en/roles) (invite someone else's deployment into your team, create cross-deployment groups); Roles manages each bot's per-group persona; Bot Defaults (Bot configuration) sets default behaviors (new-group on-call, card signature, **default role**, etc.).
- **Workflows control panel**: Run List polling; Run Detail shows the summary / dangling red zone / node-activity / event timeline / concurrent-execution timeline; you can **cancel a run** directly.

> **Two things live outside the Dashboard**: a v3 workflow's **humanGate approve / reject** happens on a **Lark approval card** (not clicked in the Dashboard); triggering a workflow with parameters currently goes through the **connector (Webhook)** path (see [Connectors](/en/webhook)) — there is no "Workflow Catalog + parameterized trigger" page in the Dashboard. The Dashboard's Workflows panel focuses on observation and cancel.

## External read-only queries

The primary external observation surfaces documented here are:

- `GET /api/dashboard/v1/summary`: a versioned, strongly redacted fleet summary.
- `GET /api/sessions`: the current aggregate of active + closed session rows.
- `GET /events`: the Dashboard's external SSE stream. For session events, `session.spawned` carries the full values in `body.session`, while `session.update` carries changes in `body.patch`. Each daemon also has a loopback-only `/api/events` endpoint for Dashboard aggregator IPC; it is not the external URL.

### Dashboard Summary API

`GET /api/dashboard/v1/summary` lets an external status page, monitor, or orchestrator treat a regular botmux fleet as a long-running daemon service. It reads live sessions and schedules from the currently online daemons, then returns only positively allow-listed status and counts. It never returns bot or session IDs, titles, group names, working directories, prompts, schedule contents, or diagnostic logs. Its 200, 429, and 503 responses include `Cache-Control: no-store`.

> This is a **Dashboard facade for regular fleet mode**, served by the `botmux-dashboard` process started alongside `botmux start`. `botmux serve --api-only` is a core-only, single-process mode that does not start the Dashboard, so this route does not exist there. See [Core-only API Control](/en/api-core-only) for that mode's health and control endpoints.

A successfully generated snapshot returns HTTP 200. A 200 means that snapshot generation succeeded; `service.status` is still `degraded` when a configured bot is offline:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-09T02:30:00.000Z",
  "service": { "status": "healthy" },
  "bots": { "online": 3 },
  "sessions": { "active": 7, "attention": 1 },
  "schedules": {
    "enabled": 2,
    "nextRunAt": "2026-08-09T04:00:00.000Z"
  },
  "dashboard": { "href": "/" }
}
```

| Field | Meaning |
|------|---------|
| `schemaVersion` | Response-contract version; currently `1` |
| `generatedAt` | ISO-8601 time at which the Dashboard generated this live snapshot |
| `service.status` | `healthy` when the online bot count equals the configured bot count; otherwise `degraded` |
| `bots.online` | Number of currently online daemons / bots |
| `sessions.active` | Sessions from online daemons whose status is not `closed` |
| `sessions.attention` | Active sessions requiring attention, including repository selection, a TUI prompt, agent attention, and the `limited` or `stalled` states |
| `schedules.enabled` | Enabled schedules from online daemons |
| `schedules.nextRunAt` | Earliest valid next-run time among enabled schedules (ISO-8601), or `null` when none exists |
| `dashboard.href` | Relative path to the Dashboard root; resolve it against the current Dashboard origin |

If any live daemon's sessions or schedules snapshot times out, fails, or has a malformed shape, the endpoint returns HTTP 503. Count fields are deliberately omitted rather than presenting missing state as zero:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-09T02:30:00.000Z",
  "service": { "status": "degraded" }
}
```

Anonymous requests are subject to a rolling, **Dashboard-process-global** limit shared by every anonymous caller: at most 5 requests in any 10-second window. The sixth request returns HTTP 429:

```json
{
  "error": "rate_limited",
  "retryAfterSeconds": 7
}
```

The `Retry-After` response header carries the same decimal number of seconds (at least `1`, normally `1`–`10`); wait that long before retrying. Requests authenticated with the current Dashboard token are exempt from the anonymous limit. Authentication uses the existing Dashboard login state: a valid `?t=<token>` first returns a 302, sets the `botmux_dashboard_token` cookie, and redirects to the URL without the query. A pure API client that needs the exemption must retain and return that cookie. `Authorization: Bearer` is not accepted here.

### Session row optional fields

The following fields belong only to the richer `/api/sessions` rows and `/events` session payloads; they are never returned by the summary endpoint. They are all **optional**, so consumers must handle older sessions/daemons that omit them:

| Field | Meaning |
|------|---------|
| `backendType` | The effective backend recorded for the latest worker spawn (`pty` / `tmux` / `herdr` / `zellij` / `zmx`), suitable for filtering/display; it may change after a cold resume |
| `backendSessionName` | Present only for managed persistent-backend sessions; currently `bmx-<first 8 chars of sessionId>`. PTY, adopted, and some legacy rows omit it. It is deterministic locator metadata and **does not prove that the process/socket is currently live** |
| `titleUpdatedAt` | ISO-8601 timestamp of the last title update |
| `titleSource` | Title-source tag: `initial` / `user` / `agent` / `cli` / `dashboard` / `system`. It is display/debug metadata, **not a trusted identity or audit field** |

### `publicReadOnly` and the token boundary

`publicReadOnly` is on by default. While it is enabled, allow-listed reads including `GET /api/dashboard/v1/summary`, `GET /api/sessions`, and `GET /events` are reachable **without a token** on the Dashboard listener. The summary contains only the strongly redacted aggregate above; session names, titles, backends, and the other session/event row metadata must be treated as public to that network.

- Every POST / PATCH / DELETE mutation, every GET outside the read-only allow-list, and every raw PTY / diagnostic log still requires the current token issued by `botmux dashboard`. The allow-list is fail-closed: a newly added GET endpoint does not become public merely because public read-only mode is enabled.
- When `publicReadOnly` is off, a tokenless summary request returns 401. A request carrying the current token remains available and is exempt from the anonymous rate limit. In public read-only mode, an incorrect or rotated old token is treated as anonymous.
- `botmux dashboard` and `botmux dashboard current` reuse the current token (creating the first one when absent); `botmux dashboard rotate` explicitly replaces it and invalidates the previous link. The token is application-layer Dashboard access, not a replacement for host firewall, VPN, or reverse-proxy authentication.
- If tokenless observation is unnecessary, turn off **Public read-only** under Dashboard Settings. You can also start with `BOTMUX_DASHBOARD_PUBLIC_READONLY=false`; once the setting has been saved in the UI, the persisted value in `~/.botmux/config.json` takes precedence over the environment variable.

## Deployment details

The dashboard runs as a separate pm2 process `botmux-dashboard`, starting and stopping together with the daemon. Each daemon exposes an internal IPC on `127.0.0.1` (local only), and the dashboard process acts as a reverse proxy + HMAC auth: the secret file `~/.botmux/.dashboard-secret` (mode 0600) is the internal daemon↔dashboard signing key and is **never sent down to the browser** (the browser side uses the rotating login token above).
