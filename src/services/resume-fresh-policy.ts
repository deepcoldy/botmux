import { createCliAdapterSync } from '../adapters/cli/registry.js';
import type { CliId } from '../adapters/cli/types.js';

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
 * existing fresh-demotion notice) via the same adapter capability flag, or, for
 * an adapter that finds its own session (`resumeFindsOwnSession`), via the same
 * `checkResumeTargetExists` probe consulted here.
 */
export function resumeStartsFresh(session: { cliId?: string; cliSessionId?: string; sessionId?: string; workingDir?: string }): boolean {
  if (!session.cliId || session.cliSessionId) return false;
  try {
    const adapter = createCliAdapterSync(session.cliId as CliId);
    if (adapter.resumeRequiresCliSessionId === true) return true;
    // The adapter finds its own session (Kimi / Gemini): the same probe the
    // worker runs before resuming decides, so the copy matches the launch.
    if (adapter.resumeFindsOwnSession === true && session.sessionId) {
      return adapter.checkResumeTargetExists?.({ sessionId: session.sessionId, workingDir: session.workingDir }) === false;
    }
    return false;
  } catch {
    return false;
  }
}
