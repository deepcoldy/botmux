/**
 * Unit tests for TmuxPipeBackend.
 *
 * Verifies:
 *   - spawn() creates a fifo, opens it for read, then issues `tmux pipe-pane`
 *   - send-keys / paste-buffer / copy-mode all address the REAL pane target
 *     (the bug we keep guarding against — using a synthetic session name
 *     here would silently route input to whichever pane tmux has active)
 *   - kill() cancels the pipe-pane subscription with `tmux pipe-pane`
 *     (no command argument = turn off) and unlinks the fifo
 *   - getChildPid resolves through display-message, not list-panes
 *   - captureCurrentScreen issues capture-pane -e -p -S -
 */
// Must stay the first import: this file fakes node:fs, so refuse to run outside
// the data-dir fence instead of touching live botmux data (see the helper).
import './helpers/require-fenced-data-dir.js';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Factories use a synchronous `require`, never `await vi.importActual(...)`: bun's `vi`
// shim has no `importActual`, and a fill that resolved without loading the module would
// silently un-mock. The real module is SPREAD IN because bun links named exports for
// real — a factory returning only the overridden keys fails the whole file with
// "Export named 'X' not found in module '…'" (measured: `fork`, pulled in by
// src/core/self-spawn.ts on the transitive graph). vitest performs no such check.
vi.mock('node:child_process', () => {
  const actual = require('node:child_process') as typeof import('node:child_process');
  return {
    ...actual,
    execSync: vi.fn(),
    execFile: vi.fn(),
    execFileSync: vi.fn(),
    spawnSync: vi.fn(),
  };
});

// This file mocks node:child_process, so the anti-fork gate's darwin lsof
// census would get null (spawnSync mocked) and fail closed for the full 8 s
// budget on every spawn (Linux reads /proc and is unaffected). The gate is
// unit-tested separately; here default it to a pass-through, and override it
// per-case (mockedLeadingArgs) for the two wiring tests below. vi.hoisted
// keeps the mock fn alive when the factory is hoisted above the import.
const { mockedLeadingArgs } = vi.hoisted(() => ({
  mockedLeadingArgs: vi.fn((): string[] => []),
}));
vi.mock('../src/adapters/backend/tmux-anti-fork.js', () => ({
  createTmuxBootGate: vi.fn(() => ({ leadingArgs: () => mockedLeadingArgs() })),
  TmuxCompetingServerBlockedError: class TmuxCompetingServerBlockedError extends Error {
    code = 'ETIMEDOUT';
    constructor(label: string) { super(`blocked ${label}`); this.name = 'TmuxCompetingServerBlockedError'; }
  },
}));

vi.mock('node:fs', () => {
  const actual: any = require('node:fs');
  return {
    ...actual,
    openSync: vi.fn(() => 7),
    createReadStream: vi.fn(() => {
      const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
      return {
        on(event: string, cb: (...args: unknown[]) => void) {
          handlers[event] ??= [];
          handlers[event].push(cb);
          return this;
        },
        emit(event: string, ...args: unknown[]) { for (const cb of handlers[event] ?? []) cb(...args); },
        destroy: vi.fn(),
      };
    }),
    unlinkSync: vi.fn(),
    // openSync returns fake descriptors, so teardown must never write/close
    // those numbers in the real test process.
    closeSync: vi.fn(),
    writeSync: vi.fn(),
    constants: actual.constants,
  };
});

