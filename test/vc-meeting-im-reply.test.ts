import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VC_MEETING_LISTENER_PROVIDER_DEDUP_SAFE_MS,
  finishVcMeetingImReply,
  prepareVcMeetingDeliveryReply,
  prepareVcMeetingImReply,
} from '../src/services/vc-meeting-im-reply.js';
import {
  findVcMeetingAction,
  finishVcMeetingAction,
} from '../src/services/vc-meeting-action-store.js';
import type { VcMeetingImTurnOrigin } from '../src/types.js';
import {
  acceptVcMeetingDelivery,
  applyVcMeetingMemberProjection,
  markVcMeetingDeliveryAmbiguous,
  markVcMeetingDeliveryDispatched,
  type VcMeetingMemberProjectionInput,
} from '../src/services/vc-meeting-delivery-store.js';

let dir: string;

const origin: VcMeetingImTurnOrigin = {
  listenerAppId: 'listener',
  meetingId: 'meeting',
  memberId: 'minutes',
  memberEpoch: 1,
  agentAppId: 'agent',
  ownerBootId: 'boot',
  ownerEpoch: 1,
  membershipGeneration: 1,
  sinkOwnerGeneration: 1,
  receiverSessionId: 'receiver-session',
  larkMessageId: 'om_human_a',
};

const output = {
  targetChatId: 'oc_listener',
  quoteTargetId: 'om_human_a',
  msgType: 'interactive',
  content: '{"schema":"2.0","body":{"elements":[]}}',
};

