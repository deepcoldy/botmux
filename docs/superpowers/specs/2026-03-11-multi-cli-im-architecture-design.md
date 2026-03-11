# Multi-CLI / Multi-IM Architecture Design

Date: 2026-03-11

## Context

claude-code-robot bridges Lark (Feishu) group threads to CLI coding agents via PTY.
It currently supports Claude Code, Aiden, and partially CoCo (Trae), but CLI-specific
logic is scattered across `daemon.ts` (1498 lines) and `worker.ts` with if/else chains.
Lark is hardcoded throughout with no abstraction. Adding a new CLI or IM requires
touching multiple files.

## Goals

1. **CLI adapter layer** — adding a new CLI tool (CoCo, Codex, future tools) means
   adding one adapter file, not touching core logic.
2. **Session backend abstraction** — support node-pty (default) and tmux (optional)
   so physical terminal, web terminal, and IM messages can all connect to the same session.
3. **IM-ready core** — design the session/worker core to be IM-agnostic. Define the
   ImAdapter interface now, implement only Lark. Future IMs (Slack, Discord) require
   adding an adapter, not rewriting core logic.
4. **Decompose daemon.ts** — split the 1498-line monolith into focused modules by
   responsibility.
5. **Incremental migration** — every step runs and can be verified on master. No big
   bang rewrites.

## Non-Goals

- Implementing a second IM adapter (Slack, etc.) — only the interface is defined.
- TmuxBackend full implementation — only a stub + interface.
- Pipe/headless mode (`--print`) — out of scope for now, can be added as a backend later.

---

## Core Abstractions

### 1. CliAdapter — CLI Tool Adapter

```typescript
// src/adapters/cli/types.ts

interface PtyHandle {
  write(data: string): void;
}

interface CliAdapter {
  /** Unique identifier: 'claude-code' | 'aiden' | 'coco' | 'codex' */
  id: string;

  /** Default binary name (e.g. 'claude', 'aiden', 'coco', 'codex').
   *  Resolved to absolute path via login-shell `which` at construction time.
   *  Overridden by CLAUDE_PATH env var if set. */
  resolvedBin: string;

  /** Build spawn arguments for the CLI (bin comes from resolvedBin) */
  buildArgs(opts: {
    sessionId: string;
    resume: boolean;
    workingDir: string;
  }): string[];

  /** Write user input to PTY, handling CLI-specific paste behavior.
   *  MAY fire writes asynchronously (e.g. Aiden's delayed Enter).
   *  Caller must not assume input is fully written when this returns.
   *  Returns a Promise that resolves when all writes are complete. */
  writeInput(pty: PtyHandle, content: string): Promise<void>;

  /** Install MCP server config for this CLI.
   *  Each adapter handles its own config format (JSON, TOML, etc.)
   *  and file location. Idempotent — skips if already up to date. */
  ensureMcpConfig(serverEntry: McpServerEntry): void;

  /** Additional completion marker regex (beyond generic quiescence) */
  completionPattern?: RegExp;

  /** Whether the CLI uses alternate screen buffer */
  altScreen: boolean;
}

interface McpServerEntry {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}
```

**Binary resolution**: Each adapter has a default binary name (e.g. `'claude'`).
At construction time, the factory calls `resolveCommand()` (login-shell `which`)
to find the absolute path. The `CLAUDE_PATH` env var, if set, overrides the
default name before resolution. This keeps binary resolution in the adapter layer,
not the config layer.

Each CLI gets its own file exporting an adapter factory:

| CLI | File | Key differences |
|-----|------|-----------------|
| Claude Code | `claude-code.ts` | `--session-id`, `--dangerously-skip-permissions`, `content\r` input |
| Aiden | `aiden.ts` | `--permission-mode agentFull`, delayed `\r` for paste |
| CoCo | `coco.ts` | `--session-id`, `--yolo`, standard input (TBD) |
| Codex | `codex.ts` | `codex` subcommand pattern, `--yolo`, alt-screen |

### 2. SessionBackend — PTY / tmux Abstraction

```typescript
// src/adapters/backend/types.ts

interface SpawnOpts {
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

interface SessionBackend {
  spawn(bin: string, args: string[], opts: SpawnOpts): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  kill(): void;

  /** Attach info for external clients (tmux session name, etc.) */
  getAttachInfo?(): { type: 'tmux'; sessionName: string } | null;
}
```

Two implementations:
- **PtyBackend** — wraps current node-pty logic. Default, zero external dependencies.
- **TmuxBackend** — wraps `tmux new-session` / `send-keys` / `capture-pane`.
  Enables: physical `tmux attach`, web terminal, and Lark all connected to the same
  session. Stub in Phase 7, full implementation later.

