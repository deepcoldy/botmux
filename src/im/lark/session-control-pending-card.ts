import { t, type Locale } from '../../i18n/index.js';

export type SessionControlPendingAction = 'close' | 'resume';

/**
 * Build the short-lived, button-free card returned by the Lark callback after
 * the durable control event has been inserted. The final durable outbox update
 * replaces it with the authoritative active/closed card.
 */
export function buildSessionControlPendingCard(
  action: SessionControlPendingAction,
  locale: Locale,
): string {
  const prefix = action === 'close' ? 'card.action.close_pending' : 'card.action.resume_pending';
  return JSON.stringify({
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: t(`${prefix}_title`, undefined, locale),
      },
    },
    elements: [{
      tag: 'markdown',
      content: t(`${prefix}_body`, undefined, locale),
    }],
  });
}
