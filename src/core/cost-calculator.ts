/**
 * Session cost calculator — computes token usage from JSONL logs.
 */
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, statSync, type Stats } from 'node:fs';
import { logger } from '../utils/logger.js';
import type { CliId } from '../adapters/cli/types.js';
import { findAidenLatestCheckpointByBotmuxSessionId, findAidenLatestCheckpointBySessionId } from '../services/aiden-checkpoints.js';
import {
  __resetTranscriptResolverCacheForTest,
  cachedTranscriptPathLookup,
  resolveSessionTranscriptPath,
} from '../services/transcript-resolver.js';
import { scanJsonlFromFd, scanJsonlFromOffset, type JsonlCursor } from '../services/jsonl-cursor.js';
import {
  isMeaningfulQueuedCommand,
  isMeaningfulUserEvent,
  type TranscriptEvent,
} from '../services/claude-transcript.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  model: string;
  turns: number;
}

export interface SessionTokenUsage extends SessionCost {
  in: number;
  out: number;
}

/** Latest Context Usage reported by the Agent CLI. A missing window means the
 * CLI reported usage but not its model's context capacity. `percentUsed`, when
 * present, is produced by the source parser from native facts and remains
 * consistent with the displayed measurement; the card renderer never infers
 * it. */
export interface SessionContextUsage {
  usedTokens: number;
  windowTokens?: number;
  percentUsed?: number;
}

/** Card-facing usage snapshot. Context is latest-turn state while Token Usage
 * is cumulative for the Session; neither value is inferred from the other.
 * `turnTokens` is the delta for the latest user turn (cumulative since the last
 * user message) — small, matches what the CLI's own TUI shows for "this turn",
 * whereas `tokens` is the whole-session cumulative (cache-inclusive, large). */
export interface SessionUsageSnapshot {
  context: SessionContextUsage | null;
  tokens: SessionTokenUsage | null;
  turnTokens: { in: number; out: number } | null;
}

export interface SessionTokenUsageQuery {
  cliId?: CliId | 'unknown';
  sessionId: string;
  cliSessionId?: string;
  cwd?: string;
  /** Owning bot's Lark app id — lets the transcript resolver find sandboxed
   *  (CLI-data-redirected) bots' transcripts under BOT_HOME. */
  larkAppId?: string;
  /** Bypass the reparse throttle (stat short-circuit and incremental folding
   *  still apply). Use at low-frequency exact points like ledger/card snapshots. */
  fresh?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function getSessionJsonlPath(sessionId: string, cwd: string): string | null {
  return resolveSessionTranscriptPath({ cliId: 'claude-code', sessionId, cwd })?.path ?? null;
}

export function getSessionCost(sessionId: string, cwd: string): SessionCost | null {
  const jsonlPath = getSessionJsonlPath(sessionId, cwd);
  if (!jsonlPath) return null;
  const read = readSessionTokenAggregateCached(jsonlPath, 'claude');
  if (!read) return null;
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, model, turns } = read.agg;
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, model, turns };
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function pickNum(obj: any, keys: readonly string[]): number {
  if (!obj || typeof obj !== 'object') return 0;
  for (const key of keys) {
    const value = num(obj[key]);
    if (value) return value;
  }
  return 0;
}

