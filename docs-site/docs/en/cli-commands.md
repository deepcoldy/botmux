# CLI Commands

Manage the daemon and sessions from the terminal.

| Command | Description |
|------|------|
| `botmux setup` | Interactive configuration (first run / add / edit / delete a bot) |
| `botmux start [--companion-secret-file <path> --companion-bot <appId>]` | Start the daemon. Supplying both companion options enables the closed local API for exactly one isolated test Bot; see [Local Companion API](/en/companion-api) |
| `botmux stop` | Stop the daemon |
| `botmux restart [--companion-secret-file <path> --companion-bot <appId>]` | Restart the daemon and restore active sessions; accepts the same closed Companion API options as `start` |
| `botmux logs [--lines N]` | View logs |
| `botmux status` | View daemon status |
| `botmux upgrade` | Upgrade to the latest version |
| `botmux list` (alias `ls`) | Interactively list active sessions; select a managed tmux / ZMX session and press Enter to attach (use `--plain` in scripts) |
| `botmux delete <id>` (aliases `del`/`rm`) | Close the specified session, with ID prefix matching |
| `botmux delete all` | Close all active sessions |
| `botmux delete stopped` | Clean up zombie sessions whose processes have exited |
| `botmux maintenance suspend-idle --dry-run\|--yes` | Preview or suspend long-idle sessions by last activity time (default: 7 days) |
| `botmux dashboard [current\|rotate]` | Get the current Dashboard login URL, creating the first token if absent; `rotate` explicitly replaces an existing token |

When the daemon is online, `botmux delete` first asks the owning daemon to run
the same lifecycle teardown as `/close`: evict the in-memory active session,
persist the closed state, and clean up the worker, backend, and subscriptions.
The local fallback is used only when the owning daemon is confirmed offline. If
an online daemon rejects the request or IPC fails, the command fails without a
local hard kill.

When `BOTMUX_COORDINATION_MODE=primary`, the durable PostgreSQL Session is the canonical truth. In this mode, `delete`, `resume`, non-dry-run `suspend`, `maintenance suspend-idle`, and delete/wake actions in the interactive `list` are rejected explicitly. `list` remains available as a read-only local view, but skips local auto-pruning. Use the session card in the original topic to close or resume through the fenced durable session-control lane.

### Web terminal and "Show/Hide output" with multiple replicas

In primary mode the worker runs only on the replica that owns the Session, while Lark callbacks and browser requests can land on any replica:

- **"Show/Hide output" button**: the click enters the same durable session-control lane and is applied by the owner replica, which updates the original card. It takes effect only for people allowed to operate the Session; clicking an old card or lacking permission shows a hint to use the latest card.
- **Cross-replica Web terminal forwarding**: each Dashboard publishes the Sessions with a live worker on its replica to shared storage (45 s expiry, refreshed periodically). A request that lands on a non-owner replica is forwarded to the owner's Dashboard using that record, for one hop only; the address must be a literal IP, and Cookie, Authorization and every `x-botmux-*` header never cross replicas.
  - `BOTMUX_TERMINAL_ROUTE_HOST`: the IP other replicas can reach this one at (e.g. the Pod IP). Nothing is published when unset.
  - `BOTMUX_TERMINAL_ROUTE_PORT`: the port other replicas use for this Dashboard (e.g. a NodePort). Defaults to `BOTMUX_DASHBOARD_PORT`; the startup log warns when it differs from the actual listening port.
- **Capability boundary**: only **Lark card links** that carry their own credential (`?viewToken=` / `?token=`, verified by the owner's worker) work across replicas. The terminal embedded in the Dashboard workbench (login cookie), the touch-screen dynamic view link, and takeover with write access all rely on credentials issued by the receiving replica and are refused by the owner (403) across replicas — those must reach the owner replica (session-sticky load balancing, or open the owner directly).
- Single-replica deployments (primary off) publish no routes and forward nothing; all of the above behaves exactly as before.

## Idle Session Maintenance

```bash
botmux maintenance suspend-idle --older-than 7d --dry-run
botmux maintenance suspend-idle --older-than 7d --yes
```

`--dry-run` reads authoritative runtime state from each online daemon and never changes a session or process. Its output includes the session, Bot, title, last activity, worker PID, persistent backend target, and expected process types to reclaim. Execution requires an explicit `--yes` and goes through the daemon's existing `suspendWorker` path. The daemon first destroys the exact persistent backend and post-probes it as missing; only then does it persist the logical session as active + dormant. The next message cold-resumes from the transcript. An `exists` or `unknown` teardown result fails closed instead of claiming a successful suspension.

Candidate selection fails closed. A worker must be ready, explicitly idle, backed by a resumable backend, and have a known activity timestamp. Adopted, locked, repository-pending, queued-input, unsettled-dispatch, user-attention, and transferring sessions are skipped. Use `--bot <appId>` to scope one Bot and `--json` for machine-readable output. The Dashboard's per-Bot idle auto-suspend setting remains the periodic policy; this command is the operator preview and batch-execution surface.

## Auto-Start on Boot

```bash
botmux autostart enable   # Register (macOS launchd / Linux user systemd, no sudo needed)
botmux autostart disable  # Unregister
botmux autostart status   # Check status
```

- **macOS**: writes `~/Library/LaunchAgents/com.botmux.daemon.plist` and loads it with `launchctl bootstrap`.
- **Linux**: writes `~/.config/systemd/user/botmux.service` and runs `systemctl --user enable --now`.
  - On servers / headless environments, logging out stops the service; to keep it running across logout, run `sudo loginctl enable-linger <username>`.
- The `node`/`cli.js` paths in the unit file come from the current `process.execPath`; after switching versions with nvm/fnm, just run `enable` once to rewrite them (`start`/`restart` also auto-detect path changes and refresh in place).
- `enable`/`disable` **only manage the auto-start hook and don't touch a running daemon** — avoiding the "I just wanted to turn off auto-start but it killed the service too" problem.

## In-Session Subcommands (for the CLI agent)

Session info is inferred automatically from ancestor-process markers, so the agent can call these directly:

| Command | Description |
|------|------|
| `botmux send [content]` | Send a message to the current topic (stdin / heredoc / `--content-file`; `--images`/`--files`/`--videos`/`--card-file`/`--card-json`/`--mention`) |
| `botmux card patch --message-id <om_xxx> (--card-file <path> \| --card-json <json>)` | Update a previously sent custom card in place (no new message; the messageId comes from the send output) |
| `botmux bots list` | List the bots in the current group (including open_id); `--scope team [--team <id>]` discovers same-team, opted-in agents across machines (by specialty) |
| `botmux bots invite --chat <chatId> --team <id> --agent <appId>...` | Add same-team agents + their owners into a group you're already in (auto-adds the platform app first if absent) |
| `botmux history [--limit N]` | Pull the session history (JSON) |
| `botmux quoted <message_id>` | Pull a single quoted message (JSON) |
| `botmux schedule add/list/update/remove/pause/resume/run` | Manage scheduled tasks |
| `botmux session rename "<title>"` | Rename the **current session's** botmux canonical title (the session is auto-detected; no `--session-id` or any way to target another session). Dashboard and the `/sessions` list update instantly, and the CLI-native session name is synced best-effort. The Lark group name and omt topic name are unchanged (no platform API for topic titles). Recommended shape "type \| subject", up to 200 characters |
| `botmux chat rename <new group name> [--proactive]` | Rename the **Lark group that hosts the current session** (in a topic group this is the whole `oc_` group, visible across every topic and to every member). `--proactive` is for agent-initiated renames on a phase change, with a 10-minute debounce |
