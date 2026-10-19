/**
 * Tails Codex collaboration sub-agent rollouts for usage/rate-limit terminals.
 *
 * A sub-agent (spawn_agent / wait_agent) runs in its own thread and writes its
 * own rollout. When it hits the account quota, its `task_complete` fails with
 * `usage_limit_exceeded`, but the parent only receives that as a tool result:
 * the parent turn stays `working`, the parent rollout drain never sees a failed
 * terminal, and the screen scan is suppressed while the CLI is working. The
 * worker therefore never published `limited`, so the daemon's owner notice and
 * `quotaFallbackBot` handoff never fired. Codex quota is per account — the
 * parent's next model call fails the same way — so the sub-agent terminal is a
 * reliable signal for the whole session.
 *
 * Only sub-agents whose `started` record is live are tracked: the parent
 * baseline (history before the worker attached) is never replayed, and an
 * adopt split-live / journal-recovery attach registers only sub-agents started
 * after its cutoff.
 * Within a tracked sub-agent rollout, history inherited from the parent on
 * fork is skipped (see drainCodexSubagentLimits), so a stale limit from an
 * earlier quota window cannot trigger a handoff either way.
 *
 * Coverage is best-effort by design: only direct children of the parent rollout
 * are tracked (a depth>=2 sub-agent's `started` lands in its parent sub-agent's
 * rollout, not ours), and the oldest entries are evicted past the cap. Both
 * gaps are backstopped by an ancestor's own terminal: the quota is per account,
 * so the next model call of the tracked child — or of the parent turn itself —
 * fails with the same usage_limit_exceeded and goes through the regular
 * structured limit path.
 */
import {
  drainCodexSubagentLimits,
  findCodexSubagentRollout,
  INITIAL_CODEX_SUBAGENT_CURSOR,
  type CodexBridgeEvent,
  type CodexSpawnedSubagent,
  type CodexSubagentCursor,
} from './codex-transcript.js';

/** Bound on concurrently tracked sub-agents; the oldest are dropped first
 *  (an evicted one is backstopped by its ancestor's terminal, see above). */
export const MAX_TRACKED_CODEX_SUBAGENTS = 64;
/** A sub-agent rollout normally appears within a second of `started`. Stop
 *  listing date directories for one that never shows up. */
export const CODEX_SUBAGENT_LOOKUP_WINDOW_MS = 2 * 60 * 1000;
/** Minimum spacing between directory listings for one unresolved sub-agent. */
export const CODEX_SUBAGENT_LOOKUP_INTERVAL_MS = 2_000;

interface TrackedSubagent {
  /** `started` record time: selects the local-date directories to list. */
  startedAtMs: number;
  /** When the worker registered it: bounds the lookup window, so a sub-agent
   *  found late by an adopt attach still gets its full window. */
  observedAtMs: number;
  path?: string;
  cursor: CodexSubagentCursor;
  nextLookupAtMs: number;
}

export interface CodexSubagentLimitTrackerDeps {
  findRollout?: (threadId: string, startedAtMs: number) => string | undefined;
  drain?: typeof drainCodexSubagentLimits;
}

export class CodexSubagentLimitTracker {
  private readonly tracked = new Map<string, TrackedSubagent>();
  private readonly findRollout: (threadId: string, startedAtMs: number) => string | undefined;
  private readonly drain: typeof drainCodexSubagentLimits;

  constructor(sessionsRoot: () => string | undefined, deps: CodexSubagentLimitTrackerDeps = {}) {
    this.findRollout = deps.findRollout ?? ((threadId, startedAtMs) => {
      const root = sessionsRoot();
      return root ? findCodexSubagentRollout(threadId, startedAtMs, { sessionsRoot: root }) : undefined;
    });
    this.drain = deps.drain ?? drainCodexSubagentLimits;
  }

  get size(): number { return this.tracked.size; }

  observe(subagents: readonly CodexSpawnedSubagent[] | undefined, observedAtMs: number): void {
    if (!subagents) return;
    for (const { threadId, startedAtMs } of subagents) {
      if (this.tracked.has(threadId)) continue;
      this.tracked.set(threadId, {
        startedAtMs,
        observedAtMs,
        cursor: INITIAL_CODEX_SUBAGENT_CURSOR,
        nextLookupAtMs: 0,
      });
    }
    while (this.tracked.size > MAX_TRACKED_CODEX_SUBAGENTS) {
      const oldest = this.tracked.keys().next().value;
      if (oldest === undefined) break;
      this.tracked.delete(oldest);
    }
  }

  /** Read newly appended sub-agent lines; returns limit terminals only. */
  poll(nowMs: number = Date.now()): CodexBridgeEvent[] {
    const out: CodexBridgeEvent[] = [];
    for (const [id, sub] of this.tracked) {
      if (!sub.path) {
        if (nowMs - sub.observedAtMs > CODEX_SUBAGENT_LOOKUP_WINDOW_MS) {
          this.tracked.delete(id);
          continue;
        }
        if (nowMs < sub.nextLookupAtMs) continue;
        sub.nextLookupAtMs = nowMs + CODEX_SUBAGENT_LOOKUP_INTERVAL_MS;
        sub.path = this.findRollout(id, sub.startedAtMs);
        if (!sub.path) continue;
      }
      const result = this.drain(sub.path, sub.cursor);
      sub.cursor = result.cursor;
      out.push(...result.events);
    }
    return out;
  }

  clear(): void { this.tracked.clear(); }
}
