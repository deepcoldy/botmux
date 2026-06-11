/**
 * Schedules list card (PR3 `/dashboard schedules` slice 1 + slice 2a).
 *
 * Slice 1 — read-only list + pagination + refresh.
 * Slice 2a — per-row "📂 详情" button opens a detail card; detail card has
 *           "⏸ 暂停" / "▶ 恢复" (mutually exclusive) + "🔙 返回" actions.
 *
 * Detail-card pattern (codex 2026-06-10 scope-cut):
 *  - List card stays read-only beyond the "📂 详情" inline button.
 *  - All action buttons live on the detail card.
 *  - Pause/Resume are the ONLY actions this slice. Run-now lands in slice 2b.
 *
 * Sync pause/resume (NOT optimistic state):
 *  - The pause/resume callback awaits the Route B POST inline.
 *  - On 200 → synthesize the new-state row in-process (snapshot from the
 *    pre-POST GET overlaid with `enabled: !before.enabled`), then rebuild the
 *    detail card. NO toast on success — single-pass card render.
 *    Asymmetry: pause makes nextRunAt irrelevant (scheduler stops emitting),
 *    so synth is fine. Resume needs a fresh nextRunAt (computeNextRun cron /
 *    interval logic lives in scheduler.ts, NOT here), so we do a 2nd GET and
 *    fall back to synth+log if the GET fails (the row stays functional, just
 *    with a possibly-stale nextRunAt for one render cycle).
 *  - On non-200 / network throw → return ONLY a toast. We do NOT redraw the
 *    card so the user keeps their current state for retry.
 *
 * Identity / security:
 *  - `invokerOpenId` is the owner's `ou_*` and is the invoker-lock anchor.
 *  - sender union_id NEVER lands on `action.value` (red line).
 *  - Owner gate runs at the command entry AND on every callback.
 *  - `value.schedule_id` is read but NEVER trusted for identity — only used
 *    as the routing key. The owner gate is the only authority. The Route B
 *    upstream further enforces `ownerOf(schedule_id)` scope (and as of
 *    2026-06-10 also gates cross-bot pause/resume by `callerAppId`).
 *  - Before any POST we re-run the PR1 `computeButtonAvailability` matrix
 *    against the fresh snapshot and fail-closed if the chosen action is
 *    disabled — client-side `disabled` is UX only and a replayed event or an
 *    old card could otherwise drive a state-violating POST.
 *
 * Response shape mirrors `/dashboard settings` slice 3: success path returns
 * ONLY `{ card }` (no toast) so Lark renders the card in a single pass
 * (toast + card would trigger a two-pass render and flash the stale list).
 */

import { getOwnerOpenId as defaultGetOwnerOpenId } from '../../bot-registry.js';
import type {
  ScheduleCardTaskInput,
  ScheduleDetailDto,
  ScheduleRowDto,
} from '../../dashboard/schedule-card-model.js';
import {
  computeButtonAvailability,
  paginateSchedules,
  toScheduleDetailDto,
  toScheduleRowDto,
} from '../../dashboard/schedule-card-model.js';
import type { DaemonClient } from '../../dashboard/daemon-internal-client.js';
import { type Locale, t } from '../../i18n/index.js';

import type { CardActionData } from './card-handler.js';

export const SCHEDULES_ACTION_REFRESH = 'dash_schedules_refresh' as const;
export const SCHEDULES_ACTION_PAGE = 'dash_schedules_page' as const;
export const SCHEDULES_ACTION_DETAIL = 'dash_schedules_detail' as const;
export const SCHEDULES_ACTION_PAUSE = 'dash_schedules_pause' as const;
export const SCHEDULES_ACTION_RESUME = 'dash_schedules_resume' as const;
export const SCHEDULES_ACTION_BACK_TO_LIST = 'dash_schedules_back_to_list' as const;
/** Action emitted by "🔙 返回总览" on overview-origin sub-cards. Same string
 *  as overview-card's OVERVIEW_ACTION_REFRESH (kept in sync; we don't import
 *  to avoid a circular dep). */
const BACK_TO_OVERVIEW_ACTION = 'dash_overview_refresh' as const;

