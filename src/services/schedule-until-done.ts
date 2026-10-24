/**
 * 有状态定时任务的纯逻辑：执行账本（runStats）与「直到完成」（untilDone）。
 *
 * 这里只做状态推导，不碰存储、定时器或飞书；scheduler（SQLite authority 路径）
 * 与 schedule-store（legacy JSON 路径）共用同一套规则，避免两条结算路径各写一遍。
 * 设计见 docs/design/2026-10-24-schedule-until-done.md。
 */
import type {
  ScheduledTask,
  ScheduleNotifyEvent,
  ScheduleRunStats,
  ScheduleUntilDone,
} from '../types.js';

/** One-shot until-done: wait this long before re-running a run that did not finish. */
export const UNTIL_DONE_DEFAULT_RETRY_MINUTES = 24 * 60;
/** A failed attempt is retried no later than this (one-shot and deadline closing run). */
export const UNTIL_DONE_ERROR_RETRY_MINUTES = 60;
/** Consecutive failures that make a task "failing" (notification + closing-run give-up). */
export const SCHEDULE_FAILING_THRESHOLD = 3;
export const UNTIL_DONE_NOTE_MAX_CHARS = 500;

const NOTIFY_EVENTS: readonly ScheduleNotifyEvent[] = ['failing', 'expired'];

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function isoOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

export function emptyRunStats(): ScheduleRunStats {
  return { dispatched: 0, skipped: 0, failed: 0, missed: 0, consecutiveFailures: 0 };
}

/** Rebuild a persisted ledger field-by-field; junk becomes zero, absence stays absent. */
export function normalizeRunStats(raw: unknown): ScheduleRunStats | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  return {
    dispatched: count(r.dispatched),
    skipped: count(r.skipped),
    failed: count(r.failed),
    missed: count(r.missed),
    consecutiveFailures: count(r.consecutiveFailures),
    ...(isoOrUndefined(r.lastMissedAt) ? { lastMissedAt: r.lastMissedAt as string } : {}),
    ...(isoOrUndefined(r.failingNotifiedAt) ? { failingNotifiedAt: r.failingNotifiedAt as string } : {}),
  };
}

export function normalizeUntilDone(raw: unknown): ScheduleUntilDone | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const status = r.status === 'done' || r.status === 'expired' ? r.status : 'open';
  const retryMinutes = count(r.retryMinutes);
  return {
    status,
    attempts: count(r.attempts),
    ...(isoOrUndefined(r.deadline) ? { deadline: r.deadline as string } : {}),
    ...(retryMinutes > 0 ? { retryMinutes } : {}),
    ...(typeof r.finalRunId === 'string' && r.finalRunId ? { finalRunId: r.finalRunId } : {}),
    ...(count(r.finalFailures) > 0 ? { finalFailures: count(r.finalFailures) } : {}),
    ...(isoOrUndefined(r.finalRetryAt) ? { finalRetryAt: r.finalRetryAt as string } : {}),
    ...(isoOrUndefined(r.doneAt) ? { doneAt: r.doneAt as string } : {}),
    ...(typeof r.doneNote === 'string' && r.doneNote.trim()
      ? { doneNote: Array.from(r.doneNote.trim()).slice(0, UNTIL_DONE_NOTE_MAX_CHARS).join('') }
      : {}),
    ...(isoOrUndefined(r.expiredAt) ? { expiredAt: r.expiredAt as string } : {}),
  };
}

export function normalizeScheduleNotify(raw: unknown): ScheduleNotifyEvent[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const events = NOTIFY_EVENTS.filter(event => raw.includes(event));
  return events.length > 0 ? events : undefined;
}

