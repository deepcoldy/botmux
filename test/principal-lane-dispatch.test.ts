import { describe, expect, it, vi } from 'vitest';
import type {
  PrincipalLaneBinding,
  PrincipalLaneDisplayTarget,
  PrincipalLaneSourceState,
  PrincipalLaneWorktreeProof,
} from '../src/types.js';
import {
  createPrincipalLaneDispatchContext,
  executePrincipalLaneOutput,
  revalidatePrincipalLaneDispatchCapability,
  type PrincipalLaneDispatchAuthority,
  type PrincipalLaneDispatchCapability,
} from '../src/core/principal-lane-dispatch.js';
import type {
  PrincipalLaneIngressPlan,
  PrincipalLaneSessionAuthority,
  PrincipalLaneSourceAuthority,
} from '../src/core/principal-lane-ingress.js';
import {
  PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION,
  principalWorkspaceGroupIdV2,
} from '../src/core/principal-workspace-admission.js';
import { principalLaneWorktreeMaterializationId } from '../src/core/principal-lane-worktree.js';

const timestamp = '2026-09-19T10:00:00.000Z';
const sourceSessionId = 'source-session';
const appId = 'cli_dispatch_app';

function target(scope: 'chat' | 'thread' = 'thread'): PrincipalLaneDisplayTarget {
  return scope === 'chat'
    ? { scope, larkAppId: appId, chatId: 'chat-shared' }
    : { scope, larkAppId: appId, chatId: 'chat-shared', rootMessageId: 'root-shared' };
}

