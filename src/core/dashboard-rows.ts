// src/core/dashboard-rows.ts
//
// Pure-data row composers shared between the dashboard IPC server (which
// serves /api/sessions) and the worker-pool publishers (which emit
// `session.spawned` / `session.update` lifecycle events).  Lives in its own
// module so worker-pool can import the composer without pulling in the IPC
// server (which itself imports worker-pool — that would be a cycle).
import type { DaemonSession } from './types.js';
import type { Session } from '../types.js';
import type { CliId } from '../adapters/cli/types.js';

export interface SessionRow {
  sessionId: string;
  larkAppId: string;
  botName: string;
  cliId: CliId | 'unknown';
  status: 'starting' | 'working' | 'idle' | 'analyzing' | 'limited' | 'closed';
  adopt: boolean;
  spawnedAt: number;
  lastMessageAt: number;
  closedAt?: number;
  workingDir?: string;
  chatId: string;
  rootMessageId: string;
  threadId?: string;
  title?: string;
  ownerOpenId?: string;
  webPort: number | null;
  cliVersion?: string;
  hasHistory?: boolean;
  feishuChatLink: string;
}

export function feishuChatLink(chatId: string): string {
  return `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
}

let cachedBotName = '';
export function setBotName(name: string): void { cachedBotName = name; }
export function getBotName(): string { return cachedBotName; }

function parseSessionTime(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

function sessionCreatedAtMs(s: Session): number {
  return parseSessionTime(s.createdAt) ?? 0;
}

export function sessionLastActivityAtMs(s: Session): number {
  return parseSessionTime(s.lastMessageAt) ?? sessionCreatedAtMs(s);
}

export function composeRowFromActive(ds: DaemonSession): SessionRow {
  return {
    sessionId: ds.session.sessionId,
    larkAppId: ds.larkAppId,
    botName: cachedBotName,
    cliId: ds.session.cliId ?? 'unknown',
    status: ds.lastScreenStatus ?? 'starting',
    adopt: !!ds.adoptedFrom,
    spawnedAt: sessionCreatedAtMs(ds.session) || ds.spawnedAt,
    lastMessageAt: sessionLastActivityAtMs(ds.session) || ds.lastMessageAt,
    workingDir: ds.workingDir,
    chatId: ds.chatId,
    rootMessageId: ds.session.rootMessageId,
    title: ds.session.title,
    // Read from the persisted Session — single source of truth.
    // ds.ownerOpenId is a parallel in-memory copy that gets cleared on
    // restoreActiveSessions (which builds a fresh DaemonSession from disk
    // without copying this field). Reading session.ownerOpenId works for
    // both fresh and restored sessions.
    ownerOpenId: ds.session.ownerOpenId,
    webPort: ds.workerPort ?? null,
    cliVersion: ds.cliVersion,
    hasHistory: ds.hasHistory,
    feishuChatLink: feishuChatLink(ds.chatId),
  };
}

export function composeRowFromClosed(s: Session): SessionRow {
  return {
    sessionId: s.sessionId,
    larkAppId: s.larkAppId ?? '',
    botName: cachedBotName,
    cliId: s.cliId ?? 'unknown',
    status: 'closed',
    adopt: !!s.adoptedFrom,
    spawnedAt: sessionCreatedAtMs(s),
    lastMessageAt: s.closedAt ? (parseSessionTime(s.closedAt) ?? sessionLastActivityAtMs(s)) : sessionLastActivityAtMs(s),
    closedAt: s.closedAt ? Date.parse(s.closedAt) : undefined,
    workingDir: s.workingDir,
    chatId: s.chatId,
    rootMessageId: s.rootMessageId,
    title: s.title,
    ownerOpenId: s.ownerOpenId,
    webPort: s.webPort ?? null,
    feishuChatLink: feishuChatLink(s.chatId),
  };
}
