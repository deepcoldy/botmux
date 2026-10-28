/**
 * What a CLI process left unfinished when it ended, read back when botmux
 * resumes the same conversation in a fresh process (crash auto-restart, cold
 * resume after a suspend or a daemon restart).
 *
 * Without this the new process comes up idle and nobody is told:
 *  - a turn cut off mid-way (the model was still calling tools) is never
 *    finished — its input was consumed long ago, so the in-flight carry-over
 *    does not replay it;
 *  - background tasks (Bash `run_in_background`, Monitor, background Agent)
 *    die with the process. Claude Code records their stop but does not wake
 *    the model for it, so a bot waiting on a CI monitor waits forever.
 *
 * The facts come from the transcript the old process wrote, never from the
 * screen. Everything here is pure; the worker owns the file reads and IPC.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import {
  backgroundTaskDispatchAcks,
  backgroundTaskDispatchToolUseIds,
  backgroundTaskLaunches,
  backgroundTaskSettledIds,
  isClaudeTurnTerminalEvent,
  isMeaningfulQueuedCommand,
  isMeaningfulUserEvent,
  isScheduledTurnStartEvent,
  type BackgroundTaskKind,
  type TranscriptEvent,
} from './claude-transcript.js';
import type { CodexBridgeEvent } from './codex-transcript.js';
import type { PendingCliInput } from '../utils/pending-input-queue.js';
import { t } from '../i18n/index.js';

/** Transient reason for one CLI restart; never stored in session config. */
export type CliRestartCause = 'traex-auto-model';

/** Only a planned TraeX continuation resuming the requested native session
 *  may skip interruption scanning. Preferred-model resets without a queued
 *  continuation and later crash recovery leave restartCause unset. */
export function shouldSuppressRestartInterruptionScan(input: {
  restartCause?: CliRestartCause;
  cliId: string;
  exactResumeSessionId?: string;
  effectiveCliSessionId?: string;
}): boolean {
  return input.restartCause === 'traex-auto-model'
    && input.cliId === 'traex'
    && input.exactResumeSessionId !== undefined
    && input.effectiveCliSessionId === input.exactResumeSessionId;
}

/** Bytes of transcript tail read at a resume. The scan only needs the end of
 *  the old process's life; a cut mid-turn still shows as an open turn (any
 *  non-final assistant record opens it). Bounded so a resume of a very long
 *  session does not parse its whole history. */
export const RESTART_SCAN_MAX_BYTES = 16 * 1024 * 1024;

/** A background launch older than this is not reported even if no stop was
 *  recorded for it: Claude Code leaves no marker for some stops (UI, agent
 *  teardown), and naming a day-old task as "just interrupted" is noise. Same
 *  bound as the pending-turn journal (BRIDGE_TURN_RESTORE_MAX_AGE_MS). */
export const RESTART_TASK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How close to the old process's last record a `killed` stop must be to count
 *  as the process killing its tasks on the way out. Claude Code writes those
 *  stops, and at most a `dequeue` of them, within a second of dying (0.2 s in
 *  a real tmux server loss). This only rules out a TUI-dialog stop the session
 *  carried on past: Claude Code does not wake the model for such a stop, so on
 *  an idle session it is the last record just like an exit kill
 *  (see {@link EXIT_KILL_MAX_LAG_MS}). */
export const EXIT_KILL_WINDOW_MS = 5_000;

/** With botmux's record of when the old process ended (the worker saw it exit
 *  or stopped it), a `killed` stop must also be at most this long before that
 *  moment. Bounds the idle-session TUI stop above: one made hours before a
 *  crash is not reported. Generous because a tmux pane's death is noticed by
 *  polling (12–22 s after the kills on 10-21). */
export const EXIT_KILL_MAX_LAG_MS = 30 * 60_000;

export interface InterruptedBackgroundTask {
  taskId: string;
  kind: BackgroundTaskKind;
  /** The `description` the model gave the launching tool call, if any. */
  description?: string;
}

