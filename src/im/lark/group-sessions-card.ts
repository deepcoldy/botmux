/**
 * `/sessions` current-chat session card.
 *
 * This is intentionally separate from the owner-only `/dashboard sessions`
 * card.  The public group card exposes only a title, status, recent activity,
 * and CLI/runtime label.  It never renders a working directory, full session
 * id, or terminal link. The only mutation is admin-only closed-session resume.
 *
 * Security model:
 *  - every row is freshly filtered by exact larkAppId + chatId + thread scope;
 *  - callback values are untrusted routing hints only;
 *  - callback operator must match the card's bound invoker;
 *  - the clicked card's Lark message is resolved back to its real chat before
 *    any list/locate action;
 *  - legacy locate sends an expected-session guard to the owning daemon, which
 *    closes the GET-to-POST transfer/close race.
 */

import type { DaemonClient } from '../../dashboard/daemon-internal-client.js';
import { isDashboardAdmin, type DashboardAdminLookupDeps } from '../../dashboard/dashboard-admins.js';
import { composeEntries, paginate, sortByStatus } from '../../dashboard/session-card-model.js';
import type { SessionRow } from '../../core/dashboard-rows.js';
import { type Locale, t } from '../../i18n/index.js';
import { scheduleTimeZone } from '../../utils/timezone.js';
import { getMessageChatId as defaultGetMessageChatId } from './client.js';
import type { CardActionData } from './card-handler.js';
import { STREAM_STATUS_TEMPLATE_ICON, STREAM_STATUS_TEMPLATE_MAP } from './stream-status-palette.js';

export const GROUP_SESSIONS_ACTION_REFRESH = 'group_sessions_refresh' as const;
export const GROUP_SESSIONS_ACTION_PAGE = 'group_sessions_page' as const;
export const GROUP_SESSIONS_ACTION_LOCATE = 'group_sessions_locate' as const;
export const GROUP_SESSIONS_ACTION_RESUME = 'group_sessions_resume' as const;

const PAGE_SIZE = 5;
const GROUP_SESSIONS_ACTIONS = new Set<string>([
  GROUP_SESSIONS_ACTION_REFRESH,
  GROUP_SESSIONS_ACTION_PAGE,
  GROUP_SESSIONS_ACTION_LOCATE,
  GROUP_SESSIONS_ACTION_RESUME,
]);

export interface GroupSessionsScope {
  larkAppId: string;
  chatId: string;
}

/** Exact bot/chat/thread scope used on initial render and every callback. */
export function filterGroupSessions(
  rows: ReadonlyArray<SessionRow>,
  scope: GroupSessionsScope,
): SessionRow[] {
  return rows.filter(row =>
    row.larkAppId === scope.larkAppId
    && row.chatId === scope.chatId
    && row.scope === 'thread',
  );
}

