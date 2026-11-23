import type { DaemonSession } from './types.js';
import type { StreamStatus } from '../types.js';

/** A starting card gets one bounded chance to prove that its own turn is making
 * progress. A queued turn's chance starts only when its capture identity activates. */
export const STARTING_CARD_HEALTH_DELAY_MS = 45_000;

export type StartingCardHealthEntry = {
  turnId: string;
  dispatchAttempt: number | undefined;
  generation: number | undefined;
  cardId: string;
  /** A deferred entry is waiting for its turn to become the capture producer. */
  deferred: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  delivered: boolean;
  warned: boolean;
  delayMs: number;
  onDegrade: (entry: StartingCardHealthEntry, onSettled: (delivered: boolean) => void) => void;
};

type HealthyObservation = { turnId: string; sequence: number };

const pending = new WeakMap<DaemonSession, StartingCardHealthEntry>();
/** Display-only state: set when degradation starts, retained until a qualifying
 * healthy frame, terminal, replacement card, or identity change clears it. */
const degraded = new WeakMap<DaemonSession, StartingCardHealthEntry>();
const latestHealthy = new WeakMap<DaemonSession, HealthyObservation>();
let healthySequence = 0;

function dispatchAttemptFor(ds: DaemonSession, turnId: string): number | undefined {
  const highWater = ds.turnDispatchAttemptHighWater;
  return highWater?.turnId === turnId ? highWater.dispatchAttempt : undefined;
}

function identityStillCurrent(ds: DaemonSession, entry: StartingCardHealthEntry): boolean {
  return ds.session.status === 'active'
    && ds.currentTurnId === entry.turnId
    && ds.streamCardId === entry.cardId
    && (ds.workerGeneration ?? ds.session.workerGeneration) === entry.generation
    && dispatchAttemptFor(ds, entry.turnId) === entry.dispatchAttempt;
}

export function startingCardHealthEntryStillCurrent(
  ds: DaemonSession,
  entry: StartingCardHealthEntry,
): boolean {
  return pending.get(ds) === entry && identityStillCurrent(ds, entry);
}

/** Preserve the display-only stalled state through ordinary card renders. An
 * explicit render for another turn must not inherit the current turn's warning. */
export function startingCardHealthStalledStatus(
  ds: DaemonSession,
  turnId?: string,
): 'stalled' | undefined {
  const entry = degraded.get(ds);
  if (ds.session.suspendedColdResume || ds.crashDiagnosticParked) return undefined;
  if (!entry || !identityStillCurrent(ds, entry)) return undefined;
  if (turnId !== undefined && turnId !== entry.turnId) return undefined;
  return 'stalled';
}

/** Monotonic observation sequence, not wall time: a healthy frame during a card
 * POST must outrank the sequence captured before that POST, even in the same ms. */
export function startingCardHealthySequence(ds: DaemonSession, turnId: string): number {
  const latest = latestHealthy.get(ds);
  return latest?.turnId === turnId ? latest.sequence : 0;
}

/** Record only a non-starting frame. Returns whether this frame cleared a visible
 * degraded state and therefore needs a repaint even when execution status is unchanged. */
export function noteStartingCardHealthFrame(
  ds: DaemonSession,
  turnId: string | undefined,
  status: StreamStatus,
): boolean {
  if (status === 'starting') return false;
  const current = pending.get(ds);
  if (current && turnId !== undefined && current.turnId !== turnId) return false;
  // While a follow-up is queued, an unattributed frame or prompt_ready may belong
  // to its predecessor. Once the turn activates, legacy untagged frames count again.
  if (current?.deferred && turnId !== current.turnId) return false;
  const visibleDegraded = degraded.get(ds);
  if (visibleDegraded && !identityStillCurrent(ds, visibleDegraded)) {
    degraded.delete(ds);
  }
  const currentDegraded = degraded.get(ds);
  if (currentDegraded && turnId !== undefined && currentDegraded.turnId !== turnId) return false;

  healthySequence += 1;
  latestHealthy.set(ds, {
    turnId: turnId ?? current?.turnId ?? currentDegraded?.turnId ?? '',
    sequence: healthySequence,
  });
  if (current) {
    if (current.timer) clearTimeout(current.timer);
    pending.delete(ds);
  }
  if (!currentDegraded) return false;
  degraded.delete(ds);
  return true;
}

