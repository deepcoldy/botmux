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
import { createHash } from 'node:crypto';
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

/** Durable no-progress proof for unattended replay of an agy quota failure.
 * The exact submitted USER_INPUT must be the last native turn, followed only by
 * non-output bookkeeping. Any assistant, tool, error, system or later-user
 * record fails closed. The quota refusal itself is not recorded by agy. */
function antigravitySingleTranscriptTurnFailedWithoutOutput(path: string, writtenInput: string): boolean {
  let fd: number;
  let offset: number;
  let size: number;
  try {
    const stat = statSync(path);
    size = stat.size;
    offset = Math.max(0, size - 256 * 1024);
    fd = openSync(path, 'r');
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(Math.max(0, size - offset));
    const count = readSync(fd, buf, 0, buf.length, offset);
    const lines = buf.subarray(0, count).toString('utf8').split('\n');
    if (offset > 0) lines.shift();
    const pendingTail = lines.pop() ?? '';
    const normalizedWrittenInput = writtenInput.replace(/\r\n?/g, '\n');
    let matched = false;
    let hasOutputAfter = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { if (matched) hasOutputAfter = true; continue; }
      if (rec?.type === 'USER_INPUT') {
        // Multi-hop replay and repeated user prompts can append the exact same
        // text more than once. Only the LAST native input owns the current turn.
        matched = rec.source === 'USER_EXPLICIT' && typeof rec.content === 'string'
          && unwrapAntigravityUserInput(rec.content).replace(/\r\n?/g, '\n') === normalizedWrittenInput;
        hasOutputAfter = false;
        continue;
      }
      if (!matched || rec?.type === 'CHECKPOINT' || rec?.type === 'TASK_NOTIFICATION') continue;
      hasOutputAfter = true;
    }
    return matched && !hasOutputAfter && !pendingTail.trim();
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/** Durable no-progress proof across both sibling views of one agy conversation.
 * A full log never authorizes replay alone: agy writes compact first, so full
 * without a readable compact sibling is not a complete proof. Native compact
 * paths have no compact-only authorization: every supported agy build writes
 * both views, so a missing sibling means unknown evidence and fails closed.
 * Any output, corruption or partial tail in either present sibling fails closed. */
export function antigravityTurnFailedWithoutOutput(
  path: string | undefined,
  writtenInput: string | undefined,
  proofDeps: { existsSync?: (path: string) => boolean } = {},
): boolean {
  if (!path || !writtenInput) return false;
  const exists = proofDeps.existsSync ?? existsSync;
  const isFull = basename(path) === FULL_TRANSCRIPT_NAME;
  const isCompact = basename(path) === COMPACT_TRANSCRIPT_NAME;
  if (!isFull && !isCompact) return antigravitySingleTranscriptTurnFailedWithoutOutput(path, writtenInput);
  const sibling = isFull ? antigravityCompactSiblingPath(path) : antigravityFullSiblingPath(path);
  if (!sibling) return false;
  // An old agy build may only have compact. Once full exists, both views must
  // independently retain the exact no-progress proof; full has no single-log
  // fallback even if compact disappears between inspection and reading.
  if (!exists(sibling)) return false;
  return antigravitySingleTranscriptTurnFailedWithoutOutput(path, writtenInput)
    && antigravitySingleTranscriptTurnFailedWithoutOutput(sibling, writtenInput);
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
  /** A background RUNNING record without a task ID is a separate anonymous
   *  wait. Removing the last known sibling ID must not clear it. */
  hasPendingAnonymousTask?: boolean;
  /** The RUNNING record's logical step. Only its immediate DONE successor is
   *  accepted as callback-less command-result evidence; poll results can be
   *  physically written before their lower-step tool_call. */
  pendingTaskRunningStep?: number;
  /** Task ID that owns pendingTaskRunningStep and any adjacent DONE evidence.
   *  Recovery of one known command must not clear its running siblings. */
  pendingTaskRunningTaskId?: string;
  /** The command RUNNING step's immediate non-launch DONE successor landed.
   *  invoke_subagent may use this narrower callback-less recovery signal;
   *  the launch alone does not prove an independent command ended. */
  hasPendingTaskResult?: boolean;
  /** Known task IDs with their own adjacent DONE evidence. Unlike the legacy
   *  singleton fields, this survives interleaved RUNNING records. */
  pendingTaskResultIds?: string[];
  /** Launched subagents whose first notifications have not arrived,
   *  deduplicated by id. A notification can request guidance rather than
   *  finish the work; send_message does not re-arm this wait because it does
   *  not promise a reply. An array keeps carried worker state serializable. */
  pendingSubagentIds?: string[];
  /** Daemon task IDs intentionally excluded from turn-blocking waits. Their
   *  completion/scheduled notifications must not settle an anonymous command. */
  ignoredDaemonTaskIds?: string[];
  /** Ephemeral launch hints for `IsDaemon: true` background calls in the latest
   *  tool_calls batch so standing daemons (dev servers / standing crons) are
   *  not latched as turn-blocking waits. Mixed batches retain ordinary
   *  descriptions and logical-step hints: only positive launch correlation may
   *  exclude a RUNNING record; unresolved description collisions stay pending. */
  pendingDaemonHints?: {
    allDaemon?: boolean;
    descriptions?: string[];
    nonDaemonDescriptions?: string[];
    /** GENERIC's logical step is the planner step plus the tool call's
     *  one-based ordinal. A matching step + description can disambiguate a
     *  mixed batch even when another candidate shares the description. */
    stepHints?: { stepIndex: number; isDaemon: boolean; descriptions: string[] }[];
  };
}

/** Every GENERIC record in observed logs with this phrase has status RUNNING;
 *  the phrase is the deterministic "the TUI is back at ready but the turn is
 *  still alive" marker. Status RUNNING alone is accepted too (it never occurs
 *  for foreground tool results in observed logs). */
const BACKGROUND_TASK_PHRASE_RE = /running as a background task/i;
const BACKGROUND_TASK_ID_RE = /(?:with\s+)?task\s+id:?\s*([A-Za-z0-9._/-]+)/i;
const LEGACY_TASK_RESULT_RE = /^[Tt]ask(?:\s+id)?\s*:?[ \t]*"?([A-Za-z0-9._/-]+)"?[ \t]+(?:finished|completed|was cancel(?:l)?ed|failed|timed out)\b/;
// Unheaded cancellation is necessarily a coarse recovery signal. Restrict the
// clear-all reset to an explicit user/request/turn cancellation (or a terse
// leading "canceled/interrupted/aborted"); a notice about one background task
// must not erase unrelated command/subagent waits that are still outstanding.
const SYSTEM_CANCEL_RE = /^(?:(?:the\s+)?user\s+)?(?:cancell?ed|interrupted|aborted)\b|^(?:the\s+)?(?:(?:user\s+)?request|turn)\s+(?:was\s+)?(?:cancell?ed|interrupted|aborted)\b/i;
const SYSTEM_SINGLE_TASK_CANCEL_RE = /^(?:the\s+)?(?:background\s+)?task\s+(?:was\s+)?(?:cancell?ed|interrupted|aborted)\b/i;

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
  const resultIds = state?.pendingTaskResultIds?.filter(id => state.pendingTaskIds?.includes(id));
  return hasPending ? {
    hasPendingTask: true,
    ...(state?.pendingTaskIds?.length ? { pendingTaskIds: [...state.pendingTaskIds] } : {}),
    ...(state?.hasPendingAnonymousTask ? { hasPendingAnonymousTask: true } : {}),
    ...(state?.pendingTaskRunningStep !== undefined ? { pendingTaskRunningStep: state.pendingTaskRunningStep } : {}),
    ...(state?.pendingTaskRunningTaskId ? { pendingTaskRunningTaskId: state.pendingTaskRunningTaskId } : {}),
    ...(state?.hasPendingTaskResult ? { hasPendingTaskResult: true } : {}),
    ...(resultIds?.length ? { pendingTaskResultIds: [...resultIds] } : {}),
  } : {};
}

