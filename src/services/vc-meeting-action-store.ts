/**
 * Durable side-effect ledger for VC meeting consumers.
 *
 * This module deliberately contains no membership/capability/provider logic. The
 * action gate performs those checks before calling `beginVcMeetingAction`; this
 * store only makes the effect identity immutable and the provider attempt
 * write-ahead durable. Every meeting is one locked JSON snapshot (0600), so two
 * daemons sharing a dataDir cannot both claim the same action.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { canonicalJson, computeInputHash } from '../utils/canonical-input-hash.js';

const DIR_NAME = 'vc-meeting-actions';
const SCHEMA_VERSION = 1;

export const VC_MEETING_ACTION_SINKS = [
  'listener_chat',
  'listener_notice',
  'meeting_text',
  'meeting_voice',
  'attention_dm',
  'task',
] as const;

export type VcMeetingActionSink = typeof VC_MEETING_ACTION_SINKS[number];

/** v1 intentionally has no agent-controlled free-form slots. */
export const VC_MEETING_ACTION_SLOTS = ['primary'] as const;
export type VcMeetingActionSlot = typeof VC_MEETING_ACTION_SLOTS[number];

export type VcMeetingActionSource =
  | { kind: 'delivery'; key: string; deliverySeq: number }
  | { kind: 'im_turn'; key: string; larkMessageId: string };

export type VcMeetingActionStatus =
  | 'requested'
  | 'pendingApproval'
  | 'approved'
  | 'attempting'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'expired'
  | 'unknown';

export type VcMeetingApprovalCardStatus =
  | 'requested'
  | 'attempting'
  | 'presented'
  | 'failed'
  | 'unknown';

export interface VcMeetingApprovalCardRecord {
  /** Stable Lark card UUID/idempotency key derived from actionId. */
  providerKey: string;
  status: VcMeetingApprovalCardStatus;
  attemptCount: number;
  attemptedAt?: number;
  finishedAt?: number;
  externalRefs?: Record<string, unknown>;
  errorCode?: string;
  createdAt: number;
  updatedAt: number;
}

export const VC_MEETING_ACTION_TERMINAL_STATUSES = [
  'succeeded',
  'failed',
  'rejected',
  'expired',
  'unknown',
] as const satisfies readonly VcMeetingActionStatus[];

const TERMINAL_STATUSES: ReadonlySet<VcMeetingActionStatus> = new Set(
  VC_MEETING_ACTION_TERMINAL_STATUSES,
);

const ACTION_STATUSES: ReadonlySet<string> = new Set([
  'requested',
  'pendingApproval',
  'approved',
  'attempting',
  ...VC_MEETING_ACTION_TERMINAL_STATUSES,
]);

const APPROVAL_CARD_STATUSES: ReadonlySet<string> = new Set([
  'requested',
  'attempting',
  'presented',
  'failed',
  'unknown',
]);

export interface VcMeetingActionScope {
  listenerAppId: string;
  meetingId: string;
}

export interface VcMeetingActionBeginInput extends VcMeetingActionScope {
  memberId: string;
  memberEpoch: number;
  agentAppId: string;
  /** Sink-owner-generation authorization snapshot; intentionally excluded from actionId. */
  ownerGeneration: number;
  source: VcMeetingActionSource;
  sink: VcMeetingActionSink;
  /** Runtime validation remains strict even if an untyped caller supplies a string. */
  actionSlot?: VcMeetingActionSlot;
  /** Provider-facing, normalized payload. Transport/reason fields do not belong here. */
  canonicalInput: unknown;
}

export interface VcMeetingActionRecord extends VcMeetingActionScope {
  actionId: string;
  actionSlot: VcMeetingActionSlot;
  source: VcMeetingActionSource;
  memberId: string;
  memberEpoch: number;
  agentAppId: string;
  sink: VcMeetingActionSink;
  /** Durable sinkOwnerGeneration snapshot used by the action gate's fencing check. */
  ownerGeneration: number;
  inputHash: string;
  /** Stable provider idempotency token, independent from provider content. */
  providerKey: string;
  status: VcMeetingActionStatus;
  canonicalInput: unknown;
  attemptCount: number;
  attemptedAt?: number;
  finishedAt?: number;
  externalRefs?: Record<string, unknown>;
  errorCode?: string;
  /** Present iff this action entered pending approval. The card is an effect too. */
  approvalCard?: VcMeetingApprovalCardRecord;
  createdAt: number;
  updatedAt: number;
}

export type VcMeetingActionBeginResult =
  | { kind: 'created'; record: VcMeetingActionRecord }
  /** Exact identity + content replay. Returned before any current fencing checks. */
  | { kind: 'existing'; record: VcMeetingActionRecord }
  | {
      kind: 'conflict';
      reason: 'invalid' | 'unsupported_slot' | 'input_mismatch';
      actionId?: string;
      record?: VcMeetingActionRecord;
      detail?: string;
    };

