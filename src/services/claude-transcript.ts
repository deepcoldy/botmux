/**
 * Incremental reader for Claude Code transcript JSONL files.
 *
 * Used by the adopt-bridge pipeline (worker.ts) to:
 *   1. baseline the transcript at attach time so historical messages aren't
 *      replayed to Lark.
 *   2. drain newly-appended assistant messages between user turns.
 *   3. tolerate truncation, rotation, half-written JSON lines, and races with
 *      Claude Code's writer.
 *
 * The functions are pure (no fs.watch — that's the worker's wakeup concern)
 * to keep them unit-testable.
 */
import { existsSync, openSync, readSync, closeSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { baselineJsonlCursor } from './jsonl-cursor.js';
import type { ModelFallbackState } from '../types.js';

/** Subset of Claude Code's JSONL event shape we care about. */
export interface TranscriptEvent {
  type?: string;
  subtype?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    /** Claude's API stop reason. `tool_use` is an intra-turn pause; terminal
     * reasons such as `end_turn` / `stop_sequence` close the logical turn. */
    stop_reason?: string | null;
    /** Model that actually served this reply (e.g. `claude-opus-4-8`). Claude
     *  Code writes the placeholder `<synthetic>` on API-error records. */
    model?: string;
  };
  /** API-error records. When the model call fails, Claude Code writes a
   *  `type:"assistant"` line with `isApiErrorMessage:true` and a machine
   *  `error` code (e.g. "rate_limit", "server_error", "authentication_failed",
   *  "unknown") plus the HTTP `apiErrorStatus`. These carry a human-readable
   *  text block ("You've hit your session limit · resets 10:40pm"), so they
   *  must be excluded from assistant-reply forwarding (they are not a model
   *  answer) and, for rate_limit, routed to usage-limit detection instead. */
  error?: string;
  errorDetails?: unknown;
  isApiErrorMessage?: boolean;
  apiErrorStatus?: number;
  /** Present on `type:"attachment"` lines. The bridge attribution queue
   *  treats `attachment.type === "queued_command"` as a turn-start signal —
   *  Claude writes one of these the moment it dequeues a type-ahead
   *  submission, immediately before the assistant's reply for that turn
   *  starts streaming. `prompt` carries the same content the user typed;
   *  shape is usually `string` but we tolerate the message-style array form
   *  via stringifyUserContent. */
  attachment?: {
    type?: string;
    prompt?: unknown;
    commandMode?: string;
  };
  /** Present on `type:"system"` model-switch records (see
   *  {@link parseClaudeModelFallbackEvent}). `scope:"local"` marks a sub-agent /
   *  side-question fallback that leaves the main session model untouched. */
  scope?: string;
  trigger?: string;
  originalModel?: string;
  fallbackModel?: string;
  apiRefusalCategory?: string;
}

/**
 * True when an event is Claude Code's structured rate-limit record: an
 * `isApiErrorMessage` line whose machine `error` code is "rate_limit" (429).
 * This is the authoritative "we are rate limited" signal — far more reliable
 * than scraping the TUI, and it lands exactly at the turn's terminal boundary.
 * The caller turns this into a `limited` session state via
 * structuredRateLimitState(); it must NOT be forwarded as an assistant reply.
 */
export function isTranscriptRateLimitEvent(ev: TranscriptEvent): boolean {
  if (!ev || typeof ev !== 'object') return false;
  return ev.error === 'rate_limit' || ev.apiErrorStatus === 429;
}

/** Concatenated text blocks of an API-error record, used to recover a human
 *  retry clock ("... resets 10:40pm") when present. Returns '' if none. */
export function apiErrorMessageText(ev: TranscriptEvent): string {
  const content = ev.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join(' ');
  }
  return '';
}

/** Kind of automatic model switch Claude Code recorded, mapped from the raw
 *  `type:"system"` subtype so the card copy can branch on one stable value. */
export type ClaudeModelFallbackKind = 'refusal' | 'unavailable' | 'consent';

const MODEL_FALLBACK_KIND_BY_SUBTYPE: Record<string, ClaudeModelFallbackKind> = {
  model_refusal_fallback: 'refusal',
  model_fallback: 'unavailable',
  model_consent_fallback: 'consent',
};

/** One parsed model-switch record. `scope: 'local'` is a sub-agent /
 *  side-question fallback: the main session model did NOT change, so surfacing
 *  it would mislead. Builds that predate the field omit it and read as
 *  'session'. */
export interface ClaudeModelFallbackRecord extends ModelFallbackState {
  scope: 'session' | 'local';
}

/** Normalise a model id for comparison: drop a trailing context-window suffix
 *  and lower-case. `originalModel` is written as `claude-fable-5-1[1m]` while an
 *  assistant record's `message.model` is the bare `claude-fable-5-1`; without
 *  this the "user switched back" check can never fire. */
export function normalizeClaudeModelId(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\[[^\]]*\]$/, '').trim().toLowerCase();
  return normalized || undefined;
}

/** Parse a `type:"system"` model-switch record. Returns undefined for anything
 *  else, and fail-closed for a record missing the uuid or either model id —
 *  a half-written switch must not produce a notice we can never clear. */
export function parseClaudeModelFallbackEvent(
  ev: TranscriptEvent,
): ClaudeModelFallbackRecord | undefined {
  if (!ev || typeof ev !== 'object' || ev.type !== 'system') return undefined;
  const kind = typeof ev.subtype === 'string'
    ? MODEL_FALLBACK_KIND_BY_SUBTYPE[ev.subtype]
    : undefined;
  if (!kind) return undefined;
  const uuid = typeof ev.uuid === 'string' ? ev.uuid.trim() : '';
  const originalModel = typeof ev.originalModel === 'string' ? ev.originalModel.trim() : '';
  const fallbackModel = typeof ev.fallbackModel === 'string' ? ev.fallbackModel.trim() : '';
  if (!uuid || !originalModel || !fallbackModel) return undefined;
  const trigger = typeof ev.trigger === 'string' ? ev.trigger.trim() : '';
  const apiRefusalCategory = typeof ev.apiRefusalCategory === 'string'
    ? ev.apiRefusalCategory.trim()
    : '';
  const observedAt = typeof ev.timestamp === 'string' ? ev.timestamp.trim() : '';
  return {
    uuid,
    kind,
    originalModel,
    fallbackModel,
    scope: ev.scope === 'local' ? 'local' : 'session',
    ...(trigger ? { trigger } : {}),
    ...(apiRefusalCategory ? { apiRefusalCategory } : {}),
    ...(observedAt ? { observedAt } : {}),
  };
}

