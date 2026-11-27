/**
 * Idempotent publication slots and <=50-char Feishu UUID derivation for
 * streaming status cards.
 *
 * Why this exists:
 * `client.ts` keeps one `wireUuid` stable across `api-gate` internal retries
 * for a single `sendMessage` / `replyMessage` call, but without a caller-owned
 * cross-retry `uuid`, outer retries across `postTurnStartingStatusCard`,
 * `case 'ready'`, and `case 'screen_update'` each mint a brand-new
 * `randomUUID()`. During a Feishu HTTP 500 (`code=2200`) partial-commit window
 * where the card actually landed in the chat/thread, every outer retry posts a
 * fresh orphan card that never enters `frozenCards`.
 *
 * This leaf module owns:
 * - Deterministic <=50-char URL-safe UUID derivation (`sc_<tag>_<32hex>` = 37
 *   chars), domain-separated across slot kinds and keyed on the destination
 *   `replyTargetKey` (Feishu UUID dedupe ignores `parent_id` mismatches).
 * - Per-session isolated slot namespaces (`turn`, `manual`, `legacyMigrations`,
 *   `resume`) stored in a WeakMap so zero fields are added to SQLite / Session.
 * - Cross-retry `card_nonce` preservation so a deduplicated retry still matches
 *   the button nonce embedded in Attempt #1's committed card.
 * - Divergent-body tracking so a deduplicated retry whose body changed since a
 *   commit-unknown attempt (e.g. `starting` -> `working`/`idle`) triggers an
 *   immediate reconciliation PATCH instead of leaving Feishu's card stale.
 * - Structured error classification separating withdrawn/blocked targets,
 *   never-landed local/circuit failures, commit-unknown transient failures, and
 *   deterministic non-retryable rejections.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { StreamStatus } from '../types.js';
import type { DaemonSession } from './types.js';
import {
  LARK_CODE_MESSAGE_INTERNAL_ERROR,
  LARK_CODE_MESSAGE_UPDATE_EXPIRED,
  extractLarkBusinessCode,
} from '../im/lark/lark-errors.js';
import {
  LarkCircuitOpenError,
  getLarkGatePriorAttemptErrors,
  isRetryableLarkError,
} from '../im/lark/api-gate.js';
import { TopicSendError } from '../cli/topic-send-guard.js';

export const FEISHU_UUID_MAX_LEN = 50;
export const FEISHU_UUID_PATTERN = /^[A-Za-z0-9_-]{1,50}$/;
export const MAX_TRACKED_UNKNOWN_BODY_HASHES = 8;
export const MAX_LEGACY_MIGRATION_SLOTS = 8;

export type StreamingCardSlotKind =
  | 'turn'
  | 'ready_fallback'
  | 'manual'
  | 'legacy_migration'
  | 'resume';

export type StreamingCardPostErrorKind =
  | 'withdrawn'
  | 'topic_blocked'
  | 'topic_check_failed'
  | 'never_landed'
  | 'commit_unknown'
  | 'non_retryable';

export interface StreamingCardPostErrorDisposition {
  readonly kind: StreamingCardPostErrorKind;
  readonly mayHaveCommitted: boolean;
  readonly suppressStaticFallback: boolean;
  readonly isTargetUnavailable: boolean;
}

export interface StreamingCardPostSlot {
  readonly kind: Exclude<StreamingCardSlotKind, 'ready_fallback'>;
  readonly slotToken: string;
  readonly sessionId: string;
  readonly larkAppId: string;
  readonly anchorId: string;
  readonly replyTargetKey: string;
  readonly turnGeneration: number;
  readonly canonicalTurnId?: string;
  readonly retireMessageId?: string;
  readonly staleCardId?: string;
  readonly nonce: string;
  readonly uuid: string;
  attempts: number;
  readonly unknownOutcomeBodyHashes: Set<string>;
  unknownOutcomeOverflow: boolean;
  firstUnknownOutcomeStatus?: StreamStatus;
}

export interface StreamingCardSlotGenerators {
  nextSlotToken?: () => string;
  nextNonce?: (avoid?: ReadonlySet<string>) => string;
}

export interface DeriveStreamingCardUuidInput {
  kind: StreamingCardSlotKind;
  larkAppId: string;
  sessionId: string;
  anchorId: string;
  replyTargetKey: string;
  turnGeneration: number;
  canonicalTurnId?: string;
  retireMessageId?: string;
  staleCardId?: string;
  slotToken: string;
}

export interface TurnSlotAcquireInput {
  sessionId: string;
  larkAppId: string;
  anchorId: string;
  replyTargetKey: string;
  turnGeneration: number;
  canonicalTurnId?: string;
  avoidNonces?: ReadonlySet<string>;
}

export interface ManualSlotAcquireInput {
  sessionId: string;
  larkAppId: string;
  anchorId: string;
  replyTargetKey: string;
  turnGeneration: number;
  avoidNonces?: ReadonlySet<string>;
}

export interface LegacyMigrationSlotAcquireInput {
  sessionId: string;
  larkAppId: string;
  anchorId: string;
  replyTargetKey: string;
  turnGeneration: number;
  retireMessageId: string;
  avoidNonces?: ReadonlySet<string>;
}

export interface ResumeSlotAcquireInput {
  sessionId: string;
  larkAppId: string;
  anchorId: string;
  replyTargetKey: string;
  staleCardId: string;
  avoidNonces?: ReadonlySet<string>;
}

interface SessionStreamingCardPostSlots {
  turn?: StreamingCardPostSlot;
  manual?: StreamingCardPostSlot;
  legacyMigrations?: Map<string, StreamingCardPostSlot>;
  resume?: StreamingCardPostSlot;
}

const KIND_TAG: Record<StreamingCardSlotKind, string> = {
  turn: 't',
  ready_fallback: 'f',
  manual: 'm',
  legacy_migration: 'l',
  resume: 'r',
};

const NEVER_LANDED_NETWORK_RE = /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|getaddrinfo)\b|circuit open/i;
const COMMIT_UNKNOWN_NETWORK_RE = /\b(ETIMEDOUT|ECONNRESET|ECONNABORTED|EPIPE|ENETUNREACH|EHOSTUNREACH|ERR_NETWORK|UND_ERR_[A-Z0-9_]+)\b|socket hang up|\btimeout\b|\btimed out\b/i;

const sessionSlots = new WeakMap<DaemonSession, SessionStreamingCardPostSlots>();

function defaultNextSlotToken(): string {
  return randomBytes(16).toString('hex');
}

function defaultNextNonce(avoid?: ReadonlySet<string>): string {
  let candidate = randomBytes(4).toString('hex');
  if (!avoid || avoid.size === 0) return candidate;
  for (let i = 0; i < 8 && avoid.has(candidate); i++) {
    candidate = randomBytes(4).toString('hex');
  }
  return candidate;
}

function getOrCreateSessionSlots(ds: DaemonSession): SessionStreamingCardPostSlots {
  let slots = sessionSlots.get(ds);
  if (!slots) {
    slots = {};
    sessionSlots.set(ds, slots);
  }
  return slots;
}

/**
 * Derive a deterministic Feishu IM `uuid` strictly <= 50 characters (`37` chars,
 * matching `/^sc_[tfmlr]_[0-9a-f]{32}$/`). Canonical JSON-array framing prevents
 * delimiter collisions across arbitrary ids.
 */
