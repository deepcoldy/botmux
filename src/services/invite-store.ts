/**
 * Team invite store: an existing member mints a single-use, short-TTL invite
 * code; the invitee pairs (pairing-login) and presents the code on consume,
 * which authorizes joining the team (team-store.addMember). This sidesteps
 * email→open_id resolution (the dashboard process has no Lark client) — the
 * invitee self-authenticates via the bot, the invite only grants admission.
 *
 * Storage: `{dataDir}/team-invites.json`, atomic writes; expired/used pruned.
 *
 * Concurrency: consume is a read-modify-write. This assumes a SINGLE dashboard
 * writer process (the current deployment model). If multiple dashboard processes
 * ever write concurrently, a single-use code would need a file lock here.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface TeamInvite {
  code: string;
  teamId: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
}

type FileShape = Record<string, TeamInvite>; // keyed by code

function filePath(dataDir: string): string { return join(dataDir, 'team-invites.json'); }

function readFile(dataDir: string): FileShape {
  const fp = filePath(dataDir);
  if (!existsSync(fp)) return {};
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as FileShape;
  } catch { /* corrupt */ }
  return {};
}

function writeFileAtomic(dataDir: string, data: FileShape): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const fp = filePath(dataDir);
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, fp);
}

/** Drop expired or used-and-old entries. */
function prune(data: FileShape, now: number): FileShape {
  for (const [code, inv] of Object.entries(data)) {
    if (inv.expiresAt <= now || (inv.usedAt && now - inv.usedAt > DEFAULT_TTL_MS)) delete data[code];
  }
  return data;
}

export interface CreatedInvite { code: string; expiresAt: number; }

/** Mint a single-use invite for a team. */
export function createInvite(dataDir: string, teamId: string, createdBy: string, ttlMs: number = DEFAULT_TTL_MS, now: number = Date.now()): CreatedInvite {
  const data = prune(readFile(dataDir), now);
  const code = randomBytes(9).toString('base64url'); // ~12 chars, high entropy
  data[code] = { code, teamId, createdBy, createdAt: now, expiresAt: now + ttlMs };
  writeFileAtomic(dataDir, data);
  return { code, expiresAt: now + ttlMs };
}

export type ConsumeInviteResult =
  | { ok: true; teamId: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'used' };

/** Validate + burn an invite (single-use). Determines the precise failure
 *  reason BEFORE pruning, so an expired code reports `expired` (not `not_found`). */
export function consumeInvite(dataDir: string, code: string, now: number = Date.now()): ConsumeInviteResult {
  const data = readFile(dataDir);
  const inv = data[code?.trim()];
  if (!inv) return { ok: false, reason: 'not_found' };
  if (inv.expiresAt <= now) return { ok: false, reason: 'expired' };
  if (inv.usedAt) return { ok: false, reason: 'used' };
  inv.usedAt = now;
  writeFileAtomic(dataDir, prune(data, now)); // burn this one; prune other stale entries
  return { ok: true, teamId: inv.teamId };
}