function escapeLarkMd(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_~`])/g, '\\$1');
}

function statusIcon(status: string): string {
  if (status === 'dormant' || status === 'closed') return '⚫';
  if (status in STREAM_STATUS_TEMPLATE_MAP) {
    const template = STREAM_STATUS_TEMPLATE_MAP[status as keyof typeof STREAM_STATUS_TEMPLATE_MAP];
    return STREAM_STATUS_TEMPLATE_ICON[template];
  }
  return '⚪';
}

function statusLabel(status: string, locale: Locale): string {
  switch (status) {
    case 'working': return t('card.status.working', undefined, locale);
    case 'analyzing': return t('card.status.analyzing', undefined, locale);
    case 'starting': return t('card.status.starting', undefined, locale);
    case 'limited': return t('card.status.limited', undefined, locale);
    case 'stalled': return t('card.status.stalled', undefined, locale);
    case 'idle': return t('card.status.idle', undefined, locale);
    case 'dormant': return t('card.status.dormant', undefined, locale);
    case 'closed': return t('card.group_sessions.status_closed', undefined, locale);
    default: return t('card.group_sessions.status_unknown', undefined, locale);
  }
}

function relativeTime(fromMs: number, nowMs: number, locale: Locale): string {
  const diff = nowMs - fromMs;
  if (!Number.isFinite(diff) || diff < 0) {
    return t('card.group_sessions.time.just_now', undefined, locale);
  }
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return t('card.group_sessions.time.seconds', { n: seconds }, locale);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('card.group_sessions.time.minutes', { n: minutes }, locale);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('card.group_sessions.time.hours', { n: hours }, locale);
  return t('card.group_sessions.time.days', { n: Math.floor(hours / 24) }, locale);
}

function topicMultiUrl(url: string): Record<string, string> {
  return { url, pc_url: url, android_url: url, ios_url: url };
}

export interface BuildGroupSessionsCardOpts extends GroupSessionsScope {
  invokerOpenId: string;
  /** Write affordance only. The callback independently rechecks admin access. */
  canResume?: boolean;
  locale: Locale;
  page: number;
  timeZone?: string;
}

function snapshotTime(nowMs: number, locale: Locale, timeZone = scheduleTimeZone()): string {
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-GB', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
    timeZoneName: 'short',
  }).format(new Date(nowMs));
}

/** Build the compact current-group card from already bot-scoped Route B rows. */
export function buildGroupSessionsCard(
  rawRows: ReadonlyArray<SessionRow>,
  opts: BuildGroupSessionsCardOpts,
  nowMs: number,
): string {
  const filtered = filterGroupSessions(rawRows, opts);
  const sortedRows = sortByStatus(composeEntries(filtered)).map(entry => entry.raw);
  const { items, meta } = paginate(sortedRows, opts.page, PAGE_SIZE);
  const activeCount = filtered.filter(row => row.status !== 'closed').length;
  const closedCount = filtered.length - activeCount;
  const elements: unknown[] = [{
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: t('card.group_sessions.summary', {
        active: activeCount,
        closed: closedCount,
        page: meta.page,
        totalPages: meta.totalPages,
      }, opts.locale),
    },
  }, { tag: 'hr' }];

  if (items.length === 0) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: t('card.group_sessions.empty', undefined, opts.locale) },
    });
  } else {
    for (const row of items) {
      const title = row.title?.trim() || t('card.group_sessions.untitled', undefined, opts.locale);
      const cli = row.runtimeDisplayName?.trim() || String(row.cliId || 'unknown');
      const recent = relativeTime(row.lastMessageAt, nowMs, opts.locale);
      const titleLine = row.status === 'closed'
        ? `<font color="grey">**${escapeLarkMd(title.slice(0, 80))}**</font>`
        : `**${escapeLarkMd(title.slice(0, 80))}**`;
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content:
            `${statusIcon(row.status)} ${titleLine}\n`
            + `<font color="grey">${escapeLarkMd(statusLabel(row.status, opts.locale))}`
            + ` · ${escapeLarkMd(cli)} · ${escapeLarkMd(recent)}</font>`,
        },
      });

      const button: Record<string, unknown> = {
        tag: 'button',
        text: { tag: 'plain_text', content: t('card.group_sessions.open_topic', undefined, opts.locale) },
        type: 'default',
      };
      if (row.feishuThreadLink) {
        button.multi_url = topicMultiUrl(row.feishuThreadLink);
      } else {
        button.text = { tag: 'plain_text', content: t('card.group_sessions.locate_topic', undefined, opts.locale) };
        button.value = {
          action: GROUP_SESSIONS_ACTION_LOCATE,
          invoker_open_id: opts.invokerOpenId,
          chat_id: opts.chatId,
          session_id: row.sessionId,
          page: String(meta.page),
        };
      }
      const rowActions: Record<string, unknown>[] = [button];
      if (row.status === 'closed' && opts.canResume === true) {
        rowActions.push({
          tag: 'button',
          text: { tag: 'plain_text', content: t('card.group_sessions.resume', undefined, opts.locale) },
          type: 'primary',
          value: {
            action: GROUP_SESSIONS_ACTION_RESUME,
            invoker_open_id: opts.invokerOpenId,
            chat_id: opts.chatId,
            session_id: row.sessionId,
            page: String(meta.page),
          },
          confirm: {
            title: { tag: 'plain_text', content: t('card.group_sessions.resume_confirm_title', undefined, opts.locale) },
            text: {
              tag: 'plain_text',
              content: t('card.group_sessions.resume_confirm_text', { title: title.slice(0, 80) }, opts.locale),
            },
          },
        });
      }
      elements.push({ tag: 'action', actions: rowActions });
    }
  }

  elements.push({ tag: 'hr' });
  const actions: unknown[] = [];
  if (meta.totalPages > 1) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.group_sessions.prev', undefined, opts.locale) },
      type: 'default',
      disabled: meta.page <= 1,
      value: {
        action: GROUP_SESSIONS_ACTION_PAGE,
        invoker_open_id: opts.invokerOpenId,
        chat_id: opts.chatId,
        page: String(Math.max(1, meta.page - 1)),
      },
    }, {
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.group_sessions.next', undefined, opts.locale) },
      type: 'default',
      disabled: meta.page >= meta.totalPages,
      value: {
        action: GROUP_SESSIONS_ACTION_PAGE,
        invoker_open_id: opts.invokerOpenId,
        chat_id: opts.chatId,
        page: String(Math.min(meta.totalPages, meta.page + 1)),
      },
    });
  }
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t('card.group_sessions.refresh', undefined, opts.locale) },
    type: 'default',
    value: {
      action: GROUP_SESSIONS_ACTION_REFRESH,
      invoker_open_id: opts.invokerOpenId,
      chat_id: opts.chatId,
      page: String(meta.page),
    },
  });
  elements.push({ tag: 'action', actions });
  elements.push({
    tag: 'note',
    elements: [{
      tag: 'lark_md',
      content: t('card.group_sessions.footer', { time: snapshotTime(nowMs, opts.locale, opts.timeZone) }, opts.locale),
    }],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t('card.group_sessions.title', undefined, opts.locale) },
      template: 'blue',
    },
    elements,
  });
}

export interface GroupSessionsCardHandlerDeps extends DashboardAdminLookupDeps {
  createClient: (larkAppId: string) => DaemonClient;
  getMessageChatId?: (larkAppId: string, messageId: string) => Promise<string | null>;
  locale?: Locale;
  nowMs?: () => number;
}

export interface GroupSessionsCardHandlerResult {
  toast?: { type: 'info' | 'success' | 'error'; content: string };
  card?: { type: 'raw'; data: Record<string, unknown> };
}

function info(key: string, locale: Locale): GroupSessionsCardHandlerResult {
  return { toast: { type: 'info', content: t(key, undefined, locale) } };
}

function error(
  key: string,
  params: Record<string, string | number> | undefined,
  locale: Locale,
): GroupSessionsCardHandlerResult {
  return { toast: { type: 'error', content: t(key, params, locale) } };
}

async function getScopedRows(
  client: DaemonClient,
  scope: GroupSessionsScope,
  locale: Locale,
): Promise<{ rows: SessionRow[] } | { errorResult: GroupSessionsCardHandlerResult }> {
  try {
    const response = await client.request({ method: 'GET', path: '/__daemon/sessions-list?fresh=1' });
    if (response.status !== 200) {
      const reason = String((response.body as Record<string, unknown> | undefined)?.error ?? `http_${response.status}`);
      return { errorResult: error('card.group_sessions.list_failed', { reason }, locale) };
    }
    const rows = ((response.body as { sessions?: ReadonlyArray<SessionRow> })?.sessions) ?? [];
    return { rows: filterGroupSessions(rows, scope) };
  } catch (cause) {
    return { errorResult: error('card.group_sessions.list_failed', { reason: (cause as Error).message }, locale) };
  }
}

/** Handle refresh/page and legacy locate callbacks for `/sessions`. */
export async function handleGroupSessionsCardAction(
  data: CardActionData,
  larkAppId: string,
  deps: GroupSessionsCardHandlerDeps,
): Promise<GroupSessionsCardHandlerResult> {
  const locale = deps.locale ?? 'zh';
  const value = (data.action?.value ?? {}) as Record<string, string>;
  const operatorOpenId = data.operator?.open_id;
  if (!operatorOpenId || !value.invoker_open_id || operatorOpenId !== value.invoker_open_id) {
    return info('card.group_sessions.not_invoker', locale);
  }

  const action = value.action;
  if (!GROUP_SESSIONS_ACTIONS.has(action)) {
    return error('card.group_sessions.invalid_action', undefined, locale);
  }
  const chatId = value.chat_id;
  const cardMessageId = data.context?.open_message_id ?? data.open_message_id;
  if (!chatId || !cardMessageId) {
    return error('card.group_sessions.binding_invalid', undefined, locale);
  }
  const resolveMessageChat = deps.getMessageChatId ?? defaultGetMessageChatId;
  const actualChatId = await resolveMessageChat(larkAppId, cardMessageId);
  if (!actualChatId || actualChatId !== chatId) {
    return error('card.group_sessions.binding_invalid', undefined, locale);
  }

  const canResume = isDashboardAdmin(larkAppId, operatorOpenId, deps);
  if (action === GROUP_SESSIONS_ACTION_RESUME && !canResume) {
    return info('card.group_sessions.resume_owner_only', locale);
  }

  const client = deps.createClient(larkAppId);
  const scoped = await getScopedRows(client, { larkAppId, chatId }, locale);
  if ('errorResult' in scoped) return scoped.errorResult;

  if (action === GROUP_SESSIONS_ACTION_RESUME) {
    const sessionId = value.session_id;
    const row = sessionId ? scoped.rows.find(candidate => candidate.sessionId === sessionId) : undefined;
    if (!row || row.status !== 'closed') {
      return error('card.group_sessions.resume_unavailable', undefined, locale);
    }
    try {
      const response = await client.request({
        method: 'POST',
        path: `/__daemon/sessions/${encodeURIComponent(row.sessionId)}/resume`,
      });
      if (response.status !== 200 || (response.body as { ok?: boolean } | undefined)?.ok !== true) {
        const reason = String((response.body as Record<string, unknown> | undefined)?.error ?? `http_${response.status}`);
        return error('card.group_sessions.resume_failed', { reason }, locale);
      }
      const refreshed = await getScopedRows(client, { larkAppId, chatId }, locale);
      if ('errorResult' in refreshed) {
        return { toast: { type: 'success', content: t('card.group_sessions.resume_success', undefined, locale) } };
      }
      const refreshedRow = refreshed.rows.find(candidate => candidate.sessionId === row.sessionId);
      const rowsAfterResume = refreshedRow
        ? refreshed.rows.map(candidate => candidate.sessionId === row.sessionId && candidate.status === 'closed'
          ? { ...candidate, status: 'idle' as const, closedAt: undefined }
          : candidate)
        : [...refreshed.rows, { ...row, status: 'idle' as const, closedAt: undefined }];
      const cardJson = buildGroupSessionsCard(rowsAfterResume, {
        larkAppId,
        chatId,
        invokerOpenId: operatorOpenId,
        canResume,
        locale,
        page: 1,
      }, deps.nowMs ? deps.nowMs() : Date.now());
      return { card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> } };
    } catch (cause) {
      return error('card.group_sessions.resume_failed', { reason: (cause as Error).message }, locale);
    }
  }

  if (action === GROUP_SESSIONS_ACTION_LOCATE) {
    const sessionId = value.session_id;
    const row = sessionId ? scoped.rows.find(candidate => candidate.sessionId === sessionId) : undefined;
    if (!row) return error('card.group_sessions.session_not_found', undefined, locale);
    try {
      const response = await client.request({
        method: 'POST',
        path: `/__daemon/sessions/${encodeURIComponent(row.sessionId)}/locate`,
        body: {
          expectedLarkAppId: larkAppId,
          expectedChatId: chatId,
          expectedScope: 'thread',
          expectedOpen: row.status !== 'closed',
        },
      });
      if (response.status !== 200 || (response.body as { ok?: boolean } | undefined)?.ok !== true) {
        const reason = String((response.body as Record<string, unknown> | undefined)?.error ?? `http_${response.status}`);
        return error('card.group_sessions.locate_failed', { reason }, locale);
      }
      return { toast: { type: 'success', content: t('card.group_sessions.locate_success', undefined, locale) } };
    } catch (cause) {
      return error('card.group_sessions.locate_failed', { reason: (cause as Error).message }, locale);
    }
  }

  const parsedPage = Number.parseInt(value.page ?? '1', 10);
  const page = Number.isFinite(parsedPage) && parsedPage >= 1 ? parsedPage : 1;
  const cardJson = buildGroupSessionsCard(scoped.rows, {
    larkAppId,
    chatId,
    invokerOpenId: operatorOpenId,
    canResume,
    locale,
    page,
  }, deps.nowMs ? deps.nowMs() : Date.now());
  return { card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> } };
}