export function deriveStreamingCardUuid(input: DeriveStreamingCardUuidInput): string {
  const preimage = JSON.stringify([
    'botmux.streaming-card.v1',
    input.kind,
    input.larkAppId,
    input.sessionId,
    input.anchorId,
    input.replyTargetKey,
    input.turnGeneration,
    input.canonicalTurnId ?? '',
    input.retireMessageId ?? '',
    input.staleCardId ?? '',
    input.slotToken,
  ]);
  const digest = createHash('sha256').update(preimage, 'utf8').digest('hex').slice(0, 32);
  return `sc_${KIND_TAG[input.kind]}_${digest}`;
}

/**
 * Derive a deterministic fallback UUID for `case 'ready'`'s static session card
 * from the failed turn slot. Domain-separated (`sc_f_...`) from the streaming
 * card (`sc_t_...`), yet stable across `api-gate` retries of the fallback POST.
 */
export function deriveReadyFallbackStreamingCardUuid(turnSlot: StreamingCardPostSlot): string {
  return deriveStreamingCardUuid({
    kind: 'ready_fallback',
    larkAppId: turnSlot.larkAppId,
    sessionId: turnSlot.sessionId,
    anchorId: turnSlot.anchorId,
    replyTargetKey: turnSlot.replyTargetKey,
    turnGeneration: turnSlot.turnGeneration,
    canonicalTurnId: turnSlot.canonicalTurnId,
    retireMessageId: turnSlot.retireMessageId,
    staleCardId: turnSlot.staleCardId,
    slotToken: turnSlot.slotToken,
  });
}

