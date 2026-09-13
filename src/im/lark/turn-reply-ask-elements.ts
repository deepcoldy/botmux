import type { ReplyCardAsk } from '../../services/turn-reply-card.js';
import { t, type Locale } from '../../i18n/index.js';

const safe = (text: string) => text.replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, '[mention]')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Same broker actions as the standalone Ask card, expressed as Card JSON 2.0. */
export function buildTurnReplyAskElements(entry: ReplyCardAsk, locale: Locale = 'zh'): Array<Record<string, any>> {
  const { ask } = entry;
  const submit = ask.questions.length > 1 || ask.questions.some(q => q.multiSelect);
  const elements: Array<Record<string, any>> = [];
  const button = (label: string, value: Record<string, string>, type = 'default') => ({
    tag: 'button', text: { tag: 'plain_text', content: label }, type,
    behaviors: [{ type: 'callback', value: { ...value, ask_id: ask.askId, nonce: ask.nonce } }],
  });
  const row = (buttons: Array<Record<string, any>>) => ({ tag: 'column_set', flex_mode: 'flow', columns: buttons.map(b => ({
    tag: 'column', width: 'auto', elements: [b],
  })) });
  ask.questions.forEach((q, i) => {
    elements.push({ tag: 'markdown', content: safe(q.prompt) });
    const selected = new Set(ask.selections?.[i] ?? []);
    const buttons = q.options.map(option => ({
      ...button(option.label,
        { action: submit ? 'ask_toggle' : 'ask_select', key: option.key, question_index: String(i) },
        selected.has(option.key) ? 'primary' : 'default',
      ),
      ...(submit ? { icon: { tag: 'standard_icon', token: selected.has(option.key) ? 'check_outlined' : 'rectangle_outlined' } } : {}),
    }));
    for (let start = 0; start < buttons.length; start += 3) elements.push(row(buttons.slice(start, start + 3)));
  });
  if (submit) {
    if (entry.confirmEmptyArmed) elements.push({ tag: 'markdown', content: t('card.ask.empty_warning', undefined, locale) });
    elements.push(row([button(t(entry.confirmEmptyArmed ? 'card.ask.submit_confirm_empty' : 'card.ask.submit', undefined, locale), {
      action: 'ask_submit', ...(entry.confirmEmptyArmed ? { confirm_empty: 'true' } : {}),
    }, entry.confirmEmptyArmed ? 'danger' : 'primary')]));
  }
  elements.push({ tag: 'markdown', text_size: 'notation', content: [
    t('card.ask.custom_reply_hint', undefined, locale),
    `${t('card.ask.field.deadline', undefined, locale)}: ${new Date(ask.deadlineAt).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN')}`,
    t('card.ask.answerable_talk_members', undefined, locale),
  ].join('\n') });
  return elements;
}

export function turnReplyAskSummary(entry: ReplyCardAsk, locale: Locale = 'zh'): string {
  const { ask, result } = entry;
  const lines = ask.questions.map((q, i) => {
    const labels = result?.kind === 'answered'
      ? result.answers[i]?.map(key => q.options.find(o => o.key === key)?.label ?? key).join(', ') : '';
    return `🙋 ${safe(q.prompt)}${labels ? `\n✓ ${safe(labels)}` : ''}`;
  });
  if (result?.kind === 'answered') {
    if (result.comment) lines.push(`💬 ${safe(result.comment)}`);
    else if (result.answers.every(keys => keys.length === 0)) lines.push(locale === 'en' ? '✓ No options selected' : '✓ 未选择任何选项');
  } else {
    lines.push(result?.kind === 'timedOut' ? t('card.ask.timed_out', undefined, locale)
      : result?.kind === 'invalidated' ? t('card.ask.invalidated', undefined, locale)
        : locale === 'en' ? 'Waiting for your response' : '等待你回答');
  }
  return lines.join('\n');
}
