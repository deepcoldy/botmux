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
 * Once the CLI's own transcript shows an input's turn started (its user
 * record landed — onTurnStarted), the input is no longer replayed into a CLI
 * that RESUMES the conversation: it is already in that history, and replaying
 * it re-ran the whole request (10-21: a Pi review replayed twice across tmux
 * restarts). The restart note (services/restart-interruption) tells the CLI to
 * continue instead. A FRESH respawn has no such history, so started inputs are
 * still re-delivered there (takeStartedCarryOver).
 *
 * Trade-off for inputs with no start evidence: if the CLI accepted one and
 * died mid-turn, re-delivery makes the restarted CLI see it twice — a
 * duplicate ask beats a silently lost message. A false-idle blip mid-turn
 * clears the in-flight set early and degrades to the old lose-on-crash
 * behavior for that turn only.
 */

import type { CodexAppTurnInput, VcMeetingImTurnOrigin } from '../types.js';

export type InflightItem = {
  content: string;
  logicalContent?: string;
  turnId?: string;
  replyTurnId?: string;
  dispatchAttempt?: number;
  codexAppDispatchId?: string;
  queuedActivationToken?: string;
  vcMeetingImTurnOrigin?: VcMeetingImTurnOrigin;
  codexAppInput?: CodexAppTurnInput;
  /** At-most-once turn (idempotency lease): must NEVER be carried over to a
   *  respawned CLI (codex #776 round-7 finding #1). See PendingCliInput.noReplay. */
  noReplay?: boolean;
};

export class InflightInputTracker {
  private unacked: InflightItem[] = [];
  /** Written, and the CLI's transcript shows the turn started; not finished. */
  private started: InflightItem[] = [];
  private carryOver: InflightItem[] = [];
  private startedCarryOver: InflightItem[] = [];

  /** Something written to the PTY has not been consumed yet (no idle since). */
  hasUnacked(): boolean {
    return this.unacked.length > 0;
  }

  /** An input just went onto the CLI's PTY. */
  onWrite(item: InflightItem): void {
    this.unacked.push(item);
  }

  /** Remove one exact item after a definitive local write failure before the
   * caller re-queues it. Covers both the live in-flight set and a synchronous
   * backend-exit handoff that may already have moved it to carryOver. */
  forget(item: InflightItem): void {
    this.unacked = this.unacked.filter(candidate => candidate !== item);
    this.started = this.started.filter(candidate => candidate !== item);
    this.carryOver = this.carryOver.filter(candidate => candidate !== item);
    this.startedCarryOver = this.startedCarryOver.filter(candidate => candidate !== item);
  }

  /** Retire one exact write whose transport outcome is ambiguous and must not
   * be replayed automatically. Other type-ahead items remain tracked. */
  retire(item: InflightItem): boolean {
    for (const list of [this.unacked, this.started]) {
      const index = list.indexOf(item);
      if (index >= 0) {
        list.splice(index, 1);
        return true;
      }
    }
    return false;
  }

  /** A caller acknowledged an exact-turn interrupt. Drop that turn from both
   * replay stages, including an exit that already moved its input to carryOver.
   * Unrelated type-ahead inputs still belong to the next CLI generation. */
  retireTurn(turnId: string): void {
    this.unacked = this.unacked.filter(item => item.turnId !== turnId);
    this.started = this.started.filter(item => item.turnId !== turnId);
    this.carryOver = this.carryOver.filter(item => item.turnId !== turnId);
    this.startedCarryOver = this.startedCarryOver.filter(item => item.turnId !== turnId);
  }

  /** The CLI's transcript shows this turn's input arrived (its user record).
   *  Inputs of an unknown turn stay unacked. */
  onTurnStarted(turnId: string): void {
    const keep: InflightItem[] = [];
    for (const item of this.unacked) (item.turnId === turnId ? this.started : keep).push(item);
    this.unacked = keep;
  }

  /** CLI is back at its idle prompt — everything written has been consumed
   *  (answered, steered into the active turn, or drained from the TUI's own
   *  type-ahead queue). Nothing is in flight anymore. */
  onTurnComplete(): void {
    this.unacked.length = 0;
    this.started.length = 0;
  }

  /** CLI process died. Stash whatever was in flight for the next spawn.
   *  Appends (rather than replaces) so a double exit before the respawn
   *  consumes the stash can't drop the earlier batch. Returns how many
   *  items were newly stashed by THIS exit. */
  onCliExit(shouldCarry: (item: InflightItem) => boolean = () => true): number {
    const exiting = this.unacked.splice(0);
    const carried = exiting.filter(shouldCarry);
    if (carried.length > 0) this.carryOver.push(...carried);
    this.startedCarryOver.push(...this.started.splice(0).filter(shouldCarry));
    return carried.length;
  }

  /** A fresh CLI is spawning: hand back everything that must be re-queued,
   *  and reset the in-flight set (a brand-new process can't have anything
   *  in flight — covers a previous life whose exit event never fired, e.g.
   *  a detach-style kill). */
  takeCarryOver(): InflightItem[] {
    this.unacked.length = 0;
    this.started.length = 0;
    return this.carryOver.splice(0);
  }

  /** Inputs whose turn had started when the CLI died. Re-deliver them only to
   *  a FRESH respawn (no history); a resumed CLI already has them. */
  takeStartedCarryOver(): InflightItem[] {
    return this.startedCarryOver.splice(0);
  }
}
