# claude-code-robot

[中文](README.md) | English

Bridge between Lark (Feishu) topic groups and Claude Code / Aiden CLI. The daemon listens for Lark messages and automatically spawns an independent Claude Code or Aiden process for each new topic thread, with live streaming cards and a web-based terminal.

## Features

- **One topic = one Claude Code session** — each Lark thread gets its own isolated Claude Code process
- **Live streaming cards** — real-time terminal output rendered in Feishu cards with markdown support, per-turn card lifecycle
- **Web terminal (xterm.js)** — full PTY output in the browser with optional write access via on-demand DM link
- **Session persistence** — sessions survive daemon restarts and resume automatically
- **Scheduled tasks** — cron-based recurring prompts with natural language scheduling (Chinese supported)
- **Project management** — interactive repo selector, per-session working directory
- **MCP integration** — Claude Code can reply to Lark threads, read message history, and add reactions via MCP tools
- **Access control** — allowlist for users, token-based write access for terminals, button restrictions on cards

## Architecture

```
Lark WebSocket Events
    |
Daemon (daemon.ts)
    |-- Event: im.message.receive_v1 (new topics & thread replies)
    |-- Event: card.action.trigger (repo select, restart, close)
    |-- Scheduler (cron tasks)
    |
Worker (worker.ts) -- forked child process per session
    |-- node-pty: spawns Claude Code / Aiden CLI in a pseudo-terminal
    |-- HTTP + WebSocket server: serves xterm.js web terminal
    |-- Headless xterm: captures screen for streaming cards
    |-- IPC: communicates with daemon
    |
Claude Code / Aiden CLI (interactive TTY mode)
    |-- MCP Server (stdio): send_to_thread, get_thread_messages, react_to_message
    |
Lark API
    |-- Replies, reactions, card updates, DMs
```

## Prerequisites

- **Node.js** >= 20
- **Claude Code CLI or Aiden CLI** installed and authenticated (`claude` or `aiden` in PATH)
- **Lark app** with Bot and Message permissions (WebSocket event subscription)

## Installation

```bash
npm install -g @byted/claude-code-robot
```

## Quick Start

```bash
# 1. Interactive setup — creates ~/.claude-code-robot/.env
claude-code-robot setup

# 2. Start the daemon
claude-code-robot start
```

The `setup` command will guide you through:
- Creating a Lark app (with required permissions listed)
- Entering App ID, App Secret, Chat ID
- Optional: Claude model, working directory, access control

## CLI Commands

| Command | Description |
|---------|-------------|
| `claude-code-robot setup` | Interactive first-time configuration |
| `claude-code-robot start` | Start daemon (PM2 managed) |
| `claude-code-robot stop` | Stop daemon |
| `claude-code-robot restart` | Restart daemon (auto-restores active sessions) |
| `claude-code-robot logs` | View daemon logs (`--lines N` for more) |
| `claude-code-robot status` | Show daemon status |
| `claude-code-robot upgrade` | Upgrade to latest version |

## Configuration

Configuration is stored at `~/.claude-code-robot/.env`. Run `claude-code-robot setup` to create it interactively, or edit manually:

### Required

| Variable | Description |
|----------|-------------|
| `LARK_APP_ID` | Lark app ID |
| `LARK_APP_SECRET` | Lark app secret |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `LARK_BRIDGE_MODEL` | `opus` | Claude model (`opus`, `sonnet`, `haiku`) |
| `LARK_BRIDGE_MAX_TURNS` | `500` | Max conversation turns per session |
| `CLAUDE_PATH` | `claude` | Path to CLI binary (`claude` or `aiden`) |
| `CLAUDE_WORKING_DIR` | `~` | Default working directory |
| `ALLOWED_USERS` | _(empty = allow all)_ | Comma-separated Lark open_ids |
| `PROJECT_SCAN_DIR` | _(parent of CWD)_ | Directory to scan for git repos |
| `WEB_HOST` | `0.0.0.0` | HTTP server bind address |
| `WEB_EXTERNAL_HOST` | _(auto-detect LAN IP)_ | External hostname/IP for terminal URLs |
| `SESSION_DATA_DIR` | `~/.claude-code-robot/data` | Where sessions and queues are stored |
| `DEBUG` | _(unset)_ | Set to `1` for debug logging |

## File Locations

| Path | Description |
|------|-------------|
| `~/.claude-code-robot/.env` | Configuration |
| `~/.claude-code-robot/data/` | Session data, message queues |
| `~/.claude-code-robot/logs/` | Daemon logs |

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
cd claude-code-robot
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
  cli.ts                 # CLI entry point (setup/start/stop/restart/logs)
  daemon.ts              # Main daemon: event handling, session lifecycle, commands
  worker.ts              # Worker process: PTY, HTTP/WS server, prompt detection
  scheduler.ts           # Cron scheduling with natural language parsing
  config.ts              # Configuration from environment variables
  server.ts              # MCP server setup
  types.ts               # IPC message types
  services/
    lark-client.ts       # Lark API wrapper
    session-store.ts     # Session persistence (JSON)
    schedule-store.ts    # Scheduled task persistence
    message-queue.ts     # Per-thread JSONL message queue
    project-scanner.ts   # Git repo/worktree discovery
  tools/
    send-to-thread.ts    # MCP tool: send message
    get-thread-messages.ts # MCP tool: read messages
    react-to-message.ts  # MCP tool: emoji reactions
  utils/
    card-builder.ts      # Lark interactive card builders (session, streaming, repo-select)
    terminal-renderer.ts # Headless xterm renderer for screen capture & TUI filtering
    message-parser.ts    # Lark event message parsing
    logger.ts            # Logging utility
```

## License

[MIT](LICENSE)
