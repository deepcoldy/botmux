/**
 * A new turn takes over the session's last reply card: the previous card's
 * 「下一步」row comes off and its「本轮回顾」panel stops being updated. Every
 * entry point that starts a turn calls this one function, so neither row can
 * be left behind by a path that only remembered the other.
 */
import type { DaemonSession } from './types.js';
import { noteNextStepTurnStarted } from './next-step-suggestion.js';
import { nextStepIo } from './next-step-io.js';
import { noteRecapTurnStarted } from './turn-recap-state.js';

export function noteReplyCardTurnStarted(ds: DaemonSession, turnId: string): void {
  noteNextStepTurnStarted(ds, turnId, nextStepIo);
  noteRecapTurnStarted(ds, turnId);
}
