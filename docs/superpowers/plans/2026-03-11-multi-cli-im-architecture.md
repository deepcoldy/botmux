# Multi-CLI / Multi-IM Architecture Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor claude-code-robot to support multiple CLI tools (Claude Code, Aiden, CoCo, Codex) via adapters, abstract the PTY layer behind a session backend interface, and decompose the 1498-line daemon.ts into focused modules with an IM-agnostic core.

**Architecture:** CLI-specific logic extracted into adapter objects implementing `CliAdapter`. PTY management abstracted behind `SessionBackend` (default: node-pty, future: tmux). daemon.ts split into `SessionManager`, `WorkerPool`, and Lark-specific event handling. `ImAdapter` interface defined for future multi-IM support.

**Tech Stack:** TypeScript, node-pty, @larksuiteoapi/node-sdk, @modelcontextprotocol/sdk, ws

**Spec:** `docs/superpowers/specs/2026-03-11-multi-cli-im-architecture-design.md`

**No test framework exists** in this project. Verification is `pnpm build` + `pnpm daemon:restart` + manual Lark test per phase.

---

## Chunk 1: CLI Adapters + Session Backend (Phase 1 & 2)

Pure additions — no existing code modified. Creates the adapter interfaces and implementations that Phase 3 will wire in.

### Task 1: CliAdapter Interface + Types

**Files:**
- Create: `src/adapters/cli/types.ts`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p src/adapters/cli src/adapters/backend
```

- [ ] **Step 2: Write CliAdapter interface**

Create `src/adapters/cli/types.ts`:

```typescript
export interface PtyHandle {
  write(data: string): void;
}

export interface McpServerEntry {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface CliAdapter {
  /** Unique identifier */
  readonly id: string;

  /** Resolved absolute path to the CLI binary */
  readonly resolvedBin: string;

  /** Build spawn arguments (bin comes from resolvedBin).
   *  Note: workingDir is NOT passed here — it's the backend's cwd, not a CLI arg. */
  buildArgs(opts: {
    sessionId: string;
    resume: boolean;
  }): string[];

  /** Write user input to PTY. May fire writes asynchronously (e.g. Aiden delayed Enter).
   *  Resolves when all writes are complete. */
  writeInput(pty: PtyHandle, content: string): Promise<void>;

  /** Install MCP server config. Idempotent — skips if up to date. */
  ensureMcpConfig(entry: McpServerEntry): void;

  /** Completion marker regex (beyond generic quiescence). undefined = quiescence only. */
  readonly completionPattern?: RegExp;

