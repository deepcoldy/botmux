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

function manifestDir(dataDir: string = config.session.dataDir): string {
  return join(dataDir, 'skill-manifests');
}

/** The ONE place that names a session's skill-manifest file. The store writes
 *  and reads it here, and the worker's file-sandbox carve-out exposes exactly
 *  this file read-only — sharing the helper keeps the two from drifting (a
 *  renamed dir/extension would otherwise silently re-break `botmux skill show`
 *  under sandbox=true). */
export function sessionSkillManifestPath(sessionId: string, dataDir: string = config.session.dataDir): string {
  return join(manifestDir(dataDir), `${sessionId}.json`);
}

function manifestPath(sessionId: string): string {
  return sessionSkillManifestPath(sessionId);
}

const readManifestFileFromDisk = (file: string): string => readFileSync(file, 'utf-8');
let readManifestFile = readManifestFileFromDisk;

/** Test seam: inject the errno a sandbox / permission fault produces (EPERM
 *  from a Seatbelt deny, EACCES) without touching host permissions — mode bits
 *  can't produce it portably because root (the daemon's uid) bypasses them.
 *  Production callers always read from disk. */
export function __testOnly_setManifestFileReader(reader: ((file: string) => string) | undefined): void {
  readManifestFile = reader ?? readManifestFileFromDisk;
}

export function writeSessionSkillManifest(manifest: SessionSkillManifest): void {
  mkdirSync(manifestDir(), { recursive: true });
  atomicWriteFileSync(manifestPath(manifest.sessionId), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
}

export function readSessionSkillManifest(sessionId: string): SessionSkillManifest | null {
  const file = manifestPath(sessionId);
  let raw: string;
  try {
    raw = readManifestFile(file);
  } catch (err: any) {
    // ENOENT is the only "genuinely absent" case → null (callers report
    // not-found). Any other read failure is a real fault: surface it so
    // `skill show` can tell "no manifest" apart from "manifest unreadable".
    // Scope of this diagnosis: macOS Seatbelt denies an unexposed path with
    // EPERM and a real permission/IO problem gives EACCES/EISDIR/…, so those
    // are caught here. Linux bwrap does NOT mount an unexposed path at all —
    // the read is a plain ENOENT, indistinguishable from "absent" — which is
    // why the worker must expose this exact file (sessionSkillManifestPath)
    // rather than rely on this classification.
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
