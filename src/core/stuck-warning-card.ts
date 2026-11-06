/**
 * Daemon-side policy for the "CLI is stuck on a blocking page" card: who the
 * turn initiator is (frozen when the card is posted), whether a click on a
 * `stuck_key` button may press its key, and the result line after a key
 * landed. Pure — worker-pool posts/patches the card, card-handler wires the
 * click; both delegate the decisions here so they can be tested without either.
 *
 * Keys always come from core/stuck-page-catalog.ts by (page type, button
 * index); the card callback never names a key.
 */
import type { TrustedCaller } from '../types.js';
import { t, type Locale } from '../i18n/index.js';
import { recoveryNoticeInitiator } from '../services/ordinary-recovery-notice.js';
import {
  stuckKeyPermitted,
  stuckPageOptionAt,
  stuckPageSpec,
  type StuckPageOption,
} from './stuck-page-catalog.js';

/**
 * The person who may press the card's `initiator` keys: the sender of the
 * exact turn the card was raised for. Same rule as the recovery-retry card
 * (recoveryNoticeInitiator): the daemon-authenticated caller of that turn when
 * the daemon still holds it (an `ou_` id of THIS app, not a bot), otherwise
 * the turn's reply-registry entry when it proves a human sender. A known but
 * disqualified caller (foreign app, bot) is never replaced by registry data.
 * No turn id → nobody (operators only).
 */
export function stuckCardInitiatorOpenId(input: {
  turnId: string | undefined;
  larkAppId: string;
  /** ds.activeInteractiveTurn — used only when it is the same turn. */
  activeTurn?: { turnId: string; caller: TrustedCaller } | undefined;
  /** pickTurnReplyTarget(ds.session, turnId). */
  replyTarget?: { senderOpenId?: string; participants?: Array<{ openId?: string; isBot?: boolean }> } | undefined;
}): string | undefined {
  const turnId = input.turnId;
  if (!turnId) return undefined;
  const caller = input.activeTurn?.turnId === turnId ? input.activeTurn.caller : undefined;
  const initiator = recoveryNoticeInitiator(
    {
      logicalTurnId: turnId,
      ...(caller ? { retryInputs: { [turnId]: { cliInput: '', trustedCaller: caller } } } : {}),
    },
    {
      larkAppId: input.larkAppId,
      ...(input.replyTarget ? { replyTarget: input.replyTarget } : {}),
    },
  );
  return initiator.openId;
}

export type StuckKeyClickDecision =
  /** Not this card / not this warning / not a button of this page: ignore
   *  silently (the card is stale or the callback was forged). */
  | { kind: 'drop'; reason: 'stale_card' | 'stale_nonce' | 'unknown_option' }
  /** A real button of the live card, but this operator may not press it. */
  | { kind: 'deny'; toastKey: string }
  | { kind: 'press'; option: StuckPageOption };

/**
 * Gate for a `stuck_key` click. Order: the click must come from the active
 * card AND carry its nonce, the index must name an option of the active page
 * type, then the operator must be allowed for that option's audience. The
 * permission inputs are thunks so stale clicks never consult the grant store.
 */