  /** Whether CLI uses alternate screen buffer */
  readonly altScreen: boolean;
}

export type CliId = 'claude-code' | 'aiden' | 'coco' | 'codex';
```

- [ ] **Step 3: Verify build**

```bash
pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add src/adapters/cli/types.ts
git commit -m "feat: add CliAdapter interface and types"
```

### Task 2: CLI Adapter Registry + resolveCommand

**Files:**
- Create: `src/adapters/cli/registry.ts`
- Ref: `src/config.ts` (resolveCommand moves here)

- [ ] **Step 1: Write registry with resolveCommand**

Create `src/adapters/cli/registry.ts`:

```typescript
import { execSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { CliAdapter, CliId } from './types.js';

/** Resolve a command name to its absolute path via login-shell `which`. */
export function resolveCommand(cmd: string): string {
  if (isAbsolute(cmd)) return cmd;
  const shell = process.env.SHELL || '/bin/zsh';
  const shells = [shell, '/bin/zsh', '/bin/bash'].filter((v, i, a) => a.indexOf(v) === i);
  for (const sh of shells) {
    try {
      return execSync(`${sh} -lc 'which ${cmd}'`, { encoding: 'utf-8', timeout: 5_000 }).trim();
    } catch { /* try next shell */ }
  }
  return cmd;
}

// Lazy-loaded adapter modules to avoid circular deps
const adapterFactories: Record<CliId, () => Promise<{ create: (pathOverride?: string) => CliAdapter }>> = {
  'claude-code': () => import('./claude-code.js'),
  'aiden': () => import('./aiden.js'),
  'coco': () => import('./coco.js'),
  'codex': () => import('./codex.js'),
};

const adapterCache = new Map<string, CliAdapter>();

export async function createCliAdapter(id: CliId, pathOverride?: string): Promise<CliAdapter> {
  const key = `${id}:${pathOverride ?? ''}`;
  if (adapterCache.has(key)) return adapterCache.get(key)!;
  const factory = adapterFactories[id];
  if (!factory) throw new Error(`Unknown CLI adapter: ${id}`);
  const mod = await factory();
  const adapter = mod.create(pathOverride);
  adapterCache.set(key, adapter);
  return adapter;
}

/** Synchronous version for use in worker process (adapters already imported). */
export { createClaudeCodeAdapter } from './claude-code.js';
export { createAidenAdapter } from './aiden.js';
export { createCocoAdapter } from './coco.js';
export { createCodexAdapter } from './codex.js';

export function createCliAdapterSync(id: CliId, pathOverride?: string): CliAdapter {
  switch (id) {
    case 'claude-code': return createClaudeCodeAdapter(pathOverride);
    case 'aiden': return createAidenAdapter(pathOverride);
    case 'coco': return createCocoAdapter(pathOverride);
    case 'codex': return createCodexAdapter(pathOverride);
    default: throw new Error(`Unknown CLI adapter: ${id}`);
  }
}
```

- [ ] **Step 2: Note — build deferred**

Build will fail because adapter modules don't exist yet. Build verification is deferred to Task 5, Step 3 when all four adapter files exist. Do not run `pnpm build` here.

### Task 3: Claude Code Adapter

**Files:**
- Create: `src/adapters/cli/claude-code.ts`

- [ ] **Step 1: Write Claude Code adapter**

Create `src/adapters/cli/claude-code.ts`. Extract logic from `worker.ts:261-304` (spawnClaude) and `worker.ts:91-97` (writeToPty else branch):

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle, McpServerEntry } from './types.js';

const COMPLETION_RE = /✻\s*(?:Worked|Crunched|Cogitated|Cooked|Churned|Saut[eé]ed) for \d+[smh]/;

export function createClaudeCodeAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'claude');
  return {
    id: 'claude-code',
    resolvedBin: bin,

    buildArgs({ sessionId, resume }) {
      const args: string[] = [];
      if (resume) {
        args.push('--resume', sessionId);
      } else {
        args.push('--session-id', sessionId);
      }
      args.push('--dangerously-skip-permissions');
      return args;
    },

    async writeInput(pty, content) {
      pty.write(content + '\r');
    },

    ensureMcpConfig(entry) {
      const configPath = join(homedir(), '.claude.json');
      let data: any = {};
      if (existsSync(configPath)) {
        try { data = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { /* fresh */ }
      }
      if (!data.mcpServers) data.mcpServers = {};
      const existing = data.mcpServers[entry.name];
      if (existing && existing.args?.[0] === entry.args[0]) return;
      data.mcpServers[entry.name] = {
        command: entry.command,
        args: entry.args,
        env: entry.env,
      };
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n');
    },

    completionPattern: COMPLETION_RE,
    altScreen: false,
  };
}

export const create = createClaudeCodeAdapter;
```

- [ ] **Step 2: Commit**

```bash
git add src/adapters/cli/claude-code.ts
git commit -m "feat: add Claude Code CLI adapter"
```

### Task 4: Aiden Adapter

**Files:**
- Create: `src/adapters/cli/aiden.ts`

- [ ] **Step 1: Write Aiden adapter**

Create `src/adapters/cli/aiden.ts`. Extract from `worker.ts:91-104` (writeToPty aiden branch) and `worker.ts:261-288`:

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle, McpServerEntry } from './types.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createAidenAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'aiden');
  return {
    id: 'aiden',
    resolvedBin: bin,

    buildArgs({ sessionId, resume }) {
      const args: string[] = [];
      if (resume) {
        args.push('--resume', sessionId);
      }
      // Aiden auto-generates session id for new sessions
      args.push('--permission-mode', 'agentFull');
      return args;
    },

    async writeInput(pty: PtyHandle, content: string) {
      pty.write(content);
      await delay(200);
      pty.write('\r');
      if (content.includes('\n')) {
        await delay(200);
        pty.write('\r');
      }
    },

    ensureMcpConfig(entry: McpServerEntry) {
      const configPath = join(homedir(), '.aiden', '.mcp.json');
      let data: any = {};
      if (existsSync(configPath)) {
        try { data = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { /* fresh */ }
      }
      if (!data.mcpServers) data.mcpServers = {};
      const existing = data.mcpServers[entry.name];
      if (existing && existing.args?.[0] === entry.args[0]) return;
      data.mcpServers[entry.name] = {
        command: entry.command,
        args: entry.args,
        env: entry.env,
      };
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n');
    },

    completionPattern: undefined,  // quiescence only
    altScreen: false,
  };
}

export const create = createAidenAdapter;
```

- [ ] **Step 2: Commit**

```bash
git add src/adapters/cli/aiden.ts
git commit -m "feat: add Aiden CLI adapter"
```

### Task 5: CoCo Adapter + Codex Stub

**Files:**
- Create: `src/adapters/cli/coco.ts`
- Create: `src/adapters/cli/codex.ts`

- [ ] **Step 1: Write CoCo adapter**

Create `src/adapters/cli/coco.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle, McpServerEntry } from './types.js';

export function createCocoAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'coco');
  return {
    id: 'coco',
    resolvedBin: bin,

    buildArgs({ sessionId, resume }) {
      const args: string[] = [];
      if (resume) {
        args.push('--resume', sessionId);
      } else {
        args.push('--session-id', sessionId);
      }
      args.push('--yolo');
      return args;
    },

    async writeInput(pty: PtyHandle, content: string) {
      pty.write(content + '\r');
    },

    ensureMcpConfig(entry: McpServerEntry) {
      const configPath = join(homedir(), '.trae', '.mcp.json');
      let data: any = {};
      if (existsSync(configPath)) {
        try { data = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { /* fresh */ }
      }
      if (!data.mcpServers) data.mcpServers = {};
      const existing = data.mcpServers[entry.name];
      if (existing && existing.args?.[0] === entry.args[0]) return;
      data.mcpServers[entry.name] = {
        command: entry.command,
        args: entry.args,
        env: entry.env,
      };
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n');
    },

    completionPattern: undefined,
    altScreen: false,
  };
}

export const create = createCocoAdapter;
```

- [ ] **Step 2: Write Codex adapter stub**

Create `src/adapters/cli/codex.ts`:

```typescript
import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle, McpServerEntry } from './types.js';

export function createCodexAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'codex');
  return {
    id: 'codex',
    resolvedBin: bin,

    buildArgs({ sessionId, resume }) {
      // Codex uses subcommand pattern: `codex resume <id>`
      if (resume) return ['resume', sessionId];
      return ['--yolo'];
    },

    async writeInput(pty: PtyHandle, content: string) {
      pty.write(content + '\r');
    },

    ensureMcpConfig(_entry: McpServerEntry) {
      // Codex uses TOML config (~/.codex/config.toml). Stub — log only.
      console.warn('[codex] MCP config requires TOML support — skipping auto-install');
    },

    completionPattern: undefined,
    altScreen: true,
  };
}

