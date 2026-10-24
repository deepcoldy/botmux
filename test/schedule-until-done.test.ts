import { describe, expect, it } from 'vitest';
import {
  buildUntilDoneRunPrompt,
  completeUntilDone,
  describeScheduleState,
  isAutoCompletedSchedule,
  markUntilDoneFinalRun,
  normalizeRunStats,
  normalizeUntilDone,
  parseScheduleNotify,
  recordMissed,
  recordRunOutcome,
  resolveUntilDoneConfig,
  SCHEDULE_FAILING_THRESHOLD,
  scheduleNotificationsFor,
  scheduleNotificationTarget,
  scheduleNotificationText,
  settleUntilDoneRun,
  settleUntilDoneSkip,
  UNTIL_DONE_DEFAULT_RETRY_MINUTES,
  UNTIL_DONE_ERROR_RETRY_MINUTES,
  untilDoneDeadlineDue,
  untilDoneResumeNextRunAt,
} from '../src/services/schedule-until-done.js';
import type { ScheduledTask } from '../src/types.js';

const NOW = Date.parse('2026-10-24T02:00:00.000Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'a1b2c3d4', name: 'follow up', schedule: '7 10 * * *',
    parsed: { kind: 'cron', expr: '7 10 * * *', display: '7 10 * * *' },
    prompt: 'after the PR merges, switch the fleet', workingDir: '/repo', chatId: 'oc_chat',
    enabled: true, createdAt: iso(NOW - 60 * MIN),
    ...overrides,
  };
}

const onceAt = (ms: number) => ({ kind: 'once' as const, runAt: iso(ms), display: 'once' });
const open = (extra: Partial<NonNullable<ScheduledTask['untilDone']>> = {}) =>
  ({ status: 'open' as const, attempts: 0, ...extra });

describe('resolveUntilDoneConfig', () => {
  it('starts an open state with the normalized deadline and retry interval', () => {
    expect(resolveUntilDoneConfig({
      untilDone: { deadline: '2026-11-20T00:00:00+08:00', retryMinutes: 360 },
      notify: ['expired', 'failing'],
      parsed: onceAt(NOW + 60 * MIN),
      nowMs: NOW,
    })).toEqual({
      untilDone: { status: 'open', attempts: 0, deadline: '2026-11-19T16:00:00.000Z', retryMinutes: 360 },
      notify: ['failing', 'expired'],
    });
  });

  it.each([
    [{ deadline: iso(NOW - MIN) }, 'until_done_deadline_past'],
    [{ deadline: 'someday' }, 'until_done_deadline_invalid'],
    [{ deadline: iso(NOW + 30 * MIN) }, 'until_done_deadline_before_first_run'],
    [{ retryMinutes: 0 }, 'until_done_retry_invalid'],
  ])('rejects %j for a one-shot', (untilDone, code) => {
    expect(() => resolveUntilDoneConfig({ untilDone, parsed: onceAt(NOW + 60 * MIN), nowMs: NOW }))
      .toThrow(code);
  });

  it('keeps retry intervals to one-shots and expiry notices to until-done tasks', () => {
    const parsed = task().parsed;
    expect(() => resolveUntilDoneConfig({ untilDone: { retryMinutes: 60 }, parsed, nowMs: NOW }))
      .toThrow('until_done_retry_requires_once');
    expect(() => resolveUntilDoneConfig({ notify: ['expired'], parsed, nowMs: NOW }))
      .toThrow('notify_expired_requires_until_done');
    expect(resolveUntilDoneConfig({ notify: ['failing'], parsed, nowMs: NOW })).toEqual({ notify: ['failing'] });
    expect(() => resolveUntilDoneConfig({
      untilDone: {}, parsed, repeat: { times: 3, completed: 0 }, nowMs: NOW,
    })).toThrow('until_done_repeat_unsupported');
  });

  it('parses notify lists in canonical order and rejects unknown events', () => {
    expect(parseScheduleNotify('expired, failing,expired')).toEqual(['failing', 'expired']);
    expect(() => parseScheduleNotify('done')).toThrow('notify_event_invalid:done');
    expect(() => parseScheduleNotify(' , ')).toThrow('notify_events_required');
  });
});

