// src/core/dashboard-rows.ts
//
// Pure-data row composers shared between the dashboard IPC server (which
// serves /api/sessions) and the worker-pool publishers (which emit
// `session.spawned` / `session.update` lifecycle events).  Lives in its own
// module so worker-pool can import the composer without pulling in the IPC
// server (which itself imports worker-pool — that would be a cycle).
import type { DaemonSession } from './types.js';
import type { Session, StreamStatus } from '../types.js';
import type { CliId } from '../adapters/cli/types.js';
import { getTerminalAdvertisedPort } from './terminal-url.js';
import { getBotBrand } from '../bot-registry.js';
import { type Brand, chatAppLink } from '../im/lark/lark-hosts.js';
import { getSessionTokenUsage, type SessionTokenUsage } from './cost-calculator.js';

export interface SessionRow {
  sessionId: string;
  larkAppId: string;
  botName: string;
  cliId: CliId | 'unknown';
  status: StreamStatus | 'closed';
  adopt: boolean;
  spawnedAt: number;
  lastMessageAt: number;
  closedAt?: number;
  workingDir?: string;
  chatId: string;
  rootMessageId: string;
  threadId?: string;
  /** Conversation unit ('thread' = topic-anchored, 'chat' = plain chat scope).
   *  Drives the board's locate button: chat-scope sessions have no topic to
   *  locate, so the dashboard offers "open chat" (feishuChatLink) instead.
   *  Absent on rows from older daemons → callers keep the locate behavior. */
  scope?: 'thread' | 'chat';
  title?: string;
  /** 看板视图的手动放置（列 id / 列内排序位置），用户拖拽后持久化在 Session 上。
   *  未设置时前端按运行状态推导默认列。 */
  kanbanColumn?: string;
  kanbanPosition?: number;
  ownerOpenId?: string;
  webPort: number | null;
  /** Owning daemon's advertised reverse-proxy port — WEB_EXTERNAL_PORT + botIndex
   *  when configured, else the bound proxy port (0/undefined if the proxy isn't
   *  up). When set, the terminal is reachable at {host}:{proxyPort}/s/{sessionId}.
   *  Mirrors the port buildTerminalUrl puts in card links so both agree. */
  proxyPort?: number;
  cliVersion?: string;
  hasHistory?: boolean;
  feishuChatLink: string;
  /** Repo-selection card is waiting for a click — the CLI has not spawned yet.
   *  Feeds the board view's needs-you column. */
  pendingRepo?: boolean;
  /** A TUI prompt card is open and waiting for the user's choice.
   *  Feeds the board view's needs-you column. */
  tuiPromptActive?: boolean;
  /** The agent raised a hand (`botmux send --attention`) — it hit a blocker
   *  needing human intervention. Carries the human-readable reason so the
   *  board/overview can show *why* at a glance, plus `at` (epoch ms when it
   *  was raised) so the UI shows a true "waiting since" time — NOT lastMessageAt,
   *  which a silent raise never bumps. Feeds the needs-you column. */
  agentAttention?: { kind: string; reason: string; at: number };
  /** Native Agent CLI token usage for this session. Null means unavailable. */
  tokenUsage?: SessionTokenUsage | null;
}

export function feishuChatLink(chatId: string, brand: Brand = 'feishu'): string {
  return chatAppLink(chatId, brand);
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

function sessionTokenUsage(s: Session, workingDir?: string): SessionTokenUsage | null {
  return getSessionTokenUsage({
    cliId: s.cliId ?? 'unknown',
    sessionId: s.sessionId,
    cliSessionId: s.cliSessionId,
    cwd: workingDir ?? s.workingDir,
  });
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
    scope: ds.session.scope,
    title: ds.session.title,
    kanbanColumn: ds.session.kanbanColumn,
    kanbanPosition: ds.session.kanbanPosition,
    // Read from the persisted Session — single source of truth.
    // ds.ownerOpenId is a parallel in-memory copy that gets cleared on
    // restoreActiveSessions (which builds a fresh DaemonSession from disk
    // without copying this field). Reading session.ownerOpenId works for
    // both fresh and restored sessions.
    ownerOpenId: ds.session.ownerOpenId,
    webPort: ds.workerPort ?? null,
    proxyPort: getTerminalAdvertisedPort() || undefined,
    cliVersion: ds.cliVersion,
    hasHistory: ds.hasHistory,
    feishuChatLink: feishuChatLink(ds.chatId, getBotBrand(ds.larkAppId)),
    pendingRepo: !!ds.pendingRepo,
    tuiPromptActive: !!ds.tuiPromptCardId,
    agentAttention: ds.agentAttention
      ? { kind: ds.agentAttention.kind, reason: ds.agentAttention.reason, at: ds.agentAttention.at }
      : undefined,
    tokenUsage: sessionTokenUsage(ds.session, ds.workingDir),
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
    scope: s.scope,
    title: s.title,
    kanbanColumn: s.kanbanColumn,
    kanbanPosition: s.kanbanPosition,
    ownerOpenId: s.ownerOpenId,
    webPort: s.webPort ?? null,
    feishuChatLink: feishuChatLink(s.chatId, getBotBrand(s.larkAppId ?? '')),
    tokenUsage: sessionTokenUsage(s),
  };
}
