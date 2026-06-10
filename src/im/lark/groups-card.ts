/**
 * Groups list card (PR3 `/dashboard groups` slice 1).
 *
 * Read-only matrix list + pagination + refresh. NO leave / add-bots /
 * oncall bind/unbind / disband / detail / search / filter in this slice.
 * Codex scope-cut on 2026-06-09: those need an action-state pattern
 * (optimistic-state + rollback) plus filter UI design which we'll land in
 * later slices.
 *
 * Per-bot scope: the Route B groups-matrix endpoint filters bots to ONLY
 * the caller's bot AND chats to ones where the caller is `inChat=true`,
 * with each retained chat's `memberBots` trimmed to the caller's single
 * entry (no roster leakage of other bots). With that scoping the matrix
 * has exactly ONE column — this card renders a single-column list.
 *
 * Identity / security mirrors sessions-card.ts (slice 1):
 *  - `invokerOpenId` is the owner's `ou_*` (invoker-lock anchor).
 *  - Owner gate runs at the command entry AND on every callback.
 *  - sender union_id NEVER lands on action.value.
 *
 * Response: success returns `{ card }` only (no toast) — single-pass render,
 * no stale-frame flash. Errors / permission denials return `{ toast }`.
 *
 * Sort order: KEEP `buildGroupRows` output order verbatim — the PR1 model
 * owns the canonical ordering; resorting in the card would silently diverge.
 */

import { getOwnerOpenId as defaultGetOwnerOpenId } from '../../bot-registry.js';
import type {
  GroupRowDto,
  GroupsBotInput,
  GroupsChatInput,
} from '../../dashboard/groups-card-model.js';
import { buildGroupRow } from '../../dashboard/groups-card-model.js';
import type { DaemonClient } from '../../dashboard/daemon-internal-client.js';
import { type Locale, t } from '../../i18n/index.js';

import type { CardActionData } from './card-handler.js';

export const GROUPS_ACTION_REFRESH = 'dash_groups_refresh' as const;
export const GROUPS_ACTION_PAGE = 'dash_groups_page' as const;
/** Action emitted by the "🔙 返回总览" button on overview-origin sub-cards.
 *  Same string as overview-card's OVERVIEW_ACTION_REFRESH (avoids a circular
 *  import). card-handler routes by action prefix, so dispatch lands on the
 *  overview handler regardless of which sub-card emitted it. */
const BACK_TO_OVERVIEW_ACTION = 'dash_overview_refresh' as const;

/** Default page size for `/dashboard groups` — unified at 5/page across
 *  all dashboard list cards on user request 2026-06-10. */
const PAGE_SIZE = 5;

/** Hard cap on `select_static` option count for the "jump to page" picker.
 *  Lark caps select options around this; we also keep payload small. Above
 *  the cap we fall back to prev/next only. */
const JUMP_PAGE_MAX_OPTIONS = 50;

/** Mapping from coverage status to a stable colour-emoji prefix. Pure. */
function statusIcon(status: string): string {
  switch (status) {
    case 'in':      return '🟢';
    case 'out':     return '⚪';
    case 'unknown': return '🟡';
    case 'error':   return '🔴';
    default:        return '⚫';
  }
}

/** Translate coverage status to its localized label. */
function statusLabel(status: string, locale: Locale): string {
  switch (status) {
    case 'in':      return t('card.dashboard.groups.status.in', undefined, locale);
    case 'out':     return t('card.dashboard.groups.status.out', undefined, locale);
    case 'unknown': return t('card.dashboard.groups.status.unknown', undefined, locale);
    case 'error':   return t('card.dashboard.groups.status.error', undefined, locale);
    default:        return status;
  }
}

export interface BuildGroupsCardOpts {
  invokerOpenId: string;
  locale: Locale;
  /** 1-based page index. Caller clamps; this just renders what's given. */
  page: number;
  /** Page size override. Omit → PAGE_SIZE (5; unified for standalone and
   *  drilldown 2026-06-10). Override only when a caller needs a different
   *  size. Threaded through every button.value so the size persists across
   *  page/refresh round-trips. */
  pageSize?: number;
  /** Navigation origin. `'overview'` means this card was opened via
   *  `/dashboard overview` → goto groups; the footer renders an extra
   *  "🔙 返回总览" button, and every button.value carries `origin=overview`
   *  to keep that affordance across rebuilds. Undefined → standalone card,
   *  no overview link. */
  origin?: 'overview';
}