export function hashStreamingCardBody(cardJson: string): string {
  return createHash('sha256').update(cardJson, 'utf8').digest('hex');
}

export function hasUnknownOutcomeHistory(
  slot: Pick<StreamingCardPostSlot, 'unknownOutcomeBodyHashes' | 'unknownOutcomeOverflow'>,
): boolean {
  return slot.unknownOutcomeOverflow || slot.unknownOutcomeBodyHashes.size > 0;
}

/**
 * True when an earlier commit-unknown attempt for the same UUID slot sent a
 * card body whose hash differs from `currentBodyHash`. When a later retry
 * succeeds via Feishu UUID dedupe, Feishu returns Attempt #1's message_id
 * WITHOUT replacing its content, so callers must schedule an immediate PATCH.
 */
export function hasDivergentUnknownOutcomeBody(
  slot: Pick<StreamingCardPostSlot, 'unknownOutcomeBodyHashes' | 'unknownOutcomeOverflow'>,
  currentBodyHash: string,
): boolean {
  if (slot.unknownOutcomeOverflow) return true;
  for (const priorHash of slot.unknownOutcomeBodyHashes) {
    if (priorHash !== currentBodyHash) return true;
  }
  return false;
}

/**
 * Converge `postTurnStartingStatusCard`, `case 'ready'`, and `case 'screen_update'`
 * onto the exact same pending turn id whenever a new turn is awaiting its card.
 */
export function resolveCanonicalStreamingCardTurnId(
  ds: Pick<DaemonSession, 'streamCardPending' | 'streamCardPendingTurnId'>,
  explicitTurnId?: string,
): string | undefined {
  return ds.streamCardPending && ds.streamCardPendingTurnId
    ? ds.streamCardPendingTurnId
    : explicitTurnId;
}

function readHttpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { response?: { status?: unknown }; status?: unknown };
  const raw = e.response?.status ?? e.status;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function classifySingleStreamingCardPostError(err: unknown): StreamingCardPostErrorDisposition {
  const obj = err && typeof err === 'object' ? (err as Record<string, unknown>) : undefined;
  const errName = typeof obj?.name === 'string' ? obj.name : '';
  const errCode = typeof obj?.code === 'string' ? obj.code : '';
  const errMessage = typeof obj?.message === 'string'
    ? obj.message
    : (typeof err === 'string' ? err : '');

  if (errName === 'MessageWithdrawnError') {
    return {
      kind: 'withdrawn',
      mayHaveCommitted: false,
      suppressStaticFallback: true,
      isTargetUnavailable: true,
    };
  }

  if (err instanceof TopicSendError || errName === 'TopicSendError') {
    if (errCode === 'TOPIC_SEND_BLOCKED') {
      return {
        kind: 'topic_blocked',
        mayHaveCommitted: false,
        suppressStaticFallback: true,
        isTargetUnavailable: true,
      };
    }
    if (errCode === 'TOPIC_SEND_CHECK_FAILED') {
      return {
        kind: 'topic_check_failed',
        mayHaveCommitted: false,
        suppressStaticFallback: true,
        isTargetUnavailable: false,
      };
    }
  }

  const httpStatus = readHttpStatus(err);
  const hasResponse = !!(obj && 'response' in obj && obj.response !== undefined && obj.response !== null);
  const businessCode = extractLarkBusinessCode(err);
  const textBag = [errCode, errName, errMessage].filter(Boolean).join(' ');

  if (err instanceof LarkCircuitOpenError || errName === 'LarkCircuitOpenError') {
    return {
      kind: 'never_landed',
      mayHaveCommitted: false,
      suppressStaticFallback: true,
      isTargetUnavailable: false,
    };
  }

  if (!hasResponse && httpStatus === undefined && businessCode === undefined
    && NEVER_LANDED_NETWORK_RE.test(textBag)) {
    return {
      kind: 'never_landed',
      mayHaveCommitted: false,
      suppressStaticFallback: true,
      isTargetUnavailable: false,
    };
  }

  if (
    businessCode === LARK_CODE_MESSAGE_INTERNAL_ERROR
    || isRetryableLarkError(err)
    || httpStatus === 408
    || httpStatus === 429
    || (httpStatus !== undefined && httpStatus >= 500 && httpStatus <= 599)
    || (!hasResponse && httpStatus === undefined && businessCode === undefined
      && COMMIT_UNKNOWN_NETWORK_RE.test(textBag))
  ) {
    return {
      kind: 'commit_unknown',
      mayHaveCommitted: true,
      suppressStaticFallback: true,
      isTargetUnavailable: false,
    };
  }

  return {
    kind: 'non_retryable',
    mayHaveCommitted: false,
    suppressStaticFallback: false,
    isTargetUnavailable: false,
  };
}

