import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFleetState } from '../../core/fleet-state-store.js';
import { pidAlive } from '../../core/fleet-supervisor.js';
import type { DesktopRuntimeState } from '../shared/types.js';
import type { BotConfigStatus, BundledRuntimeCandidate, createRuntimeService, RunResult } from './runtime-service.js';

export interface LiveSupervisorSnapshot {
  supervisorPid: number;
  supervisorStartedAt: string;
  supervisorEntry?: string;
}

export interface ZeroBotOwnershipRecord {
  sessionId: string;
  supervisorPid: number;
  supervisorStartedAt: string;
}

export interface ZeroBotOwnershipStore {
  sessionId: string;
  read(): ZeroBotOwnershipRecord | null;
  write(record: ZeroBotOwnershipRecord): void;
  clear(): void;
}

export type ZeroBotCleanupOutcome =
  | 'stopped'
  | 'skipped-not-owned'
  | 'skipped-configured'
  | 'skipped-not-running'
  | 'skipped-unowned'
  | 'skipped-other-host'
  | 'timeout'
  | 'failed';

export type ZeroBotLifecyclePhase = 'idle' | 'starting' | 'active' | 'graduated';

export interface ZeroBotLifecycleRuntime {
  readBotConfigStatus(): BotConfigStatus;
  getState(): Promise<DesktopRuntimeState>;
  start(options?: { signal?: AbortSignal }): Promise<RunResult>;
  stop(options?: { timeoutMs?: number }): Promise<RunResult>;
  stopIfEmpty(options?: { supervisorPid?: number; timeoutMs?: number }): Promise<RunResult>;
  restart(options?: { signal?: AbortSignal }): Promise<RunResult>;
  restartBundled(options?: { signal?: AbortSignal }): Promise<RunResult>;
  takeover(): Promise<RunResult>;
}

export interface ZeroBotLifecycleDeps<TRuntime extends ZeroBotLifecycleRuntime = ReturnType<typeof createRuntimeService>> {
  runtime: TRuntime;
  readLiveSupervisor: () => LiveSupervisorSnapshot | null;
  isOwnedByApp: (live: LiveSupervisorSnapshot) => boolean;
  /** Optional session-scoped handoff store so host relaunches (e.g. after runtime self-update)
   *  within the same app session retain 0-bot cleanup ownership until the app actually quits. */
  ownershipStore?: ZeroBotOwnershipStore;
  /** Optional check for another live Desktop host instance (prevents a slow-exiting host1 from
   *  killing a 0-bot supervisor that a quickly-reopened host2 has adopted). */
  hasOtherActiveHost?: () => boolean;
  now?: () => number;
  warn?: (message: string) => void;
}

export interface ZeroBotCleanupOptions {
  totalTimeoutMs?: number;
  waitInFlightMs?: number;
  abortGraceMs?: number;
  postAbortPollMs?: number;
}

interface ActiveLaunch {
  gen: number;
  kind: 'start' | 'restart';
  promise: Promise<RunResult>;
  controller: AbortController;
}

/** Read the currently-live supervisor identity from `~/.botmux/fleet-state.json`. */
export function readLiveSupervisorSnapshot(
  botmuxHome: string,
  checkAlive: (pid: number) => boolean = pidAlive,
): LiveSupervisorSnapshot | null {
  const statePath = join(botmuxHome, 'fleet-state.json');
  if (!existsSync(statePath)) return null;
  try {
    const state = readFleetState(statePath);
    if (!state || !state.supervisorPid || !checkAlive(state.supervisorPid)) return null;
    return {
      supervisorPid: state.supervisorPid,
      supervisorStartedAt: state.supervisorStartedAt,
      supervisorEntry: state.supervisorEntry,
    };
  } catch {
    return null;
  }
}

/** Check whether a live supervisor entry belongs to this app's bundled runtime. */
export function isSupervisorOwnedByBundledRuntime(
  live: LiveSupervisorSnapshot,
  bundled: Pick<BundledRuntimeCandidate, 'root' | 'cliPath'> | undefined,
): boolean {
  if (!bundled || !live.supervisorEntry) return false;
  return live.supervisorEntry === bundled.cliPath || live.supervisorEntry.startsWith(`${bundled.root}/`);
}

