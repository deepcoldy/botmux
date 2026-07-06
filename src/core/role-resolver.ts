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

// Upper bound on a role definition. Raised from the original 4 KB to give room
// for richer personas; kept as a (generous) safety cap rather than removed
// outright because the role block is injected into the prompt — by default on
// every turn — so an accidental mega-paste would bloat every round. The
// per-chat "inject once" mode (see readRoleInjectMode) offsets the per-turn
// cost when a large role is intentional. Exported so all role write paths share
// one limit.
export const MAX_ROLE_BYTES = 32 * 1024; // 32 KB (~10k CJK chars)
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

/** Truncate `content` to at most MAX_ROLE_BYTES UTF-8 bytes, never splitting a
 *  multi-byte UTF-8 sequence. O(1)-ish (single buffer slice) rather than the
 *  old byte-at-a-time loop, which mattered once the limit was raised. */
function truncateToByteLimit(content: string): string {
  const buf = Buffer.from(content, 'utf-8');
  if (buf.length <= MAX_ROLE_BYTES) return content;
  // Back off past any UTF-8 continuation bytes (0b10xxxxxx = 0x80–0xBF) so the
  // cut lands on a character boundary instead of mid-codepoint.
  let end = MAX_ROLE_BYTES;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf-8');
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

// ─── Role injection mode (per bot + chat) ──────────────────────────────────
// Controls how often the resolved <role> block is injected into the CLI prompt
// for a given chat:
//   'every' (default) — inject on every turn (unchanged legacy behavior)
//   'once'            — inject only on the opening / refork turn, skip follow-ups
// Stored as a small sidecar next to the chat role file so it travels with the
// rest of session state. It is keyed on (larkAppId, chatId) and applies to
// whatever role is effective for the chat — a per-chat override OR the team
// default — because it is a property of *this chat's* injection, not of the
// role text's source.

export type RoleInjectMode = 'every' | 'once';

/** Absolute path to the per-chat role metadata sidecar. */
function roleMetaFilePath(larkAppId: string, chatId: string): string {
  assertRoleChatId(chatId);
  return join(config.session.dataDir, 'roles', larkAppId, `${chatId}.meta.json`);
}

/**
 * Read the injection mode for a (bot, chat). Defaults to 'every' when no
 * sidecar exists or it can't be parsed — i.e. legacy behavior is the default.
 */
export function readRoleInjectMode(larkAppId: string, chatId: string): RoleInjectMode {
  if (!larkAppId || !chatId || !isValidRoleChatId(chatId)) return 'every';
  try {
    const fp = roleMetaFilePath(larkAppId, chatId);
    if (!existsSync(fp)) return 'every';
    const meta = JSON.parse(readFileSync(fp, 'utf-8')) as { inject?: unknown };
    return meta?.inject === 'once' ? 'once' : 'every';
  } catch {
    return 'every';
  }
}

/**
 * Persist the injection mode. 'every' (the default) removes the sidecar so the
 * on-disk state stays clean; 'once' writes it.
 */
export function writeRoleInjectMode(larkAppId: string, chatId: string, mode: RoleInjectMode): void {
  const fp = roleMetaFilePath(larkAppId, chatId);
  if (mode === 'once') {
    mkdirSync(dirname(fp), { recursive: true });
    atomicWriteFileSync(fp, JSON.stringify({ inject: 'once' }));
  } else {
    try { unlinkSync(fp); } catch { /* already absent */ }
  }
  logger.info(`[role] inject mode chat=${chatId} app=${larkAppId} => ${mode}`);
}

/** Remove the injection-mode sidecar (used when a chat role is deleted). */
export function deleteRoleInjectMode(larkAppId: string, chatId: string): void {
  if (!isValidRoleChatId(chatId)) return;
  try { unlinkSync(roleMetaFilePath(larkAppId, chatId)); } catch { /* already absent */ }
}

/**
 * Resolve the effective role content + source (like resolveRole) plus the
 * per-chat injection mode. The prompt builder uses this to decide whether to
 * emit the <role> block on follow-up turns.
 */
export function resolveRoleInjection(
  larkAppId: string,
  chatId: string,
): { content: string | null; source: RoleSource; injectMode: RoleInjectMode } {
  const base = resolveRole(larkAppId, chatId);
  if (!base.content) return { ...base, injectMode: 'every' };
  return { ...base, injectMode: readRoleInjectMode(larkAppId, chatId) };
}
