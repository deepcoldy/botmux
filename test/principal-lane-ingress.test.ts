import { describe, expect, it, vi } from 'vitest';
import type {
  MessageProvenance,
  PrincipalLaneBinding,
  PrincipalLaneDisplayTarget,
  PrincipalLaneSourceState,
  Session,
} from '../src/types.js';
import {
  decidePrincipalLaneIngress,
  materializePrincipalLaneIngress,
  planPrincipalLaneIngress,
  validPrincipalLaneIngressFence,
  type PrincipalLaneActiveTurnAuthority,
  type PrincipalLaneAuthorityFailure,
  type PrincipalLaneIngressAuthorityReader,
  type PrincipalLaneIngressPlan,
  type PrincipalLaneReferenceAuthority,
  type PrincipalLaneSessionAuthority,
  type PrincipalLaneSourceAuthority,
} from '../src/core/principal-lane-ingress.js';
import {
  PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION,
  principalWorkspaceGroupIdV2,
} from '../src/core/principal-workspace-admission.js';

const appId = 'app-ingress';
const sourceSessionId = 'session-source';
const timestamp = '2026-09-19T09:00:00.000Z';
const displayTarget: PrincipalLaneDisplayTarget = {
  scope: 'thread',
  larkAppId: appId,
  chatId: 'chat-ingress',
  rootMessageId: 'root-ingress',
};