function entryMatchesTerminal(
  entry: StartingCardHealthEntry,
  turnId: string,
  dispatchAttempt: number | undefined,
): boolean {
  return entry.turnId === turnId
    && (dispatchAttempt === undefined || entry.dispatchAttempt === undefined
      || entry.dispatchAttempt === dispatchAttempt);
}

export function closeStartingCardHealth(
  ds: DaemonSession,
  turnId: string,
  dispatchAttempt?: number,
): void {
  const current = pending.get(ds);
  if (current && entryMatchesTerminal(current, turnId, dispatchAttempt)) {
    if (current.timer) clearTimeout(current.timer);
    pending.delete(ds);
  }
  const currentDegraded = degraded.get(ds);
  if (currentDegraded && entryMatchesTerminal(currentDegraded, turnId, dispatchAttempt)) {
    degraded.delete(ds);
  }
}

export function resetStartingCardHealth(ds: DaemonSession): void {
  const current = pending.get(ds);
  if (current?.timer) clearTimeout(current.timer);
  pending.delete(ds);
  degraded.delete(ds);
}

function fireStartingCardHealth(ds: DaemonSession, entry: StartingCardHealthEntry): void {
  entry.timer = null;
  if (pending.get(ds) !== entry || entry.delivered) return;
  if (!startingCardHealthEntryStillCurrent(ds, entry)) {
    if (pending.get(ds) === entry) pending.delete(ds);
    if (degraded.get(ds) === entry) degraded.delete(ds);
    return;
  }
  // Set the display state before scheduling so every newer ordinary render also
  // preserves stalled. A failed PATCH retries under the same identity.
  degraded.set(ds, entry);
  entry.onDegrade(entry, delivered => {
    if (delivered) {
      entry.delivered = true;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      return;
    }
    if (pending.get(ds) !== entry) return;
    scheduleStartingCardHealthFire(ds, entry);
  });
}

function scheduleStartingCardHealthFire(ds: DaemonSession, entry: StartingCardHealthEntry): void {
  entry.timer = setTimeout(() => fireStartingCardHealth(ds, entry), entry.delayMs);
  entry.timer.unref?.();
}

/** Start the grace period when a queued turn becomes the terminal producer. */
export function activateStartingCardHealth(ds: DaemonSession, turnId: string): void {
  const entry = pending.get(ds);
  if (!entry || entry.turnId !== turnId || !entry.deferred || entry.delivered) return;
  // A queued publication may precede the first numeric attempt known for its
  // turn. Adopt that first identity only; an already-known attempt must still
  // fail the identity check when a retry takes over before activation.
  if (entry.dispatchAttempt === undefined) entry.dispatchAttempt = dispatchAttemptFor(ds, turnId);
  if (!startingCardHealthEntryStillCurrent(ds, entry)) {
    closeStartingCardHealth(ds, turnId, entry.dispatchAttempt);
    return;
  }
  entry.deferred = false;
  scheduleStartingCardHealthFire(ds, entry);
}

/** Arm after the real starting-card id exists. `afterHealthySeq` is captured
 * before the POST; only a strictly newer healthy observation can suppress arming. */
export function armStartingCardHealth(
  ds: DaemonSession,
  turnId: string,
  cardId: string,
  onDegrade: StartingCardHealthEntry['onDegrade'],
  opts: { delayMs?: number; afterHealthySeq?: number; defer?: boolean } = {},
): void {
  resetStartingCardHealth(ds);
  const healthyAtPost = opts.afterHealthySeq ?? startingCardHealthySequence(ds, turnId);
  if (startingCardHealthySequence(ds, turnId) > healthyAtPost) return;
  const entry: StartingCardHealthEntry = {
    turnId,
    dispatchAttempt: dispatchAttemptFor(ds, turnId),
    generation: ds.workerGeneration ?? ds.session.workerGeneration,
    cardId,
    deferred: opts.defer === true,
    timer: null,
    delivered: false,
    warned: false,
    delayMs: opts.delayMs ?? STARTING_CARD_HEALTH_DELAY_MS,
    onDegrade,
  };
  pending.set(ds, entry);
  if (!entry.deferred) scheduleStartingCardHealthFire(ds, entry);
}