function pendingState(state: AntigravityTranscriptState | undefined): AntigravityTranscriptState {
  return {
    ...commandState(state),
    ...(state?.pendingSubagentIds?.length ? { pendingSubagentIds: [...state.pendingSubagentIds] } : {}),
    ...ignoredDaemonTaskState(state),
  };
}

function ignoredDaemonTaskState(state: AntigravityTranscriptState | undefined): AntigravityTranscriptState {
  return state?.ignoredDaemonTaskIds?.length
    ? { ignoredDaemonTaskIds: [...state.ignoredDaemonTaskIds] }
    : {};
}

function commandWaitCount(state: AntigravityTranscriptState | undefined): number {
  const identifiedAndAnonymous = (state?.pendingTaskIds?.length ?? 0) + (state?.hasPendingAnonymousTask ? 1 : 0);
  return identifiedAndAnonymous || (state?.hasPendingTask ? 1 : 0);
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
      ...(hints.nonDaemonDescriptions?.length ? { nonDaemonDescriptions: [...hints.nonDaemonDescriptions] } : {}),
      ...(hints.stepHints?.length ? {
        stepHints: hints.stepHints.map(hint => ({ ...hint, descriptions: [...hint.descriptions] })),
      } : {}),
    },
  };
}

function daemonHintsFromToolCalls(
  toolCalls: readonly any[],
  plannerStepIndex?: number,
): AntigravityTranscriptState['pendingDaemonHints'] {
  let daemonCount = 0;
  let nonDaemonBgCapableCount = 0;
  const descriptions: string[] = [];
  const nonDaemonDescriptions: string[] = [];
  const stepHints: { stepIndex: number; isDaemon: boolean; descriptions: string[] }[] = [];
  for (const [callIndex, call] of toolCalls.entries()) {
    const name = call?.name ?? call?.function?.name;
    if (name !== 'run_command' && name !== 'schedule') continue;
    const args = toolCallArguments(call);
    const isDaemon = decodeArgumentValue(args?.IsDaemon) === true;
    if (isDaemon) daemonCount++;
    else nonDaemonBgCapableCount++;

    const callDescriptions: string[] = [];
    for (const rawField of [args?.CommandLine, args?.Prompt, args?.CronExpression]) {
      const decoded = decodeArgumentValue(rawField);
      if (typeof decoded === 'string' && decoded.trim()) callDescriptions.push(decoded.trim());
    }
    const cronExpression = decodeArgumentValue(args?.CronExpression);
    if (typeof cronExpression === 'string' && cronExpression.trim()) {
      // RUNNING records wrap schedule expressions as `Cron: <expression>`;
      // retain the raw form too for builds that omit the wrapper.
      callDescriptions.push(`Cron: ${cronExpression.trim()}`);
    }
    (isDaemon ? descriptions : nonDaemonDescriptions).push(...callDescriptions);
    if (typeof plannerStepIndex === 'number' && Number.isInteger(plannerStepIndex)) {
      stepHints.push({
        stepIndex: plannerStepIndex + callIndex + 1,
        isDaemon,
        descriptions: callDescriptions,
      });
    }
  }
  if (daemonCount === 0) return undefined;
  return {
    ...(nonDaemonBgCapableCount === 0 ? { allDaemon: true } : {}),
    ...(descriptions.length > 0 ? { descriptions } : {}),
    ...(nonDaemonDescriptions.length > 0 ? { nonDaemonDescriptions } : {}),
    ...(stepHints.length > 0 ? { stepHints } : {}),
  };
}

