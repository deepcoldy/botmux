import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import type { SessionSkillManifest } from './types.js';

/** Manifest file exists but could not be READ (permission denied, I/O error).
 *  Distinct from "absent" so callers can diagnose a sandbox/policy misconfig
 *  instead of reporting a misleading "not found". */
export class SkillManifestReadError extends Error {
  constructor(public readonly path: string, public readonly cause: any) {
    super(`skill manifest unreadable (${cause?.code ?? 'read error'}): ${path}`);
    this.name = 'SkillManifestReadError';
  }
}

/** Manifest file was read but is not valid JSON. */
export class SkillManifestParseError extends Error {
  constructor(public readonly path: string, public readonly cause: any) {
    super(`skill manifest is corrupt (invalid JSON): ${path}`);
    this.name = 'SkillManifestParseError';
  }
}

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
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (err: any) {
    // ENOENT is the only "genuinely absent" case → null (callers report
    // not-found). A permission error (EACCES/EPERM — e.g. the file sandbox
    // never exposed this session's manifest) or any other read failure is a
    // real fault: surface it so `skill show` can tell "no manifest" apart from
    // "manifest unreadable", instead of masking a sandbox misconfig as
    // not-found (the historical failure mode).
    if (err?.code === 'ENOENT') return null;
    throw new SkillManifestReadError(file, err);
  }
  try {
    return JSON.parse(raw) as SessionSkillManifest;
  } catch (err: any) {
    // File is present and readable but corrupt — a distinct, diagnosable fault.
    throw new SkillManifestParseError(file, err);
  }
}

export function removeSessionSkillManifest(sessionId: string): void {
  rmSync(manifestPath(sessionId), { force: true });
}