interface PartitionedInputTokens {
  rawInputTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

/** Partition a provider's cache-inclusive input total into mutually exclusive
 *  accounting buckets. Cache read consumes the raw total first, then cache
 *  creation consumes only the remainder; malformed counters cannot make the
 *  three buckets exceed the provider's raw input total. */
function partitionInclusiveInputTokens(
  rawInput: number,
  reportedCacheRead: number,
  reportedCacheCreate: number,
): PartitionedInputTokens {
  const rawInputTokens = Math.max(0, rawInput);
  const cacheReadTokens = Math.min(rawInputTokens, Math.max(0, reportedCacheRead));
  const afterCacheRead = rawInputTokens - cacheReadTokens;
  const cacheCreateTokens = Math.min(afterCacheRead, Math.max(0, reportedCacheCreate));
  return {
    rawInputTokens,
    inputTokens: afterCacheRead - cacheCreateTokens,
    cacheReadTokens,
    cacheCreateTokens,
  };
}

function extractNativeUsage(entry: any): { usage: any; model?: string } | null {
  const candidates = [
    { usage: entry?.message?.usage, model: entry?.message?.model },
    { usage: entry?.message?.usageMetadata, model: entry?.message?.model },
    {
      usage: entry?.message?.message?.response_meta?.usage,
      model: entry?.message?.message?.extra?._source_model ?? entry?.message?.message?.extra?.trae_extra_info?.model,
    },
    { usage: entry?.payload?.usage, model: entry?.payload?.model },
    { usage: entry?.payload?.usageMetadata, model: entry?.payload?.model },
    { usage: entry?.response?.usage, model: entry?.response?.model },
    { usage: entry?.response?.usageMetadata, model: entry?.response?.model },
    { usage: entry?.usage, model: entry?.model },
    { usage: entry?.usageMetadata, model: entry?.model },
  ];
  for (const c of candidates) {
    if (c.usage && typeof c.usage === 'object') return c;
  }
  return null;
}

function extractCodexTokenCountUsage(entry: any): SessionTokenUsage | null {
  if (entry?.type !== 'event_msg' || entry?.payload?.type !== 'token_count') return null;
  const u = entry.payload?.info?.total_token_usage;
  if (!u || typeof u !== 'object') return null;
  // Codex-compatible token_count snapshots define input_tokens as the whole
  // prompt-side total: cached tokens are a subset, not an additional bucket.
  // Keep the raw total in `in` for the dashboard, while the accounting fields
  // are mutually exclusive so ledger consumers can safely sum them.
  const outputTokens = pickNum(u, ['output_tokens', 'outputTokens']);
  const { rawInputTokens, inputTokens, cacheReadTokens, cacheCreateTokens } = partitionInclusiveInputTokens(
    pickNum(u, ['input_tokens', 'inputTokens']),
    pickNum(u, ['cached_input_tokens', 'cachedInputTokens', 'cache_read_input_tokens', 'cacheReadInputTokens']),
    pickNum(u, ['cache_creation_input_tokens', 'cacheCreationInputTokens', 'cache_write_input_tokens', 'cacheWriteInputTokens']),
  );
  return {
    in: rawInputTokens,
    out: outputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    model: '',
    turns: 0,
  };
}

function extractCodexContextUsage(entry: any): SessionContextUsage | null {
  if (entry?.type !== 'event_msg' || entry?.payload?.type !== 'token_count') return null;
  const info = entry.payload?.info;
  const last = info?.last_token_usage;
  if (!last || typeof last !== 'object') return null;
  // Codex's native absolute gauge is last_token_usage.total_tokens. Cached
  // input is already a subset of input and must never be added again.
  const totalTokens = pickNum(last, ['total_tokens', 'totalTokens']);
  const usedTokens = totalTokens > 0
    ? totalTokens
    : pickNum(last, ['input_tokens', 'inputTokens']);
  if (usedTokens <= 0) return null;
  const windowTokens = pickNum(info, ['model_context_window', 'modelContextWindow']);
  // This card reports raw Context Usage, so keep the percentage consistent
  // with the displayed numerator/denominator. Codex's TUI separately exposes
  // a "user-controllable remaining" meter that subtracts fixed baseline
  // prompts/tools; that is a different metric and does not belong here.
  const percentUsed = windowTokens > 0
    ? Math.round(Math.max(0, Math.min(1, usedTokens / windowTokens)) * 100)
    : undefined;
  return {
    usedTokens,
    ...(windowTokens > 0 ? { windowTokens } : {}),
    ...(percentUsed !== undefined ? { percentUsed } : {}),
  };
}

interface TokenUsageAggregate {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  model: string;
  turns: number;
  latestCodexUsage: SessionTokenUsage | null;
  latestContextUsage: SessionContextUsage | null;
  latestCodexUsageSource: UsageSourceRecord | null;
  latestContextUsageSource: UsageSourceRecord | null;
  modelSource: UsageSourceRecord | null;
  /** Prompt-side (input + cache) and output tokens accumulated for the CURRENT
   *  user turn — reset when a new user message is seen (Claude). Lets the card
   *  show a small "this turn" delta alongside the large cumulative total. */
  turnInputTokens: number;
  turnOutputTokens: number;
}

/** Per-CLI transcript dialect. Each kind only counts the events that dialect
 *  defines as billable turns — no cross-CLI guessing on usage-shaped lines. */
type UsageKind = 'claude' | 'codex' | 'coco' | 'pi' | 'generic';

interface UsageSourceRecord {
  offset: number;
}

const CODEX_USAGE_SOURCE_RECORD_MAX_BYTES = 64 * 1024;

function sourceRecordForLine(line: string, lineStart: number | undefined): UsageSourceRecord | null {
  if (lineStart === undefined || lineStart < 0) return null;
  if (Buffer.byteLength(line, 'utf8') > CODEX_USAGE_SOURCE_RECORD_MAX_BYTES) return null;
  return {
    offset: lineStart,
  };
}

type UsageSourceRecordGetter = () => UsageSourceRecord | null;

function usageKindForCli(cliId: SessionTokenUsageQuery['cliId']): UsageKind {
  switch (cliId) {
    case 'claude-code':
    case 'seed':
    case 'relay':
      return 'claude';
    case 'codex':
    // TRAE rollouts are byte-identical to Codex (see traex-transcript.ts):
    // token_count events carry the cumulative totals, and the active model
    // rides on turn_context/session_meta payloads. The generic fold picked up
    // the tokens but never the model, so traex ledger records shipped with
    // model "" (consumers like kaboo fall back to "unknown").
    case 'traex':
      return 'codex';
    case 'coco':
      return 'coco';
    case 'pi':
      return 'pi';
    default:
      return 'generic';
  }
}

function newTokenUsageAggregate(): TokenUsageAggregate {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    model: '',
    turns: 0,
    latestCodexUsage: null,
    latestContextUsage: null,
    latestCodexUsageSource: null,
    latestContextUsageSource: null,
    modelSource: null,
    turnInputTokens: 0,
    turnOutputTokens: 0,
  };
}

/** Claude Code / Seed: one JSONL line per content block; blocks of the same
 *  turn repeat the same message.id and usage snapshot — count once per id. */