/** Model that actually served an assistant record. Sub-agent output, API-error
 *  placeholders and Claude's `<synthetic>` sentinel are not the main session's
 *  model, so they yield undefined rather than a false "model changed". */
export function servingModelFromAssistantEvent(ev: TranscriptEvent): string | undefined {
  if (!ev || typeof ev !== 'object') return undefined;
  if ((ev as any).isSidechain === true) return undefined;
  if (ev.isApiErrorMessage === true || isTranscriptRateLimitEvent(ev)) return undefined;
  if ((ev.message?.role ?? ev.type) !== 'assistant') return undefined;
  const model = ev.message?.model?.trim();
  if (!model || model === '<synthetic>') return undefined;
  return model;
}

/** Resolve the model fallback still in effect from the newest session-scoped
 *  switch record plus the model serving replies AFTER it. A serving model that
 *  no longer matches means the user ran `/model` to switch back, so the notice
 *  clears. An unknown serving model (no assistant reply since the switch) keeps
 *  the notice — Claude stays on the fallback until told otherwise. */
export function resolveActiveModelFallback(opts: {
  fallback?: ClaudeModelFallbackRecord;
  servingModel?: string;
}): ModelFallbackState | null {
  const rec = opts.fallback;
  if (!rec || rec.scope === 'local') return null;
  const serving = normalizeClaudeModelId(opts.servingModel);
  if (serving && serving !== normalizeClaudeModelId(rec.fallbackModel)) return null;
  return {
    uuid: rec.uuid,
    kind: rec.kind,
    originalModel: rec.originalModel,
    fallbackModel: rec.fallbackModel,
    ...(rec.trigger ? { trigger: rec.trigger } : {}),
    ...(rec.apiRefusalCategory ? { apiRefusalCategory: rec.apiRefusalCategory } : {}),
    ...(rec.observedAt ? { observedAt: rec.observedAt } : {}),
  };
}

/** Upper bound on the backward scan below. Same guard rationale as
 *  TRAEX_RUNTIME_SCAN_MAX_BYTES: the fallback notice is advisory and must never
 *  synchronously parse a multi-GB transcript at bridge start. */
const CLAUDE_MODEL_FALLBACK_SCAN_MAX_BYTES = 4 * 1024 * 1024;

/** Recover the current model-fallback state from a transcript's tail, for the
 *  worker's cold start: baseline cursors straight to EOF, so a switch recorded
 *  before `--resume` / a daemon restart is never drained again.
 *
 *  Scans BACKWARD and stops at the newest session-scoped switch record; the
 *  serving model is therefore only collected from records NEWER than it, which
 *  is exactly what {@link resolveActiveModelFallback} needs (an assistant reply
 *  written before the switch says nothing about what serves now). A
 *  non-newline-terminated tail is excluded via baselineJsonlCursor. */
export function readLatestClaudeModelFallback(path: string): {
  fallback?: ClaudeModelFallbackRecord;
  servingModel?: string;
} {
  if (!path || !existsSync(path)) return {};
  let completeEnd: number;
  try { completeEnd = baselineJsonlCursor(path).newOffset; } catch { return {}; }
  if (completeEnd <= 0) return {};

  let fallback: ClaudeModelFallbackRecord | undefined;
  let servingModel: string | undefined;
  const emit = () => ({
    ...(fallback ? { fallback } : {}),
    ...(servingModel ? { servingModel } : {}),
  });
  const consider = (line: string): boolean => {
    if (!line.trim()) return false;
    let ev: TranscriptEvent;
    try { ev = JSON.parse(line) as TranscriptEvent; } catch { return false; }
    if (!ev || typeof ev !== 'object') return false;
    const rec = parseClaudeModelFallbackEvent(ev);
    if (rec) {
      if (rec.scope === 'local') return false;
      fallback = rec;
      return true;
    }
    if (!servingModel) servingModel = servingModelFromAssistantEvent(ev);
    return false;
  };

  const floor = Math.max(0, completeEnd - CLAUDE_MODEL_FALLBACK_SCAN_MAX_BYTES);
  const chunkBytes = 64 * 1024;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    let end = completeEnd;
    let carry = Buffer.alloc(0);
    while (end > floor) {
      const start = Math.max(floor, end - chunkBytes);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      const block = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
      let lineEnd = block.length;
      if (lineEnd > 0 && block[lineEnd - 1] === 0x0a) lineEnd--;
      let carryEnd = lineEnd;
      for (let i = lineEnd - 1; i >= 0; i--) {
        if (block[i] !== 0x0a) continue;
        const line = block.subarray(i + 1, lineEnd).toString('utf8');
        lineEnd = i;
        carryEnd = i;
        if (consider(line)) return emit();
      }
      // Drop the leading fragment only at the byte-cap floor (a truncated
      // historical partial); at true file start it is a complete record.
      carry = start === floor && floor > 0 ? Buffer.alloc(0) : block.subarray(0, carryEnd);
      end = start;
    }
    if (carry.length > 0) consider(carry.toString('utf8'));
  } catch {
    return emit();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return emit();
}

/** Bound on the tracker's dedupe set. A long session can switch models many
 *  times, so an unbounded set would leak slowly. */
const MODEL_FALLBACK_SEEN_UUIDS_MAX = 256;

/** Running model-fallback state for one Claude bridge. Owns the record-uuid
 *  dedupe (the same record is re-drained after a truncation or a jsonl switch)
 *  and the "serving model since the switch" rule, leaving the worker with only
 *  the decision of when to publish. */
export class ClaudeModelFallbackTracker {
  private readonly seenUuids = new Set<string>();
  private fallback: ClaudeModelFallbackRecord | undefined;
  private servingModel: string | undefined;

  /** Fold newly-drained events in, newest last. Returns the records newly
   *  accepted, for the caller to log. `scope:"local"` records are skipped
   *  outright: a sub-agent fell back on its own and the main session model is
   *  untouched. */
  observe(events: readonly TranscriptEvent[]): ClaudeModelFallbackRecord[] {
    const accepted: ClaudeModelFallbackRecord[] = [];
    for (const ev of events) {
      const rec = parseClaudeModelFallbackEvent(ev);
      if (rec) {
        if (rec.scope === 'local' || this.seenUuids.has(rec.uuid)) continue;
        this.seenUuids.add(rec.uuid);
        if (this.seenUuids.size > MODEL_FALLBACK_SEEN_UUIDS_MAX) {
          const oldest = this.seenUuids.values().next().value;
          if (oldest !== undefined) this.seenUuids.delete(oldest);
        }
        this.fallback = rec;
        // Replies written before the switch say nothing about what serves now;
        // keeping the old value would clear the notice the instant it appeared.
        this.servingModel = undefined;
        accepted.push(rec);
        continue;
      }
      const serving = servingModelFromAssistantEvent(ev);
      if (serving) this.servingModel = serving;
    }
    return accepted;
  }

