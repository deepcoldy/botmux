/**
 * What the worker tells the user when a SYNTHESISED local turn fails.
 *
 * `local-*` / `local-headless-*` / `scheduled-*` turns are minted by the bridge
 * queue for transcript activity that matched no pending Lark mark. They never
 * send a turn terminal on failure: the daemon would render it as a
 * 「本轮执行失败」card stamped with the session's current prompt — the wrong task
 * (#1170). That gate exists for history a restarted worker replays out of the
 * transcript (a provider error from 10h earlier resurfaced on two consecutive
 * restarts). A failure the worker watched happen is a different case: the CLI
 * stopped mid-work and nothing told the group (measured: a turn cut by
 * `provider_server_error` showed as done, and the group waited 1.5h on it).
 * Those get a plain notice instead of a terminal.
 */
import type { BridgePendingTurn } from './bridge-turn-queue.js';

export interface LocalTurnFailureNotice {
  errorCode: string;
  /** Turn whose reply target the notice is sent to; absent → session default. */
  replyTurnId?: string;
}

export function localTurnFailureNotice(
  turn: Pick<BridgePendingTurn,
    'turnId' | 'isScheduled' | 'replyAnchorTurnId' | 'precedingLarkTurnId'
    | 'terminalOutcome' | 'terminalOutcomeAtMs'>,
  opts: {
    /** Failures recorded before this instant belong to an earlier worker
     *  generation's history and stay silent. */
    liveSinceMs: number;
    /** Zero-injection terminal sync: the daemon captured a reply target for
     *  the local turn itself (terminal_turn_started). */
    zeroPromptTerminalSync: boolean;
  },
): LocalTurnFailureNotice | undefined {
  const outcome = turn.terminalOutcome;
  if (!outcome || outcome.status === 'completed') return undefined;
  // No timestamp means no proof the failure is live: keep the replay-safe
  // silence rather than risk resurfacing history.
  if (turn.terminalOutcomeAtMs === undefined || turn.terminalOutcomeAtMs < opts.liveSinceMs) return undefined;
  // A scheduled fire keeps its strict create-time anchor: borrowing a later
  // topic would route cross-topic (see BridgeTurnQueue.handleScheduledTurnStart).
  const replyTurnId = opts.zeroPromptTerminalSync
    ? turn.turnId
    : turn.isScheduled ? turn.replyAnchorTurnId : turn.precedingLarkTurnId;
  return { errorCode: outcome.errorCode, ...(replyTurnId ? { replyTurnId } : {}) };
}