function foldClaudeLine(agg: TokenUsageAggregate, seenMessageIds: Set<string>, entry: any): void {
  // A *real* new prompt starts a new user turn → reset the per-turn delta.
  // Reuse the single source of truth the bridge attribution queue uses
  // (claude-transcript.ts) so "本轮" agrees with what counts as a turn start:
  //  - meaningful user prompts reset (isMeaningfulUserEvent excludes
  //    tool_result continuations, isMeta/isCompactSummary/isSidechain markers,
  //    slash-command wrappers and empty/synthetic-prefix lines);
  //  - type-ahead submissions land as `type:'attachment'` queued_command lines,
  //    NOT `type:'user'` — those are genuine turn starts and must reset too.
  // Writing a weaker local predicate here would mis-reset on /clear, compaction
  // and slash wrappers, and miss type-ahead — diverging from the real turn
  // boundaries the rest of the bridge sees.
  if (entry?.type === 'user' || entry?.type === 'attachment') {
    if (
      isMeaningfulUserEvent(entry as TranscriptEvent)
      || isMeaningfulQueuedCommand(entry as TranscriptEvent)
    ) {
      agg.turnInputTokens = 0;
      agg.turnOutputTokens = 0;
    }
    return;
  }
  if (entry?.type !== 'assistant') return;
  const msg = entry.message;
  const u = msg?.usage;
  if (!u || typeof u !== 'object') return;
  const messageId = typeof msg.id === 'string' ? msg.id : '';
  if (messageId) {
    if (seenMessageIds.has(messageId)) return;
    seenMessageIds.add(messageId);
  }
  agg.inputTokens += num(u.input_tokens);
  agg.outputTokens += num(u.output_tokens);
  agg.cacheReadTokens += num(u.cache_read_input_tokens);
  agg.cacheCreateTokens += num(u.cache_creation_input_tokens);
  const contextTokens =
    num(u.input_tokens)
    + num(u.cache_read_input_tokens)
    + num(u.cache_creation_input_tokens);
  // Per-turn delta: prompt side (input, excluding cache_read which just re-reads
  // the existing context) + output for every assistant step since the last user
  // message. This matches the small "↑N ↓M this turn" the CLI's own TUI shows.
  agg.turnInputTokens += num(u.input_tokens) + num(u.cache_creation_input_tokens);
  agg.turnOutputTokens += num(u.output_tokens);
  // Synthetic/empty assistant records around compaction must not erase the
  // last native context measurement.
  if (contextTokens > 0) {
    agg.latestContextUsage = { usedTokens: contextTokens };
  }
  if (!agg.model && typeof msg.model === 'string') agg.model = msg.model;
  agg.turns++;
}

/** Codex rollouts report cumulative totals via event_msg/token_count; only
 *  the latest snapshot counts. The active model rides on turn_context /
 *  session_meta payloads (latest wins — sessions can switch models). */
function foldCodexLine(agg: TokenUsageAggregate, entry: any, getSource: UsageSourceRecordGetter): void {
  const contextUsage = extractCodexContextUsage(entry);
  let source: UsageSourceRecord | null | undefined;
  const sourceForTrackedMetric = () => {
    source ??= getSource();
    return source;
  };
  if (contextUsage) {
    agg.latestContextUsage = contextUsage;
    agg.latestContextUsageSource = sourceForTrackedMetric();
  }

  const codexUsage = extractCodexTokenCountUsage(entry);
  if (codexUsage) {
    agg.latestCodexUsage = codexUsage;
    agg.latestCodexUsageSource = sourceForTrackedMetric();
    return;
  }
  const m = entry?.payload?.model ?? entry?.payload?.collaboration_mode?.settings?.model;
  if (typeof m === 'string' && m) {
    agg.model = m;
    agg.modelSource = sourceForTrackedMetric();
  }
}

/** CoCo events: only assistant messages with response_meta.usage count; the
 *  agent_end summary repeats the last turn's usage and must not be counted. */
function foldCocoLine(agg: TokenUsageAggregate, entry: any): void {
  const inner = entry?.message?.message;
  if (!inner || inner.role !== 'assistant') return;
  const u = inner.response_meta?.usage;
  if (!u || typeof u !== 'object') return;
  agg.inputTokens += pickNum(u, ['prompt_tokens', 'input_tokens']);
  agg.outputTokens += pickNum(u, ['completion_tokens', 'output_tokens']);
  agg.cacheReadTokens += pickNum(u, ['cache_read_input_tokens', 'cache_read_tokens']);
  agg.cacheCreateTokens += pickNum(u, ['cache_creation_input_tokens', 'cache_write_input_tokens']);
  if (!agg.model) {
    const m = inner.extra?._source_model ?? inner.extra?.trae_extra_info?.model;
    if (typeof m === 'string') agg.model = m;
  }
  agg.turns++;
}

function foldPiLine(agg: TokenUsageAggregate, seenMessageIds: Set<string>, entry: any): void {
  if (entry?.type !== 'message' || entry?.message?.role !== 'assistant') return;
  const msg = entry.message;
  const u = msg.usage;
  if (!u || typeof u !== 'object') return;
  const messageId = typeof msg.id === 'string' ? msg.id : '';
  if (messageId) {
    if (seenMessageIds.has(messageId)) return;
    seenMessageIds.add(messageId);
  }
  agg.inputTokens += num(u.input);
  agg.outputTokens += num(u.output);
  agg.cacheReadTokens += num(u.cacheRead);
  agg.cacheCreateTokens += num(u.cacheWrite);
  if (!agg.model && typeof msg.model === 'string') agg.model = msg.model;
  agg.turns++;
}

/** Cursor / TraeX / Antigravity: transcripts whose exact dialect is not yet
 *  pinned down — keep the tolerant multi-shape extraction for them. */
function foldGenericLine(agg: TokenUsageAggregate, seenMessageIds: Set<string>, entry: any): void {
  const contextUsage = extractCodexContextUsage(entry);
  if (contextUsage) agg.latestContextUsage = contextUsage;

  const codexUsage = extractCodexTokenCountUsage(entry);
  if (codexUsage) {
    agg.latestCodexUsage = codexUsage;
    return;
  }
  const native = extractNativeUsage(entry);
  if (!native) return;
  const messageId = entry?.message?.id;
  if (typeof messageId === 'string' && messageId) {
    if (seenMessageIds.has(messageId)) return;
    seenMessageIds.add(messageId);
  }
  const u = native.usage;
  agg.inputTokens += pickNum(u, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'promptTokenCount']);
  agg.outputTokens += pickNum(u, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'candidatesTokenCount']);
  agg.cacheReadTokens += pickNum(u, ['cache_read_input_tokens', 'cacheReadInputTokens', 'cache_read_tokens', 'cacheReadTokens']);
  agg.cacheCreateTokens += pickNum(u, ['cache_creation_input_tokens', 'cacheCreationInputTokens', 'cache_write_input_tokens', 'cacheWriteInputTokens']);
  if (!agg.model && typeof native.model === 'string') agg.model = native.model;
  agg.turns++;
}

