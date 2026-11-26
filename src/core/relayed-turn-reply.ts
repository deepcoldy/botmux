import type { IncomingHttpHeaders } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { DaemonSession } from './types.js';
import type { TurnSendKind } from '../services/turn-send-ledger.js';
import {
  RELAYED_TURN_REPLY_HEADERS,
  RELAYED_TURN_REPLY_RESPONSE_MAX_BYTES,
  sealRelayedTurnReplyRequest,
  verifyRelayedTurnReplyResponse,
  type RelayedTurnReplyKey,
  type RelayedTurnReplyKeyKind,
  type RelayedTurnReplyRequestAuth,
  type RelayedTurnReplyWireBody,
} from './relayed-turn-reply-crypto.js';
import {
  recordSessionTurnReplies,
  type RecordSessionTurnRepliesResult,
  type RecordSessionTurnReplyLimits,
  type SessionTurnReply,
  type SessionTurnRetention,
} from '../services/session-turns.js';

/**
 * Daemon-side host proxy for structured session-turn reply receipts from a CLI
 * that cannot write `<DATA_DIR>/session-turns/turns.sqlite` directly (macOS
 * Seatbelt read-isolation, macOS credential-only Seatbelt, Linux bwrap, or a
 * third-party CLI's own workspace-write sandbox).
 *
 * `turns.sqlite` holds every bot's and every session's structured turns across
 * the host and is strictly host-only — never allowlisted into any sandbox.
 *
 * Trust boundary:
 * - Pre-body auth & rate admission: the HTTP handler verifies an HMAC bound to
 *   the exact sealed body (using either the host IPC secret or the live turn
 *   capability as local key material) and enforces sliding-window request rate +
 *   per-session/global in-flight limits BEFORE reading any request body bytes.
 *   Neither key nor plaintext reply text crosses the loopback wire.
 * - Zero TOCTOU: after bounded body read, the handler synchronously re-verifies
 *   `ds`, `ds.managedTurnOrigin.turnId`, and (for capability callers) live
 *   capability before committing in a single SQLite transaction.
 * - Authoritative binding: `sessionId` and `turnId` come strictly from the live
 *   daemon session; caller `expectedTurnId` can only refuse (`409 turn_mismatch`).
 *   `doc:<commentId>` receipts must match live `docCommentTargets` / `docCommentTurns`.
 * - Bounded work & storage: raw text is capped at `SESSION_TURN_REPLY_RAW_TEXT_CAP`,
 *   timestamps are lower- and upper-bounded around host wall clock, host
 *   `pruneNow` is always passed, and durable per-turn reply/char/payload-byte
 *   caps are enforced atomically post-deduplication inside SQLite.
 */
export const RELAYED_TURN_REPLY_ROUTE = 'turn-reply';
export { RELAYED_TURN_REPLY_HEADERS };
export type {
  RelayedTurnReplyKey,
  RelayedTurnReplyKeyKind,
  RelayedTurnReplyRequestAuth,
  RelayedTurnReplyWireBody,
};
export {
  openRelayedTurnReplyRequest,
  sealRelayedTurnReplyRequest,
  signRelayedTurnReplyResponse,
  verifyRelayedTurnReplyRequestProof,
  verifyRelayedTurnReplyResponse,
} from './relayed-turn-reply-crypto.js';

/** 3 MiB: holds the AES-GCM/base64url envelope for a 256 KiB UTF-16 CJK reply
 *  (~768 KiB UTF-8) plus worst-case JSON escaping and request metadata. */
export const RELAYED_TURN_REPLY_MAX_BYTES = 3 * 1024 * 1024;
export const RELAYED_TURN_REPLY_BODY_TIMEOUT_MS = 2_000;
export const RELAYED_TURN_REPLY_MAX_IN_FLIGHT = 16;
export const RELAYED_TURN_REPLY_MAX_IN_FLIGHT_PER_SESSION = 3;
export const RELAYED_TURN_REPLY_MAX_ITEMS = 64;
/** `safeScrubAndTruncate(..., 256 * 1024)` truncates on UTF-16 code units when
 *  `raw.length > 256 * 1024`. Slicing raw text to `256 * 1024 + 512` preserves
 *  bit-for-bit identical host scrubbing & truncation output while bounding CPU. */