  /** Recover the state from a transcript tail at bridge start (see
   *  {@link readLatestClaudeModelFallback}). */
  seed(path: string): void {
    const seeded = readLatestClaudeModelFallback(path);
    if (seeded.fallback) {
      this.fallback = seeded.fallback;
      this.seenUuids.add(seeded.fallback.uuid);
    }
    this.servingModel = seeded.servingModel;
  }

  /** The fallback still in effect, or null. */
  current(): ModelFallbackState | null {
    return resolveActiveModelFallback({
      fallback: this.fallback,
      servingModel: this.servingModel,
    });
  }
}

/** Provider-neutral terminal semantics derived from one Claude transcript
 * event. The classifier is deliberately fail-closed: an `unknown` API error is
 * retryable only when its bounded text matches a verified transient signature. */
export type ClaudeTerminalOutcome =
  | { status: 'completed' }
  | { status: 'failed'; errorCode: string; retryable: boolean }
  | { status: 'ambiguous'; errorCode: string; retryable: false }
  | { status: 'rate_limited'; errorCode: 'provider_rate_limited'; retryable: false };

function normalizedApiErrorCode(ev: TranscriptEvent): string {
  return String(ev.error ?? '').trim().toLowerCase();
}

function hasApiErrorSignature(ev: TranscriptEvent, pattern: RegExp): boolean {
  return pattern.test(apiErrorMessageText(ev));
}

export function classifyClaudeTerminalEvent(
  ev: TranscriptEvent,
): ClaudeTerminalOutcome | undefined {
  if (!ev || typeof ev !== 'object' || (ev as any).isSidechain === true) return undefined;
  if (isTranscriptRateLimitEvent(ev)) {
    return {
      status: 'rate_limited',
      errorCode: 'provider_rate_limited',
      retryable: false,
    };
  }
  if (ev.isApiErrorMessage === true) {
    const code = normalizedApiErrorCode(ev);
    const status = ev.apiErrorStatus;
    if (code.includes('auth') || status === 401 || status === 407) {
      return { status: 'failed', errorCode: 'provider_authentication_failed', retryable: false };
    }
    if (code.includes('permission') || code.includes('authorization') || status === 403) {
      return { status: 'failed', errorCode: 'provider_permission_denied', retryable: false };
    }
    if (code.includes('invalid') || code.includes('terms')
      || (typeof status === 'number' && status >= 400 && status <= 499)) {
      return { status: 'failed', errorCode: 'provider_invalid_request', retryable: false };
    }
    if (code.includes('cancel')) {
      return { status: 'failed', errorCode: 'provider_cancelled', retryable: false };
    }
    if (code === 'unknown' && hasApiErrorSignature(ev, /unexpected\s+eof/i)) {
      return { status: 'failed', errorCode: 'provider_unexpected_eof', retryable: true };
    }
    if (code === 'server_error'
      || (typeof status === 'number' && status >= 500 && status <= 599)
      || hasApiErrorSignature(ev, /(?:connection\s+(?:reset|lost|closed)|econnreset|http2:\s*client\s+connection\s+lost|closed\s+mid-response|internalserverexception|server\s+unavailable|temporarily\s+unavailable|overload(?:ed)?)/i)) {
      return { status: 'failed', errorCode: 'provider_server_error', retryable: true };
    }
    return { status: 'ambiguous', errorCode: 'provider_unknown_error', retryable: false };
  }
  if (ev.type === 'system' && ev.subtype === 'turn_duration') return undefined;
  const role = ev.message?.role ?? ev.type;
  if (role !== 'assistant') return undefined;
  const reason = ev.message?.stop_reason;
  if (typeof reason !== 'string' || reason.length === 0
    || reason === 'tool_use' || reason === 'pause_turn') return undefined;
  return { status: 'completed' };
}

/**
 * Authoritative Claude Code end-of-turn markers observed in its JSONL:
 *
 * - the final non-sidechain assistant message carries a non-tool stop reason;
 * - current Claude versions additionally append `system/turn_duration`.
 *
 * Both may be present for the same turn, so consumers must deduplicate by the
 * durable turn identity. `tool_use` and `pause_turn` are explicitly excluded:
 * Claude is waiting on a tool/continuation and has not returned to a new turn.
 */
export function isClaudeTurnTerminalEvent(ev: TranscriptEvent): boolean {
  if (!ev || typeof ev !== 'object' || (ev as any).isSidechain === true) return false;
  if (ev.type === 'system' && ev.subtype === 'turn_duration') return true;
  const role = ev.message?.role ?? ev.type;
  if (role !== 'assistant') return false;
  const reason = ev.message?.stop_reason;
  return typeof reason === 'string'
    && reason.length > 0
    && reason !== 'tool_use'
    && reason !== 'pause_turn';
}

/** Extract the user-typed prompt text for a "turn start" event — works for
 *  both legacy `role:user` events (text in `message.content`) and the
 *  type-ahead `attachment(queued_command)` form (text in `attachment.prompt`).
 *  Returns '' when neither shape carries usable content. Used at three
 *  layers: BridgeTurnQueue.ingest (fingerprint-match the right pending Lark
 *  turn), worker emit (local-turn user-text resolution), and tests. */
export function extractTurnStartText(ev: TranscriptEvent | null | undefined): string {
  if (!ev || typeof ev !== 'object') return '';
  if (ev.type === 'attachment' && ev.attachment?.type === 'queued_command') {
    const prompt = ev.attachment.prompt;
    if (typeof prompt === 'string') return prompt;
    return stringifyUserContent(prompt);
  }
  return stringifyUserContent(ev.message?.content);
}

export interface DrainResult {
  events: TranscriptEvent[];
  /** Byte offset to pass back on the next drain. */
  newOffset: number;
  /** Trailing partial line (no newline yet) — kept so the next drain can
   *  prepend it. Internal helper for chained drains; callers usually only
   *  need to remember `newOffset`. */
  pendingTail: string;
}

