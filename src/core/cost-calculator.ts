/**
 * Session cost calculator — computes token usage from JSONL logs.
 */
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, statSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';
import type { CliId } from '../adapters/cli/types.js';
import { findAidenLatestCheckpointByBotmuxSessionId, findAidenLatestCheckpointBySessionId } from '../services/aiden-checkpoints.js';
import {
  __resetTranscriptResolverCacheForTest,
  cachedTranscriptPathLookup,
  resolveSessionTranscriptPath,
} from '../services/transcript-resolver.js';
import { scanJsonlFromFd, scanJsonlFromOffset, type JsonlCursor } from '../services/jsonl-cursor.js';
import { estimateCostCny, type ResolvedModelPricing } from '../services/model-pricing.js';
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
 * whereas `tokens` is the whole-session cumulative (cache-inclusive, large).
 * `costCny` is the cumulative CNY estimate for the whole session (pricing-gated:
 * absent when no pricing is supplied or the session model is unpriced). */
export interface SessionUsageSnapshot {
  context: SessionContextUsage | null;
  tokens: SessionTokenUsage | null;
  turnTokens: { in: number; out: number } | null;
  model?: string;
  reasoningEffort?: string;
  costCny?: number;
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
  /** Optional pricing for CNY cost estimation. When supplied (and the session
   *  model is priced), getSessionUsageSnapshot fills `costCny` on the
   *  cumulative token totals — distinct from the ledger's per-delta cost. */
  pricing?: ResolvedModelPricing;
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

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return '';
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
  reasoningEffort: string;
}

/** Per-CLI transcript dialect. Each kind only counts the events that dialect
 *  defines as billable turns — no cross-CLI guessing on usage-shaped lines. */
type UsageKind = 'claude' | 'codex' | 'coco' | 'pi' | 'grok' | 'generic';

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
    case 'grok':
      return 'grok';
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
    reasoningEffort: '',
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

/** Pi transcripts carry per-turn usage but no context window of their own;
 *  the window comes from ~/.pi/agent/models.json. Cache by mtime so the fold
 *  never re-reads a stable file (models.json is edited rarely). */
const PI_MODELS_JSON_PATH = join(homedir(), '.pi', 'agent', 'models.json');

interface PiModelsCacheEntry {
  mtimeMs: number;
  size: number;
  contextByModelId: Map<string, number>;
  contextByProviderModel: Map<string, number>;
}

let piModelsCache: (PiModelsCacheEntry & { ambiguousBareIds?: Set<string> }) | null = null;

interface PiModelsWindows {
  byBareId: Map<string, number>;
  byProviderModel: Map<string, number>;
  ambiguousBareIds: Set<string>;
}

function readPiModelsContextWindows(): PiModelsWindows | null {
  try {
    const st = statSync(PI_MODELS_JSON_PATH);
    if (piModelsCache && piModelsCache.mtimeMs === st.mtimeMs && piModelsCache.size === st.size) {
      return { byBareId: piModelsCache.contextByModelId, byProviderModel: piModelsCache.contextByProviderModel, ambiguousBareIds: piModelsCache.ambiguousBareIds ?? new Set() };
    }
    const parsed = JSON.parse(readFileSync(PI_MODELS_JSON_PATH, 'utf-8')) as any;
    const contextByModelId = new Map<string, number>();
    const contextByProviderModel = new Map<string, number>();
    const ambiguousBareIds = new Set<string>();
    const providers = parsed?.providers;
    if (providers && typeof providers === 'object') {
      for (const [providerName, provider] of Object.entries<any>(providers)) {
        if (!provider || typeof provider !== 'object') continue;
        const models = provider.models;
        if (!Array.isArray(models)) continue;
        for (const model of models) {
          if (model && typeof model.id === 'string' && typeof model.contextWindow === 'number' && model.contextWindow > 0) {
            const existing = contextByModelId.get(model.id);
            if (existing !== undefined && existing !== model.contextWindow) {
              // Same bare id with a different window under another provider: bare-id
              // lookup would silently pick one, so mark it ambiguous and only allow
              // provider-qualified resolution.
              ambiguousBareIds.add(model.id);
            } else {
              contextByModelId.set(model.id, model.contextWindow);
            }
            contextByProviderModel.set(`${providerName}/${model.id}`, model.contextWindow);
          }
        }
      }
    }
    for (const id of ambiguousBareIds) contextByModelId.delete(id);
    piModelsCache = { mtimeMs: st.mtimeMs, size: st.size, contextByModelId, contextByProviderModel, ambiguousBareIds };
    return { byBareId: contextByModelId, byProviderModel: contextByProviderModel, ambiguousBareIds };
  } catch {
    // models.json missing or unparseable: fall back to used-tokens-only context
    // (no window, no percentage), same as Claude Code sessions.
    return null;
  }
}

