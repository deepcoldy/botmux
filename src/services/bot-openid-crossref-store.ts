import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMentionableBotOpenId } from '../core/a2a-readiness.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export interface BotOpenIdCrossRefEntry {
  name: string;
  openId: string;
}

export function readBotOpenIdCrossRefRecord(dataDir: string, larkAppId: string): Record<string, string> {
  try {
    const path = join(dataDir, `bot-openids-${larkAppId}.json`);
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string' && isMentionableBotOpenId(entry[1])
    )));
  } catch {
    return {};
  }
}

/** Persist observer-scoped bot open_ids learned from the authoritative group roster. */
export function mergeBotOpenIdCrossRef(
  dataDir: string,
  larkAppId: string,
  entries: BotOpenIdCrossRefEntry[],
): boolean {
  const current = readBotOpenIdCrossRefRecord(dataDir, larkAppId);
  const existingKeyByName = new Map(Object.keys(current).map((name) => [name.trim().toLowerCase(), name]));
  let changed = false;
  for (const entry of entries) {
    const name = entry.name.trim();
    const openId = entry.openId.trim();
    if (!name || !isMentionableBotOpenId(openId)) continue;
    const key = existingKeyByName.get(name.toLowerCase()) ?? name;
    if (current[key] === openId) continue;
    current[key] = openId;
    existingKeyByName.set(name.toLowerCase(), key);
    changed = true;
  }
  if (!changed) return false;
  atomicWriteFileSync(join(dataDir, `bot-openids-${larkAppId}.json`), JSON.stringify(current, null, 2));
  return true;
}
