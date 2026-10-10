import type {
  PrincipalLaneBinding,
  PrincipalLaneDisplayTarget,
  Session,
} from '../types.js';
import { sessionKey } from './types.js';
import {
  lanePrincipalKey,
  parsePrincipalLaneBinding,
  parsePrincipalLaneSourceState,
  sourceSessionDisplayTarget,
} from './principal-lane-routing.js';
import { parsePrincipalLaneWorktreeProof } from './principal-lane-worktree.js';
import {
  validPrincipalLaneIngressFence,
  type PrincipalLaneFenceAuthority,
  type PrincipalLaneIngressPlan,
} from './principal-lane-ingress.js';

export type PrincipalLaneOutputPlan =
  | {
      kind: 'send_chat';
      larkAppId: string;
      chatId: string;
    }
  | {
      kind: 'reply_thread';
      larkAppId: string;
      chatId: string;
      rootMessageId: string;
      replyInThread: true;
    };

export interface PrincipalLaneQueueIdentity {
  larkAppId: string;
  sourceSessionId: string;
  laneId: string;
  sessionId: string;
}

export interface PrincipalLaneDispatchAuthority extends PrincipalLaneFenceAuthority {
  lane: NonNullable<PrincipalLaneFenceAuthority['lane']>;
  /** Actual child Session row read in the same authority snapshot. */
  session: Session;
}

export interface PrincipalLaneDispatchContext {
  readonly sourceSessionId: string;
  readonly laneId: string;
  readonly sessionId: string;
  readonly routingKey: string;
  readonly queueIdentity: Readonly<PrincipalLaneQueueIdentity>;
  readonly displayTarget: Readonly<PrincipalLaneDisplayTarget>;
  readonly output: Readonly<PrincipalLaneOutputPlan>;
  readonly fence: Extract<
    PrincipalLaneIngressPlan,
    { kind: 'route_lane' | 'suggestion' }
  >['fence'];
}

declare const principalLaneDispatchCapabilityBrand: unique symbol;

/** Runtime-only authority capability. The public object carries no target or
 * queue identity; those remain in a WeakMap and are re-derived after a fresh
 * authority check at every execution boundary. */
export interface PrincipalLaneDispatchCapability {
  readonly version: 1;
  readonly [principalLaneDispatchCapabilityBrand]: true;
}

export type PrincipalLaneDispatchContextResult =
  | {
      status: 'ready';
      capability: PrincipalLaneDispatchCapability;
      context: PrincipalLaneDispatchContext;
    }
  | { status: 'invalid'; reason: 'invalid_capability' }
  | {
      status: 'retry';
      reason: 'non_executable_plan' | 'stale_authority';
    }
  | {
      status: 'quarantined';
      target: 'source' | 'lane';
      reason: 'malformed_display_target' | 'source_state_malformed'
        | 'source_sidecar_mismatch' | 'lane_sidecar_mismatch'
        | 'session_missing' | 'session_sidecar_mismatch';
    };

interface PrincipalLaneDispatchCapabilityRecord {
  plan: Extract<PrincipalLaneIngressPlan, { kind: 'route_lane' | 'suggestion' }>;
}

const dispatchCapabilities = new WeakMap<object, PrincipalLaneDispatchCapabilityRecord>();

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function immutableExecutablePlanSnapshot(
  plan: Extract<PrincipalLaneIngressPlan, { kind: 'route_lane' | 'suggestion' }>,
): Extract<PrincipalLaneIngressPlan, { kind: 'route_lane' | 'suggestion' }> {
  return deepFreeze(structuredClone(plan));
}

