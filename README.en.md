# botmux

[中文](README.md) | English

Bridge between Lark (Feishu) topic groups and AI coding CLIs. The daemon listens for Lark messages and automatically spawns an independent CLI process (supporting Claude Code, Aiden, CoCo, Codex) for each new topic thread, with live streaming cards and a web-based terminal.

## Demo

<video src="https://github.com/user-attachments/assets/840d3bb6-3b98-465a-8662-b4beadeb48ce" width="100%" controls></video>

## Features

- **One topic = one AI coding session** — each Lark thread gets its own isolated CLI process
- **Multi-CLI support** — adapter architecture supports Claude Code, Aiden, CoCo, Codex, and is extensible
- **Live streaming cards** — real-time terminal output rendered in Feishu cards with markdown support, per-turn card lifecycle
- **Web terminal (xterm.js)** — full PTY output in the browser with optional write access via on-demand DM link
- **Session persistence** — sessions survive daemon restarts; with tmux backend, CLI processes persist across restarts with zero interruption
- **Scheduled tasks** — cron-based recurring prompts with natural language scheduling (Chinese supported)
- **Project management** — interactive repo selector, per-session working directory
- **MCP integration** — CLI can reply to Lark threads, read message history, and add reactions via MCP tools
- **Access control** — allowlist for users, token-based write access for terminals, button restrictions on cards

## Architecture

```
Lark WebSocket Events
    |
Daemon (daemon.ts → core/ modules)
    |-- im/lark/event-dispatcher: Lark event routing
    |-- im/lark/card-handler: card interaction handling
    |-- core/worker-pool: worker process pool management
    |-- core/command-handler: slash command processing
    |-- core/session-manager: session lifecycle
    |-- core/scheduler: cron task scheduling
    |
Worker (worker.ts) -- forked child process per session
    |-- adapters/cli/*: CLI adapters (Claude Code / Aiden / CoCo / Codex)
    |-- adapters/backend: PtyBackend (node-pty) or TmuxBackend (tmux + node-pty)
    |-- utils/idle-detector: idle detection (quiescence + spinner + completion marker)
    |-- HTTP + WebSocket server: serves xterm.js web terminal
    |-- Headless xterm: captures screen for streaming cards
    |-- IPC: communicates with daemon
    |
AI Coding CLI (interactive TTY mode)
    |-- MCP Server (stdio): send_to_thread, get_thread_messages, react_to_message
    |
Lark API
    |-- Replies, reactions, card updates, DMs
```

## Prerequisites

- **Node.js** >= 20
- **AI coding CLI** installed and authenticated (`claude`, `aiden`, `coco`, or `codex` in PATH)
- **Lark app** with Bot and Message permissions (WebSocket event subscription)
- **tmux** >= 3.x (optional — auto-enabled when installed for persistent CLI sessions)

## Installation

```bash
npm install -g botmux
```

## Quick Start

```bash
# 1. Interactive setup — creates ~/.botmux/.env
botmux setup

# 2. Start the daemon
botmux start
```

The `setup` command will guide you through:
- Creating a Lark app (with required permissions listed)
- Entering App ID, App Secret, Chat ID
- Optional: Claude model, working directory, access control

## CLI Commands

| Command | Description |
|---------|-------------|
| `botmux setup` | Interactive first-time configuration |
| `botmux start` | Start daemon (PM2 managed) |
| `botmux stop` | Stop daemon |
| `botmux restart` | Restart daemon (auto-restores active sessions) |
| `botmux logs` | View daemon logs (`--lines N` for more) |
| `botmux status` | Show daemon status |
| `botmux upgrade` | Upgrade to latest version |
| `botmux list` | List all active sessions (alias: `ls`) |
| `botmux delete <id>` | Close a session by ID prefix (alias: `del`/`rm`) |
| `botmux delete all` | Close all active sessions |
| `botmux delete stopped` | Clean up zombie sessions with dead processes |

## Configuration

Configuration is stored at `~/.botmux/.env`. Run `botmux setup` to create it interactively, or edit manually:

### Required