/** Build the groups list card JSON. Pure (composes + paginates + renders).
 *  Single-column matrix (post-scoping). PR1 model owns the sort. */
export function buildGroupsCard(
  matrix: { chats: ReadonlyArray<GroupsChatInput>; bots: ReadonlyArray<GroupsBotInput> },
  opts: BuildGroupsCardOpts,
): string {
  const effectivePageSize =
    typeof opts.pageSize === 'number' && Number.isFinite(opts.pageSize) && opts.pageSize > 0
      ? Math.floor(opts.pageSize)
      : PAGE_SIZE;

  // Project EVERY chat into a row DTO ourselves rather than going through
  // `buildGroupRows`, because the pipeline helper also paginates (default
  // pageSize=20) which would silently clip past the 10-per-page card layout.
  // The matrix is already scoped to caller's single bot upstream, so the
  // projection cost is negligible. PR1 model owns the canonical sort — we
  // walk `matrix.chats` verbatim, no client re-sort.
  const allRows: GroupRowDto[] = matrix.chats.map(c => buildGroupRow(c, matrix.bots));

  // Header counts before pagination.
  const total = allRows.length;
  const joined = allRows.reduce(
    (n, r) => (r.coverage[0]?.status === 'in' ? n + 1 : n),
    0,
  );
  const missing = total - joined;

  // Paginate the DTO list (mirror paginateGroups semantics on the projected rows).
  const totalPages = Math.max(1, Math.ceil(total / effectivePageSize));
  let activePage = Number.isFinite(opts.page) ? Math.floor(opts.page) : 1;
  if (activePage < 1) activePage = 1;
  if (activePage > totalPages) activePage = totalPages;
  const start = (activePage - 1) * effectivePageSize;
  const pageItems = allRows.slice(start, start + effectivePageSize);

  // Plumb origin + page_size into every button.value so refresh/page rebuilds
  // keep the same drilldown state. Empty values are omitted so standalone
  // cards stay byte-identical to before this change.
  const navFields: Record<string, string> = {};
  if (opts.origin === 'overview') navFields.origin = 'overview';
  if (effectivePageSize !== PAGE_SIZE) navFields.page_size = String(effectivePageSize);

  const elements: unknown[] = [];

  // Sub-header — counts + page indicator.
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: t(
        'card.dashboard.groups.count_summary',
        {
          total: String(total),
          joined: String(joined),
          missing: String(missing),
          page: String(activePage),
          totalPages: String(totalPages),
        },
        opts.locale,
      ),
    },
  });

  elements.push({ tag: 'hr' });

  if (pageItems.length === 0) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: t('card.dashboard.groups.empty', undefined, opts.locale),
      },
    });
  } else {
    for (const row of pageItems) {
      elements.push(renderRow(row, opts.locale));
    }
  }

  elements.push({ tag: 'hr' });

  // Pagination + refresh.
  const actions: unknown[] = [];
  if (totalPages > 1) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.dashboard.groups.prev', undefined, opts.locale) },
      type: 'default',
      disabled: activePage <= 1,
      value: {
        action: GROUPS_ACTION_PAGE,
        invoker_open_id: opts.invokerOpenId,
        page: String(Math.max(1, activePage - 1)),
        ...navFields,
      },
    });
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.dashboard.groups.next', undefined, opts.locale) },
      type: 'default',
      disabled: activePage >= totalPages,
      value: {
        action: GROUPS_ACTION_PAGE,
        invoker_open_id: opts.invokerOpenId,
        page: String(Math.min(totalPages, activePage + 1)),
        ...navFields,
      },
    });
    // "Jump to page" select — same action as prev/next, page comes via
    // action.option instead of value.page. Handler reads `value.page ??
    // action.option ?? '1'` so both paths converge on one branch. Capped at
    // JUMP_PAGE_MAX_OPTIONS to keep payload small / inside Lark's option
    // limit (above the cap, prev/next still works).
    if (totalPages > 2 && totalPages <= JUMP_PAGE_MAX_OPTIONS) {
      const options = Array.from({ length: totalPages }, (_, i) => {
        const n = i + 1;
        return {
          text: { tag: 'plain_text', content: t('card.dashboard.groups.jump_page', { n: String(n) }, opts.locale) },
          value: String(n),
        };
      });
      actions.push({
        tag: 'select_static',
        placeholder: {
          tag: 'plain_text',
          content: t('card.dashboard.groups.jump_page', { n: String(activePage) }, opts.locale),
        },
        initial_option: String(activePage),
        options,
        value: {
          action: GROUPS_ACTION_PAGE,
          invoker_open_id: opts.invokerOpenId,
          ...navFields,
        },
      });
    }
  }
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t('card.dashboard.groups.refresh', undefined, opts.locale) },
    type: 'default',
    value: {
      action: GROUPS_ACTION_REFRESH,
      invoker_open_id: opts.invokerOpenId,
      ...navFields,
    },
  });
  // Overview drilldown only — "🔙 返回总览" reuses the overview-refresh
  // action; card-handler routes by action prefix, so dispatch lands on
  // overview-card.ts which rebuilds the parent card cleanly.
  if (opts.origin === 'overview') {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.dashboard.overview.back_button', undefined, opts.locale) },
      type: 'default',
      value: {
        action: BACK_TO_OVERVIEW_ACTION,
        invoker_open_id: opts.invokerOpenId,
      },
    });
  }
  elements.push({ tag: 'action', actions });

  elements.push({
    tag: 'note',
    elements: [
      { tag: 'lark_md', content: t('card.dashboard.settings.footer.security', undefined, opts.locale) },
    ],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t('card.dashboard.groups.title', undefined, opts.locale) },
      template: 'blue',
    },
    elements,
  });
}

