import type { PendingAsk } from '../../core/ask-types.js';
import { ASK_CUSTOM_MAX_LENGTH } from '../../core/ask-custom-input.js';
import { t, type Locale } from '../../i18n/index.js';

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
  ask.questions.forEach((q, i) => {
    elements.push({ tag: 'markdown', content: `**${t('card.ask.question_n', { n: i + 1 }, locale)}**\n${prompt(q.prompt)}` });
    const customSelected = ask.customAnswers?.[i] != null;
    const selected = new Set(customSelected ? [] : ask.selections?.[i]);
    const mark = (on: boolean) => q.multiSelect ? (on ? '☑' : '☐') : (on ? '◉' : '○');
    const buttons = q.options.map((o, j) => button(`${mark(selected.has(o.key))} ${o.label}`,
      `option_${i}_${j}`, { action: 'ask_toggle', question_index: String(i), key: o.key }, selected.has(o.key) ? 'primary' : 'default'));
    // A column stacks its children vertically. One container per question
    // preserves one option per line without multiplying Feishu card elements.
    if (buttons.length) elements.push({ tag: 'column_set', flex_mode: 'none', columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: buttons },
    ] });
    if (q.allowCustom !== false) {
      const input = { tag: 'input', name: `custom_${i}`, width: 'fill',
        max_length: ASK_CUSTOM_MAX_LENGTH, default_value: ask.customAnswers?.[i] ?? '',
        placeholder: { tag: 'plain_text', content: t('card.ask.custom_input_hint', undefined, locale) },
      };
      if (q.inputMode === 'text') elements.push(input);
      else elements.push({ tag: 'column_set', flex_mode: 'none', columns: [
        { tag: 'column', width: 'auto', vertical_align: 'center', elements: [button(
          `${mark(customSelected)} ${t('card.ask.custom_input', undefined, locale)}`, `custom_option_${i}`,
          { action: 'ask_toggle', question_index: String(i), custom_choice: 'true' }, customSelected ? 'primary' : 'default')] },
        { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [input] },
      ] });
    }
  });
  if (confirmEmpty) elements.push({ tag: 'markdown', content: t('card.ask.empty_warning', undefined, locale) });
  elements.push(button(t(confirmEmpty ? 'card.ask.submit_confirm_empty' : 'card.ask.submit', undefined, locale), 'submit_answers', {
    action: 'ask_submit', ...(confirmEmpty ? { confirm_empty: 'true' } : {}),
  }, confirmEmpty ? 'danger' : 'primary'));
  return { tag: 'form', name: `ask_${ask.askId.replace(/[^a-zA-Z0-9_]/g, '_')}`, elements };
}
