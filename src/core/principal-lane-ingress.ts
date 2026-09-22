import type {
  HumanLaneIdentityEvidence,
  InboundPrincipal,
  MessageProvenance,
  PrincipalLaneBinding,
  PrincipalLaneDisplayTarget,
  PrincipalLaneSourceState,
} from '../types.js';
import type { EnsureShadowPrincipalLaneResult } from '../services/session-store.js';
import {
  lanePrincipalFromInbound,
  lanePrincipalKey,
  type PrincipalLaneIntent,
} from './principal-lane-routing.js';

export interface PrincipalLaneSourceAuthority {
  sourceSessionId: string;
  source: PrincipalLaneSourceState;
  lane: PrincipalLaneBinding;
}

export interface PrincipalLaneSessionAuthority {
  lane: PrincipalLaneBinding;
  sessionId: string;
}

export interface PrincipalLaneActiveTurnAuthority {
  sessionId: string;
  laneId: string;
  principalKey: string;
  turnId: string;
  workerGeneration: number;
  state: 'active' | 'terminal';
}

export interface PrincipalLaneReferenceAuthority {
  provenance: MessageProvenance;
  lane: PrincipalLaneSessionAuthority;
  activeTurn?: PrincipalLaneActiveTurnAuthority;
}

export type PrincipalLaneAuthorityFailure =
  | { kind: 'retry'; reason: string }
  | { kind: 'quarantined'; reason: string }
  | { kind: 'identity_conflict'; reason: string };

export type PrincipalLaneAuthorityRead<T> =
  | { status: 'ready'; value: T }
  | { status: 'missing' }
  | { status: 'failure'; failure: PrincipalLaneAuthorityFailure };

export interface PrincipalLaneSourceFence {
  callerPrincipalKey: string;
  sourceSessionId: string;
  sourcePrincipalKey: string;
  sourceRevision: number;
  sourceLaneRevision: number;
  workspaceEpoch: number;
  canonicalCwd: string;
  workspaceGroupId: string;
  workspaceGroupKeyVersion: 2 | undefined;
  displayTarget: PrincipalLaneDisplayTarget;
}

export interface PrincipalLaneRouteFence extends PrincipalLaneSourceFence {
  laneId: string;
  laneRevision: number;
  lanePrincipalKey: string;
  routingAnchor: string;
  sessionId: string;
}

export interface PrincipalLaneSuggestionFence extends PrincipalLaneRouteFence {
  provenanceMessageId: string;
  targetTurnId: string;
  workerGeneration: number;
}

export type PrincipalLaneIngressPlan =
  | { kind: 'bot_explicit_as' }
  | { kind: 'new_topic' }
  | { kind: 'reject_suggestion'; reason: 'missing_current_task_reference' }
  | PrincipalLaneAuthorityFailure
  | {
      kind: 'create_lane';
      sourceFence: PrincipalLaneSourceFence;
      identity: HumanLaneIdentityEvidence;
      title?: string;
    }
  | {
      kind: 'route_lane';
      reason: 'trusted_own_reference' | 'existing_caller_lane' | 'materialized_caller_lane';
      lane: PrincipalLaneBinding;
      displayTarget: PrincipalLaneDisplayTarget;
      fence: PrincipalLaneRouteFence;
    }
  | {
      kind: 'suggestion';
      targetLane: PrincipalLaneBinding;
      displayTarget: PrincipalLaneDisplayTarget;
      fence: PrincipalLaneSuggestionFence;
    };

export interface PrincipalLaneIngressRequest {
  senderType: 'user' | 'bot';
  larkAppId: string;
  unionId?: string;
  openId?: string;
  sourceSessionId: string;
  eventDisplayTarget: PrincipalLaneDisplayTarget;
  intent: PrincipalLaneIntent;
  /** The sole reference authority input. rootId/threadId below are trace only. */
  parentId?: string;
  rootId?: string;
  threadId?: string;
  title?: string;
}

export interface PrincipalLaneIngressDecisionInput {
  request: PrincipalLaneIngressRequest;
  caller?: InboundPrincipal;
  source?: PrincipalLaneSourceAuthority;
  callerLane?: PrincipalLaneSessionAuthority;
  reference?: PrincipalLaneReferenceAuthority;
}

