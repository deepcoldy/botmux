/**
 * `/sessions` current-chat session card.
 *
 * This is intentionally separate from the owner-only `/dashboard sessions`
 * card.  The public group card exposes only a title, status, recent activity,
 * and CLI/runtime label.  It never renders a working directory, full session
 * id, terminal link, or mutation controls.
 *
 * Security model:
 *  - every row is freshly filtered by exact larkAppId + chatId + thread scope
 *    + non-closed status;
 *  - callback values are untrusted routing hints only;
 *  - callback operator must match the card's bound invoker;
 *  - the clicked card's Lark message is resolved back to its real chat before
 *    any list/locate action;
 *  - legacy locate sends an expected-session guard to the owning daemon, which
 *    closes the GET-to-POST transfer/close race.
 */

import type { DaemonClient } from '../../dashboard/daemon-internal-client.js';
import { composeEntries, paginate, sortByStatus } from '../../dashboard/session-card-model.js';
import type { SessionRow } from '../../core/dashboard-rows.js';
import { type Locale, t } from '../../i18n/index.js';
import { getMessageChatId as defaultGetMessageChatId } from './client.js';
import type { CardActionData } from './card-handler.js';

export const GROUP_SESSIONS_ACTION_REFRESH = 'group_sessions_refresh' as const;
export const GROUP_SESSIONS_ACTION_PAGE = 'group_sessions_page' as const;
export const GROUP_SESSIONS_ACTION_LOCATE = 'group_sessions_locate' as const;

const PAGE_SIZE = 5;
const GROUP_SESSIONS_ACTIONS = new Set<string>([
  GROUP_SESSIONS_ACTION_REFRESH,
  GROUP_SESSIONS_ACTION_PAGE,
  GROUP_SESSIONS_ACTION_LOCATE,
]);

export interface GroupSessionsScope {
  larkAppId: string;
  chatId: string;
}

/** Exact, fail-closed scope used on initial render and every callback. */
export function filterGroupSessions(
  rows: ReadonlyArray<SessionRow>,
  scope: GroupSessionsScope,
): SessionRow[] {
  return rows.filter(row =>
    row.larkAppId === scope.larkAppId
    && row.chatId === scope.chatId
    && row.scope === 'thread'
    && row.status !== 'closed',
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
  switch (status) {
    case 'working': return '🟢';
    case 'analyzing':
    case 'starting': return '🔵';
    case 'limited': return '🟡';
    case 'stalled': return '🔴';
    case 'idle': return '⚪';
    case 'dormant': return '⚫';
    default: return '⚪';
  }
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
  locale: Locale;
  page: number;
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
  const elements: unknown[] = [{
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: t('card.group_sessions.summary', {
        count: filtered.length,
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
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content:
            `${statusIcon(row.status)} **${escapeLarkMd(title.slice(0, 80))}**\n`
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
      elements.push({ tag: 'action', actions: [button] });
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
    elements: [{ tag: 'lark_md', content: t('card.group_sessions.footer', undefined, opts.locale) }],
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

export interface GroupSessionsCardHandlerDeps {
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
    const response = await client.request({ method: 'GET', path: '/__daemon/sessions-list' });
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

  const client = deps.createClient(larkAppId);
  const scoped = await getScopedRows(client, { larkAppId, chatId }, locale);
  if ('errorResult' in scoped) return scoped.errorResult;

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
          expectedOpen: true,
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
    locale,
    page,
  }, deps.nowMs ? deps.nowMs() : Date.now());
  return { card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> } };
}
