import { getBot } from '../../bot-registry.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { OncallGroupStore, type OncallGroupSource } from '../../services/oncall-group-store.js';
import { oncallGroupEnabled, type OncallGroupPolicy } from '../../services/oncall-group-policy.js';
import { createOncallGroup, loadOncallGroupTarget, oncallUsername, OncallGroupApiError } from '../../services/oncall-group-client.js';
import { getMessageDetail, replyMessage } from './client.js';
import { resolveSender } from './identity-cache.js';
import { parseApiMessage } from './message-parser.js';
import { chatAppLink } from './lark-hosts.js';
import type { CardActionData } from './card-handler.js';

export function buildOncallGroupColumn(): Record<string, any> {
  return { tag: 'column', element_id: 'botmux_oncall_group_column', width: 'auto', elements: [{
    tag: 'button', text: { tag: 'plain_text', content: '拉起 Oncall 群' }, type: 'primary_text',
    icon: { tag: 'standard_icon', token: 'chat_outlined' },
    behaviors: [{ type: 'callback', value: { action: 'oncall_group_create' } }],
  }] };
}

export function attachOncallGroupButton(raw: string, policy: OncallGroupPolicy | undefined, chatId: string, chatType?: string): string {
  if (chatType === 'p2p' || !oncallGroupEnabled(policy, chatId)) return raw;
  const card = JSON.parse(raw);
  const elements = card.body?.elements;
  if (!Array.isArray(elements) || elements.some((item: any) => item.element_id === 'botmux_oncall_group'
    || item.columns?.some((column: any) => column.element_id === 'botmux_oncall_group_column'))) return raw;
  const column = buildOncallGroupColumn();
  const feedback = elements.find((item: any) => item.element_id === 'botmux_feedback');
  if (feedback?.columns) { feedback.flex_mode = 'flow'; feedback.columns.push(column); }
  else {
    const footer = elements.findIndex((item: any) => item.element_id === 'botmux_reply_footer');
    elements.splice(footer < 0 ? elements.length : footer, 0, {
      tag: 'column_set', element_id: 'botmux_oncall_group', flex_mode: 'none', columns: [column],
    });
  }
  return JSON.stringify(card);
}

export function recordOncallGroupDelivery(dataDir: string, { card, ...source }: OncallGroupSource & { card: Record<string, any> }): void {
  if (!card.body?.elements?.some((item: any) => item.element_id === 'botmux_oncall_group'
    || item.columns?.some((column: any) => column.element_id === 'botmux_oncall_group_column'))) return;
  try { new OncallGroupStore(dataDir).recordSource(source); }
  catch { logger.warn('[oncall-group] Could not index the delivered card; the answer must not be resent'); }
}

export async function handleOncallGroupAction(data: CardActionData, appId: string): Promise<any> {
  const store = new OncallGroupStore(config.session.dataDir);
  let source: OncallGroupSource | undefined;
  try { source = store.findSource(appId, data.context?.open_message_id ?? ''); } catch { /* invalid source is rejected below */ }
  const bot = getBot(appId).config;
  if (!source || !oncallGroupEnabled(bot.oncallGroup, source.chatId)
    || (data.context?.open_chat_id && data.context.open_chat_id !== source.chatId)) {
    return { toast: { type: 'error', content: '此群未开启拉起 Oncall 群，或原卡片已失效' } };
  }
  if (!data.operator?.open_id?.startsWith('ou_')) return { toast: { type: 'error', content: '无法确认点击者身份' } };
  let text: string;
  try {
    let result = store.getRequest(source);
    if (!result || result.status === 'failed') {
      const target = loadOncallGroupTarget(config.session.dataDir, appId);
      const secret = process.env.ONCALL_SERVICE_SECRET?.trim();
      if (!secret) throw new Error('Oncall 服务账号凭据尚未配置，请联系机器人管理员设置 ONCALL_SERVICE_SECRET');
      const sender = await resolveSender(appId, data.operator.open_id, 'user');
      const username = oncallUsername(sender?.email, target);
      let question = '';
      if (source.questionId.startsWith('om_')) {
        try {
          const detail = await getMessageDetail(appId, source.questionId);
          question = parseApiMessage(detail?.items?.[0] ?? detail ?? {}).content;
        } catch { throw new Error('无法读取原问题，请稍后重试'); }
      }
      const message = [`问题：${question.slice(0, 8000)}`, `回答：${source.answer.slice(0, 16000)}`,
        `来源群：${chatAppLink(source.chatId, bot.brand)}\n原消息：${source.questionId}`].join('\n\n');
      if (store.claim(source)) {
        try {
          const created = await createOncallGroup(target, secret, username, message);
          store.finish(source, { status: 'succeeded', ...created });
        } catch (error) {
          store.finish(source, { status: error instanceof OncallGroupApiError && !error.uncertain ? 'failed' : 'unknown' });
          if (error instanceof OncallGroupApiError) throw error;
        }
      }
      result = store.getRequest(source);
    }
    text = result?.status === 'succeeded' && result.openChatId ? `Oncall 群：${chatAppLink(result.openChatId, bot.brand)}`
      : result?.status === 'failed' ? '拉起 Oncall 群失败，可再次点击重试'
        : '建群请求已提交，暂未确认结果，请勿重复创建；若长时间无结果，请联系管理员核对';
  } catch (error) { text = error instanceof Error ? error.message : 'Oncall 建群暂不可用'; }
  await replyMessage(appId, source.messageId, text, 'text', true);
}
