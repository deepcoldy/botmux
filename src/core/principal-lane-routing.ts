import type {
  HumanLanePrincipal,
  InboundPrincipal,
  LanePrincipal,
  PrincipalLaneBinding,
  PrincipalLaneDisplayTarget,
  PrincipalLaneSourceState,
  Session,
} from '../types.js';
import { validPrincipalWorkspaceGroupIdentity } from './principal-workspace-admission.js';

export type PrincipalLaneIntent =
  | 'none'
  | 'explicit_new_topic'
  | 'explicit_suggest_current';

export const SOURCE_PRINCIPAL_LANE_ID = 'source';

export interface TrustedPrincipalLaneReference {
  trusted: boolean;
  principalKey?: string;
  laneId?: string;
  sessionId?: string;
  laneValid?: boolean;
  foreignTurnActive?: boolean;
  workerGenerationMatches?: boolean;
}

export type PrincipalLaneRouteDecision =
  | { kind: 'bot_explicit_as' }
  | { kind: 'new_topic' }
  | { kind: 'route_lane'; laneId: string; reason: 'trusted_own_reference' | 'existing_caller_lane' }
  | { kind: 'suggestion'; targetSessionId: string; targetLaneId: string }
  | { kind: 'reject_suggestion'; reason: 'missing_current_task_reference' }
  | { kind: 'create_lane' };

/** The only supported principal-key derivation. union_id wins because open_id
 * is app-scoped; the fallback therefore includes the app id. */
export function lanePrincipalKey(principal: InboundPrincipal): string {
  if (principal.kind === 'union') {
    return `${principal.senderType}:union:${principal.unionId}`;
  }
  return `${principal.senderType}:app:${principal.larkAppId}:open:${principal.openId}`;
}

export function lanePrincipalFromInbound(args: {
  senderType: 'user' | 'bot';
  larkAppId: string;
  unionId?: string;
  openId?: string;
}): InboundPrincipal | undefined {
  const unionId = args.unionId?.trim();
  if (unionId) return { senderType: args.senderType, kind: 'union', unionId };
  const openId = args.openId?.trim();
  if (!openId) return undefined;
  return {
    senderType: args.senderType,
    kind: 'app_open',
    larkAppId: args.larkAppId,
    openId,
  };
}

/** Lane 0 is a durable mapping, not an active-turn heuristic. This keeps the
 * original principal on the source session even after its current turn is
 * idle, and prevents accidental creation of a shadow copy of lane 0. */
export function resolveCallerLaneId(args: {
  callerPrincipalKey: string;
  sourcePrincipalKey: string;
  indexedLaneId?: string;
}): string | undefined {
  if (args.callerPrincipalKey === args.sourcePrincipalKey) return SOURCE_PRINCIPAL_LANE_ID;
  return args.indexedLaneId;
}

/** Pure precedence table. In particular explicit new-topic intent is exact and
 * absolute: a parent_id must never pull that action back into a lane. */
export function decidePrincipalLaneRoute(args: {
  senderType: 'user' | 'bot';
  intent: PrincipalLaneIntent;
  callerPrincipalKey: string;
  callerLaneId?: string;
  reference?: TrustedPrincipalLaneReference;
}): PrincipalLaneRouteDecision {
  if (args.senderType === 'bot') return { kind: 'bot_explicit_as' };
  if (args.intent === 'explicit_new_topic') return { kind: 'new_topic' };

  const ref = args.reference;
  if (ref?.trusted
      && ref.laneValid
      && ref.principalKey === args.callerPrincipalKey
      && ref.laneId) {
    return { kind: 'route_lane', laneId: ref.laneId, reason: 'trusted_own_reference' };
  }

  if (ref?.trusted
      && ref.laneValid
      && ref.principalKey
      && ref.principalKey !== args.callerPrincipalKey
      && ref.foreignTurnActive
      && ref.workerGenerationMatches
      && ref.sessionId
      && ref.laneId) {
    return { kind: 'suggestion', targetSessionId: ref.sessionId, targetLaneId: ref.laneId };
  }

  if (args.intent === 'explicit_suggest_current') {
    return { kind: 'reject_suggestion', reason: 'missing_current_task_reference' };
  }

  if (args.callerLaneId) {
    return { kind: 'route_lane', laneId: args.callerLaneId, reason: 'existing_caller_lane' };
  }
  return { kind: 'create_lane' };
}

