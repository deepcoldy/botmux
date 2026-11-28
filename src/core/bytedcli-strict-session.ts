import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, openSync, closeSync, fsyncSync, writeSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { bytecloudBrokerEnabled } from './identity-policy.js';
import type { TriggerUserAuthConfig } from '../services/trigger-user-auth.js';

/** Host-only monotonic fence, including publications before the first worker.
 * A marker's presence is enough to refuse exports, even after a partial write.
 * Never delete this on session teardown or a live policy disable. */
export function bytedcliStrictMarkerRoot(dataDir: string): string { return join(dataDir, 'bytedcli-strict'); }
function marker(dataDir: string, sessionId: string): string {
  return join(bytedcliStrictMarkerRoot(dataDir), createHash('sha256').update(sessionId).digest('hex'));
}
export function bytedcliStrictSession(dataDir: string, sessionId: string): boolean {
  try { lstatSync(marker(dataDir, sessionId)); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}
export function persistBytedcliStrictSession(dataDir: string, sessionId: string): void {
  const root = bytedcliStrictMarkerRoot(dataDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const fd = openSync(marker(dataDir, sessionId), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, 'strict\n'); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
const policyReaders = new Map<string, () => TriggerUserAuthConfig | undefined>();
const policyKey = (dataDir: string, sessionId: string) => JSON.stringify([resolve(dataDir), sessionId]);
export function registerBytedcliSessionPolicyReader(dataDir: string, sessionId: string, reader: () => TriggerUserAuthConfig | undefined): void {
  policyReaders.set(policyKey(dataDir, sessionId), reader);
}
export function forgetBytedcliSessionPolicyReader(dataDir: string, sessionId: string): void {
  policyReaders.delete(policyKey(dataDir, sessionId));
}
export function bytecloudExportBlocked(dataDir: string, sessionId: string, policy?: TriggerUserAuthConfig): boolean {
  if (bytecloudBrokerEnabled(policy)) persistBytedcliStrictSession(dataDir, sessionId);
  const reader = policyReaders.get(policyKey(dataDir, sessionId));
  if (reader) {
    try { policy = reader(); } catch { return true; }
  }
  if (bytecloudBrokerEnabled(policy)) persistBytedcliStrictSession(dataDir, sessionId);
  return bytedcliStrictSession(dataDir, sessionId);
}
