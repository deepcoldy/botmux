/**
 * Pairing-login HTTP handlers for the team platform UI (transport-agnostic:
 * return { status, body, cookie? } so they unit-test without req/res; dashboard
 * mounts thin wrappers that read/write cookies).
 *
 * Flow (see pairing-store.ts): browser start → user sends code to bot (daemon
 * claims) → browser consume → team-membership gate → issue web session.
 *
 * Bootstrap: a fresh deployment's default team is empty, so the FIRST successful
 * login seeds it (that person becomes the team). After that, membership is
 * required. Explicit invite/management is P3.
 */
import {
  createPairing, getPairingStatus, consumePairing,
} from '../services/pairing-store.js';
import {
  DEFAULT_TEAM_ID, ensureDefaultTeam, getTeam, isMember, addMember,
} from '../services/team-store.js';
import { consumeInvite } from '../services/invite-store.js';
import { createWebSession } from '../services/web-session-store.js';

export interface PairingHandlerResult {
  status: number;
  body: unknown;
  /** Set this cookie (httpOnly) on the response. */
  cookie?: { name: string; value: string; maxAgeMs: number };
}

export const PAIR_COOKIE = 'bmx_pair';
export const SESSION_COOKIE = 'bmx_session';

const PAIR_TTL_MS = 5 * 60 * 1000;

/** POST /api/pairing/start — begin a pairing; returns the code to show the user. */
export function pairingStart(dataDir: string): PairingHandlerResult {
  const p = createPairing(dataDir, PAIR_TTL_MS);
  return {
    status: 200,
    body: { ok: true, pairingId: p.pairingId, code: p.code, expiresAt: p.expiresAt },
    cookie: { name: PAIR_COOKIE, value: p.browserToken, maxAgeMs: PAIR_TTL_MS },
  };
}

/** GET /api/pairing/status — browser poll; leaks only status (+ name for UX). */
export function pairingStatusView(dataDir: string, pairingId: string, browserToken: string): PairingHandlerResult {
  if (!pairingId || !browserToken) return { status: 400, body: { ok: false, status: 'bad_request' } };
  const v = getPairingStatus(dataDir, pairingId, browserToken);
  if (v.status === 'not_found') return { status: 404, body: { ok: false, status: 'not_found' } };
  if (v.status === 'claimed') return { status: 200, body: { ok: true, status: 'claimed', name: v.claimedBy.name } };
  return { status: 200, body: { ok: true, status: v.status } };
}

/** POST /api/pairing/consume — finalize a claimed pairing into a web session. */
export function pairingConsume(
  dataDir: string,
  pairingId: string,
  browserToken: string,
  teamId: string = DEFAULT_TEAM_ID,
  inviteCode?: string,
): PairingHandlerResult {
  if (!pairingId || !browserToken) return { status: 400, body: { ok: false, reason: 'bad_request' } };
  const c = consumePairing(dataDir, pairingId, browserToken);
  if (!c.ok) return { status: 409, body: { ok: false, reason: c.reason } };

  const id = { unionId: c.claimedBy.unionId, openId: c.claimedBy.openId };
  ensureDefaultTeam(dataDir);
  const addClaimer = () => addMember(dataDir, teamId, { unionId: c.claimedBy.unionId, openId: c.claimedBy.openId, name: c.claimedBy.name });
  let member = isMember(dataDir, teamId, id);
  if (!member && teamId === DEFAULT_TEAM_ID && (getTeam(dataDir, DEFAULT_TEAM_ID)?.members.length ?? 0) === 0) {
    // Bootstrap: first login on an empty default team seeds the team.
    addClaimer();
    member = true;
  }
  if (!member && inviteCode) {
    // Join via a valid single-use invite minted by an existing member.
    const inv = consumeInvite(dataDir, inviteCode);
    if (inv.ok && inv.teamId === teamId) { addClaimer(); member = true; }
    else if (inv.ok) return { status: 403, body: { ok: false, reason: 'invite_wrong_team' } };
    else return { status: 403, body: { ok: false, reason: `invite_${inv.reason}` } }; // invite_not_found | invite_expired | invite_used
  }
  if (!member) return { status: 403, body: { ok: false, reason: 'not_a_member' } };

  const sess = createWebSession(dataDir, { unionId: c.claimedBy.unionId, openId: c.claimedBy.openId, name: c.claimedBy.name }, teamId);
  return {
    status: 200,
    body: { ok: true, user: { name: c.claimedBy.name }, teamId },
    cookie: { name: SESSION_COOKIE, value: sess.token, maxAgeMs: 7 * 24 * 60 * 60 * 1000 },
  };
}
