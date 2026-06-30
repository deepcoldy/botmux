/**
 * Team-bot identity store: the tenant-stable `union_id` set of bots this
 * deployment has learned are TEAMMATES, so the auth gate can let them
 * collaborate without `/grant` (and without `/introduce` for discovery).
 *
 * Why union_id is the key (not name, not open_id):
 * - **name is spoofable** — anyone in the tenant can run a bot called "Claude".
 *   Trust must never hinge on a self-reported display name.
 * - **open_id is per-app scoped** — bot B's open_id as seen by app A ≠ as seen
 *   by app B, so it can't be a shared trust key across deployments.
 * - **union_id is tenant-stable and cross-app consistent** — the same value in
 *   every app's view of the same bot, and Feishu vouches for it (it arrives on
 *   inbound events as `sender.sender_id.union_id`). It is the only sound key.
 *
 * Where entries come from (the trust ROOT — see recordTeamBot callers):
 * - A bot observed talking inside a TEAM-ASSEMBLED group (a 拉群 group recorded
 *   in [[team-groups-store]]). Such groups are built by the team itself, adding
 *   bots by `larkAppId` from the federated roster — membership is team-controlled,
 *   so a bot speaking there is a vouched teammate. We capture its union_id here,
 *   then honour that union_id as a teammate in ANY group (incl. manually-created
 *   ones), without re-deriving trust from a spoofable name.
 *
 * Revocation / self-healing: entries carry lastSeenAt and expire after
 * DEFAULT_EXPIRY_MS if the bot stops appearing in team contexts — so a bot that
 * leaves the team ages out of the trusted set on its own.
 *
 * Storage: `{dataDir}/team-bots.json`, deployment-wide (not per-chat: trust in a
 * teammate is global once established). Atomic writes via the shared helper.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

/** Learned-teammate entries older than this (by lastSeenAt) are ignored by
 *  isTeamBot / listTeamBots — the bot hasn't shown up in a team context for a
 *  month, so we stop vouching for it until it's seen again. */
export const DEFAULT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

export interface TeamBot {
  unionId: string;
  name: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

type FileEntry = { name: string; firstSeenAt: number; lastSeenAt: number };
type FileShape = Record<string, FileEntry>;

function filePath(dataDir: string): string {
  return join(dataDir, 'team-bots.json');
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

/**
 * Upsert a learned teammate bot by union_id. Existing entry keeps firstSeenAt
 * and bumps lastSeenAt (+ refreshes name); new entry stamps both.
 *
 * No-op when unionId is empty — many inbound bot events DO carry
 * `sender.sender_id.union_id`, but the ones that don't simply can't be learned
 * (and fall back to the existing /grant path), never polluting the store with a
 * keyless entry. name may be empty (we still record the trusted union_id).
 *
 * Returns true iff the store changed (new entry or refreshed timestamp/name),
 * so callers can skip a redundant log.
 */
export function recordTeamBot(
  dataDir: string,
  bot: { unionId: string | undefined; name?: string },
  now: number = Date.now(),
): boolean {
  const unionId = (bot.unionId ?? '').trim();
  if (!unionId) return false;
  const name = (bot.name ?? '').trim();
  const data = readFile(dataDir);
  const prior = data[unionId];
  data[unionId] = prior
    ? { ...prior, name: name || prior.name, lastSeenAt: now }
    : { name, firstSeenAt: now, lastSeenAt: now };
  atomicWriteFileSync(filePath(dataDir), JSON.stringify(data, null, 2) + '\n');
  return true;
}

/** Is `unionId` a known (non-expired) teammate bot? The auth gate's predicate.
 *  Empty/unknown/expired → false (caller falls back to /grant). */
export function isTeamBot(
  dataDir: string,
  unionId: string | undefined,
  maxAgeMs: number = DEFAULT_EXPIRY_MS,
  now: number = Date.now(),
): boolean {
  const id = (unionId ?? '').trim();
  if (!id) return false;
  const entry = readFile(dataDir)[id];
  if (!entry) return false;
  return now - entry.lastSeenAt <= maxAgeMs;
}

/** All non-expired learned teammate bots (for discovery / debugging). Unordered. */
export function listTeamBots(
  dataDir: string,
  maxAgeMs: number = DEFAULT_EXPIRY_MS,
  now: number = Date.now(),
): TeamBot[] {
  const data = readFile(dataDir);
  const out: TeamBot[] = [];
  for (const [unionId, entry] of Object.entries(data)) {
    if (now - entry.lastSeenAt > maxAgeMs) continue;
    out.push({ unionId, name: entry.name, firstSeenAt: entry.firstSeenAt, lastSeenAt: entry.lastSeenAt });
  }
  return out;
}

/** Forget a learned teammate (explicit revoke). Returns true if removed. */
export function removeTeamBot(dataDir: string, unionId: string | undefined): boolean {
  const id = (unionId ?? '').trim();
  if (!id) return false;
  const data = readFile(dataDir);
  if (!(id in data)) return false;
  delete data[id];
  atomicWriteFileSync(filePath(dataDir), JSON.stringify(data, null, 2) + '\n');
  return true;
}
