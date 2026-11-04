import type { DelegatedCliIdentity } from './turn-cli-identity.js';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

// Daemon-local references to identities already verified by the existing
// signed-dispatch flow. No credentials or CLI-provided identity enter here.
const sessions = new Map<string, Map<string, DelegatedCliIdentity>>();

function canonicalDataDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

const sessionKey = (dataDir: string, sessionId: string) => JSON.stringify([canonicalDataDir(dataDir), sessionId]);

export function rememberLarkToolDelegation(
  dataDir: string, sessionId: string, turnId: string | undefined, identity?: DelegatedCliIdentity,
): void {
  if (!turnId) return;
  const key = sessionKey(dataDir, sessionId);
  if (!identity) { sessions.get(key)?.delete(turnId); return; }
  let turns = sessions.get(key);
  if (!turns) {
    if (sessions.size >= 512) sessions.delete(sessions.keys().next().value!);
    turns = new Map(); sessions.set(key, turns);
  }
  turns.set(turnId, { ...identity, tools: [...identity.tools] });
  if (turns.size > 64) turns.delete(turns.keys().next().value!);
}

export function getLarkToolDelegation(dataDir: string, sessionId: string, turnId: string): DelegatedCliIdentity | undefined {
  const identity = sessions.get(sessionKey(dataDir, sessionId))?.get(turnId);
  return identity ? { ...identity, tools: [...identity.tools] } : undefined;
}

/**
 * The delegation in force for `turnId` right now. A workflow handoff's
 * delegation is re-checked on every use (`recheck`); once it no longer holds
 * it is replaced, for good, by a refusal (`delegation_inactive`, no target,
 * no tools), which is what this returns from then on. Every other delegation
 * is returned exactly as remembered.
 */
export function currentLarkToolDelegation(dataDir: string, sessionId: string, turnId: string): DelegatedCliIdentity | undefined {
  const identity = sessions.get(sessionKey(dataDir, sessionId))?.get(turnId);
  if (!identity?.recheck) return getLarkToolDelegation(dataDir, sessionId, turnId);
  let refusal: string | undefined;
  try {
    refusal = identity.recheck();
  } catch {
    refusal = 'recheck_failed';
  }
  if (!refusal) return getLarkToolDelegation(dataDir, sessionId, turnId);
  const { recheck: _drop, targetOpenId: _target, ...rest } = identity;
  rememberLarkToolDelegation(dataDir, sessionId, turnId, { ...rest, tools: [], denialReason: 'delegation_inactive' });
  return getLarkToolDelegation(dataDir, sessionId, turnId);
}

export function clearLarkToolDelegations(dataDir: string, sessionId: string): void {
  sessions.delete(sessionKey(dataDir, sessionId));
}

/** Turn ids with a remembered delegation in this session. Terminal identity GC
 *  must retain their material while the in-memory record survives the 64-entry
 *  cap; once it is evicted, fail-closed routes resolve to a refusal. */
export function larkToolDelegationTurnIds(dataDir: string, sessionId: string): string[] {
  return [...(sessions.get(sessionKey(dataDir, sessionId))?.keys() ?? [])];
}