/** Default page size for `/dashboard schedules` (standalone AND overview
 *  drilldown — unified at 5/page across all dashboard list cards on user
 *  request 2026-06-10). `pageSize` opt still works as an override. */
const PAGE_SIZE = 5;

/** Hard cap on `select_static` jump-page option count. */
const JUMP_PAGE_MAX_OPTIONS = 50;

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
  /** Page size override. Omit → PAGE_SIZE (5; unified for standalone and
   *  drilldown 2026-06-10). Threaded through every button.value. */
  pageSize?: number;
  /** Navigation origin. `'overview'` → footer renders "🔙 返回总览" and every
   *  button.value carries `origin=overview`. Undefined → standalone card. */
  origin?: 'overview';
  /** Dashboard scope. `'global'` (2026-06-11): the `/dashboard` command
   *  family is a tool panel for the Bot Owner; schedules from any bot show
   *  up regardless of which bot dispatched the callback. Threaded onto
   *  every button.value so refresh/page/detail/back keep the scope; the
   *  handler appends `?scope=global` to every Route B GET/POST. Undefined
   *  → per-bot (back-compat default). */
  scope?: 'global';
}

/** Build the schedules list card JSON. Pure (sorts + paginates + renders). */
export function buildSchedulesCard(
  tasks: ReadonlyArray<ScheduleCardTaskInput>,
  opts: BuildSchedulesCardOpts,
  nowMs: number,
): string {
  const effectivePageSize =
    typeof opts.pageSize === 'number' && Number.isFinite(opts.pageSize) && opts.pageSize > 0
      ? Math.floor(opts.pageSize)
      : PAGE_SIZE;
  const sorted = sortForList(tasks);
  const { items, total, page, totalPages } = paginateSchedules(sorted, opts.page, effectivePageSize);

  // Plumb origin + page_size + scope onto every button.value so refresh/
  // page/detail/detail-back rebuilds keep the same drilldown state.
  const navFields: Record<string, string> = {};
  if (opts.origin === 'overview') navFields.origin = 'overview';
  if (effectivePageSize !== PAGE_SIZE) navFields.page_size = String(effectivePageSize);
  if (opts.scope === 'global') navFields.dashboard_scope = 'global';

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
      // Row text element.
      elements.push(renderRow(dto, opts.locale, opts.scope === 'global'));
      // Per-row action element holding ONLY the "📂 详情" button (slice 2a).
      // Keeping each row's actions in its own `action` element (rather than
      // one shared element for the whole page) makes the visual layout
      // align with the row above and lets us pass the row's schedule id
      // through `value.schedule_id` as the routing key.
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: t('card.dashboard.schedules.row_detail', undefined, opts.locale) },
            type: 'default',
            value: {
              action: SCHEDULES_ACTION_DETAIL,
              invoker_open_id: opts.invokerOpenId,
              schedule_id: dto.id,
              ...navFields,
            },
          },
        ],
      });
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
        ...navFields,
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
        ...navFields,
      },
    });
    // "Jump to page" select — same action as prev/next, page comes via
    // action.option. Handler reads `value.page ?? action.option ?? '1'`.
    // Capped at JUMP_PAGE_MAX_OPTIONS to keep payload small.
    if (totalPages > 2 && totalPages <= JUMP_PAGE_MAX_OPTIONS) {
      const options = Array.from({ length: totalPages }, (_, i) => {
        const n = i + 1;
        return {
          text: { tag: 'plain_text', content: t('card.dashboard.schedules.jump_page', { n: String(n) }, opts.locale) },
          value: String(n),
        };
      });
      actions.push({
        tag: 'select_static',
        placeholder: {
          tag: 'plain_text',
          content: t('card.dashboard.schedules.jump_page', { n: String(page) }, opts.locale),
        },
        initial_option: String(page),
        options,
        value: {
          action: SCHEDULES_ACTION_PAGE,
          invoker_open_id: opts.invokerOpenId,
          ...navFields,
        },
      });
    }
  }
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t('card.dashboard.schedules.refresh', undefined, opts.locale) },
    type: 'default',
    value: {
      action: SCHEDULES_ACTION_REFRESH,
      invoker_open_id: opts.invokerOpenId,
      ...navFields,
    },
  });
  // Overview drilldown only — back-to-overview reuses overview-refresh
  // action; card-handler routes by action prefix.
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
      title: { tag: 'plain_text', content: t('card.dashboard.schedules.title', undefined, opts.locale) },
      template: 'blue',
    },
    elements,
  });
}