export interface InterruptedWork {
  /** The main agent's turn had started and not reached its terminal record. */
  turnOpen: boolean;
  /** Background tasks still running when the process ended. */
  tasks: InterruptedBackgroundTask[];
}

export function hasInterruptedWork(work: InterruptedWork | undefined): work is InterruptedWork {
  return !!work && (work.turnOpen || work.tasks.length > 0);
}

function eventTimeMs(ev: TranscriptEvent): number | undefined {
  const ms = typeof ev.timestamp === 'string' ? Date.parse(ev.timestamp) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/** Claude Code's stop record for a background task it killed: a
 *  `queue-operation enqueue` of a `<task-notification>` with status `killed`.
 *  Written for every running task as the process exits, and also when a user
 *  stops one from the TUI's task dialog — the two differ only in whether the
 *  process wrote anything afterwards (see {@link claudeInterruptedWork}). */
function isKilledTaskEnqueue(ev: TranscriptEvent): boolean {
  return ev.type === 'queue-operation'
    && ev.operation === 'enqueue'
    && typeof ev.content === 'string'
    && ev.content.trimStart().startsWith('<task-notification>')
    && /<status>killed<\/status>/.test(ev.content);
}

function toolUseDescription(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const { description, command } = input as { description?: unknown; command?: unknown };
  if (typeof description === 'string' && description.trim()) return description.trim();
  if (typeof command === 'string' && command.trim()) return command.trim();
  return undefined;
}

function toolResultToolUseIds(ev: TranscriptEvent): string[] {
  const content = ev.message?.content;
  if (!Array.isArray(content)) return [];
  return (content as any[])
    .filter(b => b && b.type === 'tool_result' && typeof b.tool_use_id === 'string')
    .map(b => b.tool_use_id as string);
}

interface TrackedTask extends InterruptedBackgroundTask {
  atMs?: number;
  expiresAtMs?: number;
}

/**
 * Fold a Claude Code transcript into what its last process left unfinished.
 * Only records stamped before `beforeMs` (when the new process was launched)
 * count, so the resumed process's own records — including the "didn't finish
 * before the previous session ended" notices it writes on resume — are never
 * read as the old process's state.
 *
 * Turn: opened by a real prompt (typed or dequeued type-ahead), a scheduler
 * fire, or any main-thread assistant record; closed by Claude Code's terminal
 * record ({@link isClaudeTurnTerminalEvent}) or an Esc interrupt (a user
 * record carrying `interruptedMessageId` — the user stopped it, nothing was
 * cut off). A delivered `<task-notification>` does not open it by itself: the
 * model's reply does. That keeps a resume-time orphan notice that the model
 * never answered from reading as an interrupted turn at the next restart.
 *
 * Background tasks: launches read from `toolUseResult` (Agent / Bash /
 * Monitor, see {@link backgroundTaskLaunches}) plus the legacy Agent
 * dispatch/ack pair, minus every recorded stop. A `killed` stop counts as the
 * process killing the task on its way out — so the task was interrupted — when
 * it is within {@link EXIT_KILL_WINDOW_MS} of the last record the old process
 * wrote and, given `processEndedAtMs`, within {@link EXIT_KILL_MAX_LAG_MS}
 * before that end. Without `processEndedAtMs` (a new worker resuming after a
 * daemon restart or a suspend) a TUI-dialog stop on an idle session cannot be
 * told apart and is reported too. A non-persistent Monitor whose own deadline
 * passed, and launches older than {@link RESTART_TASK_MAX_AGE_MS}, are not
 * reported.
 */
export function claudeInterruptedWork(
  events: readonly TranscriptEvent[],
  beforeMs: number,
  opts: { processEndedAtMs?: number } = {},
): InterruptedWork {
  let turnOpen = false;
  const toolUses = new Map<string, string | undefined>();
  const legacyAwaitingAck = new Map<string, string | undefined>();
  const live = new Map<string, TrackedTask>();
  const settled = new Set<string>();
  /** Tasks whose only stop so far is a `killed` record, with its time. */
  const killed = new Map<string, { task: TrackedTask; atMs: number }>();
  let lastRecordAtMs = -Infinity;

  const launch = (task: TrackedTask): void => {
    if (settled.has(task.taskId) || live.has(task.taskId) || killed.has(task.taskId)) return;
    live.set(task.taskId, task);
  };
  const settle = (taskId: string): void => {
    live.delete(taskId);
    killed.delete(taskId);
    settled.add(taskId);
  };

  for (const ev of events) {
    if (!ev || typeof ev !== 'object' || ev.isSidechain === true) continue;
    const atMs = eventTimeMs(ev);
    // Untimestamped lines are Claude Code's own bookkeeping (titles, modes,
    // snapshots), not conversation; anything at/after the launch is the new
    // process's.
    if (atMs === undefined || atMs >= beforeMs) continue;
    lastRecordAtMs = Math.max(lastRecordAtMs, atMs);

    if (isKilledTaskEnqueue(ev)) {
      for (const id of backgroundTaskSettledIds(ev)) {
        const task = live.get(id);
        if (task) {
          live.delete(id);
          killed.set(id, { task, atMs });
        }
      }
      continue;
    }

    const role = ev.message?.role ?? ev.type;
    if (role === 'user' && typeof (ev as { interruptedMessageId?: unknown }).interruptedMessageId === 'string') {
      turnOpen = false;
    } else if (isMeaningfulUserEvent(ev) || isMeaningfulQueuedCommand(ev) || isScheduledTurnStartEvent(ev)) {
      turnOpen = true;
    } else if (isClaudeTurnTerminalEvent(ev)) {
      turnOpen = false;
    } else if (role === 'assistant') {
      turnOpen = true;
    }

    if (role === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const block of ev.message!.content as any[]) {
        if (block && block.type === 'tool_use' && typeof block.id === 'string') {
          toolUses.set(block.id, toolUseDescription(block.input));
        }
      }
      for (const toolUseId of backgroundTaskDispatchToolUseIds(ev)) {
        legacyAwaitingAck.set(toolUseId, toolUses.get(toolUseId));
      }
    }
    if (role === 'user') {
      const resultToolUseIds = toolResultToolUseIds(ev);
      const launchDescription = resultToolUseIds.length === 1 ? toolUses.get(resultToolUseIds[0]) : undefined;
      for (const l of backgroundTaskLaunches(ev)) {
        launch({
          taskId: l.taskId,
          kind: l.kind,
          atMs,
          ...(l.expiresAtMs !== undefined ? { expiresAtMs: l.expiresAtMs } : {}),
          ...(launchDescription ? { description: launchDescription } : {}),
        });
      }
      // Builds that predate the structured `toolUseResult`.
      for (const ack of backgroundTaskDispatchAcks(ev)) {
        if (!legacyAwaitingAck.has(ack.toolUseId)) continue;
        const description = legacyAwaitingAck.get(ack.toolUseId);
        legacyAwaitingAck.delete(ack.toolUseId);
        launch({ taskId: ack.agentId, kind: 'agent', atMs, ...(description ? { description } : {}) });
      }
    }
    for (const id of backgroundTaskSettledIds(ev)) settle(id);
  }

  const reportable = (task: TrackedTask): boolean =>
    (task.expiresAtMs === undefined || task.expiresAtMs > beforeMs)
    && (task.atMs === undefined || beforeMs - task.atMs <= RESTART_TASK_MAX_AGE_MS);
  const killedOnExit = [...killed.values()]
    .filter(k => lastRecordAtMs - k.atMs <= EXIT_KILL_WINDOW_MS
      && (opts.processEndedAtMs === undefined || opts.processEndedAtMs - k.atMs <= EXIT_KILL_MAX_LAG_MS))
    .map(k => k.task);
  const tasks = [...live.values(), ...killedOnExit]
    .filter(reportable)
    .map(({ taskId, kind, description }) => ({ taskId, kind, ...(description ? { description } : {}) }));
  return { turnOpen, tasks };
}