describe('run ledger', () => {
  it('counts outcomes and resets the failure streak on the next dispatch', () => {
    let stats = recordRunOutcome(undefined, 'failed');
    stats = recordRunOutcome(stats, 'failed');
    stats = recordRunOutcome(stats, 'skipped');
    expect(stats).toMatchObject({ dispatched: 0, failed: 2, skipped: 1, consecutiveFailures: 2 });
    stats = recordRunOutcome({ ...stats, failingNotifiedAt: iso(NOW) }, 'dispatched');
    expect(stats).toEqual({ dispatched: 1, skipped: 1, failed: 2, missed: 0, consecutiveFailures: 0 });
    expect(recordMissed(stats, iso(NOW))).toMatchObject({ missed: 1, lastMissedAt: iso(NOW) });
  });

  it('rebuilds persisted state field by field', () => {
    expect(normalizeRunStats({ dispatched: 2.7, failed: -1, missed: '3', lastMissedAt: 'never' }))
      .toEqual({ dispatched: 2, skipped: 0, failed: 0, missed: 0, consecutiveFailures: 0 });
    expect(normalizeRunStats(null)).toBeUndefined();
    expect(normalizeUntilDone({ status: 'weird', attempts: 4, deadline: 'x', doneNote: '  ok  ' }))
      .toEqual({ status: 'open', attempts: 4, doneNote: 'ok' });
    expect(normalizeUntilDone([])).toBeUndefined();
  });
});

describe('settleUntilDoneRun', () => {
  it('re-arms an unfinished one-shot instead of consuming it', () => {
    const consumed = task({ parsed: onceAt(NOW - MIN), enabled: false, disabledReason: 'once_completed',
      untilDone: open({ retryMinutes: 120 }) });
    expect(settleUntilDoneRun(consumed, { success: true, runId: 'r1', nowMs: NOW })).toMatchObject({
      enabled: true, disabledReason: undefined, nextRunAt: iso(NOW + 120 * MIN),
      untilDone: { status: 'open', attempts: 1 },
    });
    const failed = settleUntilDoneRun({ ...consumed, untilDone: open() }, { success: false, runId: 'r1', nowMs: NOW });
    expect(failed).toMatchObject({ enabled: true, nextRunAt: iso(NOW + UNTIL_DONE_ERROR_RETRY_MINUTES * MIN),
      untilDone: { attempts: 0 } });
    expect(UNTIL_DONE_ERROR_RETRY_MINUTES).toBeLessThan(UNTIL_DONE_DEFAULT_RETRY_MINUTES);
  });

  it('leaves a recurring task on its own cadence', () => {
    const recurring = task({ nextRunAt: iso(NOW + 24 * 60 * MIN), untilDone: open() });
    expect(settleUntilDoneRun(recurring, { success: false, runId: 'r1', nowMs: NOW }))
      .toMatchObject({ enabled: true, nextRunAt: iso(NOW + 24 * 60 * MIN), untilDone: { attempts: 0 } });
  });

  it('never re-enables a task closed while its run was in flight', () => {
    const closed = task({ enabled: false, untilDone: { status: 'done', attempts: 2 } });
    expect(settleUntilDoneRun(closed, { success: true, runId: 'r1', nowMs: NOW }))
      .toMatchObject({ enabled: false, untilDone: { status: 'done', attempts: 2 } });
  });

  it('expires after the closing run, retrying a failed closing run a bounded number of times', () => {
    const claimed = markUntilDoneFinalRun(task({ untilDone: open({ deadline: iso(NOW - MIN) }) }), 'final-1');
    expect(settleUntilDoneRun(claimed, { success: true, runId: 'final-1', nowMs: NOW })).toMatchObject({
      enabled: false, disabledReason: 'once_completed',
      untilDone: { status: 'expired', attempts: 1, expiredAt: iso(NOW) },
    });

    let current = claimed;
    for (let attempt = 1; attempt < SCHEDULE_FAILING_THRESHOLD; attempt++) {
      current = settleUntilDoneRun(current, { success: false, runId: current.untilDone!.finalRunId, nowMs: NOW });
      expect(current.untilDone).toMatchObject({ status: 'open', finalFailures: attempt,
        finalRetryAt: iso(NOW + UNTIL_DONE_ERROR_RETRY_MINUTES * MIN) });
      expect(untilDoneDeadlineDue(current, NOW)).toBe(false);
      expect(untilDoneDeadlineDue(current, NOW + UNTIL_DONE_ERROR_RETRY_MINUTES * MIN)).toBe(true);
      current = markUntilDoneFinalRun(current, `final-${attempt + 1}`);
    }
    expect(settleUntilDoneRun(current, { success: false, runId: current.untilDone!.finalRunId, nowMs: NOW }))
      .toMatchObject({ enabled: false, untilDone: { status: 'expired' } });
  });

  it('treats a skipped closing run as expiry and ignores other skips', () => {
    const claimed = markUntilDoneFinalRun(task({ untilDone: open({ deadline: iso(NOW - MIN) }) }), 'final-1');
    expect(settleUntilDoneSkip(claimed, 'final-1', NOW)).toMatchObject({
      enabled: false, untilDone: { status: 'expired' },
    });
    expect(settleUntilDoneSkip(claimed, 'other-run', NOW)).toBe(claimed);
  });
});