function renderRow(row: ScheduleRowDto, locale: Locale, showBotLabel: boolean): unknown {
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
  // Global-scope (2026-06-11): prefix the secondary line with the owning
  // bot so the user can tell which bot a schedule belongs to (different
  // bots can share schedule names; per-bot scope didn't need this).
  // Preference: row.raw.botName → larkAppId short-suffix → '—'.
  if (showBotLabel) {
    const botLabel = botLabelFromRow(row);
    secondaryParts.unshift(t('card.dashboard.schedules.bot_label', { bot: botLabel }, locale));
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

/** Resolve the human label for a schedule's owning bot. */
function botLabelFromRow(row: ScheduleRowDto): string {
  const raw = row.raw as { botName?: string; larkAppId?: string };
  if (typeof raw.botName === 'string' && raw.botName.length > 0) return raw.botName;
  if (typeof raw.larkAppId === 'string' && raw.larkAppId.length > 0) {
    return `bot:${raw.larkAppId.slice(-6)}`;
  }
  return '—';
}

/** Slice-2a options for the detail card. `invokerOpenId` plumbs the lock onto every callback button. */
export interface BuildSchedulesDetailCardOpts {
  invokerOpenId: string;
  locale: Locale;
  /** Overview drilldown nav state — threaded into the "🔙 返回" button so
   *  the list rebuilt by BACK_TO_LIST is still drilldown-shaped (5/page +
   *  return-to-overview). Detail itself does NOT render return-to-overview. */
  origin?: 'overview';
  pageSize?: number;
  /** Global-scope flag (2026-06-11) — threaded into pause/resume/back so
   *  the rebuilt list and follow-on writes keep `?scope=global` semantics. */
  scope?: 'global';
}

/**
 * Build the detail card (slice 2a). Status icon + bold title + id monospace;
 * key/value block for name/enabled/kind/displayExpr/nextRunAt/lastRunAt/
 * lastStatus/repeat/prompt; next-N runs list; action row with pause/resume +
 * back.
 *
 * Pause and resume are MUTUALLY EXCLUSIVE per the PR1 matrix:
 *   enabled === true → pause clickable, resume disabled (alreadyEnabled)
 *   enabled === false → pause disabled (alreadyPaused), resume clickable
 *
 * The disabled button is rendered with `disabled:true` and a small reason
 * note next to it via `mapPauseDisabledReason` / `mapResumeDisabledReason`.
 */
export function buildSchedulesDetailCard(
  detail: ScheduleDetailDto,
  opts: BuildSchedulesDetailCardOpts,
): string {
  const elements: unknown[] = [];

  // ─── Title — status dot + bold name + id monospace ─────────────────────
  const enabledIcon = detail.enabled
    ? (detail.errorIndicator ? '🔴' : '🟢')
    : '⚪';
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content:
        `${enabledIcon} **${escapeLarkMd(detail.name)}**` +
        `\n\`${escapeLarkMd(detail.id)}\``,
    },
  });

  elements.push({ tag: 'hr' });

  // ─── Key/value block ───────────────────────────────────────────────────
  const enabledLabel = detail.enabled
    ? t('card.dashboard.schedules.detail.enabled.active', undefined, opts.locale)
    : t('card.dashboard.schedules.detail.enabled.paused', undefined, opts.locale);
  const infoLines: string[] = [];
  infoLines.push(
    t('card.dashboard.schedules.detail.name_label', { name: escapeLarkMd(detail.name) }, opts.locale),
  );
  infoLines.push(
    t('card.dashboard.schedules.detail.enabled_label', { status: enabledLabel }, opts.locale),
  );
  infoLines.push(
    t('card.dashboard.schedules.detail.kind_label', { kind: escapeLarkMd(detail.kind) }, opts.locale),
  );
  infoLines.push(
    t(
      'card.dashboard.schedules.detail.display_label',
      { expr: escapeLarkMd(detail.displayExpr) },
      opts.locale,
    ),
  );
  infoLines.push(
    t(
      'card.dashboard.schedules.detail.next_label',
      { rel: escapeLarkMd(detail.nextRunAt ?? '—') },
      opts.locale,
    ),
  );
  infoLines.push(
    t(
      'card.dashboard.schedules.detail.last_label',
      { rel: escapeLarkMd(detail.lastRunAt ?? '—') },
      opts.locale,
    ),
  );
  if (detail.lastStatus) {
    infoLines.push(
      t(
        'card.dashboard.schedules.detail.status_label',
        { status: escapeLarkMd(detail.lastStatus) },
        opts.locale,
      ),
    );
  }
  if (detail.repeat) {
    const repeatStr =
      detail.repeat.times === null
        ? `${detail.repeat.completed}/∞`
        : `${detail.repeat.completed}/${detail.repeat.times}`;
    infoLines.push(
      t('card.dashboard.schedules.detail.repeat_label', { repeat: repeatStr }, opts.locale),
    );
  }
  if (detail.prompt) {
    // `detail.prompt` is already truncated by `toScheduleDetailDto`. When the
    // raw prompt was longer than `promptTruncateAt` the DTO appends `…`, so
    // we can render it verbatim and rely on that visible marker.
    infoLines.push(
      t(
        'card.dashboard.schedules.detail.prompt_label',
        { prompt: escapeLarkMd(detail.prompt) },
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

  // ─── Next runs section (if any) ────────────────────────────────────────
  if (detail.nextRuns.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content:
          `**${t('card.dashboard.schedules.detail.next_runs_header', undefined, opts.locale)}**\n` +
          detail.nextRuns.map(iso => `- ${escapeLarkMd(iso)}`).join('\n'),
      },
    });
  }

  elements.push({ tag: 'hr' });

  // Threaded nav state — pause/resume rebuild this same detail card on
  // success, so users may then press 🔙 返回 and expect the drilldown list.
  const navFields: Record<string, string> = {};
  if (opts.origin === 'overview') navFields.origin = 'overview';
  if (
    typeof opts.pageSize === 'number'
    && Number.isFinite(opts.pageSize)
    && opts.pageSize > 0
    && opts.pageSize !== PAGE_SIZE
  ) {
    navFields.page_size = String(Math.floor(opts.pageSize));
  }
  if (opts.scope === 'global') navFields.dashboard_scope = 'global';

  // ─── Action row — pause / resume (mutually exclusive) + back ───────────
  const pauseEnabled = detail.actions.pause.enabled === true;
  const resumeEnabled = detail.actions.resume.enabled === true;
  const pauseButton: Record<string, unknown> = {
    tag: 'button',
    text: { tag: 'plain_text', content: t('card.dashboard.schedules.btn.pause', undefined, opts.locale) },
    type: pauseEnabled ? 'primary' : 'default',
    value: {
      action: SCHEDULES_ACTION_PAUSE,
      invoker_open_id: opts.invokerOpenId,
      schedule_id: detail.id,
      ...navFields,
    },
  };
  if (!pauseEnabled) pauseButton.disabled = true;
  const resumeButton: Record<string, unknown> = {
    tag: 'button',
    text: { tag: 'plain_text', content: t('card.dashboard.schedules.btn.resume', undefined, opts.locale) },
    type: resumeEnabled ? 'primary' : 'default',
    value: {
      action: SCHEDULES_ACTION_RESUME,
      invoker_open_id: opts.invokerOpenId,
      schedule_id: detail.id,
      ...navFields,
    },
  };
  if (!resumeEnabled) resumeButton.disabled = true;
  elements.push({
    tag: 'action',
    actions: [
      pauseButton,
      resumeButton,
      {
        tag: 'button',
        text: { tag: 'plain_text', content: t('card.dashboard.schedules.btn.back', undefined, opts.locale) },
        type: 'default',
        value: {
          action: SCHEDULES_ACTION_BACK_TO_LIST,
          invoker_open_id: opts.invokerOpenId,
          ...navFields,
        },
      },
    ],
  });

  // Surface reasonKey notes for whichever button is disabled. Pause/resume
  // are mutually exclusive in this slice — only one will be disabled at a
  // time — but render both branches defensively in case the matrix evolves.
  if (!pauseEnabled) {
    const reasonKey = mapPauseDisabledReason(detail.actions.pause.reasonKey);
    if (reasonKey) {
      elements.push({
        tag: 'note',
        elements: [
          { tag: 'lark_md', content: t(reasonKey, undefined, opts.locale) },
        ],
      });
    }
  }
  if (!resumeEnabled) {
    const reasonKey = mapResumeDisabledReason(detail.actions.resume.reasonKey);
    if (reasonKey) {
      elements.push({
        tag: 'note',
        elements: [
          { tag: 'lark_md', content: t(reasonKey, undefined, opts.locale) },
        ],
      });
    }
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
      title: { tag: 'plain_text', content: t('card.dashboard.schedules.detail.title', undefined, opts.locale) },
      template: 'blue',
    },
    elements,
  });
}

