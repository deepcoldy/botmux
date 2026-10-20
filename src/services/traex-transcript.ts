/**
 * Reader for TRAE CLI (traex / traecli) per-session rollout JSONL.
 *
 * TRAE is a Codex-family CLI, but its terminal event is NOT byte-identical to
 * upstream Codex:
 *   - genuine user input is confirmed by event_msg `user_message` or, in
 *     TraeX 0.201.4 rollout dialect, event_msg `item_completed` with a
 *     `UserMessage` item; TRAE also writes internal runtime injections as
 *     response_item role=user messages, so those records alone are not
 *     user-attribution evidence;
 *   - assistant response_item messages have no `phase` and are emitted many
 *     times during tool use, so none of them is a safe turn boundary;
 *   - append-only `history_mutation` records carry the model-visible
 *     reasoning and tool call/result items. They are normalized into the same
 *     cosmetic CoT event shape used by Codex, without changing turn
 *     attribution or completion;
 *   - event_msg `task_complete` is the durable end-of-turn marker and carries
 *     the final visible text in `last_agent_message` (which may be empty).
 *     When it is empty the drainer consults the turn's assistant records: a
 *     `final_answer`-phase agent_message reconstructs a dropped final, and a
 *     commentary message ending in the nothing-to-send sentinel marks
 *     deliberate silence. Two newer dialects get the same treatment: an
 *     `item_completed` AgentMessage item (0.201.4+ mirrors the assistant
 *     message there, symmetric to the UserMessage user dialect) and a
 *     phase-less `agent_message` (a dialect that dropped the `phase` field,
 *     cf. codex >= 0.146) — the last of either is a final candidate unless it
 *     ends in the nothing-to-send sentinel, which marks deliberate silence.
 *     A non-null `error` payload maps the terminal to `failed` (mirroring the
 *     Codex drainer) so a model-endpoint failure surfaces its real reason
 *     instead of the misleading "completed but empty" diagnostic.
 *   - Directory layout differs: sessions live under
 *     ~/.trae/cli/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl
 *     (note the extra `cli/` level vs Codex's ~/.codex/sessions/...).
 *
 * This module therefore owns a small TRAE-specific incremental reader while
 * reusing the Codex queue event shape and history helpers.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  type Dirent,
} from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import {
  splitCodexEventsByCutoff,
  extractLastCodexTurn,
  type CodexBridgeEvent,
  type CodexDrainResult,
  codexCotEntriesFromResponseItem,
  codexTaskFailureCode,
  CODEX_OUTPUT_LIMIT_ERROR_CODE,
  isExactCodexOutputLimitError,
  safeFailureSummary,
  codexHistorySidIsOwned,
  readLatestRolloutRuntime,
  rolloutAbortErrorCode,
  runtimeFromTurnContext,
} from './codex-transcript.js';
import {
  BRIDGE_NOTHING_TO_SEND_SENTINEL,
  BRIDGE_NO_REPLY_SENTINEL_LEGACY,
} from './bridge-fallback-gate.js';
import { isInternalCodexSessionMeta } from './codex-session-meta.js';
import { openDatabaseSyncNow } from './sqlite-compat.js';
import { isBotmuxInjectedPrompt } from './resumable-session-discovery.js';
import { isBotmuxGoalObjective } from '../workflows/v3/contract.js';
import { beginJsonlDrain, iterateJsonlLines } from './jsonl-cursor.js';
import { traeSessionsRoot, traeStateDbPath } from './traex-paths.js';
import { listProcessOpenFiles } from '../utils/process-open-files.js';

export { splitCodexEventsByCutoff as splitTraexEventsByCutoff };
export { extractLastCodexTurn as extractLastTraexTurn };
export type { CodexBridgeEvent as TraexBridgeEvent };

export interface TraexDrainResult extends CodexDrainResult {
  /** Latest executor-reported model observed in the drained complete records. */
  latestModel?: string;
  /** Latest executor-reported reasoning effort observed in complete records. */
  latestReasoningEffort?: string;
}

export interface TraexDrainOptions {
  /** Adopt mode: the adopted CLI is botmux-unaware, so the drainer must NOT
   *  synthesise a bare nothing-to-send sentinel for an empty final — the emit
   *  layer posts transcript text verbatim in adopt mode and the literal token
   *  would leak into Lark. Default false (synthesise, matching the non-adopt
   *  genuine-silence contract). */
  adoptMode?: boolean;
  /** Read-only probe: skip the per-turn agent_message cache mutations. Used by
   *  submit-confirmation probes that re-drain the same live rollout at a
   *  different offset and must not disturb the production drainer's pending
   *  turn state. */
  probe?: boolean;
}

export interface TraexRuntimeSnapshot {
  model?: string;
  reasoningEffort?: string;
}

const TRAEX_SESSION_META_SCAN_MAX_BYTES = 4 * 1024 * 1024;
const TRAEX_ROLLOUT_LOOKUP_INITIAL_BACKOFF_MS = 2_000;
const TRAEX_ROLLOUT_LOOKUP_MAX_BACKOFF_MS = 8_000;
const TRAEX_ROLLOUT_LOOKUP_MISS_CACHE_MAX = 256;
const TRAEX_YEAR_DIR_RE = /^\d{4}$/;
const TRAEX_MONTH_DIR_RE = /^(?:0[1-9]|1[0-2])$/;
const TRAEX_DAY_DIR_RE = /^(?:0[1-9]|[12]\d|3[01])$/;
const TRAEX_ROLLOUT_SESSION_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.jsonl$/i;

interface TraexRolloutLookupMiss {
  nextFilesystemScanAtMs: number;
  backoffMs: number;
}

/** Per-process fallback throttle. The authoritative SQLite lookup still runs
 *  on every call, so a newly indexed rollout attaches immediately; only the
 *  compatibility filesystem scan is delayed after repeated misses. */
const traexRolloutLookupMisses = new Map<string, TraexRolloutLookupMiss>();

/** Extract the stable TRAE thread id from a rollout filename.
 *
 * Older releases used `rollout-<ts>-<thread-id>.jsonl`. TraeX 0.209.1 also
 * writes resumed history segments as
 * `rollout-<ts>-<thread-id>_<first-turn-id>.jsonl`. The suffix after `_` is a
 * turn id, not a new resumable session id. The generic Codex parser selects
 * the final UUID and therefore cannot be used for TRAE segmented rollouts. */
export function traexSessionIdFromRolloutPath(path: string): string | undefined {
  return TRAEX_ROLLOUT_SESSION_RE.exec(basename(path))?.[1];
}

type DatabaseSyncLike = {
  prepare(sql: string): StatementSyncLike;
  close(): void;
};
type StatementSyncLike = {
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
};