export interface PrincipalLaneIngressAuthorityReader {
  readSource(sourceSessionId: string): PrincipalLaneAuthorityRead<PrincipalLaneSourceAuthority>;
  readCallerLane(args: {
    sourceSessionId: string;
    caller: InboundPrincipal;
  }): PrincipalLaneAuthorityRead<PrincipalLaneSessionAuthority>;
  readReference(args: {
    parentId: string;
    sourceSessionId: string;
  }): PrincipalLaneAuthorityRead<PrincipalLaneReferenceAuthority>;
}

function sameDisplayTarget(
  left: PrincipalLaneDisplayTarget,
  right: PrincipalLaneDisplayTarget,
): boolean {
  return left.scope === right.scope
    && left.larkAppId === right.larkAppId
    && left.chatId === right.chatId
    && (left.scope !== 'thread'
      || (right.scope === 'thread' && left.rootMessageId === right.rootMessageId));
}

function admissibleLane(
  authority: PrincipalLaneSessionAuthority,
  source: PrincipalLaneSourceAuthority,
): boolean {
  const { lane } = authority;
  return lane.sourceSessionId === source.sourceSessionId
    && authority.sessionId.length > 0
    && lanePrincipalKey(lane.principal) === lane.principalKey
    && lane.workspaceEpoch === source.source.workspaceEpoch
    && (lane.phase === 'active' || lane.phase === 'dormant')
    && sameDisplayTarget(lane.displayTarget, source.source.displayTarget);
}

function validSourceAuthority(
  authority: PrincipalLaneSourceAuthority,
  request: PrincipalLaneIngressRequest,
): boolean {
  return authority.sourceSessionId === request.sourceSessionId
    && request.larkAppId === authority.source.displayTarget.larkAppId
    && authority.source.phase === 'active'
    && authority.lane.laneId === 'source'
    && authority.lane.sourceSessionId === request.sourceSessionId
    && authority.lane.principalKey === authority.source.sourcePrincipalKey
    && lanePrincipalKey(authority.lane.principal) === authority.lane.principalKey
    && authority.lane.workspaceEpoch === authority.source.workspaceEpoch
    && authority.lane.phase === 'active'
    && sameDisplayTarget(authority.lane.displayTarget, authority.source.displayTarget)
    && sameDisplayTarget(authority.source.displayTarget, request.eventDisplayTarget);
}

function sourceFence(
  callerPrincipalKey: string,
  source: PrincipalLaneSourceAuthority,
): PrincipalLaneSourceFence {
  return {
    callerPrincipalKey,
    sourceSessionId: source.sourceSessionId,
    sourcePrincipalKey: source.source.sourcePrincipalKey,
    sourceRevision: source.source.revision,
    sourceLaneRevision: source.lane.revision,
    workspaceEpoch: source.source.workspaceEpoch,
    canonicalCwd: source.source.canonicalCwd,
    workspaceGroupId: source.source.workspaceGroupId,
    workspaceGroupKeyVersion: source.source.workspaceGroupKeyVersion,
    displayTarget: source.source.displayTarget,
  };
}

function routeFence(
  callerPrincipalKey: string,
  source: PrincipalLaneSourceAuthority,
  lane: PrincipalLaneSessionAuthority,
): PrincipalLaneRouteFence {
  return {
    ...sourceFence(callerPrincipalKey, source),
    laneId: lane.lane.laneId,
    laneRevision: lane.lane.revision,
    lanePrincipalKey: lane.lane.principalKey,
    routingAnchor: lane.lane.routingAnchor,
    sessionId: lane.sessionId,
  };
}

function validReference(
  reference: PrincipalLaneReferenceAuthority | undefined,
  parentId: string | undefined,
  source: PrincipalLaneSourceAuthority,
): reference is PrincipalLaneReferenceAuthority {
  if (!parentId || !reference || reference.provenance.messageId !== parentId) return false;
  const { provenance, lane } = reference;
  return provenance.trustState === 'trusted'
    && provenance.sourceSessionId === source.sourceSessionId
    && provenance.laneId === lane.lane.laneId
    && provenance.sessionId === lane.sessionId
    && provenance.principalKey === lane.lane.principalKey
    && provenance.larkAppId === source.source.displayTarget.larkAppId
    && provenance.chatId === source.source.displayTarget.chatId
    && (source.source.displayTarget.scope === 'thread'
      ? provenance.displayRootId === source.source.displayTarget.rootMessageId
      : provenance.displayRootId === undefined)
    && admissibleLane(lane, source);
}