/** Resolve a model's context window, tolerating pi's bare model ids as well as
 *  the "provider/model" and "model:variant" shapes used in configs. */
function piModelContextWindow(modelId: string, provider?: string): number | undefined {
  const windows = readPiModelsContextWindows();
  if (!windows) return undefined;
  // Prefer the exact provider+model identity recorded in the transcript.
  if (provider) {
    const qualified = windows.byProviderModel.get(`${provider}/${modelId}`);
    if (qualified !== undefined) return qualified;
  }
  if (windows.byBareId.has(modelId)) return windows.byBareId.get(modelId);
  const bare = modelId.includes('/') ? modelId.slice(modelId.lastIndexOf('/') + 1) : modelId;
  if (provider) {
    const qualifiedBare = windows.byProviderModel.get(`${provider}/${bare}`);
    if (qualifiedBare !== undefined) return qualifiedBare;
  }
  if (windows.byBareId.has(bare)) return windows.byBareId.get(bare);
  const withoutVariant = bare.includes(':') ? bare.slice(0, bare.indexOf(':')) : bare;
  if (withoutVariant !== bare) {
    if (provider) {
      const qualifiedNoVariant = windows.byProviderModel.get(`${provider}/${withoutVariant}`);
      if (qualifiedNoVariant !== undefined) return qualifiedNoVariant;
    }
    if (windows.byBareId.has(withoutVariant)) return windows.byBareId.get(withoutVariant);
  }
  return undefined;
}

/** pi's usage is per-turn prompt-side totals; the latest measurement is the
 *  context gauge. The window (and therefore the percentage) comes from
 *  ~/.pi/agent/models.json when the model id can be resolved. */
function buildPiContextUsage(usedTokens: number, modelId: string, provider?: string): SessionContextUsage {
  const windowTokens = piModelContextWindow(modelId, provider);
  if (!windowTokens) return { usedTokens };
  const percentUsed = Math.round(Math.max(0, Math.min(1, usedTokens / windowTokens)) * 100);
  return { usedTokens, windowTokens, percentUsed };
}

/** Grok Build persists ACP updates. `turn_completed.usage` is an exact
 *  per-turn provider total (input includes cached input); companion
 *  signals.json supplies the live context gauge and user-facing model id. */
