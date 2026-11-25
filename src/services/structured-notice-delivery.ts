import type { Session } from '../types.js';
import { addTurnNotice, type TurnNoticeRecord } from './ordinary-recovery-notice.js';

export class StructuredNoticeCardPendingError extends Error {
  constructor() { super('structured_notice_card_effect_pending'); this.name = 'StructuredNoticeCardPendingError'; }
}

export interface StructuredNoticeDeliveryInput {
  session: Session;
  noticeId: string;
  turnId: string;
  content: string;
  owns(): boolean;
  /** Persist the session's current turnNotices list. */
  persist(): void;
  /** Silent display retirement has no text fallback; a normal legacy return is
   * itself terminal. Unknown card effects never switch carrier. */
  allowTextFallback?: boolean;
  /** Existing unified/legacy card path; false selects the durable text outbox. */
  retireCard(): Promise<boolean>;
  /** Drive the existing RecoveryNoticeOutbox for this stable notice UUID. */
  deliverPending(noticeId: string): Promise<void>;
  /** A throw means the worker retains its journal and replays the same UUID. */
  acknowledge(): void;
  onEnqueued?(): void;
  onCardError?(error: unknown): void;
  now?(): number;
}

const inFlight = new WeakMap<Session, Map<string, Promise<void>>>();

/**
 * Make one worker-originated structured warning durable before any UI effect.
 * The worker keeps its own pendingNotice until acknowledge(). A replay with a
 * delivered record only re-ACKs; a pending replay resumes the frozen card/text
 * plan. Initial pending persistence is the handoff boundary, so an ACK is safe
 * even when the text outbox still owes the provider retry.
 */
export async function deliverStructuredNotice(input: StructuredNoticeDeliveryInput): Promise<void> {
  if (!input.owns()) return;
  let byId = inFlight.get(input.session);
  if (!byId) { byId = new Map(); inFlight.set(input.session, byId); }
  const existing = byId.get(input.noticeId);
  if (existing) return existing;
  const work = Promise.resolve().then(() => runStructuredNoticeDelivery(input));
  byId.set(input.noticeId, work);
  try { await work; }
  finally {
    byId!.delete(input.noticeId);
    if (byId!.size === 0) inFlight.delete(input.session);
  }
}

async function runStructuredNoticeDelivery(input: StructuredNoticeDeliveryInput): Promise<void> {
  const { session, noticeId } = input;
  const find = () => session.turnNotices?.find(entry => entry.delivery.uuid === noticeId);
  if (!input.owns()) return;
  let record = find();
  if (record && record.delivery.state !== 'pending') {
    // A previous ACK may have been the only lost edge. Never repeat the UI effect.
    if (input.owns()) input.acknowledge();
    return;
  }
  if (!record) {
    const previous = session.turnNotices;
    const now = input.now?.() ?? Date.now();
    const created: TurnNoticeRecord = {
      kind: 'user_notify', turnId: input.turnId, msgType: 'text', content: input.content,
      retention: 'structured', carrier: input.allowTextFallback === false ? 'silent' : 'card', createdAt: now,
      delivery: { state: 'pending', attempts: 0, uuid: noticeId, nextAttemptAt: now },
    };
    session.turnNotices = addTurnNotice(previous, created);
    try { input.persist(); }
    catch (error) { session.turnNotices = previous; throw error; }
    record = find();
    if (!record) throw new Error('structured_notice_durable_record_missing');
    input.onEnqueued?.();
  }

  if (record.carrier === 'text') {
    // Text owns the effect from this point onward, including an unknown text
    // result followed by a lost ACK. Never rerun the card on such a replay.
    await input.deliverPending(noticeId);
  } else {
    let cardRetired = false;
    try { cardRetired = await input.retireCard(); }
    catch (error) {
      input.onCardError?.(error);
      if (record.carrier === 'silent' || error instanceof StructuredNoticeCardPendingError) throw error;
    }
    if (cardRetired || record.carrier === 'silent') {
      // This is a separate durable edge, NOT a text-outbox fallback: if this write
      // fails, a retry may idempotently PATCH the card, but must not also post text.
      const current = find();
      if (!current || current.delivery.state !== 'pending') throw new Error('structured_notice_pending_record_lost');
      current.delivery.state = 'delivered';
      current.delivery.attempts += 1;
      current.delivery.deliveredAt = input.now?.() ?? Date.now();
      current.delivery.nextAttemptAt = undefined;
      current.delivery.lastError = undefined;
      input.persist();
    } else {
      // A definite no-card outcome may change carrier, but the transition itself
      // must be durable BEFORE the first text attempt.
      const current = find();
      if (!current || current.delivery.state !== 'pending') throw new Error('structured_notice_pending_record_lost');
      current.carrier = 'text';
      current.delivery.nextAttemptAt = input.now?.() ?? Date.now();
      input.persist();
      await input.deliverPending(noticeId);
    }
  }
  if (!find()) throw new Error('structured_notice_durable_record_lost');
  // Pending is safe to ACK: the daemon owns the durable row. Text resumes via
  // resumeTurnNotices(); card/silent rows wait for the worker's same-ID replay.
  if (input.owns()) input.acknowledge();
}
