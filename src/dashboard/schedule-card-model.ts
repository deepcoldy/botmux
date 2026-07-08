/**
 * Schedule card model (PR1) — pure projection of `ScheduleCardTaskInput` (a
 * minimal task shape mirroring fields from `ScheduledTask`, redeclared here
 * so the model does NOT depend on `ScheduledTask` / `scheduler.ts` /
 * `dashboard-ipc-server.ts` runtime modules) into list-card and detail-card
 * DTOs.
 *
 * Allowed imports:
 *  - `import type { ParsedSchedule } from '../types.js'` (type-only, erasable)
 *  - `import { Cron } from 'croner'` (third-party, already a runtime dep —
 *     used purely for time math on cron expressions; no IO is invoked)
 *  - `import type { ... } from './card-model-types.js'`
 *
 * Forbidden: scheduler.ts (ONESHOT_GRACE, tick), schedule-store, dashboard-*.
 */

import { Cron } from 'croner';
import type { ParsedSchedule } from '../types.js';
import { scheduleTimeZone } from '../utils/timezone.js';
import type {
  ButtonState,
  PaginationMeta,
  PaginationParams,
  StatusDot,
} from './card-model-types.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PROMPT_TRUNCATE = 200;
const DEFAULT_NEXT_RUNS_COUNT = 5;

/** Minimal task input — self-contained so PR1 model does not pull in `ScheduledTask`. */
export interface ScheduleCardTaskInput {
  id: string;
  name: string;
  prompt?: string;
  parsed: ParsedSchedule;
  enabled: boolean;
  deliver?: ScheduleDelivery;
  larkAppId?: string;
  /** Human bot label (e.g. `zkd-claude-bot`). Optional — when present the
   *  global-scope card row prefixes the row with it so the user can tell
   *  which bot owns the schedule. Falls back to a `larkAppId` short suffix
   *  when missing. */
  botName?: string;
  chatId?: string;
  /** ISO of the next scheduled run (precomputed by caller). */
  nextRunAt?: string;
  /** ISO of the last completed run. */
  lastRunAt?: string;
  lastStatus?: 'ok' | 'error';
  /** Repeat counter shape mirrors `ScheduledTask.repeat` (`src/types.ts:212`):
   *  `times === null` ⇒ forever; finite `times` ⇒ auto-removes after N runs.
   *  `completed` counts how many runs have fired. */
  repeat?: { times: number | null; completed: number };
}

export type ScheduleKind = ParsedSchedule['kind'];
export type ScheduleDelivery = 'origin' | 'local' | 'new-topic';
export type ScheduleKindChip = ScheduleKind | 'all';

export interface ScheduleFilterQuery extends PaginationParams {
  /** Case-insensitive substring match against name + prompt. */
  search?: string;
  kind?: ScheduleKindChip;
  enabledOnly?: boolean;
}

export interface RowRenderContext {
  /** Epoch ms — required so relative-time outputs are deterministic. */
  nowMs: number;
  /** IANA timezone for cron next-run math; defaults to the host's local zone (scheduleTimeZone()). */
  timezone?: string;
  /** Cap prompt length in detail DTO; defaults to 200. */
  promptTruncateAt?: number;
  /** How many next-runs to precompute for detail. Defaults to 5. */
  nextRunsCount?: number;
}

/** Per-button availability for the 3 schedule actions. */
export interface ScheduleActionMatrix {
  runNow: ButtonState;
  pause: ButtonState;
  resume: ButtonState;
}

export interface ScheduleRowDto {
  id: string;
  name: string;
  /** parsed.display passthrough. */
  displayExpr: string;
  kind: ScheduleKind;
  enabled: boolean;
  /** Human relative form: 'in Xm' / 'overdue' / '—'. */
  nextRunRelative: string;
  /** Human relative form: 'Xm ago' / '—'. */
  lastRunRelative: string;
  /** Semantic flag — renderer decides whether to draw a glyph. */
  errorIndicator: boolean;
  /** Semantic dot, useful for list-row decoration. */
  dot: StatusDot;
  /** Passthrough of `ScheduledTask.repeat` so the row can render `n/N` or `n/∞`. */
  repeat?: { times: number | null; completed: number };
  actions: ScheduleActionMatrix;
  raw: ScheduleCardTaskInput;
}

