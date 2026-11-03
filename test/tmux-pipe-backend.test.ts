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
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
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
import {
  TmuxPipeBackend,
  normaliseCaptureLineEndings,
  tmuxLifecycleInitialDelayMs,
  setStartupTmuxRetrySleepForTests,
  buildPipePaneStartupError,
  __testOnly_liveFifoReaderCount,
  resolveReportedExitCode,
} from '../src/adapters/backend/tmux-pipe-backend.js';
import { resetTmuxVersionCacheForTests, getTmuxVersionCached } from '../src/setup/ensure-tmux.js';
import { bufferSpawnResult } from './helpers/spawn-result.js';
import { takePaneLaunchFile } from './helpers/pane-launch.js';
import { TmuxCommandTooLongError } from '../src/adapters/backend/pane-launch.js';
import { isTransientStartupFailure } from '../src/core/worker-startup-retry.js';

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

beforeEach(() => {
  mockedExecSync.mockReset();
  mockedExecFileSync.mockReset();
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

    // Step 2: tmux pipe-pane -O -t 0:2.0 'cat > <fifo>'
    const pipeCalls = mockedExecSync.mock.calls
      .map(c => String(c[0]))
      .filter(c => c.includes('pipe-pane'));
    expect(pipeCalls.length).toBe(1);
    expect(pipeCalls[0]).toContain('-O');
    expect(pipeCalls[0]).toContain("'0:2.0'");
    expect(pipeCalls[0]).toMatch(/cat > '.*botmux-pipe-.*\.fifo'/);
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
        expect(mockedOpenSync).not.toHaveBeenCalled();
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

    const pasteArgs = calls[1][1] as string[];
    expect(pasteArgs).toContain('paste-buffer');
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
      if (Array.isArray(args) && args.includes('paste-buffer')) throw new Error('no server running');
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
      if (Array.isArray(args) && args.includes('paste-buffer')) throw new Error('no server running');
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
      expect(args.slice(cIdx + 3)).toEqual([';', 'set-option', '-t', 'bmx-fish-pipe', 'remain-on-exit', 'failed']);
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
    expect(args.slice(cIdx + 4)).toEqual([';', 'set-option', '-t', 'bmx-posix-pipe', 'remain-on-exit', 'failed']);
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
  const isPaneProbe = (args: any) =>
    Array.isArray(args) && args.includes('display-message') && args.includes('#{pane_id}');
  const PANE_OK = (_bin: any, args: any) => isPaneProbe(args) ? '%1\n' as any : '' as any;
  const PANE_GONE = (_bin: any, args: any) => {
    if (isPaneProbe(args)) throw Object.assign(new Error('no pane'), { status: 1, signal: null });
    return '' as any;
  };

  it('fires exit when the tmux pane disappears — but only after 3 consecutive failures (backed-off probes)', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      mockedExecFileSync.mockImplementation(PANE_OK);
      const be = new TmuxPipeBackend('bmx-owned', { ownsSession: true });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      be.spawn('', [], spawnOpts());
      mockedExecFileSync.mockImplementation(PANE_GONE);

      // Failed probes back off (1s → 3s → 9s): miss#1 at the initial delay,
      // miss#2 3s later. Two misses are NOT enough — the gate rides them out.
      vi.advanceTimersByTime(tmuxLifecycleInitialDelayMs('bmx-owned') + 3_000);
      expect(exits).toEqual([]);

      // miss#3 lands 9s after miss#2, trips the gate; the final lenient
      // confirm also fails and the server cross-check answers ⇒ now we detach.
      vi.advanceTimersByTime(9_000);
      expect(exits).toEqual([[1, null]]);
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }
  });

  it('treats an empty pane id as a failure (debounced the same way)', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      mockedExecFileSync.mockImplementation(PANE_OK);
      const be = new TmuxPipeBackend('bmx-owned', { ownsSession: true });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      be.spawn('', [], spawnOpts());
      mockedExecFileSync.mockImplementation((_bin: any, args: any) => isPaneProbe(args) ? '\n' as any : '' as any);

      vi.advanceTimersByTime(tmuxLifecycleInitialDelayMs('bmx-owned') + 3_000);
      expect(exits).toEqual([]);
      vi.advanceTimersByTime(9_000);
      expect(exits).toEqual([[1, null]]);
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }
  });

  it('does NOT detach on a single transient probe failure that then recovers', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      mockedExecFileSync.mockImplementation(PANE_OK);
      const be = new TmuxPipeBackend('bmx-owned', { ownsSession: true });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      be.spawn('', [], spawnOpts());

      // One failure, then sustained success — the false signal must be ignored.
      mockedExecFileSync.mockImplementation(PANE_GONE);
      vi.advanceTimersByTime(tmuxLifecycleInitialDelayMs('bmx-owned'));
      mockedExecFileSync.mockImplementation(PANE_OK);
      vi.advanceTimersByTime(10_000);

      expect(exits).toEqual([]);
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }
  });

  // #2434: a dead-but-kept corpse still answers #{pane_id}; the watcher then
  // reads #{pane_dead}:#{pane_dead_status} and confirms death. The real code
  // (77) is captured AT THAT probe. If a deeply starved tmux is unreadable by
  // the time handlePaneExit() does its terminal read (~13s later), the latched
  // code must still be reported — not collapsed to the sentinel 1.
  it('reports the real exit code latched when the pane was confirmed dead, even if the terminal read is starved', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      const DEAD_STATUS = '#{pane_dead}:#{pane_dead_status}';
      // A watcher liveness probe reads pane_id FIRST then the death-status
      // format; handlePaneExit()'s terminal read reads the death-status format
      // WITHOUT a preceding pane_id. Distinguish them by the previous call:
      //  - death-status right after a pane_id read (the probe): confirmed 1:77
      //  - a standalone death-status read (terminal, no preceding pane_id):
      //    starved/unreadable -> ''  (this is the #2434 starvation shape)
      let lastWasPaneId = false;
      const probeImpl = (_bin: any, args: any) => {
        if (!Array.isArray(args) || !args.includes('display-message')) { lastWasPaneId = false; return '' as any; }
        if (args.includes('#{pane_id}')) { lastWasPaneId = true; return '%1\n' as any; }
        if (args.some((a: unknown) => String(a).startsWith(DEAD_STATUS))) {
          const afterPaneId = lastWasPaneId;
          lastWasPaneId = false;
          return afterPaneId ? '1:77\n' as any : '' as any;
        }
        lastWasPaneId = false;
        return '' as any;
      };

      mockedExecFileSync.mockImplementation(probeImpl);
      const be = new TmuxPipeBackend('bmx-owned', { ownsSession: true });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      be.spawn('', [], spawnOpts());

      // Each watcher probe: pane_id OK + isPaneDead reads 1:77 -> 'missing'
      // (corpse). Three back-to-back dead verdicts + final confirm trip exit.
      vi.advanceTimersByTime(tmuxLifecycleInitialDelayMs('bmx-owned') + 3_000 + 9_000);

      // handlePaneExit() already ran with a starved terminal read (the
      // standalone DEAD_STATUS call above returned ''); advance any tail timer.
      vi.advanceTimersByTime(2_000);

      // Latched 77 wins over the now-unreadable terminal read.
      expect(exits).toEqual([[77, null]]);
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }
  });

  // #2453: the same probe-time latch when tmux never publishes a status
  // because it has not reaped the pane process — the code then comes from the
  // kernel's record of that unreaped child, read while the probe confirms the
  // corpse. A real unreaped child stands in for the pane (python forks it and
  // never waits), so the kernel read is real; the terminal read is starved, so
  // only the probe-time capture can carry the 3.
  const python3 = ['/usr/bin/python3', '/bin/python3'].find(path => existsSync(path));
  it.skipIf(!python3 || process.platform !== 'linux')('latches a status tmux never published from the kernel at probe time (#2453)', async () => {
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
      // dead, no status, pane pid = the unreaped child, server pid = its parent
      const corpse = `1::${String(chunk).trim()}:${parent.pid}\n`;
      vi.useFakeTimers();
      let lastWasPaneId = false;
      mockedExecFileSync.mockImplementation(((_bin: any, args: any) => {
        if (!Array.isArray(args) || !args.includes('display-message')) { lastWasPaneId = false; return '' as any; }
        if (args.includes('#{pane_id}')) { lastWasPaneId = true; return '%1\n' as any; }
        if (args.some((a: unknown) => String(a).startsWith('#{pane_dead}:#{pane_dead_status}'))) {
          const afterPaneId = lastWasPaneId;
          lastWasPaneId = false;
          return afterPaneId ? corpse as any : '' as any;
        }
        lastWasPaneId = false;
        return '' as any;
      }) as typeof execFileSync);
      const be = new TmuxPipeBackend('bmx-owned', { ownsSession: true });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      be.spawn('', [], spawnOpts());
      vi.advanceTimersByTime(tmuxLifecycleInitialDelayMs('bmx-owned') + 3_000 + 9_000 + 2_000);
      expect(exits).toEqual([[3, null]]);
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
      parent.stdin!.end();
      await once(parent, 'close');
    }
  });

  it('resets the failure counter on an intervening success (never 3-in-a-row)', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      mockedExecFileSync.mockImplementation(PANE_OK);
      const be = new TmuxPipeBackend('bmx-owned', { ownsSession: true });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      be.spawn('', [], spawnOpts());

      mockedExecFileSync.mockImplementation(PANE_GONE);
      vi.advanceTimersByTime(tmuxLifecycleInitialDelayMs('bmx-owned') + 3_000); // 2 failures (probes back off 1s→3s)
      mockedExecFileSync.mockImplementation(PANE_OK);
      vi.advanceTimersByTime(9_000);          // success → reset (next probe 9s out)
      mockedExecFileSync.mockImplementation(PANE_GONE);
      vi.advanceTimersByTime(4_000);          // 2 more failures at 1s + 3s (gate back to 2)

      expect(exits).toEqual([]);              // never reached 3 consecutive
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }
  });

  it('stays attached when the final lenient confirm probe succeeds', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      let paneIdCalls = 0;
      mockedExecFileSync.mockImplementation((_bin: any, args: any) => {
        if (isPaneProbe(args)) {
          paneIdCalls += 1;
          if (paneIdCalls <= 3) {
            throw Object.assign(new Error('no pane'), { status: 1, signal: null });
          }
          return '%1\n' as any;
        }
        return '' as any;
      });
      const be = new TmuxPipeBackend('bmx-owned', { ownsSession: true });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      be.spawn('', [], spawnOpts());

      vi.advanceTimersByTime(tmuxLifecycleInitialDelayMs('bmx-owned') + 12_000);
      expect(exits).toEqual([]);              // recovered on the confirm, no detach
      expect(paneIdCalls).toBe(4);
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }
  });

  it('never trips the gate on connection-level clean errors (server stall ⇒ instant ECONNREFUSED)', () => {
    // 2026-08-20 incident: a briefly stalled shared server refuses connects
    // instantly (unix-socket accept backlog overflow). The clean exit-1 +
    // "error connecting" stderr must classify as UNKNOWN, not authoritative
    // missing — misreading it tore down every live session across all bots.
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      mockedExecFileSync.mockImplementation(PANE_OK);
      const be = new TmuxPipeBackend('bmx-owned', { ownsSession: true });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      be.spawn('', [], spawnOpts());
      mockedExecFileSync.mockImplementation((_bin: any, args: any) => {
        if (isPaneProbe(args)) {
          throw Object.assign(new Error('cmd failed'), {
            status: 1,
            signal: null,
            stderr: Buffer.from('error connecting to /tmp/tmux-0/default (Connection refused)'),
          });
        }
        return '' as any;
      });

      // Well past the old 3-miss window but inside the 60s outage escalation.
      vi.advanceTimersByTime(tmuxLifecycleInitialDelayMs('bmx-owned') + 30_000);
      expect(exits).toEqual([]);
      expect(errSpy.mock.calls.some(call => String(call[0]).includes('keeping managed session attached'))).toBe(true);
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }
  });

  it('escalates to pane-exit when the server stays continuously unreachable past the outage window', () => {
    // Connection-level errors are unknown, but a genuinely DEAD server also
    // produces them forever — and its panes died with it. An unbroken run
    // longer than the escalation window must eventually declare the pane gone
    // so the worker can restart/resume instead of holding a zombie session.
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      mockedExecFileSync.mockImplementation(PANE_OK);
      const be = new TmuxPipeBackend('bmx-owned', { ownsSession: true });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      be.spawn('', [], spawnOpts());
      mockedExecFileSync.mockImplementation((_bin: any, args: any) => {
        if (isPaneProbe(args)) {
          throw Object.assign(new Error('cmd failed'), {
            status: 1,
            signal: null,
            stderr: Buffer.from('error connecting to /tmp/tmux-0/default (Connection refused)'),
          });
        }
        return '' as any;
      });

      vi.advanceTimersByTime(tmuxLifecycleInitialDelayMs('bmx-owned') + 80_000);
      expect(exits).toEqual([[1, null]]);
      expect(errSpy.mock.calls.some(call => String(call[0]).includes('continuously unreachable'))).toBe(true);
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }
  });

  it('stays attached when panes read missing but the server itself does not answer (cross-check)', () => {
    // Defense in depth: even an authoritative-looking missing verdict must not
    // destroy state while an independent list-sessions cross-check says the
    // server is not answering — covers unrecognised stderr wordings / future
    // tmux message changes that slip past the connection-error classifier.
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      mockedExecFileSync.mockImplementation(PANE_OK);
      const be = new TmuxPipeBackend('bmx-owned', { ownsSession: true });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      be.spawn('', [], spawnOpts());
      mockedExecFileSync.mockImplementation((_bin: any, args: any) => {
        if (isPaneProbe(args)) {
          throw Object.assign(new Error('no pane'), { status: 1, signal: null });
        }
        if (Array.isArray(args) && args.includes('list-sessions')) {
          throw Object.assign(new Error('cmd failed'), {
            status: 1,
            signal: null,
            stderr: Buffer.from('error connecting to /tmp/tmux-0/default (Connection refused)'),
          });
        }
        return '' as any;
      });

      vi.advanceTimersByTime(tmuxLifecycleInitialDelayMs('bmx-owned') + 13_000);
      expect(exits).toEqual([]);
      expect(errSpy.mock.calls.some(call => String(call[0]).includes('treating as server outage'))).toBe(true);
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }
  });

  it('tears down when panes read missing AND the cross-check says the server is DOWN (no server running)', () => {
    // Regression guard for the sole-session hang: when a managed session is the
    // only session on its socket, its pane dying makes tmux exit, so BOTH the
    // pane probe and the list-sessions cross-check return authoritative
    // "no server running" — NOT a connection-level error. That is 'down'
    // (server gone ⇒ this pane provably gone), so teardown must proceed.
    // The earlier cross-check collapsed 'down' into "not answering" and stayed
    // attached forever: each authoritative-missing probe reset the outage
    // clock, so the 60s escalation never fired and the worker hung until the
    // next write. Distinct from the connection-level case above (stay attached).
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      mockedExecFileSync.mockImplementation(PANE_OK);
      const be = new TmuxPipeBackend('bmx-owned', { ownsSession: true });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      be.spawn('', [], spawnOpts());
      // Sole session's pane died → tmux server exited. EVERY tmux invocation
      // (pane probe AND list-sessions cross-check) now returns authoritative
      // "no server running".
      mockedExecFileSync.mockImplementation((_bin: any, _args: any) => {
        throw Object.assign(new Error('no server'), {
          status: 1,
          signal: null,
          stderr: Buffer.from('no server running on /tmp/tmux-0/default'),
        });
      });

      // Well past the ~13s backed-off teardown window, but far short of the 60s
      // escalation clock — proving teardown comes from the 'down' cross-check,
      // not from the outage escalation.
      vi.advanceTimersByTime(tmuxLifecycleInitialDelayMs('bmx-owned') + 15_000);
      expect(exits).toEqual([[1, null]]);
      expect(errSpy.mock.calls.some(call => String(call[0]).includes('pane gone after'))).toBe(true);
      // Must NOT have stayed attached via the outage path.
      expect(errSpy.mock.calls.some(call => String(call[0]).includes('treating as server outage'))).toBe(false);
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }
  });

  it('never detaches when tmux probes time out or fail to spawn (unknown, not missing)', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      const be = new TmuxPipeBackend('bmx-owned', { ownsSession: true });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      be.spawn('', [], spawnOpts());
      mockedExecFileSync.mockImplementation((_bin: any, args: any) => {
        if (isPaneProbe(args)) {
          throw Object.assign(new Error('spawn tmux EMFILE'), { code: 'EMFILE', status: null, signal: null });
        }
        return '' as any;
      });

      vi.advanceTimersByTime(tmuxLifecycleInitialDelayMs('bmx-owned') + 10_000);
      expect(exits).toEqual([]);
      expect(errSpy.mock.calls.some(call => String(call[0]).includes('keeping managed session attached'))).toBe(true);
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }
  });

  it('fires exit IMMEDIATELY when the adopted CLI pid disappears (pid is decisive, not debounced)', () => {
    // The pid check is a pure process.kill(pid,0) syscall — it can only report
    // ESRCH/EPERM, never a transient timeout — so it must NOT be debounced:
    // delaying teardown would route Lark input into the user's bare shell.
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
      if (pid === 4242 && signal === 0) {
        const err: NodeJS.ErrnoException = new Error('gone');
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    }) as typeof process.kill);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      mockedExecFileSync.mockImplementation(PANE_OK);
      const be = new TmuxPipeBackend('0:2.0', { cliPid: 4242 });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      be.spawn('', [], spawnOpts());
      mockedExecSync.mockClear();

      vi.advanceTimersByTime(tmuxLifecycleInitialDelayMs('0:2.0'));
      expect(exits).toEqual([[1, null]]);

      const cancelCall = mockedExecSync.mock.calls
        .map(c => String(c[0]))
        .find(c => c.includes('pipe-pane'));
      expect(cancelCall).toBeDefined();
      expect(cancelCall).toContain("'0:2.0'");
      expect(cancelCall).not.toContain('cat >');
    } finally {
      errSpy.mockRestore();
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('kill() during a pending (sub-threshold) failure streak stops the watcher cleanly', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      mockedExecFileSync.mockImplementation(PANE_OK);
      const be = new TmuxPipeBackend('bmx-owned', { ownsSession: true });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      be.spawn('', [], spawnOpts());

      mockedExecFileSync.mockImplementation(PANE_GONE);
      vi.advanceTimersByTime(tmuxLifecycleInitialDelayMs('bmx-owned') + 1_000);
      expect(exits).toEqual([]);

      be.kill();                              // explicit close mid-streak
      mockedExecFileSync.mockClear();
      vi.advanceTimersByTime(10_000);         // watcher must be stopped

      expect(exits).toEqual([]);              // kill() does not fire onExit
      const probeAfterKill = mockedExecFileSync.mock.calls
        .some(c => (c[1] as string[]).includes('display-message'));
      expect(probeAfterKill).toBe(false);     // no further probing after kill
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }
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

  it('drops the write (no throw, no exit) when send-keys fails but the pane is alive', () => {
    const be = new TmuxPipeBackend('bmx-live', { ownsSession: true });
    const exits: Array<[number | null, string | null]> = [];
    be.onExit((c, s) => exits.push([c, s]));
    be.spawn('', [], spawnOpts());

    mockedExecFileSync.mockImplementation((_bin: any, args: any) => {
      if ((args as string[]).includes('send-keys')) throw new Error('transient tmux error');
      if ((args as string[]).includes('#{pane_id}')) return '%1\n' as any;
      return '' as any;
    });
    // Liveness probe succeeds ⇒ pane ALIVE ⇒ transient error, just dropped.

    expect(() => be.sendText('hi')).not.toThrow();
    expect(exits).toEqual([]);
  });

  it('drops the write without teardown when the follow-up pane probe is unknown', () => {
    const be = new TmuxPipeBackend('bmx-busy', { ownsSession: true });
    const exits: Array<[number | null, string | null]> = [];
    be.onExit((c, s) => exits.push([c, s]));
    be.spawn('', [], spawnOpts());

    mockedExecFileSync.mockImplementation((_bin: any, args: any) => {
      if ((args as string[]).includes('send-keys')) throw new Error('tmux write timed out');
      if ((args as string[]).includes('#{pane_id}')) {
        throw Object.assign(new Error('spawn tmux EMFILE'), { code: 'EMFILE', status: null, signal: null });
      }
      return '' as any;
    });

    expect(() => be.sendText('hi')).not.toThrow();
    expect(exits).toEqual([]);
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
      // The death probe is the display-message whose format carries the
      // STATUS field; the liveness probe's bare '#{pane_dead}' and pane_id
      // probes must be answered separately (mock split by args).
      if (a.includes('display-message') && a.some(f => String(f).includes('#{pane_dead_status}'))) {
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
    expect(pipeCall).not.toContain('cat >');  // no command = cancel
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
  }

  // Shape assertions that discriminate beyond a contains() on the unwrapped
  // command: (1) the marker display MUST be the then-branch (death verdict),
  // i.e. appear before the subscription in argv; (2) the subscription MUST
  // reach tmux as ONE single-quoted if-shell argument — an unescaped
  // pipePaneCommand splits into "too many arguments" on both 2.8 and 3.3a,
  // so the guard silently never runs while a weaker contains() still passes.
  function expectGuardShape(cmd: string) {
    const unwrapped = unescapeQuotes(cmd);
    expect(unwrapped).toContain(`pipe-pane -O -t '${target}'`);
    expect(cmd.indexOf(MARKER)).toBeLessThan(cmd.indexOf('pipe-pane -O'));
    expect(cmd).toContain("'pipe-pane -O -t");
  }

  function attachCommands(): string[] {
    return mockedExecSync.mock.calls
      .map(c => String(c[0]))
      .filter(c => c.includes('pipe-pane') || c.includes('if-shell'));
  }

  // The wrapped command is itself a single-quoted argument of if-shell, so its
  // inner quotes reach us shell-escaped (`'\''`); unescape to read its shape.
  function unescapeQuotes(s: string): string {
    return s.replace(/'\\''/g, "'");
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
