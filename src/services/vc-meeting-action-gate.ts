/**
 * Deterministic action gate for managed VC-meeting side effects.
 *
 * The receiver daemon supplies a trusted origin (session + stable delivery
 * turn + dispatch attempt). This service resolves that origin from the durable
 * delivery ledger, persists an immutable action intent, applies current
 * membership fencing, and write-ahead claims the next provider effect. It
 * deliberately never calls Lark, the realtime voice provider, or an approval
 * card provider; callers execute only the returned plan.
 */
import { createHash } from 'node:crypto';
import {
  approveAndClaimVcMeetingAction,
  beginVcMeetingAction,
  claimVcMeetingActionAttempt,
  claimVcMeetingApprovalCardAttempt,
  deriveVcMeetingActionId,
  findVcMeetingAction,
  finishVcMeetingAction,
  finishVcMeetingApprovalCard,
  isVcMeetingActionTerminal,
  markVcMeetingActionPendingApproval,
  rejectVcMeetingAction,
  resolveVcMeetingActionApproval,
  VC_MEETING_ACTION_SINKS,
  type VcMeetingActionRecord,
  type VcMeetingActionRef,
  type VcMeetingActionSink,
  type VcMeetingActionTransitionResult,
} from './vc-meeting-action-store.js';
import {
  findVcMeetingDeliveryByKey,
  getVcMeetingMemberProjection,
  listVcMeetingMemberProjections,
  type VcMeetingDeliveryReceiptRecord,
  type VcMeetingMemberProjectionRecord,
} from './vc-meeting-delivery-store.js';
import { canonicalJson, computeInputHash } from '../utils/canonical-input-hash.js';

const MAX_OUTPUT_CHARS = 200;

export type VcMeetingManagedActionChannel = 'text' | 'voice';

export interface VcMeetingManagedActionRequest {
  /** Trusted consumer-daemon identity; still checked against the local daemon. */
  agentAppId: string;
  receiverSessionId: string;
  /** The stable delivery turn id. In MA-P0 this is exactly the delivery key. */
  stableTurnId: string;
  dispatchAttempt: number;
  channel: VcMeetingManagedActionChannel;
  content: string;
  fallbackText?: string;
  /** Human-facing justification; excluded from provider input and inputHash. */
  reason?: string;
}

export type VcMeetingActionAuthorizationDenial =
  | 'listener_session_inactive'
  | 'meeting_phase_closed'
  | 'capability_denied'
  | 'not_sink_owner'
  | 'output_policy_denied';

export type VcMeetingActionAuthorizationDecision =
  | { kind: 'allow' }
  | { kind: 'approval' }
  | { kind: 'deny'; reason: VcMeetingActionAuthorizationDenial; detail?: string };

export interface VcMeetingActionAuthorizationContext {
  request: Readonly<VcMeetingManagedActionRequest>;
  projection: Readonly<VcMeetingMemberProjectionRecord>;
  receipt: Readonly<VcMeetingDeliveryReceiptRecord>;
  action: Readonly<VcMeetingActionRecord>;
  sink: 'meeting_text' | 'meeting_voice';
}

export interface VcMeetingActionGateDeps {
  dataDir: string;
  /** App id of the consumer daemon handling this trusted receiver request. */
  selfAgentAppId: string;
  /**
   * Hub/runtime policy hook. It must verify the listener session/phase, the
   * selected sink owner + capability, and return the current output policy.
   */
  authorize: (
    context: VcMeetingActionAuthorizationContext,
  ) => VcMeetingActionAuthorizationDecision | Promise<VcMeetingActionAuthorizationDecision>;
}

/**
 * Daemon-derived identity for an explicit user IM turn routed into a meeting
 * receiver session. None of these fields may be accepted from model output.
 * The owner/member snapshots are intentionally carried with the turn so a
 * delayed action cannot silently inherit a newer authority generation.
 */
export interface VcMeetingTrustedImTurnOrigin {
  listenerAppId: string;
  meetingId: string;
  memberId: string;
  memberEpoch: number;
  agentAppId: string;
  ownerBootId: string;
  ownerEpoch: number;
  membershipGeneration: number;
  sinkOwnerGeneration: number;
  receiverSessionId: string;
  larkMessageId: string;
}

/**
 * A provider-neutral managed action originating from an explicit Lark IM
 * message. `canonicalInput` is the normalized provider payload (for example a
 * task ledger or `{ content }` for meeting text); transport metadata and
 * human-facing `reason` do not belong in it.
 */
export interface VcMeetingManagedImActionRequest {
  origin: VcMeetingTrustedImTurnOrigin;
  sink: VcMeetingActionSink;
  canonicalInput: Record<string, unknown>;
  reason?: string;
}

export interface VcMeetingImActionAuthorizationContext {
  request: Readonly<VcMeetingManagedImActionRequest>;
  projection: Readonly<VcMeetingMemberProjectionRecord>;
  action: Readonly<VcMeetingActionRecord>;
  sink: VcMeetingActionSink;
}

export interface VcMeetingImActionGateDeps {
  dataDir: string;
  /** App id of the consumer daemon that authoritatively routed the IM turn. */
  selfAgentAppId: string;
  authorize: (
    context: VcMeetingImActionAuthorizationContext,
  ) => VcMeetingActionAuthorizationDecision | Promise<VcMeetingActionAuthorizationDecision>;
}

export interface VcMeetingApprovalRevalidationContext {
  projection: Readonly<VcMeetingMemberProjectionRecord>;
  action: Readonly<VcMeetingActionRecord>;
  sink: VcMeetingActionSink;
}

