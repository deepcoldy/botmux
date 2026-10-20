/**
 * Bot ownership store: which team member "owns" each bot, used to group the
 * team roster by person (so multi-person teams stay organized).
 *
 * Ownership is mostly automatic: when a member logs in via pairing through a
 * given bot, that bot is assigned to them IF it has no owner yet (we never
 * silently steal an existing owner — see setBotOwner override). A member can
 * also explicitly claim bots ("归到我名下", override=true).
 *
 * Identity: union_id is the canonical owner key (stable across apps); openId
 * and name are kept for display/fallback only.
 *
 * Storage: `{dataDir}/bot-owners.json`, atomic writes.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { isJsonObject, readJsonFileSoft } from '../utils/json-file.js';

export interface BotOwner {
  unionId?: string;
  openId?: string;
  name?: string;
  assignedAt: number;
  assignedBy: 'auto' | 'manual';
}

type FileShape = Record<string, BotOwner>; // keyed by larkAppId

function filePath(dataDir: string): string { return join(dataDir, 'bot-owners.json'); }

function readFile(dataDir: string): FileShape {
  // 损坏的文件被隔离为 .corrupt-*（而不是被下一次写入覆盖），见 utils/json-file.ts。
  return readJsonFileSoft<FileShape>(filePath(dataDir), {
    fallback: () => ({}),
    validate: isJsonObject,
    label: 'bot-owner-store',
  });
}

function writeFileAtomic(dataDir: string, data: FileShape): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  atomicWriteFileSync(filePath(dataDir), JSON.stringify(data, null, 2) + '\n', { followTargetSymlink: false });
}

function hasIdentity(o: { unionId?: string; openId?: string }): boolean {
  return !!(o.unionId || o.openId);
}

/** Current owner of a bot, or null. */
export function getBotOwner(dataDir: string, larkAppId: string): BotOwner | null {
  if (!larkAppId) return null;
  return readFile(dataDir)[larkAppId] ?? null;
}

/**
 * Assign a bot's owner. By default does NOT overwrite an existing owner (auto
 * assignment on pairing). Pass `override: true` for an explicit claim. Returns
 * true if it wrote.
 */
export function setBotOwner(
  dataDir: string,
  larkAppId: string,
  owner: { unionId?: string; openId?: string; name?: string },
  opts: { override?: boolean } = {},
  now: number = Date.now(),
): boolean {
  if (!larkAppId || !hasIdentity(owner)) return false;
  const data = readFile(dataDir);
  if (data[larkAppId] && !opts.override) return false; // don't steal an existing owner
  data[larkAppId] = {
    ...(owner.unionId ? { unionId: owner.unionId } : {}),
    ...(owner.openId ? { openId: owner.openId } : {}),
    ...(owner.name ? { name: owner.name } : {}),
    assignedAt: now,
    assignedBy: opts.override ? 'manual' : 'auto',
  };
  writeFileAtomic(dataDir, data);
  return true;
}

/** Remove a bot's owner. Returns true if one existed. */
export function clearBotOwner(dataDir: string, larkAppId: string): boolean {
  const data = readFile(dataDir);
  if (!data[larkAppId]) return false;
  delete data[larkAppId];
  writeFileAtomic(dataDir, data);
  return true;
}

/** All owners, keyed by larkAppId. */
export function listBotOwners(dataDir: string): FileShape {
  return readFile(dataDir);
}
