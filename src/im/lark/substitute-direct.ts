import type { SubstituteTrigger } from '../../types.js';
import {
  appendSubstituteInterventionNote,
  consumeSubstituteInterventionNotes,
  getActiveSubstituteDirectChat,
  getSubstituteDirectQuotedGroupMessageId,
  getSubstituteDirectChat,
  recordSubstituteDirectForwardedMessage,
  upsertSubstituteDirectChat,
  type SubstituteDirectChat,
} from '../../services/substitute-direct-store.js';
import { getBot, resolveBrandLabel } from '../../bot-registry.js';
import { getChatName, MessageWithdrawnError, replyMessage, sendMessage, sendUserMessage } from './client.js';
import { resolveName } from './identity-cache.js';
import { mentionOpenId, stripLeadingMentions } from './message-parser.js';
import { buildMarkdownCard } from './md-card.js';
import { t, localeForBot } from '../../i18n/index.js';
import { logger } from '../../utils/logger.js';

function textFromMessage(message: any, opts?: { renderAt?: boolean }): string | null {
  if (!message?.content) return null;
  try {
    const obj = JSON.parse(message.content);
    if (typeof obj?.text === 'string') return opts?.renderAt ? renderMentionKeys(obj.text, message?.mentions) : obj.text;
    const inner = obj?.zh_cn ?? obj?.en_us ?? obj;
    if (Array.isArray(inner?.content)) {
      const parts: string[] = [];
      for (const para of inner.content) {
        if (!Array.isArray(para)) continue;
        for (const node of para) {
          if (node?.tag === 'text' && typeof node.text === 'string') parts.push(node.text);
          else if (node?.tag === 'at' && typeof node.user_name === 'string') {
            const openId = typeof node.user_id === 'string' ? node.user_id : undefined;
            parts.push(opts?.renderAt && openId ? `<at id=${openId}></at>` : `@${node.user_name}`);
          }
        }
      }
      return parts.join('').trim() || null;
    }
  } catch { /* ignore malformed content */ }
  return null;
}

function renderMentionKeys(text: string, mentions: any[] | undefined): string {
  if (!mentions?.length) return text;
  let out = text;
  const sorted = [...mentions].sort((a, b) => String(b?.key ?? '').length - String(a?.key ?? '').length);
  for (const mention of sorted) {
    if (!mention?.key) continue;
    const openId = mentionOpenId(mention);
    if (!openId) continue;
    out = out.split(mention.key).join(`<at id=${openId}></at>`);
  }
  return out;
}

export async function forwardSubstituteGroupMessageToDm(input: {
  larkAppId: string;
  chatId: string;
  message: any;
  trigger: SubstituteTrigger;
  direct?: { substituteOpenId: string; chat: SubstituteDirectChat };
}): Promise<boolean> {
  const targetOpenId = input.direct?.substituteOpenId ?? input.trigger.target.openId;
  if (!targetOpenId) return false;
  const existing = input.direct?.chat ?? getSubstituteDirectChat(input.larkAppId, targetOpenId, input.chatId);
  if (!existing || existing.mode !== 'direct') return false;
  const loc = localeForBot(input.larkAppId);
  const body = textFromMessage(input.message, { renderAt: true });
  const chatName = await getChatName(input.larkAppId, input.chatId).catch(() => null);
  upsertSubstituteDirectChat({
    larkAppId: input.larkAppId,
    substituteOpenId: targetOpenId,
    targetOpenId: input.trigger.target.openId,
    substituteUserId: input.trigger.target.userId,
    substituteUnionId: input.trigger.target.unionId,
    chatId: input.chatId,
    chatName,
    targetName: input.trigger.target.name,
    mode: 'direct',
    disclosure: input.trigger.disclosure,
    lastGroupMessageId: input.message?.message_id,
  });
  const forwardedContent = body
    ? body
    : t('substitute.direct.dm_non_text', {
        messageType: input.message?.message_type ?? input.message?.msg_type ?? t('substitute.direct.non_text_fallback', undefined, loc),
      }, loc);
  const content = t('substitute.direct.dm', {
    chat: chatName ?? input.chatId,
    target: input.trigger.target.name ?? targetOpenId,
    content: forwardedContent,
  }, loc);
  const dmMessageId = await sendUserMessage(input.larkAppId, targetOpenId, content, 'text');
  recordSubstituteDirectForwardedMessage({
    larkAppId: input.larkAppId,
    substituteOpenId: targetOpenId,
    chatId: input.chatId,
    dmMessageId,
    groupMessageId: input.message?.message_id,
  });
  logger.info(`[substitute-direct:${input.larkAppId}] group ${input.chatId.substring(0, 12)} → DM ${targetOpenId.substring(0, 12)}`);
  return true;
}