/** Pure precedence and authority decision. It never reads or writes durable
 * state. rootId/threadId are deliberately ignored: parentId is the only path
 * by which a reference authority may participate. */
export function decidePrincipalLaneIngress(
  input: PrincipalLaneIngressDecisionInput,
): PrincipalLaneIngressPlan {
  const { request } = input;
  if (request.senderType === 'bot') return { kind: 'bot_explicit_as' };
  if (request.intent === 'explicit_new_topic') return { kind: 'new_topic' };
  const caller = input.caller;
  const source = input.source;
  if (!caller || caller.senderType !== 'user' || !source
      || !validSourceAuthority(source, request)) {
    return { kind: 'retry', reason: 'invalid_source_authority' };
  }
  const callerPrincipalKey = lanePrincipalKey(caller);
  const ownReference = validReference(input.reference, request.parentId, source)
    && input.reference.provenance.principalKey === callerPrincipalKey
    ? input.reference
    : undefined;
  if (ownReference) {
    return {
      kind: 'route_lane',
      reason: 'trusted_own_reference',
      lane: ownReference.lane.lane,
      displayTarget: source.source.displayTarget,
      fence: routeFence(callerPrincipalKey, source, ownReference.lane),
    };
  }

  const foreignReference = validReference(input.reference, request.parentId, source)
    && input.reference.provenance.principalKey !== callerPrincipalKey
    ? input.reference
    : undefined;
  const activeTurn = foreignReference?.activeTurn;
  if (foreignReference && activeTurn
      && activeTurn.state === 'active'
      && activeTurn.sessionId === foreignReference.lane.sessionId
      && activeTurn.laneId === foreignReference.lane.lane.laneId
      && activeTurn.principalKey === foreignReference.lane.lane.principalKey
      && activeTurn.turnId === foreignReference.provenance.turnId
      && activeTurn.workerGeneration === foreignReference.provenance.workerGeneration) {
    return {
      kind: 'suggestion',
      targetLane: foreignReference.lane.lane,
      displayTarget: source.source.displayTarget,
      fence: {
        ...routeFence(callerPrincipalKey, source, foreignReference.lane),
        provenanceMessageId: foreignReference.provenance.messageId,
        targetTurnId: foreignReference.provenance.turnId,
        workerGeneration: foreignReference.provenance.workerGeneration,
      },
    };
  }

  if (request.intent === 'explicit_suggest_current') {
    return { kind: 'reject_suggestion', reason: 'missing_current_task_reference' };
  }

  const sourceCallerLane: PrincipalLaneSessionAuthority | undefined =
    callerPrincipalKey === source.source.sourcePrincipalKey
      ? { lane: source.lane, sessionId: source.sourceSessionId }
      : undefined;
  const callerLane = sourceCallerLane ?? input.callerLane;
  if (callerLane && admissibleLane(callerLane, source)
      && callerLane.lane.principalKey === callerPrincipalKey) {
    return {
      kind: 'route_lane',
      reason: 'existing_caller_lane',
      lane: callerLane.lane,
      displayTarget: source.source.displayTarget,
      fence: routeFence(callerPrincipalKey, source, callerLane),
    };
  }
  return {
    kind: 'create_lane',
    sourceFence: sourceFence(callerPrincipalKey, source),
    identity: {
      larkAppId: request.larkAppId,
      ...(request.unionId ? { unionId: request.unionId } : {}),
      ...(request.openId ? { openId: request.openId } : {}),
    },
    ...(request.title ? { title: request.title } : {}),
  };
}

/** Read-only orchestration around the pure decision. The early bot/new-topic
 * returns are structural: no human-lane reader is called in those branches. */