function isDaemonBackgroundRecord(
  obj: any,
  hints: AntigravityTranscriptState['pendingDaemonHints'],
): boolean {
  if (!hints) return false;
  if (hints.allDaemon) {
    // The latest batch being all-daemon says nothing about older/out-of-order
    // records. Exact logical-step correlation alone is sufficient for its own
    // launches, even when a compact RUNNING omits Task Description.
    return hints.stepHints?.some(hint => hint.isDaemon && hint.stepIndex === obj.step_index) === true;
  }
  const desc = backgroundTaskDescription(obj);
  if (!desc) return false;
  const matches = (candidate: string) => candidate.startsWith(desc) || desc.startsWith(candidate);
  const stepHint = hints.stepHints?.find(hint =>
    hint.stepIndex === obj.step_index && hint.descriptions.some(matches));
  if (stepHint) return stepHint.isDaemon;
  if (!hints.descriptions?.length) return false;
  if (!hints.descriptions.some(matches)) return false;
  // A compact log may truncate either side of a description. If the same
  // observation also matches an ordinary launch, its daemon provenance is
  // ambiguous: keep the turn-blocking wait rather than releasing authority
  // while an ordinary background command is still running.
  return !hints.nonDaemonDescriptions?.some(matches);
}

function removePendingTaskId(
  state: AntigravityTranscriptState,
  completedId: string | undefined,
): AntigravityTranscriptState {
  const ids = state.pendingTaskIds;
  if (ids && ids.length > 0) {
    // Once concrete IDs are tracked, an absent or unrelated ID proves nothing
    // about those waits. This applies to completion notifications and explicit
    // manage_task kills alike, including a sole tracked task.
    if (!completedId || !ids.includes(completedId)) return commandState(state);
    const remaining = ids.filter(id => id !== completedId);
    if (remaining.length > 0) {
      const remainingResultIds = state.pendingTaskResultIds?.filter(id => remaining.includes(id));
      // RUNNING-step/result evidence belongs to the command that produced it.
      // The legacy fields do not record that owner, so never transfer them to
      // a surviving sibling after another task completes.
      return {
        hasPendingTask: true,
        pendingTaskIds: remaining,
        ...(state.hasPendingAnonymousTask ? { hasPendingAnonymousTask: true } : {}),
        ...(remainingResultIds?.length ? { pendingTaskResultIds: remainingResultIds } : {}),
      };
    }
    return state.hasPendingAnonymousTask
      ? { hasPendingTask: true, hasPendingAnonymousTask: true }
      : {};
  }
  // Legacy RUNNING records without an ID retain their historical clear-all
  // completion behavior; there is no concrete wait identity to preserve.
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
    // A concrete kill ID cannot be correlated to an anonymous legacy wait.
    // Completion notifications retain their legacy recovery semantics, but an
    // explicit kill for another/unknown task must not erase that wait.
    if (!state.pendingTaskIds?.length && state.hasPendingTask) continue;
    const nextCmd = removePendingTaskId(state, taskId.trim());
    const {
      provisionalFinal: _final,
      hasPendingTask: _pending,
      pendingTaskIds: _taskIds,
      hasPendingAnonymousTask: _anonymous,
      pendingTaskRunningStep: _step,
      pendingTaskRunningTaskId: _taskId,
      hasPendingTaskResult: _res,
      pendingTaskResultIds: _resultIds,
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
    // Turn-scoped waits reset at an explicit input, but daemon identity must
    // survive so a late notification from an older turn cannot settle a new
    // anonymous ordinary wait.
    const carriedDaemonIds = ignoredDaemonTaskState(state);
    if (text) {
      const next = adoptMode ? { sourceTurnId: uuid } : {};
      events.push({ uuid, timestampMs, kind: 'user', text, ...next,
        ...(adoptMode ? { inputTextAliases: [] } : {}),
      });
      return { ...next, ...carriedDaemonIds };
    }
    return carriedDaemonIds;
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
      const daemonHints = daemonHintsFromToolCalls(obj.tool_calls, obj.step_index);
      if (obj.tool_calls.every(isTaskPollToolCall)) {
        const { pendingDaemonHints: _staleDaemon, ...rest } = state;
        return daemonHints ? { ...rest, pendingDaemonHints: daemonHints } : rest;
      }
      const hasOrdinaryForeground = obj.tool_calls.some((call: any) =>
        !isTaskPollToolCall(call) && !isSubagentLaunchToolCall(call));
      // A physically late launch has its RUNNING logical step inside this
      // planner batch's immediate tool-result range. It is provenance for that
      // wait, not foreground recovery; genuinely separate foreground work
      // (including older step numbers from observed real logs) may still clear.
      const runningBelongsToPlannerBatch = state.pendingTaskRunningStep !== undefined
        && typeof obj.step_index === 'number'
        && Number.isInteger(obj.step_index)
        && obj.step_index < state.pendingTaskRunningStep
        && state.pendingTaskRunningStep <= obj.step_index + obj.tool_calls.length;
      const foregroundRecovery = hasOrdinaryForeground && !runningBelongsToPlannerBatch;
      // Ordinary foreground work retains the legacy recovery heuristic. A
      // subagent launch is narrower: it recovers a missing callback only after
      // a command-result DONE, never while the command is still merely RUNNING.
      const launchRecovery = (state.hasPendingTaskResult || !!state.pendingTaskResultIds?.length)
        && obj.tool_calls.some(isSubagentLaunchToolCall);
      const provenResultIds = [...new Set([
        ...(state.pendingTaskResultIds ?? []),
        ...(state.hasPendingTaskResult && state.pendingTaskRunningTaskId ? [state.pendingTaskRunningTaskId] : []),
      ])];
      let recoveredCommand = commandState(state);
      if (foregroundRecovery || launchRecovery) {
        if (state.pendingTaskIds?.length) {
          // Each known command needs its own adjacent DONE. Recover every
          // proven ID while retaining any sibling still lacking that evidence.
          for (const taskId of provenResultIds) {
            recoveredCommand = removePendingTaskId(recoveredCommand, taskId);
          }
        } else if (commandWaitCount(state) <= 1) {
          // Only the anonymous legacy wait retains the old foreground recovery
          // heuristic; a concrete task ID requires its own result evidence.
          recoveredCommand = {};
        }
      }
      return {
        ...turn,
        ...recoveredCommand,
        ...subagentState(state.pendingSubagentIds),
        ...ignoredDaemonTaskState(state),
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
      // Retain their IDs only to distinguish their notifications from an
      // anonymous ordinary command completion.
      const daemonTaskId = backgroundTaskId(obj);
      const withDaemonId = daemonTaskId ? {
        ...state,
        ignoredDaemonTaskIds: [...new Set([...(state.ignoredDaemonTaskIds ?? []), daemonTaskId])],
      } : state;
      return { ...turn, ...pendingState(withDaemonId), ...daemonHintState(state) };
    }
    const {
      hasPendingTaskResult: _staleResult,
      pendingTaskRunningStep: _staleStep,
      pendingTaskRunningTaskId: _staleTaskId,
      pendingTaskResultIds: _staleResultIds,
      ...rest
    } = state;
    const runningStep = typeof obj.step_index === 'number' && Number.isInteger(obj.step_index)
      ? obj.step_index
      : undefined;
    const taskId = backgroundTaskId(obj);
    const nextTaskIds = taskId
      ? [...new Set([...(state.pendingTaskIds ?? []), taskId])]
      : state.pendingTaskIds;
    const nextResultIds = state.pendingTaskResultIds?.filter(id => id !== taskId);
    return {
      ...rest,
      hasPendingTask: true,
      ...(nextTaskIds?.length ? { pendingTaskIds: nextTaskIds } : {}),
      ...(!taskId ? { hasPendingAnonymousTask: true } : {}),
      ...(runningStep !== undefined ? { pendingTaskRunningStep: runningStep } : {}),
      ...(taskId ? { pendingTaskRunningTaskId: taskId } : {}),
      ...(nextResultIds?.length ? { pendingTaskResultIds: nextResultIds } : {}),
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
    const resultOwner = commandResult ? state.pendingTaskRunningTaskId : undefined;
    const withCommandResult = commandResult ? {
      ...state,
      hasPendingTaskResult: true,
      ...(resultOwner ? {
        pendingTaskResultIds: [...new Set([...(state.pendingTaskResultIds ?? []), resultOwner])],
      } : {}),
    } : state;
    return {
      ...turn,
      ...pendingState(withCommandResult),
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
        return { ...turn, ...ignoredDaemonTaskState(state) };
      }
      const pendingCommands = commandWaitCount(state);
      if (!/^Reminder:/i.test(trimmedPayload)
        && pendingCommands === 1
        && !state.pendingSubagentIds?.length
        && SYSTEM_SINGLE_TASK_CANCEL_RE.test(trimmedPayload)) {
        return { ...turn, ...ignoredDaemonTaskState(state) };
      }
      return state;
    }
    const ids = state.pendingSubagentIds?.filter(id => id !== sender);
    const ignoredDaemonCompletion = (taskSender && sender !== undefined
      && state.ignoredDaemonTaskIds?.includes(sender) === true)
      || (legacyTaskResult && legacyTaskId !== undefined
        && state.ignoredDaemonTaskIds?.includes(legacyTaskId) === true);
    // While a daemon launch is still awaiting its RUNNING record, an unrelated
    // or early completion cannot prove that an anonymous ordinary task ended.
    // Keep both the wait and launch hints so a later RUNNING can establish the
    // daemon identity instead of being latched or killed as ordinary work.
    if (!ignoredDaemonCompletion
      && (taskSender || legacyTaskResult)
      && !state.pendingTaskIds?.length
      && state.hasPendingTask
      && state.pendingDaemonHints) {
      return state;
    }
    if (ignoredDaemonCompletion) return state;
    return {
      ...turn,
      ...(taskSender || legacyTaskResult
        ? removePendingTaskId(state, taskSender ? sender : legacyTaskId)
        : commandState(state)),
      ...subagentState(ids),
      ...ignoredDaemonTaskState(state),
      ...daemonHintState(state),
    };
  }
  if (type === 'ERROR_MESSAGE' || type === 'ERROR') {
    return { ...turn, ...subagentState(state.pendingSubagentIds), ...ignoredDaemonTaskState(state) };
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
      const nextState = pendingState(incomingState);
      return { events, newOffset: fromOffset, pendingTail: '', state: nextState };
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

function isTaskResultRecord(rec: any): boolean {
  if (rec?.type !== 'SYSTEM_MESSAGE' || typeof rec.content !== 'string') return false;
  const content = rec.content;
  const header = systemMessageHeader(content);
  const sender = header.match(/(?:^|\s)sender=([A-Za-z0-9._/-]+)(?:\s|$)/)?.[1];
  if (sender !== undefined && /\/task-[A-Za-z0-9._-]+$/.test(sender)) return true;
  const payload = header
    ? (header.match(/(?:^|\s)content=(.*)/)?.[1] ?? header)
    : systemMessagePayload(content);
  return LEGACY_TASK_RESULT_RE.test(payload);
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
        const needsEarlierProvenance = stats.size > chunkSize && parsed.some(isTaskResultRecord);
        if (turnStart >= 0 && !needsEarlierProvenance) {
          let state: AntigravityTranscriptState = {};
          const events: CodexBridgeEvent[] = [];
          // Fold the whole retained window: each USER_INPUT resets turn waits,
          // while daemon IDs are deliberately carried forward. Starting at the
          // latest input would lose older daemon identity needed to reject its
          // late notification in a newer anonymous-task turn.
          for (let i = 0; i < parsed.length; i++) {
            state = foldRecord(transcriptPath, i, parsed[i], 0, events, state, false, false);
          }
          return { bounded: true, pending: hasAntigravityPendingTasks(state) };
        }
        if (chunkSize >= stats.size) return { bounded: false, pending: false };
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
    const compact = scanTranscriptTailForPendingTasks(compactSibling, PENDING_SCAN_COMPACT_MAX_CHUNK);
    if (compact.bounded) return compact.pending;
  }
  // A capped window without an explicit USER_INPUT boundary is inconclusive,
  // not proof of either state. Widen once to the whole file so long completed
  // turns can release while a RUNNING beyond the cap still holds authority.
  // Only a file with no explicit turn boundary at all remains fail-closed.
  const exhaustive = scanTranscriptTailForPendingTasks(transcriptPath, Number.MAX_SAFE_INTEGER);
  return exhaustive.bounded ? exhaustive.pending : true;
}

export interface AntigravityCompletedTurnCandidate {
  turnId: string;
  submittedText?: string;
  /** 归一化 submittedText 的 SHA-256 摘要（用于从 PID marker 恢复而不落盘明文）。 */
  submittedTextSha256?: string;
  /** 采样 minByteOffset 时的 transcript 文件路径（用于 compact → full 视图切换时换算偏移）。 */
  sampledTranscriptPath?: string;
  /** 提交该候选回合前采样的 transcript 字节偏移下界；纯文本匹配仅接受 >= 换算后下界的 USER_INPUT，
   *  避免同文重复提示词（如静态定时巡检或零注入下的「继续」）误命中更早的已完成回合。 */
  minByteOffset?: number;
  /** 提交前同会话内排在它之前、且尚未落盘到 minByteOffset 之前的同文/未知正文在途回合数；
   *  纯文本匹配必须跳过前 skipPriorMatches 条命中，才把后续独立 occurrence 归属给本候选。 */
  skipPriorMatches?: number;
}

export function hashAntigravitySubmittedText(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n?/g, '\n')).digest('hex');
}