/**
 * Read everything from `path` starting at `fromOffset` and return parsed
 * JSONL events plus the new file offset.
 *
 * - Returns `{ events: [], newOffset: 0, pendingTail: '' }` if the file
 *   doesn't exist (caller treats this as "nothing yet").
 * - Detects truncation (size < fromOffset): resets to 0 and re-drains so a
 *   rotated/cleared transcript doesn't silently swallow new lines.
 * - Skips malformed JSON lines (logs nothing — robustness over noise).
 * - The trailing partial line (no `\n` yet) is *not* parsed and *not*
 *   counted toward `newOffset`, so the next drain re-reads it.
 */
export function drainTranscript(
  path: string,
  fromOffset: number,
): DrainResult {
  if (!existsSync(path)) {
    return { events: [], newOffset: 0, pendingTail: '' };
  }
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { events: [], newOffset: fromOffset, pendingTail: '' };
  }
  let start = fromOffset;
  if (size < start) {
    // Truncated/rotated — re-read from the top.
    start = 0;
  }
  if (size === start) {
    return { events: [], newOffset: start, pendingTail: '' };
  }
  const len = size - start;
  const buf = Buffer.alloc(len);
  let read = 0;
  const fd = openSync(path, 'r');
  try {
    read = readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }
  const text = buf.subarray(0, read).toString('utf8');

  // Find the last '\n' — anything after it is a partial line we shouldn't
  // commit yet. Adjust newOffset to exclude the partial tail so the next
  // drain re-reads it.
  const lastNl = text.lastIndexOf('\n');
  let toParse: string;
  let pendingTail: string;
  let newOffset: number;
  if (lastNl < 0) {
    // No complete line at all — treat the whole buffer as pending.
    toParse = '';
    pendingTail = text;
    newOffset = start;
  } else {
    toParse = text.substring(0, lastNl);
    pendingTail = text.substring(lastNl + 1);
    newOffset = start + Buffer.byteLength(text.substring(0, lastNl + 1), 'utf8');
  }

  const events: TranscriptEvent[] = [];
  if (toParse) {
    for (const line of toParse.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === 'object') events.push(obj as TranscriptEvent);
      } catch {
        // Malformed line — skip silently. Claude Code's writer is atomic per
        // line, so this means a debug/non-JSON line snuck in; not our concern.
      }
    }
  }
  return { events, newOffset, pendingTail };
}

/**
 * Filter to assistant text events. Returns only events where:
 *   - type === 'assistant' OR message.role === 'assistant'
 *   - content has at least one text block
 *   - uuid is present
 *
 * Sub-agent / sidechain events (isSidechain === true) are excluded so that
 * spawn-internal Task agent chatter doesn't leak to Lark.
 */
export function pickAssistantTextEvents(events: TranscriptEvent[]): TranscriptEvent[] {
  return events.filter(e => {
    if (!e || typeof e !== 'object') return false;
    if ((e as any).isSidechain === true) return false;
    // API-error lines are execution metadata rather than assistant answers.
    // The bridge emits a structured terminal outcome (or the existing limited
    // state) and daemon-owned recovery/attention provides user visibility.
    if (e.isApiErrorMessage === true || isTranscriptRateLimitEvent(e)) return false;
    const role = e.message?.role ?? e.type;
    if (role !== 'assistant') return false;
    if (!e.uuid) return false;
    const content = e.message?.content;
    if (!content) return false;
    if (typeof content === 'string') return content.length > 0;
    if (Array.isArray(content)) return content.some(b => b && b.type === 'text' && typeof b.text === 'string' && b.text.length > 0);
    return false;
  });
}

/**
 * Extract the visible text from one assistant event. Walks all `type:'text'`
 * blocks in `message.content` (or the bare string) and joins them with
 * blank lines. Returns '' if no text blocks.
 */
export function extractAssistantText(event: TranscriptEvent): string {
  const content = event.message?.content;
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text);
    }
  }
  return parts.join('\n\n');
}

/**
 * Extract the model's thinking (CoT) text from one assistant event. Walks all
 * `type:'thinking'` blocks in `message.content` and joins them with blank
 * lines. Returns '' when the event carries no thinking blocks. Sidechain /
 * error filtering is the caller's job (bridge-turn-queue already applies it
 * before attribution).
 */
export function extractAssistantThinking(event: TranscriptEvent): string {
  const content = event.message?.content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && (block as any).type === 'thinking' && typeof (block as any).thinking === 'string' && (block as any).thinking.length > 0) {
      parts.push((block as any).thinking);
    }
  }
  return parts.join('\n\n');
}

/** Per-entry truncation caps for the CoT tool timeline. Tool args (Write
 *  contents, long prompts) and results (file reads, command output) can be
 *  hundreds of KB — the bubble only needs a recognisable preview. */
const COT_TOOL_ARGS_MAX_CHARS = 600;
const COT_TOOL_RESULT_MAX_CHARS = 800;

function truncateForCot(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** One node of the native CoT message. Mirrors `CotEntry` in types.ts —
 *  redeclared structurally here to keep this module dependency-free. */
export type TranscriptCotEntry =
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; id: string; name: string; args: string }
  | { kind: 'tool_result'; id: string; result: string };

/** Flatten a tool_result block's content (string, or array of text blocks)
 *  to a display string. Non-text blocks (images) are skipped. */
function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n');
}

/**
 * Extract the CoT (thinking process) entries from one transcript event, in
 * content-block order:
 *   - assistant events → `thinking` blocks and `tool_use` blocks
 *     (id + name + JSON-stringified input, truncated);
 *   - user events → `tool_result` blocks (tool_use_id + flattened text,
 *     truncated).
 * Returns [] for events carrying neither. Sidechain / error filtering is the
 * caller's job (bridge-turn-queue applies it before attribution).
 */
export function extractCotEntries(event: TranscriptEvent): TranscriptCotEntry[] {
  const content = event.message?.content;
  if (!Array.isArray(content)) return [];
  const entries: TranscriptCotEntry[] = [];
  for (const block of content as any[]) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) {
      entries.push({ kind: 'thinking', text: block.thinking });
    } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      let args = '';
      try { args = block.input === undefined ? '' : JSON.stringify(block.input); } catch { /* unserialisable input — show none */ }
      entries.push({ kind: 'tool_call', id: block.id, name: block.name, args: truncateForCot(args, COT_TOOL_ARGS_MAX_CHARS) });
    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      const result = stringifyToolResultContent(block.content);
      entries.push({ kind: 'tool_result', id: block.tool_use_id, result: truncateForCot(result, COT_TOOL_RESULT_MAX_CHARS) });
    }
  }
  return entries;
}

