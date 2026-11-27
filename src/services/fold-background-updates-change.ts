import { logger } from '../utils/logger.js';

/** Structural view of a daemon session, kept dependency-free for config stores. */
export interface FoldBackgroundUpdatesWorkerSession {
  larkAppId: string;
  worker?: {
    killed?: boolean;
    connected?: boolean;
    send(message: { type: 'set_fold_background_updates'; enabled: boolean }): unknown;
  } | null;
}

export type FoldBackgroundUpdatesChangeHandler = (larkAppId: string, enabled: boolean) => void;

let currentHandler: FoldBackgroundUpdatesChangeHandler | null = null;

/** Registered by the daemon, which owns the active-session registry. */
export function registerFoldBackgroundUpdatesChangeHandler(handler: FoldBackgroundUpdatesChangeHandler): () => void {
  currentHandler = handler;
  return () => {
    if (currentHandler === handler) currentHandler = null;
  };
}

/** Fan a successful config write out to every live worker belonging to the bot.
 *  Deduplicates sessions in case the registry indexes one session under
 *  multiple keys. When `dispatch` is provided (daemon production wiring),
 *  routes through `afterWorkerIpcBootstrap` so a toggle racing worker fork
 *  cannot arrive ahead of the initial `init` message. */
export function broadcastFoldBackgroundUpdatesToWorkers<T extends FoldBackgroundUpdatesWorkerSession>(
  sessions: Iterable<T>,
  larkAppId: string,
  enabled: boolean,
  dispatch?: (ds: T, enabled: boolean) => unknown,
): void {
  for (const ds of new Set(sessions)) {
    if (ds.larkAppId !== larkAppId || !ds.worker || ds.worker.killed || ds.worker.connected === false) continue;
    try {
      if (dispatch) dispatch(ds, enabled);
      else ds.worker.send({ type: 'set_fold_background_updates', enabled });
    } catch { /* worker gone */ }
  }
}

/** Single post-write hook shared by Dashboard, /config, /botconfig and config cards. */
export function notifyFoldBackgroundUpdatesChanged(larkAppId: string, enabled: boolean): void {
  if (!currentHandler) return;
  try {
    currentHandler(larkAppId, enabled);
  } catch (error) {
    logger.warn(`[fold-background-updates] worker sync failed app=${larkAppId} enabled=${enabled}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