export const SESSION_TURN_REPLY_RAW_TEXT_CAP = 256 * 1024 + 512;
export const RELAYED_TURN_REPLY_MAX_FUTURE_SKEW_MS = 60_000;
export const RELAYED_TURN_REPLY_MAX_PAST_AGE_MS = 24 * 60 * 60 * 1000;

export const RELAYED_TURN_REPLY_WINDOW_MS = 10_000;
export const RELAYED_TURN_REPLY_WINDOW_MAX_REQUESTS = 30;
export const RELAYED_TURN_REPLY_WINDOW_MAX_CHARS = 1_048_576;
export const RELAYED_TURN_REPLY_TURN_MAX_REPLIES = 128;
export const RELAYED_TURN_REPLY_TURN_MAX_CHARS = 2 * 1024 * 1024;
export const RELAYED_TURN_REPLY_TURN_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const RELAYED_TURN_REPLY_QUOTA_MAX_KEYS = 1024;

// Forbids ':' inside doc:<commentId> so event_key `reply:${kind}:${id}:${at}`
// cannot collide on delimiter boundaries.
const MESSAGE_ID_RE = /^(?:om_[A-Za-z0-9_-]{1,128}|doc:[A-Za-z0-9_.-]{1,128})$/;
const VALID_RESPONSE_KINDS = new Set<TurnSendKind>(['progress', 'final', 'auxiliary']);
const EXPECTED_TURN_ID_MAX_CHARS = 256;

export type RelayedTurnReplyAuthClaim = Partial<RelayedTurnReplyRequestAuth>;