import { execSync, execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { unlinkSync, createReadStream, openSync, closeSync, writeSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import {
  TmuxPipeBackend,
  normaliseCaptureLineEndings,
  tmuxLifecycleInitialDelayMs,
  tmuxLifecycleIdleProbeMs,
  lifecycleProbeDelayMs,
  LIFECYCLE_ACTIVE_PROBE_MS,
  LIFECYCLE_ACTIVITY_WINDOW_MS,
  LIFECYCLE_OUTPUT_ACTIVITY_WINDOW_MS,
  LIFECYCLE_IDLE_PROBE_MAX_MS,
  setStartupTmuxRetrySleepForTests,
  buildPipePaneStartupError,
  __testOnly_liveFifoReaderCount,
  resolveReportedExitCode,
  literalSendKeysArgs,
} from '../src/adapters/backend/tmux-pipe-backend.js';
import { pipePaneShellCommand } from '../src/adapters/backend/tmux-pipe-relay.js';
import { resetTmuxVersionCacheForTests, getTmuxVersionCached } from '../src/setup/ensure-tmux.js';
import { bufferSpawnResult } from './helpers/spawn-result.js';
import { takePaneLaunchFile } from './helpers/pane-launch.js';
import { TmuxCommandTooLongError } from '../src/adapters/backend/pane-launch.js';
import { isTransientStartupFailure } from '../src/core/worker-startup-retry.js';
import {
  CONNECTION_REFUSED, DEADLINE, EMFILE, LOST_SERVER, NO_SERVER,
  createTmuxWorld, installTmuxWorld, isLivenessRead, type TmuxWorld,
} from './helpers/tmux-world.js';

// Startup retries sleep synchronously (Atomics.wait — immune to fake timers);
// stub the sleep for the whole suite so retry tests don't add real seconds.
setStartupTmuxRetrySleepForTests(() => {});

const mockedExecSync = vi.mocked(execSync);
const mockedExecFileSync = vi.mocked(execFileSync);
const mockedSpawnSync = vi.mocked(spawnSync);
const mockedUnlinkSync = vi.mocked(unlinkSync);
const mockedOpenSync = vi.mocked(openSync);
const mockedCloseSync = vi.mocked(closeSync);
const mockedWriteSync = vi.mocked(writeSync);

type FakeShell = {
  readonly dir: string;
  readonly path: string;
};

function createFakeShell(name: 'fish'): FakeShell {
  const dir = mkdtempSync(join(tmpdir(), 'bmx-fake-shell-'));
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nexec "$@"\n');
  chmodSync(path, 0o755);
  return { dir, path };
}

function cleanupFakeShell(shell: FakeShell): void {
  rmSync(shell.dir, { recursive: true, force: true });
}

/** The paste-buffer argv a tmux batch carries: as a plain command, or as the
 *  dead-pane-guarded if-shell branch (a tmux-quoted command string). */
function pasteBufferArgv(args: readonly string[]): string[] | null {
  const plain = args.indexOf('paste-buffer');
  if (plain >= 0) return args.slice(plain);
  const branch = args.find(arg => arg.startsWith('"paste-buffer"'));
  return branch
    ? [...branch.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1].replace(/\\(.)/g, '$1'))
    : null;
}

function getExecFileCalls() {
  return mockedExecFileSync.mock.calls
    .filter(call => !(call[1] as string[]).includes('display-message'));
}

// tmux is mocked, so no pane shell ever reads (and deletes) a launch file.
const paneLaunchRoot = mkdtempSync(join(tmpdir(), 'bmx-pipe-launch-'));
afterAll(() => rmSync(paneLaunchRoot, { recursive: true, force: true }));

function spawnOpts() {
  return {
    cwd: '/tmp',
    cols: 200,
    rows: 50,
    env: process.env as Record<string, string>,
    paneLaunchDir: paneLaunchRoot,
  };
}

function newSessionArgs(): string[] {
  const call = mockedExecFileSync.mock.calls.find(([_, args]) => {
    return Array.isArray(args) && args.includes('new-session');
  });
  if (!call) throw new Error('expected tmux new-session call');
  return call[1] as string[];
}

function scriptIndex(args: readonly string[]): number {
  const index = args.indexOf('-c');
  if (index < 0) throw new Error('expected shell -c script in argv');
  return index;
}

/** Emulate tmux executing the queued subscription after printing the new
 * session's identity. Keep the existing pipe failure injections applicable to
 * both the creating queue and later standalone subscription retries. */
function emulateQueuedSubscription(): void {
  const implementation = mockedExecFileSync.getMockImplementation()!;
  mockedExecFileSync.mockImplementation(((...params: unknown[]) => {
    const result = Reflect.apply(implementation, undefined, params);
    const argv = params[1] as string[];
    if (!Array.isArray(argv) || !argv.includes('new-session')) return result;
    const subscription = argv.slice(argv.lastIndexOf(';') + 1);
    if (!['if-shell', 'pipe-pane'].includes(subscription[0]!)) return result;
    const command = subscription.map((arg, i) => i === 0 || arg.startsWith('-')
      ? arg : `'${arg.replace(/'/g, "'\\''")}'`).join(' ');
    const identity = String(result).trim() || '1234 $7 5678';
    try {
      return Buffer.from(`${identity}\n${String(mockedExecSync(`tmux ${command}`))}`);
    } catch (err) {
      throw Object.assign(err as Error, { stdout: Buffer.from(`${identity}\n`) });
    }
  }) as typeof execFileSync);
}

beforeEach(() => {
  mockedExecSync.mockReset();
  mockedExecFileSync.mockReset();
  vi.mocked(execFile).mockReset();
  mockedSpawnSync.mockReset();
  mockedUnlinkSync.mockReset();
  mockedOpenSync.mockReset().mockReturnValue(7);
  mockedCloseSync.mockReset();
  mockedWriteSync.mockReset();
  mockedExecSync.mockReturnValue(Buffer.from('') as any);
  mockedSpawnSync.mockReturnValue(bufferSpawnResult({ status: 0 }));
  // Default emulation is a modern tmux (dev/CI box): `tmux -V` answers 3.3a,
  // so version-gated options (new-session -e, remain-on-exit failed) are
  // emitted. Tests that exercise OLD tmux behaviour override this with
  // emulateTmux()/their own mockImplementation.
  mockedExecFileSync.mockImplementation(((_bin: unknown, args: string[]) => {
    if (Array.isArray(args) && args[0] === '-V') return 'tmux 3.3a';
    return Buffer.from('') as any;
  }) as typeof execFileSync);
  resetTmuxVersionCacheForTests();
});

describe('TmuxPipeBackend.spawn', () => {
  it('removes the FIFO and creates no session if opening its read end fails', () => {
    mockedOpenSync.mockImplementationOnce(() => { throw new Error('EACCES: FIFO read denied'); });
    const be = new TmuxPipeBackend('bmx-no-reader', { createSession: true, ownsSession: true });
    const readersBefore = __testOnly_liveFifoReaderCount();
    expect(() => be.spawn('/bin/sh', [], spawnOpts())).toThrow(/EACCES/);
    expect(mockedUnlinkSync).toHaveBeenCalledWith(expect.stringMatching(/botmux-pipe-.*\.fifo$/));
    expect(__testOnly_liveFifoReaderCount()).toBe(readersBefore);
    expect(mockedExecFileSync.mock.calls.some(([, args]) => (args as string[]).includes('new-session'))).toBe(false);
    expect(be.retireSessionCreatedBySpawn()).toBe(false);
  });

  it.each([
    { status: 1, stderr: Buffer.from('mkfifo: No space left on device') },
    { status: null, error: new Error('spawn mkfifo ENOENT') },
  ])('preserves FIFO creation failure before opening or subscribing', (failure) => {
    mockedSpawnSync.mockReturnValueOnce(bufferSpawnResult(failure));
    vi.mocked(openSync).mockClear();
    const be = new TmuxPipeBackend('0:2.0');
    expect(() => be.spawn('', [], spawnOpts())).toThrow(/Could not create tmux FIFO.*(No space left|ENOENT)/);
    expect(openSync).not.toHaveBeenCalled();
    expect(mockedExecSync.mock.calls.some(call => String(call[0]).includes('pipe-pane'))).toBe(false);
  });

  it('mkfifo + opens read fd + issues tmux pipe-pane to that fifo', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());

    // Step 1: mkfifo via spawnSync
    expect(mockedSpawnSync).toHaveBeenCalledWith('mkfifo', expect.arrayContaining([expect.stringMatching(/botmux-pipe-/)]), expect.any(Object));

    // Step 2: subscribe a copier that writes into the fifo.
    const pipeCalls = mockedExecSync.mock.calls
      .map(c => String(c[0]))
      .filter(c => c.includes('pipe-pane'));
    expect(pipeCalls.length).toBe(1);
    expect(pipeCalls[0]).toContain('-O');
    expect(pipeCalls[0]).toContain("'0:2.0'");
    expect(pipeCalls[0]).toMatch(/exec >.*botmux-pipe-.*\.fifo/);
  });

  it('retries pipe-pane after a transient connect failure instead of failing the session start', () => {
    // Startup herd after an outage: the first pipe-pane routinely eats an
    // instant ECONNREFUSED from the stalled shared server. One spaced retry
    // must recover instead of surfacing "会话启动失败" to the chat.
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      let pipeAttempts = 0;
      mockedExecSync.mockImplementation(((cmd: any) => {
        if (String(cmd).includes('pipe-pane')) {
          pipeAttempts += 1;
          if (pipeAttempts === 1) {
            throw Object.assign(new Error('cmd failed'), {
              status: 1,
              signal: null,
              stderr: Buffer.from('error connecting to /tmp/tmux-0/default (Connection refused)'),
            });
          }
        }
        return Buffer.from('') as any;
      }) as any);

      const be = new TmuxPipeBackend('0:2.0');
      const exits: unknown[] = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      expect(() => be.spawn('', [], spawnOpts())).not.toThrow();

      expect(pipeAttempts).toBe(2);
      expect(exits).toEqual([]);
      expect(errSpy.mock.calls.some(call => String(call[0]).includes('pipe-pane attach failed'))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('throws but does NOT fire an exit when pipe-pane keeps failing (startup failure, not a crash)', () => {
    emulateQueuedSubscription();
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      let pipeAttempts = 0;
      mockedExecSync.mockImplementation(((cmd: any) => {
        if (String(cmd).includes('pipe-pane')) {
          pipeAttempts += 1;
          throw Object.assign(new Error('cmd failed'), {
            status: 1,
            signal: null,
            stderr: Buffer.from('error connecting to /tmp/tmux-0/default (Connection refused)'),
          });
        }
        return Buffer.from('') as any;
      }) as any);

      const be = new TmuxPipeBackend('0:2.0', { createSession: true, ownsSession: true });
      const exits: unknown[] = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      expect(() => be.spawn('', [], spawnOpts())).toThrow();

      expect(pipeAttempts).toBe(3);            // initial + 2 retries
      // Startup failure: spawn throws and NO process-exit event is emitted —
      // a tmux stall must not be reported as a crashed CLI (code 1) and feed
      // the crash-restart channel (#2408). The throw carries the startup error.
      expect(exits).toEqual([]);
    } finally {
      errSpy.mockRestore();
    }
  });

  // Worker ordering: backend.onExit is wired only AFTER a successful spawn.
  // The failed-spawn path therefore must not leave a sticky phantom exit code
  // cached that a later onExit would replay — that used to mislabel a tmux
  // stall as a crashed CLI once fireExit became sticky (#2408).
  it('a failed spawn leaves no sticky exit for an onExit registered afterwards', () => {
    emulateQueuedSubscription();
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      mockedExecSync.mockImplementation(((cmd: any) => {
        if (String(cmd).includes('pipe-pane')) {
          throw Object.assign(new Error('cmd failed'), {
            status: 1, signal: null,
            stderr: Buffer.from('error connecting to /tmp/tmux-0/default (Connection refused)'),
          });
        }
        return Buffer.from('') as any;
      }) as any);

      // FRESH create: a startup failure leaves no sticky phantom exit.
      const be = new TmuxPipeBackend('0:2.0', { createSession: true, ownsSession: true });
      expect(() => be.spawn('', [], spawnOpts())).toThrow();
      const exits: unknown[] = [];
      be.onExit((code, signal) => exits.push([code, signal])); // worker wires this only now
      expect(exits).toEqual([]);
    } finally {
      errSpy.mockRestore();
    }
  });

  // Biased reattach path (createSession: false): we are attaching to a pane
  // that was expected to already exist. If pipe-pane finds it gone, that is a
  // lost SESSION (not a failed fresh startup), so the backend reports exit 1
  // so the worker recovers — the pre-#2408 contract that must be kept.
  it('fires exit 1 (and throws) when a biased reattach pipe-pane finds the pane gone', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      mockedExecSync.mockImplementation(((cmd: any) => {
        if (String(cmd).includes('pipe-pane')) {
          throw Object.assign(new Error('cmd failed'), {
            status: 1, signal: null,
            stderr: Buffer.from("can't find pane: 0:2.0"),
          });
        }
        return Buffer.from('') as any;
      }) as any);

      const be = new TmuxPipeBackend('0:2.0', { ownsSession: true, isReattach: true });
      const exits: unknown[] = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      expect(() => be.spawn('', [], { ...spawnOpts(), strictEnvReattach: true })).toThrow();
      expect(exits).toEqual([[1, null]]);
    } finally {
      errSpy.mockRestore();
    }
  });

  // Worker ordering on the reattach path: even though onExit is wired only
  // after spawn (which throws), the sticky exit must NOT be delivered there
  // for a fresh create — but for a reattach it is a genuine loss. This test
  // pins that a fresh failed spawn (no new-session) never caches a phantom.
  it('reattach-pane-gone caches exit 1 for an onExit wired after spawn, fresh does not', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      mockedExecSync.mockImplementation(((cmd: any) => {
        if (String(cmd).includes('pipe-pane')) {
          throw Object.assign(new Error('cmd failed'), {
            status: 1, signal: null,
            stderr: Buffer.from("can't find pane: 0:2.0"),
          });
        }
        return Buffer.from('') as any;
      }) as any);

      const reattach = new TmuxPipeBackend('0:2.0', { ownsSession: true, isReattach: true });
      expect(() => reattach.spawn('', [], { ...spawnOpts(), strictEnvReattach: true })).toThrow();
      const rExits: unknown[] = [];
      reattach.onExit((code, signal) => rExits.push([code, signal]));
      expect(rExits).toEqual([[1, null]]); // genuine reattach loss replays
    } finally {
      errSpy.mockRestore();
    }
  });

  it('fails pipe-pane FAST on a server-answered deterministic rejection (pane genuinely gone)', () => {
    emulateQueuedSubscription();
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      let pipeAttempts = 0;
      mockedExecSync.mockImplementation(((cmd: any) => {
        if (String(cmd).includes('pipe-pane')) {
          pipeAttempts += 1;
          throw Object.assign(new Error('cmd failed'), {
            status: 1,
            signal: null,
            stderr: Buffer.from("can't find pane: 0:2.0"),
          });
        }
        return Buffer.from('') as any;
      }) as any);

      // FRESH create: deterministic "pane gone" during startup throws and
      // emits no process-exit event.
      const be = new TmuxPipeBackend('0:2.0', { createSession: true, ownsSession: true });
      const exits: unknown[] = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      expect(() => be.spawn('', [], spawnOpts())).toThrow();

      expect(pipeAttempts).toBe(1);            // no pointless retries
      // Same for a deterministic rejection: it is a startup failure (throws),
      // never a process-exit event (#2408).
      expect(exits).toEqual([]);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('retries new-session on a connect failure and treats duplicate-session-on-retry as success', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      let newSessionAttempts = 0;
      mockedExecFileSync.mockImplementation(((_bin: any, args: any) => {
        if (Array.isArray(args) && args.includes('new-session')) {
          newSessionAttempts += 1;
          if (newSessionAttempts === 1) {
            // Timed-out first attempt: the client was killed but the server may
            // have created the session anyway.
            throw Object.assign(new Error('timed out'), { status: null, signal: 'SIGTERM', killed: true });
          }
          // Retry discovers the session DOES exist server-side.
          throw Object.assign(new Error('cmd failed'), {
            status: 1,
            signal: null,
            stderr: Buffer.from('duplicate session: bmx-owned'),
          });
        }
        return '' as any;
      }) as any);

      const be = new TmuxPipeBackend('bmx-owned', { createSession: true, ownsSession: true });
      expect(() => be.spawn('echo', [], spawnOpts())).not.toThrow();
      expect(newSessionAttempts).toBe(2);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('treats a deadline that raced a clean exit (ETIMEDOUT + numeric status) as retryable — 2026-08-23 regression', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      let newSessionAttempts = 0;
      mockedExecFileSync.mockImplementation(((_bin: any, args: any) => {
        if (Array.isArray(args) && args.includes('new-session')) {
          newSessionAttempts += 1;
          if (newSessionAttempts === 1) {
            // The exact 08-23 storm shape: the overloaded client finished and
            // exited CLEANLY (numeric status, no signal, empty stderr) in the
            // same window the exec deadline fired, so Node attached BOTH the
            // clean exit and the ETIMEDOUT error. The server had actually
            // created the session. The old classifier read "clean numeric exit
            // ⇒ deterministic rejection" and killed the launch user-visibly.
            throw Object.assign(new Error('spawnSync tmux ETIMEDOUT'), {
              code: 'ETIMEDOUT',
              errno: -110,
              syscall: 'spawnSync tmux',
              status: 0,
              signal: null,
              stderr: Buffer.from(''),
            });
          }
          // Retry discovers the session DOES exist server-side → success.
          throw Object.assign(new Error('cmd failed'), {
            status: 1,
            signal: null,
            stderr: Buffer.from('duplicate session: bmx-owned'),
          });
        }
        return '' as any;
      }) as any);

      const be = new TmuxPipeBackend('bmx-owned', { createSession: true, ownsSession: true });
      expect(() => be.spawn('echo', [], spawnOpts())).not.toThrow();
      expect(newSessionAttempts).toBe(2);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('does NOT retry new-session on a server-answered deterministic rejection', () => {
    let newSessionAttempts = 0;
    mockedExecFileSync.mockImplementation(((_bin: any, args: any) => {
      if (Array.isArray(args) && args.includes('new-session')) {
        newSessionAttempts += 1;
        throw Object.assign(new Error('cmd failed'), {
          status: 1,
          signal: null,
          stderr: Buffer.from('usage: new-session [...]'),
        });
      }
      return '' as any;
    }) as any);

    const be = new TmuxPipeBackend('bmx-owned', { createSession: true, ownsSession: true });
    expect(() => be.spawn('echo', [], spawnOpts())).toThrow();
    expect(newSessionAttempts).toBe(1);
  });

  it.each(['binding-a', 'binding-b', ''])('checks the actual identity before adopting a duplicate on startup retry: %s', actual => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const be = new TmuxPipeBackend('bmx-bound', { createSession: true, ownsSession: true });
    const readersBefore = __testOnly_liveFifoReaderCount();
    let attempts = 0;
    mockedExecFileSync.mockImplementation(((_bin: unknown, args: string[]) => {
      if (args[0] === '-V') return 'tmux 3.3a';
      if (args[0] === 'new-session') {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT', status: 1 });
        throw Object.assign(new Error('duplicate'), { status: 1, signal: null, stderr: 'duplicate session: bmx-bound' });
      }
      if (args[0] === 'show-environment' && args.includes('BOTMUX_CODEX_INSTANCE_BINDING')) {
        return actual ? `BOTMUX_CODEX_INSTANCE_BINDING=${actual}` : '';
      }
      return '';
    }) as typeof execFileSync);
    const opts = { ...spawnOpts(), env: { ...spawnOpts().env, BOTMUX_CODEX_INSTANCE_BINDING: 'binding-a' } };
    try {
      if (actual === 'binding-a') expect(() => be.spawn('sleep', ['60'], opts)).not.toThrow();
      else {
        expect(() => be.spawn('sleep', ['60'], opts)).toThrow(/preserved/);
        expect(__testOnly_liveFifoReaderCount()).toBe(readersBefore);
        expect(mockedExecSync.mock.calls.some(([cmd]) => /set-option|pipe-pane/.test(String(cmd)))).toBe(false);
      }
      expect(attempts).toBe(2);
      // tmux >= 3.2 marks atomically with -e and never falls back to set-environment.
      expect(newSessionArgs().slice(0, newSessionArgs().indexOf('--')))
        .toEqual(expect.arrayContaining(['-e', 'BOTMUX_CODEX_INSTANCE_BINDING=binding-a']));
      expect(mockedExecFileSync.mock.calls.some(([, a]) => (a as string[])[0] === 'set-environment')).toBe(false);
    } finally {
      be.kill();
      errSpy.mockRestore();
    }
  });

  it('keeps user-owned adopt panes usable without a Botmux identity marker', () => {
    const be = new TmuxPipeBackend('0:2.0');
    try {
      expect(() => be.spawn('', [], {
        ...spawnOpts(), env: { ...spawnOpts().env, BOTMUX_CODEX_INSTANCE_BINDING: 'binding-a' },
      })).not.toThrow();
      expect(mockedExecFileSync.mock.calls.some(([, args]) => (args as string[]).includes('BOTMUX_CODEX_INSTANCE_BINDING'))).toBe(false);
    } finally {
      be.kill();
    }
  });
});

const TMUX_EMULATED_IDENTITY = '1234 $7 5678';

  /** Emulates a real tmux that rejects `new-session -e` before 3.2, prints
 *  the created-session identity on success, and answers the identity fence.
 *  `rejectFailed` makes it behave like a pre-3.2 tmux that does not know the
 *  `remain-on-exit failed` value (real 3.1c: "bad value: failed"). */
function emulateTmux(versionString: string, opts: { rejectE?: boolean; duplicate?: boolean; rejectFailed?: boolean } = {}) {
  let attempts = 0;
  mockedExecFileSync.mockImplementation(((_bin: unknown, args: string[]) => {
    if (args[0] === '-V') return versionString;
    if (args[0] === 'new-session') {
      if (opts.rejectE && args.includes('-e')) {
        throw Object.assign(new Error('flag'), { status: 1, signal: null, stderr: 'command new-session: unknown flag -e' });
      }
      // A pre-3.2 tmux rejects the value itself, so the chained new-session
      // (and a standalone set-option) must never be sent on those versions.
      if (opts.rejectFailed && args.includes('remain-on-exit') && args.includes('failed')) {
        throw Object.assign(new Error('bad value'), { status: 1, signal: null, stderr: 'bad value: failed' });
      }
      attempts += 1;
      if (opts.duplicate && attempts === 1) {
        throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT', status: 1, signal: null });
      }
      if (opts.duplicate) {
        throw Object.assign(new Error('dup'), { status: 1, signal: null, stderr: 'duplicate session: bmx-ver' });
      }
      return TMUX_EMULATED_IDENTITY;
    }
    // has-session (probe) succeeds and the fence reads back our marker.
    if (args[0] === 'show-environment' && args.includes('BOTMUX_CODEX_INSTANCE_BINDING')) {
      return 'BOTMUX_CODEX_INSTANCE_BINDING=binding-a';
    }
    return '';
  }) as typeof execFileSync);
  return () => attempts;
}

describe('TmuxPipeBackend identity marker vs tmux version (#1959)', () => {
  const bindingOpts = () => ({ ...spawnOpts(), env: { ...spawnOpts().env, BOTMUX_CODEX_INSTANCE_BINDING: 'binding-a' } });

  const setEnvironmentCalls = () => mockedExecFileSync.mock.calls
    .filter(([, a]) => (a as string[])[0] === 'set-environment')
    .map(([, a]) => a as string[]);

  it('uses atomic new-session -e on tmux >= 3.2 and never set-environment', () => {
    emulateTmux('tmux 3.3a');
    const be = new TmuxPipeBackend('bmx-ver', { createSession: true, ownsSession: true });
    try {
      expect(() => be.spawn('sleep', ['60'], bindingOpts())).not.toThrow();
      expect(newSessionArgs()).toEqual(expect.arrayContaining(['-e', 'BOTMUX_CODEX_INSTANCE_BINDING=binding-a']));
      expect(setEnvironmentCalls()).toEqual([]);
    } finally { be.kill(); }
  });

  it('creates the session on a pre-3.2 tmux that rejects -e, then marks with set-environment', () => {
    const attempts = emulateTmux('tmux 3.1c', { rejectE: true });
    const be = new TmuxPipeBackend('bmx-ver', { createSession: true, ownsSession: true });
    try {
      // Without the version fallback this is a deterministic "unknown flag" failure.
      expect(() => be.spawn('sleep', ['60'], bindingOpts())).not.toThrow();
      expect(attempts()).toBe(1);
      expect(newSessionArgs().includes('-e')).toBe(false);
      // set-environment takes NAME and VALUE as separate argv (NAME=VALUE is rejected).
      expect(setEnvironmentCalls()).toEqual([
        ['set-environment', '-t', 'bmx-ver', 'BOTMUX_CODEX_INSTANCE_BINDING', 'binding-a'],
      ]);
      // Marker is written before the identity fence reads it.
      const order = mockedExecFileSync.mock.calls.map(([, a]) => (a as string[])[0]);
      expect(order.indexOf('set-environment')).toBeLessThan(order.indexOf('show-environment'));
    } finally { be.kill(); }
  });

  it('never writes set-environment on the duplicate path, even on old tmux', () => {
    emulateTmux('tmux 2.9', { rejectE: true, duplicate: true });
    const be = new TmuxPipeBackend('bmx-ver', { createSession: true, ownsSession: true });
    try {
      expect(() => be.spawn('sleep', ['60'], bindingOpts())).not.toThrow();
      expect(newSessionArgs().includes('-e')).toBe(false);
      expect(setEnvironmentCalls()).toEqual([]);
    } finally { be.kill(); }
  });

  it('treats an unparsable tmux version like the old path (no -e, set-environment fallback)', () => {
    const attempts = emulateTmux('tmux something-weird', { rejectE: true });
    const be = new TmuxPipeBackend('bmx-ver', { createSession: true, ownsSession: true });
    try {
      expect(() => be.spawn('sleep', ['60'], bindingOpts())).not.toThrow();
      expect(newSessionArgs().includes('-e')).toBe(false);
      expect(attempts()).toBe(1);
      expect(setEnvironmentCalls()).toHaveLength(1);
    } finally { be.kill(); }
  });
});

// v3.53.0 regression (#2164): `set-option remain-on-exit failed` is chained
// atomically into new-session, but `failed` only exists on tmux >= 3.2. On a
// tmux that rejects the value (3.1c: "bad value: failed") sending the chain
// makes new-session FAIL — i.e. every new session fails to start. The chain
// must use the supported `on` value on old/unknown tmux, preserving the exit
// status for the lifecycle watcher without blocking session creation.
describe('TmuxPipeBackend remain-on-exit failed vs tmux version (v3.53.0 regression)', () => {
  const newSessionArgv = (): string[] => newSessionArgs();
  const hasFailedChain = (): boolean =>
    newSessionArgv().includes('remain-on-exit') && newSessionArgv().includes('failed');

  it.each([
    ['tmux 3.3a'], // local dev
    ['tmux 3.2a'], // Ubuntu 22.04
    ['tmux 3.2'],
  ])('chains remain-on-exit failed into new-session on supported %s', (versionString) => {
    emulateTmux(versionString);
    const be = new TmuxPipeBackend('bmx-roe', { createSession: true, ownsSession: true });
    try {
      expect(() => be.spawn('sleep', ['60'], spawnOpts())).not.toThrow();
      expect(hasFailedChain()).toBe(true);
    } finally { be.kill(); }
  });

  it('uses on for tmux 3.1c that rejects "failed", and still creates the session', () => {
    // Faithful old-tmux fake: it would return "bad value: failed" if we sent
    // the option. Sending it is exactly the regression (new-session fails).
    emulateTmux('tmux 3.1c', { rejectFailed: true });
    const be = new TmuxPipeBackend('bmx-roe', { createSession: true, ownsSession: true });
    try {
      expect(() => be.spawn('sleep', ['60'], spawnOpts())).not.toThrow();
      expect(hasFailedChain()).toBe(false);
    } finally { be.kill(); }
  });

  it('uses on for older tmux 2.9 (never block start on an old recognized tmux)', () => {
    emulateTmux('tmux 2.9', { rejectFailed: true });
    const be = new TmuxPipeBackend('bmx-roe-29', { createSession: true, ownsSession: true });
    try {
      expect(() => be.spawn('sleep', ['60'], spawnOpts())).not.toThrow();
      expect(hasFailedChain()).toBe(false);
    } finally { be.kill(); }
  });

  // The most dangerous failure direction is FAIL-OPEN on an UNREADABLE version:
  // treating null as "supported" would send the option to an unknown old tmux
  // and block EVERY session — a regression as bad as (or worse than) the
  // original. This needs its OWN test; bundling it with the 2.9 case used to
  // let a null->true mutation hide behind the independently-passing 2.9 half.
  it('uses on when the tmux version is unreadable (unknown must fail CLOSED, not open)', () => {
    emulateTmux('tmux not-a-version', { rejectFailed: true });
    const be = new TmuxPipeBackend('bmx-roe-unknown', { createSession: true, ownsSession: true });
    try {
      // The fake rejects "failed": a fail-open implementation would throw here.
      expect(() => be.spawn('sleep', ['60'], spawnOpts())).not.toThrow();
      expect(hasFailedChain()).toBe(false);
    } finally { be.kill(); }
  });

  // Session creation re-probes an unknown cached version ONCE instead of
  // downgrading the whole session on a single transient `tmux -V` timeout.
  it('re-probes tmux -V at session start when the cached version is unknown, then uses the chain', () => {
    resetTmuxVersionCacheForTests();
    let vCalls = 0;
    mockedExecFileSync.mockImplementation(((_bin: unknown, args: string[]) => {
      if (args[0] === '-V') {
        vCalls += 1;
        // First read (cached during an earlier gate attempt) is a transient
        // timeout; the boundary re-probe succeeds with a modern tmux.
        if (vCalls === 1) throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
        return 'tmux 3.3a';
      }
      if (args[0] === 'new-session') return '1234 $7 5678';
      return '';
    }) as typeof execFileSync);
    // Prime the cache with a null result inside its null-TTL window.
    expect(getTmuxVersionCached()).toBeNull();
    expect(vCalls).toBe(1);

    const be = new TmuxPipeBackend('bmx-roe-reprobe', { createSession: true, ownsSession: true });
    try {
      expect(() => be.spawn('sleep', ['60'], spawnOpts())).not.toThrow();
      expect(vCalls).toBe(2);                 // the boundary re-probed
      expect(hasFailedChain()).toBe(true);    // modern tmux → chain enabled
    } finally { be.kill(); }
  });

  // createDetachedSession resolves the version once and applySessionOptions()
  // runs at its end: the reapply MUST reuse that resolution. A second boundary
  // resolve re-forces a `tmux -V` even inside the null TTL (the resolver
  // refreshes on ANY null), so an unreadable tmux would pay the 3s probe
  // timeout twice per session creation (~6s -> ~9s worst case) for a decision
  // that is already known. One session = one boundary resolution.
  it('resolves tmux -V exactly once per session creation when the probe stays unreadable', () => {
    resetTmuxVersionCacheForTests();
    let vCalls = 0;
    mockedExecFileSync.mockImplementation(((_bin: unknown, args: string[]) => {
      if (args[0] === '-V') {
        vCalls += 1;
        throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
      }
      if (args[0] === 'new-session') return '1234 $7 5678';
      return '';
    }) as typeof execFileSync);
    // Prime a recent null (the shape a failed gate/self-check leaves behind).
    expect(getTmuxVersionCached()).toBeNull();
    expect(vCalls).toBe(1);

    const be = new TmuxPipeBackend('bmx-roe-create-unreadable', { createSession: true, ownsSession: true });
    try {
      expect(() => be.spawn('sleep', ['60'], spawnOpts())).not.toThrow();
      // prime(1) + the single boundary resolve's forced re-probe(2); the
      // end-of-creation option reapply must not resolve a third time.
      expect(vCalls).toBe(2);
      expect(hasFailedChain()).toBe(false);
    } finally { be.kill(); }
  });
});

// tmux parses commands and option values in the SERVER. After a package upgrade
// the shared server keeps running the old binary, so gating on the client's
// `tmux -V` would still send `failed` / `-e` to a 3.1c server.
describe('TmuxPipeBackend gates on the running tmux server version', () => {
  function emulateMixed(client: string | null, server: string | null): void {
    mockedExecFileSync.mockImplementation(((_bin: unknown, args: string[]) => {
      if (args[0] === '-V') {
        if (client === null) throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
        return `${client}\n`;
      }
      if (args.includes('display-message') && args.includes('#{version}')) {
        if (server === null) throw Object.assign(new Error('no server'), { status: 1 });
        return `${server}\n`;
      }
      const cmd = args[0] === '-L' ? args[2] : args[0];
      if (cmd === 'new-session') return TMUX_EMULATED_IDENTITY;
      if (cmd === 'show-environment') return 'BOTMUX_CODEX_INSTANCE_BINDING=binding-a';
      return '';
    }) as typeof execFileSync);
  }
  const bindingOpts = () => ({ ...spawnOpts(), env: { ...spawnOpts().env, BOTMUX_CODEX_INSTANCE_BINDING: 'binding-a' } });
  const roeReapplies = () => mockedExecSync.mock.calls.map(c => String(c[0])).filter(c => c.includes('remain-on-exit'));

  beforeEach(() => resetTmuxVersionCacheForTests());

  it('client 3.5a but server still 3.1c: uses legacy remain-on-exit on, never failed/-e', () => {
    // #2419 superseded the old "omit entirely" behaviour: an old SERVER gets
    // `remain-on-exit on` (every tmux accepts it) so real exit codes are still
    // read from the retained corpse; only `failed` and `-e` are withheld.
    emulateMixed('tmux 3.5a', '3.1c');
    const be = new TmuxPipeBackend('bmx-srv-old', { createSession: true, ownsSession: true, socketName: 'botmux' });
    try {
      expect(() => be.spawn('sleep', ['60'], bindingOpts())).not.toThrow();
      expect(newSessionArgs()).toEqual(expect.arrayContaining(['remain-on-exit', 'on']));
      expect(newSessionArgs()).not.toContain('failed');
      expect(newSessionArgs()).not.toContain('-e');
      // Reattached/fresh option reapply uses the same server-aware value.
      expect(roeReapplies().length).toBeGreaterThan(0);
      for (const c of roeReapplies()) expect(c).toContain('remain-on-exit on');
    } finally { be.kill(); }
  });

  it('client probe unreadable but server 3.5a: chains remain-on-exit failed and -e', () => {
    emulateMixed(null, '3.5a');
    const be = new TmuxPipeBackend('bmx-srv-new', { createSession: true, ownsSession: true, socketName: 'botmux' });
    try {
      expect(() => be.spawn('sleep', ['60'], bindingOpts())).not.toThrow();
      expect(newSessionArgs()).toEqual(expect.arrayContaining(['remain-on-exit', 'failed', '-e']));
    } finally { be.kill(); }
  });

  it('cold start (no server on the socket yet) falls back to the client version', () => {
    emulateMixed('tmux 3.3a', null);
    const be = new TmuxPipeBackend('bmx-srv-cold', { createSession: true, ownsSession: true, socketName: 'botmux' });
    try {
      expect(() => be.spawn('sleep', ['60'], spawnOpts())).not.toThrow();
      expect(newSessionArgs()).toEqual(expect.arrayContaining(['remain-on-exit', 'failed']));
    } finally { be.kill(); }
  });

  it('asks the server on the session socket, not the default server', () => {
    emulateMixed('tmux 3.5a', '3.5a');
    const be = new TmuxPipeBackend('bmx-srv-sock', { createSession: true, ownsSession: true, socketName: 'botmux' });
    try {
      be.spawn('sleep', ['60'], spawnOpts());
      const probes = mockedExecFileSync.mock.calls
        .map(([, a]) => a as string[])
        .filter(a => a.includes('#{version}'));
      expect(probes.length).toBeGreaterThan(0);
      for (const a of probes) expect(a.slice(0, 2)).toEqual(['-L', 'botmux']);
    } finally { be.kill(); }
  });

  it('probes the running server exactly once during session creation (option reapply reuses it)', () => {
    emulateMixed('tmux 3.5a', '3.5a');
    const be = new TmuxPipeBackend('bmx-srv-once', { createSession: true, ownsSession: true, socketName: 'botmux' });
    try {
      be.spawn('sleep', ['60'], spawnOpts());
      const probes = mockedExecFileSync.mock.calls
        .map(([, a]) => a as string[])
        .filter(a => a.includes('#{version}'));
      expect(probes).toHaveLength(1);
    } finally { be.kill(); }
  });
});

describe('TmuxPipeBackend server selection (dedicated socket)', () => {
  function everyTmuxCall(): string[] {
    const fileCalls = mockedExecFileSync.mock.calls
      .filter(([bin]) => bin === 'tmux')
      .map(([, args]) => (args as string[]).join(' '));
    const shellCalls = mockedExecSync.mock.calls
      .map(([cmd]) => String(cmd))
      .filter(cmd => cmd.startsWith('tmux'));
    return [...fileCalls.map(args => `tmux ${args}`), ...shellCalls];
  }

  it('addresses every command of a managed session to its own server', () => {
    const be = new TmuxPipeBackend('bmx-owned', { createSession: true, ownsSession: true, socketName: 'botmux' });
    be.spawn('/bin/true', [], spawnOpts());
    be.sendText('hello');
    be.sendSpecialKeys('Enter');
    be.sendLines(['a', 'b'], 'S-Enter');
    be.pasteText('multi\nline');
    be.resize(120, 40);
    be.getChildPid();
    be.captureCurrentScreen();
    be.destroySession();
    const calls = everyTmuxCall();
    expect(calls.some(call => call.includes('new-session'))).toBe(true);
    expect(calls.some(call => call.includes('pipe-pane'))).toBe(true);
    expect(calls.some(call => call.includes('kill-session'))).toBe(true);
    // `tmux -V` is the version probe: it reaches no server.
    expect(calls.filter(call => call !== 'tmux -V' && !call.startsWith('tmux -L botmux '))).toEqual([]);
  });

  it('keeps adopted user panes on the default server', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    be.sendText('hello');
    be.kill();
    const calls = everyTmuxCall();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter(call => call.includes('-L '))).toEqual([]);
  });
});

