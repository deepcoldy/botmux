import { logger } from '../utils/logger.js';

/** Structural view of a daemon session, kept dependency-free for config stores. */
export interface FollowUpReplyWorkerSession {
  larkAppId: string;
  worker?: {
    killed?: boolean;
    send(message: { type: 'set_follow_up_reply'; enabled: boolean }): unknown;
  } | null;
}

export type FollowUpReplyChangeHandler = (larkAppId: string, enabled: boolean) => void;

let currentHandler: FollowUpReplyChangeHandler | null = null;

/** Registered by the daemon, which owns the active-session registry. */
export function registerFollowUpReplyChangeHandler(handler: FollowUpReplyChangeHandler): () => void {
  currentHandler = handler;
  return () => {
    if (currentHandler === handler) currentHandler = null;
  };
}

/** Fan a successful config write out to every live worker belonging to the bot. */
export function broadcastFollowUpReplyToWorkers(
  sessions: Iterable<FollowUpReplyWorkerSession>,
  larkAppId: string,
  enabled: boolean,
): void {
  for (const ds of sessions) {
    if (ds.larkAppId !== larkAppId || !ds.worker || ds.worker.killed) continue;
    try { ds.worker.send({ type: 'set_follow_up_reply', enabled }); } catch { /* worker gone */ }
  }
}

/** Single post-write hook shared by Dashboard, /config, /botconfig and config cards. */
export function notifyFollowUpReplyChanged(larkAppId: string, enabled: boolean): void {
  if (!currentHandler) return;
  try {
    currentHandler(larkAppId, enabled);
  } catch (error) {
    logger.warn(`[follow-up-reply] worker sync failed app=${larkAppId} enabled=${enabled}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