function validDisplayTarget(target: PrincipalLaneDisplayTarget): boolean {
  if (!target || typeof target !== 'object'
      || typeof target.larkAppId !== 'string' || target.larkAppId.length === 0
      || typeof target.chatId !== 'string' || target.chatId.length === 0) return false;
  if (target.scope === 'chat') {
    return (target as PrincipalLaneDisplayTarget & { rootMessageId?: unknown }).rootMessageId
      === undefined;
  }
  return target.scope === 'thread'
    && typeof target.rootMessageId === 'string'
    && target.rootMessageId.length > 0;
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

function sameLaneBinding(left: PrincipalLaneBinding, right: PrincipalLaneBinding): boolean {
  return left.version === right.version
    && left.laneId === right.laneId
    && left.sourceSessionId === right.sourceSessionId
    && left.principalKey === right.principalKey
    && lanePrincipalKey(left.principal) === left.principalKey
    && lanePrincipalKey(right.principal) === right.principalKey
    && left.routingAnchor === right.routingAnchor
    && sameDisplayTarget(left.displayTarget, right.displayTarget)
    && left.workspaceEpoch === right.workspaceEpoch
    && left.phase === right.phase
    && left.revision === right.revision
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
    && left.quarantineReason === right.quarantineReason;
}

function outputPlan(target: PrincipalLaneDisplayTarget): PrincipalLaneOutputPlan {
  if (target.scope === 'chat') {
    return { kind: 'send_chat', larkAppId: target.larkAppId, chatId: target.chatId };
  }
  return {
    kind: 'reply_thread',
    larkAppId: target.larkAppId,
    chatId: target.chatId,
    rootMessageId: target.rootMessageId,
    replyInThread: true,
  };
}

function cloneDisplayTarget(target: PrincipalLaneDisplayTarget): PrincipalLaneDisplayTarget {
  return target.scope === 'chat'
    ? { scope: 'chat', larkAppId: target.larkAppId, chatId: target.chatId }
    : {
        scope: 'thread', larkAppId: target.larkAppId,
        chatId: target.chatId, rootMessageId: target.rootMessageId,
      };
}

function buildPrincipalLaneDispatchContext(
  plan: PrincipalLaneIngressPlan,
  authority: PrincipalLaneDispatchAuthority,
): Exclude<PrincipalLaneDispatchContextResult, { status: 'ready' | 'invalid' }>
  | { status: 'ready'; context: PrincipalLaneDispatchContext } {
  if (plan.kind !== 'route_lane' && plan.kind !== 'suggestion') {
    return { status: 'retry', reason: 'non_executable_plan' };
  }
  const { source, lane, session } = authority;
  if (!source || typeof source !== 'object') {
    return { status: 'quarantined', target: 'source', reason: 'source_state_malformed' };
  }
  const rawSourceState: unknown = (source as { source?: unknown }).source;
  if (!rawSourceState || typeof rawSourceState !== 'object' || Array.isArray(rawSourceState)) {
    return { status: 'quarantined', target: 'source', reason: 'source_state_malformed' };
  }
  const rawDisplayTarget = (rawSourceState as { displayTarget?: unknown }).displayTarget;
  if (!validDisplayTarget(rawDisplayTarget as PrincipalLaneDisplayTarget)) {
    return { status: 'quarantined', target: 'source', reason: 'malformed_display_target' };
  }
  const parsedSource = parsePrincipalLaneSourceState(
    rawSourceState,
    rawDisplayTarget as PrincipalLaneDisplayTarget,
    source.sourceSessionId,
  );
  if (!parsedSource.ok) {
    return { status: 'quarantined', target: 'source', reason: 'source_state_malformed' };
  }
  const parsedSourceLane = parsePrincipalLaneBinding(source.lane, {
    displayTarget: parsedSource.value.displayTarget,
    sourceSessionId: source.sourceSessionId,
  });
  if (!parsedSourceLane.ok
      || source.sourceSessionId !== parsedSourceLane.value.sourceSessionId
      || parsedSourceLane.value.laneId !== 'source'
      || parsedSource.value.sourcePrincipalKey !== parsedSourceLane.value.principalKey
      || parsedSourceLane.value.workspaceEpoch !== parsedSource.value.workspaceEpoch) {
    return { status: 'quarantined', target: 'source', reason: 'source_sidecar_mismatch' };
  }
  if (!lane || typeof lane !== 'object') {
    return { status: 'quarantined', target: 'lane', reason: 'lane_sidecar_mismatch' };
  }
  const parsedLane = parsePrincipalLaneBinding(lane.lane, {
    displayTarget: parsedSource.value.displayTarget,
    sourceSessionId: source.sourceSessionId,
  });
  if (!parsedLane.ok) {
    return { status: 'quarantined', target: 'lane', reason: 'lane_sidecar_mismatch' };
  }
  if (!session || typeof session !== 'object') {
    return { status: 'quarantined', target: 'lane', reason: 'session_missing' };
  }
  const expectedDisplayTarget = parsedSource.value.displayTarget;
  const sourceCarrierTarget = parsedLane.value.laneId === 'source'
    ? sourceSessionDisplayTarget(session, expectedDisplayTarget.larkAppId)
    : undefined;
  const displayCarrierMatches = parsedLane.value.laneId === 'source'
    ? !!sourceCarrierTarget && sameDisplayTarget(sourceCarrierTarget, expectedDisplayTarget)
    : session.larkAppId === expectedDisplayTarget.larkAppId
      && session.scope === expectedDisplayTarget.scope
      && session.chatId === expectedDisplayTarget.chatId
      && (expectedDisplayTarget.scope === 'thread'
        ? session.rootMessageId === expectedDisplayTarget.rootMessageId
        : typeof session.rootMessageId === 'string' && session.rootMessageId.length > 0);
  const workspaceCarrierMatches = parsedLane.value.laneId === 'source'
    ? session.workingDir === parsedSource.value.canonicalCwd
    : (() => {
      const proof = session.principalLaneWorktree
        ? parsePrincipalLaneWorktreeProof(session.principalLaneWorktree, {
          sourceSessionId: source.sourceSessionId,
          laneId: parsedLane.value.laneId,
          sessionId: lane.sessionId,
          principalKey: parsedLane.value.principalKey,
          workspaceEpoch: parsedLane.value.workspaceEpoch,
        })
        : { ok: false as const, error: 'missing_embedded_proof' };
      return proof.ok
        && proof.value.sourceCanonicalCwd === parsedSource.value.canonicalCwd
        && session.workingDir === proof.value.workingDir;
    })();
  if (session.sessionId !== lane.sessionId
      || !displayCarrierMatches
      || !workspaceCarrierMatches
      || !session.principalLane) {
    return { status: 'quarantined', target: 'lane', reason: 'session_sidecar_mismatch' };
  }
  const parsedSessionLane = parsePrincipalLaneBinding(session.principalLane, {
    displayTarget: parsedSource.value.displayTarget,
    sourceSessionId: source.sourceSessionId,
  });
  if (!parsedSessionLane.ok
      || !sameLaneBinding(parsedSessionLane.value, parsedLane.value)) {
    return { status: 'quarantined', target: 'lane', reason: 'session_sidecar_mismatch' };
  }
  if (session.status !== 'active') {
    return { status: 'retry', reason: 'stale_authority' };
  }
  const normalizedAuthority: PrincipalLaneFenceAuthority = {
    ...authority,
    source: {
      sourceSessionId: source.sourceSessionId,
      source: parsedSource.value,
      lane: parsedSourceLane.value,
    },
    lane: { sessionId: lane.sessionId, lane: parsedLane.value },
  };
  if (!validPrincipalLaneIngressFence(plan, normalizedAuthority)) {
    return { status: 'retry', reason: 'stale_authority' };
  }
  const displayTarget = Object.freeze(cloneDisplayTarget(parsedSource.value.displayTarget));
  const queueIdentity = Object.freeze({
    larkAppId: displayTarget.larkAppId,
    sourceSessionId: source.sourceSessionId,
    laneId: parsedLane.value.laneId,
    sessionId: lane.sessionId,
  });
  const output = Object.freeze(outputPlan(displayTarget));
  const fence = Object.freeze({
    ...plan.fence,
    displayTarget: Object.freeze(cloneDisplayTarget(plan.fence.displayTarget)),
  }) as typeof plan.fence;
  return {
    status: 'ready',
    context: Object.freeze({
      sourceSessionId: source.sourceSessionId,
      laneId: parsedLane.value.laneId,
      sessionId: lane.sessionId,
      routingKey: sessionKey(parsedLane.value.routingAnchor, displayTarget.larkAppId),
      queueIdentity,
      displayTarget,
      output,
      fence,
    }),
  };
}

/** Mint a runtime-only capability after validating source, lane and the actual
 * child Session row. The capability contains no target fields itself. */
export function createPrincipalLaneDispatchContext(
  plan: PrincipalLaneIngressPlan,
  authority: PrincipalLaneDispatchAuthority,
): PrincipalLaneDispatchContextResult {
  const built = buildPrincipalLaneDispatchContext(plan, authority);
  if (built.status !== 'ready') return built;
  if (plan.kind !== 'route_lane' && plan.kind !== 'suggestion') {
    return { status: 'retry', reason: 'non_executable_plan' };
  }
  const capability = Object.freeze({ version: 1 }) as PrincipalLaneDispatchCapability;
  dispatchCapabilities.set(capability as object, {
    plan: immutableExecutablePlanSnapshot(plan),
  });
  return { ...built, capability };
}

/** Recheck a capability against a fresh store snapshot immediately before a
 * queue or output effect. Forged objects never reach target resolution. */
export function revalidatePrincipalLaneDispatchCapability(
  capability: PrincipalLaneDispatchCapability,
  authority: PrincipalLaneDispatchAuthority,
): PrincipalLaneDispatchContextResult {
  const record = dispatchCapabilities.get(capability as object);
  if (!record) return { status: 'invalid', reason: 'invalid_capability' };
  const built = buildPrincipalLaneDispatchContext(record.plan, authority);
  return built.status === 'ready' ? { ...built, capability } : built;
}

export interface PrincipalLaneOutputExecutor<T> {
  sendChat(target: Extract<PrincipalLaneOutputPlan, { kind: 'send_chat' }>): T | Promise<T>;
  replyThread(target: Extract<PrincipalLaneOutputPlan, { kind: 'reply_thread' }>): T | Promise<T>;
}

export type PrincipalLaneOutputExecutionResult<T> =
  | { status: 'ready'; value: T }
  | Exclude<PrincipalLaneDispatchContextResult, { status: 'ready' }>;

/** The sole output execution boundary. A naked output plan is descriptive only
 * and cannot be executed without its registered capability plus fresh store
 * authority. */
export async function executePrincipalLaneOutput<T>(
  capability: PrincipalLaneDispatchCapability,
  authority: PrincipalLaneDispatchAuthority,
  executor: PrincipalLaneOutputExecutor<T>,
): Promise<PrincipalLaneOutputExecutionResult<T>> {
  const resolved = revalidatePrincipalLaneDispatchCapability(capability, authority);
  if (resolved.status !== 'ready') return resolved;
  const output = resolved.context.output;
  const value = output.kind === 'send_chat'
    ? await executor.sendChat(output)
    : await executor.replyThread(output);
  return { status: 'ready', value };
}
