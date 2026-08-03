import { sendMessage } from '../im/lark/client.js';
import { buildMarkdownCard } from '../im/lark/md-card.js';

export interface SendBotMarkdownToChatOpts {
  larkAppId: string;
  chatId: string;
  markdown: string;
  idempotencyKey?: string;
  brand?: string;
}

/** Send a top-level Markdown card to a known chat using a configured Bot
 * identity. This intentionally has no Session dependency so installers and
 * recovery scripts can finish onboarding an already-created group without
 * impersonating a user or creating a duplicate group. */
export async function sendBotMarkdownToChat(
  opts: SendBotMarkdownToChatOpts,
): Promise<{ messageId: string }> {
  const card = buildMarkdownCard(opts.markdown, undefined, opts.brand);
  const messageId = await sendMessage(
    opts.larkAppId,
    opts.chatId,
    card,
    'interactive',
    opts.idempotencyKey,
  );
  return { messageId };
}
