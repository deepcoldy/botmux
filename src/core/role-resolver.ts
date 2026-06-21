/**
 * Per-bot, per-chat role file resolver.
 *
 * Role definitions live in botmux's session data directory, keyed by the bot's
 * Lark app id and the chat id:
 *   {config.session.dataDir}/roles/{larkAppId}/{chatId}.md
 *
 * Storing under the session data dir (rather than the bot's project workingDir)
 * keeps role config out of the user's code repo, makes it relocate together
 * with the rest of session state via SESSION_DATA_DIR, and keying on larkAppId
 * means two bots that share a workingDir still get independent personas. Role
 * content is injected into the CLI prompt as a <role> block, allowing the same
 * bot to adopt different personas in different Lark groups.
 */

import { existsSync, readFileSync, statSync, mkdirSync, unlinkSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { join, dirname } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const MAX_ROLE_BYTES = 4 * 1024; // 4 KB
const ROLE_CHAT_ID_RE = /^(?:oc|om)_[A-Za-z0-9_-]{1,128}$/;

interface CacheEntry {
  mtimeMs: number;
  content: string | null; // null = file not found (negative cache)
}

const cache = new Map<string, CacheEntry>();

function cacheKey(larkAppId: string, chatId: string): string {
  return `${larkAppId}::${chatId}`;
}

/** Absolute path to the role file for a given bot + chat. */
function roleFilePath(larkAppId: string, chatId: string): string {
  assertRoleChatId(chatId);
  return join(config.session.dataDir, 'roles', larkAppId, `${chatId}.md`);
}

/** Absolute path to the team-level (per-bot, chat-independent) role file. */
function teamRoleFilePath(larkAppId: string): string {
  return join(config.session.dataDir, 'team-roles', `${larkAppId}.md`);
}

function teamCacheKey(larkAppId: string): string {
  return `team::${larkAppId}`;
}

export function isValidRoleChatId(chatId: string): boolean {
  return ROLE_CHAT_ID_RE.test(chatId);
}

function assertRoleChatId(chatId: string): void {
  if (!isValidRoleChatId(chatId)) {
    throw new Error(`invalid chat id: ${chatId}`);
  }
}

/** Truncate `content` to at most MAX_ROLE_BYTES UTF-8 bytes. */
function truncateToByteLimit(content: string): string {
  let out = content;
  while (Buffer.byteLength(out, 'utf-8') > MAX_ROLE_BYTES) {
    out = out.slice(0, -1);
  }
  return out;
}

/** Shared stat + cache + read + truncate logic for chat and team role files. */
function readRoleFile(filePath: string, key: string, logLabel: string): string | null {
  let stat: ReturnType<typeof statSync> | null = null;
  try {
    if (!existsSync(filePath)) {
      // Negative cache
      cache.set(key, { mtimeMs: 0, content: null });
      return null;
    }
    stat = statSync(filePath);
  } catch {
    cache.set(key, { mtimeMs: 0, content: null });
    return null;
  }

  // Cache hit — skip read if mtime unchanged
  const cached = cache.get(key);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.content;
  }

  // Read & validate
  try {
    const raw = readFileSync(filePath, 'utf-8');

    // Truncate by UTF-8 byte length, not JS string length (CJK chars are 3 bytes each)
    let content = raw.trim();
    if (Buffer.byteLength(content, 'utf-8') > MAX_ROLE_BYTES) {
      logger.warn(`[role] ${filePath} exceeds ${MAX_ROLE_BYTES} UTF-8 bytes (${Buffer.byteLength(content, 'utf-8')}), truncating`);
      content = truncateToByteLimit(content);
    }

    if (!content) {
      cache.set(key, { mtimeMs: stat.mtimeMs, content: null });
      return null;
    }

    cache.set(key, { mtimeMs: stat.mtimeMs, content });
    logger.info(`[role] ${logLabel} file=${filePath} (${Buffer.byteLength(content, 'utf-8')} bytes)`);
    return content;
  } catch (err: any) {
    logger.warn(`[role] failed to read ${filePath}: ${err?.message ?? err}`);
    cache.set(key, { mtimeMs: 0, content: null });
    return null;
  }
}

