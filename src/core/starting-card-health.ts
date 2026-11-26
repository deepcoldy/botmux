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
  /** True while the card itself still visibly displays `starting`, so disarming
   * on a same-value `working` frame must force one exit repaint. */
  visiblyStarting: boolean;
  /** Host capture turn for a folded/steered follow-up activated before any
   * rendered frame proved the capture pipeline alive. */
  foldedHostTurnId?: string;
  /** Monotonic activation epoch per entry; incremented when a folded entry is
   * promoted to direct capture ownership so an in-flight stall callback from
   * before promotion cannot cancel or duplicate the fresh grace timer. */
  epoch: number;
  timer: ReturnType<typeof setTimeout> | null;
  delivered: boolean;
  warned: boolean;
  delayMs: number;
  onDegrade: (entry: StartingCardHealthEntry, onSettled: (delivered: boolean) => void) => void;
};

type HealthyObservation = {
  turnId: string;
  dispatchAttempt: number | undefined;
  generation: number | undefined;
  status: StreamStatus;
  sequence: number;
};

type NativeAcceptanceObservation = {
  turnId: string;
  dispatchAttempt: number | undefined;
  generation: number | undefined;
};

const OBSERVATION_MAP_MAX = 16;

const pending = new WeakMap<DaemonSession, StartingCardHealthEntry>();
/** Display-only state: set when degradation starts, retained until a qualifying
 * healthy frame, terminal, replacement card, or identity change clears it. */
const degraded = new WeakMap<DaemonSession, StartingCardHealthEntry>();
/** Rendered non-starting screen/screenshot evidence per turn (bounded per session). */
const latestHealthy = new WeakMap<DaemonSession, Map<string, HealthyObservation>>();
/** Native folded/steered acceptance per turn, kept separate from rendered health so
 * native acceptance never disarms a cold capture watchdog or clears `stalled`. */
const nativeAccepted = new WeakMap<DaemonSession, Map<string, NativeAcceptanceObservation>>();
let healthySequence = 0;

function currentGeneration(ds: DaemonSession): number | undefined {
  return ds.workerGeneration ?? ds.session.workerGeneration;
}

function dispatchAttemptFor(ds: DaemonSession, turnId: string): number | undefined {
  const highWater = ds.turnDispatchAttemptHighWater;
  return highWater?.turnId === turnId ? highWater.dispatchAttempt : undefined;
}

function attemptMatches(a: number | undefined, b: number | undefined): boolean {
  return a === undefined || b === undefined || a === b;
}

