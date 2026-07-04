# Environment Variables and File Locations

## Environment variables (set in `~/.botmux/.env`)

| Variable | Default | Description |
|------|------|------|
| `BOTS_CONFIG` | _(unset)_ | Path to bots.json (overrides the default location) |
| `WEB_HOST` | `0.0.0.0` | HTTP service bind address |
| `WEB_EXTERNAL_HOST` | _(auto-detect LAN IP)_ | External hostname/IP used in terminal links (for public/intranet-domain access, see [Web Terminal](/en/web-terminal)) |
| `WEB_EXTERNAL_PORT` | _(local proxy port)_ | External port used in terminal links, overriding the local proxy port (`8800 + botIndex`) so a relay host can listen on a different port number; in a multi-bot setup it's the base port, with the actual port being `WEB_EXTERNAL_PORT + botIndex` (see [Web Terminal](/en/web-terminal)) |
| `SESSION_DATA_DIR` | `~/.botmux/data` | Session and queue storage directory |
| `BACKEND_TYPE` | _(auto-detect)_ | `pty` forces a downgrade to pure pty mode |
| `DEBUG` | _(unset)_ | Set to `1` to enable debug logging |

### Dashboard-related

| Variable | Default | Description |
|------|------|------|
| `BOTMUX_DASHBOARD_HOST` | `0.0.0.0` | Dashboard HTTP bind address |
| `BOTMUX_DASHBOARD_PORT` | `7891` | Dashboard HTTP port |
| `BOTMUX_DASHBOARD_EXTERNAL_HOST` | `WEB_EXTERNAL_HOST` or auto-detect | Host used in URLs the CLI prints |
| `BOTMUX_DAEMON_IPC_BASE_PORT` | `7892` | Each daemon's IPC port = base + botIndex |
| `BOTMUX_WORKFLOW_RUNS_DIR` | `~/.botmux/workflow-runs` | Workflow run storage directory |

## File locations

| Path | Description |
|------|------|
| `~/.botmux/bots.json` | Bot configuration |
| `~/.botmux/.env` | Environment variables |
| `~/.botmux/data/` | Session data, message queues |
| `~/.botmux/logs/` | Daemon logs |
| `~/.botmux/bin/botmux` | In-session wrapper script (written automatically) |
| `~/.botmux/lark-scopes.json` | Full permission-request JSON |
| `~/.botmux/.dashboard-secret` | Dashboard HMAC secret (0600) |