### 3. ImAdapter — IM Platform Interface

```typescript
// src/im/types.ts

interface ImMessage {
  id: string;
  threadId: string;
  senderId: string;
  senderType: 'user' | 'bot';
  content: string;
  msgType: string;
  attachments?: ImAttachment[];
  createTime: string;
}

interface ImAttachment {
  type: 'image' | 'file';
  path: string;
  name: string;
}

interface ImUser {
  id: string;           // platform-specific user ID
  identifier: string;   // original input (email prefix, open_id, etc.)
}

interface ImCard {
  /** Opaque card payload — built by IM-specific card builder */
  payload: unknown;
}

interface ImCardAction {
  actionType: string;
  threadId: string;
  operatorId?: string;
  value?: Record<string, unknown>;
}

interface ImEventHandler {
  onNewTopic(msg: ImMessage, chatId: string, chatType: 'group' | 'p2p'): Promise<void>;
  onThreadReply(msg: ImMessage, threadId: string): Promise<void>;
  onCardAction(action: ImCardAction): Promise<void>;
}

/** Card builder — each IM provides its own implementation.
 *  Core modules call these methods; the IM adapter provides the factory. */
interface ImCardBuilder {
  buildSessionCard(opts: {
    sessionId: string;
    rootMessageId: string;
    terminalUrl: string;
    title: string;
  }): ImCard;

  buildStreamingCard(opts: {
    sessionId: string;
    rootMessageId: string;
    terminalUrl: string;
    title: string;
    content: string;
    status: 'starting' | 'working' | 'idle';
  }): ImCard;

  buildRepoSelectCard(opts: {
    projects: Array<{ name: string; path: string; description: string }>;
    currentCwd: string;
    rootMessageId: string;
  }): ImCard;
}

interface ImAdapter {
  start(handler: ImEventHandler): Promise<void>;
  stop(): Promise<void>;

  /** Card builder for this IM platform */
  cards: ImCardBuilder;

  sendMessage(threadId: string, content: string, format: 'text' | 'rich'): Promise<string>;
  replyMessage(messageId: string, content: string, format: 'text' | 'rich'): Promise<string>;
  updateMessage(messageId: string, content: string): Promise<void>;
  sendCard(threadId: string, card: ImCard): Promise<string>;
  updateCard(messageId: string, card: ImCard): Promise<void>;

  resolveUsers(identifiers: string[]): Promise<ImUser[]>;
  sendDirectMessage(userId: string, content: string): Promise<void>;

  downloadAttachment(messageId: string, resourceKey: string): Promise<string>;
  getThreadMessages(threadId: string, limit: number): Promise<ImMessage[]>;

  /** Get bot's own user ID (for filtering self-messages) */
  getBotUserId(): string | undefined;
}
```

Only `LarkImAdapter` is implemented. Core modules depend on `ImAdapter` and
`ImCardBuilder`, never on Lark-specific types directly.

---

## Directory Structure

```
src/
  adapters/
    cli/
      types.ts              # CliAdapter + McpServerEntry interfaces
      registry.ts           # id -> adapter factory + createCliAdapter()
      claude-code.ts
      aiden.ts
      coco.ts
      codex.ts              # stub
    backend/
      types.ts              # SessionBackend interface
      pty-backend.ts        # node-pty implementation
      tmux-backend.ts       # stub (future)
  im/
    types.ts                # ImAdapter + ImCardBuilder + ImEventHandler + ImMessage
    lark/
      adapter.ts            # LarkImAdapter implements ImAdapter
      client.ts             # Lark HTTP API calls (renamed from lark-client.ts)
      event-dispatcher.ts   # Lark WSClient + event routing
      card-builder.ts       # LarkCardBuilder implements ImCardBuilder
      card-handler.ts       # Card button interaction logic
      message-parser.ts     # Lark event -> ImMessage normalization
  core/
    types.ts                # DaemonSession type definition (see below)
    session-manager.ts      # Session CRUD, activeSessions Map, topic/reply handling
    worker-pool.ts          # Worker fork, IPC, restart, double-fork guard
    command-handler.ts      # /close /status /cost /schedule daemon commands
    cost-calculator.ts      # MODEL_PRICING, getSessionCost, formatNumber
    scheduler.ts            # Cron task management (moved from src/)
  tools/
    index.ts                # MCP tool registry
    send-to-thread.ts       # MCP tool: send message (uses ImAdapter in Phase 6)
    get-thread-messages.ts
    react-to-message.ts
  services/
    session-store.ts        # unchanged
    schedule-store.ts       # unchanged
    message-queue.ts        # unchanged
    project-scanner.ts      # unchanged
  utils/
    logger.ts               # unchanged
    terminal-renderer.ts    # unchanged
    idle-detector.ts        # new: extracted from worker.ts onPtyData
  worker.ts                 # uses CliAdapter + SessionBackend
  daemon.ts                 # thin entry: load config, wire modules, start
  config.ts                 # adds cliId, backendType
  types.ts                  # shared types + IPC message definitions
  index.ts                  # MCP server entry (unchanged)
  index-daemon.ts           # daemon entry (unchanged)
  cli.ts                    # CLI commands (unchanged)
```

