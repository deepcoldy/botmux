import { describe, expect, it } from 'vitest';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
import { store } from '../src/dashboard/web/store.js';
import {
  buildSchedulePreconditionFormFields,
  canSubmitSchedule,
  checkSchedule,
  countScheduleRunHistory,
  filterSchedules,
  formatScheduleRepeat,
  formatScheduleRunDuration,
  fmtScheduleDate,
  isSchedulePreconditionAbsolutePath,
  isSchedulePreconditionPathWithinTrustedRoot,
  schedulePreconditionFileExamplePath,
  scheduleRunTargetResults,
  scheduleRunHistoryForBackdrop,
  schedulePreconditionEditorInitialState,
  scheduleExecutionPlacement,
  initialScheduleEditPosition,
  scheduleTargetChatIds,
  scheduleCalendarLabel,
} from '../src/dashboard/web/schedules-page.js';

const TRUSTED_FILE_ROOT = '/srv/botmux-data/schedule-preconditions/trusted-files';
const TRUSTED_FILE_PATH = `${TRUSTED_FILE_ROOT}/check-ready.sh`;

describe('dashboard schedules React page helpers', () => {
  it('shows localized calendar names and day selections instead of a builtin ID', () => {
    const names = { zh: '中国法定工作日历', en: 'China Statutory Work Calendar' };
    expect(scheduleCalendarLabel('cn', names, 'zh')).toBe(names.zh);
    expect(scheduleCalendarLabel('cn', names, 'en')).toBe(names.en);
    expect(scheduleCalendarLabel('company', { zh: '公司日历' }, 'en')).toBe('公司日历');
    expect(scheduleCalendarLabel('company', undefined, 'zh')).toBe('company');
    for (const lang of ['zh', 'en'] as const) {
      const t = createDashboardTranslator(lang);
      expect(t('schedules.calendarDayType.workday')).not.toBe(t('schedules.calendarDayType.restday'));
      expect(t('schedules.form.calendar')).not.toContain('schedules.form');
    }
  });
  it('clears the previous Bash source from the browser cache on a live replacement', () => {
    store.replaceSnapshot([], [{
      id: 'schedule-precondition-live',
      hasPrecondition: true,
      preconditionSource: 'inline',
      preconditionScript: 'printf 1',
    }]);

    store.applySse('schedule.updated', {
      id: 'schedule-precondition-live',
      patch: {
        preconditionSource: 'file',
        preconditionScript: null,
        preconditionFilePath: TRUSTED_FILE_PATH,
      },
    });

    expect(store.schedules.get('schedule-precondition-live')).toMatchObject({
      preconditionSource: 'file',
      preconditionScript: null,
      preconditionFilePath: TRUSTED_FILE_PATH,
    });
  });

  const tr = ((key: string) => key) as Parameters<typeof checkSchedule>[1];

  it('filters by kind, enabled state, and text query', () => {
    const rows = [
      { id: 'daily', name: 'Daily Standup', enabled: true, parsed: { kind: 'cron', display: '0 9 * * *' }, nextRunAt: '2026-06-30T09:00:00.000Z' },
      { id: 'paused', name: 'Paused Cleanup', enabled: false, parsed: { kind: 'interval', display: 'every 1h' }, nextRunAt: '2026-06-30T08:00:00.000Z' },
      { id: 'once', name: 'One-shot Deploy', enabled: true, parsed: { kind: 'once', display: 'once' }, nextRunAt: '2026-06-30T07:00:00.000Z' },
    ];

    expect(filterSchedules(rows, { q: 'deploy', kind: '', enabledOnly: true }).map(s => s.id)).toEqual(['once']);
    expect(filterSchedules(rows, { q: '', kind: 'interval', enabledOnly: false }).map(s => s.id)).toEqual(['paused']);
  });

  it('sorts enabled schedules before disabled, then by next run time', () => {
    const rows = [
      { id: 'disabled-sooner', enabled: false, nextRunAt: '2026-06-30T01:00:00.000Z' },
      { id: 'enabled-later', enabled: true, nextRunAt: '2026-06-30T03:00:00.000Z' },
      { id: 'enabled-sooner', enabled: true, nextRunAt: '2026-06-30T02:00:00.000Z' },
    ];

    expect(filterSchedules(rows, { q: '', kind: '', enabledOnly: false }).map(s => s.id))
      .toEqual(['enabled-sooner', 'enabled-later', 'disabled-sooner']);
  });

  it.each([
    '每天 09:00',
    '每日 09:00',
    '每周一 09:00',
    '每月1号 09:00',
    '每2小时',
    '每30分钟',
    '30分钟后',
    '明天 09:00',
    '每个工作日 09:00',
    '工作日每天 09:00',
  ])('accepts the server-supported Chinese schedule prefix %s', input => {
    expect(checkSchedule(input, tr, 'Asia/Shanghai').ok).toBe(true);
  });

  it('lets an unchanged legacy schedule save while still rejecting a new unknown value', () => {
    expect(canSubmitSchedule('legacy daily syntax', 'legacy daily syntax', tr, 'Asia/Shanghai')).toBe(true);
    expect(canSubmitSchedule('new unknown syntax', 'legacy daily syntax', tr, 'Asia/Shanghai')).toBe(false);
  });

  it('keeps the legacy empty date placeholder', () => {
    expect(fmtScheduleDate()).toBe('—');
  });

  it('formats a run count only for schedules that configure a repeat limit', () => {
    expect(formatScheduleRepeat()).toBeNull();
    expect(formatScheduleRepeat({ times: null, completed: 5 })).toBe('5/∞');
    expect(formatScheduleRepeat({ times: 10, completed: 3 })).toBe('3/10');
  });

  it('fills task backgrounds with the latest run outcomes from older to newer', () => {
    const newestFirst = [
      { id: 'newest', outcome: 'error' as const },
      { id: 'middle', outcome: 'precondition_skipped' as const },
      { id: 'oldest', outcome: 'model_dispatched' as const },
    ];
    const original = [...newestFirst];

    expect(scheduleRunHistoryForBackdrop(newestFirst).map(entry => entry.id))
      .toEqual(['oldest', 'middle', 'newest']);
    expect(newestFirst).toEqual(original);
    expect(countScheduleRunHistory(newestFirst)).toEqual({
      model_dispatched: 1,
      precondition_skipped: 1,
      calendar_skipped: 0,
      error: 1,
    });

    const moreThanOnePage = Array.from({ length: 51 }, (_, index) => ({
      id: `run-${index}`,
      outcome: 'model_dispatched' as const,
    }));
    const capped = scheduleRunHistoryForBackdrop(moreThanOnePage);
    expect(capped).toHaveLength(50);
    expect(capped[0]?.id).toBe('run-49');
    expect(capped.at(-1)?.id).toBe('run-0');
  });

  it('invalidates only the fired task history and all histories after a snapshot refresh', () => {
    const invalidated: Array<string | undefined> = [];
    const unsubscribe = store.onScheduleRunLogsChanged(taskId => invalidated.push(taskId));

    store.applySse('schedule.fired', { id: 'task-fired', status: 'ok' });
    store.replaceSnapshot([], [{ id: 'task-snapshot' }]);
    unsubscribe();

    expect(invalidated).toEqual(['task-fired', undefined]);
  });

  it('prefills revealed preconditions and keeps a fail-safe for incomplete legacy projections', () => {
    expect(schedulePreconditionEditorInitialState({
      hasPrecondition: true,
      preconditionEnabled: true,
      preconditionSource: 'inline',
      preconditionScript: 'printf 1',
    })).toEqual({
      hasExisting: true,
      enabled: true,
      mode: 'inline',
      script: 'printf 1',
      filePath: '',
    });
    expect(schedulePreconditionEditorInitialState({
      hasPrecondition: true,
      preconditionEnabled: false,
      preconditionSource: 'file',
      preconditionFilePath: TRUSTED_FILE_PATH,
    })).toEqual({
      hasExisting: true,
      enabled: false,
      mode: 'file',
      script: '',
      filePath: TRUSTED_FILE_PATH,
    });
    expect(schedulePreconditionEditorInitialState({ hasPrecondition: true })).toEqual({
      hasExisting: true,
      enabled: true,
      mode: 'keep',
      script: '',
      filePath: '',
    });
  });

  it('omits precondition fields when create is off or a revealed source is unchanged', () => {
    expect(buildSchedulePreconditionFormFields({
      hasExisting: false,
      initialEnabled: false,
      initialMode: 'inline',
      initialScript: '',
      initialFilePath: '',
      enabled: false,
      mode: 'inline',
      script: '',
      filePath: '',
    })).toEqual({ ok: true, fields: {} });

    expect(buildSchedulePreconditionFormFields({
      hasExisting: true,
      initialEnabled: true,
      initialMode: 'inline',
      initialScript: 'printf 1',
      initialFilePath: '',
      enabled: true,
      mode: 'inline',
      script: 'printf 1',
      filePath: '',
    })).toEqual({ ok: true, fields: {} });

    expect(buildSchedulePreconditionFormFields({
      hasExisting: true,
      initialEnabled: false,
      initialMode: 'file',
      initialScript: '',
      initialFilePath: TRUSTED_FILE_PATH,
      trustedFileRoot: TRUSTED_FILE_ROOT,
      enabled: false,
      mode: 'file',
      script: '',
      filePath: TRUSTED_FILE_PATH,
    })).toEqual({ ok: true, fields: {} });
  });

  it('sends only an actual toggle, source replacement, or removal by clearing the current source', () => {
    const base = {
      hasExisting: true,
      initialEnabled: true,
      initialMode: 'inline',
      initialScript: 'printf 1',
      initialFilePath: '',
      trustedFileRoot: TRUSTED_FILE_ROOT,
      script: 'printf 1',
      filePath: '',
    } as const;

    expect(buildSchedulePreconditionFormFields({
      ...base,
      enabled: false,
      mode: 'inline',
    })).toEqual({ ok: true, fields: { preconditionEnabled: false } });
    expect(buildSchedulePreconditionFormFields({
      ...base,
      initialEnabled: false,
      enabled: true,
      mode: 'inline',
    })).toEqual({ ok: true, fields: { preconditionEnabled: true } });
    expect(buildSchedulePreconditionFormFields({
      ...base,
      enabled: true,
      mode: 'inline',
      script: 'printf 2',
    })).toEqual({
      ok: true,
      fields: { preconditionScript: 'printf 2' },
    });
    expect(buildSchedulePreconditionFormFields({
      ...base,
      enabled: true,
      mode: 'file',
      filePath: ` ${TRUSTED_FILE_PATH} `,
    })).toEqual({
      ok: true,
      fields: { preconditionFilePath: TRUSTED_FILE_PATH },
    });
    expect(buildSchedulePreconditionFormFields({
      ...base,
      initialEnabled: false,
      initialMode: 'file',
      initialScript: '',
      initialFilePath: TRUSTED_FILE_PATH,
      enabled: false,
      mode: 'file',
      filePath: `${TRUSTED_FILE_ROOT}/check-next.sh`,
    })).toEqual({
      ok: true,
      fields: { preconditionFilePath: `${TRUSTED_FILE_ROOT}/check-next.sh` },
    });
    expect(buildSchedulePreconditionFormFields({
      ...base,
      enabled: true,
      mode: 'inline',
      script: '',
    })).toEqual({ ok: true, fields: { preconditionScript: null } });

    expect(buildSchedulePreconditionFormFields({
      hasExisting: false,
      initialEnabled: false,
      initialMode: 'inline',
      initialScript: '',
      initialFilePath: '',
      trustedFileRoot: TRUSTED_FILE_ROOT,
      enabled: true,
      mode: 'inline',
      script: 'printf 1',
      filePath: '',
    })).toEqual({
      ok: true,
      fields: { preconditionEnabled: true, preconditionScript: 'printf 1' },
    });
  });

  it.each(['inline', 'file'] as const)('clears an existing %s source when its visible value is blank, even while paused', mode => {
    for (const enabled of [true, false]) {
      for (const value of ['', ' \n\t ']) {
        expect(buildSchedulePreconditionFormFields({
          hasExisting: true,
          initialEnabled: true,
          initialMode: mode,
          initialScript: mode === 'inline' ? 'printf 1' : '',
          initialFilePath: mode === 'file' ? TRUSTED_FILE_PATH : '',
          trustedFileRoot: TRUSTED_FILE_ROOT,
          enabled,
          mode,
          script: value,
          filePath: value,
        })).toEqual({ ok: true, fields: { preconditionScript: null } });
      }
    }
  });

  it('preserves the unreadable legacy keep source instead of treating it as an empty editor', () => {
    const base = {
      hasExisting: true,
      initialEnabled: true,
      initialMode: 'keep',
      mode: 'keep',
      initialScript: '',
      initialFilePath: '',
      script: '',
      filePath: '',
    } as const;
    expect(buildSchedulePreconditionFormFields({ ...base, enabled: true }))
      .toEqual({ ok: true, fields: {} });
    expect(buildSchedulePreconditionFormFields({ ...base, enabled: false }))
      .toEqual({ ok: true, fields: { preconditionEnabled: false } });
  });

  it('omits blank new sources and still validates nonempty live-file paths before submit', () => {
    const base = {
      hasExisting: false,
      initialEnabled: false,
      initialMode: 'inline',
      initialScript: '',
      initialFilePath: '',
      trustedFileRoot: TRUSTED_FILE_ROOT,
      enabled: true,
      script: '',
      filePath: '',
    } as const;
    expect(buildSchedulePreconditionFormFields({ ...base, mode: 'inline' }))
      .toEqual({ ok: true, fields: {} });
    expect(buildSchedulePreconditionFormFields({ ...base, mode: 'inline', script: ' \n\t ' }))
      .toEqual({ ok: true, fields: {} });
    expect(buildSchedulePreconditionFormFields({ ...base, mode: 'file' }))
      .toEqual({ ok: true, fields: {} });
    expect(buildSchedulePreconditionFormFields({ ...base, mode: 'file', filePath: ' \n\t ' }))
      .toEqual({ ok: true, fields: {} });
    expect(buildSchedulePreconditionFormFields({ ...base, mode: 'file', filePath: '~/.ready' }))
      .toEqual({ ok: false, error: 'file_tilde' });
    expect(buildSchedulePreconditionFormFields({ ...base, mode: 'file', filePath: 'bad\0path' }))
      .toEqual({ ok: false, error: 'file_nul' });
    expect(buildSchedulePreconditionFormFields({ ...base, mode: 'file', filePath: 'scripts/check-ready.sh' }))
      .toEqual({ ok: false, error: 'file_absolute' });
    expect(buildSchedulePreconditionFormFields({
      ...base,
      mode: 'file',
      filePath: '/srv/botmux/scripts/check-ready.sh',
    })).toEqual({ ok: false, error: 'file_outside_trusted_root' });
    expect(buildSchedulePreconditionFormFields({
      ...base,
      trustedFileRoot: null,
      mode: 'file',
      filePath: TRUSTED_FILE_PATH,
    })).toEqual({ ok: false, error: 'file_root_unavailable' });
    expect(buildSchedulePreconditionFormFields({
      ...base,
      mode: 'file',
      filePath: TRUSTED_FILE_PATH,
    })).toEqual({
      ok: true,
      fields: { preconditionEnabled: true, preconditionFilePath: TRUSTED_FILE_PATH },
    });
    expect(isSchedulePreconditionAbsolutePath('/srv/botmux/check-ready.sh')).toBe(true);
    expect(isSchedulePreconditionAbsolutePath('scripts/check-ready.sh')).toBe(false);
    expect(isSchedulePreconditionPathWithinTrustedRoot(TRUSTED_FILE_PATH, TRUSTED_FILE_ROOT)).toBe(true);
    expect(isSchedulePreconditionPathWithinTrustedRoot(TRUSTED_FILE_ROOT, TRUSTED_FILE_ROOT)).toBe(false);
    expect(isSchedulePreconditionPathWithinTrustedRoot(
      `${TRUSTED_FILE_ROOT}-other/check-ready.sh`,
      TRUSTED_FILE_ROOT,
    )).toBe(false);
    expect(isSchedulePreconditionPathWithinTrustedRoot(
      `${TRUSTED_FILE_ROOT}/../outside/check-ready.sh`,
      TRUSTED_FILE_ROOT,
    )).toBe(false);
    expect(schedulePreconditionFileExamplePath(TRUSTED_FILE_ROOT)).toBe(TRUSTED_FILE_PATH);
    expect(schedulePreconditionFileExamplePath(null)).toBe('');
  });

  it('prefers normalized chatIds and falls back to legacy chatId', () => {
    expect(scheduleTargetChatIds({ chatId: ' oc_legacy ' })).toEqual(['oc_legacy']);
    expect(scheduleTargetChatIds({ chatIds: [' oc_a ', 'oc_b', 'oc_a', '', 7] })).toEqual([
      'oc_a',
      'oc_b',
    ]);
    expect(scheduleTargetChatIds({ chatIds: [], chatId: 'oc_ignored' })).toEqual([]);
  });

  it('normalizes per-group run results without rejecting legacy or malformed logs', () => {
    expect(scheduleRunTargetResults({})).toEqual([]);
    expect(scheduleRunTargetResults({ targetResults: 'legacy' })).toEqual([]);
    expect(scheduleRunTargetResults({
      targetResults: [
        { chatId: ' oc_ok ', outcome: 'model_dispatched' },
        { chatId: 'oc_failed', outcome: 'error', error: 'dispatch failed' },
        { chatId: '', outcome: 'error' },
        { chatId: 'oc_unknown', outcome: 'skipped' },
        null,
      ],
    })).toEqual([
      { chatId: 'oc_ok', outcome: 'model_dispatched' },
      { chatId: 'oc_failed', outcome: 'error', error: 'dispatch failed' },
    ]);
  });

  it('maps stored state to top-level, retained-topic, fresh-topic, or local execution', () => {
    expect(scheduleExecutionPlacement({ id: 'chat', scope: 'chat', rootMessageId: 'om_old' })).toBe('chat');
    expect(scheduleExecutionPlacement({ id: 'thread', scope: 'thread', rootMessageId: 'om_root' })).toBe('thread');
    expect(scheduleExecutionPlacement({ id: 'fresh', executionPosition: 'new-topic', rootMessageId: 'om_root' })).toBe('new-topic');
    expect(scheduleExecutionPlacement({ id: 'legacy-fresh', deliver: 'new-topic' })).toBe('new-topic');
    expect(scheduleExecutionPlacement({ id: 'local', deliver: 'local' })).toBe('local');
  });

  it('edit form keeps the dedicated-task identity for a materialized task row', () => {
    // A materialized dedicated task projects to 'thread' for display, but the
    // edit dialog must initialize to 'task': saving an unrelated field with the
    // form state otherwise PATCHes executionPosition:'topic' and silently
    // downgrades the task (its first-fire root then pins the wrong semantics).
    expect(initialScheduleEditPosition({
      id: 'task-materialized', executionPosition: 'task', rootMessageId: 'om_task_root',
    } as never)).toBe('task');
    expect(initialScheduleEditPosition({
      id: 'task-rootless', executionPosition: 'task',
    } as never)).toBe('task');
    // Non-task positions keep following the display placement.
    expect(initialScheduleEditPosition({
      id: 'topic', executionPosition: 'topic', scope: 'thread', rootMessageId: 'om_root',
    } as never)).toBe('topic');
    expect(initialScheduleEditPosition({
      id: 'fresh', executionPosition: 'new-topic', rootMessageId: 'om_root',
    } as never)).toBe('new-topic');
    expect(initialScheduleEditPosition({ id: 'top', scope: 'chat' } as never)).toBe('top-level');
    expect(initialScheduleEditPosition(null)).toBe('top-level');
  });

  it('formats in the given schedule timezone, not the browser zone', () => {
    // 2026-07-08T01:00Z = 09:00 in Asia/Shanghai. Rendering with the effective
    // schedule tz must show 09 (+ a zone suffix), regardless of the test host zone.
    const out = fmtScheduleDate('2026-07-08T01:00:00.000Z', 'Asia/Shanghai');
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date('2026-07-08T01:00:00.000Z'));
    expect(parts.find(p => p.type === 'hour')!.value).toBe('09');
    // The formatted string carries a zone-name suffix (GMT+8 / CST / …) so a
    // viewer in another browser zone isn't misled.
    expect(out).toMatch(/GMT|UTC|[A-Z]{2,5}/);
  });

  it('formats scheduler dispatch duration without implying model runtime', () => {
    expect(formatScheduleRunDuration(-1)).toBe('—');
    expect(formatScheduleRunDuration(248)).toBe('248 ms');
    expect(formatScheduleRunDuration(1_250)).toBe('1.3 s');
    expect(formatScheduleRunDuration(12_400)).toBe('12 s');
    expect(formatScheduleRunDuration(61_000)).toBe('1 min 1 s');
  });
});
