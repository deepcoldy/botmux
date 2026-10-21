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
    schema: '2.0',
    config: {
      width_mode: 'fill',
      enable_forward_interaction: false,
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: t(`${prefix}_title`, undefined, locale),
      },
    },
    body: {
      direction: 'vertical',
      elements: [{
        tag: 'markdown',
        element_id: 'botmux_session_control_pending',
        content: t(`${prefix}_body`, undefined, locale),
      }],
    },
  });
}
