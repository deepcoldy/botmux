/**
 * Sessions dashboard card.
 *
 * The list view is compact, paginated, refreshable, and read-only except for
 * per-row detail entry. The detail view exposes locate, terminal, close/resume,
 * and back actions.
 *
 * Close/resume callbacks block on Route B and return a rebuilt card on success.
 * Failures return toast-only and leave the visible card unchanged for retry.
 * Chat-scope locate uses a direct `multi_url`; thread-scope locate posts a
 * Route B notification and returns toast-only.
 *
 * Security:
 *  - `invokerOpenId` pins callbacks to the admin who opened the card.
 *  - sender union_id never lands on `action.value`.
 *  - command entry and callbacks both enforce the dashboard admin gate.
 *  - row ids are routing keys only; Route B still enforces row ownership.
 *  - write actions re-run the model availability matrix before POSTing.
 */

import { isDashboardAdmin } from '../../dashboard/dashboard-admins.js';
import type { SessionRowDto, SessionDetailDto } from '../../dashboard/session-card-model.js';
import { composeEntries, sortByStatus, paginate, composeDetail } from '../../dashboard/session-card-model.js';
import type { DaemonClient } from '../../dashboard/daemon-internal-client.js';
import type { SessionRow } from '../../core/dashboard-rows.js';
import { config } from '../../config.js';
import { type Locale, t } from '../../i18n/index.js';

import { terminalMultiUrl } from './card-builder.js';
import type { CardActionData } from './card-handler.js';

export const SESSIONS_ACTION_REFRESH = 'dash_sessions_refresh' as const;
export const SESSIONS_ACTION_PAGE = 'dash_sessions_page' as const;
export const SESSIONS_ACTION_DETAIL = 'dash_sessions_detail' as const;
export const SESSIONS_ACTION_CLOSE = 'dash_sessions_close' as const;
export const SESSIONS_ACTION_BACK_TO_LIST = 'dash_sessions_back_to_list' as const;
/** Thread-scope locate sends a mention into the original topic. */
export const SESSIONS_ACTION_LOCATE = 'dash_sessions_locate' as const;
/** Replaces close when status === 'closed'; refetches after resume. */
export const SESSIONS_ACTION_RESUME = 'dash_sessions_resume' as const;
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

function clampPageSize(pageSize: number | undefined): number {
  if (typeof pageSize !== 'number' || !Number.isFinite(pageSize) || pageSize <= 0) return PAGE_SIZE;
  return Math.min(Math.floor(pageSize), MAX_PAGE_SIZE);
}

export interface BuildSessionsCardOpts {
  invokerOpenId: string;
  locale: Locale;
  /** 1-based page index. Caller clamps; this just renders what's given. */
  page: number;
  /** Page size override, threaded through every button value. */
  pageSize?: number;
  /** Navigation origin. `'overview'` means this card was opened via
   *  `/dashboard overview` → goto sessions; the footer renders an extra
   *  "🔙 返回总览" button, and every button.value carries `origin=overview`
   *  to keep that affordance across rebuilds. Undefined → standalone card,
   *  no overview link. */
  origin?: 'overview';
  /** Dashboard scope. `'global'` means `/dashboard` shows sessions from
   *  every bot, and write callbacks route by the row's true owner. */
  scope?: 'global';
}

