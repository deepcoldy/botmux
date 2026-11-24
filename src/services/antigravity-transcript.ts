/**
 * Structured transcript bridge drainer for Google Antigravity CLI (`agy`).
 *
 * Antigravity writes two append-only conversation logs side by side in
 *   ~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/
 *   - transcript.jsonl       compact: any long field (content / thinking /
 *                            tool_calls args) is cut to its head and tail
 *                            around a `<truncated N bytes>` marker, and the
 *                            record lists the cut fields in `truncated_fields`;
 *   - transcript_full.jsonl  the same records, untruncated (never carries
 *                            `truncated_fields`).
 * Both hold one line per step in the same order (identical step_index
 * sequence); agy writes the compact line first and the full line 0–3 ms later.
 * The bridge reads the FULL log — a long final reply read from the compact log
 * reached Lark with its middle silently replaced by the marker — and falls
 * back to the compact log only for an agy build that does not write the full
 * one (or the few ms before it is created; see
 * mapAntigravityCompactOffsetToFull for moving a compact bind over). A final
 * read from the compact log that was cut gets an explicit notice appended.
 *
 * Each line is a self-contained JSON object. This drainer distills the log to
 * the shared CodexBridgeEvent shape (the same one codex/cursor drains emit) so
 * the worker can attribute turns and harvest final replies via CodexBridgeQueue
 * WITHOUT teaching the model a `botmux send` command (zero-prompt mode):
 *
 *   - type:"USER_INPUT" (source:"USER_EXPLICIT")            → kind:'user'
 *   - type:"PLANNER_RESPONSE", non-empty string `content`
 *     and NO (non-empty) `tool_calls`                       → provisional
 *                                                             kind:'assistant_final'
 *
 * Provisional terminal — why the final is held back:
 * In ~17% of real turns the planner emits a content-only step while the turn
 * is NOT actually over — "Wait for task X to finish." while a shell tool runs
 * as a BACKGROUND task. The TUI returns to idle, then a SYSTEM_MESSAGE
 * (background-task result / stop-hook) wakes the planner and it continues with
 * new tool calls; the user-facing answer only comes later. Emitting the first
 * content-only step immediately would dequeue the turn and lose the real
 * final. The candidate therefore stays in the drainer STATE until either:
 *   - the next USER_INPUT arrives (proves the previous loop ended), or
 *   - the worker's guarded quiet-tick confirms (1s of unchanged offset AND a
 *     viewport that is both not-busy and shows the ready marker) and calls
 *     drain with flushTrailingFinal:true.
 *
 * Pending-task self-attestation — why the screen gate alone is not enough:
 * Background commands and subagents both leave the TUI at a ready composer.
 * A RUNNING GENERIC latches hasPendingTask for command waits; a GENERIC saying
 * "Created the following subagent" records its conversationId even though the
 * launch itself is DONE. Quiet flushes are refused while either wait exists.
 * Command waits end on a task-result SYSTEM_MESSAGE, an error, a foreground
 * tool call, or the next USER_INPUT (legacy agy can omit command callbacks).
 * Subagent waits survive foreground work, errors and unrelated system notices:
 * only that agent's [Message] sender, an explicit manage_subagents kill/kill_all
 * call abandoning the wait, or a new USER_INPUT removes them. Each agent is
 * tracked separately so the first of several replies cannot close the turn.
 *
 * Continuation records cancel a held candidate: a PLANNER_RESPONSE with a
 * foreground tool, GENERIC tool output, or SYSTEM_MESSAGE / ERROR_MESSAGE.
 * Task launch/poll calls preserve it. CHECKPOINT / TASK_NOTIFICATION neither
 * confirm nor cancel (they can follow a real final while the turn is done).
 *
 * Other accepted gaps:
 *   - An EMPTY content/no-tool_calls PLANNER_RESPONSE precedes a
 *     "model output must contain either output text or tool calls" ERROR and a
 *     retry step — it is NOT terminal, so empty records produce no event.
 *   - An interrupted turn emits nothing (the safe failure mode) rather than a
 *     half-answer; the screen idle/termination path still closes the card.
 *
 * USER_INPUT content is agy's own envelope: `<USER_REQUEST>\n<submitted
 * payload>\n</USER_REQUEST>\n<ADDITIONAL_METADATA>…`. The submitted payload is
 * byte-identical to history.jsonl's `display` (what botmux typed), so the
 * envelope is unwrapped here — the bridge fingerprints turns against the
 * submitted text. Every observed USER_INPUT record uses this envelope; if a
 * future agy build stops wrapping, the raw content is used unchanged.
 *
 * Pure I/O. Attribution belongs in CodexBridgeQueue.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { CodexBridgeEvent } from './codex-transcript.js';
import { beginJsonlDrain, iterateJsonlLines, scanJsonlFromOffset } from './jsonl-cursor.js';

const CONVERSATION_ID_RE = /^[A-Za-z0-9._-]+$/;
const COMPACT_TRANSCRIPT_NAME = 'transcript.jsonl';
const FULL_TRANSCRIPT_NAME = 'transcript_full.jsonl';

function defaultBrainDir(): string {
  return join(homedir(), '.gemini', 'antigravity-cli', 'brain');
}

function conversationLogPath(conversationId: string | undefined, brainDir: string, name: string): string | null {
  if (!conversationId || !CONVERSATION_ID_RE.test(conversationId)) return null;
  return join(brainDir, conversationId, '.system_generated', 'logs', name);
}

/** Absolute COMPACT transcript path (transcript.jsonl) for a conversation id,
 *  or null when the id is unsafe/empty (it is interpolated directly rather
 *  than discovered by a dir scan). Readers want
 *  {@link resolveAntigravityTranscriptPath}, which prefers the full log. */
