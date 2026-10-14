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
 * Only sub-agents whose `started` record is ingested live are tracked; the
 * parent baseline (history before the worker attached) is never replayed, so a
 * stale limit from an earlier quota window cannot trigger a handoff.
 */
import {
  drainCodexSubagentLimits,
  findCodexSubagentRollout,
  type CodexBridgeEvent,
} from './codex-transcript.js';

/** Bound on concurrently tracked sub-agents; the oldest are dropped first. */
export const MAX_TRACKED_CODEX_SUBAGENTS = 64;
/** A sub-agent rollout normally appears within a second of `started`. Stop
 *  listing date directories for one that never shows up. */
export const CODEX_SUBAGENT_LOOKUP_WINDOW_MS = 2 * 60 * 1000;
/** Minimum spacing between directory listings for one unresolved sub-agent. */
export const CODEX_SUBAGENT_LOOKUP_INTERVAL_MS = 2_000;

interface TrackedSubagent {
  startedAtMs: number;
  path?: string;
  offset: number;
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

  observe(threadIds: readonly string[] | undefined, startedAtMs: number): void {
    if (!threadIds) return;
    for (const id of threadIds) {
      if (this.tracked.has(id)) continue;
      this.tracked.set(id, { startedAtMs, offset: 0, nextLookupAtMs: 0 });
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
        if (nowMs - sub.startedAtMs > CODEX_SUBAGENT_LOOKUP_WINDOW_MS) {
          this.tracked.delete(id);
          continue;
        }
        if (nowMs < sub.nextLookupAtMs) continue;
        sub.nextLookupAtMs = nowMs + CODEX_SUBAGENT_LOOKUP_INTERVAL_MS;
        sub.path = this.findRollout(id, sub.startedAtMs);
        if (!sub.path) continue;
      }
      const result = this.drain(sub.path, sub.offset);
      sub.offset = result.newOffset;
      out.push(...result.events);
    }
    return out;
  }

  clear(): void { this.tracked.clear(); }
}
