import { createHash } from 'node:crypto';
import type {
  CliTurnPayload,
  Session,
  TrustedCaller,
  XpiSharedCwdAdmissionLease,
  XpiSharedCwdDispatchUnknownNotice,
  XpiSharedCwdQuarantine,
  XpiSharedCwdQueuedTurn,
} from '../types.js';

export type XpiSharedCwdQuarantineNotice = {
  sessionId: string;
  scope: XpiSharedCwdQuarantine['scope'];
  reason: XpiSharedCwdQuarantine['reason'];
  detail: string;
};

export type XpiSharedCwdRecoveryResult = {
  changedSessionIds: Set<string>;
  quarantinedSessionIds: Set<string>;
  notices: XpiSharedCwdQuarantineNotice[];
  dispatchUnknownNotices: XpiSharedCwdDispatchUnknownStartupNotice[];
};

export type XpiSharedCwdDispatchUnknownStartupNotice = {
  sessionId: string;
  recordId: string;
  turnId: string;
  caller: TrustedCaller;
  detail: string;
};

export type XpiSharedCwdStartupNotice =
  | XpiSharedCwdQuarantineNotice
  | XpiSharedCwdDispatchUnknownStartupNotice;

/** A grouped turn is already a durable copy of user input. Keep the queue
 * bounded so a wedged or deliberately flooded group cannot grow sessions.db
 * without limit while preserving the oldest FIFO entries for recovery. */
export const MAX_XPI_SHARED_CWD_QUEUED_TURNS = 32;

