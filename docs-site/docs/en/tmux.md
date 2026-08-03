# Tmux Session Persistence

**tmux is botmux's default backend** (PTY is retired and no longer an automatic fallback). Once tmux is installed, the CLI process stays persistent inside a tmux session, so **restarting the daemon does not interrupt the CLI** — which is the answer to the common worry "will a restart lose my context?": it won't.

![tmux session management](https://magic-builder.tos-cn-beijing.volces.com/uploads/1780033301974_tmux.gif)

## Why it matters

On `botmux restart`, the worker process exits, but the tmux session (and the CLI process inside it) keeps running. The next time a message arrives, the worker automatically re-attaches, **with no need to reload context via `--resume`** — the context stays alive the whole time, saving tokens, saving time, and losing no state.

> Recovery is "re-attach to a still-running process," not "cold-start a new one with `--resume`": after a daemon restart botmux eagerly re-forks surviving persistent sessions with an **empty prompt** (attach only, no new turn), and also lazily reconnects on the next message or when you open the terminal.

| Event | tmux session | CLI process |
|------|-------------|---------|
| `botmux restart` | Survives | Survives (re-attached on next message, no context reload) |
| `/close` or close button | Destroyed | Terminated along with the session |
| CLI exits / crashes on its own | Closes along with it | Already exited (auto-restarted with a new session within the same worker; > 3 crashes/min stops auto-restart to avoid a crash loop) |

> `/close` / the close button runs `tmux kill-session` — tmux then delivers SIGHUP to the pane's processes, so the session and CLI disappear together.

## What happens when tmux is unavailable

It does not silently downgrade to pty; it **hard-gates**: when starting a new session, if tmux isn't functional on this machine, botmux refuses to start and posts a card telling you to install tmux (`brew install tmux` / `apt-get install -y tmux`), with the `BACKEND_TYPE=pty` escape hatch noted. An already-live persistent session is unaffected by a one-off probe failure and can still reconnect. See [Prerequisites](/en/prerequisites).

## Attach directly

```bash
# Interactive session list; attach directly after selecting
botmux list

# Manual attach (session name = bmx-<first 8 chars of sessionId>)
tmux attach -t bmx-<first8>
# Ctrl+B, D to detach, without affecting the running CLI
```

Once you attach, what you see is a terminal exactly identical to your local development — and this is the key difference between botmux and "read-only output" approaches. The Lark topic, the Web terminal, and your local tmux all show the same process; see [Web Terminal](/en/web-terminal).

## Other backends and explicit pty

Only tmux (default) and pty (emergency) are relevant day to day; `zellij` / `herdr` are also available backends, opted into explicitly via `BACKEND_TYPE` or a per-bot `backendType`, and don't change the default. `riff` is different — it is **enabled paired with the riff CLI** (`cliId===riff ⇔ backendType===riff`, a forced binding) and can't be selected for an ordinary CLI the way zellij/herdr can.

```bash
# Force pure pty mode (without using tmux) — emergency only
BACKEND_TYPE=pty botmux start
```

> ⚠️ A pty session **does not survive a daemon restart**: pty has no persistent process to re-attach to, so the session must reload after a restart. For "restart without losing context," use the default tmux. You can also set `"backendType": "pty"` per bot (see [bots.json configuration](/en/bots-json)).
