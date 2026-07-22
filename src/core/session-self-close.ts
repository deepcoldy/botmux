import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { DaemonSession } from './types.js';

const SELF_CLOSE_CAPABILITY_DOMAIN = 'botmux:session:self-close:v1';
const SELF_CLOSE_RECEIPT_TTL_MS = 5 * 60_000;
const SELF_CLOSE_RECEIPT_LIMIT = 1024;
const HEX_CAPABILITY_RE = /^[a-f0-9]{64}$/i;

export interface SessionSelfCloseClaim {
  capability: string;
  turnId: string;
  dispatchAttempt?: number;
}

interface SessionSelfCloseReceipt extends SessionSelfCloseClaim {
  sessionId: string;
  committedAt: number;
}

export type SessionSelfCloseAuthorization =
  | { ok: true; alreadyClosed: false; claim: SessionSelfCloseClaim; session: DaemonSession }
  | { ok: true; alreadyClosed: true; claim: SessionSelfCloseClaim; sessionId: string }
  | {
      ok: false;
      reason:
        | 'target_not_allowed'
        | 'capability_missing'
        | 'capability_malformed'
        | 'turn_missing'
        | 'dispatch_attempt_malformed'
        | 'origin_unproven'
        | 'origin_ambiguous'
        | 'turn_mismatch'
        | 'dispatch_attempt_mismatch';
    };

const committedReceipts = new Map<string, SessionSelfCloseReceipt>();

/**
 * Domain-separate self-close authority from the generic rotating origin token.
 * The daemon retains only the generic token on the live session; the CLI derives
 * this action-specific proof locally, and no other IPC endpoint accepts it.
 */
export function deriveSessionSelfCloseCapability(originCapability: string): string {
  return createHmac('sha256', originCapability)
    .update(SELF_CLOSE_CAPABILITY_DOMAIN)
    .digest('hex');
}

function capabilityDigest(capability: string): string {
  return createHash('sha256').update(capability).digest('hex');
}

function capabilitiesEqual(left: string, right: string): boolean {
  if (!HEX_CAPABILITY_RE.test(left) || !HEX_CAPABILITY_RE.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function parseClaim(body: Record<string, unknown>): SessionSelfCloseAuthorization | SessionSelfCloseClaim {
  // A self-close request has no caller-selectable target. Reject target-like
  // fields instead of silently ignoring them so a session can never believe it
  // closed a sibling because a legacy/admin-shaped payload happened to succeed.
  if ('sessionId' in body || 'targetSessionId' in body || 'target' in body) {
    return { ok: false, reason: 'target_not_allowed' };
  }
  if (typeof body.capability !== 'string') {
    return { ok: false, reason: 'capability_missing' };
  }
  if (!HEX_CAPABILITY_RE.test(body.capability)) {
    return { ok: false, reason: 'capability_malformed' };
  }
  if (typeof body.turnId !== 'string' || body.turnId.length === 0 || body.turnId.length > 256) {
    return { ok: false, reason: 'turn_missing' };
  }
  if (body.dispatchAttempt !== undefined
    && (typeof body.dispatchAttempt !== 'number'
      || !Number.isSafeInteger(body.dispatchAttempt)
      || body.dispatchAttempt < 1)) {
    return { ok: false, reason: 'dispatch_attempt_malformed' };
  }
  return {
    capability: body.capability,
    turnId: body.turnId,
    ...(body.dispatchAttempt !== undefined
      ? { dispatchAttempt: body.dispatchAttempt as number }
      : {}),
  };
}

function pruneReceipts(now: number): void {
  for (const [key, receipt] of committedReceipts) {
    if (now - receipt.committedAt > SELF_CLOSE_RECEIPT_TTL_MS) {
      committedReceipts.delete(key);
    }
  }
  while (committedReceipts.size > SELF_CLOSE_RECEIPT_LIMIT) {
    const oldest = committedReceipts.keys().next().value as string | undefined;
    if (!oldest) break;
    committedReceipts.delete(oldest);
  }
}

/**
 * Resolve the caller exclusively from an action-scoped capability. The request
 * never supplies a session id, bot id, chat id, or route key. A committed
 * duplicate is the sole replay exception: it returns the prior receipt without
 * executing lifecycle side effects again.
 */
export function authorizeSessionSelfClose(
  body: Record<string, unknown>,
  activeSessions: Iterable<DaemonSession>,
  now: number = Date.now(),
): SessionSelfCloseAuthorization {
  const parsed = parseClaim(body);
  if ('ok' in parsed) return parsed;
  const claim = parsed;
  pruneReceipts(now);

  const receipt = committedReceipts.get(capabilityDigest(claim.capability));
  if (receipt) {
    if (receipt.turnId !== claim.turnId
      || receipt.dispatchAttempt !== claim.dispatchAttempt) {
      return { ok: false, reason: 'origin_unproven' };
    }
    return {
      ok: true,
      alreadyClosed: true,
      claim,
      sessionId: receipt.sessionId,
    };
  }

  const matches: DaemonSession[] = [];
  for (const session of activeSessions) {
    const origin = session.managedTurnOrigin;
    if (!origin?.capability || !origin.turnId) continue;
    const expected = deriveSessionSelfCloseCapability(origin.capability);
    if (capabilitiesEqual(claim.capability, expected)) matches.push(session);
  }
  if (matches.length === 0) return { ok: false, reason: 'origin_unproven' };
  if (matches.length !== 1) return { ok: false, reason: 'origin_ambiguous' };

  const session = matches[0];
  const origin = session.managedTurnOrigin!;
  if (origin.turnId !== claim.turnId) return { ok: false, reason: 'turn_mismatch' };
  if (origin.dispatchAttempt !== claim.dispatchAttempt) {
    return { ok: false, reason: 'dispatch_attempt_mismatch' };
  }
  return { ok: true, alreadyClosed: false, claim, session };
}

export function recordCommittedSessionSelfClose(
  claim: SessionSelfCloseClaim,
  sessionId: string,
  now: number = Date.now(),
): void {
  pruneReceipts(now);
  committedReceipts.set(capabilityDigest(claim.capability), {
    ...claim,
    sessionId,
    committedAt: now,
  });
  pruneReceipts(now);
}

export function __testOnly_resetSessionSelfCloseReceipts(): void {
  committedReceipts.clear();
}
