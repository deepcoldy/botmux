import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import {
  canSubmitSchedule,
  checkSchedule,
  filterSchedules,
  fmtScheduleDate,
  scheduleExecutionPlacement,
} from '../src/dashboard/web/schedules-page.js';

describe('dashboard schedules React page helpers', () => {
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

  it('shows the target chat in both the schedule row and edit dialog', () => {
    const page = readFileSync(new URL('../src/dashboard/web/schedules-page.tsx', import.meta.url), 'utf8');
    expect(page).toContain("import { chatDisplayTitle, loadNameMaps } from './ui.js';");
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

  it('keeps schedule-state CSS rule intact and left-aligns the error chip', () => {
    const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');
    // Regression: inserting the error-chip rule must not clobber the
    // `.schedule-row-head .schedule-state {` selector (previously its body
    // became orphaned declarations, dropping enabled styling + min-width).
    expect(css).toContain('.schedule-row-head .schedule-state {');
    // The error chip must left-align so long errors keep the "⚠ Error" prefix
    // instead of being center-clipped.
    expect(css).toMatch(
      /\.schedule-chip-strip span\.schedule-error-chip \{[\s\S]*?justify-content:\s*flex-start/,
    );
    // No orphaned declarations between the error-chip rule and the next rule.
    expect(css).toMatch(
      /\.schedule-chip-strip span\.schedule-error-chip \{[\s\S]*?\}\s*\.schedule-row-head \.schedule-state \{/,
    );
    expect(css).toMatch(/\.schedules-list \{[\s\S]*?grid-auto-rows:\s*max-content/);
    expect(css).toMatch(/\.schedule-list-row \.schedule-actions \{[\s\S]*?flex-wrap:\s*nowrap/);
  });
});
