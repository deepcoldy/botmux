import type { DaemonSession } from './types.js';
import type { CliId } from '../adapters/cli/types.js';
import type { CliMarkerInfo } from './resource-monitor/attribution.js';
import type { ResolvedIdleSpinSuspendConfig } from './idle-spin-config.js';
import type { IdleSpinSampler, IdleSpinTarget } from './idle-spin-sampler.js';
import {
  selectIdleSuspendCandidates,
  suspendSelectedIdleCandidatesAfterTurnDrain,
} from './idle-worker-sweeper.js';
import { observeTraexInstall } from '../services/traex-install-watch.js';
import { logger } from '../utils/logger.js';

export interface IdleSpinDetectorDeps {
  larkAppId: string;
  activeSessions: Map<string, DaemonSession>;
  /** Bot-level CLI used when a restored session has no frozen cliId. May be a
   *  getter so a hot CLI change applies without recreating the detector. */
  defaultCliId?: CliId | (() => CliId | undefined);
  sampler: IdleSpinSampler;
  readMarkers?: () => ReadonlyMap<number, CliMarkerInfo>;
  /** Install/identity observation seam; production uses `observeTraexInstall`. */
  observeInstall?: (ds: DaemonSession, cliId: CliId, now: number) => { state: string };
  now?: () => number;
  mutationAcquireTimeoutMs?: number;
  /** Checked immediately before the suspend action (daemon shutdown fence). */
  shouldAbort?: () => boolean;
}

export interface IdleSpinTickResult {
  candidates: number;
  sampled: number;
  overThreshold: number;
  suspended: number;
  invalid: number;
  gateBusy: boolean;
  /** Over-threshold sessions NOT suspended because their CLI still has live
   *  child processes (background task, tool shell, MCP server…) or the
   *  children could not be read. */
  busyChildren: number;
  /** Host-wide CPU utilization from this tick's /proc/stat delta. */
  hostCpuPct: number;
}

export interface IdleSpinDetector {
  tick(config: ResolvedIdleSpinSuspendConfig): Promise<IdleSpinTickResult>;
  /**
   * One host-pressure (Layer 2) reclaim pass. Parks at most
   * `hostPressure.maxSuspendsPerPass` of the SAME sessions Layer 1 may act on
   * (strict idle selector ∩ `cliIds` ∩ proven TRAE identity) whose CLI has no
   * live child process. Layer 2 only drops the per-session CPU requirement; it
   * never widens the CLI scope, so with the default `cliIds: ['traex']` no
   * other CLI's idle session is touched by a host overload.
   * Returns the number parked, or null when the bot gate stayed busy.
   */
  reclaimHostPressure(config: ResolvedIdleSpinSuspendConfig): Promise<number | null>;
  reset(): void;
  /** Test/diagnostics view: sessionId → consecutive over-threshold samples. */
  streaks(): ReadonlyMap<string, number>;
}

const EMPTY_RESULT: IdleSpinTickResult = {
  candidates: 0,
  sampled: 0,
  overThreshold: 0,
  suspended: 0,
  invalid: 0,
  gateBusy: false,
  busyChildren: 0,
  hostCpuPct: 0,
};

function effectiveCliId(
  ds: DaemonSession,
  fallback?: CliId | (() => CliId | undefined),
): CliId | undefined {
  const resolvedFallback = typeof fallback === 'function' ? fallback() : fallback;
  return (ds.session.cliLaunchSnapshot?.cliId
    ?? ds.session.cliId
    ?? ds.initConfig?.cliId
    ?? resolvedFallback) as CliId | undefined;
}

/**
 * CPU-driven idle-spin detector (Layer 1).
 *
 * Selection is deliberately the SAME strict predicate the operator age sweep
 * uses (`selectIdleSuspendCandidates`): live, active, workerReady, idle,
 * non-adopted, resumable backend, not locked, and no unsettled work
 * (including accepted-but-unsubmitted input, scheduled runs, activations,
 * keep-alive and idle auto-compact). The CPU sampler only narrows that set.
 *
 * Consecutive over-threshold samples are required, and the streak is reset by
 * any sample that is below threshold, invalid, or no longer a strict
 * candidate. State is in-memory: a daemon restart starts every streak at zero,
 * and a restored session without `idleSinceAt` uses the conservative
 * last-message/spawn clocks from the selector rather than an invented idle
 * edge.
 */
