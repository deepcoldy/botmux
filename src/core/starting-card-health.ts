import type { DaemonSession } from './types.js';
import type { StreamStatus } from '../types.js';

/** A starting card gets one bounded chance to prove that its own turn is making
 * progress. A delivered PATCH (not a same-value status) is what closes the
 * watchdog; a failed write is retried with the same identity fences. */
export const STARTING_CARD_HEALTH_DELAY_MS = 45_000;

export type StartingCardHealthEntry = {
  turnId: string;
  generation: number | undefined;
  cardId: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  delivered: boolean;
  warned: boolean;
};

const pending = new WeakMap<DaemonSession, StartingCardHealthEntry>();
const latestHealthy = new WeakMap<DaemonSession, { turnId: string; at: number }>();

export function startingCardHealthEntryStillCurrent(
  ds: DaemonSession,
  entry: StartingCardHealthEntry,
): boolean {
  return pending.get(ds) === entry
    && ds.session.status === 'active'
    && ds.currentTurnId === entry.turnId
    && ds.streamCardId === entry.cardId
    && (ds.workerGeneration ?? ds.session.workerGeneration) === entry.generation;
}

/** Record only a non-starting frame. A same-value starting frame proves no more
 * progress than the original POST did, so it must not disarm the watchdog. */
export function noteStartingCardHealthFrame(
  ds: DaemonSession,
  turnId: string | undefined,
  status: StreamStatus,
): void {
  if (status === 'starting') return;
  const current = pending.get(ds);
  if (current && turnId !== undefined && current.turnId !== turnId) return;
  latestHealthy.set(ds, { turnId: turnId ?? current?.turnId ?? '', at: Date.now() });
  if (!current) return;
  if (current.timer) clearTimeout(current.timer);
  pending.delete(ds);
}

export function closeStartingCardHealth(ds: DaemonSession, turnId: string): void {
  const current = pending.get(ds);
  if (!current || current.turnId !== turnId) return;
  if (current.timer) clearTimeout(current.timer);
  pending.delete(ds);
}

/** Arm after the real starting-card id exists. A frame that arrived before this
 * POST is not evidence for this card; only a newer non-starting frame cancels. */
export function armStartingCardHealth(
  ds: DaemonSession,
  turnId: string,
  cardId: string,
  onDegrade: (entry: StartingCardHealthEntry, onSettled: (delivered: boolean) => void) => void,
  opts: { now?: () => number; delayMs?: number } = {},
): void {
  const startedAt = (opts.now ?? Date.now)();
  const latest = latestHealthy.get(ds);
  if (latest && latest.turnId === turnId && latest.at >= startedAt) return;
  closeStartingCardHealth(ds, turnId);
  const entry: StartingCardHealthEntry = {
    turnId,
    generation: ds.workerGeneration ?? ds.session.workerGeneration,
    cardId,
    startedAt,
    timer: null,
    inFlight: false,
    delivered: false,
    warned: false,
  };
  const fire = () => {
    if (pending.get(ds) !== entry || entry.delivered) return;
    if (!startingCardHealthEntryStillCurrent(ds, entry)) {
      if (entry.timer) clearTimeout(entry.timer);
      if (pending.get(ds) === entry) pending.delete(ds);
      return;
    }
    entry.inFlight = true;
    onDegrade(entry, delivered => {
      entry.inFlight = false;
      if (delivered) {
        entry.delivered = true;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        return;
      }
      // A transient transport failure must not leave the card at starting
      // forever. Retry with the same turn/card/generation fence, never more
      // than one PATCH in flight for this watchdog entry.
      if (pending.get(ds) !== entry) return;
      entry.timer = setTimeout(fire, opts.delayMs ?? STARTING_CARD_HEALTH_DELAY_MS);
      entry.timer.unref?.();
    });
  };
  entry.timer = setTimeout(fire, opts.delayMs ?? STARTING_CARD_HEALTH_DELAY_MS);
  entry.timer.unref?.();
  pending.set(ds, entry);
}