/** Map PR1 pause-disabled reasonKey to the slice-2a i18n key. */
function mapPauseDisabledReason(reasonKey: string | undefined): string | undefined {
  switch (reasonKey) {
    case 'schedules.action.pause.alreadyPaused':
      return 'card.dashboard.schedules.pause.disabled.alreadyPaused';
    default:
      return undefined;
  }
}

/** Map PR1 resume-disabled reasonKey to the slice-2a i18n key. */
function mapResumeDisabledReason(reasonKey: string | undefined): string | undefined {
  switch (reasonKey) {
    case 'schedules.action.resume.alreadyEnabled':
      return 'card.dashboard.schedules.resume.disabled.alreadyEnabled';
    default:
      return undefined;
  }
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

  // Validate the action BEFORE creating the Route B client — an unknown
  // action shouldn't even open a connection (defensive, also keeps the
  // slice-1 invariant that the unknown-action path doesn't touch the
  // client).
  const validActions = new Set<string>([
    SCHEDULES_ACTION_REFRESH,
    SCHEDULES_ACTION_PAGE,
    SCHEDULES_ACTION_DETAIL,
    SCHEDULES_ACTION_PAUSE,
    SCHEDULES_ACTION_RESUME,
    SCHEDULES_ACTION_BACK_TO_LIST,
  ]);
  if (!validActions.has(action)) {
    return ackToast('card.dashboard.settings.invalid_action', locale);
  }

  const client = deps.createClient(larkAppId);
  const now = (): number => (deps.nowMs ? deps.nowMs() : Date.now());

  // ─── Nav state (overview drilldown + global scope) ──────────────────
  // Threaded by buildSchedulesCard onto every button.value; we parse here
  // so the rebuild path keeps the same shape (5/page + 🔙 返回总览 +
  // global scope).
  const navOrigin: 'overview' | undefined = value.origin === 'overview' ? 'overview' : undefined;
  const parsedPageSize = Number.parseInt(value.page_size ?? '', 10);
  const navPageSize: number | undefined =
    Number.isFinite(parsedPageSize) && parsedPageSize > 0 ? parsedPageSize : undefined;
  const navScope: 'global' | undefined = value.dashboard_scope === 'global' ? 'global' : undefined;
  const listPathSuffix = navScope === 'global' ? '?scope=global' : '';
  const writePathSuffix = navScope === 'global' ? '?scope=global' : '';

  // ─── 3a) DETAIL — open the per-schedule detail card ─────────────────
  if (action === SCHEDULES_ACTION_DETAIL) {
    const scheduleId = value.schedule_id;
    if (typeof scheduleId !== 'string' || !scheduleId) {
      return errorToast('card.dashboard.schedules.schedule_not_found', undefined, locale);
    }
    const r = await safeGetSchedulesList(client, locale, listPathSuffix);
    if ('errorResult' in r) return r.errorResult;
    const row = r.tasks.find(t => t.id === scheduleId);
    if (!row) {
      return errorToast('card.dashboard.schedules.schedule_not_found', undefined, locale);
    }
    const detail = toScheduleDetailDto(row, { nowMs: now() });
    const cardJson = buildSchedulesDetailCard(detail, {
      invokerOpenId: expectedOwner,
      locale,
      origin: navOrigin,
      pageSize: navPageSize,
      scope: navScope,
    });
    return { card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> } };
  }

  // ─── 3b) PAUSE / RESUME — synchronous toggle ────────────────────────
  if (action === SCHEDULES_ACTION_PAUSE || action === SCHEDULES_ACTION_RESUME) {
    const scheduleId = value.schedule_id;
    if (typeof scheduleId !== 'string' || !scheduleId) {
      return errorToast('card.dashboard.schedules.schedule_not_found', undefined, locale);
    }
    const verb = action === SCHEDULES_ACTION_PAUSE ? 'pause' : 'resume';
    const failedKey =
      verb === 'pause'
        ? 'card.dashboard.schedules.pause_failed'
        : 'card.dashboard.schedules.resume_failed';

    // Pre-POST snapshot — needed both to confirm the schedule still exists
    // AND to synthesize the new-state row in-process so we don't pay the
    // cost (or race) of a second GET on the happy pause path.
    const pre = await safeGetSchedulesList(client, locale, listPathSuffix);
    if ('errorResult' in pre) return pre.errorResult;
    const before = pre.tasks.find(t => t.id === scheduleId);
    if (!before) {
      return errorToast('card.dashboard.schedules.schedule_not_found', undefined, locale);
    }

    // codex 2026-06-10 SECURITY BLOCKER: client-side `disabled` on the
    // pause/resume button is UX only — a replayed event, an old card
    // still open, or a hand-crafted payload can still hit this callback.
    // Server-side we MUST re-run the PR1 action-availability matrix
    // against the fresh snapshot and fail-closed on `enabled === false`.
    // This re-uses the SAME computeButtonAvailability logic the builder
    // used to decide whether to disable the button in the first place —
    // keeping the rules in one place avoids drift between client paint
    // and server enforce.
    const beforeMatrix = computeButtonAvailability(before);
    const buttonState = verb === 'pause' ? beforeMatrix.pause : beforeMatrix.resume;
    if (buttonState.enabled !== true) {
      // Reuse the SAME PR1 reasonKey → i18n key mapping the builder uses
      // for the inline disabled-button note so toast text matches what
      // the user already sees on the card. NEVER POST; NEVER redraw.
      const mappedKey = verb === 'pause'
        ? mapPauseDisabledReason(buttonState.reasonKey) ?? failedKey
        : mapResumeDisabledReason(buttonState.reasonKey) ?? failedKey;
      return errorToast(mappedKey, undefined, locale);
    }

    // Route B owner gate is the authority on whether THIS bot's owner can
    // toggle THIS schedule; we only sanitize the routing key above. As of
    // 2026-06-10 the Route B handler also gates cross-bot writes.
    let resp: Awaited<ReturnType<DaemonClient['request']>>;
    try {
      resp = await client.request({
        method: 'POST',
        path: `/__daemon/schedules/${encodeURIComponent(scheduleId)}/${verb}${writePathSuffix}`,
      });
    } catch (e) {
      return errorToast(failedKey, { reason: (e as Error).message }, locale);
    }
    if (resp.status !== 200) {
      const body = (resp.body ?? {}) as Record<string, unknown>;
      const reason = String(body.error ?? `http_${resp.status}`);
      // Preserve user state — do NOT redraw card on failure.
      return errorToast(failedKey, { reason }, locale);
    }

    if (verb === 'pause') {
      // Pause makes nextRunAt irrelevant — the scheduler stops emitting
      // until the task is resumed — so an in-process overlay is safe.
      const synth: ScheduleCardTaskInput = { ...before, enabled: false };
      const detail = toScheduleDetailDto(synth, { nowMs: now() });
      const cardJson = buildSchedulesDetailCard(detail, {
        invokerOpenId: expectedOwner,
        locale,
        origin: navOrigin,
        pageSize: navPageSize,
        scope: navScope,
      });
      return { card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> } };
    }

    // RESUME — nextRunAt MUST be recomputed by the real scheduler's
    // computeNextRun (cron / interval logic lives in scheduler.ts). We
    // do a 2nd GET to read the freshly-recomputed row. If that GET
    // fails or the row is missing, fall back to a `{...before, enabled:
    // true}` synth — the row will still be functional, just with a
    // possibly-stale nextRunAt for one render cycle. The next user
    // interaction (refresh / back-to-list / another detail click) will
    // converge it.
    const postRefetch = await safeGetSchedulesList(client, locale, listPathSuffix);
    let after: ScheduleCardTaskInput | undefined;
    if ('errorResult' in postRefetch) {
      after = undefined;
    } else {
      after = postRefetch.tasks.find(t => t.id === scheduleId);
    }
    if (!after) {
      // codex fall-back: resume succeeded upstream but refetch couldn't
      // surface the new row. Render synth-with-enabled:true so the user
      // gets a valid card; nextRunAt may be stale until the next refresh.
      after = { ...before, enabled: true };
    }
    const detail = toScheduleDetailDto(after, { nowMs: now() });
    const cardJson = buildSchedulesDetailCard(detail, {
      invokerOpenId: expectedOwner,
      locale,
      origin: navOrigin,
      pageSize: navPageSize,
      scope: navScope,
    });
    return { card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> } };
  }

  // ─── 3c) BACK TO LIST — rebuild list card at page 1 ─────────────────
  if (action === SCHEDULES_ACTION_BACK_TO_LIST) {
    const r = await safeGetSchedulesList(client, locale, listPathSuffix);
    if ('errorResult' in r) return r.errorResult;
    const cardJson = buildSchedulesCard(
      r.tasks,
      {
        invokerOpenId: expectedOwner,
        locale,
        page: 1,
        pageSize: navPageSize,
        origin: navOrigin,
        scope: navScope,
      },
      now(),
    );
    return { card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> } };
  }

  // ─── 3d) Slice-1 actions — REFRESH + PAGE ───────────────────────────
  // `action` is already constrained to validActions above; the only ones
  // left here are REFRESH + PAGE (the other 4 returned early).
  let page = 1;
  if (action === SCHEDULES_ACTION_PAGE) {
    // Page comes from value.page (prev/next button) OR action.option
    // (select_static "jump to page" picker). Same action key, different
    // dispatch field — handler converges on one branch.
    const raw = value.page ?? (data.action as { option?: string } | undefined)?.option ?? '1';
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) page = parsed;
  }

  const r = await safeGetSchedulesList(client, locale, listPathSuffix);
  if ('errorResult' in r) return r.errorResult;
  const cardJson = buildSchedulesCard(
    r.tasks,
    {
      invokerOpenId: expectedOwner,
      locale,
      page,
      pageSize: navPageSize,
      origin: navOrigin,
      scope: navScope,
    },
    now(),
  );
  return {
    card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> },
  };
}

