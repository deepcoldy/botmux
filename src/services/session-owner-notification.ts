import { replyMessage } from '../im/lark/client.js';

export interface SessionOwnerNotificationTarget {
  larkAppId: string;
  rootMessageId: string;
  ownerOpenId: string;
}

export function buildSessionOwnerMention(ownerOpenId: string, text?: string): string {
  const mention = `<at user_id="${ownerOpenId}"></at>`;
  return text ? `${mention} ${text}` : mention;
}

/** Shared delivery seam for manual Locate and scheduled owner reminders. */
export function sendSessionOwnerThreadNotification(
  target: SessionOwnerNotificationTarget,
  text?: string,
  uuid?: string,
): Promise<string> {
  return replyMessage(
    target.larkAppId,
    target.rootMessageId,
    buildSessionOwnerMention(target.ownerOpenId, text),
    'text',
    true,
    uuid,
  );
}
