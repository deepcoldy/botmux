import {
  findVcMeetingDeliveryByKey,
  listVcMeetingActiveProjectionsForReceiverSession,
} from './vc-meeting-delivery-store.js';
import type { Session, VcMeetingImTurnOrigin } from '../types.js';

/** Resolve explicit-IM authority by the worker's live turn id. The latest
 * quote target is presentation state only: message B may already be queued
 * while message A is still the live CLI turn. */
export function resolveVcMeetingImTurnOrigin(
  session: Pick<Session, 'sessionId' | 'vcMeetingImTurnOrigins'> | undefined,
  turnId: string | undefined,
): VcMeetingImTurnOrigin | undefined {
  if (!session || !turnId) return undefined;
  const origin = session.vcMeetingImTurnOrigins?.[turnId];
  if (!origin
    || origin.larkMessageId !== turnId
    || origin.receiverSessionId !== session.sessionId) return undefined;
  return origin;
}

export interface VcMeetingManagedSendOrigin {
  receiverSessionId: string;
  turnId?: string;
  dispatchAttempt?: number;
  receiverSession: boolean;
  /** Persisted current inbound Lark message id for an explicit human IM turn.
   * This is the trusted no-dispatchAttempt origin; callers must not populate it
   * from the CLI's static spawn environment. */
  currentImTurnId?: string;
  /** Worker UI may need to patch/freeze an already-created card after terminal;
   * new botmux send/ask effects must leave this false. */
  allowTerminalReceipt?: boolean;
}

export type VcMeetingManagedSendDecision =
  | { ok: true; kind: 'ordinary' | 'listener_thread' }
  | { ok: false; errorCode: 'origin_unproven' | 'receipt_not_found' | 'origin_mismatch' | 'silent_delivery'; error: string };

export interface VcMeetingLiveManagedOrigin {
  capability: string;
  turnId?: string;
  dispatchAttempt?: number;
}

export type VcMeetingManagedOriginVerification =
  | {
      ok: true;
      origin: {
        receiverSessionId: string;
        turnId?: string;
        dispatchAttempt?: number;
        currentImTurnId?: string;
      };
    }
  | Extract<VcMeetingManagedSendDecision, { ok: false }>;

export function isTrustedVcMeetingHostRelayParent(
  markerPresent: boolean,
  sessionWorkerPid: number | null | undefined,
  parentPid: number,
): boolean {
  return markerPresent
    && Number.isInteger(sessionWorkerPid)
    && (sessionWorkerPid ?? 0) > 1
    && sessionWorkerPid === parentPid;
}

/** Authorize a daemon-mediated exit (ask/action relay) against the worker's
 * live origin registry. The caller may prove the current turn with the rotating
 * capability (sandbox) or an exact live marker tuple (non-sandbox). */
export function evaluateVcMeetingManagedOriginClaim(
  dataDir: string,
  input: {
    receiverSessionId: string;
    currentImTurnId?: string;
    liveOrigin?: VcMeetingLiveManagedOrigin;
    claimedCapability?: string;
    claimedTurnId?: string;
    claimedDispatchAttempt?: number;
  },
): VcMeetingManagedSendDecision {
  const verified = verifyVcMeetingManagedOriginClaim(input);
  if (!verified.ok) return verified;
  return evaluateVcMeetingManagedSend(dataDir, {
    ...verified.origin,
    receiverSession: true,
  });
}

/**
 * Prove that a daemon-mediated request belongs to the worker's current turn,
 * without imposing a particular sink policy. `botmux send`/ask call the
 * evaluator above (which also enforces responseMode); the deterministic action
 * gate calls this verifier and then applies capability/sink-owner policy at the
 * hub. Keeping these concerns separate prevents `silent` from becoming either
 * an action bypass or an accidental blanket capability model.
 */
export function verifyVcMeetingManagedOriginClaim(
  input: {
    receiverSessionId: string;
    currentImTurnId?: string;
    liveOrigin?: VcMeetingLiveManagedOrigin;
    claimedCapability?: string;
    claimedTurnId?: string;
    claimedDispatchAttempt?: number;
  },
): VcMeetingManagedOriginVerification {
  const live = input.liveOrigin;
  const capabilityMatches = !!live && !!input.claimedCapability
    && input.claimedCapability === live.capability;
  const markerMatches = !!live && !!input.claimedTurnId
    && input.claimedTurnId === live.turnId
    && input.claimedDispatchAttempt === live.dispatchAttempt;
  if (!live || (!capabilityMatches && !markerMatches)) {
    return { ok: false, errorCode: 'origin_unproven', error: 'managed origin claim is stale or missing' };
  }
  return {
    ok: true,
    origin: {
      receiverSessionId: input.receiverSessionId,
      turnId: live.turnId,
      dispatchAttempt: live.dispatchAttempt,
      currentImTurnId: input.currentImTurnId,
    },
  };
}

/** Resolve a managed output decision from the durable receipt, not mutable
 * process-global "current turn" state. Missing origin evidence on a dedicated
 * receiver fails closed; ordinary sessions stay unchanged. */
export function evaluateVcMeetingManagedSend(
  dataDir: string,
  origin: VcMeetingManagedSendOrigin,
): VcMeetingManagedSendDecision {
  if (origin.dispatchAttempt === undefined) {
    if (origin.receiverSession) {
      if (origin.turnId && origin.currentImTurnId === origin.turnId) {
        return { ok: true, kind: 'listener_thread' };
      }
      return {
        ok: false,
        errorCode: 'origin_unproven',
        error: 'receiver-session send has no attributable durable attempt',
      };
    }
    return { ok: true, kind: 'ordinary' };
  }
  if (!origin.turnId) {
    return { ok: false, errorCode: 'origin_unproven', error: 'durable send has no turn id' };
  }
  const lookup = findVcMeetingDeliveryByKey(dataDir, origin.turnId);
  if (!lookup) {
    return { ok: false, errorCode: 'receipt_not_found', error: 'durable delivery receipt was not found' };
  }
  if (lookup.receiverSessionId !== origin.receiverSessionId
    || lookup.receipt.dispatchAttempt !== origin.dispatchAttempt) {
    return { ok: false, errorCode: 'origin_mismatch', error: 'send origin does not match the durable receipt attempt' };
  }
  if (!origin.allowTerminalReceipt && lookup.receipt.status !== 'dispatched') {
    return { ok: false, errorCode: 'origin_mismatch', error: 'durable delivery is no longer executing' };
  }
  const activeProjection = listVcMeetingActiveProjectionsForReceiverSession(
    dataDir,
    origin.receiverSessionId,
  ).some((projection) => projection.listenerAppId === lookup.memberKey.listenerAppId
    && projection.meetingId === lookup.memberKey.meetingId
    && projection.memberId === lookup.memberKey.memberId
    && projection.memberEpoch === lookup.memberKey.memberEpoch);
  if (!activeProjection) {
    return { ok: false, errorCode: 'origin_mismatch', error: 'membership is no longer active/current' };
  }
  // The policy is frozen on the receipt. Reading the current projection here
  // would let a later silent→listener_thread update retroactively authorize an
  // old silent attempt. Missing mode is an old WIP record and fails closed.
  if ((lookup.receipt.responseMode ?? 'silent') === 'silent') {
    return { ok: false, errorCode: 'silent_delivery', error: 'managed output is disabled for this silent delivery' };
  }
  return { ok: true, kind: 'listener_thread' };
}