export function decideStuckKeyClick(input: {
  cardMessageId: string | undefined;
  activeCardId: string | undefined;
  valueNonce: unknown;
  activeNonce: number | undefined;
  pageType: unknown;
  rawIndex: unknown;
  operatorOpenId: string | undefined;
  initiatorOpenId: string | undefined;
  /** Global switch (config.ts `stuckCardInitiatorKeys`, read at click time):
   *  false = nobody counts as the initiator, every key is operators only. */
  initiatorKeysEnabled: boolean;
  operatorIsAdmin: () => boolean;
  operatorCanTalk: () => boolean;
}): StuckKeyClickDecision {
  if (!input.activeCardId || input.cardMessageId !== input.activeCardId) {
    return { kind: 'drop', reason: 'stale_card' };
  }
  if (input.activeNonce === undefined || input.valueNonce !== String(input.activeNonce)) {
    return { kind: 'drop', reason: 'stale_nonce' };
  }
  const option = stuckPageOptionAt(input.pageType, input.rawIndex);
  if (!option) return { kind: 'drop', reason: 'unknown_option' };
  const initiatorOpenId = input.initiatorKeysEnabled ? input.initiatorOpenId : undefined;
  const operatorIsAdmin = !!input.operatorOpenId && input.operatorIsAdmin();
  const permitted = stuckKeyPermitted({
    audience: option.audience,
    operatorOpenId: input.operatorOpenId,
    initiatorOpenId,
    operatorIsAdmin,
    // canTalk only matters for the initiator pressing an initiator key.
    operatorCanTalk: !operatorIsAdmin
      && option.audience === 'initiator'
      && !!input.operatorOpenId
      && input.operatorOpenId === initiatorOpenId
      && input.operatorCanTalk(),
  });
  if (!permitted) {
    return {
      kind: 'deny',
      toastKey: option.audience === 'admin' || !input.initiatorKeysEnabled
        ? 'card.stuck.denied_admin_only'
        : 'card.stuck.denied',
    };
  }
  return { kind: 'press', option };
}

/** Human name of a key the card can send (shown on buttons' results). */
export function stuckKeyDisplayName(key: string): string {
  if (key === 'Escape') return 'Esc';
  return key;
}

/**
 * Result line for the card after the worker wrote a stuck-card key. The worker
 * re-reads the screen shortly after the key: `afterObserved === false` = that
 * capture failed; `afterPageType` = still (or now) on a known blocking page;
 * neither = the page is gone. A worker that predates the fields sends no
 * `key` and gets the old generic "done".
 */
export function stuckKeyResultText(
  msg: { key?: string; afterPageType?: string; afterObserved?: boolean },
  locale?: Locale,
): string {
  if (!msg.key) return t('card.action.tui_done', undefined, locale);
  const key = stuckKeyDisplayName(msg.key);
  if (msg.afterObserved === false) return t('card.stuck.result.unobserved', { key }, locale);
  if (msg.afterPageType) {
    const spec = stuckPageSpec(msg.afterPageType);
    const page = spec ? t(spec.descriptionKey, undefined, locale) : t('card.stuck.page.unknown', undefined, locale);
    return t('card.stuck.result.still_blocked', { key, page }, locale);
  }
  return t('card.stuck.result.left_page', { key }, locale);
}

/**
 * Plain-text stand-in for a keyed stuck card that Feishu refused (content
 * audit on the screen text, size): the same news without the screen tail.
 * `submit_unconfirmed` carries its own worker-localised notice (noticeText);
 * a held message gets the hold notice the worker used to send as text; a
 * stalled turn (reason absent) gets a one-line "stuck on <page>". Undefined =
 * nothing to send.
 */
export function stuckCardFallbackText(
  msg: { reason?: 'turn_stalled' | 'input_held' | 'submit_unconfirmed'; matchedPattern?: string; noticeText?: string },
  cliName: string,
  locale?: Locale,
): string | undefined {
  if (msg.reason === 'submit_unconfirmed') return msg.noticeText || undefined;
  const spec = stuckPageSpec(msg.matchedPattern);
  const page = t(spec ? spec.descriptionKey : 'card.stuck.page.unknown', undefined, locale)
    .replace(/[。.]\s*$/, '');
  const key = msg.reason === 'input_held' ? 'card.stuck.fallback.input_held' : 'card.stuck.fallback.turn_stalled';
  return t(key, { cliName, page }, locale);
}

/**
 * Whether a failed card POST means the card did NOT reach the chat, so a text
 * fallback will not duplicate it. daemon.ts sessionReply throws
 * 'principal-lane outbound lost turn ownership' from persistPrincipalLaneOutbound
 * AFTER sendMessage/replyMessage returned a message id — the card is already
 * in the chat, only its provenance bookkeeping failed. daemon.ts exposes no
 * error class for it, so it is matched by message. Every other throw on that
 * path (stale/ambiguous identity, topic unavailable, Lark API refusal) happens
 * before or instead of the send.
 */
export function stuckCardPostErrorMeansUnsent(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return !message.includes('principal-lane outbound lost turn ownership');
}
