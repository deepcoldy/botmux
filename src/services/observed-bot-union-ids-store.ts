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
import { withFileLockSync } from '../utils/file-lock.js';

export interface BotUnionIdEntry {
  unionId: string;
  /** More than one observed union_id for this display name means the name is
   *  ambiguous. Readers fail closed and do not use it for delivery authz. */
  observedUnionIds?: string[];
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

function observedUnionIdsOf(entry: BotUnionIdEntry | undefined): string[] {
  const values = Array.isArray(entry?.observedUnionIds)
    ? entry.observedUnionIds
    : entry?.unionId ? [entry.unionId] : [];
  return values
    .filter((value): value is string => typeof value === 'string' && !!value.trim())
    .map((value) => value.trim());
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
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  return withFileLockSync(filePath(dataDir), () => {
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
    const observedUnionIds = new Set(observedUnionIdsOf(prior));
    observedUnionIds.add(normalizedUnionId);
    data.byName[normalizedName] = {
      unionId: normalizedUnionId,
      ...(observedUnionIds.size > 1 ? { observedUnionIds: [...observedUnionIds] } : {}),
      lastOpenId: openId ?? (prior?.unionId === normalizedUnionId ? prior.lastOpenId : undefined),
      firstSeenAt: prior?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
    writeFile(dataDir, data);
    return true;
  });
}

function resolvedUnionId(entry: BotUnionIdEntry | undefined): string | undefined {
  if (!entry?.unionId?.trim()) return undefined;
  const observed = new Set(observedUnionIdsOf(entry));
  return observed.size === 1 ? [...observed][0] : undefined;
}

export function getBotUnionIdByName(dataDir: string, name: string): string | undefined {
  const normalizedName = name?.trim().toLowerCase();
  if (!normalizedName) return undefined;
  return resolvedUnionId(readFile(dataDir).byName[normalizedName]);
}

export function listBotUnionIds(dataDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(readFile(dataDir).byName)) {
    const unionId = resolvedUnionId(entry);
    if (unionId) out[name] = unionId;
  }
  return out;
}
