/** Confirmed dismissal of one owner-scoped, DM-born session group. */
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
import { disbandChat } from '../services/groups-store.js';
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
  | { status: 'confirm'; state: string; sessions: DismissSession[] }
  | { status: 'close_failed' | 'residual'; detail?: string }
  | { status: 'peer_offline'; larkAppIds: string[] }
  | { status: 'unsupported' | 'owner_only' | 'shared_adopt' | 'changed' | 'disband_failed' | 'dismissed' | 'unavailable' };

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

/**
 * Validate the current group and explicit confirmation, close every local
 * bot's session in it, and only then disband it. The caller authenticates the
 * human operator first. The bot mutation gate prevents same-bot
 * admission/resume during this sequence; peer admissions are caught by the
 * post-teardown inventory instead.
 */
export async function dismissSessionGroup(args: {
  larkAppId: string;
  chatId: string;
  rootId: string;
  senderId: string;
  confirmedState?: string;
  activeSessions: ReadonlyMap<string, DaemonSession>;
  /** Display name for failure details; defaults to the app id. */
  botName?: (larkAppId: string) => string;
}): Promise<DismissResult> {
  try {
    return await withBotTurnMutation(args.larkAppId, async (): Promise<DismissResult> => {
      const entry = getSessionGroup(args.chatId);
      if (!entry || args.rootId !== args.chatId) return { status: 'unsupported' };
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
      // BotMux does not own an adopted source conversation, so it cannot end it for the group.
      if (others.some(s => isSharedAdoptPersistedSession(s.session) || (s.live && isSharedAdoptSession(s.live)))) {
        return { status: 'shared_adopt' };
      }
      const offline = [...new Set(others.map(s => s.larkAppId))]
        .filter(app => app !== args.larkAppId && !findOnlineDaemon(app));
      if (offline.length > 0) return { status: 'peer_offline', larkAppIds: offline };

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
      const name = args.botName ?? (app => app);
      const describe = (s: ChatSession, f: CloseFailure) =>
        `${name(s.larkAppId)} · ${s.session.title || s.session.sessionId}: ${f.reason}`;
      const settle = async (s: ChatSession): Promise<[ChatSession, CloseFailure | undefined]> => {
        try { return [s, await closeOne(args.larkAppId, s)]; }
        catch (err) { return [s, { kind: 'failed', reason: err instanceof Error ? err.message : String(err) }]; }
      };
      const settled: Array<[ChatSession, CloseFailure | undefined]> = [];
      for (const s of others.filter(s => s.larkAppId === args.larkAppId)) settled.push(await settle(s));
      settled.push(...await Promise.all(others.filter(s => s.larkAppId !== args.larkAppId).map(settle)));
      const failures = settled.filter((r): r is [ChatSession, CloseFailure] => !!r[1]);
      if (failures.length > 0) {
        return {
          status: failures.some(([, f]) => f.kind === 'failed') ? 'close_failed' : 'residual',
          detail: failures.map(([s, f]) => describe(s, f)).join('\n'),
        };
      }

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
      return { status: 'dismissed' };
    });
  } catch (err) {
    logger.warn(`[dismiss] group preserved or deletion unconfirmed: ${err}`);
    return { status: 'unavailable' };
  }
}
