import type {
  PrincipalLaneDispatchUnknownNotice,
  Session,
  TrustedCaller,
} from '../types.js';

export interface PrincipalLaneDispatchUnknownStartupNotice {
  kind: 'principal_lane_dispatch_unknown';
  sessionId: string;
  recordId: string;
  turnId: string;
  caller: TrustedCaller;
  detail: string;
}

export interface PrincipalLaneRecoveryQuarantineStartupNotice {
  kind: 'principal_lane_recovery_quarantine';
  sessionId: string;
  reason: 'ambiguous_queue' | 'recovery_persistence_failure';
  detail: string;
}

export type PrincipalLaneStartupNotice =
  | PrincipalLaneDispatchUnknownStartupNotice
  | PrincipalLaneRecoveryQuarantineStartupNotice;

export interface PrincipalLaneRecoveryResult {
  changed: boolean;
  quarantined: boolean;
  notices: PrincipalLaneDispatchUnknownStartupNotice[];
  detail?: string;
}

export function principalLaneDispatchUnknownNoticeId(
  sessionId: string,
  turnId: string,
): string {
  return `principal-lane-dispatch-unknown:${sessionId}:${turnId}`;
}

function pendingStartupNotices(session: Session): PrincipalLaneDispatchUnknownStartupNotice[] {
  return (session.principalLaneDispatchUnknownNotices ?? [])
    .filter(notice => notice.noticePending === true)
    .map(notice => ({
      kind: 'principal_lane_dispatch_unknown' as const,
      sessionId: session.sessionId,
      recordId: notice.id,
      turnId: notice.turnId,
      caller: structuredClone(notice.caller),
      detail: `Principal-lane turn ${notice.turnId} crossed the dispatch barrier; `
        + 'its outcome is unknown and it will not be replayed',
    }));
}

/** Remove one exact attempting FIFO head and create its durable notice in the
 * same caller-owned transaction. The returned row is never runnable again. */
export function terminalizePrincipalLaneAttemptingHead(
  session: Session,
  turnId: string,
  detectedAt: string,
): PrincipalLaneDispatchUnknownStartupNotice | undefined {
  const queued = session.principalLaneQueuedTurns;
  const head = queued?.[0];
  if (!head || head.turnId !== turnId || head.dispatchState !== 'attempting') return undefined;

  session.principalLaneQueuedTurns = queued.length > 1 ? queued.slice(1) : undefined;
  const notices = session.principalLaneDispatchUnknownNotices
    ?? (session.principalLaneDispatchUnknownNotices = []);
  const id = principalLaneDispatchUnknownNoticeId(session.sessionId, turnId);
  let durable = notices.find(notice => notice.id === id);
  if (!durable) {
    durable = {
      version: 1,
      id,
      turnId,
      caller: structuredClone(head.caller),
      detectedAt,
      noticePending: true,
    } satisfies PrincipalLaneDispatchUnknownNotice;
    notices.push(durable);
  }
  return {
    kind: 'principal_lane_dispatch_unknown',
    sessionId: session.sessionId,
    recordId: durable.id,
    turnId: durable.turnId,
    caller: structuredClone(durable.caller),
    detail: `Principal-lane turn ${durable.turnId} crossed the dispatch barrier; `
      + 'its outcome is unknown and it will not be replayed',
  };
}

/** Boot reconciliation runs before registration/ingress. A prior daemon's
 * attempting head can no longer produce a trusted terminal edge, so it is
 * atomically terminalized and replaced by a durable notice. */
export function reconcilePrincipalLaneRecovery(
  session: Session,
  detectedAt: string,
): PrincipalLaneRecoveryResult {
  if (!session.principalLane || session.status !== 'active') {
    return { changed: false, quarantined: false, notices: [] };
  }
  const queued = session.principalLaneQueuedTurns ?? [];
  const attempting = queued
    .map((turn, index) => ({ turn, index }))
    .filter(item => item.turn.dispatchState === 'attempting');
  if (attempting.length > 1 || attempting.some(item => item.index !== 0)) {
    session.restoreQuarantinedAt ??= detectedAt;
    return {
      changed: true,
      quarantined: true,
      notices: pendingStartupNotices(session),
      detail: 'principal-lane FIFO contains ambiguous attempting records',
    };
  }

  let changed = false;
  if (attempting.length === 1) {
    changed = !!terminalizePrincipalLaneAttemptingHead(
      session,
      attempting[0]!.turn.turnId,
      detectedAt,
    );
  }
  return {
    changed,
    quarantined: false,
    notices: pendingStartupNotices(session),
  };
}