describe('literalSendKeysArgs (tmux eats a trailing ";")', () => {
  it('keeps plain text as one literal send-keys', () => {
    expect(literalSendKeysArgs('0:1.0', 'mid;dle')).toEqual(['send-keys', '-t', '0:1.0', '-l', '--', 'mid;dle']);
  });

  it('sends trailing semicolons as hex keys in the same invocation', () => {
    expect(literalSendKeysArgs('0:1.0', '93&#47;')).toEqual([
      'send-keys', '-t', '0:1.0', '-l', '--', '93&#47', ';', 'send-keys', '-t', '0:1.0', '-H', '3b',
    ]);
    expect(literalSendKeysArgs('p', 'E;;')).toEqual(['send-keys', '-t', 'p', '-l', '--', 'E', ';', 'send-keys', '-t', 'p', '-H', '3b', '3b']);
  });

  it('never leaves a literal argument ending in ";" or a backslash-escaped one', () => {
    expect(literalSendKeysArgs('p', ';')).toEqual(['send-keys', '-t', 'p', '-H', '3b']);
    expect(literalSendKeysArgs('p', 'B\\;')).toEqual(['send-keys', '-t', 'p', '-l', '--', 'B\\', ';', 'send-keys', '-t', 'p', '-H', '3b']);
  });

  it('keeps the old argv on tmux without -H (< 3.0)', () => {
    expect(literalSendKeysArgs('p', 'X;', { major: 2, minor: 9 })).toEqual(['send-keys', '-t', 'p', '-l', '--', 'X;']);
    expect(literalSendKeysArgs('p', 'X;', { major: 3, minor: 0 })).toContain('-H');
  });

  it('sendText and sendLines route through it', () => {
    const be = new TmuxPipeBackend('0:3.1');
    be.spawn('', [], spawnOpts());
    mockedExecFileSync.mockClear();
    be.sendText('&#10;');
    be.sendLines(['a;', 'b'], 'S-Enter');
    const [text, lines] = getExecFileCalls().map(call => call[1] as string[]);
    expect(text.slice(-5)).toEqual(['send-keys', '-t', '0:3.1', '-H', '3b']);
    expect(text).toContain('&#10');
    expect(text).not.toContain('&#10;');
    expect(lines).toContain('3b');
    expect(lines.filter(arg => arg !== ';' && arg.endsWith(';'))).toEqual([]);
  });
});

describe('TmuxPipeBackend input addressing', () => {
  it('sendText routes to the real pane target', () => {
    const be = new TmuxPipeBackend('0:3.1');
    be.spawn('', [], spawnOpts());
    mockedExecFileSync.mockClear();
    be.sendText('飞书消息');

    const call = getExecFileCalls()[0];
    expect(call[0]).toBe('tmux');
    const args = call[1] as string[];
    const tIdx = args.indexOf('-t');
    expect(args[tIdx + 1]).toBe('0:3.1');
    expect(args).toContain('-l');
    expect(args).toContain('飞书消息');
  });

  it('sendSpecialKeys routes to the pane', () => {
    const be = new TmuxPipeBackend('1:0.2');
    be.spawn('', [], spawnOpts());
    mockedExecFileSync.mockClear();
    be.sendSpecialKeys('Enter');

    const args = getExecFileCalls()[0][1] as string[];
    const tIdx = args.indexOf('-t');
    expect(args[tIdx + 1]).toBe('1:0.2');
    expect(args).toContain('Enter');
  });

  it('pasteText load-buffer + paste-buffer, paste targets the pane', () => {
    const be = new TmuxPipeBackend('0:5.0');
    be.spawn('', [], spawnOpts());
    mockedExecFileSync.mockClear();
    be.pasteText('multi\nline');

    const calls = getExecFileCalls();
    const loadArgs = calls[0][1] as string[];
    expect(loadArgs).toContain('load-buffer');
    expect((calls[0][2] as any).input).toBe('multi\nline');
    const bIdx = loadArgs.indexOf('-b');
    expect(bIdx).toBeGreaterThanOrEqual(0);
    const bufferName = loadArgs[bIdx + 1];
    expect(bufferName).toMatch(/^botmux-[a-f0-9]{16}$/);

    // The paste only runs behind `#{pane_dead}`, decided in the same tmux queue.
    expect(calls[1][1]).toEqual(expect.arrayContaining(['if-shell', '-F', '#{pane_dead}']));
    const pasteArgs = pasteBufferArgv(calls[1][1] as string[])!;
    expect(pasteArgs[0]).toBe('paste-buffer');
    const pasteBIdx = pasteArgs.indexOf('-b');
    expect(pasteBIdx).toBeGreaterThanOrEqual(0);
    expect(pasteArgs[pasteBIdx + 1]).toBe(bufferName);
    const tIdx = pasteArgs.indexOf('-t');
    expect(pasteArgs[tIdx + 1]).toBe('0:5.0');
    // -p forces bracketed-paste markers, REQUIRED for CoCo/Ink to treat the
    // content as one paste and accept the trailing Enter as a submit. Without
    // it the Enter is swallowed as a soft-newline and the message strands in
    // the input box (replies-to-previous-message off-by-one). Regression guard
    // for PR #25, which added -p only to the unused TmuxBackend.
    expect(pasteArgs).toContain('-p');
  });

  it('submits the framed Codex paste in one tmux batch and Enter as the next tmux call', () => {
    const be = new TmuxPipeBackend('0:5.0');
    be.spawn('', [], spawnOpts());
    mockedExecFileSync.mockClear();
    expect(be.submitBracketedPaste('line one  \nline two')).toBe(true);
    const calls = getExecFileCalls();
    expect(calls).toHaveLength(3);
    expect((calls[0][2] as any).input).toBe('line one  \nline two');
    expect(pasteBufferArgv(calls[1][1] as string[])).toContain('-r');
    expect(pasteBufferArgv(calls[1][1] as string[])).not.toContain('-p');
    expect((calls[1][1] as string[]).slice(-7)).toEqual([';', 'send-keys', '-t', '0:5.0', '-l', '--', '\x1b[201~']);
    expect(calls[1][1]).toContain('\x1b[200~');
    expect((calls[2][1] as string[]).slice(-6)).toEqual(['send-keys', '-t', '0:5.0', '-l', '--', '\r']);
  });

  it('does not send Enter when the framed paste was dropped', () => {
    const be = new TmuxPipeBackend('0:5.0');
    be.spawn('', [], spawnOpts());
    mockedExecFileSync.mockClear();
    mockedExecFileSync.mockImplementation(((_file: string, args: string[]) => {
      if (pasteBufferArgv(args)) throw new Error('server busy');
      return '';
    }) as typeof execFileSync);
    expect(be.submitBracketedPaste('message')).toBe(false);
    expect(getExecFileCalls().some(call => (call[1] as string[]).includes('\r'))).toBe(false);
  });

  it('uses a fresh named tmux buffer for each paste', () => {
    const be = new TmuxPipeBackend('0:5.0');
    be.spawn('', [], spawnOpts());
    mockedExecFileSync.mockClear();
    be.pasteText('one');
    be.pasteText('two');

    const loadCalls = getExecFileCalls()
      .map(call => call[1] as string[])
      .filter(args => args.includes('load-buffer'));
    const firstBuffer = loadCalls[0][loadCalls[0].indexOf('-b') + 1];
    const secondBuffer = loadCalls[1][loadCalls[1].indexOf('-b') + 1];
    expect(firstBuffer).not.toBe(secondBuffer);
  });

  it('deletes the named buffer when paste-buffer fails (cleanup, no leak)', () => {
    const be = new TmuxPipeBackend('0:5.0');
    be.spawn('', [], spawnOpts());
    mockedExecFileSync.mockClear();
    // load-buffer succeeds, paste-buffer throws → the -d delete never runs, so
    // the finally{} must delete the SAME named buffer. guardedSend swallows the
    // failure (pane ALIVE via the default execSync mock) so pasteText must not throw.
    mockedExecFileSync.mockImplementation(((_cmd: string, args?: string[]) => {
      if (Array.isArray(args) && pasteBufferArgv(args)) throw new Error('no server running');
      return '' as any;
    }) as any);

    expect(() => be.pasteText('boom')).not.toThrow();

    const calls = getExecFileCalls().map(call => call[1] as string[]);
    const loadArgs = calls.find(args => args.includes('load-buffer'))!;
    const bufferName = loadArgs[loadArgs.indexOf('-b') + 1];
    const deleteArgs = calls.find(args => args.includes('delete-buffer'));
    expect(deleteArgs).toBeDefined();
    expect(deleteArgs![deleteArgs!.indexOf('-b') + 1]).toBe(bufferName);
  });

  it('reports paste rejection when paste-buffer fails after load-buffer cleanup', () => {
    const be = new TmuxPipeBackend('0:5.0');
    be.spawn('', [], spawnOpts());
    mockedExecFileSync.mockClear();
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      if (Array.isArray(args) && pasteBufferArgv(args)) throw new Error('no server running');
      return Buffer.from('');
    });

    expect(be.pasteText('boom')).toBe(false);
  });

  it('reports paste rejection after backend exit without sending Enter-bound content', () => {
    const be = new TmuxPipeBackend('0:5.0');
    be.spawn('', [], spawnOpts());
    be.kill();
    mockedExecFileSync.mockClear();

    expect(be.pasteText('after exit')).toBe(false);
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('write delegates to sendText (literal send-keys)', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecFileSync.mockClear();
    be.write('hi');
    const args = getExecFileCalls()[0][1] as string[];
    expect(args).toContain('-l');  // literal mode
    expect(args).toContain('hi');
  });
});

describe('TmuxPipeBackend.getChildPid', () => {
  it('uses display-message -p (not list-panes) for accurate pane resolution', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockClear();
    mockedExecSync.mockReturnValue('45678\n' as any);
    expect(be.getChildPid()).toBe(45678);
    const cmd = String(mockedExecSync.mock.calls[0][0]);
    expect(cmd).toContain('display-message');
    expect(cmd).toContain('#{pane_pid}');
    expect(cmd).not.toContain('list-panes');
  });
});

describe('TmuxPipeBackend.captureCurrentScreen', () => {
  it('captures with ANSI + full scrollback (-e -p -S -)', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockClear();
    // First call → alternate_on probe (returns '0' = main buffer)
    // Second call → capture-pane payload
    mockedExecSync
      .mockReturnValueOnce('0\n' as any)
      .mockReturnValueOnce('\x1b[1mhello\x1b[0m' as any);
    const out = be.captureCurrentScreen();
    expect(out).toBe('\x1b[1mhello\x1b[0m');
    const captureCall = mockedExecSync.mock.calls.find(c => String(c[0]).includes('capture-pane'));
    expect(captureCall).toBeDefined();
    const cmd = String(captureCall![0]);
    expect(cmd).toContain('-e');
    expect(cmd).toContain('-p');
    expect(cmd).toContain('-S -');
    expect(cmd).toContain("'0:2.0'");
  });

  it('normalises bare \\n to \\r\\n so xterm.js does not staircase', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue(Buffer.from('') as any);
    mockedExecSync
      .mockReturnValueOnce('0\n' as any)  // alternate_on probe
      .mockReturnValueOnce('line1\nline2\nline3\n' as any);
    const out = be.captureCurrentScreen();
    // Each \n must become \r\n; existing \r\n must not be doubled. The web seed
    // also strips the trailing newline (see composeSeedBody) so it doesn't
    // scroll the receiving xterm a row past the content. Cursor query is mocked
    // empty here → no CUP appended.
    expect(out).toBe('line1\r\nline2\r\nline3');
  });

  it('preserves existing \\r\\n untouched', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue(Buffer.from('') as any);
    mockedExecSync
      .mockReturnValueOnce('0\n' as any)
      .mockReturnValueOnce('a\r\nb\nc\r\n' as any);
    // \r\n preserved; trailing newline stripped for the seed.
    expect(be.captureCurrentScreen()).toBe('a\r\nb\r\nc');
  });

  it('prefixes alt-buffer enter sequence when pane is in alt screen', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue(Buffer.from('') as any);
    mockedExecSync
      .mockReturnValueOnce('1\n' as any)        // alternate_on=1 (Claude TUI)
      .mockReturnValueOnce('claude prompt\n' as any);
    const out = be.captureCurrentScreen();
    // Must start with: enter alt buffer + home + clear, then the snapshot
    // (trailing newline stripped for the seed; cursor query mocked empty).
    expect(out.startsWith('\x1b[?1049h\x1b[H\x1b[2J')).toBe(true);
    expect(out.endsWith('claude prompt')).toBe(true);
  });

  it('does NOT prefix alt-buffer enter when pane is on main buffer', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue(Buffer.from('') as any);
    mockedExecSync
      .mockReturnValueOnce('0\n' as any)        // alternate_on=0 (zsh prompt)
      .mockReturnValueOnce('$ ls\n' as any);
    const out = be.captureCurrentScreen();
    expect(out).toBe('$ ls');                   // trailing newline stripped
    expect(out).not.toContain('\x1b[?1049h');
  });

  it('restores the pane cursor (CUP) so the live redraw lands on the right row', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue(Buffer.from('') as any);
    mockedExecSync
      .mockReturnValueOnce('0\n' as any)          // alternate_on=0 (main buffer)
      .mockReturnValueOnce('STATUS\nTIP\nINPUT\n' as any)  // capture-pane
      .mockReturnValueOnce('6 10\n' as any);      // cursor_x=6 cursor_y=10
    const out = be.captureCurrentScreen();
    // Trailing newline stripped, then CUP to (y+1=11, x+1=7).
    expect(out).toBe('STATUS\r\nTIP\r\nINPUT\x1b[11;7H');
  });
});

describe('TmuxPipeBackend.captureViewport', () => {
  it('uses no `-S`/`-E` flags so tmux returns viewport-only', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue(Buffer.from('') as any);
    mockedExecSync
      .mockReturnValueOnce('0\n' as any)
      .mockReturnValueOnce('viewport line\n' as any);
    const out = be.captureViewport();
    expect(out).toBe('viewport line\r\n');
    const captureCall = mockedExecSync.mock.calls.find(c => String(c[0]).includes('capture-pane'));
    expect(captureCall).toBeDefined();
    const cmd = String(captureCall![0]);
    expect(cmd).toContain('-e');
    expect(cmd).toContain('-p');
    // Critically, no `-S` flag — otherwise -S -N pulls N scrollback rows
    // on top of the viewport (tmux semantics) and the transient terminal
    // ends up scrolled past the bottom.
    expect(cmd).not.toContain('-S');
    expect(cmd).not.toContain('-E');
  });

  it('still applies alt-buffer prefix when pane is in alt screen', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue(Buffer.from('') as any);
    mockedExecSync
      .mockReturnValueOnce('1\n' as any)
      .mockReturnValueOnce('claude tui\n' as any);
    const out = be.captureViewport();
    expect(out.startsWith('\x1b[?1049h\x1b[H\x1b[2J')).toBe(true);
    expect(out).toContain('claude tui\r\n');
  });
});

describe('TmuxPipeBackend.captureViewportAsync', () => {
  it('reads the frozen native pane asynchronously without ANSI/history or sync mode probes', async () => {
    const be = new TmuxPipeBackend('test:2.0', { socketName: 'private-test' });
    let finish!: (error: Error | null, screen: string) => void;
    vi.mocked(execFile).mockImplementation(((_bin: string, _args: string[], _options: any, cb: any) => {
      finish = cb;
      return {};
    }) as any);
    const syncCalls = vi.mocked(execSync).mock.calls.length;
    const pending = be.captureViewportAsync();
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(vi.mocked(execFile).mock.calls.at(-1)?.slice(0, 3)).toEqual([
      'tmux', ['-L', 'private-test', 'capture-pane', '-p', '-t', 'test:2.0'],
      expect.objectContaining({ timeout: expect.any(Number), killSignal: 'SIGKILL', maxBuffer: expect.any(Number) }),
    ]);
    expect(vi.mocked(execSync).mock.calls).toHaveLength(syncCalls);
    finish(null, '◆ Working…\n');
    expect(await pending).toBe('◆ Working…\n');
  });

  it.each(['native error', 'exited'])('does not provide stale viewport evidence after %s', async failure => {
    const be = new TmuxPipeBackend('test:0.0');
    let finish!: (error: Error | null, screen: string) => void;
    vi.mocked(execFile).mockImplementation(((_bin: string, _args: string[], _options: any, cb: any) => {
      finish = cb;
      return {};
    }) as any);
    const pending = be.captureViewportAsync();
    if (failure === 'native error') {
      finish(new Error('timeout'), '');
      await expect(pending).rejects.toThrow('timeout');
    } else {
      // Normal teardown must invalidate a read already in flight too.
      be.kill();
      finish(null, 'old Working frame');
      expect(await pending).toBe('');
      expect(await be.captureViewportAsync()).toBe('');
    }
  });
});

describe('capture failure observability', () => {
  function captureError(stderr: string): Error {
    return Object.assign(new Error(stderr), { status: 1, signal: null, stderr: Buffer.from(stderr) });
  }

  it.each([
    ['error connecting to /tmp/tmux-0/private-test (Connection refused)', 'server-unreachable'],
    ['no server running on /tmp/tmux-0/private-test', 'no-server'],
    ["can't find pane: 0:2.0", 'pane-missing'],
  ])('classifies %s without changing the empty capture result', (stderr, kind) => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockedExecSync.mockImplementation(() => { throw captureError(stderr); });
    const be = new TmuxPipeBackend('0:2.0', { socketName: 'private-test' });

    expect(be.captureViewport()).toBe('');
    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = String(errSpy.mock.calls[0][0]);
    expect(line).toContain(`kind=${kind}`);
    expect(line).toContain('socket=private-test');
    expect(line).toContain('target=0:2.0');
    errSpy.mockRestore();
  });

  it('rate-limits identical errors but logs again after the interval', () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockedExecSync.mockImplementation(() => { throw captureError('no server running on /tmp/tmux-0/private-test'); });
    const be = new TmuxPipeBackend('0:2.0', { socketName: 'private-test' });

    be.captureViewport();
    be.captureViewport();
    expect(errSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(31_000);
    be.captureViewport();
    expect(errSpy).toHaveBeenCalledTimes(2);
    errSpy.mockRestore();
    vi.useRealTimers();
  });

  it('classifies async capture errors while preserving rejection', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.mocked(execFile).mockImplementation(((_bin: string, _args: string[], _options: any, cb: any) => {
      cb(captureError('error connecting to /tmp/tmux-0/private-test (Connection refused)'), '');
      return {};
    }) as any);
    const be = new TmuxPipeBackend('0:2.0', { socketName: 'private-test' });

    await expect(be.captureViewportAsync()).rejects.toThrow('error connecting');
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain('kind=server-unreachable');
    errSpy.mockRestore();
  });
});

describe('TmuxPipeBackend.getPaneSize', () => {
  it('parses `#{pane_width} #{pane_height}` into {cols, rows}', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue('200 60\n' as any);
    const size = be.getPaneSize();
    expect(size).toEqual({ cols: 200, rows: 60 });
    const cmd = String(mockedExecSync.mock.calls[0][0]);
    expect(cmd).toContain('display-message');
    expect(cmd).toContain("'#{pane_width} #{pane_height}'");
  });

  it('returns null when tmux errors (pane gone, server gone)', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockReset();
    mockedExecSync.mockImplementation(() => { throw new Error('no server'); });
    expect(be.getPaneSize()).toBeNull();
  });

  it('returns null on malformed output (NaN width/height)', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue('abc def\n' as any);
    expect(be.getPaneSize()).toBeNull();
  });

  it('returns null after exited', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    be.kill();
    expect(be.getPaneSize()).toBeNull();
  });
});

describe('normaliseCaptureLineEndings', () => {
  it('handles mixed line endings idempotently', () => {
    expect(normaliseCaptureLineEndings('a\nb')).toBe('a\r\nb');
    expect(normaliseCaptureLineEndings('a\r\nb')).toBe('a\r\nb');
    expect(normaliseCaptureLineEndings('\n\n\n')).toBe('\r\n\r\n\r\n');
    expect(normaliseCaptureLineEndings('')).toBe('');
  });
});

