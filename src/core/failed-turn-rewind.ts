/**
 * A turn that ended on API errors alone — no tool call, no text — leaves
 * nothing behind but its input and an error record. Every further input used
 * to start a new turn on top of it, so an upstream outage turned a session into
 * a stack of "input → API Error" rounds (2026-11-16: 33 of them in one steward
 * session, one failure card each).
 *
 * Instead the next input cuts that turn out of the Claude Code transcript the
 * way /rewind does (context-rewind.ts) and goes in together with it:
 *
 *  - a retry (failure card button, /retry) or botmux's own automatic
 *    continuation re-sends the failed input (`resend`);
 *  - anything else — a trigger's "继续", a new chat message — is sent after
 *    the failed input in ONE turn (`merge`), so the failed input is not lost.
 *
 * So the session holds at most the latest failure. A turn that made progress,
 * or one this cannot cut (another CLI, a remote or adopted pane, a turn behind
 * a compaction, a busy CLI…), keeps the old behaviour.
 *
 * The daemon decides from its failed-turn record whether an input carries a
 * {@link FailedTurnRewindDirective}; the worker owns the transcript and the
 * CLI, re-checks the transcript itself and only then cuts. Pure functions only:
 * worker and daemon state stay with their callers.
 */
import type { FailedTurnRecord, FailedTurnRewindDirective } from '../types.js';
import { isHttpVirtualSession, type DaemonSession } from './types.js';
import { isSilentScheduledTurn } from './silent-schedule-turns.js';
import { isTriggerFinalSuppressed } from './trigger-final-suppression.js';
import { normaliseForFingerprint } from '../services/claude-transcript.js';
import type { PurgeResumeTarget } from '../services/transcript-image-purge.js';
import { isInClaudeProjectsRoot, type ClaudeProjectsRoot } from '../services/claude-projects-root.js';
import { inspectLastClaudeTurn, withOpenTranscript, type LastTurnInspection, type RewindResult, type TranscriptTreeScope } from './context-rewind.js';

/** The failed input, then the newer one, as one turn. A newer input identical
 *  to how the failed input already ends (a connector re-sending its bare
 *  "继续" after every failure) is not appended again. */
export function mergeFailedTurnInput(failedInput: string, next: string): string {
  const head = failedInput.trimEnd();
  const tail = next.trim();
  if (!tail || head === tail || head.endsWith(`\n\n${tail}`)) return head;
  return `${head}\n\n${tail}`;
}

/** Input the CLI reads as a command of its own (a slash command, a shell
 *  escape): it cannot be folded into a turn's text. */
function isCliCommandInput(content: string): boolean {
  return /^[/!]/.test(content.trimStart());
}

/** Error codes of a failed turn whose input may be cut and sent again. A
 *  cancelled request is a stop the user made; rate limits never arrive as
 *  `failed` (they have their own limited state). */
export function rewindableErrorCode(errorCode: string | undefined): boolean {
  return !!errorCode && errorCode.startsWith('provider_') && errorCode !== 'provider_cancelled'
    && errorCode !== 'provider_rate_limited';
}

/**
 * Daemon side: the directive (if any) an input should carry.
 *
 * Only for a turn recorded as a direct failure the provider may answer
 * differently next time (`retryable !== false`; an explicit refusal keeps its
 * card and its stacking, as before). Whether that turn is still the last one
 * in the transcript is the worker's call: it reads the transcript and declines
 * when anything else came after it (a terminal-typed turn, an input that went
 * in plainly), so a stale record can only cost a declined directive.
 */