/** Build the sessions list card JSON from raw rows. Pure (composes + paginates). */
export function buildSessionsCard(
  rows: ReadonlyArray<SessionRow>,
  opts: BuildSessionsCardOpts,
  nowMs: number,
): string {
  const effectivePageSize = clampPageSize(opts.pageSize);
  const sorted = sortByStatus(composeEntries(rows, nowMs));
  const { items, meta } = paginate(sorted, opts.page, effectivePageSize);

  // Plumb origin + page_size + scope into every button.value so refresh/
  // page/detail/detail-back rebuilds keep the same dashboard context.
  const navFields: Record<string, string> = {};
  if (opts.origin === 'overview') navFields.origin = 'overview';
  if (effectivePageSize !== PAGE_SIZE) navFields.page_size = String(effectivePageSize);
  if (opts.scope === 'global') navFields.dashboard_scope = 'global';

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
      // Row text element.
      elements.push(renderRow(e, opts.locale));
      // Per-row action element holding ONLY the "📂 详情" button.
      // Keeping each row's actions in its own `action` element (rather than
      // one shared element for the whole page) makes the visual layout
      // align with the row above and lets us pass the row's sessionId
      // through `value.session_id` as the routing key.
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: t('card.dashboard.sessions.row_detail', undefined, opts.locale) },
            type: 'default',
            value: {
              action: SESSIONS_ACTION_DETAIL,
              invoker_open_id: opts.invokerOpenId,
              session_id: e.sessionId,
              page: String(meta.page),
              ...navFields,
            },
          },
        ],
      });
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
        ...navFields,
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
        ...navFields,
      },
    });
    // "Jump to page" select — same action as prev/next, page comes via
    // action.option instead of value.page. Handler reads `value.page ??
    // action.option ?? '1'` so both paths converge on one branch. Capped at
    // JUMP_PAGE_MAX_OPTIONS to keep payload small / inside Lark's option
    // limit (above the cap, prev/next still works).
    if (meta.totalPages > 2 && meta.totalPages <= JUMP_PAGE_MAX_OPTIONS) {
      const options = Array.from({ length: meta.totalPages }, (_, i) => {
        const n = i + 1;
        return {
          text: { tag: 'plain_text', content: t('card.dashboard.sessions.jump_page', { n: String(n), total: String(meta.totalPages) }, opts.locale) },
          value: String(n),
        };
      });
      actions.push({
        tag: 'select_static',
        placeholder: {
          tag: 'plain_text',
          content: t('card.dashboard.sessions.jump_page', { n: String(meta.page), total: String(meta.totalPages) }, opts.locale),
        },
        initial_option: String(meta.page),
        options,
        value: {
          action: SESSIONS_ACTION_PAGE,
          invoker_open_id: opts.invokerOpenId,
          ...navFields,
        },
      });
    }
  }
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t('card.dashboard.sessions.refresh', undefined, opts.locale) },
    type: 'default',
    value: {
      action: SESSIONS_ACTION_REFRESH,
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
        `${icon} **${escapeLarkMd(entry.primary)}**` +
        (entry.secondary ? `\n<font color="grey">${escapeLarkMd(entry.secondary)}</font>` : ''),
    },
  };
}

/** Options for the detail card. `invokerOpenId` plumbs the lock onto every callback button. */
export interface BuildSessionsDetailCardOpts {
  invokerOpenId: string;
  locale: Locale;
  /** Override `Date.now()` for the relative-time label. Tests pass a fixed value. */
  nowMs?: number;
  /** Overview drilldown nav state — threaded into the "🔙 返回" button so the
   *  list rebuilt by `BACK_TO_LIST` is still drilldown-shaped (5/page +
   *  return-to-overview). Detail itself does NOT render a return-to-overview
   *  button (single back affordance). */
  origin?: 'overview';
  pageSize?: number;
  /** Source list page. Detail buttons round-trip this so BACK_TO_LIST restores
   *  the page that opened the detail card (instead of always resetting to 1). */
  sourcePage?: number;
  /** Dashboard scope. Threaded into locate/close/resume/back buttons. */
  scope?: 'global';
  /** Web terminal URL for the openTerminal button; null renders it disabled. */
  terminalUrl?: string | null;
  /** Direct chat link for chat-scope locate; absent for thread-scope rows. */
  feishuChatLink?: string | null;
}

/**
 * Build the session detail card: metadata, locate/terminal controls, close or
 * resume depending on status, and the back button.
 */
