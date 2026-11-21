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
import { existsSync, statSync } from 'node:fs';
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
  /** Launched subagents whose first notifications have not arrived,
   *  deduplicated by id. A notification can request guidance rather than
   *  finish the work; send_message does not re-arm this wait because it does
   *  not promise a reply. An array keeps carried worker state serializable. */
  pendingSubagentIds?: string[];
}

/** Every GENERIC record in observed logs with this phrase has status RUNNING;
 *  the phrase is the deterministic "the TUI is back at ready but the turn is
 *  still alive" marker. Status RUNNING alone is accepted too (it never occurs
 *  for foreground tool results in observed logs). */
const BACKGROUND_TASK_PHRASE_RE = /running as a background task/i;

function isBackgroundTaskRunningRecord(obj: any): boolean {
  if (obj?.type !== 'GENERIC') return false;
  return obj?.status === 'RUNNING'
    || (typeof obj?.content === 'string' && BACKGROUND_TASK_PHRASE_RE.test(obj.content));
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
    ...(state?.sourceTurnId ? { sourceTurnId: state.sourceTurnId } : {}),
  };
}

/** Shared by the worker's quiet latch and both drainer flush paths. */
export function hasAntigravityPendingTasks(state: AntigravityTranscriptState): boolean {
  return !!state.hasPendingTask || !!state.pendingSubagentIds?.length;
}

function pendingState(state: AntigravityTranscriptState | undefined): AntigravityTranscriptState {
  return {
    ...(state?.hasPendingTask ? { hasPendingTask: true } : {}),
    ...(state?.pendingSubagentIds?.length ? { pendingSubagentIds: [...state.pendingSubagentIds] } : {}),
  };
}

function subagentState(ids: readonly string[] | undefined): AntigravityTranscriptState {
  return ids?.length ? { pendingSubagentIds: [...ids] } : {};
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

/** Tool calls that are part of the background-task mechanism itself —
 *  launching a task (`manage_task`) or polling/scheduling (`schedule`).
 *  Observed logs call BOTH of these synchronously too (their GENERIC result is
 *  DONE while polling status), so a name never SETS the pending flag by itself
 *  (only a GENERIC RUNNING does). Their role here is narrower: once a
 *  GENERIC RUNNING has latched hasPendingTask, an intervening call to one of
 *  these tools must NOT clear it — the wait it is part of is still in flight.
 *  Empirically the RUNNING record and these calls are written out of
 *  step_index order, so clearing on every PLANNER tool_call dropped the flag
 *  for the majority of real build/review waits (63%). */
const TASK_POLL_TOOL_NAMES = new Set(['manage_task', 'schedule']);

function isTaskPollToolCall(toolCall: any): boolean {
  const name = toolCall?.name ?? toolCall?.function?.name;
  if (typeof name !== 'string') return false;
  if (TASK_POLL_TOOL_NAMES.has(name)) return true;
  // Cancellation abandons selected subagents, not an independent command.
  // Launches and ordinary subagent management (e.g. list) remain foreground
  // transitions for the legacy missing-command-callback recovery heuristic.
  // Their foreground path still carries every outstanding subagent id.
  const action = name === 'manage_subagents'
    ? decodeArgumentValue(toolCallArguments(toolCall)?.Action)
    : undefined;
  return action === 'kill' || action === 'kill_all';
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
): AntigravityTranscriptState {
  const type = obj?.type;
  const turn = state.sourceTurnId ? { sourceTurnId: state.sourceTurnId } : {};
  if (type === 'USER_INPUT') {
    // Only agy's own explicit submits start bridge turns. Any other source is
    // ignored entirely (and neither confirms nor cancels a candidate).
    if (obj.source !== undefined && obj.source !== 'USER_EXPLICIT') return state;
    // A new explicit user turn proves the previous loop really ended AND no
    // background task from it is outstanding: release its held final BEFORE
    // the user event so turns stay interleaved, and reset the turn state.
    const uuid = `${path}:${lineStart}`;
    if (state.provisionalFinal && !(adoptMode && hasAntigravityPendingTasks(state))) {
      events.push(state.provisionalFinal);
    } else if (state.sourceTurnId) {
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
      if (obj.tool_calls.every(isTaskPollToolCall)) return state;
      return { ...turn, ...subagentState(state.pendingSubagentIds) };
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
    return { ...state, hasPendingTask: true };
  }
  if (type === 'GENERIC') {
    // Foreground tool output after a content-only step cancels the candidate;
    // a possibly-outstanding background task stays recorded.
    const content = typeof obj.content === 'string' ? obj.content : '';
    const ids = obj.status === 'DONE' ? createdSubagentIds(content) : [];
    return {
      ...turn,
      ...pendingState(state),
      ...subagentState([...new Set([...(state.pendingSubagentIds ?? []), ...ids])]),
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
    const legacyTaskResult = !sender
      && /^[Tt]ask(?: id)?\s+[^\n]*? (?:finished|completed|was cancel(?:l)?ed|failed|timed out)\b/.test(payload);
    // Pure system notices do not wake the planner with a result and may land
    // after its real final. Preserve both pending work and the held candidate.
    if (!header && !legacyTaskResult) return state;
    const ids = state.pendingSubagentIds?.filter(id => id !== sender);
    return {
      ...turn,
      ...(!taskSender && !legacyTaskResult && state.hasPendingTask ? { hasPendingTask: true } : {}),
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
    state = foldRecord(path, lineStart, obj, recordTimestampMs(obj), events, state, options.adoptMode === true);
  }

  // The final object may sit at EOF without a trailing \n until the next turn.
  // Fold it only once it parses completely; otherwise keep it pending.
  if (pendingTail.length > 0) {
    try {
      const obj = JSON.parse(pendingTail);
      state = foldRecord(path, newOffset, obj, recordTimestampMs(obj), events, state, options.adoptMode === true);
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