/**
 * Classify a streaming-card POST error for slot retention, static-fallback
 * suppression, and post-dedup body reconciliation. Cross-realm safe against
 * mocked error classes in unit tests, and inspects earlier `executeWithLarkGate`
 * retry attempts so a later circuit-open / topic-check / beforeWrite / 4xx
 * error never masks an earlier commit-unknown HTTP 500 attempt.
 */
export function classifyStreamingCardPostError(err: unknown): StreamingCardPostErrorDisposition {
  const current = classifySingleStreamingCardPostError(err);
  if (current.isTargetUnavailable || current.mayHaveCommitted) return current;
  const priorErrors = getLarkGatePriorAttemptErrors(err);
  for (const prior of priorErrors) {
    if (classifySingleStreamingCardPostError(prior).mayHaveCommitted) {
      return {
        kind: 'commit_unknown',
        mayHaveCommitted: true,
        suppressStaticFallback: true,
        isTargetUnavailable: false,
      };
    }
  }
  return current;
}

export function isStreamingCardTargetBlockedError(err: unknown): boolean {
  return classifyStreamingCardPostError(err).isTargetUnavailable;
}

export function isMessageUpdateExpiredError(err: unknown): boolean {
  const errName = err && typeof err === 'object' ? (err as { name?: unknown }).name : undefined;
  return errName === 'MessageUpdateExpiredError'
    || extractLarkBusinessCode(err) === LARK_CODE_MESSAGE_UPDATE_EXPIRED;
}

export function acquireTurnStreamingCardPostSlot(
  ds: DaemonSession,
  input: TurnSlotAcquireInput,
  gen?: StreamingCardSlotGenerators,
): { slot: StreamingCardPostSlot; reused: boolean } {
  const slots = getOrCreateSessionSlots(ds);
  const existing = slots.turn;
  if (
    existing
    && existing.sessionId === input.sessionId
    && existing.larkAppId === input.larkAppId
    && existing.anchorId === input.anchorId
    && existing.replyTargetKey === input.replyTargetKey
    && existing.turnGeneration === input.turnGeneration
    && (hasUnknownOutcomeHistory(existing)
      || !(existing.canonicalTurnId && input.canonicalTurnId
        && existing.canonicalTurnId !== input.canonicalTurnId))
  ) {
    existing.attempts += 1;
    return { slot: existing, reused: true };
  }

  const slotToken = (gen?.nextSlotToken ?? defaultNextSlotToken)();
  const nonce = (gen?.nextNonce ?? defaultNextNonce)(input.avoidNonces);
  const slot: StreamingCardPostSlot = {
    kind: 'turn',
    slotToken,
    sessionId: input.sessionId,
    larkAppId: input.larkAppId,
    anchorId: input.anchorId,
    replyTargetKey: input.replyTargetKey,
    turnGeneration: input.turnGeneration,
    ...(input.canonicalTurnId !== undefined ? { canonicalTurnId: input.canonicalTurnId } : {}),
    nonce,
    uuid: deriveStreamingCardUuid({
      kind: 'turn',
      larkAppId: input.larkAppId,
      sessionId: input.sessionId,
      anchorId: input.anchorId,
      replyTargetKey: input.replyTargetKey,
      turnGeneration: input.turnGeneration,
      canonicalTurnId: input.canonicalTurnId,
      slotToken,
    }),
    attempts: 1,
    unknownOutcomeBodyHashes: new Set<string>(),
    unknownOutcomeOverflow: false,
  };
  slots.turn = slot;
  return { slot, reused: false };
}

