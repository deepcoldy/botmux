# Contributing to botmux

## Development Setup

```bash
git clone https://github.com/deepcoldy/botmux.git
cd botmux
pnpm install
pnpm build

# Run directly (no PM2)
pnpm daemon

# Or with PM2
pnpm daemon:start
pnpm daemon:logs
```

> Every code change requires `pnpm build` then `pnpm daemon:restart`.

## Architecture

```
Lark WebSocket Events
    |
Daemon (daemon.ts → core/ modules)
    |-- im/lark/event-dispatcher: event routing
    |-- im/lark/card-handler: card interactions
    |-- core/worker-pool: worker process pool
    |-- core/command-handler: slash commands
    |-- core/session-manager: session lifecycle
    |-- core/scheduler: cron scheduling
    |
Worker (worker.ts) -- forked per session
    |-- adapters/cli/*: CLI adapters (Claude Code / Codex / Gemini / OpenCode)
    |-- adapters/backend: PtyBackend or TmuxBackend
    |-- utils/idle-detector: idle detection
    |-- HTTP + WebSocket: xterm.js web terminal
    |-- Headless xterm: screen capture for streaming cards
    |-- IPC: daemon communication
    |
AI Coding CLI (interactive TTY)
    |-- MCP Server (stdio): send_to_thread, get_thread_messages, react_to_message
    |
Lark API
    |-- Replies, reactions, card updates, DMs
```

## Project Structure

```
src/
  cli.ts                    # CLI entry (setup/start/stop/restart/logs/list/delete)
  daemon.ts                 # Daemon orchestrator
  worker.ts                 # Worker: CLI + PTY management, web terminal
  bot-registry.ts           # Multi-bot registry
  config.ts                 # Environment config
  server.ts                 # MCP server
  types.ts                  # IPC message types
  adapters/
    cli/
      types.ts              # CliAdapter interface, CliId type
      registry.ts           # Adapter factory + resolveCommand
      claude-code.ts        # Claude Code adapter
      codex.ts              # Codex adapter
      gemini.ts             # Gemini CLI adapter
    backend/
      types.ts              # SessionBackend interface
      pty-backend.ts        # node-pty backend
      tmux-backend.ts       # tmux backend (persistent sessions)
  core/
    types.ts                # DaemonSession core type
    worker-pool.ts          # Worker process pool
    command-handler.ts      # Slash command processing
    session-manager.ts      # Session lifecycle + path resolution
    cost-calculator.ts      # Token usage & cost estimation
    scheduler.ts            # Cron scheduling (natural language parsing)
  im/
    types.ts                # ImAdapter interface (multi-IM abstraction)
    lark/
      client.ts             # Lark API wrapper
      event-dispatcher.ts   # Lark WebSocket event routing
      card-handler.ts       # Lark card interaction handling
      card-builder.ts       # Lark interactive card builders
      message-parser.ts     # Lark event message parsing
  tools/
    index.ts                # MCP tool registry
    send-to-thread.ts       # MCP: send message to thread
    get-thread-messages.ts  # MCP: read thread messages
    react-to-message.ts     # MCP: emoji reactions
  services/
    session-store.ts        # Session persistence (JSON)
    schedule-store.ts       # Scheduled task persistence
    message-queue.ts        # Per-thread JSONL message queue
    project-scanner.ts      # Git repo/worktree discovery
  utils/
    idle-detector.ts        # CLI idle detection
    terminal-renderer.ts    # Headless xterm renderer (screen capture & TUI filtering)
    logger.ts               # Logging utility
```

## MCP Tools

The CLI communicates with Lark through three MCP tools exposed via stdio:

| Tool | Description |
|------|-------------|
| `send_to_thread` | Send a message (plain text or rich post) to the Lark thread |
| `get_thread_messages` | Retrieve message history from the thread |
| `react_to_message` | Add or remove emoji reactions on messages |

MCP config is auto-injected by each CLI adapter's `ensureMcpConfig()` method at session startup.

## Adding a New CLI Adapter

1. Create a new file in `src/adapters/cli/`, implementing the `CliAdapter` interface
2. Add the new ID to the `CliId` type in `src/adapters/cli/types.ts`
3. Add a case to the switch in `src/adapters/cli/registry.ts`
4. Set `"cliId": "<new-id>"` in `bots.json` to use it

The `CliAdapter` interface requires:

| Method / Property | Description |
|-------------------|-------------|
| `id` | Unique CLI identifier |
| `resolvedBin` | Path to the CLI binary |
| `buildArgs()` | Construct CLI launch arguments |
| `writeInput()` | Write user input to the PTY (handles multi-line, Enter key timing) |
| `ensureMcpConfig()` | Register the botmux MCP server in the CLI's config |
| `completionPattern` | Regex to detect when a turn is complete (optional) |
| `readyPattern` | Regex to detect when the CLI is ready for input (optional) |
| `systemHints` | System-level hints injected into the CLI (optional) |
| `altScreen` | Whether the CLI uses alternate screen mode |

## Tests

```bash
pnpm test                # Run all tests
pnpm test:codex          # Codex input E2E test
pnpm test:mcp            # Codex MCP E2E test
pnpm test:claude-mcp     # Claude Code MCP E2E test
pnpm test:gemini         # Gemini CLI input E2E test
```
