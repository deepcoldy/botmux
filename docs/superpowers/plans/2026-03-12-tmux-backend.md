# TmuxBackend Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement TmuxBackend so CLI sessions survive daemon restarts, with fallback to PtyBackend when tmux is unavailable.

**Architecture:** TmuxBackend wraps node-pty — the pty runs `tmux new-session` (first spawn) or `tmux attach-session` (re-attach). All existing output capture (IdleDetector, TerminalRenderer, WebSocket broadcast) flows through the same pty onData pipeline unchanged. The `kill()` method only detaches the pty viewer; a separate `destroySession()` kills the tmux session (called only on explicit `/close`). Auto-detection: if `tmux` binary is found on `$PATH`, use tmux; otherwise fall back to pty. Override via `BACKEND_TYPE=pty`.

**Tech Stack:** node-pty, tmux 3.x, execSync for tmux CLI commands

**Naming convention:** tmux sessions are named `bmx-<sessionId.slice(0,8)>`, derived deterministically from the session UUID — no extra persistence needed.

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Rewrite | `src/adapters/backend/tmux-backend.ts` | Full TmuxBackend: spawn/attach, write, resize, onData, onExit, kill (detach only), destroySession, static helpers including `sessionName()` |
| Modify | `src/adapters/backend/types.ts:8-16` | Add optional `destroySession?(): void` to SessionBackend interface |
| Modify | `src/worker.ts:22,162-198,420-442` | Backend selection logic in spawnClaude, tmux-aware close/cleanup handlers |
| Modify | `src/config.ts:24` | Auto-detect tmux, default backendType |
| Modify | `src/core/worker-pool.ts:82-93,280-299` | Kill tmux session in `killWorker()`, clean orphaned sessions in `killStalePids` |
| Create | `test/tmux-backend.e2e.ts` | E2E test: spawn in tmux, verify re-attach after pty kill |

---

## Chunk 1: TmuxBackend Core + Interface Change

### Task 1: Add `destroySession` to SessionBackend interface

**Files:**
- Modify: `src/adapters/backend/types.ts:8-16`

- [ ] **Step 1: Add destroySession to interface**

```typescript
export interface SessionBackend {
  spawn(bin: string, args: string[], opts: SpawnOpts): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  kill(): void;
  /** Permanently destroy the backing session (e.g. kill tmux session).
   *  Called only on explicit /close. Default: same as kill(). */
  destroySession?(): void;
  getAttachInfo?(): { type: 'tmux'; sessionName: string } | null;
}
```

- [ ] **Step 2: Verify build passes**