export function antigravityTranscriptPath(
  conversationId: string | undefined,
  brainDir: string = defaultBrainDir(),
): string | null {
  return conversationLogPath(conversationId, brainDir, COMPACT_TRANSCRIPT_NAME);
}

/** Absolute FULL transcript path (transcript_full.jsonl), same id rules. */
export function antigravityFullTranscriptPath(
  conversationId: string | undefined,
  brainDir: string = defaultBrainDir(),
): string | null {
  return conversationLogPath(conversationId, brainDir, FULL_TRANSCRIPT_NAME);
}

/** The transcript a reader should use for a conversation: the full log when it
 *  is on disk, else the compact log (an agy build without the full log), else
 *  null. `mapPath` rewrites each candidate before the existence check (the
 *  dashboard's per-session scratch overlay) and the rewritten path is returned. */
export function resolveAntigravityTranscriptPath(
  conversationId: string | undefined,
  opts: { brainDir?: string; mapPath?: (path: string) => string } = {},
): string | null {
  const brainDir = opts.brainDir ?? defaultBrainDir();
  for (const candidate of [
    antigravityFullTranscriptPath(conversationId, brainDir),
    antigravityTranscriptPath(conversationId, brainDir),
  ]) {
    if (!candidate) continue;
    const path = opts.mapPath ? opts.mapPath(candidate) : candidate;
    if (existsSync(path)) return path;
  }
  return null;
}

/** transcript_full.jsonl next to a compact transcript path, or null when
 *  `path` is not a compact transcript. */
export function antigravityFullSiblingPath(path: string): string | null {
  return basename(path) === COMPACT_TRANSCRIPT_NAME ? join(dirname(path), FULL_TRANSCRIPT_NAME) : null;
}

/** transcript.jsonl next to a full transcript path, or null when `path` is not
 *  a full transcript. */
export function antigravityCompactSiblingPath(path: string): string | null {
  return basename(path) === FULL_TRANSCRIPT_NAME ? join(dirname(path), COMPACT_TRANSCRIPT_NAME) : null;
}

/** Whether two transcript paths belong to the same conversation. The compact
 *  and full logs are two views of ONE conversation, so a bind moving from one
 *  to the other is not a `/new` rotation — comparing raw paths would replay
 *  the whole conversation as a fresh one. */
export function isSameAntigravityConversation(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const logsDir = (p: string): string => {
    const name = basename(p);
    return name === COMPACT_TRANSCRIPT_NAME || name === FULL_TRANSCRIPT_NAME ? dirname(p) : p;
  };
  return logsDir(a) === logsDir(b);
}

