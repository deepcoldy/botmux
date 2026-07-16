/**
 * Durable identity for the user-visible assistant reply of an explicit VC
 * `im_turn`. The first canonical output wins; exact crash replays reuse the
 * same provider UUID, while changed replays reuse the first durable output.
 */
import type { VcMeetingImTurnOrigin } from '../types.js';
import {
  beginVcMeetingAction,
  claimVcMeetingActionAttempt,
  finishVcMeetingAction,
  type VcMeetingActionRecord,
  type VcMeetingActionRef,
} from './vc-meeting-action-store.js';
import { deriveVcMeetingImTurnSourceKey } from './vc-meeting-action-gate.js';
import {
  findVcMeetingDeliveryByKey,
  getVcMeetingMemberProjection,
} from './vc-meeting-delivery-store.js';
import { isCurrentVcMeetingImTurnOrigin } from './vc-meeting-send-policy.js';

// Lark message UUIDs deduplicate for one hour. Keep the same five-minute
// clock/network margin as managed meeting_text: after this point an ambiguous
// provider result must be reviewed manually, never blindly reissued.
export const VC_MEETING_LISTENER_PROVIDER_DEDUP_SAFE_MS = 55 * 60_000;

export interface VcMeetingImReplyCanonicalOutput {
  targetChatId: string;
  quoteTargetId?: string;
  msgType: string;
  content: string;
}

export type VcMeetingImReplyPrepareResult =
  | {
      kind: 'send';
      providerKey: string;
      ref: VcMeetingActionRef;
      replay: boolean;
      /** True only when the provider UUID may already have been accepted. The
       * caller must suppress a second outbound hook while reconciling it. */
      providerReplay: boolean;
      /** Always the first durable output, even when this replay proposed text
       * that differs. Callers must send this value, never their new proposal. */
      canonicalOutput: VcMeetingImReplyCanonicalOutput;
      outputMismatch: boolean;
    }
  | {
      kind: 'succeeded';
      providerKey: string;
      ref: VcMeetingActionRef;
      messageId?: string;
      /** A missing legacy provider ref is reconciled with an already-used UUID;
       * do not emit the outbound hook again if a provider call is required. */
      providerReplay: true;
      canonicalOutput: VcMeetingImReplyCanonicalOutput;
      outputMismatch: boolean;
    }
  | {
      kind: 'conflict';
      reason: 'invalid_origin' | 'output_mismatch' | 'invalid_state';
      detail: string;
    };

export interface VcMeetingDeliveryReplyOrigin {
  receiverSessionId: string;
  stableTurnId: string;
  dispatchAttempt: number;
}

