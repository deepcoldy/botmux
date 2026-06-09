/**
 * Sessions list card (PR3 `/dashboard sessions` slice 1).
 *
 * Read-only list + pagination + refresh. NO close/restart/locate/open-terminal
 * buttons in this slice — those are slice 2 (sessions detail/actions). The
 * absence of action buttons here is intentional, see codex's scope-cut on
 * 2026-06-09: action callbacks introduce optimistic-state + rollback + race
 * conditions which we want to design separately, not bundle into the list.
 *
 * Identity / security:
 *  - `invokerOpenId` is the owner's `ou_*` and is the invoker-lock anchor.
 *  - sender union_id NEVER lands on `action.value` (red line).
 *  - Owner gate runs at the command entry AND on every callback.
 *
 * Response shape mirrors `/dashboard settings` slice 3: success path returns
 * ONLY `{ card }` (no toast) so Lark renders the card in a single pass
 * (toast + card would trigger a two-pass render and flash the stale list).
 */

import { getOwnerOpenId as defaultGetOwnerOpenId } from '../../bot-registry.js';
import type { SessionRowDto } from '../../dashboard/session-card-model.js';
import { composeEntries, sortByStatus, paginate } from '../../dashboard/session-card-model.js';
import type { DaemonClient } from '../../dashboard/daemon-internal-client.js';
import type { SessionRow } from '../../core/dashboard-rows.js';
import { type Locale, t } from '../../i18n/index.js';

import type { CardActionData } from './card-handler.js';

export const SESSIONS_ACTION_REFRESH = 'dash_sessions_refresh' as const;
export const SESSIONS_ACTION_PAGE = 'dash_sessions_page' as const;

const PAGE_SIZE = 10;

/** Mapping from `StatusDot.tone` to a stable colour-emoji prefix. Pure. */
function toneIcon(tone: string): string {
  switch (tone) {
    case 'success': return '🟢';
    case 'info':    return '🔵';
    case 'warning': return '🟡';
    case 'neutral': return '⚪';
    default:        return '⚫';
  }
}

export interface BuildSessionsCardOpts {
  invokerOpenId: string;
  locale: Locale;
  /** 1-based page index. Caller clamps; this just renders what's given. */
  page: number;
}

/** Build the sessions list card JSON from raw rows. Pure (composes + paginates). */
export function buildSessionsCard(
  rows: ReadonlyArray<SessionRow>,
  opts: BuildSessionsCardOpts,
  nowMs: number,
): string {
  const sorted = sortByStatus(composeEntries(rows, nowMs));
  const { items, meta } = paginate(sorted, opts.page, PAGE_SIZE);

  const activeCount = sorted.filter(e => e.status !== 'closed').length;
  const closedCount = sorted.length - activeCount;

  const elements: unknown[] = [];

  // Sub-header summary — counts + page indicator. Plain `div` markdown.
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: t(
        'card.dashboard.sessions.count_summary',
        {
          active: String(activeCount),
          closed: String(closedCount),
          page: String(meta.page),
          totalPages: String(meta.totalPages),
        },
        opts.locale,
      ),
    },
  });

  elements.push({ tag: 'hr' });

  if (items.length === 0) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: t('card.dashboard.sessions.empty', undefined, opts.locale),
      },
    });
  } else {
    for (const e of items) {
      elements.push(renderRow(e, opts.locale));
    }
  }

  elements.push({ tag: 'hr' });

  // Pagination + refresh — pagination row only if more than one page.
  const actions: unknown[] = [];
  if (meta.totalPages > 1) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.dashboard.sessions.prev', undefined, opts.locale) },
      type: 'default',
      disabled: meta.page <= 1,
      value: {
        action: SESSIONS_ACTION_PAGE,
        invoker_open_id: opts.invokerOpenId,
        page: String(Math.max(1, meta.page - 1)),
      },
    });
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.dashboard.sessions.next', undefined, opts.locale) },
      type: 'default',
      disabled: meta.page >= meta.totalPages,
      value: {
        action: SESSIONS_ACTION_PAGE,
        invoker_open_id: opts.invokerOpenId,
        page: String(Math.min(meta.totalPages, meta.page + 1)),
      },
    });
  }
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t('card.dashboard.sessions.refresh', undefined, opts.locale) },
    type: 'default',
    value: {
      action: SESSIONS_ACTION_REFRESH,
      invoker_open_id: opts.invokerOpenId,
    },
  });
  elements.push({ tag: 'action', actions });

  // Footer security note (matches /dashboard settings idiom).
  elements.push({
    tag: 'note',
    elements: [
      { tag: 'lark_md', content: t('card.dashboard.settings.footer.security', undefined, opts.locale) },
    ],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t('card.dashboard.sessions.title', undefined, opts.locale) },
      template: 'blue',
    },
    elements,
  });
}

