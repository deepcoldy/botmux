import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveVcMeetingImTurnSourceKey,
  finishVcMeetingManagedActionProvider,
  finishVcMeetingManagedApprovalCard,
  requestVcMeetingManagedAction,
  requestVcMeetingManagedImAction,
  resolveVcMeetingManagedActionApproval,
  type VcMeetingActionAuthorizationDecision,
  type VcMeetingActionGateDeps,
  type VcMeetingImActionGateDeps,
  type VcMeetingManagedImActionRequest,
  type VcMeetingManagedActionRequest,
  type VcMeetingTrustedImTurnOrigin,
} from '../src/services/vc-meeting-action-gate.js';
import {
  beginVcMeetingAction,
  findVcMeetingAction,
  listVcMeetingActions,
} from '../src/services/vc-meeting-action-store.js';
import {
  acceptVcMeetingDelivery,
  applyVcMeetingMemberProjection,
  completeVcMeetingDelivery,
  markVcMeetingDeliveryAmbiguous,
  markVcMeetingDeliveryDispatched,
  type VcMeetingMemberProjectionInput,
} from '../src/services/vc-meeting-delivery-store.js';

const LISTENER = 'listener-app';
const MEETING = 'meeting-1';
const AGENT = 'consumer-agent';
const MEMBER = 'member-speaker';
const SESSION = 'receiver-session-1';
const DELIVERY = 'vc_delivery_stable_1';

function projection(
  overrides: Partial<VcMeetingMemberProjectionInput> = {},
): VcMeetingMemberProjectionInput {
  return {
    listenerAppId: LISTENER,
    meetingId: MEETING,
    ownerBootId: 'owner-boot-1',
    ownerEpoch: 1,
    memberId: MEMBER,
    agentAppId: AGENT,
    role: 'analysis',
    memberEpoch: 1,
    membershipGeneration: 1,
    status: 'active',
    responseMode: 'silent',
    capabilities: ['meeting.read'],
    ownedSinks: [],
    sinkOwnerGeneration: 1,
    joinedAtIngestSeq: 0,
    receiverSessionId: SESSION,
    outputChatId: 'listener-chat',
    ...overrides,
  };
}

function request(overrides: Partial<VcMeetingManagedActionRequest> = {}): VcMeetingManagedActionRequest {
  return {
    agentAppId: AGENT,
    receiverSessionId: SESSION,
    stableTurnId: DELIVERY,
    dispatchAttempt: 1,
    channel: 'text',
    content: 'Hello meeting',
    reason: 'Relevant response',
    ...overrides,
  };
}

function imOrigin(overrides: Partial<VcMeetingTrustedImTurnOrigin> = {}): VcMeetingTrustedImTurnOrigin {
  return {
    listenerAppId: LISTENER,
    meetingId: MEETING,
    memberId: MEMBER,
    memberEpoch: 1,
    agentAppId: AGENT,
    ownerBootId: 'owner-boot-1',
    ownerEpoch: 1,
    membershipGeneration: 1,
    sinkOwnerGeneration: 1,
    receiverSessionId: SESSION,
    larkMessageId: 'om_explicit_user_1',
    ...overrides,
  };
}

function imRequest(
  overrides: Partial<VcMeetingManagedImActionRequest> = {},
): VcMeetingManagedImActionRequest {
  return {
    origin: imOrigin(),
    sink: 'task',
    canonicalInput: {
      mode: 'sync',
      items: [{ summary: 'Send the launch note', assigneeOpenIds: ['ou_owner'] }],
    },
    reason: 'User explicitly asked to create the meeting task',
    ...overrides,
  };
}

