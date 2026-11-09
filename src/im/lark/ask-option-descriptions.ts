import type { AskQuestion } from '../../core/ask-types.js';
import { t, type Locale } from '../../i18n/index.js';

/** Option labels and descriptions are model-written text: a literal mention tag in them must
 *  never ping anyone (a bot target makes Feishu reject the whole card). Same rule on every card. */
export function escapeOptionText(text: string): string {
  return text.replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, '[mention]')
    .replace(/[\\`*_~[\]]/g, c => `\\${c}`)
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** At most `cap` UTF-16 units, never ending on half a surrogate pair. One cap is shared by every description,
 *  so when their emoji sit at different offsets some cut always lands mid-pair. */
export function capChars(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const head = text.slice(0, Math.max(0, cap));
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

/**
 * Markdown listing every described option as `**label**：description`. Entries are separated by a
 * blank line so a multi-line description does not run into the next option. `cap` limits each
 * description; a cut one ends with `…` and the block points at the full-text attachment.
 */
export function optionDescriptions(q: AskQuestion, locale: Locale | undefined, cap = Infinity): { content: string; truncated: boolean } | undefined {
  const described = q.options.filter(o => o.description);
  if (!described.length) return undefined;
  const notice = t('card.ask.descriptions_truncated', undefined, locale);
  if (cap <= 0) return { content: notice, truncated: true };
  const separator = locale === 'en' ? ': ' : '：';
  const truncated = described.some(o => o.description!.length > cap);
  const lines = described.map(o => {
    const text = o.description!.length > cap ? `${capChars(o.description!, cap)}…` : o.description!;
    return `**${escapeOptionText(o.label || o.key)}**${separator}${escapeOptionText(text)}`;
  });
  if (truncated) lines.push(notice);
  return { content: lines.join('\n\n'), truncated };
}
