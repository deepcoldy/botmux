import { privateReplyEnabled } from './private-reply.js';
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
import { activeSessionKey, sessionAnchorId } from './types.js';
import { persistStreamCardState } from './session-manager.js';
import { fallbackTurnId, frozenReplyContextForTurn, replyTargetKey } from './reply-target.js';
import {
  acquireResumeStreamingCardPostSlot,
  classifyStreamingCardPostError,
  hasDivergentUnknownOutcomeBody,
  hashStreamingCardBody,
  hasUnknownOutcomeHistory,
  invalidateTurnStreamingCardPostSlot,
  recordStreamingCardPostFailure,
  retireStreamingCardPostSlot,
} from './streaming-card-post-slot.js';
import {
  CARD_POSTING_SENTINEL,
  buildStreamingCardJson,
  canCommitStreamingCardPublication,
  collectUsedStreamingCardNonces,
  continuePublishedStreamingCardPinChain,
  rememberPublishedStreamingCardIdentity,
  scheduleCardPatch,
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
  postCard: (cardJson: string, uuid?: string) => Promise<string>,
): Promise<ResumeStreamingCardReconcileResult> {
  const botCfg = getBot(ds.larkAppId).config;
  const shouldRepost = !privateReplyEnabled(ds.session) && botCfg.disableStreamingCard !== true
    && !botCfg.noCardChats?.includes(ds.chatId);
  const priorCardId = ds.streamCardId;
  const priorNonce = ds.streamCardNonce;
  const priorReplyTargetKey = ds.streamCardReplyTargetKey;
  const priorGeneration = ds.streamCardTurnGeneration ?? 0;

  let freshCardId: string | undefined;
  let dedupStale = false;
  let bodyHash = '';
  if (shouldRepost) {
    if (priorCardId === CARD_POSTING_SENTINEL) {
      return { status: 'superseded' };
    }
    const destReplyTargetKey = replyTargetKey(frozenReplyContextForTurn(ds, fallbackTurnId(ds, undefined)).target);
    const { slot } = acquireResumeStreamingCardPostSlot(ds, {
      sessionId: ds.session.sessionId,
      larkAppId: ds.larkAppId,
      anchorId: sessionAnchorId(ds),
      replyTargetKey: destReplyTargetKey,
      staleCardId,
      avoidNonces: collectUsedStreamingCardNonces(ds),
    });
    ds.streamCardNonce = slot.nonce;
    const cardJson = buildStreamingCardJson(ds);
    bodyHash = hashStreamingCardBody(cardJson);
    ds.streamCardId = CARD_POSTING_SENTINEL;
    const fence = {
      session: ds.session,
      larkAppId: ds.larkAppId,
      runtimeKey: activeSessionKey(ds),
      anchorId: sessionAnchorId(ds),
      expectedPriorCardId: CARD_POSTING_SENTINEL,
      expectedPriorNonce: slot.nonce,
      expectedTurnGeneration: priorGeneration,
    };
    const restorePrePostIdentity = (): void => {
      if (ds.streamCardId === CARD_POSTING_SENTINEL && ds.streamCardNonce === slot.nonce) {
        ds.streamCardId = priorCardId;
        ds.streamCardNonce = priorNonce;
        ds.streamCardReplyTargetKey = priorReplyTargetKey;
      }
    };
    try {
      freshCardId = await postCard(cardJson, slot.uuid);
    } catch (err) {
      const disposition = classifyStreamingCardPostError(err);
      if (canCommitStreamingCardPublication(ds, fence)
        || (disposition.mayHaveCommitted && ds.session.status === 'active')) {
        recordStreamingCardPostFailure(ds, slot, disposition, bodyHash);
      } else if (disposition.isTargetUnavailable || !hasUnknownOutcomeHistory(slot)) {
        retireStreamingCardPostSlot(ds, slot);
      }
      restorePrePostIdentity();
      throw err;
    }
    dedupStale = hasDivergentUnknownOutcomeBody(slot, bodyHash);
    retireStreamingCardPostSlot(ds, slot);
    if (!freshCardId || !canCommitStreamingCardPublication(ds, fence)) {
      restorePrePostIdentity();
      if (freshCardId) {
        await deleteMessage(ds.larkAppId, freshCardId).catch(() => { /* stale repost */ });
      }
      return { status: 'superseded' };
    }
    ds.streamCardId = freshCardId;
    ds.streamCardReplyTargetKey = destReplyTargetKey;
    rememberPublishedStreamingCardIdentity(ds, freshCardId, priorGeneration);
    invalidateTurnStreamingCardPostSlot(ds);
  } else {
    const fence = {
      session: ds.session,
      larkAppId: ds.larkAppId,
      runtimeKey: activeSessionKey(ds),
      anchorId: sessionAnchorId(ds),
      expectedPriorCardId: priorCardId,
    };
    // No POST means there is no later await at which to validate the route.
    // Check immediately before the synchronous identity commit so a concurrent
    // user turn cannot have promoted another card that we then clear/delete.
    if (!canCommitStreamingCardPublication(ds, fence)) {
      return { status: 'superseded' };
    }
    ds.streamCardId = undefined;
    ds.streamCardNonce = undefined;
    ds.streamCardReplyTargetKey = undefined;
    invalidateTurnStreamingCardPostSlot(ds);
  }

  persistStreamCardState(ds);
  if (freshCardId) {
    const latestCardJson = buildStreamingCardJson(ds);
    if (dedupStale || hashStreamingCardBody(latestCardJson) !== bodyHash) {
      scheduleCardPatch(ds, latestCardJson);
    }
    continuePublishedStreamingCardPinChain(ds, freshCardId, priorCardId ? [priorCardId] : []);
  }
  if (staleCardId !== freshCardId) {
    await deleteMessage(ds.larkAppId, staleCardId).catch(() => { /* already withdrawn/expired */ });
  }
  return { status: 'committed', reposted: shouldRepost, ...(freshCardId ? { messageId: freshCardId } : {}) };
}
