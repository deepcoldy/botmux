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
    |-- Auto-installed Skills (~/.claude/skills/, ~/.gemini/skills/, ~/.config/opencode/skills/)
    |-- ~/.botmux/bin/botmux wrapper on PATH → `botmux send/schedule/bots/thread` subcommands
    |
Lark API
    |-- Replies, reactions, card updates, DMs
```

## Project Structure

```
src/
  cli.ts                    # CLI entry (setup/start/stop/restart/logs/list/delete + send/bots/schedule/thread subcommands)
  daemon.ts                 # Daemon orchestrator
  worker.ts                 # Worker: CLI + PTY management, web terminal
  bot-registry.ts           # Multi-bot registry
  config.ts                 # Environment config
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
  skills/
    definitions.ts          # Built-in Skill markdown (botmux-send/schedule/bots/thread-messages)
    installer.ts            # Syncs skills into each CLI's native skills dir
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

## CLI-Agent Interaction (Skills + CLI subcommands)

botmux exposes its Lark-interaction surface as **CLI subcommands**
(`botmux send`, `botmux schedule`, `botmux bots`,
`botmux thread messages`) paired with auto-installed **Skills** that
teach the agent when/how to use them.

**Runtime setup per CLI worker spawn** (see `src/core/worker-pool.ts`):

1. `ensureCliSkills(cliId)` — writes `src/skills/definitions.ts` content
   into the CLI's native skill dir (`~/.claude/skills/`, `~/.gemini/skills/`,
   `~/.config/opencode/skills/`). Synchronous, idempotent per lifecycle.
2. Worker `PATH` is prepended with `~/.botmux/bin`, which contains a
   `botmux` shell wrapper written by the daemon at startup (points at the
   running daemon's `dist/cli.js` — always in sync).
3. `--append-system-prompt` flag injects the routing instruction
   ("user reads Lark, not terminal — use `botmux send` for user-facing content")
   into each CLI session.
4. Every user message carries a per-message hint (`[回复请用 botmux send]`)
   appended in `buildFollowUpContent` to keep the instruction near the attention
   window even in long conversations.

### CLI subcommands (agent-facing)

| Subcommand | Description |
|------------|-------------|
| `botmux send [content]` | Send message to current thread (stdin / heredoc / `--content-file`; `--images` / `--files` / `--mention` flags) |
| `botmux bots list` | List bots in current chat with their `open_id`s |
| `botmux thread messages [--limit N]` | Fetch thread message history (JSON) |
| `botmux schedule add <schedule> <prompt>` | Create scheduled task bound to current thread |
| `botmux schedule list/remove/pause/resume/run` | Manage tasks |

All agent-facing subcommands auto-detect session context by walking the
process tree looking for a CLI-pid marker written by the worker
(`{dataDir}/.botmux-cli-pids/{pid}`). Works across every CLI that can
spawn child processes — no extra protocol support required from the CLI.

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
| `skillsDir` | Absolute path to the CLI's skills directory (optional; Skills only installed when set) |
| `completionPattern` | Regex to detect when a turn is complete (optional) |
| `readyPattern` | Regex to detect when the CLI is ready for input (optional) |
| `systemHints` | System-level hints injected into the CLI (optional) |
| `altScreen` | Whether the CLI uses alternate screen mode |

## Tests

```bash
pnpm test                # Run all tests (unit + E2E)
pnpm test:codex          # Codex input E2E
pnpm test:gemini         # Gemini CLI input E2E
```