export interface VcMeetingApprovalResolutionOptions {
  externalRefs?: Record<string, unknown>;
  errorCode?: string;
  /** Re-check live listener phase/session and sink policy immediately before
   * an approved action is write-ahead claimed. Structural membership and
   * owner fences are enforced by this module before this hook runs. */
  revalidate?: (
    context: VcMeetingApprovalRevalidationContext,
  ) => VcMeetingActionAuthorizationDecision | Promise<VcMeetingActionAuthorizationDecision>;
}

export interface VcMeetingGenericProviderExecutionPlan {
  actionId: string;
  inputHash: string;
  providerKey: string;
  sink: VcMeetingActionSink;
  canonicalInput: Record<string, unknown>;
  ambiguousRecovery: 'lookup_or_idempotent_retry' | 'manual_unknown';
}

export interface VcMeetingGenericApprovalPresentationPlan {
  actionId: string;
  inputHash: string;
  providerKey: string;
  sink: VcMeetingActionSink;
  canonicalInput: Record<string, unknown>;
  reason?: string;
}

export type VcMeetingImActionGateSuccessBody =
  | { ok: true; kind: 'existing'; action: VcMeetingActionRecord }
  | {
      ok: true;
      kind: 'execute';
      action: VcMeetingActionRecord;
      plan: VcMeetingGenericProviderExecutionPlan;
    }
  | {
      ok: true;
      kind: 'needsApproval';
      action: VcMeetingActionRecord;
      plan: VcMeetingGenericApprovalPresentationPlan;
    };

export type VcMeetingImActionGateResult =
  | { status: 200 | 202; body: VcMeetingImActionGateSuccessBody }
  | { status: 400 | 403 | 404 | 409 | 500 | 503; body: VcMeetingActionGateErrorBody };

export interface VcMeetingProviderExecutionPlan {
  actionId: string;
  inputHash: string;
  providerKey: string;
  channel: VcMeetingManagedActionChannel;
  sink: 'meeting_text' | 'meeting_voice';
  content: string;
  fallbackText?: string;
  /** Text may use its provider key for lookup/idempotent retry. Voice may not. */
  ambiguousRecovery: 'lookup_or_idempotent_retry' | 'manual_unknown';
}

export interface VcMeetingApprovalPresentationPlan {
  actionId: string;
  inputHash: string;
  providerKey: string;
  channel: VcMeetingManagedActionChannel;
  content: string;
  fallbackText?: string;
  reason?: string;
}

export type VcMeetingActionGateSuccessBody =
  | { ok: true; kind: 'existing'; action: VcMeetingActionRecord }
  | { ok: true; kind: 'execute'; action: VcMeetingActionRecord; plan: VcMeetingProviderExecutionPlan }
  | {
      ok: true;
      kind: 'needsApproval';
      action: VcMeetingActionRecord;
      plan: VcMeetingApprovalPresentationPlan;
    };

export interface VcMeetingActionGateErrorBody {
  ok: false;
  kind: 'rejected';
  errorCode: string;
  error: string;
  action?: VcMeetingActionRecord;
}

type VcMeetingActionGateErrorResult = {
  status: 400 | 403 | 404 | 409 | 500 | 503;
  body: VcMeetingActionGateErrorBody;
};

export type VcMeetingActionGateResult =
  | { status: 200 | 202; body: VcMeetingActionGateSuccessBody }
  | VcMeetingActionGateErrorResult;