/** 将采样文件坐标系下的字节下界换算到当前读取的 transcriptPath；
 *  compact → full 走 mapAntigravityCompactOffsetToFull，其余无法安全对齐的跨文件切换一律 fail-closed（返回 null）。 */
export function resolveAntigravityCandidateMinByteOffset(
  candidate: Pick<AntigravityCompletedTurnCandidate, 'minByteOffset' | 'sampledTranscriptPath'>,
  transcriptPath: string,
): number | undefined | null {
  if (candidate.minByteOffset === undefined) return undefined;
  const sampled = candidate.sampledTranscriptPath;
  if (!sampled || sampled === transcriptPath) return candidate.minByteOffset;
  if (antigravityFullSiblingPath(sampled) === transcriptPath) {
    const mapped = mapAntigravityCompactOffsetToFull(sampled, candidate.minByteOffset, transcriptPath);
    return mapped === undefined ? null : mapped;
  }
  if (antigravityCompactSiblingPath(sampled) === transcriptPath) {
    return candidate.minByteOffset === 0 ? 0 : null;
  }
  return null;
}

/** 统计 transcriptPath 的 [minByteOffset, maxByteOffset) 区间内，正文 SHA-256 命中 textSha256 的 USER_INPUT 次数。 */
export function countAntigravityUserInputMatches(
  transcriptPath: string,
  textSha256: string,
  minByteOffset = 0,
  maxByteOffset?: number,
): number {
  if (!transcriptPath || !existsSync(transcriptPath)) return 0;
  if (maxByteOffset !== undefined && maxByteOffset <= minByteOffset) return 0;
  let count = 0;
  scanJsonlFromOffset(transcriptPath, minByteOffset, {
    ...(maxByteOffset !== undefined ? { endOffset: maxByteOffset } : {}),
    onLine: line => {
      if (!line.trim()) return;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        return;
      }
      if (!isExplicitUserInput(rec)) return;
      const unwrapped = unwrapAntigravityUserInput(typeof rec.content === 'string' ? rec.content : '');
      if (hashAntigravitySubmittedText(unwrapped) === textSha256) count += 1;
    },
  });
  return count;
}