export function planFailedTurnRewind(input: {
  record: FailedTurnRecord | undefined;
  /** This input's own turn id. */
  turnId: string | undefined;
  content: string;
  mode: 'merge' | 'resend';
}): FailedTurnRewindDirective | undefined {
  const record = input.record;
  if (!record || record.directFailure !== true || record.status !== 'failed') return undefined;
  if (record.limitedSnapshot || record.recovery || record.retryable === false) return undefined;
  if (!rewindableErrorCode(record.errorCode)) return undefined;
  if (!record.turnId || (input.turnId !== undefined && input.turnId === record.turnId)) return undefined;
  if (!record.cliInput.trim() || isCliCommandInput(record.cliInput)) return undefined;
  if (input.mode === 'merge' && isCliCommandInput(input.content)) return undefined;
  return {
    failedTurnId: record.turnId,
    failedInput: record.cliInput,
    mode: input.mode,
    content: input.mode === 'resend' ? record.cliInput : mergeFailedTurnInput(record.cliInput, input.content),
  };
}

/** A block the worker appends to an input at the CLI write edge — the skill
 *  catalog (or its replacement) owed after a restart — and nothing after it. */
const WRITE_EDGE_BLOCK_RE = /(?:<botmux_skills_refresh>[\s\S]*?<\/botmux_skills_refresh>|<botmux_skills\b[^>]*>[\s\S]*?<\/botmux_skills>)\s*$/;

/** How a turn's recorded text relates to an input the daemon sent: the same
 *  input, possibly followed by blocks the worker appended when writing it.
 *  `suffix` is those blocks as recorded (empty when there are none); a cut
 *  must carry them on, or the conversation would lose e.g. the refreshed
 *  skill catalog. Undefined when the text is not that input. */
export function matchRecordedInput(recorded: string, input: string): { suffix: string } | undefined {
  const want = normaliseForFingerprint(input);
  if (want.length === 0) return undefined;
  if (normaliseForFingerprint(recorded) === want) return { suffix: '' };
  let head = recorded;
  let last: string | undefined;
  for (let i = 0; i < 4; i += 1) {
    const block = WRITE_EDGE_BLOCK_RE.exec(head);
    if (!block) return undefined;
    // A catalog replaces every earlier one: only the latest is worth keeping.
    last ??= block[0].trim();
    head = head.slice(0, block.index);
    if (normaliseForFingerprint(head) === want) return { suffix: last };
  }
  return undefined;
}

/** Daemon side: this turn's answer goes to the chat — the same exits
 *  codexAppDeliverySinkForTurn tells apart, plus silent runs and HTTP-only
 *  sessions. Read while the turn's routing state is still in place (at its
 *  admission, or at its terminal before the HTTP settlement drops it). */
export function turnAnswersInChat(ds: DaemonSession, turnId: string): boolean {
  return !isSilentScheduledTurn(ds, turnId)
    && !isTriggerFinalSuppressed(ds, turnId)
    && !ds.suppressedFinalOutputTurns?.has(turnId)
    && !ds.pendingWaitPromises?.has(turnId)
    && !ds.asyncTriggerResults?.has(turnId)
    && !ds.settledHttpTerminalTurns?.has(turnId)
    && !ds.session.docCommentTargets?.[turnId]
    && !ds.docCommentTurns?.has(turnId)
    && !isHttpVirtualSession(ds.chatId)
    && !ds.session.headless;
}

/** Daemon side: an input sent to the live worker to carry `failedTurnId` on
 *  (any failed turn when omitted) has not been answered yet — its CLI restart
 *  is still running. A retry now would run the failed input twice. */
export function failedTurnRewindInFlight(
  ds: Pick<DaemonSession, 'pendingFailedTurnRewinds' | 'worker'>,
  failedTurnId?: string,
): boolean {
  for (const pending of ds.pendingFailedTurnRewinds?.values() ?? []) {
    if ((failedTurnId === undefined || pending.failedTurnId === failedTurnId)
      && pending.worker === ds.worker && !ds.worker?.killed) return true;
  }
  return false;
}

/** The inspected last turn is the failed turn whose input is `failedInput`,
 *  answered by errors alone, and cutting it leaves a resumable transcript. */
export function lastTurnIsFailedInput(turn: LastTurnInspection, failedInput: string): boolean {
  return turn.outcome === 'error_only'
    && turn.resumable === true
    && turn.offset !== undefined
    && turn.text !== undefined
    && matchRecordedInput(turn.text, failedInput) !== undefined;
}

