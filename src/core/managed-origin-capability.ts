import { createHash, randomBytes } from 'node:crypto';
import {
  lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const RELAY_ORIGIN_CAPABILITY_BASENAME = '.botmux-origin-capability.json';

export interface ManagedOriginCapabilityClaim {
  sessionId: string;
  capability: string;
  turnId?: string;
  dispatchAttempt?: number;
}

/**
 * Per-session path used by macOS read-isolated CLIs to read only their own
 * rotating daemon-IPC capability. Hashing keeps an untrusted session id out of
 * the path while still letting the worker and CLI derive the same filename.
 * The parent is denied wholesale by the Seatbelt profile; only this exact file
 * is carved back in for the owning session.
 */
export function managedOriginCapabilityPath(dataDir: string, sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex');
  return join(dataDir, 'read-isolation', `origin-${digest}.json`);
}

/**
 * Atomically replace a capability file without following an attacker-planted
 * destination symlink. The generic atomic writer intentionally follows
 * symlinks for user-managed dotfiles; authority files need the opposite
 * contract so an isolated child cannot redirect the worker's next rotation.
 */
export function replaceManagedOriginCapabilityFile(filePath: string, body: string): void {
  const parent = dirname(filePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`managed origin capability parent is not a real directory: ${parent}`);
  }
  const temp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    // rename replaces the destination directory entry itself; unlike opening
    // filePath, it does not dereference an existing destination symlink.
    renameSync(temp, filePath);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* temp may not have been created */ }
    throw error;
  }
}

/**
 * Read the current origin claim from the per-session sandbox relay (Linux) or
 * the exact Seatbelt carve-out (macOS). A file is only transport: the daemon
 * still compares the token with its live worker registry, so stale files and
 * forged tuple fields never confer authority.
 */
export function readManagedOriginCapability(
  dataDir: string,
  sessionId: string | undefined,
  relayDir?: string,
): ManagedOriginCapabilityClaim | null {
  if (!sessionId) return null;
  const relay = !!relayDir;
  const path = relay
    ? join(relayDir!, RELAY_ORIGIN_CAPABILITY_BASENAME)
    : managedOriginCapabilityPath(dataDir, sessionId);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      sessionId?: unknown;
      token?: unknown;
      capability?: unknown;
      turnId?: unknown;
      dispatchAttempt?: unknown;
    };
    if (!relay && parsed.sessionId !== sessionId) return null;
    const capability = typeof parsed.capability === 'string'
      ? parsed.capability
      : parsed.token;
    if (typeof capability !== 'string' || !/^[a-f0-9]{32,128}$/i.test(capability)) {
      return null;
    }
    const turnId = typeof parsed.turnId === 'string'
      && parsed.turnId.length > 0
      && parsed.turnId.length <= 256
      ? parsed.turnId
      : undefined;
    const dispatchAttempt = typeof parsed.dispatchAttempt === 'number'
      && Number.isSafeInteger(parsed.dispatchAttempt)
      && parsed.dispatchAttempt > 0
      ? parsed.dispatchAttempt
      : undefined;
    return {
      sessionId,
      capability,
      ...(turnId ? { turnId } : {}),
      ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}),
    };
  } catch {
    return null;
  }
}