function project(overrides: Partial<VcMeetingMemberProjectionInput> = {}): void {
  expect(applyVcMeetingMemberProjection(dir, {
    listenerAppId: origin.listenerAppId,
    meetingId: origin.meetingId,
    memberId: origin.memberId,
    memberEpoch: origin.memberEpoch,
    agentAppId: origin.agentAppId,
    ownerBootId: origin.ownerBootId,
    ownerEpoch: origin.ownerEpoch,
    role: 'minutes',
    membershipGeneration: origin.membershipGeneration,
    status: 'active',
    responseMode: 'silent',
    capabilities: ['meeting.read'],
    ownedSinks: [],
    sinkOwnerGeneration: origin.sinkOwnerGeneration,
    joinedAtIngestSeq: 0,
    receiverSessionId: origin.receiverSessionId,
    outputChatId: output.targetChatId,
    ...overrides,
  })).toMatchObject({ ok: true });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-im-reply-'));
  project();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('VC explicit IM assistant reply ledger', () => {
  it('locks the first output and reuses one provider UUID across ambiguous replay', () => {
    const first = prepareVcMeetingImReply(dir, origin, output, 100);
    expect(first).toMatchObject({ kind: 'send', replay: false, providerReplay: false });
    if (first.kind !== 'send') throw new Error('expected first send claim');
    expect(first.providerKey).toMatch(/^vcp_[0-9a-f]+$/);
    expect(first.providerKey.length).toBeLessThanOrEqual(50);

    const replay = prepareVcMeetingImReply(dir, origin, output, 101);
    expect(replay).toMatchObject({
      kind: 'send',
      replay: true,
      providerReplay: true,
      providerKey: first.providerKey,
    });

    const changedOutput = {
      ...output,
      content: '{"schema":"2.0","body":{"elements":[{"tag":"markdown","content":"changed"}]}}',
    };
    const mismatch = prepareVcMeetingImReply(dir, origin, changedOutput, 102);
    expect(mismatch).toMatchObject({
      kind: 'send',
      replay: true,
      providerKey: first.providerKey,
      outputMismatch: true,
      canonicalOutput: output,
    });
    if (mismatch.kind === 'send') {
      expect(mismatch.canonicalOutput.content).not.toBe(changedOutput.content);
    }
  });

  it('never retries an ambiguous provider call after the Lark UUID safety window', () => {
    const attemptedAt = 100;
    const first = prepareVcMeetingImReply(dir, origin, output, attemptedAt);
    if (first.kind !== 'send') throw new Error('expected first send claim');

    expect(prepareVcMeetingImReply(
      dir,
      origin,
      output,
      attemptedAt + VC_MEETING_LISTENER_PROVIDER_DEDUP_SAFE_MS,
    )).toMatchObject({ kind: 'send', providerReplay: true });

    expect(prepareVcMeetingImReply(
      dir,
      origin,
      output,
      attemptedAt + VC_MEETING_LISTENER_PROVIDER_DEDUP_SAFE_MS + 1,
    )).toMatchObject({
      kind: 'conflict',
      reason: 'invalid_state',
      detail: expect.stringContaining('manual review'),
    });
    expect(findVcMeetingAction(dir, {
      listenerAppId: origin.listenerAppId,
      meetingId: origin.meetingId,
    }, first.ref.actionId)).toMatchObject({
      status: 'unknown',
      errorCode: 'provider_idempotency_window_expired',
    });

    // Even after the provider's full one-hour dedupe TTL, terminal unknown is
    // a manual state and can never be turned back into an automatic send.
    expect(prepareVcMeetingImReply(dir, origin, output, attemptedAt + 60 * 60_000 + 1))
      .toMatchObject({ kind: 'conflict', reason: 'invalid_state' });
  });

  it('only reconciles succeeded records missing messageId inside the UUID safety window', () => {
    const attemptedAt = 100;
    const first = prepareVcMeetingImReply(dir, origin, output, attemptedAt);
    if (first.kind !== 'send') throw new Error('expected first send claim');
    expect(finishVcMeetingAction(dir, first.ref, { status: 'succeeded' }, attemptedAt + 1))
      .toMatchObject({ kind: 'updated', record: { status: 'succeeded' } });

    expect(prepareVcMeetingImReply(
      dir,
      origin,
      output,
      attemptedAt + VC_MEETING_LISTENER_PROVIDER_DEDUP_SAFE_MS,
    )).toMatchObject({ kind: 'succeeded', providerReplay: true });
    expect(prepareVcMeetingImReply(
      dir,
      origin,
      output,
      attemptedAt + VC_MEETING_LISTENER_PROVIDER_DEDUP_SAFE_MS + 1,
    )).toMatchObject({
      kind: 'conflict',
      reason: 'invalid_state',
      detail: expect.stringContaining('manual review'),
    });
  });

  it('refuses a late replay after the member is removed or ownership changes', () => {
    expect(prepareVcMeetingImReply(dir, origin, output, 100)).toMatchObject({ kind: 'send' });
    project({ membershipGeneration: 2, status: 'removed' });
    expect(prepareVcMeetingImReply(dir, origin, output, 101)).toMatchObject({
      kind: 'conflict',
      reason: 'invalid_origin',
    });

    project({
      memberEpoch: 2,
      membershipGeneration: 3,
      sinkOwnerGeneration: 2,
    });
    expect(prepareVcMeetingImReply(dir, origin, output, 102)).toMatchObject({
      kind: 'conflict',
      reason: 'invalid_origin',
    });
  });

  it('refuses to bind a canonical reply outside the projected listener chat', () => {
    expect(prepareVcMeetingImReply(dir, origin, {
      ...output,
      targetChatId: 'oc_elsewhere',
    })).toMatchObject({ kind: 'conflict', reason: 'invalid_origin' });
  });

  it('returns the committed provider result without sending a second answer', () => {
    const first = prepareVcMeetingImReply(dir, origin, output, 100);
    if (first.kind !== 'send') throw new Error('expected first send claim');
    finishVcMeetingImReply(dir, first.ref, 'om_assistant_reply', 110);

    expect(prepareVcMeetingImReply(dir, origin, output, 120)).toMatchObject({
      kind: 'succeeded',
      providerKey: first.providerKey,
      messageId: 'om_assistant_reply',
    });
  });

  it('uses a different identity for the next human IM turn', () => {
    const first = prepareVcMeetingImReply(dir, origin, output);
    const secondOrigin = { ...origin, larkMessageId: 'om_human_b' };
    const second = prepareVcMeetingImReply(dir, secondOrigin, {
      ...output,
      quoteTargetId: 'om_human_b',
    });
    expect(first.kind).toBe('send');
    expect(second.kind).toBe('send');
    if (first.kind === 'send' && second.kind === 'send') {
      expect(second.providerKey).not.toBe(first.providerKey);
    }
  });
});

describe('VC durable delivery assistant reply ledger', () => {
  const deliveryOrigin = {
    receiverSessionId: origin.receiverSessionId,
    stableTurnId: 'delivery-stable-key',
    dispatchAttempt: 1,
  };
  const deliveryOutput = {
    targetChatId: output.targetChatId,
    msgType: output.msgType,
    content: output.content,
  };
  const deliveryKey = {
    listenerAppId: origin.listenerAppId,
    meetingId: origin.meetingId,
    memberId: origin.memberId,
    memberEpoch: origin.memberEpoch,
    deliveryKey: deliveryOrigin.stableTurnId,
  };

  beforeEach(() => {
    project({
      membershipGeneration: 2,
      responseMode: 'listener_thread',
      capabilities: ['meeting.read', 'listener.output.request'],
    });
    expect(acceptVcMeetingDelivery(dir, {
      ...deliveryKey,
      ownerBootId: origin.ownerBootId,
      ownerEpoch: origin.ownerEpoch,
      membershipGeneration: 2,
      inputHash: 'delivery-input-hash',
      fromSeq: 1,
      toSeq: 1,
      responseMode: 'listener_thread',
      receiverBootId: 'receiver-boot-a',
    })).toMatchObject({ kind: 'accepted' });
    expect(markVcMeetingDeliveryDispatched(dir, deliveryKey, {
      receiverBootId: 'receiver-boot-a',
      workerGeneration: 1,
    })).toMatchObject({ ok: true, receipt: { dispatchAttempt: 1 } });
  });

  it('reuses one provider UUID and first output across an ambiguous replay attempt', () => {
    const first = prepareVcMeetingDeliveryReply(dir, deliveryOrigin, deliveryOutput, 100);
    expect(first).toMatchObject({ kind: 'send', replay: false, providerReplay: false });
    if (first.kind !== 'send') throw new Error('expected first delivery reply claim');

    expect(markVcMeetingDeliveryAmbiguous(dir, deliveryKey, {
      workerGeneration: 1,
      dispatchAttempt: 1,
    }, 110)).toMatchObject({ ok: true, receipt: { status: 'ambiguous' } });
    expect(markVcMeetingDeliveryDispatched(dir, deliveryKey, {
      receiverBootId: 'receiver-boot-b',
      workerGeneration: 2,
    }, 120)).toMatchObject({ ok: true, receipt: { dispatchAttempt: 2 } });

    const changed = { ...deliveryOutput, content: '{"changed":true}' };
    const replay = prepareVcMeetingDeliveryReply(dir, {
      ...deliveryOrigin,
      dispatchAttempt: 2,
    }, changed, 130);
    expect(replay).toMatchObject({
      kind: 'send',
      replay: true,
      providerReplay: true,
      providerKey: first.providerKey,
      outputMismatch: true,
      canonicalOutput: deliveryOutput,
    });
  });

  it('rejects the stale attempt after the receipt has moved to its retry', () => {
    expect(prepareVcMeetingDeliveryReply(dir, deliveryOrigin, deliveryOutput)).toMatchObject({ kind: 'send' });
    expect(markVcMeetingDeliveryAmbiguous(dir, deliveryKey, {
      workerGeneration: 1,
      dispatchAttempt: 1,
    })).toMatchObject({ ok: true });
    expect(markVcMeetingDeliveryDispatched(dir, deliveryKey, {
      receiverBootId: 'receiver-boot-b',
      workerGeneration: 2,
    })).toMatchObject({ ok: true, receipt: { dispatchAttempt: 2 } });

    expect(prepareVcMeetingDeliveryReply(dir, deliveryOrigin, deliveryOutput)).toMatchObject({
      kind: 'conflict',
      reason: 'invalid_origin',
    });
  });

  it('returns the committed provider result without sending a second delivery reply', () => {
    const first = prepareVcMeetingDeliveryReply(dir, deliveryOrigin, deliveryOutput, 100);
    if (first.kind !== 'send') throw new Error('expected first delivery reply claim');
    finishVcMeetingImReply(dir, first.ref, 'om_delivery_reply', 110);

    expect(prepareVcMeetingDeliveryReply(dir, deliveryOrigin, deliveryOutput, 120)).toMatchObject({
      kind: 'succeeded',
      providerKey: first.providerKey,
      messageId: 'om_delivery_reply',
      canonicalOutput: deliveryOutput,
    });
  });
});
