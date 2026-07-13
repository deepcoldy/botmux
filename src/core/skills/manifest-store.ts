import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import type { SessionSkillManifest } from './types.js';

function manifestDir(): string {
  return join(config.session.dataDir, 'skill-manifests');
}

function manifestPath(sessionId: string): string {
  return join(manifestDir(), `${sessionId}.json`);
}

export function writeSessionSkillManifest(manifest: SessionSkillManifest): void {
  mkdirSync(manifestDir(), { recursive: true });
  atomicWriteFileSync(manifestPath(manifest.sessionId), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
}

export function readSessionSkillManifest(sessionId: string): SessionSkillManifest | null {
  const file = manifestPath(sessionId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as SessionSkillManifest;
  } catch {
    return null;
  }
}

export function removeSessionSkillManifest(sessionId: string): void {
  rmSync(manifestPath(sessionId), { force: true });
}