export interface VcMeetingActionRef extends VcMeetingActionScope {
  actionId: string;
  inputHash: string;
}

export type VcMeetingActionTransitionResult =
  | { kind: 'updated'; record: VcMeetingActionRecord }
  | { kind: 'existing'; record: VcMeetingActionRecord }
  | {
      kind: 'conflict';
      reason: 'not_found' | 'input_mismatch' | 'invalid_transition' | 'invalid';
      record?: VcMeetingActionRecord;
    };

export type VcMeetingActionClaimResult =
  | { kind: 'claimed'; record: VcMeetingActionRecord }
  | { kind: 'existing'; record: VcMeetingActionRecord }
  | {
      kind: 'conflict';
      reason: 'not_found' | 'input_mismatch' | 'invalid_transition' | 'invalid';
      record?: VcMeetingActionRecord;
    };

export type VcMeetingApprovalCardClaimResult = VcMeetingActionClaimResult;

export interface VcMeetingProviderReconcileRef extends VcMeetingActionRef {
  sink: VcMeetingActionSink;
  providerKey: string;
  attemptedAt: number;
  externalRefs?: Record<string, unknown>;
  /** Caller must lookup or idempotently retry with providerKey, then finish. */
  mode: 'lookup_or_idempotent_retry';
}

export interface VcMeetingApprovalCardReconcileRef extends VcMeetingActionRef {
  approvalProviderKey: string;
  status: 'requested' | 'attempting';
  attemptedAt?: number;
  externalRefs?: Record<string, unknown>;
  /** requested = send after claim; attempting = lookup/retry with the same key. */
  mode: 'claim_then_send' | 'lookup_or_idempotent_retry';
}

export interface VcMeetingActionBootReconcileResult {
  providerAttempts: VcMeetingProviderReconcileRef[];
  approvalCards: VcMeetingApprovalCardReconcileRef[];
  terminalizedUnknown: VcMeetingActionRecord[];
  terminalizedExpired: VcMeetingActionRecord[];
}

interface VcMeetingActionStateFile extends VcMeetingActionScope {
  schemaVersion: number;
  actions: Record<string, VcMeetingActionRecord>;
  createdAt: number;
  updatedAt: number;
}

function nonEmpty(...values: string[]): boolean {
  return values.every((value) => typeof value === 'string' && value.trim().length > 0);
}

function safeFileToken(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, (ch) => `%${ch.charCodeAt(0).toString(16)}`);
}

function meetingFileName(scope: VcMeetingActionScope): string {
  return `${safeFileToken(scope.listenerAppId)}__${safeFileToken(scope.meetingId)}.json`;
}

function meetingFilePath(dataDir: string, scope: VcMeetingActionScope): string {
  return join(dataDir, DIR_NAME, meetingFileName(scope));
}