export function buildSessionsDetailCard(
  detail: SessionDetailDto,
  opts: BuildSessionsDetailCardOpts,
): string {
  const icon = toneIcon(detail.dot.tone);
  const elements: unknown[] = [];

  // ─── Title — status dot + bold title + sessionId monospace ─────────────
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content:
        `${icon} **${escapeLarkMd(detail.title)}**` +
        `\n\`${escapeLarkMd(detail.sessionId)}\``,
    },
  });

  elements.push({ tag: 'hr' });

  // ─── Secondary info block ──────────────────────────────────────────────
  const infoLines: string[] = [];
  infoLines.push(
    t(
      'card.dashboard.sessions.detail.status_label',
      { status: escapeLarkMd(detail.status) },
      opts.locale,
    ),
  );
  infoLines.push(
    t(
      'card.dashboard.sessions.detail.cli_label',
      { cli: escapeLarkMd(detail.cliId) },
      opts.locale,
    ),
  );
  if (detail.workingDir) {
    infoLines.push(
      t(
        'card.dashboard.sessions.detail.workingdir_label',
        { dir: escapeLarkMd(detail.workingDir) },
        opts.locale,
      ),
    );
  }
  infoLines.push(
    t(
      'card.dashboard.sessions.detail.chat_label',
      { chat: escapeLarkMd(detail.chatId) },
      opts.locale,
    ),
  );
  const lastMessageAt = detail.raw.lastMessageAt;
  if (Number.isFinite(lastMessageAt) && lastMessageAt > 0) {
    const now = opts.nowMs ?? Date.now();
    infoLines.push(
      t(
        'card.dashboard.sessions.detail.last_message_label',
        { rel: formatRelativeForDetail(lastMessageAt, now) },
        opts.locale,
      ),
    );
  }
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: infoLines.map(l => `<font color="grey">${l}</font>`).join('\n'),
    },
  });

  elements.push({ tag: 'hr' });

  // ─── Action row — locate / terminal / (close OR resume) / back ────────
  // Detail card matches the Web dashboard's four primary actions.
  // active state shows close (danger); closed state replaces close with
  // resume so the user can revive the session.
  const backNav: Record<string, string> = {};
  const effectivePageSize = clampPageSize(opts.pageSize);
  if (opts.origin === 'overview') backNav.origin = 'overview';
  if (typeof opts.sourcePage === 'number' && Number.isFinite(opts.sourcePage) && opts.sourcePage >= 1) {
    backNav.page = String(Math.floor(opts.sourcePage));
  }
  if (effectivePageSize !== PAGE_SIZE) backNav.page_size = String(effectivePageSize);
  if (opts.scope === 'global') backNav.dashboard_scope = 'global';
  // Track reason notes to render below the action row in row order.
  const reasonNotes: { key: string; titleKey?: string }[] = [];

  // 1) Locate button. The matrix says it's always enabled; we still gate
  //    on matrix to stay matrix-driven.
  const locateEnabled = detail.actions.locate.enabled === true;
  const locateButton: Record<string, unknown> = {
    tag: 'button',
    text: { tag: 'plain_text', content: t('card.dashboard.sessions.btn.locate', undefined, opts.locale) },
    type: 'default',
  };
  if (locateEnabled) {
    if (
      detail.actions.locateMode === 'openChat'
      && typeof opts.feishuChatLink === 'string'
      && opts.feishuChatLink.length > 0
    ) {
      // chat-scope: jump straight into the group via multi_url. No callback.
      locateButton.multi_url = {
        url: opts.feishuChatLink,
        pc_url: opts.feishuChatLink,
        android_url: opts.feishuChatLink,
        ios_url: opts.feishuChatLink,
      };
    } else {
      // thread-scope (default) OR chat-scope missing the link: POST to
      // Route B locate which sends a @mention into the original topic.
      locateButton.value = {
        action: SESSIONS_ACTION_LOCATE,
        invoker_open_id: opts.invokerOpenId,
        session_id: detail.sessionId,
        ...backNav,
      };
    }
  } else {
    locateButton.disabled = true;
  }

  // 2) Open Terminal button. multi_url-based — no callback.
  //    Disabled when actions.openTerminal.enabled === false OR no terminalUrl.
  const terminalEnabled =
    detail.actions.openTerminal.enabled === true
    && typeof opts.terminalUrl === 'string'
    && opts.terminalUrl.length > 0;
  const terminalButton: Record<string, unknown> = {
    tag: 'button',
    text: { tag: 'plain_text', content: t('card.dashboard.sessions.btn.terminal', undefined, opts.locale) },
    type: 'default',
  };
  if (terminalEnabled) {
    // Wrap with the project's terminal multi-url policy (PC sidebar vs direct).
    terminalButton.multi_url = terminalMultiUrl(opts.terminalUrl as string);
  } else {
    terminalButton.disabled = true;
    const reasonKey = mapTerminalDisabledReason(detail.actions.openTerminal.reasonKey);
    if (reasonKey) reasonNotes.push({ key: reasonKey });
  }

  // 3) close OR resume — mutually exclusive based on row status.
  //    closed → resume button replaces close; otherwise → close stays.
  const isClosed = detail.actions.resume.enabled === true;
  let writeButton: Record<string, unknown>;
  if (isClosed) {
    // Resume button: green primary, confirm dialog.
    writeButton = {
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.dashboard.sessions.btn.resume', undefined, opts.locale) },
      type: 'primary',
      value: {
        action: SESSIONS_ACTION_RESUME,
        invoker_open_id: opts.invokerOpenId,
        session_id: detail.sessionId,
        ...backNav,
      },
      confirm: {
        title: { tag: 'plain_text', content: t('card.dashboard.sessions.confirm.resume.title', undefined, opts.locale) },
        text: {
          tag: 'plain_text',
          content: t('card.dashboard.sessions.confirm.resume.text', { title: detail.title }, opts.locale),
        },
      },
    };
  } else {
    const closeEnabled = detail.actions.close.enabled === true;
    writeButton = {
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.dashboard.sessions.btn.close', undefined, opts.locale) },
      type: 'danger',
      value: {
        action: SESSIONS_ACTION_CLOSE,
        invoker_open_id: opts.invokerOpenId,
        session_id: detail.sessionId,
        ...backNav,
      },
    };
    if (closeEnabled) {
      (writeButton as Record<string, unknown>).confirm = {
        title: { tag: 'plain_text', content: t('card.dashboard.sessions.confirm.close.title', undefined, opts.locale) },
        text: {
          tag: 'plain_text',
          content: t('card.dashboard.sessions.confirm.close.text', { title: detail.title }, opts.locale),
        },
      };
    } else {
      (writeButton as Record<string, unknown>).disabled = true;
      const reasonKey = mapCloseDisabledReason(detail.actions.close.reasonKey);
      if (reasonKey) reasonNotes.push({ key: reasonKey });
    }
  }

  // 4) Back button — always.
  const backButton = {
    tag: 'button',
    text: { tag: 'plain_text', content: t('card.dashboard.sessions.btn.back', undefined, opts.locale) },
    type: 'default',
    value: {
      action: SESSIONS_ACTION_BACK_TO_LIST,
      invoker_open_id: opts.invokerOpenId,
      ...backNav,
    },
  };

  elements.push({
    tag: 'action',
    actions: [locateButton, terminalButton, writeButton, backButton],
  });

  for (const r of reasonNotes) {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'lark_md', content: t(r.key, undefined, opts.locale) }],
    });
  }

  // Footer security note (mirrors list card).
  elements.push({
    tag: 'note',
    elements: [
      { tag: 'lark_md', content: t('card.dashboard.settings.footer.security', undefined, opts.locale) },
    ],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t('card.dashboard.sessions.detail.title', undefined, opts.locale) },
      template: 'blue',
    },
    elements,
  });
}

