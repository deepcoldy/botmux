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
| `botmux send [content]` | Send a message to the current topic (stdin / heredoc / `--content-file`; `--images`/`--files`/`--videos`/`--mention`) |
| `botmux bots list` | List the bots in the current group (including open_id) |
| `botmux history [--limit N]` | Pull the session history (JSON) |
| `botmux quoted <message_id>` | Pull a single quoted message (JSON) |
| `botmux schedule add/list/remove/pause/resume/run` | Manage scheduled tasks |