export class XpiSharedCwdQueueFullError extends Error {
  constructor(readonly sessionId: string) {
    super(`XPI shared-cwd queue is full for session ${sessionId}`);
    this.name = 'XpiSharedCwdQueueFullError';
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validCaller(value: unknown): value is TrustedCaller {
  if (!value || typeof value !== 'object') return false;
  const caller = value as TrustedCaller;
  if (!nonEmpty(caller.requestLarkAppId)) return false;
  if (!nonEmpty(caller.requestUserOpenId) && !nonEmpty(caller.requestUserUnionId)) return false;
  if (caller.requestUserOpenId !== undefined && !nonEmpty(caller.requestUserOpenId)) return false;
  if (caller.requestUserUnionId !== undefined && !nonEmpty(caller.requestUserUnionId)) return false;
  if (caller.senderType !== undefined && caller.senderType !== 'user' && caller.senderType !== 'bot') return false;
  if (caller.source !== undefined && caller.source !== 'schedule_creator') return false;
  if (caller.source === 'schedule_creator') return nonEmpty(caller.taskId);
  return caller.taskId === undefined;
}

export function xpiSharedCwdQueuedTurnId(sessionId: string, turnId: string): string {
  return `xpicwd_${createHash('sha256').update(`${sessionId}\0${turnId}`).digest('hex').slice(0, 24)}`;
}

function malformedQueueDetail(session: Session): string | undefined {
  for (const record of session.xpiSharedCwdQueuedTurns ?? []) {
    if (record.version !== 1
      || !nonEmpty(record.id)
      || !nonEmpty(record.turnId)
      || record.id !== xpiSharedCwdQueuedTurnId(session.sessionId, record.turnId)
      || !nonEmpty(record.createdAt)
      || typeof record.userPrompt !== 'string'
      || typeof record.resume !== 'boolean'
      || (record.dispatchState !== undefined
        && record.dispatchState !== 'queued'
        && record.dispatchState !== 'attempting')
      || !validCaller(record.caller)
      || typeof record.cliInput?.content !== 'string') {
      return `session ${session.sessionId} contains a malformed XPI shared-cwd queue record`;
    }
  }
  return undefined;
}

function setQuarantine(
  session: Session,
  quarantine: Omit<XpiSharedCwdQuarantine, 'version' | 'detectedAt' | 'noticePending'>,
  detectedAt: string,
): boolean {
  const prior = session.xpiSharedCwdQuarantine;
  let changed = false;
  // Reuse the existing durable route-reservation quarantine. Merely filtering
  // this row out of restore would leave its anchor free for a replacement
  // session beside a possibly-live persistent backend.
  if (!session.restoreQuarantinedAt) {
    session.restoreQuarantinedAt = detectedAt;
    changed = true;
  }
  // A row already contained as part of an ambiguous authority group must not
  // be downgraded merely because it also carries one malformed session-local
  // record. Group quarantine is the stronger safety verdict.
  if (prior?.scope === 'group' && quarantine.scope === 'session') return changed;
  if (prior?.scope === quarantine.scope
    && prior.reason === quarantine.reason
    && prior.detail === quarantine.detail) return changed;
  session.xpiSharedCwdQuarantine = {
    version: 1,
    ...quarantine,
    detectedAt,
    noticePending: true,
  };
  return true;
}

function addQuarantine(
  result: XpiSharedCwdRecoveryResult,
  session: Session,
  quarantine: Omit<XpiSharedCwdQuarantine, 'version' | 'detectedAt' | 'noticePending'>,
  detectedAt: string,
): void {
  result.quarantinedSessionIds.add(session.sessionId);
  if (setQuarantine(session, quarantine, detectedAt)) result.changedSessionIds.add(session.sessionId);
  if (session.xpiSharedCwdQuarantine?.noticePending
    && !result.notices.some(notice => notice.sessionId === session.sessionId
      && notice.reason === quarantine.reason)) {
    result.notices.push({ sessionId: session.sessionId, ...quarantine });
  }
}

function staleLegacyXpiDetail(session: Session, now: number): string | undefined {
  for (const record of session.crossPrincipalInterruptions ?? []) {
    const staleClassification = record.phase === 'awaiting_classification'
      && record.classificationDeadlineAt !== undefined
      && record.classificationDeadlineAt <= now;
    const staleOwner = record.phase === 'awaiting_owner'
      && record.ownerDeadlineAt !== undefined
      && record.ownerDeadlineAt <= now;
    if (staleClassification || staleOwner) {
      return `session ${session.sessionId} contains expired legacy XPI state that this build must not reanimate`;
    }
  }
  return undefined;
}

function quarantineGroup(
  result: XpiSharedCwdRecoveryResult,
  members: readonly Session[],
  reason: XpiSharedCwdQuarantine['reason'],
  detail: string,
  detectedAt: string,
): void {
  for (const member of members) addQuarantine(result, member, { scope: 'group', reason, detail }, detectedAt);
}

/**
 * Restore-only validation for the narrow XPI fallback admission state.
 * Every failure is contained to one stale XPI session or one explicit group;
 * callers may restore every session absent from `quarantinedSessionIds`.
 */
export function reconcileXpiSharedCwdRecovery(
  sessions: readonly Session[],
  now: number,
  options: { containRestoreQuarantinedSessionIds?: ReadonlySet<string> } = {},
): XpiSharedCwdRecoveryResult {
  const result: XpiSharedCwdRecoveryResult = {
    changedSessionIds: new Set(),
    quarantinedSessionIds: new Set(),
    notices: [],
    dispatchUnknownNotices: [],
  };
  const detectedAt = new Date(now).toISOString();

  for (const session of sessions) {
    for (const notice of session.xpiSharedCwdDispatchUnknownNotices ?? []) {
      if (notice.noticePending !== true) continue;
      result.dispatchUnknownNotices.push({
        sessionId: session.sessionId,
        recordId: notice.id,
        turnId: notice.turnId,
        caller: structuredClone(notice.caller),
        detail: 'A previously dispatched XPI shared-cwd turn has an unknown outcome after daemon restart',
      });
    }
    const existingQuarantine = session.xpiSharedCwdQuarantine;
    if (existingQuarantine) {
      result.quarantinedSessionIds.add(session.sessionId);
      if (existingQuarantine.noticePending) {
        result.notices.push({
          sessionId: session.sessionId,
          scope: existingQuarantine.scope,
          reason: existingQuarantine.reason,
          detail: existingQuarantine.detail,
        });
      }
    }
    // A later restore phase can quarantine a persisted row after the initial
    // XPI reconcile has run. If it still owns a grouped FIFO entry but never
    // becomes a runtime DaemonSession, silently selecting that entry forever
    // blocks every healthy peer. Park it explicitly and detach it below: the
    // durable queue remains available for inspection, an owner notice is
    // emitted, and only then may the healthy remainder elect a coordinator.
    if (options.containRestoreQuarantinedSessionIds?.has(session.sessionId)
      && !existingQuarantine
      && session.restoreQuarantinedAt
      && session.xpiSharedCwdAdmissionGroupId) {
      const queued = session.xpiSharedCwdQueuedTurns?.length ?? 0;
      addQuarantine(result, session, {
        scope: 'session',
        reason: 'restore_quarantined_member',
        detail: `session ${session.sessionId} was quarantined during restore with ${queued} queued turn(s); those turns remain parked and will not be dispatched`,
      }, detectedAt);
    }
    const stale = staleLegacyXpiDetail(session, now);
    if (stale) {
      addQuarantine(result, session, {
        scope: 'session',
        reason: 'stale_legacy_xpi_record',
        detail: stale,
      }, detectedAt);
    }
    if (!existingQuarantine
      && !session.xpiSharedCwdAdmissionGroupId
      && (session.xpiSharedCwdAdmissionCoordinatorSessionId
        || session.xpiSharedCwdAdmissionLease
        || (session.xpiSharedCwdQueuedTurns?.length ?? 0) > 0)) {
      addQuarantine(result, session, {
        scope: 'group',
        reason: 'authority_without_group',
        detail: `session ${session.sessionId} carries XPI shared-cwd authority without a group id`,
      }, detectedAt);
    }
  }

  const groups = new Map<string, Session[]>();
  for (const session of sessions) {
    const groupId = session.xpiSharedCwdAdmissionGroupId;
    if (!groupId) continue;
    const members = groups.get(groupId) ?? [];
    members.push(session);
    groups.set(groupId, members);
  }

  for (const [groupId, members] of groups) {
    const priorGroupQuarantine = members.find(member => member.xpiSharedCwdQuarantine?.scope === 'group')
      ?.xpiSharedCwdQuarantine;
    if (priorGroupQuarantine) {
      quarantineGroup(result, members, priorGroupQuarantine.reason, priorGroupQuarantine.detail, detectedAt);
      continue;
    }
    for (const member of members) {
      const queueError = malformedQueueDetail(member);
      if (queueError) {
        addQuarantine(result, member, {
          scope: 'session',
          reason: 'malformed_queue',
          detail: queueError,
        }, detectedAt);
      }
    }
    const declared = new Set(members
      .map(member => member.xpiSharedCwdAdmissionCoordinatorSessionId)
      .filter(nonEmpty));
    if (declared.size > 1) {
      quarantineGroup(result, members, 'conflicting_coordinators',
        `XPI shared-cwd group ${groupId} has conflicting coordinator ids`, detectedAt);
      continue;
    }
    const leaseOwners = members.filter(member => member.xpiSharedCwdAdmissionLease);
    if (leaseOwners.length > 1) {
      quarantineGroup(result, members, 'lease_outside_coordinator',
        `XPI shared-cwd group ${groupId} has more than one durable lease row`, detectedAt);
      continue;
    }
    const declaredId = [...declared][0];
    if (declaredId && !members.some(member => member.sessionId === declaredId)) {
      quarantineGroup(result, members, 'coordinator_missing',
        `XPI shared-cwd group ${groupId} references a missing coordinator`, detectedAt);
      continue;
    }
    if (leaseOwners.length === 1 && leaseOwners[0]!.sessionId !== declaredId) {
      quarantineGroup(result, members, 'lease_outside_coordinator',
        `XPI shared-cwd group ${groupId} stores its lease outside the declared coordinator`, detectedAt);
      continue;
    }
    const lease = leaseOwners[0]?.xpiSharedCwdAdmissionLease;
    if (lease) {
      const holder = members.find(member => member.sessionId === lease.holderSessionId);
      if (lease.version !== 1
        || lease.groupId !== groupId
        || !holder
        || !nonEmpty(lease.turnId)
        || !Number.isSafeInteger(lease.workerGeneration)
        || lease.workerGeneration <= 0
        || !nonEmpty(lease.acquiredAt)
        || holder.workerGeneration !== lease.workerGeneration) {
        quarantineGroup(result, members, 'ambiguous_lease',
          `XPI shared-cwd group ${groupId} has an internally inconsistent durable lease`, detectedAt);
      } else {
        const journals = holder.xpiSharedCwdQueuedTurns?.filter(record =>
          record.id === xpiSharedCwdQueuedTurnId(holder.sessionId, lease.turnId)
          && record.turnId === lease.turnId
          && record.dispatchState === 'attempting') ?? [];
        if (journals.length !== 1) {
          quarantineGroup(result, members, 'ambiguous_lease',
            `XPI shared-cwd group ${groupId} cannot match its lease to one attempting journal`, detectedAt);
          continue;
        }
        const journal = journals[0]!;
        // The previous daemon crossed the durable commit-unknown barrier. Do
        // not replay the turn and do not freeze an otherwise healthy group:
        // atomically terminalize the exact journal, release the lease, and keep
        // a durable owner-visible notice until delivery succeeds.
        leaseOwners[0]!.xpiSharedCwdAdmissionLease = undefined;
        removeXpiSharedCwdTurn(holder, journal.id);
        const notices = holder.xpiSharedCwdDispatchUnknownNotices
          ?? (holder.xpiSharedCwdDispatchUnknownNotices = []);
        let durable = notices.find(notice => notice.id === journal.id);
        if (!durable) {
          durable = {
            version: 1,
            id: journal.id,
            turnId: journal.turnId,
            caller: structuredClone(journal.caller),
            detectedAt,
            noticePending: true,
          } satisfies XpiSharedCwdDispatchUnknownNotice;
          notices.push(durable);
        }
        result.changedSessionIds.add(leaseOwners[0]!.sessionId);
        result.changedSessionIds.add(holder.sessionId);
        result.dispatchUnknownNotices.push({
          sessionId: holder.sessionId,
          recordId: durable.id,
          turnId: durable.turnId,
          caller: structuredClone(durable.caller),
          detail: `XPI shared-cwd turn ${durable.turnId} crossed the dispatch barrier before daemon restart; outcome is unknown and it will not be replayed`,
        });
      }
      continue;
    }

    // With no surviving lease, a session-local bad record can be detached
    // without inventing execution authority. Persist that detachment now so a
    // later boot cannot see the old coordinator declaration beside the newly
    // elected one and incorrectly escalate one bad row into a group quarantine.
    for (const member of members) {
      if (member.xpiSharedCwdQuarantine?.scope !== 'session') continue;
      member.xpiSharedCwdAdmissionGroupId = undefined;
      member.xpiSharedCwdAdmissionCoordinatorSessionId = undefined;
      member.xpiSharedCwdAdmissionLease = undefined;
      result.changedSessionIds.add(member.sessionId);
    }
    const recoverable = members
      .filter(member => !result.quarantinedSessionIds.has(member.sessionId) && member.status === 'active')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sessionId.localeCompare(b.sessionId));
    if (recoverable.length === 0) continue;
    const coordinatorId = declaredId && recoverable.some(member => member.sessionId === declaredId)
      ? declaredId
      : recoverable[0]!.sessionId;
    for (const member of recoverable) {
      if (member.xpiSharedCwdAdmissionCoordinatorSessionId !== coordinatorId) {
        member.xpiSharedCwdAdmissionCoordinatorSessionId = coordinatorId;
        result.changedSessionIds.add(member.sessionId);
      }
    }
  }
  return result;
}

export function enqueueXpiSharedCwdTurn(args: {
  session: Session;
  turnId: string;
  caller: TrustedCaller;
  userPrompt: string;
  cliInput: CliTurnPayload;
  resume: boolean;
  createdAt: string;
}): { record: XpiSharedCwdQueuedTurn; inserted: boolean } {
  const id = xpiSharedCwdQueuedTurnId(args.session.sessionId, args.turnId);
  const queue = args.session.xpiSharedCwdQueuedTurns
    ?? (args.session.xpiSharedCwdQueuedTurns = []);
  const existing = queue.find(item => item.id === id);
  if (existing) return { record: existing, inserted: false };
  if (queue.length >= MAX_XPI_SHARED_CWD_QUEUED_TURNS) {
    throw new XpiSharedCwdQueueFullError(args.session.sessionId);
  }
  const record: XpiSharedCwdQueuedTurn = {
    version: 1,
    id,
    turnId: args.turnId,
    caller: structuredClone(args.caller),
    userPrompt: args.userPrompt,
    cliInput: structuredClone(args.cliInput),
    resume: args.resume,
    createdAt: args.createdAt,
    dispatchState: 'queued',
  };
  queue.push(record);
  return { record, inserted: true };
}

export function removeXpiSharedCwdTurn(session: Session, id: string): boolean {
  const queue = session.xpiSharedCwdQueuedTurns;
  if (!queue) return false;
  const next = queue.filter(item => item.id !== id);
  if (next.length === queue.length) return false;
  session.xpiSharedCwdQueuedTurns = next.length > 0 ? next : undefined;
  return true;
}

export function selectNextXpiSharedCwdTurn(
  sessions: readonly Session[],
  groupId: string,
): { session: Session; record: XpiSharedCwdQueuedTurn } | undefined {
  return sessions
    .filter(session => session.status === 'active'
      && session.xpiSharedCwdAdmissionGroupId === groupId
      && !session.xpiSharedCwdQuarantine)
    .flatMap(session => (session.xpiSharedCwdQueuedTurns ?? [])
      .filter(record => (record.dispatchState ?? 'queued') === 'queued')
      .map(record => ({ session, record })))
    .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt)
      || a.record.id.localeCompare(b.record.id))[0];
}

