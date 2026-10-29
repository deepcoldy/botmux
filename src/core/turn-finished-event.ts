/**
 * One structured notice when a worker `turn_terminal` has been accepted by the
 * durable callback. `success` means that callback returned, not that a later
 * feedback webhook (`turn.completed`) has been correlated.
 *
 * Integrators can subscribe to the `turn.finished` hook or to the daemon
 * loopback `GET /api/events`. The public dashboard `/events` relay drops this
 * frame for anonymous and workbench viewers. A dedicated VC receiver still
 * publishes on the loopback bus, but does not run the user hook.
 *
 * The sender is the turn's own reply-target sender, unless the caller passes
 * the Codex App ledger sender frozen at acceptance. A turn with no sender
 * omits `senderOpenId`; the session owner is not a substitute.
 *
 * Dedupe is in-process only (4096 FIFO). A daemon restart can emit again.
 */
import { dashboardEventBus } from './dashboard-events.js';
import { pickTurnReplyTarget } from './reply-target.js';
import { emitHookEventLocal } from '../services/hook-runner.js';
import { logger } from '../utils/logger.js';
import type { Session, WorkerToDaemon } from '../types.js';

export type TurnFinishedTerminalStatus = Extract<WorkerToDaemon, { type: 'turn_terminal' }>['status'];
export type TurnFinishedStatus = 'success' | 'error';

const seen = new Set<string>();
const seenOrder: string[] = [];
const SEEN_LIMIT = 4096;

export function turnFinishedStatus(status: TurnFinishedTerminalStatus): TurnFinishedStatus {
  return status === 'completed' ? 'success' : 'error';
}

/** Reply-target sender only. Owner, creator, and last caller are not consulted. */
export function turnFinishedSenderOpenId(
  session: Pick<Session, 'replyTargets' | 'currentReplyTarget' | 'quoteTargetId' | 'quoteTargetSenderOpenId'>,
  turnId: string,
): string | undefined {
  const sender = pickTurnReplyTarget(session, turnId)?.senderOpenId;
  return sender || undefined;
}

export function publishTurnFinished(
  ds: {
    larkAppId: string;
    chatId: string;
    session: Pick<Session, 'sessionId' | 'replyTargets' | 'currentReplyTarget' | 'quoteTargetId' | 'quoteTargetSenderOpenId' | 'vcMeetingReceiver'>;
  },
  terminal: {
    turnId: string;
    dispatchAttempt?: number;
    status: TurnFinishedTerminalStatus;
    /** Ledger sender frozen at Codex App acceptance. Wins over the live reply target. */
    senderOpenId?: string;
  },
): boolean {
  const key = `${ds.session.sessionId}\0${terminal.turnId}\0${terminal.dispatchAttempt ?? ''}`;
  if (seen.has(key)) return false;
  seen.add(key);
  seenOrder.push(key);
  if (seenOrder.length > SEEN_LIMIT) {
    const stale = seenOrder.shift();
    if (stale) seen.delete(stale);
  }
  const senderOpenId = terminal.senderOpenId || turnFinishedSenderOpenId(ds.session, terminal.turnId);
  const body = {
    sessionId: ds.session.sessionId,
    turnId: terminal.turnId,
    status: turnFinishedStatus(terminal.status),
    terminalStatus: terminal.status,
    larkAppId: ds.larkAppId,
    chatId: ds.chatId,
    ...(terminal.dispatchAttempt !== undefined ? { dispatchAttempt: terminal.dispatchAttempt } : {}),
    ...(senderOpenId ? { senderOpenId } : {}),
  };
  try {
    dashboardEventBus.publish({ type: 'turn.finished', body });
    // User hooks are an external side-effect channel. Dedicated VC receivers
    // fail closed on every other lifecycle hook; this one does too. The
    // loopback bus above stays, matching session.spawned/update for these rows.
    if (!ds.session.vcMeetingReceiver) emitHookEventLocal('turn.finished', body);
    return true;
  } catch (err) {
    seen.delete(key);
    const idx = seenOrder.lastIndexOf(key);
    if (idx >= 0) seenOrder.splice(idx, 1);
    logger.warn(`[turn.finished] publish failed for ${terminal.turnId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
