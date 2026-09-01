/**
 * Crash-durable lifecycle ledger for ordinary Lark IM turns.
 *
 * The record is written before the existing seen-message tombstone. Milestones
 * are independent instead of one mutable enum because a worker can emit
 * `final_output` before `turn_terminal`; a late terminal must never regress an
 * already-delivered output. Only a received-only record is safe to replay.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FrozenSessionReplyTarget } from '../types.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { computeInputHash } from '../utils/canonical-input-hash.js';
import { logger } from '../utils/logger.js';

const RECORD_VERSION = 1 as const;

/** Keep settled rows as long as the seen-message tombstone can suppress a
 * provider redelivery, then remove them so a genuinely old message id is not
 * rejected forever and the ledger directory stays bounded by live work. */
export const ORDINARY_TURN_LEDGER_RETENTION_MS = 8 * 60 * 60_000;
/** Feishu's provider UUID dedupe lasts one hour. At or beyond that boundary an
 * ACK-lost output is ambiguous and must become attention, never a blind send. */
export const ORDINARY_TURN_PROVIDER_DEDUPE_MS = 60 * 60_000;

export interface OrdinaryTurnRoutingSnapshot {
  chatId: string;
  scope: 'thread' | 'chat';
  anchor: string;
  replyRootId?: string;
}

export interface OrdinaryTurnOutputDelivery {
  rootId: string;
  content: string;
  msgType?: string;
  turnId: string;
  options?: {
    uuid?: string;
    quoteMessageId?: string;
    suppressHook?: boolean;
    sourceSessionId?: string;
    replyTarget?: FrozenSessionReplyTarget;
    placement?: 'auto' | 'chat' | 'topic';
  };
}

export interface OrdinaryTurnRecord {
  version: typeof RECORD_VERSION;
  larkAppId: string;
  messageId: string;
  payload: unknown;
  payloadHash?: string;
  claimedAt: string;
  updatedAt: string;
  replayScheduledAt?: string;
  routedAt?: string;
  routing?: OrdinaryTurnRoutingSnapshot;
  acceptedAt?: string;
  turnId?: string;
  sessionId?: string;
  worker?: {
    generation: number;
    receivedAt?: string;
    committedAt?: string;
    runningAt?: string;
    heartbeatAt?: string;
    rejectedAt?: string;
    rejectionReason?: string;
  };
  terminal?: {
    at: string;
    status: 'completed' | 'failed' | 'cancelled' | 'ambiguous';
    errorCode?: string;
    outputDisposition?: 'nothing_to_send';
  };
  output?: {
    status: 'pending' | 'delivered';
    delivery: OrdinaryTurnOutputDelivery;
    preparedAt: string;
    deliveredAt?: string;
    providerMessageId?: string;
  };
  attention?: {
    requiredAt: string;
    reason: string;
    notifiedAt?: string;
    providerMessageId?: string;
  };
}

export interface OrdinaryTurnRecoveryPlan {
  replays: OrdinaryTurnRecord[];
  attentions: OrdinaryTurnRecord[];
  pendingOutputs: OrdinaryTurnRecord[];
}

/** Limit boot reconciliation to rows that predate the dispatcher-open
 * horizon. Strict comparison is intentional: a message claimed by the new
 * daemon in the same clock millisecond as the cutoff belongs to the live
 * generation and must not be replayed or warned concurrently. */
export function limitOrdinaryTurnRecoveryPlanToClaimedBefore(
  plan: OrdinaryTurnRecoveryPlan,
  claimedBeforeMs: number | undefined,
): OrdinaryTurnRecoveryPlan {
  if (claimedBeforeMs === undefined) return plan;
  const eligible = (record: OrdinaryTurnRecord): boolean => {
    const claimedAt = Date.parse(record.claimedAt);
    return Number.isFinite(claimedAt) && claimedAt < claimedBeforeMs;
  };
  return {
    replays: plan.replays.filter(eligible),
    attentions: plan.attentions.filter(eligible),
    pendingOutputs: plan.pendingOutputs.filter(eligible),
  };
}

type AppCache = Map<string, OrdinaryTurnRecord>;
const caches = new Map<string, AppCache>();

function iso(now: number): string {
  return new Date(now).toISOString();
}

function safeSegment(value: string): string {
  const prefix = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'unknown';
  const digest = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
  return `${prefix}-${digest}`;
}