function withTraeDb<T>(fn: (db: DatabaseSyncLike) => T, dbPath = traeStateDbPath()): T | null {
  if (!existsSync(dbPath)) return null;
  // Runtime-agnostic open: `node:sqlite` on Node, `bun:sqlite` on the compiled
  // single-file binary. This MUST NOT go back to requiring `node:sqlite`
  // directly — botmux ships as a `bun build --compile` executable, and taking
  // that path there loses TRAE session lookup silently (the shim's null return
  // is indistinguishable from "no db", so resume/verification just degrades
  // with no error). See src/services/sqlite-compat.ts.
  //
  // NOTE for future merges: this file arrived from master with a direct
  // `createRequire('node:sqlite')` and produced NO merge conflict, because the
  // logic had moved here from the traex adapter — where the Bun fix lived. A
  // clean merge is not a correct merge; re-check this call whenever the file
  // moves again.
  const db = openDatabaseSyncNow(dbPath, { readOnly: true }) as DatabaseSyncLike | null;
  if (!db) return null;
  try {
    return fn(db);
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** Cheap per-thread identity / ordering data — no prompt-bearing columns, so
 *  it can be read for every thread on each /adopt. */
export interface TraexThreadIndexEntry {
  id: string;
  cwd?: string;
  rolloutPath?: string;
  updatedAtMs?: number;
}

/** Prompt-derived data. Read only for the threads a picker actually inspects
 *  (see readTraexThreadDetails): prompts can be tens of KiB each. */
export interface TraexThreadDetails {
  id: string;
  /** DISPLAY ONLY. What TraeX itself shows for the thread: `threads.name`
   *  (0.208+, written by `/rename` and TraeX's own auto-naming) else the legacy
   *  `threads.title`. Omitted when that text is itself botmux-shaped (an
   *  envelope / the v3 goal objective), so it is never rendered — but it never
   *  decides origin either way. */
  title?: string;
  /** ORIGIN EVIDENCE: the thread's original first input, `threads.preview`.
   *  Unlike `title` / `name` / `first_user_message`, which TraeX rewrites
   *  (0.210 moves `title` and `first_user_message` to a later input), `preview`
   *  keeps what the thread started with. Absent (older schemas, or not yet
   *  written) → the rollout's first-turn rule decides origin instead. */
  firstUserMessage?: string;
  /** `firstUserMessage` is a botmux envelope or botmux v3's own `/goal`
   *  objective: botmux started this thread. */
  botmuxOrigin?: boolean;
}

type TraexThreadRow = {
  id?: unknown;
  name?: unknown;
  title?: unknown;
  preview?: unknown;
  cwd?: unknown;
  rolloutPath?: unknown;
  updatedAt?: unknown;
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function traexUpdatedAtMs(value: unknown): number | undefined {
  const timestamp = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined;
  return timestamp >= 1_000_000_000_000 ? timestamp : timestamp * 1000;
}

function normalizeTraexThreadIndexEntry(row: TraexThreadRow | undefined): TraexThreadIndexEntry | undefined {
  const id = nonEmptyString(row?.id);
  if (!id) return undefined;
  const cwd = nonEmptyString(row?.cwd);
  const rolloutPath = nonEmptyString(row?.rolloutPath);
  const updatedAtMs = traexUpdatedAtMs(row?.updatedAt);
  return {
    id,
    ...(cwd ? { cwd } : {}),
    ...(rolloutPath ? { rolloutPath } : {}),
    ...(updatedAtMs ? { updatedAtMs } : {}),
  };
}

/** botmux-generated text: a Lark envelope or botmux v3's own `/goal` objective. */
function isBotmuxShapedText(text: string): boolean {
  return isBotmuxInjectedPrompt(text.trim()) || isBotmuxGoalObjective(text);
}

function normalizeTraexThreadDetails(row: TraexThreadRow | undefined): TraexThreadDetails | undefined {
  const id = nonEmptyString(row?.id);
  if (!id) return undefined;
  // Origin comes from first-turn evidence only — `preview`, the original first
  // input. Mutable display fields can't decide it in either direction: an
  // external thread whose name / later prompt holds an envelope stays
  // external, and a botmux thread renamed to something clean stays botmux.
  // Without `preview` the rollout's first-turn rule decides (resume) or origin
  // stays unknown (live: only the display-safety check below applies).
  const firstUserMessage = nonEmptyString(row?.preview);
  const botmuxOrigin = firstUserMessage !== undefined && isBotmuxShapedText(firstUserMessage);
  // Display safety, not origin: a title that is itself an envelope / the goal
  // objective (≤0.207 defaulted the title to the first prompt) is never shown.
  const title = [nonEmptyString(row?.name), nonEmptyString(row?.title)]
    .find(text => text !== undefined && !isBotmuxShapedText(text));
  return {
    id,
    ...(title ? { title } : {}),
    ...(firstUserMessage ? { firstUserMessage } : {}),
    ...(botmuxOrigin ? { botmuxOrigin } : {}),
  };
}

/** `threads` columns these readers understand, as `[column, alias]`, split so
 *  the per-/adopt full scan never touches prompt-bearing text. The set drifts
 *  across TraeX releases (`name`/`preview` are 0.208+, very old DBs lack
 *  `first_user_message`), and selecting a missing column throws — which
 *  withTraeDb would swallow into "no metadata at all". Project only the columns
 *  the live schema has and NULL the rest. */
type TraexThreadColumns = ReadonlyArray<readonly [string, keyof TraexThreadRow]>;
const TRAEX_THREAD_INDEX_COLUMNS: TraexThreadColumns = [
  ['cwd', 'cwd'],
  ['rollout_path', 'rolloutPath'],
  ['updated_at', 'updatedAt'],
];
const TRAEX_THREAD_DETAIL_COLUMNS: TraexThreadColumns = [
  ['name', 'name'],
  ['title', 'title'],
  ['preview', 'preview'],
];
/** Bound on `IN (…)` parameters per detail query (SQLite's default limit is
 *  far higher; this just keeps statements small). */
const TRAEX_THREAD_DETAIL_BATCH = 200;

function traexThreadSelect(db: DatabaseSyncLike, wanted: TraexThreadColumns): string | undefined {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(threads)').all() as Array<{ name?: unknown }>)
      .map(column => column.name),
  );
  if (!columns.has('id')) return undefined;
  const projection = wanted.map(([column, alias]) =>
    columns.has(column) ? `${column} AS ${alias}` : `NULL AS ${alias}`);
  return `SELECT id, ${projection.join(', ')} FROM threads`;
}

/** Every thread's identity / ordering data (cwd, rollout path, updated_at) —
 *  enough to order resume candidates by native activity. Best-effort: an
 *  older/missing/corrupt database yields an empty map and callers fall back to
 *  parsing rollout JSONL. */
export function readTraexThreadIndex(
  dbPath = traeStateDbPath(),
): ReadonlyMap<string, TraexThreadIndexEntry> {
  return withTraeDb((db) => {
    const out = new Map<string, TraexThreadIndexEntry>();
    const select = traexThreadSelect(db, TRAEX_THREAD_INDEX_COLUMNS);
    if (!select) return out;
    for (const row of db.prepare(select).all() as TraexThreadRow[]) {
      const entry = normalizeTraexThreadIndexEntry(row);
      if (entry) out.set(entry.id, entry);
    }
    return out;
  }, dbPath) ?? new Map<string, TraexThreadIndexEntry>();
}

/** Title / first prompt / origin for just these threads — the candidates a
 *  picker is about to show. Prompt columns are read whole on purpose: origin
 *  detection needs the envelope's closing tags and trailing footer, which can
 *  sit tens of KiB into a long pasted prompt, so a prefix cut would turn a
 *  botmux thread into a false "external" one. */
export function readTraexThreadDetails(
  ids: readonly string[],
  dbPath = traeStateDbPath(),
): ReadonlyMap<string, TraexThreadDetails> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map<string, TraexThreadDetails>();
  return withTraeDb((db) => {
    const out = new Map<string, TraexThreadDetails>();
    const select = traexThreadSelect(db, TRAEX_THREAD_DETAIL_COLUMNS);
    if (!select) return out;
    for (let start = 0; start < unique.length; start += TRAEX_THREAD_DETAIL_BATCH) {
      const batch = unique.slice(start, start + TRAEX_THREAD_DETAIL_BATCH);
      const rows = db.prepare(`${select} WHERE id IN (${batch.map(() => '?').join(', ')})`)
        .all(...batch) as TraexThreadRow[];
      for (const row of rows) {
        const details = normalizeTraexThreadDetails(row);
        if (details) out.set(details.id, details);
      }
    }
    return out;
  }, dbPath) ?? new Map<string, TraexThreadDetails>();
}

/** Resolve one live TraeX session's native title for the /adopt picker.
 *
 *  Live discovery (tmux / herdr / zellij) never runs the rollout parser, so the
 *  index evidence is applied here: a thread whose original first input
 *  (`preview`) is botmux's gets `undefined` — the project-dir fallback — and a
 *  title that is itself botmux-shaped is never returned (readTraexThreadDetails
 *  drops it), so a Lark envelope can't be rendered as the card title even when
 *  origin is unknown (no `preview`). Returned untruncated; display cleaning
 *  lives with the other live titles (traexLiveTitle in core/session-discovery). */
export function readTraexThreadTitle(
  cliSessionId: string,
  dbPath = traeStateDbPath(),
): string | undefined {
  if (!cliSessionId) return undefined;
  const details = readTraexThreadDetails([cliSessionId], dbPath).get(cliSessionId);
  if (!details?.title || details.botmuxOrigin) return undefined;
  return details.title.replace(/\s+/g, ' ').trim() || undefined;
}

type TraexRolloutKind = 'user' | 'internal' | 'legacy' | 'empty' | 'pending';

interface TraexRolloutRef {
  path: string;
  cliSessionId: string;
  kind: TraexRolloutKind;
  startedAtMs?: number;
}

const traexRolloutMetaCache = new Map<string, {
  kind: TraexRolloutKind;
  startedAtMs?: number;
}>();

/** Per-rollout `agent_message` state for the CURRENTLY OPEN turn, retained
 *  across drain calls. A turn's commentary/final_answer records are almost
 *  always drained in earlier polls than its `task_complete` (turns run for
 *  minutes while the poller runs on the second scale), so same-batch state
 *  would never see them. Reset on every `user_message` (turn start) and
 *  consumed/cleared by `task_complete`/`turn_aborted` (turn end); a turn that
 *  terminates without either leaves at most one stale entry, bounded by the
 *  same cap/eviction as traexRolloutMetaCache. */
interface TraexPendingAgentMessages {
  /** Last commentary-phase `agent_message` since the turn's user_message.
   *  Its trailing sentinel is the deliberate-silence signal. */
  lastCommentary?: string;
  /** Last final_answer-phase `agent_message` since the turn's user_message.
   *  Defensive reconstruction source when task_complete drops the final it
   *  actually produced. */
  lastFinalAnswer?: string;
  /** Last `item_completed` AgentMessage item text since the turn's
   *  user_message. TraeX 0.201.4+ can mirror the assistant message as an
   *  item_completed item (symmetric to the UserMessage user dialect), so the
   *  last one is a final candidate. NOT phase-guaranteed: a candidate ending
   *  in the nothing-to-send sentinel is deliberate-silence narration, and the
   *  sentinel guard at task_complete distinguishes the two. */
  agentItems?: Map<string, { text: string; phase?: string; canonical: boolean }>;
  /** Last PHASE-LESS `agent_message` since the turn's user_message. A dialect
   *  that dropped the `phase` field (cf. codex >= 0.146) makes commentary and
   *  final byte-identical, so the last phase-less message is the best final
   *  candidate — same sentinel guard as lastAgentItemText. */
  lastAgentMessageNoPhase?: string;
}

interface TraexPendingAgentTurns {
  turns: Map<string, TraexPendingAgentMessages>;
  activeKey?: string;
}

const traexPendingAgentCache = new Map<string, TraexPendingAgentTurns>();
const TRAEX_PENDING_AGENT_CACHE_MAX = 512;
const TRAEX_PENDING_AGENT_TURNS_PER_PATH_MAX = 64;
const TRAEX_PENDING_AGENT_ITEMS_PER_TURN_MAX = 64;

/** New and legacy user event dialects can mirror one another in the same
 * rollout. Keep de-duplication scoped to a rollout and its stable turn id:
 * identical prompts in distinct turns must remain distinct local turns. */
const traexSeenUserTurns = new Map<string, Map<string, string | undefined>>();
/** TraeX can write the legacy and item_completed user records in either order.
 * Remember the one missing counterpart across incremental drains. The state
 * belongs only to the currently open native turn and is cleared at its
 * terminal edge, so a same-text prompt in the next turn remains real input. */
interface TraexPendingUserMirror {
  text: string;
  timestampMs: number;
  expected: 'legacy' | 'item' | 'terminal';
  sourceTurnId?: string;
  agentStateKey?: string;
  /** A native successor was allowed to start while this id-less legacy turn
   * stayed queued, so a terminal may need to bind it if its item mirror never
   * arrives. */
  preservedBeforeSuccessor?: boolean;
}
interface TraexDrainUserMirror extends TraexPendingUserMirror {
  /** Set only for a legacy event emitted by this drain, so its item mirror can
   * upgrade that event in place without changing chronological turn order. */
  eventIndex?: number;
}
const traexPendingUserMirrors = new Map<string, TraexPendingUserMirror[]>();
const TRAEX_SEEN_USER_TURN_PATHS_MAX = 512;
const TRAEX_SEEN_USER_TURNS_PER_PATH_MAX = 4096;
const TRAEX_PENDING_USER_MIRRORS_PER_PATH_MAX = 64;
const TRAEX_LEGACY_USER_MIRROR_WINDOW_MS = 5_000;

function claimTraexUserTurn(path: string, turnId: unknown, legacyStateKey?: string): boolean {
  if (typeof turnId !== 'string' || turnId.length === 0) return true;
  let seen = traexSeenUserTurns.get(path);
  if (!seen) {
    seen = new Map<string, string | undefined>();
    traexSeenUserTurns.set(path, seen);
    if (traexSeenUserTurns.size > TRAEX_SEEN_USER_TURN_PATHS_MAX) {
      const oldestPath = traexSeenUserTurns.keys().next().value;
      if (oldestPath) traexSeenUserTurns.delete(oldestPath);
    }
  }
  if (seen.has(turnId)) return false;
  seen.set(turnId, legacyStateKey);
  if (seen.size > TRAEX_SEEN_USER_TURNS_PER_PATH_MAX) {
    const oldestTurnId = seen.keys().next().value;
    if (oldestTurnId) seen.delete(oldestTurnId);
  }
  return true;
}

function rememberTraexUserMirrors(path: string, pending: readonly TraexPendingUserMirror[]): void {
  if (pending.length === 0) {
    traexPendingUserMirrors.delete(path);
    return;
  }
  traexPendingUserMirrors.set(path, pending.slice(-TRAEX_PENDING_USER_MIRRORS_PER_PATH_MAX));
  if (traexPendingUserMirrors.size > TRAEX_SEEN_USER_TURN_PATHS_MAX) {
    const oldestPath = traexPendingUserMirrors.keys().next().value;
    if (oldestPath) traexPendingUserMirrors.delete(oldestPath);
  }
}

function takeExpectedTraexUserMirror(
  pending: TraexDrainUserMirror[],
  expected: TraexPendingUserMirror['expected'],
  text: string,
  timestampMs: number,
): TraexDrainUserMirror | undefined {
  // Transcript timestamps are chronological. Expired candidates cannot be a
  // later mirror and retaining them could consume a genuine repeated prompt.
  expireTraexUserMirrors(pending, timestampMs);
  const index = pending.findIndex(candidate => candidate.expected === expected
    && candidate.text === text
    && timestampMs >= candidate.timestampMs);
  if (index < 0) return undefined;
  return pending.splice(index, 1)[0];
}

function shouldPreserveUnboundLegacyPredecessor(
  pending: TraexDrainUserMirror[],
  sourceTurnId: string | undefined,
  timestampMs: number,
): boolean {
  // A native-id user can be a typed-ahead successor whose event arrives
  // before the item mirror that will bind an already-started legacy turn.
  // Keep that id-less predecessor alive until the delayed mirror/terminal can
  // identify it. Apply this to every supported native user dialect.
  expireTraexUserMirrors(pending, timestampMs);
  if (sourceTurnId === undefined) return false;
  const predecessor = pending.find(
    candidate => candidate.expected === 'item' && !candidate.sourceTurnId,
  );
  if (!predecessor) return false;
  predecessor.preservedBeforeSuccessor = true;
  return true;
}

function expireTraexUserMirrors(pending: TraexDrainUserMirror[], timestampMs: number): void {
  for (let index = pending.length - 1; index >= 0; index--) {
    // Once a native successor has started behind an id-less legacy turn, this
    // candidate is the only durable evidence that a later native terminal
    // belongs to that predecessor. A normal model turn can outlive the short
    // dialect-mirror window, so retain it until its mirror/bind/terminal
    // consumes it (the per-path mirror cap still bounds retained state).
    if (pending[index].preservedBeforeSuccessor) continue;
    const ageMs = timestampMs - pending[index].timestampMs;
    if (ageMs > TRAEX_LEGACY_USER_MIRROR_WINDOW_MS) pending.splice(index, 1);
  }
}

function takeTraexUserMirrorAtTerminal(
  pending: TraexDrainUserMirror[],
  sourceTurnId: string,
  nativeUserWasSeen: boolean,
  legacyStateKey?: string,
): TraexDrainUserMirror | undefined {
  // A paired legacy-first turn leaves a terminal marker, while item-first
  // state carries its id directly. Prefer either exact match so a terminal
  // cannot consume a source-less candidate belonging to a typed-ahead turn.
  const exactIndex = pending.findIndex(candidate => candidate.sourceTurnId === sourceTurnId);
  if (exactIndex >= 0) {
    return pending.splice(exactIndex, 1)[0];
  }
  if (legacyStateKey !== undefined) {
    const replayIndex = pending.findIndex(candidate => candidate.agentStateKey === legacyStateKey);
    if (replayIndex >= 0) return pending.splice(replayIndex, 1)[0];
  }
  // A terminal for a turn whose native user record was already observed must
  // not consume an earlier id-less legacy turn. That predecessor can only be
  // identified by the first unseen native id that reaches its mirror or
  // terminal edge.
  if (nativeUserWasSeen) return undefined;
  // A legacy-only dialect never reveals the id until terminal. In that case
  // retire only the oldest unmatched legacy turn, preserving queued inputs.
  const legacyIndex = pending.findIndex(candidate => candidate.expected === 'item');
  if (legacyIndex < 0) return undefined;
  return pending.splice(legacyIndex, 1)[0];
}

function itemCompletedUserText(item: unknown): string {
  if (!item || typeof item !== 'object') return '';
  const record = item as { type?: unknown; content?: unknown };
  if (record.type !== 'UserMessage' || !Array.isArray(record.content)) return '';
  const parts: string[] = [];
  for (const block of record.content) {
    if (!block || typeof block !== 'object') continue;
    const textBlock = block as { type?: unknown; text?: unknown };
    if (textBlock.type === 'text' && typeof textBlock.text === 'string') {
      parts.push(textBlock.text);
    }
  }
  return parts.join('');
}

/** Assistant-side mirror of itemCompletedUserText: extract the text of an
 *  item_completed `AgentMessage` item. TraeX 0.201.4+ can emit the assistant
 *  message in this shape (symmetric to the UserMessage user dialect), and a
 *  later dialect may drop the agent_message phase field, so the drainer
 *  tracks the last AgentMessage item as a final candidate. The block type is
 *  accepted as 'Text' (observed TraeX 0.201.4 shape), 'output_text' (upstream
 *  Responses API shape) or lowercase 'text' so dialect drift doesn't silently
 *  drop the final; non-text blocks (reasoning, tool calls) carry no `text`
 *  field and are skipped. */
function itemCompletedAgentText(item: unknown): string {
  if (!item || typeof item !== 'object') return '';
  const record = item as { type?: unknown; content?: unknown };
  if (record.type !== 'AgentMessage' || !Array.isArray(record.content)) return '';
  const parts: string[] = [];
  for (const block of record.content) {
    if (!block || typeof block !== 'object') continue;
    const textBlock = block as { type?: unknown; text?: unknown };
    if (typeof textBlock.text !== 'string') continue;
    if (textBlock.type === 'Text'
      || textBlock.type === 'text'
      || textBlock.type === 'output_text') {
      parts.push(textBlock.text);
    }
  }
  return parts.join('');
}

/** TraeX persists the model-visible conversation in `history_mutation`
 * records. Unlike its diagnostic `exec_command_end` / `patch_apply_end`
 * events, these append records contain both the original tool call and its
 * returned content, in model order. Normalize the array-shaped tool output to
 * the string shape understood by the shared Codex CoT extractor. */
function traexDisplayCompletions(payload: any, sourceSessionId?: string): any[] {
  if (payload?.operation !== 'append' || !Array.isArray(payload.display_completions)) return [];
  return payload.display_completions.filter((completion: any) =>
    completion && typeof completion === 'object'
    && typeof completion.turn_id === 'string' && completion.turn_id
    && completion.turn_id === payload.turn_id
    && (!sourceSessionId || completion.thread_id === sourceSessionId));
}

/** Verified user input carried by one TraeX rollout record, for /adopt
 *  history discovery: `history_mutation` display completions of type
 *  UserMessage (0.208+, same turn/thread validation the bridge uses) and the
 *  0.201.4 `item_completed` UserMessage mirror. The record's raw model-visible
 *  `items` are deliberately NOT returned — TraeX also writes runtime
 *  injections there as `role: user`, so they cannot decide session origin. */
export function traexRolloutUserInputs(
  rec: Record<string, unknown>,
  sourceSessionId?: string,
): string[] {
  const payload = rec.payload as any;
  if (rec.type === 'history_mutation') {
    return traexDisplayCompletions(payload, sourceSessionId)
      .filter((completion: any) => completion.item?.type === 'UserMessage')
      .map((completion: any) => itemCompletedUserText(completion.item).trim())
      .filter(Boolean);
  }
  if (rec.type === 'event_msg' && payload?.type === 'item_completed') {
    const text = itemCompletedUserText(payload.item).trim();
    return text ? [text] : [];
  }
  return [];
}

function traexHistoryCotEntries(payload: any, sourceSessionId?: string): CodexBridgeEvent['cotEntries'] {
  if (payload?.operation !== 'append') return [];
  const modelItems = Array.isArray(payload.items) ? payload.items : [];
  const displayReasoning = new Map<string, any>();
  for (const completion of traexDisplayCompletions(payload, sourceSessionId)) {
    const item = completion.item;
    if (item?.type !== 'Reasoning' || typeof item.id !== 'string' || !item.id) continue;
    const summary = Array.isArray(item.summary_text)
      ? item.summary_text.filter((text: unknown) => typeof text === 'string' && text.length > 0)
      : [];
    const raw = Array.isArray(item.raw_content)
      ? item.raw_content.filter((text: unknown) => typeof text === 'string' && text.length > 0)
      : [];
    if (summary.length === 0 && raw.length === 0) continue;
    displayReasoning.set(item.id, {
      type: 'reasoning',
      id: item.id,
      summary: summary.map((text: string) => ({ type: 'summary_text', text })),
      content: raw.map((text: string) => ({ type: 'reasoning_text', text })),
    });
  }
  const modelReasoningIndices = new Map<string, number>();
  for (const [index, item] of modelItems.entries()) {
    if (item?.type === 'reasoning' && typeof item.id === 'string') {
      modelReasoningIndices.set(item.id, index);
    }
  }
  const reasoningItems = Array.from(displayReasoning.values());
  const firstAnchor = reasoningItems.find(item => modelReasoningIndices.has(item.id));
  let insertionIndex = firstAnchor ? modelReasoningIndices.get(firstAnchor.id)! : 0;
  const reasoningInsertions = new Map<number, any[]>();
  for (const item of reasoningItems) {
    const modelIndex = modelReasoningIndices.get(item.id);
    if (modelIndex !== undefined) {
      insertionIndex = modelIndex + 1;
    } else {
      const insertion = reasoningInsertions.get(insertionIndex) ?? [];
      insertion.push(item);
      reasoningInsertions.set(insertionIndex, insertion);
    }
  }
  const items = modelItems.flatMap((item: any, index: number) => {
    const display = item?.type === 'reasoning' ? displayReasoning.get(item.id) : undefined;
    const normalized = display ? {
      ...item,
      summary: display.summary.length > 0 ? display.summary : item.summary,
      content: display.content.length > 0 ? display.content : item.content,
    } : item;
    return [...(reasoningInsertions.get(index) ?? []), normalized];
  });
  items.push(...(reasoningInsertions.get(modelItems.length) ?? []));
  const entries: NonNullable<CodexBridgeEvent['cotEntries']> = [];
  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    let item = rawItem;
    if ((rawItem.type === 'function_call_output' || rawItem.type === 'custom_tool_call_output')
      && Array.isArray(rawItem.output)) {
      const text = rawItem.output
        .flatMap((block: any) => block && typeof block === 'object'
          && typeof block.text === 'string'
          && (block.type === 'input_text' || block.type === 'output_text' || block.type === 'text')
          ? [block.text]
          : [])
        .join('');
      item = { ...rawItem, output: text };
    }
    const itemEntries = codexCotEntriesFromResponseItem(item);
    entries.push(...itemEntries);
    // The shared renderer deliberately accepts an empty tool result and turns
    // it into its localized completion marker. Preserve that terminal edge
    // for image-only, unknown-block, and empty-array outputs without exposing
    // opaque/non-text payloads in the CoT message.
    if (itemEntries.length === 0
      && (rawItem.type === 'function_call_output' || rawItem.type === 'custom_tool_call_output')
      && typeof rawItem.call_id === 'string' && rawItem.call_id) {
      entries.push({ kind: 'tool_result', id: rawItem.call_id, result: '' });
    }
  }
  return entries;
}

