/**
 * Schedules list card (PR3 `/dashboard schedules` slice 1).
 *
 * Read-only list + pagination + refresh. NO run-now / pause / resume / delete
 * / edit / create / search / filter in this slice. Codex scope-cut on
 * 2026-06-09: those need an action-state pattern (optimistic-state +
 * rollback) which we'll design once and reuse across modules.
 *
 * Identity / security mirrors sessions-card.ts (slice 1):
 *  - `invokerOpenId` is the owner's `ou_*` (invoker-lock anchor).
 *  - Owner gate runs at the command entry AND on every callback.
 *  - sender union_id NEVER lands on action.value.
 *
 * Response: success returns `{ card }` only (no toast) — single-pass render,
 * no stale-frame flash. Errors / permission denials return `{ toast }`.
 */

import { getOwnerOpenId as defaultGetOwnerOpenId } from '../../bot-registry.js';
import type {
  ScheduleCardTaskInput,
  ScheduleRowDto,
} from '../../dashboard/schedule-card-model.js';
import {
  paginateSchedules,
  toScheduleRowDto,
} from '../../dashboard/schedule-card-model.js';
import type { DaemonClient } from '../../dashboard/daemon-internal-client.js';
import { type Locale, t } from '../../i18n/index.js';

import type { CardActionData } from './card-handler.js';

export const SCHEDULES_ACTION_REFRESH = 'dash_schedules_refresh' as const;
export const SCHEDULES_ACTION_PAGE = 'dash_schedules_page' as const;

const PAGE_SIZE = 10;

function toneIcon(tone: string): string {
  switch (tone) {
    case 'success': return '🟢';
    case 'info':    return '🔵';
    case 'warning': return '🟡';
    case 'danger':  return '🔴';
    case 'neutral': return '⚪';
    default:        return '⚫';
  }
}

/**
 * Sort schedules per the Web UI semantics:
 *  - enabled first (paused tasks sink),
 *  - then by earliest `nextRunAt` (ISO string compare works because ISO
 *    strings sort lexicographically same as chronologically).
 *  - tasks without `nextRunAt` sort last within their enabled group.
 */
function sortForList(tasks: ReadonlyArray<ScheduleCardTaskInput>): ScheduleCardTaskInput[] {
  return tasks.slice().sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    const an = a.nextRunAt ?? '';
    const bn = b.nextRunAt ?? '';
    if (an === bn) return 0;
    if (!an) return 1;
    if (!bn) return -1;
    return an < bn ? -1 : 1;
  });
}

export interface BuildSchedulesCardOpts {
  invokerOpenId: string;
  locale: Locale;
  /** 1-based page index. Caller clamps; this just renders what's given. */
  page: number;
}

/** Build the schedules list card JSON. Pure (sorts + paginates + renders). */
export function buildSchedulesCard(
  tasks: ReadonlyArray<ScheduleCardTaskInput>,
  opts: BuildSchedulesCardOpts,
  nowMs: number,
): string {
  const sorted = sortForList(tasks);
  const { items, total, page, totalPages } = paginateSchedules(sorted, opts.page, PAGE_SIZE);

  const enabledCount = sorted.filter(t => t.enabled).length;
  const pausedCount = total - enabledCount;

  const elements: unknown[] = [];

  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: t(
        'card.dashboard.schedules.count_summary',
        {
          enabled: String(enabledCount),
          paused: String(pausedCount),
          page: String(page),
          totalPages: String(totalPages),
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
        content: t('card.dashboard.schedules.empty', undefined, opts.locale),
      },
    });
  } else {
    for (const task of items) {
      const dto = toScheduleRowDto(task, { nowMs });
      elements.push(renderRow(dto, opts.locale));
    }
  }

  elements.push({ tag: 'hr' });

  // Pagination + refresh.
  const actions: unknown[] = [];
  if (totalPages > 1) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.dashboard.schedules.prev', undefined, opts.locale) },
      type: 'default',
      disabled: page <= 1,
      value: {
        action: SCHEDULES_ACTION_PAGE,
        invoker_open_id: opts.invokerOpenId,
        page: String(Math.max(1, page - 1)),
      },
    });
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.dashboard.schedules.next', undefined, opts.locale) },
      type: 'default',
      disabled: page >= totalPages,
      value: {
        action: SCHEDULES_ACTION_PAGE,
        invoker_open_id: opts.invokerOpenId,
        page: String(Math.min(totalPages, page + 1)),
      },
    });
  }
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t('card.dashboard.schedules.refresh', undefined, opts.locale) },
    type: 'default',
    value: {
      action: SCHEDULES_ACTION_REFRESH,
      invoker_open_id: opts.invokerOpenId,
    },
  });
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
      title: { tag: 'plain_text', content: t('card.dashboard.schedules.title', undefined, opts.locale) },
      template: 'blue',
    },
    elements,
  });
}

