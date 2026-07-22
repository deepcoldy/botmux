# CLI Commands

Manage the daemon and sessions from the terminal.

| Command | Description |
|------|------|
| `botmux setup` | Interactive configuration (first run / add / edit / delete a bot) |
| `botmux start` | Start the daemon (managed by PM2) |
| `botmux stop` | Stop the daemon |
| `botmux restart [--include-pm2]` | Restart the daemon (automatically restores active sessions); `--include-pm2` also restarts botmux's PM2 God daemon |
| `botmux logs [--lines N]` | View logs |
| `botmux status` | View daemon status |
| `botmux upgrade` | Upgrade to the latest version |
| `botmux list` (alias `ls`) | List all active sessions |
| `botmux delete <id>` (aliases `del`/`rm`) | Close the specified session, with ID prefix matching |
| `botmux delete all` | Close all active sessions |
| `botmux delete stopped` | Clean up zombie sessions whose processes have exited |
| `botmux dashboard` | Print a Web Dashboard URL once (refreshes the token each time) |

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
| `botmux bots list` | List the bots in the current group (including open_id) |
| `botmux history [--limit N]` | Pull the session history (JSON) |
| `botmux quoted <message_id>` | Pull a single quoted message (JSON) |
| `botmux schedule add/list/remove/pause/resume/run` | Manage scheduled tasks |
| `botmux session close-self` | Safely and atomically close the current logical session (no target ID accepted) |

### Safe self-close

`botmux session close-self` is available only inside a running Botmux session. It proves the caller with an action-scoped capability for the current turn, and the daemon resolves the one matching session from that capability. The request carries and accepts no `sessionId`, bot ID, or other target selector.

The daemon first commits a synchronous logical-close barrier (persist `closed`, revoke authority, and remove the route), then returns success and asynchronously cleans up the worker, backend bridge, and subscriptions. The next message in the same chat or thread therefore creates a fresh Botmux session and provider session instead of resuming the closed provider session. Adopted sessions only detach the Botmux bridge; the user's tmux pane is not killed.

Call it only after the result checkpoint, receipt, or handoff has been persisted. A successful call must be the caller's final action. An exact retry of an already committed request returns `alreadyClosed` without repeating close side effects.