function traexPendingAgentTurns(path: string): TraexPendingAgentTurns {
  let state = traexPendingAgentCache.get(path);
  if (!state) {
    state = { turns: new Map() };
    traexPendingAgentCache.set(path, state);
    if (traexPendingAgentCache.size > TRAEX_PENDING_AGENT_CACHE_MAX) {
      const oldest = traexPendingAgentCache.keys().next().value;
      if (oldest) traexPendingAgentCache.delete(oldest);
    }
  }
  return state;
}

function traexPendingAgentState(path: string, sourceTurnId?: string): TraexPendingAgentMessages {
  const state = traexPendingAgentTurns(path);
  const key = sourceTurnId ?? state.activeKey ?? '';
  let messages = state.turns.get(key);
  if (!messages) {
    messages = {};
    state.turns.set(key, messages);
    if (state.turns.size > TRAEX_PENDING_AGENT_TURNS_PER_PATH_MAX) {
      const oldest = state.turns.keys().next().value;
      if (oldest !== undefined) state.turns.delete(oldest);
    }
  }
  return messages;
}

function bindTraexPendingAgentTurn(path: string, legacyKey: string | undefined, sourceTurnId: string): void {
  if (legacyKey !== undefined && legacyKey !== sourceTurnId) {
    const seen = traexSeenUserTurns.get(path);
    if (seen?.has(sourceTurnId)) seen.set(sourceTurnId, legacyKey);
  }
  const state = traexPendingAgentCache.get(path);
  if (!state || legacyKey === undefined || legacyKey === sourceTurnId) return;
  const legacy = state.turns.get(legacyKey);
  const native = state.turns.get(sourceTurnId);
  if (legacy) {
    const merged: TraexPendingAgentMessages = {
      ...legacy,
      ...native,
      agentItems: new Map(),
    };
    for (const [key, item] of [...(legacy.agentItems ?? []), ...(native?.agentItems ?? [])]) {
      rememberTraexAgentItem(merged, { id: key, phase: item.phase }, item.text, item.canonical, key);
    }
    state.turns.set(sourceTurnId, merged);
    state.turns.delete(legacyKey);
  }
  if (state.activeKey === legacyKey) state.activeKey = sourceTurnId;
}