function foldGrokLine(agg: TokenUsageAggregate, entry: any): void {
  // Grok writes two sibling `_meta` objects. `params._meta` is almost always
  // present (eventId / totalTokens) and must not shadow `update._meta.modelId`
  // on `user_message_chunk` — that is the first-turn user-facing model before
  // signals.json exists.
  const paramsMeta = entry?.params?._meta;
  const updateMeta = entry?.params?.update?._meta;
  const contextTokens = num(paramsMeta?.totalTokens) || num(updateMeta?.totalTokens);
  if (contextTokens > 0) {
    agg.latestContextUsage = { usedTokens: contextTokens };
  }
  const eventModel = firstNonEmptyString(updateMeta?.modelId, paramsMeta?.modelId);
  if (eventModel) agg.model = eventModel;
  const update = entry?.params?.update;
  if (update?.sessionUpdate !== 'turn_completed') return;
  const u = update.usage;
  if (!u || typeof u !== 'object') return;
  const partitioned = partitionInclusiveInputTokens(
    pickNum(u, ['inputTokens', 'input_tokens']),
    pickNum(u, ['cachedReadTokens', 'cache_read_input_tokens']),
    pickNum(u, ['cacheCreationTokens', 'cache_creation_input_tokens']),
  );
  const output = pickNum(u, ['outputTokens', 'output_tokens']);
  agg.inputTokens += partitioned.inputTokens;
  agg.outputTokens += output;
  agg.cacheReadTokens += partitioned.cacheReadTokens;
  agg.cacheCreateTokens += partitioned.cacheCreateTokens;
  // The terminal event is one complete turn, so latest-turn counters replace
  // the preceding turn instead of accumulating across the session.
  agg.turnInputTokens = partitioned.rawInputTokens;
  agg.turnOutputTokens = output;
  const modelUsage = u.modelUsage;
  if (!agg.model && modelUsage && typeof modelUsage === 'object') {
    const modelId = Object.keys(modelUsage).find(key => key.trim().length > 0);
    if (modelId) agg.model = modelId;
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
  // Pi 0.84+ native context accounting prefers usage.totalTokens; fall back to
  // the four-part sum (input + output + cacheRead + cacheWrite). input alone
  // excludes the current turn's output, which undercounts the real context.
  const totalTokens = num(u.totalTokens);
  const contextTokens = totalTokens > 0
    ? totalTokens
    : num(u.input) + num(u.output) + num(u.cacheRead) + num(u.cacheWrite);
  // Synthetic/empty assistant records (e.g. around compaction) must not erase
  // the last native context measurement.
  if (contextTokens > 0) {
    agg.latestContextUsage = buildPiContextUsage(contextTokens, typeof msg.model === 'string' ? msg.model : '', typeof msg.provider === 'string' ? msg.provider : '');
  }
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
    case 'grok':
      return foldGrokLine(agg, entry);
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
/** When the last tail window is missing a metric (a single huge turn can push
 *  the newest token_count snapshot — or the model line — out of it), do ONE
 *  bounded widen to this size and re-scan that whole window. It is the width of
 *  the single widened pass, NOT a cumulative ladder: the worst-case synchronous
 *  dashboard read is `tail + this`, and past it we fail closed (yield whatever
 *  the widened window found, never inheriting a possibly-stale value across an
 *  unverifiable generation boundary). */
export const CODEX_USAGE_MAX_BACKSCAN_BYTES = 32 * 1024 * 1024;

/** Aiden checkpoint paths move as the session progresses (latest.json points
 *  at a new checkpoint id per turn), so positive hits expire quickly too. */
const AIDEN_PATH_HIT_TTL_MS = 15_000;
const warnedOversizedUsageFiles = new Set<string>();

export function __resetSessionUsageCachesForTest(): void {
  usageFileCache.clear();
  warnedOversizedUsageFiles.clear();
  piModelsCache = null;
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

/** The two cumulative-usage metrics recovered. Used to decide when the bounded
 *  widen can stop: cumulative and context can sit on different lines, so a
 *  window that caught only one is not complete. Model is handled separately
 *  (see the model back-fill below) — it is a stable session-level attribute, so
 *  gating the (bounded) widen on it would force a re-scan for every rollout that
 *  simply never re-emits a model line inside the tail window. */
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
    // Oversized cold/bounded read. Fast path: scan the last tail window. Widen
    // ONCE to the back-scan budget and re-scan that whole window when the fast
    // path is incomplete — either the two usage metrics (cumulative/context)
    // are not both present, or this session is KNOWN to carry a model (the
    // cached read had one) but the fast window has none. A single >4MiB turn can
    // push the newest token_count — or a just-switched model line — out of the
    // tail window; the widen recovers the true latest of all of them. A single
    // widened pass (not a 4/8/.../32 ladder) keeps the worst-case synchronous
    // read at tail + budget, not their sum. Each pass scans from a fresh state;
    // Codex token_count/model are latest-wins, so re-folding older lines first
    // and letting the newest overwrite last is exact. Model is NOT inherited
    // from cache: a widen that still finds none fails closed to empty rather
    // than risk shipping a stale model (which mis-prices the ledger) after an
    // append-only model switch.
    const cachedHadModel = sameOpenFileAsCache && !!previousAgg?.model;
    baseOffset = Math.max(0, fdStat.size - CODEX_USAGE_TRANSCRIPT_TAIL_BYTES);
    let win = scanFromWindow(baseOffset, false);
    if (!win) {
      closeSync(fd);
      usageFileCache.delete(key);
      return null;
    }
    const fastPathIncomplete = !aggregateHasAllCodexMetrics(win.previewAgg)
      || (cachedHadModel && !win.previewAgg.model);
    if (fastPathIncomplete && baseOffset > 0) {
      const widenedBaseOffset = Math.max(0, fdStat.size - CODEX_USAGE_MAX_BACKSCAN_BYTES);
      if (widenedBaseOffset < baseOffset) {
        const widened = scanFromWindow(widenedBaseOffset, false);
        if (!widened) {
          closeSync(fd);
          usageFileCache.delete(key);
          return null;
        }
        baseOffset = widenedBaseOffset;
        win = widened;
      }
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
  const read = readSessionTokenAggregateCached(resolved.path, usageKindForCli(q.cliId), { fresh: q.fresh });
  if (q.cliId !== 'grok' || !read) return read;
  // signals.json is a small rewritten snapshot beside updates.jsonl. Read it
  // on every card refresh: the append-only JSONL cache may legitimately be
  // throttled, while the live context gauge and model can change independently.
  const agg = cloneAggregate(read.agg);
  let result = read.result ? { ...read.result } : null;
  const grokSessionDir = dirname(resolved.path);
  try {
    const signals = JSON.parse(readFileSync(join(grokSessionDir, 'signals.json'), 'utf8'));
    const usedTokens = num(signals?.contextTokensUsed);
    const windowTokens = num(signals?.contextWindowTokens);
    const reportedPercent = num(signals?.contextWindowUsage);
    if (usedTokens > 0 || windowTokens > 0) {
      const percentUsed = reportedPercent > 0
        ? Math.max(0, Math.min(100, Math.round(reportedPercent)))
        : windowTokens > 0
          ? Math.round(Math.max(0, Math.min(1, usedTokens / windowTokens)) * 100)
          : undefined;
      agg.latestContextUsage = {
        usedTokens,
        ...(windowTokens > 0 ? { windowTokens } : {}),
        ...(percentUsed !== undefined ? { percentUsed } : {}),
      };
    }
    const model = typeof signals?.primaryModelId === 'string' ? signals.primaryModelId.trim() : '';
    if (model) {
      agg.model = model;
      if (result) result = { ...result, model };
    }
  } catch {
    // A brand-new Grok session may not have written signals.json yet.
  }
  try {
    const summary = JSON.parse(readFileSync(join(grokSessionDir, 'summary.json'), 'utf8'));
    const reasoningEffort = typeof summary?.reasoning_effort === 'string'
      ? summary.reasoning_effort.trim()
      : '';
    if (reasoningEffort) agg.reasoningEffort = reasoningEffort;
    // signals.json is rewritten at turn end. A first-turn working card only
    // has summary.current_model_id until then — use it when fold/signals
    // did not already supply a model.
    const summaryModel = typeof summary?.current_model_id === 'string'
      ? summary.current_model_id.trim()
      : '';
    if (summaryModel && !agg.model) {
      agg.model = summaryModel;
      if (result) result = { ...result, model: summaryModel };
    }
  } catch {
    // summary.json is also created lazily; reasoning effort is optional.
  }
  return { agg, result };
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
  // 累计口径金额（区别于 ledger 的 delta 口径）：无 pricing 或模型未定价时
  // estimateCostCny 返回 null，字段缺省而非报错。
  const costCny = read?.result ? estimateCostCny(read.result, q.pricing) : null;
  return {
    context: agg?.latestContextUsage ?? null,
    tokens: read?.result ?? null,
    turnTokens,
    // Grok exposes a stable user-facing primaryModelId in signals.json.
    // Keep other CLIs unchanged: Relay-family transcript model strings may
    // be internal routing codes and intentionally never surface on cards.
    ...(q.cliId === 'grok' && agg?.model ? { model: agg.model } : {}),
    ...(q.cliId === 'grok' && agg?.reasoningEffort ? { reasoningEffort: agg.reasoningEffort } : {}),
    ...(costCny !== null && Number.isFinite(costCny) ? { costCny } : {}),
  };
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}