export function acquireManualStreamingCardPostSlot(
  ds: DaemonSession,
  input: ManualSlotAcquireInput,
  gen?: StreamingCardSlotGenerators,
): { slot: StreamingCardPostSlot; reused: boolean } {
  const slots = getOrCreateSessionSlots(ds);
  const existing = slots.manual;
  if (
    existing
    && hasUnknownOutcomeHistory(existing)
    && existing.sessionId === input.sessionId
    && existing.larkAppId === input.larkAppId
    && existing.anchorId === input.anchorId
    && existing.replyTargetKey === input.replyTargetKey
    && existing.turnGeneration === input.turnGeneration
  ) {
    existing.attempts += 1;
    return { slot: existing, reused: true };
  }

  const slotToken = (gen?.nextSlotToken ?? defaultNextSlotToken)();
  const nonce = (gen?.nextNonce ?? defaultNextNonce)(input.avoidNonces);
  const slot: StreamingCardPostSlot = {
    kind: 'manual',
    slotToken,
    sessionId: input.sessionId,
    larkAppId: input.larkAppId,
    anchorId: input.anchorId,
    replyTargetKey: input.replyTargetKey,
    turnGeneration: input.turnGeneration,
    nonce,
    uuid: deriveStreamingCardUuid({
      kind: 'manual',
      larkAppId: input.larkAppId,
      sessionId: input.sessionId,
      anchorId: input.anchorId,
      replyTargetKey: input.replyTargetKey,
      turnGeneration: input.turnGeneration,
      slotToken,
    }),
    attempts: 1,
    unknownOutcomeBodyHashes: new Set<string>(),
    unknownOutcomeOverflow: false,
  };
  slots.manual = slot;
  return { slot, reused: false };
}

export function acquireLegacyMigrationStreamingCardPostSlot(
  ds: DaemonSession,
  input: LegacyMigrationSlotAcquireInput,
  gen?: StreamingCardSlotGenerators,
): { slot: StreamingCardPostSlot; reused: boolean } {
  const slots = getOrCreateSessionSlots(ds);
  const map = slots.legacyMigrations ?? (slots.legacyMigrations = new Map<string, StreamingCardPostSlot>());
  const existing = map.get(input.retireMessageId);
  if (
    existing
    && hasUnknownOutcomeHistory(existing)
    && existing.sessionId === input.sessionId
    && existing.larkAppId === input.larkAppId
    && existing.anchorId === input.anchorId
    && existing.replyTargetKey === input.replyTargetKey
    && existing.turnGeneration === input.turnGeneration
    && existing.retireMessageId === input.retireMessageId
  ) {
    existing.attempts += 1;
    return { slot: existing, reused: true };
  }

  if (existing) {
    map.delete(input.retireMessageId);
  }
  // This is a soft cap for clean slots. Never evict an unresolved
  // commit-unknown slot: its UUID is the only way to recover the message that
  // Feishu may already have committed. If every retained slot is unresolved,
  // temporarily exceed the cap until a later success/retirement releases them.
  while (map.size >= MAX_LEGACY_MIGRATION_SLOTS) {
    let oldestCleanKey: string | undefined;
    for (const [key, candidate] of map) {
      if (!hasUnknownOutcomeHistory(candidate)) {
        oldestCleanKey = key;
        break;
      }
    }
    if (oldestCleanKey === undefined) break;
    map.delete(oldestCleanKey);
  }

  const slotToken = (gen?.nextSlotToken ?? defaultNextSlotToken)();
  const nonce = (gen?.nextNonce ?? defaultNextNonce)(input.avoidNonces);
  const slot: StreamingCardPostSlot = {
    kind: 'legacy_migration',
    slotToken,
    sessionId: input.sessionId,
    larkAppId: input.larkAppId,
    anchorId: input.anchorId,
    replyTargetKey: input.replyTargetKey,
    turnGeneration: input.turnGeneration,
    retireMessageId: input.retireMessageId,
    nonce,
    uuid: deriveStreamingCardUuid({
      kind: 'legacy_migration',
      larkAppId: input.larkAppId,
      sessionId: input.sessionId,
      anchorId: input.anchorId,
      replyTargetKey: input.replyTargetKey,
      turnGeneration: input.turnGeneration,
      retireMessageId: input.retireMessageId,
      slotToken,
    }),
    attempts: 1,
    unknownOutcomeBodyHashes: new Set<string>(),
    unknownOutcomeOverflow: false,
  };
  map.set(input.retireMessageId, slot);
  return { slot, reused: false };
}