/** Stable Lark idempotency token shared by live failure cards and boot replay.
 * A provider ACK can be lost after the card was accepted; deriving from the
 * durable record identity makes the retry collapse onto the same message. */
export function ordinaryTurnRecoveryUuid(
  kind: 'output' | 'attention',
  larkAppId: string,
  messageId: string,
): string {
  const digest = createHash('sha256')
    .update(`${kind}\0${larkAppId}\0${messageId}`, 'utf8')
    .digest('hex');
  return `${kind === 'output' ? 'oo' : 'oa'}_${digest}`.slice(0, 50);
}

function appDir(dataDir: string, larkAppId: string): string {
  return join(dataDir, 'ordinary-turn-ledger', safeSegment(larkAppId));
}

function recordPath(dataDir: string, larkAppId: string, messageId: string): string {
  const digest = createHash('sha256').update(messageId, 'utf8').digest('hex');
  return join(appDir(dataDir, larkAppId), `${digest}.json`);
}

function cacheKey(dataDir: string, larkAppId: string): string {
  return `${resolve(dataDir)}\u0000${larkAppId}`;
}

function isRecord(value: unknown, larkAppId: string): value is OrdinaryTurnRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<OrdinaryTurnRecord>;
  return record.version === RECORD_VERSION
    && record.larkAppId === larkAppId
    && typeof record.messageId === 'string'
    && !!record.messageId
    && typeof record.claimedAt === 'string'
    && typeof record.updatedAt === 'string';
}

