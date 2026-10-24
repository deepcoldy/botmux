import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeEnvPolicy, type EnvPolicy } from '../core/env-policy.js';
import type { ComposedSessionEnv } from '../core/session-env.js';
import { writeFileAtomic0600 } from './cli-credential-source.js';

/**
 * Identity of the configured environment a session was launched with: the
 * composed overlay plus the inheritance policy. Hash only — values are
 * credentials and must not land in the stamp file.
 */
export function sessionEnvFingerprint(composed: ComposedSessionEnv, policy?: EnvPolicy): string {
  let normalizedPolicy: EnvPolicy | null = null;
  try { normalizedPolicy = normalizeEnvPolicy(policy) ?? null; } catch { normalizedPolicy = null; }
  const canonical = JSON.stringify({
    v: 1,
    policy: normalizedPolicy,
    set: Object.keys(composed.set).sort().map(k => [k, composed.set[k]]),
    unset: [...composed.unset].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function stampPath(dataDir: string, sessionId: string): string {
  return join(dataDir, 'sessions', `${sessionId}.env-stamp`);
}

/** Written by the worker when it actually launches a CLI (never on reattach). */
export function writeSessionEnvStamp(dataDir: string, sessionId: string, fingerprint: string): void {
  mkdirSync(join(dataDir, 'sessions'), { recursive: true, mode: 0o700 });
  writeFileAtomic0600(stampPath(dataDir, sessionId), fingerprint);
}

/** `undefined` = launched before stamps existed (or never launched). */
export function readSessionEnvStamp(dataDir: string, sessionId: string): string | undefined {
  try { return readFileSync(stampPath(dataDir, sessionId), 'utf8').trim() || undefined; }
  catch { return undefined; }
}
