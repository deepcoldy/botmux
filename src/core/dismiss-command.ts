/** Confirmed dismissal of one owner-scoped, DM-born session group. */
import { createHash } from 'node:crypto';
import type { DaemonSession } from './types.js';
import { withBotTurnMutation } from './bot-turn-mutation-gate.js';
import { isSharedAdoptPersistedSession, isSharedAdoptSession } from './shared-adopt.js';
import { describeCloseResidual } from './close-residual.js';
import { closeSession } from './worker-pool.js';
import { getSessionGroup, removeSessionGroup } from '../services/session-groups-store.js';
import { listSessionsStrict, findActiveSessionsByChatStrict } from '../services/session-store.js';
import { disbandChat } from '../services/groups-store.js';
import { logger } from '../utils/logger.js';

/** Outcomes never conflate successful session teardown with group deletion. */
export type DismissResult =
  | { status: 'confirm'; state: string }
  | { status: 'close_failed' | 'residual'; detail?: string }
  | { status: 'unsupported' | 'owner_only' | 'other_sessions' | 'changed' | 'disband_failed' | 'dismissed' | 'unavailable' };

/**
 * Validate the current group and explicit confirmation, close its exact session,
 * and only then disband it. The caller authenticates the human operator first.
 * The bot mutation gate prevents same-bot admission/resume during this sequence.
 */
export async function dismissSessionGroup(args: {
  larkAppId: string;
  chatId: string;
  rootId: string;
  senderId: string;
  confirmedState?: string;
  activeSessions: ReadonlyMap<string, DaemonSession>;
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
      const hasOtherSessions = (includeTarget: boolean): boolean =>
        findActiveSessionsByChatStrict(args.chatId).some(s => includeTarget || s.sessionId !== session.sessionId
          || (s.larkAppId !== undefined && s.larkAppId !== args.larkAppId))
        || [...args.activeSessions.values()].some(ds => ds.chatId === args.chatId
          && (includeTarget || ds.session.sessionId !== session.sessionId || ds.larkAppId !== args.larkAppId));
      if (hasOtherSessions(false)) return { status: 'other_sessions' };
      const state = createHash('sha256').update(JSON.stringify([
        args.larkAppId, args.chatId, args.senderId, session.sessionId,
        session.createdAt, session.status, session.closedAt, live?.spawnedAt,
      ])).digest('hex');
      if (args.confirmedState !== state) return { status: 'confirm', state };

      const closed = await closeSession(session.sessionId);
      if (!closed.ok) return { status: 'close_failed', detail: [closed.error, closed.taskId].filter(Boolean).join(' · ') };
      if (!closed.known) return { status: 'close_failed' };
      if (closed.outcome !== 'closed') return { status: 'residual', detail: describeCloseResidual(closed.residual) };
      // Re-read after teardown so a new or foreign session is not abandoned.
      if (hasOtherSessions(true)) return { status: 'other_sessions' };
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
