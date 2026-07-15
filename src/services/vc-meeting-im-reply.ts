/**
 * Durable identity for the user-visible assistant reply of an explicit VC
 * `im_turn`. The first canonical output wins; exact crash replays reuse the
 * same provider UUID, while changed text is rejected before Lark is called.
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

export type VcMeetingImReplyPrepareResult =
  | {
      kind: 'send';
      providerKey: string;
      ref: VcMeetingActionRef;
      replay: boolean;
    }
  | {
      kind: 'succeeded';
      providerKey: string;
      ref: VcMeetingActionRef;
      messageId?: string;
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

export function prepareVcMeetingImReply(
  dataDir: string,
  origin: VcMeetingImTurnOrigin,
  canonicalOutput: {
    targetChatId: string;
    quoteTargetId?: string;
    msgType: string;
    content: string;
  },
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
    return {
      kind: 'conflict',
      reason: begun.reason === 'input_mismatch' ? 'output_mismatch' : 'invalid_origin',
      detail: begun.reason === 'input_mismatch'
        ? 'this IM turn already committed a different assistant reply; the first output wins'
        : begun.detail ?? begun.reason,
    };
  }

  const record = begun.record;
  if (record.status === 'succeeded') {
    const messageId = typeof record.externalRefs?.messageId === 'string'
      ? record.externalRefs.messageId
      : undefined;
    return {
      kind: 'succeeded',
      providerKey: record.providerKey,
      ref: refFor(record),
      ...(messageId ? { messageId } : {}),
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
      replay: begun.kind === 'existing',
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
