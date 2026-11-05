import { getMessageDetail } from './client.js';
import { extractMentionIdentities, mentionAppId, mentionOpenId } from './message-parser.js';

/** Recover stable bot App IDs from this exact message, without names or a bot roster. */
export async function resolveSubstituteAppMentions(larkAppId: string, message: any): Promise<any> {
  if (!['text', 'post'].includes(message?.message_type ?? message?.msg_type)
      || !message?.message_id || !message?.chat_id
      || !extractMentionIdentities(message).some(mention => mention.openId && !mention.appId)) return message;
  try {
    const options = { userCardContent: false, timeoutMs: 2_000 };
    // Omitted user_id_type returns observer Open IDs; explicit open_id returns
    // bot App IDs. Read both representations to verify the event's recipients.
    const [detail, observed] = await Promise.all([
      getMessageDetail(larkAppId, message.message_id, { ...options, userIdType: 'open_id' }),
      getMessageDetail(larkAppId, message.message_id, options),
    ]);
    const item = detail?.items?.find((entry: any) => entry.message_id === message.message_id);
    const baseline = observed?.items?.find((entry: any) => entry.message_id === message.message_id);
    if (!item || item.chat_id !== message.chat_id
        || (item.msg_type ?? item.message_type) !== (message.message_type ?? message.msg_type)
        || JSON.stringify(JSON.parse(item.body?.content ?? '{}')) !== JSON.stringify(JSON.parse(message.content ?? '{}'))) return message;
    // The body may keep the same @_user_N after an edit changes its recipient.
    // Both REST views must describe the same version, and every attachment must
    // retain the event's observer-scoped identity even when WS omits update_time.
    if (!baseline || baseline.chat_id !== item.chat_id
        || baseline.msg_type !== item.msg_type
        || baseline.body?.content !== item.body?.content
        || baseline.create_time !== item.create_time
        || baseline.update_time !== item.update_time) return message;
    if (message.create_time && item.create_time && message.create_time !== item.create_time) return message;
    if (message.update_time && item.update_time && message.update_time !== item.update_time) return message;
    if (message.update_time && !item.update_time) return message;
    const appMentions = (item.mentions ?? []).filter((mention: any) => /^cli_[a-z0-9]+$/i.test(mentionAppId(mention) ?? ''));
    if (!appMentions.length) return message;
    const mentions = (message.mentions ?? []).map((mention: any) => {
      const match = appMentions.find((entry: any) => entry.key && entry.key === mention.key);
      const original = baseline.mentions?.find((entry: any) => entry.key === mention.key);
      if (!match || !mentionOpenId(mention) || mentionOpenId(original) !== mentionOpenId(mention)
          || (message.message_type === 'text' && !JSON.parse(message.content).text?.includes(match.key))) return mention;
      return { ...mention, id: {
        ...(typeof mention.id === 'object' ? mention.id : { open_id: mentionOpenId(mention) }),
        app_id: mentionAppId(match),
      } };
    });
    return { ...message, mentions };
  } catch {
    // API failure is never permission to guess a bot identity from its display name.
    return message;
  }
}