export type LegacySourceMigrationDecision =
  | {
      kind: 'bind';
      principal: LanePrincipal;
      principalKey: string;
      evidence: 'owner_union_id' | 'same_app_owner_open_id';
    }
  | {
      kind: 'disable_principal_lanes';
      reason: 'caller_identity_unproven';
    };

/** Migration is deliberately evidence-based. It may disable principal lanes
 * for one legacy source, but it never disables that session's existing
 * single-principal behavior and never binds the first person who happens to
 * speak in a group. */
export function decideLegacySourceMigration(args: {
  session: Pick<Session, 'larkAppId' | 'ownerUnionId' | 'ownerOpenId'>;
  inboundLarkAppId: string;
  caller: InboundPrincipal;
}): LegacySourceMigrationDecision {
  const ownerUnionId = args.session.ownerUnionId?.trim();
  if (ownerUnionId
      && args.caller.kind === 'union'
      && args.caller.senderType === 'user'
      && args.caller.unionId === ownerUnionId) {
    return {
      kind: 'bind',
      principal: args.caller,
      principalKey: lanePrincipalKey(args.caller),
      evidence: 'owner_union_id',
    };
  }

  const ownerOpenId = args.session.ownerOpenId?.trim();
  if (!ownerUnionId
      && ownerOpenId
      && args.caller.kind === 'app_open'
      && args.caller.senderType === 'user'
      && args.session.larkAppId === args.inboundLarkAppId
      && args.caller.larkAppId === args.inboundLarkAppId
      && args.caller.openId === ownerOpenId) {
    return {
      kind: 'bind',
      principal: args.caller,
      principalKey: lanePrincipalKey(args.caller),
      evidence: 'same_app_owner_open_id',
    };
  }

  return { kind: 'disable_principal_lanes', reason: 'caller_identity_unproven' };
}

export function principalLaneDisplayTarget(
  session: Pick<Session, 'scope' | 'chatId' | 'rootMessageId' | 'larkAppId' | 'principalLane'>,
  expectedDisplayTarget: PrincipalLaneDisplayTarget,
): PrincipalLaneDisplayTarget | undefined {
  if (session.larkAppId && session.larkAppId !== expectedDisplayTarget.larkAppId) return undefined;
  if (session.principalLane) {
    const parsed = parsePrincipalLaneBinding(session.principalLane, { displayTarget: expectedDisplayTarget });
    return parsed.ok ? parsed.value.displayTarget : undefined;
  }
  const carrierTarget: PrincipalLaneDisplayTarget = session.scope === 'chat'
    ? { scope: 'chat', larkAppId: expectedDisplayTarget.larkAppId, chatId: session.chatId }
    : {
        scope: 'thread', larkAppId: expectedDisplayTarget.larkAppId,
        chatId: session.chatId, rootMessageId: session.rootMessageId,
      };
  return sameDisplayTarget(carrierTarget, expectedDisplayTarget) ? carrierTarget : undefined;
}

/** Build the authoritative visible target from the persisted source session,
 * never from the current inbound event or a shadow lane's self-description. */
export function sourceSessionDisplayTarget(
  session: Pick<Session, 'scope' | 'chatId' | 'rootMessageId' | 'larkAppId'>,
  owningLarkAppId: string,
): PrincipalLaneDisplayTarget | undefined {
  if (session.larkAppId && session.larkAppId !== owningLarkAppId) return undefined;
  if (!nonemptyString(session.chatId)) return undefined;
  if (session.scope === 'chat') {
    return { scope: 'chat', larkAppId: owningLarkAppId, chatId: session.chatId };
  }
  // Legacy rows omitted scope and were thread-scoped. Every other persisted
  // value is malformed and must not be normalized into a trusted target.
  if (session.scope !== undefined && session.scope !== 'thread') return undefined;
  if (!nonemptyString(session.rootMessageId)) return undefined;
  return {
    scope: 'thread',
    larkAppId: owningLarkAppId,
    chatId: session.chatId,
    rootMessageId: session.rootMessageId,
  };
}