/** Parse a `--notify` list ("failing,expired"). Throws on unknown events. */
export function parseScheduleNotify(input: string): ScheduleNotifyEvent[] {
  const parts = input.split(/[,\s]+/).map(part => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('notify_events_required');
  for (const part of parts) {
    if (!(NOTIFY_EVENTS as readonly string[]).includes(part)) throw new Error(`notify_event_invalid:${part}`);
  }
  return NOTIFY_EVENTS.filter(event => parts.includes(event));
}

export interface UntilDoneConfigInput {
  deadline?: string;
  retryMinutes?: number;
}

/**
 * Validate until-done / notify configuration against the task's schedule and
 * return the initial persisted state. Error messages are stable codes.
 */
export function resolveUntilDoneConfig(input: {
  untilDone?: UntilDoneConfigInput;
  notify?: readonly ScheduleNotifyEvent[];
  parsed: ScheduledTask['parsed'];
  repeat?: ScheduledTask['repeat'];
  nowMs: number;
}): { untilDone?: ScheduleUntilDone; notify?: ScheduleNotifyEvent[] } {
  const notify = input.notify ? normalizeScheduleNotify([...input.notify]) : undefined;
  if (input.notify && input.notify.length > 0 && !notify) throw new Error('notify_event_invalid');
  if (!input.untilDone) {
    if (notify?.includes('expired')) throw new Error('notify_expired_requires_until_done');
    return { ...(notify ? { notify } : {}) };
  }
  if (input.repeat && input.repeat.times !== null && input.repeat.times !== undefined) {
    throw new Error('until_done_repeat_unsupported');
  }
  const { deadline, retryMinutes } = input.untilDone;
  let deadlineIso: string | undefined;
  if (deadline !== undefined) {
    const deadlineMs = Date.parse(deadline);
    if (Number.isNaN(deadlineMs)) throw new Error('until_done_deadline_invalid');
    if (deadlineMs <= input.nowMs) throw new Error('until_done_deadline_past');
    if (input.parsed.kind === 'once' && input.parsed.runAt && Date.parse(input.parsed.runAt) > deadlineMs) {
      throw new Error('until_done_deadline_before_first_run');
    }
    deadlineIso = new Date(deadlineMs).toISOString();
  }
  if (retryMinutes !== undefined) {
    if (!Number.isInteger(retryMinutes) || retryMinutes <= 0) throw new Error('until_done_retry_invalid');
    if (input.parsed.kind !== 'once') throw new Error('until_done_retry_requires_once');
  }
  return {
    untilDone: {
      status: 'open',
      attempts: 0,
      ...(deadlineIso ? { deadline: deadlineIso } : {}),
      ...(retryMinutes !== undefined ? { retryMinutes } : {}),
    },
    ...(notify ? { notify } : {}),
  };
}

export function isUntilDoneOpen(task: Pick<ScheduledTask, 'untilDone'>): boolean {
  return task.untilDone?.status === 'open';
}

export function isUntilDoneClosed(task: Pick<ScheduledTask, 'untilDone'>): boolean {
  return !!task.untilDone && task.untilDone.status !== 'open';
}

/** A task that closed itself (one-shot ran, or until-done done/expired) rather
 *  than being paused by a person. The run that closed it keeps its authority
 *  while still live, exactly like a completed one-shot. */
export function isAutoCompletedSchedule(
  task: Pick<ScheduledTask, 'disabledReason' | 'parsed' | 'untilDone'>,
): boolean {
  return task.disabledReason === 'once_completed'
    && (task.parsed?.kind === 'once' || isUntilDoneClosed(task));
}

/** Open, past its deadline, and no closing run in flight or waiting to retry. */
export function untilDoneDeadlineDue(task: Pick<ScheduledTask, 'untilDone'>, nowMs: number): boolean {
  const state = task.untilDone;
  if (state?.status !== 'open' || !state.deadline || state.finalRunId) return false;
  if (nowMs < Date.parse(state.deadline)) return false;
  return !state.finalRetryAt || nowMs >= Date.parse(state.finalRetryAt);
}

export function isUntilDoneFinalRun(task: Pick<ScheduledTask, 'untilDone'>, runId: string | undefined): boolean {
  return !!runId && task.untilDone?.status === 'open' && task.untilDone.finalRunId === runId;
}

/** Ledger update for a settled run. */
export function recordRunOutcome(
  stats: ScheduleRunStats | undefined,
  outcome: 'dispatched' | 'skipped' | 'failed',
): ScheduleRunStats {
  const next = { ...(stats ?? emptyRunStats()) };
  if (outcome === 'dispatched') {
    next.dispatched += 1;
    next.consecutiveFailures = 0;
    delete next.failingNotifiedAt;
  } else if (outcome === 'skipped') {
    next.skipped += 1;
  } else {
    next.failed += 1;
    next.consecutiveFailures += 1;
  }
  return next;
}

export function recordMissed(stats: ScheduleRunStats | undefined, atIso: string): ScheduleRunStats {
  const next = { ...(stats ?? emptyRunStats()) };
  next.missed += 1;
  next.lastMissedAt = atIso;
  return next;
}

/**
 * Settle an until-done task after a claimed run finished dispatching (or
 * failed). `task` must already carry the legacy settlement (lastStatus,
 * enabled/nextRunAt for one-shots); this returns the until-done overrides, or
 * the task unchanged when it is not an open until-done task.
 */
export function settleUntilDoneRun(
  task: ScheduledTask,
  input: { success: boolean; runId?: string; nowMs: number },
): ScheduledTask {
  const state = task.untilDone;
  if (!state) return task;
  if (state.status !== 'open') {
    // Closed while the run was in flight (e.g. `schedule done` from inside the
    // turn): never let the settlement re-enable it.
    return { ...task, enabled: false, disabledReason: 'once_completed', nextRunAt: undefined };
  }
  const nowIso = new Date(input.nowMs).toISOString();
  const attempts = input.success ? state.attempts + 1 : state.attempts;
  if (isUntilDoneFinalRun(task, input.runId)) {
    const finalFailures = input.success ? state.finalFailures ?? 0 : (state.finalFailures ?? 0) + 1;
    if (input.success || finalFailures >= SCHEDULE_FAILING_THRESHOLD) {
      const { finalRunId: _final, finalRetryAt: _retry, ...rest } = state;
      return {
        ...task,
        enabled: false,
        disabledReason: 'once_completed',
        nextRunAt: undefined,
        untilDone: { ...rest, status: 'expired', attempts, finalFailures, expiredAt: nowIso },
      };
    }
    const { finalRunId: _final, ...rest } = state;
    return {
      ...task,
      enabled: true,
      disabledReason: undefined,
      untilDone: {
        ...rest,
        attempts,
        finalFailures,
        finalRetryAt: new Date(input.nowMs + UNTIL_DONE_ERROR_RETRY_MINUTES * 60_000).toISOString(),
      },
    };
  }
  const untilDone: ScheduleUntilDone = { ...state, attempts };
  if (task.parsed.kind !== 'once') {
    // Recurring: the claim already advanced nextRunAt; a failure simply waits
    // for the next occurrence. Only make sure nothing disabled it.
    return { ...task, enabled: true, disabledReason: undefined, untilDone };
  }
  const retryMinutes = state.retryMinutes ?? UNTIL_DONE_DEFAULT_RETRY_MINUTES;
  const delayMinutes = input.success ? retryMinutes : Math.min(retryMinutes, UNTIL_DONE_ERROR_RETRY_MINUTES);
  return {
    ...task,
    enabled: true,
    disabledReason: undefined,
    nextRunAt: new Date(input.nowMs + delayMinutes * 60_000).toISOString(),
    untilDone,
  };
}

/** A precondition / calendar skip of the closing run means the deadline came
 *  and the awaited condition never held: close the task as expired rather than
 *  leaving the closing-run marker latched. Other skips change nothing. */
export function settleUntilDoneSkip(task: ScheduledTask, runId: string | undefined, nowMs: number): ScheduledTask {
  if (!isUntilDoneFinalRun(task, runId)) return task;
  const { finalRunId: _final, finalRetryAt: _retry, ...rest } = task.untilDone!;
  return {
    ...task,
    enabled: false,
    disabledReason: 'once_completed',
    nextRunAt: undefined,
    untilDone: { ...rest, status: 'expired', expiredAt: new Date(nowMs).toISOString() },
  };
}

/** Claim-time marker for the deadline closing run. */
export function markUntilDoneFinalRun(task: ScheduledTask, runId: string): ScheduledTask {
  if (task.untilDone?.status !== 'open') return task;
  const { finalRetryAt: _retry, ...rest } = task.untilDone;
  return { ...task, untilDone: { ...rest, finalRunId: runId } };
}

export type CompleteUntilDoneResult =
  | { ok: true; task: ScheduledTask; replay: boolean }
  | { ok: false; error: 'schedule_not_until_done' | 'schedule_until_done_expired' };

/** `botmux schedule done`: open → done. Repeating it is an idempotent replay;
 *  an expired task can still be closed as done by its own closing run. */
export function completeUntilDone(task: ScheduledTask, note: string | undefined, nowMs: number): CompleteUntilDoneResult {
  const state = task.untilDone;
  if (!state) return { ok: false, error: 'schedule_not_until_done' };
  if (state.status === 'done') return { ok: true, task, replay: true };
  const trimmed = note?.trim();
  const { finalRunId: _final, finalRetryAt: _retry, ...rest } = state;
  return {
    ok: true,
    replay: false,
    task: {
      ...task,
      enabled: false,
      disabledReason: 'once_completed',
      nextRunAt: undefined,
      manualRunRequested: undefined,
      untilDone: {
        ...rest,
        status: 'done',
        doneAt: new Date(nowMs).toISOString(),
        ...(trimmed ? { doneNote: Array.from(trimmed).slice(0, UNTIL_DONE_NOTE_MAX_CHARS).join('') } : {}),
      },
    },
  };
}

/** Where a resumed open until-done one-shot should run next: its planned time,
 *  or right away when that has passed (a plain one-shot would never fire again). */
export function untilDoneResumeNextRunAt(task: ScheduledTask, nowMs: number): string | undefined {
  if (task.untilDone?.status !== 'open' || task.parsed.kind !== 'once') return undefined;
  const runAtMs = task.parsed.runAt ? Date.parse(task.parsed.runAt) : Number.NaN;
  return new Date(Number.isNaN(runAtMs) ? nowMs : Math.max(nowMs, runAtMs)).toISOString();
}

/** Owner notifications earned by a settlement (before → after). */
export function scheduleNotificationsFor(
  before: Pick<ScheduledTask, 'untilDone' | 'runStats'>,
  after: Pick<ScheduledTask, 'untilDone' | 'runStats' | 'notify'>,
): ScheduleNotifyEvent[] {
  const wanted = after.notify ?? [];
  const events: ScheduleNotifyEvent[] = [];
  if (wanted.includes('expired') && before.untilDone?.status === 'open' && after.untilDone?.status === 'expired') {
    events.push('expired');
  }
  if (wanted.includes('failing')
    && (after.runStats?.consecutiveFailures ?? 0) >= SCHEDULE_FAILING_THRESHOLD
    && !after.runStats?.failingNotifiedAt) {
    events.push('failing');
  }
  return events;
}

/** Where an owner notification goes. Always sent by the task's own bot:
 *  `ownerOpenId` is scoped to that app, so it is only a valid mention there.
 *  Lands in the topic/chat where the task was created when that was the same
 *  bot, else in the execution chat (thread when the task has one). */
export function scheduleNotificationTarget(
  task: Pick<ScheduledTask, 'larkAppId' | 'chatId' | 'rootMessageId' | 'creatorChatId'
    | 'creatorRootMessageId' | 'creatorLarkAppId' | 'ownerOpenId'>,
  fallbackAppId: string,
): { appId: string; chatId: string; rootMessageId?: string; mentionOpenId?: string } {
  const appId = task.larkAppId ?? fallbackAppId;
  const createdHere = !!task.creatorChatId
    && (!task.creatorLarkAppId || task.creatorLarkAppId === appId);
  const rootMessageId = createdHere ? task.creatorRootMessageId : task.rootMessageId;
  return {
    appId,
    chatId: createdHere ? task.creatorChatId! : task.chatId,
    ...(rootMessageId ? { rootMessageId } : {}),
    ...(task.ownerOpenId ? { mentionOpenId: task.ownerOpenId } : {}),
  };
}

export function scheduleNotificationText(
  task: Pick<ScheduledTask, 'id' | 'name' | 'lastError'>,
  event: ScheduleNotifyEvent,
): string {
  return event === 'expired'
    ? `定时任务「${task.name}」（${task.id}）已到截止时间：最后一次收尾执行已发起，之后不再执行。`
    : `定时任务「${task.name}」（${task.id}）已连续失败 ${SCHEDULE_FAILING_THRESHOLD} 次，`
      + `最近一次错误：${task.lastError ?? '未知'}。系统会按计划继续重试。`;
}

/** Hidden run context appended to every until-done run's prompt, so the task
 *  author only states what to wait for and what to do. */
export function buildUntilDoneRunPrompt(
  task: Pick<ScheduledTask, 'id' | 'untilDone'>,
  runId: string,
  formatTime: (iso: string) => string,
): string | undefined {
  const state = task.untilDone;
  if (state?.status !== 'open') return undefined;
  const attempt = state.attempts + 1;
  const deadline = state.deadline ? `，截止 ${formatTime(state.deadline)}` : '';
  if (state.finalRunId === runId) {
    return [
      `[botmux 跟进任务] 定时任务 ${task.id} 已到截止时间${deadline}，这是最后一次执行（第 ${attempt} 次）。`,
      '- 按现状收尾：已经完成就先运行 `botmux schedule done self --note "<一句话结果>"`，再发最终答复。',
      '- 做不完就用 botmux send 说明现状与原因。本轮结束后任务自动关闭，不会再执行。',
    ].join('\n');
  }
  return [
    `[botmux 跟进任务] 这是「直到完成」定时任务 ${task.id} 的第 ${attempt} 次执行${deadline}。`,
    '- 先判断要等的条件是否已经满足、要做的事是否已经做完。',
    '- 已完成：先运行 `botmux schedule done self --note "<一句话结果>"`，再发最终答复；任务随即结束。',
    '- 未完成：直接结束本轮即可，不要删除或暂停任务，系统会按计划再次执行。',
  ].join('\n');
}

/** Human-readable state lines for `botmux schedule list`. */
export function describeScheduleState(
  task: Pick<ScheduledTask, 'untilDone' | 'runStats' | 'notify'>,
  formatTime: (iso: string) => string,
): string[] {
  const lines: string[] = [];
  const state = task.untilDone;
  if (state) {
    const label = state.status === 'open' ? '进行中' : state.status === 'done' ? '已完成' : '已到期';
    const parts = [`直到完成 · ${label}`, `已执行 ${state.attempts} 次`];
    if (state.deadline) parts.push(`截止 ${formatTime(state.deadline)}`);
    if (state.status === 'done' && state.doneAt) parts.push(`完成于 ${formatTime(state.doneAt)}`);
    if (state.status === 'expired' && state.expiredAt) parts.push(`到期于 ${formatTime(state.expiredAt)}`);
    lines.push(`状态: ${parts.join(' · ')}`);
    if (state.doneNote) lines.push(`结果: ${state.doneNote}`);
  }
  const stats = task.runStats;
  if (stats) {
    const missed = stats.missed > 0 && stats.lastMissedAt
      ? `错过 ${stats.missed}（最近 ${formatTime(stats.lastMissedAt)}）`
      : `错过 ${stats.missed}`;
    const streak = stats.consecutiveFailures > 0 ? ` · 连续失败 ${stats.consecutiveFailures}` : '';
    lines.push(`账本: 执行 ${stats.dispatched} · 跳过 ${stats.skipped} · 失败 ${stats.failed} · ${missed}${streak}`);
  }
  if (task.notify?.length) lines.push(`通知: ${task.notify.join(', ')}`);
  return lines;
}
