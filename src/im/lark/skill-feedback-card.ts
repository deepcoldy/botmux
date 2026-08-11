import { createHash } from 'node:crypto';
import type { CardActionData } from './card-handler.js';
import { resolveCardOperatorUnionId } from './card-handler.js';
import type { FeedbackPolicy } from '../../services/feedback-policy.js';
import type { SkillFeedbackStore } from '../../services/skill-feedback-store.js';

export interface FeedbackCardState { result?: string; reasonKey?: string; comment?: string }

function button(text: string, style: string, value: Record<string, unknown>, disabled = false): Record<string, unknown> {
  return { tag: 'button', text: { tag: 'plain_text', content: text }, type: style, disabled, behaviors: [{ type: 'callback', value }] };
}

export function buildFeedbackElement(policy: FeedbackPolicy, state: FeedbackCardState = {}): Record<string, unknown> {
  const locked = !!state.result && !policy.allowReselect;
  return {
    tag: 'column_set', element_id: 'botmux_feedback', flex_mode: 'none', horizontal_spacing: 'small',
    columns: policy.buttons.map(option => ({
      tag: 'column', width: 'auto', elements: [
        button(option.label, option.style, { action: 'feedback_submit', result: option.key }, locked),
      ],
    })),
  };
}

function feedbackStateElements(policy: FeedbackPolicy, state: FeedbackCardState): Record<string, unknown>[] {
  if (!state.result) return [buildFeedbackElement(policy)];
  const selected = policy.buttons.find(option => option.key === state.result);
  const elements: Record<string, unknown>[] = [buildFeedbackElement(policy, state)];
  elements.push({ tag: 'markdown', element_id: 'botmux_feedback_status', content: `已选择：**${selected?.label ?? state.result}**` });
  if (!selected || selected.semantic !== 'negative') {
    return elements;
  }
  if (policy.negativeFollowup.reasons.length > 0) {
    elements.push({
      tag: 'column_set', element_id: 'botmux_feedback_reasons', flex_mode: 'none', horizontal_spacing: 'small',
      columns: policy.negativeFollowup.reasons.map(reason => ({ tag: 'column', width: 'auto', elements: [button(state.reasonKey === reason.key ? `✓ ${reason.label}` : reason.label, state.reasonKey === reason.key ? 'primary' : 'default', { action: 'feedback_reason', reason_key: reason.key })] })),
    });
  }
  if (policy.negativeFollowup.comment.enabled) {
    if (state.comment !== undefined) elements.push({ tag: 'markdown', element_id: 'botmux_feedback_comment_done', content: '已补充说明' });
    else elements.push({
      tag: 'form', name: 'feedback_comment_form', element_id: 'botmux_feedback_comment', elements: [
        { tag: 'input', name: 'comment', input_type: 'multiline_text', rows: 3, max_rows: 8, auto_resize: true, width: 'fill', required: policy.negativeFollowup.comment.required, placeholder: { tag: 'plain_text', content: policy.negativeFollowup.comment.placeholder } },
        { tag: 'button', name: 'feedback_comment_submit', text: { tag: 'plain_text', content: '提交补充' }, type: 'primary', action_type: 'form_submit', value: { action: 'feedback_comment' } },
      ],
    });
  }
  if (!policy.negativeFollowup.comment.enabled && policy.negativeFollowup.reasons.length === 0) return elements;
  return elements;
}

const FEEDBACK_ELEMENT_IDS = new Set([
  'botmux_feedback',
  'botmux_feedback_status',
  'botmux_feedback_reasons',
  'botmux_feedback_comment',
  'botmux_feedback_comment_done',
]);

export function renderFeedbackCard(baseCard: Record<string, any>, policy: FeedbackPolicy, state: FeedbackCardState = {}): Record<string, unknown> {
  const card = structuredClone(baseCard);
  const elements: Record<string, unknown>[] = card.body?.elements ?? [];
  const feedbackIndex = elements.findIndex((element: any) => element.element_id === 'botmux_feedback');
  if (feedbackIndex < 0) return card;
  let end = feedbackIndex + 1;
  while (end < elements.length && FEEDBACK_ELEMENT_IDS.has(String((elements[end] as any)?.element_id ?? ''))) end++;
  elements.splice(feedbackIndex, end - feedbackIndex, ...feedbackStateElements(policy, state));
  card.body.elements = elements;
  return card;
}

function callbackKey(input: Record<string, unknown>): string { return createHash('sha256').update(JSON.stringify(input)).digest('hex'); }

