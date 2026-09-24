import type {
  HumanLanePrincipal,
  PrincipalLaneBinding,
  PrincipalLaneDisplayTarget,
  PrincipalLaneSourceState,
  PrincipalLaneWorktreeProof,
} from '../../src/types.js';
import {
  createPrincipalLaneDispatchContext,
  type PrincipalLaneDispatchAuthority,
  type PrincipalLaneQueueIdentity,
} from '../../src/core/principal-lane-dispatch.js';
import type { PrincipalLaneIngressPlan } from '../../src/core/principal-lane-ingress.js';
import {
  PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION,
  principalWorkspaceGroupIdV2,
} from '../../src/core/principal-workspace-admission.js';
import { principalLaneWorktreeMaterializationId } from '../../src/core/principal-lane-worktree.js';

const timestamp = '2026-09-19T10:00:00.000Z';

export interface PrincipalLaneRecordFixtureOptions extends Partial<PrincipalLaneQueueIdentity> {
  principal?: HumanLanePrincipal;
}

export function principalLaneRecordFixture(options: PrincipalLaneRecordFixtureOptions = {}) {
  const identity: PrincipalLaneQueueIdentity = {
    larkAppId: options.larkAppId ?? 'cli_lane_record_app',
    sourceSessionId: options.sourceSessionId ?? 'source-record-session',
    laneId: options.laneId ?? 'lane-record-a',
    sessionId: options.sessionId ?? 'session-record-a',
  };
  const displayTarget: PrincipalLaneDisplayTarget = {
    scope: 'thread',
    larkAppId: identity.larkAppId,
    chatId: 'chat-record-shared',
    rootMessageId: 'root-record-shared',
  };
  const sourceLane: PrincipalLaneBinding = {
    version: 1,
    laneId: 'source',
    sourceSessionId: identity.sourceSessionId,
    principalKey: 'user:union:on_record_source',
    principal: { senderType: 'user', kind: 'union', unionId: 'on_record_source' },
    routingAnchor: 'principal-lane:record-source:routing-only',
    displayTarget,
    workspaceEpoch: 2,
    phase: 'active',
    revision: 3,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const principal = options.principal ?? {
    senderType: 'user', kind: 'union', unionId: 'on_record_lane',
  };
  const principalKey = principal.kind === 'union'
    ? `user:union:${principal.unionId}`
    : `user:app:${principal.larkAppId}:open:${principal.openId}`;
  const lane: PrincipalLaneBinding = {
    version: 1,
    laneId: identity.laneId,
    sourceSessionId: identity.sourceSessionId,
    principalKey,
    principal,
    routingAnchor: `principal-lane:${identity.laneId}:routing-only`,
    displayTarget,
    workspaceEpoch: 2,
    phase: 'active',
    revision: 4,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const sourceState: PrincipalLaneSourceState = {
    version: 1,
    sourcePrincipalKey: sourceLane.principalKey,
    displayTarget,
    canonicalCwd: '/workspace/record-repo',
    workspaceEpoch: 2,
    workspaceGroupId: principalWorkspaceGroupIdV2(
      identity.larkAppId, '/workspace/record-repo',
    ),
    workspaceGroupKeyVersion: PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION,
    phase: 'active',
    revision: 5,
    updatedAt: timestamp,
  };
  const plan: PrincipalLaneIngressPlan = {
    kind: 'route_lane',
    reason: 'existing_caller_lane',
    lane,
    displayTarget,
    fence: {
      callerPrincipalKey: lane.principalKey,
      sourceSessionId: identity.sourceSessionId,
      sourcePrincipalKey: sourceLane.principalKey,
      sourceRevision: sourceState.revision,
      sourceLaneRevision: sourceLane.revision,
      workspaceEpoch: sourceState.workspaceEpoch,
      canonicalCwd: sourceState.canonicalCwd,
      workspaceGroupId: sourceState.workspaceGroupId,
      workspaceGroupKeyVersion: sourceState.workspaceGroupKeyVersion,
      displayTarget,
      laneId: lane.laneId,
      laneRevision: lane.revision,
      lanePrincipalKey: lane.principalKey,
      routingAnchor: lane.routingAnchor,
      sessionId: identity.sessionId,
    },
  };
  const worktreeRoot = `/workspace/record-repo-wt-${identity.laneId}`;
  const worktree: PrincipalLaneWorktreeProof = {
    version: 1,
    materializationId: principalLaneWorktreeMaterializationId({
      sourceSessionId: identity.sourceSessionId,
      principalKey: lane.principalKey,
      workspaceEpoch: lane.workspaceEpoch,
      sourceCanonicalCwd: sourceState.canonicalCwd,
    }),
    sourceSessionId: identity.sourceSessionId,
    laneId: lane.laneId,
    sessionId: identity.sessionId,
    principalKey: lane.principalKey,
    workspaceEpoch: lane.workspaceEpoch,
    sourceCanonicalCwd: sourceState.canonicalCwd,
    sourceRepoRoot: sourceState.canonicalCwd,
    sourceGitCommonDir: `${sourceState.canonicalCwd}/.git`,
    sourceRelativeCwd: '',
    worktreeRoot,
    worktreeGitCommonDir: `${sourceState.canonicalCwd}/.git`,
    workingDir: worktreeRoot,
    branch: `wt/principal-lane-${identity.laneId}`,
    baseRef: 'HEAD',
    phase: 'ready',
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const authority: PrincipalLaneDispatchAuthority = {
    source: { sourceSessionId: identity.sourceSessionId, source: sourceState, lane: sourceLane },
    lane: { lane, sessionId: identity.sessionId },
    session: {
      sessionId: identity.sessionId,
      chatId: displayTarget.chatId,
      rootMessageId: displayTarget.rootMessageId,
      scope: 'thread',
      title: 'Record lane',
      status: 'active',
      createdAt: timestamp,
      larkAppId: identity.larkAppId,
      workingDir: worktree.workingDir,
      principalLane: lane,
      principalLaneWorktree: worktree,
    },
  };
  const dispatch = createPrincipalLaneDispatchContext(plan, authority);
  if (dispatch.status !== 'ready') throw new Error(`dispatch fixture failed: ${dispatch.status}`);
  return { identity, plan, authority, capability: dispatch.capability };
}
