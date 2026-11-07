# Environment Variables and File Locations

Most settings live in `bots.json` and the Dashboard, so **you usually don't need environment variables**. Only a few machine-wide switches (bind address, ports, external address, backend type, and so on) go in `~/.botmux/.env`. This page lists those switches and where botmux keeps its key files, for backup and troubleshooting.

**When to read this page**: the Dashboard or web terminal won't open, you need to change a bind address or port, terminal links show the wrong address, you want the pty backend, or you're looking for config / logs / data.

> This page covers **botmux's own processes**. To control which variables the CLI inside a session receives, use the Dashboard: "Settings → Session environment" (global) or "Bot settings → Advanced → Startup environment → Session environment" (per bot). See [bots.json → Session environment](/en/bots-json#session-env).

## How to change a setting

1. Edit `~/.botmux/.env`, one `KEY=value` per line:

   ```bash
   # ~/.botmux/.env
   WEB_EXTERNAL_HOST=10.0.0.12
   BOTMUX_DASHBOARD_PORT=7891
   ```

2. Restart to apply:

   ```bash
   botmux restart
   ```

**Put values in the file instead of only `export`ing them in a shell.** A restart that a bot runs from inside a Feishu session reads only `~/.botmux/.env` and does not inherit your shell. A value you only exported is lost on the next in-session restart.

## Network and access addresses

These decide whether other people can open web terminal and Dashboard links.

| Variable | Default | Purpose |
|------|------|------|
| `WEB_HOST` | `0.0.0.0` | Address the web terminal service listens on |
| `WEB_EXTERNAL_HOST` | Local LAN IP, auto-detected | Hostname / IP used in terminal links on cards. Set it when the machine has several NICs or you access it by domain (see [Web Terminal](/en/web-terminal)) |
| `BOTMUX_WEB_PROXY_BASE_PORT` | `8800` | Each bot's terminal entry port = this value + bot index (bot 1 is 8800, bot 2 is 8801, …) |
| `WEB_EXTERNAL_PORT` | Unset, uses the local port | Set when a relay host exposes a different port than the local one. Also offset per bot: the real port is `WEB_EXTERNAL_PORT + bot index` |
| `BOTMUX_WORKER_HTTP_HOST` | `0.0.0.0` | Listen address of each session's terminal sub-service (the old name `BOTMUX_WORKER_HOST` still works) |
| `BOTMUX_DASHBOARD_HOST` | `0.0.0.0` | Dashboard listen address |
| `BOTMUX_DASHBOARD_PORT` | `7891` | Dashboard port. If it's taken, botmux tries the next free port; the actual port is written to `~/.botmux/.dashboard-port` |
| `BOTMUX_DASHBOARD_EXTERNAL_HOST` | `WEB_EXTERNAL_HOST`, then a non-wildcard listen address, then the LAN IP | Hostname used when `botmux` commands print Dashboard links |
| `BOTMUX_PUBLIC_URL` | Unset | Set it when you put the Dashboard behind your own nginx (or similar) on one domain, e.g. `https://botmux.example.com`. Dashboard and card terminal links then become `<this URL>/…` and `<this URL>/s/<session ID>`, so you expose a single entry point instead of one port per bot |
| `BOTMUX_DEVBOX_AUTO_EXPORT` | On | On a Merlin Devbox, automatically creates a private short link for the Dashboard. Skipped when central-platform remote access or `BOTMUX_PUBLIC_URL` is configured. Set `0` or `false` to turn it off; on failure botmux falls back to the local address |
| `BOTMUX_DAEMON_IPC_BASE_PORT` | `7950` | Internal port used between bot background processes = this value + bot index, local-only. Rarely needs changing unless ports collide |

> Which address Dashboard links use: central platform (when remote access is on) > `BOTMUX_PUBLIC_URL` > Devbox short link > local `host:port`. Terminal links follow the same order, minus the Devbox short link.

## Dashboard access control