describe('deadline and completion', () => {
  it('is due only once the deadline passed and no closing run is in flight', () => {
    const t = task({ untilDone: open({ deadline: iso(NOW) }) });
    expect(untilDoneDeadlineDue(t, NOW - 1)).toBe(false);
    expect(untilDoneDeadlineDue(t, NOW)).toBe(true);
    expect(untilDoneDeadlineDue(markUntilDoneFinalRun(t, 'final'), NOW)).toBe(false);
    expect(untilDoneDeadlineDue(task({ untilDone: open() }), NOW)).toBe(false);
  });

  it('closes as done once, replays afterwards, and refuses plain tasks', () => {
    const first = completeUntilDone(task({ untilDone: open({ attempts: 2 }) }), '  merged  ', NOW);
    expect(first).toMatchObject({ ok: true, replay: false, task: {
      enabled: false, disabledReason: 'once_completed', nextRunAt: undefined,
      untilDone: { status: 'done', attempts: 2, doneAt: iso(NOW), doneNote: 'merged' },
    } });
    expect(completeUntilDone((first as { task: ScheduledTask }).task, 'again', NOW + MIN))
      .toMatchObject({ ok: true, replay: true });
    expect(completeUntilDone(task(), undefined, NOW)).toEqual({ ok: false, error: 'schedule_not_until_done' });
    expect(completeUntilDone(task({ untilDone: { status: 'expired', attempts: 3 } }), undefined, NOW))
      .toMatchObject({ ok: true, task: { untilDone: { status: 'done' } } });
  });

  it('keeps the closing turn authorized like a completed one-shot, but not a manual pause', () => {
    expect(isAutoCompletedSchedule({ disabledReason: 'once_completed', parsed: task().parsed,
      untilDone: { status: 'done', attempts: 1 } })).toBe(true);
    expect(isAutoCompletedSchedule({ disabledReason: 'once_completed', parsed: task().parsed })).toBe(false);
    expect(isAutoCompletedSchedule({ disabledReason: 'manual', parsed: onceAt(NOW) })).toBe(false);
    expect(isAutoCompletedSchedule({ disabledReason: 'once_completed', parsed: onceAt(NOW) })).toBe(true);
  });

  it('resumes an open one-shot at its planned time or right away when that has passed', () => {
    expect(untilDoneResumeNextRunAt(task({ parsed: onceAt(NOW - MIN), untilDone: open() }), NOW)).toBe(iso(NOW));
    expect(untilDoneResumeNextRunAt(task({ parsed: onceAt(NOW + MIN), untilDone: open() }), NOW)).toBe(iso(NOW + MIN));
    expect(untilDoneResumeNextRunAt(task({ untilDone: open() }), NOW)).toBeUndefined();
  });
});