/** `later` (the newest scan) with an `earlier` result that was never handed
 *  over still folded in: a resumed process that died before its first prompt
 *  wrote resume records that settle the old tasks, so the newer scan alone
 *  would forget them. */
export function mergeInterruptedWork(earlier: InterruptedWork | undefined, later: InterruptedWork): InterruptedWork {
  if (!earlier) return later;
  const known = new Set(later.tasks.map(task => task.taskId));
  return {
    turnOpen: later.turnOpen || earlier.turnOpen,
    tasks: [...earlier.tasks.filter(task => !known.has(task.taskId)), ...later.tasks],
  };
}

/** `work` without the background tasks already reported by this worker: a
 *  crash loop resumes the same transcript again and again, and one task needs
 *  one mention, not one per restart. */
export function withoutReportedTasks(work: InterruptedWork, reported: ReadonlySet<string>): InterruptedWork {
  return { turnOpen: work.turnOpen, tasks: work.tasks.filter(task => !reported.has(task.taskId)) };
}

/**
 * Whether a structured-transcript CLI (Pi, Codex, Grok, …) was mid-turn when
 * its process ended, from the bridge events its drainer produced: a prompt or
 * `turn_started` opens the turn, `assistant_final` / `turn_aborted` close it.
 * Per the bridge contract a `cot` record (thinking, tool call, tool result)
 * never starts or closes a turn; it only says one is running when the tail
 * window begins inside a turn, before any boundary was read. Events stamped
 * at/after `beforeMs` belong to the resumed process.
 */