| Variable | Description |
|----------|-------------|
| `LARK_APP_ID` | Lark app ID |
| `LARK_APP_SECRET` | Lark app secret |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `CLI_ID` | `claude-code` | CLI adapter (`claude-code`, `aiden`, `coco`, `codex`) |
| `CLI_PATH` | _(auto-detect by CLI_ID)_ | CLI binary path override |
| `BACKEND_TYPE` | _(auto-detect)_ | Session backend: `tmux` if available, otherwise `pty` |
| `WORKING_DIR` | `~` | Default working directory; supports comma-separated multiple dirs (e.g. `~/a,~/b`), `/repo` scans all |
| `ALLOWED_USERS` | _(empty = allow all)_ | Comma-separated email prefixes or Lark open_ids |
| `PROJECT_SCAN_DIR` | _(parent of CWD)_ | Directory to scan for git repos |
| `WEB_HOST` | `0.0.0.0` | HTTP server bind address |
| `WEB_EXTERNAL_HOST` | _(auto-detect LAN IP)_ | External hostname/IP for terminal URLs |
| `SESSION_DATA_DIR` | `~/.botmux/data` | Where sessions and queues are stored |
| `DEBUG` | _(unset)_ | Set to `1` for debug logging |

## File Locations

| Path | Description |
|------|-------------|
| `~/.botmux/.env` | Configuration |
| `~/.botmux/data/` | Session data, message queues |
| `~/.botmux/logs/` | Daemon logs |

## Usage

### Workflow

1. Send a message in your Lark topic group to create a new thread
2. The bot shows a repo selection card — pick a project or click "Start directly"
3. Claude Code spawns in the selected directory
4. A live streaming card appears in the thread, showing real-time terminal output with markdown rendering
5. Each reply creates a new streaming card for that turn; previous cards freeze at their last state
6. Click "🔑 Get Write Link" on the card to receive a write-enabled terminal URL via DM
7. Claude replies in the thread via MCP tools

### Slash Commands

| Command | Description |
|---------|-------------|
| `/repo` | Show project selector card |
| `/repo <N>` | Switch to Nth project from last scan |
| `/cd <path>` | Change working directory |
| `/status` | Show session info (uptime, terminal URL, etc.) |
| `/cost` | Show token usage and estimated cost |
| `/restart` | Restart Claude process |
| `/close` | Close session and terminate Claude |
| `/clear` | Clear context (new session, same thread) |
| `/schedule` | Manage scheduled tasks |
| `/help` | Show available commands |

### Scheduled Tasks

Create recurring tasks with natural language:

```
/schedule every day at 17:50 check AI news
/schedule weekdays at 9:00 run health check
/schedule every Monday at 10:00 generate weekly report
```

Manage tasks:

```
/schedule list
/schedule remove <id>
/schedule enable <id>
/schedule disable <id>
/schedule run <id>
```

### Streaming Cards

Each conversation turn gets a live-updating Feishu card that shows:

- Real-time terminal output (rendered via headless xterm + Feishu Card v2 markdown)
- Status indicator: 🟡 Starting → 🔵 Working → 🟢 Idle
- Action buttons: Open Terminal, Get Write Link, Restart Claude, Close Session

The card content is captured from a headless xterm terminal that filters out TUI chrome (logo, status bar, prompts, box-drawing characters) and shows only Claude's actual work output.

### Web Terminal

Each session exposes a web terminal at `http://<WEB_EXTERNAL_HOST>:<port>`.

- **Read-only link** — shown on the streaming card in the group thread
- **Write-enabled link** — sent via DM on demand (click "🔑 Get Write Link" on the card)

Features: xterm.js with fit/unicode11/web-links addons, TokyoNight theme, scrollback buffer, mobile-friendly viewport.

### Tmux Persistent Sessions

When tmux is installed, botmux automatically uses the tmux backend (pty-under-tmux architecture). CLI processes run inside tmux sessions while the daemon attaches via node-pty to capture output — streaming cards, idle detection, and web terminal all work unchanged.

**Key benefit: daemon restarts don't interrupt the CLI.** During `botmux restart`, the worker process exits but the tmux session (and the CLI inside it) keeps running. The next incoming message triggers a re-attach — no `--resume` context reload needed.