/**
 * Resolve the per-chat role content for a given bot (larkAppId) and chat.
 * Returns the role markdown string, or null if no role file exists.
 */
export function resolveRoleFile(larkAppId: string, chatId: string): string | null {
  if (!larkAppId || !chatId) return null;
  if (!isValidRoleChatId(chatId)) return null;
  return readRoleFile(roleFilePath(larkAppId, chatId), cacheKey(larkAppId, chatId), `chat=${chatId}`);
}

/** Clear the in-memory cache (useful for testing or manual reload). */
export function clearRoleCache(): void {
  cache.clear();
}

/** Invalidate cache for a specific larkAppId + chatId pair. */
export function invalidateRoleCache(larkAppId: string, chatId: string): void {
  cache.delete(cacheKey(larkAppId, chatId));
}

/** Write or overwrite role content for a chat. Creates the parent directory if needed. */
export function writeRoleFile(larkAppId: string, chatId: string, content: string): void {
  const filePath = roleFilePath(larkAppId, chatId);
  mkdirSync(dirname(filePath), { recursive: true });
  // Truncate by UTF-8 byte length, not JS string length
  const trimmed = truncateToByteLimit(content.trim());
  atomicWriteFileSync(filePath, trimmed);
  cache.delete(cacheKey(larkAppId, chatId)); // invalidate so next read picks up the new content
  logger.info(`[role] wrote chat=${chatId} file=${filePath} (${Buffer.byteLength(trimmed, 'utf-8')} bytes)`);
}

/** Delete a role file for a chat. */
export function deleteRoleFile(larkAppId: string, chatId: string): boolean {
  if (!isValidRoleChatId(chatId)) return false;
  const filePath = roleFilePath(larkAppId, chatId);
  try {
    unlinkSync(filePath);
    cache.delete(cacheKey(larkAppId, chatId));
    logger.info(`[role] deleted chat=${chatId} file=${filePath}`);
    return true;
  } catch (err: any) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    logger.warn(`[role] failed to delete ${filePath}: ${err?.message ?? err}`);
    return false;
  }
}

export type RoleSource = 'chat' | 'team' | 'none';

/** Resolve the team-level (per-bot) role, or null. */
export function resolveTeamRoleFile(larkAppId: string): string | null {
  if (!larkAppId) return null;
  return readRoleFile(teamRoleFilePath(larkAppId), teamCacheKey(larkAppId), `team app=${larkAppId}`);
}

/** Write or overwrite the team-level role for a bot. */
export function writeTeamRoleFile(larkAppId: string, content: string): void {
  const filePath = teamRoleFilePath(larkAppId);
  mkdirSync(dirname(filePath), { recursive: true });
  const trimmed = truncateToByteLimit(content.trim());
  atomicWriteFileSync(filePath, trimmed);
  cache.delete(teamCacheKey(larkAppId));
  logger.info(`[role] wrote team app=${larkAppId} file=${filePath} (${Buffer.byteLength(trimmed, 'utf-8')} bytes)`);
}

/** Delete the team-level role for a bot. */
export function deleteTeamRoleFile(larkAppId: string): boolean {
  const filePath = teamRoleFilePath(larkAppId);
  try {
    unlinkSync(filePath);
    cache.delete(teamCacheKey(larkAppId));
    logger.info(`[role] deleted team app=${larkAppId} file=${filePath}`);
    return true;
  } catch (err: any) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    logger.warn(`[role] failed to delete ${filePath}: ${err?.message ?? err}`);
    return false;
  }
}

/**
 * Layered role resolution: per-chat override ＞ team-level default ＞ none.
 * Returns the effective content plus its source, so callers/UI/logs can
 * explain *why* a given role is in effect.
 */
export function resolveRole(larkAppId: string, chatId: string): { content: string | null; source: RoleSource } {
  const chat = (larkAppId && chatId) ? resolveRoleFile(larkAppId, chatId) : null;
  if (chat !== null) return { content: chat, source: 'chat' };
  const team = larkAppId ? resolveTeamRoleFile(larkAppId) : null;
  if (team !== null) return { content: team, source: 'team' };
  return { content: null, source: 'none' };
}
