# Persistent Backends

Botmux can run the CLI process inside a persistent backend. When the daemon or worker restarts, the underlying CLI stays in its original session; the next incoming message re-attaches the worker to that same process.

## Backend Selection

When `backendType` is empty, botmux auto-selects tmux if it is available, otherwise falls back to `pty`. Herdr and Zellij are never selected automatically; set them explicitly in the bot config:

```json
{
  "backendType": "herdr"
}
```

`tmux`, `herdr`, and `zellij` are persistent backends. `pty` attaches directly to the process and does not persist across daemon restarts.

## Lifecycle

| Event | Persistent session | CLI process |
|------|-------------|---------|
| `botmux restart` | Survives | Survives (re-attached on next message) |
| `/close`, close button, `botmux delete` | Destroyed | Terminated |
| CLI exits / crashes on its own | Closes along with it | Already exited (automatically restarted with a new session) |

## Attach

```bash
# Interactive session list; attach to the bot's configured backend after selecting
botmux list

# Manual tmux attach
tmux attach -t bmx-<first8>

# Manual Herdr attach
herdr session attach bmx-<first8>
```

`botmux list` resolves the target backend from the bot's `backendType`; `botmux delete` closes the matching backend session as well.

To run `botmux list` inside a Herdr client and jump into another Herdr session, enable `[experimental] allow_nested = true` in the Herdr config. After entering the target session, use Herdr detach to leave the view; closing the pane/workspace closes the real agent.