export function xpiSharedCwdCoordinator(
  sessions: readonly Session[],
  member: Session,
): Session | undefined {
  const coordinatorId = member.xpiSharedCwdAdmissionCoordinatorSessionId;
  const groupId = member.xpiSharedCwdAdmissionGroupId;
  if (!groupId || !coordinatorId || member.xpiSharedCwdQuarantine) return undefined;
  return sessions.find(session => session.status === 'active'
    && !session.xpiSharedCwdQuarantine
    && session.sessionId === coordinatorId
    && session.xpiSharedCwdAdmissionGroupId === groupId);
}

export function tryAcquireXpiSharedCwdAdmission(args: {
  sessions: readonly Session[];
  member: Session;
  turnId: string;
  workerGeneration: number;
  now: string;
}): { status: 'unmanaged' }
  | { status: 'unavailable' }
  | { status: 'busy'; coordinator: Session; lease: XpiSharedCwdAdmissionLease }
  | { status: 'acquired'; coordinator: Session; lease: XpiSharedCwdAdmissionLease; changed: boolean } {
  const groupId = args.member.xpiSharedCwdAdmissionGroupId;
  if (!groupId) return { status: 'unmanaged' };
  if (!Number.isSafeInteger(args.workerGeneration) || args.workerGeneration <= 0) {
    return { status: 'unavailable' };
  }
  const coordinator = xpiSharedCwdCoordinator(args.sessions, args.member);
  if (!coordinator) return { status: 'unavailable' };
  const current = coordinator.xpiSharedCwdAdmissionLease;
  if (current) {
    const exact = current.holderSessionId === args.member.sessionId
      && current.turnId === args.turnId
      && current.workerGeneration === args.workerGeneration;
    return exact
      ? { status: 'acquired', coordinator, lease: current, changed: false }
      : { status: 'busy', coordinator, lease: current };
  }
  const lease: XpiSharedCwdAdmissionLease = {
    version: 1,
    groupId,
    holderSessionId: args.member.sessionId,
    turnId: args.turnId,
    workerGeneration: args.workerGeneration,
    acquiredAt: args.now,
  };
  coordinator.xpiSharedCwdAdmissionLease = lease;
  return { status: 'acquired', coordinator, lease, changed: true };
}

