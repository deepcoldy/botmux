import type { DaemonSession } from '../core/types.js';
import type { DaemonToWorker } from '../types.js';
import { logger } from '../utils/logger.js';

/** Daemon-side notification that a bot's replyCardRecap was switched off. */
export type AwaySummaryFocusRevocationHandler = (larkAppId: string) => void;

let currentHandler: AwaySummaryFocusRevocationHandler | undefined;

/** Register the live-session broadcast without linking config-store to worker-pool. */
export function registerAwaySummaryFocusRevocationHandler(
  handler: AwaySummaryFocusRevocationHandler,
): () => void {
  const previous = currentHandler;
  currentHandler = handler;
  return () => {
    if (currentHandler === handler) currentHandler = previous;
  };
}

/** Called only after a bots.json on→off transition has committed. */
export function notifyAwaySummaryFocusRevoked(larkAppId: string): void {
  if (!currentHandler) return;
  try {
    currentHandler(larkAppId);
  } catch (error) {
    logger.warn(`[away-summary] revocation broadcast failed for ${larkAppId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Cancel waiting and report focus back in every live worker owned by this bot. */
export function cancelAwaySummaryFocusForBot(
  sessions: Iterable<DaemonSession>,
  larkAppId: string,
): number {
  let sent = 0;
  for (const ds of new Set(sessions)) {
    if (ds.larkAppId !== larkAppId) continue;
    const worker = ds.worker;
    if (!worker?.connected || worker.killed) continue;
    try {
      worker.send({ type: 'away_summary_focus_cancel' } satisfies DaemonToWorker);
      sent += 1;
    } catch (error) {
      logger.warn(`[away-summary] ${ds.session.sessionId.slice(0, 8)}: revocation not sent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return sent;
}
