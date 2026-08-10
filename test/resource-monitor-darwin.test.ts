import { freemem } from 'node:os';
import { describe, expect, it } from 'vitest';
import { attributeResources } from '../src/core/resource-monitor/attribution.js';
import {
  applyFootprints,
  createSampleBudget,
  hostCpuTicks,
  parsePsBirthStamps,
  parsePsCpuTime,
  parsePsLine,
  parsePsTable,
  parseSwapusage,
  parseTopFootprints,
  parseTopMemBytes,
  parseVmStat,
  sampleDarwin,
  type ToolOutcome,
  type ToolRunner,
} from '../src/core/resource-monitor/darwin.js';
import { sampleProcfs } from '../src/core/resource-monitor/procfs.js';
import { readProcessStartIdentity } from '../src/core/session-marker.js';

const onDarwin = process.platform === 'darwin';

describe('darwin resource parsers', () => {
  it('converts os.cpus() millisecond times into centisecond ticks summed across cores', () => {
    const times = { user: 1_000, nice: 0, sys: 500, idle: 8_000, irq: 0 };
    const cpuList = [{ times }, { times }] as unknown as ReturnType<typeof import('node:os').cpus>;

    // (1000+500+8000)/10 = 950 per core, idle 800 per core.
    expect(hostCpuTicks(cpuList)).toEqual({ total: 1_900, idle: 1_600 });
  });

  it('parses every ps cpu-time format into centiseconds', () => {
    expect(parsePsCpuTime('0:00.14')).toBe(14);
    expect(parsePsCpuTime('170:41.46')).toBe(170 * 6_000 + 4_146);
    expect(parsePsCpuTime('27:03:12.08')).toBe((27 * 3_600 + 3 * 60 + 12) * 100 + 8);
    expect(parsePsCpuTime('3-04:11:22.31')).toBe((3 * 86_400 + 4 * 3_600 + 11 * 60 + 22) * 100 + 31);
    expect(parsePsCpuTime('')).toBe(0);
  });

  it('parses a row into pid/ppid/memory/cpu plus the birth stamp', () => {
    const line = '  1234   567  122432 12:34.56 Tue Jul 21 22:59:26 2026';

    expect(parsePsLine(line)).toEqual({
      pid: 1234,
      ppid: 567,
      rssBytes: 122_432 * 1024,
      cpuTicks: 12 * 6_000 + 3_456,
      startTicks: 'Tue Jul 21 22:59:26 2026',
    });
  });

  it('keeps the space-padded day-of-month form intact (ps pads %e, not zero-fills)', () => {
    // Whitespace-split, so `Jul  1` and `Jul 21` both land on 5 tokens.
    expect(parsePsLine('1 0 32144 170:41.46 Tue Jul  1 22:59:26 2026')?.startTicks).toBe('Tue Jul 1 22:59:26 2026');
    expect(parsePsLine('1 0 32144 170:41.46 Tue Jul 21 22:59:26 2026')?.startTicks).toBe('Tue Jul 21 22:59:26 2026');
  });

  it('rejects rows that are not exactly the five fixed ps columns', () => {
    // argv is not selected at all, so no process-controlled text reaches this parser.
    // These checks keep it that way: a row carrying anything beyond the five kernel
    // columns is dropped rather than trusted to place a pid in the process tree.
    expect(parsePsLine('1234 1 999999 0:01.00 Tue Aug 5 12:34:56 2026 /bin/sh -c evil')).toBeNull();
    expect(parsePsLine('1234 1 999999 not-a-time Tue Aug 5 12:34:56 2026')).toBeNull();
    expect(parsePsLine('1234 1 999999 0:01.00 2026-08-05 12:34:56 UTC extra')).toBeNull();
    expect(parsePsLine('1234 1 abc 0:01.00 Tue Aug 5 12:34:56 2026')).toBeNull();
    // Long cumulative CPU times and day-prefixed forms stay accepted.
    expect(parsePsLine('1 0 100 999:59:59.99 Tue Aug 5 12:34:56 2026')).not.toBeNull();
    expect(parsePsLine('1 0 100 3-04:11:22.31 Tue Aug 5 12:34:56 2026')).not.toBeNull();
  });

  it('keeps ps RSS when a pid changed identity between the ps and top passes', () => {
    const processes = [
      { pid: 100, ppid: 1, rssBytes: 40 * 1024 ** 2, cpuTicks: 10, startTicks: 'Tue Jul 21 22:59:26 2026' },
      { pid: 200, ppid: 1, rssBytes: 90 * 1024 ** 2, cpuTicks: 20, startTicks: 'Tue Jul 21 23:00:00 2026' },
    ];
    const footprints = new Map([[100, 12 * 1024 ** 2], [200, 33 * 1024 ** 2]]);
    // pid 200 was recycled after the first ps pass: top's number belongs to a different
    // process, so splicing it in would report a stranger's memory under this identity.
    const birthAfter = new Map([
      [100, 'Tue Jul 21 22:59:26 2026'],
      [200, 'Wed Aug  5 21:49:32 2026'],
    ]);

    applyFootprints(processes, footprints, birthAfter);

    expect(processes[0].rssBytes).toBe(12 * 1024 ** 2);
    expect(processes[1].rssBytes).toBe(90 * 1024 ** 2);
  });

  it('gives the whole sample one budget so a wedged tool cannot stall five timeouts in turn', () => {
    let clock = 1_000;
    const remaining = createSampleBudget(() => clock, 3_000);

    expect(remaining()).toBe(3_000);
    clock += 2_500; // first tool ate most of the budget
    expect(remaining()).toBe(500); // later tools get what is left, not a fresh timeout
    clock += 600;
    expect(remaining()).toBe(0); // exhausted → remaining tools are skipped, not queued
  });

  describe('degradation: a tool that is absent falls back, a tool that failed drops the sample', () => {
    const PS_ROWS = [
      '1 0 32144 0:01.00 Tue Jul 21 22:59:26 2026',
      '2 1 65536 0:02.00 Tue Jul 21 22:59:27 2026',
    ].join('\n');
    const VM_STAT = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                                   100.',
      'Pages inactive:                               200.',
      'Pages speculative:                             50.',
    ].join('\n');
    const TOP = ['PID    MEM  ', '1  8M', '2  16M'].join('\n');
    const BIRTHS = ['1 Tue Jul 21 22:59:26 2026', '2 Tue Jul 21 22:59:27 2026'].join('\n');

    // Scripted runner: `outcomes` maps a tool (matched by its binary list) to what
    // this run should return, so each degradation branch can be hit deterministically.
    const runnerFor = (outcomes: Record<string, ToolOutcome>): ToolRunner => (candidates, args) => {
      const key = candidates[0].endsWith('ps') ? (args[1].includes('ppid') ? 'ps' : 'births') : candidates[0].split('/').pop()!;
      return outcomes[key] ?? { ok: true, stdout: '' };
    };
    const ok = (stdout: string): ToolOutcome => ({ ok: true, stdout });
    const absent: ToolOutcome = { ok: false, absent: true };
    const failed: ToolOutcome = { ok: false, absent: false };
    const base = { ps: ok(PS_ROWS), vm_stat: ok(VM_STAT), sysctl: ok('total = 0.00M free = 0.00M'), top: ok(TOP), births: ok(BIRTHS) };
    const sample = (over: Partial<typeof base>) => sampleDarwin(1_700_000_000_000, { run: runnerFor({ ...base, ...over }) });

    it('produces footprint-based memory when every tool answers', () => {
      const s = sample({})!;
      expect(s.supported).toBe(true);
      expect(s.mem.memAvailableBytes).toBe(350 * 16_384);
      expect(s.processes.map(p => p.rssBytes)).toEqual([8 * 1024 ** 2, 16 * 1024 ** 2]);
    });

    it('falls back to os.freemem() only when vm_stat does not exist on the host', () => {
      const s = sample({ vm_stat: absent })!;
      // Stable platform property → the same definition every sample, no mid-series step.
      expect(s.supported).toBe(true);
      // freemem() drifts between the call and the assertion, so compare loosely — the
      // point is that it is the live free-page figure and not vm_stat's reclaimable sum.
      expect(s.mem.memAvailableBytes).not.toBe(350 * 16_384);
      expect(Math.abs(s.mem.memAvailableBytes - freemem())).toBeLessThan(256 * 1024 ** 2);
    });

    it('drops the sample when vm_stat exists but this call failed', () => {
      expect(sample({ vm_stat: failed })).toBeNull();
    });

    it('falls back rather than dropping when vm_stat output cannot be parsed', () => {
      // An OS version whose format we do not understand is deterministic: every
      // sample on this host takes the same fallback, so the series has no step.
      // Dropping instead would leave the dashboard permanently "unsupported".
      const s = sample({ vm_stat: ok('vm_stat: unrecognized flag') })!;
      expect(s.supported).toBe(true);
      expect(Math.abs(s.mem.memAvailableBytes - freemem())).toBeLessThan(256 * 1024 ** 2);
    });

    it('keeps ps RSS rather than dropping when top output cannot be parsed', () => {
      const s = sample({ top: ok('top: illegal option -- Z') })!;
      expect(s.supported).toBe(true);
      expect(s.processes.map(p => p.rssBytes)).toEqual([32_144 * 1024, 65_536 * 1024]);
    });

    it('reports ps RSS for every sample when top does not exist on the host', () => {
      const s = sample({ top: absent })!;
      expect(s.supported).toBe(true);
      expect(s.processes.map(p => p.rssBytes)).toEqual([32_144 * 1024, 65_536 * 1024]);
    });

    it('drops the sample when top exists but this call failed', () => {
      // Silently keeping RSS here would splice a ~2.7x step into a footprint series.
      expect(sample({ top: failed })).toBeNull();
    });

    it('drops the sample when the identity re-check pass failed', () => {
      // Without it no pid can be proven unchanged, so every row would keep RSS.
      expect(sample({ births: failed })).toBeNull();
    });

    it('keeps the sample when swap is unavailable, since swap feeds no history series', () => {
      const s = sample({ sysctl: failed })!;
      expect(s.supported).toBe(true);
      expect(s.mem).toMatchObject({ swapTotalBytes: 0, swapFreeBytes: 0 });
    });
  });

  it('parses birth stamps from the identity re-check pass', () => {
    const raw = '  100 Tue Jul 21 22:59:26 2026\n  200 Wed Aug  5 21:49:32 2026\ngarbage\n';

    expect([...parsePsBirthStamps(raw).entries()]).toEqual([
      [100, 'Tue Jul 21 22:59:26 2026'],
      [200, 'Wed Aug 5 21:49:32 2026'],
    ]);
  });

  it('skips malformed ps rows instead of poisoning the table', () => {
    const table = parsePsTable([
      '1 0 32144 0:01.00 Tue Jul 21 22:59:26 2026',
      'garbage',
      '',
      '2 1 100 0:02.00 Tue Jul 21 22:59:27 2026',
    ].join('\n'));

    expect(table.map(proc => proc.pid)).toEqual([1, 2]);
  });

  it('parses top MEM values with unit suffixes and diff markers', () => {
    expect(parseTopMemBytes('3665K')).toBe(3_665 * 1024);
    expect(parseTopMemBytes('213M')).toBe(213 * 1024 ** 2);
    expect(parseTopMemBytes('1.2G')).toBe(1.2 * 1024 ** 3);
    expect(parseTopMemBytes('213M+')).toBe(213 * 1024 ** 2);
    expect(parseTopMemBytes('16384B')).toBe(16_384);
    expect(parseTopMemBytes('PID')).toBeNull();
  });

  it('maps top rows to pid → footprint and ignores the banner', () => {
    const raw = [
      'Processes: 695 total, 2 running, 693 sleeping, 2883 threads',
      'PhysMem: 18G used (1977M wired, 152M compressor), 5530M unused.',
      'PID    MEM  ',
      '96892  3665K',
      '23317  213M ',
    ].join('\n');

    expect([...parseTopFootprints(raw).entries()]).toEqual([[96892, 3_665 * 1024], [23317, 213 * 1024 ** 2]]);
  });

  it('counts free+speculative+inactive as available and never adds purgeable', () => {
    const raw = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                                   100.',
      'Pages active:                                 900.',
      'Pages inactive:                               200.',
      'Pages speculative:                             50.',
      'Pages wired down:                             300.',
      'Pages purgeable:                               10.',
      'Pages occupied by compressor:                 400.',
    ].join('\n');

    const mem = parseVmStat(raw, 1_000 * 16_384);
    // purgeable pages also sit on the active/inactive queues (XNU counts resident
    // non-wired pages of volatile purgeable objects), so adding them would count the
    // inactive∩purgeable overlap twice and overstate what can be reclaimed.
    expect(mem).toEqual({ memTotalBytes: 16_384_000, memAvailableBytes: 350 * 16_384 });
    // Compressor pages are in none of those queues → counted as used.
    expect(mem && mem.memTotalBytes - mem.memAvailableBytes).toBe(650 * 16_384);
  });

  it('returns null from vm_stat parsing when the page size or counters are missing', () => {
    expect(parseVmStat('Pages free: 100.\n', 1024)).toBeNull();
    expect(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\n', 1024)).toBeNull();
  });

  it('parses sysctl vm.swapusage, including the no-swap case', () => {
    expect(parseSwapusage('total = 2048.00M  used = 1024.25M  free = 1023.75M  (encrypted)')).toEqual({
      swapTotalBytes: 2048 * 1024 ** 2,
      swapFreeBytes: 1023.75 * 1024 ** 2,
    });
    expect(parseSwapusage('total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)')).toEqual({
      swapTotalBytes: 0,
      swapFreeBytes: 0,
    });
    expect(parseSwapusage('')).toEqual({ swapTotalBytes: 0, swapFreeBytes: 0 });
  });
});

