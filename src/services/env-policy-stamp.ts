import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeEnvPolicy, type EnvPolicy } from '../core/env-policy.js';
import { writeFileAtomic0600 } from './cli-credential-source.js';

export function envPolicyId(policy?: EnvPolicy): string {
  return createHash('sha256').update(JSON.stringify(normalizeEnvPolicy(policy) ?? { mode: 'inherit' })).digest('hex');
}
export function readEnvPolicyStamp(dataDir: string, sessionId: string): string | undefined {
  try { return readFileSync(join(dataDir, 'sessions', sessionId + '.env-policy'), 'utf8').trim(); }
  catch { return undefined; }
}
export function writeEnvPolicyStamp(dataDir: string, sessionId: string, policy?: EnvPolicy): void {
  if (policy?.mode !== 'strict') {
    rmSync(join(dataDir, 'sessions', sessionId + '.env-policy'), { force: true });
    return;
  }
  mkdirSync(join(dataDir, 'sessions'), { recursive: true, mode: 0o700 });
  writeFileAtomic0600(join(dataDir, 'sessions', sessionId + '.env-policy'), envPolicyId(policy));
}
export function envPolicyRequiresColdStart(stamp: string | undefined, policy?: EnvPolicy): boolean {
  // Absent policies retain historical restore behavior. Strict mode never
  // reuses an unstamped or differently configured generation.
  return policy?.mode === 'strict' && stamp !== envPolicyId(policy);
}