function refFor(record: VcMeetingActionRecord): VcMeetingActionRef {
  return {
    listenerAppId: record.listenerAppId,
    meetingId: record.meetingId,
    actionId: record.actionId,
    inputHash: record.inputHash,
  };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function canonicalOutputFromRecord(
  record: VcMeetingActionRecord,
): VcMeetingImReplyCanonicalOutput | undefined {
  const value = record.canonicalInput;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const output = value as Record<string, unknown>;
  if (!nonEmpty(output.targetChatId)
    || !nonEmpty(output.msgType)
    || !nonEmpty(output.content)
    || (output.quoteTargetId !== undefined && !nonEmpty(output.quoteTargetId))) return undefined;
  return {
    targetChatId: output.targetChatId,
    ...(typeof output.quoteTargetId === 'string'
      ? { quoteTargetId: output.quoteTargetId }
      : {}),
    msgType: output.msgType,
    content: output.content,
  };
}

export function prepareVcMeetingImReply(
  dataDir: string,
  origin: VcMeetingImTurnOrigin,
  canonicalOutput: VcMeetingImReplyCanonicalOutput,
  now = Date.now(),
): VcMeetingImReplyPrepareResult {
  if (!origin
    || !nonEmpty(origin.listenerAppId)
    || !nonEmpty(origin.meetingId)
    || !nonEmpty(origin.memberId)
    || !nonEmpty(origin.agentAppId)
    || !nonEmpty(origin.receiverSessionId)
    || !nonEmpty(origin.larkMessageId)
    || !Number.isSafeInteger(origin.memberEpoch)
    || origin.memberEpoch < 1
    || !Number.isSafeInteger(origin.sinkOwnerGeneration)
    || origin.sinkOwnerGeneration < 1
    || !nonEmpty(canonicalOutput.targetChatId)
    || !nonEmpty(canonicalOutput.msgType)
    || !nonEmpty(canonicalOutput.content)) {
    return { kind: 'conflict', reason: 'invalid_origin', detail: 'IM reply origin/output is invalid' };
  }
  if (!isCurrentVcMeetingImTurnOrigin(dataDir, origin, canonicalOutput.targetChatId)) {
    return {
      kind: 'conflict',
      reason: 'invalid_origin',
      detail: 'IM reply membership is no longer active/current',
    };
  }

  const sourceKey = deriveVcMeetingImTurnSourceKey(
    origin.receiverSessionId,
    origin.larkMessageId,
  );
  const begun = beginVcMeetingAction(dataDir, {
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
    // `listener_chat + primary` is the deterministic assistant_reply slot for
    // explicit IM turns. Managed meeting text/voice actions use other sinks.
    sink: 'listener_chat',
    actionSlot: 'primary',
    canonicalInput: canonicalOutput,
  }, now);
  if (begun.kind === 'conflict') {
    if (begun.reason === 'input_mismatch' && begun.record) {
      const record = begun.record;
      const firstOutput = canonicalOutputFromRecord(record);
      if (!firstOutput
        || !isCurrentVcMeetingImTurnOrigin(dataDir, origin, firstOutput.targetChatId)) {
        return {
          kind: 'conflict',
          reason: firstOutput ? 'invalid_origin' : 'invalid_state',
          detail: firstOutput
            ? 'IM reply membership is no longer active/current'
            : 'the first IM reply output is invalid',
        };
      }
      return prepareExistingVcMeetingListenerReply(dataDir, record, firstOutput, true, now);
    }
    return {
      kind: 'conflict',
      reason: 'invalid_origin',
      detail: begun.detail ?? begun.reason,
    };
  }

  const record = begun.record;
  const firstOutput = canonicalOutputFromRecord(record);
  if (!firstOutput) {
    return { kind: 'conflict', reason: 'invalid_state', detail: 'the first IM reply output is invalid' };
  }
  return prepareExistingVcMeetingListenerReply(dataDir, record, firstOutput, false, now, begun.kind === 'existing');
}

/**
 * Durable identity for the automatic listener-thread reply of one delivery.
 * The identity is the stable delivery key (not dispatchAttempt), so a crash
 * replay reuses the same provider UUID and first canonical output.
 */
export function prepareVcMeetingDeliveryReply(
  dataDir: string,
  origin: VcMeetingDeliveryReplyOrigin,
  canonicalOutput: VcMeetingImReplyCanonicalOutput,
  now = Date.now(),
): VcMeetingImReplyPrepareResult {
  if (!nonEmpty(origin.receiverSessionId)
    || !nonEmpty(origin.stableTurnId)
    || !Number.isSafeInteger(origin.dispatchAttempt)
    || origin.dispatchAttempt < 1
    || !nonEmpty(canonicalOutput.targetChatId)
    || !nonEmpty(canonicalOutput.msgType)
    || !nonEmpty(canonicalOutput.content)) {
    return { kind: 'conflict', reason: 'invalid_origin', detail: 'delivery reply origin/output is invalid' };
  }
  const lookup = findVcMeetingDeliveryByKey(dataDir, origin.stableTurnId, {
    receiverSessionId: origin.receiverSessionId,
  });
  if (!lookup
    || lookup.receipt.stableTurnId !== origin.stableTurnId
    || lookup.receipt.dispatchAttempt !== origin.dispatchAttempt
    || !['dispatched', 'completed'].includes(lookup.receipt.status)
    || lookup.receipt.responseMode !== 'listener_thread'
    || !Number.isSafeInteger(lookup.receipt.sinkOwnerGeneration)
    || (lookup.receipt.sinkOwnerGeneration ?? 0) < 1) {
    return { kind: 'conflict', reason: 'invalid_origin', detail: 'delivery reply receipt is stale or not listener-visible' };
  }
  const projection = getVcMeetingMemberProjection(dataDir, lookup.memberKey);
  if (!projection
    || projection.status !== 'active'
    || projection.receiverSessionId !== origin.receiverSessionId
    || projection.outputChatId !== canonicalOutput.targetChatId
    || projection.sinkOwnerGeneration !== lookup.receipt.sinkOwnerGeneration) {
    return { kind: 'conflict', reason: 'invalid_origin', detail: 'delivery reply membership is no longer active/current' };
  }

  const begun = beginVcMeetingAction(dataDir, {
    ...lookup.memberKey,
    agentAppId: projection.agentAppId,
    ownerGeneration: lookup.receipt.sinkOwnerGeneration!,
    source: {
      kind: 'delivery',
      key: lookup.receipt.deliveryKey,
      deliverySeq: lookup.receipt.toSeq,
    },
    sink: 'listener_chat',
    actionSlot: 'primary',
    canonicalInput: canonicalOutput,
  }, now);
  if (begun.kind === 'conflict') {
    if (begun.reason === 'input_mismatch' && begun.record) {
      const firstOutput = canonicalOutputFromRecord(begun.record);
      if (!firstOutput || firstOutput.targetChatId !== projection.outputChatId) {
        return {
          kind: 'conflict',
          reason: firstOutput ? 'invalid_origin' : 'invalid_state',
          detail: firstOutput
            ? 'the first delivery reply target is no longer current'
            : 'the first delivery reply output is invalid',
        };
      }
      return prepareExistingVcMeetingListenerReply(dataDir, begun.record, firstOutput, true, now);
    }
    return {
      kind: 'conflict',
      reason: begun.reason === 'input_mismatch' ? 'output_mismatch' : 'invalid_origin',
      detail: begun.detail ?? begun.reason,
    };
  }
  const firstOutput = canonicalOutputFromRecord(begun.record);
  if (!firstOutput) {
    return { kind: 'conflict', reason: 'invalid_state', detail: 'the first delivery reply output is invalid' };
  }
  return prepareExistingVcMeetingListenerReply(
    dataDir,
    begun.record,
    firstOutput,
    false,
    now,
    begun.kind === 'existing',
  );
}

function prepareExistingVcMeetingListenerReply(
  dataDir: string,
  record: VcMeetingActionRecord,
  canonicalOutput: VcMeetingImReplyCanonicalOutput,
  outputMismatch: boolean,
  now: number,
  exactReplay = true,
): VcMeetingImReplyPrepareResult {
  const providerReplayIsSafe = record.attemptedAt !== undefined
    && now >= record.attemptedAt
    && now - record.attemptedAt <= VC_MEETING_LISTENER_PROVIDER_DEDUP_SAFE_MS;
  if (record.status === 'succeeded') {
    const messageId = typeof record.externalRefs?.messageId === 'string'
      ? record.externalRefs.messageId
      : undefined;
    if (!messageId && !providerReplayIsSafe) {
      return {
        kind: 'conflict',
        reason: 'invalid_state',
        detail: 'IM assistant reply succeeded without a provider message id and its idempotency window expired; manual review required',
      };
    }
    return {
      kind: 'succeeded',
      providerKey: record.providerKey,
      ref: refFor(record),
      ...(messageId ? { messageId } : {}),
      providerReplay: true,
      canonicalOutput,
      outputMismatch,
    };
  }
  if (record.status === 'requested') {
    const claimed = claimVcMeetingActionAttempt(dataDir, refFor(record), now);
    if (claimed.kind === 'conflict') {
      return { kind: 'conflict', reason: 'invalid_state', detail: claimed.reason };
    }
    return {
      kind: 'send',
      providerKey: claimed.record.providerKey,
      ref: refFor(claimed.record),
      replay: exactReplay || outputMismatch,
      providerReplay: false,
      canonicalOutput,
      outputMismatch,
    };
  }
  if (record.status === 'attempting' && providerReplayIsSafe) {
    // The prior process may have died after Lark accepted the UUID. Reissuing
    // the same provider key is safe only while Lark's UUID window is active.
    return {
      kind: 'send',
      providerKey: record.providerKey,
      ref: refFor(record),
      replay: true,
      providerReplay: true,
      canonicalOutput,
      outputMismatch,
    };
  }
  if (record.status === 'attempting') {
    const terminal = finishVcMeetingAction(dataDir, refFor(record), {
      status: 'unknown',
      errorCode: 'provider_idempotency_window_expired',
      externalRefs: { providerKey: record.providerKey },
    }, now);
    if (terminal.kind === 'conflict') {
      return {
        kind: 'conflict',
        reason: 'invalid_state',
        detail: `failed to terminalize expired IM assistant reply: ${terminal.reason}`,
      };
    }
    return {
      kind: 'conflict',
      reason: 'invalid_state',
      detail: 'IM assistant reply provider result is ambiguous and its idempotency window expired; manual review required',
    };
  }
  if (record.status === 'unknown') {
    return {
      kind: 'conflict',
      reason: 'invalid_state',
      detail: 'IM assistant reply provider result is unknown; manual review required',
    };
  }
  return {
    kind: 'conflict',
    reason: 'invalid_state',
    detail: `IM assistant reply is already ${record.status}`,
  };
}

export function finishVcMeetingImReply(
  dataDir: string,
  ref: VcMeetingActionRef,
  messageId: string,
  now = Date.now(),
): void {
  const finished = finishVcMeetingAction(dataDir, ref, {
    status: 'succeeded',
    externalRefs: { messageId },
  }, now);
  if (finished.kind === 'conflict') {
    throw new Error(`failed to finish IM assistant reply: ${finished.reason}`);
  }
}