function cloneRecord(record: VcMeetingActionRecord): VcMeetingActionRecord {
  return structuredClone(record);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateJsonRecord(value: unknown, label: string): void {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain object`);
  canonicalJson(value);
}

function validateSource(source: unknown): asserts source is VcMeetingActionSource {
  if (!isPlainObject(source) || !nonEmpty(source.kind as string, source.key as string)) {
    throw new Error('invalid action source');
  }
  if (source.kind === 'delivery') {
    if (
      !Number.isInteger(source.deliverySeq)
      || (source.deliverySeq as number) < 1
      || Object.keys(source).some((key) => !['kind', 'key', 'deliverySeq'].includes(key))
    ) throw new Error('invalid delivery action source');
    return;
  }
  if (source.kind === 'im_turn') {
    if (
      !nonEmpty(source.larkMessageId as string)
      || Object.keys(source).some((key) => !['kind', 'key', 'larkMessageId'].includes(key))
    ) throw new Error('invalid IM action source');
    return;
  }
  throw new Error('invalid action source kind');
}

function validateApprovalCard(record: VcMeetingActionRecord): void {
  const card = record.approvalCard;
  if (!card) {
    if (record.status === 'pendingApproval') throw new Error('pending approval is missing card effect');
    return;
  }
  if (
    !nonEmpty(card.providerKey)
    || card.providerKey !== deriveVcMeetingApprovalCardKey(record.actionId)
    || !APPROVAL_CARD_STATUSES.has(card.status)
    || !Number.isInteger(card.attemptCount)
    || card.attemptCount < 0
    || !isFiniteTimestamp(card.createdAt)
    || !isFiniteTimestamp(card.updatedAt)
    || (card.attemptedAt !== undefined && !isFiniteTimestamp(card.attemptedAt))
    || (card.finishedAt !== undefined && !isFiniteTimestamp(card.finishedAt))
    || (card.errorCode !== undefined && !nonEmpty(card.errorCode))
  ) throw new Error('invalid approval card effect');
  if (card.status === 'requested' && (card.attemptCount !== 0 || card.attemptedAt !== undefined)) {
    throw new Error('requested approval card has attempt evidence');
  }
  if (card.status === 'attempting' && (card.attemptCount < 1 || card.attemptedAt === undefined)) {
    throw new Error('attempting approval card lacks attempt evidence');
  }
  if (['presented', 'failed', 'unknown'].includes(card.status)
    && (card.attemptCount < 1 || card.attemptedAt === undefined || card.finishedAt === undefined)) {
    throw new Error('terminal approval card lacks finishedAt');
  }
  if (card.externalRefs !== undefined) validateJsonRecord(card.externalRefs, 'approval externalRefs');
}

function validateActionRecord(
  mapKey: string,
  value: unknown,
  scope: VcMeetingActionScope,
): asserts value is VcMeetingActionRecord {
  if (!isPlainObject(value)) throw new Error(`action ${mapKey} must be an object`);
  const record = value as unknown as VcMeetingActionRecord;
  if (
    record.listenerAppId !== scope.listenerAppId
    || record.meetingId !== scope.meetingId
    || record.actionId !== mapKey
    || !nonEmpty(record.memberId, record.agentAppId, record.inputHash, record.providerKey)
    || !Number.isInteger(record.memberEpoch)
    || record.memberEpoch < 1
    || !Number.isInteger(record.ownerGeneration)
    || record.ownerGeneration < 1
    || record.actionSlot !== 'primary'
    || !(VC_MEETING_ACTION_SINKS as readonly string[]).includes(record.sink)
    || !ACTION_STATUSES.has(record.status)
    || !Number.isInteger(record.attemptCount)
    || record.attemptCount < 0
    || !isFiniteTimestamp(record.createdAt)
    || !isFiniteTimestamp(record.updatedAt)
    || (record.attemptedAt !== undefined && !isFiniteTimestamp(record.attemptedAt))
    || (record.finishedAt !== undefined && !isFiniteTimestamp(record.finishedAt))
    || (record.errorCode !== undefined && !nonEmpty(record.errorCode))
  ) throw new Error(`invalid action record ${mapKey}`);

  validateSource(record.source);
  const expectedActionId = deriveVcMeetingActionId({
    meetingId: record.meetingId,
    memberId: record.memberId,
    memberEpoch: record.memberEpoch,
    source: record.source,
    sink: record.sink,
    actionSlot: record.actionSlot,
  });
  if (expectedActionId !== record.actionId) throw new Error(`actionId mismatch for ${mapKey}`);
  let expectedInputHash: string;
  try {
    expectedInputHash = computeInputHash(record.canonicalInput);
  } catch (err) {
    throw new Error(
      `invalid canonical input for ${mapKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (expectedInputHash !== record.inputHash) throw new Error(`inputHash mismatch for ${mapKey}`);
  if (record.providerKey !== deriveVcMeetingProviderKey(record.actionId)) {
    throw new Error(`providerKey mismatch for ${mapKey}`);
  }
  if (record.status === 'attempting' && (record.attemptCount < 1 || record.attemptedAt === undefined)) {
    throw new Error(`attempting action ${mapKey} lacks attempt evidence`);
  }
  if (isVcMeetingActionTerminal(record.status) && record.finishedAt === undefined) {
    throw new Error(`terminal action ${mapKey} lacks finishedAt`);
  }
  if (record.externalRefs !== undefined) validateJsonRecord(record.externalRefs, 'externalRefs');
  if (record.status === 'requested' && record.approvalCard !== undefined) {
    throw new Error(`requested action ${mapKey} unexpectedly has approval card`);
  }
  validateApprovalCard(record);
}

function readStateFile(fp: string, scope: VcMeetingActionScope): VcMeetingActionStateFile | undefined {
  if (!existsSync(fp)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(fp, 'utf-8'));
  } catch (err) {
    // Fail closed: rebuilding an effect ledger from empty could duplicate an
    // already-executed provider side effect.
    throw new Error(
      `vc meeting action ledger is unreadable at ${fp}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`vc meeting action ledger is invalid at ${fp}`);
  }
  const state = parsed as Partial<VcMeetingActionStateFile>;
  if (
    state.schemaVersion !== SCHEMA_VERSION
    || state.listenerAppId !== scope.listenerAppId
    || state.meetingId !== scope.meetingId
    || basename(fp) !== meetingFileName(scope)
    || !isPlainObject(state.actions)
    || !isFiniteTimestamp(state.createdAt)
    || !isFiniteTimestamp(state.updatedAt)
  ) {
    throw new Error(`vc meeting action ledger binding/schema mismatch at ${fp}`);
  }
  for (const [mapKey, record] of Object.entries(state.actions)) {
    validateActionRecord(mapKey, record, scope);
  }
  return state as VcMeetingActionStateFile;
}

function newStateFile(scope: VcMeetingActionScope, now: number): VcMeetingActionStateFile {
  return {
    schemaVersion: SCHEMA_VERSION,
    ...scope,
    actions: {},
    createdAt: now,
    updatedAt: now,
  };
}

function writeStateFile(fp: string, state: VcMeetingActionStateFile, now: number): void {
  state.updatedAt = now;
  const dir = join(fp, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(fp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

function mutateState<T>(
  dataDir: string,
  scope: VcMeetingActionScope,
  now: number,
  createIfMissing: boolean,
  fn: (state: VcMeetingActionStateFile | undefined) => { result: T; write?: VcMeetingActionStateFile },
): T {
  const dir = join(dataDir, DIR_NAME);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fp = meetingFilePath(dataDir, scope);
  return withFileLockSync(fp, () => {
    let state = readStateFile(fp, scope);
    if (!state && createIfMissing) state = newStateFile(scope, now);
    const { result, write } = fn(state);
    if (write) writeStateFile(fp, write, now);
    return result;
  });
}

/**
 * The effect identity is content- and owner-generation-independent. With the
 * `vca_` namespace the 50-character key retains 184 bits of SHA-256 entropy.
 */
export function deriveVcMeetingActionId(
  input: Omit<VcMeetingActionBeginInput, 'canonicalInput' | 'ownerGeneration' | 'agentAppId' | 'listenerAppId'>,
): string {
  const slot = input.actionSlot ?? 'primary';
  const seed = canonicalJson({
    meetingId: input.meetingId,
    memberId: input.memberId,
    memberEpoch: input.memberEpoch,
    sourceKind: input.source.kind,
    sourceKey: input.source.key,
    sink: input.sink,
    slot,
  });
  return `vca_${createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 46)}`;
}

/** Stable provider UUID/client-token derived only from action identity. */
export function deriveVcMeetingProviderKey(actionId: string): string {
  const hex = createHash('sha256').update(actionId, 'utf8').digest('hex');
  return `vcp_${hex.slice(0, 46)}`;
}

/** Approval presentation is a separate provider effect with its own stable key. */
export function deriveVcMeetingApprovalCardKey(actionId: string): string {
  const hex = createHash('sha256').update(`approval-card:${actionId}`, 'utf8').digest('hex');
  return `vcc_${hex.slice(0, 46)}`;
}

export function isVcMeetingActionTerminal(status: VcMeetingActionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * These providers have a stable providerKey that the gate can use for lookup or
 * an idempotent retry. Voice deliberately remains excluded: replaying speech
 * after an ambiguous crash is not safe.
 */
export function canReconcileVcMeetingActionProvider(sink: VcMeetingActionSink): boolean {
  return sink !== 'meeting_voice';
}

function validateBegin(input: VcMeetingActionBeginInput, slot: unknown): string | undefined {
  try {
    validateSource(input.source);
  } catch (err) {
    return err instanceof Error ? err.message : 'invalid action source';
  }
  if (
    !nonEmpty(
      input.listenerAppId,
      input.meetingId,
      input.memberId,
      input.agentAppId,
      input.source?.key,
    )
    || !Number.isInteger(input.memberEpoch)
    || input.memberEpoch < 1
    || !Number.isInteger(input.ownerGeneration)
    || input.ownerGeneration < 1
    || !VC_MEETING_ACTION_SINKS.includes(input.sink)
  ) return 'invalid action identity';
  if (slot !== 'primary') return 'unsupported slot';
  if (input.source.kind === 'delivery') {
    if (!Number.isInteger(input.source.deliverySeq) || input.source.deliverySeq < 1) {
      return 'invalid delivery source';
    }
  } else if (input.source.kind === 'im_turn') {
    if (!nonEmpty(input.source.larkMessageId)) return 'invalid IM source';
  } else {
    return 'invalid source kind';
  }
  return undefined;
}

/**
 * Persist an immutable action intent. Exact replays return the original record
 * even when the caller now carries a stale sink-owner generation or agent
 * snapshot; the action gate can therefore replay terminal results before
 * current fencing.
 */
export function beginVcMeetingAction(
  dataDir: string,
  input: VcMeetingActionBeginInput,
  now = Date.now(),
): VcMeetingActionBeginResult {
  const slot = input.actionSlot ?? 'primary';
  const validationError = validateBegin(input, slot);
  if (validationError) {
    return {
      kind: 'conflict',
      reason: slot !== 'primary' ? 'unsupported_slot' : 'invalid',
      detail: validationError,
    };
  }

  let canonicalInput: unknown;
  let inputHash: string;
  try {
    if (!isPlainObject(input.canonicalInput)) throw new Error('canonicalInput must be a plain object');
    // Parsing the canonical form snapshots the caller-owned object and removes
    // undefined object properties exactly as computeInputHash does.
    canonicalInput = JSON.parse(canonicalJson(input.canonicalInput));
    inputHash = computeInputHash(canonicalInput);
  } catch (err) {
    return {
      kind: 'conflict',
      reason: 'invalid',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const actionId = deriveVcMeetingActionId({
    meetingId: input.meetingId,
    memberId: input.memberId,
    memberEpoch: input.memberEpoch,
    source: input.source,
    sink: input.sink,
    actionSlot: slot,
  });
  const scope = { listenerAppId: input.listenerAppId, meetingId: input.meetingId };

  return mutateState<VcMeetingActionBeginResult>(dataDir, scope, now, true, (state) => {
    const existing = state!.actions[actionId];
    if (existing) {
      if (existing.inputHash !== inputHash) {
        return {
          result: {
            kind: 'conflict' as const,
            reason: 'input_mismatch' as const,
            actionId,
            record: cloneRecord(existing),
          },
        };
      }
      return { result: { kind: 'existing' as const, record: cloneRecord(existing) } };
    }

    const record: VcMeetingActionRecord = {
      ...scope,
      actionId,
      actionSlot: slot,
      source: structuredClone(input.source),
      memberId: input.memberId,
      memberEpoch: input.memberEpoch,
      agentAppId: input.agentAppId,
      sink: input.sink,
      ownerGeneration: input.ownerGeneration,
      inputHash,
      providerKey: deriveVcMeetingProviderKey(actionId),
      status: 'requested',
      canonicalInput,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    state!.actions[actionId] = record;
    return { result: { kind: 'created' as const, record: cloneRecord(record) }, write: state! };
  });
}

function transition(
  dataDir: string,
  ref: VcMeetingActionRef,
  now: number,
  apply: (record: VcMeetingActionRecord) => 'existing' | 'updated' | 'invalid_transition',
): VcMeetingActionTransitionResult {
  if (!nonEmpty(ref.listenerAppId, ref.meetingId, ref.actionId, ref.inputHash)) {
    return { kind: 'conflict', reason: 'invalid' };
  }
  const scope = { listenerAppId: ref.listenerAppId, meetingId: ref.meetingId };
  return mutateState<VcMeetingActionTransitionResult>(dataDir, scope, now, false, (state) => {
    const record = state?.actions[ref.actionId];
    if (!record) return { result: { kind: 'conflict' as const, reason: 'not_found' as const } };
    if (record.inputHash !== ref.inputHash) {
      return {
        result: {
          kind: 'conflict' as const,
          reason: 'input_mismatch' as const,
          record: cloneRecord(record),
        },
      };
    }
    const disposition = apply(record);
    if (disposition === 'invalid_transition') {
      return {
        result: {
          kind: 'conflict' as const,
          reason: 'invalid_transition' as const,
          record: cloneRecord(record),
        },
      };
    }
    if (disposition === 'existing') {
      return { result: { kind: 'existing' as const, record: cloneRecord(record) } };
    }
    record.updatedAt = now;
    return {
      result: { kind: 'updated' as const, record: cloneRecord(record) },
      write: state!,
    };
  });
}

export function markVcMeetingActionPendingApproval(
  dataDir: string,
  ref: VcMeetingActionRef,
  now = Date.now(),
): VcMeetingActionTransitionResult {
  return transition(dataDir, ref, now, (record) => {
    if (record.status === 'pendingApproval' || isVcMeetingActionTerminal(record.status)) return 'existing';
    if (record.status !== 'requested') return 'invalid_transition';
    record.status = 'pendingApproval';
    record.approvalCard = {
      providerKey: deriveVcMeetingApprovalCardKey(record.actionId),
      status: 'requested',
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    return 'updated';
  });
}

/**
 * Write-ahead claim for the approval card provider effect. `claimed` means the
 * card's attempting state is durable; the caller may now send with providerKey.
 */
export function claimVcMeetingApprovalCardAttempt(
  dataDir: string,
  ref: VcMeetingActionRef,
  now = Date.now(),
): VcMeetingApprovalCardClaimResult {
  const result = transition(dataDir, ref, now, (record) => {
    const card = record.approvalCard;
    if (record.status !== 'pendingApproval' || !card) return 'invalid_transition';
    if (card.status === 'attempting' || card.status === 'presented') return 'existing';
    if (card.status !== 'requested') return 'invalid_transition';
    card.status = 'attempting';
    card.attemptCount += 1;
    card.attemptedAt = now;
    card.updatedAt = now;
    return 'updated';
  });
  if (result.kind === 'updated') return { kind: 'claimed', record: result.record };
  return result;
}

function normalizedExternalRefs(
  externalRefs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (externalRefs === undefined) return undefined;
  if (!isPlainObject(externalRefs)) throw new Error('externalRefs must be a plain object');
  return JSON.parse(canonicalJson(externalRefs));
}

function mergeExternalRefs(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!existing && !incoming) return undefined;
  return { ...(existing ?? {}), ...(incoming ?? {}) };
}

export function finishVcMeetingApprovalCard(
  dataDir: string,
  ref: VcMeetingActionRef,
  finish: {
    status: 'presented' | 'failed' | 'unknown';
    externalRefs?: Record<string, unknown>;
    errorCode?: string;
  },
  now = Date.now(),
): VcMeetingActionTransitionResult {
  if (!(finish && ['presented', 'failed', 'unknown'].includes(finish.status))
    || (finish.errorCode !== undefined && !nonEmpty(finish.errorCode))) {
    return { kind: 'conflict', reason: 'invalid' };
  }
  let refs: Record<string, unknown> | undefined;
  try {
    refs = normalizedExternalRefs(finish.externalRefs);
  } catch {
    return { kind: 'conflict', reason: 'invalid' };
  }
  return transition(dataDir, ref, now, (record) => {
    const card = record.approvalCard;
    if (record.status !== 'pendingApproval' || !card) return 'invalid_transition';
    if (['presented', 'failed', 'unknown'].includes(card.status)) {
      if (card.status !== finish.status) return 'existing';
      // Preserve the first provider identifiers while still allowing a later
      // lookup/recovery callback to fill previously absent audit fields.
      const merged = mergeExternalRefs(refs, card.externalRefs);
      if (canonicalJson(merged ?? {}) === canonicalJson(card.externalRefs ?? {})) return 'existing';
      card.externalRefs = merged;
      card.updatedAt = now;
      return 'updated';
    }
    if (card.status !== 'attempting') return 'invalid_transition';
    card.status = finish.status;
    card.finishedAt = now;
    card.externalRefs = mergeExternalRefs(card.externalRefs, refs);
    if (finish.errorCode) card.errorCode = finish.errorCode;
    card.updatedAt = now;
    return 'updated';
  });
}

export function resolveVcMeetingActionApproval(
  dataDir: string,
  ref: VcMeetingActionRef,
  decision: 'approved' | 'rejected' | 'expired',
  opts: { externalRefs?: Record<string, unknown>; errorCode?: string } = {},
  now = Date.now(),
): VcMeetingActionTransitionResult {
  if (!['approved', 'rejected', 'expired'].includes(decision)
    || (opts.errorCode !== undefined && !nonEmpty(opts.errorCode))) {
    return { kind: 'conflict', reason: 'invalid' };
  }
  let normalizedRefs: Record<string, unknown> | undefined;
  try {
    normalizedRefs = normalizedExternalRefs(opts.externalRefs);
  } catch {
    return { kind: 'conflict', reason: 'invalid' };
  }
  return transition(dataDir, ref, now, (record) => {
    if (record.status === decision || isVcMeetingActionTerminal(record.status)) return 'existing';
    // `approved` is only a legacy two-write crash residue. It may be expired
    // after current-authority revalidation fails, but it must never be newly
    // claimed without that revalidation.
    if (record.status !== 'pendingApproval'
      && !(record.status === 'approved' && decision !== 'approved')) {
      return 'invalid_transition';
    }
    record.status = decision;
    record.externalRefs = mergeExternalRefs(record.externalRefs, normalizedRefs);
    if (opts.errorCode) record.errorCode = opts.errorCode;
    if (decision !== 'approved') record.finishedAt = now;
    return 'updated';
  });
}

/**
 * Atomically apply an approval and claim the provider attempt in one file-lock
 * transaction. There is deliberately no durable `approved` crash window: once
 * this returns `claimed`, the write-ahead `attempting` record is already the
 * only observable state. A legacy/crash residue already in `approved` is also
 * claimed so startup can heal older records.
 */
export function approveAndClaimVcMeetingAction(
  dataDir: string,
  ref: VcMeetingActionRef,
  opts: { externalRefs?: Record<string, unknown> } = {},
  now = Date.now(),
): VcMeetingActionClaimResult {
  let normalizedRefs: Record<string, unknown> | undefined;
  try {
    normalizedRefs = normalizedExternalRefs(opts.externalRefs);
  } catch {
    return { kind: 'conflict', reason: 'invalid' };
  }
  const result = transition(dataDir, ref, now, (record) => {
    if (record.status === 'attempting' || isVcMeetingActionTerminal(record.status)) return 'existing';
    if (record.status !== 'pendingApproval' && record.status !== 'approved') return 'invalid_transition';
    record.status = 'attempting';
    record.externalRefs = mergeExternalRefs(record.externalRefs, normalizedRefs);
    record.attemptCount += 1;
    record.attemptedAt = now;
    delete record.errorCode;
    return 'updated';
  });
  if (result.kind === 'updated') return { kind: 'claimed', record: result.record };
  return result;
}

/**
 * Deterministically reject an action before any provider attempt. This is kept
 * separate from approval resolution: capability/fencing/policy denial is not
 * an approval-card effect and must not manufacture one merely to reach the
 * terminal `rejected` state.
 */
export function rejectVcMeetingAction(
  dataDir: string,
  ref: VcMeetingActionRef,
  opts: { errorCode: string; externalRefs?: Record<string, unknown> },
  now = Date.now(),
): VcMeetingActionTransitionResult {
  if (!opts || !nonEmpty(opts.errorCode)) {
    return { kind: 'conflict', reason: 'invalid' };
  }
  let normalizedRefs: Record<string, unknown> | undefined;
  try {
    normalizedRefs = normalizedExternalRefs(opts.externalRefs);
  } catch {
    return { kind: 'conflict', reason: 'invalid' };
  }
  return transition(dataDir, ref, now, (record) => {
    if (record.status === 'rejected' || isVcMeetingActionTerminal(record.status)) return 'existing';
    if (record.status !== 'requested') return 'invalid_transition';
    record.status = 'rejected';
    record.errorCode = opts.errorCode;
    record.externalRefs = mergeExternalRefs(record.externalRefs, normalizedRefs);
    record.finishedAt = now;
    return 'updated';
  });
}

/**
 * Atomically claims provider execution. `claimed` means the attempting record
 * is already durable and the caller may now invoke the provider. Every other
 * result means the caller must not invoke it.
 */
export function claimVcMeetingActionAttempt(
  dataDir: string,
  ref: VcMeetingActionRef,
  now = Date.now(),
): VcMeetingActionClaimResult {
  const result = transition(dataDir, ref, now, (record) => {
    if (record.status === 'attempting' || isVcMeetingActionTerminal(record.status)) return 'existing';
    if (record.status !== 'requested' && record.status !== 'approved') return 'invalid_transition';
    record.status = 'attempting';
    record.attemptCount += 1;
    record.attemptedAt = now;
    return 'updated';
  });
  if (result.kind === 'updated') return { kind: 'claimed', record: result.record };
  return result;
}

export function finishVcMeetingAction(
  dataDir: string,
  ref: VcMeetingActionRef,
  finish: {
    status: 'succeeded' | 'failed' | 'unknown';
    externalRefs?: Record<string, unknown>;
    errorCode?: string;
  },
  now = Date.now(),
): VcMeetingActionTransitionResult {
  if (!(finish && ['succeeded', 'failed', 'unknown'].includes(finish.status))
    || (finish.errorCode !== undefined && !nonEmpty(finish.errorCode))) {
    return { kind: 'conflict', reason: 'invalid' };
  }
  let normalizedRefs: Record<string, unknown> | undefined;
  try {
    normalizedRefs = normalizedExternalRefs(finish.externalRefs);
  } catch {
    return { kind: 'conflict', reason: 'invalid' };
  }
  return transition(dataDir, ref, now, (record) => {
    if (isVcMeetingActionTerminal(record.status)) {
      if (record.status !== finish.status) return 'existing';
      // A duplicate provider callback may add lookup evidence, but it must not
      // rewrite the provider ids captured by the first terminal callback.
      const merged = mergeExternalRefs(normalizedRefs, record.externalRefs);
      if (canonicalJson(merged ?? {}) === canonicalJson(record.externalRefs ?? {})) return 'existing';
      record.externalRefs = merged;
      return 'updated';
    }
    if (record.status !== 'attempting') return 'invalid_transition';
    record.status = finish.status;
    record.finishedAt = now;
    record.externalRefs = mergeExternalRefs(record.externalRefs, normalizedRefs);
    if (finish.errorCode) record.errorCode = finish.errorCode;
    return 'updated';
  });
}

export function findVcMeetingAction(
  dataDir: string,
  scope: VcMeetingActionScope,
  actionId: string,
): VcMeetingActionRecord | undefined {
  if (!nonEmpty(scope.listenerAppId, scope.meetingId, actionId)) return undefined;
  const state = readStateFile(meetingFilePath(dataDir, scope), scope);
  const record = state?.actions[actionId];
  return record ? cloneRecord(record) : undefined;
}

export function listVcMeetingActions(
  dataDir: string,
  scope: VcMeetingActionScope,
  filter: { status?: VcMeetingActionStatus; memberId?: string; sink?: VcMeetingActionSink } = {},
): VcMeetingActionRecord[] {
  if (!nonEmpty(scope.listenerAppId, scope.meetingId)) return [];
  const state = readStateFile(meetingFilePath(dataDir, scope), scope);
  if (!state) return [];
  return Object.values(state.actions)
    .filter((record) => filter.status === undefined || record.status === filter.status)
    .filter((record) => filter.memberId === undefined || record.memberId === filter.memberId)
    .filter((record) => filter.sink === undefined || record.sink === filter.sink)
    .sort((a, b) => a.createdAt - b.createdAt || a.actionId.localeCompare(b.actionId))
    .map(cloneRecord);
}

/** Enumerate durable meeting scopes so daemon boot can reconcile every ledger. */
export function listVcMeetingActionScopes(dataDir: string): VcMeetingActionScope[] {
  const dir = join(dataDir, DIR_NAME);
  if (!existsSync(dir)) return [];
  const scopes: VcMeetingActionScope[] = [];
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
    const fp = join(dir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(fp, 'utf8'));
    } catch (err) {
      throw new Error(
        `vc meeting action ledger is unreadable at ${fp}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!isPlainObject(raw) || !nonEmpty(raw.listenerAppId as string, raw.meetingId as string)) {
      throw new Error(`vc meeting action ledger binding/schema mismatch at ${fp}`);
    }
    const scope = {
      listenerAppId: raw.listenerAppId as string,
      meetingId: raw.meetingId as string,
    };
    // Full validation also proves the filename and every record bind to scope.
    readStateFile(fp, scope);
    scopes.push(scope);
  }
  return scopes.sort(
    (a, b) => a.listenerAppId.localeCompare(b.listenerAppId) || a.meetingId.localeCompare(b.meetingId),
  );
}

