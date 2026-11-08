/**
 * Confirmed dismissal of an owner-scoped, DM-born session group, or of an
 * ordinary group this bot provably owns, and closing this bot's sessions once
 * a chat is gone (disbanded, or the bot was removed).
 */
import { createHash } from 'node:crypto';
import type { Session } from '../types.js';
import type { DaemonSession } from './types.js';
import { withBotTurnMutation } from './bot-turn-mutation-gate.js';
import { isSharedAdoptPersistedSession, isSharedAdoptSession } from './shared-adopt.js';
import { describeCloseResidual, parseCloseResidual } from './close-residual.js';
import { closeSession } from './worker-pool.js';
import { fetchDaemonIpc } from './daemon-ipc-auth.js';
import { findOnlineDaemon } from '../utils/daemon-discovery.js';
import { getSessionGroup, removeSessionGroup } from '../services/session-groups-store.js';
import { listSessionsStrict, findActiveSessionsByChatStrict } from '../services/session-store.js';
import { botProvablyOwnsChat, disbandChat, probeChatGone } from '../services/groups-store.js';
import { coordinationModeIsPrimary } from '../services/durable-coordination-runtime.js';
import { logger } from '../utils/logger.js';

/** A peer daemon that has not answered by then is treated as an unverified close. */
const PEER_CLOSE_TIMEOUT_MS = 60_000;

/** One session dismissal closes. Peers belong to other bots on this machine. */
export interface DismissSession {
  larkAppId: string;
  session: Session;
  /** The session the group was registered for, as opposed to a co-resident one. */
  resident: boolean;
}

/** Outcomes never conflate successful session teardown with group deletion. */
export type DismissResult =
  /** `ordinaryGroup`: the chat has no session-group registration. */
  | { status: 'confirm'; state: string; sessions: DismissSession[]; ordinaryGroup?: true }
  | { status: 'close_failed' | 'residual'; detail?: string }
  | { status: 'peer_offline'; larkAppIds: string[] }
  /** `workingDirs`: where the closed sessions ran, for the worktree cleanup offer. */
  | { status: 'dismissed'; workingDirs: string[]; ordinaryGroup?: true }
  | { status: 'unsupported' | 'owner_only' | 'no_permission' | 'shared_adopt' | 'changed' | 'disband_failed' | 'unavailable' };

type CloseFailure = { kind: 'failed' | 'residual'; reason: string };

interface ChatSession { larkAppId: string; session: Session; live?: DaemonSession }

const keyOf = (larkAppId: string, sessionId: string) => `${larkAppId}\0${sessionId}`;

/** Every active session any local bot holds in the chat, keyed by owning bot + id. */
function chatInventory(larkAppId: string, chatId: string, activeSessions: ReadonlyMap<string, DaemonSession>): Map<string, ChatSession> {
  const found = new Map<string, ChatSession>();
  for (const s of findActiveSessionsByChatStrict(chatId)) {
    // Own-store rows may predate larkAppId persistence; peers are stamped by the store.
    const app = s.larkAppId ?? larkAppId;
    found.set(keyOf(app, s.sessionId), { larkAppId: app, session: s });
  }
  for (const ds of activeSessions.values()) {
    if (ds.chatId === chatId) found.set(keyOf(ds.larkAppId, ds.session.sessionId), { larkAppId: ds.larkAppId, session: ds.session, live: ds });
  }
  return found;
}