function stepIdentity(line: string): string | undefined {
  try {
    const obj = JSON.parse(line);
    return Number.isInteger(obj?.step_index) ? `${obj.step_index}:${obj.type}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Re-express a consumed byte offset of transcript.jsonl as the equivalent
 * offset of its transcript_full.jsonl sibling, so a reader that started on the
 * compact log can continue on the full log without re-reading or skipping a
 * record. "After the N-th record" is the same point in both files (one line
 * per step, same order); only the byte lengths differ, so a compact offset can
 * never be used against the full file directly.
 *
 * Returns undefined — the caller stays on the compact log and retries later —
 * when the offset is negative/unsafe, the compact log is shorter than the
 * consumed offset at either the size probe or the byte frontier the scan
 * actually reached (a cut landing between the stat and the scan is caught by
 * the latter), or covers no record before it (it was replaced/truncated:
 * the drainer holds on that, and a mapping from it would land mid-history or
 * at byte 0 of the full log and replay those records), the full log has not
 * yet written all N records as complete lines (it trails the compact log by a
 * few ms), or the first or N-th records disagree on step_index/type (never
 * observed; refuse rather than misalign).
 */
export function mapAntigravityCompactOffsetToFull(
  compactPath: string,
  compactOffset: number,
  fullPath: string,
): number | undefined {
  if (!Number.isSafeInteger(compactOffset) || compactOffset < 0 || !existsSync(fullPath)) return undefined;
  if (compactOffset === 0) return 0;
  try {
    if (statSync(compactPath).size < compactOffset) return undefined;
  } catch {
    return undefined;
  }
  let records = 0;
  let firstLine: string | undefined;
  let lastLine: string | undefined;
  const compact = scanJsonlFromOffset(compactPath, 0, {
    endOffset: compactOffset,
    onLine: line => {
      if (!line.trim()) return;
      records++;
      firstLine ??= line;
      lastLine = line;
    },
  });
  if (!compact) return undefined;
  // The size probe above can race a cut that lands before the scan opens: the
  // stat still saw the full log while the scan only reached an earlier EOF, so
  // N would count the records of the shortened prefix and map to the N-th of
  // those, replaying the tail. Re-check the same invariant against the bytes
  // actually read; a final record consumed without its '\n' rides in
  // pendingTail, and newOffset + its byte length still equals compactOffset.
  if (compact.newOffset + Buffer.byteLength(compact.pendingTail, 'utf8') < compactOffset) return undefined;
  // The drainer also consumes a final record written without its '\n' yet once
  // it parses (newOffset = size); the scan leaves that record in pendingTail.
  if (compact.pendingTail.trim()) {
    records++;
    firstLine ??= compact.pendingTail;
    lastLine = compact.pendingTail;
  }
  if (records === 0) return undefined;
  const origin = stepIdentity(firstLine!);
  const boundary = stepIdentity(lastLine!);
  if (origin === undefined || boundary === undefined) return undefined;

  let seen = 0;
  let mapped: number | undefined;
  let aligned = true;
  scanJsonlFromOffset(fullPath, 0, {
    onLine: (line, lineStart) => {
      if (!aligned || mapped !== undefined || !line.trim()) return;
      seen++;
      if (seen === 1 && stepIdentity(line) !== origin) {
        aligned = false;
        return;
      }
      if (seen < records) return;
      if (stepIdentity(line) !== boundary) {
        aligned = false;
        return;
      }
      mapped = lineStart + Buffer.byteLength(line, 'utf8') + 1;
    },
  });
  return aligned ? mapped : undefined;
}

/** Appended to a final reply that was read from the compact log with its
 *  content cut (`truncated_fields` lists "content"): the marker alone looks
 *  like model output, and a half reply must not pass as a complete one. */
export const ANTIGRAVITY_TRUNCATED_REPLY_NOTICE =
  '⚠️ 这条回复的中间部分被 Antigravity 的会话日志截掉了（见上文 <truncated … bytes> 处），botmux 没能读到完整内容，请在终端里查看全文。';

function hasTruncatedContent(obj: any): boolean {
  return Array.isArray(obj?.truncated_fields) && obj.truncated_fields.includes('content');
}

const USER_REQUEST_OPEN = '<USER_REQUEST>';
const USER_REQUEST_CLOSE = '\n</USER_REQUEST>';

/** Strip agy's `<USER_REQUEST>` envelope (and its trailing
 *  <ADDITIONAL_METADATA> block), leaving exactly the submitted payload. Falls
 *  back to the raw content if the envelope is absent or malformed.
 *
 *  Uses the LAST close marker: the submitted payload itself can legitimately
 *  contain the literal string `</USER_REQUEST>` (a user asking about XML or
 *  prompt templates), so an indexOf on the first occurrence would truncate the
 *  prompt and break the bridge fingerprint. The newline after the open tag is
 *  skipped only when it is actually present (do not hard-code the +1). */
export function unwrapAntigravityUserInput(content: string): string {
  if (!content.startsWith(USER_REQUEST_OPEN)) return content;
  const afterOpen = USER_REQUEST_OPEN.length;
  const innerStart = content.charCodeAt(afterOpen) === 10 /* \n */ ? afterOpen + 1 : afterOpen;
  const closeAt = content.lastIndexOf(USER_REQUEST_CLOSE);
  if (closeAt < innerStart) return content;
  return content.slice(innerStart, closeAt);
}

/** A content-only PLANNER_RESPONSE held as the turn's candidate final until a
 *  later record proves continuation (it gets dropped) or the quiet-tick/next
 *  user turn confirms it (it gets emitted). */
export interface AntigravityTranscriptState {
  provisionalFinal?: CodexBridgeEvent;
  sourceTurnId?: string;
  /** Legacy command wait, separate from subagent waits: foreground work can
   *  clear this even when an agy build omitted the command callback. */
  hasPendingTask?: boolean;
  /** Tracked background command/timer task IDs whose completion notifications
   *  have not yet arrived (deduplicated). When multiple tasks run in parallel,
   *  a completion notification removes only its own ID instead of dropping the
   *  remaining waits. */
  pendingTaskIds?: string[];
  /** The RUNNING record's logical step. Only its immediate DONE successor is
   *  accepted as callback-less command-result evidence; poll results can be
   *  physically written before their lower-step tool_call. */
  pendingTaskRunningStep?: number;
  /** The command RUNNING step's immediate non-launch DONE successor landed.
   *  invoke_subagent may use this narrower callback-less recovery signal;
   *  the launch alone does not prove an independent command ended. */
  hasPendingTaskResult?: boolean;
  /** Launched subagents whose first notifications have not arrived,
   *  deduplicated by id. A notification can request guidance rather than
   *  finish the work; send_message does not re-arm this wait because it does
   *  not promise a reply. An array keeps carried worker state serializable. */
  pendingSubagentIds?: string[];
  /** Ephemeral launch hint for `IsDaemon: true` background calls in the latest
   *  tool_calls batch so standing daemons (dev servers / standing crons) are
   *  not latched as turn-blocking waits. Dropped once the turn moves on. */
  pendingDaemonHints?: { allDaemon?: boolean; descriptions?: string[] };
}

/** Every GENERIC record in observed logs with this phrase has status RUNNING;
 *  the phrase is the deterministic "the TUI is back at ready but the turn is
 *  still alive" marker. Status RUNNING alone is accepted too (it never occurs
 *  for foreground tool results in observed logs). */
const BACKGROUND_TASK_PHRASE_RE = /running as a background task/i;
const BACKGROUND_TASK_ID_RE = /(?:with\s+)?task\s+id:?\s*([A-Za-z0-9._/-]+)/i;
const LEGACY_TASK_RESULT_RE = /^[Tt]ask(?: id)?\s+"?([A-Za-z0-9._/-]+)"?\s+(?:finished|completed|was cancel(?:l)?ed|failed|timed out)\b/;
const SYSTEM_CANCEL_RE = /^(?:the\s+user\s+)?(?:cancell?ed|interrupted|aborted)\b|\b(?:user|request|turn|task)\s+(?:was\s+)?(?:cancell?ed|interrupted|aborted)\b/i;

function isBackgroundTaskRunningRecord(obj: any): boolean {
  if (obj?.type !== 'GENERIC') return false;
  return obj?.status === 'RUNNING'
    || (typeof obj?.content === 'string' && BACKGROUND_TASK_PHRASE_RE.test(obj.content));
}

function backgroundTaskId(obj: any): string | undefined {
  const content = typeof obj?.content === 'string' ? obj.content : '';
  return content.match(BACKGROUND_TASK_ID_RE)?.[1];
}

function backgroundTaskDescription(obj: any): string | undefined {
  const content = typeof obj?.content === 'string' ? obj.content : '';
  const line = content.match(/(?:^|\n)Task Description:\s*([^\r\n]+)/i)?.[1]?.trim();
  return line || undefined;
}

export interface AntigravityDrainResult {
  events: CodexBridgeEvent[];
  /** Byte offset of the last fully-parsed line + its trailing \n. The next
   *  drain should pass this back as fromOffset. */
  newOffset: number;
  /** A line written without its terminating \n yet — informational; only
   *  complete lines produce events. */
  pendingTail: string;
  /** Carried candidate terminal; pass back on the next drain. */
  state: AntigravityTranscriptState;
}

export interface AntigravityDrainOptions {
  /** Worker-only: release the held trailing candidate after the viewport
   *  quiet-tick probe confirmed the TUI is idle and on the ready marker. */
  flushTrailingFinal?: boolean;
  /** Worker-only: the whole conversation is being retired. A later explicit
   *  input abandons earlier pending work in managed mode too, rather than
   *  promoting its waiting narration to a normal final. */
  retirePendingTurns?: boolean;
  /** Bind replies to native inputs when a person can also type in the pane. */
  adoptMode?: boolean;
}

export function recordTimestampMs(rec: any): number {
  const ms = Date.parse(rec?.created_at);
  return Number.isFinite(ms) ? ms : Date.now();
}

function cloneState(state: AntigravityTranscriptState | undefined): AntigravityTranscriptState {
  const candidate = state?.provisionalFinal;
  return {
    ...(candidate ? { provisionalFinal: { ...candidate } } : {}),
    ...pendingState(state),
    ...daemonHintState(state),
    ...(state?.sourceTurnId ? { sourceTurnId: state.sourceTurnId } : {}),
  };
}

/** Shared by the worker's quiet latch and both drainer flush paths. */
export function hasAntigravityPendingTasks(state: AntigravityTranscriptState): boolean {
  return !!state.hasPendingTask || !!state.pendingTaskIds?.length || !!state.pendingSubagentIds?.length;
}

function commandState(state: AntigravityTranscriptState | undefined): AntigravityTranscriptState {
  const hasPending = !!state?.hasPendingTask || !!state?.pendingTaskIds?.length;
  return hasPending ? {
    hasPendingTask: true,
    ...(state?.pendingTaskIds?.length ? { pendingTaskIds: [...state.pendingTaskIds] } : {}),
    ...(state?.pendingTaskRunningStep !== undefined ? { pendingTaskRunningStep: state.pendingTaskRunningStep } : {}),
    ...(state?.hasPendingTaskResult ? { hasPendingTaskResult: true } : {}),
  } : {};
}

function pendingState(state: AntigravityTranscriptState | undefined): AntigravityTranscriptState {
  return {
    ...commandState(state),
    ...(state?.pendingSubagentIds?.length ? { pendingSubagentIds: [...state.pendingSubagentIds] } : {}),
  };
}

function subagentState(ids: readonly string[] | undefined): AntigravityTranscriptState {
  return ids?.length ? { pendingSubagentIds: [...ids] } : {};
}

function daemonHintState(state: AntigravityTranscriptState | undefined): AntigravityTranscriptState {
  const hints = state?.pendingDaemonHints;
  if (!hints || (!hints.allDaemon && !hints.descriptions?.length)) return {};
  return {
    pendingDaemonHints: {
      ...(hints.allDaemon ? { allDaemon: true } : {}),
      ...(hints.descriptions?.length ? { descriptions: [...hints.descriptions] } : {}),
    },
  };
}

function daemonHintsFromToolCalls(toolCalls: readonly any[]): AntigravityTranscriptState['pendingDaemonHints'] {
  let daemonCount = 0;
  let nonDaemonBgCapableCount = 0;
  const descriptions: string[] = [];
  for (const call of toolCalls) {
    const name = call?.name ?? call?.function?.name;
    if (name !== 'run_command' && name !== 'schedule') continue;
    const args = toolCallArguments(call);
    const isDaemon = decodeArgumentValue(args?.IsDaemon) === true;
    if (!isDaemon) {
      nonDaemonBgCapableCount++;
      continue;
    }
    daemonCount++;
    for (const rawField of [args?.CommandLine, args?.Prompt, args?.CronExpression]) {
      const decoded = decodeArgumentValue(rawField);
      if (typeof decoded === 'string' && decoded.trim()) {
        descriptions.push(decoded.trim());
      }
    }
  }
  if (daemonCount === 0) return undefined;
  return {
    ...(nonDaemonBgCapableCount === 0 ? { allDaemon: true } : {}),
    ...(descriptions.length > 0 ? { descriptions } : {}),
  };
}

function isDaemonBackgroundRecord(
  obj: any,
  hints: AntigravityTranscriptState['pendingDaemonHints'],
): boolean {
  if (!hints) return false;
  if (hints.allDaemon) return true;
  const desc = backgroundTaskDescription(obj);
  if (!desc || !hints.descriptions?.length) return false;
  return hints.descriptions.some(candidate =>
    candidate.startsWith(desc) || desc.startsWith(candidate));
}

function removePendingTaskId(
  state: AntigravityTranscriptState,
  completedId: string | undefined,
): AntigravityTranscriptState {
  const ids = state.pendingTaskIds;
  if (ids && ids.length > 0) {
    if (completedId && ids.includes(completedId)) {
      const remaining = ids.filter(id => id !== completedId);
      if (remaining.length > 0) {
        return {
          hasPendingTask: true,
          pendingTaskIds: remaining,
          ...(state.pendingTaskRunningStep !== undefined ? { pendingTaskRunningStep: state.pendingTaskRunningStep } : {}),
          ...(state.hasPendingTaskResult ? { hasPendingTaskResult: true } : {}),
        };
      }
      return {};
    }
    // Unmatched completion notification: when multiple tracked tasks exist, do
    // not drop all remaining tasks on an unrelated ID; when at most one task is
    // tracked (or the notification carries no ID), clear it like legacy mode.
    if (completedId && ids.length > 1) {
      return commandState(state);
    }
  }
  return {};
}

/** Match the tool's result header, not arbitrary conversationIds in output. */
function createdSubagentIds(content: string): string[] {
  // A launch has only timestamp metadata before this header. read_file and
  // run_command output can quote the same text later in their result bodies.
  const match = content.match(/^(?:(?:Created|Completed) At: [^\r\n]+\r?\n)*Created the following subagent:\s*\{\s*"conversationId"\s*:\s*"([A-Za-z0-9._-]+)"/);
  return match ? [match[1]] : [];
}

/** Only the notification header supplies provenance; a report body may quote
 *  other agents' sender= strings. */
function systemMessageHeader(content: string): string {
  return systemMessagePayload(content).match(/^\[Message\] ([^\n]*)/)?.[1] ?? '';
}

/** Strip only agy's system envelope, so legacy unheaded task results can be
 *  matched at the start of the payload rather than anywhere in a reminder. */
function systemMessagePayload(content: string): string {
  return content.match(/(?:^|\n)<SYSTEM_MESSAGE>\r?\n([\s\S]*?)(?:\r?\n<\/SYSTEM_MESSAGE>|$)/)?.[1] ?? content;
}

/** Compact transcripts JSON-encode each args field separately; full logs and
 *  function-call encodings can already carry native values. Decode one layer. */
function decodeArgumentValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function toolCallArguments(call: any): any {
  const args = call?.args ?? call?.function?.arguments;
  if (typeof args !== 'string') return args;
  try { return JSON.parse(args); } catch { return undefined; }
}

/** An explicit kill abandons the requested waits. list/send_message/ordinary
 *  tools cannot do that. Support agy's args and the function-call encoding. */
function abandonSubagentWaits(state: AntigravityTranscriptState, toolCalls: any[]): AntigravityTranscriptState {
  for (const call of toolCalls) {
    if ((call?.name ?? call?.function?.name) !== 'manage_subagents') continue;
    const args = toolCallArguments(call);
    const action = decodeArgumentValue(args?.Action);
    const conversationIds = decodeArgumentValue(args?.ConversationIds);
    if (action !== 'kill_all' && !(action === 'kill' && Array.isArray(conversationIds))) continue;
    const ids = action === 'kill_all'
      ? undefined
      : state.pendingSubagentIds?.filter(id => !(conversationIds as unknown[]).includes(id));
    // Cancel the old "waiting" narration as well: otherwise kill_all could
    // immediately flush that stale candidate before the kill's result lands.
    const { provisionalFinal: _final, pendingSubagentIds: _ids, ...rest } = state;
    state = { ...rest, ...subagentState(ids) };
  }
  return state;
}

/** An explicit `manage_task(Action="kill", TaskId=...)` abandons that
 *  background task wait without clearing unrelated tasks or subagents. */
function abandonCommandWaits(state: AntigravityTranscriptState, toolCalls: any[]): AntigravityTranscriptState {
  for (const call of toolCalls) {
    if ((call?.name ?? call?.function?.name) !== 'manage_task') continue;
    const args = toolCallArguments(call);
    const action = decodeArgumentValue(args?.Action);
    const taskId = decodeArgumentValue(args?.TaskId);
    if (action !== 'kill' || typeof taskId !== 'string' || !taskId.trim()) continue;
    const nextCmd = removePendingTaskId(state, taskId.trim());
    const {
      provisionalFinal: _final,
      hasPendingTask: _pending,
      pendingTaskIds: _taskIds,
      pendingTaskRunningStep: _step,
      hasPendingTaskResult: _res,
      ...rest
    } = state;
    state = { ...rest, ...nextCmd };
  }
  return state;
}

/** Tool calls that are part of the background-task mechanism itself —
 *  launching a task (`manage_task`) or polling/scheduling (`schedule`).
 *  Observed logs call BOTH of these synchronously too (their GENERIC result is
 *  DONE while polling status), so a name never SETS the pending flag by itself
 *  (only a GENERIC RUNNING does). Their role here is narrower: once a
 *  GENERIC RUNNING has latched hasPendingTask, an intervening call to one of
 *  these tools must NOT clear it — the wait it is part of is still in flight.
 *  Empirically the RUNNING record and these calls are written out of
 *  step_index order, so clearing on every PLANNER tool_call dropped the flag
 *  for the majority of real build/review waits (63%). manage_subagents also
 *  preserves both waits: managing agents says nothing about a command.
 *  invoke_subagent is deliberately NOT in this set. It is substantive new
 *  work, so the ordinary foreground branch clears the legacy command wait
 *  and old candidate while retaining every outstanding subagent id. */
const TASK_POLL_TOOL_NAMES = new Set(['manage_task', 'schedule', 'manage_subagents']);

function isTaskPollToolCall(toolCall: any): boolean {
  const name = toolCall?.name ?? toolCall?.function?.name;
  return typeof name === 'string' && TASK_POLL_TOOL_NAMES.has(name);
}

function isSubagentLaunchToolCall(toolCall: any): boolean {
  return (toolCall?.name ?? toolCall?.function?.name) === 'invoke_subagent';
}

/** Fold one parsed record into the drain: push confirmed events, hold/cancel
 *  the provisional terminal, track outstanding background tasks. Returns the
 *  updated state. */
function foldRecord(
  path: string,
  lineStart: number,
  obj: any,
  timestampMs: number,
  events: CodexBridgeEvent[],
  state: AntigravityTranscriptState,
  adoptMode: boolean,
  retirePendingTurns: boolean,
): AntigravityTranscriptState {
  const type = obj?.type;
  const turn = state.sourceTurnId ? { sourceTurnId: state.sourceTurnId } : {};
  if (type === 'USER_INPUT') {
    // Only agy's own explicit submits start bridge turns. Any other source is
    // ignored entirely (and neither confirms nor cancels a candidate).
    if (obj.source !== undefined && obj.source !== 'USER_EXPLICIT') return state;
    // A new explicit user turn normally confirms the previous loop. During
    // conversation retirement, pending work is abandoned in managed mode too:
    // its waiting narration must not become the old turn's normal answer.
    const uuid = `${path}:${lineStart}`;
    const pending = hasAntigravityPendingTasks(state);
    const abandonPending = retirePendingTurns && pending;
    if (state.provisionalFinal && !((adoptMode || retirePendingTurns) && pending)) {
      events.push(state.provisionalFinal);
    } else if (state.sourceTurnId || abandonPending) {
      // Managed states have no native id; the queue's current collecting owner
      // receives this abort. Adopt states route by their exact sourceTurnId.
      events.push({ uuid: `${uuid}:abort`, timestampMs, kind: 'turn_aborted', text: '', ...turn });
    }
    const raw = typeof obj.content === 'string' ? obj.content : '';
    const text = unwrapAntigravityUserInput(raw);
    if (text) {
      const next = adoptMode ? { sourceTurnId: uuid } : {};
      events.push({ uuid, timestampMs, kind: 'user', text, ...next,
        ...(adoptMode ? { inputTextAliases: [] } : {}),
      });
      return next;
    }
    return {};
  }

  if (type === 'PLANNER_RESPONSE') {
    if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
      // Provenance decides whether the wait is over:
      //  - EVERY call is a task launch/poll tool → the background-wait
      //    mechanism is still operating; this neither confirms nor cancels.
      //    Keep BOTH a held candidate and the pending flag intact (the RUNNING
      //    record and these calls are observed out of step order).
      //  - ANY call is an ordinary FOREGROUND tool (run_command/read/edit/…)
      //    → drop the candidate and clear the legacy command wait, retaining
      //    all outstanding subagent ids. This lets a turn with a command task
      //    that wrapped up on its own (NO completion SYSTEM_MESSAGE, e.g.
      //    session 098f4ab3's 491-char release summary) still emit its real
      //    final instead of latching forever.
      state = abandonSubagentWaits(state, obj.tool_calls);
      state = abandonCommandWaits(state, obj.tool_calls);
      const daemonHints = daemonHintsFromToolCalls(obj.tool_calls);
      if (obj.tool_calls.every(isTaskPollToolCall)) {
        const { pendingDaemonHints: _staleDaemon, ...rest } = state;
        return daemonHints ? { ...rest, pendingDaemonHints: daemonHints } : rest;
      }
      const hasOrdinaryForeground = obj.tool_calls.some((call: any) =>
        !isTaskPollToolCall(call) && !isSubagentLaunchToolCall(call));
      // Ordinary foreground work retains the legacy recovery heuristic. A
      // subagent launch is narrower: it recovers a missing callback only after
      // a command-result DONE, never while the command is still merely RUNNING.
      const launchRecovery = state.hasPendingTaskResult
        && obj.tool_calls.some(isSubagentLaunchToolCall);
      return {
        ...turn,
        ...(!hasOrdinaryForeground && !launchRecovery ? commandState(state) : {}),
        ...subagentState(state.pendingSubagentIds),
        ...(daemonHints ? { pendingDaemonHints: daemonHints } : {}),
      };
    }
    const text = typeof obj.content === 'string' ? obj.content : '';
    if (!text.trim() || (adoptMode && !state.sourceTurnId)) {
      // Empty content-only step: the "model output must contain either output
      // text or tool calls" ERROR precursor. Never a final; do not disturb a
      // held candidate or the pending flag.
      return state;
    }
    // Content-only step: newest candidate wins (a later content-only step
    // replaces an earlier held one). The pending-task flag rides along — the
    // quiet flush checks it and refuses while a task is outstanding.
    const finalText = hasTruncatedContent(obj) ? `${text}\n\n${ANTIGRAVITY_TRUNCATED_REPLY_NOTICE}` : text;
    const model = adoptMode && typeof obj.model === 'string' ? obj.model.trim() : '';
    return {
      ...turn,
      provisionalFinal: {
        uuid: `${path}:${lineStart}`, timestampMs, kind: 'assistant_final', text: finalText, ...turn,
        ...(model && !model.endsWith('-worker-agy') ? { replyModel: model } : {}),
      },
      ...pendingState(state),
    };
  }

  // A background task that just went RUNNING proves the turn is waiting: latch
  // the flag. A later GENERIC DONE is only the tool result landing — the
  // outstanding-task state must survive it; the completion SYSTEM_MESSAGE is
  // the actual wake-up that clears it.
  if (isBackgroundTaskRunningRecord(obj)) {
    if (isDaemonBackgroundRecord(obj, state.pendingDaemonHints)) {
      // Standing daemon processes (`IsDaemon: true`, e.g. dev servers or
      // recurring crons meant to outlive the turn) must not block turn idle.
      return { ...turn, ...pendingState(state), ...daemonHintState(state) };
    }
    const { hasPendingTaskResult: _staleResult, pendingTaskRunningStep: _staleStep, ...rest } = state;
    const runningStep = typeof obj.step_index === 'number' && Number.isInteger(obj.step_index)
      ? obj.step_index
      : undefined;
    const taskId = backgroundTaskId(obj);
    const nextTaskIds = taskId
      ? [...new Set([...(state.pendingTaskIds ?? []), taskId])]
      : state.pendingTaskIds;
    return {
      ...rest,
      hasPendingTask: true,
      ...(nextTaskIds?.length ? { pendingTaskIds: nextTaskIds } : {}),
      ...(runningStep !== undefined ? { pendingTaskRunningStep: runningStep } : {}),
    };
  }
  if (type === 'GENERIC') {
    // Foreground tool output after a content-only step cancels the candidate;
    // a possibly-outstanding background task stays recorded. A DONE result can
    // later support invoke_subagent's callback-less recovery, but a subagent
    // creation result is not evidence about the independent command.
    const content = typeof obj.content === 'string' ? obj.content : '';
    const ids = obj.status === 'DONE' ? createdSubagentIds(content) : [];
    // Real background RUNNING/result pairs are consecutive logical steps even
    // when lower-step planner records physically land between them. Poll DONE
    // or ERROR records have no such relationship, including reversed writes.
    const commandResult = state.hasPendingTask
      && obj.status === 'DONE'
      && ids.length === 0
      && state.pendingTaskRunningStep !== undefined
      && obj.step_index === state.pendingTaskRunningStep + 1;
    return {
      ...turn,
      ...pendingState(commandResult ? { ...state, hasPendingTaskResult: true } : state),
      ...subagentState([...new Set([...(state.pendingSubagentIds ?? []), ...ids])]),
      ...daemonHintState(state),
    };
  }

  if (type === 'SYSTEM_MESSAGE') {
    const content = typeof obj.content === 'string' ? obj.content : '';
    const header = systemMessageHeader(content);
    const sender = header.match(/(?:^|\s)sender=([A-Za-z0-9._/-]+)(?:\s|$)/)?.[1];
    // Sender provenance is sufficient for command/timer wakeups: schedule
    // delivers arbitrary user-defined prompts, not a fixed completion phrase.
    const taskSender = sender !== undefined && /\/task-[A-Za-z0-9._-]+$/.test(sender);
    const payload = header
      ? (header.match(/(?:^|\s)content=(.*)/)?.[1] ?? header)
      : systemMessagePayload(content);
    // Older builds omit sender and sometimes [Message] itself. Match only a
    // task result at the payload's start, never a quoted result in a reminder
    // or a subagent's report body.
    const legacyMatch = !sender ? payload.match(LEGACY_TASK_RESULT_RE) : null;
    const legacyTaskResult = !!legacyMatch;
    const legacyTaskId = legacyMatch?.[1];
    // Pure system notices do not wake the planner with a result and may land
    // after its real final. Preserve both pending work and the held candidate,
    // except explicit user cancellation notices which terminate pending waits.
    if (!header && !legacyTaskResult) {
      const trimmedPayload = payload.trim();
      if (!/^Reminder:/i.test(trimmedPayload) && SYSTEM_CANCEL_RE.test(trimmedPayload)) {
        return { ...turn };
      }
      return state;
    }
    const ids = state.pendingSubagentIds?.filter(id => id !== sender);
    return {
      ...turn,
      ...(taskSender || legacyTaskResult
        ? removePendingTaskId(state, taskSender ? sender : legacyTaskId)
        : commandState(state)),
      ...subagentState(ids),
    };
  }
  if (type === 'ERROR_MESSAGE' || type === 'ERROR') {
    return { ...turn, ...subagentState(state.pendingSubagentIds) };
  }

  // CHECKPOINT / TASK_NOTIFICATION / unknown types neither confirm nor cancel;
  // in particular they do NOT clear hasPendingTask.
  return state;
}

/**
 * Increment-read the transcript from `fromOffset`. Mirrors the byte-offset
 * contract of drainCursorTranscript / drainOmpTranscript so the worker reuses
 * the same fs.watch / poll wakeup machinery and the shared CodexBridgeQueue.
 * `path` is whichever log the caller bound (full or compact) and `fromOffset`
 * is a byte offset in THAT file — moving between the two goes through
 * mapAntigravityCompactOffsetToFull.
 *
 * The log is append-only for the life of a conversation; a size that shrank
 * past `fromOffset` (rotation/replace race) is ignored rather than replayed
 * from zero — wait for it to grow past the consumed byte, exactly like the
 * cursor drainer.
 */
export function drainAntigravityTranscript(
  path: string,
  fromOffset: number,
  incomingState: AntigravityTranscriptState = {},
  options: AntigravityDrainOptions = {},
): AntigravityDrainResult {
  const step = beginJsonlDrain(path, fromOffset, { onShrink: 'hold', missingOffset: 'keep' });
  if (step.kind === 'skip') {
    return { events: [], newOffset: step.newOffset, pendingTail: '', state: cloneState(incomingState) };
  }
  if (step.kind === 'idle') {
    // Nothing new on disk, but the caller may be releasing a held candidate.
    // Refuse while a background task is still outstanding: its completion
    // result notification has not arrived, so a quiet
    // screen cannot prove the turn is done.
    if (options.flushTrailingFinal && incomingState.provisionalFinal && !hasAntigravityPendingTasks(incomingState)) {
      const events = [incomingState.provisionalFinal];
      return { events, newOffset: fromOffset, pendingTail: '', state: pendingState(incomingState) };
    }
    return { events: [], newOffset: fromOffset, pendingTail: '', state: cloneState(incomingState) };
  }

  const { size, completeText } = step.window;
  let pendingTail = step.window.pendingTail;
  let newOffset = step.window.newOffset;

  const events: CodexBridgeEvent[] = [];
  let state = cloneState(incomingState);
  for (const { line, lineStart } of iterateJsonlLines(completeText, fromOffset)) {
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    state = foldRecord(path, lineStart, obj, recordTimestampMs(obj), events, state, options.adoptMode === true, options.retirePendingTurns === true);
  }

  // The final object may sit at EOF without a trailing \n until the next turn.
  // Fold it only once it parses completely; otherwise keep it pending.
  if (pendingTail.length > 0) {
    try {
      const obj = JSON.parse(pendingTail);
      state = foldRecord(path, newOffset, obj, recordTimestampMs(obj), events, state, options.adoptMode === true, options.retirePendingTurns === true);
      newOffset = size;
      pendingTail = '';
    } catch {
      // Still being written.
    }
  }

  // Release the candidate only when the flush is requested AND no background
  // command or subagent is outstanding. The candidate rides another tick
  // until the corresponding result / next user turn clears the wait.
  if (options.flushTrailingFinal && state.provisionalFinal && !hasAntigravityPendingTasks(state)) {
    events.push(state.provisionalFinal);
    state.provisionalFinal = undefined;
    delete state.sourceTurnId;
  }
  return { events, newOffset, pendingTail, state };
}

/** Read a completed native side turn by its receipt's conversation ID. Refuse
 * unrelated transcripts, including another side question typed in the TUI. */
export function readAntigravitySideAnswer(conversationId: string, question: string, brainDir?: string): string | undefined {
  const path = resolveAntigravityTranscriptPath(conversationId, { brainDir });
  if (!path) return;
  const { events } = drainAntigravityTranscript(path, 0, {}, { flushTrailingFinal: true });
  const input = events.filter(event => event.kind === 'user');
  if (input.length !== 1 || input[0]!.text.trim() !== question) return;
  return events.reverse().find(event => event.kind === 'assistant_final')?.text.trim() || undefined;
}

const PENDING_SCAN_INITIAL_CHUNK = 64 * 1024;
const PENDING_SCAN_FULL_MAX_CHUNK = 1024 * 1024;
const PENDING_SCAN_COMPACT_MAX_CHUNK = 4 * 1024 * 1024;

function isExplicitUserInput(rec: any): boolean {
  return rec?.type === 'USER_INPUT' && (rec.source === undefined || rec.source === 'USER_EXPLICIT');
}

function scanTranscriptTailForPendingTasks(
  transcriptPath: string,
  maxChunkBytes: number,
): { bounded: boolean; pending: boolean } {
  if (!existsSync(transcriptPath)) return { bounded: true, pending: false };
  try {
    const fd = openSync(transcriptPath, 'r');
    try {
      const stats = fstatSync(fd);
      if (stats.size === 0) return { bounded: true, pending: false };

      let chunkSize = Math.min(stats.size, PENDING_SCAN_INITIAL_CHUNK);
      let lastParsed: any[] = [];
      while (chunkSize <= stats.size) {
        const buf = Buffer.alloc(chunkSize);
        readSync(fd, buf, 0, chunkSize, stats.size - chunkSize);
        const text = buf.toString('utf-8');
        const rawLines = text.split('\n');
        const candidateLines = stats.size > chunkSize ? rawLines.slice(1) : rawLines;
        const parsed: any[] = [];
        for (const raw of candidateLines) {
          const line = raw.trim();
          if (!line) continue;
          try { parsed.push(JSON.parse(line)); } catch { /* ignore partial/corrupt lines */ }
        }
        lastParsed = parsed;

        let turnStart = -1;
        for (let i = parsed.length - 1; i >= 0; i--) {
          if (isExplicitUserInput(parsed[i])) {
            turnStart = i;
            break;
          }
        }
        if (turnStart >= 0 || chunkSize >= stats.size) {
          let state: AntigravityTranscriptState = {};
          const events: CodexBridgeEvent[] = [];
          const start = turnStart >= 0 ? turnStart : 0;
          for (let i = start; i < parsed.length; i++) {
            state = foldRecord(transcriptPath, i, parsed[i], 0, events, state, false, false);
          }
          return { bounded: true, pending: hasAntigravityPendingTasks(state) };
        }
        if (chunkSize >= maxChunkBytes) break;
        chunkSize = Math.min(stats.size, Math.min(chunkSize * 4, maxChunkBytes));
      }

      let state: AntigravityTranscriptState = {};
      const events: CodexBridgeEvent[] = [];
      for (let i = 0; i < lastParsed.length; i++) {
        state = foldRecord(transcriptPath, i, lastParsed[i], 0, events, state, false, false);
      }
      return { bounded: false, pending: hasAntigravityPendingTasks(state) };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { bounded: true, pending: false };
  }
}

/**
 * Inspect the latest explicit user turn in an Antigravity transcript on disk
 * and report whether any non-daemon background command task or subagent is
 * still pending.
 *
 * Used by the worker's prompt-ready authority guard when the structured
 * transcript bridge is not active (ordinary `replyDelivery: 'send'` mode) or
 * has not yet attached, reusing the exact same `foldRecord` state machine as
 * `drainAntigravityTranscript`.
 */
export function hasAntigravityTranscriptPendingTasks(transcriptPath: string): boolean {
  if (!transcriptPath || !existsSync(transcriptPath)) return false;
  const fullLimit = antigravityCompactSiblingPath(transcriptPath)
    ? PENDING_SCAN_FULL_MAX_CHUNK
    : PENDING_SCAN_COMPACT_MAX_CHUNK;
  const primary = scanTranscriptTailForPendingTasks(transcriptPath, fullLimit);
  if (primary.bounded) return primary.pending;
  const compactSibling = antigravityCompactSiblingPath(transcriptPath);
  if (compactSibling && existsSync(compactSibling)) {
    return scanTranscriptTailForPendingTasks(compactSibling, PENDING_SCAN_COMPACT_MAX_CHUNK).pending;
  }
  return primary.pending;
}
