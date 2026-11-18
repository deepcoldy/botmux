import { createCliAdapterSync, resolveEffectiveCliId } from '../adapters/cli/registry.js';

/**
 * The session fields that decide whether a resume lands on the same CLI-native
 * conversation. `dshRuntime` is the LIVE bot toggle: a `dsh` session carries no
 * runtime in its persisted row, yet the worker spawns the `dsh-tui` adapter
 * when the bot has `dshRuntime:'tui'` — the display layer must resolve the same
 * effective adapter or it describes a different CLI than the one that runs
 * (dsh-tui can only resume a precise native id, which it never records).
 */
export interface ResumeFreshSession {
  cliId?: string;
  cliSessionId?: string;
  sessionId?: string;
  workingDir?: string;
  dshRuntime?: 'official' | 'tui';
}

/**
 * True when resuming this session will start a FRESH CLI instead of restoring
 * its history: the adapter can only resume a precise `cliSessionId` (no
 * `--continue` / "latest" fallback — those risk loading a SIBLING botmux
 * session's conversation) and no id was persisted.
 *
 * Upper layers use this to distinguish "logical route reactivated" from "CLI
 * history restored" in user-facing copy (closed-session card, resume receipt),
 * so users are never told history is back when the next spawn is actually a
 * blank session. The worker independently demotes resume→fresh (with its
 * existing fresh-demotion report) via the same adapter capability flag, or, for
 * an adapter that finds its own session (`resumeFindsOwnSession`), via the same
 * `checkResumeTargetExists` probe consulted here.
 */
export function resumeStartsFresh(session: ResumeFreshSession): boolean {
  if (!session.cliId || session.cliSessionId) return false;
  try {
    const adapter = createCliAdapterSync(resolveEffectiveCliId(session.cliId, session.dshRuntime));
    if (adapter.resumeRequiresCliSessionId === true) return true;
    // The adapter finds its own session (Kimi): the same probe the
    // worker runs before resuming decides, so the copy matches the launch.
    if (adapter.resumeFindsOwnSession === true && session.sessionId) {
      return adapter.checkResumeTargetExists?.({ sessionId: session.sessionId, workingDir: session.workingDir }) === false;
    }
    return false;
  } catch {
    return false;
  }
}