/** Convenience: filter+extract a list of events into a single concatenated string. */
export function joinAssistantText(events: TranscriptEvent[]): string {
  return pickAssistantTextEvents(events)
    .map(extractAssistantText)
    .filter(s => s.length > 0)
    .join('\n\n');
}

function hasToolUseBlock(ev: TranscriptEvent): boolean {
  const content = ev.message?.content;
  return Array.isArray(content) && content.some(b => b && (b as any).type === 'tool_use');
}

/**
 * The turn's FINAL answer: the contiguous run of this turn's assistant-text
 * events after its last tool_use. A long agentic turn writes many interim
 * narration blocks between tool calls; joining them all (joinAssistantText)
 * makes the fallback both post a narration collage AND look "materially
 * longer" than the model's own explicit `botmux send`, defeating the
 * bridge-fallback gate. Walking back from the turn's last text event until a
 * tool_use / tool_result boundary yields just the closing answer.
 *
 * Crossed (not boundaries): thinking-only assistant lines and non-message
 * meta lines (`last-prompt`, `ai-title`, system, attachments) — Claude Code
 * interleaves these freely inside a closing answer. Events from other turns
 * never contribute: only uuids in `turnAssistantUuids` are collected.
 * Returns '' for a turn with no text after its last tool_use (nothing worth
 * falling back with — e.g. the turn ended in a `botmux send` call).
 */
export function trailingAssistantText(events: TranscriptEvent[], turnAssistantUuids: readonly string[]): string {
  if (turnAssistantUuids.length === 0) return '';
  const uuids = new Set(turnAssistantUuids);
  const lastUuid = turnAssistantUuids[turnAssistantUuids.length - 1];
  let end = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.uuid === lastUuid) { end = i; break; }
  }
  if (end === -1) return '';
  // The turn must actually END in text: if an assistant tool_use line follows
  // the last text event (before any real next-turn user message), the turn
  // closed mid-tooling — there is no final answer to fall back with.
  for (let i = end + 1; i < events.length; i++) {
    const ev = events[i];
    if (!ev || typeof ev !== 'object') continue;
    const role = ev.message?.role ?? ev.type;
    if (role === 'assistant' && hasToolUseBlock(ev)) return '';
    if (role === 'user' && isMeaningfulUserEvent(ev)) break;
  }
  const tail: TranscriptEvent[] = [];
  for (let i = end; i >= 0; i--) {
    const ev = events[i];
    if (!ev || typeof ev !== 'object') continue;
    const role = ev.message?.role ?? ev.type;
    if (role === 'assistant') {
      if (hasToolUseBlock(ev)) break;
      if (ev.uuid && uuids.has(ev.uuid)) { tail.unshift(ev); continue; }
      // Thinking-only / non-turn assistant lines: cross unless they belong to
      // a DIFFERENT turn's visible text (then we've walked past our turn).
      if (pickAssistantTextEvents([ev]).length > 0) break;
      continue;
    }
    if (role === 'user') break;
    // system / attachment / meta lines (last-prompt, ai-title, …): cross.
  }
  return joinAssistantText(tail);
}

/** XML wrappers Claude Code uses for synthetic user events that aren't real
 *  prompts (slash command invocation, local-command output caveat, etc.).
 *  These should usually carry `isMeta:true` and we'd filter on that — this
 *  list is a defense-in-depth check for jsonls where the flag is absent. */
const SYNTHETIC_USER_PREFIXES = [
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<task-notification>',
];

/** True when a `type:'user'` (or `message.role:'user'`) event represents a
 *  *real* prompt the human typed — not Claude Code's internal machinery
 *  (tool_result, slash-command wrappers, isMeta/isCompactSummary markers,
 *  sidechain spawn events). The bridge attribution queue and the adopt
 *  preamble extractor share this predicate to ensure they're seeing the
 *  same notion of "user input". */
export function isMeaningfulUserEvent(ev: TranscriptEvent | null | undefined): boolean {
  if (!ev || typeof ev !== 'object') return false;
  const role = ev.message?.role ?? ev.type;
  if (role !== 'user') return false;
  const flags = ev as any;
  if (flags.isMeta === true) return false;
  if (flags.isCompactSummary === true) return false;
  if (flags.isSidechain === true) return false;
  const content = ev.message?.content;
  if (isPureToolResultUserEvent(content)) return false;
  const text = normaliseForFingerprint(stringifyUserContent(content));
  if (text.length === 0) return false;
  if (SYNTHETIC_USER_PREFIXES.some(p => text.startsWith(p))) return false;
  return true;
}

/** True when a `type:'attachment'` line carries a queued-command payload
 *  representing a real submitted prompt. Claude writes one of these when it
 *  dequeues a type-ahead submission (right before the assistant's reply for
 *  that turn starts streaming) — the bridge attribution queue treats it
 *  exactly like a `role:user` event for turn-start purposes. Filters mirror
 *  isMeaningfulUserEvent's defenses (sidechain, empty / synthetic-prefix
 *  prompts) so a queued slash command can't false-start a Lark turn. */
export function isMeaningfulQueuedCommand(ev: TranscriptEvent | null | undefined): boolean {
  if (!ev || typeof ev !== 'object') return false;
  if (ev.type !== 'attachment') return false;
  if (ev.attachment?.type !== 'queued_command') return false;
  if (ev.attachment.commandMode === 'task-notification') return false;
  if ((ev as any).isSidechain === true) return false;
  const text = normaliseForFingerprint(extractTurnStartText(ev));
  if (text.length === 0) return false;
  if (SYNTHETIC_USER_PREFIXES.some(p => text.startsWith(p))) return false;
  return true;
}

export interface AdoptPreamble {
  /** The most recent meaningful user prompt's text (post-stringify, no
   *  whitespace collapse — preserves the prompt's actual formatting). */
  userText: string;
  /** All assistant visible-text emitted between that user prompt and the
   *  end of the events list, joined with blank lines. tool_use blocks are
   *  excluded; sidechain assistant events are excluded. */
  assistantText: string;
}

