import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopRuntimeState } from '../../src/desktop/shared/types.js';
import type { BotConfigStatus, RunResult } from '../../src/desktop/main/runtime-service.js';
import { createRuntimeStateMonitor } from '../../src/desktop/main/runtime-actions.js';
import {
  createFileZeroBotOwnershipStore,
  createZeroBotLifecycle,
  type LiveSupervisorSnapshot,
  type ZeroBotLifecycleRuntime,
} from '../../src/desktop/main/zero-bot-lifecycle.js';

function okResult(stdout = ''): RunResult {
  return { code: 0, stdout, stderr: '', signal: null };
}

function runtimeState(overrides: Partial<DesktopRuntimeState> = {}): DesktopRuntimeState {
  return {
    status: 'running',
    appVersion: '1.0.0',
    runtimeVersion: '1.0.0',
    runtimeSource: 'bundled',
    runtimeManaged: true,
    runtimePath: '/Applications/Botmux.app/Contents/Resources/runtime/dist/cli.js',
    botCount: 0,
    onlineDaemonCount: 0,
    attentionCount: 0,
    dashboardUrl: null,
    ...overrides,
  };
}

function makeHarness(initial: {
  config?: BotConfigStatus;
  live?: LiveSupervisorSnapshot | null;
  owned?: boolean;
  startImpl?: (opts?: { signal?: AbortSignal }) => Promise<RunResult>;
  stopImpl?: (opts?: { timeoutMs?: number }) => Promise<RunResult>;
  stopIfEmptyImpl?: (opts?: { supervisorPid?: number; timeoutMs?: number }) => Promise<RunResult>;
} = {}) {
  let config: BotConfigStatus = initial.config ?? { status: 'not_configured', count: 0 };
  let live: LiveSupervisorSnapshot | null = initial.live ?? null;
  let owned = initial.owned ?? true;

  const stopIfEmpty = vi.fn(initial.stopIfEmptyImpl ?? (async () => {
    live = null;
    return okResult();
  }));
  const start = vi.fn(initial.startImpl ?? (async () => {
    live = {
      supervisorPid: 4242,
      supervisorStartedAt: '2026-11-26T00:00:00.000Z',
      supervisorEntry: '/Applications/Botmux.app/Contents/Resources/runtime/dist/index-supervisor.js',
    };
    return okResult();
  }));
  const stop = vi.fn(initial.stopImpl ?? (async () => {
    live = null;
    return okResult();
  }));
  const restart = vi.fn(async () => okResult());
  const restartBundled = vi.fn(async () => okResult());
  const takeover = vi.fn(async () => okResult());
  const getState = vi.fn(async () => runtimeState());

  const stubRuntime: ZeroBotLifecycleRuntime = {
    readBotConfigStatus: () => config,
    getState,
    start,
    stop,
    stopIfEmpty,
    restart,
    restartBundled,
    takeover,
  };

  const warn = vi.fn();
  const lifecycle = createZeroBotLifecycle({
    runtime: stubRuntime,
    readLiveSupervisor: () => live,
    isOwnedByApp: () => owned,
    warn,
  });

  return {
    lifecycle,
    spies: { start, stop, stopIfEmpty, restart, restartBundled, warn },
    setConfig: (next: BotConfigStatus) => { config = next; },
    setLive: (next: LiveSupervisorSnapshot | null) => { live = next; },
    setOwned: (next: boolean) => { owned = next; },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('zero-bot lifecycle quit cleanup', () => {
  it('reaps an app-started 0-bot supervisor with its attested PID on quit', async () => {
    const h = makeHarness();
    expect(h.lifecycle.needsQuitCleanup()).toBe(false);

    await h.lifecycle.runtime.start();
    expect(h.lifecycle.needsQuitCleanup()).toBe(true);
    expect(h.lifecycle.getOwnedSupervisor()).toEqual({
      supervisorPid: 4242,
      supervisorStartedAt: '2026-11-26T00:00:00.000Z',
    });

    const outcome = await h.lifecycle.cleanupOnQuit({ totalTimeoutMs: 5_000 });
    expect(outcome).toBe('stopped');
    expect(h.spies.stopIfEmpty).toHaveBeenCalledTimes(1);
    expect(h.spies.stopIfEmpty).toHaveBeenCalledWith(expect.objectContaining({ supervisorPid: 4242 }));
    expect(h.lifecycle.needsQuitCleanup()).toBe(false);
  });

  it('re-reads bots.json from disk at quit and does NOT stop when the first bot was just saved before a monitor tick', async () => {
    const h = makeHarness();
    await h.lifecycle.runtime.start();
    expect(h.lifecycle.needsQuitCleanup()).toBe(true);

    // User saves their first bot (including local apiOnly) right before pressing Cmd+Q,
    // before the 5s monitor tick has called observeState({ botCount: 1 }).
    h.setConfig({ status: 'configured', count: 1 });

    const outcome = await h.lifecycle.cleanupOnQuit();
    expect(outcome).toBe('skipped-configured');
    expect(h.spies.stopIfEmpty).not.toHaveBeenCalled();
    expect(h.lifecycle.getPhase()).toBe('graduated');
  });

  it('fails closed and skips stopping when bots.json became corrupted before quit', async () => {
    const h = makeHarness();
    await h.lifecycle.runtime.start();
    h.setConfig({ status: 'invalid', message: 'Unexpected end of JSON input' });

    const outcome = await h.lifecycle.cleanupOnQuit();
    expect(outcome).toBe('skipped-configured');
    expect(h.spies.stopIfEmpty).not.toHaveBeenCalled();
  });

  it('skips cleanup in 0ms for existing 1+ bot users so the fleet outlives quit', async () => {
    const h = makeHarness({
      config: { status: 'configured', count: 2 },
    });
    await h.lifecycle.runtime.start();
    expect(h.lifecycle.needsQuitCleanup()).toBe(false);

    const outcome = await h.lifecycle.cleanupOnQuit();
    expect(outcome).toBe('skipped-not-owned');
    expect(h.spies.stopIfEmpty).not.toHaveBeenCalled();
  });

  it('graduates monotonically once observeState sees botCount > 0', async () => {
    const h = makeHarness();
    await h.lifecycle.runtime.start();
    expect(h.lifecycle.needsQuitCleanup()).toBe(true);

    h.lifecycle.observeState(runtimeState({ status: 'running', botCount: 1, onlineDaemonCount: 1 }));
    expect(h.lifecycle.needsQuitCleanup()).toBe(false);
    expect(h.lifecycle.getPhase()).toBe('graduated');

    const outcome = await h.lifecycle.cleanupOnQuit();
    expect(outcome).toBe('skipped-not-owned');
    expect(h.spies.stopIfEmpty).not.toHaveBeenCalled();
  });

  it('never stops a pre-existing external 0-bot supervisor that Desktop did not start', async () => {
    const h = makeHarness({
      live: {
        supervisorPid: 9001,
        supervisorStartedAt: '2026-11-25T10:00:00.000Z',
        supervisorEntry: '/usr/local/bin/botmux',
      },
      owned: false,
    });

    await h.lifecycle.runtime.start();
    expect(h.lifecycle.needsQuitCleanup()).toBe(false);

    const outcome = await h.lifecycle.cleanupOnQuit();
    expect(outcome).toBe('skipped-not-owned');
    expect(h.spies.stopIfEmpty).not.toHaveBeenCalled();
  });

  it('never stops a supervisor whose PID or startedAt drifted to another instance', async () => {
    const h = makeHarness();
    await h.lifecycle.runtime.start();

    h.setLive({
      supervisorPid: 7777,
      supervisorStartedAt: '2026-11-26T00:05:00.000Z',
      supervisorEntry: '/Applications/Botmux.app/Contents/Resources/runtime/dist/index-supervisor.js',
    });

    const outcome = await h.lifecycle.cleanupOnQuit();
    expect(outcome).toBe('skipped-unowned');
    expect(h.spies.stopIfEmpty).not.toHaveBeenCalled();
  });

  it('clears ownership on explicit stop() so a subsequent quit is a no-op', async () => {
    const h = makeHarness();
    await h.lifecycle.runtime.start();
    await h.lifecycle.runtime.stop();

    expect(h.lifecycle.needsQuitCleanup()).toBe(false);
    const outcome = await h.lifecycle.cleanupOnQuit();
    expect(outcome).toBe('skipped-not-owned');
    expect(h.spies.stopIfEmpty).not.toHaveBeenCalled();
  });

  it('aborts an in-flight 0-bot start on quit and still reaps a detached supervisor if it spawned before abort', async () => {
    vi.useFakeTimers();
    let aborted = false;
    let resolveStart!: (result: RunResult) => void;
    let setLiveRef!: (next: LiveSupervisorSnapshot | null) => void;

    const h = makeHarness({
      startImpl: opts => new Promise<RunResult>(resolve => {
        resolveStart = resolve;
        opts?.signal?.addEventListener('abort', () => {
          aborted = true;
          // Simulate CLI having already spawned the detached supervisor right before abort.
          setLiveRef({
            supervisorPid: 5151,
            supervisorStartedAt: '2026-11-26T00:01:00.000Z',
            supervisorEntry: '/Applications/Botmux.app/Contents/Resources/runtime/dist/index-supervisor.js',
          });
          resolve({ code: 1, stdout: '', stderr: 'Command aborted', signal: null });
        }, { once: true });
      }),
    });
    setLiveRef = h.setLive;

    const startPromise = h.lifecycle.runtime.start();
    expect(h.lifecycle.needsQuitCleanup()).toBe(true);

    const cleanupPromise = h.lifecycle.cleanupOnQuit({
      totalTimeoutMs: 5_000,
      waitInFlightMs: 2_000,
      abortGraceMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const [startResult, cleanupOutcome] = await Promise.all([startPromise, cleanupPromise]);
    expect(aborted).toBe(true);
    expect(startResult.code).toBe(1);
    expect(cleanupOutcome).toBe('stopped');
    expect(h.spies.stopIfEmpty).toHaveBeenCalledWith(expect.objectContaining({ supervisorPid: 5151 }));
    void resolveStart;
  });

  it('is idempotent when cleanupOnQuit is invoked concurrently', async () => {
    let releaseStop!: (result: RunResult) => void;
    const h = makeHarness({
      stopIfEmptyImpl: () => new Promise<RunResult>(resolve => {
        releaseStop = resolve;
      }),
    });
    await h.lifecycle.runtime.start();

    const first = h.lifecycle.cleanupOnQuit();
    const second = h.lifecycle.cleanupOnQuit();
    releaseStop(okResult());

    expect(await Promise.all([first, second])).toEqual(['stopped', 'stopped']);
    expect(h.spies.stopIfEmpty).toHaveBeenCalledTimes(1);
  });

  it('refuses new start() calls after markClosing() has been called', async () => {
    const h = makeHarness();
    h.lifecycle.markClosing();
    const result = await h.lifecycle.runtime.start();
    expect(result.code).toBe(1);
    expect(h.spies.start).not.toHaveBeenCalled();
  });

  it('invalidates an in-flight start when stop() runs mid-flight so a later external CLI is never killed', async () => {
    let releaseStart!: (r: RunResult) => void;
    let startAborted = false;
    const h = makeHarness({
      startImpl: opts => new Promise<RunResult>(resolve => {
        releaseStart = resolve;
        opts?.signal?.addEventListener('abort', () => { startAborted = true; }, { once: true });
      }),
    });

    const startPromise = h.lifecycle.runtime.start();
    await h.lifecycle.runtime.stop();
    expect(startAborted).toBe(true);

    // Late code:0 exit from aborted start must NOT re-arm ownership.
    releaseStart(okResult());
    await startPromise;
    expect(h.lifecycle.needsQuitCleanup()).toBe(false);

    // A later externally-started bundled CLI must NOT be stopped on Quit.
    h.setLive({
      supervisorPid: 9999,
      supervisorStartedAt: '2026-11-26T01:00:00.000Z',
      supervisorEntry: '/Applications/Botmux.app/Contents/Resources/runtime/dist/index-supervisor.js',
    });
    expect(await h.lifecycle.cleanupOnQuit()).toBe('skipped-not-owned');
    expect(h.spies.stopIfEmpty).not.toHaveBeenCalled();
  });

  it('tracks concurrent restart() during an in-flight start() and reaps the replacement supervisor on quit', async () => {
    let releaseStart!: (r: RunResult) => void;
    let setLiveRef!: (next: LiveSupervisorSnapshot | null) => void;
    const h = makeHarness({
      startImpl: () => new Promise<RunResult>(resolve => {
        setLiveRef({
          supervisorPid: 2001,
          supervisorStartedAt: '2026-11-26T00:01:00.000Z',
          supervisorEntry: '/Applications/Botmux.app/Contents/Resources/runtime/dist/index-supervisor.js',
        });
        releaseStart = resolve;
      }),
    });
    setLiveRef = h.setLive;
    h.spies.restart.mockImplementation(async () => {
      h.setLive({
        supervisorPid: 2002,
        supervisorStartedAt: '2026-11-26T00:02:00.000Z',
        supervisorEntry: '/Applications/Botmux.app/Contents/Resources/runtime/dist/index-supervisor.js',
      });
      return okResult();
    });

    const pStart = h.lifecycle.runtime.start();
    await h.lifecycle.runtime.restart();
    releaseStart(okResult());
    await pStart;

    expect(h.lifecycle.getOwnedSupervisor()?.supervisorPid).toBe(2002);
    expect(await h.lifecycle.cleanupOnQuit()).toBe('stopped');
    expect(h.spies.stopIfEmpty).toHaveBeenCalledWith(expect.objectContaining({ supervisorPid: 2002 }));
  });

  it('coalesces overlapping start() calls and resets phase to idle if start() rejects', async () => {
    let rejectStart!: (err: Error) => void;
    const h = makeHarness({
      startImpl: () => new Promise<RunResult>((_resolve, reject) => {
        rejectStart = reject;
      }),
    });

    const p1 = h.lifecycle.runtime.start();
    const p2 = h.lifecycle.runtime.start();
    expect(h.spies.start).toHaveBeenCalledTimes(1);

    const err1Promise = p1.then(() => null, err => err as Error);
    const err2Promise = p2.then(() => null, err => err as Error);
    rejectStart(new Error('spawn EMFILE'));
    const [err1, err2] = await Promise.all([err1Promise, err2Promise]);
    expect(err1?.message).toContain('spawn EMFILE');
    expect(err2?.message).toContain('spawn EMFILE');

    expect(h.lifecycle.getPhase()).toBe('idle');
    expect(h.lifecycle.needsQuitCleanup()).toBe(false);
  });

  it('polls briefly after aborting an in-flight start to catch a detached supervisor that writes fleet-state late', async () => {
    let setLiveRef!: (next: LiveSupervisorSnapshot | null) => void;
    const h = makeHarness({
      startImpl: opts => new Promise<RunResult>(resolve => {
        opts?.signal?.addEventListener('abort', () => {
          // CLI dies immediately on SIGTERM, while detached supervisor writes fleet-state 60ms later.
          setTimeout(() => {
            setLiveRef({
              supervisorPid: 6161,
              supervisorStartedAt: '2026-11-26T00:03:00.000Z',
              supervisorEntry: '/Applications/Botmux.app/Contents/Resources/runtime/dist/index-supervisor.js',
            });
          }, 60);
          resolve({ code: 1, stdout: '', stderr: 'Command aborted', signal: null });
        }, { once: true });
      }),
    });
    setLiveRef = h.setLive;

    const pStart = h.lifecycle.runtime.start();
    const pClean = h.lifecycle.cleanupOnQuit({
      totalTimeoutMs: 2_000,
      waitInFlightMs: 25,
      abortGraceMs: 400,
      postAbortPollMs: 15,
    });

    await pStart;
    expect(await pClean).toBe('stopped');
    expect(h.spies.stopIfEmpty).toHaveBeenCalledWith(expect.objectContaining({ supervisorPid: 6161 }));
  });

  it('re-hydrates 0-bot ownership across host relaunches in the same session and skips cleanup when another host is active', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-owner-store-'));
    try {
      const live: LiveSupervisorSnapshot = {
        supervisorPid: 8080,
        supervisorStartedAt: '2026-11-26T00:04:00.000Z',
        supervisorEntry: '/Applications/Botmux.app/Contents/Resources/runtime/dist/index-supervisor.js',
      };
      const store1 = createFileZeroBotOwnershipStore(dir, 'app-session-1');
      const stopIfEmpty1 = vi.fn(async () => okResult());
      const lc1 = createZeroBotLifecycle({
        runtime: {
          readBotConfigStatus: () => ({ status: 'not_configured', count: 0 }),
          getState: async () => runtimeState(),
          start: async () => okResult(),
          stop: async () => okResult(),
          stopIfEmpty: stopIfEmpty1,
          restart: async () => okResult(),
          restartBundled: async () => okResult(),
          takeover: async () => okResult(),
        },
        readLiveSupervisor: () => live,
        isOwnedByApp: () => true,
        ownershipStore: store1,
        hasOtherActiveHost: () => true,
      });

      expect(lc1.adoptRunningZeroBot()).toBe(true);
      expect(store1.read()?.supervisorPid).toBe(8080);

      // Re-hydration in same session succeeds; different session ignores the marker.
      const storeOther = createFileZeroBotOwnershipStore(dir, 'app-session-2');
      const lcOther = createZeroBotLifecycle({
        runtime: {
          readBotConfigStatus: () => ({ status: 'not_configured', count: 0 }),
          getState: async () => runtimeState(),
          start: async () => okResult(),
          stop: async () => okResult(),
          stopIfEmpty: vi.fn(async () => okResult()),
          restart: async () => okResult(),
          restartBundled: async () => okResult(),
          takeover: async () => okResult(),
        },
        readLiveSupervisor: () => live,
        isOwnedByApp: () => true,
        ownershipStore: storeOther,
      });
      expect(lcOther.needsQuitCleanup()).toBe(false);

      // Exiting host1 skips stopping when another active host holds a lease.
      expect(await lc1.cleanupOnQuit()).toBe('skipped-other-host');
      expect(stopIfEmpty1).not.toHaveBeenCalled();

      // Relaunched host2 in same session re-hydrates ownership and reaps on final Quit.
      const store2 = createFileZeroBotOwnershipStore(dir, 'app-session-1');
      const stopIfEmpty2 = vi.fn(async () => okResult());
      const lc2 = createZeroBotLifecycle({
        runtime: {
          readBotConfigStatus: () => ({ status: 'not_configured', count: 0 }),
          getState: async () => runtimeState(),
          start: async () => okResult(),
          stop: async () => okResult(),
          stopIfEmpty: stopIfEmpty2,
          restart: async () => okResult(),
          restartBundled: async () => okResult(),
          takeover: async () => okResult(),
        },
        readLiveSupervisor: () => live,
        isOwnedByApp: () => true,
        ownershipStore: store2,
        hasOtherActiveHost: () => false,
      });
      expect(lc2.needsQuitCleanup()).toBe(true);
      expect(await lc2.cleanupOnQuit()).toBe('stopped');
      expect(stopIfEmpty2).toHaveBeenCalledWith(expect.objectContaining({ supervisorPid: 8080 }));
      expect(store2.read()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runtime state monitor watchDir acceleration', () => {
  it('triggers a debounced refresh when bots.json is written inside watchDir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-desktop-watch-'));
    try {
      let botCount = 0;
      const seen: number[] = [];
      const monitor = createRuntimeStateMonitor({
        runtime: {
          getState: async () => runtimeState({ botCount }),
        },
        sendState: state => { seen.push(state.botCount); },
        intervalMs: 60_000,
        watchDir: dir,
      });

      monitor.start();
      await vi.waitFor(() => {
        expect(seen).toContain(0);
      }, { timeout: 2_000 });

      botCount = 1;
      writeFileSync(join(dir, 'bots.json'), '[{"larkAppId":"cli_a","larkAppSecret":"s"}]\n');

      await vi.waitFor(() => {
        expect(seen).toContain(1);
      }, { timeout: 3_000 });

      monitor.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('queues a follow-up refresh when fs.watch fires mid-refresh and suppresses sendState after stop()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-desktop-watch-race-'));
    try {
      let callCount = 0;
      let releaseFirst!: (state: DesktopRuntimeState) => void;
      const seen: number[] = [];
      const monitor = createRuntimeStateMonitor({
        runtime: {
          getState: () => {
            callCount += 1;
            if (callCount === 1) {
              return new Promise<DesktopRuntimeState>(resolve => {
                releaseFirst = resolve;
              });
            }
            return Promise.resolve(runtimeState({ botCount: 1 }));
          },
        },
        sendState: state => { seen.push(state.botCount); },
        intervalMs: 60_000,
        watchDir: dir,
      });

      monitor.start();
      // Trigger bots.json change while initial refresh is still in-flight.
      writeFileSync(join(dir, 'bots.json'), '[{"larkAppId":"cli_a","larkAppSecret":"s"}]\n');
      await new Promise(resolve => setTimeout(resolve, 250));
      releaseFirst(runtimeState({ botCount: 0 }));

      await vi.waitFor(() => {
        expect(seen).toEqual([0, 1]);
      }, { timeout: 3_000 });
      monitor.stop();

      // Now verify stop() suppresses an in-flight refresh from invoking sendState.
      let releaseLate!: (state: DesktopRuntimeState) => void;
      const lateSeen: DesktopRuntimeState[] = [];
      const mon2 = createRuntimeStateMonitor({
        runtime: {
          getState: () => new Promise<DesktopRuntimeState>(resolve => { releaseLate = resolve; }),
        },
        sendState: state => { lateSeen.push(state); },
        intervalMs: 60_000,
      });
      const p = mon2.refresh();
      mon2.stop();
      releaseLate(runtimeState({ botCount: 1 }));
      await p;
      expect(lateSeen).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