const COMPLETED_TURN_INITIAL_TAIL_BYTES = 256 * 1024;
const COMPLETED_TURN_MAX_TAIL_BYTES = 4 * 1024 * 1024;

/** 从 BotMux 注入的 envelope 头部提取 `<message_location message_id="..."/>`。
 *  仅扫描 `<user_message>` 之前的系统头，防止正文引用伪造回执归属。 */
function extractBotmuxMessageLocationId(unwrappedUserInput: string): string | undefined {
  const userMsgIdx = unwrappedUserInput.indexOf('<user_message>');
  const header = userMsgIdx >= 0 ? unwrappedUserInput.slice(0, userMsgIdx) : unwrappedUserInput;
  const match = header.match(/(?:^|\n)<message_location\b[^>]*\bmessage_id="([^"]+)"[^>]*\/>(?:\n|$)/);
  return match?.[1];
}

/** 从 Antigravity 原生 transcript 判定哪些候选非 durable 回合已被消费并完成。
 *  仅当 transcript 尾部不处于忙碌态，且候选回合对应的独立 USER_INPUT 之后
 *  存在非空无工具调用的 PLANNER_RESPONSE（DONE）时，才认定其已完成（fail-closed）。 */
export function findCompletedAntigravityTurnIds(
  transcriptPath: string,
  candidates: readonly AntigravityCompletedTurnCandidate[],
): Set<string> {
  const result = new Set<string>();
  if (candidates.length === 0 || !existsSync(transcriptPath)) return result;
  // 最新回合仍有未完成的非 daemon 后台任务或 subagent 时，其无工具 PLANNER_RESPONSE 只是等待旁白，
  // 绝不能提前判定该回合已结束并回收归属权。
  if (hasAntigravityTranscriptPendingTasks(transcriptPath)) return result;

  const candidateIds = new Set<string>();
  const hashToCandidates = new Map<string, Array<{
    turnId: string;
    minByteOffset?: number;
    skipPriorMatches: number;
  }>>();
  let earliestMinOffset: number | undefined;
  for (const candidate of candidates) {
    if (!candidate.turnId) continue;
    candidateIds.add(candidate.turnId);
    const textSha256 = candidate.submittedTextSha256
      ?? (candidate.submittedText ? hashAntigravitySubmittedText(candidate.submittedText) : undefined);
    if (textSha256) {
      const effectiveMinOffset = resolveAntigravityCandidateMinByteOffset(candidate, transcriptPath);
      if (effectiveMinOffset === null) continue;
      if (effectiveMinOffset !== undefined) {
        earliestMinOffset = earliestMinOffset === undefined
          ? effectiveMinOffset
          : Math.min(earliestMinOffset, effectiveMinOffset);
      }
      const entry = {
        turnId: candidate.turnId,
        minByteOffset: effectiveMinOffset,
        skipPriorMatches: Math.max(0, candidate.skipPriorMatches ?? 0),
      };
      const list = hashToCandidates.get(textSha256);
      if (list) {
        if (!list.some(item => item.turnId === candidate.turnId)) list.push(entry);
      } else {
        hashToCandidates.set(textSha256, [entry]);
      }
    }
  }
  if (candidateIds.size === 0) return result;

  try {
    const fd = openSync(transcriptPath, 'r');
    try {
      const stats = fstatSync(fd);
      if (stats.size === 0) return result;

      let chunkSize = Math.min(stats.size, COMPLETED_TURN_INITIAL_TAIL_BYTES);
      while (chunkSize <= stats.size) {
        const windowStart = stats.size - chunkSize;
        const buf = Buffer.alloc(chunkSize);
        readSync(fd, buf, 0, chunkSize, windowStart);

        let busy = false;
        const pending = new Set<string>();
        const completed = new Set<string>();
        const seenCandidates = new Set<string>();
        const plainTextSeenCounts = new Map<string, number>();
        const plainTextClaimed = new Set<string>();

        let pos = 0;
        if (windowStart > 0) {
          const firstNl = buf.indexOf(0x0a);
          pos = firstNl >= 0 ? firstNl + 1 : buf.length;
        }
        while (pos < buf.length) {
          const nl = buf.indexOf(0x0a, pos);
          const lineEnd = nl >= 0 ? nl : buf.length;
          const lineFileOffset = windowStart + pos;
          const line = buf.subarray(pos, lineEnd).toString('utf-8').trim();
          pos = nl >= 0 ? nl + 1 : buf.length;
          if (!line) continue;
          let rec: any;
          try {
            rec = JSON.parse(line);
          } catch {
            continue;
          }
          const type = rec?.type;
          if (type === 'USER_INPUT') {
            if (rec.source !== undefined && rec.source !== 'USER_EXPLICIT') continue;
            busy = true;
            const unwrapped = unwrapAntigravityUserInput(
              typeof rec.content === 'string' ? rec.content : '',
            ).replace(/\r\n?/g, '\n');
            const matched: string[] = [];
            const locId = extractBotmuxMessageLocationId(unwrapped);
            if (locId && candidateIds.has(locId)) {
              matched.push(locId);
            }
            if (hashToCandidates.size > 0) {
              const byHash = hashToCandidates.get(hashAntigravitySubmittedText(unwrapped));
              if (byHash) {
                let claimedThisOccurrence = false;
                for (const entry of byHash) {
                  if (locId && locId !== entry.turnId) continue;
                  if (entry.minByteOffset !== undefined && lineFileOffset < entry.minByteOffset) continue;
                  const seen = (plainTextSeenCounts.get(entry.turnId) ?? 0) + 1;
                  plainTextSeenCounts.set(entry.turnId, seen);
                  if (claimedThisOccurrence || plainTextClaimed.has(entry.turnId)) continue;
                  if (seen <= entry.skipPriorMatches) continue;
                  plainTextClaimed.add(entry.turnId);
                  claimedThisOccurrence = true;
                  if (!matched.includes(entry.turnId)) matched.push(entry.turnId);
                }
              }
            }
            for (const turnId of matched) {
              seenCandidates.add(turnId);
              completed.delete(turnId);
              pending.add(turnId);
            }
            continue;
          }
          if (type === 'PLANNER_RESPONSE') {
            if (Array.isArray(rec.tool_calls) && rec.tool_calls.length > 0) {
              busy = true;
              continue;
            }
            const content = typeof rec.content === 'string' ? rec.content.trim() : '';
            if (content.length > 0 && (rec.status === undefined || rec.status === 'DONE')) {
              busy = false;
              for (const turnId of pending) completed.add(turnId);
              pending.clear();
            }
            continue;
          }
          if (type === 'GENERIC') {
            busy = true;
            continue;
          }
          if (type === 'ERROR_MESSAGE' || type === 'ERROR') {
            busy = false;
            continue;
          }
          if (type === 'SYSTEM_MESSAGE') {
            if (/cancell?ed|interrupted|aborted/i.test(String(rec.content ?? ''))) {
              busy = false;
            }
            continue;
          }
        }

        // transcript 自身仍处于执行态时绝不提前回收任何候选回合。
        if (busy) return new Set();

        const coversMinOffsets = earliestMinOffset === undefined || windowStart <= earliestMinOffset;
        if ((seenCandidates.size === candidateIds.size && coversMinOffsets)
          || chunkSize >= stats.size
          || chunkSize >= COMPLETED_TURN_MAX_TAIL_BYTES) {
          return completed;
        }
        chunkSize = Math.min(stats.size, Math.min(chunkSize * 4, COMPLETED_TURN_MAX_TAIL_BYTES));
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return new Set();
  }
  return result;
}