function clearTraexPendingAgentMessages(path: string, sourceTurnId: string, legacyKey?: string): void {
  const state = traexPendingAgentCache.get(path);
  if (!state) return;
  state.turns.delete(sourceTurnId);
  if (legacyKey !== undefined) state.turns.delete(legacyKey);
  if (state.activeKey === sourceTurnId || state.activeKey === legacyKey) state.activeKey = undefined;
  if (state.turns.size === 0) traexPendingAgentCache.delete(path);
}

function rememberTraexAgentItem(
  pending: TraexPendingAgentMessages,
  item: { id?: unknown; phase?: unknown },
  text: string,
  canonical: boolean,
  fallbackId: string,
): void {
  const items = pending.agentItems ??= new Map();
  const key = typeof item.id === 'string' && item.id ? item.id : fallbackId;
  const existing = items.get(key);
  const phase = typeof item.phase === 'string' && item.phase ? item.phase : undefined;
  if (!existing?.canonical || canonical) {
    items.set(key, { text, phase: phase ?? existing?.phase, canonical: canonical || existing?.canonical === true });
  }
  if (items.size > TRAEX_PENDING_AGENT_ITEMS_PER_TURN_MAX) {
    const oldest = items.keys().next().value;
    if (oldest !== undefined) items.delete(oldest);
  }
}

/** Matches a commentary message that ENDS with a nothing-to-send sentinel
 *  (current or legacy token), optionally glued to trailing prose — the shape
 *  TRAE writes when the model replied via `botmux send` and kept only
 *  narration in the commentary phase. Captures the exact token so the
 *  synthesised final carries the same one the gate recognises. */
const TRAEX_TRAILING_SENTINEL_RE = new RegExp(
  `(${BRIDGE_NOTHING_TO_SEND_SENTINEL}|${BRIDGE_NO_REPLY_SENTINEL_LEGACY})\\s*$`,
);

function traexTrailingSentinel(message: string): string | undefined {
  return TRAEX_TRAILING_SENTINEL_RE.exec(message)?.[1];
}