/** Worker side, at a failed terminal: whether the turn it just ended is the
 *  transcript's last turn and produced nothing but errors. */
export function transcriptTurnFailedWithoutOutput(jsonlPath: string, writtenInput: string): boolean {
  return lastTurnIsFailedInput(inspectLastClaudeTurn(jsonlPath), writtenInput);
}

/** The last turn of a transcript inside the projects root the worker pinned
 *  when it launched the CLI (services/claude-projects-root.ts, the check the
 *  image purge applies): never a root derived from the transcript's own path,
 *  which a link at or above `projects` would move along. No pinned root:
 *  nothing is trusted. The file itself is never followed either, see
 *  {@link inspectLastClaudeTurn}. */
export function inspectLastTurnInProjectsRoot(
  jsonlPath: string,
  root: ClaudeProjectsRoot | undefined,
  scope: TranscriptTreeScope = {},
): LastTurnInspection {
  assertTranscriptInProjectsRoot(jsonlPath, root);
  return inspectLastClaudeTurn(jsonlPath, undefined, scope);
}

/** The last-turn read and the cut of a failed-turn rewind, on one held
 *  descriptor (context-rewind's withOpenTranscript): the cut lands on the
 *  file read. A transcript in the CLI-writable tree is checked against that
 *  tree on open, and its backup goes to `scope.backupDir`. */
export interface FailedTurnTranscript {
  lastTurn(): LastTurnInspection;
  cut(offset: number): RewindResult;
}

/** Open the transcript for {@link runFailedTurnRewindMaintenance}: inside the
 *  projects root pinned at launch, through withOpenTranscript; the cut keeps
 *  only the bytes it removes. */
export function withFailedTurnTranscript<T>(
  jsonlPath: string,
  root: ClaudeProjectsRoot | undefined,
  scope: TranscriptTreeScope,
  use: (transcript: FailedTurnTranscript) => T,
): T {
  assertTranscriptInProjectsRoot(jsonlPath, root);
  return withOpenTranscript(jsonlPath, scope, transcript => use({
    lastTurn: () => transcript.lastTurn(),
    cut: offset => transcript.cut(offset, Date.now(), { backup: 'removed' }),
  }));
}

/** Throws unless the transcript lies inside the projects root pinned at
 *  launch (no pinned root: nothing is trusted). */
export function assertTranscriptInProjectsRoot(jsonlPath: string, root: ClaudeProjectsRoot | undefined): void {
  if (!root || !isInClaudeProjectsRoot(jsonlPath, root)) {
    throw new Error('transcript outside its projects directory');
  }
}

/** What the CLI gets once the turn is cut: the directive's content, then the
 *  write-edge blocks the cut turn carried (see {@link matchRecordedInput}). */
export function rewoundContent(content: string, suffix: string): string {
  return suffix ? `${content}\n\n${suffix}` : content;
}

export type FailedTurnRewindPlan =
  | { kind: 'decline'; reason: string }
  | {
    kind: 'proceed';
    target: PurgeResumeTarget;
    offset: number;
    uuid?: string;
    preserveScratchTree: boolean;
  };

/** A cut that landed, with the write-edge blocks of the turn it removed. */
export type FailedTurnRewindOutcome =
  | { kind: 'rewound'; result: RewindResult; suffix: string }
  | { kind: 'declined'; reason: string };

/** Worker side, before anything is torn down: may this message's directive
 *  run? Any reason not to leaves the CLI running and the message unchanged. */