export async function forwardSubstituteDmMessageToGroup(input: {
  larkAppId: string;
  message: any;
  senderOpenId: string | undefined;
}): Promise<boolean> {
  if (input.message?.chat_type !== 'p2p' || !input.senderOpenId) return false;
  const chat = getActiveSubstituteDirectChat(input.larkAppId, input.senderOpenId);
  if (!chat) return false;
  const loc = localeForBot(input.larkAppId);
  const rawBody = textFromMessage(input.message);
  const body = textFromMessage(input.message, { renderAt: true });
  const stripped = rawBody ? stripLeadingMentions(rawBody.trim(), input.message?.mentions ?? []).trim() : '';
  if (stripped.startsWith('/')) return false;
  if (!body) {
    await replyMessage(input.larkAppId, input.message.message_id, t('substitute.direct.unsupported_dm', undefined, loc), 'text', false)
      .catch(err => logger.warn(`[substitute-direct] unsupported DM notice failed: ${err?.message ?? err}`));
    return true;
  }
  if (chat.mode === 'intervene') {
    appendSubstituteInterventionNote(input.larkAppId, input.senderOpenId, body);
    await replyMessage(input.larkAppId, input.message.message_id, t('substitute.intervene.saved', undefined, loc), 'text', false)
      .catch(err => logger.warn(`[substitute-direct] intervention saved notice failed: ${err?.message ?? err}`));
    return true;
  }
  const senderName = await resolveName(input.larkAppId, input.senderOpenId);
  const currentTarget = getBot(input.larkAppId).config.substituteMode?.targets?.find(t => t.openId === input.senderOpenId);
  const name = senderName || currentTarget?.name || chat.targetName || t('substitute.direct.group_fallback_name', undefined, loc);
  const content = chat.disclosure === 'none'
    ? t('substitute.direct.group', { name, content: body }, loc)
    : t('substitute.direct.group_prefix', { name, content: body }, loc);
  const card = buildMarkdownCard(content, undefined, resolveBrandLabel(input.larkAppId), loc);
  const hookContext = {
    source: 'substitute_direct',
    sourceMessageId: input.message?.message_id,
    substituteOpenId: input.senderOpenId,
  };
  const quotedGroupMessageId = getSubstituteDirectQuotedGroupMessageId(input.larkAppId, input.senderOpenId, input.message?.parent_id ?? input.message?.root_id);
  if (quotedGroupMessageId) {
    try {
      await replyMessage(input.larkAppId, quotedGroupMessageId, card, 'interactive', false, undefined, hookContext);
    } catch (err) {
      if (err instanceof MessageWithdrawnError) {
        await sendMessage(input.larkAppId, chat.chatId, card, 'interactive', undefined, hookContext);
      } else {
        throw err;
      }
    }
  } else {
    await sendMessage(input.larkAppId, chat.chatId, card, 'interactive', undefined, hookContext);
  }
  logger.info(`[substitute-direct:${input.larkAppId}] DM ${input.senderOpenId.substring(0, 12)} → group ${chat.chatId.substring(0, 12)}`);
  return true;
}

export function consumeSubstituteDirectInterventionNotes(input: {
  larkAppId: string;
  substituteOpenId: string | undefined;
  chatId: string | undefined;
}): string[] {
  return consumeSubstituteInterventionNotes(input.larkAppId, input.substituteOpenId, input.chatId);
}
