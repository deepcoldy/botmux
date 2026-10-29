/**
 * Generation counter for one person's local CLI homes.
 *
 * Revoking deletes `~/.botmux/data/{lark-cli,bytedcli}-home/<openId>`, but a
 * CLI can rewrite its session files after that delete, and an in-flight login
 * can stamp a fresh HOME with the credential we just forgot. The epoch file
 * is the authority: revoke bumps it before logout, and a HOME is usable only
 * when its `.botmux-auth-epoch` stamp equals the current epoch.
 *
 * A missing stamp is valid only at epoch 0, so upgrading does not force every
 * existing login to scan again.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { isUsableOpenId } from '../utils/user-token.js';

const EPOCH_ROOT = join(homedir(), '.botmux', 'data', 'cli-auth-epoch');
export const CLI_AUTH_EPOCH_STAMP = '.botmux-auth-epoch';

function epochPath(openId: string): string {
  return join(EPOCH_ROOT, openId);
}

function parseEpoch(text: string): number | null {
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= 0 && n < Number.MAX_SAFE_INTEGER ? n : null;
}

function readEpochFile(path: string): number {
  try {
    return parseEpoch(readFileSync(path, 'utf8')) ?? 0;
  } catch {
    return 0;
  }
}

/** Current epoch. Unusable ids and a missing file are 0 (legacy logins stay valid). */
export function readCliAuthEpoch(openId: string): number {
  if (!isUsableOpenId(openId)) return 0;
  return readEpochFile(epochPath(openId));
}

/**
 * Advance this person's epoch by one. The read stays inside the lock and must
 * not take it again — `withFileLockSync` is not reentrant.
 */
export function bumpCliAuthEpoch(openId: string): number {
  if (!isUsableOpenId(openId)) {
    throw new Error(`[cli-auth-epoch] unusable open_id: ${JSON.stringify(openId)}`);
  }
  const path = epochPath(openId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withFileLockSync(path, () => {
    const next = readEpochFile(path) + 1;
    atomicWriteFileSync(path, String(next), { mode: 0o600 });
    return next;
  });
}

/** True when this HOME may still authenticate `openId`. */
export function cliAuthEpochAllows(openId: string, home: string): boolean {
  const epoch = readCliAuthEpoch(openId);
  let stamp: number | null;
  try {
    stamp = parseEpoch(readFileSync(join(home, CLI_AUTH_EPOCH_STAMP), 'utf8'));
  } catch {
    stamp = null;
  }
  if (stamp === null) return epoch === 0;
  return stamp === epoch;
}

/** Record the epoch that was current when this HOME became a login. */
export function stampCliAuthEpoch(openId: string, home: string): void {
  atomicWriteFileSync(join(home, CLI_AUTH_EPOCH_STAMP), String(readCliAuthEpoch(openId)), { mode: 0o600 });
}