export const create = createCodexAdapter;
```

- [ ] **Step 3: Verify build**

```bash
pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add src/adapters/cli/coco.ts src/adapters/cli/codex.ts
git commit -m "feat: add CoCo and Codex CLI adapter stubs"
```

### Task 6: SessionBackend Interface + PtyBackend

**Files:**
- Create: `src/adapters/backend/types.ts`
- Create: `src/adapters/backend/pty-backend.ts`

- [ ] **Step 1: Write SessionBackend interface**

Create `src/adapters/backend/types.ts`:

```typescript
export interface SpawnOpts {
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

export interface SessionBackend {
  spawn(bin: string, args: string[], opts: SpawnOpts): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  kill(): void;
  getAttachInfo?(): { type: 'tmux'; sessionName: string } | null;
}
```

- [ ] **Step 2: Write PtyBackend**

Create `src/adapters/backend/pty-backend.ts`. Extract from `worker.ts:299-314`:

```typescript
import * as pty from 'node-pty';
import type { SessionBackend, SpawnOpts } from './types.js';

export class PtyBackend implements SessionBackend {
  private process: pty.IPty | null = null;

  spawn(bin: string, args: string[], opts: SpawnOpts): void {
    this.process = pty.spawn(bin, args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
    });
  }

  write(data: string): void {
    this.process?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process?.resize(cols, rows);
  }

  /** Must be called AFTER spawn(). Callbacks registered before spawn are silently lost. */
  onData(cb: (data: string) => void): void {
    this.process?.onData(cb);
  }

  /** Must be called AFTER spawn(). Callbacks registered before spawn are silently lost. */
  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.process?.onExit(({ exitCode, signal }) => {
      cb(exitCode, signal !== undefined ? String(signal) : null);
    });
  }

  kill(): void {
    if (this.process) {
      try { this.process.kill(); } catch { /* already dead */ }
      this.process = null;
    }
  }
}
```

- [ ] **Step 3: Verify full build**

```bash
pnpm build
```

All files should compile. No existing code has been modified.

- [ ] **Step 4: Commit**

```bash
git add src/adapters/backend/
git commit -m "feat: add SessionBackend interface and PtyBackend implementation"
```

---

## Chunk 2: Worker Switches to Adapters (Phase 3)

This is the critical refactoring step. `worker.ts` drops `detectCliKind()` and all
CLI-specific if/else chains, replacing them with CliAdapter + PtyBackend.

### Task 7: Extract IdleDetector

**Files:**
- Create: `src/utils/idle-detector.ts`

- [ ] **Step 1: Write IdleDetector class**

Create `src/utils/idle-detector.ts`. Extract from `worker.ts:56-191` (all idle detection logic):

```typescript
import type { CliAdapter } from '../adapters/cli/types.js';

/** Spinner frames — animate while CLI is working */
const SPINNER_RE = /[·✢✳✶✻✽]/;

/** Default quiescence timeout (ms) — idle if PTY silent + no recent spinner */
const QUIESCENCE_MS = 2_000;
/** Spinner guard — don't declare idle if spinner seen within this window */
const SPINNER_GUARD_MS = 3_000;

export class IdleDetector {
  private outputTail = '';
  private lastSpinnerAt = 0;
  private quiescenceTimer: ReturnType<typeof setTimeout> | null = null;
  private isIdle = false;
  private idleCallback: (() => void) | null = null;
  private completionPattern: RegExp | undefined;

  constructor(cli: CliAdapter) {
    this.completionPattern = cli.completionPattern;
  }

  onIdle(cb: () => void): void {
    this.idleCallback = cb;
  }

  feed(data: string): void {
    if (this.isIdle) return;

    const stripped = this.stripAnsi(data);
    this.outputTail = (this.outputTail + stripped).slice(-500);

    // Track spinner — but not if it's part of completion marker
    if (SPINNER_RE.test(stripped) && !(this.completionPattern?.test(this.outputTail))) {
      this.lastSpinnerAt = Date.now();
    }

    // Strategy 1: CLI-specific completion marker
    if (this.completionPattern?.test(this.outputTail)) {
      this.clearTimer();
      this.quiescenceTimer = setTimeout(() => {
        this.quiescenceTimer = null;
        if (!this.isIdle) this.markIdle();
      }, 500);
      return;
    }

    // Strategy 2: quiescence (PTY silence + no recent spinner)
    this.clearTimer();
    this.quiescenceTimer = setTimeout(() => this.quiescenceCheck(), QUIESCENCE_MS);
  }

  reset(): void {
    this.isIdle = false;
    this.outputTail = '';
    this.lastSpinnerAt = Date.now();
    this.clearTimer();
  }

  dispose(): void {
    this.clearTimer();
    this.idleCallback = null;
  }

  private quiescenceCheck(): void {
    this.quiescenceTimer = null;
    if (this.isIdle) return;
    const sinceSpinner = Date.now() - this.lastSpinnerAt;
    if (sinceSpinner < SPINNER_GUARD_MS) {
      this.quiescenceTimer = setTimeout(
        () => this.quiescenceCheck(),
        SPINNER_GUARD_MS - sinceSpinner + 200,
      );
      return;
    }
    this.markIdle();
  }

  private markIdle(): void {
    this.isIdle = true;
    this.outputTail = '';
    this.clearTimer();
    this.idleCallback?.();
  }

  private clearTimer(): void {
    if (this.quiescenceTimer) {
      clearTimeout(this.quiescenceTimer);
      this.quiescenceTimer = null;
    }
  }

  private stripAnsi(str: string): string {
    return str
      .replace(/\x1b\[(\d*)C/g, (_m, n) => ' '.repeat(Number(n) || 1))
      .replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]|\x1b\[[\?]?[0-9;]*[hlmsuJ]/g, '');
  }
}
```

- [ ] **Step 2: Verify build**

```bash
pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add src/utils/idle-detector.ts
git commit -m "feat: extract IdleDetector from worker.ts"
```

### Task 8: Update IPC Types + Config

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`

