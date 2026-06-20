# Tmux Session Persistence

Automatically enabled once tmux is installed. The CLI process stays persistent inside a tmux session, so **restarting the daemon does not interrupt the CLI**.

![tmux session management](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780033301974_tmux.gif)

## Why it matters

On `botmux restart`, the worker process exits, but the tmux session (and the CLI process inside it) keeps running. The next time a message arrives, the worker automatically re-attaches, **with no need to reload context via `--resume`** — the context stays alive the whole time, saving tokens, saving time, and losing no state.

| Event | tmux session | CLI process |
|------|-------------|---------|
| `botmux restart` | Survives | Survives (re-attached on next message) |
| `/close` or close button | Destroyed | Terminated (SIGHUP) |
| CLI exits / crashes on its own | Closes along with it | Already exited (automatically restarted with a new session) |

## Attach directly

```bash
# Interactive session list; attach directly after selecting
botmux list

# Manual attach (session name = bmx-<first 8 chars of sessionId>)
tmux attach -t bmx-<first8>
# Ctrl+B, D to detach, without affecting the running CLI

# Force fall back to pure pty mode (without using tmux)
BACKEND_TYPE=pty botmux start
```

Once you attach, what you see is a terminal exactly identical to your local development — and this is the key difference between botmux and "read-only output" approaches.
