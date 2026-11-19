import type { CodexPendingTurn } from './codex-bridge-queue.js';

/** Which pre-start heads dropped by lease expiry still need the thread told
 *  that their reply cannot be collected.
 *
 *  Expiry means the transcript never showed the turn starting, so even if the
 *  CLI answers, the final has no turn to attach to. The notice is for turns
 *  nobody else is already talking to the user about:
 *    - a durable attempt or retired RPC owner was settled with a terminal of
 *      its own (`structured_start_timeout` / `rpc_delivery_ambiguous_timeout`);
 *    - a local (terminal-typed) turn has no Lark sender waiting on it;
 *    - a turn whose write failed already got that failure's own notice (submit
 *      failure, ambiguous recovery, ZMX hold) — and saying "sent to the CLI"
 *      there would be wrong, since the bytes may never have reached it. */
export function uncollectedTurnsNeedingNotice(
  dropped: readonly CodexPendingTurn[],
  opts: {
    settledByTerminal: ReadonlySet<CodexPendingTurn>;
    hasOwnNotice: (turn: CodexPendingTurn) => boolean;
  },
): CodexPendingTurn[] {
  return dropped.filter(turn => !turn.isLocal
    && !opts.settledByTerminal.has(turn)
    && !opts.hasOwnNotice(turn));
}