function binding(args: {
  laneId: string;
  principalKey: string;
  revision?: number;
  phase?: PrincipalLaneBinding['phase'];
}): PrincipalLaneBinding {
  return {
    version: 1,
    laneId: args.laneId,
    sourceSessionId,
    principalKey: args.principalKey,
    principal: args.principalKey.startsWith('user:union:')
      ? { senderType: 'user', kind: 'union', unionId: args.principalKey.slice('user:union:'.length) }
      : {
          senderType: 'user',
          kind: 'app_open',
          larkAppId: appId,
          openId: args.principalKey.slice(`user:app:${appId}:open:`.length),
        },
    routingAnchor: `principal-lane:${args.laneId}`,
    displayTarget,
    workspaceEpoch: 3,
    phase: args.phase ?? 'active',
    revision: args.revision ?? 4,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const sourceLane = binding({ laneId: 'source', principalKey: 'user:union:on_a', revision: 7 });
const sourceState: PrincipalLaneSourceState = {
  version: 1,
  sourcePrincipalKey: 'user:union:on_a',
  displayTarget,
  canonicalCwd: '/workspace/repo',
  workspaceEpoch: 3,
  workspaceGroupId: principalWorkspaceGroupIdV2(appId, '/workspace/repo'),
  workspaceGroupKeyVersion: PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION,
  phase: 'active',
  revision: 8,
  updatedAt: timestamp,
};
const sourceAuthority: PrincipalLaneSourceAuthority = {
  sourceSessionId,
  source: sourceState,
  lane: sourceLane,
};
const laneB: PrincipalLaneSessionAuthority = {
  lane: binding({ laneId: 'lane-b', principalKey: 'user:union:on_b', revision: 5 }),
  sessionId: 'session-b',
};
const laneC: PrincipalLaneSessionAuthority = {
  lane: binding({ laneId: 'lane-c', principalKey: 'user:union:on_c', revision: 6 }),
  sessionId: 'session-c',
};

function provenance(
  lane: PrincipalLaneSessionAuthority,
  overrides: Partial<MessageProvenance> = {},
): MessageProvenance {
  return {
    messageId: 'om-parent',
    larkAppId: appId,
    chatId: displayTarget.chatId,
    displayRootId: displayTarget.scope === 'thread' ? displayTarget.rootMessageId : undefined,
    sourceSessionId,
    laneId: lane.lane.laneId,
    sessionId: lane.sessionId,
    turnId: 'om-turn',
    principalKey: lane.lane.principalKey,
    workerGeneration: 11,
    direction: 'outbound',
    trustState: 'trusted',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function activeTurn(
  lane: PrincipalLaneSessionAuthority,
  overrides: Partial<PrincipalLaneActiveTurnAuthority> = {},
): PrincipalLaneActiveTurnAuthority {
  return {
    sessionId: lane.sessionId,
    laneId: lane.lane.laneId,
    principalKey: lane.lane.principalKey,
    turnId: 'om-turn',
    workerGeneration: 11,
    state: 'active',
    ...overrides,
  };
}

function reference(
  lane: PrincipalLaneSessionAuthority,
  turn?: PrincipalLaneActiveTurnAuthority,
  provenanceOverrides: Partial<MessageProvenance> = {},
): PrincipalLaneReferenceAuthority {
  return { provenance: provenance(lane, provenanceOverrides), lane, ...(turn ? { activeTurn: turn } : {}) };
}

function request(overrides: Partial<Parameters<typeof planPrincipalLaneIngress>[0]> = {}) {
  return {
    senderType: 'user' as const,
    larkAppId: appId,
    unionId: 'on_b',
    openId: 'ou_b',
    sourceSessionId,
    eventDisplayTarget: displayTarget,
    intent: 'none' as const,
    ...overrides,
  };
}

function reader(args: {
  callerLane?: PrincipalLaneSessionAuthority;
  callerFailure?: PrincipalLaneAuthorityFailure;
  reference?: PrincipalLaneReferenceAuthority;
} = {}): PrincipalLaneIngressAuthorityReader & {
  readSource: ReturnType<typeof vi.fn>;
  readCallerLane: ReturnType<typeof vi.fn>;
  readReference: ReturnType<typeof vi.fn>;
} {
  return {
    readSource: vi.fn(() => ({ status: 'ready', value: sourceAuthority })),
    readCallerLane: vi.fn(() => {
      if (args.callerFailure) return { status: 'failure', failure: args.callerFailure };
      return args.callerLane
        ? { status: 'ready', value: args.callerLane }
        : { status: 'missing' };
    }),
    readReference: vi.fn(() => args.reference
      ? { status: 'ready', value: args.reference }
      : { status: 'missing' }),
  } as any;
}

describe('principal lane ingress planning', () => {
  it('returns bot explicit-as before touching any human lane authority', () => {
    const authority = reader();
    expect(planPrincipalLaneIngress(request({
      senderType: 'bot',
      unionId: 'on_bot',
      openId: 'ou_bot',
      parentId: 'om-parent',
    }), authority)).toEqual({ kind: 'bot_explicit_as' });
    expect(authority.readSource).not.toHaveBeenCalled();
    expect(authority.readCallerLane).not.toHaveBeenCalled();
    expect(authority.readReference).not.toHaveBeenCalled();
  });

  it('makes explicit new-topic absolute without reading provenance or materializing a lane', () => {
    const authority = reader({ callerLane: laneB, reference: reference(laneC, activeTurn(laneC)) });
    const plan = planPrincipalLaneIngress(request({
      intent: 'explicit_new_topic',
      parentId: 'om-parent',
    }), authority);
    expect(plan).toEqual({ kind: 'new_topic' });
    expect(authority.readSource).not.toHaveBeenCalled();
    expect(authority.readCallerLane).not.toHaveBeenCalled();
    expect(authority.readReference).not.toHaveBeenCalled();
    const ensureShadowLane = vi.fn();
    expect(materializePrincipalLaneIngress(plan, { ensureShadowLane })).toBe(plan);
    expect(ensureShadowLane).not.toHaveBeenCalled();
  });

  it('ignores root_id/thread_id when parent_id is absent', () => {
    const authority = reader({ callerLane: laneB, reference: reference(laneC, activeTurn(laneC)) });
    expect(planPrincipalLaneIngress(request({
      rootId: 'om-root-lookalike',
      threadId: 'omt-thread-lookalike',
    }), authority)).toMatchObject({
      kind: 'route_lane', reason: 'existing_caller_lane', lane: { laneId: 'lane-b' },
    });
    expect(authority.readReference).not.toHaveBeenCalled();
  });

  it('routes an idle source principal back to durable lane zero', () => {
    const authority = reader();
    expect(planPrincipalLaneIngress(request({ unionId: 'on_a', openId: 'ou_a' }), authority))
      .toMatchObject({
        kind: 'route_lane', reason: 'existing_caller_lane', lane: { laneId: 'source' },
        fence: { callerPrincipalKey: 'user:union:on_a', sessionId: sourceSessionId },
      });
    expect(authority.readCallerLane).not.toHaveBeenCalled();
  });

  it('routes a trusted own-lane reference even when its turn is old or terminal', () => {
    const ownReference = reference(laneB, activeTurn(laneB, {
      state: 'terminal', turnId: 'different-old-turn', workerGeneration: 99,
    }));
    expect(planPrincipalLaneIngress(request({ parentId: 'om-parent' }), reader({
      callerLane: laneB,
      reference: ownReference,
    }))).toMatchObject({
      kind: 'route_lane', reason: 'trusted_own_reference', lane: { laneId: 'lane-b' },
    });
  });

  it('does not let a caller-lane quarantine override a trusted own reference', () => {
    const authority = reader({
      callerFailure: { kind: 'quarantined', reason: 'caller_lane_quarantined' },
      reference: reference(laneB),
    });
    expect(planPrincipalLaneIngress(request({ parentId: 'om-parent' }), authority)).toMatchObject({
      kind: 'route_lane', reason: 'trusted_own_reference', lane: { laneId: 'lane-b' },
    });
    expect(authority.readCallerLane).not.toHaveBeenCalled();
  });

  it('permits cross-human suggestion only for the exact current turn and generation', () => {
    const current = reference(laneC, activeTurn(laneC));
    expect(planPrincipalLaneIngress(request({ parentId: 'om-parent' }), reader({
      callerLane: laneB,
      reference: current,
    }))).toMatchObject({
      kind: 'suggestion',
      fence: {
        callerPrincipalKey: 'user:union:on_b',
        provenanceMessageId: 'om-parent',
        targetTurnId: 'om-turn',
        workerGeneration: 11,
      },
    });

    for (const stale of [
      reference(laneC, activeTurn(laneC, { state: 'terminal' })),
      reference(laneC, activeTurn(laneC, { turnId: 'om-other' })),
      reference(laneC, activeTurn(laneC, { workerGeneration: 12 })),
    ]) {
      expect(planPrincipalLaneIngress(request({ parentId: 'om-parent' }), reader({
        callerLane: laneB,
        reference: stale,
      }))).toMatchObject({
        kind: 'route_lane', reason: 'existing_caller_lane', lane: { laneId: 'lane-b' },
      });
      expect(planPrincipalLaneIngress(request({
        parentId: 'om-parent', intent: 'explicit_suggest_current',
      }), reader({ callerLane: laneB, reference: stale }))).toEqual({
        kind: 'reject_suggestion', reason: 'missing_current_task_reference',
      });
    }
  });

  it('does not let a caller identity conflict override a trusted foreign suggestion', () => {
    const authority = reader({
      callerFailure: { kind: 'identity_conflict', reason: 'caller_identity_conflict' },
      reference: reference(laneC, activeTurn(laneC)),
    });
    expect(planPrincipalLaneIngress(request({ parentId: 'om-parent' }), authority)).toMatchObject({
      kind: 'suggestion',
      targetLane: { laneId: 'lane-c' },
    });
    expect(authority.readCallerLane).not.toHaveBeenCalled();
  });

  it('rejects an invalid explicit suggestion before reading an unhealthy caller lane', () => {
    const authority = reader({
      callerFailure: { kind: 'quarantined', reason: 'caller_lane_quarantined' },
    });
    expect(planPrincipalLaneIngress(request({
      intent: 'explicit_suggest_current',
      parentId: 'om-missing',
    }), authority)).toEqual({
      kind: 'reject_suggestion', reason: 'missing_current_task_reference',
    });
    expect(authority.readCallerLane).not.toHaveBeenCalled();
  });

  it('surfaces a caller-lane failure only after reference and suggestion paths miss', () => {
    const failure: PrincipalLaneAuthorityFailure = {
      kind: 'identity_conflict', reason: 'caller_identity_conflict',
    };
    const authority = reader({ callerFailure: failure });
    expect(planPrincipalLaneIngress(request(), authority)).toEqual(failure);
    expect(authority.readCallerLane).toHaveBeenCalledOnce();
    expect(authority.readReference).not.toHaveBeenCalled();
  });

  it('fails a cross-display or untrusted parent closed and falls back to caller lane', () => {
    for (const invalid of [
      reference(laneC, activeTurn(laneC), { chatId: 'chat-other' }),
      reference(laneC, activeTurn(laneC), { trustState: 'untrusted' }),
      reference(laneC, activeTurn(laneC), { sourceSessionId: 'source-other' }),
    ]) {
      expect(planPrincipalLaneIngress(request({ parentId: 'om-parent' }), reader({
        callerLane: laneB,
        reference: invalid,
      }))).toMatchObject({ kind: 'route_lane', lane: { laneId: 'lane-b' } });
    }
  });

  it('rejects an inbound app that does not match the durable source target', () => {
    expect(planPrincipalLaneIngress(request({ larkAppId: 'app-other' }), reader({
      callerLane: laneB,
    }))).toEqual({ kind: 'retry', reason: 'invalid_source_authority' });
  });

  it('materializes only create-lane and forwards the source authority fence', () => {
    const plan = planPrincipalLaneIngress(request({ title: 'B task' }), reader());
    expect(plan).toMatchObject({
      kind: 'create_lane',
      sourceFence: {
        callerPrincipalKey: 'user:union:on_b',
        sourceRevision: 8,
        sourceLaneRevision: 7,
        workspaceEpoch: 3,
      },
    });
    if (plan.kind !== 'create_lane') throw new Error('expected create plan');
    const child: Session = {
      sessionId: 'session-b-created',
      chatId: displayTarget.chatId,
      rootMessageId: displayTarget.scope === 'thread' ? displayTarget.rootMessageId : 'trace',
      scope: displayTarget.scope,
      title: 'B task',
      status: 'active',
      createdAt: timestamp,
    };
    const createdLane = binding({ laneId: 'lane-b-created', principalKey: 'user:union:on_b' });
    child.principalLane = createdLane;
    const ensureShadowLane = vi.fn(() => ({
      status: 'ready' as const,
      created: true,
      lane: createdLane,
      session: child,
    }));
    expect(materializePrincipalLaneIngress(plan, { ensureShadowLane })).toMatchObject({
      kind: 'route_lane', reason: 'materialized_caller_lane',
      fence: { laneId: 'lane-b-created', sessionId: 'session-b-created' },
    });
    expect(ensureShadowLane).toHaveBeenCalledWith({
      sourceSessionId,
      identity: { larkAppId: appId, unionId: 'on_b', openId: 'ou_b' },
      title: 'B task',
      expectedSource: {
        sourcePrincipalKey: 'user:union:on_a',
        sourceRevision: 8,
        sourceLaneRevision: 7,
        workspaceEpoch: 3,
        canonicalCwd: '/workspace/repo',
        workspaceGroupId: principalWorkspaceGroupIdV2(appId, '/workspace/repo'),
        workspaceGroupKeyVersion: PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION,
        displayTarget,
      },
    });
  });

  it('does not materialize route, suggestion, reject, retry, or bot plans', () => {
    const ensureShadowLane = vi.fn();
    const plans: PrincipalLaneIngressPlan[] = [
      planPrincipalLaneIngress(request(), reader({ callerLane: laneB })),
      planPrincipalLaneIngress(request({ parentId: 'om-parent' }), reader({
        callerLane: laneB, reference: reference(laneC, activeTurn(laneC)),
      })),
      { kind: 'reject_suggestion', reason: 'missing_current_task_reference' },
      { kind: 'retry', reason: 'busy' },
      { kind: 'bot_explicit_as' },
    ];
    for (const plan of plans) expect(materializePrincipalLaneIngress(plan, { ensureShadowLane })).toBe(plan);
    expect(ensureShadowLane).not.toHaveBeenCalled();
  });

  it('invalidates a frozen route fence when source or lane revision changes', () => {
    const plan = planPrincipalLaneIngress(request(), reader({ callerLane: laneB }));
    if (plan.kind !== 'route_lane') throw new Error('expected route plan');
    expect(validPrincipalLaneIngressFence(plan, { source: sourceAuthority, lane: laneB })).toBe(true);
    expect(validPrincipalLaneIngressFence(plan, {
      source: {
        ...sourceAuthority,
        source: { ...sourceState, revision: sourceState.revision + 1 },
      },
      lane: laneB,
    })).toBe(false);
    expect(validPrincipalLaneIngressFence(plan, {
      source: {
        ...sourceAuthority,
        source: { ...sourceState, canonicalCwd: '/workspace/other' },
      },
      lane: laneB,
    })).toBe(false);
    expect(validPrincipalLaneIngressFence(plan, {
      source: {
        ...sourceAuthority,
        source: { ...sourceState, workspaceGroupId: 'principal-workspace-v2:other' },
      },
      lane: laneB,
    })).toBe(false);
    expect(validPrincipalLaneIngressFence(plan, {
      source: {
        ...sourceAuthority,
        source: { ...sourceState, workspaceGroupKeyVersion: undefined },
      },
      lane: laneB,
    })).toBe(false);
    expect(validPrincipalLaneIngressFence(plan, {
      source: sourceAuthority,
      lane: { ...laneB, lane: { ...laneB.lane, revision: laneB.lane.revision + 1 } },
    })).toBe(false);
    expect(validPrincipalLaneIngressFence(plan, {
      source: {
        ...sourceAuthority,
        source: { ...sourceState, phase: 'closing' },
      },
      lane: laneB,
    })).toBe(false);
    expect(validPrincipalLaneIngressFence(plan, {
      source: sourceAuthority,
      lane: { ...laneB, lane: { ...laneB.lane, phase: 'closed' } },
    })).toBe(false);
    expect(validPrincipalLaneIngressFence(plan, {
      source: sourceAuthority,
      lane: {
        ...laneB,
        lane: {
          ...laneB.lane,
          principal: { senderType: 'user', kind: 'union', unionId: 'on_other' },
        },
      },
    })).toBe(false);
  });

  it('revalidates suggestion provenance and live turn in addition to source/lane fence', () => {
    const targetReference = reference(laneC, activeTurn(laneC));
    const plan = planPrincipalLaneIngress(request({ parentId: 'om-parent' }), reader({
      callerLane: laneB,
      reference: targetReference,
    }));
    if (plan.kind !== 'suggestion') throw new Error('expected suggestion plan');
    expect(validPrincipalLaneIngressFence(plan, {
      source: sourceAuthority,
      lane: laneC,
      provenance: targetReference.provenance,
      activeTurn: targetReference.activeTurn,
    })).toBe(true);
    expect(validPrincipalLaneIngressFence(plan, {
      source: sourceAuthority,
      lane: laneC,
      provenance: targetReference.provenance,
      activeTurn: activeTurn(laneC, { workerGeneration: 12 }),
    })).toBe(false);
    expect(validPrincipalLaneIngressFence(plan, {
      source: sourceAuthority,
      lane: laneC,
      provenance: { ...targetReference.provenance, principalKey: laneB.lane.principalKey },
      activeTurn: targetReference.activeTurn,
    })).toBe(false);
  });

  it('keeps the pure decision independent from durable readers', () => {
    expect(decidePrincipalLaneIngress({
      request: request({ intent: 'explicit_new_topic', parentId: 'om-parent' }),
    })).toEqual({ kind: 'new_topic' });
  });
});