function foldUsageLine(
  kind: UsageKind,
  agg: TokenUsageAggregate,
  seenMessageIds: Set<string>,
  entry: any,
  getSource?: UsageSourceRecordGetter,
): void {
  switch (kind) {
    case 'claude':
      return foldClaudeLine(agg, seenMessageIds, entry);
    case 'codex':
      return foldCodexLine(agg, entry, getSource ?? (() => null));
    case 'coco':
      return foldCocoLine(agg, entry);
    case 'pi':
      return foldPiLine(agg, seenMessageIds, entry);
    case 'generic':
      return foldGenericLine(agg, seenMessageIds, entry);
  }
}

/** Aggregate token usage over a JSONL transcript. Returns null only on read
 *  failure; an empty/usage-less file yields a zeroed aggregate. */
function readTokenUsageAggregate(path: string, kind: UsageKind): TokenUsageAggregate | null {
  const agg = newTokenUsageAggregate();
  const seenMessageIds = new Set<string>();

  try {
    let scanError: unknown = null;
    const scanned = scanJsonlFromOffset(path, 0, {
      onLine: (line, lineStart) => foldUsageJsonLine(kind, agg, seenMessageIds, line, lineStart),
      onError: (error) => { scanError = error; },
    });
    if (!scanned) throw scanError instanceof Error ? scanError : new Error('scan failed');
    if (scanned.pendingTail.trim()) {
      foldUsageJsonLine(kind, agg, seenMessageIds, scanned.pendingTail);
    }
  } catch (err: any) {
    logger.error(`Failed to read session token usage JSONL (${kind}): ${err.message}`);
    return null;
  }

  return agg;
}

function finalizeTokenUsage(aggregate: TokenUsageAggregate): SessionTokenUsage | null {
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, model, turns, latestCodexUsage } = aggregate;
  if (latestCodexUsage) return { ...latestCodexUsage, model: model || latestCodexUsage.model };
  if (turns === 0) return null;
  return {
    in: inputTokens + cacheReadTokens + cacheCreateTokens,
    out: outputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    model,
    turns,
  };
}

// ─── Cached / incremental transcript reading ─────────────────────────────────
//
// Dashboard row composition calls into this on every /api/sessions render and
// on worker status transitions. Transcripts can be tens of MB, so the reader
// (a) short-circuits on unchanged stat, (b) reparses a changing file at most
// once per throttle interval, (c) folds non-Codex append-only JSONL from the
// durable frontier, and (d) for Codex changes replays the bounded tracked
// source interval or falls back to a normal rebuild / oversized tail rebuild.

type CachedUsageKind = UsageKind | 'aiden';

interface UsageFileCacheEntry {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  dev: number;
  ino: number;
  canReadIncrementally: boolean;
  /** Durable parse frontier: byte offset just past the last complete line.
   *  <= 0 ⇒ the next change forces a full reparse. */
  offset: number;
  state: TokenUsageAggregate;
  seenMessageIds: Set<string>;
  previewAgg: TokenUsageAggregate;
  result: SessionTokenUsage | null;
  parsedAtMs: number;
}

const usageFileCache = new Map<string, UsageFileCacheEntry>();
const USAGE_FILE_CACHE_MAX_ENTRIES = 512;
/** While a transcript keeps changing, serve the cached value and reparse at
 *  most once per interval — keeps row composition off the disk. */
const USAGE_REPARSE_MIN_INTERVAL_MS = 15_000;
/** Token usage is advisory. Never let dashboard row rendering synchronously
 *  scan pathological multi-GB transcripts. */
export const MAX_USAGE_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
/** Codex token_count events are cumulative snapshots, so an oversized cold
 *  restore starts from a bounded tail window and recovers the latest usage
 *  card from it. Real 150MiB+ rollouts almost always carry a token_count
 *  snapshot in the last 4MiB, so this window is the common-case fast path. */
export const CODEX_USAGE_TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;
const CODEX_USAGE_REPLAY_BYTES = 4 * 1024 * 1024;
/** When a single huge turn (e.g. one giant tool output) pushes the latest
 *  token_count snapshot out of the first tail window, widen the window one
 *  step at a time and re-scan until both the cumulative and context metrics
 *  are recovered. This keeps the card showing the TRUE latest usage instead of
 *  collapsing to null. Bounded so the synchronous dashboard read never walks an
 *  unbounded prefix: past this budget we stop widening and fail closed (yield
 *  whatever the bounded window found, without inheriting a possibly-stale value
 *  across an unverifiable generation boundary). */
export const CODEX_USAGE_MAX_BACKSCAN_BYTES = 32 * 1024 * 1024;

/** Aiden checkpoint paths move as the session progresses (latest.json points
 *  at a new checkpoint id per turn), so positive hits expire quickly too. */
const AIDEN_PATH_HIT_TTL_MS = 15_000;
const warnedOversizedUsageFiles = new Set<string>();

export function __resetSessionUsageCachesForTest(): void {
  usageFileCache.clear();
  warnedOversizedUsageFiles.clear();
  __resetTranscriptResolverCacheForTest();
}