/** Walk the events forward and return the last *completed* user/assistant
 *  exchange. "Completed" here means: a meaningful user prompt followed by
 *  at least one assistant event with visible text. tool_use / tool_result
 *  events do NOT reset the turn — they're intra-turn machinery, so a
 *  prompt → tool_use → tool_result → assistant text sequence still counts
 *  as a single turn. Returns null when there's no meaningful user yet, or
 *  the last user wasn't followed by any visible assistant text (Claude is
 *  mid-tool-use when /adopt fired).
 *
 *  Used by adopt-bridge to surface "the previous round" to the Lark thread
 *  so the user has context for continuing the conversation. */
export function extractLastAssistantTurn(events: TranscriptEvent[]): AdoptPreamble | null {
  let userText: string | null = null;
  let assistantTexts: string[] = [];

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (isMeaningfulUserEvent(ev)) {
      // New turn boundary — reset the assistant accumulator.
      userText = stringifyUserContent(ev.message?.content);
      assistantTexts = [];
      continue;
    }
    const role = ev.message?.role ?? ev.type;
    if (role !== 'assistant') continue;
    if ((ev as any).isSidechain === true) continue;
    const text = extractAssistantText(ev);
    if (text.length === 0) continue;
    if (userText !== null) assistantTexts.push(text);
  }

  if (userText === null || assistantTexts.length === 0) return null;
  return {
    userText,
    assistantText: assistantTexts.join('\n\n'),
  };
}

/**
 * True when a user-role event carries ONLY tool_result blocks — Claude
 * Code's representation of "tool returned this output" between an
 * assistant tool_use and the assistant's continuation. Both the bridge
 * attribution queue and the on-disk fingerprint search must skip these:
 *
 *   - the queue would treat tool output as fresh local input and disable
 *     collection mid-turn,
 *   - the fingerprint search would false-positive on log content that
 *     happens to contain the Lark fingerprint substring (e.g. a short
 *     "hello" message hijacked by an unrelated jsonl whose tool_result
 *     dumped a log line containing "hello"). Re-exported by
 *     bridge-turn-queue.ts so both consumers share the same predicate
 *     and never drift apart.
 */
export function isPureToolResultUserEvent(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((block: any) => block?.type === 'tool_result');
}

/**
 * Stringify a transcript user event's content to a flat string. Handles
 * both legacy bare-string content and the array-of-blocks form.
 *
 * Lives here (not in bridge-turn-queue.ts) so the in-process attribution
 * state machine and the on-disk fingerprint search use *exactly* the
 * same text — otherwise multi-line / array-content Lark messages stop
 * matching one path or the other and bridges silently break.
 */
export function stringifyUserContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as any[]) {
    if (typeof block?.text === 'string') parts.push(block.text);
    else if (typeof block?.content === 'string') parts.push(block.content);
  }
  return parts.join('\n');
}

/**
 * Collapse whitespace + trim. Same normalisation applied on both sides
 * of the fingerprint compare (the Lark message that produces the
 * fingerprint, and the transcript user content we search through),
 * so newlines / tabs / double-spaces don't break the match.
 */
export function normaliseForFingerprint(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Find the most recently-modified `.jsonl` file in a Claude Code project
 * directory.
 *
 * `acceptCandidate` lets callers narrow the candidate set — the bridge's
 * quiet-mtime fallback passes a trust-set predicate so a sibling Claude
 * pane writing in the same project dir cannot hijack the watcher.
 * Without it any actively-written sibling jsonl wins the mtime race and
 * the bridge enters a flap loop with the pid resolver pulling it back.
 *
 * Returns null when the directory doesn't exist, has no jsonl files, or
 * every candidate was rejected by `acceptCandidate`.
 */
export function findLatestJsonl(
  dir: string,
  opts?: { acceptCandidate?: (path: string) => boolean },
): string | null {
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const accept = opts?.acceptCandidate;
  let latestPath: string | null = null;
  let latestMtime = -Infinity;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const full = join(dir, name);
    if (accept && !accept(full)) continue;
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      if (st.mtimeMs > latestMtime) {
        latestMtime = st.mtimeMs;
        latestPath = full;
      }
    } catch {
      // File disappeared between readdir and stat — ignore.
    }
  }
  return latestPath;
}

/**
 * Search every `.jsonl` file in `dir` for one whose contents include the
 * given fingerprint. Used by the bridge watcher to detect a session
 * switch (`/clear` / `/resume`) caused by the user's pane: when a Lark
 * message is pending and its content fingerprint shows up in a NEW jsonl
 * file, that file is the user's current session and we should switch.
 *
 * Pinning the switch decision to fingerprint match (rather than mtime)
 * avoids hijacking by sibling Claude Code panes in the same project
 * directory — they'll write busy jsonls but won't ever contain our Lark
 * fingerprint.
 *
 * Optional `excludePath` skips the file we're already watching so the
 * caller's "did it change?" comparison is cheap.
 *
 * Reads only the trailing 1 MB of each candidate (fingerprints land near
 * the end of the jsonl when Claude has just written them) — long-lived
 * sessions can grow to tens of MB so a full read would be wasteful.
 * Callers should still gate on "an unstarted pending turn exists" rather
 * than calling this on every poll tick.
 */
export interface JsonlFingerprintSearchOptions {
  /** Skip the file the caller is already watching/checking. */
  excludePath?: string;
  /** Ignore older files when the caller is looking for a just-written submit. */
  minMtimeMs?: number;
  /** Drop events whose `timestamp` field is older than this (millis since
   *  epoch). Defends against short fingerprints ("hello", "test") matching
   *  old user lines in unrelated sibling jsonls — file mtime alone isn't
   *  enough since a sibling Claude pane could be actively writing. */
  minEventTimestampMs?: number;
  /** Also match Claude Code type-ahead enqueue events, whose content is not role:user. */
  includeQueueOperations?: boolean;
  /** Called on each candidate that already passed the fingerprint match.
   *  Returning `false` skips the candidate and continues searching older
   *  files in the directory (mtime-descending walk). Used by the bridge
   *  watcher to reject sibling-pane jsonls whose sessionId we don't trust,
   *  without losing the chance to find a legitimate /clear rotation buried
   *  under a busier sibling. Default (no callback): accept the first
   *  fingerprint match like the original behaviour. */
  acceptCandidate?: (path: string) => boolean;
}

/** Scan a single jsonl file's tail for a Lark message fingerprint. Same
 *  parsing rules as `findJsonlContainingFingerprint` (decode role:user content,
 *  optionally also queue-operation/enqueue, normalise whitespace, then
 *  substring-match the fingerprint). Used by the claude-code adapter when
 *  the pid resolver has just switched to a rotated jsonl that may already
 *  contain the just-submitted user event. */
