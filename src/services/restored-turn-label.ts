import { t, type Locale } from '../i18n/index.js';

/** Which turn a reply recovered after a restart answers. Presentation only. */
export interface RestoredTurnLabel {
  /** When the turn's input went into the CLI (the journaled mark time). */
  askedAtMs: number;
  /** The start of that input, single-line, bounded. */
  excerpt?: string;
}

const EXCERPT_MAX_CHARS = 30;

/** The label for a turn the transcript bridge restored from its journal: when
 *  its input went in and how it began, enough to tell it from the turns the
 *  conversation has had since. */
export function restoredTurnLabel(turn: { markTimeMs?: number; contentNormalized?: string }): RestoredTurnLabel | undefined {
  if (turn.markTimeMs === undefined || !Number.isFinite(turn.markTimeMs)) return undefined;
  const text = (turn.contentNormalized ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  const excerpt = chars.length > EXCERPT_MAX_CHARS ? `${chars.slice(0, EXCERPT_MAX_CHARS).join('')}…` : text;
  return { askedAtMs: turn.markTimeMs, ...(excerpt ? { excerpt } : {}) };
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** The note above a recovered reply, in card markdown. The excerpt is the
 *  user's own text: it is shown literally, never as markup or a mention. */
export function restoredTurnNotice(label: RestoredTurnLabel, locale: Locale): string {
  const at = new Date(label.askedAtMs);
  const time = `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (!label.excerpt) return t('card.restored_turn_notice_no_excerpt', { time }, locale);
  const excerpt = label.excerpt
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\*_~`[\]#|])/g, '\\$1');
  return t('card.restored_turn_notice', { time, excerpt }, locale);
}
