# botmux

<p align="center">
  <img src="cover.svg" alt="botmux cover" width="800">
</p>

[中文](README.md) | English

Bridge between Lark (Feishu) topic groups and AI coding CLIs. The daemon listens for Lark messages and automatically spawns an independent CLI process (supporting Claude Code, Aiden, CoCo, Codex, Gemini) for each new topic thread, with live streaming cards and a web-based terminal.

## Demo

[Demo Video](https://github.com/user-attachments/assets/3ba4c681-0a7e-4a03-89c8-b8d26b544a65)

## Features

- **One topic = one AI coding session** — each Lark thread gets its own isolated CLI process
- **Multi-CLI support** — adapter architecture supports Claude Code, Aiden, CoCo, Codex, Gemini, and is extensible
- **Live streaming cards** — real-time terminal output rendered in Feishu cards with markdown support, per-turn card lifecycle
- **Web terminal (xterm.js)** — full PTY output in the browser with a mobile shortcut toolbar and on-demand write access via DM link
- **Session persistence** — sessions survive daemon restarts; with tmux backend, CLI processes persist across restarts with zero interruption
- **Scheduled tasks** — cron-based recurring prompts with natural language scheduling (Chinese supported)
- **Project management** — interactive repo selector, per-session working directory
- **MCP integration** — CLI can reply to Lark threads, read message history, and add reactions via MCP tools
- **Access control** — allowlist for users, token-based write access for terminals, button restrictions on cards

## Prerequisites

- **Node.js** >= 20
- **AI coding CLI** installed and authenticated (`claude`, `aiden`, `coco`, `codex`, `gemini`, or `opencode` in PATH)
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
| `botmux setup` | Interactive setup (first-time or add bots) |
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

Configure bots via `~/.botmux/bots.json`. Run `botmux setup` to create it interactively, or edit manually.

Supports running multiple Lark bots on a single machine, each mapped to a different CLI. Multiple bots in the same group chat route messages via @mention; a single bot responds automatically without @.

```bash
# Interactive setup
botmux setup
```

**bots.json format:**

```json
[
  {
    "larkAppId": "cli_xxx_bot1",
    "larkAppSecret": "secret_1",
    "cliId": "claude-code",
    "workingDir": "~/projects",
    "allowedUsers": ["alice@company.com"]
  },
  {
    "larkAppId": "cli_xxx_bot2",
    "larkAppSecret": "secret_2",
    "cliId": "codex",
    "workingDir": "~/work"
  }
]
```

| Field | Required | Description |
|-------|----------|-------------|
| `larkAppId` | Yes | Lark app ID |
| `larkAppSecret` | Yes | Lark app secret |
| `cliId` | No | CLI adapter, defaults to `claude-code` (options: `aiden`, `coco`, `codex`, `gemini`, `opencode`) |
| `cliPathOverride` | No | CLI binary path override |
| `backendType` | No | Session backend: `pty` or `tmux` (auto-detected by default) |
| `workingDir` | No | Default working directory, supports comma-separated |
| `allowedUsers` | No | Allowed users (email prefixes or open_ids) |
| `projectScanDir` | No | Directory to scan for git repos |

**Config priority:** `BOTS_CONFIG` env var > `~/.botmux/bots.json`

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BOTS_CONFIG` | _(unset)_ | Path to bots.json (overrides default location) |
| `WEB_HOST` | `0.0.0.0` | HTTP server bind address |
| `WEB_EXTERNAL_HOST` | _(auto-detect LAN IP)_ | External hostname/IP for terminal URLs |
| `SESSION_DATA_DIR` | `~/.botmux/data` | Where sessions and queues are stored |
| `DEBUG` | _(unset)_ | Set to `1` for debug logging |

## File Locations

| Path | Description |
|------|-------------|
| `~/.botmux/bots.json` | Bot configuration |
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
| `/skip` | Skip repo selection, start session directly |
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
- Status indicator: 🟡 Starting > 🔵 Working > 🟢 Idle
- Action buttons: Open Terminal, Get Write Link, Restart Claude, Close Session

The card content is captured from a headless xterm terminal that filters out TUI chrome (logo, status bar, prompts, box-drawing characters) and shows only Claude's actual work output.

### Web Terminal

Each session exposes a web terminal at `http://<WEB_EXTERNAL_HOST>:<port>`.

- **Read-only link** — shown on the streaming card in the group thread
- **Write-enabled link** — sent via DM on demand (click "🔑 Get Write Link" on the card)

Features: xterm.js with fit/unicode11/web-links addons, TokyoNight theme, scrollback buffer. On mobile/tablet, a floating shortcut toolbar provides Esc, Ctrl+C, Tab, arrow keys and other control keys missing from virtual keyboards, with automatic keyboard avoidance.

### Tmux Persistent Sessions

When tmux is installed, botmux automatically uses the tmux backend. CLI processes run inside tmux sessions while the daemon attaches via node-pty to capture output — streaming cards, idle detection, and web terminal all work unchanged.

**Key benefit: daemon restarts don't interrupt the CLI.** During `botmux restart`, the worker process exits but the tmux session (and the CLI inside it) keeps running. The next incoming message triggers a re-attach — no `--resume` context reload needed.

```bash
# Recommended: interactive session picker — select and attach to tmux
npx botmux list

# Or manually attach (session name = bmx-<first 8 chars of session ID>)
tmux attach -t bmx-<first-8-chars-of-session-id>
# Ctrl+B, D to detach — CLI keeps running

# Force pure pty mode (disable tmux)
BACKEND_TYPE=pty botmux start
```

`botmux list` provides an interactive TUI showing all active sessions with ID, title, working directory, PID, uptime, and status. Use arrow keys to select and Enter to attach. Use `botmux list --plain` for plain-text table output suitable for scripting.

**Session naming:** `bmx-<first 8 chars of session UUID>`

**Lifecycle:**

| Event | tmux session | CLI process |
|-------|-------------|-------------|
| `botmux restart` | Survives | Survives (re-attaches on next message) |
| `/close` or close button | Destroyed | Terminated (SIGHUP) |
| CLI exits / crashes | Closes with it | Already exited (auto-restart creates new session) |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