function binding(args: {
  laneId: string;
  principalKey: string;
  displayTarget?: PrincipalLaneDisplayTarget;
  phase?: PrincipalLaneBinding['phase'];
  revision?: number;
  workspaceEpoch?: number;
}): PrincipalLaneBinding {
  return {
    version: 1,
    laneId: args.laneId,
    sourceSessionId,
    principalKey: args.principalKey,
    principal: { senderType: 'user', kind: 'union', unionId: args.principalKey.split(':').at(-1)! },
    routingAnchor: `principal-lane:${args.laneId}:not-a-lark-target`,
    displayTarget: args.displayTarget ?? target(),
    workspaceEpoch: args.workspaceEpoch ?? 4,
    phase: args.phase ?? 'active',
    revision: args.revision ?? 2,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function fixture(scope: 'chat' | 'thread' = 'thread') {
  const displayTarget = target(scope);
  const sourceLane = binding({
    laneId: 'source',
    principalKey: 'user:union:on_source',
    displayTarget,
    revision: 6,
  });
  const laneBinding = binding({
    laneId: 'lane-b',
    principalKey: 'user:union:on_b',
    displayTarget,
    revision: 7,
  });
  const sourceState: PrincipalLaneSourceState = {
    version: 1,
    sourcePrincipalKey: sourceLane.principalKey,
    displayTarget,
    canonicalCwd: '/workspace/repo',
    workspaceEpoch: 4,
    workspaceGroupId: principalWorkspaceGroupIdV2(appId, '/workspace/repo'),
    workspaceGroupKeyVersion: PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION,
    phase: 'active',
    revision: 8,
    updatedAt: timestamp,
  };
  const source: PrincipalLaneSourceAuthority = {
    sourceSessionId,
    source: sourceState,
    lane: sourceLane,
  };
  const lane: PrincipalLaneSessionAuthority = {
    lane: laneBinding,
    sessionId: 'session-b',
  };
  const plan: PrincipalLaneIngressPlan = {
    kind: 'route_lane',
    reason: 'existing_caller_lane',
    lane: laneBinding,
    displayTarget,
    fence: {
      callerPrincipalKey: laneBinding.principalKey,
      sourceSessionId,
      sourcePrincipalKey: sourceLane.principalKey,
      sourceRevision: sourceState.revision,
      sourceLaneRevision: sourceLane.revision,
      workspaceEpoch: sourceState.workspaceEpoch,
      canonicalCwd: sourceState.canonicalCwd,
      workspaceGroupId: sourceState.workspaceGroupId,
      workspaceGroupKeyVersion: sourceState.workspaceGroupKeyVersion,
      displayTarget,
      laneId: laneBinding.laneId,
      laneRevision: laneBinding.revision,
      lanePrincipalKey: laneBinding.principalKey,
      routingAnchor: laneBinding.routingAnchor,
      sessionId: lane.sessionId,
    },
  };
  const worktree: PrincipalLaneWorktreeProof = {
    version: 1,
    materializationId: principalLaneWorktreeMaterializationId({
      sourceSessionId,
      principalKey: laneBinding.principalKey,
      workspaceEpoch: laneBinding.workspaceEpoch,
      sourceCanonicalCwd: sourceState.canonicalCwd,
    }),
    sourceSessionId,
    laneId: laneBinding.laneId,
    sessionId: lane.sessionId,
    principalKey: laneBinding.principalKey,
    workspaceEpoch: laneBinding.workspaceEpoch,
    sourceCanonicalCwd: sourceState.canonicalCwd,
    sourceRepoRoot: sourceState.canonicalCwd,
    sourceGitCommonDir: `${sourceState.canonicalCwd}/.git`,
    sourceRelativeCwd: '',
    worktreeRoot: '/workspace/repo-wt-lane-b',
    worktreeGitCommonDir: `${sourceState.canonicalCwd}/.git`,
    workingDir: '/workspace/repo-wt-lane-b',
    branch: 'wt/principal-lane-b',
    baseRef: 'HEAD',
    phase: 'ready',
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const authority: PrincipalLaneDispatchAuthority = {
    source,
    lane,
    session: {
      sessionId: lane.sessionId,
      chatId: displayTarget.chatId,
      rootMessageId: displayTarget.scope === 'thread'
        ? displayTarget.rootMessageId
        : 'chat-trigger-message',
      scope: displayTarget.scope,
      title: 'B lane',
      status: 'active',
      createdAt: timestamp,
      larkAppId: displayTarget.larkAppId,
      workingDir: worktree.workingDir,
      principalLane: { ...laneBinding },
      principalLaneWorktree: worktree,
    },
  };
  return { displayTarget, sourceLane, laneBinding, sourceState, source, lane, plan, authority };
}

describe('principal lane dispatch context', () => {
  it('plans chat output only from the authoritative display target', () => {
    const value = fixture('chat');
    const result = createPrincipalLaneDispatchContext(value.plan, value.authority);
    expect(result).toMatchObject({
      status: 'ready',
      context: {
        output: { kind: 'send_chat', larkAppId: appId, chatId: 'chat-shared' },
        queueIdentity: {
          larkAppId: appId,
          sourceSessionId,
          laneId: 'lane-b',
          sessionId: 'session-b',
        },
      },
    });
    if (result.status !== 'ready') throw new Error('expected ready context');
    expect(JSON.stringify(result.context.output)).not.toContain('routingAnchor');
    expect(JSON.stringify(result.context.output)).not.toContain('principal-lane:');
  });

  it('keeps chat authority in a thread output plan without leaking routing input', () => {
    const value = fixture('thread');
    const result = createPrincipalLaneDispatchContext(value.plan, value.authority);
    expect(result).toMatchObject({
      status: 'ready',
      context: {
        output: {
          kind: 'reply_thread',
          larkAppId: appId,
          chatId: 'chat-shared',
          rootMessageId: 'root-shared',
          replyInThread: true,
        },
      },
    });
    if (result.status !== 'ready') throw new Error('expected ready context');
    expect(Object.keys(result.context.output).sort()).toEqual([
      'chatId', 'kind', 'larkAppId', 'replyInThread', 'rootMessageId',
    ]);
  });

  it.each([
    ['app', { larkAppId: 'cli_other', chatId: 'chat-shared', rootMessageId: 'root-shared' }],
    ['chat', { larkAppId: appId, chatId: 'chat-other', rootMessageId: 'root-shared' }],
    ['root', { larkAppId: appId, chatId: 'chat-shared', rootMessageId: 'root-other' }],
  ])('quarantines a lane whose %s display sidecar crosses the source boundary', (_label, fields) => {
    const value = fixture('thread');
    const changed = {
      ...value.laneBinding,
      displayTarget: { scope: 'thread' as const, ...fields },
    };
    const result = createPrincipalLaneDispatchContext(value.plan, {
      ...value.authority,
      lane: { ...value.lane, lane: changed },
      session: { ...value.authority.session, principalLane: changed },
    });
    expect(result).toEqual({
      status: 'quarantined', target: 'lane', reason: 'lane_sidecar_mismatch',
    });
  });

  it('quarantines source and session sidecar inconsistencies narrowly', () => {
    const value = fixture();
    expect(createPrincipalLaneDispatchContext(value.plan, {
      ...value.authority,
      source: {
        ...value.source,
        lane: {
          ...value.sourceLane,
          displayTarget: { ...target('thread'), rootMessageId: 'root-other' },
        },
      },
    })).toEqual({
      status: 'quarantined', target: 'source', reason: 'source_sidecar_mismatch',
    });
    expect(createPrincipalLaneDispatchContext(value.plan, {
      ...value.authority,
      session: {
        ...value.authority.session,
        principalLane: { ...value.laneBinding, revision: value.laneBinding.revision + 1 },
      },
    })).toEqual({
      status: 'quarantined', target: 'lane', reason: 'session_sidecar_mismatch',
    });
  });

  it.each(['source_revision', 'source_phase', 'workspace_epoch', 'lane_phase'] as const)(
    'returns stale retry for normal %s authority movement',
    (change) => {
      const value = fixture();
      const authority: PrincipalLaneDispatchAuthority = {
        ...value.authority,
        source: {
          ...value.source,
          source: { ...value.sourceState },
          lane: { ...value.sourceLane },
        },
        lane: { ...value.lane, lane: { ...value.laneBinding } },
        session: {
          ...value.authority.session,
          principalLane: { ...value.laneBinding },
        },
      };
      if (change === 'source_revision') authority.source.source.revision += 1;
      if (change === 'source_phase') authority.source.source.phase = 'closing';
      if (change === 'workspace_epoch') {
        authority.source.source.workspaceEpoch += 1;
        authority.source.lane.workspaceEpoch += 1;
        authority.lane.lane.workspaceEpoch += 1;
        authority.session.principalLane!.workspaceEpoch += 1;
        authority.session.principalLaneWorktree!.workspaceEpoch += 1;
        authority.session.principalLaneWorktree!.materializationId =
          principalLaneWorktreeMaterializationId(
            authority.session.principalLaneWorktree!,
          );
      }
      if (change === 'lane_phase') {
        authority.lane.lane.phase = 'closing';
        authority.session.principalLane!.phase = 'closing';
      }
      expect(createPrincipalLaneDispatchContext(value.plan, authority)).toEqual({
        status: 'retry', reason: 'stale_authority',
      });
    },
  );

  it('rejects non-executable plans without constructing any target', () => {
    const value = fixture();
    expect(createPrincipalLaneDispatchContext({ kind: 'new_topic' }, value.authority)).toEqual({
      status: 'retry', reason: 'non_executable_plan',
    });
  });

  it.each([
    ['unsupported version', { version: 2 }],
    ['empty cwd', { canonicalCwd: '' }],
    ['invalid timestamp', { updatedAt: 'not-an-iso-timestamp' }],
  ])('quarantines a source with %s', (_label, sourcePatch) => {
    const value = fixture();
    expect(createPrincipalLaneDispatchContext(value.plan, {
      ...value.authority,
      source: {
        ...value.source,
        source: { ...value.sourceState, ...sourcePatch } as typeof value.sourceState,
      },
    })).toEqual({
      status: 'quarantined', target: 'source', reason: 'source_state_malformed',
    });
  });

  it.each([
    ['missing session', undefined],
    ['session id', { sessionId: 'session-other' }],
    ['session app', { larkAppId: 'cli_other' }],
    ['session chat', { chatId: 'chat-other' }],
    ['session root', { rootMessageId: 'root-other' }],
  ])('quarantines only the lane for %s mismatch', (_label, sessionPatch) => {
    const value = fixture();
    const session = sessionPatch === undefined
      ? undefined
      : { ...value.authority.session, ...sessionPatch };
    expect(createPrincipalLaneDispatchContext(value.plan, {
      ...value.authority,
      session,
    } as PrincipalLaneDispatchAuthority)).toMatchObject({
      status: 'quarantined', target: 'lane',
    });
  });

  it('requires a registered capability and fresh authority at output execution', async () => {
    const value = fixture();
    const created = createPrincipalLaneDispatchContext(value.plan, value.authority);
    if (created.status !== 'ready') throw new Error('expected ready capability');
    expect(Object.keys(created.capability)).toEqual(['version']);
    const sendChat = vi.fn(() => 'sent-chat');
    const replyThread = vi.fn(() => 'sent-thread');

    expect(await executePrincipalLaneOutput(
      { version: 1 } as PrincipalLaneDispatchCapability,
      value.authority,
      { sendChat, replyThread },
    )).toEqual({ status: 'invalid', reason: 'invalid_capability' });
    expect(sendChat).not.toHaveBeenCalled();
    expect(replyThread).not.toHaveBeenCalled();

    const staleAuthority: PrincipalLaneDispatchAuthority = {
      ...value.authority,
      source: {
        ...value.source,
        source: { ...value.sourceState, revision: value.sourceState.revision + 1 },
      },
    };
    expect(await executePrincipalLaneOutput(
      created.capability,
      staleAuthority,
      { sendChat, replyThread },
    )).toEqual({ status: 'retry', reason: 'stale_authority' });
    expect(sendChat).not.toHaveBeenCalled();
    expect(replyThread).not.toHaveBeenCalled();

    expect(await executePrincipalLaneOutput(
      created.capability,
      value.authority,
      { sendChat, replyThread },
    )).toEqual({ status: 'ready', value: 'sent-thread' });
    expect(replyThread).toHaveBeenCalledOnce();
  });

  it('binds a capability to an immutable plan snapshot', () => {
    const value = fixture();
    const signedAuthority = structuredClone(value.authority);
    const created = createPrincipalLaneDispatchContext(value.plan, signedAuthority);
    if (created.status !== 'ready' || value.plan.kind !== 'route_lane') {
      throw new Error('expected ready route capability');
    }
    const reboundDisplay: PrincipalLaneDisplayTarget = {
      scope: 'thread', larkAppId: appId, chatId: 'chat-shared', rootMessageId: 'root-rebound',
    };
    const reboundLane = {
      ...value.laneBinding,
      laneId: 'lane-rebound',
      routingAnchor: 'principal-lane:lane-rebound:routing-only',
      displayTarget: reboundDisplay,
    };
    value.plan.lane = reboundLane;
    value.plan.displayTarget = reboundDisplay;
    Object.assign(value.plan.fence, {
      laneId: reboundLane.laneId,
      sessionId: 'session-rebound',
      routingAnchor: reboundLane.routingAnchor,
      displayTarget: reboundDisplay,
    });

    expect(revalidatePrincipalLaneDispatchCapability(
      created.capability,
      signedAuthority,
    )).toMatchObject({ status: 'ready', context: { laneId: 'lane-b', sessionId: 'session-b' } });

    const reboundAuthority: PrincipalLaneDispatchAuthority = {
      source: {
        ...signedAuthority.source,
        source: { ...signedAuthority.source.source, displayTarget: reboundDisplay },
        lane: { ...signedAuthority.source.lane, displayTarget: reboundDisplay },
      },
      lane: { lane: reboundLane, sessionId: 'session-rebound' },
      session: {
        ...signedAuthority.session,
        sessionId: 'session-rebound',
        rootMessageId: reboundDisplay.rootMessageId,
        principalLane: reboundLane,
        principalLaneWorktree: {
          ...signedAuthority.session.principalLaneWorktree!,
          laneId: reboundLane.laneId,
          sessionId: 'session-rebound',
        },
      },
    };
    expect(revalidatePrincipalLaneDispatchCapability(
      created.capability,
      reboundAuthority,
    )).toEqual({ status: 'retry', reason: 'stale_authority' });
  });

  it('accepts a legacy thread carrier for source lane zero only', () => {
    const value = fixture();
    const sourcePlan: PrincipalLaneIngressPlan = {
      kind: 'route_lane',
      reason: 'existing_caller_lane',
      lane: value.sourceLane,
      displayTarget: value.displayTarget,
      fence: {
        callerPrincipalKey: value.sourceLane.principalKey,
        sourceSessionId,
        sourcePrincipalKey: value.sourceLane.principalKey,
        sourceRevision: value.sourceState.revision,
        sourceLaneRevision: value.sourceLane.revision,
        workspaceEpoch: value.sourceState.workspaceEpoch,
        canonicalCwd: value.sourceState.canonicalCwd,
        workspaceGroupId: value.sourceState.workspaceGroupId,
        workspaceGroupKeyVersion: value.sourceState.workspaceGroupKeyVersion,
        displayTarget: value.displayTarget,
        laneId: 'source',
        laneRevision: value.sourceLane.revision,
        lanePrincipalKey: value.sourceLane.principalKey,
        routingAnchor: value.sourceLane.routingAnchor,
        sessionId: sourceSessionId,
      },
    };
    const legacySourceAuthority: PrincipalLaneDispatchAuthority = {
      source: value.source,
      lane: { lane: value.sourceLane, sessionId: sourceSessionId },
      session: {
        sessionId: sourceSessionId,
        chatId: value.displayTarget.chatId,
        rootMessageId: value.displayTarget.scope === 'thread'
          ? value.displayTarget.rootMessageId
          : 'legacy-root',
        title: 'Legacy source',
        status: 'active',
        createdAt: timestamp,
        workingDir: value.sourceState.canonicalCwd,
        principalLane: value.sourceLane,
      },
    };
    expect(createPrincipalLaneDispatchContext(sourcePlan, legacySourceAuthority))
      .toMatchObject({ status: 'ready', context: { laneId: 'source' } });

    for (const sessionPatch of [
      { larkAppId: 'cli_other' },
      { chatId: 'chat-other' },
      { rootMessageId: 'root-other' },
    ]) {
      expect(createPrincipalLaneDispatchContext(sourcePlan, {
        ...legacySourceAuthority,
        session: { ...legacySourceAuthority.session, ...sessionPatch },
      })).toEqual({
        status: 'quarantined', target: 'lane', reason: 'session_sidecar_mismatch',
      });
    }
  });

  it.each([
    ['missing app', { larkAppId: undefined }],
    ['missing scope', { scope: undefined }],
  ])('keeps shadow Session validation strict for %s', (_label, sessionPatch) => {
    const value = fixture();
    expect(createPrincipalLaneDispatchContext(value.plan, {
      ...value.authority,
      session: { ...value.authority.session, ...sessionPatch },
    })).toEqual({
      status: 'quarantined', target: 'lane', reason: 'session_sidecar_mismatch',
    });
  });
});
