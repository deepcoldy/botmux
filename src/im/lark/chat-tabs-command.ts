import { localeForBot } from '../../i18n/index.js';
import { logger } from '../../utils/logger.js';
import { isBotMentioned, canOperate, extractMessageTextForRouting } from './event-dispatcher.js';
import { replyMessage } from './client.js';
import { stripLeadingMentions } from './message-parser.js';
import { deleteChatTab, ensureUrlChatTab, isCompleteChatTabOrder, listChatTabs, renameChatTab, sortChatTabs, type ChatTab } from './chat-tabs.js';

type TabsCommand =
  | { action: 'list' }
  | { action: 'add'; url: string; name?: string }
  | { action: 'rename'; tabId: string; name: string }
  | { action: 'delete'; tabId: string }
  | { action: 'sort'; tabIds: string[] }
  | { action: 'usage' };

export function parseTabsCommand(text: string): TabsCommand | null {
  const match = /^\/(?:tabs|tab)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const rest = (match[1] ?? '').trim();
  if (!rest || /^list$/i.test(rest)) return { action: 'list' };

  let m = /^add\s+(\S+)(?:\s+([\s\S]+))?$/i.exec(rest);
  if (m) {
    try {
      const url = new URL(m[1]!);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return { action: 'usage' };
      return { action: 'add', url: url.toString(), ...(m[2]?.trim() ? { name: m[2].trim() } : {}) };
    } catch {
      return { action: 'usage' };
    }
  }
  m = /^rename\s+(\S+)\s+([\s\S]+)$/i.exec(rest);
  if (m) return { action: 'rename', tabId: m[1]!, name: m[2]!.trim() };
  m = /^(?:delete|remove|rm)\s+(\S+)$/i.exec(rest);
  if (m) return { action: 'delete', tabId: m[1]! };
  m = /^sort\s+([\s\S]+)$/i.exec(rest);
  if (m) {
    const tabIds = m[1]!.trim().split(/[\s,]+/).filter(Boolean);
    return tabIds.length > 0 ? { action: 'sort', tabIds } : { action: 'usage' };
  }
  return { action: 'usage' };
}

function tabLine(tab: ChatTab, index: number): string {
  const content = tab.tab_content?.url ?? tab.tab_content?.doc ?? '';
  return `${index + 1}. ${tab.tab_name || '(未命名)'} · ${tab.tab_type}\n   ID: ${tab.tab_id || '-'}${content ? `\n   ${content}` : ''}`;
}

function strings(locale: 'zh' | 'en') {
  return locale === 'en' ? {
    usage: 'Usage:\n/tabs — list tabs\n/tabs add <url> [name]\n/tabs rename <tab_id> <name>\n/tabs delete <tab_id>\n/tabs sort <tab_id> ...',
    groupOnly: 'The /tabs command is only available in group chats.',
    forbidden: 'Only the bot owner or an authorized operator can change chat tabs.',
    empty: 'This chat has no tabs.',
    heading: 'Chat tabs:',
    added: 'Tab added', renamed: 'Tab renamed', deleted: 'Tab deleted', sorted: 'Tabs reordered',
    failed: 'Chat tab operation failed',
  } : {
    usage: '用法：\n/tabs — 查看标签页\n/tabs add <网址> [名称]\n/tabs rename <tab_id> <新名称>\n/tabs delete <tab_id>\n/tabs sort <tab_id> ...',
    groupOnly: '/tabs 仅支持在群聊中使用。',
    forbidden: '只有 bot owner 或获授权的操作人可以修改群标签页。',
    empty: '当前群没有标签页。',
    heading: '当前群标签页：',
    added: '已新增标签页', renamed: '已重命名标签页', deleted: '已删除标签页', sorted: '已完成标签页排序',
    failed: '标签页操作失败',
  };
}

export async function tryHandleChatTabsCommand(
  larkAppId: string,
  message: any,
  senderOpenId: string | undefined,
  canTalk: boolean,
): Promise<boolean> {
  const rawText = extractMessageTextForRouting(message);
  if (!rawText) return false;
  const text = stripLeadingMentions(rawText.trim(), message?.mentions ?? []);
  const command = parseTabsCommand(text);
  if (!command) return false;

  const isP2p = message.chat_type === 'p2p';
  if (!isP2p && !isBotMentioned(larkAppId, message, senderOpenId)) return true;

  const chatId = message.chat_id as string | undefined;
  const messageId = message.message_id as string | undefined;
  const locale = localeForBot(larkAppId);
  const s = strings(locale);
  const reply = (content: string) => messageId
    ? replyMessage(larkAppId, messageId, content, 'text', false)
        .catch(err => logger.warn(`[chat-tabs] reply failed: ${err?.message ?? err}`))
    : Promise.resolve();

  if (isP2p || !chatId) {
    await reply(s.groupOnly);
    return true;
  }
  if (!canTalk) return true;
  if (command.action === 'usage') {
    await reply(s.usage);
    return true;
  }
  if (command.action !== 'list' && !canOperate(larkAppId, chatId, senderOpenId)) {
    await reply(s.forbidden);
    return true;
  }

  try {
    if (command.action === 'list') {
      const tabs = await listChatTabs(larkAppId, chatId);
      await reply(tabs.length ? `${s.heading}\n${tabs.map(tabLine).join('\n')}` : s.empty);
    } else if (command.action === 'add') {
      const result = await ensureUrlChatTab(larkAppId, chatId, command.url, command.name);
      await reply(`${s.added}${result.tab.tab_id ? `：${result.tab.tab_id}` : ''}`);
    } else if (command.action === 'rename') {
      await renameChatTab(larkAppId, chatId, command.tabId, command.name);
      await reply(s.renamed);
    } else if (command.action === 'delete') {
      await deleteChatTab(larkAppId, chatId, command.tabId);
      await reply(s.deleted);
    } else {
      // Feishu requires the built-in message tab ID in the complete order.
      const current = await listChatTabs(larkAppId, chatId);
      if (!isCompleteChatTabOrder(current, command.tabIds)) {
        throw new Error('sort_requires_all_tab_ids');
      }
      await sortChatTabs(larkAppId, chatId, command.tabIds);
      await reply(s.sorted);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`[chat-tabs] ${command.action} failed chat=${chatId.substring(0, 12)}: ${detail}`);
    await reply(`${s.failed}：${detail}`);
  }
  return true;
}
