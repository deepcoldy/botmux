/**
 * Per-deployment bot union_id registry — learned from observed events.
 *
 * Cross-device verified-delivery authorizes a remote worker's delivery envelope
 * by `senderUnionId ∈ task.workerBotUnionIds` (union_id is the only worker id that
 * is BOTH tenant-stable cross-app AND present on every inbound message event —
 * see verified-delivery/types.ts). To populate `workerBotUnionIds` at dispatch,
 * and to let a deployment advertise its bots' `botUnionId` in the federation
 * roster, we need a source for a bot's union_id.
 *
 * There is no API that maps an app_id → its bot's union_id (a bot is not a user;
 * /bot/v3/info doesn't return one), and a daemon never receives its OWN bot's
 * messages. But when bot A sends a message into a chat bot B's daemon sees,
 * B observes A's `sender_id.union_id` — the canonical tenant union_id. So a
 * deployment learns its (and its peers') bots' union_ids by OBSERVING bot-sender
 * events. This store is that learned registry, shared across the deployment's
 * daemons via one file in dataDir.
 *
 * Keyed by **botName** (unique per deployment, and the join key both consumers
 * already hold): dispatch has the worker's `--bot <name>` label / roster name;
 * federation `localBots()` has each bot's `botName`. open_id can't be the key —
 * it is per-observing-app, so the open_id B saw for A differs from A's own.
 *
 * Storage: `{dataDir}/bot-union-ids.json`, atomic writes (unique tmp + rename).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface BotUnionIdEntry {
  unionId: string;
  /** Last open_id observed alongside this union_id (in SOME observing app's
   *  namespace) — diagnostic only; never used as a cross-app key. */
  lastOpenId?: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

interface FileShape {
  version: 1;
  /** botName → entry */
  byName: Record<string, BotUnionIdEntry>;
}

function filePath(dataDir: string): string {
  return join(dataDir, 'bot-union-ids.json');
}

function readFile(dataDir: string): FileShape {
  const fp = filePath(dataDir);
  if (!existsSync(fp)) return { version: 1, byName: {} };
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed && typeof parsed.byName === 'object' && parsed.byName) return { version: 1, byName: parsed.byName };
  } catch { /* corrupt — fall through */ }
  return { version: 1, byName: {} };
}

function writeFileAtomic(dataDir: string, data: FileShape): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const fp = filePath(dataDir);
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, fp);
}

/**
 * Record a (botName, union_id) observation. Upserts by name: keeps firstSeenAt,
 * bumps lastSeenAt, refreshes union_id/open_id. No-ops on empty name or union_id,
 * or when the union_id is unchanged AND already fresh (avoids a write per event).
 * Returns true when the file was written.
 */
export function recordBotUnionId(
  dataDir: string,
  name: string,
  unionId: string,
  openId?: string,
  now: number = Date.now(),
): boolean {
  // Names are matched case-insensitively (the bot-openids cross-ref lowercases;
  // consumers pass the display-case botName) — normalize the key here so record
  // and lookup always agree.
  const n = name?.trim().toLowerCase();
  const u = unionId?.trim();
  if (!n || !u) return false;
  const data = readFile(dataDir);
  const prior = data.byName[n];
  // Skip a write when nothing meaningful changed and the entry was seen recently
  // (within 10 min) — keep the hot path allocation-light on every bot event.
  if (prior && prior.unionId === u && prior.lastOpenId === (openId ?? prior.lastOpenId) && now - prior.lastSeenAt < 10 * 60 * 1000) {
    return false;
  }
  data.byName[n] = {
    unionId: u,
    lastOpenId: openId ?? prior?.lastOpenId,
    firstSeenAt: prior?.firstSeenAt ?? now,
    lastSeenAt: now,
  };
  writeFileAtomic(dataDir, data);
  return true;
}

/** The learned union_id for a bot name (case-insensitive), or undefined. */
export function getBotUnionIdByName(dataDir: string, name: string): string | undefined {
  const n = name?.trim().toLowerCase();
  if (!n) return undefined;
  return readFile(dataDir).byName[n]?.unionId;
}

/** All learned (name → union_id) pairs (diagnostic / bulk fill). */
export function listBotUnionIds(dataDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, e] of Object.entries(readFile(dataDir).byName)) out[name] = e.unionId;
  return out;
}