### DaemonSession type

The `DaemonSession` interface (currently daemon.ts lines 25-46, 16 fields) is split:

```typescript
// src/core/types.ts

/** Core session state — IM-agnostic */
interface DaemonSession {
  session: Session;
  worker: ChildProcess | null;
  workerPort: number | null;
  workerToken: string | null;
  chatId: string;
  chatType: 'group' | 'p2p';
  spawnedAt: number;
  claudeVersion: string;
  lastMessageAt: number;
  hasHistory: boolean;
  workingDir?: string;
  initConfig?: DaemonToWorker;
  pendingRepo?: boolean;
  pendingPrompt?: string;
  pendingAttachments?: ImAttachment[];
  ownerUserId?: string;        // renamed from ownerOpenId (IM-agnostic)
  currentTurnTitle?: string;
}

/** IM-specific rendering state — managed by ImAdapter, opaque to core */
interface ImRenderState {
  streamCardId?: string;       // message_id of live streaming card
  streamCardPending?: boolean; // next screen_update creates a new card
  lastScreenContent?: string;  // frozen at idle for card update
}
```

`SessionManager` stores `DaemonSession`. `ImRenderState` is stored alongside
(e.g. as `Map<string, ImRenderState>` in `LarkImAdapter` or passed through).
This keeps IM-specific rendering concerns out of the core type.

### daemon.ts decomposition mapping

| Current daemon.ts content | Moves to |
|---------------------------|----------|
| `activeSessions` Map, session create/close/restore | `core/session-manager.ts` |
| `forkWorker()`, IPC handling, restart logic | `core/worker-pool.ts` |
| Lark WSClient, `im.message.receive_v1` dispatch | `im/lark/event-dispatcher.ts` |
| `card.action.trigger` handling | `im/lark/card-handler.ts` |
| `buildSessionCard()` etc. | `im/lark/card-builder.ts` |
| `/close`, `/status`, `/cost` commands | `core/command-handler.ts` |
| `getSessionCost()`, `MODEL_PRICING`, `formatNumber` | `core/cost-calculator.ts` |
| `buildNewTopicPrompt()`, permission checks | `core/session-manager.ts` |
| `ensureMcpConfig()` | each CliAdapter's `ensureMcpConfig()` method |
| `downloadResources()`, `getAttachmentsDir()` | `core/session-manager.ts` (calls `im.downloadAttachment()`) |
| `probeBotOpenId()`, `isBotMentioned()` | `im/lark/event-dispatcher.ts` |
| `checkGroupMessageAccess()`, user count cache | `im/lark/event-dispatcher.ts` |
| `getClaudeVersion()`, `refreshClaudeVersion()` | `adapters/cli/registry.ts` |
| Startup/shutdown glue | `daemon.ts` (~80-100 lines) |

### Thin daemon.ts sketch

```typescript
import { config } from './config.js';
import { createCliAdapter } from './adapters/cli/registry.js';
import { LarkImAdapter } from './im/lark/adapter.js';
import { SessionManager } from './core/session-manager.js';
import { WorkerPool } from './core/worker-pool.js';
import { Scheduler } from './core/scheduler.js';

export async function startDaemon() {
  const cli = createCliAdapter(config.daemon.cliId);
  const im = new LarkImAdapter(config.lark);
  const sessions = new SessionManager(im, config);
  const workers = new WorkerPool(cli, config);
  const scheduler = new Scheduler(sessions, workers);

  // IM events -> core logic
  await im.start({
    onNewTopic: (msg, chatId, chatType) =>
      sessions.handleNewTopic(msg, chatId, chatType, workers),
    onThreadReply: (msg, threadId) =>
      sessions.handleThreadReply(msg, threadId, workers),
    onCardAction: (action) =>
      sessions.handleCardAction(action, workers),
  });

  scheduler.start();
  // graceful shutdown handlers...
}
```

Note: `SessionManager` receives `ImAdapter` as a constructor dependency (not per-method
parameter). `WorkerPool` is passed per-method since session manager needs it only for
fork/send operations.