export function acquireResumeStreamingCardPostSlot(
  ds: DaemonSession,
  input: ResumeSlotAcquireInput,
  gen?: StreamingCardSlotGenerators,
): { slot: StreamingCardPostSlot; reused: boolean } {
  const slots = getOrCreateSessionSlots(ds);
  const existing = slots.resume;
  if (
    existing
    && hasUnknownOutcomeHistory(existing)
    && existing.sessionId === input.sessionId
    && existing.larkAppId === input.larkAppId
    && existing.anchorId === input.anchorId
    && existing.replyTargetKey === input.replyTargetKey
    && existing.staleCardId === input.staleCardId
  ) {
    existing.attempts += 1;
    return { slot: existing, reused: true };
  }

  const slotToken = (gen?.nextSlotToken ?? defaultNextSlotToken)();
  const nonce = (gen?.nextNonce ?? defaultNextNonce)(input.avoidNonces);
  const slot: StreamingCardPostSlot = {
    kind: 'resume',
    slotToken,
    sessionId: input.sessionId,
    larkAppId: input.larkAppId,
    anchorId: input.anchorId,
    replyTargetKey: input.replyTargetKey,
    turnGeneration: 0,
    staleCardId: input.staleCardId,
    nonce,
    uuid: deriveStreamingCardUuid({
      kind: 'resume',
      larkAppId: input.larkAppId,
      sessionId: input.sessionId,
      anchorId: input.anchorId,
      replyTargetKey: input.replyTargetKey,
      turnGeneration: 0,
      staleCardId: input.staleCardId,
      slotToken,
    }),
    attempts: 1,
    unknownOutcomeBodyHashes: new Set<string>(),
    unknownOutcomeOverflow: false,
  };
  slots.resume = slot;
  return { slot, reused: false };
}

function isCurrentSlot(slots: SessionStreamingCardPostSlots, slot: StreamingCardPostSlot): boolean {
  switch (slot.kind) {
    case 'turn':
      return slots.turn === slot;
    case 'manual':
      return slots.manual === slot;
    case 'legacy_migration':
      return slot.retireMessageId !== undefined
        && slots.legacyMigrations?.get(slot.retireMessageId) === slot;
    case 'resume':
      return slots.resume === slot;
  }
}

function removeSlotIfCurrent(slots: SessionStreamingCardPostSlots, slot: StreamingCardPostSlot): void {
  if (!isCurrentSlot(slots, slot)) return;
  switch (slot.kind) {
    case 'turn':
      slots.turn = undefined;
      break;
    case 'manual':
      slots.manual = undefined;
      break;
    case 'legacy_migration':
      if (slot.retireMessageId !== undefined) slots.legacyMigrations?.delete(slot.retireMessageId);
      break;
    case 'resume':
      slots.resume = undefined;
      break;
  }
}

/**
 * Roll back an acquired attempt that was aborted locally before calling Lark.
 * Keeps a slot that already has commit-unknown history intact so a subsequent
 * retry still deduplicates onto the earlier attempt.
 */
export function abortUnissuedStreamingCardPostAttempt(
  ds: DaemonSession,
  slot: StreamingCardPostSlot,
): void {
  const slots = sessionSlots.get(ds);
  if (!slots || !isCurrentSlot(slots, slot)) return;
  slot.attempts = Math.max(0, slot.attempts - 1);
  if (slot.attempts === 0 && !hasUnknownOutcomeHistory(slot)) {
    removeSlotIfCurrent(slots, slot);
  }
}

