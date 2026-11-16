import type { DaemonSession } from './types.js';
import { withBotTurnMutation } from './bot-turn-mutation-gate.js';
import { suspendWorkerAsync } from './worker-pool.js';
import { coordinationModeIsPrimary } from '../services/durable-coordination-runtime.js';
import { logger } from '../utils/logger.js';

/** Root withdrawal stops execution immediately but retains the logical topic
 * session. Recalling a reply never matches a thread's root binding. */
export async function suspendRecalledTopicWorkers(args: {
  larkAppId: string;
  chatId: string;
  messageId: string;
  activeSessions: ReadonlyMap<string, DaemonSession>;
}): Promise<void> {
  const tag = `[topic-suspend] root=${args.messageId.slice(0, 12)}`;
  if (coordinationModeIsPrimary()) {
    logger.warn(`${tag}: durable primary requires its authoritative lifecycle path`);
    return;
  }
  const matches = (ds: DaemonSession): boolean => ds.larkAppId === args.larkAppId
    && ds.chatId === args.chatId && ds.scope === 'thread'
    && ds.session.status === 'active' && ds.session.rootMessageId === args.messageId;
  try {
    await withBotTurnMutation(args.larkAppId, async () => {
      const seen = new Set<string>();
      for (const ds of args.activeSessions.values()) {
        if (!matches(ds) || seen.has(ds.session.sessionId)) continue;
        seen.add(ds.session.sessionId);
        const worker = ds.worker;
        if (!worker || worker.killed) continue;
        const generation = ds.workerGeneration;
        try {
          // This is an explicit termination event, not an idle suspend request:
          // stop the exact backing now rather than waiting for the turn to finish.
          const suspended = await suspendWorkerAsync(ds, 'topic_recalled', () =>
            [...args.activeSessions.values()].includes(ds) && matches(ds)
            && ds.worker === worker && ds.workerGeneration === generation);
          if (suspended) logger.info(`${tag}: suspended worker session=${ds.session.sessionId.slice(0, 8)}`);
          else logger.warn(`${tag}: suspend refused; session=${ds.session.sessionId.slice(0, 8)} retained for retry`);
        } catch (error) {
          logger.warn(`${tag}: suspend failed; session=${ds.session.sessionId.slice(0, 8)}: ${error}`);
        }
      }
    });
  } catch (error) {
    logger.warn(`${tag}: suspend mutation failed: ${error}`);
  }
}