export interface ScheduleDetailDto {
  id: string;
  name: string;
  enabled: boolean;
  kind: ScheduleKind;
  displayExpr: string;
  deliver: ScheduleDelivery;
  prompt?: string;
  /** True when prompt was longer than promptTruncateAt and got cut. */
  promptTruncated: boolean;
  chatId?: string;
  larkAppId?: string;
  /** Precomputed list of N upcoming runs (ISO strings, strictly increasing). */
  nextRuns: string[];
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: 'ok' | 'error';
  errorIndicator: boolean;
  /** Passthrough of `ScheduledTask.repeat`. */
  repeat?: { times: number | null; completed: number };
  actions: ScheduleActionMatrix;
  raw: ScheduleCardTaskInput;
}

export interface KindCounts {
  all: number;
  once: number;
  interval: number;
  cron: number;
}

export interface ScheduleListPage {
  rows: ScheduleRowDto[];
  meta: PaginationMeta;
  kindCounts: KindCounts;
}

function statusDotFor(task: ScheduleCardTaskInput): StatusDot {
  if (!task.enabled) {
    return { tone: 'neutral', pulse: false, label: 'schedules.status.paused' };
  }
  if (task.lastStatus === 'error') {
    return { tone: 'danger', pulse: false, label: 'schedules.status.lastError' };
  }
  return { tone: 'success', pulse: false, label: 'schedules.status.active' };
}

function formatNextRun(nextRunAt: string | undefined, nowMs: number): string {
  if (!nextRunAt) return '—';
  const ms = Date.parse(nextRunAt);
  if (!Number.isFinite(ms)) return '—';
  const diff = ms - nowMs;
  if (diff < 0) return 'overdue';
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'in <1m';
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `in ${hr}h`;
  return `in ${Math.floor(hr / 24)}d`;
}

