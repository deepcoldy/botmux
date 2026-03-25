import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { deleteFrozenCards } from './frozen-card-store.js';
import type { Session } from '../types.js';

let sessions: Map<string, Session> = new Map();
let loaded = false;
let currentAppId: string | undefined;

/**
 * Initialise session store for a specific bot (multi-daemon mode).
 * When appId is set, sessions are stored in `sessions-{appId}.json`.
 * When unset, uses the legacy `sessions.json`.
 */
export function init(appId?: string): void {
  currentAppId = appId;
  loaded = false;
  sessions = new Map();
}

function getFilePath(): string {
  const fileName = currentAppId ? `sessions-${currentAppId}.json` : 'sessions.json';
  return join(config.session.dataDir, fileName);
}

function ensureDir(): void {
  const dir = dirname(getFilePath());
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function load(): void {
  if (loaded) return;
  ensureDir();
  const fp = getFilePath();
  if (existsSync(fp)) {
    try {
      const data = JSON.parse(readFileSync(fp, 'utf-8'));
      sessions = new Map(Object.entries(data));
      logger.info(`Loaded ${sessions.size} sessions from ${fp}`);
    } catch (err) {
      logger.error(`Failed to load sessions: ${err}`);
      sessions = new Map();
    }
  } else if (currentAppId) {
    // Per-bot file doesn't exist — migrate matching sessions from legacy sessions.json
    const legacyFp = join(config.session.dataDir, 'sessions.json');
    if (existsSync(legacyFp)) {
      try {
        const data: Record<string, Session> = JSON.parse(readFileSync(legacyFp, 'utf-8'));
        sessions = new Map();
        for (const [k, v] of Object.entries(data)) {
          if (v.larkAppId === currentAppId) {
            sessions.set(k, v);
          }
        }
        if (sessions.size > 0) {
          save();
          logger.info(`Migrated ${sessions.size} sessions from sessions.json to ${fp}`);
        }
      } catch (err) {
        logger.error(`Failed to migrate sessions from legacy file: ${err}`);
        sessions = new Map();
      }
    }
  }
  loaded = true;
}

function save(): void {
  ensureDir();
  const fp = getFilePath();
  const tmpFp = fp + '.tmp';
  const obj: Record<string, Session> = {};
  for (const [k, v] of sessions) {
    obj[k] = v;
  }
  writeFileSync(tmpFp, JSON.stringify(obj, null, 2), 'utf-8');
  renameSync(tmpFp, fp);
}

export function createSession(chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p'): Session {
  load();
  const session: Session = {
    sessionId: randomUUID(),
    chatId,
    chatType,
    rootMessageId,
    title,
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  sessions.set(session.sessionId, session);
  save();
  logger.info(`Created session ${session.sessionId} (thread: ${rootMessageId})`);
  return session;
}

export function getSession(sessionId: string): Session | undefined {
  load();
  return sessions.get(sessionId) ?? findInOtherFiles(sessionId);
}

/**
 * Search all session files for a session not found in the current file.
 *
 * The MCP server is a global singleton (one config in ~/.claude.json shared
 * by all CLI instances). It may be spawned from a non-botmux context where
 * LARK_APP_ID is unavailable, so it can't scope to the right per-bot file.
 * Scanning all files is safe here because MCP tools only read sessions.
 */
function findInOtherFiles(sessionId: string): Session | undefined {
  const dataDir = config.session.dataDir;
  const currentFp = getFilePath();
  try {
    for (const file of readdirSync(dataDir)) {
      if (!file.startsWith('sessions') || !file.endsWith('.json')) continue;
      const fp = join(dataDir, file);
      if (fp === currentFp) continue;
      try {
        const data: Record<string, Session> = JSON.parse(readFileSync(fp, 'utf-8'));
        if (data[sessionId]) return data[sessionId];
      } catch { continue; }
    }
  } catch { /* ignore */ }
  return undefined;
}

export function closeSession(sessionId: string): void {
  load();
  const session = sessions.get(sessionId);
  if (session) {
    session.status = 'closed';
    session.closedAt = new Date().toISOString();
    save();
    deleteFrozenCards(sessionId);
    logger.info(`Closed session ${sessionId}`);
  }
}

export function updateSessionPid(sessionId: string, pid: number | null): void {
  load();
  const session = sessions.get(sessionId);
  if (session) {
    session.pid = pid ?? undefined;
    save();
  }
}

export function updateSession(session: Session): void {
  load();
  sessions.set(session.sessionId, session);
  save();
}

export function listSessions(): Session[] {
  load();
  return [...sessions.values()];
}
