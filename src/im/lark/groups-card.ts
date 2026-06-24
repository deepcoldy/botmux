/**
 * Groups dashboard card.
 *
 * List view + detail/manage view. The list stays compact (5/page); the
 * detail card carries per-bot membership / oncall / role management actions.
 *
 * Global dashboard scope: `/dashboard` renders the full groups matrix. The
 * row view summarizes coverage across all bot columns (joined/total) instead
 * of pretending the matrix has a single caller-bot column.
 *
 * Security:
 *  - `invokerOpenId` is the invoking admin's `ou_*` (invoker-lock anchor).
 *  - Admin gate runs at the command entry AND on every callback.
 *  - sender union_id NEVER lands on action.value.
 *
 * Response: success returns `{ card }` only (no toast) — single-pass render,
 * no stale-frame flash. Errors / permission denials return `{ toast }`.
 *
 * Sort order: keep model output order verbatim; resorting in the card would
 * silently diverge from the Web Dashboard.
 */

import { isDashboardAdmin } from '../../dashboard/dashboard-admins.js';
import type {
  GroupCoverageStatus,
  GroupDetailMemberDto,
  GroupRowDto,
  GroupsBotInput,
  GroupsChatInput,
} from '../../dashboard/groups-card-model.js';
import { buildGroupDetail, buildGroupRow } from '../../dashboard/groups-card-model.js';
import type { DaemonClient } from '../../dashboard/daemon-internal-client.js';
import { type Locale, t } from '../../i18n/index.js';

import type { CardActionData } from './card-handler.js';

export const GROUPS_ACTION_REFRESH = 'dash_groups_refresh' as const;
export const GROUPS_ACTION_PAGE = 'dash_groups_page' as const;
export const GROUPS_ACTION_DETAIL = 'dash_groups_detail' as const;
export const GROUPS_ACTION_BACK_TO_LIST = 'dash_groups_back_to_list' as const;
export const GROUPS_ACTION_ADD_BOT = 'dash_groups_add_bot' as const;
export const GROUPS_ACTION_LEAVE_BOT = 'dash_groups_leave_bot' as const;
export const GROUPS_ACTION_ONCALL_BIND = 'dash_groups_oncall_bind' as const;
export const GROUPS_ACTION_ONCALL_UNBIND = 'dash_groups_oncall_unbind' as const;
export const GROUPS_ACTION_ROLE_OPEN = 'dash_groups_role_open' as const;
export const GROUPS_ACTION_ROLE_SAVE = 'dash_groups_role_save' as const;
export const GROUPS_ACTION_ROLE_DELETE = 'dash_groups_role_delete' as const;
/** Action emitted by the "🔙 返回总览" button on overview-origin sub-cards.
 *  Same string as overview-card's OVERVIEW_ACTION_REFRESH (avoids a circular
 *  import). card-handler routes by action prefix, so dispatch lands on the
 *  overview handler regardless of which sub-card emitted it. */
const BACK_TO_OVERVIEW_ACTION = 'dash_overview_refresh' as const;

/** Default page size for standalone and overview-drilldown list cards. */
const PAGE_SIZE = 5;
const MAX_PAGE_SIZE = 100;

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
  /** Page size override, threaded through every button value. */
  pageSize?: number;
  /** Navigation origin. `'overview'` means this card was opened via
   *  `/dashboard overview` → goto groups; the footer renders an extra
   *  "🔙 返回总览" button, and every button.value carries `origin=overview`
   *  to keep that affordance across rebuilds. Undefined → standalone card,
   *  no overview link. */
  origin?: 'overview';
  /** Dashboard scope. `'global'` returns the full groups matrix rather than
   *  the caller-bot scoped matrix. */
  scope?: 'global';
}

interface GroupsNavOpts {
  invokerOpenId: string;
  locale: Locale;
  page?: number;
  pageSize?: number;
  origin?: 'overview';
  scope?: 'global';
}

type GroupsMatrix = {
  chats: ReadonlyArray<GroupsChatInput>;
  bots: ReadonlyArray<GroupsBotInput>;
};