export function jsonlContainsFingerprint(
  path: string,
  fingerprint: string,
  opts?: { includeQueueOperations?: boolean; minEventTimestampMs?: number },
): boolean {
  if (fingerprint.length === 0 || !existsSync(path)) return false;
  let size: number;
  try { size = statSync(path).size; } catch { return false; }
  if (size === 0) return false;
  const includeQueueOps = opts?.includeQueueOperations ?? false;
  const minEventTimestampMs = opts?.minEventTimestampMs;
  const len = Math.min(size, 1024 * 1024);
  let buf: Buffer;
  try {
    const fd = openSync(path, 'r');
    try {
      buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  // Skip the leading partial line when we read a strict tail (size > len).
  const startIdx = size > len ? 1 : 0;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;
    // Per-event timestamp guard: short fingerprints would otherwise
    // false-match old user events in unrelated sibling jsonls (file
    // mtime can be recent if a sibling Claude pane is actively writing
    // its own turns). We compare against `event.timestamp` rather than
    // file mtime to be precise.
    if (minEventTimestampMs !== undefined && typeof ev.timestamp === 'string') {
      const evMs = Date.parse(ev.timestamp);
      if (Number.isFinite(evMs) && evMs < minEventTimestampMs) continue;
    }
    const role = ev.message?.role ?? ev.type;
    let lineText = '';
    if (role === 'user') {
      // Skip pure tool_result events — Claude Code records them as
      // role:user but they're internal turn machinery, not the user's
      // actual prompt. A tool_result that dumps log output containing
      // the fingerprint substring would otherwise hijack the search.
      if (isPureToolResultUserEvent(ev.message?.content)) continue;
      lineText = stringifyUserContent(ev.message?.content);
    } else if (
      includeQueueOps &&
      ev.type === 'queue-operation' &&
      ev.operation === 'enqueue'
    ) {
      lineText = typeof ev.content === 'string' ? ev.content : stringifyUserContent(ev.content);
    } else {
      continue;
    }
    const normalisedText = normaliseForFingerprint(lineText);
    if (normalisedText.length > 0 && normalisedText.includes(fingerprint)) return true;
  }
  return false;
}

export function findJsonlContainingFingerprint(
  dir: string,
  fingerprint: string,
  excludePathOrOptions?: string | JsonlFingerprintSearchOptions,
): string | null {
  if (!existsSync(dir) || fingerprint.length === 0) return null;
  const opts: JsonlFingerprintSearchOptions =
    typeof excludePathOrOptions === 'string'
      ? { excludePath: excludePathOrOptions }
      : (excludePathOrOptions ?? {});
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  // Walk newest-first so a recently-rotated jsonl is found before older
  // ones; if two files contain the fingerprint (rare, e.g. user pasted
  // the same message into two panes) we prefer the more recent.
  const candidates: Array<{ path: string; mtime: number }> = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const full = join(dir, name);
    if (opts.excludePath && full === opts.excludePath) continue;
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      if (opts.minMtimeMs !== undefined && st.mtimeMs < opts.minMtimeMs) continue;
      candidates.push({ path: full, mtime: st.mtimeMs });
    } catch { /* ignore */ }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const { path } of candidates) {
    try {
      const fd = openSync(path, 'r');
      try {
        const size = statSync(path).size;
        // Read at most the trailing 1MB — fingerprints land near the end
        // of the jsonl when Claude just wrote them. Cheaper than reading
        // an entire long-lived session.
        const len = Math.min(size, 1024 * 1024);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, size - len);
        const text = buf.toString('utf8');
        // We must NOT do a raw includes() here: Claude writes user content
        // as a JSON-encoded string, so any newline in the Lark message is
        // serialized as `\n` on disk while our fingerprint has it
        // collapsed to a single space. Parse each complete jsonl line,
        // pick role:user events, and apply the same stringify+normalise
        // we use in BridgeTurnQueue.ingest. Skip the leading partial line
        // when we read a strict tail (size > len), since it likely begins
        // mid-line.
        const lines = text.split('\n');
        const startIdx = size > len ? 1 : 0;
        for (let i = startIdx; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }
          if (!ev || typeof ev !== 'object') continue;
          // Per-event timestamp guard — see jsonlContainsFingerprint for
          // the full rationale. Required to keep short fingerprints
          // ("hello", "test") from matching old user lines in unrelated
          // sibling jsonls.
          if (opts.minEventTimestampMs !== undefined && typeof ev.timestamp === 'string') {
            const evMs = Date.parse(ev.timestamp);
            if (Number.isFinite(evMs) && evMs < opts.minEventTimestampMs) continue;
          }
          const role = ev.message?.role ?? ev.type;
          let text = '';
          if (role === 'user') {
            // Skip pure tool_result events — see jsonlContainsFingerprint
            // for the full rationale; in short, tool_result content is
            // log output, not user input, and would false-match short
            // fingerprints like "hello" in unrelated jsonls.
            if (isPureToolResultUserEvent(ev.message?.content)) continue;
            text = stringifyUserContent(ev.message?.content);
          } else if (
            opts.includeQueueOperations &&
            ev.type === 'queue-operation' &&
            ev.operation === 'enqueue'
          ) {
            text = typeof ev.content === 'string' ? ev.content : stringifyUserContent(ev.content);
          } else {
            continue;
          }
          const normalisedText = normaliseForFingerprint(text);
          if (normalisedText.length > 0 && normalisedText.includes(fingerprint)) {
            // Allow caller to veto this candidate (e.g., sibling-pane
            // hijack guard rejecting an untrusted sessionId). On veto,
            // break out of the line loop so we move to the next, older
            // candidate instead of returning `null` after the first
            // fingerprint hit.
            if (opts.acceptCandidate && !opts.acceptCandidate(path)) {
              break;
            }
            return path;
          }
        }
      } finally {
        closeSync(fd);
      }
    } catch { /* unreadable — skip */ }
  }
  return null;
}

