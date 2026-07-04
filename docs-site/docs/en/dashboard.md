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

## Deployment details

The dashboard runs as a separate pm2 process `botmux-dashboard`, starting and stopping together with the daemon. Each daemon exposes an internal IPC on `127.0.0.1` (local only), and the dashboard process acts as a reverse proxy + HMAC auth (`~/.botmux/.dashboard-secret`, mode 0600, never sent down to the browser).