- [ ] **Step 1: Update DaemonToWorker init message**

In `src/types.ts`, replace the `init` variant in `DaemonToWorker` (line 48):

```typescript
// OLD
| { type: 'init'; sessionId: string; chatId: string; rootMessageId: string; workingDir: string; claudePath: string; prompt: string; resume?: boolean; ownerOpenId?: string }

// NEW
| { type: 'init'; sessionId: string; chatId: string; rootMessageId: string; workingDir: string; cliId: string; backendType: 'pty' | 'tmux'; prompt: string; resume?: boolean; ownerOpenId?: string }
```

- [ ] **Step 2: Update config.ts**

In `src/config.ts`, replace `claudePath` with new fields. Keep `resolveCommand` for now (still used by existing daemon.ts until Phase 4):

Replace the `daemon` section:

```typescript
daemon: {
  model: process.env.LARK_BRIDGE_MODEL ?? 'opus',
  maxTurns: Number(process.env.LARK_BRIDGE_MAX_TURNS ?? '500'),
  cliId: (process.env.CLI_ID ?? 'claude-code') as import('./adapters/cli/types.js').CliId,
  cliPathOverride: process.env.CLAUDE_PATH,
  backendType: (process.env.BACKEND_TYPE ?? 'pty') as 'pty' | 'tmux',
  claudePath: resolveCommand(process.env.CLAUDE_PATH ?? 'claude'),  // kept for backward compat
  workingDir: process.env.CLAUDE_WORKING_DIR ?? '~',
  allowedUsers: (process.env.ALLOWED_USERS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  projectScanDir: process.env.PROJECT_SCAN_DIR ?? '',
},
```

Note: `claudePath` is kept temporarily — daemon.ts still references it until Phase 4 refactors it.

- [ ] **Step 3: Fix daemon.ts init message compilation**

In `daemon.ts`, find where `initMsg` is constructed (around line 321-325). Replace `claudePath: config.daemon.claudePath` with:

```typescript
cliId: config.daemon.cliId,
backendType: config.daemon.backendType,
```

Note: `ensureMcpConfig()` and `isAidenCli()` are replaced in Task 10. No changes needed here.

- [ ] **Step 4: Verify build**

```bash
pnpm build
```

Should compile cleanly. worker.ts will be fixed in Task 9.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/config.ts src/daemon.ts
git commit -m "feat: update IPC types and config for CLI adapter support"
```

### Task 9: Refactor worker.ts to Use Adapters

**Files:**
- Modify: `src/worker.ts`

This is the main refactoring. Replace all CLI-specific logic with adapter calls.

- [ ] **Step 1: Replace imports and state variables**

At top of `worker.ts`, replace:
- Remove: `import type { DaemonToWorker, WorkerToDaemon } from './types.js';` line only
- Add imports for adapters:

```typescript
import { createCliAdapterSync } from './adapters/cli/registry.js';
import type { CliAdapter } from './adapters/cli/types.js';
import { PtyBackend } from './adapters/backend/pty-backend.js';
import type { SessionBackend } from './adapters/backend/types.js';
import { IdleDetector } from './utils/idle-detector.js';
import type { DaemonToWorker, WorkerToDaemon } from './types.js';
```

Replace state variables (remove `useAiden`, add adapter refs):

```typescript
let cliAdapter: CliAdapter | null = null;
let backend: SessionBackend | null = null;
let idleDetector: IdleDetector | null = null;
```

- [ ] **Step 2: Remove detectCliKind and writeToPty**

Delete `detectCliKind()` function (lines 80-89) and `writeToPty()` function (lines 91-108).

- [ ] **Step 3: Rewrite spawnClaude to use adapters**

Replace `spawnClaude` function entirely:

```typescript
function spawnClaude(cfg: Extract<DaemonToWorker, { type: 'init' }>): void {
  cliAdapter = createCliAdapterSync(cfg.cliId as any, process.env.CLAUDE_PATH);
  backend = new PtyBackend();

  const args = cliAdapter.buildArgs({
    sessionId: cfg.sessionId,
    resume: cfg.resume ?? false,
  });

  // Extra args from env (CLI_DISABLE_DEFAULT_ARGS is removed — adapters own their defaults)
  const extra = (process.env.CLI_EXTRA_ARGS ?? '').trim();
  if (extra) args.push(...extra.split(/\s+/).filter(Boolean));

  log(`Spawning: ${cliAdapter.resolvedBin} ${args.join(' ')} (cwd: ${cfg.workingDir})`);

  backend.spawn(cliAdapter.resolvedBin, args, {
    cwd: cfg.workingDir,
    cols: PTY_COLS,
    rows: PTY_ROWS,
    env: { ...process.env, CLAUDECODE: undefined } as unknown as Record<string, string>,
  });

  // Set up idle detection
  idleDetector = new IdleDetector(cliAdapter);
  idleDetector.onIdle(() => {
    log('Prompt detected (idle)');
    markPromptReady();
  });

  backend.onData(onPtyData);
  backend.onExit((code, signal) => {
    log(`Claude exited (code: ${code}, signal: ${signal})`);
    backend = null;
    isPromptReady = false;
    send({ type: 'claude_exit', code, signal });
  });
}
```

- [ ] **Step 4: Simplify onPtyData — delegate idle detection**

Replace the entire `onPtyData` function. Remove all inline idle detection logic (spinner tracking, quiescence timer, completion marker). Keep: renderer feed, scrollback, WS broadcast, trust dialog. Delegate idle to `idleDetector.feed()`:

```typescript
const TRUST_DIALOG_PATTERN = /Yes, I trust this folder/;
let trustHandled = false;