/** Recover the final text for a SUCCESSFUL turn whose task_complete carried no
 *  last_agent_message. Sources in priority order:
 *   1. a final_answer-phase agent_message — the phase field guarantees it is
 *      the model's answer, not tool narration. Safe in BOTH modes;
 *   2. the last item_completed AgentMessage item — the 0.201.4+ assistant
 *      dialect (mirrors the UserMessage user dialect);
 *   3. the last phase-less agent_message — a dialect that dropped the phase
 *      field (cf. codex >= 0.146) makes commentary and final byte-identical,
 *      so the last one is the best candidate.
 *  Sources 2/3 are NOT phase-guaranteed: a candidate ending in the
 *  nothing-to-send sentinel is deliberate-silence narration (the model
 *  replied via `botmux send`), not an answer, so it is excluded from the
 *  answer candidates and used only for the sentinel synthesis below.
 *
 *  Deliberate silence synthesises the bare sentinel the fallback gate already
 *  treats as genuine silence — NON-ADOPT ONLY: adopt posts transcript text
 *  verbatim, so a synthesised bare token would leak the literal into Lark. */
function recoverTraexEmptyFinal(
  pending: TraexPendingAgentMessages | undefined,
  adoptMode: boolean,
): string {
  if (pending?.lastFinalAnswer?.trim()) return pending.lastFinalAnswer;
  const items = Array.from(pending?.agentItems?.values() ?? []).reverse();
  const finalItem = items.find(item => item.phase === 'final_answer' && item.text.trim());
  if (finalItem) return finalItem.text;
  const candidates: string[] = [];
  const candidateItem = items.find(item => !item.phase && item.text.trim());
  if (candidateItem) candidates.push(candidateItem.text);
  if (pending?.lastAgentMessageNoPhase?.trim()) candidates.push(pending.lastAgentMessageNoPhase);
  const answer = candidates.find(candidate => !traexTrailingSentinel(candidate));
  if (answer) return answer;
  if (adoptMode) return '';
  // No real answer candidate: recognise deliberate silence from whichever
  // tracked message carries the trailing sentinel (explicit commentary-phase
  // first, then the phase-less/item candidates).
  const commentary = items.find(item => item.phase && item.phase !== 'final_answer');
  for (const source of [pending?.lastCommentary ?? '', commentary?.text ?? '', ...candidates]) {
    const sentinel = traexTrailingSentinel(source);
    if (sentinel) return sentinel;
  }
  return '';
}

/** Upper bound on how far back readLatestTraexRuntime scans for the newest
 * model/effort. The newest turn_context sits near the tail, so this is only a
 * pathological-file guard (cf. #740): never synchronously parse a multi-GB
 * rollout on attach just to surface advisory runtime identity. */
const TRAEX_RUNTIME_SCAN_MAX_BYTES = 4 * 1024 * 1024;

function eventTimestampMs(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function* completeTraexRolloutRecords(
  text: string,
  fromOffset: number,
  sourceSessionId?: string,
): Generator<{ entry: any; offset: number; displayIndex?: number }> {
  for (const { line, lineStart: offset } of iterateJsonlLines(text, fromOffset)) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const completions = new Set(traexDisplayCompletions(entry?.payload, sourceSessionId));
    if (entry?.type === 'history_mutation' && completions.size > 0) {
      for (const [displayIndex, completion] of entry.payload.display_completions.entries()) {
        if (!completions.has(completion)
          || !['UserMessage', 'AgentMessage'].includes(completion.item?.type)) continue;
        yield {
          entry: {
            type: 'event_msg',
            timestamp: entry.timestamp,
            payload: { ...completion, type: 'item_completed' },
          },
          offset,
          displayIndex,
        };
      }
    }
    yield { entry, offset };
  }
}

/** Incrementally drain complete TRAE rollout lines.
 *
 * `task_complete` is intentionally emitted even when last_agent_message is
 * missing/empty: a silent successful turn still has to release a durable
 * delivery. A non-newline-terminated tail is never parsed, so a process crash
 * halfway through the terminal JSON object cannot manufacture completion.
 *
 * Terminal refinement on an empty `last_agent_message`:
 *   - a non-null `error` payload maps the event to `failed` (same shape as the
 *     Codex drainer) — traecli writes task_complete with
 *     last_agent_message=null AND error when the model endpoint fails, so the
 *     failure must not be read as a silent success;
 *   - otherwise the turn's assistant records (tracked across drain calls)
 *     recover a dropped final_answer, an item_completed AgentMessage item, or
 *     a phase-less agent_message, and recognise a trailing nothing-to-send
 *     sentinel on any of them as deliberate silence. The sentinel synthesis
 *     runs only in non-adopt mode: adopt posts transcript text verbatim, so a
 *     synthesised bare token would leak into Lark. */