export function structuredTurnOpen(
  events: ReadonlyArray<Pick<CodexBridgeEvent, 'kind' | 'timestampMs'>>,
  beforeMs: number,
): boolean {
  let open = false;
  let sawBoundary = false;
  for (const ev of events) {
    if (!(ev.timestampMs < beforeMs)) continue;
    if (ev.kind === 'user' || ev.kind === 'turn_started') {
      open = true;
      sawBoundary = true;
    } else if (ev.kind === 'assistant_final' || ev.kind === 'turn_aborted') {
      open = false;
      sawBoundary = true;
    } else if (ev.kind === 'cot' && !sawBoundary) {
      open = true;
    }
  }
  return open;
}

/** First line boundary of the last `maxBytes` of `path` (0 for a smaller
 *  file), so a tail read never starts on half a record. */
export function transcriptTailOffset(path: string, maxBytes: number = RESTART_SCAN_MAX_BYTES): number {
  const size = statSync(path).size;
  if (size <= maxBytes) return 0;
  const start = size - maxBytes;
  const fd = openSync(path, 'r');
  try {
    const probe = Buffer.alloc(64 * 1024);
    let offset = start;
    while (offset < size) {
      const n = readSync(fd, probe, 0, probe.length, offset);
      if (n <= 0) break;
      const nl = probe.subarray(0, n).indexOf(0x0a);
      if (nl >= 0) return offset + nl + 1;
      offset += n;
    }
    return size;
  } finally {
    closeSync(fd);
  }
}

const NOTE_TASK_LIMIT = 5;
const TASK_DESCRIPTION_MAX_CHARS = 60;

function taskLabel(task: InterruptedBackgroundTask): string {
  const kind = t(`worker.restart_interrupted.kind.${task.kind}`);
  const raw = task.description?.replace(/\s+/g, ' ').trim();
  const name = raw && raw.length > TASK_DESCRIPTION_MAX_CHARS
    ? `${raw.slice(0, TASK_DESCRIPTION_MAX_CHARS - 1)}…`
    : raw;
  return name
    ? t('worker.restart_interrupted.task', { name, kind, id: task.taskId })
    : t('worker.restart_interrupted.task_unnamed', { kind, id: task.taskId });
}