| Variable | Default | Purpose |
|------|------|------|
| `BOTMUX_DASHBOARD_PUBLIC_READONLY` | `true` | Allows read-only browsing of the Dashboard (sessions, schedules, …) without a token, so stale links still work; writes still need a token. Set `false` to disable. **Note**: once you change this switch on the Dashboard "Settings" page, the value in `~/.botmux/config.json` wins and the environment variable no longer applies |
| `BOTMUX_DASHBOARD_TERMINAL_CONTROL_TTL_MS` | `300000` (5 minutes) | How long you can type after "taking over" a terminal in the Dashboard, between 10 seconds and 15 minutes. It returns to read-only on expiry, release, or disconnect |
| `BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH` | `~/.botmux/audit/dashboard-control.ndjson` | Audit log for terminal takeover and similar actions. Records only time, user, session, and action, never typed input |

### Open the Dashboard from Feishu without logging in (optional)

Off by default. When on, you can open the Dashboard straight from a Feishu H5 app without a token in the link; only users on the allow list get in.

| Variable | Description |
|------|------|
| `BOTMUX_DASHBOARD_FEISHU_H5_ENABLED` | Set `true` to enable |
| `BOTMUX_DASHBOARD_FEISHU_H5_APP_ID` / `_APP_SECRET` | Credentials of the Feishu app used for login |
| `BOTMUX_DASHBOARD_FEISHU_H5_ALLOWED_OPEN_IDS` | Users allowed to sign in, comma-separated (open_ids under that app) |
| `BOTMUX_DASHBOARD_FEISHU_H5_BRAND` | `feishu` (default) or `lark` |
| `BOTMUX_DASHBOARD_FEISHU_H5_ENTRY_PATH` | Login entry path, default `/auth/feishu` |
| `BOTMUX_DASHBOARD_FEISHU_H5_SESSION_TTL_MS` | Login lifetime, default 30 minutes, range 1 minute to 24 hours |
| `BOTMUX_DASHBOARD_FEISHU_H5_SECURE_COOKIE` | Set `true` when TLS terminates at an upstream proxy but `BOTMUX_PUBLIC_URL` isn't an `https://` URL |
| `BOTMUX_DASHBOARD_FEISHU_H5_TRUSTED_PROXY_HOPS` | Number of reverse proxies in front of the Dashboard (default `0`, range 0–8), so rate limiting sees the real client IP |

These variables (including the app secret) are used only by the Dashboard process. Bot background processes and session CLIs never receive them.

## Sessions and behavior

| Variable | Default | Purpose |
|------|------|------|
| `BACKEND_TYPE` | `tmux` | Session backend. tmux is always the default; if tmux is unavailable you get a card telling you so, and botmux does not silently switch to pty. Only an explicit `pty` selects the plain pty backend, and pty sessions don't survive a botmux restart (see [tmux backend](/en/tmux)) |
| `BOTMUX_FORWARD_FOLLOWUP_WAIT_MS` | `1500` | After a new topic is posted in a topic group, how long to wait for the same person's immediate follow-up so both go to the CLI together. `0` disables, max `10000` |
| `BOTMUX_SENDER_RESOLVE_TIMEOUT_MS` | `800` | Per-step timeout (ms) for looking up the sender's display name. Try `3000` on slow networks (at most 6 seconds if both steps time out). Owner identity checks keep their own 3-second budget |
| `BOTMUX_ASK_TIMEOUT_MS` | `86400000` (24 hours) | How long a CLI question turned into a Feishu card waits for an answer. After a timeout the question falls back to the terminal and can no longer be answered from Feishu, so the default is long on purpose. Shortening it is not recommended |
| `BOTMUX_PERMISSION_TIMEOUT_MS` | `600000` (10 minutes) | How long a tool-permission card waits. On timeout the request is denied and the session keeps going. Clamped to 1 second–14 minutes |
| `STUCK_DETECTOR_ENABLED` | On | When an input hasn't finished a turn for a while, checks whether the CLI is stuck on a Codex hook-review screen and warns you if so. Set `false` to disable |
| `STUCK_DETECTOR_TIMEOUT_MS` | `45000` | How long (ms) after an input the check above runs |
| `BOTMUX_SCHEDULE_TIMEZONE` | Unset: the timezone chosen on the page, else the host timezone | Timezone for [scheduled tasks](/en/schedule), e.g. `Asia/Shanghai`. Takes priority over the timezone chosen on the Global Settings page; invalid names are ignored |
| `BOTMUX_RECOVERY_FORK_BATCH` | `5` | When botmux restarts and recovers sessions, how many it relaunches per batch, so they don't all start at once and swamp the machine. Minimum `1` |
| `BOTMUX_RECOVERY_FORK_DELAY_MS` | `250` | Pause (ms) between recovery batches. Minimum `0` |
| `BOTMUX_WORKTREE_SLUG_AI_ENABLED` | Off | Set `true` to name new worktree branches with AI. See "Name worktrees with AI" below |
| `BOTMUX_ALLOW_UNKNOWN_SCOPES` | Unset | Set `1` to request Feishu scopes not yet in botmux's scope list (syntax check only). A stopgap when Feishu ships a new scope before a botmux release |
| `BOTMUX_CODEX_NODE_REPL_PATH` | Unset | Absolute path to an installed Codex `node_repl` executable, for opt-in browser features when no MCP runtime is configured |

