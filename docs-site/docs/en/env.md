# Environment Variables and File Locations

Most configuration goes through `bots.json` / the dashboard — you **usually don't need env vars**. Only a few machine-level switches (bind address / port / backend type / external host) live in `~/.botmux/.env`. This page also lists botmux's key file locations for backup / troubleshooting.

**Applies to**: the dashboard / web terminal won't open or you need to change the bind address, pin a port, switch the pty/tmux backend, or find where config / logs / credentials live.

## Environment variables (set in `~/.botmux/.env`)

| Variable | Default | Description |
|------|------|------|
| `BOTS_CONFIG` | _(unset)_ | Path to bots.json (overrides the default location) |
| `WEB_HOST` | `0.0.0.0` | HTTP service bind address |
| `WEB_EXTERNAL_HOST` | _(auto-detect LAN IP)_ | External hostname/IP used in terminal links (for public/intranet-domain access, see [Web Terminal](/en/web-terminal)) |
| `WEB_EXTERNAL_PORT` | _(local proxy port)_ | External port used in terminal links, overriding the local proxy port (`8800 + botIndex`) so a relay host can listen on a different port number; in a multi-bot setup it's the base port, with the actual port being `WEB_EXTERNAL_PORT + botIndex` (see [Web Terminal](/en/web-terminal)) |
| `SESSION_DATA_DIR` | `~/.botmux/data` | Session and queue storage directory |
| `BACKEND_TYPE` | _(default tmux)_ | Explicitly set `pty` to fall back to a pure pty backend (the default is always tmux — no auto-fallback to pty; an unavailable tmux hard-gates with a card). pty doesn't survive daemon restarts |
| `BOTMUX_FORWARD_FOLLOWUP_WAIT_MS` | `1500` | Milliseconds to hold a new topic for a root-linked clarification from the same user in the same chat; `0` disables it, maximum `10000` |
| `DEBUG` | _(unset)_ | Set to `1` to enable debug logging |
| `GITHUB_TOKEN` | _(unset)_ | Auth token for GitHub Releases API requests made by botmux itself, including dashboard changelog, update checks, and restart-report. Takes precedence over `GH_TOKEN`. |
| `GH_TOKEN` | _(unset)_ | Fallback auth token for GitHub Releases API requests. Used only when `GITHUB_TOKEN` is unset. |

> `GITHUB_TOKEN` / `GH_TOKEN` may be provided in the calling process environment or in `~/.botmux/.env` so both the daemon and the standalone Dashboard process can read them.
> botmux uses these tokens only for its own GitHub requests and strips them from default worker / agent inheritance. If a specific bot should receive a token explicitly, configure it in that bot's own `env`.

### Dashboard-related

| Variable | Default | Description |
|------|------|------|
| `BOTMUX_DASHBOARD_HOST` | `0.0.0.0` | Dashboard HTTP bind address |
| `BOTMUX_DASHBOARD_PORT` | `7891` | Dashboard HTTP port |
| `BOTMUX_DASHBOARD_EXTERNAL_HOST` | `WEB_EXTERNAL_HOST` or auto-detect | Host used in URLs the CLI prints |
| `BOTMUX_PUBLIC_URL` | _(unset)_ | Self-hosted reverse-proxy base (`scheme://host[:port]`). Set it when you don't use the central platform but front the dashboard with your own nginx etc. on a single public/intranet domain; dashboard and card terminal links then emit `<base>/…` and `<base>/s/<sessionId>` through the dashboard front door, with no per-bot port. Unset falls back to the local `host:port`. Must be written into `~/.botmux/.env` (a restart launched from inside a session reads only the file, it does not inherit the shell) |
| `BOTMUX_DEVBOX_AUTO_EXPORT` | `1` | On a Merlin Devbox with an exportable Dashboard port, automatically creates or reuses a private short link. Skipped when the central platform or `BOTMUX_PUBLIC_URL` is configured. Set to `0` or `false` to disable; failures and timeouts fall back silently to the local URL. |
| `BOTMUX_DAEMON_IPC_BASE_PORT` | `7892` | Each daemon's IPC port = base + botIndex |
| `BOTMUX_WORKFLOW_RUNS_DIR` | `~/.botmux/workflow-runs` | Workflow run storage directory |
| `BOTMUX_DASHBOARD_PUBLIC_READONLY` | `true` | Allow tokenless access to the Dashboard's allow-listed read-only APIs / SSE. Once this switch has been saved in Dashboard Settings, the value persisted in `~/.botmux/config.json` takes precedence over this environment variable |

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