export type PrincipalLaneBindingParseError =
  | 'not_object'
  | 'unsupported_version'
  | 'invalid_lane_id'
  | 'invalid_source_session_id'
  | 'source_session_mismatch'
  | 'invalid_principal'
  | 'principal_app_mismatch'
  | 'principal_key_mismatch'
  | 'invalid_routing_anchor'
  | 'invalid_display_target'
  | 'display_app_mismatch'
  | 'display_scope_mismatch'
  | 'display_chat_mismatch'
  | 'display_root_mismatch'
  | 'invalid_workspace_epoch'
  | 'invalid_phase'
  | 'invalid_revision'
  | 'invalid_timestamp'
  | 'invalid_quarantine_reason';

export type PrincipalLaneBindingParseResult =
  | { ok: true; value: PrincipalLaneBinding }
  | { ok: false; error: PrincipalLaneBindingParseError };

const PRINCIPAL_LANE_PHASES = new Set([
  'creating', 'active', 'dormant', 'closing', 'closed', 'quarantined',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function canonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function parseLanePrincipal(value: unknown): HumanLanePrincipal | undefined {
  const candidate = record(value);
  if (!candidate || candidate.senderType !== 'user') return undefined;
  if (candidate.kind === 'union' && nonemptyString(candidate.unionId)) {
    return { senderType: candidate.senderType, kind: 'union', unionId: candidate.unionId };
  }
  if (candidate.kind === 'app_open'
      && nonemptyString(candidate.larkAppId)
      && nonemptyString(candidate.openId)) {
    return {
      senderType: candidate.senderType,
      kind: 'app_open',
      larkAppId: candidate.larkAppId,
      openId: candidate.openId,
    };
  }
  return undefined;
}

function sameDisplayTarget(
  actual: PrincipalLaneDisplayTarget,
  expected: PrincipalLaneDisplayTarget,
): boolean {
  return actual.larkAppId === expected.larkAppId
    && actual.scope === expected.scope
    && actual.chatId === expected.chatId
    && (actual.scope !== 'thread'
      || (expected.scope === 'thread' && actual.rootMessageId === expected.rootMessageId));
}

/** No-throw durable decoder. Callers must quarantine an invalid row and keep
 * restoring unrelated sessions; they must not cast persisted JSON to the TS
 * interface or infer missing authority. */
export function parsePrincipalLaneBinding(
  value: unknown,
  expected: { displayTarget: PrincipalLaneDisplayTarget; sourceSessionId?: string },
): PrincipalLaneBindingParseResult {
  const candidate = record(value);
  if (!candidate) return { ok: false, error: 'not_object' };
  if (candidate.version !== 1) return { ok: false, error: 'unsupported_version' };
  if (!nonemptyString(candidate.laneId)) return { ok: false, error: 'invalid_lane_id' };
  if (!nonemptyString(candidate.sourceSessionId)) return { ok: false, error: 'invalid_source_session_id' };
  if (expected.sourceSessionId && candidate.sourceSessionId !== expected.sourceSessionId) {
    return { ok: false, error: 'source_session_mismatch' };
  }
  const principal = parseLanePrincipal(candidate.principal);
  if (!principal) return { ok: false, error: 'invalid_principal' };
  if (principal.kind === 'app_open' && principal.larkAppId !== expected.displayTarget.larkAppId) {
    return { ok: false, error: 'principal_app_mismatch' };
  }
  if (!nonemptyString(candidate.principalKey)
      || candidate.principalKey !== lanePrincipalKey(principal)) {
    return { ok: false, error: 'principal_key_mismatch' };
  }
  if (!nonemptyString(candidate.routingAnchor)) return { ok: false, error: 'invalid_routing_anchor' };

  const display = record(candidate.displayTarget);
  if (!display
      || (display.scope !== 'chat' && display.scope !== 'thread')
      || !nonemptyString(display.larkAppId)
      || !nonemptyString(display.chatId)
      || (display.scope === 'thread' && !nonemptyString(display.rootMessageId))) {
    return { ok: false, error: 'invalid_display_target' };
  }
  if (display.larkAppId !== expected.displayTarget.larkAppId) {
    return { ok: false, error: 'display_app_mismatch' };
  }
  if (display.scope !== expected.displayTarget.scope) {
    return { ok: false, error: 'display_scope_mismatch' };
  }
  if (display.chatId !== expected.displayTarget.chatId) {
    return { ok: false, error: 'display_chat_mismatch' };
  }
  if (display.scope === 'thread'
      && expected.displayTarget.scope === 'thread'
      && display.rootMessageId !== expected.displayTarget.rootMessageId) {
    return { ok: false, error: 'display_root_mismatch' };
  }
  if (!Number.isSafeInteger(candidate.workspaceEpoch) || Number(candidate.workspaceEpoch) < 1) {
    return { ok: false, error: 'invalid_workspace_epoch' };
  }
  if (typeof candidate.phase !== 'string' || !PRINCIPAL_LANE_PHASES.has(candidate.phase)) {
    return { ok: false, error: 'invalid_phase' };
  }
  if (!Number.isSafeInteger(candidate.revision) || Number(candidate.revision) < 1) {
    return { ok: false, error: 'invalid_revision' };
  }
  if (!canonicalIsoTimestamp(candidate.createdAt) || !canonicalIsoTimestamp(candidate.updatedAt)) {
    return { ok: false, error: 'invalid_timestamp' };
  }
  if (candidate.quarantineReason !== undefined && typeof candidate.quarantineReason !== 'string') {
    return { ok: false, error: 'invalid_quarantine_reason' };
  }

  const displayTarget: PrincipalLaneDisplayTarget = display.scope === 'chat'
    ? { scope: 'chat', larkAppId: display.larkAppId, chatId: display.chatId }
    : {
        scope: 'thread',
        larkAppId: display.larkAppId,
        chatId: display.chatId,
        rootMessageId: display.rootMessageId as string,
      };
  return {
    ok: true,
    value: {
      version: 1,
      laneId: candidate.laneId,
      sourceSessionId: candidate.sourceSessionId,
      principalKey: candidate.principalKey,
      principal,
      routingAnchor: candidate.routingAnchor,
      displayTarget,
      workspaceEpoch: Number(candidate.workspaceEpoch),
      phase: candidate.phase as PrincipalLaneBinding['phase'],
      revision: Number(candidate.revision),
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
      ...(typeof candidate.quarantineReason === 'string'
        ? { quarantineReason: candidate.quarantineReason }
        : {}),
    },
  };
}

export function validPrincipalLaneBinding(
  value: unknown,
  expected: { displayTarget: PrincipalLaneDisplayTarget; sourceSessionId?: string },
): boolean {
  return parsePrincipalLaneBinding(value, expected).ok;
}

export type PrincipalLaneSourceParseResult =
  | { ok: true; value: PrincipalLaneSourceState }
  | { ok: false; error: string };

export function parsePrincipalLaneSourceState(
  value: unknown,
  expectedDisplayTarget: PrincipalLaneDisplayTarget,
  expectedSourceSessionId: string,
): PrincipalLaneSourceParseResult {
  const candidate = record(value);
  if (!candidate) return { ok: false, error: 'not_object' };
  if (candidate.version !== 1) return { ok: false, error: 'unsupported_version' };
  if (!nonemptyString(candidate.sourcePrincipalKey)) return { ok: false, error: 'invalid_source_principal_key' };
  if (!nonemptyString(candidate.canonicalCwd)) return { ok: false, error: 'invalid_canonical_cwd' };
  if (!Number.isSafeInteger(candidate.workspaceEpoch) || Number(candidate.workspaceEpoch) < 1) {
    return { ok: false, error: 'invalid_workspace_epoch' };
  }
  if (!nonemptyString(candidate.workspaceGroupId)) return { ok: false, error: 'invalid_workspace_group_id' };
  const groupIdentity = validPrincipalWorkspaceGroupIdentity({
    sourceSessionId: expectedSourceSessionId,
    larkAppId: expectedDisplayTarget.larkAppId,
    canonicalCwd: candidate.canonicalCwd,
    workspaceEpoch: Number(candidate.workspaceEpoch),
    workspaceGroupId: candidate.workspaceGroupId,
    workspaceGroupKeyVersion: candidate.workspaceGroupKeyVersion,
    workspaceGroupKeyVersionPresent: Object.prototype.hasOwnProperty.call(
      candidate, 'workspaceGroupKeyVersion',
    ),
  });
  if (!groupIdentity.ok) return { ok: false, error: groupIdentity.error };
  if (typeof candidate.phase !== 'string' || !PRINCIPAL_LANE_PHASES.has(candidate.phase)) {
    return { ok: false, error: 'invalid_phase' };
  }
  if (!Number.isSafeInteger(candidate.revision) || Number(candidate.revision) < 1) {
    return { ok: false, error: 'invalid_revision' };
  }
  if (!canonicalIsoTimestamp(candidate.updatedAt)) return { ok: false, error: 'invalid_timestamp' };
  const display = record(candidate.displayTarget);
  if (!display) return { ok: false, error: 'invalid_display_target' };
  const displayTarget: PrincipalLaneDisplayTarget | undefined = display.scope === 'chat'
      && nonemptyString(display.larkAppId)
      && nonemptyString(display.chatId)
    ? { scope: 'chat', larkAppId: display.larkAppId, chatId: display.chatId }
    : display.scope === 'thread'
      && nonemptyString(display.larkAppId)
      && nonemptyString(display.chatId)
      && nonemptyString(display.rootMessageId)
      ? {
          scope: 'thread', larkAppId: display.larkAppId,
          chatId: display.chatId, rootMessageId: display.rootMessageId,
        }
      : undefined;
  if (!displayTarget) return { ok: false, error: 'invalid_display_target' };
  if (!sameDisplayTarget(displayTarget, expectedDisplayTarget)) {
    return { ok: false, error: 'display_target_mismatch' };
  }
  if (candidate.leaseOwner !== undefined && typeof candidate.leaseOwner !== 'string') {
    return { ok: false, error: 'invalid_lease_owner' };
  }
  if (candidate.leaseGeneration !== undefined
      && (!Number.isSafeInteger(candidate.leaseGeneration) || Number(candidate.leaseGeneration) < 1)) {
    return { ok: false, error: 'invalid_lease_generation' };
  }
  if (candidate.principalLaneDisabledReason !== undefined
      && typeof candidate.principalLaneDisabledReason !== 'string') {
    return { ok: false, error: 'invalid_disabled_reason' };
  }
  const audit = record(candidate.migrationAudit);
  if (audit
      && ((audit.evidence !== 'owner_union_id' && audit.evidence !== 'same_app_owner_open_id')
        || !canonicalIsoTimestamp(audit.migratedAt)
        || !nonemptyString(audit.larkAppId))) {
    return { ok: false, error: 'invalid_migration_audit' };
  }
  return {
    ok: true,
    value: {
      version: 1,
      sourcePrincipalKey: candidate.sourcePrincipalKey,
      displayTarget,
      canonicalCwd: candidate.canonicalCwd,
      workspaceEpoch: Number(candidate.workspaceEpoch),
      workspaceGroupId: candidate.workspaceGroupId,
      ...(groupIdentity.version === 2 ? { workspaceGroupKeyVersion: 2 as const } : {}),
      phase: candidate.phase as PrincipalLaneSourceState['phase'],
      revision: Number(candidate.revision),
      updatedAt: candidate.updatedAt,
      ...(typeof candidate.leaseOwner === 'string' ? { leaseOwner: candidate.leaseOwner } : {}),
      ...(typeof candidate.leaseGeneration === 'number'
        ? { leaseGeneration: candidate.leaseGeneration }
        : {}),
      ...(typeof candidate.principalLaneDisabledReason === 'string'
        ? { principalLaneDisabledReason: candidate.principalLaneDisabledReason }
        : {}),
      ...(audit ? {
        migrationAudit: {
          evidence: audit.evidence as 'owner_union_id' | 'same_app_owner_open_id',
          migratedAt: audit.migratedAt as string,
          larkAppId: audit.larkAppId as string,
        },
      } : {}),
    },
  };
}