export function drainTraexRollout(
  path: string,
  fromOffset: number,
  opts?: TraexDrainOptions,
): TraexDrainResult {
  const adoptMode = opts?.adoptMode === true;
  const probe = opts?.probe === true;
  const step = beginJsonlDrain(path, fromOffset);
  if (step.kind !== 'read') return { events: [], newOffset: step.newOffset, pendingTail: '' };
  const start = step.start;
  const { completeText, pendingTail, newOffset } = step.window;
  const sourceSessionId = traexSessionIdFromRolloutPath(path);

  const events: CodexBridgeEvent[] = [];
  const seenUserTurns = new Set<string>();
  const pendingUserMirrors: TraexDrainUserMirror[] = probe
    ? []
    : (traexPendingUserMirrors.get(path) ?? []).map(candidate => ({ ...candidate }));
  const claimUserTurn = (turnId: unknown): boolean => {
    if (typeof turnId !== 'string' || turnId.length === 0) return true;
    if (seenUserTurns.has(turnId)) return false;
    seenUserTurns.add(turnId);
    // Probes must not consume the persistent de-duplication claim that the
    // production drainer needs when it observes this same record later.
    return probe || claimTraexUserTurn(path, turnId);
  };
  const bindPreservedLegacyPredecessor = (turnId: string, base: {
    uuid: string; timestampMs: number; sourceSessionId?: string;
  }): boolean => {
    // A source-id CoT can be the first native evidence for a preserved
    // legacy-first turn when its item mirror is delayed or absent. Do not
    // steal a predecessor for a successor whose native user was already seen.
    const candidate = pendingUserMirrors.find(mirror => mirror.expected === 'item'
      && !mirror.sourceTurnId
      && mirror.preservedBeforeSuccessor);
    if (!candidate || !claimUserTurn(turnId)) return false;
    candidate.expected = 'terminal';
    candidate.sourceTurnId = turnId;
    if (!probe) bindTraexPendingAgentTurn(path, candidate.agentStateKey, turnId);
    events.push({
      ...base, uuid: `${base.uuid}:turn-bind`, kind: 'turn_bind', text: '', sourceTurnId: turnId,
    });
    return true;
  };
  let latestModel: string | undefined;
  let latestReasoningEffort: string | undefined;
  for (const { entry: obj, offset: lineStart, displayIndex } of completeTraexRolloutRecords(
    completeText, start, sourceSessionId,
  )) {
    const runtime = runtimeFromTurnContext(obj);
    latestModel = runtime?.model ?? latestModel;
    latestReasoningEffort = runtime?.reasoningEffort ?? latestReasoningEffort;
    const payload = obj?.payload;
    if (!payload || typeof payload !== 'object') continue;
    const base = {
      uuid: `${path}:${lineStart}${displayIndex !== undefined ? `:display:${displayIndex}` : ''}`,
      timestampMs: eventTimestampMs(obj.timestamp),
      ...(sourceSessionId ? { sourceSessionId } : {}),
    };
    const sourceTurnId = typeof payload.turn_id === 'string' && payload.turn_id.length > 0
      ? payload.turn_id
      : undefined;
    // The append-only history is TraeX's canonical model/tool timeline. Its
    // event_msg records mirror reasoning and tool completion, so consuming
    // those too would duplicate nodes. One mutation can carry parallel calls
    // or results; preserve their item order in one cosmetic event.
    if (!probe && obj.type === 'history_mutation') {
      const cotEntries = traexHistoryCotEntries(payload, sourceSessionId);
      if (cotEntries && cotEntries.length > 0) {
        if (sourceTurnId) bindPreservedLegacyPredecessor(sourceTurnId, base);
        events.push({ ...base, kind: 'cot', text: '', cotEntries, ...(sourceTurnId ? { sourceTurnId } : {}) });
      }
      continue;
    }
    if (obj.type === 'event_msg'
      && payload.type === 'user_message'
      && typeof payload.message === 'string') {
      const userText = payload.message;
      if (!sourceTurnId) {
        if (takeExpectedTraexUserMirror(pendingUserMirrors, 'legacy', userText, base.timestampMs)) continue;
      }
      if (userText && claimUserTurn(payload.turn_id)) {
        const preserveCollecting = shouldPreserveUnboundLegacyPredecessor(
          pendingUserMirrors, sourceTurnId, base.timestampMs,
        );
        events.push({
          ...base,
          kind: 'user',
          text: userText,
          ...(sourceTurnId ? { sourceTurnId } : {}),
          ...(preserveCollecting ? { preserveCollecting: true } : {}),
        });
        if (typeof payload.turn_id !== 'string' || payload.turn_id.length === 0) {
          pendingUserMirrors.push({
            text: userText,
            timestampMs: base.timestampMs,
            expected: 'item',
            eventIndex: events.length - 1,
            agentStateKey: base.uuid,
          });
        }
        if (!probe) traexPendingAgentTurns(path).activeKey = sourceTurnId ?? base.uuid;
      }
      continue;
    }
    if (obj.type === 'event_msg'
      && payload.type === 'item_completed') {
      const userText = itemCompletedUserText(payload.item);
      if (userText) {
        if (claimUserTurn(payload.turn_id)) {
          // Legacy user_message records did not always carry a turn id. When
          // the same drain also contains their 0.201.4 UserMessage mirror,
          // replace the uncorrelatable legacy event with the turn-addressable
          // item_completed event instead of starting two local turns.
          const expectedMirror = takeExpectedTraexUserMirror(
            pendingUserMirrors, 'item', userText, base.timestampMs,
          );
          const legacyIndex = expectedMirror?.eventIndex;
          if (legacyIndex !== undefined) {
            events[legacyIndex] = {
              ...events[legacyIndex],
              ...(sourceTurnId ? { sourceTurnId } : {}),
            };
          } else if (expectedMirror?.expected === 'item' && sourceTurnId) {
            events.push({ ...base, kind: 'turn_bind', text: '', sourceTurnId });
          } else if (!expectedMirror) {
            const preserveCollecting = shouldPreserveUnboundLegacyPredecessor(
              pendingUserMirrors, sourceTurnId, base.timestampMs,
            );
            events.push({
              ...base,
              kind: 'user',
              text: userText,
              ...(sourceTurnId ? { sourceTurnId } : {}),
              ...(preserveCollecting ? { preserveCollecting: true } : {}),
            });
          }
          if (expectedMirror?.expected === 'item' && sourceTurnId) {
            if (!probe) bindTraexPendingAgentTurn(path, expectedMirror.agentStateKey, sourceTurnId);
            pendingUserMirrors.push({
              text: userText,
              timestampMs: base.timestampMs,
              expected: 'terminal',
              sourceTurnId,
              agentStateKey: sourceTurnId,
            });
          }
          if (!expectedMirror && sourceTurnId) {
            pendingUserMirrors.push({
              text: userText,
              timestampMs: base.timestampMs,
              expected: 'legacy',
              sourceTurnId,
            });
          }
          if (!probe && !expectedMirror) {
            traexPendingAgentTurns(path).activeKey = sourceTurnId ?? base.uuid;
          }
        } else if (!probe && sourceTurnId) {
          const legacyKey = traexSeenUserTurns.get(path)?.get(sourceTurnId);
          const mirrorIndex = pendingUserMirrors.findIndex(mirror =>
            legacyKey !== undefined && mirror.agentStateKey === legacyKey && mirror.text === userText);
          if (mirrorIndex >= 0) {
            const mirror = pendingUserMirrors.splice(mirrorIndex, 1)[0];
            bindTraexPendingAgentTurn(path, mirror.agentStateKey, sourceTurnId);
            pendingUserMirrors.push({
              ...mirror,
              expected: 'terminal',
              sourceTurnId,
            });
          }
        }
      } else if (!probe) {
        // Assistant-side mirror of the UserMessage dialect: TraeX 0.201.4+
        // can emit the assistant message as an item_completed AgentMessage
        // item. Track the last one as a final candidate (the sentinel guard
        // at task_complete distinguishes a real answer from deliberate-silence
        // narration). Tool results and other item types yield no text.
        const agentText = itemCompletedAgentText(payload.item);
        if (agentText) {
          const pending = traexPendingAgentState(path, sourceTurnId);
          rememberTraexAgentItem(pending, payload.item, agentText, displayIndex !== undefined, base.uuid);
        }
      }
      continue;
    }
    // agent_message records are narration (commentary) or the produced final
    // (final_answer). They are NOT turn boundaries — only task_complete is —
    // so they are tracked per turn and consulted when the terminal arrives
    // with an empty/missing last_agent_message. A dialect that dropped the
    // `phase` field (cf. codex >= 0.146) writes phase-less records that are
    // byte-identical for commentary and final; the last one is the best final
    // candidate, tracked separately so an explicit commentary-phase message
    // keeps its deliberate-silence semantics.
    if (!probe
      && obj.type === 'event_msg'
      && payload.type === 'agent_message'
      && typeof payload.message === 'string'
      && payload.message.length > 0) {
      const pending = traexPendingAgentState(path, sourceTurnId);
      if (payload.phase === 'final_answer') pending.lastFinalAnswer = payload.message;
      else if (typeof payload.phase !== 'string' || payload.phase.length === 0) {
        pending.lastAgentMessageNoPhase = payload.message;
      } else pending.lastCommentary = payload.message;
      continue;
    }
    if (obj.type === 'event_msg'
      && payload.type === 'task_complete'
      && typeof payload.turn_id === 'string'
      && payload.turn_id.length > 0) {
      const terminalMirror = takeTraexUserMirrorAtTerminal(
        pendingUserMirrors,
        payload.turn_id,
        seenUserTurns.has(payload.turn_id) || traexSeenUserTurns.get(path)?.has(payload.turn_id) === true,
        traexSeenUserTurns.get(path)?.get(payload.turn_id),
      );
      if (terminalMirror && !terminalMirror.sourceTurnId) {
        if (!probe) claimTraexUserTurn(path, payload.turn_id, terminalMirror.agentStateKey);
        seenUserTurns.add(payload.turn_id);
      }
      if (!probe) bindTraexPendingAgentTurn(path, terminalMirror?.agentStateKey, payload.turn_id);
      const pending = traexPendingAgentCache.get(path)?.turns.get(payload.turn_id);
      const failed = payload.error !== null && payload.error !== undefined;
      const rawFinal = typeof payload.last_agent_message === 'string'
        ? payload.last_agent_message
        : '';
      let text = rawFinal;
      if (!failed && rawFinal.trim().length === 0) {
        // TRAE wrote no final for a successful turn. Recover, in order:
        //   1. a final_answer-phase agent_message — TRAE dropped the final it
        //      actually produced (the phase field guarantees it is an answer,
        //      not tool narration). Safe in BOTH modes: it is the model's real
        //      answer, and adopt posts transcript text verbatim anyway;
        //   2. the last item_completed AgentMessage item (0.201.4+ assistant
        //      dialect) or the last phase-less agent_message (phase-dropped
        //      dialect) — the model's real transcript answer, safe in BOTH
        //      modes, unless it ends in the nothing-to-send sentinel (then it
        //      is deliberate-silence narration, not an answer);
        //   3. a commentary/candidate message ending in the nothing-to-send
        //      sentinel — the model deliberately stayed silent (it replied via
        //      `botmux send`), so synthesise the bare sentinel the fallback
        //      gate already treats as genuine silence instead of tripping the
        //      misleading "completed but empty" diagnostic. NON-ADOPT ONLY:
        //      adopt posts transcript text verbatim, so a synthesised bare
        //      token would leak the literal into Lark.
        text = recoverTraexEmptyFinal(pending, adoptMode);
      }
      if (!probe) clearTraexPendingAgentMessages(path, payload.turn_id);
      if (terminalMirror?.expected === 'item'
        && !terminalMirror.sourceTurnId
        && terminalMirror.preservedBeforeSuccessor) {
        claimUserTurn(payload.turn_id);
        events.push({
          ...base, uuid: `${base.uuid}:turn-bind`, kind: 'turn_bind', text: '', sourceTurnId: payload.turn_id,
        });
      }
      events.push({
        ...base,
        kind: 'assistant_final',
        text,
        ...(sourceTurnId ? { sourceTurnId } : {}),
        // A non-null error means the turn FAILED (e.g. the model endpoint
        // connection failed before any response). Mirror the Codex drainer:
        // classify as failed with a safe code/summary so the worker surfaces
        // the real reason instead of an empty-final alert.
        ...(failed ? {
          terminalStatus: 'failed' as const,
          terminalErrorCode: isExactCodexOutputLimitError(payload.error)
            ? CODEX_OUTPUT_LIMIT_ERROR_CODE
            : codexTaskFailureCode(payload.error),
          terminalErrorSummary: safeFailureSummary(payload.error),
        } : {}),
      });
      continue;
    }
    // Observed cancellation records write `turn_aborted`
    // (turn_id, reason, completed_at, duration_ms) and no
    // task_complete. Side effects may already have happened, so the safe
    // durable outcome is ambiguous rather than failed/completed.
    if (obj.type === 'event_msg'
      && payload.type === 'turn_aborted'
      && typeof payload.turn_id === 'string'
      && payload.turn_id.length > 0) {
      const terminalMirror = takeTraexUserMirrorAtTerminal(
        pendingUserMirrors,
        payload.turn_id,
        seenUserTurns.has(payload.turn_id) || traexSeenUserTurns.get(path)?.has(payload.turn_id) === true,
        traexSeenUserTurns.get(path)?.get(payload.turn_id),
      );
      if (terminalMirror && !terminalMirror.sourceTurnId) {
        if (!probe) claimTraexUserTurn(path, payload.turn_id, terminalMirror.agentStateKey);
        seenUserTurns.add(payload.turn_id);
      }
      if (!probe) {
        clearTraexPendingAgentMessages(path, payload.turn_id, terminalMirror?.agentStateKey);
      }
      if (terminalMirror?.expected === 'item'
        && !terminalMirror.sourceTurnId
        && terminalMirror.preservedBeforeSuccessor) {
        claimUserTurn(payload.turn_id);
        events.push({
          ...base, uuid: `${base.uuid}:turn-bind`, kind: 'turn_bind', text: '', sourceTurnId: payload.turn_id,
        });
      }
      events.push({
        ...base,
        kind: 'assistant_final',
        text: '',
        terminalStatus: 'ambiguous',
        terminalErrorCode: rolloutAbortErrorCode('traex_turn_aborted', payload.reason),
        ...(sourceTurnId ? { sourceTurnId } : {}),
      });
    }
  }
  if (!probe) rememberTraexUserMirrors(path, pendingUserMirrors.map(({ eventIndex: _eventIndex, ...candidate }) => candidate));
  return {
    events,
    newOffset,
    pendingTail,
    ...(latestModel ? { latestModel } : {}),
    ...(latestReasoningEffort ? { latestReasoningEffort } : {}),
  };
}