Run: `cd /root/iserver/claude-code-robot && pnpm build`
Expected: PASS (destroySession is optional, existing code doesn't need to implement it)

- [ ] **Step 3: Commit**

```bash
git add src/adapters/backend/types.ts
git commit -m "feat: add optional destroySession to SessionBackend interface"
```

---

### Task 2: Implement TmuxBackend

**Files:**
- Rewrite: `src/adapters/backend/tmux-backend.ts`

- [ ] **Step 1: Write TmuxBackend implementation**

Replace the entire stub with:

```typescript
import * as pty from 'node-pty';
import { execSync } from 'node:child_process';
import type { SessionBackend, SpawnOpts } from './types.js';

/**
 * TmuxBackend — session backend using tmux for process persistence.
 *
 * Architecture: pty-under-tmux.
 *   - A node-pty process runs `tmux new-session` or `tmux attach-session`
 *   - All output flows through the pty (onData/onExit work unchanged)
 *   - kill() only detaches (kills the pty viewer), tmux session survives
 *   - destroySession() kills the tmux session (for explicit /close)
 *
 * Naming: tmux sessions are named `bmx-<sessionId.slice(0,8)>`.
 */
export class TmuxBackend implements SessionBackend {
  private process: pty.IPty | null = null;
  private readonly sessionName: string;
  private reattaching = false;

  constructor(sessionName: string) {
    this.sessionName = sessionName;
  }

  // ─── Static helpers ───────────────────────────────────────────────────────

  /** Check if tmux binary is available on PATH. */
  static isAvailable(): boolean {
    try {
      execSync('tmux -V', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /** Check if a named tmux session exists. */
  static hasSession(name: string): boolean {
    try {
      execSync(`tmux has-session -t ${shellescape(name)}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /** Kill a named tmux session (no-op if it doesn't exist). */
  static killSession(name: string): void {
    try {
      execSync(`tmux kill-session -t ${shellescape(name)}`, { stdio: 'ignore' });
    } catch { /* session doesn't exist */ }
  }

  /** Derive tmux session name from a session UUID. */
  static sessionName(sessionId: string): string {
    return `bmx-${sessionId.slice(0, 8)}`;
  }

  /** List all botmux tmux sessions (bmx-* prefix). */
  static listBotmuxSessions(): string[] {
    try {
      const out = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null", {
        encoding: 'utf-8',
      });
      return out.split('\n').filter(s => s.startsWith('bmx-'));
    } catch {
      return [];
    }
  }

  // ─── SessionBackend implementation ────────────────────────────────────────

  spawn(bin: string, args: string[], opts: SpawnOpts): void {
    this.reattaching = TmuxBackend.hasSession(this.sessionName);

    if (this.reattaching) {
      // Re-attach to surviving tmux session (CLI is still running)
      this.process = pty.spawn('tmux', ['attach-session', '-t', this.sessionName], {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: opts.env,
      });
    } else {
      // Create new tmux session running the CLI command
      const tmuxArgs = [
        'new-session',
        '-s', this.sessionName,
        '-x', String(opts.cols),
        '-y', String(opts.rows),
        '--', bin, ...args,
      ];
      this.process = pty.spawn('tmux', tmuxArgs, {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: opts.env,
      });
    }
  }

  /** Whether the last spawn() re-attached to an existing tmux session. */
  get isReattach(): boolean {
    return this.reattaching;
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

  /** Detach only — kills the pty viewer but leaves tmux session alive. */
  kill(): void {
    if (this.process) {
      try { this.process.kill(); } catch { /* already dead */ }
      this.process = null;
    }
  }

  /** Kill the tmux session permanently. Called on explicit /close. */
  destroySession(): void {
    this.kill();
    TmuxBackend.killSession(this.sessionName);
  }

  getAttachInfo() {
    return { type: 'tmux' as const, sessionName: this.sessionName };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal shell-escape for tmux session names (alphanumeric + dash). */
function shellescape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
```

- [ ] **Step 2: Verify build passes**

Run: `cd /root/iserver/claude-code-robot && pnpm build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/adapters/backend/tmux-backend.ts
git commit -m "feat: implement TmuxBackend with pty-under-tmux architecture"
```

---

## Chunk 2: Config Auto-Detection + Worker Integration

### Task 3: Auto-detect tmux in config

**Files:**
- Modify: `src/config.ts:24`

- [ ] **Step 1: Add tmux auto-detection**

Replace the `backendType` line in `config.ts`:

```typescript
// Old:
backendType: (process.env.BACKEND_TYPE ?? 'pty') as 'pty' | 'tmux',

// New:
backendType: (process.env.BACKEND_TYPE ?? detectDefaultBackend()) as 'pty' | 'tmux',
```

Add the detection function before `export const config`:

```typescript
import { execSync } from 'node:child_process';

function detectDefaultBackend(): 'pty' | 'tmux' {
  try {
    execSync('tmux -V', { stdio: 'ignore' });
    return 'tmux';
  } catch {
    return 'pty';
  }
}
```

- [ ] **Step 2: Verify build passes**

Run: `cd /root/iserver/claude-code-robot && pnpm build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: auto-detect tmux availability for default backend"
```

---

### Task 4: Worker backend selection and tmux-aware lifecycle

**Files:**
- Modify: `src/worker.ts:22,162-198,420-442`

This is the most critical task. The worker needs to:
1. Select PtyBackend or TmuxBackend based on init config
2. Derive tmux session name from sessionId
3. On close: call `destroySession()` to kill tmux session
4. On SIGTERM/SIGINT/disconnect: call `kill()` only (tmux survives)
5. Skip `awaitingFirstPrompt` suppression on re-attach (CLI is already running)

- [ ] **Step 1: Add TmuxBackend import and session name helper**

At the top of worker.ts, add the import (after the PtyBackend import):

```typescript
import { TmuxBackend } from './adapters/backend/tmux-backend.js';
```

- [ ] **Step 2: Modify spawnClaude to select backend**

Replace the backend creation in `spawnClaude()` — change:

```typescript
function spawnClaude(cfg: Extract<DaemonToWorker, { type: 'init' }>): void {
  cliAdapter = createCliAdapterSync(cfg.cliId as any, cfg.cliPathOverride);
  backend = new PtyBackend();
```

To:

```typescript
function spawnClaude(cfg: Extract<DaemonToWorker, { type: 'init' }>): void {
  cliAdapter = createCliAdapterSync(cfg.cliId as any, cfg.cliPathOverride);
  const useTmux = cfg.backendType === 'tmux';
  const tmuxBe = useTmux ? new TmuxBackend(TmuxBackend.sessionName(cfg.sessionId)) : null;
  backend = tmuxBe ?? new PtyBackend();
```

After `backend.spawn(...)` and before setting up idle detection, add re-attach handling:

```typescript
  // On tmux re-attach, CLI is already running — don't suppress first prompt
  if (tmuxBe?.isReattach) {
    awaitingFirstPrompt = false;
    log('Re-attached to existing tmux session');
  }
```

- [ ] **Step 3: Modify close handler to destroy tmux session**

In the IPC message handler, change the 'close' case:

```typescript
    case 'close': {
      log('Close requested');
      // destroySession kills tmux session permanently; kill() only detaches
      backend?.destroySession?.();
      killClaude();
      cleanup();
      process.exit(0);
    }
```

- [ ] **Step 4: Modify SIGTERM/SIGINT/disconnect to preserve tmux**

Replace the three signal/disconnect handlers at the bottom of worker.ts:

```typescript
process.on('SIGTERM', () => { killClaude(); cleanup(); process.exit(0); });
process.on('SIGINT', () => { killClaude(); cleanup(); process.exit(0); });
process.on('disconnect', () => { log('Daemon disconnected'); killClaude(); cleanup(); process.exit(0); });
```

Note: `killClaude()` calls `backend.kill()` which for TmuxBackend only detaches. The tmux session survives. This is the desired behavior — daemon restart preserves the CLI.

No changes needed to these handlers; the TmuxBackend.kill() already does the right thing (detach only). The existing code is correct.

- [ ] **Step 5: Verify build passes**

Run: `cd /root/iserver/claude-code-robot && pnpm build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/worker.ts
git commit -m "feat: worker selects TmuxBackend when configured, tmux-aware lifecycle"
```

---

## Chunk 3: Stale Tmux Cleanup + E2E Test

### Task 5: Tmux cleanup in killWorker + orphaned session cleanup

**Files:**
- Modify: `src/core/worker-pool.ts:82-93,280-299`

Two fixes:
1. `killWorker()` must also kill the tmux session — if the worker is already dead, the IPC `close` message never reaches it, leaving the tmux session orphaned.
2. `killStalePids()` cleans orphaned `bmx-*` tmux sessions on daemon restart.

- [ ] **Step 1: Add TmuxBackend import**

Add import at top of worker-pool.ts:

```typescript
import { TmuxBackend } from '../adapters/backend/tmux-backend.js';
```

- [ ] **Step 2: Add tmux cleanup to killWorker**

In `killWorker()`, add tmux session cleanup after the existing worker kill logic:

```typescript
export function killWorker(ds: DaemonSession): void {
  if (!ds.worker || ds.worker.killed) return;
  try {
    ds.worker.send({ type: 'close' } as DaemonToWorker);
  } catch { /* IPC already closed */ }
  // Give worker 2s to clean up, then force kill
  const w = ds.worker;
  setTimeout(() => { if (!w.killed) w.kill('SIGTERM'); }, 2000);
  ds.worker = null;
  ds.workerPort = null;
  ds.workerToken = null;

  // Also kill tmux session directly as a safety net:
  // if worker is dead or doesn't handle 'close' in time, this ensures cleanup.
  if (config.daemon.backendType === 'tmux') {
    TmuxBackend.killSession(TmuxBackend.sessionName(ds.session.sessionId));
  }
}
```

- [ ] **Step 3: Add tmux cleanup to killStalePids**

Add tmux cleanup at the end of `killStalePids`:

```typescript
export function killStalePids(activeSessions_: Session[]): void {
  // ... existing PID cleanup code ...

  // Clean orphaned tmux sessions: kill bmx-* sessions not in active set
  if (config.daemon.backendType === 'tmux') {
    const activeNames = new Set(
      activeSessions_.map(s => TmuxBackend.sessionName(s.sessionId)),
    );
    for (const name of TmuxBackend.listBotmuxSessions()) {
      if (!activeNames.has(name)) {
        logger.info(`Killing orphaned tmux session: ${name}`);
        TmuxBackend.killSession(name);
      }
    }
  }
}
```

- [ ] **Step 4: Verify build passes**

Run: `cd /root/iserver/claude-code-robot && pnpm build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/worker-pool.ts
git commit -m "feat: kill tmux sessions in killWorker and clean orphans on restore"
```

---

### Task 6: E2E test — tmux backend spawn and re-attach

**Files:**
- Create: `test/tmux-backend.e2e.ts`

- [ ] **Step 1: Write E2E test**

```typescript
/**
 * E2E test: TmuxBackend spawn, output capture, detach, and re-attach.
 *
 * Verifies:
 * 1. TmuxBackend.spawn() creates a tmux session and captures output via pty
 * 2. kill() detaches without destroying the tmux session
 * 3. A second TmuxBackend with the same name re-attaches and captures output
 * 4. destroySession() kills the tmux session
 *
 * Requires: tmux installed (skips if not available)
 * Run: pnpm vitest run test/tmux-backend.e2e.ts
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';

const TEST_SESSION = 'bmx-test0001';
const TEST_TIMEOUT = 15_000;

describe('TmuxBackend', () => {
  beforeEach(() => {
    // Ensure clean state
    TmuxBackend.killSession(TEST_SESSION);
  });

  afterEach(() => {
    // Cleanup
    TmuxBackend.killSession(TEST_SESSION);
  });

  it.skipIf(!TmuxBackend.isAvailable())('spawn creates tmux session and captures output', async () => {
    const backend = new TmuxBackend(TEST_SESSION);
    const output: string[] = [];

    // Spawn a simple command that outputs something and stays alive
    backend.spawn('/bin/bash', ['-c', 'echo HELLO_TMUX && sleep 60'], {
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: { ...process.env } as Record<string, string>,
    });

    backend.onData((data) => output.push(data));

    // Wait for output
    await waitFor(() => output.join('').includes('HELLO_TMUX'), 5000);
    expect(output.join('')).toContain('HELLO_TMUX');

    // Tmux session should exist
    expect(TmuxBackend.hasSession(TEST_SESSION)).toBe(true);
    expect(backend.isReattach).toBe(false);

    // Detach (kill pty viewer, tmux survives)
    backend.kill();
    expect(TmuxBackend.hasSession(TEST_SESSION)).toBe(true);
  }, TEST_TIMEOUT);

  it.skipIf(!TmuxBackend.isAvailable())('re-attach captures output from surviving session', async () => {
    // Phase 1: Create session
    const be1 = new TmuxBackend(TEST_SESSION);
    be1.spawn('/bin/bash', ['-c', 'echo PHASE1 && sleep 60'], {
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: { ...process.env } as Record<string, string>,
    });

    const out1: string[] = [];
    be1.onData((data) => out1.push(data));
    await waitFor(() => out1.join('').includes('PHASE1'), 5000);

    // Detach
    be1.kill();
    expect(TmuxBackend.hasSession(TEST_SESSION)).toBe(true);

    // Phase 2: Re-attach
    const be2 = new TmuxBackend(TEST_SESSION);
    const out2: string[] = [];

    // spawn() with same name → should attach, not create
    be2.spawn('/bin/bash', ['-c', 'echo SHOULD_NOT_RUN'], {
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: { ...process.env } as Record<string, string>,
    });

    be2.onData((data) => out2.push(data));
    expect(be2.isReattach).toBe(true);

    // Wait for tmux to replay screen content (PHASE1 should be visible)
    await waitFor(() => out2.join('').length > 0, 5000);

    // Should NOT contain SHOULD_NOT_RUN (bin/args are ignored on re-attach)
    expect(out2.join('')).not.toContain('SHOULD_NOT_RUN');

    // destroySession kills tmux
    be2.destroySession();
    expect(TmuxBackend.hasSession(TEST_SESSION)).toBe(false);
  }, TEST_TIMEOUT);

  it.skipIf(!TmuxBackend.isAvailable())('destroySession kills tmux session', () => {
    const backend = new TmuxBackend(TEST_SESSION);
    backend.spawn('/bin/bash', ['-c', 'sleep 60'], {
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: { ...process.env } as Record<string, string>,
    });
    expect(TmuxBackend.hasSession(TEST_SESSION)).toBe(true);

    backend.destroySession();
    expect(TmuxBackend.hasSession(TEST_SESSION)).toBe(false);
  }, TEST_TIMEOUT);

  it.skipIf(!TmuxBackend.isAvailable())('listBotmuxSessions returns bmx- sessions', () => {
    const backend = new TmuxBackend(TEST_SESSION);
    backend.spawn('/bin/bash', ['-c', 'sleep 60'], {
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: { ...process.env } as Record<string, string>,
    });

    const sessions = TmuxBackend.listBotmuxSessions();
    expect(sessions).toContain(TEST_SESSION);

    backend.destroySession();
  }, TEST_TIMEOUT);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(check, 100);
    };
    check();
  });
}
```

- [ ] **Step 2: Run the test**

Run: `cd /root/iserver/claude-code-robot && pnpm vitest run test/tmux-backend.e2e.ts`
Expected: All 4 tests PASS (or skip if tmux not available)

- [ ] **Step 3: Commit**

```bash
git add test/tmux-backend.e2e.ts
git commit -m "test: add E2E tests for TmuxBackend spawn, re-attach, and cleanup"
```

---

### Task 7: Manual integration test

- [ ] **Step 1: Build**

```bash
cd /root/iserver/claude-code-robot && pnpm build
```

- [ ] **Step 2: Verify auto-detection works**

```bash
# Should show 'tmux' since tmux is installed
node -e "import('./dist/config.js').then(m => console.log('backendType:', m.config.daemon.backendType))"
```

Expected: `backendType: tmux`

- [ ] **Step 3: Verify BACKEND_TYPE=pty override works**

```bash
BACKEND_TYPE=pty node -e "import('./dist/config.js').then(m => console.log('backendType:', m.config.daemon.backendType))"
```

Expected: `backendType: pty`

- [ ] **Step 4: Start daemon and test tmux persistence**

```bash
# Start daemon
pnpm daemon:start

# Send a message in Lark to create a session
# Check tmux sessions:
tmux list-sessions | grep bmx-

# Restart daemon (simulating deploy):
pnpm daemon:restart

# Verify tmux session survived:
tmux list-sessions | grep bmx-

# Send another message in same thread — should re-attach, not create new CLI
# Check logs for "Re-attached to existing tmux session":
pnpm daemon:logs --lines 50
```

- [ ] **Step 5: Test manual attach**

```bash
# List sessions
tmux list-sessions | grep bmx-

# Attach to a session to observe CLI in real time
tmux attach -t bmx-<first-8-chars>

# Detach with Ctrl+B, D — session continues
```

- [ ] **Step 6: Test /close cleanup**

```
# In Lark, send /close to the topic thread
# Verify tmux session is gone:
tmux list-sessions | grep bmx-
```