function cloneAggregate(agg: TokenUsageAggregate): TokenUsageAggregate {
  return { ...agg };
}

function foldUsageText(kind: UsageKind, agg: TokenUsageAggregate, seenMessageIds: Set<string>, text: string): void {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      foldUsageLine(kind, agg, seenMessageIds, JSON.parse(line));
    } catch { /* skip malformed lines */ }
  }
}

function foldUsageJsonLine(
  kind: UsageKind,
  agg: TokenUsageAggregate,
  seenMessageIds: Set<string>,
  line: string,
  lineStart?: number,
): void {
  if (!line.trim()) return;
  try {
    const entry = JSON.parse(line);
    if (kind !== 'codex') {
      foldUsageLine(kind, agg, seenMessageIds, entry);
      return;
    }
    let sourceCalculated = false;
    let source: UsageSourceRecord | null = null;
    foldUsageLine(kind, agg, seenMessageIds, entry, () => {
      if (!sourceCalculated) {
        source = sourceRecordForLine(line, lineStart);
        sourceCalculated = true;
      }
      return source;
    });
  } catch { /* skip malformed lines */ }
}

function readFdProbe(fd: number, offset: number, length: number): Buffer | null {
  if (length <= 0) return Buffer.alloc(0);
  try {
    const buf = Buffer.alloc(length);
    const read = readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, read);
  } catch {
    return null;
  }
}

function isJsonlLineBoundaryFd(fd: number, offset: number): boolean {
  if (offset <= 0) return true;
  const probe = readFdProbe(fd, offset - 1, 1);
  return !!probe && probe.length === 1 && probe[0] === 0x0a;
}

function aggregateHasCodexUsage(agg: TokenUsageAggregate): boolean {
  return !!agg.latestCodexUsage || !!agg.latestContextUsage;
}

/** Both independent Codex metrics recovered. Used to decide when a widening
 *  back-scan can stop: they may live on different lines, so a window that only
 *  caught one is not yet complete. */
function aggregateHasAllCodexMetrics(agg: TokenUsageAggregate): boolean {
  return !!agg.latestCodexUsage && !!agg.latestContextUsage;
}

interface UsageReadResult {
  agg: TokenUsageAggregate;
  result: SessionTokenUsage | null;
}

function ensureUsageFileCacheCapacity(key: string): void {
  if (usageFileCache.size >= USAGE_FILE_CACHE_MAX_ENTRIES && !usageFileCache.has(key)) {
    const oldest = usageFileCache.keys().next().value;
    if (oldest !== undefined) usageFileCache.delete(oldest);
  }
}

function canReuseUsageCache(
  cached: UsageFileCacheEntry,
  st: Stats,
): boolean {
  if (!cached.canReadIncrementally) return false;
  if (st.size < cached.offset) return false;
  return cached.dev === st.dev && cached.ino === st.ino;
}

function earliestCodexReplaySourceOffset(
  previous: TokenUsageAggregate | undefined,
): number | null {
  if (!previous) return null;
  const offsets: number[] = [];
  if (previous.latestCodexUsage) {
    if (!previous.latestCodexUsageSource) return null;
    offsets.push(previous.latestCodexUsageSource.offset);
  }
  if (previous.latestContextUsage) {
    if (!previous.latestContextUsageSource) return null;
    offsets.push(previous.latestContextUsageSource.offset);
  }
  if (previous.model) {
    if (!previous.modelSource) return null;
    offsets.push(previous.modelSource.offset);
  }
  return offsets.length > 0 ? Math.min(...offsets) : null;
}

function cacheUsageRead(
  key: string,
  st: Stats,
  entry: Omit<UsageFileCacheEntry, 'mtimeMs' | 'ctimeMs' | 'size' | 'dev' | 'ino'>,
): void {
  ensureUsageFileCacheCapacity(key);
  usageFileCache.set(key, {
    ...entry,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    size: st.size,
    dev: st.dev,
    ino: st.ino,
  });
}