function clampPageSize(pageSize: number | undefined): number {
  if (typeof pageSize !== 'number' || !Number.isFinite(pageSize) || pageSize <= 0) return PAGE_SIZE;
  return Math.min(Math.floor(pageSize), MAX_PAGE_SIZE);
}

function buildNavFields(opts: { pageSize?: number; origin?: 'overview'; scope?: 'global' }): Record<string, string> {
  const navFields: Record<string, string> = {};
  const effectivePageSize = clampPageSize(opts.pageSize);
  if (opts.origin === 'overview') navFields.origin = 'overview';
  if (effectivePageSize !== PAGE_SIZE) navFields.page_size = String(effectivePageSize);
  if (opts.scope === 'global') navFields.dashboard_scope = 'global';
  return navFields;
}

/** Build the groups list card JSON. Pure (composes + paginates + renders). */
export function buildGroupsCard(
  matrix: GroupsMatrix,
  opts: BuildGroupsCardOpts,
): string {
  const effectivePageSize = clampPageSize(opts.pageSize);

  // Project EVERY chat into a row DTO ourselves rather than going through
  // `buildGroupRows`, because the pipeline helper also paginates and would
  // silently clip the card list. The model owns the
  // canonical sort — we walk `matrix.chats` verbatim, no client re-sort.
  const allRows: GroupRowDto[] = matrix.chats.map(c => buildGroupRow(c, matrix.bots));

  // Header counts before pagination.
  const total = allRows.length;
  const joined = allRows.reduce(
    (n, r) => (aggregateCoverageStatus(r.coverage) === 'in' ? n + 1 : n),
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

  // Plumb origin + page_size + scope into every button.value so refresh/page
  // rebuilds keep the same dashboard context.
  const navFields = buildNavFields({ pageSize: effectivePageSize, origin: opts.origin, scope: opts.scope });

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
      elements.push(...renderRow(row, opts.locale, {
        invokerOpenId: opts.invokerOpenId,
        page: activePage,
        navFields,
      }));
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
          text: { tag: 'plain_text', content: t('card.dashboard.groups.jump_page', { n: String(n), total: String(totalPages) }, opts.locale) },
          value: String(n),
        };
      });
      actions.push({
        tag: 'select_static',
        placeholder: {
          tag: 'plain_text',
          content: t('card.dashboard.groups.jump_page', { n: String(activePage), total: String(totalPages) }, opts.locale),
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

export function buildGroupsDetailCard(
  matrix: GroupsMatrix,
  chat: GroupsChatInput,
  opts: GroupsNavOpts,
): string {
  const detail = buildGroupDetail(chat, matrix.bots);
  const displayName = detail.name && detail.name !== detail.chatId
    ? detail.name
    : t('card.dashboard.groups.unnamed', undefined, opts.locale);
  const navFields = buildNavFields({ pageSize: opts.pageSize, origin: opts.origin, scope: opts.scope });
  const backValue = {
    action: GROUPS_ACTION_BACK_TO_LIST,
    invoker_open_id: opts.invokerOpenId,
    ...(opts.page ? { page: String(opts.page) } : {}),
    ...navFields,
  };

  const elements: unknown[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content:
          `**${escapeLarkMd(displayName)}**` +
          `\n<font color="grey">${escapeLarkMd(detail.chatId)} · ${escapeLarkMd(
            t('card.dashboard.groups.joined_ratio', {
              joined: String(detail.members.filter(m => m.status === 'in').length),
              total: String(detail.members.length),
            }, opts.locale),
          )}</font>`,
      },
    },
    { tag: 'hr' },
  ];

  for (const member of detail.members) {
    elements.push(...renderDetailMember(detail.chatId, member, opts, navFields));
  }

  elements.push({ tag: 'hr' });
  const footerActions: unknown[] = [{
    tag: 'button',
    text: { tag: 'plain_text', content: t('card.dashboard.groups.btn.back', undefined, opts.locale) },
    type: 'default',
    value: backValue,
  }];
  if (opts.origin === 'overview') {
    footerActions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.dashboard.overview.back_button', undefined, opts.locale) },
      type: 'default',
      value: { action: BACK_TO_OVERVIEW_ACTION, invoker_open_id: opts.invokerOpenId },
    });
  }
  elements.push({ tag: 'action', actions: footerActions });
  elements.push({
    tag: 'note',
    elements: [
      { tag: 'lark_md', content: t('card.dashboard.settings.footer.security', undefined, opts.locale) },
    ],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t('card.dashboard.groups.detail.title', undefined, opts.locale) },
      template: 'blue',
    },
    elements,
  });
}

