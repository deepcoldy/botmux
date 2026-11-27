/**
 * Two ways of sending with a durable record saved first, each used by every
 * sender that follows the same rule (the other senders keep rules of their own):
 *
 *  - a latched notice (deliverLatchedNotice): the intent is saved before the
 *    send. An explicit failure undoes it, and the notice may go again
 *    WECOM_NOTICE_RETRY_MS later; an outcome that is not known keeps it, as if
 *    sent. Reminder cycles (../reminders.ts) and the no-progress notice
 *    (running-turn.ts);
 *  - a recorded attempt (recordThenSend): the attempt is saved before the send
 *    and is never undone, whatever happens to the send. The running card
 *    (tick.ts), the feedback and controls cards (results.ts) and the close of a
 *    silent turn's stream card (answer-delivery.ts).
 */
import { WecomDeliveryUncertainError } from '../../protocol/types.js';

/** How long after an explicit failure a latched notice may be sent again. */
export const WECOM_NOTICE_RETRY_MS = 2000;

/** The sender-specific parts of a latched notice: its own fields, its own send. */
export interface LatchedNotice {
  /** Record that the notice is going out; saved before it is sent. */
  intend(): void;
  /** Judged right after that save: false sends nothing, and the intent stays. */
  stillWanted?(): boolean;
  send(): Promise<void>;
  sent?(): void;
  /** The send's outcome is not known (WecomDeliveryUncertainError); the intent stays. */
  uncertain?(): void;
  /** The send certainly failed: undo the intent; the notice may go again at `retryAt`. */
  failed(retryAt: number): void;
}

export async function deliverLatchedNotice(
  notice: LatchedNotice,
  store: { save(): void; now(): number },
): Promise<void> {
  notice.intend();
  store.save(); // An uncertain restart must not replay this notice.
  if (notice.stillWanted && !notice.stillWanted()) {
    return;
  }
  try {
    await notice.send();
    notice.sent?.();
  } catch (error) {
    // A negative ACK/unsent failure is safe to retry. An ACK timeout or
    // disconnect after write is uncertain: retain the durable latch because
    // the platform has no dedupe key.
    if (error instanceof WecomDeliveryUncertainError) {
      notice.uncertain?.();
    } else {
      notice.failed(store.now() + WECOM_NOTICE_RETRY_MS);
    }
  }
  store.save();
}

/**
 * Record the attempt, save it, then send. The record stays whatever happens to
 * the send, so neither a restart nor a lost acknowledgement makes its sender
 * send again beyond what the record allows (one card; a bounded number of
 * attempts). A failed send is never retried: `onFailure: 'ignore'` ends it
 * here, `'throw'` passes it to the caller.
 */
export async function recordThenSend(
  store: { save(): void },
  attempt: { record(): void; send(): Promise<void>; onFailure: 'ignore' | 'throw' },
): Promise<void> {
  attempt.record();
  store.save();
  if (attempt.onFailure === 'throw') {
    await attempt.send();
    return;
  }
  try {
    await attempt.send();
  } catch { /* not retried: the attempt stays recorded */ }
}