function renderRow(row: ScheduleRowDto, locale: Locale): unknown {
  const icon = toneIcon(row.dot.tone);
  const errorGlyph = row.errorIndicator ? ' ⚠️' : '';
  // Primary: status icon + bold name + short id (8 chars) for traceability —
  // schedules can share names (e.g. two `daily-ping` cron tasks in different
  // chats), so we surface a stable disambiguator.
  // Secondary: kind · displayExpr · next · last (· repeat counter if finite)
  const shortId = row.id ? row.id.slice(0, 8) : '';
  const repeatStr =
    row.repeat
      ? row.repeat.times === null
        ? `${row.repeat.completed}/∞`
        : `${row.repeat.completed}/${row.repeat.times}`
      : undefined;
  const secondaryParts: string[] = [
    row.kind,
    row.displayExpr,
    t('card.dashboard.schedules.next_label', { rel: row.nextRunRelative }, locale),
    t('card.dashboard.schedules.last_label', { rel: row.lastRunRelative }, locale),
  ];
  if (repeatStr) {
    secondaryParts.push(t('card.dashboard.schedules.repeat_label', { repeat: repeatStr }, locale));
  }

  const idSuffix = shortId ? ` <font color="grey">${escapeLarkMd(shortId)}</font>` : '';
  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content:
        `${icon} **${escapeLarkMd(row.name)}**${idSuffix}${errorGlyph}` +
        `\n<font color="grey">${escapeLarkMd(secondaryParts.join(' · '))}</font>`,
    },
  };
}

/**
 * Sanitize user-/CLI-supplied text for inclusion in lark_md. See
 * `sessions-card.ts:escapeLarkMd` for the order rationale: `&` first to
 * avoid `&` → `&amp;` then `<` → `&lt;` getting re-encoded as `&amp;lt;`.
 */
function escapeLarkMd(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_~`])/g, '\\$1');
}

/** ─── Handler ─────────────────────────────────────────────────────────── */

export interface SchedulesCardHandlerDeps {
  getOwnerOpenId?: (larkAppId: string) => string | undefined;
  createClient: (larkAppId: string) => DaemonClient;
  locale?: Locale;
  /** Override `Date.now()` so tests are deterministic. */
  nowMs?: () => number;
}

export interface SchedulesCardHandlerResult {
  toast?: { type: 'info' | 'success' | 'error'; content: string };
  card?: { type: 'raw'; data: Record<string, unknown> };
}

function ackToast(textKey: string, locale: Locale): SchedulesCardHandlerResult {
  return { toast: { type: 'info', content: t(textKey, undefined, locale) } };
}

function errorToast(textKey: string, params: Record<string, string> | undefined, locale: Locale): SchedulesCardHandlerResult {
  return { toast: { type: 'error', content: t(textKey, params, locale) } };
}

/** Dispatch a `dash_schedules_*` action callback. Mirrors sessions-card. */
export async function handleSchedulesCardAction(
  data: CardActionData,
  larkAppId: string,
  deps: SchedulesCardHandlerDeps,
): Promise<SchedulesCardHandlerResult> {
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

  // Resolve target page.
  let page = 1;
  if (action === SCHEDULES_ACTION_PAGE) {
    const parsed = Number.parseInt(value.page ?? '1', 10);
    if (Number.isFinite(parsed) && parsed >= 1) page = parsed;
  } else if (action !== SCHEDULES_ACTION_REFRESH) {
    return ackToast('card.dashboard.settings.invalid_action', locale);
  }

  // GET list + rebuild card. Same non-200 handling as sessions slice 1
  // (codex blocker #1, 2026-06-09): 4xx/5xx → error toast, NOT empty list.
  let r: Awaited<ReturnType<DaemonClient['request']>>;
  try {
    const client = deps.createClient(larkAppId);
    r = await client.request({ method: 'GET', path: '/__daemon/schedules-list' });
  } catch (e) {
    return errorToast('card.dashboard.schedules.list_failed', { reason: (e as Error).message }, locale);
  }
  if (r.status !== 200) {
    const reason = String((r.body as any)?.error ?? `http_${r.status}`);
    return errorToast('card.dashboard.schedules.list_failed', { reason }, locale);
  }
  const tasks = ((r.body as { schedules?: ReadonlyArray<ScheduleCardTaskInput> })?.schedules) ?? [];
  const nowMs = deps.nowMs ? deps.nowMs() : Date.now();
  const cardJson = buildSchedulesCard(tasks, { invokerOpenId: expectedOwner, locale, page }, nowMs);
  return {
    card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> },
  };
}
