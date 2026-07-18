/**
 * Per-deployment registry of other bots' union_ids learned from message events.
 *
 * This is intentionally separate from bot-union-ids-store.ts: that store is
 * keyed by larkAppId and records each local bot's own identity for platform
 * heartbeats. This store is keyed by bot name and feeds cross-device delivery
 * authorization and federation rosters.
 *
 * Storage: `{dataDir}/observed-bot-union-ids.json`.
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export interface BotUnionIdEntry {
  unionId: string;
  /** Diagnostic only; open_id is scoped to the observing app. */
  lastOpenId?: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

interface FileShape {
  version: 1;
  byName: Record<string, BotUnionIdEntry>;
}

function filePath(dataDir: string): string {
  return join(dataDir, 'observed-bot-union-ids.json');
}

function readFile(dataDir: string): FileShape {
  const fp = filePath(dataDir);
  if (!existsSync(fp)) return { version: 1, byName: {} };
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed && typeof parsed.byName === 'object' && parsed.byName) {
      return { version: 1, byName: parsed.byName };
    }
  } catch { /* corrupt — fall through */ }
  return { version: 1, byName: {} };
}

function writeFile(dataDir: string, data: FileShape): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  atomicWriteFileSync(filePath(dataDir), JSON.stringify(data, null, 2) + '\n');
}

export function recordObservedBotUnionId(
  dataDir: string,
  name: string,
  unionId: string,
  openId?: string,
  now: number = Date.now(),
): boolean {
  const normalizedName = name?.trim().toLowerCase();
  const normalizedUnionId = unionId?.trim();
  if (!normalizedName || !normalizedUnionId) return false;
  const data = readFile(dataDir);
  const prior = data.byName[normalizedName];
  if (
    prior
    && prior.unionId === normalizedUnionId
    && prior.lastOpenId === (openId ?? prior.lastOpenId)
    && now - prior.lastSeenAt < 10 * 60 * 1000
  ) {
    return false;
  }
  data.byName[normalizedName] = {
    unionId: normalizedUnionId,
    lastOpenId: openId ?? prior?.lastOpenId,
    firstSeenAt: prior?.firstSeenAt ?? now,
    lastSeenAt: now,
  };
  writeFile(dataDir, data);
  return true;
}

export function getBotUnionIdByName(dataDir: string, name: string): string | undefined {
  const normalizedName = name?.trim().toLowerCase();
  if (!normalizedName) return undefined;
  return readFile(dataDir).byName[normalizedName]?.unionId;
}

export function listBotUnionIds(dataDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(readFile(dataDir).byName)) {
    out[name] = entry.unionId;
  }
  return out;
}