function onPtyData(data: string): void {
  renderer?.write(data);

  scrollback += data;
  if (scrollback.length > MAX_SCROLLBACK) {
    scrollback = scrollback.slice(-MAX_SCROLLBACK);
  }

  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }

  // Trust dialog auto-accept
  if (!trustHandled) {
    const stripped = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    if (TRUST_DIALOG_PATTERN.test(stripped)) {
      trustHandled = true;
      log('Trust dialog detected, auto-accepting...');
      backend?.write('\r');
      return;
    }
  }

  // Delegate idle detection to IdleDetector
  idleDetector?.feed(data);
}
```

- [ ] **Step 5: Update sendToPty and flushPending to use adapter**

Replace `writeToPty(msg)` calls with `cliAdapter.writeInput(backend, msg)`:

```typescript
async function flushPending(): Promise<void> {
  log(`flushPending: ${pendingMessages.length} pending, promptReady=${isPromptReady}, hasPty=${!!backend}`);
  while (pendingMessages.length > 0 && isPromptReady && backend && cliAdapter) {
    const msg = pendingMessages.shift()!;
    isPromptReady = false;
    idleDetector?.reset();
    log(`Writing to PTY (flush): "${msg.substring(0, 80)}"`);
    await cliAdapter.writeInput(backend, msg);
  }
}

async function sendToPty(content: string): Promise<void> {
  if (!backend || !cliAdapter) return;
  if (isPromptReady) {
    isPromptReady = false;
    idleDetector?.reset();
    log(`Writing to PTY: "${content.substring(0, 80)}"`);
    await cliAdapter.writeInput(backend, content);
  } else {
    pendingMessages.push(content);
    log(`Queued message (${pendingMessages.length} pending): "${content.substring(0, 80)}"`);
  }
}
```

- [ ] **Step 6: Update markPromptReady to await flushPending**

`flushPending` is now async (because `cliAdapter.writeInput` returns `Promise<void>`). Update `markPromptReady` to await it. Preserve existing guards and behaviors from the original (worker.ts lines 110-130):

```typescript
async function markPromptReady(): Promise<void> {
  if (isPromptReady) return;  // guard against duplicate calls
  isPromptReady = true;
  if (awaitingFirstPrompt) {
    awaitingFirstPrompt = false;
    renderer?.markNewTurn();  // exclude history replay from streaming card
  }
  send({ type: 'prompt_ready' });
  // Send immediate idle snapshot so Lark card reflects idle status
  if (renderer) {
    const { content } = renderer.snapshot();
    send({ type: 'screen_update', content, status: 'idle' });
  }
  await flushPending();
}
```

Also update the IPC `message` handler to await `sendToPty`:

```typescript
case 'message':
  await sendToPty(msg.content);
  break;
```

Make the IPC handler async if it isn't already.

- [ ] **Step 7: Update killClaude to use backend**

```typescript
function killClaude(): void {
  idleDetector?.dispose();
  idleDetector = null;
  stopScreenUpdates();
  backend?.kill();
  backend = null;
  isPromptReady = false;
  pendingMessages.length = 0;
  scrollback = '';
  trustHandled = false;
}
```

- [ ] **Step 8: Update WS resize handler**

In the WebSocket `msg.type === 'resize'` handler, replace `ptyProcess.resize(...)` with `backend?.resize(msg.cols, msg.rows)`.

In the `msg.type === 'input'` handler, replace `ptyProcess.write(msg.data)` with `backend?.write(msg.data)`.

- [ ] **Step 9: Update restart handler**

In the `case 'restart'` handler, update to use adapter:

```typescript
case 'restart': {
  log('Restart requested');
  killClaude();
  awaitingFirstPrompt = true;
  setTimeout(() => {
    if (lastInitConfig) {
      startScreenUpdates();
      spawnClaude({ ...lastInitConfig, resume: true, prompt: '' });
    }
  }, 500);
  break;
}
```

- [ ] **Step 10: Remove old variables and functions**

Remove the now-unused module-level items:
- Variables: `ptyProcess`, `useAiden`, `outputTail`, `quiescenceTimer`, `lastSpinnerAt`
- Constants: `SPINNER_CHARS_RE`, `COMPLETION_RE`, `QUIESCENCE_MS`
- Functions: `detectCliKind()`, `writeToPty()`, `stripAnsi()`
- Types: `CliKind` (if defined locally)
- Constants: original `TRUST_DIALOG_PATTERN` (if re-declared in Step 4's `onPtyData`)

- [ ] **Step 11: Verify build**

```bash
pnpm build
```

Fix any remaining compile errors.

- [ ] **Step 12: Restart daemon and test**

```bash
pnpm daemon:restart
```

Send a test message via Lark to verify Claude Code sessions still work.

- [ ] **Step 13: Commit**

```bash
git add src/worker.ts
git commit -m "refactor: worker uses CliAdapter + PtyBackend + IdleDetector"
```

### Task 10: Update daemon.ts to pass cliId

**Files:**
- Modify: `src/daemon.ts`

- [ ] **Step 1: Update ensureMcpConfig to use adapter**

Import the adapter and call `adapter.ensureMcpConfig()` instead of the inline function. Find `ensureMcpConfig()` in daemon.ts and replace:

```typescript
import { createCliAdapterSync } from './adapters/cli/registry.js';

