import { describe, expect, it } from 'vitest';
import { platform } from 'node:os';
import {
  parseLoadavg,
  parseMeminfo,
  parseProcessStat,
  parseSmapsRollupPss,
  parseSystemCpuTimes,
  parseSystemStat,
  sampleProcfs,
  sampleProcfsAsync,
  selectPssPids,
} from '../src/core/resource-monitor/procfs.js';

describe('selectPssPids', () => {
  // pid tree: 1 → {10 → {20 → 30}, 11}, 2 → 40
  const rows = [
    { pid: 1, ppid: 0 }, { pid: 10, ppid: 1 }, { pid: 20, ppid: 10 }, { pid: 30, ppid: 20 },
    { pid: 11, ppid: 1 }, { pid: 2, ppid: 0 }, { pid: 40, ppid: 2 },
  ];

  it('returns null (everyone) when no roots are given — legacy behaviour', () => {
    expect(selectPssPids(rows, {})).toBeNull();
  });

  it('expands each root to its ppid subtree and nothing else', () => {
    expect([...selectPssPids(rows, { pssRoots: [10] })!].sort((a, b) => a - b)).toEqual([10, 20, 30]);
    expect([...selectPssPids(rows, { pssRoots: [10, 40] })!].sort((a, b) => a - b)).toEqual([10, 20, 30, 40]);
  });

  it('ignores roots that are not in the table and yields an empty set for no roots', () => {
    expect(selectPssPids(rows, { pssRoots: [999, 0, -1] })!.size).toBe(0);
    expect(selectPssPids(rows, { pssRoots: [] })!.size).toBe(0);
  });

  it('caps the number of PSS targets, keeping the largest by RSS', () => {
    // RSS−PSS error scales with the process, so the cap must drop the small
    // ones (shells, tmux) and keep the big CLIs — not whichever DFS met first.
    const sized = rows.map(row => ({ ...row, rssPages: { 1: 5, 10: 50, 20: 500, 30: 5000, 11: 1 }[row.pid] ?? 0 }));
    const picked = selectPssPids(sized, { pssRoots: [1], maxPssProcesses: 2 })!;
    expect([...picked].sort((a, b) => a - b)).toEqual([20, 30]);
    // Under the cap nothing is dropped.
    expect(selectPssPids(sized, { pssRoots: [1], maxPssProcesses: 10 })!.size).toBe(5);
  });
});

describe.runIf(platform() === 'linux')('procfs sampling (live host)', () => {
  it('async sweep matches the sync sweep in shape and includes this process', async () => {
    const roots = [process.pid];
    const [async, sync] = await Promise.all([sampleProcfsAsync(1_700_000_000_000, { pssRoots: roots }), sampleProcfs(1_700_000_000_000, { pssRoots: roots })]);
    for (const sample of [async, sync]) {
      expect(sample.supported).toBe(true);
      expect(sample.sampledAt).toBe(1_700_000_000_000);
      expect(sample.mem.memTotalBytes).toBeGreaterThan(0);
      expect(sample.totalCpuTicks).toBeGreaterThan(0);
      const self = sample.processes.find(proc => proc.pid === process.pid);
      expect(self).toBeDefined();
      expect(self?.ppid).toBe(process.ppid);
      expect(self?.rssBytes).toBeGreaterThan(0);
      // cmdline is deliberately NOT read: nothing consumes it and it costs a
      // memory read of every process on the host per sweep (see procfs.ts).
      expect(self?.cmd).toBeUndefined();
    }
  });

  it('reads PSS only inside the requested roots and keeps stat RSS elsewhere', async () => {
    // With no roots, nobody gets smaps_rollup: every rssBytes is a whole number of
    // pages. Our own process, when named as a root, gets PSS instead — which is a
    // kB figure and differs from the page-rounded RSS in the general case.
    const noRoots = await sampleProcfsAsync(Date.now(), { pssRoots: [] });
    expect(noRoots.processes.length).toBeGreaterThan(0);
    for (const proc of noRoots.processes) expect(proc.rssBytes % 4096).toBe(0);

    const withSelf = await sampleProcfsAsync(Date.now(), { pssRoots: [process.pid] });
    const self = withSelf.processes.find(proc => proc.pid === process.pid);
    const selfNoRoots = noRoots.processes.find(proc => proc.pid === process.pid);
    expect(self?.rssBytes).toBeGreaterThan(0);
    // PSS never exceeds RSS at one instant (shared pages are apportioned); the
    // two sweeps are moments apart, so allow for heap growth in between.
    expect(self!.rssBytes).toBeLessThanOrEqual(selfNoRoots!.rssBytes * 1.5);
  });
});

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
