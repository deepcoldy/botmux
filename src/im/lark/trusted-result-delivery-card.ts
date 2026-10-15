import type { Locale } from '../../i18n/index.js';
import {
  buildCanonicalFinalReplyCard,
  CARD_LATE_CHROME_RESERVE_BYTES,
} from './md-card.js';
import {
  TURN_REPLY_CARD_MAX_BYTES,
  turnReplyCardRequestBytes,
} from './turn-reply-card-size.js';

export interface TrustedResultDeliveryCardOptions {
  markdown: string;
  chatId: string;
  uuid: string;
  recipientOpenId?: string;
  brand?: string;
  locale?: Locale;
  workingDir?: string;
}

/** Build and byte-check the exact card before any source file is consumed. */
export function buildTrustedResultDeliveryCard(
  opts: TrustedResultDeliveryCardOptions,
): string {
  const card = buildCanonicalFinalReplyCard({
    markdown: opts.markdown,
    recipientOpenId: opts.recipientOpenId,
    brand: opts.brand,
    locale: opts.locale,
    workingDir: opts.workingDir,
  });
  if (turnReplyCardRequestBytes(card, opts.chatId, opts.uuid)
    > TURN_REPLY_CARD_MAX_BYTES - CARD_LATE_CHROME_RESERVE_BYTES) {
    throw new Error('host_delivery_markdown_too_large');
  }
  return card;
}
