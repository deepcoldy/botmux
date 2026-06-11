/**
 * Session cost calculator — computes token usage from JSONL logs.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, type Stats } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';
import { expandHome } from './working-dir.js';
import type { CliId } from '../adapters/cli/types.js';
import { findAidenLatestCheckpointByBotmuxSessionId, findAidenLatestCheckpointBySessionId } from '../services/aiden-checkpoints.js';
import { findCodexRolloutBySessionId, findCodexSessionIdByBotmuxSessionId } from '../services/codex-transcript.js';
import { cocoEventsPathForSession } from '../services/coco-transcript.js';
import { findCursorTranscriptByChatId } from '../services/cursor-transcript.js';
import { findTraexRolloutBySessionId } from '../services/traex-transcript.js';

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

export interface SessionTokenUsageQuery {
  cliId?: CliId | 'unknown';
  sessionId: string;
  cliSessionId?: string;
  cwd?: string;
  /** Bypass the reparse throttle (stat short-circuit and incremental folding
   *  still apply). Use at low-frequency exact points like ledger snapshots. */
  fresh?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function getSessionJsonlPath(sessionId: string, cwd: string): string | null {
  return getClaudeSessionJsonlPath(sessionId, cwd, join(homedir(), '.claude'));
}

function getClaudeSessionJsonlPath(sessionId: string, cwd: string, dataDir: string): string | null {
  const resolvedCwd = resolve(expandHome(cwd));
  // Claude stores sessions at ~/.claude/projects/<project-key>/<sessionId>.jsonl
  // where project-key = absolute path with non [A-Za-z0-9-] chars replaced by -
  const projectKey = resolvedCwd.replace(/[^A-Za-z0-9-]/g, '-');
  const jsonlPath = join(dataDir, 'projects', projectKey, `${sessionId}.jsonl`);
  return existsSync(jsonlPath) ? jsonlPath : null;
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
  const inputTokens = pickNum(u, ['input_tokens', 'inputTokens']);
  const outputTokens = pickNum(u, ['output_tokens', 'outputTokens']);
  const cacheReadTokens = pickNum(u, ['cached_input_tokens', 'cachedInputTokens']);
  return {
    in: inputTokens,
    out: outputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens: 0,
    model: '',
    turns: 0,
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
}

/** Per-CLI transcript dialect. Each kind only counts the events that dialect
 *  defines as billable turns — no cross-CLI guessing on usage-shaped lines. */
type UsageKind = 'claude' | 'codex' | 'coco' | 'generic';

function usageKindForCli(cliId: SessionTokenUsageQuery['cliId']): UsageKind {
  switch (cliId) {
    case 'claude-code':
    case 'seed':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'coco':
      return 'coco';
    default:
      return 'generic';
  }
}

function newTokenUsageAggregate(): TokenUsageAggregate {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, model: '', turns: 0, latestCodexUsage: null };
}

/** Claude Code / Seed: one JSONL line per content block; blocks of the same
 *  turn repeat the same message.id and usage snapshot — count once per id. */
function foldClaudeLine(agg: TokenUsageAggregate, seenMessageIds: Set<string>, entry: any): void {
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
  if (!agg.model && typeof msg.model === 'string') agg.model = msg.model;
  agg.turns++;
}

/** Codex rollouts report cumulative totals via event_msg/token_count; only
 *  the latest snapshot counts. The active model rides on turn_context /
 *  session_meta payloads (latest wins — sessions can switch models). */
