/**
 * Pairing-login store: binds a browser session to a Feishu user without a web
 * OAuth redirect (which is unfriendly to ip:port self-host — see
 * docs/platform-design.md). Device-code style:
 *
 *   1. Browser (unauthenticated) calls start → gets a short human `code` to show
 *      the user, plus a high-entropy `browserToken` it keeps privately.
 *   2. User sends the `code` to the bot in Feishu. The daemon (which already
 *      knows the sender's open_id) claims the pairing for that identity.
 *   3. Browser polls/consumes with its `browserToken`; on a claimed pairing it
 *      learns the Feishu identity and the web endpoint issues a session.
 *
 * Identity is established INSIDE Feishu, so only a short-lived code crosses to
 * the web — independent of domain/IP/port. Team-membership gating is the
 * caller's job (via team-store); this store only pairs browser ↔ identity.
 *
 * Security: code is high-entropy + short TTL + single-use; browserToken gates
 * status/consume so a guessed code alone can't hijack a browser session.
 * (Brute-forcing codes is further bounded by endpoint rate limiting at the wiring
 * layer.) Codes/tokens are never logged.
 *
 * Storage: `{dataDir}/pairings.json` (shared across the web + daemon processes),
 * atomic writes.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
/** Unambiguous alphabet (no 0/O/1/I) for the human-entered code. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;

export type PairingStatus = 'pending' | 'claimed' | 'consumed';

export interface PairingClaimer {
  openId: string;
  unionId?: string;
  name?: string;
  /** The bot app the user ran `/pair` with — open_id is scoped to THIS app. */
  larkAppId?: string;
}

interface PairingEntry {
  pairingId: string;
  code: string;
  browserToken: string;
  status: PairingStatus;
  createdAt: number;
  expiresAt: number;
  claimedBy?: PairingClaimer;
}

type FileShape = Record<string, PairingEntry>; // keyed by pairingId

function filePath(dataDir: string): string {
  return join(dataDir, 'pairings.json');
}

function readFile(dataDir: string): FileShape {
  const fp = filePath(dataDir);
  if (!existsSync(fp)) return {};
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as FileShape;
  } catch { /* corrupt — fall through */ }
  return {};
}

function writeFileAtomic(dataDir: string, data: FileShape): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const fp = filePath(dataDir);
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, fp);
}

/** Drop expired entries; returns the live map. */
function prune(data: FileShape, now: number): FileShape {
  for (const [id, e] of Object.entries(data)) {
    if (e.expiresAt <= now) delete data[id];
  }
  return data;
}

function genCode(): string {
  const bytes = randomBytes(CODE_LEN);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export interface StartedPairing {
  pairingId: string;
  code: string;
  browserToken: string;
  expiresAt: number;
}

/** Begin a pairing. Returns the code to show the user + a private browserToken. */
export function createPairing(dataDir: string, ttlMs: number = DEFAULT_TTL_MS, now: number = Date.now()): StartedPairing {
  const data = prune(readFile(dataDir), now);
  const entry: PairingEntry = {
    pairingId: randomUUID(),
    code: genCode(),
    browserToken: randomBytes(24).toString('base64url'),
    status: 'pending',
    createdAt: now,
    expiresAt: now + ttlMs,
  };
  data[entry.pairingId] = entry;
  writeFileAtomic(dataDir, data);
  return { pairingId: entry.pairingId, code: entry.code, browserToken: entry.browserToken, expiresAt: entry.expiresAt };
}

export type ClaimResult =
  | { ok: true; pairingId: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_claimed' };

/** Claim a pending pairing for a Feishu identity (called by the daemon on the bot side). */
export function claimPairing(dataDir: string, code: string, claimer: PairingClaimer, now: number = Date.now()): ClaimResult {
  const data = prune(readFile(dataDir), now);
  const entry = Object.values(data).find(e => e.code === code.trim().toUpperCase());
  if (!entry) return { ok: false, reason: 'not_found' };
  if (entry.expiresAt <= now) return { ok: false, reason: 'expired' };
  if (entry.status !== 'pending') return { ok: false, reason: 'already_claimed' };
  entry.status = 'claimed';
  entry.claimedBy = {
    openId: claimer.openId,
    ...(claimer.unionId ? { unionId: claimer.unionId } : {}),
    ...(claimer.name ? { name: claimer.name } : {}),
    ...(claimer.larkAppId ? { larkAppId: claimer.larkAppId } : {}),
  };
  writeFileAtomic(dataDir, data);
  return { ok: true, pairingId: entry.pairingId };
}

export type PairingView =
  | { status: 'pending' }
  | { status: 'claimed'; claimedBy: PairingClaimer }
  | { status: 'consumed' }
  | { status: 'not_found' };

/** Browser-side status poll; requires the matching browserToken. */
export function getPairingStatus(dataDir: string, pairingId: string, browserToken: string, now: number = Date.now()): PairingView {
  const data = prune(readFile(dataDir), now);
  const entry = data[pairingId];
  if (!entry || entry.browserToken !== browserToken) return { status: 'not_found' };
  if (entry.status === 'claimed' && entry.claimedBy) return { status: 'claimed', claimedBy: entry.claimedBy };
  if (entry.status === 'consumed') return { status: 'consumed' };
  return { status: 'pending' };
}

export type ConsumeResult =
  | { ok: true; claimedBy: PairingClaimer }
  | { ok: false; reason: 'not_found' | 'not_claimed' | 'already_consumed' };

/** Single-use: turn a claimed pairing into a session. Requires the browserToken. */
export function consumePairing(dataDir: string, pairingId: string, browserToken: string, now: number = Date.now()): ConsumeResult {
  const data = prune(readFile(dataDir), now);
  const entry = data[pairingId];
  if (!entry || entry.browserToken !== browserToken) return { ok: false, reason: 'not_found' };
  if (entry.status === 'consumed') return { ok: false, reason: 'already_consumed' };
  if (entry.status !== 'claimed' || !entry.claimedBy) return { ok: false, reason: 'not_claimed' };
  entry.status = 'consumed';
  const claimedBy = entry.claimedBy;
  writeFileAtomic(dataDir, data);
  return { ok: true, claimedBy };
}