function readCodexTokenAggregateCached(
  key: string,
  path: string,
  st: Stats,
  cached: UsageFileCacheEntry | undefined,
  now: number,
  retryOnRace = true,
): UsageReadResult | null {
  let fd: number | null = null;
  let fdStat: Stats;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    fdStat = fstatSync(fd);
    if (!fdStat.isFile()) {
      closeSync(fd);
      usageFileCache.delete(key);
      return { agg: newTokenUsageAggregate(), result: null };
    }
  } catch (error) {
    if (fd !== null) closeSync(fd);
    logger.error(`Failed to open Codex transcript ${path}: ${error instanceof Error ? error.message : String(error)}`);
    usageFileCache.delete(key);
    return null;
  }
  if (fdStat.dev !== st.dev || fdStat.ino !== st.ino || fdStat.size !== st.size) {
    closeSync(fd);
    usageFileCache.delete(key);
    if (retryOnRace) {
      return readCodexTokenAggregateCached(key, path, fdStat, undefined, now, false);
    }
    return { agg: newTokenUsageAggregate(), result: null };
  }
  let state: TokenUsageAggregate;
  let seenMessageIds: Set<string>;
  let baseOffset = 0;
  const previousAgg = cached?.previewAgg ? cloneAggregate(cached.previewAgg) : undefined;
  const sameOpenFileAsCache = !!cached
    && cached.dev === fdStat.dev
    && cached.ino === fdStat.ino;
  const canConsiderReplay = !!cached
    && sameOpenFileAsCache
    && cached.canReadIncrementally
    && cached.offset > 0
    && fdStat.size >= cached.offset;
  const oversized = fdStat.size > MAX_USAGE_TRANSCRIPT_BYTES;
  const candidateReplayBaseOffset = canConsiderReplay
    ? earliestCodexReplaySourceOffset(previousAgg)
    : null;
  const candidateReplaySpan = candidateReplayBaseOffset === null
    ? Number.POSITIVE_INFINITY
    : fdStat.size - candidateReplayBaseOffset;
  const replayBaseOffset = candidateReplaySpan <= CODEX_USAGE_REPLAY_BYTES
    && candidateReplayBaseOffset !== null
    && isJsonlLineBoundaryFd(fd, candidateReplayBaseOffset)
    ? candidateReplayBaseOffset
    : null;
  const replaySpan = replayBaseOffset === null ? Number.POSITIVE_INFINITY : fdStat.size - replayBaseOffset;
  const reuseTrackedReplay = replayBaseOffset !== null && replaySpan <= CODEX_USAGE_REPLAY_BYTES;

  // Scan one [from, size) window into a fresh aggregate. Codex token_count is a
  // cumulative snapshot (latest wins), so a wider window that re-includes older
  // lines re-folds them first and the newest snapshot still overwrites last —
  // scanning from a fresh state each time keeps that correctness without any
  // double counting. Returns null only on read failure.
  interface WindowScan {
    state: TokenUsageAggregate;
    seenMessageIds: Set<string>;
    scanned: JsonlCursor;
    completeBytes: number;
    previewAgg: TokenUsageAggregate;
    pendingTailIsInitialResidualLine: boolean;
  }
  const scanFromWindow = (from: number, knownLineBoundary: boolean): WindowScan | null => {
    const windowState = newTokenUsageAggregate();
    const windowSeen = new Set<string>();
    // Replay/full-file reads start on a proven line boundary (offset 0, or an
    // offset already validated by isJsonlLineBoundaryFd), so they need no extra
    // probe. Only a widened bounded-tail window lands at an arbitrary byte and
    // must drop the partial leading record.
    let dropResidual = !knownLineBoundary && from > 0 && !isJsonlLineBoundaryFd(fd, from);
    let droppedResidual = false;
    let windowScanError: unknown = null;
    const windowScanned = scanJsonlFromFd(fd, from, {
      endOffset: fdStat.size,
      onLine: (line, lineStart) => {
        if (dropResidual) {
          dropResidual = false;
          droppedResidual = true;
          return;
        }
        foldUsageJsonLine('codex', windowState, windowSeen, line, lineStart);
      },
      onError: (error) => { windowScanError = error; },
    });
    if (!windowScanned) {
      logger.error(`Failed to read Codex transcript slice ${path}: ${windowScanError instanceof Error ? windowScanError.message : String(windowScanError)}`);
      return null;
    }
    let windowPreview = windowState;
    const windowTail = windowScanned.pendingTail.trim();
    const residualTailPending = dropResidual && !droppedResidual;
    if (windowTail && !residualTailPending) {
      windowPreview = cloneAggregate(windowState);
      foldUsageText('codex', windowPreview, new Set(windowSeen), windowTail);
    }
    return {
      state: windowState,
      seenMessageIds: windowSeen,
      scanned: windowScanned,
      completeBytes: windowScanned.newOffset - from,
      previewAgg: windowPreview,
      pendingTailIsInitialResidualLine: residualTailPending,
    };
  };

  let scanned: JsonlCursor;
  let completeBytes: number;
  let previewAgg: TokenUsageAggregate;
  let pendingTailIsInitialResidualLine: boolean;

  if (reuseTrackedReplay) {
    baseOffset = replayBaseOffset;
    const win = scanFromWindow(baseOffset, true);
    if (!win) {
      closeSync(fd);
      usageFileCache.delete(key);
      return null;
    }
    ({ state, seenMessageIds, scanned, completeBytes, previewAgg, pendingTailIsInitialResidualLine } = win);
  } else if (!oversized) {
    baseOffset = 0;
    const win = scanFromWindow(baseOffset, true);
    if (!win) {
      closeSync(fd);
      usageFileCache.delete(key);
      return null;
    }
    ({ state, seenMessageIds, scanned, completeBytes, previewAgg, pendingTailIsInitialResidualLine } = win);
  } else {
    // Oversized cold/bounded read: start at the last tail window and widen it
    // one step at a time until BOTH independent metrics are recovered (they can
    // sit on different lines) — or we hit the file head or the back-scan budget.
    // This recovers the true latest usage even when a single >4MiB turn pushed
    // the newest snapshot out of the first window, instead of collapsing to null.
    let win: WindowScan | null = null;
    let step = 0;
    for (;;) {
      const windowBytes = CODEX_USAGE_TRANSCRIPT_TAIL_BYTES * (step + 1);
      baseOffset = Math.max(0, fdStat.size - windowBytes);
      const attempt = scanFromWindow(baseOffset, false);
      if (!attempt) {
        closeSync(fd);
        usageFileCache.delete(key);
        return null;
      }
      win = attempt;
      if (
        aggregateHasAllCodexMetrics(attempt.previewAgg)
        || baseOffset === 0
        || windowBytes >= CODEX_USAGE_MAX_BACKSCAN_BYTES
      ) {
        break;
      }
      step += 1;
    }
    ({ state, seenMessageIds, scanned, completeBytes, previewAgg, pendingTailIsInitialResidualLine } = win);
  }

  const nextOffset = pendingTailIsInitialResidualLine ? baseOffset : baseOffset + completeBytes;
  let endStat: Stats;
  try {
    endStat = fstatSync(fd);
  } catch {
    closeSync(fd);
    usageFileCache.delete(key);
    return { agg: newTokenUsageAggregate(), result: null };
  }
  if (
    endStat.dev !== fdStat.dev
    || endStat.ino !== fdStat.ino
    || endStat.size !== fdStat.size
    || endStat.mtimeMs !== fdStat.mtimeMs
    || endStat.ctimeMs !== fdStat.ctimeMs
  ) {
    closeSync(fd);
    usageFileCache.delete(key);
    if (retryOnRace) {
      return readCodexTokenAggregateCached(key, path, endStat, undefined, now, false);
    }
    return { agg: newTokenUsageAggregate(), result: null };
  }

  let pathStat: Stats;
  try {
    pathStat = statSync(path);
  } catch {
    closeSync(fd);
    usageFileCache.delete(key);
    return { agg: newTokenUsageAggregate(), result: null };
  }
  if (
    pathStat.dev !== fdStat.dev
    || pathStat.ino !== fdStat.ino
    || pathStat.size !== fdStat.size
    || pathStat.mtimeMs !== fdStat.mtimeMs
    || pathStat.ctimeMs !== fdStat.ctimeMs
  ) {
    closeSync(fd);
    usageFileCache.delete(key);
    if (retryOnRace) {
      return readCodexTokenAggregateCached(key, path, pathStat, undefined, now, false);
    }
    return { agg: newTokenUsageAggregate(), result: null };
  }

  if (pendingTailIsInitialResidualLine) {
    // The bounded window starts in the middle of a JSONL record and no newline
    // has arrived yet. Cache safe stat/throttle metadata only; the stored
    // offset is not a reusable durable cursor, so any later change reboots from
    // a bounded tail instead of turning that suffix into a fake complete line.
    const result = finalizeTokenUsage(previewAgg);
    cacheUsageRead(key, fdStat, {
      offset: nextOffset,
      state,
      seenMessageIds,
      previewAgg,
      result,
      parsedAtMs: now,
      canReadIncrementally: false,
    });
    closeSync(fd);
    return { agg: previewAgg, result };
  }
  const result = finalizeTokenUsage(previewAgg);
  const canReadIncrementally = aggregateHasCodexUsage(previewAgg);
  cacheUsageRead(key, fdStat, {
    offset: nextOffset,
    state,
    seenMessageIds,
    previewAgg,
    result,
    parsedAtMs: now,
    canReadIncrementally,
  });
  closeSync(fd);
  return { agg: previewAgg, result };
}

