import { readFileSync } from 'node:fs';
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
  scheduleRunHistoryForBackdrop,
  schedulePreconditionEditorInitialState,
  schedulePreconditionPathExample,
  scheduleExecutionPlacement,
} from '../src/dashboard/web/schedules-page.js';

describe('dashboard schedules React page helpers', () => {
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
        preconditionFilePath: 'scripts/check-ready.sh',
      },
    });

    expect(store.schedules.get('schedule-precondition-live')).toMatchObject({
      preconditionSource: 'file',
      preconditionScript: null,
      preconditionFilePath: 'scripts/check-ready.sh',
    });
  });

  const tr = ((key: string) => key) as Parameters<typeof checkSchedule>[1];

  it('reads enabled filter checkbox state before entering React state updaters', () => {
    const page = readFileSync(new URL('../src/dashboard/web/schedules-page.tsx', import.meta.url), 'utf8');

    expect(page).toContain('const enabledOnly = event.currentTarget.checked;');
    expect(page).not.toContain('enabledOnly: e.currentTarget.checked');
    expect(page).not.toContain('enabledOnly: event.currentTarget.checked');
  });

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

  it('reveals schedule validation errors when submitting an untouched legacy value', () => {
    const page = readFileSync(new URL('../src/dashboard/web/schedules-page.tsx', import.meta.url), 'utf8');
    expect(page).toMatch(
      /function handleSubmit\(e: React\.FormEvent\): void \{[\s\S]*?setTouched\(true\);\s*setScheduleTouched\(true\);/,
    );
  });

  it('keeps the legacy empty date placeholder', () => {
    expect(fmtScheduleDate()).toBe('—');
  });

  it('renders a silent chip and keeps position editing inside the form (not the crowded row actions)', () => {
    const page = readFileSync(new URL('../src/dashboard/web/schedules-page.tsx', import.meta.url), 'utf8');
    // chip in the meta strip
    expect(page).toContain("s.silent ? <span>🔇 {tr('schedules.silent')}</span> : null");
    expect(page).not.toContain('op="delivery"');
    expect(page).not.toContain('setDeliver(');
  });

  it('shows run counts only for schedules that configure repeat limits', () => {
    const page = readFileSync(new URL('../src/dashboard/web/schedules-page.tsx', import.meta.url), 'utf8');
    const zh = createDashboardTranslator('zh');
    const en = createDashboardTranslator('en');

    expect(formatScheduleRepeat()).toBeNull();
    expect(formatScheduleRepeat({ times: null, completed: 5 })).toBe('5/∞');
    expect(formatScheduleRepeat({ times: 10, completed: 3 })).toBe('3/10');
    expect(page).toContain('const repeat = formatScheduleRepeat(s.repeat);');
    expect(page).toContain(
      "{repeat !== null ? <span>{tr('schedules.repeat')}: {repeat}</span> : null}",
    );
    expect(zh('schedules.repeat')).toBe('执行次数');
    expect(en('schedules.repeat')).toBe('Run count');
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

  it('renders the run history as a non-interactive semantic-color backdrop', () => {
    const page = readFileSync(new URL('../src/dashboard/web/schedules-page.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');
    const zh = createDashboardTranslator('zh');

    expect(page).toContain('if (!ui.authed)');
    expect(page).toContain('store.onScheduleRunLogsChanged');
    expect(page).toContain('className="schedule-run-log-fill" aria-hidden="true"');
    expect(page).toContain('className={`outcome-${entry.outcome}`}');
    expect(page).toContain('aria-label={openLogsLabel}');
    expect(zh('schedules.logs.backgroundSummary', {
      shown: 3,
      total: 8,
      dispatched: 1,
      skipped: 1,
      failed: 1,
    })).toContain('最近 3/8 次执行');

    expect(css).toMatch(/\.schedule-run-log-fill \{[\s\S]*?pointer-events:\s*none/);
    expect(css).toMatch(/\.schedule-run-log-fill > i \{[\s\S]*?flex:\s*1 1 0/);
    expect(css).toMatch(/\.outcome-model_dispatched \{[\s\S]*?var\(--accent\)/);
    expect(css).toMatch(/\.outcome-precondition_skipped \{[\s\S]*?var\(--warning\)/);
    expect(css).toMatch(/\.outcome-error \{[\s\S]*?var\(--danger\)/);
    expect(css).toMatch(/\.schedule-list-row > \.overview-list-main,[\s\S]*?z-index:\s*1/);
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
      preconditionFilePath: 'scripts/check-ready.sh',
    })).toEqual({
      hasExisting: true,
      enabled: false,
      mode: 'file',
      script: '',
      filePath: 'scripts/check-ready.sh',
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
      remove: false,
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
      remove: false,
      mode: 'inline',
      script: 'printf 1',
      filePath: '',
    })).toEqual({ ok: true, fields: {} });

    expect(buildSchedulePreconditionFormFields({
      hasExisting: true,
      initialEnabled: false,
      initialMode: 'file',
      initialScript: '',
      initialFilePath: 'scripts/check-ready.sh',
      enabled: false,
      remove: false,
      mode: 'file',
      script: '',
      filePath: 'scripts/check-ready.sh',
    })).toEqual({ ok: true, fields: {} });
  });

  it('sends only an actual toggle, source replacement, or explicit removal', () => {
    const base = {
      hasExisting: true,
      initialEnabled: true,
      initialMode: 'inline',
      initialScript: 'printf 1',
      initialFilePath: '',
      remove: false,
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
      filePath: ' scripts/check-ready.sh ',
    })).toEqual({
      ok: true,
      fields: { preconditionFilePath: 'scripts/check-ready.sh' },
    });
    expect(buildSchedulePreconditionFormFields({
      ...base,
      initialEnabled: false,
      initialMode: 'file',
      initialScript: '',
      initialFilePath: 'scripts/check-ready.sh',
      enabled: false,
      mode: 'file',
      filePath: 'scripts/check-next.sh',
    })).toEqual({
      ok: true,
      fields: { preconditionFilePath: 'scripts/check-next.sh' },
    });
    expect(buildSchedulePreconditionFormFields({
      ...base,
      enabled: true,
      mode: 'inline',
      remove: true,
    })).toEqual({ ok: true, fields: { preconditionScript: null } });

    expect(buildSchedulePreconditionFormFields({
      hasExisting: false,
      initialEnabled: false,
      initialMode: 'inline',
      initialScript: '',
      initialFilePath: '',
      enabled: true,
      remove: false,
      mode: 'inline',
      script: 'printf 1',
      filePath: '',
    })).toEqual({
      ok: true,
      fields: { preconditionEnabled: true, preconditionScript: 'printf 1' },
    });
  });

  it('validates visible inline and live-file sources before submit', () => {
    const base = {
      hasExisting: false,
      initialEnabled: false,
      initialMode: 'inline',
      initialScript: '',
      initialFilePath: '',
      enabled: true,
      remove: false,
      script: '',
      filePath: '',
    } as const;
    expect(buildSchedulePreconditionFormFields({ ...base, mode: 'inline' }))
      .toEqual({ ok: false, error: 'script_required' });
    expect(buildSchedulePreconditionFormFields({ ...base, mode: 'file' }))
      .toEqual({ ok: false, error: 'file_required' });
    expect(buildSchedulePreconditionFormFields({ ...base, mode: 'file', filePath: '~/.ready' }))
      .toEqual({ ok: false, error: 'file_tilde' });
    expect(buildSchedulePreconditionFormFields({ ...base, mode: 'file', filePath: 'bad\0path' }))
      .toEqual({ ok: false, error: 'file_nul' });
  });

  it('reveals saved Bash sources in an accessible editor without forcing a rewrite', () => {
    const page = readFileSync(new URL('../src/dashboard/web/schedules-page.tsx', import.meta.url), 'utf8');
    const zh = createDashboardTranslator('zh');
    const en = createDashboardTranslator('en');

    expect(page).toContain('hasPrecondition?: boolean');
    expect(page).toContain('preconditionEnabled?: boolean');
    expect(page).toContain("preconditionSource?: 'inline' | 'file';");
    expect(page).toContain('preconditionScript?: string;');
    expect(page).toContain('preconditionFilePath?: string;');
    expect(page).toContain('schedulePreconditionEditorInitialState(editing)');
    expect(page).toContain('useState(initialPrecondition.script)');
    expect(page).toContain('useState(initialPrecondition.filePath)');
    expect(page).toContain("initialPrecondition.mode === 'keep'");
    expect(page).toContain('(preconditionEnabled || hasExistingPrecondition) && !removePrecondition');
    expect(page).toContain('...(data.preconditionScript !== undefined');
    expect(page).toContain('...(data.preconditionFilePath !== undefined');
    expect(page).toContain('disabled={removePrecondition}');
    expect(page).toContain("tr('schedules.form.preconditionRemove')");
    expect(page).toContain('role="switch"');
    expect(page).toContain('<fieldset className="schedule-precondition-source">');
    expect(page).toContain('type="radio"');
    expect(page).toContain('htmlFor="schedule-precondition-script"');
    expect(page).toContain('htmlFor="schedule-precondition-file-path"');
    expect(page).not.toContain('type="file"');
    expect(page).toContain('PRECONDITION_SCRIPT_EXAMPLE');
    expect(page).toContain('PRECONDITION_PROMPT_EXAMPLE');
    expect(page).toContain("tr('schedules.form.preconditionRule')");
    expect(page).toContain("tr('schedules.form.preconditionUseExample')");
    expect(page).toContain("tr('schedules.form.preconditionFileHelp')");
    expect(zh('schedules.form.preconditionConfiguredHelp')).toContain('已在下方显示');
    expect(zh('schedules.form.preconditionConfiguredHelp')).not.toContain('安全');
    expect(zh('schedules.form.preconditionSourceKeep')).toContain('暂不可读');
    expect(en('schedules.form.preconditionConfiguredHelp')).toContain('shown below');
    expect(en('schedules.form.preconditionConfiguredHelp')).not.toContain('security');
  });

  it('moves the Bash gate and FD 3 examples into an accessible help dialog', () => {
    const page = readFileSync(new URL('../src/dashboard/web/schedules-page.tsx', import.meta.url), 'utf8');
    const zh = createDashboardTranslator('zh');
    const en = createDashboardTranslator('en');

    expect(page).toContain("printf '1\\n'");
    expect(page).toContain("cat >&3 <<'PROMPT'");
    expect(page.match(/<SchedulePreconditionProtocolHelp/g)).toHaveLength(1);
    expect(page.match(/className="schedule-precondition-source-option"/g)).toHaveLength(2);
    expect(page.match(/className="schedule-precondition-help-trigger"/g)).toHaveLength(2);
    expect(page).toContain("aria-label={tr('schedules.form.preconditionInlineHelpOpen')}");
    expect(page).toContain("title={tr('schedules.form.preconditionInlineHelpOpen')}");
    expect(page).toContain("aria-label={tr('schedules.form.preconditionFileHelpOpen')}");
    expect(page).toContain("title={tr('schedules.form.preconditionFileHelpOpen')}");
    expect(page).toContain('aria-haspopup="dialog"');
    expect(page).toContain('aria-controls="schedule-precondition-help-dialog"');
    expect(page).toContain("aria-expanded={preconditionHelpSource === 'inline'}");
    expect(page).toContain("aria-expanded={preconditionHelpSource === 'file'}");
    expect(page).toContain("setPreconditionHelpSource('inline')");
    expect(page).toContain("setPreconditionHelpSource('file')");
    expect(page).toContain('id="schedule-precondition-help-dialog"');
    expect(page).toContain('aria-labelledby="schedule-precondition-help-title"');
    expect(page).toContain('aria-describedby="schedule-precondition-help-intro"');
    expect(page).toContain("aria-label={tr('schedules.form.preconditionHelpClose')}");
    expect(page).toContain("title={tr('schedules.form.preconditionHelpClose')}");
    expect(page).toContain('dialog.showModal()');
    expect(page).toContain('closeButtonRef.current?.focus()');
    expect(page).toContain('onCancel={e => {');
    expect(page).toContain('if (e.target === dialogRef.current) closeDialog()');
    expect(page).toContain('props.returnFocusRef.current?.focus()');
    expect(page).toContain("const canApplyExample = mode === 'inline' && source === 'inline';");
    expect(page).toContain('onUseSimple={canApplyExample ? () => {');
    expect(page).toContain('onUsePrompt={canApplyExample ? () => {');
    expect(page).toContain('open={open && preconditionHelpSource !== null}');
    expect(page.match(/<SchedulePreconditionSourceHelp/g)).toHaveLength(1);
    expect(page).toMatch(
      /<SchedulePreconditionSourceHelp[\s\S]*?<SchedulePreconditionProtocolHelp/,
    );
    expect(page).toContain('workingDir={preconditionWorkingDir}');
    expect(page).toContain('workingDir={props.workingDir}');
    expect(page).not.toContain('id="schedule-precondition-inline-help"');
    expect(page).not.toContain('id="schedule-precondition-file-help"');
    expect(page).not.toContain('className="schedule-precondition-guide"');
    expect(page.match(/aria-describedby=\{preconditionError \? 'schedule-precondition-error' : undefined\}/g))
      .toHaveLength(2);

    expect(zh('schedules.form.preconditionRule')).toContain('stdout）去除首尾空白后严格等于 1');
    expect(zh('schedules.form.preconditionPromptHelp')).toContain('仅在本次执行中追加到原任务 Prompt');
    expect(zh('schedules.form.preconditionPromptPrivacy')).toContain('请勿输出密钥');
    expect(zh('schedules.form.preconditionEnableHelp')).toContain('关闭或未配置时不执行前置脚本');
    expect(zh('schedules.form.preconditionInlineHelpOpen')).toContain('直接填写 Bash');
    expect(zh('schedules.form.preconditionFileHelpOpen')).toContain('Bash 文件路径');
    expect(zh('schedules.form.preconditionHelpViewOnly')).toContain('不会切换配置方式');
    expect(zh('schedules.form.preconditionHelpApplyNote')).toContain('保存任务后才会生效');
    expect(zh('schedules.form.preconditionUseExample')).toContain('填入');
    expect(zh('schedules.form.preconditionHelp')).toContain('任务执行根目录');
    expect(zh('schedules.form.preconditionHelp')).not.toContain('点击');

    expect(en('schedules.form.preconditionRule')).toContain('trimmed stdout is strictly 1');
    expect(en('schedules.form.preconditionPromptHelp')).toContain('for this run only');
    expect(en('schedules.form.preconditionPromptPrivacy')).toContain('Do not output secrets');
    expect(en('schedules.form.preconditionInlineHelpOpen')).toContain('entering Bash directly');
    expect(en('schedules.form.preconditionFileHelpOpen')).toContain('Bash file paths');
    expect(en('schedules.form.preconditionHelpViewOnly')).toContain('will not switch');
    expect(en('schedules.form.preconditionHelp')).toContain('task execution root');
  });

  it('shows the actual Bash file execution root and concrete path examples', () => {
    const page = readFileSync(new URL('../src/dashboard/web/schedules-page.tsx', import.meta.url), 'utf8');
    const zh = createDashboardTranslator('zh');
    const en = createDashboardTranslator('en');

    expect(schedulePreconditionPathExample('/srv/botmux', 'scripts/check-ready.sh'))
      .toBe('/srv/botmux/scripts/check-ready.sh');
    expect(schedulePreconditionPathExample('/', 'scripts/check-ready.sh'))
      .toBe('/scripts/check-ready.sh');
    expect(page).toContain('scheduleWorkingDir?: string | null');
    expect(page).toContain('editing\n    ? editing.workingDir\n    : selectedBot?.scheduleWorkingDir');
    expect(page).toContain('function SchedulePreconditionSourceHelp');
    expect(page).toContain("source === 'inline'");
    expect(page).toContain('<dl className="schedule-precondition-path-context">');
    expect(page).toContain('<dd aria-live="polite">');
    expect(page).toContain('<code>scripts/check-ready.sh</code> → <code>{relativeFileExample}</code>');
    expect(page).toContain('<code>.ready</code> → <code>{relativeScriptExample}</code>');

    expect(zh('schedules.form.preconditionFileHelp')).toContain('daemon 宿主机上的文件路径，不是上传文件');
    expect(zh('schedules.form.preconditionWorkingDir')).toContain('相对路径基准');
    expect(zh('schedules.form.preconditionWorkingDirUnavailable')).toContain('创建任务后重新编辑');
    expect(zh('schedules.form.preconditionScriptWorkingDirHelp')).toContain('不是 Bash 文件所在目录');
    expect(zh('schedules.form.preconditionFileRequirements')).toContain('无需执行权限');
    expect(zh('schedules.form.preconditionFileRequirements')).toContain('符号链接');

    expect(en('schedules.form.preconditionFileHelp')).toContain('does not upload a file');
    expect(en('schedules.form.preconditionWorkingDirUnavailable')).toContain('reopen it');
    expect(en('schedules.form.preconditionScriptWorkingDirHelp')).toContain('not the Bash file directory');
    expect(en('schedules.form.preconditionFileRequirements')).toContain('executable permission is not required');
  });

  it('renders the precondition editor as code with a visible keyboard focus', () => {
    const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');
    expect(css).toMatch(
      /textarea\.schedule-precondition-editor \{[\s\S]*?font-family:\s*var\(--mono/,
    );
    expect(css).toMatch(
      /\.schedule-precondition-toggle input:focus-visible \+ \.switch \{[\s\S]*?outline:/,
    );
    expect(css).toMatch(
      /\.schedule-precondition-path-context > div \{[\s\S]*?grid-template-columns:/,
    );
    expect(css).toMatch(
      /\.schedule-precondition-path-context code \{[\s\S]*?overflow-wrap:\s*anywhere/,
    );
    expect(css).toMatch(
      /\.schedule-precondition-help-trigger:focus-visible \{[\s\S]*?outline:/,
    );
    expect(css).toMatch(
      /\.schedule-precondition-help-close:focus-visible \{[\s\S]*?outline:/,
    );
    expect(css).toMatch(
      /\.schedule-precondition-help-dialog > article \{[\s\S]*?grid-template-rows:/,
    );
  });

  it('shows the target chat in both the schedule row and edit dialog', () => {
    const page = readFileSync(new URL('../src/dashboard/web/schedules-page.tsx', import.meta.url), 'utf8');
    expect(page).toContain("import { chatDisplayTitle, loadNameMaps, ui } from './ui.js';");
    // Row chip: dedicated class so a long (Chinese) chat name can be width-capped
    // + ellipsised instead of overrunning into the action buttons.
    expect(page).toContain('className="schedule-chat-chip"');
    expect(page).toContain("{tr('schedules.form.chat')}: {chatTitle ?? s.chatId}");
    // Tooltip keeps the full name AND the raw chatId so truncation loses nothing.
    expect(page).toContain('title={chatTitle ? `${chatTitle} · ${String(s.chatId)}` : String(s.chatId)}');
    expect(page).toContain("<code title={chatId}>{chatDisplayTitle(editing) ?? chatId}</code>");
  });

  it('caps the target-chat chip width so a long name cannot overrun the row', () => {
    const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');
    // The chip must have its own bounded rule (base .schedule-chip-strip span is
    // flex:none + nowrap with no max-width — a long name would push past the
    // main column into the Run/Edit/Delete actions).
    expect(css).toMatch(
      /\.schedule-chip-strip span\.schedule-chat-chip \{[\s\S]*?max-width:[\s\S]*?overflow:\s*hidden[\s\S]*?text-overflow:\s*ellipsis/,
    );
    // inline-block (not the base inline-flex) is what actually renders the … glyph.
    expect(css).toMatch(
      /\.schedule-chip-strip span\.schedule-chat-chip \{[\s\S]*?display:\s*inline-block/,
    );
  });

  it('offers three execution positions and allows lazy silent fresh topics', () => {
    const page = readFileSync(new URL('../src/dashboard/web/schedules-page.tsx', import.meta.url), 'utf8');
    expect(page).toContain('onChange={e => setSilent(e.target.checked)}');
    expect(page).toContain('silentNewTopicConflict');
    expect(page).toContain("value=\"top-level\"");
    expect(page).toContain("value=\"topic\"");
    expect(page).toContain("value=\"new-topic\"");
    expect(page).toContain("setExecutionPosition('new-topic')");
    expect(page).toContain("tr('schedules.form.topicTitle')");
    expect(page).toContain('maxLength={200}');
    expect(page).not.toContain("disabled={executionPosition === 'new-topic'}");
    expect(page).toContain("executionPosition === 'new-topic' && silent");
    expect(page).toContain("tr('schedules.form.topicRoot')");
    expect(page).toContain("executionPosition === 'topic' && !rootMessageId.trim()");
    expect(page).toContain("const localDelivery = editing?.deliver === 'local';");
    expect(page).toContain('updateExecutionPosition: !localDelivery');
    expect(page).toContain('...(data.updateExecutionPosition ? {');
  });

  it('maps stored state to top-level, retained-topic, fresh-topic, or local execution', () => {
    expect(scheduleExecutionPlacement({ id: 'chat', scope: 'chat', rootMessageId: 'om_old' })).toBe('chat');
    expect(scheduleExecutionPlacement({ id: 'thread', scope: 'thread', rootMessageId: 'om_root' })).toBe('thread');
    expect(scheduleExecutionPlacement({ id: 'fresh', executionPosition: 'new-topic', rootMessageId: 'om_root' })).toBe('new-topic');
    expect(scheduleExecutionPlacement({ id: 'legacy-fresh', deliver: 'new-topic' })).toBe('new-topic');
    expect(scheduleExecutionPlacement({ id: 'local', deliver: 'local' })).toBe('local');
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

  it('opens a read-only task-scoped run-log dialog with paging and focus return', () => {
    const page = readFileSync(new URL('../src/dashboard/web/schedules-page.tsx', import.meta.url), 'utf8');

    expect(page).toContain('className="schedule-action-button schedule-log-button"');
    expect(page).toContain('aria-haspopup="dialog"');
    expect(page).toContain('aria-controls="schedule-run-log-dialog"');
    expect(page).toContain('id="schedule-run-log-dialog"');
    expect(page).toContain('dialog.showModal()');
    expect(page).toContain('closeButtonRef.current?.focus()');
    expect(page).toContain('props.returnFocusRef.current?.focus()');
    expect(page).toContain('onCancel={event => {');
    expect(page).toContain('if (event.target === dialogRef.current) closeDialog()');
    expect(page).toContain('SCHEDULE_RUN_LOG_PAGE_SIZE = 50');
    expect(page).toContain('/logs?limit=${SCHEDULE_RUN_LOG_PAGE_SIZE}&offset=${offset}');
    expect(page).toContain("loadLogs('more')");
    expect(page).toContain('<LoadingState compact');
    expect(page).toContain('className="schedule-run-log-alert" role="alert"');
    expect(page).toContain('className="schedule-run-log-empty"');
    expect(page).not.toContain('setInterval(');
  });

  it('moves the scheduler-log boundary behind an accessible model-submission tooltip', () => {
    const page = readFileSync(new URL('../src/dashboard/web/schedules-page.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');
    const zh = createDashboardTranslator('zh');
    const en = createDashboardTranslator('en');

    expect(zh('schedules.logs.outcomeDispatched')).toBe('已提交模型');
    expect(zh('schedules.logs.outcomeSkipped')).toBe('前置条件未通过');
    expect(zh('schedules.logs.outcomeError')).toBe('调度失败');
    expect(zh('schedules.logs.intro')).toContain('不包含模型生成');
    expect(zh('schedules.logs.boundary')).toContain('不代表模型已完成');
    expect(zh('schedules.logs.emptyHint')).toContain('仅展示升级后产生的记录');
    expect(en('schedules.logs.boundary')).toContain('does not mean the model finished');
    expect(page).toMatch(
      /<dt>\s*<FieldTitle\s+help=\{tr\('schedules\.logs\.boundary'\)\}\s+helpLabel=\{tr\('schedules\.logs\.boundary'\)\}\s*>\s*\{tr\('schedules\.logs\.modelInvocation'\)\}\s*<\/FieldTitle>\s*<\/dt>/,
    );
    expect(page).not.toContain('className="schedule-run-log-boundary"');
    expect(css).not.toContain('.schedule-run-log-boundary');
  });

  it('keeps the run-log dialog usable on small screens', () => {
    const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');

    expect(css).toMatch(/\.schedule-run-log-workspace \{[\s\S]*?grid-template-columns:/);
    expect(css).toMatch(/@media \(max-width: 720px\) \{[\s\S]*?\.schedule-run-log-workspace \{[\s\S]*?grid-template-columns:\s*1fr/);
    expect(css).toMatch(/\.schedule-run-log-list-panel \{[\s\S]*?min-height:\s*0/);
    expect(css).toMatch(/button\.schedule-run-log-row:focus-visible \{[\s\S]*?outline:/);
  });

  it('keeps run errors in the log dialog instead of the task panel', () => {
    const page = readFileSync(new URL('../src/dashboard/web/schedules-page.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');

    expect(page).not.toContain('className="schedule-error-chip"');
    expect(page).not.toContain("s.lastStatus === 'error'");
    expect(page).toContain('<code>{selected.errorCode}</code>');
    expect(page).toContain('<strong>{selected.error}</strong>');
    expect(css).not.toContain('.schedule-error-chip');
    expect(css).toContain('.schedule-row-head .schedule-state {');
    expect(css).toMatch(/\.schedules-list \{[\s\S]*?grid-auto-rows:\s*max-content/);
    expect(css).toMatch(/\.schedule-list-row \.schedule-actions \{[\s\S]*?flex-wrap:\s*nowrap/);
  });
});