/** Read the current TRAE runtime from complete rollout records without
 * retaining the full transcript in memory. Each field is latest-wins because
 * `/model` and `/effort` can change independently in a long-lived session.
 *
 * Scans BACKWARD in fixed-size chunks and stops as soon as both fields are
 * resolved — the newest `turn_context` is near the tail, so a live session
 * touches only the last chunk. A hard byte cap bounds the pathological case
 * where a field never appears (same guard rationale as #740's
 * MAX_USAGE_TRANSCRIPT_BYTES): runtime identity is advisory and must never
 * synchronously parse a multi-GB rollout on attach. A non-newline-terminated
 * trailing partial is excluded via baselineJsonlCursor, so a crash mid-write
 * cannot surface a half-written model — matching drainTraexRollout. */
export function readLatestTraexRuntime(path: string): TraexRuntimeSnapshot {
  return readLatestRolloutRuntime(path, TRAEX_RUNTIME_SCAN_MAX_BYTES);
}

function normaliseInputText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Submit-confirmation probe: only a complete user event record appended after
 * `fromOffset` can match. Read-only — drains with `probe` so
 * it never mutates the per-turn agent_message cache the production drainer
 * relies on (a re-drain of the same live rollout at a different offset must
 * not clear pending turn state). Not currently wired into the production
 * submit-confirmation path; kept as a tested probe. */
export function traexRolloutHasUserInputSince(
  path: string,
  fromOffset: number,
  expectedText: string,
): boolean {
  const expected = normaliseInputText(expectedText);
  return drainTraexRollout(path, fromOffset, { probe: true }).events.some(event =>
    event.kind === 'user' && normaliseInputText(event.text) === expected,
  );
}

// -- history.jsonl submit-confirmation (submit-time truth) ------------------
//
// TRAE writes ~/.trae/cli/history.jsonl at SUBMIT time — one JSON line
// {session_id, ts, text} per successful user submit, byte-identical to Codex's
// format. This is the correct submit-confirmation source: a type-ahead message
// parked while a turn runs is logged here immediately, whereas the per-session
// rollout only records it when the running turn dequeues it (which can exceed
// the worker's confirmation deadline → false "submission couldn't be confirmed"
// warning). Because history.jsonl is a single global file shared by every TRAE
// pane under one TRAE_HOME, a same-text line may be written by a concurrent
// sibling pane; callers pass an `acceptSid` ownership filter to skip a foreign
// pane's line. Mirrors the codex.ts writeInput verification path exactly.

export interface TraexHistoryMatch {
  found: boolean;
  cliSessionId?: string;
}

/** Optional ownership filter for a shared-history match: accept a same-text
 *  line only when its session id is one the owning pid actually holds open.
 *  Re-evaluated on every call so a lazily-opened owned rollout fd that appears
 *  AFTER its history line can still be accepted on a later poll. */
export type TraexHistorySidFilter = (cliSessionId: string | undefined) => boolean;

function readTraexHistorySid(parsed: unknown): string | undefined {
  return parsed && typeof parsed === 'object' && typeof (parsed as any).session_id === 'string'
    ? (parsed as any).session_id
    : undefined;
}

/** Scan the byte delta appended to history.jsonl since `fromByte` for a line
 *  whose decoded `text` exactly matches `expectedText` (newline-normalised).
 *  Never parses a non-newline-terminated tail, so a half-written line can't
 *  manufacture a false match — a later poll sees the completed entry. */
export function traexHistoryMatchDelta(
  path: string,
  fromByte: number,
  expectedText: string,
  acceptSid?: TraexHistorySidFilter,
): TraexHistoryMatch {
  if (!existsSync(path)) return { found: false };
  let size: number;
  try { size = statSync(path).size; } catch { return { found: false }; }
  if (size <= fromByte) return { found: false };
  const len = size - fromByte;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, len, fromByte); } finally { closeSync(fd); }
  const delta = buf.toString('utf8');
  // Drop a trailing partial line (no newline yet) — it may still be mid-write.
  const lines = delta.endsWith('\n') ? delta.split('\n') : delta.split('\n').slice(0, -1);
  const expected = normaliseInputText(expectedText);
  for (const line of lines) {
    if (line.length === 0) continue;
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (typeof parsed?.text !== 'string') continue;
    if (normaliseInputText(parsed.text) !== expected) continue;
    const cliSessionId = readTraexHistorySid(parsed);
    // Skip a same-text line owned by a DIFFERENT pane (shared-TRAE_HOME
    // collision). Keep scanning — the owned line may be later in this delta
    // or arrive on a later poll.
    if (acceptSid && !acceptSid(cliSessionId)) continue;
    return { found: true, cliSessionId };
  }
  return { found: false };
}

/** Current byte size of history.jsonl (0 when absent), captured before a paste
 *  so the confirmation scan only considers lines this submit appends. */
export function traexHistorySize(path: string): number {
  if (!path || !existsSync(path)) return 0;
  try { return statSync(path).size; } catch { return 0; }
}

function matchTraexRolloutPath(target: string): { path: string; cliSessionId: string } | undefined {
  if (!target.endsWith('.jsonl')) return undefined;
  // Accept both the default layout (~/.trae/cli/sessions/...) and any
  // TRAE_HOME override the user may have configured.
  if (!target.includes('/sessions/') && !target.includes('.trae')) {
    // Fast reject: the path has neither the sessions subdir nor the default
    // TRAE home marker. Avoid false positives against Codex rollouts which
    // share the same rollout-*.jsonl filename shape.
    if (!target.includes('/cli/sessions/')) return undefined;
  }
  const sid = traexSessionIdFromRolloutPath(target);
  if (!sid) return undefined;
  return { path: target, cliSessionId: sid };
}

