/**
 * Display-name helpers for live /adopt entries: herdr pane / tab / workspace
 * names, Claude terminal titles, TraeX native titles and first prompts. Pure and
 * dependency-free so session discovery, the picker's live enrichment and the
 * picker card clean, cap and group them the same way.
 */

/** Same cap as resume (history) entry titles. */
export const LIVE_TITLE_MAX = 80;
/** Cap for the shared tab-name prefix of a `<tab> · <part>` title. */
const LIVE_TITLE_PREFIX_MAX = 30;
const LIVE_TITLE_JOINER = ' · ';

/** One line, no control characters or `<` / `>` (no tag-like text reaches any
 * downstream surface), at most `max` code points with a trailing `…` when cut.
 * Cuts by code point so a surrogate pair is never split. Shared by every live
 * display name (herdr label / Claude terminal title / TraeX native title). */
export function cleanLiveAdoptTitle(raw: unknown, max = LIVE_TITLE_MAX): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  const chars = Array.from(text);
  return chars.length > max
    ? `${chars.slice(0, max - 1).join('')}…`
    : text;
}

/** `<prefix> · <part>` for entries that share one herdr tab. The prefix is cut
 * to 30 code points first and the part gets the rest of the 80, so however long
 * the shared tab name is, the part that tells the entries apart stays visible. */
export function joinLiveTitle(prefix: string, part: string): string {
  const head = cleanLiveAdoptTitle(prefix, LIVE_TITLE_PREFIX_MAX) ?? '';
  const room = LIVE_TITLE_MAX - Array.from(head).length - LIVE_TITLE_JOINER.length;
  return `${head}${LIVE_TITLE_JOINER}${cleanLiveAdoptTitle(part, room) ?? ''}`;
}

interface HerdrTabRef {
  source?: string;
  herdrSessionName?: string;
  herdrTabId?: string;
}

/** Group key of a live herdr entry's tab. Herdr ids are scoped per server
 * session (`default` and `botmux` can both have `w1:t1`), so the key is
 * `(session, tab id)`; an entry without a tab id never joins a group. */
export function herdrTabGroupKey(s: HerdrTabRef): string | undefined {
  return s.source === 'herdr' && s.herdrSessionName && s.herdrTabId
    ? `${s.herdrSessionName}\0${s.herdrTabId}`
    : undefined;
}

/** How many of `sessions` sit in each herdr tab. Count over exactly the list
 * the card renders (this bot's CLI, owned panes already excluded); entries of
 * other backends carry no herdr fields and are skipped. */
export function countHerdrTabGroups(sessions: readonly object[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    const key = herdrTabGroupKey(s as HerdrTabRef);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