function readSessionTokenAggregateCached(path: string, kind: CachedUsageKind, opts?: { fresh?: boolean }): UsageReadResult | null {
  const key = `${kind}:${path}`;
  let st: Stats | null = null;
  try {
    st = statSync(path);
  } catch {
    st = null;
  }

  if (!st) {
    usageFileCache.delete(key);
    if (kind === 'codex') {
      return { agg: newTokenUsageAggregate(), result: null };
    }
    // Unstat-able (file gone, or mocked fs in unit tests): parse directly, uncached.
    if (kind === 'aiden') {
      const result = readTokenUsageFromAidenCheckpoint(path);
      return result ? { agg: newTokenUsageAggregate(), result } : null;
    }
    const agg = readTokenUsageAggregate(path, kind);
    return agg ? { agg, result: finalizeTokenUsage(agg) } : null;
  }

  const now = Date.now();
  const cached = usageFileCache.get(key);
  if (cached && cached.dev === st.dev && cached.ino === st.ino) {
    const unchanged = cached.mtimeMs === st.mtimeMs && cached.ctimeMs === st.ctimeMs && cached.size === st.size;
    const throttled = !opts?.fresh && now - cached.parsedAtMs < USAGE_REPARSE_MIN_INTERVAL_MS;
    if (unchanged || throttled) {
      return { agg: cached.previewAgg, result: cached.result };
    }
  }

  if (kind === 'codex') {
    return readCodexTokenAggregateCached(key, path, st, cached, now);
  }

  if (st.size > MAX_USAGE_TRANSCRIPT_BYTES) {
    // Warn once per transcript, not per observed size: an actively-growing
    // oversized file would otherwise re-warn and leak a Set entry every reparse.
    if (!warnedOversizedUsageFiles.has(key)) {
      warnedOversizedUsageFiles.add(key);
      logger.warn(
        `Skipping token usage scan for oversized transcript ${path} ` +
        `(${st.size} bytes > ${MAX_USAGE_TRANSCRIPT_BYTES} bytes)`,
      );
    }
    if (cached) return { agg: cached.previewAgg, result: cached.result };
    return { agg: newTokenUsageAggregate(), result: null };
  }

  if (kind === 'aiden') {
    // Checkpoints are rewritten whole — nothing incremental to exploit.
    const result = readTokenUsageFromAidenCheckpoint(path);
    const blank = newTokenUsageAggregate();
    cacheUsageRead(key, st, {
      offset: -1,
      state: blank,
      seenMessageIds: new Set(),
      previewAgg: blank,
      result,
      parsedAtMs: now,
      canReadIncrementally: false,
    });
    return { agg: blank, result };
  }

  let state: TokenUsageAggregate;
  let seenMessageIds: Set<string>;
  let baseOffset: number;
  if (cached && cached.offset > 0 && canReuseUsageCache(cached, st)) {
    // Append-only growth: continue folding from the durable frontier.
    state = cached.state;
    seenMessageIds = cached.seenMessageIds;
    baseOffset = cached.offset;
  } else {
    state = newTokenUsageAggregate();
    seenMessageIds = new Set();
    baseOffset = 0;
  }

  let scanError: unknown = null;
  const scanned = scanJsonlFromOffset(path, baseOffset, {
    endOffset: st.size,
    onLine: (line, lineStart) => foldUsageJsonLine(kind, state, seenMessageIds, line, lineStart),
    onError: (error) => { scanError = error; },
  });
  if (!scanned) {
    logger.error(`Failed to read transcript slice ${path}: ${scanError instanceof Error ? scanError.message : String(scanError)}`);
    usageFileCache.delete(key);
    return null;
  }
  const completeBytes = scanned.newOffset - baseOffset;

  // The bytes after the last newline may still be a complete JSON record
  // (writer mid-flush). Fold them into a preview copy only — the durable
  // frontier stays at the newline, so the line is folded durably exactly
  // once when its terminator arrives.
  let previewAgg = state;
  const tailText = scanned.pendingTail.trim();
  if (tailText) {
    previewAgg = cloneAggregate(state);
    foldUsageText(kind, previewAgg, new Set(seenMessageIds), tailText);
  }

  const result = finalizeTokenUsage(previewAgg);
  cacheUsageRead(key, st, {
    offset: baseOffset + completeBytes,
    state,
    seenMessageIds,
    previewAgg,
    result,
    parsedAtMs: now,
    canReadIncrementally: true,
  });
  return { agg: previewAgg, result };
}