/** Map composeDetail close reason keys to card i18n keys. */
function mapCloseDisabledReason(reasonKey: string | undefined): string | undefined {
  switch (reasonKey) {
    case 'sessions.action.close.starting':
      return 'card.dashboard.sessions.close.disabled.starting';
    case 'sessions.action.close.alreadyClosed':
      return 'card.dashboard.sessions.close.disabled.alreadyClosed';
    default:
      return undefined;
  }
}

/** Map open-terminal reason keys to card i18n keys. */
function mapTerminalDisabledReason(reasonKey: string | undefined): string | undefined {
  switch (reasonKey) {
    case 'sessions.action.terminal.noPort':
      return 'card.dashboard.sessions.terminal.disabled.noPort';
    default:
      return undefined;
  }
}

/** Map resume reason keys to card i18n keys. */
function mapResumeDisabledReason(reasonKey: string | undefined): string | undefined {
  switch (reasonKey) {
    case 'sessions.action.resume.onlyClosed':
      return 'card.dashboard.sessions.resume.disabled.onlyClosed';
    default:
      return undefined;
  }
}

/** Compute the Web Terminal URL for a SessionRow. Mirrors
 *  `src/dashboard/web/sessions.ts:terminalHref`: proxy port wins (with the
 *  `/s/{sessionId}` suffix); otherwise direct worker port. Returns null when
 *  the session has no port at all (e.g. closed / starting).
 *
 *  Closed sessions can carry a stale webPort, so closed rows are always
 *  rejected here even if the raw row still has a port value. */