function renderRow(row: GroupRowDto, locale: Locale): unknown {
  // Single-column matrix: coverage[0] is the caller bot.
  const cell = row.coverage[0];
  const status = cell?.status ?? 'unknown';
  const icon = statusIcon(status);

  // Primary: status icon + bold name (or unnamed fallback) + grey id suffix.
  const displayName = row.name && row.name !== row.chatId
    ? row.name
    : t('card.dashboard.groups.unnamed', undefined, locale);
  const idSuffix = row.chatIdSuffix
    ? ` <font color="grey">${escapeLarkMd(row.chatIdSuffix)}</font>`
    : '';

  // Secondary: 覆盖 status [· oncall workingDir=<dir>]
  // PR1 DTO drops `oncallChat` from list-row projection (it lives on the
  // detail DTO). For slice 1 we surface JUST the per-bot coverage label; the
  // oncall workingDir hook is the "if present" branch — when the upstream
  // helper ever threads oncallChat onto the list cell it'll auto-light up,
  // but today it's a no-op so we deliberately don't reach into
  // matrix.chats[*].memberBots[0].oncallChat from here (that'd be a layering
  // violation against the DTO contract).
  const secondaryParts: string[] = [
    t('card.dashboard.groups.coverage_label', { status: statusLabel(status, locale) }, locale),
  ];

  const secondary = `\n<font color="grey">${escapeLarkMd(secondaryParts.join(' · '))}</font>`;

  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content:
        `${icon} **${escapeLarkMd(displayName)}**${idSuffix}` + secondary,
    },
  };
}

/**
 * Sanitize chat name / chatIdSuffix / workingDir for lark_md inclusion.
 *
 * Chat names are user-controlled (group titles), chatIdSuffix is bot-supplied
 * but echoed near user content, and workingDir comes from the filesystem. All
 * three flow into a `<font color="grey">…</font>` wrapper; without escaping,
 * a payload like `</font><at id=ou_x></at>` would close our wrapper and
 * inject @mention-looking content. Order matters: `&` first so a later `<`
 * → `&lt;` doesn't get re-encoded as `&amp;lt;`.
 */
