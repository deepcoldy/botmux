/**
 * A Claude turn the transcript bridge read nothing of.
 *
 * Claude Code appends a turn's prompt record as the turn starts and its reply
 * records as they stream, so every model turn grows the transcript Claude
 * writes. When the CLI demonstrably ran one — its busy footer / OSC 7501
 * `working` out of idle — and came back to its prompt without the bridge's
 * file growing at all, the bridge is on a file
 * Claude no longer writes and that turn's reply is dropped without a trace.
 * Seen 2026-10-22: a `/clear` made before a daemon restart left the restored
 * bridge on the pre-clear transcript, and four replies never reached the group.
 *
 * Pure (no fs / IPC / timers): the worker feeds read positions and turn edges.
 */

export interface BridgeReadPosition {
  /** The bridge's primary transcript. */
  path: string | undefined;
  /** Bytes of it consumed so far. */
  offset: number;
}

/** Busy spans shorter than this are not judged. Claude writes the prompt record
 *  within a few hundred ms of starting a turn; a sub-3s busy→idle flicker of
 *  the screen heuristics can end before that write and say nothing. */
export const BLIND_TURN_MIN_BUSY_MS = 3_000;

export type BlindTurnVerdict =
  /** No turn evidence since the last prompt, or too short to judge. */
  | { kind: 'none' }
  /** The bridge read the turn (its file grew, or it moved onto another one). */
  | { kind: 'read' }
  /** An idle-compaction span the bridge read nothing of. Compaction writes its
   *  records after the prompt returns and answers nobody, so it is not
   *  reported; but terminal input the worker never sees (a client attached
   *  straight to the pane) can run a real turn inside it. */
  | { kind: 'maintenance'; turnStartedAtMs: number }
  | {
    kind: 'blind';
    /** When this turn started. */
    turnStartedAtMs: number;
    /** When the first turn of the current unread run started: recovery
     *  replays everything from there. */
    blindSinceMs: number;
    /** Whether this run has already been reported to the user. */
    reported: boolean;
  };

export class BridgeBlindTurnWatch {
  private turn: { startedAtMs: number; at: BridgeReadPosition; maintenance: boolean } | undefined;
  private blindSinceMs: number | undefined;
  private reported = false;
  private idleCompaction = false;
  private lastPromptAtMs = -Infinity;

  /** PreCompact 是维护事件，不能当成产生回复的模型轮次。已有待处理输入时
   *  不豁免：真实漏读仍由原来的恢复与告警路径处理。 */
  noteCompactionStarted(hasPendingTurn: boolean, hookStartedAtMs: number): boolean {
    if (hasPendingTurn || hookStartedAtMs <= this.lastPromptAtMs
      || this.idleCompaction || this.turn?.maintenance) return false;
    // 不能把压缩前已运行的模型轮次改成维护；只覆盖 hook 之后才观察到的忙碌。
    if (this.turn && this.turn.startedAtMs < hookStartedAtMs) return false;
    this.idleCompaction = true;
    if (this.turn) this.turn.maintenance = true;
    return true;
  }

  noteCompactionFinished(): void {
    this.idleCompaction = false;
  }

  /** Explicit evidence the CLI started a model turn. A turn already open keeps
   *  its start. */
  noteTurnStarted(at: BridgeReadPosition, nowMs: number): void {
    this.turn ??= { startedAtMs: nowMs, at: { ...at }, maintenance: this.idleCompaction };
  }

  /** The CLI is back at its prompt: judge the turn that just ended. */
  noteTurnEnded(at: BridgeReadPosition, nowMs: number, hasPendingTurn = false): BlindTurnVerdict {
    // 即使压缩被取消、没有 SessionStart(compact)，提示符也会结束这次豁免，
    // 下一条真正的输入不能一直被当作维护。旧的漏读 run 与去重状态保留。
    const turn = this.turn;
    this.turn = undefined;
    this.idleCompaction = false;
    this.lastPromptAtMs = nowMs;
    if (!turn) return { kind: 'none' };
    if (at.path !== turn.at.path || at.offset > turn.at.offset) {
      this.blindSinceMs = undefined;
      this.reported = false;
      return { kind: 'read' };
    }
    if (nowMs - turn.startedAtMs < BLIND_TURN_MIN_BUSY_MS) return { kind: 'none' };
    if (turn.maintenance && !hasPendingTurn) return { kind: 'maintenance', turnStartedAtMs: turn.startedAtMs };
    this.blindSinceMs ??= turn.startedAtMs;
    return { kind: 'blind', turnStartedAtMs: turn.startedAtMs, blindSinceMs: this.blindSinceMs, reported: this.reported };
  }

  /** The user was told about the current unread run; stay quiet until the
   *  bridge reads a turn again. */
  noteReported(): void {
    this.reported = true;
  }

  /** The bridge was torn down (CLI restart / exit): nothing carries over. */
  reset(): void {
    this.idleCompaction = false;
    this.lastPromptAtMs = -Infinity;
    this.turn = undefined;
    this.blindSinceMs = undefined;
    this.reported = false;
  }
}

export interface BlindTurnNoticeInput {
  /** The transcript carries every reply of this session to the group, local
   *  turns included: adopt mode, or zero-injection terminal sync. */
  transcriptCarriesEveryReply: boolean;
  /** A Lark turn whose prompt line the bridge never read is still pending. */
  unreadLarkTurn: boolean;
  /** The model ran `botmux send` after the turn started. */
  sentDuringTurn: boolean;
}

/** Whether an unread turn lost something the group would otherwise have got.
 *  With `botmux send` delivery the transcript is only the fallback for a Lark
 *  turn the model did not answer itself, and a terminal-local turn is never
 *  forwarded at all — telling the group about those would be noise. */
export function blindTurnNeedsNotice(input: BlindTurnNoticeInput): boolean {
  if (input.transcriptCarriesEveryReply) return true;
  return input.unreadLarkTurn && !input.sentDuringTurn;
}
