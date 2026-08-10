import { createHash } from 'node:crypto';
import type { CardActionData } from './card-handler.js';
import { resolveCardOperatorUnionId } from './card-handler.js';
import type { SkillFeedbackLevel, SkillFeedbackStore } from '../../services/skill-feedback-store.js';

export const DEFAULT_SKILL_FEEDBACK_LEVEL: SkillFeedbackLevel = 'L1';

export const SKILL_FEEDBACK_OPTIONS = {
  L0: [
    { code: 'helpful', label: '有帮助', type: 'primary' },
    { code: 'incomplete', label: '不完整', type: 'default' },
    { code: 'incorrect', label: '不正确', type: 'danger' },
  ],
  L1: [
    { code: 'usable', label: '结论可用', type: 'primary' },
    { code: 'progress', label: '有效推进', type: 'default' },
    { code: 'wrong', label: '结论有误', type: 'danger' },
  ],
  L2: [
    { code: 'completed', label: '已完成', type: 'primary' },
    { code: 'partial', label: '部分完成', type: 'default' },
    { code: 'blocked', label: '受阻', type: 'default' },
    { code: 'wrong', label: '结果错误', type: 'danger' },
  ],
} as const;

export function buildSkillFeedbackElement(level: SkillFeedbackLevel = DEFAULT_SKILL_FEEDBACK_LEVEL): Record<string, unknown> {
  return {
    tag: 'column_set',
    element_id: 'botmux_skill_feedback',
    flex_mode: 'none',
    horizontal_spacing: 'small',
    columns: SKILL_FEEDBACK_OPTIONS[level].map(option => ({
      tag: 'column',
      width: 'auto',
      elements: [{
        tag: 'button',
        text: { tag: 'plain_text', content: option.label },
        type: option.type,
        behaviors: [{ type: 'callback', value: { action: 'skill_feedback_submit', result: option.code } }],
      }],
    })),
  };
}

function callbackKey(input: { platformAppId: string; platformMessageId: string; operatorSubjectId: string; result: string; reasonKey?: string; callbackToken?: string }): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export async function handleSkillFeedbackCardAction(
  data: CardActionData,
  larkAppId: string,
  deps: { store: SkillFeedbackStore },
): Promise<any> {
  const platformMessageId = data.context?.open_message_id;
  const verifiedOperator = await resolveCardOperatorUnionId(data, larkAppId);
  const operatorSubjectId = verifiedOperator.unionId
    ?? (data.operator?.union_id === undefined && verifiedOperator.openId?.startsWith('ou_')
      ? verifiedOperator.openId
      : undefined);
  const result = data.action?.value?.result;
  if (!platformMessageId || !operatorSubjectId || !result) {
    return { toast: { type: 'error', content: '无法验证反馈来源，请重试' } };
  }
  const delivery = deps.store.findDeliveryByPlatformMessage('lark', larkAppId, platformMessageId);
  if (!delivery) {
    return { toast: { type: 'error', content: '反馈目标不存在或已失效' } };
  }
  const reasonKey = data.action?.value?.reason_key || undefined;
  const allowedResults = new Set(SKILL_FEEDBACK_OPTIONS[delivery.level].map(option => option.code));
  if (!allowedResults.has(result as never) || reasonKey !== undefined) {
    return { toast: { type: 'error', content: '反馈选项无效，请重试' } };
  }
  const callbackToken = data.action?.value?.callback_token || undefined;
  const recorded = deps.store.recordFeedback({
    platform: 'lark', platformAppId: larkAppId, platformMessageId, operatorSubjectId, result, reasonKey,
    callbackKey: callbackKey({ platformAppId: larkAppId, platformMessageId, operatorSubjectId, result, reasonKey, callbackToken }),
  });
  return {
    toast: {
      type: 'success',
      content: recorded.status === 'duplicate' ? '反馈已记录' : recorded.status === 'revised' ? '反馈已更新' : '感谢反馈',
    },
  };
}