describe('vc meeting managed action gate', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-vc-action-gate-'));
    expect(applyVcMeetingMemberProjection(dir, projection(), 100)).toMatchObject({ ok: true });
    expect(acceptVcMeetingDelivery(dir, {
      listenerAppId: LISTENER,
      meetingId: MEETING,
      ownerBootId: 'owner-boot-1',
      ownerEpoch: 1,
      memberId: MEMBER,
      agentAppId: AGENT,
      memberEpoch: 1,
      membershipGeneration: 1,
      deliveryKey: DELIVERY,
      inputHash: 'delivery-input-hash',
      fromSeq: 1,
      toSeq: 7,
      responseMode: 'silent',
      receiverBootId: 'receiver-boot-1',
    } as Parameters<typeof acceptVcMeetingDelivery>[1], 110)).toMatchObject({ kind: 'accepted' });
    expect(markVcMeetingDeliveryDispatched(dir, {
      listenerAppId: LISTENER,
      meetingId: MEETING,
      memberId: MEMBER,
      memberEpoch: 1,
      deliveryKey: DELIVERY,
    }, { receiverBootId: 'receiver-boot-1', workerGeneration: 4 }, 120)).toMatchObject({
      ok: true,
      receipt: { status: 'dispatched', dispatchAttempt: 1 },
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function deps(
    decision: VcMeetingActionAuthorizationDecision = { kind: 'allow' },
  ): VcMeetingActionGateDeps & { authorize: ReturnType<typeof vi.fn> } {
    return {
      dataDir: dir,
      selfAgentAppId: AGENT,
      authorize: vi.fn(async () => decision),
    };
  }

  function imDeps(
    decision: VcMeetingActionAuthorizationDecision = { kind: 'allow' },
  ): VcMeetingImActionGateDeps & { authorize: ReturnType<typeof vi.fn> } {
    return {
      dataDir: dir,
      selfAgentAppId: AGENT,
      authorize: vi.fn(async () => decision),
    };
  }

  it('passes the silent analysis projection to authorization and durably rejects missing capability', async () => {
    expect(applyVcMeetingMemberProjection(dir, projection({
      membershipGeneration: 2,
      responseMode: 'silent',
    }), 130)).toMatchObject({ ok: true });
    const gate = deps({ kind: 'deny', reason: 'capability_denied', detail: 'analysis-only member' });
    const result = await requestVcMeetingManagedAction(request(), gate, 140);
    expect(result).toMatchObject({
      status: 403,
      body: {
        ok: false,
        errorCode: 'capability_denied',
        action: { status: 'rejected', errorCode: 'capability_denied', ownerGeneration: 1 },
      },
    });
    expect(gate.authorize).toHaveBeenCalledTimes(1);
    expect(gate.authorize.mock.calls[0]![0]).toMatchObject({
      projection: { role: 'analysis', responseMode: 'silent' },
      receipt: { responseMode: 'silent', toSeq: 7 },
      sink: 'meeting_text',
    });
  });

  it('fences actions by sink owner generation rather than membership generation', async () => {
    expect(beginVcMeetingAction(dir, {
      listenerAppId: LISTENER,
      meetingId: MEETING,
      memberId: MEMBER,
      memberEpoch: 1,
      agentAppId: AGENT,
      ownerGeneration: 1,
      source: { kind: 'delivery', key: DELIVERY, deliverySeq: 7 },
      sink: 'meeting_text',
      actionSlot: 'primary',
      canonicalInput: { content: 'Hello meeting' },
    }, 125)).toMatchObject({
      kind: 'created',
      record: { status: 'requested', ownerGeneration: 1 },
    });

    // Pause/resume and other control-plane changes advance membershipGeneration
    // without transferring sink ownership. Such an update must not fence the
    // already-durable action intent.
    expect(applyVcMeetingMemberProjection(dir, projection({
      membershipGeneration: 2,
      sinkOwnerGeneration: 1,
    }), 130)).toMatchObject({ ok: true });
    const gate = deps();
    expect(await requestVcMeetingManagedAction(request(), gate, 140)).toMatchObject({
      status: 202,
      body: {
        kind: 'execute',
        action: { status: 'attempting', ownerGeneration: 1 },
      },
    });
    expect(gate.authorize).toHaveBeenCalledTimes(1);
  });

  it('rejects a requested crash residue after sink ownership generation advances', async () => {
    expect(beginVcMeetingAction(dir, {
      listenerAppId: LISTENER,
      meetingId: MEETING,
      memberId: MEMBER,
      memberEpoch: 1,
      agentAppId: AGENT,
      ownerGeneration: 1,
      source: { kind: 'delivery', key: DELIVERY, deliverySeq: 7 },
      sink: 'meeting_text',
      actionSlot: 'primary',
      canonicalInput: { content: 'Hello meeting' },
    }, 125)).toMatchObject({ kind: 'created' });
    expect(applyVcMeetingMemberProjection(dir, projection({
      membershipGeneration: 2,
      sinkOwnerGeneration: 2,
    }), 130)).toMatchObject({ ok: true });

    const gate = deps();
    expect(await requestVcMeetingManagedAction(request(), gate, 140)).toMatchObject({
      status: 409,
      body: {
        errorCode: 'stale_owner_generation',
        action: { status: 'rejected', ownerGeneration: 1 },
      },
    });
    expect(gate.authorize).not.toHaveBeenCalled();
  });

  it('does not let a delivery inherit a later sink owner generation on its first action', async () => {
    // The delivery was accepted under owner generation 1 in beforeEach. Its
    // first action arrives only after ownership has churned to generation 3.
    expect(applyVcMeetingMemberProjection(dir, projection({
      membershipGeneration: 2,
      sinkOwnerGeneration: 3,
    }), 130)).toMatchObject({ ok: true });

    const gate = deps();
    expect(await requestVcMeetingManagedAction(request(), gate, 140)).toMatchObject({
      status: 409,
      body: {
        errorCode: 'stale_owner_generation',
        action: {
          status: 'rejected',
          ownerGeneration: 1,
          errorCode: 'stale_owner_generation',
        },
      },
    });
    expect(gate.authorize).not.toHaveBeenCalled();
  });

  it('does not let stale attempt N poison the action before live attempt N+1', async () => {
    expect(markVcMeetingDeliveryAmbiguous(dir, {
      listenerAppId: LISTENER,
      meetingId: MEETING,
      memberId: MEMBER,
      memberEpoch: 1,
      deliveryKey: DELIVERY,
    }, { workerGeneration: 4, dispatchAttempt: 1 }, 130)).toMatchObject({
      ok: true,
      receipt: { status: 'ambiguous', dispatchAttempt: 1 },
    });
    expect(markVcMeetingDeliveryDispatched(dir, {
      listenerAppId: LISTENER,
      meetingId: MEETING,
      memberId: MEMBER,
      memberEpoch: 1,
      deliveryKey: DELIVERY,
    }, { receiverBootId: 'receiver-boot-1', workerGeneration: 5 }, 131)).toMatchObject({
      ok: true,
      receipt: { status: 'dispatched', dispatchAttempt: 2 },
    });
    const gate = deps();
    const stale = await requestVcMeetingManagedAction(request({ dispatchAttempt: 1 }), gate, 140);
    expect(stale).toMatchObject({
      status: 409,
      body: { errorCode: 'stale_dispatch_attempt' },
    });
    expect(stale.body).not.toHaveProperty('action');
    expect(gate.authorize).not.toHaveBeenCalled();

    const live = await requestVcMeetingManagedAction(request({ dispatchAttempt: 2 }), gate, 141);
    expect(live).toMatchObject({
      status: 202,
      body: { kind: 'execute', action: { status: 'attempting', attemptCount: 1 } },
    });
    expect(gate.authorize).toHaveBeenCalledTimes(1);
  });

  it('rejects a delivery from a superseded member epoch', async () => {
    expect(applyVcMeetingMemberProjection(dir, projection({
      memberEpoch: 2,
      membershipGeneration: 2,
      receiverSessionId: 'receiver-session-2',
    }), 130)).toMatchObject({ ok: true });
    const gate = deps();
    expect(await requestVcMeetingManagedAction(request(), gate, 140)).toMatchObject({
      status: 409,
      body: { errorCode: 'stale_member_epoch', action: { status: 'rejected' } },
    });
    expect(gate.authorize).not.toHaveBeenCalled();
  });

  it('rejects a removed current membership', async () => {
    expect(applyVcMeetingMemberProjection(dir, projection({
      membershipGeneration: 2,
      status: 'removed',
    }), 130)).toMatchObject({ ok: true });
    const gate = deps();
    expect(await requestVcMeetingManagedAction(request(), gate, 140)).toMatchObject({
      status: 409,
      body: { errorCode: 'membership_removed', action: { status: 'rejected' } },
    });
    expect(gate.authorize).not.toHaveBeenCalled();
  });

  it('replays a terminal action before current membership fencing', async () => {
    const gate = deps();
    const first = await requestVcMeetingManagedAction(request(), gate, 140);
    expect(first).toMatchObject({ status: 202, body: { kind: 'execute', action: { status: 'attempting' } } });
    if (!first.body.ok || first.body.kind !== 'execute') throw new Error('expected execution plan');
    expect(finishVcMeetingManagedActionProvider(dir, {
      listenerAppId: LISTENER,
      meetingId: MEETING,
      actionId: first.body.action.actionId,
      inputHash: first.body.action.inputHash,
      status: 'succeeded',
      externalRefs: { messageId: 'om_sent' },
    }, 150)).toMatchObject({ kind: 'updated', record: { status: 'succeeded' } });
    expect(completeVcMeetingDelivery(dir, {
      listenerAppId: LISTENER,
      meetingId: MEETING,
      memberId: MEMBER,
      memberEpoch: 1,
      deliveryKey: DELIVERY,
    }, { workerGeneration: 4, dispatchAttempt: 1 }, 155)).toMatchObject({
      ok: true,
      receipt: { status: 'completed' },
    });
    expect(applyVcMeetingMemberProjection(dir, projection({
      membershipGeneration: 2,
      status: 'removed',
    }), 160)).toMatchObject({ ok: true });

    const replay = await requestVcMeetingManagedAction(request(), gate, 170);
    expect(replay).toMatchObject({
      status: 200,
      body: { kind: 'existing', action: { status: 'succeeded', externalRefs: { messageId: 'om_sent' } } },
    });
    expect(gate.authorize).toHaveBeenCalledTimes(1);
  });

  it('returns 409 for the same action identity with different provider input', async () => {
    const gate = deps();
    const first = await requestVcMeetingManagedAction(request(), gate, 140);
    expect(first).toMatchObject({ status: 202, body: { kind: 'execute' } });
    const conflict = await requestVcMeetingManagedAction(request({
      content: 'Changed content',
      reason: 'A changed reason is not the problem',
    }), gate, 150);
    expect(conflict).toMatchObject({
      status: 409,
      body: { errorCode: 'action_input_mismatch', action: { status: 'attempting' } },
    });
    expect((conflict.body as { error: string }).error).toContain('do not change content or slot');
  });

  it('write-ahead claims an allowed provider action only once', async () => {
    const gate = deps();
    const first = await requestVcMeetingManagedAction(request({ content: '  Hello\n meeting  ' }), gate, 140);
    expect(first).toMatchObject({
      status: 202,
      body: {
        kind: 'execute',
        action: {
          status: 'attempting',
          attemptCount: 1,
          ownerGeneration: 1,
          source: { kind: 'delivery', key: DELIVERY, deliverySeq: 7 },
        },
        plan: {
          channel: 'text',
          sink: 'meeting_text',
          content: 'Hello meeting',
          ambiguousRecovery: 'lookup_or_idempotent_retry',
        },
      },
    });
    const second = await requestVcMeetingManagedAction(request({
      content: 'Hello meeting',
      reason: 'Reason changes are not provider input',
    }), gate, 150);
    expect(second).toMatchObject({
      status: 200,
      body: { kind: 'existing', action: { status: 'attempting', attemptCount: 1 } },
    });
    expect(gate.authorize).toHaveBeenCalledTimes(1);
  });

  it('write-ahead claims one approval card then claims provider only after approval', async () => {
    const gate = deps({ kind: 'approval' });
    const first = await requestVcMeetingManagedAction(request(), gate, 140);
    expect(first).toMatchObject({
      status: 202,
      body: {
        kind: 'needsApproval',
        action: {
          status: 'pendingApproval',
          approvalCard: { status: 'attempting', attemptCount: 1 },
        },
        plan: { channel: 'text', content: 'Hello meeting' },
      },
    });
    if (!first.body.ok || first.body.kind !== 'needsApproval') throw new Error('expected approval plan');
    const action = first.body.action;
    const replay = await requestVcMeetingManagedAction(request(), gate, 141);
    expect(replay).toMatchObject({
      status: 200,
      body: { kind: 'existing', action: { approvalCard: { status: 'attempting', attemptCount: 1 } } },
    });
    expect(gate.authorize).toHaveBeenCalledTimes(1);

    expect(finishVcMeetingManagedApprovalCard(dir, {
      listenerAppId: LISTENER,
      meetingId: MEETING,
      actionId: action.actionId,
      inputHash: action.inputHash,
      status: 'presented',
      externalRefs: { cardMessageId: 'om_approval' },
    }, 150)).toMatchObject({ kind: 'updated', record: { approvalCard: { status: 'presented' } } });
    const approved = await resolveVcMeetingManagedActionApproval(dir, {
      listenerAppId: LISTENER,
      meetingId: MEETING,
      actionId: action.actionId,
      inputHash: action.inputHash,
    }, 'approved', {
      externalRefs: { operatorOpenId: 'ou_operator' },
      revalidate: async () => ({ kind: 'allow' }),
    }, 160);
    expect(approved).toMatchObject({
      kind: 'execute',
      action: { status: 'attempting', attemptCount: 1 },
      plan: { providerKey: action.providerKey },
    });
  });

  it('expires a pending approval when the member is removed before the click', async () => {
    const first = await requestVcMeetingManagedAction(request(), deps({ kind: 'approval' }), 140);
    if (!first.body.ok || first.body.kind !== 'needsApproval') throw new Error('expected approval plan');
    expect(applyVcMeetingMemberProjection(dir, projection({
      membershipGeneration: 2,
      status: 'removed',
    }), 150)).toMatchObject({ ok: true });
    const revalidate = vi.fn(async () => ({ kind: 'allow' as const }));

    expect(await resolveVcMeetingManagedActionApproval(dir, {
      listenerAppId: LISTENER,
      meetingId: MEETING,
      actionId: first.body.action.actionId,
      inputHash: first.body.action.inputHash,
    }, 'approved', { revalidate }, 160)).toMatchObject({
      kind: 'resolved',
      action: {
        status: 'expired',
        attemptCount: 0,
        errorCode: 'membership_removed',
      },
    });
    expect(revalidate).not.toHaveBeenCalled();
  });

  it('expires a pending approval when a newer member epoch supersedes it', async () => {
    const first = await requestVcMeetingManagedAction(request(), deps({ kind: 'approval' }), 140);
    if (!first.body.ok || first.body.kind !== 'needsApproval') throw new Error('expected approval plan');
    expect(applyVcMeetingMemberProjection(dir, projection({
      memberEpoch: 2,
      membershipGeneration: 2,
      receiverSessionId: 'receiver-session-2',
    }), 150)).toMatchObject({ ok: true });
    const revalidate = vi.fn(async () => ({ kind: 'allow' as const }));

    expect(await resolveVcMeetingManagedActionApproval(dir, {
      listenerAppId: LISTENER,
      meetingId: MEETING,
      actionId: first.body.action.actionId,
      inputHash: first.body.action.inputHash,
    }, 'approved', { revalidate }, 160)).toMatchObject({
      kind: 'resolved',
      action: {
        status: 'expired',
        attemptCount: 0,
        errorCode: 'stale_member_epoch',
      },
    });
    expect(revalidate).not.toHaveBeenCalled();
  });

  it('expires a pending approval when sink ownership changes before the click', async () => {
    const first = await requestVcMeetingManagedAction(request(), deps({ kind: 'approval' }), 140);
    if (!first.body.ok || first.body.kind !== 'needsApproval') throw new Error('expected approval plan');
    expect(applyVcMeetingMemberProjection(dir, projection({
      membershipGeneration: 2,
      sinkOwnerGeneration: 2,
    }), 150)).toMatchObject({ ok: true });
    const revalidate = vi.fn(async () => ({ kind: 'allow' as const }));

    expect(await resolveVcMeetingManagedActionApproval(dir, {
      listenerAppId: LISTENER,
      meetingId: MEETING,
      actionId: first.body.action.actionId,
      inputHash: first.body.action.inputHash,
    }, 'approved', { revalidate }, 160)).toMatchObject({
      kind: 'resolved',
      action: {
        status: 'expired',
        attemptCount: 0,
        errorCode: 'stale_owner_generation',
      },
    });
    expect(revalidate).not.toHaveBeenCalled();
  });

  it('rechecks member fences after an asynchronous approval hook', async () => {
    const first = await requestVcMeetingManagedAction(request(), deps({ kind: 'approval' }), 140);
    if (!first.body.ok || first.body.kind !== 'needsApproval') throw new Error('expected approval plan');
    const revalidate = vi.fn(async () => {
      expect(applyVcMeetingMemberProjection(dir, projection({
        membershipGeneration: 2,
        sinkOwnerGeneration: 2,
      }), 155)).toMatchObject({ ok: true });
      return { kind: 'allow' as const };
    });

    expect(await resolveVcMeetingManagedActionApproval(dir, {
      listenerAppId: LISTENER,
      meetingId: MEETING,
      actionId: first.body.action.actionId,
      inputHash: first.body.action.inputHash,
    }, 'approved', { revalidate }, 160)).toMatchObject({
      kind: 'resolved',
      action: {
        status: 'expired',
        attemptCount: 0,
        errorCode: 'stale_owner_generation',
      },
    });
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it('revalidates the live meeting phase before claiming an approved action', async () => {
    const first = await requestVcMeetingManagedAction(request(), deps({ kind: 'approval' }), 140);
    if (!first.body.ok || first.body.kind !== 'needsApproval') throw new Error('expected approval plan');
    const revalidate = vi.fn(async () => ({
      kind: 'deny' as const,
      reason: 'meeting_phase_closed' as const,
    }));

    expect(await resolveVcMeetingManagedActionApproval(dir, {
      listenerAppId: LISTENER,
      meetingId: MEETING,
      actionId: first.body.action.actionId,
      inputHash: first.body.action.inputHash,
    }, 'approved', { revalidate }, 160)).toMatchObject({
      kind: 'resolved',
      action: {
        status: 'expired',
        attemptCount: 0,
        errorCode: 'meeting_phase_closed',
      },
    });
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it('durably rejects a denied output policy and replays that terminal decision', async () => {
    const gate = deps({ kind: 'deny', reason: 'output_policy_denied' });
    const denied = await requestVcMeetingManagedAction(request(), gate, 140);
    expect(denied).toMatchObject({
      status: 403,
      body: {
        errorCode: 'output_policy_denied',
        action: { status: 'rejected', errorCode: 'output_policy_denied', finishedAt: 140 },
      },
    });
    const replay = await requestVcMeetingManagedAction(request(), gate, 150);
    expect(replay).toMatchObject({
      status: 200,
      body: { kind: 'existing', action: { status: 'rejected', errorCode: 'output_policy_denied' } },
    });
    expect(gate.authorize).toHaveBeenCalledTimes(1);
  });

  it('keeps voice fallback in provider input and marks ambiguous recovery manual', async () => {
    const gate = deps();
    const result = await requestVcMeetingManagedAction(request({
      channel: 'voice',
      content: 'Speak this',
      fallbackText: 'Post this if voice is unavailable',
    }), gate, 140);
    expect(result).toMatchObject({
      status: 202,
      body: {
        kind: 'execute',
        action: {
          sink: 'meeting_voice',
          canonicalInput: { content: 'Speak this', fallbackText: 'Post this if voice is unavailable' },
        },
        plan: {
          channel: 'voice',
          sink: 'meeting_voice',
          fallbackText: 'Post this if voice is unavailable',
          ambiguousRecovery: 'manual_unknown',
        },
      },
    });
    if (!result.body.ok || result.body.kind !== 'execute') throw new Error('expected voice plan');
    expect(finishVcMeetingManagedActionProvider(dir, {
      listenerAppId: LISTENER,
      meetingId: MEETING,
      actionId: result.body.action.actionId,
      inputHash: result.body.action.inputHash,
      status: 'unknown',
      errorCode: 'voice_result_unknown_manual_review',
    }, 150)).toMatchObject({ kind: 'updated', record: { status: 'unknown' } });
  });

  it('derives an IM source from receiver + Lark message and claims a task action once', async () => {
    const gate = imDeps();
    const sourceKey = deriveVcMeetingImTurnSourceKey(SESSION, 'om_explicit_user_1');
    expect(sourceKey).toMatch(/^vci_[0-9a-f]{46}$/);
    expect(sourceKey).toHaveLength(50);
    expect(deriveVcMeetingImTurnSourceKey(SESSION, 'om_explicit_user_1')).toBe(sourceKey);
    expect(deriveVcMeetingImTurnSourceKey('another-session', 'om_explicit_user_1')).not.toBe(sourceKey);

    const first = await requestVcMeetingManagedImAction(imRequest(), gate, 140);
    expect(first).toMatchObject({
      status: 202,
      body: {
        kind: 'execute',
        action: {
          status: 'attempting',
          attemptCount: 1,
          sink: 'task',
          ownerGeneration: 1,
          source: {
            kind: 'im_turn',
            key: sourceKey,
            larkMessageId: 'om_explicit_user_1',
          },
        },
        plan: {
          sink: 'task',
          canonicalInput: {
            mode: 'sync',
            items: [{ summary: 'Send the launch note', assigneeOpenIds: ['ou_owner'] }],
          },
          ambiguousRecovery: 'lookup_or_idempotent_retry',
        },
      },
    });

    // The explicit IM turn has no delivery receipt/dispatchAttempt. Its exact
    // Lark message retry replays the durable provider claim instead.
    const replay = await requestVcMeetingManagedImAction(imRequest({
      reason: 'A transport retry may carry a different display reason',
    }), gate, 150);
    expect(replay).toMatchObject({
      status: 200,
      body: { kind: 'existing', action: { status: 'attempting', attemptCount: 1 } },
    });
    expect(gate.authorize).toHaveBeenCalledTimes(1);
    expect(gate.authorize.mock.calls[0]![0]).toMatchObject({
      sink: 'task',
      projection: { receiverSessionId: SESSION, memberEpoch: 1 },
      request: { origin: { larkMessageId: 'om_explicit_user_1' } },
    });
  });

  it('claims one approval presentation for an IM-origin meeting output retry', async () => {
    const gate = imDeps({ kind: 'approval' });
    const action = imRequest({
      origin: imOrigin({ larkMessageId: 'om_say_this' }),
      sink: 'meeting_text',
      canonicalInput: { content: 'We will post the decision after the meeting.' },
      reason: 'User explicitly requested a meeting response',
    });
    const first = await requestVcMeetingManagedImAction(action, gate, 140);
    expect(first).toMatchObject({
      status: 202,
      body: {
        kind: 'needsApproval',
        action: {
          status: 'pendingApproval',
          source: { kind: 'im_turn', larkMessageId: 'om_say_this' },
          approvalCard: { status: 'attempting', attemptCount: 1 },
        },
        plan: {
          sink: 'meeting_text',
          canonicalInput: { content: 'We will post the decision after the meeting.' },
          reason: 'User explicitly requested a meeting response',
        },
      },
    });
    const replay = await requestVcMeetingManagedImAction(action, gate, 141);
    expect(replay).toMatchObject({
      status: 200,
      body: {
        kind: 'existing',
        action: { status: 'pendingApproval', approvalCard: { attemptCount: 1 } },
      },
    });
    expect(gate.authorize).toHaveBeenCalledTimes(1);
  });

  it('fences a new IM action when the trusted sink-owner snapshot is stale', async () => {
    expect(applyVcMeetingMemberProjection(dir, projection({
      membershipGeneration: 2,
      sinkOwnerGeneration: 2,
    }), 130)).toMatchObject({ ok: true });

    const gate = imDeps();
    expect(await requestVcMeetingManagedImAction(imRequest({
      origin: imOrigin({ larkMessageId: 'om_stale_sink_owner' }),
    }), gate, 140)).toMatchObject({
      status: 409,
      body: {
        errorCode: 'stale_owner_generation',
        action: { status: 'rejected', ownerGeneration: 1 },
      },
    });
    expect(gate.authorize).not.toHaveBeenCalled();
  });

  it('fences a new IM action from a retired meeting owner boot/epoch', async () => {
    expect(applyVcMeetingMemberProjection(dir, projection({
      ownerBootId: 'owner-boot-2',
      ownerEpoch: 2,
    }), 130)).toMatchObject({ ok: true });

    const gate = imDeps();
    expect(await requestVcMeetingManagedImAction(imRequest({
      origin: imOrigin({ larkMessageId: 'om_stale_hub_owner' }),
    }), gate, 140)).toMatchObject({
      status: 409,
      body: { errorCode: 'stale_owner_epoch', action: { status: 'rejected' } },
    });
    expect(gate.authorize).not.toHaveBeenCalled();
  });

  it('fences a new IM action from a superseded member epoch', async () => {
    expect(applyVcMeetingMemberProjection(dir, projection({
      memberEpoch: 2,
      membershipGeneration: 2,
      receiverSessionId: 'receiver-session-2',
    }), 130)).toMatchObject({ ok: true });

    const gate = imDeps();
    expect(await requestVcMeetingManagedImAction(imRequest({
      origin: imOrigin({ larkMessageId: 'om_stale_member' }),
    }), gate, 140)).toMatchObject({
      status: 409,
      body: { errorCode: 'stale_member_epoch', action: { status: 'rejected' } },
    });
    expect(gate.authorize).not.toHaveBeenCalled();
  });

  it('rejects a wrong receiver before creating or disclosing an IM action', async () => {
    const gate = imDeps();
    expect(await requestVcMeetingManagedImAction(imRequest({
      origin: imOrigin({
        receiverSessionId: 'receiver-session-hijack',
        larkMessageId: 'om_wrong_receiver',
      }),
    }), gate, 140)).toMatchObject({
      status: 409,
      body: { errorCode: 'receiver_session_mismatch' },
    });
    expect(gate.authorize).not.toHaveBeenCalled();
    expect(listVcMeetingActions(dir, { listenerAppId: LISTENER, meetingId: MEETING })).toEqual([]);
  });

  it('does not let a sibling consumer daemon inspect or poison the action ledger', async () => {
    const gate = { ...deps(), selfAgentAppId: 'another-agent' };
    expect(await requestVcMeetingManagedAction(request(), gate, 140)).toMatchObject({
      status: 409,
      body: { errorCode: 'wrong_agent' },
    });
    expect(listVcMeetingActions(dir, { listenerAppId: LISTENER, meetingId: MEETING })).toEqual([]);
    expect(findVcMeetingAction(dir, { listenerAppId: LISTENER, meetingId: MEETING }, 'missing')).toBeUndefined();
  });
});
