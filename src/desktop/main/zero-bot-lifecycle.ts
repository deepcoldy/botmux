import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStopIfEmptyCliOutcome } from '../../core/desktop-host-leases.js';
import { inspectSupervisorState } from '../../core/fleet-process-identity.js';
import { readFleetState } from '../../core/fleet-state-store.js';
import { pidAlive } from '../../core/fleet-supervisor.js';
import type { DesktopRuntimeState } from '../shared/types.js';
import type { BotConfigStatus, BundledRuntimeCandidate, createRuntimeService, RunResult } from './runtime-service.js';

export interface LiveSupervisorSnapshot {
  supervisorPid: number;
  supervisorStartedAt: string;
  supervisorEntry?: string;
}

export interface PendingZeroBotOwnershipRecord {
  state: 'pending';
  sessionId: string;
  startedAt: string;
  /** Retained across tracked restart() so SIGKILL before old supervisor exits still matches. */
  previousSupervisor?: {
    supervisorPid: number;
    supervisorStartedAt: string;
  };
}

export interface ActiveZeroBotOwnershipRecord {
  state: 'active';
  sessionId: string;
  supervisorPid: number;
  supervisorStartedAt: string;
}

export type ZeroBotOwnershipRecord =
  | PendingZeroBotOwnershipRecord
  | ActiveZeroBotOwnershipRecord;

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
  stopIfEmpty(options?: { supervisorPid?: number; hostPid?: number; timeoutMs?: number }): Promise<RunResult>;
  restart(options?: { signal?: AbortSignal }): Promise<RunResult>;
  restartBundled(options?: { signal?: AbortSignal }): Promise<RunResult>;
  takeover(): Promise<RunResult>;
}

export interface ZeroBotLifecycleDeps<TRuntime extends ZeroBotLifecycleRuntime = ReturnType<typeof createRuntimeService>> {
  runtime: TRuntime;
  readLiveSupervisor: () => LiveSupervisorSnapshot | null;
  isOwnedByApp: (live: LiveSupervisorSnapshot) => boolean;
  /** Optional session-scoped handoff store so host relaunches (e.g. after runtime
   *  self-update or abnormal SIGKILL mid-start) retain 0-bot cleanup ownership. */
  ownershipStore?: ZeroBotOwnershipStore;
  /** Optional check for another live Desktop host instance (fast-path guard;
   *  authoritative fencing also runs inside `botmux stop --if-empty --host-pid`). */
  hasOtherActiveHost?: () => boolean;
  /** PID of this Desktop host process, forwarded via `--host-pid` to `stop --if-empty`. */
  hostPid?: number;
  now?: () => number;
  warn?: (message: string) => void;
}