function taskList(tasks: readonly InterruptedBackgroundTask[]): string {
  const shown = tasks.slice(0, NOTE_TASK_LIMIT).map(taskLabel);
  const sep = t('worker.restart_interrupted.list_separator');
  const more = tasks.length - shown.length;
  return more > 0
    ? `${shown.join(sep)}${t('worker.restart_interrupted.more_tasks', { count: more })}`
    : shown.join(sep);
}

/** The short note handed to the resumed CLI. */
export function restartInterruptionNote(work: InterruptedWork): string {
  const parts: string[] = [];
  if (work.turnOpen) parts.push(t('worker.restart_interrupted.note_turn'));
  if (work.tasks.length > 0) {
    parts.push(t('worker.restart_interrupted.note_tasks', { tasks: taskList(work.tasks) }));
  }
  return t('worker.restart_interrupted.note', { details: parts.join('') });
}

/** The one notice posted in the session's thread. `noteDelivered` says whether
 *  the CLI was handed the note (and so will pick the work up by itself). */
export function restartInterruptionNotice(
  work: InterruptedWork,
  opts: { cliName: string; noteDelivered: boolean },
): string {
  const parts: string[] = [];
  if (work.turnOpen) parts.push(t('worker.restart_interrupted.notice_turn'));
  if (work.tasks.length > 0) {
    parts.push(t('worker.restart_interrupted.notice_tasks', {
      count: work.tasks.length,
      tasks: taskList(work.tasks),
    }));
  }
  return t(
    opts.noteDelivered ? 'worker.restart_interrupted.notice' : 'worker.restart_interrupted.notice_no_note',
    { cliName: opts.cliName, details: parts.join(t('worker.restart_interrupted.notice_separator')) },
  );
}

/** Whether the note may ride on `item`, the first input the resumed CLI will
 *  receive. Durable / meeting / Codex App inputs have their own replay or
 *  payload contracts, so the note is not mixed into them. */
export function restartNoteMayPrefix(item: PendingCliInput): boolean {
  return item.dispatchAttempt === undefined
    && !item.durablePrimaryInbox
    && !item.vcMeetingImTurnOrigin
    && !item.codexAppInput
    && !item.codexAppDispatchId
    && !item.taskContinuation;
}

/** `item` with the note in front of what the CLI receives. The logical
 *  content (what transcript bridges fingerprint to attribute the turn) stays
 *  the original message, and an older note on the same input (replayed after
 *  another restart) is replaced rather than stacked. */
export function prefixRestartNote(item: PendingCliInput, note: string): PendingCliInput {
  const original = item.restartNoteOriginalContent ?? item.content;
  return {
    ...item,
    logicalContent: item.logicalContent ?? original,
    content: `${note}\n\n${original}`,
    restartNoteOriginalContent: original,
  };
}

/** A standalone input carrying the note, attributed to `template` — the last
 *  turn written to the old process — so its card, reply target and caller
 *  identity continue that turn, the same way the in-flight carry-over replays
 *  an interrupted input under its original turn. */
export function restartNoteInput(template: PendingCliInput, note: string): PendingCliInput | undefined {
  if (!template.turnId || !restartNoteMayPrefix(template)) return undefined;
  return {
    content: note,
    turnId: template.turnId,
    ...(template.replyTurnId ? { replyTurnId: template.replyTurnId } : {}),
    ...(template.turnCallerOpenId ? { turnCallerOpenId: template.turnCallerOpenId } : {}),
    ...(template.trustedCaller ? { trustedCaller: template.trustedCaller } : {}),
    ...(template.trustedController ? { trustedController: template.trustedController } : {}),
  };
}