function renderDetailMember(
  chatId: string,
  member: GroupDetailMemberDto,
  opts: GroupsNavOpts,
  navFields: Record<string, string>,
): unknown[] {
  const status = member.status;
  const icon = statusIcon(status);
  const roleLabel = member.hasRole
    ? t('card.dashboard.groups.role_configured', undefined, opts.locale)
    : t('card.dashboard.groups.role_empty', undefined, opts.locale);
  const oncallLabel = member.oncallWorkingDir !== null
    ? t('card.dashboard.groups.oncall_enabled', { workingDir: member.oncallWorkingDir || '-' }, opts.locale)
    : t('card.dashboard.groups.oncall_disabled', undefined, opts.locale);
  const secondary = [
    statusLabel(status, opts.locale),
    roleLabel,
    oncallLabel,
    member.isOwnerBot ? t('card.dashboard.groups.owner_bot', undefined, opts.locale) : undefined,
  ].filter((x): x is string => typeof x === 'string' && x.length > 0);
  const valueBase = {
    invoker_open_id: opts.invokerOpenId,
    chat_id: chatId,
    app_id: member.larkAppId,
    ...(opts.page ? { page: String(opts.page) } : {}),
    ...navFields,
  };
  const actions: unknown[] = [];

  const extraElements: unknown[] = [];
  if (status === 'in') {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.dashboard.groups.btn.role', undefined, opts.locale) },
      type: 'default',
      value: { action: GROUPS_ACTION_ROLE_OPEN, ...valueBase },
    });
    if (member.oncallWorkingDir !== null) {
      actions.push({
        tag: 'button',
        text: { tag: 'plain_text', content: t('card.dashboard.groups.btn.oncall_unbind', undefined, opts.locale) },
        type: 'danger',
        value: { action: GROUPS_ACTION_ONCALL_UNBIND, ...valueBase },
      });
    } else {
      extraElements.push({
        tag: 'form',
        name: 'groups_oncall_form',
        elements: [
          {
            tag: 'input',
            name: 'working_dir',
            placeholder: {
              tag: 'plain_text',
              content: t('card.dashboard.groups.working_dir_placeholder', undefined, opts.locale),
            },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: t('card.dashboard.groups.btn.oncall_bind', undefined, opts.locale) },
            type: 'primary',
            name: 'groups_oncall_bind',
            action_type: 'form_submit',
            value: { action: GROUPS_ACTION_ONCALL_BIND, ...valueBase },
          },
        ],
      });
    }
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.dashboard.groups.btn.leave_bot', undefined, opts.locale) },
      type: 'danger',
      confirm: {
        title: { tag: 'plain_text', content: t('card.dashboard.groups.confirm.leave.title', undefined, opts.locale) },
        text: {
          tag: 'plain_text',
          content: t('card.dashboard.groups.confirm.leave.text', { bot: member.botName }, opts.locale),
        },
      },
      value: { action: GROUPS_ACTION_LEAVE_BOT, ...valueBase },
    });
  } else {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.dashboard.groups.btn.add_bot', undefined, opts.locale) },
      type: 'primary',
      value: { action: GROUPS_ACTION_ADD_BOT, ...valueBase },
    });
  }

  return [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content:
          `${icon} **${escapeLarkMd(member.botName)}** ` +
          `<font color="grey">${escapeLarkMd(member.larkAppId.slice(-6))}</font>` +
          `\n<font color="grey">${escapeLarkMd(secondary.join(' · '))}</font>`,
      },
    },
    {
      tag: 'action',
      actions,
    },
    ...extraElements,
  ];
}