function singleHeaderString(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** Parse encrypted-relay auth headers strictly from single-valued HTTP headers. */
export function parseRelayedTurnReplyAuthHeaders(headers: IncomingHttpHeaders): RelayedTurnReplyAuthClaim {
  const claim: RelayedTurnReplyAuthClaim = {};
  const keyKind = singleHeaderString(headers, RELAYED_TURN_REPLY_HEADERS.keyKind);
  if (keyKind === 'capability' || keyKind === 'host') claim.keyKind = keyKind;
  const turnId = singleHeaderString(headers, RELAYED_TURN_REPLY_HEADERS.turnId);
  if (turnId && turnId.length <= EXPECTED_TURN_ID_MAX_CHARS && !turnId.includes('\0')) {
    claim.turnId = turnId;
  }
  const attemptRaw = singleHeaderString(headers, RELAYED_TURN_REPLY_HEADERS.dispatchAttempt);
  if (attemptRaw && /^\d+$/.test(attemptRaw)) {
    const attempt = Number(attemptRaw);
    if (Number.isSafeInteger(attempt) && attempt > 0) claim.dispatchAttempt = attempt;
  }
  const requestNonce = singleHeaderString(headers, RELAYED_TURN_REPLY_HEADERS.requestNonce);
  if (requestNonce && /^[a-f0-9]{64}$/.test(requestNonce)) claim.requestNonce = requestNonce;
  const payloadSha256 = singleHeaderString(headers, RELAYED_TURN_REPLY_HEADERS.payloadSha256);
  if (payloadSha256 && /^[a-f0-9]{64}$/.test(payloadSha256)) claim.payloadSha256 = payloadSha256;
  const requestProof = singleHeaderString(headers, RELAYED_TURN_REPLY_HEADERS.requestProof);
  if (requestProof && /^[a-f0-9]{64}$/.test(requestProof)) claim.requestProof = requestProof;
  return claim;
}

export interface TurnReplyQuotaLimits {
  windowMs?: number;
  maxWindowRequests?: number;
  maxWindowChars?: number;
  maxTurnReplies?: number;
  maxTurnChars?: number;
  maxTurnPayloadBytes?: number;
  maxKeys?: number;
  monotonicNow?: () => number;
}

export interface TurnReplyRateWindowSlot {
  at: number;
  chars: number;
}

export interface TurnReplyQuotaTracker {
  readonly turnLimits: Required<RecordSessionTurnReplyLimits>;
  /** Admits a request BEFORE reading the HTTP body so stalled/oversized/bad-JSON
   *  loops still consume sliding-window request quota. */
  admitPreBodyRequest(
    sessionId: string,
    turnId: string,
    nowMs?: number,
  ): { ok: true; slot: TurnReplyRateWindowSlot } | { ok: false; error: 'turn_reply_rate_limited' };
  /** Enforces the sliding-window char budget (and request count when no pre-body
   *  slot was acquired). */
  checkAndRecordChars(
    sessionId: string,
    turnId: string,
    requestChars: number,
    slot?: TurnReplyRateWindowSlot,
    nowMs?: number,
  ): { ok: true } | { ok: false; error: 'turn_reply_rate_limited' };
  clear(): void;
}

interface TurnReplyQuotaEntry {
  windowEvents: TurnReplyRateWindowSlot[];
}

export function createTurnReplyQuotaTracker(limits: TurnReplyQuotaLimits = {}): TurnReplyQuotaTracker {
  const windowMs = Math.max(1, Math.floor(limits.windowMs ?? RELAYED_TURN_REPLY_WINDOW_MS));
  const maxWindowRequests = Math.max(1, Math.floor(limits.maxWindowRequests ?? RELAYED_TURN_REPLY_WINDOW_MAX_REQUESTS));
  const maxWindowChars = Math.max(1, Math.floor(limits.maxWindowChars ?? RELAYED_TURN_REPLY_WINDOW_MAX_CHARS));
  const maxTurnReplies = Math.max(1, Math.floor(limits.maxTurnReplies ?? RELAYED_TURN_REPLY_TURN_MAX_REPLIES));
  const maxTurnChars = Math.max(1, Math.floor(limits.maxTurnChars ?? RELAYED_TURN_REPLY_TURN_MAX_CHARS));
  const maxTurnPayloadBytes = Math.max(1, Math.floor(limits.maxTurnPayloadBytes ?? RELAYED_TURN_REPLY_TURN_MAX_PAYLOAD_BYTES));
  const maxKeys = Math.max(1, Math.floor(limits.maxKeys ?? RELAYED_TURN_REPLY_QUOTA_MAX_KEYS));
  const monotonicNow = limits.monotonicNow ?? (() => performance.now());

  const entries = new Map<string, TurnReplyQuotaEntry>();
  const keyOf = (sessionId: string, turnId: string) => `${sessionId}\0${turnId}`;

  const touch = (key: string): TurnReplyQuotaEntry => {
    let entry = entries.get(key);
    if (entry) {
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    }
    entry = { windowEvents: [] };
    entries.set(key, entry);
    while (entries.size > maxKeys) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    return entry;
  };

  const pruneWindow = (entry: TurnReplyQuotaEntry, now: number): void => {
    const cutoff = now - windowMs;
    // Drop expired entries AND defensively drop future entries (at > now) so a
    // backward clock jump can never pin the sliding window.
    if (entry.windowEvents.length > 0) {
      entry.windowEvents = entry.windowEvents.filter(ev => ev.at > cutoff && ev.at <= now);
    }
  };

  return {
    turnLimits: {
      maxReplies: maxTurnReplies,
      maxTextChars: maxTurnChars,
      maxPayloadBytes: maxTurnPayloadBytes,
    },
    admitPreBodyRequest(sessionId, turnId, nowMs) {
      const now = nowMs !== undefined && Number.isFinite(nowMs) ? nowMs : monotonicNow();
      const entry = touch(keyOf(sessionId, turnId));
      pruneWindow(entry, now);
      if (entry.windowEvents.length >= maxWindowRequests) {
        return { ok: false, error: 'turn_reply_rate_limited' };
      }
      const slot: TurnReplyRateWindowSlot = { at: now, chars: 0 };
      entry.windowEvents.push(slot);
      return { ok: true, slot };
    },
    checkAndRecordChars(sessionId, turnId, requestChars, slot, nowMs) {
      const now = nowMs !== undefined && Number.isFinite(nowMs) ? nowMs : monotonicNow();
      const entry = touch(keyOf(sessionId, turnId));
      pruneWindow(entry, now);
      let windowChars = 0;
      for (const ev of entry.windowEvents) windowChars += ev.chars;
      if (!slot && entry.windowEvents.length >= maxWindowRequests) {
        return { ok: false, error: 'turn_reply_rate_limited' };
      }
      if (windowChars + requestChars > maxWindowChars) {
        return { ok: false, error: 'turn_reply_rate_limited' };
      }
      if (slot) {
        slot.chars = requestChars;
      } else {
        entry.windowEvents.push({ at: now, chars: requestChars });
      }
      return { ok: true };
    },
    clear() {
      entries.clear();
    },
  };
}

export type RelayedTurnReplyResult =
  | { ok: true; recorded: number; duplicates: number; staged: boolean }
  | { ok: false; status: 400 | 403 | 404 | 409 | 429 | 500; error: string };

export function recordRelayedTurnReply(input: {
  ds: Pick<DaemonSession, 'session' | 'managedTurnOrigin' | 'docCommentTurns'> | undefined;
  body: Record<string, unknown>;
  dataDir: string;
  quota?: TurnReplyQuotaTracker;
  quotaSlot?: TurnReplyRateWindowSlot;
  /** Wall-clock ms for `reply.at` validation and `pruneNow`. */
  now?: number;
  /** Monotonic ms for the sliding rate-limit window (defaults to tracker's monotonic clock, or `now` when explicitly passed in tests). */
  rateWindowNow?: number;
  retention?: SessionTurnRetention;
}): RelayedTurnReplyResult {
  const { ds, body, dataDir } = input;
  if (!ds || ds.session.status === 'closed') {
    return { ok: false, status: 404, error: 'session_not_active' };
  }
  const expectedTurnId = body.expectedTurnId;
  if (typeof expectedTurnId !== 'string'
    || expectedTurnId.length === 0
    || expectedTurnId.length > EXPECTED_TURN_ID_MAX_CHARS
    || expectedTurnId.includes('\0')) {
    return { ok: false, status: 400, error: 'invalid_turn_reply' };
  }
  const turnId = ds.managedTurnOrigin?.turnId;
  if (!turnId) {
    return { ok: false, status: 409, error: 'turn_unbound' };
  }
  if (expectedTurnId !== turnId) {
    return { ok: false, status: 409, error: 'turn_mismatch' };
  }
  const rawReplies = body.replies;
  if (!Array.isArray(rawReplies) || rawReplies.length === 0 || rawReplies.length > RELAYED_TURN_REPLY_MAX_ITEMS) {
    return { ok: false, status: 400, error: 'invalid_turn_reply' };
  }

  const serverNow = input.now !== undefined && Number.isFinite(input.now) ? Math.trunc(input.now) : Date.now();
  const minAt = serverNow - RELAYED_TURN_REPLY_MAX_PAST_AGE_MS;
  const maxAt = serverNow + RELAYED_TURN_REPLY_MAX_FUTURE_SKEW_MS;
  const normalizedReplies: SessionTurnReply[] = [];
  let totalTextChars = 0;

  for (const item of rawReplies) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, status: 400, error: 'invalid_turn_reply' };
    }
    const candidate = item as Record<string, unknown>;
    const messageId = candidate.messageId;
    const responseKind = candidate.responseKind;
    const at = candidate.at;
    const rawText = candidate.text;

    if (typeof messageId !== 'string' || !MESSAGE_ID_RE.test(messageId)) {
      return { ok: false, status: 400, error: 'invalid_turn_reply' };
    }
    if (messageId.startsWith('doc:')) {
      const docTarget = ds.session.docCommentTargets?.[turnId] ?? ds.docCommentTurns?.get(turnId);
      if (!docTarget || docTarget.commentId !== messageId.slice(4)) {
        return { ok: false, status: 403, error: 'doc_comment_target_mismatch' };
      }
    }
    if (typeof responseKind !== 'string' || !VALID_RESPONSE_KINDS.has(responseKind as TurnSendKind)) {
      return { ok: false, status: 400, error: 'invalid_turn_reply' };
    }
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 1 || at < minAt || at > maxAt) {
      return { ok: false, status: 400, error: 'invalid_turn_reply' };
    }
    if (rawText !== undefined && typeof rawText !== 'string') {
      return { ok: false, status: 400, error: 'invalid_turn_reply' };
    }
    const text = typeof rawText === 'string' && rawText.length > 0 ? rawText : undefined;
    if (text !== undefined) {
      totalTextChars += text.length;
      if (totalTextChars > SESSION_TURN_REPLY_RAW_TEXT_CAP) {
        return { ok: false, status: 400, error: 'invalid_turn_reply' };
      }
    }
    normalizedReplies.push({
      messageId,
      responseKind: responseKind as TurnSendKind,
      at,
      ...(text !== undefined ? { text } : {}),
    });
  }

  const rateWindowNow = input.rateWindowNow ?? (input.now !== undefined ? serverNow : undefined);

  const turnLimits: RecordSessionTurnReplyLimits = input.quota?.turnLimits ?? {
    maxReplies: RELAYED_TURN_REPLY_TURN_MAX_REPLIES,
    maxTextChars: RELAYED_TURN_REPLY_TURN_MAX_CHARS,
    maxPayloadBytes: RELAYED_TURN_REPLY_TURN_MAX_PAYLOAD_BYTES,
  };

  let result: RecordSessionTurnRepliesResult;
  try {
    result = recordSessionTurnReplies(dataDir, ds.session.sessionId, turnId, normalizedReplies, {
      pruneNow: serverNow,
      retention: input.retention,
      turnLimits,
      chargeNewTextChars: input.quota
        ? newTextChars => input.quota!.checkAndRecordChars(
            ds.session.sessionId,
            turnId,
            newTextChars,
            input.quotaSlot,
            rateWindowNow,
          ).ok
        : undefined,
    });
  } catch {
    return { ok: false, status: 500, error: 'turn_reply_store_error' };
  }

  if (result.rateLimited) {
    return { ok: false, status: 429, error: 'turn_reply_rate_limited' };
  }
  if (result.quotaExceeded) {
    return { ok: false, status: 429, error: 'turn_reply_quota_exceeded' };
  }
  return {
    ok: true,
    recorded: result.recorded,
    duplicates: result.duplicates,
    staged: result.staged,
  };
}