function formatLastRun(lastRunAt: string | undefined, nowMs: number): string {
  if (!lastRunAt) return '—';
  const ms = Date.parse(lastRunAt);
  if (!Number.isFinite(ms)) return '—';
  const diff = nowMs - ms;
  if (diff < 0) return '—';
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '<1m ago';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** Compute UI availability for the 3 schedule action buttons (pure). */
export function computeButtonAvailability(task: ScheduleCardTaskInput): ScheduleActionMatrix {
  if (task.enabled) {
    return {
      runNow: { enabled: true },
      pause: { enabled: true },
      resume: { enabled: false, reasonKey: 'schedules.action.resume.alreadyEnabled' },
    };
  }
  return {
    runNow: { enabled: true },
    pause: { enabled: false, reasonKey: 'schedules.action.pause.alreadyPaused' },
    resume: { enabled: true },
  };
}

export function normalizeScheduleDelivery(deliver: ScheduleCardTaskInput['deliver']): ScheduleDelivery {
  return deliver === 'new-topic' || deliver === 'local' ? deliver : 'origin';
}

export function computeDeliveryButtonAvailability(
  task: ScheduleCardTaskInput,
  target: Exclude<ScheduleDelivery, 'local'>,
): ButtonState {
  const current = normalizeScheduleDelivery(task.deliver);
  if (current === 'local') {
    return { enabled: false, reasonKey: 'schedules.action.delivery.local' };
  }
  if (current === target) {
    return {
      enabled: false,
      reasonKey: target === 'origin'
        ? 'schedules.action.delivery.alreadyOrigin'
        : 'schedules.action.delivery.alreadyNewTopic',
    };
  }
  return { enabled: true };
}

/** Build a single ScheduleRowDto for list rendering. */
export function toScheduleRowDto(task: ScheduleCardTaskInput, ctx: RowRenderContext): ScheduleRowDto {
  return {
    id: task.id,
    name: task.name,
    displayExpr: task.parsed.display,
    kind: task.parsed.kind,
    enabled: task.enabled,
    nextRunRelative: formatNextRun(task.nextRunAt, ctx.nowMs),
    lastRunRelative: formatLastRun(task.lastRunAt, ctx.nowMs),
    errorIndicator: task.lastStatus === 'error',
    dot: statusDotFor(task),
    repeat: task.repeat,
    actions: computeButtonAvailability(task),
    raw: task,
  };
}

/** Build the detail-card DTO including precomputed next-N runs and prompt truncation. */
export function toScheduleDetailDto(task: ScheduleCardTaskInput, ctx: RowRenderContext): ScheduleDetailDto {
  const truncateAt = ctx.promptTruncateAt ?? DEFAULT_PROMPT_TRUNCATE;
  const count = ctx.nextRunsCount ?? DEFAULT_NEXT_RUNS_COUNT;
  const promptRaw = task.prompt ?? '';
  const promptTruncated = promptRaw.length > truncateAt;
  const prompt = promptTruncated ? `${promptRaw.slice(0, truncateAt)}…` : promptRaw;

  return {
    id: task.id,
    name: task.name,
    enabled: task.enabled,
    kind: task.parsed.kind,
    displayExpr: task.parsed.display,
    deliver: normalizeScheduleDelivery(task.deliver),
    prompt: promptRaw.length === 0 ? undefined : prompt,
    promptTruncated,
    chatId: task.chatId,
    larkAppId: task.larkAppId,
    nextRuns: computeNextNRuns(task, count, { nowMs: ctx.nowMs, timezone: ctx.timezone }),
    nextRunAt: task.nextRunAt,
    lastRunAt: task.lastRunAt,
    lastStatus: task.lastStatus,
    errorIndicator: task.lastStatus === 'error',
    repeat: task.repeat,
    actions: computeButtonAvailability(task),
    raw: task,
  };
}

/**
 * Compute the next N runs of a task, as ISO strings. Strictly increasing.
 *
 *  - `once`:  one entry if `runAt >= nowMs` AND `lastRunAt` is absent; else [].
 *  - `interval`: minutes>0 required; base = lastRunAt ?? nowMs; aligns to first
 *               future run > nowMs.
 *  - `cron`:  uses `croner` with the host's local timezone (or an injected override).
 *
 * Pure w.r.t. the clock: nowMs is injected. `timezone` is injected too; when
 * omitted it falls back to the host's local zone (scheduleTimeZone()).
 */
export function computeNextNRuns(
  task: ScheduleCardTaskInput,
  n: number,
  ctx: { nowMs: number; timezone?: string },
): string[] {
  if (n <= 0) return [];
  const tz = ctx.timezone ?? scheduleTimeZone();
  const { parsed } = task;

  if (parsed.kind === 'once') {
    if (task.lastRunAt) return [];
    if (!parsed.runAt) return [];
    const runAtMs = Date.parse(parsed.runAt);
    if (!Number.isFinite(runAtMs) || runAtMs < ctx.nowMs) return [];
    return [new Date(runAtMs).toISOString()];
  }

  if (parsed.kind === 'interval') {
    const minutes = parsed.minutes ?? 0;
    if (minutes <= 0) return [];
    const stepMs = minutes * 60_000;
    const lastMs = task.lastRunAt ? Date.parse(task.lastRunAt) : NaN;
    let next = Number.isFinite(lastMs) ? lastMs + stepMs : ctx.nowMs + stepMs;
    if (next <= ctx.nowMs) {
      const skipped = Math.floor((ctx.nowMs - next) / stepMs) + 1;
      next += skipped * stepMs;
    }
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      out.push(new Date(next).toISOString());
      next += stepMs;
    }
    return out;
  }

  if (parsed.kind === 'cron') {
    if (!parsed.expr) return [];
    try {
      const cron = new Cron(parsed.expr, { timezone: tz });
      const out: string[] = [];
      let prev = new Date(ctx.nowMs);
      for (let i = 0; i < n; i++) {
        const next = cron.nextRun(prev);
        if (!next) break;
        out.push(next.toISOString());
        prev = next;
      }
      return out;
    } catch {
      return [];
    }
  }

  return [];
}

