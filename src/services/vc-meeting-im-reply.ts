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
import { isCurrentVcMeetingImTurnOrigin } from './vc-meeting-send-policy.js';

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
      canonicalOutput: VcMeetingImReplyCanonicalOutput;
      outputMismatch: boolean;
    }
  | {
      kind: 'conflict';
      reason: 'invalid_origin' | 'output_mismatch' | 'invalid_state';
      detail: string;
    };

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
      return prepareExistingVcMeetingImReply(dataDir, record, firstOutput, true, now);
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
  return prepareExistingVcMeetingImReply(dataDir, record, firstOutput, false, now, begun.kind === 'existing');
}

function prepareExistingVcMeetingImReply(
  dataDir: string,
  record: VcMeetingActionRecord,
  canonicalOutput: VcMeetingImReplyCanonicalOutput,
  outputMismatch: boolean,
  now: number,
  exactReplay = true,
): VcMeetingImReplyPrepareResult {
  if (record.status === 'succeeded') {
    const messageId = typeof record.externalRefs?.messageId === 'string'
      ? record.externalRefs.messageId
      : undefined;
    return {
      kind: 'succeeded',
      providerKey: record.providerKey,
      ref: refFor(record),
      ...(messageId ? { messageId } : {}),
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
      canonicalOutput,
      outputMismatch,
    };
  }
  if (record.status === 'attempting' || record.status === 'unknown') {
    // The prior process may have died after Lark accepted the UUID. Reissuing
    // the same provider key is the only safe reconciliation path.
    return {
      kind: 'send',
      providerKey: record.providerKey,
      ref: refFor(record),
      replay: true,
      canonicalOutput,
      outputMismatch,
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
