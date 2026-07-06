import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

// Keep in sync with MAX_ROLE_BYTES in core/role-resolver.ts — applying a
// profile writes its entry into a chat role, so the two limits must match.
export const MAX_ROLE_PROFILE_ENTRY_BYTES = 32 * 1024;
export const MAX_ROLE_PROFILE_ID_LENGTH = 64;

const PROFILE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ENTRY_KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;

export interface RoleProfileSummary {
  profileId: string;
  entryCount: number;
  updatedAt: number | null;
}

export interface RoleProfileEntry {
  profileId: string;
  larkAppId: string;
  content: string;
  byteLength: number;
  updatedAt: number | null;
}

export function isValidRoleProfileId(profileId: string): boolean {
  return PROFILE_ID_RE.test(profileId) && profileId !== '.' && profileId !== '..';
}

export function isValidRoleProfileEntryKey(larkAppId: string): boolean {
  return ENTRY_KEY_RE.test(larkAppId);
}

function assertProfileId(profileId: string): void {
  if (!isValidRoleProfileId(profileId)) {
    throw new Error(`invalid profile id: ${profileId}`);
  }
}

function assertEntryKey(larkAppId: string): void {
  if (!isValidRoleProfileEntryKey(larkAppId)) {
    throw new Error(`invalid lark app id: ${larkAppId}`);
  }
}

function profilesDir(dataDir: string): string {
  return join(dataDir, 'role-profiles');
}

function assertPathInside(baseDir: string, targetPath: string): void {
  const base = resolve(baseDir);
  const target = resolve(targetPath);
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new Error(`role profile path escaped profile root: ${targetPath}`);
  }
}

function profileDir(dataDir: string, profileId: string): string {
  assertProfileId(profileId);
  const base = profilesDir(dataDir);
  const dir = join(base, profileId);
  assertPathInside(base, dir);
  return dir;
}

function entryPath(dataDir: string, profileId: string, larkAppId: string): string {
  assertProfileId(profileId);
  assertEntryKey(larkAppId);
  return join(profileDir(dataDir, profileId), `${larkAppId}.md`);
}

function truncateToByteLimit(content: string): string {
  const buf = Buffer.from(content, 'utf-8');
  if (buf.length <= MAX_ROLE_PROFILE_ENTRY_BYTES) return content;
  // Back off past UTF-8 continuation bytes so we never split a codepoint.
  let end = MAX_ROLE_PROFILE_ENTRY_BYTES;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf-8');
}

function normalizeContent(content: string): string {
  return truncateToByteLimit(content.trim());
}

function safeStatMtimeMs(filePath: string): number | null {
  try { return statSync(filePath).mtimeMs; } catch { return null; }
}

function readEntryFile(dataDir: string, profileId: string, larkAppId: string): RoleProfileEntry | null {
  const filePath = entryPath(dataDir, profileId, larkAppId);
  if (!existsSync(filePath)) return null;
  try {
    const content = normalizeContent(readFileSync(filePath, 'utf-8'));
    return {
      profileId,
      larkAppId,
      content,
      byteLength: Buffer.byteLength(content, 'utf-8'),
      updatedAt: safeStatMtimeMs(filePath),
    };
  } catch {
    return null;
  }
}

export function listRoleProfiles(dataDir: string): RoleProfileSummary[] {
  let names: string[];
  try { names = readdirSync(profilesDir(dataDir)); } catch { return []; }

  const out: RoleProfileSummary[] = [];
  for (const profileId of names.sort()) {
    if (!isValidRoleProfileId(profileId)) continue;
    let files: string[];
    try { files = readdirSync(profileDir(dataDir, profileId)); } catch { continue; }
    let entryCount = 0;
    let updatedAt: number | null = null;
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const larkAppId = file.slice(0, -'.md'.length);
      if (!isValidRoleProfileEntryKey(larkAppId)) continue;
      const mtime = safeStatMtimeMs(entryPath(dataDir, profileId, larkAppId));
      entryCount += 1;
      if (mtime !== null) updatedAt = updatedAt === null ? mtime : Math.max(updatedAt, mtime);
    }
    out.push({ profileId, entryCount, updatedAt });
  }
  return out;
}

export function listRoleProfileEntries(dataDir: string, profileId: string): RoleProfileEntry[] {
  let files: string[];
  try { files = readdirSync(profileDir(dataDir, profileId)); } catch { return []; }
  return files
    .filter(file => file.endsWith('.md'))
    .map(file => file.slice(0, -'.md'.length))
    .filter(isValidRoleProfileEntryKey)
    .sort()
    .map(larkAppId => readEntryFile(dataDir, profileId, larkAppId))
    .filter((entry): entry is RoleProfileEntry => entry !== null);
}

export function readRoleProfileEntry(dataDir: string, profileId: string, larkAppId: string): string | null {
  return readEntryFile(dataDir, profileId, larkAppId)?.content ?? null;
}

export function writeRoleProfileEntry(
  dataDir: string,
  profileId: string,
  larkAppId: string,
  content: string,
  options: { allowEmpty?: boolean } = {},
): void {
  const normalized = normalizeContent(content);
  if (!normalized && !options.allowEmpty) throw new Error('content_required');
  const filePath = entryPath(dataDir, profileId, larkAppId);
  mkdirSync(dirname(filePath), { recursive: true });
  atomicWriteFileSync(filePath, normalized);
}

export function deleteRoleProfileEntry(dataDir: string, profileId: string, larkAppId: string): boolean {
  const filePath = entryPath(dataDir, profileId, larkAppId);
  try {
    unlinkSync(filePath);
    return true;
  } catch (err: any) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export function deleteRoleProfileIfEmpty(dataDir: string, profileId: string): boolean {
  const dir = profileDir(dataDir, profileId);
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return false; }
  if (entries.length > 0) return false;
  rmdirSync(dir);
  return true;
}