describe('notifications', () => {
  it('fires only opted-in events: expiry once, a failure streak once', () => {
    const before = task({ untilDone: open() });
    const expired = { ...before, untilDone: { status: 'expired' as const, attempts: 1 } };
    expect(scheduleNotificationsFor(before, expired)).toEqual([]);
    expect(scheduleNotificationsFor(before, { ...expired, notify: ['expired'] })).toEqual(['expired']);

    const failing = { ...before, notify: ['failing' as const],
      runStats: { dispatched: 0, skipped: 0, failed: 3, missed: 0, consecutiveFailures: SCHEDULE_FAILING_THRESHOLD } };
    expect(scheduleNotificationsFor(before, failing)).toEqual(['failing']);
    expect(scheduleNotificationsFor(before, {
      ...failing, runStats: { ...failing.runStats, failingNotifiedAt: iso(NOW) },
    })).toEqual([]);
    expect(scheduleNotificationsFor(before, {
      ...failing, runStats: { ...failing.runStats, consecutiveFailures: SCHEDULE_FAILING_THRESHOLD - 1 },
    })).toEqual([]);
  });
});

describe('notification target', () => {
  const base = { larkAppId: 'cli_owner', chatId: 'oc_exec', rootMessageId: 'om_exec', ownerOpenId: 'ou_creator' };

  it('replies in the creation topic when the same bot created the task', () => {
    expect(scheduleNotificationTarget({ ...base, creatorChatId: 'oc_origin', creatorRootMessageId: 'om_origin',
      creatorLarkAppId: 'cli_owner' }, 'cli_daemon')).toEqual({
      appId: 'cli_owner', chatId: 'oc_origin', rootMessageId: 'om_origin', mentionOpenId: 'ou_creator',
    });
    expect(scheduleNotificationTarget({ ...base, creatorChatId: 'oc_origin' }, 'cli_daemon'))
      .toEqual({ appId: 'cli_owner', chatId: 'oc_origin', mentionOpenId: 'ou_creator' });
  });

  it('stays on the task bot and its execution chat when another bot created it', () => {
    expect(scheduleNotificationTarget({ ...base, creatorChatId: 'oc_origin', creatorRootMessageId: 'om_origin',
      creatorLarkAppId: 'cli_other' }, 'cli_daemon')).toEqual({
      appId: 'cli_owner', chatId: 'oc_exec', rootMessageId: 'om_exec', mentionOpenId: 'ou_creator',
    });
    expect(scheduleNotificationTarget({ chatId: 'oc_exec' }, 'cli_daemon')).toEqual({ appId: 'cli_daemon', chatId: 'oc_exec' });
  });

  it('names the task and, for a failure streak, the last error', () => {
    const t = { id: 'a1b2c3d4', name: 'follow up', lastError: 'dispatch failed' };
    expect(scheduleNotificationText(t, 'failing')).toContain('dispatch failed');
    for (const event of ['failing', 'expired'] as const) {
      expect(scheduleNotificationText(t, event)).toContain('a1b2c3d4');
    }
  });
});

describe('run context and display', () => {
  const fmt = (value: string) => value.slice(0, 10);

  it('tells each run how to finish, and marks the closing run differently', () => {
    const t = task({ untilDone: open({ attempts: 2, deadline: iso(NOW) }) });
    const regular = buildUntilDoneRunPrompt(t, 'run-1', fmt)!;
    const closing = buildUntilDoneRunPrompt(markUntilDoneFinalRun(t, 'run-2'), 'run-2', fmt)!;
    for (const text of [regular, closing]) {
      expect(text).toContain('a1b2c3d4');
      expect(text).toContain('botmux schedule done self');
      expect(text).toContain('2026-10-24');
    }
    expect(closing).not.toEqual(regular);
    expect(buildUntilDoneRunPrompt(task({ untilDone: { status: 'done', attempts: 3 } }), 'run-3', fmt))
      .toBeUndefined();
    expect(buildUntilDoneRunPrompt(task(), 'run-4', fmt)).toBeUndefined();
  });

  it('shows state and ledger only for tasks that have them', () => {
    expect(describeScheduleState(task(), fmt)).toEqual([]);
    const lines = describeScheduleState(task({
      untilDone: { status: 'done', attempts: 3, doneAt: iso(NOW), doneNote: 'merged' },
      runStats: { dispatched: 3, skipped: 1, failed: 2, missed: 1, consecutiveFailures: 0, lastMissedAt: iso(NOW) },
      notify: ['failing'],
    }), fmt);
    expect(lines).toHaveLength(4);
    expect(lines.join('\n')).toMatch(/3[\s\S]*merged[\s\S]*3[\s\S]*1[\s\S]*2[\s\S]*1[\s\S]*failing/);
  });
});
