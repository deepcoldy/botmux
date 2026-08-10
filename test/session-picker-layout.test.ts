import { describe, expect, it } from 'vitest';
import {
  computeSessionPickerLayout,
  sessionPickerLayoutWidth,
} from '../src/cli/session-picker-layout.js';

describe('session picker responsive layout', () => {
  it('preserves the historical full layout at the old width thresholds', () => {
    const single = computeSessionPickerLayout(100, false);
    expect(single.columns).toEqual([
      { key: 'id', width: 10 },
      { key: 'title', width: 8 },
      { key: 'dir', width: 12 },
      { key: 'pid', width: 8 },
      { key: 'uptime', width: 7 },
      { key: 'status', width: 7 },
      { key: 'target', width: 26 },
    ]);

    const multi = computeSessionPickerLayout(121, true);
    expect(multi.columns).toEqual([
      { key: 'id', width: 10 },
      { key: 'bot', width: 18 },
      { key: 'title', width: 8 },
      { key: 'dir', width: 12 },
      { key: 'pid', width: 8 },
      { key: 'uptime', width: 7 },
      { key: 'status', width: 7 },
      { key: 'target', width: 26 },
    ]);
  });

  it('switches to compact one-line layouts below the old wrap thresholds', () => {
    const single = computeSessionPickerLayout(99, false);
    expect(single.columns.map(column => column.key)).toEqual([
      'id', 'title', 'dir', 'pid', 'uptime', 'status', 'target',
    ]);
    expect(sessionPickerLayoutWidth(single)).toBe(99);

    const multi = computeSessionPickerLayout(120, true);
    expect(multi.columns.map(column => column.key)).toEqual([
      'id', 'bot', 'title', 'dir', 'pid', 'uptime', 'status', 'target',
    ]);
    expect(sessionPickerLayoutWidth(multi)).toBe(120);
  });

  it('never returns a row wider than the terminal', () => {
    for (const multiBot of [false, true]) {
      for (let termWidth = 1; termWidth <= 240; termWidth++) {
        const layout = computeSessionPickerLayout(termWidth, multiBot);
        expect(sessionPickerLayoutWidth(layout), `${multiBot ? 'multi' : 'single'} @ ${termWidth}`)
          .toBeLessThanOrEqual(termWidth);
      }
    }
  });

  it('progressively removes low-value columns on very narrow terminals', () => {
    const medium = computeSessionPickerLayout(70, true);
    expect(medium.columns.some(column => column.key === 'target')).toBe(false);
    expect(medium.columns.some(column => column.key === 'bot')).toBe(true);
    expect(medium.columns.some(column => column.key === 'title')).toBe(true);

    const tiny = computeSessionPickerLayout(20, true);
    expect(tiny.columns).toEqual([{ key: 'title', width: 16 }]);
    expect(sessionPickerLayoutWidth(tiny)).toBe(20);
  });
});