function load(dataDir: string, larkAppId: string): AppCache {
  const key = cacheKey(dataDir, larkAppId);
  const cached = caches.get(key);
  if (cached) return cached;

  const records: AppCache = new Map();
  const dir = appDir(dataDir, larkAppId);
  if (existsSync(dir)) {
    let names: string[] = [];
    try { names = readdirSync(dir).filter(name => name.endsWith('.json')).sort(); }
    catch (error) {
      logger.error(`[ordinary-turn-ledger] cannot scan ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const name of names) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        if (!isRecord(parsed, larkAppId)) {
          logger.error(`[ordinary-turn-ledger] invalid record ignored: ${join(dir, name)}`);
          continue;
        }
        const prior = records.get(parsed.messageId);
        if (!prior || Date.parse(parsed.updatedAt) >= Date.parse(prior.updatedAt)) {
          records.set(parsed.messageId, parsed);
        }
      } catch (error) {
        logger.error(`[ordinary-turn-ledger] corrupt record ignored (${join(dir, name)}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  caches.set(key, records);
  return records;
}

function persist(dataDir: string, record: OrdinaryTurnRecord): void {
  const dir = appDir(dataDir, record.larkAppId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(
    recordPath(dataDir, record.larkAppId, record.messageId),
    JSON.stringify(record),
    { durable: true, mode: 0o600, followTargetSymlink: false },
  );
  load(dataDir, record.larkAppId).set(record.messageId, record);
}

function clone(record: OrdinaryTurnRecord): OrdinaryTurnRecord {
  return structuredClone(record);
}

function resolvedAtMs(record: OrdinaryTurnRecord): number | undefined {
  // A pending output remains unresolved until the user-facing ambiguity fence
  // itself is durably notified. After that notification the provider request
  // is deliberately abandoned (its one-hour UUID window has elapsed), so the
  // row may be compacted once the normal retention horizon also passes.
  if (record.output?.status === 'pending' && !record.attention?.notifiedAt) {
    return undefined;
  }
  const value = record.output?.status === 'delivered'
    ? record.output.deliveredAt ?? record.updatedAt
    : record.attention?.notifiedAt
      ? record.attention.notifiedAt
      : record.terminal?.outputDisposition === 'nothing_to_send'
        ? record.terminal.at
        : undefined;
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Delete only positively settled rows older than the seen-store retention.
 * Ambiguous work, pending output, and unnotified attention are deliberately
 * retained without a size-based eviction: dropping them would recreate the
 * silent-loss window this ledger exists to close. */
export function compactOrdinaryTurnLedger(input: {
  dataDir: string;
  larkAppId: string;
  now?: number;
  retentionMs?: number;
}): number {
  const now = input.now ?? Date.now();
  const retentionMs = input.retentionMs ?? ORDINARY_TURN_LEDGER_RETENTION_MS;
  const records = load(input.dataDir, input.larkAppId);
  let removed = 0;
  for (const [messageId, record] of records) {
    const resolvedAt = resolvedAtMs(record);
    if (resolvedAt === undefined || now - resolvedAt < retentionMs) continue;
    const file = recordPath(input.dataDir, input.larkAppId, messageId);
    try {
      unlinkSync(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        logger.error(
          `[ordinary-turn-ledger] cannot compact ${file}: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
    }
    records.delete(messageId);
    removed += 1;
  }
  return removed;
}

function findByTurnId(dataDir: string, larkAppId: string, turnId: string): OrdinaryTurnRecord | undefined {
  const records = load(dataDir, larkAppId);
  const matches: OrdinaryTurnRecord[] = [];
  for (const record of records.values()) {
    if (record.turnId !== turnId) continue;
    matches.push(record);
  }
  if (matches.length > 1) {
    throw new Error(
      `ordinary turn ambiguous turn id ${turnId}: `
      + `${matches.map(record => record.messageId).sort().join(',')}`,
    );
  }
  // A session-group reply anchor can equal another inbound message_id. Prefer
  // the row that explicitly owns this turn id; exact message-id lookup is only
  // the compatibility fallback for pre-accept milestones whose turnId is not
  // stamped yet.
  return matches[0] ?? records.get(turnId);
}

function update(
  dataDir: string,
  larkAppId: string,
  messageId: string,
  now: number,
  mutate: (record: OrdinaryTurnRecord, at: string) => void,
): OrdinaryTurnRecord | undefined {
  const record = load(dataDir, larkAppId).get(messageId);
  if (!record) return undefined;
  const next = clone(record);
  const at = iso(now);
  mutate(next, at);
  next.updatedAt = at;
  persist(dataDir, next);
  return clone(next);
}

function updateByTurnId(
  dataDir: string,
  larkAppId: string,
  turnId: string,
  now: number,
  mutate: (record: OrdinaryTurnRecord, at: string) => void,
): OrdinaryTurnRecord | undefined {
  const record = findByTurnId(dataDir, larkAppId, turnId);
  return record ? update(dataDir, larkAppId, record.messageId, now, mutate) : undefined;
}

export function prepareOrdinaryTurnClaim(input: {
  dataDir: string;
  larkAppId: string;
  messageId: string;
  payload: unknown;
  now?: number;
}): 'created' | 'duplicate' {
  if (!input.messageId) throw new Error('ordinary turn claim requires messageId');
  compactOrdinaryTurnLedger({
    dataDir: input.dataDir,
    larkAppId: input.larkAppId,
    now: input.now,
  });
  const records = load(input.dataDir, input.larkAppId);
  const existing = records.get(input.messageId);
  if (existing) {
    validateOrdinaryTurnClaim(input);
    return 'duplicate';
  }
  const payloadHash = computeInputHash(input.payload);
  const at = iso(input.now ?? Date.now());
  persist(input.dataDir, {
    version: RECORD_VERSION,
    larkAppId: input.larkAppId,
    messageId: input.messageId,
    payload: structuredClone(input.payload),
    payloadHash,
    claimedAt: at,
    updatedAt: at,
  });
  return 'created';
}

/** Validate a provider duplicate even when the seen-message tombstone already
 * exists. Missing rows are legacy-compatible (do not synthesize replay work),
 * while one message id carrying different intent is persisted as attention and
 * rejected before ACK. */
export function validateOrdinaryTurnClaim(input: {
  dataDir: string;
  larkAppId: string;
  messageId: string;
  payload: unknown;
  now?: number;
}): 'absent' | 'match' {
  const existing = load(input.dataDir, input.larkAppId).get(input.messageId);
  if (!existing) return 'absent';
  const payloadHash = computeInputHash(input.payload);
  const existingHash = existing.payloadHash ?? computeInputHash(existing.payload);
  if (existingHash === payloadHash) return 'match';
  update(
    input.dataDir,
    input.larkAppId,
    input.messageId,
    input.now ?? Date.now(),
    (record, at) => {
      record.payloadHash ??= existingHash;
      record.attention ??= {
        requiredAt: at,
        reason: 'message_id_payload_conflict',
      };
    },
  );
  throw new Error(`ordinary message ${input.messageId} payload conflict`);
}

export function markOrdinaryTurnReplayScheduled(input: {
  dataDir: string; larkAppId: string; messageId: string; now?: number;
}): OrdinaryTurnRecord | undefined {
  return update(input.dataDir, input.larkAppId, input.messageId, input.now ?? Date.now(), (record, at) => {
    record.replayScheduledAt ??= at;
  });
}

export function markOrdinaryTurnRouted(input: {
  dataDir: string;
  larkAppId: string;
  messageId: string;
  routing: OrdinaryTurnRoutingSnapshot;
  now?: number;
}): OrdinaryTurnRecord | undefined {
  return update(input.dataDir, input.larkAppId, input.messageId, input.now ?? Date.now(), (record, at) => {
    const firstRealRoute = !record.routedAt && !record.acceptedAt && !record.worker;
    if (firstRealRoute && record.terminal?.outputDisposition === 'nothing_to_send') {
      delete record.terminal;
    }
    if (firstRealRoute && record.attention && !record.attention.notifiedAt) {
      delete record.attention;
    }
    record.routedAt ??= at;
    record.routing ??= structuredClone(input.routing);
  });
}

/** Settle a claimed message that routing intentionally ignored or handled
 * without admitting CLI work. This is message-id addressed on purpose: before
 * acceptance there may be no turnId, and another row's turnId may equal this
 * message id. */
export function markOrdinaryTurnIgnored(input: {
  dataDir: string;
  larkAppId: string;
  messageId: string;
  now?: number;
}): OrdinaryTurnRecord | undefined {
  return update(input.dataDir, input.larkAppId, input.messageId, input.now ?? Date.now(), (record, at) => {
    record.terminal = {
      at,
      status: 'completed',
      outputDisposition: 'nothing_to_send',
    };
    if (record.attention && !record.attention.notifiedAt) delete record.attention;
  });
}

export function markOrdinaryTurnAccepted(input: {
  dataDir: string;
  larkAppId: string;
  messageId: string;
  turnId: string;
  sessionId?: string;
  now?: number;
}): OrdinaryTurnRecord | undefined {
  return update(input.dataDir, input.larkAppId, input.messageId, input.now ?? Date.now(), (record, at) => {
    record.acceptedAt ??= at;
    record.turnId ??= input.turnId;
    if (input.sessionId) record.sessionId ??= input.sessionId;
  });
}

function workerMilestone(input: {
  dataDir: string;
  larkAppId: string;
  turnId: string;
  sessionId?: string;
  workerGeneration: number;
  now?: number;
}, mutate: (worker: NonNullable<OrdinaryTurnRecord['worker']>, at: string) => void): OrdinaryTurnRecord | undefined {
  return updateByTurnId(input.dataDir, input.larkAppId, input.turnId, input.now ?? Date.now(), (record, at) => {
    record.turnId ??= input.turnId;
    if (input.sessionId) record.sessionId ??= input.sessionId;
    const worker = record.worker ?? { generation: input.workerGeneration };
    if (worker.generation !== input.workerGeneration) {
      record.attention ??= { requiredAt: at, reason: 'worker_generation_changed' };
      return;
    }
    record.worker = worker;
    mutate(worker, at);
  });
}

export function markOrdinaryTurnWorkerReceived(input: {
  dataDir: string; larkAppId: string; turnId: string; sessionId?: string; workerGeneration: number; now?: number;
}): OrdinaryTurnRecord | undefined {
  return workerMilestone(input, (worker, at) => { worker.receivedAt ??= at; });
}

export function markOrdinaryTurnCommitted(input: {
  dataDir: string; larkAppId: string; turnId: string; sessionId?: string; workerGeneration: number; now?: number;
}): OrdinaryTurnRecord | undefined {
  return workerMilestone(input, (worker, at) => { worker.committedAt ??= at; });
}

export function markOrdinaryTurnRunning(input: {
  dataDir: string; larkAppId: string; turnId: string; sessionId?: string; workerGeneration: number; now?: number;
}): OrdinaryTurnRecord | undefined {
  return workerMilestone(input, (worker, at) => {
    worker.runningAt ??= at;
    worker.heartbeatAt = at;
  });
}

export function markOrdinaryTurnHeartbeat(input: {
  dataDir: string; larkAppId: string; turnId: string; sessionId?: string; workerGeneration: number; now?: number;
}): OrdinaryTurnRecord | undefined {
  return workerMilestone(input, (worker, at) => { worker.heartbeatAt = at; });
}

export function markOrdinaryTurnRejected(input: {
  dataDir: string; larkAppId: string; turnId: string; sessionId?: string; workerGeneration: number; reason: string; now?: number;
}): OrdinaryTurnRecord | undefined {
  return workerMilestone(input, (worker, at) => {
    worker.rejectedAt = at;
    worker.rejectionReason = input.reason;
  });
}

export function markOrdinaryTurnTerminal(input: {
  dataDir: string;
  larkAppId: string;
  turnId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'ambiguous';
  errorCode?: string;
  outputDisposition?: 'nothing_to_send';
  now?: number;
}): OrdinaryTurnRecord | undefined {
  return updateByTurnId(input.dataDir, input.larkAppId, input.turnId, input.now ?? Date.now(), (record, at) => {
    record.terminal = {
      at,
      status: input.status,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.outputDisposition ? { outputDisposition: input.outputDisposition } : {}),
    };
  });
}

export function prepareOrdinaryTurnOutput(input: {
  dataDir: string;
  larkAppId: string;
  turnId: string;
  delivery: OrdinaryTurnOutputDelivery;
  now?: number;
}): 'absent' | 'pending' | 'delivered' {
  const record = findByTurnId(input.dataDir, input.larkAppId, input.turnId);
  if (!record) return 'absent';
  if (record.output?.status === 'delivered') return 'delivered';
  if (record.output) {
    if (JSON.stringify(record.output.delivery) !== JSON.stringify(input.delivery)) {
      markOrdinaryTurnAttention({
        dataDir: input.dataDir,
        larkAppId: input.larkAppId,
        turnId: input.turnId,
        reason: 'final_output_payload_conflict',
        now: input.now,
      });
      throw new Error(`ordinary turn ${input.turnId} final_output payload conflict`);
    }
    return 'pending';
  }
  update(input.dataDir, input.larkAppId, record.messageId, input.now ?? Date.now(), (next, at) => {
    next.output = {
      status: 'pending',
      delivery: structuredClone(input.delivery),
      preparedAt: at,
    };
  });
  return 'pending';
}

export function markOrdinaryTurnOutputDelivered(input: {
  dataDir: string;
  larkAppId: string;
  turnId: string;
  providerMessageId: string;
  now?: number;
}): OrdinaryTurnRecord | undefined {
  return updateByTurnId(input.dataDir, input.larkAppId, input.turnId, input.now ?? Date.now(), (record, at) => {
    if (!record.output) throw new Error(`ordinary turn ${input.turnId} output was not prepared`);
    record.output.status = 'delivered';
    record.output.deliveredAt = at;
    record.output.providerMessageId = input.providerMessageId;
  });
}

export function markOrdinaryTurnAttention(input: {
  dataDir: string;
  larkAppId: string;
  messageId?: string;
  turnId?: string;
  reason: string;
  now?: number;
}): OrdinaryTurnRecord | undefined {
  const record = input.messageId
    ? load(input.dataDir, input.larkAppId).get(input.messageId)
    : input.turnId
      ? findByTurnId(input.dataDir, input.larkAppId, input.turnId)
      : undefined;
  if (!record) return undefined;
  return update(input.dataDir, input.larkAppId, record.messageId, input.now ?? Date.now(), (next, at) => {
    next.attention ??= { requiredAt: at, reason: input.reason };
  });
}

export function markOrdinaryTurnAttentionNotified(input: {
  dataDir: string;
  larkAppId: string;
  messageId?: string;
  turnId?: string;
  providerMessageId: string;
  now?: number;
}): OrdinaryTurnRecord | undefined {
  const record = input.messageId
    ? load(input.dataDir, input.larkAppId).get(input.messageId)
    : input.turnId
      ? findByTurnId(input.dataDir, input.larkAppId, input.turnId)
      : undefined;
  if (!record) return undefined;
  return update(input.dataDir, input.larkAppId, record.messageId, input.now ?? Date.now(), (next, at) => {
    if (!next.attention) throw new Error(`ordinary turn ${record.messageId} attention was not prepared`);
    next.attention.notifiedAt = at;
    next.attention.providerMessageId = input.providerMessageId;
  });
}

function needsAttention(record: OrdinaryTurnRecord): boolean {
  if (record.attention) return !record.attention.notifiedAt;
  if (record.output?.status === 'delivered') return false;
  if (record.output?.status === 'pending') return false;
  if (record.terminal?.outputDisposition === 'nothing_to_send') return false;
  return !!(
    record.replayScheduledAt
    || record.routedAt
    || record.acceptedAt
    || record.worker?.receivedAt
    || record.worker?.committedAt
    || record.worker?.runningAt
    || record.terminal
  );
}

function pendingOutputWithinProviderDedupeWindow(
  record: OrdinaryTurnRecord,
  now: number,
): boolean {
  if (record.output?.status !== 'pending') return false;
  const preparedAt = Date.parse(record.output.preparedAt);
  return Number.isFinite(preparedAt)
    && now - preparedAt < ORDINARY_TURN_PROVIDER_DEDUPE_MS;
}

/** Re-read a pending output immediately before its provider call. Recovery
 * planning and delivery are separated by awaits, while the live final-output
 * path can settle the same row in between. The stable provider UUID closes the
 * remaining check-to-send race, but a stale snapshot must not initiate a send
 * after delivery already settled or the provider dedupe window expired. */
export function selectOrdinaryTurnPendingOutputForDelivery(input: {
  dataDir: string;
  larkAppId: string;
  messageId: string;
  now?: number;
}): OrdinaryTurnRecord | undefined {
  const record = load(input.dataDir, input.larkAppId).get(input.messageId);
  if (!record || !pendingOutputWithinProviderDedupeWindow(record, input.now ?? Date.now())) {
    return undefined;
  }
  return clone(record);
}

/** Re-read an attention candidate immediately before its provider call.
 * Periodic drains may deliver only an explicit durable fence, whereas boot
 * reconciliation may infer attention from an incomplete pre-boot lifecycle.
 * An expired pending output is the one periodic inferred case: it must warn a
 * human instead of crossing Feishu's one-hour UUID dedupe boundary. */
export function selectOrdinaryTurnAttentionForDelivery(input: {
  dataDir: string;
  larkAppId: string;
  messageId: string;
  allowInferred: boolean;
  now?: number;
}): OrdinaryTurnRecord | undefined {
  const now = input.now ?? Date.now();
  const record = load(input.dataDir, input.larkAppId).get(input.messageId);
  if (!record) return undefined;
  if (record.output?.status === 'delivered'
    || record.terminal?.outputDisposition === 'nothing_to_send'
    || record.attention?.notifiedAt) {
    return undefined;
  }
  if (record.output?.status === 'pending') {
    if (pendingOutputWithinProviderDedupeWindow(record, now)) return undefined;
    const attention = clone(record);
    attention.attention ??= {
      requiredAt: iso(now),
      reason: 'pending_output_provider_dedupe_expired',
    };
    return attention;
  }
  if (record.attention) return clone(record);
  if (!input.allowInferred || !needsAttention(record)) return undefined;
  return clone(record);
}

export function planOrdinaryTurnRecovery(
  dataDir: string,
  larkAppId: string,
  now = Date.now(),
): OrdinaryTurnRecoveryPlan {
  compactOrdinaryTurnLedger({ dataDir, larkAppId, now });
  const plan: OrdinaryTurnRecoveryPlan = { replays: [], attentions: [], pendingOutputs: [] };
  const records = [...load(dataDir, larkAppId).values()]
    .sort((a, b) => Date.parse(a.claimedAt) - Date.parse(b.claimedAt));
  for (const record of records) {
    if (record.output?.status === 'pending') {
      if (pendingOutputWithinProviderDedupeWindow(record, now)) {
        plan.pendingOutputs.push(clone(record));
      } else if (!record.attention?.notifiedAt) {
        const attention = clone(record);
        attention.attention ??= {
          requiredAt: iso(now),
          reason: 'pending_output_provider_dedupe_expired',
        };
        plan.attentions.push(attention);
      }
      continue;
    }
    if (record.output?.status === 'delivered'
      || record.terminal?.outputDisposition === 'nothing_to_send'
      || record.attention?.notifiedAt) continue;
    if (needsAttention(record)) {
      plan.attentions.push(clone(record));
      continue;
    }
    plan.replays.push(clone(record));
  }
  return plan;
}

export function readOrdinaryTurnRecord(
  dataDir: string,
  larkAppId: string,
  messageIdOrTurnId: string,
): OrdinaryTurnRecord | undefined {
  const record = load(dataDir, larkAppId).get(messageIdOrTurnId)
    ?? findByTurnId(dataDir, larkAppId, messageIdOrTurnId);
  return record ? clone(record) : undefined;
}

export function _resetOrdinaryTurnLedgerCacheForTest(): void {
  caches.clear();
}