/**
 * Stronger sibling-pane recovery anchor than the substring fingerprint
 * search. Walks every `.jsonl` in `dir` and returns the paths whose
 * trailing 1MB contains a user/queue event whose normalised text is
 * EXACTLY equal to `normalisedContent` (not a substring), respecting
 * `excludePath`, `minMtimeMs`, `minEventTimestampMs`,
 * `includeQueueOperations`, and `acceptCandidate` the same way as
 * `findJsonlContainingFingerprint`.
 *
 * Returns *all* matches in mtime-descending order — callers must
 * abstain when the result has length > 1, since multiple files containing
 * the same exact normalised content cannot be disambiguated without
 * stronger evidence (and forcing a switch would risk picking the wrong
 * pane). The caller's typical pattern is:
 *
 *   - 1 match → switch to it (legitimate post-/clear recovery)
 *   - 0 matches → no recovery this tick; wait for stronger signal
 *   - >1 match → log and abstain; surface a diagnostic to the user
 *
 * Used by the bridge fingerprint fallback's recovery path for in-pane
 * `/clear`: substring matches risk hijacking on short fingerprints (the
 * literal text "test" matches "run tests" / "test bridge"), but full
 * equality on a Lark message we just wrote is a much stronger anchor.
 */
export function findJsonlsContainingExactContent(
  dir: string,
  normalisedContent: string,
  options?: JsonlFingerprintSearchOptions,
): string[] {
  if (!existsSync(dir) || normalisedContent.length === 0) return [];
  const opts: JsonlFingerprintSearchOptions = options ?? {};
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const candidates: Array<{ path: string; mtime: number }> = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const full = join(dir, name);
    if (opts.excludePath && full === opts.excludePath) continue;
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      if (opts.minMtimeMs !== undefined && st.mtimeMs < opts.minMtimeMs) continue;
      candidates.push({ path: full, mtime: st.mtimeMs });
    } catch { /* ignore */ }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const matches: string[] = [];
  for (const { path } of candidates) {
    if (opts.acceptCandidate && !opts.acceptCandidate(path)) continue;
    try {
      const fd = openSync(path, 'r');
      try {
        const size = statSync(path).size;
        const len = Math.min(size, 1024 * 1024);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, size - len);
        const text = buf.toString('utf8');
        const lines = text.split('\n');
        const startIdx = size > len ? 1 : 0;
        let hit = false;
        for (let i = startIdx; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }
          if (!ev || typeof ev !== 'object') continue;
          if (opts.minEventTimestampMs !== undefined && typeof ev.timestamp === 'string') {
            const evMs = Date.parse(ev.timestamp);
            if (Number.isFinite(evMs) && evMs < opts.minEventTimestampMs) continue;
          }
          const role = ev.message?.role ?? ev.type;
          let raw = '';
          if (role === 'user') {
            if (isPureToolResultUserEvent(ev.message?.content)) continue;
            raw = stringifyUserContent(ev.message?.content);
          } else if (
            opts.includeQueueOperations &&
            ev.type === 'queue-operation' &&
            ev.operation === 'enqueue'
          ) {
            raw = typeof ev.content === 'string' ? ev.content : stringifyUserContent(ev.content);
          } else {
            continue;
          }
          const normalised = normaliseForFingerprint(raw);
          if (normalised === normalisedContent) {
            hit = true;
            break;
          }
        }
        if (hit) matches.push(path);
      } finally {
        closeSync(fd);
      }
    } catch { /* unreadable — skip */ }
  }
  return matches;
}

/**
 * Partition transcript events into history (timestamp ≤ cutoff) and live
 * (timestamp > cutoff, or no parseable timestamp). Used by the bridge
 * watcher when it switches to a new jsonl that may contain pre-existing
 * conversation: anything older than the cutoff (e.g. iTerm-typed turns
 * the user produced before the Lark mark fired) belongs in the seen-set
 * via `BridgeTurnQueue.absorb` so the worker doesn't replay them as
 * "🖥️ 终端本地对话" cards. Anything newer is fed through `ingest()` so
 * the freshly-written Lark user event can match its pending fingerprint.
 *
 * Events with malformed / missing timestamps fall into `live`: better
 * to forward an unattributable event once than to silently drop a real
 * reply because Claude omitted a timestamp.
 */
export function splitTranscriptEventsByCutoff(
  events: TranscriptEvent[],
  cutoffMs: number,
): { history: TranscriptEvent[]; live: TranscriptEvent[] } {
  const history: TranscriptEvent[] = [];
  const live: TranscriptEvent[] = [];
  for (const ev of events) {
    let evMs = Number.NaN;
    if (typeof ev.timestamp === 'string') evMs = Date.parse(ev.timestamp);
    if (Number.isFinite(evMs) && evMs <= cutoffMs) history.push(ev);
    else live.push(ev);
  }
  return { history, live };
}

/**
 * Read the first event timestamp out of a jsonl. Reads only the leading
 * 4 KB — Claude's `file-history-snapshot` and `SessionStart` events both
 * land in the first few hundred bytes. Returns the parsed millis, or
 * undefined when no parseable timestamp is found in the leading chunk
 * (corrupted file, partial first line, format change).
 *
 * NOTE: not currently wired into the bridge rotation flow. The bridge
 * fingerprint fallback (`decideFingerprintSwitch` in
 * `bridge-rotation-policy.ts`) deliberately rejects candidates outside
 * the pid-derived trust set rather than relying on freshness heuristics
 * — file-creation timestamps cannot prove ownership across panes in
 * the same project dir. Kept here as a reusable primitive for
 * diagnostics and future /clear-recovery work.
 */
export function readFirstEventTimestamp(path: string): number | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const len = 4096;
    const buf = Buffer.alloc(len);
    let bytesRead = 0;
    try {
      bytesRead = readSync(fd, buf, 0, len, 0);
    } catch {
      return undefined;
    }
    if (bytesRead <= 0) return undefined;
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const lines = text.split('\n');
    // Drop the trailing partial line if we read exactly `len` bytes — it
    // may not be a complete JSON object. When the whole file is shorter
    // than `len` bytes the last line is complete and we keep it.
    const usable = bytesRead === len ? lines.slice(0, -1) : lines;
    for (const line of usable) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let ev: any;
      try { ev = JSON.parse(trimmed); } catch { continue; }
      // Top-level `timestamp` field — covers both regular events
      // (user/assistant/attachment) and `file-history-snapshot` records
      // whose `timestamp` lives under `snapshot.timestamp` instead.
      const tsStr = typeof ev?.timestamp === 'string'
        ? ev.timestamp
        : typeof ev?.snapshot?.timestamp === 'string'
          ? ev.snapshot.timestamp
          : undefined;
      if (!tsStr) continue;
      const ms = Date.parse(tsStr);
      if (Number.isFinite(ms)) return ms;
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}