---

## Worker Refactoring

### CliAdapter usage in worker

Worker receives `cliId` and `backendType` via IPC init message, resolves the
adapter from the registry, and delegates all CLI-specific behavior:

```typescript
// Spawn
const cli = createCliAdapter(msg.cliId);
const args = cli.buildArgs({ sessionId, resume, workingDir });
backend.spawn(cli.resolvedBin, args, { cwd, cols, rows, env });

// Input (async — caller awaits before resetting idle detector)
await cli.writeInput(backend, content);
detector.reset();

// Idle detection
const detector = new IdleDetector(cli);
backend.onData((data) => {
  detector.feed(data);
  // ... broadcast to WS, scrollback, etc.
});
detector.onIdle(() => markPromptReady());
```

### writeInput async contract

`writeInput` returns `Promise<void>`. For CLIs that need delayed writes (Aiden),
the promise resolves after all writes complete. For CLIs with synchronous writes
(Claude Code), the promise resolves immediately. The worker awaits the promise
before calling `detector.reset()`, ensuring idle detection is not prematurely
restarted.

### IPC protocol changes

Only the `init` message changes:

```typescript
type DaemonToWorker =
  | { type: 'init';
      sessionId: string;
      chatId: string;
      rootMessageId: string;
      workingDir: string;
      cliId: string;            // replaces claudePath
      backendType: 'pty' | 'tmux';  // new
      prompt: string;
      resume?: boolean;
      ownerOpenId?: string;
    }
  | { type: 'message'; content: string }
  | { type: 'close' }
  | { type: 'restart' }
```

WorkerToDaemon messages are unchanged.

### IdleDetector extraction

```typescript
// src/utils/idle-detector.ts

class IdleDetector {
  constructor(cli: CliAdapter);

  /** Feed PTY output data for analysis */
  feed(data: string): void;

  /** Register idle callback */
  onIdle(cb: () => void): void;

  /** Reset state (call after writeInput resolves) */
  reset(): void;

  /** Cleanup timers */
  dispose(): void;
}
```

Internally manages: quiescence timer, spinner tracking, CLI-specific completion
pattern matching. All the logic currently in `onPtyData()` related to idle detection
moves here.

---

## CLI Adapter Details

### writeInput implementations

| CLI | Behavior |
|-----|----------|
| Claude Code | `pty.write(content + '\r')` — resolves immediately |
| Aiden | `pty.write(content)` → 200ms delay → `pty.write('\r')` → if multiline: 200ms → `pty.write('\r')` — resolves after all writes |
| CoCo | `pty.write(content + '\r')` — resolves immediately (to be verified) |
| Codex | `pty.write(content + '\r')` — resolves immediately (alt-screen handling TBD) |

### ensureMcpConfig implementations

Each adapter handles its own config file format:

| CLI | Path | Format | Logic |
|-----|------|--------|-------|
| Claude Code | `~/.claude.json` | JSON | Read file, set `mcpServers[name]`, write back |
| Aiden | `~/.aiden/.mcp.json` | JSON | Same as Claude Code |
| CoCo | `~/.trae/.mcp.json` | JSON | Same as Claude Code |
| Codex | `~/.codex/config.toml` | TOML | Read TOML, set `[mcp_servers.<name>]`, write back (requires TOML dependency) |

The Codex adapter stub will skip TOML writing and log a warning until a TOML
library is added.

### Spawn args

| CLI | New session | Resume | Permission bypass |
|-----|-------------|--------|-------------------|
| Claude Code | `--session-id <id>` | `--resume <id>` | `--dangerously-skip-permissions` |
| Aiden | (auto) | `--resume <id>` | `--permission-mode agentFull` |
| CoCo | `--session-id <id>` | `--resume <id>` | `--yolo` |
| Codex | (auto) | `codex resume <id>` | `--yolo` |

---

## Migration Plan

Incremental on master, 7 phases. Each phase produces runnable code.

### Phase 1: Extract CliAdapter interface + implementations
- New files: `adapters/cli/types.ts`, `registry.ts`, `claude-code.ts`, `aiden.ts`,
  `coco.ts`, `codex.ts`
- `resolveCommand()` moves from `config.ts` to `adapters/cli/registry.ts`.
- Pure additions, no existing code modified yet.

### Phase 2: Extract SessionBackend interface + PtyBackend
- New files: `adapters/backend/types.ts`, `pty-backend.ts`
- Pure additions, no existing code modified.

### Phase 3: Worker switches to adapters
- Refactor `worker.ts`: remove `detectCliKind()` and inline if/else chains.
  Use CliAdapter + PtyBackend.
