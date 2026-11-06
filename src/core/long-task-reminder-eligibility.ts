import type { DaemonSession } from './types.js';
import { managedAuxUiSuppressedFor } from './worker-pool.js';

/** Preserve each exact turn's existing IM, silent, meeting and replay boundaries. */
export function canSendLongTaskReminder(
  session: DaemonSession,
  turnId: string,
  dispatchAttempt?: number,
): boolean {
  return !session.chatId.startsWith('doc:')
    && !managedAuxUiSuppressedFor(session, turnId, dispatchAttempt);
}
