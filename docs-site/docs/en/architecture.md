# Architecture overview

<video src="../img/video-v9-architecture-en.mp4" controls preload="metadata" style="width:100%;border-radius:8px"></video>

What botmux does fits in one sentence: **it turns Lark messages into input for an AI coding CLI, and turns the CLI's output back into Lark cards.** This page covers which processes make up botmux, how a message flows through them, and what happens on restart. You don't need any of this for day-to-day use; come back when you're troubleshooting or contributing.

## The big picture

![botmux processes: the supervisor starts a daemon per bot, the Dashboard and plugin services; each daemon runs a worker per topic, which reaches the CLI through a session backend such as tmux](/img/arch-overview-en.png)

## What each process does

| Process | How many | What it does |
|---------|----------|--------------|
| supervisor | 1 per machine | This is what `botmux start` launches. It starts each bot's daemon, the Dashboard and plugin services, and restarts any of them that crash |
| daemon | **1 per bot** | Holds the Lark long connection, decides whether a message should be handled and which session it belongs to, handles slash commands, and creates, restores and closes sessions |
| worker | 1 per active topic | Launches the CLI through an adapter, types Lark messages into it, and turns terminal output into streaming cards; also serves the session's [web terminal](/en/web-terminal) |
| CLI process | 1 per topic | The AI coding CLI doing the actual work, running inside tmux or another backend, exactly as if you used it in your own terminal |
| dashboard | 1 per machine | The [admin dashboard](/en/dashboard), port 7891 by default |

Key points:

- **One daemon per bot, fully isolated.** A problem in one bot won't take the others down. See [Multi-bot](/en/multi-bot).
- **A "session backend" sits between the worker and the CLI.** The default is tmux: the CLI lives inside tmux, so restarting the worker or daemon doesn't interrupt it.
- Want to drive a CLI over HTTP without Lark at all? Use the single-process [Core-only mode](/en/api-core-only). It skips the supervisor and doesn't need `bots.json`.

## How a message flows

![How a message flows: Lark push, daemon filtering, command classification, find or create the session, output to cards](/img/arch-message-flow-en.png)

Take "@ the bot in a topic and say something" as an example:

1. **Lark pushes the message to the daemon.** The daemon first decides whether to handle it: was the bot @-mentioned, is this a topic it owns, does the sender have permission.
2. **Slash commands are recognized.** Messages starting with `/` are classified against the command table (e.g. `/close`, `/restart`) and either handled by the daemon or passed to the CLI. Full list in [Slash commands](/en/slash-commands).
3. **The session is found or created.** A new topic starts a new worker and CLI; an existing session is reused and the message is typed into the running CLI.
4. **Output becomes cards.** The worker keeps reading the CLI's output, converts it to Markdown, updates the streaming card in Lark in real time, and posts the final reply when the turn ends.
5. **The CLI can also send messages on its own.** botmux injects a set of built-in Skills into the CLI (such as `botmux-send`, `botmux-schedule`, `botmux-history`), which it uses to post to the topic, create scheduled tasks, read chat history and more. See [Skills and CLI commands](/en/skill-cli).

## What happens on restart

![What survives a restart per session backend: tmux and other persistent backends keep the CLI, pty restarts it](/img/arch-restart-en.png)

`botmux restart` restarts the daemon and workers. Whether the CLI restarts too depends on the session backend:

| Backend | How to enable | After a daemon restart |
|---------|---------------|------------------------|
| **tmux** (default) | Nothing to configure | The CLI keeps running; the next message reattaches automatically and context is kept |
| zmx / zellij / herdr | Set explicitly via `backendType` or `BACKEND_TYPE` | Also persistent; requires the matching tool |
| pty | Set explicitly via `BACKEND_TYPE=pty` or `backendType: "pty"` | The CLI exits with the worker and is relaunched after restart |

If tmux isn't available, botmux **does not silently fall back to pty**. It blocks new sessions and shows a card asking you to install tmux. Details in [Persistent tmux sessions](/en/tmux) and [ZMX backend](/en/zmx).

On startup the daemon automatically restores previously active sessions, so you can keep chatting in your Lark topics after a restart.

## Where files live

| Path | Contents |
|------|----------|
| `~/.botmux/bots.json` | Bot configuration, see [bots.json](/en/bots-json) |
| `~/.botmux/.env` | Global environment variables, see [Environment variables](/en/env) |
| `~/.botmux/data/` | Session data, one SQLite database per bot (`session-stores/<appId>/sessions.db`) |
| `~/.botmux/logs/` | Logs: `daemon-<index>-out.log` / `-err.log`, `dashboard-out.log` and so on; or just run `botmux logs` |

## Source map (for contributors)

If you want to change the code, start here:

| Location | Responsibility |
|----------|----------------|
| `src/cli.ts`, `src/cli/` | The `botmux` command-line entry and its subcommands |
| `src/index-supervisor.ts`, `src/core/fleet-supervisor.ts` | Supervisor: starts and watches daemons, the dashboard and plugin services |
| `src/daemon.ts` | Daemon orchestration layer that wires the modules together |
| `src/worker.ts` | Worker process: manages the CLI, renders cards, serves the web terminal |
| `src/bot-registry.ts`, `src/config.ts` | Loading `bots.json` and global config |
| `src/adapters/cli/` | CLI adapters, one file per CLI (launch args, input method, Skill directory, etc.) |
| `src/adapters/backend/` | Session backends: tmux, pty, zmx, zellij, herdr and more |
| `src/core/` | Session management, command table and routing (`command-schema.ts` / `command-router.ts`), worker pool, scheduler, etc. |
| `src/im/lark/` | Lark: event dispatch, card building and callbacks, API calls, message parsing |
| `src/skills/` | Built-in Skills injected into the CLI |
| `src/dashboard/` | Admin dashboard |
| `src/utils/` | Idle detection, terminal screenshot rendering, logging and other utilities |

For the full steps to add a new CLI, see `src/adapters/cli/CLAUDE.md` in the repository.