`BOTMUX_ASK_TIMEOUT_MS` and `BOTMUX_PERMISSION_TIMEOUT_MS` are read by the CLI inside the session, which inherits them from `~/.botmux/.env` by default. Because they start with `BOTMUX`, they are botmux-reserved and can't be set per bot in the session environment. When a bot uses [strict process environment](/en/bots-json#strict-env), they don't reach the session and the defaults apply.

### Name worktrees with AI (optional)

Off by default. When botmux auto-names a new worktree branch (e.g. `/repo wt`), it uses a local naming rule. When on, it calls an OpenAI-compatible API you configure instead, and **sends the topic title / first message to that API**. When off, incomplete, or the request fails, the local rule is used.

| Variable | Default | Purpose |
|------|------|------|
| `BOTMUX_WORKTREE_SLUG_AI_ENABLED` | Off | Set `true` to enable |
| `BOTMUX_WORKTREE_SLUG_AI_BASE_URL` | Unset | API base URL, required, e.g. `https://api.example.com/v1`. botmux appends `/chat/completions` |
| `BOTMUX_WORKTREE_SLUG_AI_API_KEY` | Unset | API key, required |
| `BOTMUX_WORKTREE_SLUG_AI_MODEL` | Unset | Model name, required |
| `BOTMUX_WORKTREE_SLUG_AI_TIMEOUT_MS` | `5000` | Request timeout (ms) |
| `BOTMUX_WORKTREE_SLUG_AI_EXTRA_HEADERS` | Unset | Extra request headers as a JSON string, e.g. `{"X-Team":"dev"}`. Ignored if not valid JSON |
| `BOTMUX_WORKTREE_SLUG_AI_EXTRA_BODY` | Unset | Extra request body fields as a JSON string. Ignored if not valid JSON |

### Host overload alert

Turn the overload alert on and pick the notification bot on the Dashboard "Global Settings" page (see [Global Settings](/en/global-settings)). The variables below fine-tune the thresholds; the enter thresholds take priority over the values on the page.

| Variable | Default | Purpose |
|------|------|------|
| `BOTMUX_OVERLOAD_ALERT` | Unset | Set `0` to turn the overload alert off completely, whatever the page says |
| `BOTMUX_OVERLOAD_ENTER_LOAD_RATIO` | `1.5` | Overloaded when the 15-minute load average exceeds CPU count × this value |
| `BOTMUX_OVERLOAD_EXIT_LOAD_RATIO` | `1.0` | Recovered only once load drops to CPU count × this value or below |
| `BOTMUX_OVERLOAD_ENTER_MEM_FRAC` | `0.92` | Overloaded when the used-memory fraction (0–1) reaches this value |
| `BOTMUX_OVERLOAD_EXIT_MEM_FRAC` | `0.85` | Recovered only once the used-memory fraction drops to this value or below |
| `BOTMUX_OVERLOAD_MIN_REALERT_MS` | `900000` (15 minutes) | Minimum gap between two "entered overload" alerts |

