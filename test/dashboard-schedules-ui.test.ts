import { describe, expect, it } from 'vitest';
import { filterSchedules, fmtScheduleDate } from '../src/dashboard/web/schedules.js';

describe('dashboard schedules React page helpers', () => {
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

  it('keeps the legacy empty date placeholder', () => {
    expect(fmtScheduleDate()).toBe('—');
  });
});