export function planPrincipalLaneIngress(
  request: PrincipalLaneIngressRequest,
  reader: PrincipalLaneIngressAuthorityReader,
): PrincipalLaneIngressPlan {
  const caller = lanePrincipalFromInbound({
    senderType: request.senderType,
    larkAppId: request.larkAppId,
    unionId: request.unionId,
    openId: request.openId,
  });
  if (request.senderType === 'bot' || request.intent === 'explicit_new_topic') {
    return decidePrincipalLaneIngress({ request, caller });
  }
  if (!caller) return { kind: 'retry', reason: 'missing_caller_identity' };

  const sourceRead = reader.readSource(request.sourceSessionId);
  if (sourceRead.status === 'failure') return sourceRead.failure;
  if (sourceRead.status !== 'ready') return { kind: 'retry', reason: 'source_not_found' };
  const source = sourceRead.value;
  if (!validSourceAuthority(source, request)) {
    return { kind: 'retry', reason: 'invalid_source_authority' };
  }

  let reference: PrincipalLaneReferenceAuthority | undefined;
  if (request.parentId) {
    const referenceRead = reader.readReference({
      parentId: request.parentId,
      sourceSessionId: request.sourceSessionId,
    });
    if (referenceRead.status === 'ready') reference = referenceRead.value;
    else if (referenceRead.status === 'failure') {
      return referenceRead.failure;
    }
  }

  const higherPriorityPlan = decidePrincipalLaneIngress({ request, caller, source, reference });
  if (higherPriorityPlan.kind === 'suggestion'
      || higherPriorityPlan.kind === 'reject_suggestion'
      || (higherPriorityPlan.kind === 'route_lane'
        && higherPriorityPlan.reason === 'trusted_own_reference')) {
    return higherPriorityPlan;
  }

  let callerLane: PrincipalLaneSessionAuthority | undefined;
  if (lanePrincipalKey(caller) !== source.source.sourcePrincipalKey) {
    const callerLaneRead = reader.readCallerLane({
      sourceSessionId: request.sourceSessionId,
      caller,
    });
    if (callerLaneRead.status === 'failure') return callerLaneRead.failure;
    if (callerLaneRead.status === 'ready') callerLane = callerLaneRead.value;
  }
  return decidePrincipalLaneIngress({ request, caller, source, callerLane, reference });
}

export interface PrincipalLaneIngressMaterializer {
  ensureShadowLane(args: {
    sourceSessionId: string;
    identity: HumanLaneIdentityEvidence;
    title?: string;
    expectedSource: Omit<PrincipalLaneSourceFence, 'callerPrincipalKey' | 'sourceSessionId'>;
  }): EnsureShadowPrincipalLaneResult;
}

/** The only writer in this stage. Non-create plans are returned byte-for-byte
 * without calling the materializer. */
export function materializePrincipalLaneIngress(
  plan: PrincipalLaneIngressPlan,
  materializer: PrincipalLaneIngressMaterializer,
): PrincipalLaneIngressPlan {
  if (plan.kind !== 'create_lane') return plan;
  const result = materializer.ensureShadowLane({
    sourceSessionId: plan.sourceFence.sourceSessionId,
    identity: plan.identity,
    expectedSource: {
      sourcePrincipalKey: plan.sourceFence.sourcePrincipalKey,
      sourceRevision: plan.sourceFence.sourceRevision,
      sourceLaneRevision: plan.sourceFence.sourceLaneRevision,
      workspaceEpoch: plan.sourceFence.workspaceEpoch,
      canonicalCwd: plan.sourceFence.canonicalCwd,
      workspaceGroupId: plan.sourceFence.workspaceGroupId,
      workspaceGroupKeyVersion: plan.sourceFence.workspaceGroupKeyVersion,
      displayTarget: plan.sourceFence.displayTarget,
    },
    ...(plan.title ? { title: plan.title } : {}),
  });
  if (result.status !== 'ready') {
    if (result.status === 'identity_conflict') {
      return { kind: 'identity_conflict', reason: result.reason };
    }
    if (result.status === 'quarantined') {
      return { kind: 'quarantined', reason: result.reason };
    }
    return { kind: 'retry', reason: result.reason };
  }
  if (result.lane.sourceSessionId !== plan.sourceFence.sourceSessionId
      || result.lane.principalKey !== plan.sourceFence.callerPrincipalKey
      || result.lane.workspaceEpoch !== plan.sourceFence.workspaceEpoch
      || (result.lane.phase !== 'active' && result.lane.phase !== 'dormant')
      || !sameDisplayTarget(result.lane.displayTarget, plan.sourceFence.displayTarget)) {
    return { kind: 'retry', reason: 'materialized_lane_authority_mismatch' };
  }
  return {
    kind: 'route_lane',
    reason: 'materialized_caller_lane',
    lane: result.lane,
    displayTarget: plan.sourceFence.displayTarget,
    fence: {
      ...plan.sourceFence,
      laneId: result.lane.laneId,
      laneRevision: result.lane.revision,
      lanePrincipalKey: result.lane.principalKey,
      routingAnchor: result.lane.routingAnchor,
      sessionId: result.session.sessionId,
    },
  };
}