```bash
# List active botmux tmux sessions
tmux list-sessions | grep bmx-

# Manually attach for debugging (observe CLI in real time)
tmux attach -t bmx-<first-8-chars-of-session-id>
# Ctrl+B, D to detach — CLI keeps running

# Force pure pty mode (disable tmux)
BACKEND_TYPE=pty botmux start
```

**Session naming:** `bmx-<first 8 chars of session UUID>`, deterministically derived.

**Lifecycle:**

| Event | tmux session | CLI process |
|-------|-------------|-------------|
| `botmux restart` | Survives | Survives (re-attaches on next message) |
| `/close` or close button | Destroyed | Terminated (SIGHUP) |
| CLI exits / crashes | Closes with it | Already exited (auto-restart creates new session) |
| `CLI_ID` changed + restart | All destroyed | All terminated (prevents pattern mismatch) |

**Notes:**
- Switching `CLI_ID` (e.g. `claude-code` → `coco`) and restarting the daemon will kill all existing tmux sessions, since the old CLI's idle detection patterns are incompatible with the new adapter
- Orphaned tmux sessions (not in the active session list) are cleaned up automatically on daemon startup
- Set `BACKEND_TYPE=pty` to opt out of tmux persistence

## MCP Tools

Claude Code has access to three MCP tools for interacting with Lark:

| Tool | Description |
|------|-------------|
| `send_to_thread` | Send a message (text or rich post) to the Lark thread |
| `get_thread_messages` | Retrieve message history from the thread |
| `react_to_message` | Add or remove emoji reactions on messages |

## Development

```bash
git clone <repo-url>
cd botmux
pnpm install
pnpm build

# Run directly (no PM2)
pnpm daemon

# Or with PM2
pnpm daemon:start
pnpm daemon:logs
```

## Project Structure

```
src/
  cli.ts                    # CLI entry point (setup/start/stop/restart/logs/list/delete)
  daemon.ts                 # Daemon orchestrator (~400 lines, wires modules together)
  worker.ts                 # Worker process: uses adapters to manage CLI + PTY
  config.ts                 # Configuration from environment variables
  server.ts                 # MCP server setup
  types.ts                  # IPC message types
  adapters/
    cli/
      types.ts              # CliAdapter interface, CliId type
      registry.ts           # Adapter factory + resolveCommand
      claude-code.ts        # Claude Code adapter
      aiden.ts              # Aiden adapter
      coco.ts               # CoCo adapter
      codex.ts              # Codex adapter
    backend/
      types.ts              # SessionBackend interface
      pty-backend.ts        # node-pty backend
      tmux-backend.ts       # tmux backend (pty-under-tmux, persistent sessions)
  core/
    types.ts                # DaemonSession core type
    worker-pool.ts          # Worker process pool management
    command-handler.ts      # Slash command processing
    session-manager.ts      # Session lifecycle + path resolution
    cost-calculator.ts      # Token usage & cost estimation
    scheduler.ts            # Cron scheduling with natural language parsing
  im/
    types.ts                # ImAdapter interface definitions (multi-IM abstraction)
    lark/
      client.ts             # Lark API wrapper
      event-dispatcher.ts   # Lark WebSocket event routing
      card-handler.ts       # Lark card interaction handling
      card-builder.ts       # Lark interactive card builders
      message-parser.ts     # Lark event message parsing
  tools/
    index.ts                # MCP tool registry
    send-to-thread.ts       # MCP tool: send message
    get-thread-messages.ts  # MCP tool: read messages
    react-to-message.ts     # MCP tool: emoji reactions
  services/
    session-store.ts        # Session persistence (JSON)
    schedule-store.ts       # Scheduled task persistence
    message-queue.ts        # Per-thread JSONL message queue
    project-scanner.ts      # Git repo/worktree discovery
  utils/
    idle-detector.ts        # CLI idle detection (quiescence + spinner + completion marker)
    terminal-renderer.ts    # Headless xterm renderer for screen capture & TUI filtering
    logger.ts               # Logging utility
```

## License

[MIT](LICENSE)