describe.runIf(onDarwin)('darwin resource sampling (live host)', () => {
  it('samples the real host through sampleProcfs, including this test process', () => {
    const sample = sampleProcfs(1_700_000_000_000);

    expect(sample.supported).toBe(true);
    expect(sample.reason).toBeUndefined();
    expect(sample.sampledAt).toBe(1_700_000_000_000);
    expect(sample.mem.memTotalBytes).toBeGreaterThan(0);
    expect(sample.mem.memAvailableBytes).toBeGreaterThan(0);
    expect(sample.mem.memAvailableBytes).toBeLessThanOrEqual(sample.mem.memTotalBytes);
    expect(sample.totalCpuTicks).toBeGreaterThan(sample.idleCpuTicks);
    expect(sample.loadavg.load1).toBeGreaterThan(0);

    const self = sample.processes.find(proc => proc.pid === process.pid);
    expect(self).toBeDefined();
    expect(self?.ppid).toBe(process.ppid);
    expect(self?.rssBytes).toBeGreaterThan(0);
    expect(self?.cmd).toBeUndefined(); // argv is deliberately not sampled
  });

  it('produces process-birth stamps a real marker still authenticates against', () => {
    const sample = sampleDarwin(Date.now());
    const self = sample?.processes.find(proc => proc.pid === process.pid);
    const markerProcStart = readProcessStartIdentity(process.pid);
    expect(markerProcStart).toBeTruthy();

    // The two producers format ps's day-of-month padding differently, so a raw
    // string compare fails ("Aug  5" vs "Aug 5") and every session would silently
    // drop to `unknown`. What must hold is that attribution still accepts the marker.
    const attributed = attributeResources({
      processes: sample!.processes,
      processCpuPct: new Map(),
      cliMarkers: new Map([[process.pid, { sessionId: 's1', procStart: markerProcStart! }]]),
      sessions: [{ sessionId: 's1', larkAppId: 'app1', botName: 'bot1', status: 'working' }],
      daemons: [],
      previousSessionStats: new Map(),
      botmuxPids: [process.pid],
      nowMs: Date.now(),
    });

    expect(attributed.sessions[0]?.pids.cliPids).toContain(process.pid);
    expect(attributed.sessions[0]?.confidence).toBe('marker');
    expect(String(self?.startTicks).replace(/\s+/g, ' ')).toBe(markerProcStart!.replace(/\s+/g, ' '));
  });

  it('accumulates cpu ticks monotonically between samples', () => {
    const first = sampleDarwin(Date.now());
    const spinUntil = Date.now() + 120;
    while (Date.now() < spinUntil) { /* burn measurable cpu time in this process */ }
    const second = sampleDarwin(Date.now());

    expect(second!.totalCpuTicks).toBeGreaterThan(first!.totalCpuTicks);
    const before = first!.processes.find(proc => proc.pid === process.pid)!.cpuTicks;
    const after = second!.processes.find(proc => proc.pid === process.pid)!.cpuTicks;
    expect(after).toBeGreaterThan(before);
  });
});
