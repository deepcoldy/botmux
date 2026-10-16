import type { ReplyCardAsk } from '../../services/turn-reply-card.js';
import { t, type Locale } from '../../i18n/index.js';
import { askOptionLayoutForBot } from './ask-option-layout.js';

const safe = (text: string) => text.replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, '[mention]')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Same broker actions as the standalone Ask card, expressed as Card JSON 2.0. */
export function buildTurnReplyAskElements(entry: ReplyCardAsk, locale: Locale = 'zh'): Array<Record<string, any>> {
  const { ask } = entry;
  const textReplyRequired = ask.questions.some(q => q.inputMode === 'text');
  const submit = textReplyRequired || ask.questions.length > 1 || ask.questions.some(q => q.multiSelect || q.defaultSelectedKeys !== undefined);
  const elements: Array<Record<string, any>> = [];
  const button = (label: string, value: Record<string, string>, type = 'default') => ({
    tag: 'button', text: { tag: 'plain_text', content: label }, type,
    behaviors: [{ type: 'callback', value: { ...value, ask_id: ask.askId, nonce: ask.nonce } }],
  });
  const row = (buttons: Array<Record<string, any>>) => ({ tag: 'column_set', flex_mode: 'flow', columns: buttons.map(b => ({
    tag: 'column', width: 'auto', elements: [b],
  })) });
  // vertical：与独立卡同款的一行一按钮（单列 weighted、不被同排挤压）。内嵌形态是
  // Card JSON 2.0，字段形态与独立卡 1.0 不同，不能复用 appendActionRows。
  const verticalRow = (b: Record<string, any>) => ({
    tag: 'column_set', flex_mode: 'none', horizontal_spacing: 'small',
    columns: [{ tag: 'column', width: 'weighted', weight: 1, elements: [b] }],
  });
  const optionLayout = askOptionLayoutForBot(ask.larkAppId);
  ask.questions.forEach((q, i) => {
    // 显式 `botmux ask --mention` 的点名（daemon 已剔除 bot open_id）：嵌入
    // turn-reply 卡时同样要保留真实 <at>，不能走 safe()——safe 会把 at 抹成
    // [mention]，通知触达丢失。仅第一问前注入一次。
    const mentionPrefix = i === 0 && ask.mentionedOpenId
      ? `<at id=${ask.mentionedOpenId}></at>\n`
      : '';
    const prompt = textReplyRequired && q.options.length
      ? `${q.prompt}\n\n${q.options.map(o => o.label).join(' / ')}` : q.prompt;
    elements.push({ tag: 'markdown', content: `${mentionPrefix}${safe(prompt)}` });
    if (textReplyRequired) return; // Keep the batch intact; answer it with one text reply.

    const selected = new Set(ask.selections?.[i] ?? []);
    const buttons = q.options.map(option => ({
      ...button(option.label,
        { action: submit ? 'ask_toggle' : 'ask_select', key: option.key, question_index: String(i) },
        selected.has(option.key) ? 'primary' : 'default',
      ),
      ...(submit ? { icon: { tag: 'standard_icon', token: selected.has(option.key) ? 'check_outlined' : 'rectangle_outlined' } } : {}),
    }));
    if (optionLayout === 'vertical') {
      for (const b of buttons) elements.push(verticalRow(b));
    } else {
      for (let start = 0; start < buttons.length; start += 3) elements.push(row(buttons.slice(start, start + 3)));
    }
    // 选项详细说明（Claude Code AskUserQuestion options[].description）：按钮无副标题，
    // 在按钮行下用小字列出。safe() 已做转义，这里仅按 label 加粗。缺省不渲染。
    const described = q.options.filter(option => option.description?.trim());
    if (described.length) {
      elements.push({
        tag: 'markdown',
        text_size: 'notation',
        content: described.map(option => `**${safe(option.label)}**：${safe(option.description!.trim())}`).join('\n'),
      });
    }
  });
  if (submit && !textReplyRequired) {
    if (entry.confirmEmptyArmed) elements.push({ tag: 'markdown', content: t('card.ask.empty_warning', undefined, locale) });
    elements.push(row([button(t(entry.confirmEmptyArmed ? 'card.ask.submit_confirm_empty' : 'card.ask.submit', undefined, locale), {
      action: 'ask_submit', ...(entry.confirmEmptyArmed ? { confirm_empty: 'true' } : {}),
    }, entry.confirmEmptyArmed ? 'danger' : 'primary')]));
  }
  elements.push({ tag: 'markdown', text_size: 'notation', content: [
    t(textReplyRequired ? 'card.ask.text_reply_hint' : 'card.ask.custom_reply_hint', undefined, locale),
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