function errorResult(
  status: 400 | 403 | 404 | 409 | 500 | 503,
  errorCode: string,
  error: string,
  action?: VcMeetingActionRecord,
): VcMeetingActionGateErrorResult {
  return {
    status,
    body: { ok: false, kind: 'rejected', errorCode, error, ...(action ? { action } : {}) },
  };
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

/**
 * Stable IM source key. The canonical tuple avoids delimiter ambiguity and the
 * 50-character namespace matches the bounded ids used by the action ledger.
 */
export function deriveVcMeetingImTurnSourceKey(
  receiverSessionId: string,
  larkMessageId: string,
): string {
  const normalizedSessionId = normalizeText(receiverSessionId);
  const normalizedMessageId = normalizeText(larkMessageId);
  if (!normalizedSessionId || !normalizedMessageId) {
    throw new Error('receiverSessionId and larkMessageId must be non-empty');
  }
  const seed = canonicalJson({
    receiverSessionId: normalizedSessionId,
    larkMessageId: normalizedMessageId,
  });
  const hex = createHash('sha256').update(seed, 'utf8').digest('hex');
  return `vci_${hex.slice(0, 46)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeImActionRequest(raw: VcMeetingManagedImActionRequest):
  | { ok: true; request: VcMeetingManagedImActionRequest }
  | { ok: false; result: VcMeetingActionGateErrorResult } {
  if (!raw || typeof raw !== 'object' || !raw.origin || typeof raw.origin !== 'object') {
    return { ok: false, result: errorResult(400, 'invalid_request', 'IM action request and trusted origin are required') };
  }
  const listenerAppId = normalizeText(raw.origin.listenerAppId);
  const meetingId = normalizeText(raw.origin.meetingId);
  const memberId = normalizeText(raw.origin.memberId);
  const agentAppId = normalizeText(raw.origin.agentAppId);
  const ownerBootId = normalizeText(raw.origin.ownerBootId);
  const receiverSessionId = normalizeText(raw.origin.receiverSessionId);
  const larkMessageId = normalizeText(raw.origin.larkMessageId);
  const reason = normalizeText(raw.reason);
  if (!listenerAppId || !meetingId || !memberId || !agentAppId || !ownerBootId
    || !receiverSessionId || !larkMessageId
    || !isPositiveSafeInteger(raw.origin.ownerEpoch)
    || !isPositiveSafeInteger(raw.origin.memberEpoch)
    || !isPositiveSafeInteger(raw.origin.membershipGeneration)
    || !isPositiveSafeInteger(raw.origin.sinkOwnerGeneration)) {
    return { ok: false, result: errorResult(400, 'invalid_request', 'trusted IM action origin is invalid') };
  }
  if (!(VC_MEETING_ACTION_SINKS as readonly unknown[]).includes(raw.sink)) {
    return { ok: false, result: errorResult(400, 'unsupported_sink', 'managed action sink is unsupported') };
  }
  if (reason && reason.length > MAX_OUTPUT_CHARS) {
    return { ok: false, result: errorResult(400, 'content_too_long', `reason must be at most ${MAX_OUTPUT_CHARS} characters`) };
  }
  if (!isPlainObject(raw.canonicalInput)) {
    return { ok: false, result: errorResult(400, 'invalid_canonical_input', 'canonicalInput must be a plain object') };
  }
  let canonicalInput: Record<string, unknown>;
  try {
    canonicalInput = JSON.parse(canonicalJson(raw.canonicalInput)) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      result: errorResult(
        400,
        'invalid_canonical_input',
        err instanceof Error ? err.message : String(err),
      ),
    };
  }
  return {
    ok: true,
    request: {
      origin: {
        listenerAppId,
        meetingId,
        memberId,
        memberEpoch: raw.origin.memberEpoch,
        agentAppId,
        ownerBootId,
        ownerEpoch: raw.origin.ownerEpoch,
        membershipGeneration: raw.origin.membershipGeneration,
        sinkOwnerGeneration: raw.origin.sinkOwnerGeneration,
        receiverSessionId,
        larkMessageId,
      },
      sink: raw.sink,
      canonicalInput,
      ...(reason ? { reason } : {}),
    },
  };
}

function normalizeRequest(raw: VcMeetingManagedActionRequest):
  | { ok: true; request: VcMeetingManagedActionRequest }
  | { ok: false; result: VcMeetingActionGateResult } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, result: errorResult(400, 'invalid_request', 'action request must be an object') };
  }
  const agentAppId = normalizeText(raw.agentAppId);
  const receiverSessionId = normalizeText(raw.receiverSessionId);
  const stableTurnId = normalizeText(raw.stableTurnId);
  const content = normalizeText(raw.content);
  const fallbackText = normalizeText(raw.fallbackText);
  const reason = normalizeText(raw.reason);
  if (!agentAppId || !receiverSessionId || !stableTurnId || !content
    || !Number.isInteger(raw.dispatchAttempt) || raw.dispatchAttempt < 1) {
    return { ok: false, result: errorResult(400, 'invalid_request', 'trusted action origin or content is invalid') };
  }
  if (raw.channel !== 'text' && raw.channel !== 'voice') {
    return { ok: false, result: errorResult(400, 'unsupported_channel', 'channel must be text or voice') };
  }
  if (content.length > MAX_OUTPUT_CHARS
    || (fallbackText?.length ?? 0) > MAX_OUTPUT_CHARS
    || (reason?.length ?? 0) > MAX_OUTPUT_CHARS) {
    return { ok: false, result: errorResult(400, 'content_too_long', `content fields must be at most ${MAX_OUTPUT_CHARS} characters`) };
  }
  if (raw.channel === 'text' && fallbackText) {
    return { ok: false, result: errorResult(400, 'fallback_not_allowed', 'fallbackText only applies to voice output') };
  }
  return {
    ok: true,
    request: {
      agentAppId,
      receiverSessionId,
      stableTurnId,
      dispatchAttempt: raw.dispatchAttempt,
      channel: raw.channel,
      content,
      ...(fallbackText ? { fallbackText } : {}),
      ...(reason ? { reason } : {}),
    },
  };
}

function actionRef(record: VcMeetingActionRecord): VcMeetingActionRef {
  return {
    listenerAppId: record.listenerAppId,
    meetingId: record.meetingId,
    actionId: record.actionId,
    inputHash: record.inputHash,
  };
}

function executionPlan(record: VcMeetingActionRecord): VcMeetingProviderExecutionPlan {
  const input = record.canonicalInput as { content: string; fallbackText?: string };
  const channel = record.sink === 'meeting_voice' ? 'voice' : 'text';
  return {
    actionId: record.actionId,
    inputHash: record.inputHash,
    providerKey: record.providerKey,
    channel,
    sink: record.sink as 'meeting_text' | 'meeting_voice',
    content: input.content,
    ...(input.fallbackText ? { fallbackText: input.fallbackText } : {}),
    ambiguousRecovery: channel === 'voice' ? 'manual_unknown' : 'lookup_or_idempotent_retry',
  };
}

function genericExecutionPlan(record: VcMeetingActionRecord): VcMeetingGenericProviderExecutionPlan {
  return {
    actionId: record.actionId,
    inputHash: record.inputHash,
    providerKey: record.providerKey,
    sink: record.sink,
    canonicalInput: structuredClone(record.canonicalInput) as Record<string, unknown>,
    ambiguousRecovery: record.sink === 'meeting_voice'
      ? 'manual_unknown'
      : 'lookup_or_idempotent_retry',
  };
}

function existingResult(record: VcMeetingActionRecord): VcMeetingActionGateResult {
  return { status: 200, body: { ok: true, kind: 'existing', action: record } };
}

function imExistingResult(record: VcMeetingActionRecord): VcMeetingImActionGateResult {
  return { status: 200, body: { ok: true, kind: 'existing', action: record } };
}

function rejectStatus(reason: VcMeetingActionAuthorizationDenial): 403 | 409 {
  return reason === 'listener_session_inactive' || reason === 'meeting_phase_closed' ? 409 : 403;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function rejectNewAction(
  deps: { dataDir: string },
  record: VcMeetingActionRecord,
  status: 403 | 409,
  errorCode: string,
  error: string,
  now: number,
): VcMeetingActionGateErrorResult {
  const rejected = rejectVcMeetingAction(deps.dataDir, actionRef(record), { errorCode }, now);
  if (rejected.kind === 'conflict') {
    return errorResult(500, 'action_reject_transition_failed', `could not durably reject action: ${rejected.reason}`, record);
  }
  return errorResult(status, errorCode, error, rejected.record);
}

function currentProjection(
  dataDir: string,
  historical: VcMeetingMemberProjectionRecord,
): { projection?: VcMeetingMemberProjectionRecord; maxEpoch: number } {
  const projections = listVcMeetingMemberProjections(dataDir, {
    listenerAppId: historical.listenerAppId,
    meetingId: historical.meetingId,
  }).filter((candidate) => candidate.memberId === historical.memberId);
  return {
    projection: projections.find((candidate) => candidate.memberEpoch === historical.memberEpoch),
    maxEpoch: Math.max(0, ...projections.map((candidate) => candidate.memberEpoch)),
  };
}

/**
 * Resolve, fence, authorize and write-ahead claim one managed meeting action.
 * Existing non-requested records are returned before current membership
 * fencing; this is what makes terminal/approval/provider replay deterministic
 * across epoch or owner changes.
 */
export async function requestVcMeetingManagedAction(
  raw: VcMeetingManagedActionRequest,
  deps: VcMeetingActionGateDeps,
  now = Date.now(),
): Promise<VcMeetingActionGateResult> {
  const normalized = normalizeRequest(raw);
  if (!normalized.ok) return normalized.result;
  const request = normalized.request;
  if (request.agentAppId !== deps.selfAgentAppId) {
    return errorResult(409, 'wrong_agent', 'trusted action origin does not match this consumer daemon');
  }

  // Session binding is part of trusted-origin validation and always precedes
  // ledger lookup/replay. A sibling daemon sharing dataDir may not disclose an
  // action merely because it knows a delivery key.
  const lookup = findVcMeetingDeliveryByKey(deps.dataDir, request.stableTurnId);
  if (!lookup) return errorResult(404, 'receipt_not_found', 'delivery receipt was not found');
  if (lookup.receiverSessionId !== request.receiverSessionId) {
    return errorResult(409, 'receiver_session_mismatch', 'delivery is bound to a different receiver session');
  }
  const historicalProjection = getVcMeetingMemberProjection(deps.dataDir, lookup.memberKey);
  if (!historicalProjection) {
    return errorResult(409, 'projection_not_found', 'delivery membership projection was not found');
  }
  if (historicalProjection.agentAppId !== deps.selfAgentAppId) {
    return errorResult(409, 'wrong_agent', 'delivery receipt belongs to another consumer agent');
  }
  if (historicalProjection.receiverSessionId !== request.receiverSessionId) {
    return errorResult(409, 'receiver_session_changed', 'membership receiver session no longer matches the delivery');
  }
  const sink = request.channel === 'voice' ? 'meeting_voice' : 'meeting_text';
  const canonicalInput = {
    content: request.content,
    ...(request.channel === 'voice' && request.fallbackText
      ? { fallbackText: request.fallbackText }
      : {}),
  };
  const source = {
    kind: 'delivery',
    key: lookup.receipt.deliveryKey,
    deliverySeq: lookup.receipt.toSeq,
  } as const;

  // Read an already-established lifecycle before *current* receipt/member
  // fencing. This preserves deterministic terminal/pending/attempting replay,
  // while a stale attempt that is first to arrive still cannot create and
  // poison the primary action identity.
  const proposedActionId = deriveVcMeetingActionId({
    meetingId: lookup.memberKey.meetingId,
    memberId: lookup.memberKey.memberId,
    memberEpoch: lookup.memberKey.memberEpoch,
    source,
    sink,
    actionSlot: 'primary',
  });
  const proposedInputHash = computeInputHash(canonicalInput);
  const existing = findVcMeetingAction(deps.dataDir, {
    listenerAppId: lookup.memberKey.listenerAppId,
    meetingId: lookup.memberKey.meetingId,
  }, proposedActionId);
  if (existing) {
    if (existing.inputHash !== proposedInputHash) {
      return errorResult(
        409,
        'action_input_mismatch',
        'this delivery already has an action for the sink; treat it as handled and do not change content or slot',
        existing,
      );
    }
    if (existing.agentAppId !== deps.selfAgentAppId) {
      return errorResult(409, 'wrong_agent', 'existing action belongs to another consumer agent');
    }
    if (existing.status !== 'requested') return existingResult(existing);
  }

  // An origin that has not yet established an action must be the exact live
  // dispatched attempt. In particular, attempt N may not create a terminal
  // rejected action after attempt N+1 has taken over the same stable turn.
  if (lookup.receipt.stableTurnId !== request.stableTurnId) {
    return errorResult(409, 'source_turn_mismatch', 'stable turn does not match the delivery receipt');
  }
  if (lookup.receipt.status !== 'dispatched') {
    return errorResult(409, 'delivery_not_dispatched', `delivery is ${lookup.receipt.status}, not dispatched`);
  }
  if (lookup.receipt.dispatchAttempt !== request.dispatchAttempt) {
    return errorResult(409, 'stale_dispatch_attempt', 'action origin does not match the live delivery attempt');
  }

  let record = existing;
  let begunKind: 'created' | 'existing' = existing ? 'existing' : 'created';
  if (!record) {
    // This is the authorization snapshot carried by the source turn. Reading
    // the mutable projection here would let a delivery accepted under owner
    // generation N execute for the first time after ownership churned to N+2.
    if (!isPositiveSafeInteger(lookup.receipt.sinkOwnerGeneration)) {
      return errorResult(
        409,
        'receipt_policy_snapshot_missing',
        'delivery receipt has no valid sink owner generation snapshot',
      );
    }
    const begun = beginVcMeetingAction(deps.dataDir, {
      listenerAppId: lookup.memberKey.listenerAppId,
      meetingId: lookup.memberKey.meetingId,
      memberId: lookup.memberKey.memberId,
      memberEpoch: lookup.memberKey.memberEpoch,
      agentAppId: deps.selfAgentAppId,
      ownerGeneration: lookup.receipt.sinkOwnerGeneration,
      source,
      sink,
      actionSlot: 'primary',
      canonicalInput,
    }, now);
    if (begun.kind === 'conflict') {
      if (begun.reason === 'input_mismatch') {
        return errorResult(
          409,
          'action_input_mismatch',
          'this delivery already has an action for the sink; treat it as handled and do not change content or slot',
          begun.record,
        );
      }
      return errorResult(400, `action_${begun.reason}`, begun.detail ?? 'action intent is invalid', begun.record);
    }
    record = begun.record;
    begunKind = begun.kind;
  }
  if (record.agentAppId !== deps.selfAgentAppId) {
    return errorResult(409, 'wrong_agent', 'existing action belongs to another consumer agent');
  }
  // A requested record may be the crash residue between begin and policy. It
  // is safe to resume because all subsequent claims are store-atomic. Every
  // other status is an observable existing lifecycle result and is replayed
  // before current fencing.
  if (begunKind === 'existing' && record.status !== 'requested') return existingResult(record);

  const recordBeforeFencing = record;
  const rejectFencing = (
    code: string,
    message: string,
  ): VcMeetingActionGateResult => rejectNewAction(
    deps,
    recordBeforeFencing,
    409,
    code,
    message,
    now,
  );

  const current = currentProjection(deps.dataDir, historicalProjection);
  if (current.maxEpoch !== lookup.memberKey.memberEpoch) {
    return rejectFencing('stale_member_epoch', 'delivery member epoch is no longer current');
  }
  if (!current.projection) {
    return rejectFencing('projection_not_found', 'current membership projection was not found');
  }
  if (current.projection.status !== 'active') {
    return rejectFencing(`membership_${current.projection.status}`, `membership is ${current.projection.status}`);
  }
  if (current.projection.receiverSessionId !== request.receiverSessionId) {
    return rejectFencing('receiver_session_changed', 'current membership uses a different receiver session');
  }
  if (current.projection.agentAppId !== deps.selfAgentAppId) {
    return rejectFencing('wrong_agent', 'current membership belongs to another consumer agent');
  }
  if (!isPositiveSafeInteger(current.projection.sinkOwnerGeneration)) {
    return rejectFencing('projection_policy_invalid', 'current membership has no valid sink owner generation');
  }
  if (record.ownerGeneration !== current.projection.sinkOwnerGeneration) {
    return rejectFencing('stale_owner_generation', 'action authorization snapshot is no longer current');
  }

  let authorization: VcMeetingActionAuthorizationDecision;
  try {
    authorization = await deps.authorize({
      request,
      projection: current.projection,
      receipt: lookup.receipt,
      action: record,
      sink,
    });
  } catch (err) {
    return errorResult(
      503,
      'authorization_unavailable',
      err instanceof Error ? err.message : String(err),
      record,
    );
  }
  if (!authorization || !['allow', 'approval', 'deny'].includes(authorization.kind)) {
    return errorResult(503, 'authorization_invalid_result', 'authorization callback returned an invalid decision', record);
  }
  if (authorization.kind === 'deny') {
    const allowedReasons: ReadonlySet<string> = new Set([
      'listener_session_inactive',
      'meeting_phase_closed',
      'capability_denied',
      'not_sink_owner',
      'output_policy_denied',
    ] satisfies VcMeetingActionAuthorizationDenial[]);
    if (!allowedReasons.has(authorization.reason)) {
      return errorResult(503, 'authorization_invalid_result', 'authorization denial reason is invalid', record);
    }
    return rejectNewAction(
      deps,
      record,
      rejectStatus(authorization.reason),
      authorization.reason,
      authorization.detail ?? `managed meeting action denied: ${authorization.reason}`,
      now,
    );
  }

  if (authorization.kind === 'approval') {
    const pending = markVcMeetingActionPendingApproval(deps.dataDir, actionRef(record), now);
    if (pending.kind === 'conflict') {
      return errorResult(500, 'approval_transition_failed', `could not persist approval state: ${pending.reason}`, record);
    }
    record = pending.record;
    const claimed = claimVcMeetingApprovalCardAttempt(deps.dataDir, actionRef(record), now);
    if (claimed.kind === 'existing') return existingResult(claimed.record);
    if (claimed.kind === 'conflict') {
      return errorResult(500, 'approval_claim_failed', `could not claim approval presentation: ${claimed.reason}`, record);
    }
    record = claimed.record;
    return {
      status: 202,
      body: {
        ok: true,
        kind: 'needsApproval',
        action: record,
        plan: {
          actionId: record.actionId,
          inputHash: record.inputHash,
          providerKey: record.approvalCard!.providerKey,
          channel: request.channel,
          content: request.content,
          ...(request.fallbackText ? { fallbackText: request.fallbackText } : {}),
          ...(request.reason ? { reason: request.reason } : {}),
        },
      },
    };
  }

  const claimed = claimVcMeetingActionAttempt(deps.dataDir, actionRef(record), now);
  if (claimed.kind === 'existing') return existingResult(claimed.record);
  if (claimed.kind === 'conflict') {
    return errorResult(500, 'provider_claim_failed', `could not claim provider execution: ${claimed.reason}`, record);
  }
  record = claimed.record;
  return {
    status: 202,
    body: { ok: true, kind: 'execute', action: record, plan: executionPlan(record) },
  };
}

/**
 * Resolve and execute a managed action from an explicit user IM turn.
 *
 * Unlike delivery-origin actions this path has no delivery receipt or
 * dispatchAttempt: the durable identity is the authoritative membership
 * projection plus `hash(receiverSessionId, larkMessageId)`. The receiver
 * binding is checked before ledger lookup so a different session cannot use a
 * guessed message id to inspect an action. Exact action replays still return
 * their established lifecycle before current owner/member fencing, matching
 * delivery-origin replay semantics.
 */
export async function requestVcMeetingManagedImAction(
  raw: VcMeetingManagedImActionRequest,
  deps: VcMeetingImActionGateDeps,
  now = Date.now(),
): Promise<VcMeetingImActionGateResult> {
  const normalized = normalizeImActionRequest(raw);
  if (!normalized.ok) return normalized.result;
  const request = normalized.request;
  const { origin } = request;

  if (origin.agentAppId !== deps.selfAgentAppId) {
    return errorResult(409, 'wrong_agent', 'trusted IM action origin does not match this consumer daemon');
  }

  const memberKey = {
    listenerAppId: origin.listenerAppId,
    meetingId: origin.meetingId,
    memberId: origin.memberId,
    memberEpoch: origin.memberEpoch,
  };
  const historicalProjection = getVcMeetingMemberProjection(deps.dataDir, memberKey);
  if (!historicalProjection) {
    return errorResult(404, 'projection_not_found', 'IM turn membership projection was not found');
  }
  // Receiver and agent binding are authentication checks, not mutable policy
  // fences, so they intentionally precede action replay.
  if (historicalProjection.receiverSessionId !== origin.receiverSessionId) {
    return errorResult(409, 'receiver_session_mismatch', 'IM turn is bound to a different receiver session');
  }
  if (historicalProjection.agentAppId !== origin.agentAppId
    || historicalProjection.agentAppId !== deps.selfAgentAppId) {
    return errorResult(409, 'wrong_agent', 'IM turn membership belongs to another consumer agent');
  }

  const sourceKey = deriveVcMeetingImTurnSourceKey(
    origin.receiverSessionId,
    origin.larkMessageId,
  );
  const actionIdentity = {
    listenerAppId: origin.listenerAppId,
    meetingId: origin.meetingId,
    memberId: origin.memberId,
    memberEpoch: origin.memberEpoch,
    agentAppId: origin.agentAppId,
    ownerGeneration: origin.sinkOwnerGeneration,
    source: {
      kind: 'im_turn',
      key: sourceKey,
      larkMessageId: origin.larkMessageId,
    },
    sink: request.sink,
    actionSlot: 'primary',
    canonicalInput: request.canonicalInput,
  } as const;

  const proposedActionId = deriveVcMeetingActionId(actionIdentity);
  const proposedInputHash = computeInputHash(request.canonicalInput);
  const existing = findVcMeetingAction(deps.dataDir, {
    listenerAppId: origin.listenerAppId,
    meetingId: origin.meetingId,
  }, proposedActionId);
  if (existing) {
    if (existing.inputHash !== proposedInputHash) {
      return errorResult(
        409,
        'action_input_mismatch',
        'this IM message already has an action for the sink; treat it as handled and do not change content or slot',
        existing,
      );
    }
    if (existing.agentAppId !== deps.selfAgentAppId) {
      return errorResult(409, 'wrong_agent', 'existing action belongs to another consumer agent');
    }
    if (existing.status !== 'requested') return imExistingResult(existing);
  }

  const begun = beginVcMeetingAction(deps.dataDir, actionIdentity, now);
  if (begun.kind === 'conflict') {
    if (begun.reason === 'input_mismatch') {
      return errorResult(
        409,
        'action_input_mismatch',
        'this IM message already has an action for the sink; treat it as handled and do not change content or slot',
        begun.record,
      );
    }
    return errorResult(400, `action_${begun.reason}`, begun.detail ?? 'action intent is invalid', begun.record);
  }

  let record = begun.record;
  if (record.agentAppId !== deps.selfAgentAppId) {
    return errorResult(409, 'wrong_agent', 'existing action belongs to another consumer agent');
  }
  if (begun.kind === 'existing' && record.status !== 'requested') return imExistingResult(record);

  const rejectFencing = (
    code: string,
    message: string,
  ): VcMeetingActionGateErrorResult => rejectNewAction(deps, record, 409, code, message, now);

  const current = currentProjection(deps.dataDir, historicalProjection);
  if (current.maxEpoch !== origin.memberEpoch) {
    return rejectFencing('stale_member_epoch', 'IM turn member epoch is no longer current');
  }
  if (!current.projection) {
    return rejectFencing('projection_not_found', 'current membership projection was not found');
  }
  if (current.projection.status !== 'active') {
    return rejectFencing(`membership_${current.projection.status}`, `membership is ${current.projection.status}`);
  }
  if (current.projection.receiverSessionId !== origin.receiverSessionId) {
    return rejectFencing('receiver_session_changed', 'current membership uses a different receiver session');
  }
  if (current.projection.agentAppId !== deps.selfAgentAppId) {
    return rejectFencing('wrong_agent', 'current membership belongs to another consumer agent');
  }
  if (current.projection.ownerEpoch !== origin.ownerEpoch) {
    return rejectFencing('stale_owner_epoch', 'IM turn meeting owner epoch is no longer current');
  }
  if (current.projection.ownerBootId !== origin.ownerBootId) {
    return rejectFencing('stale_owner_boot', 'IM turn meeting owner boot is no longer current');
  }
  if (!isPositiveSafeInteger(current.projection.sinkOwnerGeneration)) {
    return rejectFencing('projection_policy_invalid', 'current membership has no valid sink owner generation');
  }
  if (record.ownerGeneration !== current.projection.sinkOwnerGeneration) {
    return rejectFencing('stale_owner_generation', 'action authorization snapshot is no longer current');
  }

  let authorization: VcMeetingActionAuthorizationDecision;
  try {
    authorization = await deps.authorize({
      request,
      projection: current.projection,
      action: record,
      sink: request.sink,
    });
  } catch (err) {
    return errorResult(
      503,
      'authorization_unavailable',
      err instanceof Error ? err.message : String(err),
      record,
    );
  }
  if (!authorization || !['allow', 'approval', 'deny'].includes(authorization.kind)) {
    return errorResult(503, 'authorization_invalid_result', 'authorization callback returned an invalid decision', record);
  }
  if (authorization.kind === 'deny') {
    const allowedReasons: ReadonlySet<string> = new Set([
      'listener_session_inactive',
      'meeting_phase_closed',
      'capability_denied',
      'not_sink_owner',
      'output_policy_denied',
    ] satisfies VcMeetingActionAuthorizationDenial[]);
    if (!allowedReasons.has(authorization.reason)) {
      return errorResult(503, 'authorization_invalid_result', 'authorization denial reason is invalid', record);
    }
    return rejectNewAction(
      deps,
      record,
      rejectStatus(authorization.reason),
      authorization.reason,
      authorization.detail ?? `managed meeting action denied: ${authorization.reason}`,
      now,
    );
  }

  if (authorization.kind === 'approval') {
    const pending = markVcMeetingActionPendingApproval(deps.dataDir, actionRef(record), now);
    if (pending.kind === 'conflict') {
      return errorResult(500, 'approval_transition_failed', `could not persist approval state: ${pending.reason}`, record);
    }
    record = pending.record;
    const claimed = claimVcMeetingApprovalCardAttempt(deps.dataDir, actionRef(record), now);
    if (claimed.kind === 'existing') return imExistingResult(claimed.record);
    if (claimed.kind === 'conflict') {
      return errorResult(500, 'approval_claim_failed', `could not claim approval presentation: ${claimed.reason}`, record);
    }
    record = claimed.record;
    return {
      status: 202,
      body: {
        ok: true,
        kind: 'needsApproval',
        action: record,
        plan: {
          actionId: record.actionId,
          inputHash: record.inputHash,
          providerKey: record.approvalCard!.providerKey,
          sink: record.sink,
          canonicalInput: structuredClone(record.canonicalInput) as Record<string, unknown>,
          ...(request.reason ? { reason: request.reason } : {}),
        },
      },
    };
  }

  const claimed = claimVcMeetingActionAttempt(deps.dataDir, actionRef(record), now);
  if (claimed.kind === 'existing') return imExistingResult(claimed.record);
  if (claimed.kind === 'conflict') {
    return errorResult(500, 'provider_claim_failed', `could not claim provider execution: ${claimed.reason}`, record);
  }
  record = claimed.record;
  return {
    status: 202,
    body: { ok: true, kind: 'execute', action: record, plan: genericExecutionPlan(record) },
  };
}

export interface VcMeetingActionFinishInput extends VcMeetingActionRef {
  status: 'succeeded' | 'failed' | 'unknown';
  externalRefs?: Record<string, unknown>;
  errorCode?: string;
}

/** Persist the provider terminal result after executing an `execute` plan. */
export function finishVcMeetingManagedActionProvider(
  dataDir: string,
  input: VcMeetingActionFinishInput,
  now = Date.now(),
): VcMeetingActionTransitionResult {
  const { status, externalRefs, errorCode, ...ref } = input;
  return finishVcMeetingAction(dataDir, ref, {
    status,
    ...(externalRefs ? { externalRefs } : {}),
    ...(errorCode ? { errorCode } : {}),
  }, now);
}

export interface VcMeetingApprovalCardFinishInput extends VcMeetingActionRef {
  status: 'presented' | 'failed' | 'unknown';
  externalRefs?: Record<string, unknown>;
  errorCode?: string;
}

/** Persist the approval-card provider result after a `needsApproval` plan. */
export function finishVcMeetingManagedApprovalCard(
  dataDir: string,
  input: VcMeetingApprovalCardFinishInput,
  now = Date.now(),
): VcMeetingActionTransitionResult {
  const { status, externalRefs, errorCode, ...ref } = input;
  return finishVcMeetingApprovalCard(dataDir, ref, {
    status,
    ...(externalRefs ? { externalRefs } : {}),
    ...(errorCode ? { errorCode } : {}),
  }, now);
}

export type VcMeetingApprovalResolutionResult =
  | { kind: 'execute'; action: VcMeetingActionRecord; plan: VcMeetingProviderExecutionPlan }
  | { kind: 'resolved' | 'existing'; action: VcMeetingActionRecord }
  | { kind: 'conflict'; reason: string; action?: VcMeetingActionRecord };

function approvalResolutionFromTransition(
  result: VcMeetingActionTransitionResult,
): VcMeetingApprovalResolutionResult {
  if (result.kind === 'conflict') {
    return {
      kind: 'conflict',
      reason: result.reason,
      ...(result.record ? { action: result.record } : {}),
    };
  }
  return {
    kind: result.kind === 'existing' ? 'existing' : 'resolved',
    action: result.record,
  };
}

function expireApprovalAfterFenceFailure(
  dataDir: string,
  ref: VcMeetingActionRef,
  opts: VcMeetingApprovalResolutionOptions,
  errorCode: string,
  now: number,
): VcMeetingApprovalResolutionResult {
  return approvalResolutionFromTransition(resolveVcMeetingActionApproval(
    dataDir,
    ref,
    'expired',
    {
      ...(opts.externalRefs ? { externalRefs: opts.externalRefs } : {}),
      errorCode,
    },
    now,
  ));
}

type ApprovalStructuralFenceResult =
  | { ok: true; projection: VcMeetingMemberProjectionRecord }
  | { ok: false; errorCode: string };

function validateApprovalStructuralFence(
  dataDir: string,
  action: VcMeetingActionRecord,
): ApprovalStructuralFenceResult {
  const historicalProjection = getVcMeetingMemberProjection(dataDir, {
    listenerAppId: action.listenerAppId,
    meetingId: action.meetingId,
    memberId: action.memberId,
    memberEpoch: action.memberEpoch,
  });
  if (!historicalProjection) return { ok: false, errorCode: 'projection_not_found' };
  const current = currentProjection(dataDir, historicalProjection);
  if (current.maxEpoch !== action.memberEpoch) {
    return { ok: false, errorCode: 'stale_member_epoch' };
  }
  if (!current.projection) return { ok: false, errorCode: 'projection_not_found' };
  if (current.projection.status !== 'active') {
    return { ok: false, errorCode: `membership_${current.projection.status}` };
  }
  if (current.projection.agentAppId !== action.agentAppId) {
    return { ok: false, errorCode: 'wrong_agent' };
  }
  if (!isPositiveSafeInteger(current.projection.sinkOwnerGeneration)) {
    return { ok: false, errorCode: 'projection_policy_invalid' };
  }
  if (current.projection.sinkOwnerGeneration !== action.ownerGeneration) {
    return { ok: false, errorCode: 'stale_owner_generation' };
  }
  return { ok: true, projection: current.projection };
}

/**
 * Apply a human approval decision. Approval write and provider claim are both
 * durable before an execution plan is returned.
 */
export async function resolveVcMeetingManagedActionApproval(
  dataDir: string,
  ref: VcMeetingActionRef,
  decision: 'approved' | 'rejected' | 'expired',
  opts: VcMeetingApprovalResolutionOptions = {},
  now = Date.now(),
): Promise<VcMeetingApprovalResolutionResult> {
  if (decision === 'approved') {
    const action = findVcMeetingAction(dataDir, {
      listenerAppId: ref.listenerAppId,
      meetingId: ref.meetingId,
    }, ref.actionId);
    if (!action) return { kind: 'conflict', reason: 'not_found' };
    if (action.inputHash !== ref.inputHash) {
      return { kind: 'conflict', reason: 'input_mismatch', action };
    }
    // Replays after the write-ahead claim or a terminal result disclose the
    // established lifecycle without consulting mutable current authority.
    if (action.status === 'attempting' || isVcMeetingActionTerminal(action.status)) {
      return { kind: 'existing', action };
    }
    if (action.status !== 'pendingApproval' && action.status !== 'approved') {
      return { kind: 'conflict', reason: 'invalid_transition', action };
    }

    const beforeAuthorization = validateApprovalStructuralFence(dataDir, action);
    if (!beforeAuthorization.ok) {
      return expireApprovalAfterFenceFailure(
        dataDir,
        ref,
        opts,
        beforeAuthorization.errorCode,
        now,
      );
    }
    if (!opts.revalidate) {
      return { kind: 'conflict', reason: 'approval_revalidation_required', action };
    }
    let authorization: VcMeetingActionAuthorizationDecision;
    try {
      authorization = await opts.revalidate({
        projection: beforeAuthorization.projection,
        action,
        sink: action.sink,
      });
    } catch {
      return { kind: 'conflict', reason: 'authorization_unavailable', action };
    }
    if (!authorization || !['allow', 'approval', 'deny'].includes(authorization.kind)) {
      return { kind: 'conflict', reason: 'authorization_invalid_result', action };
    }
    if (authorization.kind === 'deny') {
      return expireApprovalAfterFenceFailure(dataDir, ref, opts, authorization.reason, now);
    }

    // The live phase hook may be asynchronous. Re-read cross-process member
    // fences after it resolves so a concurrent remove/re-add or owner transfer
    // cannot win the await window and then be followed by a stale claim.
    const beforeClaim = validateApprovalStructuralFence(dataDir, action);
    if (!beforeClaim.ok) {
      return expireApprovalAfterFenceFailure(
        dataDir,
        ref,
        opts,
        beforeClaim.errorCode,
        now,
      );
    }

    const claimed = approveAndClaimVcMeetingAction(dataDir, ref, {
      ...(opts.externalRefs ? { externalRefs: opts.externalRefs } : {}),
    }, now);
    if (claimed.kind === 'conflict') {
      return { kind: 'conflict', reason: claimed.reason, ...(claimed.record ? { action: claimed.record } : {}) };
    }
    if (claimed.kind === 'existing') return { kind: 'existing', action: claimed.record };
    return { kind: 'execute', action: claimed.record, plan: executionPlan(claimed.record) };
  }
  return approvalResolutionFromTransition(resolveVcMeetingActionApproval(dataDir, ref, decision, {
    ...(opts.externalRefs ? { externalRefs: opts.externalRefs } : {}),
    ...(opts.errorCode ? { errorCode: opts.errorCode } : {}),
  }, now));
}

/** Useful to callers deciding whether an existing result is final for display. */
export function isVcMeetingManagedActionTerminal(record: VcMeetingActionRecord): boolean {
  return isVcMeetingActionTerminal(record.status);
}
