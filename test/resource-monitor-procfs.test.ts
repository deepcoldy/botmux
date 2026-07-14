import { describe, expect, it } from 'vitest';
import { parseLoadavg, parseMeminfo, parseProcessStat, parseSmapsRollupPss, parseSystemCpuTimes, parseSystemStat } from '../src/core/resource-monitor/procfs.js';

describe('resource procfs parsers', () => {
  it('parses host cpu ticks from /proc/stat', () => {
    expect(parseSystemStat('cpu  10 20 30 40 5 6 7 8 9 10\n')).toBe(145);
  });

  it('parses host idle ticks from /proc/stat', () => {
    expect(parseSystemCpuTimes('cpu  10 20 30 40 5 6 7 8 9 10\n')).toEqual({
      total: 145,
      idle: 45,
    });
  });

  it('parses load averages', () => {
    expect(parseLoadavg('1.23 2.34 3.45 4/999 12345\n')).toEqual({ load1: 1.23, load5: 2.34, load15: 3.45 });
  });

  it('parses memory values as bytes', () => {
    expect(parseMeminfo('MemTotal: 1000 kB\nMemAvailable: 250 kB\nSwapTotal: 400 kB\nSwapFree: 100 kB\n')).toEqual({
      memTotalBytes: 1_024_000,
      memAvailableBytes: 256_000,
      swapTotalBytes: 409_600,
      swapFreeBytes: 102_400,
    });
  });

  it('parses process stat with spaces and parentheses in comm', () => {
    const stat = '1234 (node (worker)) S 12 0 0 0 0 0 0 0 0 0 100 50 0 0 20 0 1 0 12345 999 42';

    expect(parseProcessStat(stat)).toEqual({ pid: 1234, ppid: 12, cpuTicks: 150, startTicks: 12345, rssPages: 42 });
  });

  it('parses Pss from smaps_rollup as bytes, and returns null when absent', () => {
    const rollup = 'Rss:               20480 kB\nPss:               10240 kB\nShared_Clean:       8192 kB\nPrivate_Dirty:      6144 kB\n';
    expect(parseSmapsRollupPss(rollup)).toBe(10_485_760); // 10240 kB * 1024
    // Pss must not be confused with Pss_Anon/Pss_File lines, and missing → null.
    expect(parseSmapsRollupPss('Rss:  20480 kB\nPss_Anon:  4096 kB\n')).toBeNull();
    expect(parseSmapsRollupPss('')).toBeNull();
  });
});
