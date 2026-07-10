import { describe, expect, it } from 'vitest';
import { selectTrackedSessions } from '../src/core/resource-monitor/top-selector.js';
import type { ResourceSessionCurrent } from '../src/core/resource-monitor/types.js';

function row(id: string, cpu1mPct: number, rssBytes: number, rssGrowth5mBytes: number): ResourceSessionCurrent {
  return {
    sessionId: id,
    larkAppId: 'app',
    botName: 'bot',
    status: 'working',
    title: id,
    current: {
      cpuPct: cpu1mPct,
      cpu1mPct,
      cpu5mPct: cpu1mPct,
      rssBytes,
      rssGrowth5mBytes,
    },
    confidence: 'unknown',
    tracked: false,
    rankReasons: [],
    pids: { sampledPids: 1 },
  };
}

describe('selectTrackedSessions', () => {
  it('selects from full current rows across cpu, rss, and growth candidates', () => {
    const rows = [
      row('cpu-heavy', 95, 10, 0),
      row('rss-heavy', 1, 900, 0),
      row('growth-heavy', 1, 20, 800),
      row('normal', 1, 10, 0),
    ];

    const result = selectTrackedSessions({
      rows,
      previous: new Map(),
      nowMs: 10_000,
      limit: 3,
      graceMs: 60_000,
      perReasonLimit: 3,
    });

    expect(result.trackedIds).toEqual(['cpu-heavy', 'rss-heavy', 'growth-heavy']);
    expect(result.reasonsBySession.get('cpu-heavy')).toContain('cpu');
    expect(result.reasonsBySession.get('rss-heavy')).toContain('rss');
    expect(result.reasonsBySession.get('growth-heavy')).toContain('rssGrowth');
  });

  it('recomputes from full current rows while preserving previous tracked rows during grace', () => {
    const previous = new Map<string, number>([['old-hot', 9_000]]);
    const rows = [
      row('new-hot', 99, 0, 0),
      row('old-hot', 0, 0, 0),
    ];

    const result = selectTrackedSessions({
      rows,
      previous,
      nowMs: 10_000,
      limit: 2,
      graceMs: 60_000,
      perReasonLimit: 1,
    });

    expect(result.trackedIds).toEqual(['new-hot', 'old-hot']);
    expect(result.reasonsBySession.get('new-hot')).toEqual(['cpu']);
    expect(result.reasonsBySession.get('old-hot')).toEqual(['grace']);
  });

  it('drops previous tracked rows after grace expires', () => {
    const previous = new Map<string, number>([['old-hot', 1_000]]);

    const result = selectTrackedSessions({
      rows: [row('new-hot', 99, 1, 0), row('old-hot', 1, 1, 0)],
      previous,
      nowMs: 100_000,
      limit: 2,
      graceMs: 10_000,
      perReasonLimit: 1,
    });

    expect(result.trackedIds).toEqual(['new-hot']);
  });
});