/** Read a transcript's token usage through the stat/incremental cache.
 *  This is the reusable entry point for dashboard rows and, later, the
 *  persistent usage ledger. */
export function readSessionTokenUsageFile(path: string, kind: CachedUsageKind, opts?: { fresh?: boolean }): SessionTokenUsage | null {
  return readSessionTokenAggregateCached(path, kind, opts)?.result ?? null;
}

function readTokenUsageFromAidenCheckpoint(path: string): SessionTokenUsage | null {
  let rawInputTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreateTokens = 0;
  let model = '';
  let turns = 0;

  try {
    const checkpoint = JSON.parse(readFileSync(path, 'utf-8'));
    const messages = checkpoint?.checkpoint?.channel_values?.messages;
    if (!Array.isArray(messages)) return null;
    for (const msg of messages) {
      // LangGraph checkpoints only attribute usage to AI messages; human/tool
      // entries occasionally echo usage metadata and must not be counted.
      if (msg?.type === 'human' || msg?.type === 'tool') continue;
      const u = msg?.usage_metadata ?? msg?.usage;
      if (!u || typeof u !== 'object') continue;
      const rawInput = pickNum(u, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']);
      const output = pickNum(u, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']);
      const reportedCacheRead =
        pickNum(u?.input_token_details, ['cache_read', 'cached_tokens', 'cacheRead']) +
        pickNum(u?.input_tokens_details, ['cache_read', 'cached_tokens', 'cacheRead']);
      const reportedCacheCreate =
        pickNum(u?.input_token_details, ['cache_creation', 'cache_write', 'cacheCreate']) +
        pickNum(u?.input_tokens_details, ['cache_creation', 'cache_write', 'cacheCreate']);
      const partitioned = partitionInclusiveInputTokens(rawInput, reportedCacheRead, reportedCacheCreate);
      rawInputTokens += partitioned.rawInputTokens;
      inputTokens += partitioned.inputTokens;
      outputTokens += output;
      cacheReadTokens += partitioned.cacheReadTokens;
      cacheCreateTokens += partitioned.cacheCreateTokens;
      if (!model && typeof msg?.response_metadata?.model_name === 'string') model = msg.response_metadata.model_name;
      turns++;
    }
  } catch (err: any) {
    logger.error(`Failed to read Aiden checkpoint token usage: ${err.message}`);
    return null;
  }

  if (turns === 0) return null;
  return {
    in: rawInputTokens,
    out: outputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    model,
    turns,
  };
}

function readSessionUsage(q: SessionTokenUsageQuery): UsageReadResult | null {
  if (q.cliId === 'aiden') {
    const sid = q.cliSessionId || q.sessionId;
    const checkpointPath = cachedTranscriptPathLookup(
      `aiden:${q.sessionId}:${sid}:${q.cwd ?? ''}`,
      AIDEN_PATH_HIT_TTL_MS,
      () =>
        findAidenLatestCheckpointBySessionId(sid, undefined, q.cwd) ??
        findAidenLatestCheckpointByBotmuxSessionId(q.sessionId, undefined, q.cwd) ??
        null,
      { retryMiss: q.fresh, refreshHit: q.fresh },
    );
    if (!checkpointPath || !existsSync(checkpointPath)) return null;
    return readSessionTokenAggregateCached(checkpointPath, 'aiden', { fresh: q.fresh });
  }
  const resolved = resolveSessionTranscriptPath(q);
  if (!resolved || !existsSync(resolved.path)) return null;
  return readSessionTokenAggregateCached(resolved.path, usageKindForCli(q.cliId), { fresh: q.fresh });
}

export function getSessionTokenUsage(q: SessionTokenUsageQuery): SessionTokenUsage | null {
  return readSessionUsage(q)?.result ?? null;
}

export function getSessionUsageSnapshot(q: SessionTokenUsageQuery): SessionUsageSnapshot {
  const read = readSessionUsage(q);
  const agg = read?.agg;
  // Per-turn delta only for dialects that track it (Claude family). Codex/coco
  // fold to a cumulative-only latestCodexUsage and leave turn counters at 0, so
  // guard on turns>0 AND a positive delta to avoid a misleading "本轮 0".
  const turnTokens = agg && agg.turns > 0
    && (agg.turnInputTokens > 0 || agg.turnOutputTokens > 0)
    ? { in: agg.turnInputTokens, out: agg.turnOutputTokens }
    : null;
  return {
    context: agg?.latestContextUsage ?? null,
    tokens: read?.result ?? null,
    turnTokens,
  };
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}