export interface ZeroBotStopOptions {
  timeoutMs?: number;
  abortGraceMs?: number;
  postAbortPollMs?: number;
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

const PENDING_START_CLOCK_TOLERANCE_MS = 2_000;
const PENDING_RECOVERY_GRACE_MS = 30_000;

/** Read the currently-live supervisor identity from `~/.botmux/fleet-state.json`. */
export function readLiveSupervisorSnapshot(
  botmuxHome: string,
  checkAlive?: (pid: number) => boolean,
): LiveSupervisorSnapshot | null {
  const statePath = join(botmuxHome, 'fleet-state.json');
  if (!existsSync(statePath)) return null;
  try {
    const state = readFleetState(statePath);
    if (!state || !state.supervisorPid) return null;
    if (checkAlive) {
      if (!checkAlive(state.supervisorPid)) return null;
    } else if (state.supervisorProcessStart) {
      if (inspectSupervisorState(state).status !== 'exact') return null;
    } else if (!pidAlive(state.supervisorPid)) {
      return null;
    }
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

function parseOwnershipRecord(raw: string): ZeroBotOwnershipRecord | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const sessionId = typeof parsed.sessionId === 'string' && parsed.sessionId.trim() ? parsed.sessionId : null;
    if (!sessionId) return null;

    if (parsed.state === 'pending') {
      if (typeof parsed.startedAt !== 'string' || !Number.isFinite(Date.parse(parsed.startedAt))) return null;
      let previousSupervisor: PendingZeroBotOwnershipRecord['previousSupervisor'];
      if (parsed.previousSupervisor !== undefined) {
        const prev = parsed.previousSupervisor as Record<string, unknown> | null;
        if (
          !prev
          || typeof prev !== 'object'
          || Array.isArray(prev)
          || typeof prev.supervisorPid !== 'number'
          || !Number.isSafeInteger(prev.supervisorPid)
          || prev.supervisorPid <= 0
          || typeof prev.supervisorStartedAt !== 'string'
          || !prev.supervisorStartedAt
        ) {
          return null;
        }
        previousSupervisor = {
          supervisorPid: prev.supervisorPid,
          supervisorStartedAt: prev.supervisorStartedAt,
        };
      }
      return {
        state: 'pending',
        sessionId,
        startedAt: parsed.startedAt,
        ...(previousSupervisor ? { previousSupervisor } : {}),
      };
    }

    if (parsed.state === 'active' || parsed.state === undefined) {
      if (
        typeof parsed.supervisorPid !== 'number'
        || !Number.isSafeInteger(parsed.supervisorPid)
        || parsed.supervisorPid <= 0
        || typeof parsed.supervisorStartedAt !== 'string'
        || !parsed.supervisorStartedAt
      ) {
        return null;
      }
      return {
        state: 'active',
        sessionId,
        supervisorPid: parsed.supervisorPid,
        supervisorStartedAt: parsed.supervisorStartedAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * File-backed session handoff store in `~/.botmux/.zero-bot-owner.json`.
 *
 * - `write()` creates `~/.botmux` with `0o700` when absent (only invoked when
 *   actively starting/adopting a 0-bot supervisor, never on untouched idle boots).
 * - `clear()` only deletes the file if it belongs to this `sessionId` (never
 *   wipes a newer app session's marker).
 */
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
        return parseOwnershipRecord(readFileSync(markerPath, 'utf-8'));
      } catch {
        return null;
      }
    },
    write(record) {
      try {
        if (!existsSync(botmuxHome)) mkdirSync(botmuxHome, { recursive: true, mode: 0o700 });
        const tmp = `${markerPath}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        renameSync(tmp, markerPath);
      } catch {
        try { rmSync(`${markerPath}.${process.pid}.tmp`, { force: true }); } catch { /* ignore */ }
      }
    },
    clear() {
      try {
        if (!existsSync(markerPath)) return;
        const current = parseOwnershipRecord(readFileSync(markerPath, 'utf-8'));
        if (current && current.sessionId !== sessionId) return;
        rmSync(markerPath, { force: true });
      } catch { /* ignore */ }
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
  let pendingRecovery: {
    startedAtMs: number;
    previousSupervisor?: { supervisorPid: number; supervisorStartedAt: string };
  } | null = null;
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

  function persistActiveOwnership(): void {
    const store = deps.ownershipStore;
    if (!store) return;
    if (phase === 'active' && ownedSupervisor) {
      store.write({
        state: 'active',
        sessionId: store.sessionId,
        supervisorPid: ownedSupervisor.supervisorPid,
        supervisorStartedAt: ownedSupervisor.supervisorStartedAt,
      });
    } else {
      store.clear();
    }
  }

  function persistPendingOwnership(previousSupervisor?: { supervisorPid: number; supervisorStartedAt: string }): void {
    const store = deps.ownershipStore;
    if (!store) return;
    store.write({
      state: 'pending',
      sessionId: store.sessionId,
      startedAt: new Date(now()).toISOString(),
      ...(previousSupervisor ? { previousSupervisor } : {}),
    });
  }

  function clearOwnershipStore(): void {
    deps.ownershipStore?.clear();
  }

  function matchesPendingLaunch(
    live: LiveSupervisorSnapshot,
    pending: { startedAtMs: number; previousSupervisor?: { supervisorPid: number; supervisorStartedAt: string } },
  ): boolean {
    if (!deps.isOwnedByApp(live)) return false;
    if (
      pending.previousSupervisor
      && live.supervisorPid === pending.previousSupervisor.supervisorPid
      && live.supervisorStartedAt === pending.previousSupervisor.supervisorStartedAt
    ) {
      return true;
    }
    const liveStartedMs = Date.parse(live.supervisorStartedAt);
    return Number.isFinite(liveStartedMs) && liveStartedMs >= pending.startedAtMs - PENDING_START_CLOCK_TOLERANCE_MS;
  }

  function tryResolvePendingRecovery(): void {
    if (!pendingRecovery || phase !== 'idle') return;
    const cfg = safeReadBotConfig();
    if (cfg.status !== 'not_configured') {
      pendingRecovery = null;
      if (cfg.status === 'configured') phase = 'graduated';
      clearOwnershipStore();
      return;
    }
    const live = safeReadLiveSupervisor();
    if (live) {
      if (matchesPendingLaunch(live, pendingRecovery)) {
        pendingRecovery = null;
        phase = 'active';
        ownedSupervisor = {
          supervisorPid: live.supervisorPid,
          supervisorStartedAt: live.supervisorStartedAt,
        };
        persistActiveOwnership();
      } else {
        pendingRecovery = null;
        clearOwnershipStore();
      }
      return;
    }
    if (now() - pendingRecovery.startedAtMs > PENDING_RECOVERY_GRACE_MS) {
      pendingRecovery = null;
      clearOwnershipStore();
    }
  }

  // Re-hydrate ownership across host relaunches within the SAME app session
  // (e.g. desktop-host exiting after applyUpdate / mtime swap or SIGKILL mid-start).
  (function rehydrateOwnership() {
    const store = deps.ownershipStore;
    if (!store) return;
    const saved = store.read();
    if (!saved || saved.sessionId !== store.sessionId) return;
    const cfg = safeReadBotConfig();
    if (cfg.status !== 'not_configured') {
      store.clear();
      return;
    }
    if (saved.state === 'active') {
      const live = safeReadLiveSupervisor();
      if (
        live
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
      return;
    }
    const startedAtMs = Date.parse(saved.startedAt);
    if (!Number.isFinite(startedAtMs)) {
      store.clear();
      return;
    }
    pendingRecovery = { startedAtMs, previousSupervisor: saved.previousSupervisor };
    tryResolvePendingRecovery();
  })();

  function reconcileAfterZeroBotLaunch(result: RunResult, gen: number): void {
    // Drop stale completions invalidated by a newer stop(), restart(), or cleanup.
    if (gen !== opGen) return;
    const configAfter = safeReadBotConfig();
    if (configAfter.status === 'configured') {
      phase = 'graduated';
      ownedSupervisor = null;
      pendingRecovery = null;
      clearOwnershipStore();
      return;
    }
    if (configAfter.status === 'invalid') {
      phase = 'idle';
      ownedSupervisor = null;
      pendingRecovery = null;
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
      pendingRecovery = null;
      persistActiveOwnership();
      return;
    }
    if (result.code === 0) {
      // Supervisor started cleanly but fleet-state was not yet readable; keep
      // active without pinned PID AND retain the pending marker until observeState
      // upgrades it to active.
      phase = 'active';
      ownedSupervisor = null;
      return;
    }
    phase = 'idle';
    ownedSupervisor = null;
    pendingRecovery = null;
    clearOwnershipStore();
  }

  async function drainInFlightLaunches(opts: {
    pending: ActiveLaunch[];
    waitBeforeAbortMs: number;
    abortGraceMs: number;
    totalDeadline: number;
  }): Promise<{ abortedInFlight: boolean; abortDeadline: number }> {
    if (opts.pending.length === 0) return { abortedInFlight: false, abortDeadline: 0 };
    const allPending = Promise.allSettled(opts.pending.map(launch => launch.promise));
    if (opts.waitBeforeAbortMs > 0) {
      const waited = await waitForPromiseOrTimeout(
        allPending,
        Math.min(opts.waitBeforeAbortMs, Math.max(0, opts.totalDeadline - now())),
      );
      if (waited.settled) return { abortedInFlight: false, abortDeadline: 0 };
    }
    const abortDeadline = Math.min(now() + opts.abortGraceMs, opts.totalDeadline);
    for (const launch of opts.pending) launch.controller.abort();
    await waitForPromiseOrTimeout(allPending, Math.max(0, abortDeadline - now()));
    return { abortedInFlight: true, abortDeadline };
  }

  async function waitForLateSupervisor(opts: {
    abortDeadline: number;
    pollMs: number;
    shouldStop?: () => boolean;
  }): Promise<LiveSupervisorSnapshot | null> {
    let live = safeReadLiveSupervisor();
    while (!live && now() < opts.abortDeadline) {
      if (opts.shouldStop?.()) return null;
      await sleepUnref(Math.min(opts.pollMs, Math.max(1, opts.abortDeadline - now())));
      if (opts.shouldStop?.()) return null;
      live = safeReadLiveSupervisor();
    }
    return live;
  }

  function launchTracked(
    kind: 'start' | 'restart',
    invoker: (options?: { signal?: AbortSignal }) => Promise<RunResult>,
    shouldTrack: boolean,
  ): Promise<RunResult> {
    if (!shouldTrack) return invoker();
    const myGen = ++opGen;
    const previousSupervisor = kind === 'restart' && ownedSupervisor ? { ...ownedSupervisor } : undefined;
    if (kind === 'restart') {
      activeStartLaunch = null;
      for (const existing of activeLaunches) existing.controller.abort();
    }
    pendingRecovery = null;
    phase = 'starting';
    ownedSupervisor = null;
    // Persist pending marker BEFORE spawning so an abnormal SIGKILL mid-start
    // still lets the relaunched host in the same session adopt and reap it.
    persistPendingOwnership(previousSupervisor);
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
    tryResolvePendingRecovery();
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

  async function stop(options?: ZeroBotStopOptions): Promise<RunResult> {
    const startedAt = now();
    const totalBudgetMs = options?.timeoutMs ?? 15_000;
    const totalDeadline = startedAt + totalBudgetMs;
    const abortGraceMs = options?.abortGraceMs ?? Math.min(1_000, totalBudgetMs);
    const postAbortPollMs = options?.postAbortPollMs ?? 50;

    const stopGen = ++opGen;
    activeStartLaunch = null;
    pendingRecovery = null;
    const pending = [...activeLaunches];

    // Wait boundedly for any in-flight 0-bot start/restart to terminate and for
    // any detached supervisor spawned right before SIGTERM to write fleet-state.
    const { abortedInFlight, abortDeadline } = await drainInFlightLaunches({
      pending,
      waitBeforeAbortMs: 0,
      abortGraceMs,
      totalDeadline,
    });
    if (stopGen !== opGen) {
      return { code: 1, stdout: '', stderr: 'Stop superseded by a newer operation', signal: null };
    }
    if (abortedInFlight) {
      await waitForLateSupervisor({
        abortDeadline,
        pollMs: postAbortPollMs,
        shouldStop: () => stopGen !== opGen,
      });
      if (stopGen !== opGen) {
        return { code: 1, stdout: '', stderr: 'Stop superseded by a newer operation', signal: null };
      }
    }

    const remainingForStop = Math.max(100, totalDeadline - now());
    const stopOpts = options?.timeoutMs !== undefined ? { timeoutMs: remainingForStop } : undefined;
    let result = await deps.runtime.stop(stopOpts);
    if (stopGen !== opGen) return result;

    let liveAfter = safeReadLiveSupervisor();
    if (
      abortedInFlight
      && liveAfter
      && deps.isOwnedByApp(liveAfter)
      && safeReadBotConfig().status === 'not_configured'
    ) {
      const retryBudget = totalDeadline - now();
      if (retryBudget > 200) {
        result = await deps.runtime.stop(options?.timeoutMs !== undefined ? { timeoutMs: retryBudget } : undefined);
        if (stopGen !== opGen) return result;
        liveAfter = safeReadLiveSupervisor();
      }
      if (liveAfter && deps.isOwnedByApp(liveAfter) && safeReadBotConfig().status === 'not_configured') {
        // Still alive after follow-up stop: retain ownership so Quit still reaps it.
        phase = 'active';
        ownedSupervisor = {
          supervisorPid: liveAfter.supervisorPid,
          supervisorStartedAt: liveAfter.supervisorStartedAt,
        };
        persistActiveOwnership();
        return result;
      }
    }

    if (liveAfter === null || (!abortedInFlight && result.code === 0)) {
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
    tryResolvePendingRecovery();
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
    pendingRecovery = null;
    phase = 'active';
    ownedSupervisor = {
      supervisorPid: live.supervisorPid,
      supervisorStartedAt: live.supervisorStartedAt,
    };
    persistActiveOwnership();
    return true;
  }

  function observeState(state: DesktopRuntimeState): void {
    if (state.botCount > 0) {
      pendingRecovery = null;
      phase = 'graduated';
      ownedSupervisor = null;
      clearOwnershipStore();
      return;
    }
    tryResolvePendingRecovery();
    if (phase === 'active' && !ownedSupervisor && state.status === 'running') {
      const live = safeReadLiveSupervisor();
      if (live && deps.isOwnedByApp(live)) {
        ownedSupervisor = {
          supervisorPid: live.supervisorPid,
          supervisorStartedAt: live.supervisorStartedAt,
        };
        persistActiveOwnership();
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
    tryResolvePendingRecovery();
    return phase === 'starting' || phase === 'active' || activeLaunches.size > 0;
  }

  async function performCleanup(options: ZeroBotCleanupOptions): Promise<ZeroBotCleanupOutcome> {
    const totalTimeoutMs = options.totalTimeoutMs ?? 5_000;
    const waitInFlightMs = options.waitInFlightMs ?? 2_000;
    const abortGraceMs = options.abortGraceMs ?? 1_000;
    const postAbortPollMs = options.postAbortPollMs ?? 50;
    const startedAt = now();
    const totalDeadline = startedAt + totalTimeoutMs;

    tryResolvePendingRecovery();
    if (!needsQuitCleanup()) return 'skipped-not-owned';

    const pending = [...activeLaunches];
    const { abortedInFlight, abortDeadline } = await drainInFlightLaunches({
      pending,
      waitBeforeAbortMs: waitInFlightMs,
      abortGraceMs,
      totalDeadline,
    });

    // Invalidate any straggler launch so nothing can overwrite phase once cleanup begins.
    opGen += 1;
    activeStartLaunch = null;
    pendingRecovery = null;

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
      live = await waitForLateSupervisor({
        abortDeadline,
        pollMs: postAbortPollMs,
        shouldStop: () => safeReadBotConfig().status !== 'not_configured',
      });
      const polledConfig = safeReadBotConfig();
      if (polledConfig.status !== 'not_configured') {
        phase = polledConfig.status === 'configured' ? 'graduated' : 'idle';
        ownedSupervisor = null;
        clearOwnershipStore();
        return 'skipped-configured';
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

    const remainingMs = totalDeadline - now();
    if (remainingMs <= 0) {
      deps.warn?.('0-bot quit cleanup timed out before stop');
      phase = 'idle';
      ownedSupervisor = null;
      clearOwnershipStore();
      return 'timeout';
    }

    const stopTimeoutMs = Math.max(1_500, remainingMs);
    try {
      const stopArgs: { supervisorPid: number; hostPid?: number; timeoutMs: number } = {
        supervisorPid: live.supervisorPid,
        timeoutMs: stopTimeoutMs,
      };
      if (typeof deps.hostPid === 'number' && Number.isSafeInteger(deps.hostPid) && deps.hostPid > 0) {
        stopArgs.hostPid = deps.hostPid;
      }
      const stopPromise = deps.runtime.stopIfEmpty(stopArgs);
      const stopRace = await waitForPromiseOrTimeout(stopPromise, Math.max(100, remainingMs));
      if (!stopRace.settled) {
        phase = 'idle';
        ownedSupervisor = null;
        clearOwnershipStore();
        deps.warn?.('0-bot quit cleanup exceeded total timeout budget');
        return 'timeout';
      }
      if (stopRace.value.code !== 0) {
        phase = 'idle';
        ownedSupervisor = null;
        clearOwnershipStore();
        deps.warn?.(`0-bot quit cleanup failed: ${stopRace.value.stderr || stopRace.value.stdout || `exit ${stopRace.value.code}`}`);
        return 'failed';
      }

      const cliOutcome = parseStopIfEmptyCliOutcome(stopRace.value.stdout);
      if (cliOutcome === 'skipped:other-host') {
        phase = 'idle';
        ownedSupervisor = null;
        // Preserve .zero-bot-owner.json if another host adopted this session.
        return 'skipped-other-host';
      }
      if (cliOutcome === 'skipped:configured') {
        phase = 'graduated';
        ownedSupervisor = null;
        clearOwnershipStore();
        return 'skipped-configured';
      }
      if (cliOutcome === 'skipped:invalid-config') {
        phase = 'idle';
        ownedSupervisor = null;
        clearOwnershipStore();
        return 'skipped-configured';
      }
      if (cliOutcome === 'skipped:not-running') {
        phase = 'idle';
        ownedSupervisor = null;
        clearOwnershipStore();
        return 'skipped-not-running';
      }
      if (cliOutcome === 'skipped:pid-mismatch') {
        phase = 'idle';
        ownedSupervisor = null;
        clearOwnershipStore();
        return 'skipped-unowned';
      }
      if (cliOutcome === 'stopped') {
        phase = 'idle';
        ownedSupervisor = null;
        clearOwnershipStore();
        return 'stopped';
      }

      // Fallback when stopIfEmpty is stubbed in unit tests without emitting the marker.
      phase = 'idle';
      ownedSupervisor = null;
      clearOwnershipStore();
      const after = safeReadLiveSupervisor();
      if (after && after.supervisorPid !== live.supervisorPid) {
        return 'skipped-unowned';
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
      tryResolvePendingRecovery();
      return phase;
    },
    getOwnedSupervisor(): { supervisorPid: number; supervisorStartedAt: string } | null {
      tryResolvePendingRecovery();
      return ownedSupervisor ? { ...ownedSupervisor } : null;
    },
  };
}
