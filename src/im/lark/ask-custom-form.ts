import type { PendingAsk } from '../../core/ask-types.js';
import { ASK_CUSTOM_MAX_LENGTH } from '../../core/ask-custom-input.js';
import { t, type Locale } from '../../i18n/index.js';
import { askOptionLayoutForBot } from './ask-option-layout.js';

/** Card JSON 2.0 form: every button submits the entire draft, so changing one
 * question cannot erase text typed in another. No select_static controls. */
export function buildAskCustomForm(ask: PendingAsk, locale: Locale, confirmEmpty = false,
  prompt: (text: string) => string = text => text.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];
  const button = (label: string, name: string, value: Record<string, string>, type = 'default') => ({
    tag: 'button', name, text: { tag: 'plain_text', content: label }, type, action_type: 'form_submit',
    value: { ...value, ask_id: ask.askId, nonce: ask.nonce, custom_form: 'v1', revision: String(ask.customRevision ?? 0) },
  });
  const vertical = askOptionLayoutForBot(ask.larkAppId) === 'vertical';
  ask.questions.forEach((q, i) => {
    elements.push({ tag: 'markdown', content: `**${t('card.ask.question_n', { n: i + 1 }, locale)}**\n${prompt(q.prompt)}` });
    const selected = new Set(ask.customAnswers?.[i] ? [] : ask.selections?.[i]);
    const buttons = q.options.map((o, j) => button(`${selected.has(o.key) ? '✓ ' : ''}${o.label}`,
      `option_${i}_${j}`, { action: 'ask_toggle', question_index: String(i), key: o.key }, selected.has(o.key) ? 'primary' : 'default'));
    const perRow = vertical ? 1 : 3;
    for (let start = 0; start < buttons.length; start += perRow) {
      elements.push({ tag: 'column_set', flex_mode: vertical ? 'none' : 'flow', columns: buttons.slice(start, start + perRow).map(b => ({
        tag: 'column', width: vertical ? 'weighted' : 'auto', ...(vertical ? { weight: 1 } : {}), elements: [b],
      })) });
    }
    if (q.allowCustom !== false) elements.push({
      tag: 'input', name: `custom_${i}`, input_type: 'multiline_text', width: 'fill',
      max_length: ASK_CUSTOM_MAX_LENGTH, default_value: ask.customAnswers?.[i] ?? '',
      label: { tag: 'plain_text', content: t('card.ask.custom_input', undefined, locale) },
      placeholder: { tag: 'plain_text', content: t('card.ask.custom_input_hint', undefined, locale) },
    });
    elements.push({ tag: 'hr' });
  });
  if (confirmEmpty) elements.push({ tag: 'markdown', content: t('card.ask.empty_warning', undefined, locale) });
  elements.push(button(t(confirmEmpty ? 'card.ask.submit_confirm_empty' : 'card.ask.submit', undefined, locale), 'submit_answers', {
    action: 'ask_submit', ...(confirmEmpty ? { confirm_empty: 'true' } : {}),
  }, confirmEmpty ? 'danger' : 'primary'));
  return { tag: 'form', name: `ask_${ask.askId.replace(/[^a-zA-Z0-9_]/g, '_')}`, elements };
}
