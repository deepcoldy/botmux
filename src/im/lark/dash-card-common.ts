/**
 * Shared plumbing for the `/dash` card family (overview, sessions, schedules,
 * groups, settings, group-sessions). A dependency-free leaf: every dash card
 * can import it without the circular overview ↔ sub-card import that used to
 * force each file to keep its own copy of these helpers and constants.
 */
import { type Locale, t } from '../../i18n/index.js';

/** Action every sub-card's "back to overview" button emits. card-handler
 *  routes by action prefix, so dispatch lands on the overview handler
 *  regardless of which sub-card emitted it. */
export const BACK_TO_OVERVIEW_ACTION = 'dash_overview_refresh' as const;

/** Default page size for standalone and overview-drilldown list cards. */
export const DASH_PAGE_SIZE = 5;

/** Hard cap on `select_static` option count for the "jump to page" picker.
 *  Lark caps select options around this; we also keep payload small. Above
 *  the cap we fall back to prev/next only. */
export const JUMP_PAGE_MAX_OPTIONS = 50;

/** Result of a dash card action handler. Success paths return ONLY a `card`
 *  (a toast + card pair renders in two passes and flashes the old state);
 *  errors, permission denials and no-ops return a toast. */
export interface DashCardHandlerResult {
  toast?: { type: 'info' | 'success' | 'error'; content: string };
  card?: { type: 'raw'; data: Record<string, unknown> };
}

export function ackToast(textKey: string, locale: Locale): DashCardHandlerResult {
  return { toast: { type: 'info', content: t(textKey, undefined, locale) } };
}

export function errorToast(
  textKey: string,
  params: Record<string, string> | undefined,
  locale: Locale,
): DashCardHandlerResult {
  return { toast: { type: 'error', content: t(textKey, params, locale) } };
}

/**
 * Escape user-controlled text (session titles, cwd, filenames…) before it is
 * interpolated into lark_md. Both flow into a span we wrap with `<font>`;
 * without escaping, a payload containing `</font><at id=ou_x></at>` would close
 * our wrapper and inject a @mention-looking element. We also need to handle
 * `*_~\``-style markdown controls so plain filenames don't render as
 * bold/italic. Backslash is escaped in the same pass: otherwise an input like
 * `\*` turns into `\\*`, where the user's backslash cancels ours and the `*`
 * is live markdown again.
 *
 * Order matters: escape `&` FIRST so a later `<` → `&lt;` doesn't get
 * re-encoded as `&amp;lt;`.
 */
export function escapeLarkMd(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\*_~`])/g, '\\$1');
}