describe('TmuxPipeBackend managed launch file', () => {
  const SECRET_PROMPT = '部署口令-不得外泄';
  const SECRET_VALUE = 'provider-secret-0123456789';

  function freshLaunchDir(): string {
    const dir = join(paneLaunchRoot, `case-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir);
    return dir;
  }

  function secretSpawn(be: TmuxPipeBackend, launchDir: string) {
    be.spawn('/usr/local/bin/grok', ['--rules', `规则 ${SECRET_PROMPT}`], {
      ...spawnOpts(),
      env: { PATH: '/usr/bin:/bin', BOTMUX_SESSION_ID: 'sid-secret' },
      injectEnv: { PROVIDER_TOKEN: SECRET_VALUE },
      unsetEnv: ['MIDSCENE_MODEL_API_KEY'],
      launchShell: '/bin/sh',
      paneLaunchDir: launchDir,
    });
  }

  /** An execFileSync failure exactly as Node/Bun build it: the message echoes
   *  the whole command, stderr carries tmux's reason. */
  function execFailure(args: string[], stderr: string) {
    return Object.assign(new Error(`Command failed: tmux ${args.join(' ')} ${SECRET_PROMPT} PROVIDER_TOKEN=${SECRET_VALUE}\n${stderr}\n`), {
      status: 1, signal: null, stderr: Buffer.from(`${stderr}\n`),
    });
  }

  function captureWrites() {
    const out: string[] = [];
    const err: string[] = [];
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => { out.push(String(chunk)); return true; }) as any);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: any) => { err.push(String(chunk)); return true; }) as any);
    return { out, err, restore: () => { outSpy.mockRestore(); errSpy.mockRestore(); } };
  }

  it('a tmux rejection reaches the caller as its reason only; the command goes to stdout', () => {
    mockedExecFileSync.mockImplementation(((_bin: any, args: any) => {
      if (Array.isArray(args) && args.includes('new-session')) throw execFailure(args, 'command too long');
      return '' as any;
    }) as any);
    const launchDir = freshLaunchDir();
    const io = captureWrites();
    let thrown: unknown;
    try {
      secretSpawn(new TmuxPipeBackend('bmx-secret', { createSession: true, ownsSession: true }), launchDir);
    } catch (err) { thrown = err; } finally { io.restore(); }
    expect(thrown).toBeInstanceOf(TmuxCommandTooLongError);
    const message = (thrown as Error).message;
    expect(message).toContain('启动命令过长，被 tmux 拒绝');
    for (const leaked of [SECRET_PROMPT, SECRET_VALUE, 'MIDSCENE_MODEL_API_KEY', '/usr/bin:/bin', 'new-session']) {
      expect(message).not.toContain(leaked);
      // stderr feeds the startup-failure card's recent-output block.
      expect(io.err.join('')).not.toContain(leaked);
    }
    expect(io.out.join('')).toMatch(/new-session bmx-secret failed: command too long\n.*tmux new-session -d/s);
    // Nothing will ever read the file now; its env values do not stay on disk.
    expect(readdirSync(launchDir)).toEqual([]);
  });

  it('keeps the transient signature of an exhausted connect failure, without the command', () => {
    mockedExecFileSync.mockImplementation(((_bin: any, args: any) => {
      if (Array.isArray(args) && args.includes('new-session')) throw execFailure(args, 'error connecting to /tmp/tmux-0/botmux (Connection refused)');
      return '' as any;
    }) as any);
    const launchDir = freshLaunchDir();
    const io = captureWrites();
    let thrown: unknown;
    try {
      secretSpawn(new TmuxPipeBackend('bmx-secret', { createSession: true, ownsSession: true }), launchDir);
    } catch (err) { thrown = err; } finally { io.restore(); }
    const message = (thrown as Error).message;
    expect(message).toBe('tmux 创建会话失败：error connecting to /tmp/tmux-0/botmux (Connection refused)');
    expect(isTransientStartupFailure(message)).toBe(true);
    // The two retry notices on stderr carry the same summary, not the echo.
    expect(io.err.filter(line => line.includes('retrying: error connecting to'))).toHaveLength(2);
    expect(io.err.join('')).not.toContain(SECRET_VALUE);
    expect(readdirSync(launchDir)).toEqual([]);
  });

  it('refuses a command past the tmux cap before running tmux', () => {
    mockedExecFileSync.mockImplementation(((_bin: any, args: any) => (args?.[0] === '-V' ? 'tmux 3.3a' : '')) as any);
    const launchDir = freshLaunchDir();
    const io = captureWrites();
    let thrown: unknown;
    try {
      new TmuxPipeBackend('bmx-huge', { createSession: true, ownsSession: true }).spawn('sleep', ['60'], {
        ...spawnOpts(),
        // Rides in the tmux command itself (`new-session -e`), not in the file.
        env: { PATH: '/usr/bin:/bin', BOTMUX_CODEX_INSTANCE_BINDING: 'b'.repeat(17_000) },
        paneLaunchDir: launchDir,
      });
    } catch (err) { thrown = err; } finally { io.restore(); }
    expect(thrown).toBeInstanceOf(TmuxCommandTooLongError);
    expect(mockedExecFileSync.mock.calls.some(([, args]) => (args as string[]).includes('new-session'))).toBe(false);
    expect(readdirSync(launchDir)).toEqual([]);
  });

  it('destroySession takes an unread launch file along; a plain detach leaves it for the pane', () => {
    const detachedDir = freshLaunchDir();
    const detached = new TmuxPipeBackend('bmx-detach', { createSession: true, ownsSession: true });
    detached.spawn('/bin/echo', ['hi'], { ...spawnOpts(), paneLaunchDir: detachedDir });
    detached.kill();
    expect(readdirSync(detachedDir)).toHaveLength(1);

    const destroyedDir = freshLaunchDir();
    const destroyed = new TmuxPipeBackend('bmx-destroy', { createSession: true, ownsSession: true });
    destroyed.spawn('/bin/echo', ['hi'], { ...spawnOpts(), paneLaunchDir: destroyedDir });
    destroyed.destroySession();
    expect(readdirSync(destroyedDir)).toEqual([]);
  });

  it('a fresh session drops older unread files of the same session, never a recent one', () => {
    const launchDir = freshLaunchDir();
    const stale = join(launchDir, 'launch-00000000000000aa.sh');
    const recent = join(launchDir, 'launch-00000000000000bb.sh');
    const unrelated = join(launchDir, 'notes.txt');
    for (const path of [stale, recent, unrelated]) writeFileSync(path, 'x');
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    utimesSync(stale, twoMinutesAgo, twoMinutesAgo);
    utimesSync(unrelated, twoMinutesAgo, twoMinutesAgo);
    new TmuxPipeBackend('bmx-sweep', { createSession: true, ownsSession: true })
      .spawn('/bin/echo', ['hi'], { ...spawnOpts(), paneLaunchDir: launchDir });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(readdirSync(launchDir).filter(name => /^launch-[0-9a-f]{16}\.sh$/.test(name))).toHaveLength(2);
  });
});

describe('TmuxPipeBackend managed session', () => {
  it('creates detached session and applies botmux tmux options', () => {
    const be = new TmuxPipeBackend('bmx-owned', { createSession: true, ownsSession: true });
    be.spawn('/bin/echo', ['hello'], spawnOpts());

    const newSessionCall = mockedExecFileSync.mock.calls.find(call => {
      const args = call[1] as string[];
      return args.includes('new-session');
    });
    expect(newSessionCall).toBeDefined();
    expect(newSessionCall![1]).toContain('-d');
    expect(newSessionCall![1]).toContain('bmx-owned');

    const optionCalls = mockedExecSync.mock.calls.map(c => String(c[0]));
    expect(optionCalls.some(c => c.includes('set-option') && c.includes('status on'))).toBe(true);
    expect(optionCalls.some(c => c.includes('set-option') && c.includes('mouse on'))).toBe(true);
    expect(optionCalls.some(c => c.includes('set-option') && c.includes('history-limit 50000'))).toBe(true);
    expect(optionCalls.some(c => c.includes('set-option') && c.includes('window-size largest'))).toBe(true);
    expect(optionCalls.some(c => c.includes('set-option -s set-clipboard on'))).toBe(true);
  });

  it('uses fish script syntax and omits the POSIX _ sentinel when launchShell is fish', () => {
    const shell = createFakeShell('fish');
    try {
      const be = new TmuxPipeBackend('bmx-fish-pipe', { createSession: true, ownsSession: true });
      be.spawn('/bin/echo', ['hello'], {
        ...spawnOpts(),
        launchShell: shell.path,
      });

      const args = newSessionArgs();
      const cIdx = scriptIndex(args);
      // The creating command chains `\; set-option … remain-on-exit failed`
      // (atomic with creation — see createDetachedSession), so the launch
      // clause is no longer the argv tail. Slice exactly the clause.
      const launchClause = args.slice(cIdx - 2, cIdx + 3);
      // fish gets its post-script args as $argv: no POSIX `_` sentinel.
      expect(launchClause).toEqual([shell.path, '-i', '-c', 'source $argv[1]', args[cIdx + 2]]);
      expect(args.slice(cIdx + 3, cIdx + 10)).toEqual([';', 'set-option', '-t', 'bmx-fish-pipe', 'remain-on-exit', 'failed', ';']);
      const { body } = takePaneLaunchFile(args);
      expect(body).toContain(`set argv '/tmp'`);
      expect(body).toContain('cd -- $argv[1]');
      expect(body).toContain('set -e argv[1]');
      expect(body).toContain('exec /usr/bin/env $argv');
      expect(body).not.toContain('cd -- "$1" && shift');
      expect(body).not.toContain('"$@"');
      expect(body).not.toMatch(/\bshift\b/);
    } finally {
      cleanupFakeShell(shell);
    }
  });

  it('sh-compatible shells source the POSIX launch file', () => {
    const be = new TmuxPipeBackend('bmx-posix-pipe', { createSession: true, ownsSession: true });
    be.spawn('/bin/echo', ['hello'], {
      ...spawnOpts(),
      env: { PATH: '/usr/bin:/bin' },
      launchShell: '/bin/sh',
    });

    const args = newSessionArgs();
    const cIdx = scriptIndex(args);
    expect(args.slice(cIdx - 1, cIdx + 4)).toEqual(['/bin/sh', '-c', '. "$1"', '_', args[cIdx + 3]]);
    expect(args.slice(cIdx + 4, cIdx + 11)).toEqual([';', 'set-option', '-t', 'bmx-posix-pipe', 'remain-on-exit', 'failed', ';']);
    const { body } = takePaneLaunchFile(args);
    expect(body).toContain(`set -- '/tmp'`);
    expect(body).toContain('cd -- "$1" && shift');
    expect(body).toContain('exec /usr/bin/env "$@"');
  });

  it('resizes owned tmux sessions and only records adopted pane resize', () => {
    const owned = new TmuxPipeBackend('bmx-owned', { ownsSession: true });
    owned.resize(120, 40);
    expect(mockedExecFileSync).toHaveBeenCalledWith('tmux', ['resize-window', '-t', 'bmx-owned', '-x', '120', '-y', '40'], expect.any(Object));

    mockedExecFileSync.mockClear();
    const adopted = new TmuxPipeBackend('0:2.0');
    adopted.resize(100, 30);
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });
});

describe('resolveReportedExitCode merges latched vs terminal death code', () => {
  // observed = code captured when a probe confirmed the corpse
  // terminal = code read at handlePaneExit teardown
  // null = confirmed dead but no code seen; undefined = death never probe-confirmed.
  it.each([
    [77, null, 77],   // latched real code wins even if terminal starved
    [77, 3, 77],     // a numeric latch is never overwritten by the terminal read
    [null, 77, 77],  // probe latched code-less, terminal catches the late code
    [undefined, 77, 77], // no probe capture; terminal code stands
    [null, null, null],   // code-less (signal) death on both -> null -> caller uses sentinel 1
    [undefined, null, null],
  ] as const)('observed=%j terminal=%j -> %j', (observed, terminal, expected) => {
    expect(resolveReportedExitCode(observed, terminal)).toBe(expected);
  });

  it('passes a real exit 0 through (does not collide with the sentinel-1 fallback)', () => {
    expect(resolveReportedExitCode(0, 1)).toBe(0);
    expect(resolveReportedExitCode(undefined, 0)).toBe(0);
  });
});

describe('TmuxPipeBackend lifecycle watcher', () => {
  // The watcher used to ask tmux with TWO synchronous display-message calls
  // every second, for every pane, whether or not anything happened in it.
  // These cases run the watcher against a model of what tmux answers
  // (helpers/tmux-world.ts: answers are expanded from the format the code
  // sends, for both execFileSync and execFile), so they pin behaviour — when a
  // pane is judged gone, with which code, how often tmux is asked, and that the
  // asking never blocks the event loop — not the argv of any one command.
  const mockedExecFile = vi.mocked(execFile);
  const TARGET = 'bmx-owned';
  const INITIAL = tmuxLifecycleInitialDelayMs(TARGET);
  const IDLE = tmuxLifecycleIdleProbeMs(TARGET);
  /** Start-up + one full activity window: from here on the pane is idle. */
  const TO_IDLE = INITIAL + LIFECYCLE_ACTIVITY_WINDOW_MS + LIFECYCLE_IDLE_PROBE_MAX_MS;
  /** The confirmation debounce (misses at +0 / +3s / +12s) plus async slack. */
  const DEBOUNCE = 12_000 + 1_000;

  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    errSpy.mockRestore();
  });

  const logged = (text: string) => errSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes(text));

  function watch(world: TmuxWorld, target = TARGET, opts: { ownsSession?: boolean; cliPid?: number } = { ownsSession: true }) {
    installTmuxWorld(world, { execFileSync: mockedExecFileSync, execFile: mockedExecFile });
    const be = new TmuxPipeBackend(target, opts);
    const exits: Array<[number | null, string | null]> = [];
    be.onExit((code, signal) => exits.push([code, signal]));
    be.spawn('', [], spawnOpts());
    resetCalls(world);
    return { be, exits };
  }
  function resetCalls(world: TmuxWorld): void {
    world.syncCalls.length = 0;
    world.asyncCalls.length = 0;
  }
  /** Liveness rounds the watcher ran (async), and liveness reads made with a
   *  BLOCKING execFileSync (must stay 0 while only the watcher runs). */
  const asyncProbes = (world: TmuxWorld) => world.asyncCalls.filter(isLivenessRead).length;
  const syncProbes = (world: TmuxWorld) => world.syncCalls.filter(isLivenessRead).length;

  it('asks tmux ONE command per round, asynchronously — never a blocking execFileSync', async () => {
    const world = createTmuxWorld();
    watch(world);
    await vi.advanceTimersByTimeAsync(INITIAL + 5 * LIFECYCLE_ACTIVE_PROBE_MS);

    expect(asyncProbes(world)).toBeGreaterThanOrEqual(5);
    // Every tmux command of a healthy round IS the liveness read: one per round.
    expect(world.asyncCalls.length).toBe(asyncProbes(world));
    expect(world.syncCalls).toEqual([]);
  });

  it('probes an idle pane at the idle cadence, never slower than LIFECYCLE_IDLE_PROBE_MAX_MS', async () => {
    expect(IDLE).toBeLessThanOrEqual(LIFECYCLE_IDLE_PROBE_MAX_MS);
    expect(IDLE).toBeGreaterThan(LIFECYCLE_ACTIVE_PROBE_MS * 10);
    const world = createTmuxWorld();
    watch(world);
    await vi.advanceTimersByTimeAsync(TO_IDLE);
    resetCalls(world);

    const SPAN = 10 * LIFECYCLE_IDLE_PROBE_MAX_MS;
    await vi.advanceTimersByTimeAsync(SPAN);
    const rounds = asyncProbes(world);
    expect(rounds).toBeGreaterThanOrEqual(Math.floor(SPAN / LIFECYCLE_IDLE_PROBE_MAX_MS));
    expect(rounds).toBeLessThanOrEqual(Math.ceil(SPAN / IDLE) + 1);
    expect(syncProbes(world)).toBe(0);
  });

  it('keeps the fast cadence while the pane streams output (a turn in progress), then decays to idle', async () => {
    const world = createTmuxWorld();
    watch(world);
    const stream: any = vi.mocked(createReadStream).mock.results.at(-1)!.value;
    await vi.advanceTimersByTimeAsync(TO_IDLE);
    resetCalls(world);

    // A turn the worker did not type into (e.g. the CLI continuing on its own):
    // output alone never pulls a probe in, but once the scheduled idle probe
    // lands while output streams, the pane is on the 1s cadence.
    const TURN = LIFECYCLE_IDLE_PROBE_MAX_MS + 20_000;
    for (let t = 0; t < TURN; t += 500) {
      stream.emit('data', Buffer.from('⠋ Working…\r'));
      await vi.advanceTimersByTimeAsync(500);
      if (t === TURN - 20_000) resetCalls(world);
    }
    expect(asyncProbes(world)).toBeGreaterThanOrEqual(20_000 / LIFECYCLE_ACTIVE_PROBE_MS - 2);

    // Output stops: the short output window lapses and the pane is idle again.
    await vi.advanceTimersByTimeAsync(LIFECYCLE_OUTPUT_ACTIVITY_WINDOW_MS + LIFECYCLE_ACTIVE_PROBE_MS);
    resetCalls(world);
    await vi.advanceTimersByTimeAsync(5 * LIFECYCLE_IDLE_PROBE_MAX_MS);
    expect(asyncProbes(world)).toBeLessThanOrEqual(Math.ceil(5 * LIFECYCLE_IDLE_PROBE_MAX_MS / IDLE) + 1);
  });

  it('an isolated repaint of an idle CLI (e.g. a statusline refresh every 60s) adds no probes', async () => {
    const world = createTmuxWorld();
    watch(world);
    const stream: any = vi.mocked(createReadStream).mock.results.at(-1)!.value;
    await vi.advanceTimersByTimeAsync(TO_IDLE);
    resetCalls(world);
    const SPAN = 10 * 60_000;
    for (let t = 0; t < SPAN; t += 60_000) {
      stream.emit('data', Buffer.from('\x1b[s\x1b[50;1H~/repo  main  12:34\x1b[u'));
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(asyncProbes(world) + syncProbes(world)).toBeLessThanOrEqual(Math.ceil(SPAN / IDLE) + 1);
  });

  it('a write pulls an idle-scheduled probe forward to the fast cadence', async () => {
    const world = createTmuxWorld();
    const { be } = watch(world);
    await vi.advanceTimersByTimeAsync(TO_IDLE);
    resetCalls(world);

    expect(be.sendText('hello')).toBe(true);
    await vi.advanceTimersByTimeAsync(LIFECYCLE_ACTIVE_PROBE_MS + 100);
    expect(asyncProbes(world)).toBe(1);
    await vi.advanceTimersByTimeAsync(5 * LIFECYCLE_ACTIVE_PROBE_MS);
    expect(asyncProbes(world)).toBeGreaterThanOrEqual(5);
  });

  it('a pane that dies while ACTIVE is torn down on the old schedule: 3 misses + final check, real exit code', async () => {
    const world = createTmuxWorld();
    const { exits } = watch(world);
    world.pane = { dead: '77' };

    // Misses at the first round and 3s later: the debounce rides them out.
    await vi.advanceTimersByTimeAsync(INITIAL + 3_000 + 100);
    expect(exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(9_000 + 1_000);
    expect(exits).toEqual([[77, null]]);
    expect(syncProbes(world)).toBe(0);
  });

  it('a pane that dies while IDLE is torn down within the idle cadence + the same debounce', async () => {
    const world = createTmuxWorld();
    const { exits } = watch(world);
    await vi.advanceTimersByTimeAsync(TO_IDLE);
    world.pane = { dead: '77' };

    await vi.advanceTimersByTimeAsync(LIFECYCLE_IDLE_PROBE_MAX_MS + DEBOUNCE);
    expect(exits).toEqual([[77, null]]);
    expect(syncProbes(world)).toBe(0);
  });

  it('a pane that vanishes (empty pane id) is debounced the same way', async () => {
    const world = createTmuxWorld();
    const { exits } = watch(world);
    world.pane = 'gone';
    await vi.advanceTimersByTimeAsync(INITIAL + 3_000 + 100);
    expect(exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(9_000 + 1_000);
    expect(exits).toEqual([[1, null]]);
    expect(syncProbes(world)).toBe(0);
  });

  it('does NOT detach on transient misses that recover, nor when the final lenient check succeeds', async () => {
    const world = createTmuxWorld();
    let misses = 3; // three missing rounds, then the final confirm finds the pane
    world.override = (args, via) => {
      if (via === 'async' && isLivenessRead(args) && misses > 0) {
        misses -= 1;
        return '::::111\n';
      }
      return undefined;
    };
    const { exits } = watch(world);
    await vi.advanceTimersByTimeAsync(INITIAL + 30_000);
    expect(exits).toEqual([]);
    expect(logged('recovered on final check')).toBe(true);
    expect(syncProbes(world)).toBe(0);
  });

  // 2026-08-20: a stalled shared server refuses connects instantly. A clean
  // exit-1 + connection-level stderr must read as UNKNOWN, never as an
  // authoritative miss — misreading it tore down every live session of every bot.
  it.each([
    ['connection refused', CONNECTION_REFUSED],
    ['lost server', LOST_SERVER],
  ])('never counts a connection-level failure (%s) as pane-gone', async (_label, failure) => {
    const world = createTmuxWorld();
    const { exits } = watch(world);
    world.failAll = failure;
    await vi.advanceTimersByTimeAsync(INITIAL + 50_000); // inside the 60s outage window
    expect(exits).toEqual([]);
    expect(logged('keeping managed session attached')).toBe(true);
    expect(syncProbes(world)).toBe(0);
  });

  it.each([
    ['probe deadline', DEADLINE],
    ['spawn EMFILE', EMFILE],
  ])('never detaches when probes get no answer (%s): unknown, not missing', async (_label, failure) => {
    const world = createTmuxWorld();
    const { exits } = watch(world);
    world.failAll = failure;
    await vi.advanceTimersByTimeAsync(INITIAL + 120_000);
    expect(exits).toEqual([]);
    expect(logged('keeping managed session attached')).toBe(true);
    expect(syncProbes(world)).toBe(0);
  });

  it('escalates only after the server is continuously unreachable for 60s — bounded even on an idle pane', async () => {
    const world = createTmuxWorld();
    const { exits } = watch(world);
    await vi.advanceTimersByTimeAsync(TO_IDLE);
    world.failAll = CONNECTION_REFUSED;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exits).toEqual([]);
    // First failure seen ≤ one idle period in, escalation on the first round
    // ≥ 60s after it: ≤ 60s + two idle periods overall.
    await vi.advanceTimersByTimeAsync(2 * LIFECYCLE_IDLE_PROBE_MAX_MS);
    expect(exits).toEqual([[1, null]]);
    expect(logged('continuously unreachable')).toBe(true);
    expect(syncProbes(world)).toBe(0);
  });

  it('an outage on an idle pane does not raise its probe rate (no extra load on a struggling server)', async () => {
    const world = createTmuxWorld();
    watch(world);
    await vi.advanceTimersByTimeAsync(TO_IDLE);
    resetCalls(world);
    world.failAll = DEADLINE;
    const SPAN = 4 * LIFECYCLE_IDLE_PROBE_MAX_MS;
    await vi.advanceTimersByTimeAsync(SPAN);
    // Every liveness read, sync or async, counts against the struggling server.
    expect(asyncProbes(world) + syncProbes(world)).toBeLessThanOrEqual(Math.ceil(SPAN / IDLE) + 1);
  });

  it('stays attached when panes read missing but the server itself does not answer (cross-check)', async () => {
    const world = createTmuxWorld({ pane: 'gone' });
    world.override = args => (args[0] === 'list-sessions' ? CONNECTION_REFUSED : undefined);
    const { exits } = watch(world);
    world.pane = 'gone';
    await vi.advanceTimersByTimeAsync(INITIAL + 13_000);
    expect(exits).toEqual([]);
    expect(logged('treating as server outage')).toBe(true);
    expect(syncProbes(world)).toBe(0);
  });

  it('tears down when panes read missing AND the server answers it is not running (sole-session socket)', async () => {
    const world = createTmuxWorld();
    const { exits } = watch(world);
    world.failAll = NO_SERVER;
    // Inside the ~12s debounce + slack, far short of the 60s escalation clock.
    await vi.advanceTimersByTimeAsync(INITIAL + DEBOUNCE + 2_000);
    expect(exits).toEqual([[1, null]]);
    expect(logged('pane gone after')).toBe(true);
    expect(logged('treating as server outage')).toBe(false);
    expect(syncProbes(world)).toBe(0);
  });

  // #2434: a corpse's code is latched by the probe that confirms death, so a
  // terminal read that a starved tmux no longer answers cannot turn 77 into 1.
  it('reports the code latched when a probe confirmed the corpse, even if the terminal read is starved', async () => {
    const world = createTmuxWorld({ pane: { dead: '77' } });
    world.override = (args, via) => (
      via === 'sync' && args.includes('display-message') && String(args.at(-1)).startsWith('#{pane_dead}')
        ? DEADLINE : undefined
    );
    const { exits } = watch(world);
    await vi.advanceTimersByTimeAsync(INITIAL + DEBOUNCE);
    expect(exits).toEqual([[77, null]]);
    expect(syncProbes(world)).toBe(0);
  });

  it('waits out the 1: → 1:<code> publish gap without blocking, then reports the real code', async () => {
    const world = createTmuxWorld({ pane: { dead: '' } });
    let deathReads = 0;
    world.override = (args, via) => {
      if (via === 'async' && args.includes('display-message') && String(args.at(-1)).startsWith('#{pane_dead}')) {
        deathReads += 1;
        if (deathReads >= 3) world.pane = { dead: '9' };
      }
      return undefined;
    };
    const { exits } = watch(world);
    await vi.advanceTimersByTimeAsync(INITIAL + DEBOUNCE);
    expect(exits).toEqual([[9, null]]);
    expect(deathReads).toBeGreaterThanOrEqual(3);
    expect(syncProbes(world)).toBe(0);
  });

  // #2453: tmux never publishes the status of a pane it has not reaped; the
  // probe takes it from the kernel's record of that zombie. A real unreaped
  // child stands in for the pane (python forks it and never waits).
  const python3 = ['/usr/bin/python3', '/bin/python3'].find(path => existsSync(path));
  it.skipIf(!python3 || process.platform !== 'linux')('latches a status tmux never published from the kernel at probe time (#2453)', async () => {
    vi.useRealTimers();
    const parent = spawn(python3!, ['-c', [
      'import os, sys, time',
      'pid = os.fork()',
      'if pid == 0: os._exit(3)',
      'time.sleep(0.2)',
      'print(pid, flush=True)',
      'sys.stdin.read()',
    ].join('\n')], { stdio: ['pipe', 'pipe', 'inherit'] });
    try {
      const [chunk] = await once(parent.stdout!, 'data') as [Buffer];
      vi.useFakeTimers();
      const corpse = `%1:1::${String(chunk).trim()}:${parent.pid}\n`;
      const world = createTmuxWorld({ pane: { dead: '' } });
      world.override = (args, via) => {
        if (via === 'async' && isLivenessRead(args)) return corpse;
        // Every other death read is starved: only the probe-time kernel read can carry the 3.
        if (args.includes('display-message') && String(args.at(-1)).startsWith('#{pane_dead}')) return DEADLINE;
        return undefined;
      };
      const { exits } = watch(world);
      await vi.advanceTimersByTimeAsync(INITIAL + DEBOUNCE);
      expect(exits).toEqual([[3, null]]);
      expect(syncProbes(world)).toBe(0);
    } finally {
      vi.useRealTimers();
      parent.stdin!.end();
      await once(parent, 'close');
    }
  });

  it('detects an adopted CLI pid exit within 1s even while the pane is probed at the idle cadence', async () => {
    let cliAlive = true;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
      if (pid === 4242 && signal === 0 && !cliAlive) {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
      return true;
    }) as typeof process.kill);
    try {
      const timersBefore = vi.getTimerCount();
      const world = createTmuxWorld();
      const { exits } = watch(world, '0:2.0', { cliPid: 4242 });
      const toIdle = tmuxLifecycleInitialDelayMs('0:2.0') + LIFECYCLE_ACTIVITY_WINDOW_MS + LIFECYCLE_IDLE_PROBE_MAX_MS;
      await vi.advanceTimersByTimeAsync(toIdle);
      resetCalls(world);
      const SPAN = 3 * LIFECYCLE_IDLE_PROBE_MAX_MS;
      await vi.advanceTimersByTimeAsync(SPAN);
      // The tmux probe went idle…
      expect(asyncProbes(world)).toBeLessThanOrEqual(Math.ceil(SPAN / tmuxLifecycleIdleProbeMs('0:2.0')) + 1);
      expect(exits).toEqual([]);

      // …but the pid check did not: the CLI returning to the user's shell is
      // still caught within a second, so Lark input never reaches that shell.
      cliAlive = false;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(exits).toEqual([[1, null]]);
      expect(logged('adopted CLI pid 4242 exited')).toBe(true);
      expect(syncProbes(world)).toBe(0);
      // Teardown stops the pid check too: a live interval would keep the
      // worker's event loop from draining after the session is gone.
      expect(vi.getTimerCount()).toBe(timersBefore);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('kill() while a probe is in flight: the late answer is dropped and the watcher stays stopped', async () => {
    const world = createTmuxWorld();
    const { be, exits } = watch(world);
    world.holdAsync = true;
    await vi.advanceTimersByTimeAsync(INITIAL);
    expect(world.held).toHaveLength(1); // the probe is waiting on tmux, the loop is free
    be.kill();
    world.pane = 'gone';
    world.holdAsync = false;
    for (const deliver of world.held.splice(0)) deliver();
    resetCalls(world);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exits).toEqual([]);
    expect(world.asyncCalls).toEqual([]);
    expect(world.syncCalls).toEqual([]);
  });

  it('kill() during a pending (sub-threshold) failure streak stops the watcher cleanly', async () => {
    const world = createTmuxWorld({ pane: 'alive' });
    const { be, exits } = watch(world);
    world.pane = 'gone';
    await vi.advanceTimersByTimeAsync(INITIAL + 1_000);
    expect(asyncProbes(world)).toBe(1);
    be.kill();
    resetCalls(world);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(exits).toEqual([]);
    expect(world.asyncCalls).toEqual([]);
  });

  it('a write that finds the corpse while a probe is in flight reports exactly one exit', async () => {
    const world = createTmuxWorld();
    const { be, exits } = watch(world);
    world.holdAsync = true;
    await vi.advanceTimersByTimeAsync(INITIAL);
    expect(world.held).toHaveLength(1);
    world.pane = { dead: '77' };
    expect(be.sendText('hello')).toBe(false);
    expect(exits).toEqual([[77, null]]);
    world.holdAsync = false;
    for (const deliver of world.held.splice(0)) deliver();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(exits).toEqual([[77, null]]);
  });

  /** With holdAsync enabled from the start, release exactly the three MAIN
   *  missing rounds. The next held callback is then the final confirmation,
   *  not the reachability command that follows it. */
  async function advanceThreeMissesToHeldFinal(world: TmuxWorld): Promise<void> {
    for (const delay of [INITIAL, 3_000, 9_000]) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(world.held).toHaveLength(1);
      for (const deliver of world.held.splice(0)) deliver();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(world.held).toHaveLength(1);
  }

  async function advanceToDeathCode(
    world: TmuxWorld,
    exits: Array<[number | null, string | null]>,
    code: number,
  ): Promise<void> {
    world.pane = { dead: String(code) };
    await vi.advanceTimersByTimeAsync(LIFECYCLE_ACTIVE_PROBE_MS + 12_000 + 100);
    expect(exits).toEqual([[code, null]]);
  }

  it.each(['write precheck', 'guardedSend follow-up probe'] as const)(
    'a newer exists from the %s invalidates an older in-flight final missing confirmation',
    async (evidencePath) => {
      const world = createTmuxWorld();
      let releaseFinalMissing = false;
      world.override = (args, via) => {
        if (via === 'async' && isLivenessRead(args) && releaseFinalMissing) return '::::111\n';
        if (evidencePath === 'guardedSend follow-up probe' && via === 'sync') {
          // Keep the write precheck inconclusive, then fail the write itself:
          // only guardedSend's follow-up sync probe supplies the live evidence.
          if (isLivenessRead(args) && String(args.at(-1)).endsWith('#{pane_in_mode}')) return DEADLINE;
          if (args[0] === 'send-keys') return { kind: 'exit', status: 1, stderr: 'transient write failure' };
        }
        return undefined;
      };
      const { be, exits } = watch(world);
      world.pane = 'gone';
      world.holdAsync = true;
      await advanceThreeMissesToHeldFinal(world);
      expect(world.asyncCalls.filter(isLivenessRead)).toHaveLength(4);
      expect(world.asyncCalls.some(args => args[0] === 'list-sessions')).toBe(false);
      expect(exits).toEqual([]);

      // A NEWER synchronous server answer proves the pane alive. In the first
      // case the write itself lands; in the second, guardedSend's post-failure
      // probe is the authoritative exists (the write is dropped, not the session).
      world.pane = 'alive';
      expect(be.sendText('newer-live-proof')).toBe(evidencePath === 'write precheck');

      // Release the OLDER final answer (missing), while the pane remains alive.
      // The old synchronous watcher could not interleave a write here; the async
      // watcher must explicitly invalidate this now-stale destructive sequence.
      releaseFinalMissing = true;
      world.holdAsync = false;
      for (const deliver of world.held.splice(0)) deliver();
      await vi.advanceTimersByTimeAsync(0);
      expect(exits).toEqual([]);

      // The live evidence must also RESET the gate, not merely suppress this
      // callback. One further miss is a new 1/3, not a fourth miss that goes
      // straight to another final confirmation and tears the live pane down.
      await vi.advanceTimersByTimeAsync(LIFECYCLE_ACTIVE_PROBE_MS + 10);
      expect(exits).toEqual([]);
    },
  );

  it('a newer live write invalidates an older missing chain while its server reachability check is in flight', async () => {
    const world = createTmuxWorld();
    const { be, exits } = watch(world);
    world.pane = 'gone';
    world.holdAsync = true;
    await advanceThreeMissesToHeldFinal(world);
    // Answer the final missing; the following reachability command stays held.
    for (const deliver of world.held.splice(0)) deliver();
    await vi.advanceTimersByTimeAsync(0);
    expect(world.held).toHaveLength(1);
    expect(world.asyncCalls.some(args => args[0] === 'list-sessions')).toBe(true);
    expect(exits).toEqual([]);

    world.pane = 'alive';
    expect(be.sendText('newer-live-proof')).toBe(true);
    world.holdAsync = false;
    for (const deliver of world.held.splice(0)) deliver();
    await vi.advanceTimersByTimeAsync(0);
    expect(exits).toEqual([]);

    world.pane = 'gone';
    await vi.advanceTimersByTimeAsync(LIFECYCLE_ACTIVE_PROBE_MS + 10);
    expect(exits).toEqual([]);
  });

  it('a newer exists drops the exit code latched by an invalidated death chain', async () => {
    const world = createTmuxWorld({ pane: { dead: '77' } });
    const { be, exits } = watch(world);
    world.holdAsync = true;
    await advanceThreeMissesToHeldFinal(world); // the old chain has latched 77

    world.pane = 'alive';
    expect(be.sendText('newer-live-proof')).toBe(true);
    world.override = (args, via) => (via === 'async' && isLivenessRead(args) ? '::::111\n' : undefined);
    world.holdAsync = false;
    for (const deliver of world.held.splice(0)) deliver();
    await vi.advanceTimersByTimeAsync(0);
    expect(exits).toEqual([]);

    world.override = undefined;
    await advanceToDeathCode(world, exits, 9);
  });

  it('a death-status capture from before a newer exists cannot relatch its old exit code', async () => {
    const world = createTmuxWorld({ pane: { dead: '' } });
    const { be, exits } = watch(world);
    world.holdAsync = true;
    await vi.advanceTimersByTimeAsync(INITIAL);
    for (const deliver of world.held.splice(0)) deliver(); // main probe: dead, status not published
    await vi.advanceTimersByTimeAsync(60); // cross the 50ms status poll sleep
    expect(world.held).toHaveLength(1); // the PANE_DEATH_FORMAT re-read is held
    expect(String(world.asyncCalls.at(-1)!.at(-1)).startsWith('#{pane_dead}')).toBe(true);

    world.pane = 'alive';
    expect(be.sendText('newer-live-proof')).toBe(true);
    world.override = (args, via) => (
      via === 'async' && String(args.at(-1)).startsWith('#{pane_dead}') ? '1:77:4242:111\n' : undefined
    );
    world.holdAsync = false;
    for (const deliver of world.held.splice(0)) deliver(); // late 77 belongs to the old chain
    await vi.advanceTimersByTimeAsync(0);
    expect(exits).toEqual([]);

    world.override = undefined;
    await advanceToDeathCode(world, exits, 9);
  });

  it.each([
    ['222', false],
    ['333', true],
  ] as const)('a newer write-side exists anchors server 222 before an old async exists returns (answering at death=%s)', async (answeringServerPid, expectedReplacement) => {
    const world = createTmuxWorld();
    world.override = (args, via) => (
      via === 'sync' && args.at(-1) === '#{pane_id} #{pid}' ? DEADLINE : undefined
    );
    const { be, exits } = watch(world); // attach-time server-pid anchor is unavailable
    world.override = undefined;
    world.holdAsync = true;
    await vi.advanceTimersByTimeAsync(INITIAL);
    expect(world.held).toHaveLength(1); // old async exists on server 111

    let releaseOldExists = false;
    world.override = (args, via) => (
      releaseOldExists && via === 'async' && isLivenessRead(args) ? '%1:0::4242:111\n' : undefined
    );
    world.serverPid = '222';
    expect(be.sendText('newer-live-proof')).toBe(true);
    releaseOldExists = true;
    world.holdAsync = false;
    for (const deliver of world.held.splice(0)) deliver();
    await vi.advanceTimersByTimeAsync(0);

    world.override = undefined;
    world.serverPid = answeringServerPid;
    await advanceToDeathCode(world, exits, 9);
    expect(be.exitedBecauseServerReplaced()).toBe(expectedReplacement);
  });

  it('an old async exists cannot backfill its server pid after a newer write-side exists', async () => {
    const world = createTmuxWorld();
    world.override = (args, via) => (
      via === 'sync' && args.at(-1) === '#{pane_id} #{pid}' ? DEADLINE : undefined
    );
    const { be, exits } = watch(world);
    world.holdAsync = true;
    await vi.advanceTimersByTimeAsync(INITIAL);
    expect(world.held).toHaveLength(1); // old async exists on server 111

    let releaseOldExists = false;
    world.override = (args, via) => {
      if (releaseOldExists && via === 'async' && isLivenessRead(args)) return '%1:0::4242:111\n';
      // The newer sync exists carries no server pid, so the anchor stays empty;
      // only the generation guard can prevent the older async 111 backfill.
      if (via === 'sync' && isLivenessRead(args) && String(args.at(-1)).endsWith('#{pane_in_mode}')) {
        return '%1:0::4242::0\n';
      }
      return undefined;
    };
    world.serverPid = '222';
    expect(be.sendText('newer-live-proof')).toBe(true);
    releaseOldExists = true;
    world.holdAsync = false;
    for (const deliver of world.held.splice(0)) deliver();
    await vi.advanceTimersByTimeAsync(0);

    world.override = undefined;
    await advanceToDeathCode(world, exits, 9);
    expect(be.exitedBecauseServerReplaced()).toBe(false);
  });

  // A refusal storm is intermittent: some connects are refused, some answered.
  // The 60s escalation must rest on a dense run of failures — on the idle
  // cadence 60s holds only ~3 samples, which "all fail" far more often than
  // ~9 do, and live sessions get torn down.
  it('escalates a connection outage on an idle pane only after a dense run of failed probes', async () => {
    const world = createTmuxWorld();
    const { exits } = watch(world);
    await vi.advanceTimersByTimeAsync(TO_IDLE);
    resetCalls(world);
    world.failAll = CONNECTION_REFUSED;
    let probesBeforeExit = -1;
    for (let t = 0; t < 3 * 60_000 && probesBeforeExit < 0; t += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000);
      if (exits.length > 0) probesBeforeExit = asyncProbes(world);
    }
    expect(exits).toEqual([[1, null]]);
    // 60s on the 3s/9s cadence: ≥ 1 + 1 + 6 rounds; on the idle cadence it was 3–4.
    expect(probesBeforeExit).toBeGreaterThanOrEqual(7);
  });

  it('kill() during the status capture of a corpse stops asking tmux at once', async () => {
    // Signal death: tmux never publishes a status and the kernel has none for
    // this pid, so the capture re-reads for its whole bounded budget.
    const world = createTmuxWorld({ pane: { dead: '' } });
    const { be } = watch(world);
    await vi.advanceTimersByTimeAsync(INITIAL + 120);
    expect(world.asyncCalls.filter(a => String(a.at(-1)).startsWith('#{pane_dead}')).length).toBeGreaterThan(0);
    be.kill();
    resetCalls(world);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(world.asyncCalls).toEqual([]);
    expect(world.syncCalls).toEqual([]);
  });

  it('writes during a missing streak do not squeeze the 3s/9s debounce (a 9s misread never tears down a live pane)', async () => {
    const world = createTmuxWorld();
    const { be, exits } = watch(world);
    await vi.advanceTimersByTimeAsync(TO_IDLE);
    // The pane is alive, but the watcher's reads see "no such pane" for 9s
    // while the worker keeps writing every 500ms (the writes themselves work).
    // The first write pulls the idle-scheduled probe in, so the misses come at
    // ~+1s and ~+4s; the debounce's third look (~+13s) must see the pane again.
    const misreadUntil = Date.now() + 9_000;
    world.override = (args, via) => (
      via === 'async' && isLivenessRead(args) && Date.now() < misreadUntil ? '::::111\n' : undefined
    );
    for (let t = 0; t < 30_000; t += 500) {
      expect(be.sendText('x')).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(exits).toEqual([]);
    // The watcher itself never read liveness synchronously (the reads the
    // writes make before themselves end in #{pane_in_mode}).
    expect(world.syncCalls.filter(a => isLivenessRead(a) && !String(a.at(-1)).endsWith('#{pane_in_mode}'))).toEqual([]);
  });

  // The 60s continuous-unreachable escalation carries the same
  // server-replacement classification as the missing streak: when the outage
  // ends with a DIFFERENT server answering the socket, the exit is not charged
  // to the CLI.
  it('classifies the 60s server-unreachable escalation as a server replacement when a different server answers', async () => {
    const world = createTmuxWorld({ serverPid: '111' });
    const { be, exits } = watch(world, 'bmx-outage');
    expect((be as unknown as { lastLiveServerPid?: number }).lastLiveServerPid).toBe(111);
    world.override = args => {
      if (args[0] === 'list-sessions' && args.includes('#{pid}')) return '222\n';
      if (args.includes('kill-session')) return '';
      return CONNECTION_REFUSED;
    };
    mockedExecSync.mockImplementation(() => { throw new Error('no server running'); });
    await vi.advanceTimersByTimeAsync(tmuxLifecycleInitialDelayMs('bmx-outage') + 60_000 + 2 * LIFECYCLE_IDLE_PROBE_MAX_MS);
    expect(exits).toHaveLength(1);
    expect(be.exitedBecauseServerReplaced()).toBe(true);
    expect(syncProbes(world)).toBe(0);
  });
});

describe('lifecycleProbeDelayMs', () => {
  const idleProbeMs = tmuxLifecycleIdleProbeMs('bmx-x');
  const delay = (recentlyActive: boolean, setbackStreak: number, lastState: 'exists' | 'missing' | 'unknown') =>
    lifecycleProbeDelayMs({ recentlyActive, idleProbeMs, setbackStreak, lastState });

  it('healthy: fast while active, the (slower, capped) idle cadence otherwise', () => {
    expect(delay(true, 0, 'exists')).toBe(LIFECYCLE_ACTIVE_PROBE_MS);
    expect(delay(false, 0, 'exists')).toBe(idleProbeMs);
    expect(idleProbeMs).toBeGreaterThan(LIFECYCLE_ACTIVE_PROBE_MS);
    expect(idleProbeMs).toBeLessThanOrEqual(LIFECYCLE_IDLE_PROBE_MAX_MS);
  });

  it('an authoritative miss confirms on the same backoff whether the pane was active or idle', () => {
    for (const streak of [1, 2, 3]) {
      expect(delay(false, streak, 'missing')).toBe(delay(true, streak, 'missing'));
      expect(delay(true, streak, 'missing')).toBeLessThan(idleProbeMs);
    }
    expect(delay(true, 2, 'missing')).toBeGreaterThan(delay(true, 1, 'missing'));
  });

  it('no answer never probes faster than the healthy cadence (outage load shedding)', () => {
    for (const streak of [1, 2, 5]) {
      expect(delay(false, streak, 'unknown')).toBeGreaterThanOrEqual(delay(false, 0, 'exists'));
      expect(delay(true, streak, 'unknown')).toBeGreaterThanOrEqual(delay(true, 0, 'exists'));
    }
  });

  it('spreads idle cadences across targets (no lock-step after a mass restore)', () => {
    const cadences = new Set(Array.from({ length: 50 }, (_, i) => tmuxLifecycleIdleProbeMs(`bmx-${i}`)));
    expect(cadences.size).toBeGreaterThan(25);
    for (const c of cadences) expect(c).toBeLessThanOrEqual(LIFECYCLE_IDLE_PROBE_MAX_MS);
  });
});

describe('TmuxPipeBackend send failure handling', () => {
  // Regression: a CLI that exits mid-write destroys its tmux session, so the
  // next `tmux send-keys` returns exit 1. Previously execFileSync's throw
  // propagated through writeInput → flushPending (fire-and-forget async) →
  // unhandledRejection and killed the whole worker. The send methods must
  // never throw: pane-gone is converted to a normal onExit, a transient
  // failure on a live pane is logged and dropped.
  it('fires onExit (does NOT throw) when send-keys fails and the pane is gone', () => {
    const be = new TmuxPipeBackend('bmx-dead', { ownsSession: true });
    const exits: Array<[number | null, string | null]> = [];
    be.onExit((c, s) => exits.push([c, s]));
    be.spawn('', [], spawnOpts());

    // The actual send-keys (execFileSync) fails…
    mockedExecFileSync.mockImplementation((_bin: any, args: any) => {
      if ((args as string[]).includes('send-keys')) throw new Error('no server running');
      return '' as any;
    });
    // …and the liveness probe (execSync display-message) also fails ⇒ pane GONE.
    mockedExecSync.mockImplementation(() => { throw new Error('no server running'); });

    expect(() => be.sendSpecialKeys('Enter')).not.toThrow();
    expect(exits).toEqual([[1, null]]);
  });

  /** A world-model backend for the write-path cases (helpers/tmux-world.ts). */
  function writeWorld(target: string, world: TmuxWorld) {
    installTmuxWorld(world, { execFileSync: mockedExecFileSync, execFile: vi.mocked(execFile) });
    const be = new TmuxPipeBackend(target, { ownsSession: true });
    const exits: Array<[number | null, string | null]> = [];
    be.onExit((c, s) => exits.push([c, s]));
    be.spawn('', [], spawnOpts());
    world.syncCalls.length = 0;
    world.asyncCalls.length = 0;
    return { be, exits };
  }
  const isWriteCheck = (args: readonly string[]) => isLivenessRead(args) && String(args.at(-1)).endsWith('#{pane_in_mode}');
  const writeArgv = (world: TmuxWorld) => world.syncCalls.filter(a => ['send-keys', 'load-buffer', 'paste-buffer'].includes(a[0]));

  it('drops the write (no throw, no exit) when send-keys fails but the pane is alive — one tmux command to tell', () => {
    const world = createTmuxWorld();
    world.override = args => (args[0] === 'send-keys' ? { kind: 'exit', status: 1, stderr: 'transient tmux error' } : undefined);
    const { be, exits } = writeWorld('bmx-live', world);

    expect(() => be.sendText('hi')).not.toThrow();
    expect(exits).toEqual([]);
    // The read before the write + ONE follow-up liveness probe (it used to
    // read #{pane_id} and then #{pane_dead} separately).
    expect(world.syncCalls.filter(a => a.includes('display-message'))).toHaveLength(2);
  });

  it('drops the write without teardown when the follow-up pane probe is unknown', () => {
    const world = createTmuxWorld();
    world.override = args => {
      if (args[0] === 'send-keys') return { kind: 'exit', status: 1, stderr: 'tmux write timed out' };
      if (isLivenessRead(args) && !isWriteCheck(args)) return EMFILE;
      return undefined;
    };
    const { be, exits } = writeWorld('bmx-busy', world);

    expect(() => be.sendText('hi')).not.toThrow();
    expect(exits).toEqual([]);
    expect(world.syncCalls.filter(a => isLivenessRead(a) && !isWriteCheck(a))).toHaveLength(1);
  });

  // send-keys into a corpse exits 0 and the keys vanish; paste-buffer into one
  // crashes the WHOLE server on tmux <= 3.3a. The read every write already
  // makes now sees the corpse, so nothing is written and the exit is reported
  // with the real code — without waiting for the (possibly idle) watcher.
  it.each([
    ['sendText', (be: TmuxPipeBackend) => be.sendText('hello')],
    ['sendSpecialKeys', (be: TmuxPipeBackend) => be.sendSpecialKeys('Enter')],
    ['sendLines', (be: TmuxPipeBackend) => be.sendLines(['a', 'b'], 'S-Enter')],
    ['pasteText', (be: TmuxPipeBackend) => be.pasteText('hello')],
    ['submitBracketedPaste', (be: TmuxPipeBackend) => be.submitBracketedPaste('hello')],
  ])('%s refuses a corpse before anything reaches the pane and reports its real exit code', (_label, write) => {
    const world = createTmuxWorld();
    const { be, exits } = writeWorld('bmx-corpse', world);
    world.pane = { dead: '77' };

    expect(write(be)).toBe(false);
    expect(writeArgv(world)).toEqual([]);
    expect(exits).toEqual([[77, null]]);
    // Same single read as before (it already served copy-mode): no added command.
    expect(world.syncCalls.filter(isWriteCheck)).toHaveLength(1);
  });

  // paste-buffer into a corpse crashes the whole server on tmux <= 3.3a. The
  // read before the write can fail (a slow server) and the pane can die right
  // after it, so the paste itself only runs behind `#{pane_dead}` in the same
  // tmux queue.
  it.each([
    ['pasteText', 'the read before the write times out', 'timeout'],
    ['pasteText', 'the pane dies between that read and the paste', 'dies-after-read'],
    ['submitBracketedPaste', 'the read before the write times out', 'timeout'],
    ['submitBracketedPaste', 'the pane dies between that read and the paste', 'dies-after-read'],
  ])('%s never pastes into a corpse when %s', (method, _label, mode) => {
    const world = createTmuxWorld();
    const { be, exits } = writeWorld('bmx-paste-race', world);
    if (mode === 'timeout') {
      world.pane = { dead: '77' };
      world.override = args => (isWriteCheck(args) ? DEADLINE : undefined);
    } else {
      world.override = args => {
        if (!isWriteCheck(args)) return undefined;
        world.override = undefined;
        world.pane = { dead: '77' };
        return '%1:0::4242:111:0\n'; // read while still alive
      };
    }
    const paste = method === 'pasteText' ? be.pasteText('hello') : be.submitBracketedPaste('hello');
    expect(paste).toBe(false);
    expect(world.serverCrashed).toBe(false);
    expect(world.pastes).toEqual([]);
    expect(exits).toEqual([[77, null]]);
    // The loaded buffer is not left behind.
    expect(world.syncCalls.some(a => a[0] === 'delete-buffer')).toBe(true);
  });

  it('a guarded paste into a live pane still lands between the bracketed-paste markers', () => {
    const world = createTmuxWorld();
    const { be, exits } = writeWorld('bmx-paste-live', world);
    expect(be.submitBracketedPaste('hello')).toBe(true);
    expect(world.pastes).toHaveLength(1);
    expect(world.pastes[0]).toEqual(expect.arrayContaining(['paste-buffer', '-t', 'bmx-paste-live', '-r']));
    const batch = world.syncCalls.find(a => a.some(arg => arg.startsWith('"paste-buffer"')))!;
    expect(batch.indexOf('\x1b[200~')).toBeLessThan(batch.indexOf('if-shell'));
    expect(batch.indexOf('if-shell')).toBeLessThan(batch.indexOf('\x1b[201~'));
    expect(exits).toEqual([]);
  });

  it('a write into a vanished pane still fails at once while the watcher sits on the idle cadence', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const world = createTmuxWorld();
      const { be, exits } = writeWorld('bmx-idle-write', world);
      await vi.advanceTimersByTimeAsync(
        tmuxLifecycleInitialDelayMs('bmx-idle-write') + LIFECYCLE_ACTIVITY_WINDOW_MS + LIFECYCLE_IDLE_PROBE_MAX_MS,
      );
      world.asyncCalls.length = 0;
      const span = 3 * LIFECYCLE_IDLE_PROBE_MAX_MS;
      await vi.advanceTimersByTimeAsync(span);
      // Idle: the watcher asks tmux rarely now…
      expect(world.asyncCalls.filter(isLivenessRead).length)
        .toBeLessThanOrEqual(Math.ceil(span / tmuxLifecycleIdleProbeMs('bmx-idle-write')) + 1);
      expect(world.syncCalls.filter(isLivenessRead)).toEqual([]);

      // …and a write does not wait for it: send-keys fails "can't find pane",
      // guardedSend's own probe answers missing, the exit fires synchronously.
      world.pane = 'gone';
      expect(be.sendText('hi')).toBe(false);
      expect(exits).toEqual([[1, null]]);
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('dumps the piped output tail (CLI final stdout/stderr) when the pane is gone', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const be = new TmuxPipeBackend('bmx-dead3', { ownsSession: true });
      be.spawn('', [], spawnOpts());
      // Drive the fifo data handler so recentOutput holds the CLI's last bytes.
      const stream: any = vi.mocked(createReadStream).mock.results.at(-1)!.value;
      stream.emit('data', Buffer.from('Error: gateway 502 — model unavailable\n'));

      mockedExecFileSync.mockImplementation((_bin: any, args: any) => {
        if ((args as string[]).includes('send-keys')) throw new Error('no server running');
        return '' as any;
      });
      mockedExecSync.mockImplementation(() => { throw new Error('no server running'); });

      be.sendSpecialKeys('Enter');

      const dumped = errSpy.mock.calls.map(c => String(c[0])).join('');
      expect(dumped).toContain('CLI last output before exit');
      expect(dumped).toContain('gateway 502 — model unavailable');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('paste failure with a gone pane fires onExit instead of throwing', () => {
    const be = new TmuxPipeBackend('bmx-dead2', { ownsSession: true });
    const exits: Array<[number | null, string | null]> = [];
    be.onExit((c, s) => exits.push([c, s]));
    be.spawn('', [], spawnOpts());

    mockedExecFileSync.mockImplementation((_bin: any, args: any) => {
      if ((args as string[]).includes('load-buffer') || (args as string[]).includes('paste-buffer')) {
        throw new Error('no server running');
      }
      return '' as any;
    });
    mockedExecSync.mockImplementation(() => { throw new Error('no server running'); });

    expect(() => be.pasteText('hello')).not.toThrow();
    expect(exits).toEqual([[1, null]]);
  });

  // handlePaneExit reap gate (#2408): the three-way verdict decides whether
  // killDeadPaneRemnant runs. The pure resolvePaneDeath tests pin the verdict;
  // these cases pin the WIRING — which verdicts actually issue kill-session.
  // Entry is guardedSend (a paste whose pane probes authoritatively missing),
  // no extra test seam is opened: handlePaneExit stays private.
  const runReapCase = (opts: { owns: boolean; deathAnswer: string | 'unreadable' }) => {
    const be = new TmuxPipeBackend('bmx-reap', { ownsSession: opts.owns });
    const exits: Array<[number | null, string | null]> = [];
    be.onExit((c, s) => exits.push([c, s]));
    be.spawn('', [], spawnOpts());

    const deathReads: number[] = [];
    mockedExecFileSync.mockImplementation(((_bin: any, args: any) => {
      const a = Array.isArray(args) ? (args as string[]) : [];
      if (a.includes('load-buffer') || a.includes('paste-buffer')) {
        throw Object.assign(new Error('gone'), {
          status: 1, signal: null, stderr: Buffer.from("can't find pane: bmx-reap"),
        });
      }
      // The terminal death read is the display-message whose format STARTS
      // with '#{pane_dead}'; the liveness probe (and the pre-write read)
      // start with '#{pane_id}' and are answered separately below.
      if (a.includes('display-message') && String(a.at(-1)).startsWith('#{pane_dead}')) {
        deathReads.push(Date.now());
        if (opts.deathAnswer === 'unreadable') throw new Error('tmux client timeout');
        return Buffer.from(opts.deathAnswer as string) as any;
      }
      // pane_id answers empty -> probePaneAddressability: 'empty pane id'
      // -> authoritative missing; kill-session answers success.
      return '' as any;
    }) as typeof execFileSync);
    mockedExecSync.mockImplementation(() => { throw new Error('no server running'); });

    expect(() => be.pasteText('x')).not.toThrow();
    const killCalls = mockedExecFileSync.mock.calls
      .filter(([, a]) => (a as string[]).includes('kill-session'));
    return { exits, killCalls, deathReads };
  };

  it('handlePaneExit reaps the remnant ONCE when death is confirmed with a real code (77)', () => {
    const { exits, killCalls, deathReads } = runReapCase({ owns: true, deathAnswer: '1:77' });
    expect(killCalls).toHaveLength(1); // #2408 corpse would otherwise leak here
    expect(exits).toEqual([[77, null]]);
    expect(deathReads).toHaveLength(1); // a coded death is adopted without re-reads
  });

  it('handlePaneExit reaps ONCE after the bounded re-reads all stay unreadable (unknown)', () => {
    const { exits, killCalls, deathReads } = runReapCase({ owns: true, deathAnswer: 'unreadable' });
    expect(killCalls).toHaveLength(1); // unknown still reaps: the pane was already authoritatively missing
    expect(exits).toEqual([[1, null]]); // no real code readable -> historic sentinel
    expect(deathReads.length).toBeGreaterThan(1); // retried instead of giving up on the first unreadable read
  });

  it('handlePaneExit does NOT kill a pane tmux explicitly answers alive (defense-in-depth)', () => {
    // No production path today lets an owned pane reach handlePaneExit while
    // tmux answers '0:' (every caller already holds an authoritative missing);
    // the real "CLI gone but pane alive" shape is an adopted CLI-pid ESRCH,
    // whose backend has ownsSession=false and reaps nothing below. This case
    // pins the guard itself: an explicit alive answer must never be killed.
    const { exits, killCalls, deathReads } = runReapCase({ owns: true, deathAnswer: '0:' });
    expect(killCalls).toHaveLength(0);
    expect(exits).toEqual([[1, null]]); // teardown still proceeds with the fallback code
    expect(deathReads).toHaveLength(1);
  });

  it('handlePaneExit never kill-sessions an adopted (user-owned) pane, even confirmed dead', () => {
    // The adopt counterpart of the managed reap: the pane belongs to the
    // user, botmux only observes it. Confirmed death still fires the exit,
    // the kill-session guard must hold.
    const { exits, killCalls } = runReapCase({ owns: false, deathAnswer: '1:77' });
    expect(killCalls).toHaveLength(0);
    expect(exits).toEqual([[77, null]]);
  });

  // Pane loss first detected from a FAILED WRITE (guardedSend) must carry the
  // same server-replacement classification as the watcher's missing streak:
  // the pid anchored at attach is compared with the server answering at
  // teardown. Pins the guardedSend call site of noteServerReplacedAtPaneLoss.
  it('guardedSend classifies a pane loss as a server replacement when a different server answers', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // During spawn the attach-time anchor read must see this pane alive on a
      // server with pid 111 (format '#{pane_id} #{pid}', same answer as a probe).
      mockedExecFileSync.mockImplementation(((_bin: any, args: any) => {
        const a = Array.isArray(args) ? (args as string[]) : [];
        if (a[0] === '-V') return 'tmux 3.3a';
        if (a.includes('display-message') && a.some(f => String(f) === '#{pane_id} #{pid}')) {
          return '%13 111' as any;
        }
        return '' as any;
      }) as typeof execFileSync);
      const be = new TmuxPipeBackend('bmx-replaced-send', { ownsSession: true });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((c, s) => exits.push([c, s]));
      be.spawn('', [], spawnOpts());
      expect((be as unknown as { lastLiveServerPid?: number }).lastLiveServerPid).toBe(111);

      mockedExecFileSync.mockImplementation(((_bin: any, args: any) => {
        const a = Array.isArray(args) ? (args as string[]) : [];
        if (a[0] === '-V') return 'tmux 3.3a';
        if (a.includes('load-buffer') || a.includes('paste-buffer')) {
          throw Object.assign(new Error('gone'), {
            status: 1, signal: null, stderr: Buffer.from("can't find pane: bmx-replaced-send"),
          });
        }
        // A DIFFERENT server (pid 222) now answers on the socket.
        if (a[0] === 'list-sessions' && a.includes('#{pid}')) return '222\n' as any;
        if (a.includes('display-message') && String(a.at(-1)).startsWith('#{pane_dead}')) {
          return '1:77' as any;
        }
        // Bare '#{pane_id}' answers empty -> authoritative missing; everything
        // else (kill-session remnant reap) succeeds.
        return '' as any;
      }) as typeof execFileSync);
      mockedExecSync.mockImplementation(() => { throw new Error('no server running'); });

      expect(() => be.pasteText('x')).not.toThrow();
      expect(be.exitedBecauseServerReplaced()).toBe(true);
      expect(exits).toEqual([[77, null]]);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('TmuxPipeBackend.kill', () => {
  it('cancels pipe-pane subscription and unlinks the fifo without firing onExit', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    let exitFired = false;
    be.onExit(() => { exitFired = true; });

    mockedExecSync.mockClear();
    be.kill();

    // The cancellation call: pipe-pane WITHOUT a shell command argument.
    const pipeCall = mockedExecSync.mock.calls
      .map(c => String(c[0]))
      .find(c => c.includes('pipe-pane'));
    expect(pipeCall).toBeDefined();
    expect(pipeCall).not.toContain('botmux-pipe-');  // no command = cancel
    expect(pipeCall).toContain("'0:2.0'");

    expect(mockedUnlinkSync).toHaveBeenCalledWith(expect.stringMatching(/botmux-pipe-.*\.fifo/));
    expect(exitFired).toBe(false);
  });

  it('is idempotent (second kill is a no-op)', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    be.kill();
    mockedExecSync.mockClear();
    mockedUnlinkSync.mockClear();
    be.kill();
    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(mockedUnlinkSync).not.toHaveBeenCalled();
  });

  it('post-kill writes are silently dropped', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    be.kill();
    mockedExecFileSync.mockClear();
    be.sendText('after-kill');
    be.sendSpecialKeys('Enter');
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });
});

describe('TmuxPipeBackend.onData', () => {
  function lastStream() {
    return vi.mocked(createReadStream).mock.results.at(-1)!.value as any;
  }

  it('forwards a whole fifo chunk to registered listeners', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    const received: string[] = [];
    be.onData(d => received.push(d));

    lastStream().emit('data', Buffer.from('hello 你好\n', 'utf8'));
    expect(received).toEqual(['hello 你好\n']);
  });

  it('reassembles a multi-byte char split across two chunks (no U+FFFD)', () => {
    // Regression: the fifo emits raw Buffers at libuv's 64KB highWaterMark,
    // which can fall mid-character. Decoding each chunk independently with
    // chunk.toString('utf8') split one wide glyph into replacement chars and
    // shifted every following column — the intermittent web-terminal "错位"
    // during CLI re-renders. StringDecoder must buffer the partial bytes.
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    const received: string[] = [];
    be.onData(d => received.push(d));

    // `┌`(0xE2 0x94 0x8C) and `─`(0xE2 0x94 0x80) are 3 bytes each. Cut one
    // byte into `─` so that character straddles the chunk boundary, exactly
    // like a 64KB split during a full-screen redraw.
    const full = Buffer.from('┌─┐', 'utf8');
    const stream = lastStream();
    stream.emit('data', full.subarray(0, 4)); // `┌` + first byte of `─`
    stream.emit('data', full.subarray(4));    // remaining bytes of `─` + `┐`

    const joined = received.join('');
    expect(joined).toBe('┌─┐');
    expect(joined).not.toContain('�');
  });
});

describe('TmuxPipeBackend fifo fd ownership', () => {
  it('closes only the wake fd after handing the read fd to ReadStream', () => {
    mockedOpenSync.mockReturnValueOnce(71).mockReturnValueOnce(72);
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    const stream = vi.mocked(createReadStream).mock.results.at(-1)!.value;

    be.kill();
    be.kill();

    expect(stream.destroy).toHaveBeenCalledTimes(1);
    expect(mockedWriteSync.mock.calls).toEqual([[72, '\0']]);
    expect(mockedCloseSync.mock.calls).toEqual([[72]]);
  });

  it('closes the read fd itself if acquiring the wake fd fails before stream creation', () => {
    mockedOpenSync.mockReturnValueOnce(71).mockImplementationOnce(() => {
      throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
    });
    vi.mocked(createReadStream).mockClear();
    const be = new TmuxPipeBackend('0:2.0');

    expect(() => be.spawn('', [], spawnOpts())).toThrow(/EMFILE/);

    expect(createReadStream).not.toHaveBeenCalled();
    expect(mockedCloseSync.mock.calls).toEqual([[71]]);
    expect(mockedWriteSync).not.toHaveBeenCalled();
    expect(mockedUnlinkSync).toHaveBeenCalledWith(expect.stringMatching(/botmux-pipe-.*\.fifo/));
  });
});

describe('TmuxPipeBackend legacy child reaper on reattach', () => {
  const socketName = 'legacy-reaper-test';
  const target = 'bmx-legacy-reaper';
  const jobCalls = () => mockedExecFileSync.mock.calls.filter(([, args]) => (
    Array.isArray(args) && args.includes('run-shell')
  ));

  function emulateDeath(opts: {
    version: string;
    line?: string;
    firstUnreadable?: boolean;
    publishAfterJob?: boolean;
    jobFails?: boolean;
    publishAfterReads?: number;
    versionAfterOptions?: string;
  }) {
    let reads = 0;
    let jobRan = false;
    let version = opts.version;
    mockedExecFileSync.mockImplementation(((_bin: unknown, args: string[]) => {
      if (args[0] === '-V') return version;
      if (args.includes('#{session_attached}') && opts.versionAfterOptions) {
        // applySessionOptions already installed legacy `on`. A version-cache
        // refresh before the corpse probe must not change that applied mode.
        version = opts.versionAfterOptions;
        resetTmuxVersionCacheForTests();
        getTmuxVersionCached();
        return '1';
      }
      if (args.includes('run-shell')) {
        jobRan = true;
        if (opts.jobFails) throw Object.assign(new Error('job deadline'), { code: 'ETIMEDOUT' });
        return '';
      }
      if (args.includes('#{pane_dead}:#{pane_dead_status}:#{pane_pid}:#{pid}')) {
        reads += 1;
        if (opts.firstUnreadable && reads === 1) throw Object.assign(new Error('probe deadline'), { code: 'ETIMEDOUT' });
        if (opts.publishAfterJob && jobRan) return '1:0:111:222';
        if (opts.publishAfterReads && reads >= opts.publishAfterReads) return '1:77:111:222';
        const raw = opts.line ?? '1:';
        // Resolver splits four fields; pad the short legacy answers.
        return raw.includes(':') && raw.split(':')[1] !== '' ? raw
          : raw === '1:' ? '1::111:222' : raw;
      }
      return '';
    }) as typeof execFileSync);
  }

  function reattach() {
    const backend = new TmuxPipeBackend(target, { ownsSession: true, isReattach: true, socketName });
    backend.spawn('', [], {
      ...spawnOpts(), env: { ...process.env, BOTMUX_CODEX_INSTANCE_BINDING: '' } as Record<string, string>,
    });
    // Match the worker: subscribe only after spawn() returns, including its
    // synchronous corpse-refusal path. The resulting exit must be sticky.
    const exits: Array<number | null> = [];
    backend.onExit(code => exits.push(code));
    return { backend, exits };
  }

  it.each([
    { label: 'old version', version: 'tmux 2.8', firstUnreadable: false },
    { label: 'unknown version after an unreadable first probe', version: 'tmux unknown', firstUnreadable: true },
    { label: 'unknown version refreshed to modern', version: 'tmux unknown', firstUnreadable: true, versionAfterOptions: 'tmux 3.4' },
  ])('recovers exit 0 from a lost SIGCHLD ($label)', opts => {
    emulateDeath({ ...opts, publishAfterJob: true });
    const { backend, exits } = reattach();
    try {
      expect(exits).toEqual([0]);
      expect(jobCalls()).toHaveLength(1);
      expect(jobCalls()[0]).toEqual([
        'tmux', ['-L', socketName, 'run-shell', '-b', 'true'], expect.objectContaining({ timeout: expect.any(Number) }),
      ]);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux', ['-L', socketName, 'kill-session', '-t', target], expect.any(Object),
      );
    } finally { backend.kill(); }
  });

  it('nudges once for a signal death and keeps the status-less exit fallback', () => {
    emulateDeath({ version: 'tmux 2.8' });
    const { backend, exits } = reattach();
    try {
      expect(exits).toEqual([1]);
      expect(jobCalls()).toHaveLength(1);
    } finally { backend.kill(); }
  });

  it('recovers the status when applying on loses its client reply', () => {
    emulateDeath({ version: 'tmux 2.8', publishAfterJob: true });
    mockedExecSync.mockImplementation(((cmd: string) => {
      if (cmd.includes('remain-on-exit on')) {
        throw Object.assign(new Error('option reply deadline'), { code: 'ETIMEDOUT' });
      }
      return Buffer.from('');
    }) as typeof execSync);
    const { backend, exits } = reattach();
    try {
      expect(exits).toEqual([0]);
      expect(jobCalls()).toHaveLength(1);
    } finally { backend.kill(); }
  });

  it('still reads the real status when the nudge itself fails', () => {
    emulateDeath({ version: 'tmux 2.8', jobFails: true, publishAfterReads: 2 });
    const { backend, exits } = reattach();
    try {
      expect(exits).toEqual([77]);
      expect(jobCalls()).toHaveLength(1);
    } finally { backend.kill(); }
  });

  it.each([
    { version: 'tmux 3.2', line: '1::111:222', exits: [1] },
    { version: 'tmux 2.8', line: '0::111:222', exits: [] },
    { version: 'tmux 2.8', line: '1:77:111:222', exits: [77] },
    { version: 'tmux 2.8', line: '', exits: [] },
  ])('does not nudge $version when the death probe returns "$line"', opts => {
    emulateDeath(opts);
    const { backend, exits } = reattach();
    try {
      expect(exits).toEqual(opts.exits);
      expect(jobCalls()).toHaveLength(0);
    } finally { backend.kill(); }
  });
});

describe('TmuxPipeBackend pipe-pane death evidence', () => {
  const isDeadProbe = (args: any) =>
    Array.isArray(args) && args.includes('display-message')
    && args.some((a: unknown) => String(a).includes('#{pane_dead}'));

  it('surfaces a readable "CLI died instantly" message with exit status and last screen', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      mockedExecSync.mockImplementation(((cmd: any) => {
        if (String(cmd).includes('pipe-pane')) {
          throw Object.assign(new Error('Command failed: tmux pipe-pane -O -t 0:2.0'), {
            status: 1,
            signal: null,
            stderr: Buffer.from("can't find pane: 0:2.0"),
          });
        }
        return Buffer.from('') as any;
      }) as any);
      mockedExecFileSync.mockImplementation(((_bin: any, args: any) => {
        if (isDeadProbe(args)) return '1:137\n' as any;
        if (Array.isArray(args) && args.includes('capture-pane')) {
          return '\x1b[2J$ /usr/local/bin/claude: command not found\r\n' as any;
        }
        return '' as any;
      }) as any);

      // FRESH create whose CLI died instantly: startup-failure message, no
      // process-exit event (it never came up).
      emulateQueuedSubscription();
      const be = new TmuxPipeBackend('0:2.0', { createSession: true, ownsSession: true });
      const exits: unknown[] = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      let thrown: unknown;
      try {
        be.spawn('', [], spawnOpts());
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain('启动后立即退出');
      expect(message).toContain('status=137');
      expect(message).toContain('最后一屏');
      expect(message).toContain('command not found');
      // The raw pipe-pane error's first line is retained.
      expect(message).toContain('Command failed: tmux pipe-pane');
      // Startup failure path: throws the readable error and emits NO process
      // exit event (the CLI never started; #2408 keeps it off crash-restart).
      expect(exits).toEqual([]);
    } finally {
      errSpy.mockRestore();
    }
  });

  // #2453 on the startup path: tmux had not reaped the instantly-dead CLI, so
  // the pane read dead-without-status and the message blamed a possible signal
  // death for what was a plain `exit 3`. A real unreaped child stands in for
  // the pane process (python forks it and never waits).
  const python3 = ['/usr/bin/python3', '/bin/python3'].find(path => existsSync(path));
  it.skipIf(!python3 || process.platform !== 'linux')('reports the exit code of a CLI tmux has not reaped yet', async () => {
    const parent = spawn(python3!, ['-c', [
      'import os, sys, time',
      'pid = os.fork()',
      'if pid == 0: os._exit(3)',
      'time.sleep(0.2)',
      'print(pid, flush=True)',
      'sys.stdin.read()',
    ].join('\n')], { stdio: ['pipe', 'pipe', 'inherit'] });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const [chunk] = await once(parent.stdout!, 'data') as [Buffer];
      const corpse = `1::${String(chunk).trim()}:${parent.pid}\n`;
      mockedExecSync.mockImplementation(((cmd: any) => {
        if (String(cmd).includes('pipe-pane')) {
          throw Object.assign(new Error('Command failed: tmux pipe-pane -O -t 0:2.0'), {
            status: 1, signal: null, stderr: Buffer.from("can't find pane: 0:2.0"),
          });
        }
        return Buffer.from('') as any;
      }) as any);
      mockedExecFileSync.mockImplementation(((_bin: any, args: any) => (isDeadProbe(args) ? corpse : '')) as any);
      const be = new TmuxPipeBackend('0:2.0', { createSession: true, ownsSession: true });
      expect(() => be.spawn('', [], spawnOpts())).toThrow(/exit status=3/);
    } finally {
      errSpy.mockRestore();
      parent.stdin!.end();
      await once(parent, 'close');
    }
  });

  it('silently degrades to the raw error when both evidence probes fail (server-level outage)', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      mockedExecSync.mockImplementation(((cmd: any) => {
        if (String(cmd).includes('pipe-pane')) {
          throw Object.assign(new Error('Command failed: tmux pipe-pane -O -t 0:2.0'), {
            status: 1,
            signal: null,
            stderr: Buffer.from('error connecting to /tmp/tmux-0/default (Connection refused)'),
          });
        }
        return Buffer.from('') as any;
      }) as any);
      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error('connect failed'), { status: 1, signal: null });
      });

      const be = new TmuxPipeBackend('0:2.0');
      let thrown: unknown;
      try {
        be.spawn('', [], spawnOpts());
      } catch (err) {
        thrown = err;
      }

      // The raw error is rethrown; the evidence code itself never raises a
      // second exception or rewrites the message.
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('Command failed: tmux pipe-pane');
      expect((thrown as Error).message).not.toContain('启动后立即退出');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('keeps the raw error when the pane is still alive (pipe-pane failed for another reason)', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      mockedExecSync.mockImplementation(((cmd: any) => {
        if (String(cmd).includes('pipe-pane')) {
          throw Object.assign(new Error('Command failed: tmux pipe-pane -O -t 0:2.0'), {
            status: 1,
            signal: null,
            stderr: Buffer.from('weird pipe error'),
          });
        }
        return Buffer.from('') as any;
      }) as any);
      mockedExecFileSync.mockImplementation(((_bin: any, args: any) => {
        if (isDeadProbe(args)) return '0:\n' as any;
        return '' as any;
      }) as any);

      const be = new TmuxPipeBackend('0:2.0');
      expect(() => be.spawn('', [], spawnOpts())).toThrowError(/Command failed: tmux pipe-pane/);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('buildPipePaneStartupError (pure)', () => {
  const raw = Object.assign(new Error('Command failed: tmux pipe-pane -O -t x'), {
    stderr: Buffer.from('boom'),
  });

  it('renders exit status and screen tail for a dead pane', () => {
    const err = buildPipePaneStartupError(raw, {
      paneDead: true,
      paneDeadStatus: '0',
      lastScreen: 'fatal: something broke',
    });
    expect(err.message).toContain('启动后立即退出');
    expect(err.message).toContain('exit status=0');
    expect(err.message).toContain('最后一屏');
    expect(err.message).toContain('fatal: something broke');
    expect(err.message).toContain('Command failed: tmux pipe-pane');
  });

  it('handles a pane killed by signal (no exit status)', () => {
    const err = buildPipePaneStartupError(raw, { paneDead: true, paneDeadStatus: null, lastScreen: null });
    expect(err.message).toContain('启动后立即退出');
    expect(err.message).toContain('信号');
    expect(err.message).not.toContain('最后一屏');
  });
});

describe('TmuxPipeBackend tmux version gating', () => {
  /** Mock `tmux -V` (via the mocked child_process module shared with
   *  ensure-tmux) and leave every other execFileSync call succeeding. */
  function mockTmuxVersion(version: string | null): void {
    mockedExecFileSync.mockImplementation(((_bin: any, args: any) => {
      if (Array.isArray(args) && args[0] === '-V') {
        if (version === null) {
          throw Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' });
        }
        return `${version}\n` as any;
      }
      return '' as any;
    }) as any);
  }

  it('uses resize-pane on tmux 2.8 (no resize-window subcommand)', () => {
    mockTmuxVersion('tmux 2.8');
    const be = new TmuxPipeBackend('bmx-resize-old', { ownsSession: true });
    be.resize(120, 40);
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'tmux', ['resize-pane', '-t', 'bmx-resize-old', '-x', '120', '-y', '40'], expect.any(Object),
    );
  });

  it('uses resize-window on tmux 3.3', () => {
    mockTmuxVersion('tmux 3.3a');
    const be = new TmuxPipeBackend('bmx-resize-new', { ownsSession: true });
    be.resize(120, 40);
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'tmux', ['resize-window', '-t', 'bmx-resize-new', '-x', '120', '-y', '40'], expect.any(Object),
    );
  });

  it('keeps resize-window when the version is unknown (legacy behaviour)', () => {
    mockTmuxVersion(null);
    const be = new TmuxPipeBackend('bmx-resize-unknown', { ownsSession: true });
    be.resize(120, 40);
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'tmux', ['resize-window', '-t', 'bmx-resize-unknown', '-x', '120', '-y', '40'], expect.any(Object),
    );
  });

  function windowSizeCalls(): string[] {
    return mockedExecSync.mock.calls
      .map(c => String(c[0]))
      .filter(c => c.includes('set-option') && c.includes('window-size largest'));
  }

  it('skips window-size largest on tmux 3.0', () => {
    mockTmuxVersion('tmux 3.0');
    const be = new TmuxPipeBackend('bmx-ws-old', { createSession: true, ownsSession: true });
    be.spawn('/bin/echo', [], spawnOpts());
    expect(windowSizeCalls()).toEqual([]);
    // Other options are still applied.
    const optionCalls = mockedExecSync.mock.calls.map(c => String(c[0]));
    expect(optionCalls.some(c => c.includes('status on'))).toBe(true);
    expect(optionCalls.some(c => c.includes('history-limit 50000'))).toBe(true);
  });

  it('sets window-size largest on tmux 3.3', () => {
    mockTmuxVersion('tmux 3.3a');
    const be = new TmuxPipeBackend('bmx-ws-new', { createSession: true, ownsSession: true });
    be.spawn('/bin/echo', [], spawnOpts());
    expect(windowSizeCalls().length).toBe(1);
  });

  it('tries window-size largest when the version is unknown (legacy behaviour)', () => {
    mockTmuxVersion(null);
    const be = new TmuxPipeBackend('bmx-ws-unknown', { createSession: true, ownsSession: true });
    be.spawn('/bin/echo', [], spawnOpts());
    expect(windowSizeCalls().length).toBe(1);
  });

  it('restores a detached owned session to the configured size on reattach', () => {
    mockedExecFileSync.mockImplementation(((_bin: any, args: any) => {
      if (Array.isArray(args) && args[0] === '-V') return 'tmux 3.3a\n' as any;
      if (Array.isArray(args) && args.includes('#{session_attached}')) return '0\n' as any;
      return '' as any;
    }) as any);
    const be = new TmuxPipeBackend('bmx-reattach-detached', { ownsSession: true, isReattach: true });

    be.spawn('/bin/echo', [], spawnOpts());

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'tmux', ['resize-window', '-t', 'bmx-reattach-detached', '-x', '200', '-y', '50'], expect.any(Object),
    );
  });

  it('preserves an attached owned session size on reattach', () => {
    mockedExecFileSync.mockImplementation(((_bin: any, args: any) => {
      if (Array.isArray(args) && args[0] === '-V') return 'tmux 3.3a\n' as any;
      if (Array.isArray(args) && args.includes('#{session_attached}')) return '1\n' as any;
      return '' as any;
    }) as any);
    const be = new TmuxPipeBackend('bmx-reattach-attached', { ownsSession: true, isReattach: true });

    be.spawn('/bin/echo', [], spawnOpts());

    const resizeCalls = mockedExecFileSync.mock.calls.filter(([, args]) => (
      Array.isArray(args) && (args[0] === 'resize-window' || args[0] === 'resize-pane')
    ));
    expect(resizeCalls).toEqual([]);
  });
});