/** Tally kinds across the (unfiltered) task pool — used for the kind chip badges. */
export function kindCounts(tasks: ReadonlyArray<ScheduleCardTaskInput>): KindCounts {
  const counts: KindCounts = { all: tasks.length, once: 0, interval: 0, cron: 0 };
  for (const t of tasks) {
    if (t.parsed.kind === 'once') counts.once += 1;
    else if (t.parsed.kind === 'interval') counts.interval += 1;
    else if (t.parsed.kind === 'cron') counts.cron += 1;
  }
  return counts;
}

/**
 * Filter tasks by search/kind/enabledOnly. Returns a new array (no mutation).
 *  - `search`: case-insensitive substring across `name` and `prompt`.
 *  - `kind`:   exact match on `parsed.kind`; 'all' or undefined is no-op.
 *  - `enabledOnly`: when true, drops tasks with `enabled !== true`.
 */
export function filterSchedules(
  tasks: ReadonlyArray<ScheduleCardTaskInput>,
  query: Pick<ScheduleFilterQuery, 'search' | 'kind' | 'enabledOnly'>,
): ScheduleCardTaskInput[] {
  let out = tasks.slice();
  if (query.enabledOnly === true) {
    out = out.filter(t => t.enabled === true);
  }
  if (typeof query.search === 'string' && query.search.trim().length > 0) {
    const needle = query.search.trim().toLowerCase();
    out = out.filter(t => {
      const hay = `${t.name} ${t.prompt ?? ''}`.toLowerCase();
      return hay.includes(needle);
    });
  }
  if (query.kind && query.kind !== 'all') {
    out = out.filter(t => t.parsed.kind === query.kind);
  }
  return out;
}

function clampPageSize(pageSize: number | undefined): number {
  if (typeof pageSize !== 'number' || !Number.isFinite(pageSize) || pageSize < 1) return DEFAULT_PAGE_SIZE;
  if (pageSize > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return Math.floor(pageSize);
}

/** Slice an already-filtered list into a single page. Clamp rules apply. */
export function paginateSchedules<T>(
  items: ReadonlyArray<T>,
  page: number | undefined,
  pageSize: number | undefined,
): { items: T[]; page: number; pageSize: number; total: number; totalPages: number } {
  const total = items.length;
  const size = clampPageSize(pageSize);
  const totalPages = Math.max(1, Math.ceil(total / size));
  let active = typeof page === 'number' && Number.isFinite(page) ? Math.floor(page) : 1;
  if (active < 1) active = 1;
  if (active > totalPages) active = totalPages;
  const start = (active - 1) * size;
  return {
    items: items.slice(start, start + size),
    page: active,
    pageSize: size,
    total,
    totalPages,
  };
}

/** End-to-end pipeline: filter → toRow → paginate → counts. Used by the dashboard endpoint. */
export function filterAndPaginateSchedules(
  tasks: ReadonlyArray<ScheduleCardTaskInput>,
  query: ScheduleFilterQuery,
  ctx: RowRenderContext,
): ScheduleListPage {
  const filtered = filterSchedules(tasks, query);
  const counts = kindCounts(tasks);
  const paged = paginateSchedules(filtered, query.page, query.pageSize);
  return {
    rows: paged.items.map(t => toScheduleRowDto(t, ctx)),
    meta: {
      page: paged.page,
      pageSize: paged.pageSize,
      total: paged.total,
      totalPages: paged.totalPages,
    },
    kindCounts: counts,
  };
}