/**
 * Record the outcome of an owned POST failure.
 * - `withdrawn` / `topic_blocked`: retire the slot immediately so retries never
 *   wedge on a dead target.
 * - `commit_unknown`: retain the slot, record `bodyHash` (capped at 8 + overflow)
 *   and `firstUnknownOutcomeStatus` for post-dedup reconciliation.
 * - `never_landed` / `topic_check_failed` / `non_retryable`: retain `'turn'`
 *   slots without poisoning `unknownOutcomeBodyHashes`; for `'manual'`,
 *   `'legacy_migration'`, and `'resume'`, retire unless commit-unknown history
 *   is already sticky on the slot.
 */
export function recordStreamingCardPostFailure(
  ds: DaemonSession,
  slot: StreamingCardPostSlot,
  disposition: StreamingCardPostErrorDisposition,
  bodyHash: string,
  status?: StreamStatus,
): void {
  const slots = sessionSlots.get(ds);
  if (!slots || !isCurrentSlot(slots, slot)) return;

  if (disposition.isTargetUnavailable) {
    removeSlotIfCurrent(slots, slot);
    return;
  }

  if (disposition.mayHaveCommitted) {
    if (!slot.unknownOutcomeBodyHashes.has(bodyHash)) {
      if (slot.unknownOutcomeBodyHashes.size >= MAX_TRACKED_UNKNOWN_BODY_HASHES) {
        slot.unknownOutcomeOverflow = true;
      } else {
        slot.unknownOutcomeBodyHashes.add(bodyHash);
      }
    }
    if (status !== undefined && slot.firstUnknownOutcomeStatus === undefined) {
      slot.firstUnknownOutcomeStatus = status;
    }
    return;
  }

  if (slot.kind !== 'turn' && !hasUnknownOutcomeHistory(slot)) {
    removeSlotIfCurrent(slots, slot);
  }
}

/**
 * Retire one slot by object identity (called immediately whenever Lark returns
 * a `message_id` — both on normal commit and before stale-card discard — or when
 * explicitly entering a terminal fallback/supersession path).
 */
export function retireStreamingCardPostSlot(
  ds: DaemonSession,
  slot: StreamingCardPostSlot,
): void {
  const slots = sessionSlots.get(ds);
  if (!slots) return;
  removeSlotIfCurrent(slots, slot);
}

/**
 * Atomically start a new pending streaming-card turn: marks `streamCardPending`,
 * replaces `streamCardPendingTurnId`, bumps `streamCardTurnGeneration`, and
 * clears both `turn` and `manual` slots so in-flight prior-turn POSTs cannot
 * clear the new turn's pending flag and prior-turn `/card` commit-unknown slots
 * cannot alias across turns.
 */
export function advancePendingStreamingCardTurn(
  ds: DaemonSession,
  pendingTurnId?: string,
): number {
  ds.streamCardPending = true;
  ds.streamCardPendingTurnId = pendingTurnId;
  const nextGen = (ds.streamCardTurnGeneration ?? 0) + 1;
  ds.streamCardTurnGeneration = nextGen;
  const slots = sessionSlots.get(ds);
  if (slots) {
    slots.turn = undefined;
    slots.manual = undefined;
  }
  return nextGen;
}

/**
 * Snapshot the active turn slot (used by speculative retry clicks such as
 * `purge_images_continue` that can be refused synchronously by the worker).
 */
export function snapshotTurnStreamingCardPostSlot(
  ds: DaemonSession,
): StreamingCardPostSlot | undefined {
  return sessionSlots.get(ds)?.turn;
}

/**
 * Restore a previously snapshotted turn slot only when no new turn slot was
 * allocated in the meantime.
 */
export function restoreTurnStreamingCardPostSlotIfUnchanged(
  ds: DaemonSession,
  saved: StreamingCardPostSlot | undefined,
): void {
  if (!saved || saved.kind !== 'turn') return;
  const slots = getOrCreateSessionSlots(ds);
  if (slots.turn === undefined) {
    slots.turn = saved;
  }
}

/**
 * Invalidate only the turn slot namespace (withdrawn/expired card clear,
 * manual/resume commit, or handoff/auto-compact settlement).
 */
export function invalidateTurnStreamingCardPostSlot(ds: DaemonSession): void {
  const slots = sessionSlots.get(ds);
  if (slots) slots.turn = undefined;
}

/**
 * Clear all streaming-card post slots for `ds` (session close, transfer, or
 * in-place repo switch).
 */
export function clearStreamingCardPostSlots(ds: DaemonSession): void {
  sessionSlots.delete(ds);
}
