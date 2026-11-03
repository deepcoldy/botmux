/**
 * Marginal-admission rescue orchestration: when a worker fork is rejected in
 * the marginal memory band (available memory below reserve by ≤ MARGIN),
 * reclaim idle workers, wait briefly for the kernel to return their pages, and
 * re-check admission exactly once.
 *
 * This module owns only the injectable orchestration (reclaim → sleep →
 * recheck). It deliberately imports neither worker-pool nor the sweeper at
 * runtime — the reclaim action is injected by the caller — so the whole flow is
 * unit-testable with fake clocks and fakes, and no import cycle is introduced.
 */
import { scaleMs } from '../utils/timing.js';
import type { WorkerAdmissionDecision } from './worker-budget.js';
import type { IdleWorkerSweepResult } from './idle-worker-sweeper.js';

/** Wall-clock wait between reclaiming idle workers and the single re-check. */
export const MARGINAL_ADMISSION_RETRY_DELAY_MS = 2_000;

/**
 * Default wait: BOTMUX_TIME_SCALE aware (like utils/timing.delay) but unref'd
 * so a rescue in flight never holds daemon shutdown hostage for up to 2s; the
 * registry generation guard makes acting after shutdown a no-op anyway.
 */
const unrefDelay = (ms: number): Promise<void> => new Promise(resolve => {
  const timer = setTimeout(resolve, scaleMs(ms));
  timer.unref?.();
});

export type MarginalAdmissionRetryOutcome =
  | { result: 'allowed'; decision: WorkerAdmissionDecision; reclaimed: number }
  | { result: 'still_blocked'; decision: WorkerAdmissionDecision; reclaimed: number };

export interface MarginalAdmissionRetryDeps {
  /** Re-read host/cgroup pressure and re-evaluate admission after the wait. */
  readAdmission: () => WorkerAdmissionDecision;
  /** Suspend eligible idle workers (already gated by the caller). */
  reclaim: () => Promise<IdleWorkerSweepResult[]> | IdleWorkerSweepResult[];
  /** Injectable sleep for tests; production uses the unref'd, BOTMUX_TIME_SCALE-aware wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Defaults to {@link MARGINAL_ADMISSION_RETRY_DELAY_MS}. */
  delayMs?: number;
}

/**
 * Reclaim → sleep → re-check, exactly once. Returns the fresh decision plus how
 * many idle sessions were suspended, so the caller can either proceed with the
 * fork or reject with a message that names the reclamation attempt.
 */
export async function runMarginalAdmissionRetry(
  deps: MarginalAdmissionRetryDeps,
): Promise<MarginalAdmissionRetryOutcome> {
  const suspended = await deps.reclaim();
  await (deps.sleep ?? unrefDelay)(deps.delayMs ?? MARGINAL_ADMISSION_RETRY_DELAY_MS);
  const decision = deps.readAdmission();
  return decision.allowed
    ? { result: 'allowed', decision, reclaimed: suspended.length }
    : { result: 'still_blocked', decision, reclaimed: suspended.length };
}

/**
 * Coalesce concurrent marginal rejections for the same key: two forks racing
 * into the marginal band for the same session share ONE reclaim + wait +
 * re-check instead of each suspending workers and racing their re-forks. Each
 * caller still receives the outcome and re-enters its own fork afterwards.
 */
export function coalesceMarginalAdmissionRetry<K extends object>(
  pending: WeakMap<K, Promise<MarginalAdmissionRetryOutcome>>,
  key: K,
  deps: MarginalAdmissionRetryDeps,
): Promise<MarginalAdmissionRetryOutcome> {
  const existing = pending.get(key);
  if (existing) return existing;
  const promise = runMarginalAdmissionRetry(deps).finally(() => {
    if (pending.get(key) === promise) pending.delete(key);
  });
  pending.set(key, promise);
  return promise;
}