/** File-backed session handoff store in `~/.botmux/.zero-bot-owner.json` (never creates `~/.botmux`). */
export function createFileZeroBotOwnershipStore(
  botmuxHome: string,
  sessionId: string,
): ZeroBotOwnershipStore {
  const markerPath = join(botmuxHome, '.zero-bot-owner.json');
  return {
    sessionId,
    read() {
      if (!existsSync(markerPath)) return null;
      try {
        const parsed = JSON.parse(readFileSync(markerPath, 'utf-8')) as Partial<ZeroBotOwnershipRecord> | null;
        if (
          !parsed
          || typeof parsed !== 'object'
          || typeof parsed.sessionId !== 'string'
          || !parsed.sessionId
          || typeof parsed.supervisorPid !== 'number'
          || !Number.isSafeInteger(parsed.supervisorPid)
          || parsed.supervisorPid <= 0
          || typeof parsed.supervisorStartedAt !== 'string'
          || !parsed.supervisorStartedAt
        ) {
          return null;
        }
        return {
          sessionId: parsed.sessionId,
          supervisorPid: parsed.supervisorPid,
          supervisorStartedAt: parsed.supervisorStartedAt,
        };
      } catch {
        return null;
      }
    },
    write(record) {
      if (!existsSync(botmuxHome)) return;
      const tmp = `${markerPath}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        renameSync(tmp, markerPath);
      } catch {
        try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
      }
    },
    clear() {
      try { rmSync(markerPath, { force: true }); } catch { /* ignore */ }
    },
  };
}

function waitForPromiseOrTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ settled: true; value: T } | { settled: false }> {
  if (ms <= 0) return Promise.resolve({ settled: false });
  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ settled: false });
    }, ms);
    timer.unref?.();
    promise.then(
      value => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ settled: true, value });
      },
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ settled: true, value: undefined as unknown as T });
      },
    );
  });
}

function sleepUnref(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Tracks app-initiated 0-bot onboarding supervisors so quitting Desktop without
 * configuring any bot cleanly reaps the background service, while leaving 1+ bot
 * fleets and externally-started services completely untouched.
 *
 * Electron-free: shared by Electron (`src/desktop/main.ts`) and the native Swift
 * host (`src/desktop/host/desktop-host.ts`).
 */
export function createZeroBotLifecycle<TRuntime extends ZeroBotLifecycleRuntime>(
  deps: ZeroBotLifecycleDeps<TRuntime>,
) {
  const now = deps.now ?? (() => Date.now());
  let phase: ZeroBotLifecyclePhase = 'idle';
  let ownedSupervisor: { supervisorPid: number; supervisorStartedAt: string } | null = null;
  let opGen = 0;
  const activeLaunches = new Set<ActiveLaunch>();
  let activeStartLaunch: ActiveLaunch | null = null;
  let quitRequested = false;
  let cleanupPromise: Promise<ZeroBotCleanupOutcome> | null = null;

  function safeReadLiveSupervisor(): LiveSupervisorSnapshot | null {
    try {
      return deps.readLiveSupervisor();
    } catch {
      return null;
    }
  }

  function safeReadBotConfig(): BotConfigStatus {
    try {
      return deps.runtime.readBotConfigStatus();
    } catch (err) {
      return { status: 'invalid', message: err instanceof Error ? err.message : String(err) };
    }
  }

  function persistOwnership(): void {
    const store = deps.ownershipStore;
    if (!store) return;
    if (phase === 'active' && ownedSupervisor) {
      store.write({
        sessionId: store.sessionId,
        supervisorPid: ownedSupervisor.supervisorPid,
        supervisorStartedAt: ownedSupervisor.supervisorStartedAt,
      });
    } else {
      store.clear();
    }
  }

  function clearOwnershipStore(): void {
    deps.ownershipStore?.clear();
  }

  // Re-hydrate ownership across host relaunches within the SAME app session
  // (e.g. desktop-host exiting after applyUpdate / mtime swap while Botmux.app stays open).
  (function rehydrateOwnership() {
    const store = deps.ownershipStore;
    if (!store) return;
    const saved = store.read();
    if (!saved || saved.sessionId !== store.sessionId) return;
    const cfg = safeReadBotConfig();
    const live = safeReadLiveSupervisor();
    if (
      cfg.status === 'not_configured'
      && live
      && deps.isOwnedByApp(live)
      && live.supervisorPid === saved.supervisorPid
      && live.supervisorStartedAt === saved.supervisorStartedAt
    ) {
      phase = 'active';
      ownedSupervisor = {
        supervisorPid: saved.supervisorPid,
        supervisorStartedAt: saved.supervisorStartedAt,
      };
      return;
    }
    store.clear();
  })();

  function reconcileAfterZeroBotLaunch(result: RunResult, gen: number): void {
    // Drop stale completions invalidated by a newer stop(), restart(), or cleanup.
    if (gen !== opGen) return;
    const configAfter = safeReadBotConfig();
    if (configAfter.status === 'configured') {
      phase = 'graduated';
      ownedSupervisor = null;
      clearOwnershipStore();
      return;
    }
    if (configAfter.status === 'invalid') {
      phase = 'idle';
      ownedSupervisor = null;
      clearOwnershipStore();
      return;
    }
    const liveAfter = safeReadLiveSupervisor();
    if (liveAfter && deps.isOwnedByApp(liveAfter)) {
      phase = 'active';
      ownedSupervisor = {
        supervisorPid: liveAfter.supervisorPid,
        supervisorStartedAt: liveAfter.supervisorStartedAt,
      };
      persistOwnership();
      return;
    }
    if (result.code === 0) {
      // Supervisor started cleanly but fleet-state was not yet readable; keep
      // active without pinned PID so cleanupOnQuit still verifies ownership live.
      phase = 'active';
      ownedSupervisor = null;
      clearOwnershipStore();
      return;
    }
    phase = 'idle';
    ownedSupervisor = null;
    clearOwnershipStore();
  }

  function launchTracked(
    kind: 'start' | 'restart',
    invoker: (options?: { signal?: AbortSignal }) => Promise<RunResult>,
    shouldTrack: boolean,
  ): Promise<RunResult> {
    if (!shouldTrack) return invoker();
    const myGen = ++opGen;
    if (kind === 'restart') {
      activeStartLaunch = null;
      for (const existing of activeLaunches) existing.controller.abort();
    }
    phase = 'starting';
    ownedSupervisor = null;
    clearOwnershipStore();
    const controller = new AbortController();
    let launch!: ActiveLaunch;
    const promise = (async () => {
      try {
        const result = await invoker({ signal: controller.signal });
        reconcileAfterZeroBotLaunch(result, myGen);
        return result;
      } catch (error) {
        reconcileAfterZeroBotLaunch({
          code: 1,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          signal: null,
        }, myGen);
        throw error;
      } finally {
        activeLaunches.delete(launch);
        if (activeStartLaunch === launch) activeStartLaunch = null;
      }
    })();
    launch = { gen: myGen, kind, promise, controller };
    activeLaunches.add(launch);
    if (kind === 'start') activeStartLaunch = launch;
    return promise;
  }

  async function start(): Promise<RunResult> {
    if (quitRequested) {
      return { code: 1, stdout: '', stderr: 'Desktop is shutting down', signal: null };
    }
    const configBefore = safeReadBotConfig();
    // Coalesce overlapping tracked 0-bot starts (e.g. auto-start + user click)
    // so both callers share one AbortController and one launch promise.
    if (configBefore.status === 'not_configured' && activeStartLaunch && activeStartLaunch.gen === opGen) {
      return activeStartLaunch.promise;
    }
    const liveBefore = safeReadLiveSupervisor();
    const shouldTrack = configBefore.status === 'not_configured' && liveBefore === null;
    return launchTracked('start', opts => deps.runtime.start(opts), shouldTrack);
  }

  async function stop(options?: { timeoutMs?: number }): Promise<RunResult> {
    const stopGen = ++opGen;
    activeStartLaunch = null;
    for (const launch of activeLaunches) launch.controller.abort();
    const result = await deps.runtime.stop(options);
    if (stopGen === opGen && (result.code === 0 || safeReadLiveSupervisor() === null)) {
      if (phase !== 'graduated') phase = 'idle';
      ownedSupervisor = null;
      clearOwnershipStore();
    }
    return result;
  }

  async function runZeroBotAwareRestart(
    invoker: (options?: { signal?: AbortSignal }) => Promise<RunResult>,
  ): Promise<RunResult> {
    if (quitRequested) {
      return { code: 1, stdout: '', stderr: 'Desktop is shutting down', signal: null };
    }
    const configBefore = safeReadBotConfig();
    const liveBefore = safeReadLiveSupervisor();
    const shouldTrack = configBefore.status === 'not_configured'
      && (phase === 'active' || phase === 'starting' || activeLaunches.size > 0 || liveBefore === null);
    return launchTracked('restart', invoker, shouldTrack);
  }

  /** Adopt an already-live app-owned 0-bot supervisor when a reopened app takes over. */
  function adoptRunningZeroBot(): boolean {
    if (quitRequested || phase === 'graduated') return false;
    const cfg = safeReadBotConfig();
    if (cfg.status !== 'not_configured') return false;
    const live = safeReadLiveSupervisor();
    if (!live || !deps.isOwnedByApp(live)) return false;
    phase = 'active';
    ownedSupervisor = {
      supervisorPid: live.supervisorPid,
      supervisorStartedAt: live.supervisorStartedAt,
    };
    persistOwnership();
    return true;
  }

  function observeState(state: DesktopRuntimeState): void {
    if (state.botCount > 0) {
      phase = 'graduated';
      ownedSupervisor = null;
      clearOwnershipStore();
      return;
    }
    if (phase === 'active' && !ownedSupervisor && state.status === 'running') {
      const live = safeReadLiveSupervisor();
      if (live && deps.isOwnedByApp(live)) {
        ownedSupervisor = {
          supervisorPid: live.supervisorPid,
          supervisorStartedAt: live.supervisorStartedAt,
        };
        persistOwnership();
      }
      return;
    }
    if (
      (phase === 'active' || (phase === 'starting' && activeLaunches.size === 0))
      && state.status === 'not_configured'
      && safeReadLiveSupervisor() === null
    ) {
      phase = 'idle';
      ownedSupervisor = null;
      clearOwnershipStore();
    }
  }

  function markClosing(): void {
    quitRequested = true;
  }

  function needsQuitCleanup(): boolean {
    return phase === 'starting' || phase === 'active' || activeLaunches.size > 0;
  }

  async function performCleanup(options: ZeroBotCleanupOptions): Promise<ZeroBotCleanupOutcome> {
    const totalTimeoutMs = options.totalTimeoutMs ?? 5_000;
    const waitInFlightMs = options.waitInFlightMs ?? 2_000;
    const abortGraceMs = options.abortGraceMs ?? 1_000;
    const postAbortPollMs = options.postAbortPollMs ?? 50;
    const startedAt = now();

    if (!needsQuitCleanup()) return 'skipped-not-owned';

    const pending = [...activeLaunches];
    let abortedInFlight = false;
    let abortDeadline = 0;

    if (pending.length > 0) {
      const allPending = Promise.allSettled(pending.map(launch => launch.promise));
      const waited = await waitForPromiseOrTimeout(allPending, Math.min(waitInFlightMs, totalTimeoutMs));
      if (!waited.settled) {
        abortedInFlight = true;
        abortDeadline = Math.min(now() + abortGraceMs, startedAt + totalTimeoutMs);
        for (const launch of pending) launch.controller.abort();
        await waitForPromiseOrTimeout(allPending, Math.max(0, abortDeadline - now()));
      }
    }

    // Invalidate any straggler launch so nothing can overwrite phase once cleanup begins.
    opGen += 1;
    activeStartLaunch = null;

    // Re-read bots.json directly from disk: never rely on cached monitor state,
    // which may lag behind a just-saved first bot.
    const configNow = safeReadBotConfig();
    if (configNow.status !== 'not_configured') {
      phase = configNow.status === 'configured' ? 'graduated' : 'idle';
      ownedSupervisor = null;
      clearOwnershipStore();
      return 'skipped-configured';
    }

    let live = safeReadLiveSupervisor();
    if (!live && abortedInFlight) {
      // If a detached supervisor was spawned milliseconds before the CLI child
      // received SIGTERM, give it a bounded window (up to abortDeadline) to
      // write fleet-state.json so we can reap it cleanly instead of leaking it.
      while (!live && now() < abortDeadline) {
        await sleepUnref(Math.min(postAbortPollMs, Math.max(1, abortDeadline - now())));
        const polledConfig = safeReadBotConfig();
        if (polledConfig.status !== 'not_configured') {
          phase = polledConfig.status === 'configured' ? 'graduated' : 'idle';
          ownedSupervisor = null;
          clearOwnershipStore();
          return 'skipped-configured';
        }
        live = safeReadLiveSupervisor();
      }
    }

    if (!live) {
      phase = 'idle';
      ownedSupervisor = null;
      clearOwnershipStore();
      return 'skipped-not-running';
    }

    if (!deps.isOwnedByApp(live)) {
      phase = 'idle';
      ownedSupervisor = null;
      clearOwnershipStore();
      return 'skipped-unowned';
    }

    if (
      ownedSupervisor
      && (
        live.supervisorPid !== ownedSupervisor.supervisorPid
        || live.supervisorStartedAt !== ownedSupervisor.supervisorStartedAt
      )
    ) {
      phase = 'idle';
      ownedSupervisor = null;
      clearOwnershipStore();
      return 'skipped-unowned';
    }

    if (deps.hasOtherActiveHost?.()) {
      // Another active Desktop host (e.g. user quickly reopened the app) has
      // taken over this 0-bot supervisor; leave it alive for the new session.
      phase = 'idle';
      ownedSupervisor = null;
      return 'skipped-other-host';
    }

    const remainingMs = totalTimeoutMs - (now() - startedAt);
    if (remainingMs <= 0) {
      deps.warn?.('0-bot quit cleanup timed out before stop');
      phase = 'idle';
      ownedSupervisor = null;
      clearOwnershipStore();
      return 'timeout';
    }

    const stopTimeoutMs = Math.max(1_500, remainingMs);
    try {
      const stopPromise = deps.runtime.stopIfEmpty({
        supervisorPid: live.supervisorPid,
        timeoutMs: stopTimeoutMs,
      });
      const stopRace = await waitForPromiseOrTimeout(stopPromise, Math.max(100, remainingMs));
      phase = 'idle';
      ownedSupervisor = null;
      clearOwnershipStore();
      if (!stopRace.settled) {
        deps.warn?.('0-bot quit cleanup exceeded total timeout budget');
        return 'timeout';
      }
      if (stopRace.value.code !== 0) {
        deps.warn?.(`0-bot quit cleanup failed: ${stopRace.value.stderr || stopRace.value.stdout || `exit ${stopRace.value.code}`}`);
        return 'failed';
      }
      return 'stopped';
    } catch (error) {
      phase = 'idle';
      ownedSupervisor = null;
      clearOwnershipStore();
      deps.warn?.(`0-bot quit cleanup threw: ${error instanceof Error ? error.message : String(error)}`);
      return 'failed';
    }
  }

  function cleanupOnQuit(options: ZeroBotCleanupOptions = {}): Promise<ZeroBotCleanupOutcome> {
    quitRequested = true;
    if (!cleanupPromise) {
      cleanupPromise = performCleanup(options);
    }
    return cleanupPromise;
  }

  const wrappedRuntime: TRuntime = {
    ...deps.runtime,
    start,
    stop,
    restart: () => runZeroBotAwareRestart(opts => deps.runtime.restart(opts)),
    restartBundled: () => runZeroBotAwareRestart(opts => deps.runtime.restartBundled(opts)),
  };

  return {
    runtime: wrappedRuntime,
    observeState,
    adoptRunningZeroBot,
    markClosing,
    needsQuitCleanup,
    cleanupOnQuit,
    getPhase(): ZeroBotLifecyclePhase {
      return phase;
    },
    getOwnedSupervisor(): { supervisorPid: number; supervisorStartedAt: string } | null {
      return ownedSupervisor ? { ...ownedSupervisor } : null;
    },
  };
}
