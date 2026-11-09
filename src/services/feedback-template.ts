import type { FeedbackPolicy } from './feedback-policy.js';
import { buildFeedbackElement, renderFeedbackCard, type FeedbackCardState } from '../im/lark/skill-feedback-card.js';
import { feedbackExtensionId } from './feedback-extension-id.js';

type Slot = 'answerReference' | 'feedbackButtons' | 'feedbackDetails' | 'actionButtons' | 'status';
export interface FeedbackTemplate {
  id: string; version: number; title: string; theme: string; density: 'compact' | 'comfortable';
  elements: Array<{ slot: Slot; layout?: 'horizontal' | 'vertical'; content?: string } | { tag: 'markdown'; content: string; slot?: never }>;
}
const slots: Slot[] = ['answerReference', 'feedbackButtons', 'feedbackDetails', 'actionButtons', 'status'];

export function defaultFeedbackTemplate(): FeedbackTemplate {
  return { id: 'default', version: 1, title: '反馈', theme: 'blue', density: 'compact', elements: slots.map(slot => ({ slot })) };
}
export function validateFeedbackTemplate(input: unknown): FeedbackTemplate {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('feedback_template_invalid');
  const raw = input as FeedbackTemplate;
  if (Object.keys(raw).some(key => !['id', 'version', 'title', 'theme', 'density', 'elements'].includes(key))) throw new Error('feedback_template_unknown_field');
  feedbackExtensionId(raw.id, 'feedbackTemplate.id');
  if (!Number.isSafeInteger(raw.version) || raw.version < 1 || typeof raw.title !== 'string' || raw.title.length > 120
    || !['blue', 'green', 'red', 'orange', 'purple', 'grey', 'indigo', 'turquoise'].includes(raw.theme)
    || !['compact', 'comfortable'].includes(raw.density) || !Array.isArray(raw.elements) || raw.elements.length > 30) throw new Error('feedback_template_invalid');
  const seen = new Set<Slot>();
  for (const element of raw.elements) {
    if (!element || typeof element !== 'object') throw new Error('feedback_template_element_invalid');
    if (element.slot) {
      if (!slots.includes(element.slot) || seen.has(element.slot)
        || Object.keys(element).some(key => !['slot', 'layout', 'content'].includes(key))
        || (element.layout !== undefined && !['horizontal', 'vertical'].includes(element.layout))) throw new Error('feedback_template_slot_invalid');
      seen.add(element.slot);
      if (element.content !== undefined && (element.slot !== 'answerReference' || typeof element.content !== 'string'
        || element.content.length > 4000 || /<at[\s>]|!\[/.test(element.content)
        || /\{[^{}]*\}/.test(element.content.replace(/\{round\}|\{answerUrl\}/g, '')))) {
        throw new Error('feedback_template_reference_invalid');
      }
    } else if (!('tag' in element) || element.tag !== 'markdown' || typeof element.content !== 'string'
      || element.content.length > 4000 || /<at[\s>]|!\[/.test(element.content)
      || Object.keys(element).some(key => !['tag', 'content'].includes(key))) throw new Error('feedback_template_element_invalid');
  }
  if (slots.filter(slot => slot !== 'actionButtons' && slot !== 'answerReference').some(slot => !seen.has(slot))) throw new Error('feedback_template_slot_missing');
  if (Buffer.byteLength(JSON.stringify(raw)) > 20000) throw new Error('feedback_template_card_too_large');
  return structuredClone(raw);
}
function safePreview(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safePreview);
  if (!value || typeof value !== 'object') return value;
  const raw = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !['behaviors', 'value', 'action_type'].includes(key))
    .map(([key, child]) => [key, safePreview(child)]));
}
export function buildFeedbackSurface(input: {
  template: FeedbackTemplate; policy: FeedbackPolicy; round: number; answerUrl: string; preview: boolean;
  state?: FeedbackCardState; actions?: Array<{ id: string; label: string }>; status?: string;
}): Record<string, unknown> {
  const template = validateFeedbackTemplate(input.template);
  if (input.actions?.length && !template.elements.some(element => element.slot === 'actionButtons')) throw new Error('feedback_template_action_slot_missing');
  const url = new URL(input.answerUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('feedback_answer_url_invalid');
  const detailsCard = renderFeedbackCard({ schema: '2.0', body: { elements: [buildFeedbackElement(input.policy)] } }, input.policy, input.state);
  const details = (detailsCard.body as { elements: Record<string, unknown>[] }).elements;
  const elements: Record<string, unknown>[] = [];
  for (const element of template.elements) {
    if (!element.slot) { elements.push({ tag: 'markdown', content: element.content }); continue; }
    if (element.slot === 'answerReference') {
      const content = element.content === undefined ? '第 {round} 轮 · [答复]({answerUrl})' : element.content;
      const rendered = content.replace(/\{round\}|\{answerUrl\}/g, placeholder => placeholder === '{round}'
        ? String(input.round) : url.href.replace(/\(/g, '%28').replace(/\)/g, '%29'));
      if (rendered.trim()) elements.push({ tag: 'markdown', content: rendered });
    }
    if (element.slot === 'feedbackButtons') {
      const buttons = structuredClone(details[0]);
      if (element.layout === 'vertical') {
        for (const column of buttons.columns as Array<Record<string, unknown>>) column.width = 'weighted';
        buttons.flex_mode = 'none';
        const columns = buttons.columns as Array<{ elements: Record<string, unknown>[] }>;
        elements.push({ tag: 'column_set', element_id: 'botmux_feedback', columns: [{ tag: 'column', width: 'weighted', weight: 1,
          elements: columns.flatMap(column => column.elements).map(button => ({ ...button, width: 'fill' })) }] });
      } else elements.push(buttons);
    }
    if (element.slot === 'feedbackDetails') elements.push(...details.slice(1));
    if (element.slot === 'actionButtons') for (const action of input.actions ?? []) {
      elements.push({ tag: 'button', text: { tag: 'plain_text', content: action.label }, type: 'default',
        behaviors: [{ type: 'callback', value: { action: 'feedback_custom_action', action_id: action.id } }] });
    }
    if (element.slot === 'status') elements.push({ tag: 'markdown', content: (input.status ?? '').replace(/[<>&]/g, '') || ' ' });
  }
  const card = { schema: '2.0', header: { title: { tag: 'plain_text', content: template.title }, template: template.theme },
    body: { padding: template.density === 'compact' ? '8px' : '16px', elements } };
  if (Buffer.byteLength(JSON.stringify(card)) > 28000) throw new Error('feedback_template_card_too_large');
  return (input.preview ? safePreview(card) : card) as Record<string, unknown>;
}