// ───────────────────────────── Client Relay Helpers ──────────────────────────

export interface RelayedTurnReplyClientClaim {
  capability: string;
  turnId?: string;
  dispatchAttempt?: number;
  ipcPort?: number;
  larkAppId?: string;
}

/** Pre-slice raw text to `SESSION_TURN_REPLY_RAW_TEXT_CAP` and group replies
 *  into batches respecting both `RELAYED_TURN_REPLY_MAX_ITEMS` and the
 *  per-request cumulative text budget. */
export function chunkRelayedTurnReplies(replies: readonly SessionTurnReply[]): SessionTurnReply[][] {
  const batches: SessionTurnReply[][] = [];
  let current: SessionTurnReply[] = [];
  let currentTextChars = 0;

  for (const reply of replies) {
    const rawText = reply.text;
    const boundedText = typeof rawText === 'string' && rawText.length > 0
      ? (rawText.length > SESSION_TURN_REPLY_RAW_TEXT_CAP
          ? rawText.slice(0, SESSION_TURN_REPLY_RAW_TEXT_CAP)
          : rawText)
      : undefined;
    const textLen = boundedText?.length ?? 0;
    if (current.length > 0 && (
      current.length >= RELAYED_TURN_REPLY_MAX_ITEMS
      || currentTextChars + textLen > SESSION_TURN_REPLY_RAW_TEXT_CAP
    )) {
      batches.push(current);
      current = [];
      currentTextChars = 0;
    }
    current.push({
      messageId: reply.messageId,
      responseKind: reply.responseKind,
      at: reply.at,
      ...(boundedText !== undefined ? { text: boundedText } : {}),
    });
    currentTextChars += textLen;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function buildRelayedTurnReplyPortCandidates(ports: readonly (number | undefined)[]): number[] {
  const unique: number[] = [];
  for (const port of ports) {
    if (typeof port === 'number' && Number.isSafeInteger(port) && port > 0 && port <= 65535 && !unique.includes(port)) {
      unique.push(port);
    }
  }
  return unique;
}

const DEFAULT_RETRY_BACKOFF_MS = [0, 250, 500, 1000, 1500, 2000] as const;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 2_500;
const DEFAULT_DEADLINE_MS = 8_000;
const MIN_ATTEMPT_BUDGET_MS = 50;
const MAX_IMMEDIATE_CAPABILITY_ROTATIONS = 2;
const MAX_SAME_TURN_403_RETRIES = 4;
const MAX_TURN_UNBOUND_409_RETRIES = 3;

export interface PostRelayedTurnRepliesOptions {
  sessionId: string;
  expectedTurnId: string;
  replies: readonly SessionTurnReply[];
  readClaim: () => RelayedTurnReplyClientClaim | null;
  /** Host secret is read lazily per attempt. A wrong secret may fail over to a
   *  live capability (and vice versa) without ever exposing either key. */
  readHostSecret?: () => string | undefined;
  /** Isolated callers prefer capability encryption; host-first callers prefer
   *  the host-secret envelope. Unauthenticated responses may switch once. */
  preferCapability?: boolean;
  resolvePorts: (claim: RelayedTurnReplyClientClaim | null) => number[];
  postBatch: (input: {
    ipcPort: number;
    sessionId: string;
    payload: RelayedTurnReplyWireBody;
    headers: Record<string, string>;
    keyKind: RelayedTurnReplyKeyKind;
    claim: RelayedTurnReplyClientClaim | null;
    signal?: AbortSignal;
  }) => Promise<Response>;
  /** True for trusted-host fallback (e.g., CLI-own sandbox without isolated
   *  attestation) where a freshly restarted daemon briefly returns 409
   *  `turn_unbound` before batched worker warm-reattach emits origin. */
  allowTurnUnboundRetry?: boolean;
  backoffMs?: readonly number[];
  attemptTimeoutMs?: number;
  deadlineMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

async function readBoundedRelayResponse(res: Response): Promise<string> {
  const contentLength = res.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/.test(contentLength)
    || Number(contentLength) > RELAYED_TURN_REPLY_RESPONSE_MAX_BYTES)) {
    void res.body?.cancel().catch(() => {});
    throw new Error('unauthenticated_ipc_response');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RELAYED_TURN_REPLY_RESPONSE_MAX_BYTES) {
        void reader.cancel().catch(() => {});
        throw new Error('unauthenticated_ipc_response');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('unauthenticated_ipc_response');
  }
}

async function readVerifiedRelayResponse(input: {
  res: Response;
  key: RelayedTurnReplyKey;
  sessionId: string;
  auth: RelayedTurnReplyRequestAuth;
}): Promise<Record<string, unknown> | undefined> {
  const { res } = input;
  const raw = await readBoundedRelayResponse(res);
  if (!verifyRelayedTurnReplyResponse({
    key: input.key,
    sessionId: input.sessionId,
    turnId: input.auth.turnId,
    dispatchAttempt: input.auth.dispatchAttempt,
    requestNonce: input.auth.requestNonce,
    status: res.status,
    raw,
    signature: res.headers.get(RELAYED_TURN_REPLY_HEADERS.responseProof),
  })) throw new Error('unauthenticated_ipc_response');
  let parsed: unknown;
  if (raw) {
    try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  }
  if (res.ok) {
    const value = parsed as { ok?: unknown; recorded?: unknown; duplicates?: unknown; staged?: unknown } | undefined;
    if (!value || value.ok !== true || typeof value.recorded !== 'number'
      || typeof value.duplicates !== 'number' || typeof value.staged !== 'boolean') {
      throw new Error('invalid_turn_reply_response');
    }
  }
  return parsed as Record<string, unknown> | undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    // Keep the timer ref'd: CLI commands run inside top-level await, and an
    // unref'd sleep when no sockets are open makes Node exit 13 ("unsettled
    // top-level await") instead of completing the bounded retry window.
    setTimeout(resolve, ms);
  });
}