function foldCodexLine(agg: TokenUsageAggregate, entry: any): void {
  const codexUsage = extractCodexTokenCountUsage(entry);
  if (codexUsage) {
    agg.latestCodexUsage = codexUsage;
    return;
  }
  const m = entry?.payload?.model ?? entry?.payload?.collaboration_mode?.settings?.model;
  if (typeof m === 'string' && m) agg.model = m;
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

/** Cursor / TraeX / Antigravity: transcripts whose exact dialect is not yet
 *  pinned down — keep the tolerant multi-shape extraction for them. */
function foldGenericLine(agg: TokenUsageAggregate, seenMessageIds: Set<string>, entry: any): void {
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

function foldUsageLine(kind: UsageKind, agg: TokenUsageAggregate, seenMessageIds: Set<string>, entry: any): void {
  switch (kind) {
    case 'claude':
      return foldClaudeLine(agg, seenMessageIds, entry);
    case 'codex':
      return foldCodexLine(agg, entry);
    case 'coco':
      return foldCocoLine(agg, entry);
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
    const content = readFileSync(path, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        foldUsageLine(kind, agg, seenMessageIds, entry);
      } catch { /* skip malformed lines */ }
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
// once per throttle interval, and (c) for append-only JSONL folds only the
// newly appended bytes instead of rereading the whole file.

type CachedUsageKind = UsageKind | 'aiden';

interface UsageFileCacheEntry {
  mtimeMs: number;
  size: number;
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

const sessionPathCache = new Map<string, { path: string | null; atMs: number }>();
const SESSION_PATH_CACHE_MAX_ENTRIES = 1024;
/** A missed lookup (transcript not on disk yet) is retried only after this
 *  window — fresh sessions otherwise trigger a directory scan per row render. */
const PATH_MISS_RETRY_MS = 30_000;
/** Aiden checkpoint paths move as the session progresses (latest.json points
 *  at a new checkpoint id per turn), so positive hits expire quickly too. */
const AIDEN_PATH_HIT_TTL_MS = 15_000;

export function __resetSessionUsageCachesForTest(): void {
  usageFileCache.clear();
  sessionPathCache.clear();
}

/** Memoize a transcript-path lookup. `hitTtlMs === null` means a found path
 *  is trusted forever (rollout/transcript files never move); misses are
 *  retried after PATH_MISS_RETRY_MS — or immediately when `retryMiss` is set
 *  (ledger reads must see lazily created transcripts at turn boundaries).
 *  `refreshHit` additionally re-resolves a cached positive hit — for sources
 *  whose path MOVES between turns (aiden checkpoints), a fresh ledger read
 *  must not settle for a stale path inside the hit TTL. */
function cachedPathLookup(
  key: string,
  hitTtlMs: number | null,
  lookup: () => string | null,
  opts?: { retryMiss?: boolean; refreshHit?: boolean },
): string | null {
  const now = Date.now();
  const cached = sessionPathCache.get(key);
  if (cached) {
    if (cached.path !== null) {
      if (!opts?.refreshHit && (hitTtlMs === null || now - cached.atMs < hitTtlMs)) return cached.path;
    } else if (!opts?.retryMiss && now - cached.atMs < PATH_MISS_RETRY_MS) {
      return null;
    }
  }
  if (sessionPathCache.size >= SESSION_PATH_CACHE_MAX_ENTRIES && !sessionPathCache.has(key)) {
    const oldest = sessionPathCache.keys().next().value;
    if (oldest !== undefined) sessionPathCache.delete(oldest);
  }
  const path = lookup();
  sessionPathCache.set(key, { path, atMs: now });
  return path;
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

function readFileSlice(path: string, start: number, length: number): Buffer | null {
  try {
    const fd = openSync(path, 'r');
    const buf = Buffer.alloc(length);
    let bytesRead = 0;
    try {
      while (bytesRead < length) {
        const n = readSync(fd, buf, bytesRead, length - bytesRead, start + bytesRead);
        if (n <= 0) break;
        bytesRead += n;
      }
    } finally {
      closeSync(fd);
    }
    return buf.subarray(0, bytesRead);
  } catch (err: any) {
    logger.error(`Failed to read transcript slice ${path}: ${err.message}`);
    return null;
  }
}

interface UsageReadResult {
  agg: TokenUsageAggregate;
  result: SessionTokenUsage | null;
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
    // Unstat-able (file gone, or mocked fs in unit tests): parse directly, uncached.
    usageFileCache.delete(key);
    if (kind === 'aiden') {
      const result = readTokenUsageFromAidenCheckpoint(path);
      return result ? { agg: newTokenUsageAggregate(), result } : null;
    }
    const agg = readTokenUsageAggregate(path, kind);
    return agg ? { agg, result: finalizeTokenUsage(agg) } : null;
  }

  const now = Date.now();
  const cached = usageFileCache.get(key);
  if (cached) {
    const unchanged = cached.mtimeMs === st.mtimeMs && cached.size === st.size;
    const throttled = !opts?.fresh && now - cached.parsedAtMs < USAGE_REPARSE_MIN_INTERVAL_MS;
    if (unchanged || throttled) {
      return { agg: cached.previewAgg, result: cached.result };
    }
  }

  if (usageFileCache.size >= USAGE_FILE_CACHE_MAX_ENTRIES && !usageFileCache.has(key)) {
    const oldest = usageFileCache.keys().next().value;
    if (oldest !== undefined) usageFileCache.delete(oldest);
  }

  if (kind === 'aiden') {
    // Checkpoints are rewritten whole — nothing incremental to exploit.
    const result = readTokenUsageFromAidenCheckpoint(path);
    const blank = newTokenUsageAggregate();
    usageFileCache.set(key, {
      mtimeMs: st.mtimeMs,
      size: st.size,
      offset: -1,
      state: blank,
      seenMessageIds: new Set(),
      previewAgg: blank,
      result,
      parsedAtMs: now,
    });
    return { agg: blank, result };
  }

  let state: TokenUsageAggregate;
  let seenMessageIds: Set<string>;
  let baseOffset: number;
  if (cached && cached.offset > 0 && st.size >= cached.offset) {
    // Append-only growth: continue folding from the durable frontier.
    state = cached.state;
    seenMessageIds = cached.seenMessageIds;
    baseOffset = cached.offset;
  } else {
    state = newTokenUsageAggregate();
    seenMessageIds = new Set();
    baseOffset = 0;
  }

  const chunk = readFileSlice(path, baseOffset, st.size - baseOffset);
  if (!chunk) {
    usageFileCache.delete(key);
    return null;
  }

  const lastNewline = chunk.lastIndexOf(0x0a);
  const completeBytes = lastNewline >= 0 ? lastNewline + 1 : 0;
  foldUsageText(kind, state, seenMessageIds, chunk.toString('utf8', 0, completeBytes));

  // The bytes after the last newline may still be a complete JSON record
  // (writer mid-flush). Fold them into a preview copy only — the durable
  // frontier stays at the newline, so the line is folded durably exactly
  // once when its terminator arrives.
  let previewAgg = state;
  const tailText = chunk.toString('utf8', completeBytes).trim();
  if (tailText) {
    previewAgg = cloneAggregate(state);
    foldUsageText(kind, previewAgg, new Set(seenMessageIds), tailText);
  }

  const result = finalizeTokenUsage(previewAgg);
  usageFileCache.set(key, {
    mtimeMs: st.mtimeMs,
    size: st.size,
    offset: baseOffset + completeBytes,
    state,
    seenMessageIds,
    previewAgg,
    result,
    parsedAtMs: now,
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
      const input = pickNum(u, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']);
      const output = pickNum(u, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']);
      inputTokens += input;
      outputTokens += output;
      cacheReadTokens +=
        pickNum(u?.input_token_details, ['cache_read', 'cached_tokens', 'cacheRead']) +
        pickNum(u?.input_tokens_details, ['cache_read', 'cached_tokens', 'cacheRead']);
      cacheCreateTokens +=
        pickNum(u?.input_token_details, ['cache_creation', 'cache_write', 'cacheCreate']) +
        pickNum(u?.input_tokens_details, ['cache_creation', 'cache_write', 'cacheCreate']);
      if (!model && typeof msg?.response_metadata?.model_name === 'string') model = msg.response_metadata.model_name;
      turns++;
    }
  } catch (err: any) {
    logger.error(`Failed to read Aiden checkpoint token usage: ${err.message}`);
    return null;
  }

  if (turns === 0) return null;
  return {
    in: inputTokens,
    out: outputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    model,
    turns,
  };
}

function tokenUsagePathForSession(q: SessionTokenUsageQuery): string | null {
  const sid = q.cliSessionId || q.sessionId;
  switch (q.cliId) {
    case 'claude-code':
      return q.cwd ? getClaudeSessionJsonlPath(sid, q.cwd, join(homedir(), '.claude')) : null;
    case 'seed':
      return q.cwd ? getClaudeSessionJsonlPath(sid, q.cwd, process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude-runtime')) : null;
    case 'codex':
      return cachedPathLookup(`codex:${q.sessionId}:${q.cliSessionId ?? ''}`, null, () => {
        const codexSid = q.cliSessionId || findCodexSessionIdByBotmuxSessionId(q.sessionId) || q.sessionId;
        return findCodexRolloutBySessionId(codexSid) ?? null;
      }, { retryMiss: q.fresh });
    case 'coco':
      return cocoEventsPathForSession(sid);
    case 'cursor':
      return cachedPathLookup(`cursor:${sid}`, null, () => findCursorTranscriptByChatId(sid) ?? null, { retryMiss: q.fresh });
    case 'traex':
      return cachedPathLookup(`traex:${sid}`, null, () => findTraexRolloutBySessionId(sid) ?? null, { retryMiss: q.fresh });
    case 'antigravity':
      return q.cliSessionId
        ? join(homedir(), '.gemini', 'antigravity-cli', 'brain', q.cliSessionId, '.system_generated', 'logs', 'transcript.jsonl')
        : null;
    default:
      return null;
  }
}

export function getSessionTokenUsage(q: SessionTokenUsageQuery): SessionTokenUsage | null {
  if (q.cliId === 'aiden') {
    const sid = q.cliSessionId || q.sessionId;
    const checkpointPath = cachedPathLookup(
      `aiden:${q.sessionId}:${sid}:${q.cwd ?? ''}`,
      AIDEN_PATH_HIT_TTL_MS,
      () =>
        findAidenLatestCheckpointBySessionId(sid, undefined, q.cwd) ??
        findAidenLatestCheckpointByBotmuxSessionId(q.sessionId, undefined, q.cwd) ??
        null,
      { retryMiss: q.fresh, refreshHit: q.fresh },
    );
    if (!checkpointPath || !existsSync(checkpointPath)) return null;
    return readSessionTokenUsageFile(checkpointPath, 'aiden', { fresh: q.fresh });
  }
  const path = tokenUsagePathForSession(q);
  if (!path || !existsSync(path)) return null;
  return readSessionTokenUsageFile(path, usageKindForCli(q.cliId), { fresh: q.fresh });
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}
