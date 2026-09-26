import type { DaemonSession } from './types.js';

export type HandoffCardEvent = {
  turnId: string; sequence: number;
} & ({ kind: 'stage'; title: string } | { kind: 'complete'; resultMessageId: string });

export function parseHandoffCardEvent(value: unknown): HandoffCardEvent {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v.turnId !== 'string' || !v.turnId.trim() || v.turnId.length > 200
    || !Number.isSafeInteger(v.sequence) || (v.sequence as number) < 1) throw new Error('bad_live_stage');
  if (v.kind === 'stage' && typeof v.title === 'string' && v.title.trim() && v.title.length <= 80) {
    return { turnId: v.turnId, sequence: v.sequence as number, kind: 'stage', title: v.title.trim() };
  }
  if (v.kind === 'complete' && typeof v.resultMessageId === 'string' && /^om_[\w-]+$/.test(v.resultMessageId)) {
    return { turnId: v.turnId, sequence: v.sequence as number, kind: 'complete', resultMessageId: v.resultMessageId };
  }
  throw new Error('bad_live_stage');
}

export function handoffCardClosed(ds: DaemonSession, turnId?: string): boolean {
  const state = ds.session.handoffLiveCard;
  return !!state?.closed && state.turnId === (turnId ?? ds.currentTurnId ?? state.turnId);
}

/** An authenticated connector reports business facts. Runtime owns card effects.
 * Persist before I/O so late screen updates and restart recovery cannot revive
 * a completed card. A delayed result can only delete its captured card id. */
export async function applyHandoffCardEvent(ds: DaemonSession, event: HandoffCardEvent, io: {
  persist(): void; patch(): void; remove(messageId: string): Promise<unknown>; clear(): void;
}): Promise<void> {
  const state = ds.session.handoffLiveCard;
  if (!state || state.turnId !== event.turnId
    || (ds.currentTurnId && ds.currentTurnId !== event.turnId)
    || ds.session.status !== 'active') throw new Error('stale_live_stage');
  if (event.sequence < state.sequence) return;
  if (event.sequence === state.sequence) {
    if (event.kind === 'stage' && !state.closed && state.title === event.title) return;
    if (!(event.kind === 'complete' && state.closed && state.resultMessageId === event.resultMessageId)) {
      throw new Error('live_stage_sequence_conflict');
    }
  }
  if (event.kind === 'stage') {
    if (state.closed) throw new Error('live_stage_completed');
    const previousTitle = ds.currentTurnTitle;
    ds.session.handoffLiveCard = { ...state, sequence: event.sequence, title: event.title };
    ds.currentTurnTitle = event.title;
    try { io.persist(); }
    catch (error) {
      ds.session.handoffLiveCard = state;
      ds.currentTurnTitle = previousTitle;
      throw error;
    }
    io.patch();
    return;
  }
  ds.session.handoffLiveCard = { ...state, sequence: event.sequence, closed: true, resultMessageId: event.resultMessageId };
  try { io.persist(); }
  catch (error) {
    ds.session.handoffLiveCard = state;
    throw error;
  }
  const cardId = ds.streamCardId;
  // Sentinel is runtime-private; a pending POST cleans itself on completion.
  if (cardId && cardId !== '__posting__') await io.remove(cardId);
  // SQLite persistence rehydrates nested session values, so reference identity
  // cannot distinguish the persisted state from a successor. Fence the exact
  // completed event instead, including a turn/card change during the delete.
  const latest = ds.session.handoffLiveCard;
  if (!latest || latest.turnId !== event.turnId || latest.sequence !== event.sequence
    || !latest.closed || latest.resultMessageId !== event.resultMessageId
    || (ds.currentTurnId && ds.currentTurnId !== event.turnId)
    || ds.streamCardId !== cardId) return;
  ds.streamCardId = undefined;
  ds.streamCardNonce = undefined;
  ds.streamCardPending = false;
  ds.streamCardPendingTurnId = undefined;
  ds.pendingCardJson = undefined;
  ds.pendingCardId = undefined;
  io.clear();
}
