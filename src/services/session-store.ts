import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { Session } from '../types.js';

let sessions: Map<string, Session> = new Map();
let loaded = false;

function getFilePath(): string {
  return join(config.session.dataDir, 'sessions.json');
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

export function createSession(chatId: string, rootMessageId: string, title: string): Session {
  load();
  const session: Session = {
    sessionId: randomUUID(),
    chatId,
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
  return sessions.get(sessionId);
}

export function closeSession(sessionId: string): void {
  load();
  const session = sessions.get(sessionId);
  if (session) {
    session.status = 'closed';
    session.closedAt = new Date().toISOString();
    save();
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

export function listSessions(): Session[] {
  load();
  return [...sessions.values()];
}
