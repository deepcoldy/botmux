# Dashboard Control Panel

The `botmux dashboard` command produces a one-time token URL for unified control across all daemons / bots in the browser.

```bash
botmux dashboard
# Output: http://<lan-ip>:7891/?t=<token>
```

> Each run rotates a new token, and the old URL is invalidated immediately — a one-time, one-secret way of fetching the link.

![Dashboard Groups panel](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780033300739_dash-groups.png)
<p class="cap">Groups panel: a chat × bot matrix that shows at a glance which bots are in which groups</p>

## Features

- **Sessions**: lists active + closed sessions across all bots, filterable by CLI / status / adopt / text. Open a detail view to "locate in the Lark topic" (the bot posts a 📍 marker in the original topic + auto-opens a chat AppLink), copy various IDs, and close sessions; multi-select batch close is supported.
- **Schedules**: lists all scheduled tasks, with Run now / Pause / Resume.
- **Groups**: one-click create a new group, add bots to a group, auto-transfer group ownership, and @ reminders; disband groups and have bots leave groups (associated sessions are cleaned up automatically).
- **Team / Roles / Bot Defaults**: the Team panel handles [cross-deployment collaboration](/en/roles) (invite someone else's deployment into your team, create cross-deployment groups); Roles manages each bot's per-group persona; Bot Defaults (Bot configuration) sets default behaviors (new-group on-call, card signature, **default role**, etc.).
- **Workflows control panel**: Run List polling; Run Detail shows the summary / dangling red zone / node-activity / event timeline / concurrent-execution timeline; you can cancel a run directly, approve/reject a humanGate; the Workflow Catalog lists all workflows and can trigger them with parameters.

## External read-only queries

The Dashboard HTTP service exposes two session read surfaces for the board and external observers:

- `GET /api/sessions`: the current aggregate of active + closed session rows.
- `GET /events`: the Dashboard's external SSE stream. For session events, `session.spawned` carries the full values in `body.session`, while `session.update` carries changes in `body.patch`. Each daemon also has a loopback-only `/api/events` endpoint for Dashboard aggregator IPC; it is not the external URL.

The following fields are all **optional**. Consumers must handle older sessions/daemons that omit them:

| Field | Meaning |
|------|---------|
| `backendType` | The effective backend recorded for the latest worker spawn (`pty` / `tmux` / `herdr` / `zellij` / `zmx`), suitable for filtering/display; it may change after a cold resume |
| `backendSessionName` | Present only for managed persistent-backend sessions; currently `bmx-<first 8 chars of sessionId>`. PTY, adopted, and some legacy rows omit it. It is deterministic locator metadata and **does not prove that the process/socket is currently live** |
| `titleUpdatedAt` | ISO-8601 timestamp of the last title update |
| `titleSource` | Title-source tag: `initial` / `user` / `agent` / `cli` / `dashboard` / `system`. It is display/debug metadata, **not a trusted identity or audit field** |

### `publicReadOnly` and the token boundary

`publicReadOnly` is on by default. While it is enabled, `GET /api/sessions` and `GET /events` are reachable **without a token** on the Dashboard listener, so session names, titles, backends, and the other row metadata must be treated as public to that network.

- Every POST / PATCH / DELETE mutation, every GET outside the read-only allow-list, and every raw PTY / diagnostic log still requires the current token issued by `botmux dashboard`. The allow-list is fail-closed: a newly added GET endpoint does not become public merely because public read-only mode is enabled.
- Each `botmux dashboard` invocation rotates the token and invalidates the previous link. The token is application-layer Dashboard access, not a replacement for host firewall, VPN, or reverse-proxy authentication.
- If tokenless observation is unnecessary, turn off **Public read-only** under Dashboard Settings. You can also start with `BOTMUX_DASHBOARD_PUBLIC_READONLY=false`; once the setting has been saved in the UI, the persisted value in `~/.botmux/config.json` takes precedence over the environment variable.

## Deployment details

The dashboard runs as a separate pm2 process `botmux-dashboard`, starting and stopping together with the daemon. Each daemon exposes an internal IPC on `127.0.0.1` (local only), and the dashboard process acts as a reverse proxy + HMAC auth (`~/.botmux/.dashboard-secret`, mode 0600, never sent down to the browser).