// Replace the ensureMcpConfig() function body with:
function ensureMcpConfig(): void {
  const adapter = createCliAdapterSync(
    config.daemon.cliId,
    config.daemon.cliPathOverride,
  );
  const serverScript = join(__dirname, 'index.js');
  adapter.ensureMcpConfig({
    name: 'claude-code-robot',
    command: 'node',
    args: [serverScript],
    env: {
      LARK_APP_ID: config.lark.appId,
      LARK_APP_SECRET: config.lark.appSecret,
    },
  });
}
```

Remove the old `isAidenCli()` detection in `ensureMcpConfig`.

- [ ] **Step 2: Update version detection to use adapter**

Replace `getClaudeVersion()` / `refreshClaudeVersion()` to use the adapter:

```typescript
function refreshClaudeVersion(): void {
  try {
    const adapter = createCliAdapterSync(
      config.daemon.cliId,
      config.daemon.cliPathOverride,
    );
    const raw = execFileSync(adapter.resolvedBin, ['--version'], {
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();
    currentClaudeVersion = raw.replace(/^[^0-9]*/, '');
    logger.info(`CLI version: ${currentClaudeVersion} (${adapter.id})`);
  } catch (err: any) {
    logger.warn(`Failed to get CLI version: ${err.message}`);
  }
}
```

- [ ] **Step 3: Verify build + restart + test**

```bash
pnpm build && pnpm daemon:restart
```

Test via Lark.

- [ ] **Step 4: Commit**

```bash
git add src/daemon.ts
git commit -m "refactor: daemon uses CliAdapter for MCP config and version detection"
```

---

## Chunk 3: Daemon Decomposition (Phase 4 & 5)

Split daemon.ts into core modules and extract Lark into its own layer.

### Task 11: Create core/types.ts

**Files:**
- Create: `src/core/types.ts`

- [ ] **Step 1: Write DaemonSession and ImRenderState**

Create `src/core/types.ts` with the types extracted from daemon.ts:

```typescript
import type { ChildProcess } from 'node:child_process';
import type { Session, DaemonToWorker } from '../types.js';
import type { ImAttachment } from '../im/types.js';

/** Core session state — IM-agnostic.
 *  IM-specific rendering state (ImRenderState) is stored separately
 *  in the ImAdapter implementation (e.g. Map<string, ImRenderState>
 *  inside LarkImAdapter), NOT on this type. */
export interface DaemonSession {
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
  ownerUserId?: string;
  currentTurnTitle?: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/core/types.ts
git commit -m "feat: add core DaemonSession types"
```

### Task 12: Create im/types.ts

**Files:**
- Create: `src/im/types.ts`

- [ ] **Step 1: Write ImAdapter interface**

Create `src/im/types.ts` with all IM interfaces (spec lines 136-227):

```typescript
export interface ImMessage {
  id: string;
  threadId: string;
  senderId: string;
  senderType: 'user' | 'bot';
  content: string;
  msgType: string;
  attachments?: ImAttachment[];
  createTime: string;
}

export interface ImAttachment {
  type: 'image' | 'file';
  path: string;
  name: string;
}

export interface ImUser {
  id: string;
  identifier: string;
}

export interface ImCard {
  payload: unknown;
}

export interface ImCardAction {
  actionType: string;
  threadId: string;
  operatorId?: string;
  value?: Record<string, unknown>;
}

export interface ImEventHandler {
  onNewTopic(msg: ImMessage, chatId: string, chatType: 'group' | 'p2p'): Promise<void>;
  onThreadReply(msg: ImMessage, threadId: string): Promise<void>;
  onCardAction(action: ImCardAction): Promise<void>;
}

export interface ImCardBuilder {
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

export interface ImAdapter {
  start(handler: ImEventHandler): Promise<void>;
  stop(): Promise<void>;

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

  /** Add a reaction emoji to a message. Returns the reaction ID. */
  addReaction(messageId: string, emojiType: string): Promise<string>;
  /** Remove a reaction by its reaction ID (not emoji type). */
  removeReaction(messageId: string, reactionId: string): Promise<void>;

  getBotUserId(): string | undefined;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/im/types.ts
git commit -m "feat: add ImAdapter interface definitions"
```

### Task 13: Extract core/worker-pool.ts

**Files:**
- Create: `src/core/worker-pool.ts`
- Modify: `src/daemon.ts`

- [ ] **Step 1: Extract forkWorker and related logic**

Move from daemon.ts into `src/core/worker-pool.ts`:
- `forkWorker()` function (lines ~290-455)
- `restartCounts` map
- Worker IPC message handling (`ready`, `prompt_ready`, `screen_update`, `claude_exit`, `error`)
- Double-fork guard

The WorkerPool class takes config as a constructor dep. Note: WorkerPool does NOT call CliAdapter directly — it sends `cliId` to the worker via IPC, and the worker resolves its own adapter. It exposes:
- `forkWorker(ds, prompt, resume?)`
- `sendMessage(ds, content)`
- `killWorker(ds)`

- [ ] **Step 2: Update daemon.ts to import WorkerPool**

Replace inline `forkWorker` calls with `workerPool.forkWorker(ds, ...)`.

- [ ] **Step 3: Verify build**

```bash
pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add src/core/worker-pool.ts src/daemon.ts
git commit -m "refactor: extract WorkerPool from daemon.ts"
```

### Task 14: Extract core/session-manager.ts + command-handler.ts + cost-calculator.ts

**Files:**
- Create: `src/core/session-manager.ts`
- Create: `src/core/command-handler.ts`
- Create: `src/core/cost-calculator.ts`
- Move: `src/scheduler.ts` → `src/core/scheduler.ts`
- Modify: `src/daemon.ts`

- [ ] **Step 1: Extract cost-calculator.ts**

Move `MODEL_PRICING`, `SessionCost`, `getSessionCost()`, `getSessionJsonlPath()`, `formatNumber()` from daemon.ts.

- [ ] **Step 2: Extract command-handler.ts**

Move command handling logic: `DAEMON_COMMANDS`, `handleCommand()`, `/close`, `/status`, `/cost`, `/schedule` handlers. Import cost-calculator.

- [ ] **Step 3: Extract session-manager.ts**

Move:
- `activeSessions` Map + `getActiveCount()`
- `handleNewTopic()`, `handleThreadReply()`
- `buildNewTopicPrompt()`, `formatAttachmentsHint()`
- `getSessionWorkingDir()`, `getProjectScanDir()`
- `downloadResources()`, `getAttachmentsDir()` (calls `im.downloadAttachment()` in Phase 5)
- `sessionReply()` helper (used by many modules — lives here since it's session-scoped)
- Session lifecycle (create, close, restore)

**Remaining daemon.ts items:**
- `tag()` helper → stays in daemon.ts (thin entry utility) or moves to `utils/`
- `lastRepoScan` map → `session-manager.ts` (project scan state)
- `killStalePids()` → `worker-pool.ts` (worker lifecycle)
- `currentClaudeVersion`/`getClaudeVersion()`/`refreshClaudeVersion()` → stays in daemon.ts startup logic (uses adapter from Task 10)

Note: In this phase, SessionManager still imports lark-client directly. This is cleaned up in Phase 5.

- [ ] **Step 4: Move scheduler.ts**

```bash
mv src/scheduler.ts src/core/scheduler.ts
```

Update all import paths.

- [ ] **Step 5: Slim daemon.ts to thin entry**

daemon.ts should now be ~80-150 lines: import modules, wire them together, start.

- [ ] **Step 6: Verify build + restart + test**

```bash
pnpm build && pnpm daemon:restart
```

Test via Lark.

- [ ] **Step 7: Commit**

```bash
git add src/core/ src/daemon.ts
git commit -m "refactor: decompose daemon.ts into core modules"
```

### Task 15: Extract Lark layer (Phase 5)

**Files:**
- Create: `src/im/lark/adapter.ts`
- Create: `src/im/lark/event-dispatcher.ts`
- Create: `src/im/lark/card-handler.ts`
- Move: `src/services/lark-client.ts` → `src/im/lark/client.ts`
- Move: `src/utils/card-builder.ts` → `src/im/lark/card-builder.ts`
- Move: `src/utils/message-parser.ts` → `src/im/lark/message-parser.ts`
- Modify: `src/core/session-manager.ts`

- [ ] **Step 1: Move Lark files to im/lark/**

```bash
mkdir -p src/im/lark
mv src/services/lark-client.ts src/im/lark/client.ts
mv src/utils/card-builder.ts src/im/lark/card-builder.ts
mv src/utils/message-parser.ts src/im/lark/message-parser.ts
```

Update all import paths across the codebase.

- [ ] **Step 2: Create event-dispatcher.ts**

Extract from daemon.ts:
- Lark SDK WSClient setup
- `im.message.receive_v1` handler
- `probeBotOpenId()`, `isBotMentioned()`
- `checkGroupMessageAccess()`, user count cache
- Permission checking

This module receives `ImEventHandler` callbacks and dispatches normalized events.

- [ ] **Step 3: Create card-handler.ts**

Extract from daemon.ts:
- `card.action.trigger` handler
- Repo selection, skip_repo, restart, close, get_write_link actions

- [ ] **Step 4: Create LarkImAdapter**

Create `src/im/lark/adapter.ts` implementing `ImAdapter`:
- `start()` → creates event-dispatcher, card-handler, wires to WSClient
- `stop()` → disconnects WSClient
- `cards` → LarkCardBuilder instance
- Message methods → delegate to client.ts
- `getThreadMessages()` → calls client + message-parser, returns `ImMessage[]`

- [ ] **Step 5: Refactor SessionManager to use ImAdapter**

Replace all direct lark-client imports in session-manager.ts with ImAdapter method calls. The ImAdapter is passed as a constructor dependency.

- [ ] **Step 6: Verify build + restart + full regression**

```bash
pnpm build && pnpm daemon:restart
```

Test: new topic, thread reply, repo selection, streaming card, @mention.

- [ ] **Step 7: Commit**

```bash
git add src/im/ src/core/ src/daemon.ts
git commit -m "refactor: extract Lark layer behind ImAdapter interface"
```

---

## Chunk 4: MCP Tools + CoCo + Tmux Stub (Phase 6 & 7)

### Task 16: MCP Tools Use ImAdapter (Phase 6)

**Files:**
- Modify: `src/tools/send-to-thread.ts`
- Modify: `src/tools/get-thread-messages.ts`
- Modify: `src/tools/react-to-message.ts`
- Modify: `src/index.ts` (MCP server entry)

- [ ] **Step 1: Create IM adapter instance and inject into tools**

In `src/index.ts`, instantiate `LarkImAdapter` and pass it to the tool registry:

```typescript
import { LarkImAdapter } from './im/lark/adapter.js';
import { setImAdapter } from './tools/index.js';

const im = new LarkImAdapter({ appId: process.env.LARK_APP_ID!, appSecret: process.env.LARK_APP_SECRET! });
setImAdapter(im);
```

In `src/tools/index.ts`, add a module-level setter so tools can access the adapter:

```typescript
import type { ImAdapter } from '../im/types.js';

let imAdapter: ImAdapter | null = null;

export function setImAdapter(im: ImAdapter): void {
  imAdapter = im;
}

export function getImAdapter(): ImAdapter {
  if (!imAdapter) throw new Error('ImAdapter not initialized — call setImAdapter() first');
  return imAdapter;
}
```

Each tool imports `getImAdapter()` and calls it in its `execute` function.

- [ ] **Step 2: Refactor send-to-thread.ts**

Replace `import { replyMessage } from '../services/lark-client.js'` with ImAdapter call.

The current file contains Lark-specific post formatting (`textToPostContent`, `zh_cn` wrapper, `{ tag: 'at' }` mentions). All this Lark-specific formatting must move into `LarkImAdapter.replyMessage()` — the tool should only pass **plain text** and an optional mention user ID:

```typescript
import { getImAdapter } from './index.js';

// In execute():
const im = getImAdapter();
await im.replyMessage(session.rootMessageId, text, 'rich');
```

Remove `textToPostContent`, `extractTextFromPostJson`, and the `@mention` logic from the tool — these belong in the Lark adapter's `replyMessage` implementation which handles formatting for the specific IM platform.

- [ ] **Step 3: Refactor get-thread-messages.ts**

Replace `import { listThreadMessages }` and `import { parseApiMessage }` with ImAdapter:

```typescript
import { getImAdapter } from './index.js';

// In execute():
const im = getImAdapter();
// getThreadMessages takes rootMessageId as threadId.
// LarkImAdapter.getThreadMessages() internally resolves chatId
// from the rootMessageId (Lark's reply_in_thread API uses parent_id).
const messages = await im.getThreadMessages(session.rootMessageId, limit);
// Returns ImMessage[] directly — no parseApiMessage needed.
```

Remove the `listThreadMessages` and `parseApiMessage` imports.

- [ ] **Step 4: Refactor react-to-message.ts**

Replace `import { addReaction, removeReaction } from '../services/lark-client.js'` with:

```typescript
import { getImAdapter } from './index.js';

// In execute():
const im = getImAdapter();
// Add: returns reactionId
const reactionId = await im.addReaction(messageId, emojiType);
// Remove: uses reactionId (not emojiType) — matches Lark API's im.v1.messageReaction.delete
await im.removeReaction(messageId, reactionId);
```

Note: `addReaction` and `removeReaction` were added to `ImAdapter` in Task 12. `removeReaction` takes `reactionId` (not emoji type) because the underlying API requires it.

- [ ] **Step 5: Verify build + restart + test MCP tools**

```bash
pnpm build && pnpm daemon:restart
```

Test: Claude calling send_to_thread, get_thread_messages, react_to_message.

- [ ] **Step 6: Commit**

```bash
git add src/tools/ src/index.ts
git commit -m "refactor: MCP tools use ImAdapter instead of direct Lark imports"
```

### Task 17: CoCo Full Adapter Verification (Phase 7a)

**Files:**
- Modify: `src/adapters/cli/coco.ts` (if needed)

- [ ] **Step 1: Test CoCo adapter**

Set `CLI_ID=coco` in .env, rebuild, restart. Send a Lark message and observe:
- Does CoCo spawn correctly?
- Does input get submitted?
- Does idle detection work?

- [ ] **Step 2: Fix any issues in coco.ts**

Adjust `buildArgs`, `writeInput`, `completionPattern` based on empirical testing.

- [ ] **Step 3: Commit fixes**

```bash
git add src/adapters/cli/coco.ts
git commit -m "fix: tune CoCo adapter based on testing"
```

### Task 18: TmuxBackend Stub (Phase 7b)

**Files:**
- Create: `src/adapters/backend/tmux-backend.ts`

- [ ] **Step 1: Write TmuxBackend stub**

Create `src/adapters/backend/tmux-backend.ts`:

```typescript
import type { SessionBackend, SpawnOpts } from './types.js';

/**
 * TmuxBackend — experimental session backend using tmux.
 * Enables: physical `tmux attach`, web terminal, and IM all on same session.
 * TODO: Full implementation.
 */
export class TmuxBackend implements SessionBackend {
  private sessionName = '';

  spawn(bin: string, args: string[], opts: SpawnOpts): void {
    throw new Error('TmuxBackend is not yet implemented');
  }

  write(data: string): void {
    throw new Error('TmuxBackend is not yet implemented');
  }

  resize(_cols: number, _rows: number): void {
    // tmux resize is handled by the attaching client
  }

  onData(_cb: (data: string) => void): void {
    throw new Error('TmuxBackend is not yet implemented');
  }

  onExit(_cb: (code: number | null, signal: string | null) => void): void {
    throw new Error('TmuxBackend is not yet implemented');
  }

  kill(): void {
    throw new Error('TmuxBackend is not yet implemented');
  }

  getAttachInfo() {
    return { type: 'tmux' as const, sessionName: this.sessionName };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/adapters/backend/tmux-backend.ts
git commit -m "feat: add TmuxBackend stub"
```

### Task 19: Final Cleanup + Push

- [ ] **Step 1: Remove dead code**

Run these grep commands and fix any remaining references:

```bash
# Should return 0 hits (except config.ts backward-compat if still there):
grep -rn 'config\.daemon\.claudePath' src/ --include='*.ts'

# Should return 0 hits:
grep -rn 'detectCliKind' src/ --include='*.ts'
grep -rn 'writeToPty' src/ --include='*.ts'

# Direct lark-client imports outside im/lark/ should be 0:
grep -rn "from.*services/lark-client" src/ --include='*.ts' | grep -v 'im/lark/'
grep -rn "from.*utils/card-builder" src/ --include='*.ts' | grep -v 'im/lark/'
grep -rn "from.*utils/message-parser" src/ --include='*.ts' | grep -v 'im/lark/'
```

Remove `config.daemon.claudePath` from config.ts if no longer needed.

- [ ] **Step 2: Update .env.example**

Add `CLI_ID` and `BACKEND_TYPE` to `.env.example`.

- [ ] **Step 3: Final build + restart + test**

```bash
pnpm build && pnpm daemon:restart
```

Full regression: new topic, thread reply, repo select, streaming card, @mention, /close, /cost.

- [ ] **Step 4: Push**

```bash
git push
```