export async function handleSkillFeedbackCardAction(data: CardActionData, larkAppId: string, deps: {
  store: SkillFeedbackStore;
  loadBaseCard?: (platformMessageId: string) => Promise<Record<string, unknown> | undefined>;
}): Promise<any> {
  const platformMessageId = data.context?.open_message_id;
  const verifiedOperator = await resolveCardOperatorUnionId(data, larkAppId);
  const operatorOpenId = verifiedOperator.openId?.startsWith('ou_') ? verifiedOperator.openId : undefined;
  const action = data.action?.value?.action;
  if (!platformMessageId || !action) return { toast: { type: 'error', content: '无法验证反馈来源，请重试' } };
  const delivery = deps.store.findDeliveryByPlatformMessage('lark', larkAppId, platformMessageId);
  if (!delivery?.policy || !delivery.baseCard) return { toast: { type: 'error', content: '反馈目标不存在或已失效' } };
  let baseCard = delivery.baseCard;
  try { baseCard = await deps.loadBaseCard?.(platformMessageId) ?? baseCard; }
  catch { /* platform fetch is best-effort; the content-free template remains usable */ }
  const operatorSubjectId = delivery.requesterSubjectId === operatorOpenId
    ? operatorOpenId
    : verifiedOperator.unionId ?? (data.operator?.union_id === undefined ? operatorOpenId : undefined);
  if (!operatorSubjectId) return { toast: { type: 'error', content: '无法验证反馈来源，请重试' } };
  if (delivery.requesterSubjectId && delivery.requesterSubjectId !== operatorSubjectId && delivery.requesterSubjectId !== operatorOpenId) return { toast: { type: 'error', content: '仅本次提问者可反馈' } };

  const previous = deps.store.getLatestFeedback(delivery.deliveryId, operatorSubjectId);
  if (previous && !delivery.policy.allowReselect && action === 'feedback_submit') {
    return { card: { type: 'raw', data: renderFeedbackCard(baseCard, delivery.policy, previous) } };
  }
  let result: string;
  let reasonKey: string | undefined;
  let comment: string | undefined;
  if (action === 'feedback_submit') {
    result = data.action?.value?.result ?? '';
    if (!delivery.policy.buttons.some(item => item.key === result)) return { toast: { type: 'error', content: '反馈选项无效，请重试' } };
  } else if (action === 'feedback_reason') {
    if (!previous) return { toast: { type: 'error', content: '请先选择反馈' } };
    const selected = delivery.policy.buttons.find(item => item.key === previous.result);
    if (selected?.semantic !== 'negative') return { toast: { type: 'error', content: '当前反馈不支持补充原因' } };
    reasonKey = data.action?.value?.reason_key;
    if (!reasonKey || !delivery.policy.negativeFollowup.reasons.some(reason => reason.key === reasonKey)) return { toast: { type: 'error', content: '反馈原因无效，请重试' } };
    result = previous.result;
    comment = previous.comment;
  } else if (action === 'feedback_comment') {
    if (!previous) return { toast: { type: 'error', content: '请先选择反馈' } };
    const selected = delivery.policy.buttons.find(item => item.key === previous.result);
    const config = delivery.policy.negativeFollowup.comment;
    if (selected?.semantic !== 'negative' || !config.enabled) return { toast: { type: 'error', content: '当前反馈不支持补充说明' } };
    const raw = data.action?.form_value?.comment;
    if (raw !== undefined && typeof raw !== 'string') return { toast: { type: 'warning', content: '补充说明格式无效' } };
    comment = (raw ?? '').trim();
    if (config.required && !comment) return { toast: { type: 'warning', content: '请填写补充说明' } };
    if (comment.length > config.maxLength) return { toast: { type: 'warning', content: `补充说明不能超过 ${config.maxLength} 字` } };
    result = previous.result;
    reasonKey = previous.reasonKey;
  } else {
    return { toast: { type: 'error', content: '反馈操作无效，请重试' } };
  }
  const selectedButton = delivery.policy.buttons.find(item => item.key === result);
  const recorded = deps.store.recordFeedback({
    platform: 'lark', platformAppId: larkAppId, platformMessageId, operatorSubjectId, result, semantic: selectedButton?.semantic, reasonKey, comment,
    callbackKey: callbackKey({
      platformMessageId, operatorSubjectId, action, result, reasonKey, comment,
      previousFeedbackId: previous?.feedbackId,
    }),
  });
  const renderedCard = renderFeedbackCard(baseCard, delivery.policy, recorded.feedback);
  if (action === 'feedback_submit' && delivery.policy.buttons.find(option => option.key === result)?.semantic === 'negative') {
    return { deferredCard: { type: 'raw', data: renderedCard } };
  }
  return { card: { type: 'raw', data: renderedCard } };
}