function traexRolloutMeta(path: string): {
  kind: TraexRolloutKind;
  startedAtMs?: number;
} {
  const cached = traexRolloutMetaCache.get(path);
  if (cached) return cached;

  let size: number;
  try { size = statSync(path).size; } catch { return { kind: 'empty' }; }
  if (size <= 0) return { kind: 'empty' };

  const length = Math.min(size, TRAEX_SESSION_META_SCAN_MAX_BYTES);
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    bytesRead = readSync(fd, buffer, 0, length, 0);
  } catch {
    return { kind: 'pending' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  const content = buffer.subarray(0, bytesRead);
  const newline = content.indexOf(0x0a);
  if (newline < 0) return { kind: 'pending' };

  let entry: any;
  try { entry = JSON.parse(content.subarray(0, newline).toString('utf8')); } catch {
    return { kind: 'pending' };
  }
  if (entry?.type !== 'session_meta' || !entry.payload || typeof entry.payload !== 'object') {
    const result = { kind: 'legacy' as const };
    traexRolloutMetaCache.set(path, result);
    return result;
  }

  const payload = entry.payload;
  const threadSource = payload.thread_source;
  let kind: TraexRolloutKind = 'legacy';
  if (isInternalCodexSessionMeta(payload)) {
    kind = 'internal';
  } else if (threadSource === 'user') {
    kind = 'user';
  }
  const rawTimestamp = typeof payload.timestamp === 'string'
    ? payload.timestamp
    : typeof entry.timestamp === 'string'
      ? entry.timestamp
      : undefined;
  const parsedTimestamp = rawTimestamp ? Date.parse(rawTimestamp) : NaN;
  const result = {
    kind,
    ...(Number.isFinite(parsedTimestamp) ? { startedAtMs: parsedTimestamp } : {}),
  };
  if (traexRolloutMetaCache.size >= 512) {
    const oldest = traexRolloutMetaCache.keys().next().value;
    if (oldest) traexRolloutMetaCache.delete(oldest);
  }
  traexRolloutMetaCache.set(path, result);
  return result;
}

function traexRolloutRefs(targets: Iterable<string>): TraexRolloutRef[] {
  const refs = new Map<string, TraexRolloutRef>();
  for (const target of targets) {
    const hit = matchTraexRolloutPath(target);
    if (!hit || refs.has(hit.path)) continue;
    refs.set(hit.path, { ...hit, ...traexRolloutMeta(hit.path) });
  }
  return [...refs.values()];
}

function newestTraexRollout(refs: TraexRolloutRef[]): TraexRolloutRef | undefined {
  const timestamped = refs.filter(
    (ref): ref is TraexRolloutRef & { startedAtMs: number } => ref.startedAtMs !== undefined,
  );
  if (timestamped.length === 0) return undefined;
  const maxStartedAt = Math.max(...timestamped.map(ref => ref.startedAtMs));
  const newest = timestamped.filter(ref => ref.startedAtMs === maxStartedAt);
  return newest.length === 1 ? newest[0] : undefined;
}

function selectableTraexRollouts(refs: TraexRolloutRef[]): TraexRolloutRef[] {
  const userRefs = refs.filter(ref => ref.kind === 'user');
  if (userRefs.length > 0) return userRefs;
  const legacyRefs = refs.filter(ref => ref.kind === 'legacy');
  if (legacyRefs.length > 0) return legacyRefs;
  return [];
}

function selectTraexRollout(
  refs: TraexRolloutRef[],
  preferredSessionId?: string,
): TraexRolloutRef | undefined {
  const candidates = selectableTraexRollouts(refs);
  if (candidates.length === 0) return undefined;

  const preferred = preferredSessionId
    ? candidates.find(ref => ref.cliSessionId.toLowerCase() === preferredSessionId.toLowerCase())
    : undefined;
  const newest = newestTraexRollout(candidates);
  if (preferred) {
    if (newest?.startedAtMs !== undefined
      && preferred.startedAtMs !== undefined
      && newest.startedAtMs > preferred.startedAtMs) {
      return newest;
    }
    return preferred;
  }
  if (candidates.length === 1) return candidates[0];
  return newest;
}

/** Find the visible top-level rollout an externally-running TRAE process owns.
 *  TRAE can keep the parent rollout and internal guardian/subagent rollouts open
 *  in the same process. Internal rollouts are never adoptable. When a current
 *  top-level session is supplied it remains preferred unless a newer top-level
 *  user rollout proves a real in-process `/new` rotation. */
export function findTraexRolloutByPid(
  pid: number,
  preferredSessionId?: string,
): { path: string; cliSessionId: string } | undefined {
  const targets = listProcessOpenFiles(pid);
  if (!targets) return undefined;
  const selected = selectTraexRollout(traexRolloutRefs(targets), preferredSessionId);
  return selected ? { path: selected.path, cliSessionId: selected.cliSessionId } : undefined;
}

/** Lowercased set of TRAE session ids whose rollout the pid holds open. The
 *  ownership gate for a shared-history.jsonl submit match: only a sid this pid
 *  actually owns is safe to accept, so a concurrent sibling pane's identical
 *  text can't hand back a foreign session id. Empty Set = pid holds no TRAE
 *  rollout; undefined = fd enumeration unavailable (callers must treat undefined
 *  as "cannot prove ownership" — fail closed, do not bind). Mirrors
 *  findCodexRolloutSetByPid. */
export function findTraexRolloutSetByPid(pid: number): Set<string> | undefined {
  const targets = listProcessOpenFiles(pid);
  if (!targets) return undefined;
  const set = new Set<string>();
  for (const ref of selectableTraexRollouts(traexRolloutRefs(targets))) {
    set.add(ref.cliSessionId.toLowerCase());
  }
  return set;
}

/** Pure ownership decision: is `cliSessionId` one of the rollouts the observed
 *  pid holds open? `ownedRollouts` is the lowercased sid set from
 *  findTraexRolloutSetByPid (undefined when fd enumeration was unavailable).
 *  FAIL CLOSED — a missing set or a non-member id returns false so the caller
 *  never binds the bridge (or persists a resume id) it can't prove the pid owns.
 *  Extracted so the exact predicate the worker's persist/attach gates use is
 *  unit-testable without a live pid. Byte-for-byte the same predicate as
 *  codexHistorySidIsOwned, so it delegates. A call-time wrapper rather than a
 *  `const` alias: reading the import at module load makes this module fail to
 *  load under any partial mock of codex-transcript. */
export function traexHistorySidIsOwned(
  cliSessionId: string,
  ownedRollouts: Set<string> | undefined,
): boolean {
  return codexHistorySidIsOwned(cliSessionId, ownedRollouts);
}

function readTraexDirectory(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isCanonicalTraexRolloutPath(
  path: string,
  sessionsRoot: string,
): boolean {
  const rel = relative(sessionsRoot, path);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return false;
  const parts = rel.split(sep);
  return parts.length === 4
    && TRAEX_YEAR_DIR_RE.test(parts[0]!)
    && TRAEX_MONTH_DIR_RE.test(parts[1]!)
    && TRAEX_DAY_DIR_RE.test(parts[2]!)
    && parts[3]!.startsWith('rollout-');
}

function findIndexedTraexRollout(
  cliSessionId: string,
  sessionsRoot: string,
): string | undefined {
  const rows = withTraeDb((db) => db.prepare(
    'SELECT rollout_path AS rolloutPath FROM threads WHERE id = ? LIMIT 1',
  ).all(cliSessionId) as { rolloutPath?: string }[]) ?? [];
  const path = rows[0]?.rolloutPath;
  if (typeof path !== 'string'
    || !isCanonicalTraexRolloutPath(path, sessionsRoot)
    || traexSessionIdFromRolloutPath(path)?.toLowerCase() !== cliSessionId.toLowerCase()) {
    return undefined;
  }
  try {
    return statSync(path).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

function findTraexRolloutInDateTree(sessionsRoot: string, cliSessionId: string): string | undefined {
  const years = readTraexDirectory(sessionsRoot)
    .filter((entry) => entry.isDirectory() && TRAEX_YEAR_DIR_RE.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  for (const year of years) {
    const yearPath = join(sessionsRoot, year.name);
    const months = readTraexDirectory(yearPath)
      .filter((entry) => entry.isDirectory() && TRAEX_MONTH_DIR_RE.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name));
    for (const month of months) {
      const monthPath = join(yearPath, month.name);
      const days = readTraexDirectory(monthPath)
        .filter((entry) => entry.isDirectory() && TRAEX_DAY_DIR_RE.test(entry.name))
        .sort((a, b) => b.name.localeCompare(a.name));
      for (const day of days) {
        const dayPath = join(monthPath, day.name);
        const rollout = readTraexDirectory(dayPath)
          .filter((entry) => entry.isFile() && entry.name.startsWith('rollout-'))
          // ISO timestamps are embedded in the filename, so descending name
          // order selects the newest resume segment within one day.
          .sort((a, b) => b.name.localeCompare(a.name))
          .find((entry) => traexSessionIdFromRolloutPath(entry.name)?.toLowerCase()
            === cliSessionId.toLowerCase());
        if (rollout) return join(dayPath, rollout.name);
      }
    }
  }
  return undefined;
}

function recordTraexRolloutLookupMiss(key: string, nowMs: number): void {
  const previous = traexRolloutLookupMisses.get(key);
  const backoffMs = previous
    ? Math.min(previous.backoffMs * 2, TRAEX_ROLLOUT_LOOKUP_MAX_BACKOFF_MS)
    : TRAEX_ROLLOUT_LOOKUP_INITIAL_BACKOFF_MS;
  // Refresh insertion order so the bounded map evicts the least-recent miss.
  traexRolloutLookupMisses.delete(key);
  traexRolloutLookupMisses.set(key, {
    nextFilesystemScanAtMs: nowMs + backoffMs,
    backoffMs,
  });
  if (traexRolloutLookupMisses.size > TRAEX_ROLLOUT_LOOKUP_MISS_CACHE_MAX) {
    const oldest = traexRolloutLookupMisses.keys().next().value as string | undefined;
    if (oldest !== undefined) traexRolloutLookupMisses.delete(oldest);
  }
}

/** Locate the rollout file for a given TRAE session UUID.
 *
 * TRAE's `threads` table is the authoritative session→path index. Older TRAE
 * versions may not expose `rollout_path`, so lookup degrades to the documented
 * `sessions/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl` tree. Newer releases may
 * append `_<first-turn-id>` after the stable sid for a resumed segment. The
 * fallback never
 * descends into rollout sidecars (`*.artifacts`, `tool-results`,
 * `rollout-blobs`), whose contents cannot be top-level sessions and may span
 * gigabytes. Repeated fallback misses are backed off, while the cheap indexed
 * lookup remains live on every late-attach tick. */
export function findTraexRolloutBySessionId(cliSessionId: string): string | undefined {
  if (!cliSessionId) return undefined;
  const sessionsRoot = traeSessionsRoot();
  const missKey = `${sessionsRoot}\0${cliSessionId.toLowerCase()}`;

  const indexed = findIndexedTraexRollout(cliSessionId, sessionsRoot);
  if (indexed) {
    traexRolloutLookupMisses.delete(missKey);
    return indexed;
  }
  if (!existsSync(sessionsRoot)) return undefined;

  const nowMs = Date.now();
  const miss = traexRolloutLookupMisses.get(missKey);
  if (miss && nowMs < miss.nextFilesystemScanAtMs) return undefined;

  const scanned = findTraexRolloutInDateTree(sessionsRoot, cliSessionId);
  if (scanned) {
    traexRolloutLookupMisses.delete(missKey);
    return scanned;
  }
  recordTraexRolloutLookupMiss(missKey, nowMs);
  return undefined;
}


/** Find the newest TRAE native session whose first prompt contains Botmux's
 *  session id. This mirrors Codex's history.jsonl bridge, but TRAE keeps the
 *  mapping in the `threads` SQLite table. It is intentionally best-effort:
 *  callers fall back to treating `sessionId` as a native id when unavailable. */
export function findTraexSessionIdByBotmuxSessionId(botmuxSessionId: string): string | undefined {
  if (!botmuxSessionId) return undefined;
  return withTraeDb((db) => {
    const rows = db.prepare(
      'SELECT id, first_user_message AS firstMessage FROM threads ORDER BY created_at DESC LIMIT 200',
    ).all() as { id?: string; firstMessage?: string }[];
    for (const r of rows) {
      if (typeof r.id === 'string'
        && typeof r.firstMessage === 'string'
        && r.firstMessage.includes(botmuxSessionId)) {
        return r.id;
      }
    }
    return undefined;
  }) ?? undefined;
}
