/**
 * One live status card per user-visible session restart.
 *
 * A restart used to post a "restarting…" text and then a separate result text
 * (and a dashboard restart posted only the first one). Instead the first
 * notification posts a card and every later status patches that same card in
 * place: 重启中 → 已重启 / 重启失败 / 重启超时 / 重启已中止.
 *
 * Observers that joined the same physical attempt (two people pressing restart
 * at once, `/restart` while a card restart is in flight) share the card: the
 * coordinator hands every observer the same attemptId, and only the first
 * observer to hear a status posts or patches.
 *
 * The caller owns delivery routing (`post`); this module owns the card shape
 * and the post-once / patch-afterwards lifecycle.
 */

import { MessageUpdateExpiredError, MessageWithdrawnError, updateMessage } from '../im/lark/client.js';
import { cardHeader, wideCard, larkMdDiv } from '../im/lark/card-primitives.js';
import { t } from '../i18n/index.js';
import type { Locale } from '../i18n/index.js';
import { logger } from '../utils/logger.js';
import type { RestartObserver, RestartObserverStatus } from './restart-coordinator.js';

export type RestartCardSource = 'slash' | 'card' | 'dashboard' | 'effort';

const HEADER_TEMPLATE: Record<RestartObserverStatus, string> = {
  in_progress: 'blue',
  succeeded: 'green',
  failed: 'red',
  timed_out: 'orange',
  cancelled: 'grey',
};

/**
 * The card for one restart status. `body` overrides the default per-status
 * explanation (the reasoning-effort reload words it differently).
 */
export function buildRestartStatusCard(o: {
  status: RestartObserverStatus;
  cliName: string;
  source: RestartCardSource;
  locale?: Locale;
  body?: string;
}): string {
  const { status, cliName, locale } = o;
  return JSON.stringify(wideCard({
    header: cardHeader(t(`card.restart.title_${status}`, { cliName }, locale), HEADER_TEMPLATE[status]),
    elements: [
      larkMdDiv(o.body ?? t(`card.restart.body_${status}`, undefined, locale)),
      { tag: 'note', elements: [{ tag: 'plain_text', content: t(`card.restart.source_${o.source}`, undefined, locale) }] },
    ],
    // Patched in place for everyone in the chat, not just the viewer.
    extraConfig: { update_multi: true },
  }));
}

interface SharedRestartCard {
  /** Resolves to the posted card's message id, or undefined when posting failed. */
  messageId: Promise<string | undefined>;
  /** Last status the card was asked to show. */
  shown: RestartObserverStatus;
  /** Observers that heard `in_progress` and have not heard a final status yet. */
  pending: number;
  /** The posting observer's edges: whoever settles the card renders and
   *  delivers it the poster's way, so its wording and source stay one card's. */
  render: (status: RestartObserverStatus) => string;
  post: (status: RestartObserverStatus) => Promise<string | undefined>;
  update: (messageId: string, cardJson: string) => Promise<unknown>;
}

const sharedCards = new Map<string, SharedRestartCard>();

export function __testOnly_resetRestartStatusCards(): void {
  sharedCards.clear();
}

export interface RestartStatusCardOptions {
  larkAppId: string;
  sessionId: string;
  render: (status: RestartObserverStatus) => string;
  /** Post a new card into the session's chat/thread; returns its message id. */
  post: (cardJson: string) => Promise<string | undefined>;
  /** Patch a posted card. Defaults to the Lark message PATCH. */
  update?: (messageId: string, cardJson: string) => Promise<unknown>;
  /** Wait before the one retry of a PATCH that failed for a transient reason. */
  retryDelayMs?: number;
}

/** The card is gone or past its edit window: retrying the PATCH cannot help. */
function patchIsFinal(err: unknown): boolean {
  return err instanceof MessageWithdrawnError || err instanceof MessageUpdateExpiredError;
}

/** A RestartObserver.notify that keeps one status card current. */
export function restartStatusCardNotifier(o: RestartStatusCardOptions): RestartObserver['notify'] {
  const update = o.update ?? ((messageId: string, cardJson: string) => updateMessage(o.larkAppId, messageId, cardJson));
  const retryDelayMs = o.retryDelayMs ?? 1_000;
  const post = async (status: RestartObserverStatus): Promise<string | undefined> => {
    try {
      return (await o.post(o.render(status))) || undefined;
    } catch (err) {
      logger.warn(`[restart] failed to post ${status} restart card for ${o.sessionId}: ${err}`);
      return undefined;
    }
  };

  const patch = async (card: SharedRestartCard, messageId: string, status: RestartObserverStatus): Promise<boolean> => {
    for (let attempt = 0; ; attempt++) {
      try {
        await card.update(messageId, card.render(status));
        return true;
      } catch (err) {
        logger.warn(`[restart] failed to update restart card ${messageId} to ${status}: ${err}`);
        if (attempt > 0 || patchIsFinal(err)) return false;
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
  };

  return async (status, attemptId) => {
    const key = `${o.sessionId}:${attemptId}`;
    const shared = sharedCards.get(key);
    if (status === 'in_progress') {
      if (shared) {
        shared.pending++;
        return;
      }
      const entry: SharedRestartCard = {
        messageId: post('in_progress'), shown: 'in_progress', pending: 1, render: o.render, post, update,
      };
      sharedCards.set(key, entry);
      await entry.messageId;
      return;
    }

    if (!shared) {
      if (status !== 'cancelled') await post(status);
      return;
    }
    if (--shared.pending <= 0) sharedCards.delete(key);
    // Another observer of this attempt already moved the card to its result.
    if (shared.shown !== 'in_progress') return;
    shared.shown = status;
    const messageId = await shared.messageId;
    if (messageId && await patch(shared, messageId, status)) return;
    // Nobody saw "restarting" — a cancel has nothing to correct.
    if (status === 'cancelled' && !messageId) return;
    // The in-progress card never landed or can no longer be patched: post the
    // result as its own card so the outcome is not lost.
    await shared.post(status);
  };
}
