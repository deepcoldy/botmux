import type { DaemonSession } from './types.js';
import type { FeedbackWebhookDestination } from '../services/feedback-outbox.js';
import type { SkillFeedbackStore } from '../services/skill-feedback-store.js';

/**
 * Daemon-side half of `botmux send --response-kind final` for a CLI that
 * cannot open the feedback store itself (bwrap sandbox / macOS read isolation:
 * `botmux-feedback.sqlite` holds every bot's delivery rows, so it is
 * deliberately not exposed to the session). Without this, the canonical final
 * answer of an isolated session never gets a delivery row, and the later
 * `turn_terminal` has nothing to correlate a `turn.completed` against.
 *
 * Trust boundary: the caller already passed `sessionCliIpcAuth`, i.e. it holds
 * this session's current rotating turn capability. Every correlation field is
 * therefore taken from the live DaemonSession — the CLI contributes only the
 * platform message id and the answer text it just delivered. The worst a
 * session can do is mis-index its own current turn, which a non-isolated CLI
 * can already do by writing the store directly. No feedback policy or base
 * card is accepted: an isolated CLI cannot read bot config, so its card never
 * carries a feedback control.
 */
export const RELAYED_TURN_DELIVERY_ROUTE = 'turn-delivery';
/** Larger than any Lark message body; the store keeps only a content hash. */
export const RELAYED_TURN_DELIVERY_MAX_BYTES = 1024 * 1024;

const MESSAGE_ID = /^om_[A-Za-z0-9_-]{1,128}$/;

export type RelayedTurnDeliveryResult =
  | { ok: true; deliveryId: string; duplicate: boolean }
  | { ok: false; status: 400 | 404 | 409; error: string };

export function recordRelayedTurnDelivery(input: {
  ds: Pick<DaemonSession, 'session' | 'larkAppId' | 'chatId' | 'cliVersion' | 'managedTurnOrigin'> | undefined;
  body: Record<string, unknown>;
  store: Pick<SkillFeedbackStore, 'findDeliveryByPlatformMessage' | 'recordTurnDelivery'>;
  webhookDestinations?: FeedbackWebhookDestination[];
  teamId?: string;
}): RelayedTurnDeliveryResult {
  const { ds, body, store } = input;
  if (!ds || ds.session.status === 'closed') return { ok: false, status: 404, error: 'session_not_active' };
  const messageId = body.messageId;
  const content = body.content;
  if (typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)
      || typeof content !== 'string' || !content) {
    return { ok: false, status: 400, error: 'invalid_turn_delivery' };
  }
  // The turn is the one the presented capability was minted for — never a
  // client-supplied id, so a session cannot index into another of its turns.
  const turnId = ds.managedTurnOrigin?.turnId;
  if (!turnId) return { ok: false, status: 409, error: 'turn_unbound' };
  const existing = store.findDeliveryByPlatformMessage('lark', ds.larkAppId, messageId);
  if (existing) {
    return existing.sessionId === ds.session.sessionId && existing.turnId === turnId
      ? { ok: true, deliveryId: existing.deliveryId, duplicate: true }
      : { ok: false, status: 409, error: 'message_already_recorded' };
  }
  const delivery = store.recordTurnDelivery({
    botAppId: ds.larkAppId,
    sessionId: ds.session.sessionId,
    turnId,
    // Same discriminator the in-process path uses for a bound turn.
    correlationDiscriminator: messageId,
    nativeSessionId: ds.session.cliSessionId,
    platform: 'lark',
    platformAppId: ds.larkAppId,
    platformMessageId: messageId,
    chatId: ds.chatId,
    topicRootId: ds.session.rootMessageId,
    dispatchAttempt: ds.managedTurnOrigin?.dispatchAttempt,
    content,
    cliId: ds.session.cliId,
    cliVersion: ds.cliVersion,
    model: ds.session.model,
    reasoningEffort: ds.session.reasoningEffort,
    cardMode: 'card',
    status: 'delivered',
    webhookDestinations: input.webhookDestinations,
    context: input.teamId ? { teamId: input.teamId } : {},
  });
  return { ok: true, deliveryId: delivery.deliveryId, duplicate: false };
}
