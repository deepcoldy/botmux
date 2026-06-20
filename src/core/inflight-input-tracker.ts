/**
 * Tracks user inputs that have been written to the CLI's PTY but whose turn
 * hasn't completed yet (the CLI hasn't returned to its idle prompt since the
 * write). If the CLI process dies first, those inputs would otherwise vanish:
 * codex crashing mid-submit never records them in history.jsonl, the
 * auto-restarted CLI comes up idle and empty, and nothing re-delivers — the
 * user-visible symptom is a session stuck at 「等待输入」 that "never received"
 * the message (2026-06-10 incident, codex 0.137.0 exit 1 ~3s after paste).
 *
 * The worker wires it up as:
 *   - flushPending dequeues an item and writes it  → onWrite(item)
 *   - CLI returns to idle prompt (markPromptReady) → onTurnComplete()
 *   - CLI process exits (backend.onExit)           → onCliExit()
 *   - fresh CLI spawning (spawnCli, non-adopt)     → takeCarryOver() and
 *     unshift the result back into pendingMessages
 *
 * Trade-off: if the CLI accepted the input and died mid-turn, re-delivery
 * makes the restarted CLI see the prompt twice — a duplicate ask beats a
 * silently lost message. A false-idle blip mid-turn clears the in-flight set
 * early and degrades to the old lose-on-crash behavior for that turn only.
 */

export type InflightItem = { content: string; turnId?: string };

export class InflightInputTracker {
  private unacked: InflightItem[] = [];
  private carryOver: InflightItem[] = [];

  /** An input just went onto the CLI's PTY. */
  onWrite(item: InflightItem): void {
    this.unacked.push(item);
  }

  /** CLI is back at its idle prompt — everything written has been consumed
   *  (answered, steered into the active turn, or drained from the TUI's own
   *  type-ahead queue). Nothing is in flight anymore. */
  onTurnComplete(): void {
    this.unacked.length = 0;
  }

  /** CLI process died. Stash whatever was in flight for the next spawn.
   *  Appends (rather than replaces) so a double exit before the respawn
   *  consumes the stash can't drop the earlier batch. Returns how many
   *  items were newly stashed by THIS exit. */
  onCliExit(): number {
    const n = this.unacked.length;
    if (n > 0) this.carryOver.push(...this.unacked.splice(0));
    return n;
  }

  /** A fresh CLI is spawning: hand back everything that must be re-queued,
   *  and reset the in-flight set (a brand-new process can't have anything
   *  in flight — covers a previous life whose exit event never fired, e.g.
   *  a detach-style kill). */
  takeCarryOver(): InflightItem[] {
    this.unacked.length = 0;
    return this.carryOver.splice(0);
  }
}