// tmux 2.8 dereferences a dead retained pane's released event when pipe-pane
// subscribes to it and crashes the WHOLE server (independently reproduced on a
// real 2.8: direct pipe-pane -> "lost server", every neighbour session dies).
// On old/unknown tmux the subscription is therefore funnelled through an
// `if-shell -F '#{pane_dead}'` decision queued atomically with the subscription
// in ONE server command; a marker reply means the pane was already dead.
// The real-2.8 crash regression lives in tmux-legacy-pipe-guard.test.ts (CI has
// no 2.8 binary), so THIS mock suite is the CI-runnable pin for the guard.
describe('TmuxPipeBackend dead-pane guard before pipe-pane (#2419)', () => {
  const target = 'bmx-dead-guard';
  const MARKER = 'botmux-pane-dead-before-pipe';

  // Old/unknown version, and a reattach corpse probe that answers "alive" so
  // spawn() proceeds to the fifo + attach steps without bounded re-reads.
  function emulateOldTmux(versionString: string, opts: { attachReply?: string } = {}) {
    mockedExecFileSync.mockImplementation(((_bin: unknown, args: string[]) => {
      if (Array.isArray(args) && args[0] === '-V') return versionString;
      if (Array.isArray(args) && args.includes('#{pane_dead}:#{pane_dead_status}:#{pane_pid}:#{pid}')) return '0:0:111:222';
      return Buffer.from('') as any;
    }) as typeof execFileSync);
    mockedExecSync.mockImplementation(((cmd: unknown) => {
      const text = String(cmd);
      if (text.includes('if-shell') && text.includes(target)) {
        return Buffer.from(opts.attachReply ?? '') as any;
      }
      return Buffer.from('') as any;
    }) as typeof execSync);
    emulateQueuedSubscription();
  }

  // The shell hands if-shell its arguments, then tmux parses the subscription
  // branch AGAIN as a command string. tmux 2.8, 3.0 and 3.1 take this path, so
  // the branch is read with the stricter of their rules: the subscription
  // must arrive as exactly one pipe-pane with the shell command byte-for-byte.
  // The marker display is the then-branch (death verdict), before it in argv.
  function expectGuardShape(cmd: string, paneTarget = target) {
    const words = shWords(cmd);
    const ifShell = words.slice(words.indexOf('if-shell'));
    expect(ifShell.slice(0, 6)).toEqual(['if-shell', '-F', '-t', paneTarget, '#{pane_dead}', `display-message -p ${MARKER}`]);
    expect(ifShell).toHaveLength(7);
    const subscription = legacyTmuxWords(ifShell[6]);
    expect(subscription.slice(0, 4)).toEqual(['pipe-pane', '-O', '-t', paneTarget]);
    expect(subscription).toHaveLength(5);
    const fifo = /^exec >'([^']+)' /.exec(subscription[4])?.[1];
    expect(fifo).toMatch(/botmux-pipe-[0-9a-f]+\.fifo$/);
    expect(subscription[4]).toBe(pipePaneShellCommand(fifo!));
  }

  function attachCommands(): string[] {
    return mockedExecSync.mock.calls
      .map(c => String(c[0]))
      .filter(c => c.includes('pipe-pane') || c.includes('if-shell'));
  }

  // /bin/sh word splitting for the single-quote quoting the backend emits.
  function shWords(cmd: string): string[] {
    const words: string[] = [];
    let word: string | null = null;
    for (let i = 0; i < cmd.length; i++) {
      const ch = cmd[i]!;
      if (ch === "'") {
        const end = cmd.indexOf("'", i + 1);
        if (end < 0) throw new Error(`unterminated quote in ${cmd}`);
        word = (word ?? '') + cmd.slice(i + 1, end);
        i = end;
      } else if (ch === '\\') {
        word = (word ?? '') + cmd[++i];
      } else if (ch === ' ') {
        if (word !== null) words.push(word);
        word = null;
      } else if (/["$`;&|<>#]/.test(ch)) {
        throw new Error(`unquoted shell metacharacter ${ch} in ${cmd}`);
      } else {
        word = (word ?? '') + ch;
      }
    }
    if (word !== null) words.push(word);
    return words;
  }

  // tmux 2.8 cmd_string_split (cmd-string.c): single quotes are literal, double
  // quotes take backslash escapes, and outside quotes a backslash is an ordinary
  // character and `#` starts a comment. `$` and a leading `~` would expand, and
  // cmd_list_parse ends the command at any argument ending in `;`. tmux 3.0/3.1
  // (cmd-parse.y) also expand a `~` that opens a double-quoted string.
  function legacyTmuxWords(cmd: string): string[] {
    const words: string[] = [];
    let word: string | null = null;
    for (let i = 0; i < cmd.length; i++) {
      const ch = cmd[i]!;
      if (ch === "'") {
        const end = cmd.indexOf("'", i + 1);
        if (end < 0) throw new Error(`unterminated quote in ${cmd}`);
        word = (word ?? '') + cmd.slice(i + 1, end);
        i = end;
      } else if (ch === '"') {
        if (cmd[i + 1] === '~') throw new Error(`tmux 3.0 would expand ~ in ${cmd}`);
        let text = '';
        for (i++; cmd[i] !== '"'; i++) {
          if (i >= cmd.length) throw new Error(`unterminated quote in ${cmd}`);
          if (cmd[i] === '$') throw new Error(`tmux would expand $ in ${cmd}`);
          if (cmd[i] === '\\') {
            i++;
            text += ({ e: '\x1b', r: '\r', n: '\n', t: '\t' } as Record<string, string>)[cmd[i]!] ?? cmd[i];
          } else {
            text += cmd[i];
          }
        }
        word = (word ?? '') + text;
      } else if (ch === '$' || (ch === '~' && word === null)) {
        throw new Error(`tmux would expand ${ch} in ${cmd}`);
      } else if (ch === '#') {
        break;
      } else if (ch === ' ' || ch === '\t') {
        if (word !== null) words.push(word);
        word = null;
      } else {
        word = (word ?? '') + ch;
      }
    }
    if (word !== null) words.push(word);
    if (words.some(w => w.endsWith(';'))) throw new Error(`tmux 2.8 would split ${cmd} at a ;`);
    return words;
  }

  it.each(['tmux 2.8', 'tmux 3.1c', 'tmux not-a-version'])(
    '%s: subscribes through the atomic if-shell -F pane_dead guard, not a bare pipe-pane', (versionString) => {
      emulateOldTmux(versionString);
      const be = new TmuxPipeBackend(target, { createSession: true, ownsSession: true });
      try {
        const readersBefore = __testOnly_liveFifoReaderCount();
        expect(() => be.spawn('', [], spawnOpts())).not.toThrow();
        expect(__testOnly_liveFifoReaderCount()).toBe(readersBefore + 1);
        const cmds = attachCommands();
        expect(cmds).toHaveLength(1);
        // The death verdict and the subscription are arguments of ONE tmux
        // invocation: a client-side probe could race the CLI exit.
        expect(cmds[0]).toMatch(new RegExp(`if-shell -F -t '${target}' '#\\{pane_dead\\}'`));
        expect(cmds[0]).toContain(`display-message -p ${MARKER}`);
        expectGuardShape(cmds[0]);
      } finally {
        be.kill();
      }
    });

  // An adopted pane's target is the user's own session name.
  it.each(['tmux 2.8', 'tmux 3.1c'])('%s: a pane target starting with ~ reaches the subscription literally', (versionString) => {
    emulateOldTmux(versionString);
    const tildeTarget = `~${target}`;
    const be = new TmuxPipeBackend(tildeTarget, { createSession: true, ownsSession: true });
    try {
      expect(() => be.spawn('', [], spawnOpts())).not.toThrow();
      const cmds = attachCommands();
      expect(cmds).toHaveLength(1);
      expectGuardShape(cmds[0], tildeTarget);
    } finally {
      be.kill();
    }
  });

  it('a marker reply on a fresh create is a deterministic one-shot startup failure: no retry, no exit, reader recycled', () => {
    emulateOldTmux('tmux 2.8', { attachReply: MARKER });
    const be = new TmuxPipeBackend(target, { createSession: true, ownsSession: true });
    const exits: unknown[] = [];
    be.onExit((code, signal) => exits.push([code, signal]));
    const readersBefore = __testOnly_liveFifoReaderCount();
    expect(() => be.spawn('', [], spawnOpts())).toThrow(/pane is dead/);
    // An onExit wired only afterwards (worker ordering) must stay empty too:
    // a retained dead pane is a startup failure, not a sticky phantom crash.
    be.onExit((code, signal) => exits.push([code, signal]));
    expect(attachCommands()).toHaveLength(1); // rejected deterministically: never retried
    expect(exits).toEqual([]);
    expect(__testOnly_liveFifoReaderCount()).toBe(readersBefore);
  });

  it('a marker reply on a biased reattach reports exit 1 once and recycles the reader', () => {
    emulateOldTmux('tmux 2.8', { attachReply: MARKER });
    const be = new TmuxPipeBackend(target, { ownsSession: true, isReattach: true });
    const exits: Array<number | null> = [];
    be.onExit(code => exits.push(code));
    const readersBefore = __testOnly_liveFifoReaderCount();
    expect(() => be.spawn('', [], spawnOpts())).toThrow(/pane is dead/);
    expect(attachCommands()).toHaveLength(1);
    expect(exits).toEqual([1]); // a pane already gone at attach is a real session loss
    // A real session-loss exit is sticky: a listener wired after spawn (the
    // worker's ordering) still receives it — unlike a fresh-create failure.
    const lateExits: Array<number | null> = [];
    be.onExit(code => lateExits.push(code));
    expect(lateExits).toEqual([1]);
    expect(__testOnly_liveFifoReaderCount()).toBe(readersBefore);
  });

  // A vanished SESSION is a different entry point than a retained corpse: on a
  // real tmux (verified 2.8) `if-shell -F -t <gone> '#{pane_dead}'` evaluates
  // FALSE and runs the else branch, so the embedded pipe-pane answers
  // deterministically "can't find pane" — NOT a marker, NOT a server-level
  // error. It must fail once (never retried) without the create path emitting
  // a process exit.
  function emulateVanishedTarget() {
    mockedExecFileSync.mockImplementation(((_bin: unknown, args: string[]) => {
      if (Array.isArray(args) && args[0] === '-V') return 'tmux 2.8';
      if (Array.isArray(args) && args.includes('#{pane_dead}:#{pane_dead_status}:#{pane_pid}:#{pid}')) return '0:0:111:222';
      return Buffer.from('') as any;
    }) as typeof execFileSync);
    mockedExecSync.mockImplementation(((cmd: unknown) => {
      const text = String(cmd);
      if (text.includes('if-shell') && text.includes(target)) {
        // Node's ExecSyncError message names the command; the reason rides in
        // stderr, which is what the retry classifier reads.
        throw Object.assign(new Error(`Command failed: ${text}`), {
          status: 1,
          signal: null,
          stderr: Buffer.from(`can't find pane: ${target}`),
        });
      }
      return Buffer.from('') as any;
    }) as typeof execSync);
    emulateQueuedSubscription();
  }

  it('a vanished target (else-branch "can\'t find pane") is a one-shot startup failure with no exit', () => {
    emulateVanishedTarget();
    const be = new TmuxPipeBackend(target, { createSession: true, ownsSession: true });
    const exits: unknown[] = [];
    be.onExit((code, signal) => exits.push([code, signal]));
    const readersBefore = __testOnly_liveFifoReaderCount();
    expect(() => be.spawn('', [], spawnOpts())).toThrow(/Command failed/);
    be.onExit((code, signal) => exits.push([code, signal]));
    expect(attachCommands()).toHaveLength(1); // deterministic: no retries
    expect(exits).toEqual([]);
    expect(__testOnly_liveFifoReaderCount()).toBe(readersBefore);
  });

  it('a vanished target on biased reattach reports exit 1 once', () => {
    emulateVanishedTarget();
    const be = new TmuxPipeBackend(target, { ownsSession: true, isReattach: true });
    const exits: Array<number | null> = [];
    be.onExit(code => exits.push(code));
    expect(() => be.spawn('', [], spawnOpts())).toThrow(/Command failed/);
    expect(attachCommands()).toHaveLength(1);
    expect(exits).toEqual([1]);
  });

  it('a non-marker reply means the subscription succeeded (kill then cancels the active pipe-pane)', () => {
    emulateOldTmux('tmux 2.8', { attachReply: 'unrelated tmux output\n' });
    const be = new TmuxPipeBackend(target, { createSession: true, ownsSession: true });
    try {
      expect(() => be.spawn('', [], spawnOpts())).not.toThrow();
      expect(attachCommands()).toHaveLength(1);
      be.kill();
      // kill() only issues the no-arg pipe-pane cancellation when the guard
      // reply was accepted as a successful subscription.
      const cancel = attachCommands().filter(c => !c.includes('if-shell') && !c.includes('-O'));
      expect(cancel.length).toBeGreaterThanOrEqual(1);
    } finally {
      be.kill();
    }
  });

  it('tmux >= 3.2 subscribes with a bare pipe-pane and no if-shell guard', () => {
    // beforeEach default emulation is modern tmux; do not override it.
    emulateQueuedSubscription();
    const be = new TmuxPipeBackend(target, { createSession: true, ownsSession: true });
    try {
      expect(() => be.spawn('', [], spawnOpts())).not.toThrow();
      const cmds = attachCommands();
      expect(cmds).toHaveLength(1);
      expect(cmds[0]).not.toContain('if-shell');
      expect(cmds[0]).toMatch(new RegExp(`pipe-pane -O -t '${target}'`));
    } finally {
      be.kill();
    }
  });

  // ADOPT backends (worker attaching to a CLI it did not launch, keyed by
  // cliPid) go through NEITHER createDetachedSession() NOR
  // applySessionOptions(), so legacyRetention must still be resolved at this
  // boundary — otherwise the guard is silently off and old tmux crashes its
  // whole server when pipe-pane subscribes to the retained adopted corpse
  // (real 2.8: 5/5 "lost server", neighbour sessions die with it).
  describe('adopt path keeps the dead-pane guard on old servers', () => {
    const adoptTarget = 'bmx-adopt-guard';
    function adoptAttachCommands(): string[] {
      return mockedExecSync.mock.calls
        .map(c => String(c[0]))
        .filter(c => (c.includes('pipe-pane') || c.includes('if-shell')) && c.includes(adoptTarget));
    }
    function adoptEmulateOld(versionString: string, opts: { attachReply?: string } = {}) {
      mockedExecFileSync.mockImplementation(((_bin: unknown, args: string[]) => {
        if (Array.isArray(args) && args[0] === '-V') return versionString;
        if (Array.isArray(args) && args.includes('#{version}')) return versionString.replace('tmux ', '');
        return Buffer.from('') as any;
      }) as typeof execFileSync);
      mockedExecSync.mockImplementation(((cmd: unknown) => {
        const text = String(cmd);
        if (text.includes('if-shell') && text.includes(adoptTarget)) {
          return Buffer.from(opts.attachReply ?? '') as any;
        }
        return Buffer.from('') as any;
      }) as typeof execSync);
    }

    it.each(['tmux 2.8', 'tmux 3.1c', 'tmux not-a-version'])(
      '%s: an adopted session subscribes through the if-shell guard', (versionString) => {
        adoptEmulateOld(versionString);
        // A live pid: the watcher must not tear anything down during spawn.
        const be = new TmuxPipeBackend(adoptTarget, { cliPid: process.pid });
        try {
          expect(() => be.spawn('', [], spawnOpts())).not.toThrow();
          const cmds = adoptAttachCommands();
          expect(cmds).toHaveLength(1);
          expect(cmds[0]).toMatch(new RegExp(`if-shell -F -t '${adoptTarget}' '#\{pane_dead\}'`));
          expect(cmds[0]).toContain(`display-message -p ${MARKER}`);
          expect(cmds[0]).toContain("'pipe-pane -O -t");
          expect(cmds[0].indexOf(MARKER)).toBeLessThan(cmds[0].indexOf('pipe-pane -O'));
        } finally {
          be.kill();
        }
      });

    it('a marker on an adopted retained corpse is a deterministic one-shot session loss (exit 1)', () => {
      adoptEmulateOld('tmux 2.8', { attachReply: MARKER });
      const be = new TmuxPipeBackend(adoptTarget, { cliPid: process.pid });
      const exits: Array<number | null> = [];
      be.onExit(code => exits.push(code));
      expect(() => be.spawn('', [], spawnOpts())).toThrow(/pane is dead/);
      expect(adoptAttachCommands()).toHaveLength(1);
      expect(exits).toEqual([1]);
      be.kill();
    });

    it('tmux >= 3.2: an adopted session uses a bare pipe-pane and no guard', () => {
      const be = new TmuxPipeBackend(adoptTarget, { cliPid: process.pid });
      try {
        expect(() => be.spawn('', [], spawnOpts())).not.toThrow();
        const cmds = adoptAttachCommands();
        expect(cmds).toHaveLength(1);
        expect(cmds[0]).not.toContain('if-shell');
        expect(cmds[0]).toMatch(new RegExp(`pipe-pane -O -t '${adoptTarget}'`));
      } finally {
        be.kill();
      }
    });
  });
});

