import { getDefaultLocale, type Locale } from '../i18n/index.js';

/**
 * How an answer that is one string per question carries the note written next to its ticked
 * options: 「家人 (推荐)；备注：带一只狗」 / "Family; note: bring a dog". Without a note the
 * answer is unchanged; with no options the note alone is the answer.
 */
export function answerWithNote(answer: string, note: string | null | undefined, locale: Locale = getDefaultLocale()): string {
  const text = note?.trim();
  if (!text) return answer;
  return answer ? `${answer}${locale === 'en' ? '; note: ' : '；备注：'}${text}` : text;
}

/** The note as one more entry of an answer list (hosts whose answer is a list of strings). */
export function noteEntry(note: string, locale: Locale = getDefaultLocale()): string {
  return `${locale === 'en' ? 'note: ' : '备注：'}${note.trim()}`;
}