function escapeLarkMd(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_~`])/g, '\\$1');
}

/** ─── Handler ─────────────────────────────────────────────────────────── */

export interface GroupsCardHandlerDeps {
  getOwnerOpenId?: (larkAppId: string) => string | undefined;
  createClient: (larkAppId: string) => DaemonClient;
  locale?: Locale;
}

export interface GroupsCardHandlerResult {
  toast?: { type: 'info' | 'success' | 'error'; content: string };
  card?: { type: 'raw'; data: Record<string, unknown> };
}

function ackToast(textKey: string, locale: Locale): GroupsCardHandlerResult {
  return { toast: { type: 'info', content: t(textKey, undefined, locale) } };
}

function errorToast(
  textKey: string,
  params: Record<string, string> | undefined,
  locale: Locale,
): GroupsCardHandlerResult {
  return { toast: { type: 'error', content: t(textKey, params, locale) } };
}

/** Dispatch a `dash_groups_*` action callback. Mirrors sessions-card. */
export async function handleGroupsCardAction(
  data: CardActionData,
  larkAppId: string,
  deps: GroupsCardHandlerDeps,
): Promise<GroupsCardHandlerResult> {
  const locale: Locale = deps.locale ?? 'zh';
  const value = (data.action?.value ?? {}) as Record<string, string>;
  const operatorOpenId = data.operator?.open_id;
  const action = value.action;

  // Invoker lock — fail-closed.
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

  // Per-bot owner gate.
  const getOwnerOpenId = deps.getOwnerOpenId ?? defaultGetOwnerOpenId;
  const expectedOwner = getOwnerOpenId(larkAppId);
  if (!expectedOwner || operatorOpenId !== expectedOwner) {
    return ackToast('card.dashboard.settings.owner_only', locale);
  }

  // ─── Nav state (overview drilldown) ─────────────────────────────────
  // Threaded by buildGroupsCard onto every button.value; we parse here so
  // the rebuild path keeps the same shape (origin + page_size persist
  // across refresh/page round-trips).
  const navOrigin: 'overview' | undefined = value.origin === 'overview' ? 'overview' : undefined;
  const parsedPageSize = Number.parseInt(value.page_size ?? '', 10);
  const navPageSize: number | undefined =
    Number.isFinite(parsedPageSize) && parsedPageSize > 0 ? parsedPageSize : undefined;

  // Resolve target page.
  let page = 1;
  if (action === GROUPS_ACTION_PAGE) {
    // Page comes from value.page (prev/next button) OR action.option
    // (select_static "jump to page" picker). Same action key, different
    // dispatch field — handler converges on one branch.
    const raw = value.page ?? (data.action as { option?: string } | undefined)?.option ?? '1';
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) page = parsed;
  } else if (action !== GROUPS_ACTION_REFRESH) {
    return ackToast('card.dashboard.settings.invalid_action', locale);
  }

  // GET matrix + rebuild card. Same non-200 handling as sessions slice 1
  // (codex blocker #1, 2026-06-09): 4xx/5xx → error toast, NOT empty list.
  let r: Awaited<ReturnType<DaemonClient['request']>>;
  try {
    const client = deps.createClient(larkAppId);
    r = await client.request({ method: 'GET', path: '/__daemon/groups-matrix' });
  } catch (e) {
    return errorToast('card.dashboard.groups.list_failed', { reason: (e as Error).message }, locale);
  }
  if (r.status !== 200) {
    const reason = String((r.body as any)?.error ?? `http_${r.status}`);
    return errorToast('card.dashboard.groups.list_failed', { reason }, locale);
  }
  const body = (r.body as {
    chats?: ReadonlyArray<GroupsChatInput>;
    bots?: ReadonlyArray<GroupsBotInput>;
  }) ?? {};
  const matrix = {
    chats: body.chats ?? [],
    bots: body.bots ?? [],
  };
  const cardJson = buildGroupsCard(matrix, {
    invokerOpenId: expectedOwner,
    locale,
    page,
    pageSize: navPageSize,
    origin: navOrigin,
  });
  return {
    card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> },
  };
}