/**
 * Provider-aware boot recovery. Voice is terminalized as unknown/manual because
 * replay is unsafe. Sinks with a stable provider key remain attempting and are
 * returned as work for lookup/idempotent retry. Approval-card presentation is
 * independently returned as work: `requested` covers a crash after durable
 * pendingApproval but before card claim, while `attempting` covers an ambiguous
 * post-send crash. This function itself never invokes a provider.
 */
export function reconcileVcMeetingActionsOnBoot(
  dataDir: string,
  scope: VcMeetingActionScope,
  now = Date.now(),
): VcMeetingActionBootReconcileResult {
  const empty = (): VcMeetingActionBootReconcileResult => ({
    providerAttempts: [],
    approvalCards: [],
    terminalizedUnknown: [],
    terminalizedExpired: [],
  });
  if (!nonEmpty(scope.listenerAppId, scope.meetingId)) return empty();
  return mutateState<VcMeetingActionBootReconcileResult>(dataDir, scope, now, false, (state) => {
    if (!state) return { result: empty() };
    const result = empty();
    let changed = false;
    for (const record of Object.values(state.actions)) {
      // A historical two-write approval crash residue has not been fenced
      // against the current meeting/member/owner state. New callers use the
      // atomic approve+claim path after revalidation and never persist this
      // intermediate state. Expire the residue rather than executing it at
      // boot with stale authority.
      if (record.status === 'approved') {
        record.status = 'expired';
        record.errorCode = 'approval_revalidation_required_after_restart';
        record.finishedAt = now;
        record.updatedAt = now;
        result.terminalizedExpired.push(cloneRecord(record));
        changed = true;
        continue;
      }
      if (record.status === 'attempting') {
        if (canReconcileVcMeetingActionProvider(record.sink)) {
          result.providerAttempts.push({
            listenerAppId: record.listenerAppId,
            meetingId: record.meetingId,
            actionId: record.actionId,
            inputHash: record.inputHash,
            sink: record.sink,
            providerKey: record.providerKey,
            attemptedAt: record.attemptedAt!,
            externalRefs: record.externalRefs ? structuredClone(record.externalRefs) : undefined,
            mode: 'lookup_or_idempotent_retry',
          });
        } else {
          record.status = 'unknown';
          record.errorCode = 'provider_result_unknown_manual_review';
          record.finishedAt = now;
          record.updatedAt = now;
          result.terminalizedUnknown.push(cloneRecord(record));
          changed = true;
        }
      }

      const card = record.approvalCard;
      if (record.status === 'pendingApproval' && card
        && (card.status === 'failed' || card.status === 'unknown')) {
        record.status = 'expired';
        record.errorCode = `approval_card_${card.status}`;
        record.finishedAt = now;
        record.updatedAt = now;
        changed = true;
        continue;
      }
      if (record.status === 'pendingApproval' && card
        && (card.status === 'requested' || card.status === 'attempting')) {
        result.approvalCards.push({
          listenerAppId: record.listenerAppId,
          meetingId: record.meetingId,
          actionId: record.actionId,
          inputHash: record.inputHash,
          approvalProviderKey: card.providerKey,
          status: card.status,
          attemptedAt: card.attemptedAt,
          externalRefs: card.externalRefs ? structuredClone(card.externalRefs) : undefined,
          mode: card.status === 'requested' ? 'claim_then_send' : 'lookup_or_idempotent_retry',
        });
      }
    }
    return { result, ...(changed ? { write: state } : {}) };
  });
}
