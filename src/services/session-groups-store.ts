/**
 * Session-group registry — the authoritative "is this chat a session group?"
 * lookup for p2pMode='group'.
 *
 * A session group is a disposable 1-user+1-bot chat auto-created to host ONE
 * DM-born conversation (see docs: p2pMode=group). It is deliberately typed
 * apart from workspace groups: per-chat features (oncall UI, /reply-mode,
 * dashboard group management) consult this registry to exclude or specialize
 * session groups WITHOUT string-matching on chat names.
 *
 * Registry answers three questions:
 *   1. isSessionGroup(chatId)      — typing / feature gating
 *   2. lastSessionId for a chatId  — same-group resume: a new message in a
 *      session group whose session was /close'd resumes that session instead
 *      of spawning a fresh one (的话题内续聊同款体验).
 *   3. ownerOpenId                 — the DM user the group was born for.
 *
 * File layout mirrors session-store / chat-first-seen-store: one file per bot
 * at `${config.session.dataDir}/session-groups-${appId}.json`, written
 * atomically via tmp + rename. One daemon process serves one bot, so the
 * per-appId singleton pattern applies.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface SessionGroupEntry {
  /** The DM user this group was born for (open_id in the bot's app scope). */
  ownerOpenId: string;
  /** Most recent session anchored in this group; same-group resume target. */
  lastSessionId: string;
  /** Epoch ms the group was created. */
  createdAt: number;
  /** Epoch ms of the last observed activity (birth, resume, new session). */
  lastActiveAt: number;
  /** True once the async AI title has been applied to the chat name. */
  titled?: boolean;
}

let entries: Map<string, SessionGroupEntry> = new Map();
let loaded = false;
let currentAppId: string | undefined;

export function initSessionGroups(appId: string): void {
  currentAppId = appId;
  loaded = false;
  entries = new Map();
}

function getFilePath(): string {
  if (!currentAppId) throw new Error('session-groups-store not initialised (call initSessionGroups(appId) first)');
  return join(config.session.dataDir, `session-groups-${currentAppId}.json`);
}

function ensureDir(): void {
  const dir = dirname(getFilePath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function load(): void {
  if (loaded) return;
  ensureDir();
  const fp = getFilePath();
  if (existsSync(fp)) {
    try {
      const data = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, SessionGroupEntry>;
      entries = new Map(Object.entries(data).filter(([, v]) =>
        v && typeof v.ownerOpenId === 'string' && typeof v.lastSessionId === 'string'));
    } catch (err) {
      logger.error(`[session-groups] failed to load ${fp}: ${err}`);
      entries = new Map();
    }
  }
  loaded = true;
}

function persist(): void {
  ensureDir();
  const fp = getFilePath();
  const tmp = `${fp}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries), null, 2), 'utf-8');
    renameSync(tmp, fp);
  } catch (err) {
    logger.error(`[session-groups] failed to persist ${fp}: ${err}`);
  }
}

/** Register a freshly-born session group (or overwrite after a re-birth). */
export function registerSessionGroup(chatId: string, entry: Omit<SessionGroupEntry, 'createdAt' | 'lastActiveAt'> & { createdAt?: number }): void {
  load();
  const now = Date.now();
  entries.set(chatId, {
    ownerOpenId: entry.ownerOpenId,
    lastSessionId: entry.lastSessionId,
    createdAt: entry.createdAt ?? now,
    lastActiveAt: now,
    titled: entry.titled,
  });
  persist();
}

/** Typing check — the ONLY sanctioned way to tell a session group apart. */
export function isSessionGroup(chatId: string): boolean {
  if (!currentAppId) return false;
  load();
  return entries.has(chatId);
}

export function getSessionGroup(chatId: string): SessionGroupEntry | undefined {
  if (!currentAppId) return undefined;
  load();
  return entries.get(chatId);
}

/** Point the registry at the session currently living in this group. */
export function touchSessionGroup(chatId: string, lastSessionId?: string): void {
  load();
  const cur = entries.get(chatId);
  if (!cur) return;
  if (lastSessionId) cur.lastSessionId = lastSessionId;
  cur.lastActiveAt = Date.now();
  persist();
}

/** Mark the async AI title as applied (idempotent). */
export function markSessionGroupTitled(chatId: string): void {
  load();
  const cur = entries.get(chatId);
  if (!cur || cur.titled) return;
  cur.titled = true;
  persist();
}

/** Remove a registry entry (group disbanded / bot removed / gc). */
export function removeSessionGroup(chatId: string): void {
  load();
  if (entries.delete(chatId)) persist();
}

export function listSessionGroups(): Array<{ chatId: string } & SessionGroupEntry> {
  if (!currentAppId) return [];
  load();
  return Array.from(entries.entries()).map(([chatId, v]) => ({ chatId, ...v }));
}