- Extract `utils/idle-detector.ts` from `onPtyData()` logic.
- IPC `init` message adds `cliId`, `backendType`.
- `config.ts` adds `cliId` config, keeps `claudePath` as `CLAUDE_PATH` override.
- **Verify**: build + restart, test Claude Code and Aiden sessions via Lark.

### Phase 4: Define ImAdapter + decompose daemon.ts core
- New files: `im/types.ts` (ImAdapter + ImCardBuilder interfaces), `core/types.ts`
  (DaemonSession).
- Extract from daemon.ts: `core/session-manager.ts`, `core/worker-pool.ts`,
  `core/command-handler.ts`, `core/cost-calculator.ts`.
- Move `scheduler.ts` → `core/scheduler.ts`.
- daemon.ts becomes thin entry (~80-100 lines).
- **Note**: In this phase, `SessionManager` temporarily imports Lark client
  directly. This coupling is removed in Phase 5 when `LarkImAdapter` is created.
- **Verify**: functionality unchanged, code is reorganized.

### Phase 5: Extract Lark layer
- Extract: `im/lark/event-dispatcher.ts` (includes `probeBotOpenId`,
  `isBotMentioned`, `checkGroupMessageAccess`, user count cache),
  `im/lark/card-handler.ts`.
- Move: `lark-client.ts` → `im/lark/client.ts`,
  `card-builder.ts` → `im/lark/card-builder.ts` (implements `ImCardBuilder`),
  `message-parser.ts` → `im/lark/message-parser.ts`.
- New: `im/lark/adapter.ts` (LarkImAdapter implements ImAdapter).
- Refactor `SessionManager` to depend on `ImAdapter` instead of Lark client.
  `getThreadMessages()` returns `ImMessage[]` directly, eliminating the need
  for MCP tools to import message-parser.
- **Verify**: build + restart, full regression.

### Phase 6: MCP tools use ImAdapter
- MCP tools call `ImAdapter` methods instead of importing lark client directly.
- MCP server process instantiates the correct IM adapter from config.
- `get-thread-messages` uses `im.getThreadMessages()` which returns `ImMessage[]`,
  no parser import needed.
- **Verify**: send_to_thread, get_thread_messages, react_to_message all work.

### Phase 7: CoCo full support + TmuxBackend stub
- Complete `coco.ts` adapter (verify spawn args, input, idle detection).
- New: `adapters/backend/tmux-backend.ts` (implements SessionBackend, experimental).
- Config supports `BACKEND_TYPE=tmux`.
- Update documentation.

### Phase dependencies

```
Phase 1 (cli adapters) ──┐
Phase 2 (backend)     ───┼──> Phase 3 (worker) ──> Phase 4 (core split)
                                                       ──> Phase 5 (lark split)
                                                           ──> Phase 6 (mcp tools)
                                                               ──> Phase 7 (coco + tmux)
```

Phase 1 and 2 are independent and can be done in parallel.

---

## Config Changes

```env
# .env additions
CLI_ID=claude-code          # claude-code | aiden | coco | codex
BACKEND_TYPE=pty             # pty | tmux (default: pty)
# CLAUDE_PATH is kept as optional binary override (passed to adapter factory)
```

```typescript
// config.ts
daemon: {
  cliId: process.env.CLI_ID ?? 'claude-code',
  backendType: (process.env.BACKEND_TYPE ?? 'pty') as 'pty' | 'tmux',
  cliPathOverride: process.env.CLAUDE_PATH,  // optional, overrides adapter default
  workingDir: process.env.CLAUDE_WORKING_DIR ?? '~',
  allowedUsers: ...,
  projectScanDir: ...,
}
```

The `claudePath` field is replaced by `cliId` (which adapter to use) and
`cliPathOverride` (optional binary path override). The adapter factory uses
`cliPathOverride ?? defaultBinaryName` and resolves via `resolveCommand()`.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| daemon.ts split introduces subtle bugs | Each phase verified with build + restart + Lark test |
| Phase 4 `SessionManager` temporarily imports Lark directly | Explicit in plan; cleaned up in Phase 5 |
| Import path changes break MCP server | Phase 6 is isolated; MCP server is a separate entry point |
| CoCo PTY behavior differs from assumed | coco.ts adapter is verified empirically in Phase 7 |
| Codex alt-screen breaks terminal renderer | Codex adapter is a stub; full support deferred until tested |
| Codex TOML config requires new dependency | Stub logs warning; TOML support added when Codex is actively used |
| TmuxBackend complexity | Stub only in Phase 7; full implementation is a separate project |