export function releaseXpiSharedCwdAdmission(args: {
  sessions: readonly Session[];
  member: Session;
  turnId?: string;
  workerGeneration: number;
  reason: 'terminal' | 'worker_exit';
}): { released: boolean; coordinator?: Session; groupId?: string; lease?: XpiSharedCwdAdmissionLease } {
  const groupId = args.member.xpiSharedCwdAdmissionGroupId;
  if (!groupId) return { released: false };
  const coordinator = xpiSharedCwdCoordinator(args.sessions, args.member);
  if (!coordinator) return { released: false };
  const lease = coordinator.xpiSharedCwdAdmissionLease;
  if (!lease
    || lease.holderSessionId !== args.member.sessionId
    || lease.workerGeneration !== args.workerGeneration
    || (args.reason === 'terminal' && lease.turnId !== args.turnId)) {
    return { released: false, coordinator, groupId };
  }
  coordinator.xpiSharedCwdAdmissionLease = undefined;
  return { released: true, coordinator, groupId, lease };
}

export type XpiSharedCwdCloseResult = {
  changedSessionIds: Set<string>;
  quarantinedSessionIds: Set<string>;
  notices: XpiSharedCwdQuarantineNotice[];
  groupId?: string;
};

/**
 * Complete coordinator migration only after closeSession's exact worker-exit
 * fence resolves. The hot path never calls this and never elects a coordinator.
 */
