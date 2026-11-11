import {
  INITIAL_OVERLOAD_STATE,
  evaluateOverload,
  type HostReading,
  type OverloadState,
  type OverloadThresholds,
} from './host-overload-alert.js';
import type { ResolvedIdleSpinHostPressureConfig } from './idle-spin-config.js';

/**
 * Host-pressure backstop (Layer 2).
 *
 * Threshold source is deliberately explicit: load / memory / swap come from
 * the existing `hostOverloadAlert` resolver (`resolveOverloadThresholds()`),
 * which already applies global config + `BOTMUX_OVERLOAD_*` env overrides and
 * works even when the alert itself is disabled. Only the CPU dimension is new
 * and per-bot (`idleSpinSuspend.hostPressure.enterCpuPercent`), because the
 * existing alert has no CPU dimension.
 *
 * Hysteresis is the existing `evaluateOverload` state machine (enter/exit
 * bars). This module adds only the reclaim-specific sustained-sample strike
 * counter and cooldown:
 *  - `afterSamples` consecutive overloaded samples before the first pass;
 *  - inside one overload episode, each sampling tick may reclaim again until
 *    no eligible candidate remains;
 *  - a 0-result pass or episode recovery starts the cooldown.
 */
export interface HostPressureState {
  overloadState: OverloadState;
  strikes: number;
  cooldownUntil: number;
}

export const INITIAL_HOST_PRESSURE_STATE: HostPressureState = {
  overloadState: INITIAL_OVERLOAD_STATE,
  strikes: 0,
  cooldownUntil: 0,
};

export interface HostPressureReading extends HostReading {
  /** Host-wide CPU utilization (0..100). */
  cpuPct: number;
}

export interface HostPressureEvaluation {
  state: HostPressureState;
  overloaded: boolean;
  strikes: number;
  /** True when the caller should run one reclaim pass now. */
  shouldReclaim: boolean;
}

export function evaluateHostPressure(
  prev: HostPressureState,
  reading: HostPressureReading,
  config: ResolvedIdleSpinHostPressureConfig,
  now: number,
  baseThresholds: OverloadThresholds,
): HostPressureEvaluation {
  const thresholds: OverloadThresholds = {
    ...baseThresholds,
    enterCpuPct: config.enterCpuPercent,
    exitCpuPct: config.exitCpuPercent,
  };
  const evaluation = evaluateOverload(prev.overloadState, reading, thresholds, now);
  const overloaded = evaluation.nextState.overloaded;

  if (!overloaded) {
    // Only an overloaded → healthy EDGE starts a cooldown. A healthy tick
    // before the first overload must not arm one: a daemon that boots on a
    // healthy host and then accumulates 53 idle spinners would otherwise
    // suppress its first reclaim for `cooldownMinutes`.
    const recoveredEdge = prev.overloadState.overloaded;
    return {
      state: {
        overloadState: evaluation.nextState,
        strikes: 0,
        cooldownUntil: recoveredEdge
          ? now + Math.max(0, config.cooldownMinutes) * 60_000
          : prev.cooldownUntil,
      },
      overloaded: false,
      strikes: 0,
      shouldReclaim: false,
    };
  }

  const strikes = prev.strikes + 1;
  const shouldReclaim = config.enabled
    && strikes >= config.afterSamples
    && now >= prev.cooldownUntil;
  return {
    state: {
      overloadState: evaluation.nextState,
      strikes,
      cooldownUntil: prev.cooldownUntil,
    },
    overloaded: true,
    strikes,
    shouldReclaim,
  };
}

export interface HostPressureTickResult extends HostPressureEvaluation {
  /** Sessions suspended by this tick, or null when the mutation gate was busy. */
  reclaimed: number | null;
}

/**
 * One sampling tick. `reclaim` returns the number of sessions parked, or null
 * when the bot-wide admission gate stayed busy (retry next tick, keep strikes).
 * A 0-result pass starts the cooldown; a positive pass keeps the episode hot so
 * the next tick can continue draining a large idle fleet.
 */
export async function runHostPressureTick(opts: {
  state: HostPressureState;
  reading: HostPressureReading;
  config: ResolvedIdleSpinHostPressureConfig;
  now: number;
  reclaim: () => Promise<number | null>;
  baseThresholds: OverloadThresholds;
}): Promise<HostPressureTickResult> {
  const evaluation = evaluateHostPressure(
    opts.state,
    opts.reading,
    opts.config,
    opts.now,
    opts.baseThresholds,
  );
  if (!evaluation.shouldReclaim) {
    return { ...evaluation, reclaimed: 0 };
  }

  const reclaimed = await opts.reclaim();
  if (reclaimed === null) {
    return { ...evaluation, reclaimed: null };
  }
  if (reclaimed === 0) {
    return {
      ...evaluation,
      state: {
        ...evaluation.state,
        // Keep the episode armed: once the cooldown expires, a newly-idle
        // candidate is reclaimed on the next tick instead of waiting another
        // `afterSamples` window. Recovery still resets strikes to 0.
        strikes: Math.max(evaluation.strikes, opts.config.afterSamples),
        cooldownUntil: opts.now + Math.max(0, opts.config.cooldownMinutes) * 60_000,
      },
      reclaimed: 0,
    };
  }
  return { ...evaluation, reclaimed };
}
