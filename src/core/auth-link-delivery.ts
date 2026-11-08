/**
 * Authorization links go to the person who asked, privately — never into a
 * group.
 *
 * A device-code or OAuth link is bound to a pending authorization flow, not to
 * a person: whoever opens it and approves hands THEIR identity to the bot.
 * Posted in a group (one public topic in a ~5000-member group did exactly this),
 * any reader can complete someone else's request with their own account.
 *
 * So in any chat that is not a one-to-one chat with the bot, the link is sent
 * as a direct message to the initiator (Lark opens the 1:1 chat on first send)
 * and the group only learns that it was sent. When the DM cannot be delivered
 * (the person is outside the app's availability range, etc.) the group is told
 * to message the bot privately — the link itself is never posted.
 */
import { t, type Locale } from '../i18n/index.js';

export type AuthLinkDelivery = 'inline' | 'dm' | 'dm_failed';

export interface AuthLinkDeliveryInput {
  /** True only for a one-to-one chat between the initiator and the bot. */
  privateChat: boolean;
  /** The initiator: the only person the link may reach. */
  openId: string | undefined;
  /** The full message carrying the link. */
  text: string;
  /** Reply in the conversation the request came from. */
  replyInPlace: (text: string) => Promise<unknown>;
  /** Send a direct message to `openId`. */
  sendDirect: (openId: string, text: string) => Promise<unknown>;
  locale?: Locale;
  /** The command the person should send in a private chat if the DM fails. */
  privateCommand?: string;
}

export async function deliverAuthLink(input: AuthLinkDeliveryInput): Promise<AuthLinkDelivery> {
  if (input.privateChat) {
    await input.replyInPlace(input.text);
    return 'inline';
  }
  if (input.openId) {
    let delivered = false;
    try {
      await input.sendDirect(input.openId, input.text);
      delivered = true;
    } catch {
      // Fall through: say how to get the link without ever posting it here.
    }
    if (delivered) {
      // The link reached the person; failing to say so in the group must not
      // turn into "I could not message you".
      await input.replyInPlace(t('auth_link.sent_privately', undefined, input.locale)).catch(() => undefined);
      return 'dm';
    }
  }
  await input.replyInPlace(t('auth_link.dm_failed', { command: input.privateCommand ?? '/login' }, input.locale));
  return 'dm_failed';
}