export function finalizeXpiSharedCwdMemberClose(args: {
  sessions: readonly Session[];
  closedSessionId: string;
  closedWorkerGeneration?: number;
  workerExitProven: boolean;
  now: number;
}): XpiSharedCwdCloseResult {
  const changedSessionIds = new Set<string>();
  const quarantinedSessionIds = new Set<string>();
  const notices: XpiSharedCwdQuarantineNotice[] = [];
  const closed = args.sessions.find(session => session.sessionId === args.closedSessionId);
  const groupId = closed?.xpiSharedCwdAdmissionGroupId;
  if (!closed || !groupId) return { changedSessionIds, quarantinedSessionIds, notices };
  const members = args.sessions.filter(session => session.xpiSharedCwdAdmissionGroupId === groupId);
  const coordinatorId = closed.xpiSharedCwdAdmissionCoordinatorSessionId;
  const detectedAt = new Date(args.now).toISOString();
  const quarantineRemaining = (detail: string): XpiSharedCwdCloseResult => {
    const recoveryShape: XpiSharedCwdRecoveryResult = {
      changedSessionIds,
      quarantinedSessionIds,
      notices,
      dispatchUnknownNotices: [],
    };
    quarantineGroup(recoveryShape, members.filter(member => member.status === 'active'),
      'close_migration_unproven', detail, detectedAt);
    return { changedSessionIds, quarantinedSessionIds, notices, groupId };
  };

  if (!coordinatorId || !members.some(member => member.sessionId === coordinatorId)) {
    return quarantineRemaining(`XPI shared-cwd group ${groupId} lost its coordinator during close`);
  }
  const coordinator = members.find(member => member.sessionId === coordinatorId)!;
  if (coordinatorId !== closed.sessionId) {
    const lease = coordinator.xpiSharedCwdAdmissionLease;
    if (lease?.holderSessionId === closed.sessionId) {
      if (!args.workerExitProven
        || args.closedWorkerGeneration === undefined
        || lease.workerGeneration !== args.closedWorkerGeneration) {
        return quarantineRemaining(`XPI shared-cwd group ${groupId} cannot prove the closing holder generation exited`);
      }
      coordinator.xpiSharedCwdAdmissionLease = undefined;
      changedSessionIds.add(coordinator.sessionId);
    }
    closed.xpiSharedCwdQueuedTurns = undefined;
    closed.xpiSharedCwdAdmissionGroupId = undefined;
    closed.xpiSharedCwdAdmissionCoordinatorSessionId = undefined;
    closed.xpiSharedCwdAdmissionLease = undefined;
    changedSessionIds.add(closed.sessionId);
    return { changedSessionIds, quarantinedSessionIds, notices, groupId };
  }

  const lease = coordinator.xpiSharedCwdAdmissionLease;
  if (lease?.holderSessionId === closed.sessionId
    && (!args.workerExitProven
      || args.closedWorkerGeneration === undefined
      || lease.workerGeneration !== args.closedWorkerGeneration)) {
    return quarantineRemaining(`XPI shared-cwd group ${groupId} cannot prove the closing holder generation exited`);
  }
  if (lease && lease.holderSessionId !== closed.sessionId) {
    const holder = members.find(member => member.sessionId === lease.holderSessionId);
    if (!holder || holder.status !== 'active' || holder.workerGeneration !== lease.workerGeneration) {
      return quarantineRemaining(`XPI shared-cwd group ${groupId} cannot prove the surviving lease holder`);
    }
  }

  const successor = members
    .filter(member => member.sessionId !== closed.sessionId
      && member.status === 'active'
      && !member.xpiSharedCwdQuarantine)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sessionId.localeCompare(b.sessionId))[0];
  const survivingLease = lease?.holderSessionId === closed.sessionId ? undefined : lease;
  if (successor) {
    successor.xpiSharedCwdAdmissionLease = survivingLease;
    for (const member of members) {
      if (member.status !== 'active' || member.xpiSharedCwdQuarantine) continue;
      member.xpiSharedCwdAdmissionCoordinatorSessionId = successor.sessionId;
      changedSessionIds.add(member.sessionId);
      if (member !== successor) member.xpiSharedCwdAdmissionLease = undefined;
    }
  }
  closed.xpiSharedCwdQueuedTurns = undefined;
  closed.xpiSharedCwdAdmissionGroupId = undefined;
  closed.xpiSharedCwdAdmissionCoordinatorSessionId = undefined;
  closed.xpiSharedCwdAdmissionLease = undefined;
  changedSessionIds.add(closed.sessionId);
  return { changedSessionIds, quarantinedSessionIds, notices, groupId };
}
