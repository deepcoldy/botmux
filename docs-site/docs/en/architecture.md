# Architecture overview

botmux is a thin orchestration layer that translates "Lark events" into "input/output for CLI processes". Core processes and modules:

## Process model

```
Lark long-connection events
        │
        ▼
   ┌──────────┐   One dedicated daemon process per bot
   │  daemon  │   Listens to messages, routes, manages session lifecycle
   └────┬─────┘
        │ spawns one per topic
        ▼
   ┌──────────┐   Launches the CLI via an adapter, on a PTY / tmux backend
   │  worker  │   Reads terminal output → renders cards; receives Lark messages → writes to CLI
   └────┬─────┘
        │
        ▼
   ┌──────────┐
   │ CLI proc │   Claude Code / Codex / ... (full runtime)
   └──────────┘
```

> The production form is **one daemon process per bot**. Multi-bot = multiple daemons, fully isolated processes that don't interfere with each other.

## Module structure

| Module | Responsibility |
|------|------|
| `daemon.ts` | Thin orchestration layer; assembles the modules and starts |
| `worker.ts` | Worker subprocess; manages the CLI + PTY via an adapter |
| `server.ts` | Web Terminal HTTP service (xterm.js) |
| `bot-registry.ts` | Multi-bot config loading + state management |
| `adapters/cli/` | CLI adapters (argument building, input writing, Skill directory), one file per CLI |
| `adapters/backend/` | Session backends: `PtyBackend`, `TmuxPipeBackend` |
| `im/lark/` | Lark: event routing, card building/handling, API client, message parsing |
| `core/` | `worker-pool`, `command-handler`, `session-manager`, `cost-calculator`, `scheduler` |
| `skills/` | Out-of-the-box Skills (`botmux-send` / `botmux-schedule` / `botmux-bots` / `botmux-history` / `botmux-quoted`) |
| `utils/` | `idle-detector` (CLI idle detection), `terminal-renderer` (xterm.js screenshot), `logger` |

## Data flow

1. Lark pushes `im.message.receive_v1` → event-dispatcher parses it and determines ownership (@mention / topic / group permissions).
2. command-handler intercepts `/xxx` slash commands; non-command messages are handed to the session.
3. New topic → worker-pool spawns a worker; existing session → reuse it and write the message to the CLI's stdin.
4. The worker continuously reads PTY output, converts it to Markdown via terminal-renderer, and updates the streaming card.
5. The CLI proactively sends messages to the topic via injected Skills / commands like `botmux send`.

Key point: **the worker and the CLI are decoupled through the backend (PTY or tmux)**. With the tmux backend, when the daemon/worker restarts the CLI process stays alive inside tmux, and the next message automatically re-attaches — no need to reload context with `--resume`. See [Persistent tmux sessions](/en/tmux) for details.