export function buildSessionTerminalUrl(row: SessionRow): string | null {
  if (row.status === 'closed') return null;
  const host = config.web.externalHost;
  if (typeof row.proxyPort === 'number' && row.proxyPort > 0) {
    return `http://${host}:${row.proxyPort}/s/${encodeURIComponent(row.sessionId)}`;
  }
  if (typeof row.webPort === 'number' && row.webPort > 0) {
    return `http://${host}:${row.webPort}`;
  }
  return null;
}

function formatRelativeForDetail(fromMs: number, nowMs: number): string {
  const diff = nowMs - fromMs;
  if (!Number.isFinite(diff) || diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h ago`;
  const day = Math.floor(hour / 24);
  return `${day}d ago`;
}

/**
 * Sanitize user/filesystem-supplied text for inclusion in a Lark `lark_md`
 * element — particularly inside our `<font color="grey">…</font>` wrapper.
 *
 * Session titles come from chat content and workingDir comes from the
 * filesystem. Both flow into a span we wrap with `<font>`; without escaping, a payload containing
 * `</font><at id=ou_x></at>` would close our wrapper and inject a
 * @mention-looking element. We also need to handle `*_~\``-style markdown
 * controls so plain filenames don't render as bold/italic.
 *
 * Order matters: escape `&` FIRST so a later `<` → `&lt;` doesn't get
 * re-encoded as `&amp;lt;`.
 */
function escapeLarkMd(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_~`])/g, '\\$1');
}

/** ─── Handler ─────────────────────────────────────────────────────────── */

export interface SessionsCardHandlerDeps {
  /** Legacy owner test seam; prefer `getDashboardAdminOpenIds` for new tests. */
  getOwnerOpenId?: (larkAppId: string) => string | undefined;
  getDashboardAdminOpenIds?: (larkAppId: string) => ReadonlyArray<string> | undefined;
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

  // ─── 2) Per-bot admin gate ──────────────────────────────────────────
  if (!isDashboardAdmin(larkAppId, operatorOpenId, deps)) {
    return ackToast('card.dashboard.settings.owner_only', locale);
  }

  // Validate the action BEFORE creating the Route B client — an unknown
  // action shouldn't even open a connection.
  const validActions = new Set<string>([
    SESSIONS_ACTION_REFRESH,
    SESSIONS_ACTION_PAGE,
    SESSIONS_ACTION_DETAIL,
    SESSIONS_ACTION_CLOSE,
    SESSIONS_ACTION_BACK_TO_LIST,
    SESSIONS_ACTION_LOCATE,
    SESSIONS_ACTION_RESUME,
  ]);
  if (!validActions.has(action)) {
    return ackToast('card.dashboard.settings.invalid_action', locale);
  }

  const client = deps.createClient(larkAppId);
  const now = (): number => (deps.nowMs ? deps.nowMs() : Date.now());

  // ─── Nav state (overview drilldown) ─────────────────────────────────
  // Threaded by buildSessionsCard onto every button.value; we parse here
  // so the rebuild path keeps the same shape (5/page + 🔙 返回总览).
  const navOrigin: 'overview' | undefined = value.origin === 'overview' ? 'overview' : undefined;
  const parsedPageSize = Number.parseInt(value.page_size ?? '', 10);
  const navPageSize: number | undefined =
    Number.isFinite(parsedPageSize) && parsedPageSize > 0 ? parsedPageSize : undefined;
  const parsedNavPage = Number.parseInt(value.page ?? '', 10);
  const navPage: number | undefined =
    Number.isFinite(parsedNavPage) && parsedNavPage >= 1 ? parsedNavPage : undefined;
  const navScope: 'global' | undefined = value.dashboard_scope === 'global' ? 'global' : undefined;
  const pathSuffix = navScope === 'global' ? '?scope=global' : '';

  // ─── 3a) DETAIL — open the per-session detail card ──────────────────
  if (action === SESSIONS_ACTION_DETAIL) {
    const sessionId = value.session_id;
    if (typeof sessionId !== 'string' || !sessionId) {
      return errorToast('card.dashboard.sessions.session_not_found', undefined, locale);
    }
    const r = await safeGetSessionsList(client, locale, pathSuffix);
    if ('errorResult' in r) return r.errorResult;
    const row = r.rows.find(s => s.sessionId === sessionId);
    if (!row) {
      return errorToast('card.dashboard.sessions.session_not_found', undefined, locale);
    }
    const detail = composeDetail(row, now());
    const cardJson = buildSessionsDetailCard(detail, {
      invokerOpenId: operatorOpenId,
      locale,
      nowMs: now(),
      origin: navOrigin,
      pageSize: navPageSize,
      sourcePage: navPage,
      scope: navScope,
      terminalUrl: buildSessionTerminalUrl(row),
      feishuChatLink: row.feishuChatLink ?? null,
    });
    return { card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> } };
  }

  // ─── 3b) CLOSE — synchronous close, in-process overlay, redraw ──────
  if (action === SESSIONS_ACTION_CLOSE) {
    const sessionId = value.session_id;
    if (typeof sessionId !== 'string' || !sessionId) {
      return errorToast('card.dashboard.sessions.session_not_found', undefined, locale);
    }
    // Pre-POST snapshot confirms the row still exists and lets us synthesize
    // the closed-state card without racing list propagation.
    const pre = await safeGetSessionsList(client, locale, pathSuffix);
    if ('errorResult' in pre) return pre.errorResult;
    const before = pre.rows.find(s => s.sessionId === sessionId);
    if (!before) {
      return errorToast('card.dashboard.sessions.session_not_found', undefined, locale);
    }

    // Client-side `disabled` is UX only; replayed or crafted callbacks can
    // still arrive. Re-run the same availability matrix server-side and
    // fail closed before POSTing.
    const beforeDetail = composeDetail(before, now());
    if (beforeDetail.actions.close.enabled !== true) {
      // Reuse the same reasonKey → i18n mapping the builder uses
      // for the inline disabled-button note (`mapCloseDisabledReason`) so
      // toast text matches what the user already sees on the card. NEVER
      // POST; NEVER redraw the card.
      const mappedKey = mapCloseDisabledReason(beforeDetail.actions.close.reasonKey)
        ?? 'card.dashboard.sessions.close_failed';
      return errorToast(mappedKey, undefined, locale);
    }

    // Route B owner routing is the authority on whether this session can be
    // closed; we only sanitize the routing key above.
    let resp: Awaited<ReturnType<DaemonClient['request']>>;
    try {
      resp = await client.request({
        method: 'POST',
        path: `/__daemon/sessions/${encodeURIComponent(sessionId)}/close${pathSuffix}`,
      });
    } catch (e) {
      return errorToast('card.dashboard.sessions.close_failed', { reason: (e as Error).message }, locale);
    }
    if (resp.status !== 200) {
      const body = (resp.body ?? {}) as Record<string, unknown>;
      const reason = String(body.error ?? `http_${resp.status}`);
      // Preserve user state — do NOT redraw card on failure.
      return errorToast('card.dashboard.sessions.close_failed', { reason }, locale);
    }

    // Synthesize the closed-state row from the pre-POST snapshot. Merge
    // closedAt/cliResumeCommand from the close response if the upstream
    // ever surfaces them (defensive — current closeSession returns only
    // `{ ok, alreadyClosed }`, but the proxy may evolve).
    const body = (resp.body ?? {}) as Record<string, unknown>;
    const synthClosedAt: number | undefined =
      typeof body.closedAt === 'number' && Number.isFinite(body.closedAt)
        ? body.closedAt
        : (typeof body.closedAt === 'string' && Number.isFinite(Date.parse(body.closedAt))
            ? Date.parse(body.closedAt)
            : (before.closedAt ?? now()));
    // Clear port fields so the closed-state detail card never advertises a
    // dead Web Terminal URL even if the daemon row still has stale ports.
    const synth: SessionRow = {
      ...before,
      status: 'closed',
      closedAt: synthClosedAt,
      webPort: null,
      proxyPort: undefined,
    };
    const detail = composeDetail(synth, now());
    const cardJson = buildSessionsDetailCard(detail, {
      invokerOpenId: operatorOpenId,
      locale,
      nowMs: now(),
      origin: navOrigin,
      pageSize: navPageSize,
      sourcePage: navPage,
      scope: navScope,
      terminalUrl: buildSessionTerminalUrl(synth),
      feishuChatLink: synth.feishuChatLink ?? null,
    });
    return { card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> } };
  }

  // ─── 3b2) LOCATE — POST + toast-only (thread-scope only) ────────────
  // Sync block: await POST → success toast (or error toast on non-200 /
  // network throw). Card is NEVER redrawn — UX matches the Web dashboard's
  // "fire a locate notification" behavior.
  //
  // Chat-scope sessions must not hit the notification POST path. Builder
  // output uses a direct `multi_url`, but replayed or crafted callbacks can
  // still arrive, so re-check the fresh row before posting.
  if (action === SESSIONS_ACTION_LOCATE) {
    const sessionId = value.session_id;
    if (typeof sessionId !== 'string' || !sessionId) {
      return errorToast('card.dashboard.sessions.session_not_found', undefined, locale);
    }
    const pre = await safeGetSessionsList(client, locale, pathSuffix);
    if ('errorResult' in pre) return pre.errorResult;
    const row = pre.rows.find(s => s.sessionId === sessionId);
    if (!row) {
      return errorToast('card.dashboard.sessions.session_not_found', undefined, locale);
    }
    const beforeDetail = composeDetail(row, now());
    if (beforeDetail.actions.locateMode !== 'openTopic') {
      // chat-scope: refuse to POST. Surface a locate_failed with an
      // explicit reason so the test can pin the gate behavior.
      return errorToast(
        'card.dashboard.sessions.locate_failed',
        { reason: 'chat_scope_not_supported' },
        locale,
      );
    }
    let resp: Awaited<ReturnType<DaemonClient['request']>>;
    try {
      resp = await client.request({
        method: 'POST',
        path: `/__daemon/sessions/${encodeURIComponent(sessionId)}/locate${pathSuffix}`,
      });
    } catch (e) {
      return errorToast('card.dashboard.sessions.locate_failed', { reason: (e as Error).message }, locale);
    }
    if (resp.status !== 200) {
      const body = (resp.body ?? {}) as Record<string, unknown>;
      const reason = String(body.error ?? `http_${resp.status}`);
      return errorToast('card.dashboard.sessions.locate_failed', { reason }, locale);
    }
    return { toast: { type: 'success', content: t('card.dashboard.sessions.locate.success', undefined, locale) } };
  }

  // ─── 3b3) RESUME — server-side matrix check, sync POST, 2nd GET ──────
  // closed → idle/active. Mirrors the close path but inverted: pre-GET
  // confirms session exists and resume is matrix-permitted; on success
  // we issue a 2nd GET to read the post-resume row (status/webPort/proxyPort
  // all change), falling back to a synth only when the row vanished.
  if (action === SESSIONS_ACTION_RESUME) {
    const sessionId = value.session_id;
    if (typeof sessionId !== 'string' || !sessionId) {
      return errorToast('card.dashboard.sessions.session_not_found', undefined, locale);
    }
    const pre = await safeGetSessionsList(client, locale, pathSuffix);
    if ('errorResult' in pre) return pre.errorResult;
    const before = pre.rows.find(s => s.sessionId === sessionId);
    if (!before) {
      return errorToast('card.dashboard.sessions.session_not_found', undefined, locale);
    }
    // Re-run the availability matrix against the fresh snapshot. A replayed
    // event on an active session must not POST resume.
    const beforeDetail = composeDetail(before, now());
    if (beforeDetail.actions.resume.enabled !== true) {
      const mappedKey = mapResumeDisabledReason(beforeDetail.actions.resume.reasonKey)
        ?? 'card.dashboard.sessions.resume_failed';
      return errorToast(mappedKey, undefined, locale);
    }

    let resp: Awaited<ReturnType<DaemonClient['request']>>;
    try {
      resp = await client.request({
        method: 'POST',
        path: `/__daemon/sessions/${encodeURIComponent(sessionId)}/resume${pathSuffix}`,
      });
    } catch (e) {
      return errorToast('card.dashboard.sessions.resume_failed', { reason: (e as Error).message }, locale);
    }
    if (resp.status !== 200) {
      const body = (resp.body ?? {}) as Record<string, unknown>;
      const reason = String(body.error ?? `http_${resp.status}`);
      return errorToast('card.dashboard.sessions.resume_failed', { reason }, locale);
    }

    // 2nd GET — read the fresh row. Resume regenerates worker port + can
    // toggle status to 'idle' or 'starting', so we don't synth this; we
    // refetch. If the refetch fails OR the row vanished (unlikely — resume
    // creates a NEW session id in some flows; but our resume verb keeps the
    // same id), fall back to a synth with cleared closedAt and a hint
    // status. The fresh row may be one render-cycle stale; the next user
    // interaction will converge it.
    const postRefetch = await safeGetSessionsList(client, locale, pathSuffix);
    let after: SessionRow | undefined;
    if (!('errorResult' in postRefetch)) {
      after = postRefetch.rows.find(s => s.sessionId === sessionId);
    }
    if (!after) {
      // Fallback: synth a minimally-recovered row. status='idle' is the
      // most likely post-resume state for a session that just came up;
      // the actual status may differ — one render of staleness, then the
      // next refresh converges.
      after = { ...before, status: 'idle', closedAt: undefined };
    }
    const detail = composeDetail(after, now());
    const cardJson = buildSessionsDetailCard(detail, {
      invokerOpenId: operatorOpenId,
      locale,
      nowMs: now(),
      origin: navOrigin,
      pageSize: navPageSize,
      sourcePage: navPage,
      scope: navScope,
      terminalUrl: buildSessionTerminalUrl(after),
      feishuChatLink: after.feishuChatLink ?? null,
    });
    return { card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> } };
  }

  // ─── 3c) BACK TO LIST — rebuild list card at page 1 ─────────────────
  if (action === SESSIONS_ACTION_BACK_TO_LIST) {
    const r = await safeGetSessionsList(client, locale, pathSuffix);
    if ('errorResult' in r) return r.errorResult;
    const cardJson = buildSessionsCard(
      r.rows,
      {
        invokerOpenId: operatorOpenId,
        locale,
        page: navPage ?? 1,
        pageSize: navPageSize,
        origin: navOrigin,
        scope: navScope,
      },
      now(),
    );
    return { card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> } };
  }

  // ─── 3d) REFRESH + PAGE actions ─────────────────────────────────────
  // `action` is already constrained to validActions above; the only ones
  // left here are REFRESH + PAGE (the other 3 returned early).
  let page = 1;
  if (action === SESSIONS_ACTION_PAGE) {
    // Page comes from value.page (prev/next button) OR action.option
    // (select_static "jump to page" picker). Same action key, different
    // dispatch field — handler converges on one branch.
    const raw = value.page ?? (data.action as { option?: string } | undefined)?.option ?? '1';
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) page = parsed;
  }

  const r = await safeGetSessionsList(client, locale, pathSuffix);
  if ('errorResult' in r) return r.errorResult;
  const cardJson = buildSessionsCard(
    r.rows,
    {
      invokerOpenId: operatorOpenId,
      locale,
      page,
      pageSize: navPageSize,
      origin: navOrigin,
      scope: navScope,
    },
    now(),
  );
  return {
    // Card-only success path — see settings-card.ts docblock for why no toast.
    card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> },
  };
}

/**
 * GET `/__daemon/sessions-list` and surface non-200 / network errors as
 * caller-facing error toasts. Returns either `{ rows }` or
 * `{ errorResult }` — exactly one is set.
 *
 * createDaemonClient.request resolves 4xx/5xx responses, so status must be
 * checked explicitly. Otherwise a backend failure would look like an empty
 * sessions list.
 */
async function safeGetSessionsList(
  client: DaemonClient,
  locale: Locale,
  pathSuffix = '',
): Promise<{ rows: ReadonlyArray<SessionRow> } | { errorResult: SessionsCardHandlerResult }> {
  let r: Awaited<ReturnType<DaemonClient['request']>>;
  try {
    r = await client.request({ method: 'GET', path: `/__daemon/sessions-list${pathSuffix}` });
  } catch (e) {
    return { errorResult: errorToast('card.dashboard.sessions.list_failed', { reason: (e as Error).message }, locale) };
  }
  if (r.status !== 200) {
    const reason = String((r.body as Record<string, unknown> | undefined)?.error ?? `http_${r.status}`);
    return { errorResult: errorToast('card.dashboard.sessions.list_failed', { reason }, locale) };
  }
  const rows = ((r.body as { sessions?: ReadonlyArray<SessionRow> })?.sessions) ?? [];
  return { rows };
}
