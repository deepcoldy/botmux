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
  /** Host-wide CPU utilization from this tick's /proc/stat delta. */
  hostCpuPct: number;
}

export interface IdleSpinDetector {
  tick(config: ResolvedIdleSpinSuspendConfig): Promise<IdleSpinTickResult>;
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
    const strictCandidates = selectIdleSuspendCandidates(deps.activeSessions, {
      olderThanMs,
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

    const eligibleIds = new Set(eligible.map(entry => entry.sessionId));
    for (const sessionId of [...streaks.keys()]) {
      if (!eligibleIds.has(sessionId)) streaks.delete(sessionId);
    }
    if (eligible.length === 0) {
      return { ...EMPTY_RESULT, candidates: strictCandidates.length };
    }

    const targets: IdleSpinTarget[] = eligible.map(({ sessionId, ds }) => {
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
    });

    let markers: ReadonlyMap<number, CliMarkerInfo> | undefined;
    try {
      markers = deps.readMarkers?.();
    } catch (err) {
      logger.warn(`[idle-spin] marker read failed: ${err instanceof Error ? err.message : String(err)}`);
    }

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

    const victims = eligible
      .filter(({ sessionId }) => (streaks.get(sessionId)?.count ?? 0) >= config.consecutiveSamples)
      .slice(0, config.maxSuspendsPerSample)
      .map(entry => entry.sessionId);
    if (victims.length === 0) {
      return {
        candidates: eligible.length,
        sampled: sample.sessions.size,
        overThreshold,
        suspended: 0,
        invalid: sample.invalid.size,
        gateBusy: false,
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
      hostCpuPct: sample.hostCpuPct,
    };
  }

  return {
    tick,
    reset,
    streaks: () => new Map([...streaks].map(([sessionId, entry]) => [sessionId, entry.count] as const)),
  };
}
