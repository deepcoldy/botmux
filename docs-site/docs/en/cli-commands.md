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
| `botmux dashboard [current\|rotate]` | Get the current Dashboard login URL, creating the first token if absent; `rotate` explicitly replaces an existing token |

When the daemon is online, `botmux delete` first asks the owning daemon to run
the same lifecycle teardown as `/close`: evict the in-memory active session,
persist the closed state, and clean up the worker, backend, and subscriptions.
The local fallback is used only when the owning daemon is confirmed offline. If
an online daemon rejects the request or IPC fails, the command fails without a
local hard kill.

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
| `botmux schedule add/list/remove/pause/resume/run` | Manage scheduled tasks |