Exit thresholds must be lower than enter thresholds. If one isn't, botmux sets it to 95% of the enter threshold and logs a warning.

## Paths, logs, and GitHub

| Variable | Default | Purpose |
|------|------|------|
| `BOTS_CONFIG` | Unset, uses `~/.botmux/bots.json` | Use a different bots.json file |
| `SESSION_DATA_DIR` | `~/.botmux/data` | Where sessions, queues, and other data are stored. On startup botmux records the actual location in `~/.botmux/.data-dir` so command-line tools follow it |
| `BOTMUX_WORKFLOW_RUNS_DIR` | `~/.botmux/workflow-runs` | Workflow run records |
| `DEBUG` | Unset | Set `1` to enable debug logs |
| `GITHUB_TOKEN` | Unset | Token botmux uses for its own GitHub requests (Dashboard changelog, update checks, restart report) to avoid rate limits |
| `GH_TOKEN` | Unset | Same, used only when `GITHUB_TOKEN` is unset |

`GITHUB_TOKEN` / `GH_TOKEN` are used only for botmux's own GitHub requests and **are not passed to session CLIs by default**. If a bot's sessions need one, add it to that bot's session environment.

## Advanced / special environments

| Variable | Default | Purpose |
|------|------|------|
| `BOTMUX_COMPANION_SECRET_FILE` | Unset | Secret-file path for the [Local Companion API](/en/companion-api), usually set by `botmux start/restart --companion-secret-file`. Must be an absolute path to a non-empty regular file owned by the current user, mode `0600`, not a symlink. Never passed to session CLIs and never falls back to `.dashboard-secret` |
| `BOTMUX_COMPANION_BOT_APP_ID` | Unset | The single test bot bound to the Companion API, usually set by `--companion-bot`. Callers can't pick another bot |
| `BOTMUX_LOOPBACK_PEERS` | Empty | Only for unusual kernels that report same-machine connections as a LAN IP, causing Dashboard or internal calls to be rejected. Extra allowed source addresses, comma-separated IPs / CIDRs, e.g. `10.0.0.5,192.168.0.0/16` |

Notes on `BOTMUX_LOOPBACK_PEERS`:

- Empty by default: only `127.0.0.1` and `::1` are accepted, same as older versions.
- It relaxes only the "request must come from this machine" check. Signature, timestamp, and replay checks still apply, so a badly signed request is still rejected.
- Entries that are too broad (`/0`–`/7`) or malformed are ignored with a startup warning.
- Prefer a single address (`/32`) or the smallest real subnet. Write IPv4 addresses in IPv4 form: `10.0.0.0/8` covers both plain IPv4 and the dual-stack `::ffff:10.x` form.

## File locations

| Path | What it is |
|------|------|
| `~/.botmux/bots.json` | Bot configuration |
| `~/.botmux/.env` | The environment variables on this page |
| `~/.botmux/config.json` | Global settings saved from the Dashboard "Settings" page; see [Global Settings](/en/global-settings) |
| `~/.botmux/data/` | Session data, message queues, etc. (change with `SESSION_DATA_DIR`) |
| `~/.botmux/logs/` | Background process logs; also viewable with `botmux logs` |
| `~/.botmux/bin/botmux` | Entry script for the global `botmux` command (written automatically) |
| `~/.botmux/lark-scopes.json` | Full list of recommended Feishu scopes (written during setup; copy it into the open platform's bulk import) |
| `~/.botmux/.dashboard-port` | The port the Dashboard actually listens on |
| `~/.botmux/.dashboard-secret` | Dashboard signing secret (mode 0600, keep it private) |
| `~/.botmux/audit/` | Dashboard terminal-takeover audit log |

For backups, keep at least `bots.json`, `.env`, `config.json`, and `data/`.