/** Close one session; undefined only when its teardown is verified. */
async function closeOne(ownAppId: string, target: ChatSession): Promise<CloseFailure | undefined> {
  const id = target.session.sessionId;
  if (target.larkAppId === ownAppId) {
    const closed = await closeSession(id);
    if (!closed.ok) return { kind: 'failed', reason: [closed.error, closed.taskId].filter(Boolean).join(' · ') };
    if (!closed.known) return { kind: 'failed', reason: 'unknown_session' };
    if (closed.outcome !== 'closed') return { kind: 'residual', reason: describeCloseResidual(closed.residual) };
    return undefined;
  }
  // Each bot's daemon owns its own workers; ask it, as /close wt does for siblings.
  const daemon = findOnlineDaemon(target.larkAppId);
  if (!daemon) return { kind: 'failed', reason: 'daemon_offline' };
  const res = await fetchDaemonIpc(daemon.ipcPort, `/api/sessions/${encodeURIComponent(id)}/close`, {
    method: 'POST',
    signal: AbortSignal.timeout(PEER_CLOSE_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (!res.ok || body?.ok !== true) {
    return { kind: 'failed', reason: typeof body?.error === 'string' ? body.error : `http_${res.status}` };
  }
  if (body.known === false) return { kind: 'failed', reason: 'unknown_session' };
  const residual = parseCloseResidual(body);
  return residual ? { kind: 'residual', reason: describeCloseResidual(residual) } : undefined;
}

/** Sessions dismissal cannot close for the group, found before anything is closed. */
function inventoryBlocker(ownAppId: string, targets: ChatSession[]): DismissResult | undefined {
  // BotMux does not own an adopted source conversation, so it cannot end it for the group.
  if (targets.some(s => isSharedAdoptPersistedSession(s.session) || (s.live && isSharedAdoptSession(s.live)))) {
    return { status: 'shared_adopt' };
  }
  const offline = [...new Set(targets.map(s => s.larkAppId))]
    .filter(app => app !== ownAppId && !findOnlineDaemon(app));
  return offline.length > 0 ? { status: 'peer_offline', larkAppIds: offline } : undefined;
}

/** Close own sessions in turn and peers' in parallel; undefined only when every close is verified. */
async function closeAll(ownAppId: string, targets: ChatSession[], botName: (larkAppId: string) => string = app => app): Promise<DismissResult | undefined> {
  const settle = async (s: ChatSession): Promise<[ChatSession, CloseFailure | undefined]> => {
    try { return [s, await closeOne(ownAppId, s)]; }
    catch (err) { return [s, { kind: 'failed', reason: err instanceof Error ? err.message : String(err) }]; }
  };
  const settled: Array<[ChatSession, CloseFailure | undefined]> = [];
  for (const s of targets.filter(s => s.larkAppId === ownAppId)) settled.push(await settle(s));
  settled.push(...await Promise.all(targets.filter(s => s.larkAppId !== ownAppId).map(settle)));
  const failures = settled.filter((r): r is [ChatSession, CloseFailure] => !!r[1]);
  if (failures.length === 0) return undefined;
  return {
    status: failures.some(([, f]) => f.kind === 'failed') ? 'close_failed' : 'residual',
    detail: failures.map(([s, f]) => `${botName(s.larkAppId)} · ${s.session.title || s.session.sessionId}: ${f.reason}`).join('\n'),
  };
}

const workingDirOf = (s: ChatSession) => s.live?.workingDir ?? s.session.workingDir;

interface DismissRequest {
  larkAppId: string;
  chatId: string;
  rootId: string;
  /** A DM is never dismissed. */
  chatType?: string;
  senderId: string;
  confirmedState?: string;
  activeSessions: ReadonlyMap<string, DaemonSession>;
  /** Display name for failure details; defaults to the app id. */
  botName?: (larkAppId: string) => string;
}

/**
 * A group without session-group registration, from any topic in it. Feishu
 * cannot dry-run a disband, so nothing is touched unless this bot provably
 * owns the group.
 */
async function dismissOrdinaryGroup(args: DismissRequest): Promise<DismissResult> {
  if (args.chatType === 'p2p') return { status: 'unsupported' };
  if (!await botProvablyOwnsChat(args.larkAppId, args.chatId)) return { status: 'no_permission' };
  const targets = [...chatInventory(args.larkAppId, args.chatId, args.activeSessions).values()];
  const blocked = inventoryBlocker(args.larkAppId, targets);
  if (blocked) return blocked;
  const state = createHash('sha256').update(JSON.stringify([
    args.larkAppId, args.chatId, args.senderId,
    targets.map(s => keyOf(s.larkAppId, s.session.sessionId)).sort(),
  ])).digest('hex');
  if (args.confirmedState !== state) {
    return {
      status: 'confirm',
      state,
      sessions: targets.map(s => ({ larkAppId: s.larkAppId, session: s.session, resident: false })),
      ordinaryGroup: true,
    };
  }
  const failed = await closeAll(args.larkAppId, targets, args.botName);
  if (failed) return failed;
  if (chatInventory(args.larkAppId, args.chatId, args.activeSessions).size > 0) return { status: 'changed' };
  const result = await disbandChat(args.larkAppId, args.chatId);
  if (!result.ok) {
    logger.warn(`[dismiss] group deletion failed: ${result.error}`);
    return { status: 'disband_failed' };
  }
  const workingDirs = targets.map(workingDirOf).filter((dir): dir is string => !!dir);
  return { status: 'dismissed', workingDirs: [...new Set(workingDirs)], ordinaryGroup: true };
}

/**
 * Validate the current group and explicit confirmation, close every local
 * bot's session in it, and only then disband it. The caller authenticates the
 * human operator first. The bot mutation gate prevents same-bot
 * admission/resume during this sequence; peer admissions are caught by the
 * post-teardown inventory instead.
 */
export async function dismissSessionGroup(args: DismissRequest): Promise<DismissResult> {
  try {
    return await withBotTurnMutation(args.larkAppId, async (): Promise<DismissResult> => {
      const entry = getSessionGroup(args.chatId);
      if (!entry) return await dismissOrdinaryGroup(args);
      if (args.rootId !== args.chatId) return { status: 'unsupported' };
      if (entry.ownerOpenId !== args.senderId) return { status: 'owner_only' };
      const live = [...args.activeSessions.values()].find(ds =>
        ds.larkAppId === args.larkAppId && ds.session.sessionId === entry.lastSessionId);
      const session = listSessionsStrict().find(s => s.sessionId === entry.lastSessionId);
      if (!session || session.chatId !== args.chatId || session.scope !== 'chat'
        || isSharedAdoptPersistedSession(session) || (session.larkAppId && session.larkAppId !== args.larkAppId)
        || (session.status !== 'active' && session.status !== 'closed')
        || (live && (live.chatId !== args.chatId || live.scope !== 'chat' || isSharedAdoptSession(live)))) {
        return { status: 'unsupported' };
      }
      const residentKey = keyOf(args.larkAppId, session.sessionId);
      const inventory = chatInventory(args.larkAppId, args.chatId, args.activeSessions);
      const others = [...inventory.entries()].filter(([key]) => key !== residentKey).map(([, s]) => s);
      const blocked = inventoryBlocker(args.larkAppId, others);
      if (blocked) return blocked;

      const state = createHash('sha256').update(JSON.stringify([
        args.larkAppId, args.chatId, args.senderId, session.sessionId,
        session.createdAt, session.status, session.closedAt, live?.spawnedAt,
        // A session that appears after the card was shown must be confirmed again.
        others.map(s => keyOf(s.larkAppId, s.session.sessionId)).sort(),
      ])).digest('hex');
      if (args.confirmedState !== state) {
        const residentRow = inventory.get(residentKey);
        return {
          status: 'confirm',
          state,
          sessions: [
            ...(residentRow ? [{ larkAppId: args.larkAppId, session: residentRow.session, resident: true }] : []),
            ...others.map(s => ({ larkAppId: s.larkAppId, session: s.session, resident: false })),
          ],
        };
      }

      // Co-resident sessions first: if any refuses, the group's own session stays up.
      const failed = await closeAll(args.larkAppId, others, args.botName);
      if (failed) return failed;

      const closed = await closeSession(session.sessionId);
      if (!closed.ok) return { status: 'close_failed', detail: [closed.error, closed.taskId].filter(Boolean).join(' · ') };
      if (!closed.known) return { status: 'close_failed' };
      if (closed.outcome !== 'closed') return { status: 'residual', detail: describeCloseResidual(closed.residual) };
      // Re-read after teardown so a new or foreign session is not abandoned.
      if (chatInventory(args.larkAppId, args.chatId, args.activeSessions).size > 0) return { status: 'changed' };
      const current = getSessionGroup(args.chatId);
      if (!current || current.lastSessionId !== session.sessionId || current.ownerOpenId !== args.senderId) {
        return { status: 'changed' };
      }
      const result = await disbandChat(args.larkAppId, args.chatId);
      if (!result.ok) {
        logger.warn(`[dismiss] group deletion failed: ${result.error}`);
        return { status: 'disband_failed' };
      }
      removeSessionGroup(args.chatId);
      const workingDirs = [live?.workingDir ?? session.workingDir, ...others.map(workingDirOf)]
        .filter((dir): dir is string => !!dir);
      return { status: 'dismissed', workingDirs: [...new Set(workingDirs)] };
    });
  } catch (err) {
    logger.warn(`[dismiss] group preserved or deletion unconfirmed: ${err}`);
    return { status: 'unavailable' };
  }
}

/**
 * The chat was disbanded or this bot was removed from it: close this bot's
 * sessions there as /close does (resumable, worktrees kept). Nothing is posted
 * to the chat, and peers close their own sessions on their own event.
 */
export async function closeSessionsInGoneChat(args: {
  larkAppId: string;
  chatId: string;
  reason: 'disbanded' | 'bot_removed';
  activeSessions: ReadonlyMap<string, DaemonSession>;
}): Promise<void> {
  const tag = `[chat-gone] ${args.reason} chat=${args.chatId.slice(0, 12)}`;
  if (coordinationModeIsPrimary()) {
    logger.warn(`${tag}: durable primary keeps its sessions; close them through the primary control path`);
    return;
  }
  try {
    await withBotTurnMutation(args.larkAppId, async () => {
      const own = new Set<string>();
      for (const s of listSessionsStrict()) {
        if (s.chatId === args.chatId && s.status === 'active' && (s.larkAppId ?? args.larkAppId) === args.larkAppId) own.add(s.sessionId);
      }
      for (const ds of args.activeSessions.values()) {
        if (ds.larkAppId === args.larkAppId && ds.chatId === args.chatId) own.add(ds.session.sessionId);
      }
      for (const id of own) {
        try {
          // 'private' skips patching the closed card into a chat that can no longer take it.
          const closed = await closeSession(id, { cardVisibility: 'private', awaitWorkerExit: false });
          if (!closed.ok) logger.warn(`${tag}: session ${id.slice(0, 8)} close refused: ${closed.error}`);
          else if (closed.outcome !== 'closed') logger.warn(`${tag}: session ${id.slice(0, 8)} closed with residual: ${describeCloseResidual(closed.residual)}`);
          else logger.info(`${tag}: closed session ${id.slice(0, 8)}`);
        } catch (err) {
          logger.warn(`${tag}: session ${id.slice(0, 8)} close failed: ${err}`);
        }
      }
      if (getSessionGroup(args.chatId)) removeSessionGroup(args.chatId);
    });
  } catch (err) {
    logger.warn(`${tag}: sessions not closed: ${err}`);
  }
}

/** Events missed while this daemon was offline: close sessions in chats that are gone. */
export async function closeSessionsInGoneChatsOnStartup(args: {
  larkAppId: string;
  activeSessions: ReadonlyMap<string, DaemonSession>;
}): Promise<void> {
  if (coordinationModeIsPrimary()) return;
  const chats = new Set<string>();
  try {
    for (const s of listSessionsStrict()) {
      if (s.status === 'active' && s.chatType !== 'p2p' && (s.larkAppId ?? args.larkAppId) === args.larkAppId) chats.add(s.chatId);
    }
  } catch (err) {
    logger.warn(`[chat-gone] startup check skipped: ${err}`);
    return;
  }
  for (const ds of args.activeSessions.values()) {
    if (ds.larkAppId === args.larkAppId && ds.chatType !== 'p2p') chats.add(ds.chatId);
  }
  for (const chatId of chats) {
    // Doc-comment, HTTP and headless sessions carry synthetic chat ids that Feishu can only reject.
    if (!chatId.startsWith('oc_')) continue;
    const reason = await probeChatGone(args.larkAppId, chatId);
    if (reason) await closeSessionsInGoneChat({ larkAppId: args.larkAppId, chatId, reason, activeSessions: args.activeSessions });
  }
}
