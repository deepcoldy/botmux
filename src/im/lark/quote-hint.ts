/**
 * Build the "[用户引用了消息 ...]" hint we prepend to the bot prompt when the
 * user used Lark's quote-reply UI to reference an earlier message.
 *
 * Returns an empty string when no quote is present, or when `parent_id`
 * collapses to the thread root / current message id (those are routing
 * plumbing, not a user-visible quote action — surfacing them would have
 * the bot run `botmux quoted` on its own thread root every turn).
 *
 * Shared by handleNewTopic and handleThreadReply so first-turn quote-replies
 * (no active session yet → handleNewTopic) surface the same hint as follow-ups
 * in an existing session (handleThreadReply).
 */
import { t, type Locale } from '../../i18n/index.js';

export function buildQuoteHint(
  parsed: { parentId?: string; messageId: string },
  scope: 'thread' | 'chat',
  anchor: string,
  locale?: Locale,
): string {
  const quotedId = parsed.parentId;
  if (!quotedId) return '';
  const threadRoot = scope === 'thread' ? anchor : null;
  if (quotedId === threadRoot || quotedId === parsed.messageId) return '';
  return `${t('prompt.quote_hint', { id: quotedId }, locale)}\n`;
}