/**
 * GET `/__daemon/schedules-list` and surface non-200 / network errors as
 * caller-facing error toasts. Returns either `{ tasks }` or
 * `{ errorResult }` — exactly one is set.
 *
 * createDaemonClient.request does NOT throw on 4xx/5xx — it resolves with
 * the response. If we only catch throws we'd silently render an empty list
 * when Route B returns 500/401, masking a real backend failure as "no
 * schedules". So check `status !== 200` explicitly and surface as an
 * error toast.
 */
async function safeGetSchedulesList(
  client: DaemonClient,
  locale: Locale,
  pathSuffix: string = '',
): Promise<{ tasks: ReadonlyArray<ScheduleCardTaskInput> } | { errorResult: SchedulesCardHandlerResult }> {
  let r: Awaited<ReturnType<DaemonClient['request']>>;
  try {
    r = await client.request({ method: 'GET', path: `/__daemon/schedules-list${pathSuffix}` });
  } catch (e) {
    return { errorResult: errorToast('card.dashboard.schedules.list_failed', { reason: (e as Error).message }, locale) };
  }
  if (r.status !== 200) {
    const reason = String((r.body as Record<string, unknown> | undefined)?.error ?? `http_${r.status}`);
    return { errorResult: errorToast('card.dashboard.schedules.list_failed', { reason }, locale) };
  }
  const tasks = ((r.body as { schedules?: ReadonlyArray<ScheduleCardTaskInput> })?.schedules) ?? [];
  return { tasks };
}