export function createIdleSpinDetector(deps: IdleSpinDetectorDeps): IdleSpinDetector {
  const now = deps.now ?? (() => Date.now());
  // A streak belongs to one worker generation. A crash/re-fork that did not
  // suspend must not inherit the old generation's count and get parked on its
  // first idle sample.
  const streaks = new Map<string, { generation: number | undefined; count: number }>();
  let lastConfigKey = '';

  function reset(): void {
    streaks.clear();
    lastConfigKey = '';
  }

  /** Strict idle candidates narrowed to `cliIds` and a proven TRAE identity.
   *  Shared by Layer 1 and Layer 2 so the two can never disagree on scope. */
  function selectEligible(
    config: ResolvedIdleSpinSuspendConfig,
    at: number,
  ): { strictCount: number; eligible: Array<{ sessionId: string; ds: DaemonSession }> } {
    const strictCandidates = selectIdleSuspendCandidates(deps.activeSessions, {
      olderThanMs: Math.max(1, config.minIdleMinutes * 60_000),
      now: at,
    });
    const bySessionId = new Map(
      [...deps.activeSessions.values()].map(ds => [ds.session.sessionId, ds] as const),
    );
    const eligible: Array<{ sessionId: string; ds: DaemonSession }> = [];
    for (const candidate of strictCandidates) {
      const ds = bySessionId.get(candidate.sessionId);
      if (!ds) continue;
      const cliId = effectiveCliId(ds, deps.defaultCliId);
      if (!cliId || !config.cliIds.includes(cliId)) continue;
      // Pinned old installs and unknown process identities must never be
      // reclaimed automatically. `observeTraexInstall` is cached for 15s and
      // never runs a `--version` probe.
      if (cliId === 'traex') {
        const observation = (deps.observeInstall ?? observeTraexInstall)(ds, cliId, at);
        if (observation.state !== 'current' && observation.state !== 'not-traex') continue;
      }
      eligible.push({ sessionId: candidate.sessionId, ds });
    }
    return { strictCount: strictCandidates.length, eligible };
  }

  function targetFor(sessionId: string, ds: DaemonSession): IdleSpinTarget {
    const att = ds.localProcessAttestation;
    return {
      sessionId,
      ...(ds.worker?.pid !== undefined ? { workerPid: ds.worker.pid } : {}),
      ...(ds.workerGeneration !== undefined ? { workerGeneration: ds.workerGeneration } : {}),
      ...(att
        ? {
          attestation: {
            ...(att.workerGeneration !== undefined ? { workerGeneration: att.workerGeneration } : {}),
            ...(att.cliPid !== undefined ? { cliPid: att.cliPid } : {}),
            ...(att.cliProcStart !== undefined ? { cliProcStart: att.cliProcStart } : {}),
            ...(att.enginePid !== undefined ? { enginePid: att.enginePid } : {}),
            ...(att.engineProcStart !== undefined ? { engineProcStart: att.engineProcStart } : {}),
          },
        }
        : {}),
    };
  }

  function readMarkers(): ReadonlyMap<number, CliMarkerInfo> | undefined {
    try {
      return deps.readMarkers?.();
    } catch (err) {
      logger.warn(`[idle-spin] marker read failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  async function tick(config: ResolvedIdleSpinSuspendConfig): Promise<IdleSpinTickResult> {
    if (!config.enabled) {
      streaks.clear();
      return EMPTY_RESULT;
    }

    const configKey = JSON.stringify({
      cliIds: config.cliIds,
      cpuPercent: config.cpuPercent,
      consecutiveSamples: config.consecutiveSamples,
      minIdleMinutes: config.minIdleMinutes,
    });
    if (configKey !== lastConfigKey) {
      streaks.clear();
      lastConfigKey = configKey;
    }

    const at = now();
    const olderThanMs = Math.max(1, config.minIdleMinutes * 60_000);
    const { strictCount, eligible } = selectEligible(config, at);

    const eligibleIds = new Set(eligible.map(entry => entry.sessionId));
    for (const sessionId of [...streaks.keys()]) {
      if (!eligibleIds.has(sessionId)) streaks.delete(sessionId);
    }
    if (eligible.length === 0) {
      return { ...EMPTY_RESULT, candidates: strictCount };
    }

    const targets = eligible.map(({ sessionId, ds }) => targetFor(sessionId, ds));
    const markers = readMarkers();

    const sample = await deps.sampler.sample(targets, markers);
    if (!sample.supported) {
      // Non-Linux (or unreadable procfs): fail closed, never auto-suspend.
      // An invalid sample is not evidence of calm, so clear the streaks too.
      streaks.clear();
      return { ...EMPTY_RESULT, candidates: eligible.length, invalid: eligible.length };
    }

    let overThreshold = 0;
    for (const { sessionId, ds } of eligible) {
      const measured = sample.sessions.get(sessionId);
      if (!measured || measured.cpuPercent < config.cpuPercent) {
        streaks.delete(sessionId);
        continue;
      }
      const generation = ds.workerGeneration;
      const previous = streaks.get(sessionId);
      const count = previous && previous.generation === generation ? previous.count + 1 : 1;
      streaks.set(sessionId, { generation, count });
      if (count >= config.consecutiveSamples) overThreshold += 1;
    }

    const overIds = eligible
      .filter(({ sessionId }) => (streaks.get(sessionId)?.count ?? 0) >= config.consecutiveSamples)
      .map(entry => entry.sessionId);
    // Veto before acting: high subtree CPU is ALSO what an idle CLI looks like
    // while a background task it started (TRAE `background_shell`, dev server,
    // build, watcher) keeps running. TRAE reports no structured background-task
    // count, so the strict selector cannot see that work; a suspend would kill
    // it. Read the CLI's children fresh and only park a childless CLI.
    const childCounts = overIds.length > 0
      ? deps.sampler.liveCliChildren(targets.filter(target => overIds.includes(target.sessionId)), markers)
      : new Map<string, number | null>();
    let busyChildren = 0;
    const victims: string[] = [];
    for (const sessionId of overIds) {
      if (childCounts.get(sessionId) !== 0) {
        busyChildren += 1;
        // Start over once the work is gone: the session must then show
        // `consecutiveSamples` fresh over-threshold samples on its own.
        streaks.delete(sessionId);
        continue;
      }
      if (victims.length < config.maxSuspendsPerSample) victims.push(sessionId);
    }
    if (victims.length === 0) {
      return {
        candidates: eligible.length,
        sampled: sample.sessions.size,
        overThreshold,
        suspended: 0,
        invalid: sample.invalid.size,
        gateBusy: false,
        busyChildren,
        hostCpuPct: sample.hostCpuPct,
      };
    }

    if (deps.shouldAbort?.()) {
      // Daemon shutdown started while the async sample was in flight: never
      // park a worker the shutdown path is already fencing.
      return {
        candidates: eligible.length,
        sampled: sample.sessions.size,
        overThreshold,
        suspended: 0,
        invalid: sample.invalid.size,
        gateBusy: false,
        busyChildren,
        hostCpuPct: sample.hostCpuPct,
      };
    }

    const result = await suspendSelectedIdleCandidatesAfterTurnDrain(
      deps.larkAppId,
      deps.activeSessions,
      new Set(victims),
      {
        olderThanMs,
        now: at,
        reason: 'idle_spin',
        maxCandidates: config.maxSuspendsPerSample,
        ...(deps.mutationAcquireTimeoutMs !== undefined
          ? { mutationAcquireTimeoutMs: deps.mutationAcquireTimeoutMs }
          : {}),
        ...(deps.shouldAbort ? { shouldAbort: deps.shouldAbort } : {}),
      },
    );
    if (result === null) {
      // The bot-wide admission gate is busy. Keep the streaks and retry on the
      // next tick instead of blocking the daemon.
      return {
        candidates: eligible.length,
        sampled: sample.sessions.size,
        overThreshold,
        suspended: 0,
        invalid: sample.invalid.size,
        gateBusy: true,
        busyChildren,
        hostCpuPct: sample.hostCpuPct,
      };
    }

    for (const entry of result.suspended) streaks.delete(entry.sessionId);
    if (result.suspended.length > 0) {
      logger.info(
        `[idle-spin] bot=${deps.larkAppId} suspended=${result.suspended.length} `
        + `candidates=${eligible.length} sampled=${sample.sessions.size} `
        + `over=${overThreshold} invalid=${sample.invalid.size} `
        + `threshold=${config.cpuPercent}%x${config.consecutiveSamples}`,
      );
    }

    return {
      candidates: eligible.length,
      sampled: sample.sessions.size,
      overThreshold,
      suspended: result.suspended.length,
      invalid: sample.invalid.size,
      gateBusy: false,
      busyChildren,
      hostCpuPct: sample.hostCpuPct,
    };
  }

  function hostPressureCandidates(config: ResolvedIdleSpinSuspendConfig): ReadonlySet<string> {
    if (!config.enabled || config.cliIds.length === 0) return new Set();
    const { eligible } = selectEligible(config, now());
    if (eligible.length === 0) return new Set();
    const counts = deps.sampler.liveCliChildren(
      eligible.map(({ sessionId, ds }) => targetFor(sessionId, ds)),
      readMarkers(),
    );
    return new Set(eligible
      .map(entry => entry.sessionId)
      .filter(sessionId => counts.get(sessionId) === 0));
  }

  async function reclaimHostPressure(config: ResolvedIdleSpinSuspendConfig): Promise<number | null> {
    if (deps.shouldAbort?.()) return null;
    const selectIds = hostPressureCandidates(config);
    if (selectIds.size === 0) return 0;
    const result = await suspendSelectedIdleCandidatesAfterTurnDrain(
      deps.larkAppId,
      deps.activeSessions,
      selectIds,
      {
        olderThanMs: Math.max(1, config.minIdleMinutes * 60_000),
        now: now(),
        reason: 'host_pressure',
        maxCandidates: config.hostPressure.maxSuspendsPerPass,
        ...(deps.mutationAcquireTimeoutMs !== undefined
          ? { mutationAcquireTimeoutMs: deps.mutationAcquireTimeoutMs }
          : {}),
        ...(deps.shouldAbort ? { shouldAbort: deps.shouldAbort } : {}),
      },
    );
    if (result === null) return null;
    for (const entry of result.suspended) streaks.delete(entry.sessionId);
    return result.suspended.length;
  }

  return {
    tick,
    reclaimHostPressure,
    reset,
    streaks: () => new Map([...streaks].map(([sessionId, entry]) => [sessionId, entry.count] as const)),
  };
}
