import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateVcMeetingManagedOriginClaim,
  evaluateVcMeetingManagedSend,
  isTrustedVcMeetingHostRelayParent,
  resolveVcMeetingImTurnOrigin,
  verifyVcMeetingManagedOriginClaim,
} from '../src/services/vc-meeting-send-policy.js';
import {
  acceptVcMeetingDelivery,
  abandonVcMeetingDeliveryStream,
  applyVcMeetingMemberProjection,
  completeVcMeetingDelivery,
  failVcMeetingDelivery,
  markVcMeetingDeliveryDispatched,
  markVcMeetingDeliveryAmbiguous,
} from '../src/services/vc-meeting-delivery-store.js';
import type { VcMeetingImTurnOrigin } from '../src/types.js';

let dir: string;
const memberKey = { listenerAppId: 'listener', meetingId: 'meeting', memberId: 'member', memberEpoch: 1 };
const imOrigin: VcMeetingImTurnOrigin = {
  ...memberKey,
  agentAppId: 'agent',
  ownerBootId: 'owner-boot',
  ownerEpoch: 1,
  membershipGeneration: 1,
  sinkOwnerGeneration: 1,
  receiverSessionId: 'receiver-session',
  larkMessageId: 'om_current',
};

function seed(responseMode: 'silent' | 'listener_thread'): void {
  applyVcMeetingMemberProjection(dir, {
    ...memberKey,
    ownerBootId: 'owner-boot',
    ownerEpoch: 1,
    agentAppId: 'agent',
    role: 'minutes',
    membershipGeneration: 1,
    status: 'active',
    responseMode,
    capabilities: ['listener.output.request', 'meeting.read'],
    ownedSinks: [],
    sinkOwnerGeneration: 1,
    joinedAtIngestSeq: 0,
    receiverSessionId: 'receiver-session',
    outputChatId: 'listener-chat',
  });
  acceptVcMeetingDelivery(dir, {
    ...memberKey,
    ownerBootId: 'owner-boot',
    ownerEpoch: 1,
    membershipGeneration: 1,
    deliveryKey: 'delivery-key',
    inputHash: 'input-hash',
    fromSeq: 1,
    toSeq: 1,
    responseMode,
    receiverBootId: 'receiver-boot',
  });
  markVcMeetingDeliveryDispatched(dir, { ...memberKey, deliveryKey: 'delivery-key' }, {
    receiverBootId: 'receiver-boot',
    workerGeneration: 1,
  });
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vc-send-policy-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('evaluateVcMeetingManagedSend', () => {
  it('trusts a host relay marker only when the CLI is a direct child of the recorded worker', () => {
    expect(isTrustedVcMeetingHostRelayParent(true, 4242, 4242)).toBe(true);
    expect(isTrustedVcMeetingHostRelayParent(true, 4242, 9999)).toBe(false);
    expect(isTrustedVcMeetingHostRelayParent(false, 4242, 4242)).toBe(false);
    expect(isTrustedVcMeetingHostRelayParent(true, null, 4242)).toBe(false);
  });

  it('rejects the exact durable origin for a silent projection', () => {
    seed('silent');
    expect(evaluateVcMeetingManagedSend(dir, {
      receiverSessionId: 'receiver-session', receiverSession: true,
      turnId: 'delivery-key', dispatchAttempt: 1,
    })).toMatchObject({ ok: false, errorCode: 'silent_delivery' });
  });

  it('allows the exact durable origin for listener_thread mode', () => {
    seed('listener_thread');
    expect(evaluateVcMeetingManagedSend(dir, {
      receiverSessionId: 'receiver-session', receiverSession: true,
      turnId: 'delivery-key', dispatchAttempt: 1,
    })).toEqual({
      ok: true,
      kind: 'listener_thread',
      meetingOwner: { listenerAppId: 'listener', meetingId: 'meeting' },
    });
  });

  it('allows a delayed final output only after successful completion', () => {
    seed('listener_thread');
    expect(completeVcMeetingDelivery(dir, {
      ...memberKey,
      deliveryKey: 'delivery-key',
    }, {
      workerGeneration: 1,
      dispatchAttempt: 1,
    })).toMatchObject({ ok: true, receipt: { status: 'completed' } });

    expect(evaluateVcMeetingManagedSend(dir, {
      receiverSessionId: 'receiver-session', receiverSession: true,
      turnId: 'delivery-key', dispatchAttempt: 1, allowTerminalReceipt: true,
    })).toMatchObject({ ok: true, kind: 'listener_thread' });
    expect(evaluateVcMeetingManagedSend(dir, {
      receiverSessionId: 'receiver-session', receiverSession: true,
      turnId: 'delivery-key', dispatchAttempt: 1,
    })).toMatchObject({ ok: false, errorCode: 'origin_mismatch' });
  });

  it('does not turn failed, ambiguous, or abandoned receipts into output authority', () => {
    const transitions = [
      {
        status: 'failed_retryable',
        apply: () => failVcMeetingDelivery(dir, {
          ...memberKey,
          deliveryKey: 'delivery-key',
        }, { kind: 'retryable', workerGeneration: 1, dispatchAttempt: 1 }),
      },
      {
        status: 'failed_terminal',
        apply: () => failVcMeetingDelivery(dir, {
          ...memberKey,
          deliveryKey: 'delivery-key',
        }, { kind: 'terminal', workerGeneration: 1, dispatchAttempt: 1 }),
      },
      {
        status: 'ambiguous',
        apply: () => markVcMeetingDeliveryAmbiguous(dir, {
          ...memberKey,
          deliveryKey: 'delivery-key',
        }, { workerGeneration: 1, dispatchAttempt: 1 }),
      },
      {
        status: 'abandoned',
        apply: () => abandonVcMeetingDeliveryStream(dir, memberKey, { reason: 'operator' }),
      },
    ] as const;

    for (const transition of transitions) {
      const caseDir = mkdtempSync(join(tmpdir(), `vc-send-policy-${transition.status}-`));
      const previousDir = dir;
      dir = caseDir;
      try {
        seed('listener_thread');
        expect(transition.apply()).toMatchObject({ ok: true });
        expect(evaluateVcMeetingManagedSend(dir, {
          receiverSessionId: 'receiver-session', receiverSession: true,
          turnId: 'delivery-key', dispatchAttempt: 1, allowTerminalReceipt: true,
        })).toMatchObject({ ok: false, errorCode: 'origin_mismatch' });
      } finally {
        dir = previousDir;
        rmSync(caseDir, { recursive: true, force: true });
      }
    }
  });

  it('rejects stale attempts and missing detached receiver origins', () => {
    seed('listener_thread');
    expect(evaluateVcMeetingManagedSend(dir, {
      receiverSessionId: 'receiver-session', receiverSession: true,
      turnId: 'delivery-key', dispatchAttempt: 2,
    })).toMatchObject({ ok: false, errorCode: 'origin_mismatch' });
    expect(evaluateVcMeetingManagedSend(dir, {
      receiverSessionId: 'receiver-session', receiverSession: true,
    })).toMatchObject({ ok: false, errorCode: 'origin_unproven' });
  });

  it('allows only the persisted current explicit IM turn without a dispatch attempt', () => {
    seed('silent');
    expect(evaluateVcMeetingManagedSend(dir, {
      receiverSessionId: 'receiver-session', receiverSession: true,
      turnId: 'om_current', currentImTurnOrigin: imOrigin,
    })).toEqual({
      ok: true,
      kind: 'listener_thread',
      meetingOwner: { listenerAppId: 'listener', meetingId: 'meeting' },
    });
    expect(evaluateVcMeetingManagedSend(dir, {
      receiverSessionId: 'receiver-session', receiverSession: true,
      turnId: 'om_stale', currentImTurnOrigin: imOrigin,
    })).toMatchObject({ ok: false, errorCode: 'origin_unproven' });
  });

  it('fences an explicit IM send after removal or ownership churn', () => {
    seed('silent');
    expect(applyVcMeetingMemberProjection(dir, {
      ...memberKey,
      ownerBootId: 'owner-boot', ownerEpoch: 1, agentAppId: 'agent', role: 'minutes',
      membershipGeneration: 2, status: 'removed', responseMode: 'silent',
      capabilities: ['listener.output.request', 'meeting.read'], ownedSinks: [],
      sinkOwnerGeneration: 1, joinedAtIngestSeq: 0,
      receiverSessionId: 'receiver-session', outputChatId: 'listener-chat',
    })).toMatchObject({ ok: true });
    expect(evaluateVcMeetingManagedSend(dir, {
      receiverSessionId: 'receiver-session', receiverSession: true,
      turnId: 'om_current', currentImTurnOrigin: imOrigin,
    })).toMatchObject({ ok: false, errorCode: 'origin_unproven' });

    const epoch2 = { ...memberKey, memberEpoch: 2 };
    expect(applyVcMeetingMemberProjection(dir, {
      ...epoch2,
      ownerBootId: 'owner-boot', ownerEpoch: 1, agentAppId: 'agent', role: 'minutes',
      membershipGeneration: 3, status: 'active', responseMode: 'silent',
      capabilities: ['listener.output.request', 'meeting.read'], ownedSinks: [],
      sinkOwnerGeneration: 2, joinedAtIngestSeq: 0,
      receiverSessionId: 'receiver-session', outputChatId: 'listener-chat',
    })).toMatchObject({ ok: true });
    expect(evaluateVcMeetingManagedSend(dir, {
      receiverSessionId: 'receiver-session', receiverSession: true,
      turnId: 'om_current', currentImTurnOrigin: imOrigin,
    })).toMatchObject({ ok: false, errorCode: 'origin_unproven' });
  });

  it('resolves queued explicit IM authority by live turn instead of latest message', () => {
    const base = {
      listenerAppId: 'listener', meetingId: 'meeting', memberId: 'member',
      memberEpoch: 1, agentAppId: 'agent', ownerBootId: 'owner-boot',
      ownerEpoch: 1, membershipGeneration: 1, sinkOwnerGeneration: 1,
      receiverSessionId: 'receiver-session',
    };
    const session = {
      sessionId: 'receiver-session',
      vcMeetingImTurnOrigins: {
        om_a: { ...base, larkMessageId: 'om_a' },
        om_b: { ...base, larkMessageId: 'om_b' },
      },
    };

    // B may already be queued/persisted while A is still executing. Both
    // entries remain independently attributable to their live worker turn.
    expect(resolveVcMeetingImTurnOrigin(session, 'om_a')?.larkMessageId).toBe('om_a');
    expect(resolveVcMeetingImTurnOrigin(session, 'om_b')?.larkMessageId).toBe('om_b');
    expect(resolveVcMeetingImTurnOrigin(session, 'om_unknown')).toBeUndefined();
    expect(resolveVcMeetingImTurnOrigin({ ...session, sessionId: 'other' }, 'om_a')).toBeUndefined();
  });

  it('keeps responseMode frozen on the receipt across projection updates', () => {
    seed('silent');
    applyVcMeetingMemberProjection(dir, {
      ...memberKey,
      ownerBootId: 'owner-boot', ownerEpoch: 1, agentAppId: 'agent', role: 'minutes',
      membershipGeneration: 2, status: 'active', responseMode: 'listener_thread',
      joinedAtIngestSeq: 0, receiverSessionId: 'receiver-session', outputChatId: 'listener-chat',
    });
    expect(evaluateVcMeetingManagedSend(dir, {
      receiverSessionId: 'receiver-session', receiverSession: true,
      turnId: 'delivery-key', dispatchAttempt: 1,
    })).toMatchObject({ ok: false, errorCode: 'silent_delivery' });
  });

  it('keeps ordinary non-receiver sends unchanged', () => {
    expect(evaluateVcMeetingManagedSend(dir, {
      receiverSessionId: 'ordinary-session', receiverSession: false, turnId: 'im-message',
    })).toEqual({ ok: true, kind: 'ordinary' });
  });

  it('authorizes daemon-mediated exits only from the worker live origin', () => {
    seed('listener_thread');
    const liveOrigin = { capability: 'cap-current', turnId: 'delivery-key', dispatchAttempt: 1 };
    expect(evaluateVcMeetingManagedOriginClaim(dir, {
      receiverSessionId: 'receiver-session', liveOrigin, claimedCapability: 'cap-current',
    })).toEqual({
      ok: true,
      kind: 'listener_thread',
      meetingOwner: { listenerAppId: 'listener', meetingId: 'meeting' },
    });
    expect(evaluateVcMeetingManagedOriginClaim(dir, {
      receiverSessionId: 'receiver-session', liveOrigin, claimedCapability: 'cap-old',
    })).toMatchObject({ ok: false, errorCode: 'origin_unproven' });
  });

  it('blocks daemon-mediated ask/card effects for a silent live delivery', () => {
    seed('silent');
    expect(evaluateVcMeetingManagedOriginClaim(dir, {
      receiverSessionId: 'receiver-session',
      liveOrigin: { capability: 'cap-silent', turnId: 'delivery-key', dispatchAttempt: 1 },
      claimedCapability: 'cap-silent',
    })).toMatchObject({ ok: false, errorCode: 'silent_delivery' });
  });

  it('proves the live origin independently from sink response policy', () => {
    seed('silent');
    const liveOrigin = { capability: 'cap-action', turnId: 'delivery-key', dispatchAttempt: 1 };
    expect(verifyVcMeetingManagedOriginClaim({
      receiverSessionId: 'receiver-session',
      liveOrigin,
      claimedCapability: 'cap-action',
    })).toEqual({
      ok: true,
      origin: {
        receiverSessionId: 'receiver-session',
        turnId: 'delivery-key',
        dispatchAttempt: 1,
        currentImTurnId: undefined,
        currentImTurnOrigin: undefined,
      },
    });
    expect(verifyVcMeetingManagedOriginClaim({
      receiverSessionId: 'receiver-session',
      liveOrigin,
      claimedTurnId: 'delivery-key',
      claimedDispatchAttempt: 1,
    })).toMatchObject({ ok: false, errorCode: 'origin_unproven' });
  });
});