export interface PrincipalLaneFenceAuthority {
  source: PrincipalLaneSourceAuthority;
  lane?: PrincipalLaneSessionAuthority;
  provenance?: MessageProvenance;
  activeTurn?: PrincipalLaneActiveTurnAuthority;
}

/** Revalidate a frozen plan immediately before a future dispatch boundary. */
export function validPrincipalLaneIngressFence(
  plan: PrincipalLaneIngressPlan,
  current: PrincipalLaneFenceAuthority,
): boolean {
  if (plan.kind !== 'route_lane' && plan.kind !== 'suggestion') return false;
  const fence = plan.fence;
  const source = current.source;
  const lane = current.lane;
  if (!lane
      || source.sourceSessionId !== fence.sourceSessionId
      || source.source.phase !== 'active'
      || source.source.sourcePrincipalKey !== fence.sourcePrincipalKey
      || source.source.revision !== fence.sourceRevision
      || source.lane.laneId !== 'source'
      || source.lane.sourceSessionId !== fence.sourceSessionId
      || source.lane.principalKey !== fence.sourcePrincipalKey
      || lanePrincipalKey(source.lane.principal) !== fence.sourcePrincipalKey
      || source.lane.workspaceEpoch !== fence.workspaceEpoch
      || source.lane.phase !== 'active'
      || source.lane.revision !== fence.sourceLaneRevision
      || source.source.workspaceEpoch !== fence.workspaceEpoch
      || source.source.canonicalCwd !== fence.canonicalCwd
      || source.source.workspaceGroupId !== fence.workspaceGroupId
      || source.source.workspaceGroupKeyVersion !== fence.workspaceGroupKeyVersion
      || !sameDisplayTarget(source.source.displayTarget, fence.displayTarget)
      || !sameDisplayTarget(source.lane.displayTarget, fence.displayTarget)
      || lane.lane.laneId !== fence.laneId
      || lane.lane.revision !== fence.laneRevision
      || lane.lane.principalKey !== fence.lanePrincipalKey
      || lanePrincipalKey(lane.lane.principal) !== fence.lanePrincipalKey
      || lane.lane.routingAnchor !== fence.routingAnchor
      || lane.lane.workspaceEpoch !== fence.workspaceEpoch
      || (lane.lane.phase !== 'active' && lane.lane.phase !== 'dormant')
      || lane.sessionId !== fence.sessionId
      || !sameDisplayTarget(lane.lane.displayTarget, fence.displayTarget)) return false;
  if (plan.kind !== 'suggestion') {
    return fence.callerPrincipalKey === fence.lanePrincipalKey;
  }
  const suggestionFence = plan.fence;
  const provenance = current.provenance;
  const activeTurn = current.activeTurn;
  return !!provenance
    && provenance.trustState === 'trusted'
    && provenance.messageId === suggestionFence.provenanceMessageId
    && provenance.sourceSessionId === suggestionFence.sourceSessionId
    && provenance.laneId === suggestionFence.laneId
    && provenance.turnId === suggestionFence.targetTurnId
    && provenance.workerGeneration === suggestionFence.workerGeneration
    && provenance.sessionId === suggestionFence.sessionId
    && provenance.principalKey === suggestionFence.lanePrincipalKey
    && provenance.larkAppId === suggestionFence.displayTarget.larkAppId
    && provenance.chatId === suggestionFence.displayTarget.chatId
    && (suggestionFence.displayTarget.scope === 'thread'
      ? provenance.displayRootId === suggestionFence.displayTarget.rootMessageId
      : provenance.displayRootId === undefined)
    && !!activeTurn
    && activeTurn.state === 'active'
    && activeTurn.sessionId === suggestionFence.sessionId
    && activeTurn.laneId === suggestionFence.laneId
    && activeTurn.principalKey === suggestionFence.lanePrincipalKey
    && activeTurn.turnId === suggestionFence.targetTurnId
    && activeTurn.workerGeneration === suggestionFence.workerGeneration;
}
