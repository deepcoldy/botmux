/**
 * Reconcile the public streaming card after a closed session is resumed from
 * outside its original topic (for example the current-group `/sessions` card).
 *
 * The caller owns delivery routing and supplies `postCard`; this module owns
 * the lifecycle commit fence, persisted card identity, Pin continuation, and
 * predecessor withdrawal so every resume entry point follows the same order:
 * publish successor -> commit successor -> withdraw predecessor.
 */

import { getBot } from '../bot-registry.js';
import { deleteMessage } from '../im/lark/client.js';
import type { DaemonSession } from './types.js';
import { sessionAnchorId } from './types.js';
import { persistStreamCardState } from './session-manager.js';
import {
  buildStreamingCardJson,
  canCommitStreamingCardPublication,
  continuePublishedStreamingCardPinChain,
} from './worker-pool.js';

export type ResumeStreamingCardReconcileResult =
  | { status: 'committed'; reposted: boolean; messageId?: string }
  | { status: 'superseded' };

/**
 * Replace one proven public closed-session card after `resumeSession()` has
 * registered the resumed DaemonSession. If another turn/close/transfer wins
 * while the successor POST is in flight, the fresh-but-stale card is removed
 * and no predecessor is touched.
 */
export async function reconcileResumedStreamingCard(
  ds: DaemonSession,
  staleCardId: string,
  postCard: (cardJson: string) => Promise<string>,
): Promise<ResumeStreamingCardReconcileResult> {
  const botCfg = getBot(ds.larkAppId).config;
  const shouldRepost = botCfg.disableStreamingCard !== true
    && !botCfg.noCardChats?.includes(ds.chatId);
  const priorCardId = ds.streamCardId;
  const fence = {
    session: ds.session,
    larkAppId: ds.larkAppId,
    anchorId: sessionAnchorId(ds),
    expectedPriorCardId: priorCardId,
  };

  let freshCardId: string | undefined;
  if (shouldRepost) {
    freshCardId = await postCard(buildStreamingCardJson(ds));
    if (!canCommitStreamingCardPublication(ds, fence)) {
      await deleteMessage(ds.larkAppId, freshCardId).catch(() => { /* stale repost */ });
      return { status: 'superseded' };
    }
    ds.streamCardId = freshCardId;
  } else {
    // No POST means there is no later await at which to validate the route.
    // Check immediately before the synchronous identity commit so a concurrent
    // user turn cannot have promoted another card that we then clear/delete.
    if (!canCommitStreamingCardPublication(ds, fence)) {
      return { status: 'superseded' };
    }
    ds.streamCardId = undefined;
    ds.streamCardNonce = undefined;
    ds.streamCardReplyTargetKey = undefined;
  }

  persistStreamCardState(ds);
  if (freshCardId) {
    continuePublishedStreamingCardPinChain(ds, freshCardId, priorCardId ? [priorCardId] : []);
  }
  if (staleCardId !== freshCardId) {
    await deleteMessage(ds.larkAppId, staleCardId).catch(() => { /* already withdrawn/expired */ });
  }
  return { status: 'committed', reposted: shouldRepost, ...(freshCardId ? { messageId: freshCardId } : {}) };
}
