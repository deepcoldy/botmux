import type { DaemonSession } from '../../src/core/types.js';
import { beginReplyTargetTurn } from '../../src/core/reply-target.js';

export function routingSnapshot(ds: DaemonSession) {
  return structuredClone({
    replyTargets: ds.session.replyTargets,
    turnReplyContexts: ds.session.turnReplyContexts,
    replyTargetsPrunedThrough: ds.session.replyTargetsPrunedThrough,
  });
}

/** Fill both bounded indexes to their actual eviction boundary. */
export function fillRetryRouting(ds: DaemonSession, sourceTurnId: string) {
  ds.scope = 'chat';
  for (let i = 0; i < 2048; i++) {
    beginReplyTargetTurn(ds, `om_topic_${i}`, `fill_${i}`,
      new Date(1700000000000 + i).toISOString(), { senderOpenId: 'ou_original', quoteOnly: true });
    if (!ds.session.turnReplyContexts?.fill_0) break;
  }
  if (ds.session.turnReplyContexts?.fill_0) throw new Error('fixture did not reach capacity');
  beginReplyTargetTurn(ds, 'om_original', sourceTurnId, '2024-01-01T00:00:00.000Z',
    { senderOpenId: 'ou_original', quoteOnly: true });
  return routingSnapshot(ds);
}
