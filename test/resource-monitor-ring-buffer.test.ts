import { describe, expect, it } from 'vitest';
import { NumericRingSeries } from '../src/core/resource-monitor/ring-buffer.js';

describe('NumericRingSeries', () => {
  it('keeps the newest fixed-size window in timestamp order', () => {
    const series = new NumericRingSeries(3, ['cpuPct', 'rssBytes']);

    series.push(1000, { cpuPct: 1, rssBytes: 10 });
    series.push(2000, { cpuPct: 2, rssBytes: 20 });
    series.push(3000, { cpuPct: 3, rssBytes: 30 });
    series.push(4000, { cpuPct: 4, rssBytes: 40 });

    expect(series.toJSON()).toEqual({
      timestamps: [2000, 3000, 4000],
      cpuPct: [2, 3, 4],
      rssBytes: [20, 30, 40],
    });
  });

  it('fills missing metric values with zero and can filter by timestamp', () => {
    const series = new NumericRingSeries(3, ['cpuPct', 'rssBytes']);

    series.push(1000, { cpuPct: 1 });
    series.push(2000, { cpuPct: 2, rssBytes: 20 });

    expect(series.toJSON(1500)).toEqual({
      timestamps: [2000],
      cpuPct: [2],
      rssBytes: [20],
    });
    expect(series.toJSON()).toEqual({
      timestamps: [1000, 2000],
      cpuPct: [1, 2],
      rssBytes: [0, 20],
    });
  });
});