function recordBoundedObservation<T>(
  outer: WeakMap<DaemonSession, Map<string, T>>,
  ds: DaemonSession,
  key: string,
  value: T,
): void {
  let map = outer.get(ds);
  if (!map) {
    map = new Map();
    outer.set(ds, map);
  }
  map.delete(key);
  map.set(key, value);
  while (map.size > OBSERVATION_MAP_MAX) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function validHealthyObservation(ds: DaemonSession, turnId: string): HealthyObservation | undefined {
  const obs = latestHealthy.get(ds)?.get(turnId);
  if (!obs) return undefined;
  if (obs.generation !== currentGeneration(ds)) return undefined;
  if (!attemptMatches(obs.dispatchAttempt, dispatchAttemptFor(ds, turnId))) return undefined;
  return obs;
}

function identityStillCurrent(ds: DaemonSession, entry: StartingCardHealthEntry): boolean {
  return ds.session.status === 'active'
    && !ds.session.suspendedColdResume
    && !ds.crashDiagnosticParked
    && ds.currentTurnId === entry.turnId
    && ds.streamCardId === entry.cardId
    && currentGeneration(ds) === entry.generation
    && dispatchAttemptFor(ds, entry.turnId) === entry.dispatchAttempt;
}

/** Deferred or folded entries published/activated before a turn's first numeric
 * dispatchAttempt intentionally keep `entry.dispatchAttempt === undefined` and
 * may adopt that first attempt cleanly rather than dying on `0 !== undefined`. */
function adoptFirstFoldedAttemptIfNeeded(ds: DaemonSession, entry: StartingCardHealthEntry): void {
  if (entry.foldedHostTurnId !== undefined && entry.dispatchAttempt === undefined) {
    const firstAttempt = dispatchAttemptFor(ds, entry.turnId);
    if (firstAttempt !== undefined) entry.dispatchAttempt = firstAttempt;
  }
}

function pendingEntryStillAlive(ds: DaemonSession, entry: StartingCardHealthEntry): boolean {
  adoptFirstFoldedAttemptIfNeeded(ds, entry);
  if (entry.deferred && entry.dispatchAttempt === undefined) {
    return ds.session.status === 'active'
      && !ds.session.suspendedColdResume
      && !ds.crashDiagnosticParked
      && ds.currentTurnId === entry.turnId
      && ds.streamCardId === entry.cardId
      && currentGeneration(ds) === entry.generation;
  }
  return identityStillCurrent(ds, entry);
}

function isObsoleteAttempt(ds: DaemonSession, turnId: string, dispatchAttempt: number | undefined): boolean {
  if (dispatchAttempt === undefined) return false;
  const highWater = dispatchAttemptFor(ds, turnId);
  return highWater !== undefined && dispatchAttempt < highWater;
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
  return validHealthyObservation(ds, turnId)?.sequence ?? 0;
}

/** Last rendered non-starting status observed for `turnId` in the current worker
 * generation and attempt. Covers races where `idle -> working` (or a fast
 * `working -> idle`) lands before `postTurnStartingStatusCard` snapshots state. */
export function startingCardHealthyStatus(ds: DaemonSession, turnId: string): StreamStatus | undefined {
  return validHealthyObservation(ds, turnId)?.status;
}

/** Record CLI-evidenced folded/steered acceptance without touching rendered
 * capture health (`latestHealthy`, `pending`, or `degraded`). */
export function noteStartingCardNativeAcceptance(
  ds: DaemonSession,
  turnId: string,
  dispatchAttempt?: number,
): void {
  if (isObsoleteAttempt(ds, turnId, dispatchAttempt)) return;
  recordBoundedObservation(nativeAccepted, ds, turnId, {
    turnId,
    dispatchAttempt: dispatchAttempt ?? dispatchAttemptFor(ds, turnId),
    generation: currentGeneration(ds),
  });
}

export function hasStartingCardNativeAcceptance(ds: DaemonSession, turnId: string): boolean {
  const obs = nativeAccepted.get(ds)?.get(turnId);
  if (!obs) return false;
  if (obs.generation !== currentGeneration(ds)) return false;
  return attemptMatches(obs.dispatchAttempt, dispatchAttemptFor(ds, turnId));
}

/** Transfer any current pending/degraded health entry from `oldCardId` to
 * `newCardId` when a manual card repost (`/card`) replaces the live card. */
export function rebindStartingCardHealthCardId(
  ds: DaemonSession,
  oldCardId: string | undefined,
  newCardId: string,
): void {
  if (!oldCardId || oldCardId === newCardId) return;
  const current = pending.get(ds);
  if (current && current.cardId === oldCardId) {
    current.cardId = newCardId;
  }
  const currentDegraded = degraded.get(ds);
  if (currentDegraded && currentDegraded.cardId === oldCardId) {
    currentDegraded.cardId = newCardId;
  }
}

/** True when an active or degraded folded follow-up entry is currently accepting
 * rendered frames from `turnId` as its host capture producer. */
export function startingCardAcceptsHostTurn(ds: DaemonSession, turnId: string | undefined): boolean {
  if (!turnId) return false;
  const current = pending.get(ds);
  if (current) adoptFirstFoldedAttemptIfNeeded(ds, current);
  if (current && !current.deferred && current.foldedHostTurnId === turnId && identityStillCurrent(ds, current)) {
    return true;
  }
  const currentDegraded = degraded.get(ds);
  if (currentDegraded) adoptFirstFoldedAttemptIfNeeded(ds, currentDegraded);
  if (currentDegraded && currentDegraded.foldedHostTurnId === turnId && identityStillCurrent(ds, currentDegraded)) {
    return true;
  }
  return false;
}

/** Record only a non-starting rendered frame. Returns whether this frame must
 * force a repaint even when execution status is unchanged — either because it
 * cleared a visible degraded state or because it disarmed a visibly-starting
 * entry on a same-value working frame. */
export function noteStartingCardHealthFrame(
  ds: DaemonSession,
  turnId: string | undefined,
  status: StreamStatus,
  dispatchAttempt?: number,
): boolean {
  if (status === 'starting') return false;
  const rawPending = pending.get(ds);
  if (rawPending && !pendingEntryStillAlive(ds, rawPending)) {
    if (rawPending.timer) clearTimeout(rawPending.timer);
    pending.delete(ds);
  }
  const rawDegraded = degraded.get(ds);
  if (rawDegraded && !identityStillCurrent(ds, rawDegraded)) {
    degraded.delete(ds);
  }
  const current = pending.get(ds);
  const currentDegraded = degraded.get(ds);

  if (turnId !== undefined) {
    if (isObsoleteAttempt(ds, turnId, dispatchAttempt)) return false;
    // Record per-turn rendered health BEFORE any `current.turnId !== turnId`
    // filtering so a pre-POST frame for turn N+1 is never dropped while `pending`
    // still holds turn N (or overwritten by an interleaved turn's frame).
    healthySequence += 1;
    recordBoundedObservation(latestHealthy, ds, turnId, {
      turnId,
      dispatchAttempt: dispatchAttempt ?? dispatchAttemptFor(ds, turnId),
      generation: currentGeneration(ds),
      status,
      sequence: healthySequence,
    });
  } else {
    // While a follow-up is queued, an unattributed frame may belong to its
    // predecessor. Once the turn activates, legacy untagged frames count again.
    if (current?.deferred) return false;
    const fallbackTurnId = current?.turnId ?? currentDegraded?.turnId;
    if (fallbackTurnId) {
      if (isObsoleteAttempt(ds, fallbackTurnId, dispatchAttempt)) return false;
      healthySequence += 1;
      recordBoundedObservation(latestHealthy, ds, fallbackTurnId, {
        turnId: fallbackTurnId,
        dispatchAttempt: dispatchAttempt ?? dispatchAttemptFor(ds, fallbackTurnId),
        generation: currentGeneration(ds),
        status,
        sequence: healthySequence,
      });
    }
  }

  const pendingHostMatch = !!current && !current.deferred
    && current.foldedHostTurnId !== undefined && turnId === current.foldedHostTurnId;
  const matchesPending = !!current && (
    pendingHostMatch
    || ((current.deferred ? turnId === current.turnId : (turnId === undefined || current.turnId === turnId))
      && attemptMatches(dispatchAttempt, current.dispatchAttempt))
  );
  const degradedHostMatch = !!currentDegraded
    && currentDegraded.foldedHostTurnId !== undefined && turnId === currentDegraded.foldedHostTurnId;
  const matchesDegraded = !!currentDegraded && (
    degradedHostMatch
    || ((turnId === undefined || currentDegraded.turnId === turnId)
      && attemptMatches(dispatchAttempt, currentDegraded.dispatchAttempt))
  );

  let clearedVisiblyStarting = false;
  if (matchesPending && current) {
    if (current.timer) clearTimeout(current.timer);
    clearedVisiblyStarting = current.visiblyStarting;
    pending.delete(ds);
  }
  if (matchesDegraded) {
    degraded.delete(ds);
  }
  return clearedVisiblyStarting || matchesDegraded;
}

function entryMatchesTerminal(
  entry: StartingCardHealthEntry,
  turnId: string,
  dispatchAttempt: number | undefined,
): boolean {
  return entry.turnId === turnId && attemptMatches(entry.dispatchAttempt, dispatchAttempt);
}

export function closeStartingCardHealth(
  ds: DaemonSession,
  turnId: string,
  dispatchAttempt?: number,
): void {
  if (isObsoleteAttempt(ds, turnId, dispatchAttempt)) return;
  const current = pending.get(ds);
  if (current && entryMatchesTerminal(current, turnId, dispatchAttempt)) {
    if (current.timer) clearTimeout(current.timer);
    pending.delete(ds);
  }
  const currentDegraded = degraded.get(ds);
  if (currentDegraded && entryMatchesTerminal(currentDegraded, turnId, dispatchAttempt)) {
    degraded.delete(ds);
  }
  const healthyMap = latestHealthy.get(ds);
  const healthyObs = healthyMap?.get(turnId);
  if (healthyMap && healthyObs && attemptMatches(healthyObs.dispatchAttempt, dispatchAttempt)) {
    healthyMap.delete(turnId);
    if (healthyMap.size === 0) latestHealthy.delete(ds);
  }
  const acceptedMap = nativeAccepted.get(ds);
  const acceptedObs = acceptedMap?.get(turnId);
  if (acceptedMap && acceptedObs && attemptMatches(acceptedObs.dispatchAttempt, dispatchAttempt)) {
    acceptedMap.delete(turnId);
    if (acceptedMap.size === 0) nativeAccepted.delete(ds);
  }
}

export function resetStartingCardHealth(
  ds: DaemonSession,
  opts: { clearHistory?: boolean } = {},
): void {
  const current = pending.get(ds);
  if (current?.timer) clearTimeout(current.timer);
  pending.delete(ds);
  degraded.delete(ds);
  if (opts.clearHistory === true) {
    latestHealthy.delete(ds);
    nativeAccepted.delete(ds);
  }
}

function fireStartingCardHealth(ds: DaemonSession, entry: StartingCardHealthEntry): void {
  entry.timer = null;
  if (pending.get(ds) !== entry || entry.delivered) return;
  adoptFirstFoldedAttemptIfNeeded(ds, entry);
  if (!startingCardHealthEntryStillCurrent(ds, entry)) {
    if (pending.get(ds) === entry) pending.delete(ds);
    if (degraded.get(ds) === entry) degraded.delete(ds);
    return;
  }
  // Set the display state before scheduling so every newer ordinary render also
  // preserves stalled. A failed PATCH retries under the same identity.
  entry.visiblyStarting = false;
  degraded.set(ds, entry);
  const fireEpoch = entry.epoch;
  entry.onDegrade(entry, delivered => {
    if (pending.get(ds) !== entry || entry.epoch !== fireEpoch) return;
    if (delivered) {
      entry.delivered = true;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      return;
    }
    scheduleStartingCardHealthFire(ds, entry);
  });
}

function scheduleStartingCardHealthFire(ds: DaemonSession, entry: StartingCardHealthEntry): void {
  entry.timer = setTimeout(() => fireStartingCardHealth(ds, entry), entry.delayMs);
  entry.timer.unref?.();
}

/** Start the grace period when a queued turn becomes the terminal producer.
 * If the turn was previously activated as a folded follow-up on a host turn,
 * promote it to exact-turn tracking with a fresh grace window. */
export function activateStartingCardHealth(ds: DaemonSession, turnId: string): void {
  const entry = pending.get(ds);
  const currentDegraded = degraded.get(ds);
  const hadFoldedHost = !!entry && entry.turnId === turnId && entry.foldedHostTurnId !== undefined;
  // Promoting `turnId` to direct capture ownership ALWAYS revokes host-turn
  // acceptance, even on an already-delivered `stalled` entry, so a late frame
  // from the former host turn can never clear this turn's stalled badge.
  if (currentDegraded && currentDegraded.turnId === turnId && currentDegraded.foldedHostTurnId !== undefined) {
    currentDegraded.foldedHostTurnId = undefined;
  }
  if (!entry || entry.turnId !== turnId) return;
  if (entry.delivered) {
    if (entry.foldedHostTurnId !== undefined) entry.foldedHostTurnId = undefined;
    return;
  }
  if (!entry.deferred && !hadFoldedHost) return;
  // A queued or folded publication may precede the first numeric attempt known
  // for its turn. Adopt that first identity only; an already-known attempt must
  // still fail the identity check when a retry takes over before activation.
  if (entry.dispatchAttempt === undefined) entry.dispatchAttempt = dispatchAttemptFor(ds, turnId);
  if (!startingCardHealthEntryStillCurrent(ds, entry)) {
    closeStartingCardHealth(ds, turnId, entry.dispatchAttempt);
    return;
  }
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  // If a folded entry was mid-retry or in-flight on an undelivered stall PATCH
  // when capture promoted directly to `turnId`, bump its epoch (fencing any
  // late onDegrade callback) and drop the undelivered stall marker before
  // granting `turnId` its fresh grace window.
  entry.epoch += 1;
  if (degraded.get(ds) === entry) degraded.delete(ds);
  entry.deferred = false;
  entry.foldedHostTurnId = undefined;
  scheduleStartingCardHealthFire(ds, entry);
}

/** Activate a deferred entry when a folded/steered follow-up is natively accepted
 * while the host turn still owns capture and has not yet proven the capture
 * pipeline alive, so health monitoring does not defer indefinitely. */
export function activateFoldedStartingCardHealth(
  ds: DaemonSession,
  turnId: string,
  hostTurnId: string | undefined,
): void {
  const entry = pending.get(ds);
  if (!entry || entry.turnId !== turnId || !entry.deferred || entry.delivered) return;
  if (!hostTurnId || hostTurnId === turnId) return;
  if (entry.dispatchAttempt === undefined) entry.dispatchAttempt = dispatchAttemptFor(ds, turnId);
  if (!startingCardHealthEntryStillCurrent(ds, entry)) {
    closeStartingCardHealth(ds, turnId, entry.dispatchAttempt);
    return;
  }
  entry.deferred = false;
  entry.foldedHostTurnId = hostTurnId;
  entry.visiblyStarting = false;
  scheduleStartingCardHealthFire(ds, entry);
}

/** Arm after the real starting-card id exists. `afterHealthySeq` is captured
 * before the POST; a healthy rendered observation for `turnId` in this generation
 * suppresses arming. */
export function armStartingCardHealth(
  ds: DaemonSession,
  turnId: string,
  cardId: string,
  onDegrade: StartingCardHealthEntry['onDegrade'],
  opts: {
    delayMs?: number;
    afterHealthySeq?: number;
    defer?: boolean;
    visiblyStarting?: boolean;
    foldedHostTurnId?: string;
  } = {},
): void {
  resetStartingCardHealth(ds);
  const healthyAtPost = opts.afterHealthySeq ?? startingCardHealthySequence(ds, turnId);
  if (startingCardHealthySequence(ds, turnId) > healthyAtPost) {
    return;
  }
  const foldedHostTurnId = opts.foldedHostTurnId && opts.foldedHostTurnId !== turnId
    ? opts.foldedHostTurnId
    : undefined;
  const entry: StartingCardHealthEntry = {
    turnId,
    dispatchAttempt: dispatchAttemptFor(ds, turnId),
    generation: currentGeneration(ds),
    cardId,
    deferred: foldedHostTurnId ? false : opts.defer === true,
    visiblyStarting: opts.visiblyStarting !== false,
    ...(foldedHostTurnId ? { foldedHostTurnId } : {}),
    epoch: 0,
    timer: null,
    delivered: false,
    warned: false,
    delayMs: opts.delayMs ?? STARTING_CARD_HEALTH_DELAY_MS,
    onDegrade,
  };
  pending.set(ds, entry);
  if (!entry.deferred) scheduleStartingCardHealthFire(ds, entry);
}
