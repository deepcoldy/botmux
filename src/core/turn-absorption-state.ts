/**
 * Dependency-free leaf holding merged-turn membership state.
 *
 * Kept separate from `turn-absorption.ts` (which pulls reply-target /
 * session-marker machinery) so low-level state modules can consult
 * `sameMergedTurnGroup` without instantiating the session-store SCC.
 */
import type { DaemonSession } from './types.js';

export interface AbsorbedTurnHost {
  hostTurnId: string;
  hostDispatchAttempt?: number;
}

const MAX_ABSORBED_ENTRIES_PER_SESSION = 128;

const absorbedBySession = new WeakMap<DaemonSession, Map<string, AbsorbedTurnHost>>();

function resolveRootHost(
  map: ReadonlyMap<string, AbsorbedTurnHost>,
  startTurnId: string,
): AbsorbedTurnHost | undefined {
  let current = map.get(startTurnId);
  if (!current) return undefined;
  const visited = new Set<string>([startTurnId]);
  while (current) {
    if (visited.has(current.hostTurnId)) return undefined;
    visited.add(current.hostTurnId);
    const parent = map.get(current.hostTurnId);
    if (!parent) return current;
    current = parent;
  }
  return undefined;
}

/** Record that `memberTurnId` was deterministically folded into `hostTurnId`. */
export function recordTurnAbsorption(
  ds: DaemonSession,
  memberTurnId: string | undefined,
  hostTurnId: string | undefined,
  hostDispatchAttempt?: number,
): boolean {
  if (!memberTurnId || !hostTurnId || memberTurnId === hostTurnId) return false;
  let map = absorbedBySession.get(ds);
  if (!map) {
    map = new Map();
    absorbedBySession.set(ds, map);
  }
  // Resolve through any existing parent chain and reject cycles back to member.
  let rootHostId = hostTurnId;
  let rootAttempt = hostDispatchAttempt;
  const visited = new Set<string>([memberTurnId]);
  while (true) {
    if (visited.has(rootHostId)) return false;
    visited.add(rootHostId);
    const parent = map.get(rootHostId);
    if (!parent) break;
    rootHostId = parent.hostTurnId;
    rootAttempt = parent.hostDispatchAttempt;
  }
  const entry: AbsorbedTurnHost = {
    hostTurnId: rootHostId,
    ...(rootAttempt !== undefined ? { hostDispatchAttempt: rootAttempt } : {}),
  };
  map.delete(memberTurnId);
  map.set(memberTurnId, entry);
  // Collapse any existing children pointing directly to memberTurnId so future
  // evictions of memberTurnId cannot strand transitive links.
  for (const [childId, childHost] of map) {
    if (childId !== memberTurnId && childHost.hostTurnId === memberTurnId) {
      map.set(childId, { ...entry });
    }
  }
  while (map.size > MAX_ABSORBED_ENTRIES_PER_SESSION) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  return true;
}

/** Record multiple absorbed member turn IDs under one host turn. */
export function recordTurnAbsorbedMembers(
  ds: DaemonSession,
  hostTurnId: string | undefined,
  memberTurnIds: readonly string[] | undefined,
  hostDispatchAttempt?: number,
): void {
  if (!hostTurnId || !memberTurnIds?.length) return;
  for (const memberId of memberTurnIds) {
    recordTurnAbsorption(ds, memberId, hostTurnId, hostDispatchAttempt);
  }
}

/** Detach a previously recorded mid-turn absorption link when settlement proves
 *  this turn was NOT covered by its host (e.g. #3880 TOCTOU or gate refusal). */
export function clearTurnAbsorption(ds: DaemonSession, memberTurnId: string | undefined): void {
  if (!memberTurnId) return;
  const map = absorbedBySession.get(ds);
  if (!map) return;
  map.delete(memberTurnId);
  if (map.size === 0) absorbedBySession.delete(ds);
}

/** Return all member turn IDs currently linked to `hostTurnId`. */
export function absorbedMembersOfHost(
  ds: DaemonSession,
  hostTurnId: string | undefined,
): string[] {
  if (!hostTurnId) return [];
  const map = absorbedBySession.get(ds);
  if (!map) return [];
  const members: string[] = [];
  for (const memberId of map.keys()) {
    if (resolveRootHost(map, memberId)?.hostTurnId === hostTurnId) {
      members.push(memberId);
    }
  }
  return members;
}

/** Return the canonical host for an absorbed member turn, or undefined. */
export function absorbedHostForTurn(
  ds: DaemonSession,
  turnId: string | undefined,
): AbsorbedTurnHost | undefined {
  if (!turnId) return undefined;
  const map = absorbedBySession.get(ds);
  if (!map) return undefined;
  return resolveRootHost(map, turnId);
}

/** Canonical host turn ID for `turnId` (its absorption host, or itself). */
export function canonicalMergedHostTurnId(
  ds: DaemonSession,
  turnId: string | undefined,
): string | undefined {
  if (!turnId) return undefined;
  return absorbedHostForTurn(ds, turnId)?.hostTurnId ?? turnId;
}

/** True iff `turnA` and `turnB` are the same turn or deterministically belong
 *  to the same merged/absorbed execution group. */
export function sameMergedTurnGroup(
  ds: DaemonSession,
  turnA: string | undefined,
  turnB: string | undefined,
): boolean {
  if (!turnA || !turnB) return false;
  if (turnA === turnB) return true;
  const hostA = canonicalMergedHostTurnId(ds, turnA);
  const hostB = canonicalMergedHostTurnId(ds, turnB);
  return hostA !== undefined && hostA === hostB;
}