// The reattach reapply of `remain-on-exit failed` (#2164, backfilled onto
// sessions an older build created) must follow the SAME tmux >= 3.2 gate as
// the new-session chain (#2418 regression). A pre-3.2 tmux rejects the value,
// and a gate in the opposite direction (never reapplying) would silently lose
// the crash exit-code channel on supported hosts — so both directions need an
// assertion. The reattach path never builds a new-session argv, which is why
// these assert on the string-form execSync calls, not newSessionArgs().
describe('reattach remain-on-exit reapply vs tmux version', () => {
  const roeReapplyCalls = (): string[] => mockedExecSync.mock.calls
    .map(c => String(c[0]))
    .filter(cmd => cmd.includes('set-option') && cmd.includes('remain-on-exit'));

  it('reapplies legacy remain-on-exit on (never failed) on a reattach against tmux 3.1c', () => {
    mockedExecFileSync.mockImplementation(((_bin: any, args: any) => {
      if (Array.isArray(args) && args[0] === '-V') return 'tmux 3.1c\n' as any;
      return '' as any;
    }) as any);
    const be = new TmuxPipeBackend('bmx-reattach-roe-old', { ownsSession: true, isReattach: true });
    be.spawn('/bin/echo', [], spawnOpts());
    expect(roeReapplyCalls()).toEqual([expect.stringContaining('remain-on-exit on')]);
    expect(roeReapplyCalls().some(c => c.includes('failed'))).toBe(false);
  });

  it('reapplies remain-on-exit failed on a reattach when tmux supports it (3.3a)', () => {
    mockedExecFileSync.mockImplementation(((_bin: any, args: any) => {
      if (Array.isArray(args) && args[0] === '-V') return 'tmux 3.3a\n' as any;
      return '' as any;
    }) as any);
    const be = new TmuxPipeBackend('bmx-reattach-roe-new', { ownsSession: true, isReattach: true });
    be.spawn('/bin/echo', [], spawnOpts());
    expect(roeReapplyCalls().length).toBe(1);
  });

  it('reapplies legacy on (never failed) when a new client meets an old server still on the socket', () => {
    mockedExecFileSync.mockImplementation(((_bin: unknown, args: string[]) => {
      if (Array.isArray(args) && args[0] === '-V') return 'tmux 3.5a\n' as any;
      if (Array.isArray(args) && args.includes('display-message') && args.includes('#{version}')) {
        return '3.1c\n' as any;
      }
      return '' as any;
    }) as any);
    const be = new TmuxPipeBackend('bmx-reattach-roe-mixed', { ownsSession: true, isReattach: true, socketName: 'botmux' });
    be.spawn('/bin/echo', [], spawnOpts());
    expect(roeReapplyCalls()).toEqual([expect.stringContaining('remain-on-exit on')]);
    expect(roeReapplyCalls().some(c => c.includes('failed'))).toBe(false);
  });

  it('re-probes tmux -V once at the reattach boundary after a cached null, then reapplies', () => {
    resetTmuxVersionCacheForTests();
    let vCalls = 0;
    mockedExecFileSync.mockImplementation(((_bin: any, args: any) => {
      if (Array.isArray(args) && args[0] === '-V') {
        vCalls += 1;
        if (vCalls === 1) throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
        return 'tmux 3.3a\n' as any;
      }
      return '' as any;
    }) as any);
    // A failed gate probe left a null inside the short TTL.
    expect(getTmuxVersionCached()).toBeNull();
    expect(vCalls).toBe(1);
    const be = new TmuxPipeBackend('bmx-reattach-roe-reprobe', { ownsSession: true, isReattach: true });
    be.spawn('/bin/echo', [], spawnOpts());
    expect(vCalls).toBe(2);
    expect(roeReapplyCalls().length).toBe(1);
  });

  // Unknown at the reattach boundary must fail CLOSED too, symmetrically with
  // the new-session chain's own unknown-version tripwire: sending `failed` to
  // an old tmux whose -V stayed unreadable is the #2418 direction. The
  // rejection is currently swallowed (this line is last inside the shared
  // try/catch, so the worst case is just this session's pre-#2164 behaviour),
  // which is exactly why the gate needs a test — a future `null || supported`
  // flip here otherwise lands silently (the same flip at the creation point
  // is already caught by the chain-shape assertions above).
  it('fails CLOSED at the reattach boundary with legacy on (never failed) when the version stays unreadable', () => {
    resetTmuxVersionCacheForTests();
    let vCalls = 0;
    mockedExecFileSync.mockImplementation(((_bin: any, args: any) => {
      if (Array.isArray(args) && args[0] === '-V') {
        vCalls += 1;
        throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
      }
      return '' as any;
    }) as any);
    // A failed gate probe left a null inside the short TTL; the boundary
    // resolver re-probes exactly once and still gets no answer, so the option
    // degrades to legacy `on` — never `failed`, which an unknown old server
    // could reject.
    expect(getTmuxVersionCached()).toBeNull();
    expect(vCalls).toBe(1);
    const be = new TmuxPipeBackend('bmx-reattach-roe-unknown', { ownsSession: true, isReattach: true });
    be.spawn('/bin/echo', [], spawnOpts());
    expect(vCalls).toBe(2);
    expect(roeReapplyCalls()).toEqual([expect.stringContaining('remain-on-exit on')]);
    expect(roeReapplyCalls().some(c => c.includes('failed'))).toBe(false);
  });
});

