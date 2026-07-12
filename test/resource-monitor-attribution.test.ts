import { describe, expect, it } from 'vitest';
import { attributeResources } from '../src/core/resource-monitor/attribution.js';
import type { ProcessResourceSample } from '../src/core/resource-monitor/types.js';

const processes: ProcessResourceSample[] = [
  { pid: 10, ppid: 1, rssBytes: 100, cpuTicks: 1000, cmd: 'daemon-a' },
  { pid: 20, ppid: 10, rssBytes: 200, cpuTicks: 2000, cmd: 'worker-a' },
  { pid: 21, ppid: 20, rssBytes: 300, cpuTicks: 3000, cmd: 'cli-a' },
  { pid: 30, ppid: 10, rssBytes: 400, cpuTicks: 4000, cmd: 'unrelated' },
  { pid: 40, ppid: 1, rssBytes: 500, cpuTicks: 5000, cmd: 'daemon-b' },
  { pid: 50, ppid: 1, rssBytes: 600, cpuTicks: 6000, cmd: 'adopted-cli' },
];

describe('attributeResources', () => {
  it('attributes all current sessions and keeps bot aggregates independent of Top selection', () => {
    const result = attributeResources({
      processes,
      processCpuPct: new Map([[10, 1], [20, 2], [21, 3], [30, 4], [40, 5], [50, 6]]),
      sessions: [
        { sessionId: 's1', larkAppId: 'app-a', botName: 'A', title: 'one', status: 'working', workerPid: 20 },
        { sessionId: 's2', larkAppId: 'app-a', botName: 'A', title: 'two', status: 'idle' },
        { sessionId: 's3', larkAppId: 'app-b', botName: 'B', title: 'adopted', status: 'working', adoptCliPid: 50 },
      ],
      daemons: [
        { larkAppId: 'app-a', botName: 'A', pid: 10 },
        { larkAppId: 'app-b', botName: 'B', pid: 40 },
      ],
      cliMarkers: new Map([[21, { sessionId: 's1' }]]),
      previousSessionStats: new Map(),
      nowMs: 10_000,
    });

    expect(result.sessions.map(s => s.sessionId)).toEqual(['s1', 's2', 's3']);
    expect(result.sessions.find(s => s.sessionId === 's1')?.current.rssBytes).toBe(500);
    expect(result.sessions.find(s => s.sessionId === 's1')?.current.cpuPct).toBe(5);
    expect(result.sessions.find(s => s.sessionId === 's1')?.confidence).toBe('marker');
    expect(result.sessions.find(s => s.sessionId === 's2')?.confidence).toBe('unknown');
    expect(result.sessions.find(s => s.sessionId === 's3')?.confidence).toBe('adopted');
    expect(result.bots.find(b => b.larkAppId === 'app-a')?.sessions.rssBytes).toBe(500);
    expect(result.bots.find(b => b.larkAppId === 'app-a')?.daemon.rssBytes).toBe(100);
    expect(result.bots.find(b => b.larkAppId === 'app-b')?.total.rssBytes).toBe(1100);

    // botmux total = daemon(10,40) + worker(20) + cli(21,50), and the breakdown
    // splits it: the per-session worker Node process (pid 20) is `worker`, while
    // its CLI child (pid 21) and the adopted CLI (pid 50) are `cli` — proving
    // botmux's own footprint is separable from the external CLIs. Sum == total.
    expect(result.botmux).toEqual({ rssBytes: 1700, cpuPct: 17 });
    expect(result.botmuxBreakdown).toEqual({
      daemon: { rssBytes: 600, cpuPct: 6 },
      worker: { rssBytes: 200, cpuPct: 2 },
      cli: { rssBytes: 900, cpuPct: 9 },
    });
    const parts = result.botmuxBreakdown;
    expect(parts.daemon.rssBytes + parts.worker.rssBytes + parts.cli.rssBytes).toBe(result.botmux.rssBytes);
  });

  it('does not force ambiguous marker processes into a session', () => {
    const result = attributeResources({
      processes,
      processCpuPct: new Map([[21, 3]]),
      sessions: [
        { sessionId: 's1', larkAppId: 'app-a', botName: 'A', status: 'working' },
        { sessionId: 's2', larkAppId: 'app-a', botName: 'A', status: 'working' },
      ],
      daemons: [{ larkAppId: 'app-a', botName: 'A' }],
      cliMarkers: new Map([[21, { sessionId: 's1' }], [20, { sessionId: 's2' }]]),
      previousSessionStats: new Map(),
      nowMs: 10_000,
    });

    expect(result.sessions.find(s => s.sessionId === 's1')?.current.rssBytes).toBe(0);
    expect(result.sessions.find(s => s.sessionId === 's2')?.current.rssBytes).toBe(200);
  });

  it('rejects stale marker pids when process start ticks do not match', () => {
    const result = attributeResources({
      processes: [
        { pid: 21, ppid: 1, rssBytes: 300, cpuTicks: 3000, startTicks: 222, cmd: 'reused-pid' },
      ],
      processCpuPct: new Map([[21, 3]]),
      sessions: [
        { sessionId: 's1', larkAppId: 'app-a', botName: 'A', status: 'working' },
      ],
      daemons: [{ larkAppId: 'app-a', botName: 'A' }],
      cliMarkers: new Map([[21, { sessionId: 's1', procStart: '111' }]]),
      previousSessionStats: new Map(),
      nowMs: 10_000,
    });

    expect(result.sessions[0].confidence).toBe('unknown');
    expect(result.sessions[0].current.rssBytes).toBe(0);
    expect(result.bots[0].sessions.rssBytes).toBe(0);
  });

  it('does not attribute descendants through a worker pid missing from the sampled process set', () => {
    const result = attributeResources({
      processes: [
        { pid: 201, ppid: 200, rssBytes: 300, cpuTicks: 3000, cmd: 'stale-child' },
      ],
      processCpuPct: new Map([[201, 3]]),
      sessions: [
        { sessionId: 'stale', larkAppId: 'app-a', botName: 'A', status: 'working', workerPid: 200 },
      ],
      daemons: [{ larkAppId: 'app-a', botName: 'A' }],
      cliMarkers: new Map(),
      previousSessionStats: new Map(),
      nowMs: 10_000,
    });

    const session = result.sessions[0];
    expect(session.confidence).toBe('unknown');
    expect(session.current.rssBytes).toBe(0);
    expect(session.current.cpuPct).toBe(0);
    expect(session.pids.sampledPids).toBe(0);
    expect(session.pids).not.toHaveProperty('workerPid');
    expect(result.bots[0].sessions.rssBytes).toBe(0);
  });

  it('includes the dashboard process in botmux totals even without bot daemons', () => {
    const result = attributeResources({
      processes,
      processCpuPct: new Map([[30, 4]]),
      sessions: [],
      daemons: [],
      botmuxPids: [30],
      cliMarkers: new Map(),
      previousSessionStats: new Map(),
      nowMs: 10_000,
    });

    expect(result.botmux).toEqual({ rssBytes: 400, cpuPct: 4 });
    expect(result.botmuxBreakdown).toEqual({
      daemon: { rssBytes: 400, cpuPct: 4 },
      worker: { rssBytes: 0, cpuPct: 0 },
      cli: { rssBytes: 0, cpuPct: 0 },
    });
    expect(result.bots).toEqual([]);
  });

  it('uses explicit daemon status before process-presence fallback', () => {
    const result = attributeResources({
      processes,
      processCpuPct: new Map([[10, 1], [40, 5]]),
      sessions: [],
      daemons: [
        { larkAppId: 'app-online', botName: 'Online', status: 'online' },
        { larkAppId: 'app-offline', botName: 'Offline', pid: 40, status: 'offline' },
        { larkAppId: 'app-explicit-unknown', botName: 'Explicit Unknown', pid: 40, status: 'unknown' },
        { larkAppId: 'app-missing-pid', botName: 'Missing PID', pid: 999 },
        { larkAppId: 'app-missing', botName: 'Missing' },
      ],
      cliMarkers: new Map(),
      previousSessionStats: new Map(),
      nowMs: 10_000,
    });

    expect(result.bots.map(bot => [bot.larkAppId, bot.daemonStatus])).toEqual([
      ['app-online', 'online'],
      ['app-offline', 'offline'],
      ['app-explicit-unknown', 'unknown'],
      ['app-missing-pid', 'offline'],
      ['app-missing', 'offline'],
    ]);
  });
});