function isDefinitiveOwnerTerminal(status: number, errorCode: string | undefined): boolean {
  if (status === 403 && (errorCode === 'doc_comment_target_mismatch' || errorCode === 'managed_action_required')) {
    return true;
  }
  if (status === 409 && errorCode === 'turn_mismatch') return true;
  if (status === 429 && errorCode === 'turn_reply_quota_exceeded') return true;
  return false;
}

export async function postRelayedTurnReplies(
  opts: PostRelayedTurnRepliesOptions,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const batches = chunkRelayedTurnReplies(opts.replies);
  if (batches.length === 0) return { ok: true };

  const backoffSchedule = opts.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const attemptTimeoutMs = Math.max(1, opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS);
  const minAttemptBudgetMs = Math.min(MIN_ATTEMPT_BUDGET_MS, attemptTimeoutMs);
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const deadlineAt = now() + deadlineMs;
  let hasDispatchedAny = false;

  for (const batch of batches) {
    let committed = false;
    let lastError = 'no_daemon_ipc_port';
    let attemptIndex = 0;
    let skipNextWait = false;
    let immediateRotations = 0;
    let sameTurn403Retries = 0;
    let turnUnboundRetries = 0;
    let fallbackKeyKind: RelayedTurnReplyKeyKind | undefined;
    let fallbackActivated = false;

    while (attemptIndex < backoffSchedule.length) {
      const waitMs = skipNextWait ? 0 : (backoffSchedule[attemptIndex] ?? 0);
      skipNextWait = false;
      if (waitMs > 0) {
        const remaining = deadlineAt - now();
        if (remaining <= waitMs || remaining - waitMs < minAttemptBudgetMs) {
          lastError = lastError || 'deadline_exceeded';
          break;
        }
        await sleep(waitMs);
      }
      if (hasDispatchedAny && deadlineAt - now() < minAttemptBudgetMs) {
        lastError = lastError || 'deadline_exceeded';
        break;
      }

      const claim = opts.readClaim();
      const ports = buildRelayedTurnReplyPortCandidates(opts.resolvePorts(claim));
      if (ports.length === 0) {
        lastError = 'no_daemon_ipc_port';
        hasDispatchedAny = true;
        attemptIndex += 1;
        continue;
      }
      let hostSecret: string | undefined;
      try { hostSecret = opts.readHostSecret?.(); } catch { hostSecret = undefined; }
      const capability = claim?.capability || undefined;
      const primaryKeyKind: RelayedTurnReplyKeyKind | undefined = opts.preferCapability && capability
        ? 'capability'
        : hostSecret
          ? 'host'
          : capability
            ? 'capability'
            : hostSecret
              ? 'host'
              : undefined;
      const fallbackAvailable = fallbackKeyKind === 'capability' ? !!capability : fallbackKeyKind === 'host' ? !!hostSecret : false;
      const keyKind = fallbackAvailable ? fallbackKeyKind! : primaryKeyKind;
      const key: RelayedTurnReplyKey | undefined = keyKind === 'capability' && capability
        ? { kind: keyKind, material: capability }
        : keyKind === 'host' && hostSecret
          ? { kind: keyKind, material: hostSecret }
          : undefined;
      if (!key || !keyKind) {
        // A warm worker may publish a claim during the next backoff. Never send
        // an unencrypted/plaintext fallback while no local key is available.
        lastError = 'origin_unproven';
        hasDispatchedAny = true;
        attemptIndex += 1;
        continue;
      }
      const sealed = sealRelayedTurnReplyRequest({
        key,
        sessionId: opts.sessionId,
        payload: { expectedTurnId: opts.expectedTurnId, replies: batch },
        dispatchAttempt: claim?.dispatchAttempt,
      });

      let outcome: 'committed' | 'retry_backoff' | 'retry_immediate' | 'terminal' = 'terminal';
      let sawRetryableTransportOrServer = false;
      let sawRetryableTurnUnbound = false;
      let saw403OriginUnproven = false;
      let sawUnauthenticatedResponse = false;
      let sawAuthenticatedResponse = false;
      let retryableError: string | undefined;

      for (const ipcPort of ports) {
        const remaining = deadlineAt - now();
        if (hasDispatchedAny && remaining < minAttemptBudgetMs) {
          if (!sawRetryableTransportOrServer && !sawRetryableTurnUnbound
            && !saw403OriginUnproven && !sawUnauthenticatedResponse) {
            outcome = 'terminal';
          }
          break;
        }
        const perTryTimeout = hasDispatchedAny
          ? Math.max(minAttemptBudgetMs, Math.min(attemptTimeoutMs, remaining))
          : attemptTimeoutMs;
        hasDispatchedAny = true;

        let res: Response;
        try {
          const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(perTryTimeout)
            : undefined;
          res = await opts.postBatch({
            ipcPort,
            sessionId: opts.sessionId,
            payload: sealed.body,
            headers: sealed.headers,
            keyKind,
            claim,
            signal,
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          lastError = msg;
          sawRetryableTransportOrServer = true;
          retryableError ??= msg;
          continue;
        }

        let parsed: Record<string, unknown> | undefined;
        try {
          parsed = await readVerifiedRelayResponse({ res, key, sessionId: opts.sessionId, auth: sealed.auth });
          sawAuthenticatedResponse = true;
        } catch (error) {
          // The listener could not prove possession of the request key. Ignore
          // every status/body it supplied and continue to the next candidate.
          const msg = error instanceof Error ? error.message : 'unauthenticated_ipc_response';
          lastError = msg;
          sawUnauthenticatedResponse = true;
          retryableError ??= msg;
          continue;
        }

        if (res.ok) {
          outcome = 'committed';
          break;
        }

        const errorCode = typeof parsed?.error === 'string' ? parsed.error : undefined;
        const errLabel = errorCode ?? `HTTP ${res.status}`;
        lastError = errLabel;

        if (isDefinitiveOwnerTerminal(res.status, errorCode)) {
          outcome = 'terminal';
          sawRetryableTransportOrServer = false;
          sawRetryableTurnUnbound = false;
          saw403OriginUnproven = false;
          sawUnauthenticatedResponse = false;
          break;
        }

        if (res.status === 408 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504
          || res.status === 429) {
          sawRetryableTransportOrServer = true;
          retryableError ??= errLabel;
          continue;
        }

        if (res.status === 409 && errorCode === 'turn_unbound' && opts.allowTurnUnboundRetry) {
          sawRetryableTurnUnbound = true;
          retryableError ??= errLabel;
          continue;
        }

        if (res.status === 403) {
          saw403OriginUnproven = true;
          retryableError ??= errLabel;
          continue;
        }

        if (res.status === 404 || res.status === 401 || res.status === 405) {
          continue;
        }

        break;
      }

      if (outcome === 'committed') {
        committed = true;
        break;
      }

      if (sawUnauthenticatedResponse && !sawAuthenticatedResponse && !fallbackActivated) {
        const alternate = keyKind === 'capability'
          ? (hostSecret ? 'host' as const : undefined)
          : (capability ? 'capability' as const : undefined);
        if (alternate) {
          fallbackKeyKind = alternate;
          fallbackActivated = true;
          outcome = 'retry_immediate';
          if (retryableError) lastError = retryableError;
        }
      }

      if (outcome !== 'retry_immediate') {
        if (sawUnauthenticatedResponse) {
          if (keyKind === 'capability') saw403OriginUnproven = true;
          else sawRetryableTransportOrServer = true;
        }
        if (sawRetryableTransportOrServer) {
          if (retryableError) lastError = retryableError;
          outcome = 'retry_backoff';
        } else if (sawRetryableTurnUnbound) {
          if (retryableError) lastError = retryableError;
          if (turnUnboundRetries < MAX_TURN_UNBOUND_409_RETRIES) {
            turnUnboundRetries += 1;
            outcome = 'retry_backoff';
          } else {
            outcome = 'terminal';
          }
        } else if (saw403OriginUnproven) {
          if (retryableError) lastError = retryableError;
          const nextClaim = opts.readClaim();
          if (!nextClaim || (nextClaim.turnId && nextClaim.turnId !== opts.expectedTurnId)) {
            outcome = 'terminal';
          } else if (nextClaim.capability !== claim?.capability && immediateRotations < MAX_IMMEDIATE_CAPABILITY_ROTATIONS) {
            immediateRotations += 1;
            outcome = 'retry_immediate';
          } else if ((!nextClaim.turnId || nextClaim.turnId === opts.expectedTurnId)
            && sameTurn403Retries < MAX_SAME_TURN_403_RETRIES) {
            sameTurn403Retries += 1;
            outcome = 'retry_backoff';
          } else {
            outcome = 'terminal';
          }
        }
      }

      if (outcome === 'terminal') {
        return { ok: false, error: lastError };
      }
      if (outcome === 'retry_immediate') {
        skipNextWait = true;
        continue;
      }
      attemptIndex += 1;
    }

    if (!committed) {
      return { ok: false, error: lastError };
    }
  }

  return { ok: true };
}

export async function recordStructuredTurnRepliesWithFallback(opts: {
  sessionId: string;
  turnId: string | undefined;
  replies: readonly SessionTurnReply[];
  mustProxy: boolean;
  recordLocal: (replies: readonly SessionTurnReply[]) => RecordSessionTurnRepliesResult;
  postRelay: (replies: readonly SessionTurnReply[]) => Promise<{ ok: true } | { ok: false; error: string }>;
}): Promise<{ ok: true; mode: 'noop' | 'local' | 'ipc' } | { ok: false; mode: 'ipc'; error: string }> {
  if (!opts.turnId || opts.replies.length === 0) {
    return { ok: true, mode: 'noop' };
  }
  if (!opts.mustProxy) {
    try {
      opts.recordLocal(opts.replies);
      return { ok: true, mode: 'local' };
    } catch {
      // Local turns.sqlite unavailable/unwritable (e.g., CLI-own sandbox or
      // restricted permissions) — fall back to host-side Daemon IPC below.
    }
  }
  const relayed = await opts.postRelay(opts.replies);
  if (relayed.ok) return { ok: true, mode: 'ipc' };
  return { ok: false, mode: 'ipc', error: relayed.error };
}
