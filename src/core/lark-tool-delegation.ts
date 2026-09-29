import type { DelegatedCliIdentity } from './turn-cli-identity.js';

// Daemon-local references to identities already verified by the existing
// signed-dispatch flow. No credentials or CLI-provided identity enter here.
const sessions = new Map<string, Map<string, DelegatedCliIdentity>>();
const sessionKey = (dataDir: string, sessionId: string) => JSON.stringify([dataDir, sessionId]);

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

export function clearLarkToolDelegations(dataDir: string, sessionId: string): void {
  sessions.delete(sessionKey(dataDir, sessionId));
}