function renderRow(entry: SessionRowDto, _locale: Locale): unknown {
  const icon = toneIcon(entry.dot.tone);
  // primary in bold; secondary on its own line in grey.
  // entry.primary is already truncated by composeEntries.
  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content:
        `${icon} **${escapeMd(entry.primary)}**` +
        (entry.secondary ? `\n<font color="grey">${escapeMd(entry.secondary)}</font>` : ''),
    },
  };
}

/** Minimal markdown-safe escape — protects `*`, `_`, `~`, `` ` `` from
 *  being interpreted as markup since session titles may contain anything. */
function escapeMd(text: string): string {
  return text.replace(/([*_~`])/g, '\\$1');
}

/** ─── Handler ─────────────────────────────────────────────────────────── */

export interface SessionsCardHandlerDeps {
  /** Override the per-bot owner lookup. Production omits and uses `bot-registry.getOwnerOpenId`. */
  getOwnerOpenId?: (larkAppId: string) => string | undefined;
  /** Factory returning a Route B client for the given larkAppId. */
  createClient: (larkAppId: string) => DaemonClient;
  /** Override locale resolution; production uses the caller-supplied locale. */
  locale?: Locale;
  /** Override `Date.now()` so tests are deterministic. */
  nowMs?: () => number;
}

export interface SessionsCardHandlerResult {
  /** Optional — success returns ONLY a `card` (single-pass render). Errors,
   *  permission denials still return a toast (no card to render). */
  toast?: { type: 'info' | 'success' | 'error'; content: string };
  card?: { type: 'raw'; data: Record<string, unknown> };
}

function ackToast(textKey: string, locale: Locale): SessionsCardHandlerResult {
  return { toast: { type: 'info', content: t(textKey, undefined, locale) } };
}

function errorToast(textKey: string, params: Record<string, string> | undefined, locale: Locale): SessionsCardHandlerResult {
  return { toast: { type: 'error', content: t(textKey, params, locale) } };
}

/**
 * Dispatch a `dash_sessions_*` action callback. Awaits the Route B GET
 * inline and returns the rebuilt card body in the SAME response.
 */
export async function handleSessionsCardAction(
  data: CardActionData,
  larkAppId: string,
  deps: SessionsCardHandlerDeps,
): Promise<SessionsCardHandlerResult> {
  const locale: Locale = deps.locale ?? 'zh';
  const value = (data.action?.value ?? {}) as Record<string, string>;
  const operatorOpenId = data.operator?.open_id;
  const action = value.action;

  // ─── 1) Invoker lock — fail-closed ──────────────────────────────────
  const invokerOpenId = value.invoker_open_id;
  if (typeof invokerOpenId !== 'string' || !invokerOpenId) {
    return ackToast('card.dashboard.settings.not_invoker', locale);
  }
  if (typeof operatorOpenId !== 'string' || !operatorOpenId) {
    return ackToast('card.dashboard.settings.not_invoker', locale);
  }
  if (invokerOpenId !== operatorOpenId) {
    return ackToast('card.dashboard.settings.not_invoker', locale);
  }

  // ─── 2) Per-bot owner gate ──────────────────────────────────────────
  const getOwnerOpenId = deps.getOwnerOpenId ?? defaultGetOwnerOpenId;
  const expectedOwner = getOwnerOpenId(larkAppId);
  if (!expectedOwner || operatorOpenId !== expectedOwner) {
    return ackToast('card.dashboard.settings.owner_only', locale);
  }

  // ─── 3) Resolve target page ─────────────────────────────────────────
  let page = 1;
  if (action === SESSIONS_ACTION_PAGE) {
    const parsed = Number.parseInt(value.page ?? '1', 10);
    if (Number.isFinite(parsed) && parsed >= 1) page = parsed;
  } else if (action !== SESSIONS_ACTION_REFRESH) {
    return ackToast('card.dashboard.settings.invalid_action', locale);
  }

  // ─── 4) GET list + rebuild card ─────────────────────────────────────
  try {
    const client = deps.createClient(larkAppId);
    const r = await client.request({ method: 'GET', path: '/__daemon/sessions-list' });
    const rows = ((r.body as { sessions?: ReadonlyArray<SessionRow> })?.sessions) ?? [];
    const nowMs = deps.nowMs ? deps.nowMs() : Date.now();
    const cardJson = buildSessionsCard(rows, { invokerOpenId: expectedOwner, locale, page }, nowMs);
    return {
      // Card-only success path — see settings-card.ts docblock for why no toast.
      card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> },
    };
  } catch (e) {
    return errorToast('card.dashboard.sessions.list_failed', { reason: (e as Error).message }, locale);
  }
}