export function buildGroupsRoleCard(
  chat: GroupsChatInput,
  member: GroupDetailMemberDto,
  roleContent: string,
  opts: GroupsNavOpts,
): string {
  const displayName = chat.name && chat.name !== chat.chatId
    ? chat.name
    : t('card.dashboard.groups.unnamed', undefined, opts.locale);
  const navFields = buildNavFields({ pageSize: opts.pageSize, origin: opts.origin, scope: opts.scope });
  const valueBase = {
    invoker_open_id: opts.invokerOpenId,
    chat_id: chat.chatId,
    app_id: member.larkAppId,
    ...(opts.page ? { page: String(opts.page) } : {}),
    ...navFields,
  };
  const elements: unknown[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content:
          `**${escapeLarkMd(displayName)} · ${escapeLarkMd(member.botName)}**` +
          `\n<font color="grey">${escapeLarkMd(chat.chatId)} · ${escapeLarkMd(member.larkAppId)}</font>`,
      },
    },
    { tag: 'hr' },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content:
          `**${t('card.dashboard.groups.current_role', undefined, opts.locale)}**` +
          `\n${roleContent.trim().length > 0
            ? escapeLarkMd(roleContent)
            : `_${escapeLarkMd(t('card.dashboard.groups.current_role_empty', undefined, opts.locale))}_`}`,
      },
    },
    { tag: 'hr' },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${t('card.dashboard.groups.edit_role', undefined, opts.locale)}**`,
      },
    },
    {
      tag: 'form',
      name: 'groups_role_form',
      elements: [
        {
          tag: 'input',
          name: 'role',
          default_value: roleContent,
          placeholder: { tag: 'plain_text', content: t('card.dashboard.groups.role_placeholder', undefined, opts.locale) },
          input_type: 'multiline_text',
          rows: 8,
          max_rows: 12,
          auto_resize: true,
          width: 'fill',
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t('card.dashboard.groups.btn.role_save', undefined, opts.locale) },
          type: 'primary',
          name: 'groups_role_save',
          action_type: 'form_submit',
          value: { action: GROUPS_ACTION_ROLE_SAVE, ...valueBase },
        },
      ],
    },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t('card.dashboard.groups.btn.role_delete', undefined, opts.locale) },
          type: 'danger',
          disabled: roleContent.trim().length === 0,
          value: { action: GROUPS_ACTION_ROLE_DELETE, ...valueBase },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t('card.dashboard.groups.btn.back', undefined, opts.locale) },
          type: 'default',
          value: { action: GROUPS_ACTION_DETAIL, ...valueBase },
        },
      ],
    },
  ];

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t('card.dashboard.groups.role.title', undefined, opts.locale) },
      template: 'blue',
    },
    elements,
  });
}

function renderRow(
  row: GroupRowDto,
  locale: Locale,
  ctx: { invokerOpenId: string; page: number; navFields: Record<string, string> },
): unknown[] {
  const status = aggregateCoverageStatus(row.coverage);
  const icon = statusIcon(status);

  // Primary: status icon + bold name (or unnamed fallback) + grey id suffix.
  const displayName = row.name && row.name !== row.chatId
    ? row.name
    : t('card.dashboard.groups.unnamed', undefined, locale);
  const idSuffix = row.chatIdSuffix
    ? ` <font color="grey">${escapeLarkMd(row.chatIdSuffix)}</font>`
    : '';

  // Secondary: aggregate coverage across all bot columns.
  const secondaryParts: string[] = [
    t('card.dashboard.groups.coverage_label', { status: statusLabel(status, locale) }, locale),
    t(
      'card.dashboard.groups.joined_ratio',
      { joined: String(row.totalBots - row.missingCount), total: String(row.totalBots) },
      locale,
    ),
  ];

  const secondary = `\n<font color="grey">${escapeLarkMd(secondaryParts.join(' · '))}</font>`;

  return [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content:
          `${icon} **${escapeLarkMd(displayName)}**${idSuffix}` + secondary,
      },
    },
    {
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: t('card.dashboard.groups.row_manage', undefined, locale) },
        type: 'default',
        value: {
          action: GROUPS_ACTION_DETAIL,
          invoker_open_id: ctx.invokerOpenId,
          chat_id: row.chatId,
          page: String(ctx.page),
          ...ctx.navFields,
        },
      }],
    },
  ];
}

function aggregateCoverageStatus(cells: ReadonlyArray<GroupRowDto['coverage'][number]>): GroupCoverageStatus {
  if (cells.length === 0) return 'unknown';
  if (cells.some(c => c.status === 'error')) return 'error';
  if (cells.some(c => c.status === 'unknown')) return 'unknown';
  if (cells.every(c => c.status === 'in')) return 'in';
  return 'out';
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
  getDashboardAdminOpenIds?: (larkAppId: string) => ReadonlyArray<string> | undefined;
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

function cardResult(cardJson: string): GroupsCardHandlerResult {
  return {
    card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> },
  };
}

function matrixFromBody(body: unknown): GroupsMatrix {
  const b = (body as {
    chats?: ReadonlyArray<GroupsChatInput>;
    bots?: ReadonlyArray<GroupsBotInput>;
  }) ?? {};
  return {
    chats: b.chats ?? [],
    bots: b.bots ?? [],
  };
}

async function loadGroupsMatrix(
  client: DaemonClient,
  pathSuffix: string,
  locale: Locale,
): Promise<{ ok: true; matrix: GroupsMatrix } | { ok: false; result: GroupsCardHandlerResult }> {
  let r: Awaited<ReturnType<DaemonClient['request']>>;
  try {
    r = await client.request({ method: 'GET', path: `/__daemon/groups-matrix${pathSuffix}` });
  } catch (e) {
    return {
      ok: false,
      result: errorToast('card.dashboard.groups.list_failed', { reason: (e as Error).message }, locale),
    };
  }
  if (r.status !== 200) {
    const reason = String((r.body as any)?.error ?? `http_${r.status}`);
    return {
      ok: false,
      result: errorToast('card.dashboard.groups.list_failed', { reason }, locale),
    };
  }
  return { ok: true, matrix: matrixFromBody(r.body) };
}

function findChat(matrix: GroupsMatrix, chatId: string | undefined): GroupsChatInput | undefined {
  if (!chatId) return undefined;
  return matrix.chats.find(c => c.chatId === chatId);
}

function findDetailMember(
  matrix: GroupsMatrix,
  chat: GroupsChatInput,
  appId: string | undefined,
): GroupDetailMemberDto | undefined {
  if (!appId) return undefined;
  return buildGroupDetail(chat, matrix.bots).members.find(m => m.larkAppId === appId);
}

function formValue(data: CardActionData, key: string): string {
  const raw = data.action?.form_value?.[key] ?? (key === 'role' ? (data.action as any)?.input_value : undefined);
  return typeof raw === 'string' ? raw.trim() : '';
}

function actionFailureReason(body: unknown, status: number): string {
  const b = body as any;
  if (b?.ok === false && typeof b.error === 'string') return b.error;
  if (typeof b?.error === 'string') return b.error;
  if (Array.isArray(b?.result)) {
    const failed = b.result.find((x: any) => x?.ok === false);
    if (failed?.error) return String(failed.error);
  }
  return `http_${status}`;
}

function bodyOk(body: unknown): boolean {
  const b = body as any;
  if (b?.ok === false) return false;
  if (Array.isArray(b?.result)) return b.result.every((x: any) => x?.ok !== false);
  return true;
}

async function writeGroupAction(
  client: DaemonClient,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body: unknown | undefined,
  locale: Locale,
): Promise<GroupsCardHandlerResult | undefined> {
  let r: Awaited<ReturnType<DaemonClient['request']>>;
  try {
    r = await client.request({ method, path, body });
  } catch (e) {
    return errorToast('card.dashboard.groups.action_failed', { reason: (e as Error).message }, locale);
  }
  if (r.status >= 400 || !bodyOk(r.body)) {
    return errorToast('card.dashboard.groups.action_failed', { reason: actionFailureReason(r.body, r.status) }, locale);
  }
  return undefined;
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

  // Per-bot admin gate.
  if (!isDashboardAdmin(larkAppId, operatorOpenId, deps)) {
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
  const navScope: 'global' | undefined = value.dashboard_scope === 'global' ? 'global' : undefined;
  const pathSuffix = navScope === 'global' ? '?scope=global' : '';
  const navOptsBase: GroupsNavOpts = {
    invokerOpenId: operatorOpenId,
    locale,
    pageSize: navPageSize,
    origin: navOrigin,
    scope: navScope,
  };
  const chatId = value.chat_id;
  const appId = value.app_id;

  // Resolve target page.
  let page = 1;
  if (action === GROUPS_ACTION_PAGE) {
    // Page comes from value.page (prev/next button) OR action.option
    // (select_static "jump to page" picker). Same action key, different
    // dispatch field — handler converges on one branch.
    const raw = value.page ?? (data.action as { option?: string } | undefined)?.option ?? '1';
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) page = parsed;
  } else if (value.page) {
    const parsed = Number.parseInt(value.page, 10);
    if (Number.isFinite(parsed) && parsed >= 1) page = parsed;
  }

  const knownActions = new Set<string>([
    GROUPS_ACTION_REFRESH,
    GROUPS_ACTION_PAGE,
    GROUPS_ACTION_DETAIL,
    GROUPS_ACTION_BACK_TO_LIST,
    GROUPS_ACTION_ADD_BOT,
    GROUPS_ACTION_LEAVE_BOT,
    GROUPS_ACTION_ONCALL_BIND,
    GROUPS_ACTION_ONCALL_UNBIND,
    GROUPS_ACTION_ROLE_OPEN,
    GROUPS_ACTION_ROLE_SAVE,
    GROUPS_ACTION_ROLE_DELETE,
  ]);
  if (!knownActions.has(String(action))) {
    return ackToast('card.dashboard.settings.invalid_action', locale);
  }

  const client = deps.createClient(larkAppId);
  const load = await loadGroupsMatrix(client, pathSuffix, locale);
  if (!load.ok) return load.result;
  const matrix = load.matrix;

  const renderList = (p: number): GroupsCardHandlerResult => cardResult(buildGroupsCard(matrix, {
    invokerOpenId: operatorOpenId,
    locale,
    page: p,
    pageSize: navPageSize,
    origin: navOrigin,
    scope: navScope,
  }));
  const renderDetail = (chat: GroupsChatInput): GroupsCardHandlerResult => cardResult(buildGroupsDetailCard(matrix, chat, {
    ...navOptsBase,
    page,
  }));

  if (action === GROUPS_ACTION_REFRESH || action === GROUPS_ACTION_PAGE || action === GROUPS_ACTION_BACK_TO_LIST) {
    return renderList(page);
  }

  const chat = findChat(matrix, chatId);
  if (!chat) {
    return errorToast('card.dashboard.groups.chat_not_found', undefined, locale);
  }
  if (action === GROUPS_ACTION_DETAIL) return renderDetail(chat);

  const member = findDetailMember(matrix, chat, appId);
  if (!member) {
    return errorToast('card.dashboard.groups.bot_not_found', undefined, locale);
  }

  if (action === GROUPS_ACTION_ADD_BOT) {
    if (member.status === 'in') {
      return errorToast('card.dashboard.groups.action_not_allowed', { reason: 'already_in_chat' }, locale);
    }
    const failed = await writeGroupAction(
      client,
      'POST',
      `/__daemon/groups/${encodeURIComponent(chat.chatId)}/add-bots`,
      { larkAppIds: [member.larkAppId] },
      locale,
    );
    if (failed) return failed;
  } else if (action === GROUPS_ACTION_LEAVE_BOT) {
    if (member.status !== 'in') {
      return errorToast('card.dashboard.groups.action_not_allowed', { reason: 'not_in_chat' }, locale);
    }
    const failed = await writeGroupAction(
      client,
      'POST',
      `/__daemon/groups/${encodeURIComponent(chat.chatId)}/leave`,
      { larkAppIds: [member.larkAppId] },
      locale,
    );
    if (failed) return failed;
  } else if (action === GROUPS_ACTION_ONCALL_BIND) {
    if (!member.bind.enabled) {
      return errorToast('card.dashboard.groups.action_not_allowed', { reason: member.bind.reasonKey ?? 'bind_disabled' }, locale);
    }
    const workingDir = formValue(data, 'working_dir');
    if (!workingDir) {
      return errorToast('card.dashboard.groups.working_dir_required', undefined, locale);
    }
    const failed = await writeGroupAction(
      client,
      'POST',
      `/__daemon/groups/${encodeURIComponent(chat.chatId)}/oncall/${encodeURIComponent(member.larkAppId)}/bind`,
      { workingDir },
      locale,
    );
    if (failed) return failed;
  } else if (action === GROUPS_ACTION_ONCALL_UNBIND) {
    if (!member.unbind.enabled) {
      return errorToast('card.dashboard.groups.action_not_allowed', { reason: member.unbind.reasonKey ?? 'unbind_disabled' }, locale);
    }
    const failed = await writeGroupAction(
      client,
      'POST',
      `/__daemon/groups/${encodeURIComponent(chat.chatId)}/oncall/${encodeURIComponent(member.larkAppId)}/unbind`,
      undefined,
      locale,
    );
    if (failed) return failed;
  } else if (action === GROUPS_ACTION_ROLE_OPEN) {
    if (member.status !== 'in') {
      return errorToast('card.dashboard.groups.action_not_allowed', { reason: 'not_in_chat' }, locale);
    }
    let r: Awaited<ReturnType<DaemonClient['request']>>;
    try {
      r = await client.request({
        method: 'GET',
        path: `/__daemon/groups/${encodeURIComponent(chat.chatId)}/roles/${encodeURIComponent(member.larkAppId)}`,
      });
    } catch (e) {
      return errorToast('card.dashboard.groups.action_failed', { reason: (e as Error).message }, locale);
    }
    if (r.status !== 200) {
      return errorToast('card.dashboard.groups.action_failed', { reason: actionFailureReason(r.body, r.status) }, locale);
    }
    const roleContent = typeof (r.body as any)?.content === 'string' ? (r.body as any).content : '';
    return cardResult(buildGroupsRoleCard(chat, member, roleContent, { ...navOptsBase, page }));
  } else if (action === GROUPS_ACTION_ROLE_SAVE) {
    if (member.status !== 'in') {
      return errorToast('card.dashboard.groups.action_not_allowed', { reason: 'not_in_chat' }, locale);
    }
    const role = formValue(data, 'role');
    if (!role) {
      return errorToast('card.dashboard.groups.role_required', undefined, locale);
    }
    const failed = await writeGroupAction(
      client,
      'PUT',
      `/__daemon/groups/${encodeURIComponent(chat.chatId)}/roles/${encodeURIComponent(member.larkAppId)}`,
      { content: role },
      locale,
    );
    if (failed) return failed;
  } else if (action === GROUPS_ACTION_ROLE_DELETE) {
    if (member.status !== 'in') {
      return errorToast('card.dashboard.groups.action_not_allowed', { reason: 'not_in_chat' }, locale);
    }
    const failed = await writeGroupAction(
      client,
      'DELETE',
      `/__daemon/groups/${encodeURIComponent(chat.chatId)}/roles/${encodeURIComponent(member.larkAppId)}`,
      undefined,
      locale,
    );
    if (failed) return failed;
  }

  const fresh = await loadGroupsMatrix(client, pathSuffix, locale);
  if (!fresh.ok) return fresh.result;
  const freshChat = findChat(fresh.matrix, chat.chatId) ?? chat;
  return cardResult(buildGroupsDetailCard(fresh.matrix, freshChat, { ...navOptsBase, page }));
}