describe('TmuxPipeBackend anti-fork gate wiring', () => {
  const creatingBackend = () => new TmuxPipeBackend('bmx-gate01', { createSession: true, ownsSession: true });

  it('prepends -N to new-session argv when the gate returns the never-start flag', () => {
    mockedLeadingArgs.mockReturnValueOnce(['-N']);
    const be = creatingBackend();
    expect(() => be.spawn('/bin/echo', [], spawnOpts())).not.toThrow();
    expect(newSessionArgs().slice(0, 3)).toEqual(['-N', 'new-session', '-d']);
  });

  it('omits -N when the gate allows a normal (cold/attach) spawn', () => {
    mockedLeadingArgs.mockReturnValueOnce([]);
    const be = creatingBackend();
    expect(() => be.spawn('/bin/echo', [], spawnOpts())).not.toThrow();
    expect(newSessionArgs().slice(0, 2)).toEqual(['new-session', '-d']);
  });

  it('a gate block surfaces the startup failure and discards the secret-bearing launch file', () => {
    // launchFile.discard() removes the file via rmSync (not unlinkSync).
    const rmSpy = vi.spyOn(nodeFs, 'rmSync').mockImplementation(() => undefined);
    mockedLeadingArgs.mockImplementationOnce(() => {
      throw Object.assign(new Error('blocked -L botmux'), { code: 'ETIMEDOUT' });
    });
    try {
      const be = creatingBackend();
      expect(() => be.spawn('/bin/echo', [], spawnOpts())).toThrow(/创建会话失败/);
      // The pane launch file written before the gate must be removed on the way out.
      expect(rmSpy).toHaveBeenCalled();
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('a -N spawn answered "no server running" (owner died in the probe→exec gap) retries and then cold-boots without -N', () => {
    // "no server running" is a numeric-status, deterministic-looking rejection,
    // so it is NOT in isRetryableStartupTmuxFailure; the gate-specific retry arm
    // is the only thing that turns this race into another gate cycle (whose
    // census then proves a real cold boot) instead of a fatal 会话创建失败.
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const leading: string[][] = [];
      mockedLeadingArgs
        .mockImplementationOnce(() => { leading.push(['-N']); return ['-N']; })
        .mockImplementationOnce(() => { leading.push([]); return []; });
      let attempts = 0;
      const attemptArgv: string[][] = [];
      mockedExecFileSync.mockImplementation(((_bin: any, args: any) => {
        if (Array.isArray(args) && args.includes('new-session')) {
          attempts += 1;
          attemptArgv.push(args as string[]);
          if (attempts === 1) {
            throw Object.assign(new Error('no server'), {
              status: 1, signal: null, stderr: Buffer.from('no server running on /tmp/tmux-0/botmux'),
            });
          }
        }
        return '' as any;
      }) as any);

      const be = creatingBackend();
      expect(() => be.spawn('/bin/echo', [], spawnOpts())).not.toThrow();
      expect(attempts).toBe(2);
      expect(attemptArgv[0]!.slice(0, 3)).toEqual(['-N', 'new-session', '-d']);
      expect(attemptArgv[1]!.slice(0, 2)).toEqual(['new-session', '-d']);
      expect(leading).toEqual([['-N'], []]);
    } finally {
      errSpy.mockRestore();
    }
  });
});