export function planFailedTurnRewindRequest(input: {
  cliId: string | undefined;
  /** Adopted panes and remote backends have no worker-owned local transcript. */
  localOwnedSession: boolean;
  target: PurgeResumeTarget | undefined;
  restartInProgress: boolean;
  childPid: number | null | undefined;
  /** Sandbox mode of the running CLI ('off' | 'oncall' | 'scratch'). */
  sandboxMode: string | undefined;
  platform: NodeJS.Platform;
  /** Why the CLI is not idle (not at its prompt, input queued or being
   *  written, a turn holding it); undefined when it is. */
  cliBusy: string | undefined;
  directive: FailedTurnRewindDirective;
  inspect: (jsonlPath: string) => LastTurnInspection;
}): FailedTurnRewindPlan {
  if (input.cliId !== 'claude-code' || !input.localOwnedSession || !input.target) {
    return { kind: 'decline', reason: 'no worker-owned local Claude Code transcript' };
  }
  if (input.restartInProgress) return { kind: 'decline', reason: 'a CLI restart is already in progress' };
  // Same rule as the image purge: only the Linux overlay can be re-prepared
  // around a rewritten view.
  const scratch = input.sandboxMode === 'scratch';
  if (scratch && input.platform !== 'linux') {
    return { kind: 'decline', reason: `scratch sandbox on ${input.platform} cannot reuse its view` };
  }
  if (!input.childPid || input.childPid <= 0) return { kind: 'decline', reason: 'no CLI pid to prove its exit with' };
  if (input.cliBusy) return { kind: 'decline', reason: `the CLI is not idle (${input.cliBusy})` };
  let turn: LastTurnInspection;
  try {
    turn = input.inspect(input.target.jsonlPath);
  } catch (err) {
    return { kind: 'decline', reason: `transcript unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!lastTurnIsFailedInput(turn, input.directive.failedInput)) {
    return { kind: 'decline', reason: `the transcript's last turn is not that failed input (${turn.outcome})` };
  }
  return {
    kind: 'proceed',
    target: input.target,
    offset: turn.offset!,
    ...(turn.uuid ? { uuid: turn.uuid } : {}),
    preserveScratchTree: scratch,
  };
}

/** Runs between killing the CLI and respawning it. Never throws: the restart
 *  goes on either way, and a declined outcome leaves the transcript as it was
 *  (the message then goes in unchanged). The turn is re-read after the exit —
 *  it must still be the one planned, at the same place. */
export async function runFailedTurnRewindMaintenance(deps: {
  waitForQuiescence: () => Promise<void>;
  /** Opens the transcript once: the last-turn read and the cut both go
   *  through that one held descriptor, so the cut lands on the file read. */
  withTranscript: <T>(use: (transcript: FailedTurnTranscript) => T) => T;
  planned: { offset: number; uuid?: string };
  failedInput: string;
  /** Checked right before the cut, with nothing awaited in between: the
   *  message that carries the failed input on must still be waiting for the
   *  CLI, or cutting would lose that input. */
  messageStillQueued: () => boolean;
}): Promise<FailedTurnRewindOutcome> {
  const text = (err: unknown) => (err instanceof Error ? err.message : String(err));
  try {
    await deps.waitForQuiescence();
  } catch (err) {
    return { kind: 'declined', reason: `CLI exit unproven: ${text(err)}` };
  }
  try {
    return deps.withTranscript((transcript): FailedTurnRewindOutcome => {
      let turn: LastTurnInspection;
      try {
        turn = transcript.lastTurn();
      } catch (err) {
        return { kind: 'declined', reason: `transcript unreadable: ${text(err)}` };
      }
      if (!lastTurnIsFailedInput(turn, deps.failedInput)
        || turn.offset !== deps.planned.offset || turn.uuid !== deps.planned.uuid) {
        return { kind: 'declined', reason: `the transcript changed before the cut (${turn.outcome})` };
      }
      if (!deps.messageStillQueued()) return { kind: 'declined', reason: 'the message is no longer waiting for the CLI' };
      const suffix = matchRecordedInput(turn.text!, deps.failedInput)!.suffix;
      try {
        return { kind: 'rewound', result: transcript.cut(turn.offset!), suffix };
      } catch (err) {
        return { kind: 'declined', reason: `cut failed: ${text(err)}` };
      }
    });
  } catch (err) {
    return { kind: 'declined', reason: `transcript unreadable: ${text(err)}` };
  }
}
