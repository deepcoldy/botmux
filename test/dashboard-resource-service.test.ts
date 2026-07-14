import { describe, expect, it } from 'vitest';
import { buildResourceMonitorDaemonSeeds, createResourceMonitorService, toResourceMonitorDaemonSeed, toResourceMonitorSessionSeed } from '../src/dashboard/resource-monitor-service.js';
import type { ProcfsSample } from '../src/core/resource-monitor/types.js';

function sample(processes: ProcfsSample['processes'], totalCpuTicks = 1000, idleCpuTicks = 0): ProcfsSample {
  return {
    supported: true,
    sampledAt: Date.now(),
    totalCpuTicks,
    idleCpuTicks,
    loadavg: { load1: 1, load5: 1, load15: 1 },
    mem: { memTotalBytes: 1000, memAvailableBytes: 500, swapTotalBytes: 100, swapFreeBytes: 100 },
    processes,
  };
}

describe('ResourceMonitorService', () => {
  it('maps dashboard session rows with runtime fields into resource seeds', () => {
    const seed = toResourceMonitorSessionSeed({
      sessionId: 's1',
      larkAppId: 'app',
      botName: 'row-bot',
      title: 'topic',
      status: 'active',
      spawnedAt: 10_000,
      lastMessageAt: 20_000,
      agentAttention: { kind: 123, reason: null, at: 30_000 },
      workerPid: 20,
      adoptCliPid: 30,
    }, 'registry-bot');

    expect(seed).toEqual({
      sessionId: 's1',
      larkAppId: 'app',
      botName: 'registry-bot',
      title: 'topic',
      status: 'active',
      spawnedAt: 10_000,
      lastMessageAt: 20_000,
      agentAttention: { kind: '123', reason: '', at: 30_000 },
      workerPid: 20,
      adoptCliPid: 30,
    });
  });

  it('maps dashboard daemon rows with explicit runtime status', () => {
    expect(toResourceMonitorDaemonSeed({
      larkAppId: 'app-online',
      botName: 'Online',
      pid: 10,
    })).toEqual({
      larkAppId: 'app-online',
      botName: 'Online',
      pid: 10,
      status: 'online',
    });

    expect(toResourceMonitorDaemonSeed({
      larkAppId: 'app-offline',
      botName: 'Offline',
    })).toEqual({
      larkAppId: 'app-offline',
      botName: 'Offline',
      status: 'offline',
    });
  });

  it('builds daemon seeds for configured online and offline bots', () => {
    const svc = createResourceMonitorService({
      intervalMs: 10_000,
      sampleProcfs: () => sample([
        { pid: 10, ppid: 1, rssBytes: 10, cpuTicks: 10, cmd: 'online-daemon' },
      ]),
      listSessions: () => [],
      listDaemons: () => buildResourceMonitorDaemonSeeds([
        { larkAppId: 'app-online', larkAppSecret: 'secret', displayName: 'Configured Online', cliId: 'codex' },
        { larkAppId: 'app-offline', larkAppSecret: 'secret', displayName: 'Configured Offline', cliId: 'codex' },
      ], [
        { larkAppId: 'app-online', botName: 'Online Registry', pid: 10 },
      ]),
      readCliMarkers: () => new Map(),
      nowMs: () => 100_000,
    });

    svc.sampleOnce();

    expect(svc.current().runtime.daemons).toEqual({ total: 2, online: 1, offline: 1 });
    expect(svc.current().bots.map(bot => [bot.larkAppId, bot.botName, bot.daemonPid, bot.daemonStatus])).toEqual([
      ['app-online', 'Online Registry', 10, 'online'],
      ['app-offline', 'Configured Offline', undefined, 'offline'],
    ]);
  });

  it('builds runtime summary from session seed timestamps and attention', () => {
    const svc = createResourceMonitorService({
      intervalMs: 10_000,
      sampleProcfs: () => sample([
        { pid: 10, ppid: 1, rssBytes: 10, cpuTicks: 10, cmd: 'daemon' },
        { pid: 20, ppid: 10, rssBytes: 10, cpuTicks: 10, cmd: 'worker-run' },
        { pid: 30, ppid: 10, rssBytes: 10, cpuTicks: 10, cmd: 'worker-wait' },
      ]),
      listSessions: () => [
        { sessionId: 'run', larkAppId: 'app', botName: 'bot', title: 'run', status: 'working', spawnedAt: 10_000, workerPid: 20 },
        {
          sessionId: 'wait',
          larkAppId: 'app',
          botName: 'bot',
          title: 'wait',
          status: 'active',
          spawnedAt: 40_000,
          lastMessageAt: 60_000,
          agentAttention: { kind: 'blocked', reason: 'need input', at: 70_000 },
          workerPid: 30,
        },
      ],
      listDaemons: () => [{ larkAppId: 'app', botName: 'bot', pid: 10 }],
      readCliMarkers: () => new Map(),
      nowMs: () => 100_000,
    });

    svc.sampleOnce();

    expect(svc.current().runtime.sessions).toMatchObject({
      total: 2,
      working: 1,
      waiting: 1,
      starting: 0,
    });
    expect(svc.current().runtime.sessions.longestRunning).toMatchObject({ sessionId: 'run', durationMs: 90_000 });
    expect(svc.current().runtime.sessions.longestWaiting).toMatchObject({ sessionId: 'wait', durationMs: 30_000 });
  });

  it('summarizes runtime health from service daemon and session seeds', () => {
    const svc = createResourceMonitorService({
      intervalMs: 10_000,
      sampleProcfs: () => sample([
        { pid: 10, ppid: 1, rssBytes: 10, cpuTicks: 10, cmd: 'offline-daemon' },
        { pid: 20, ppid: 1, rssBytes: 10, cpuTicks: 10, cmd: 'worker-run' },
        { pid: 30, ppid: 1, rssBytes: 10, cpuTicks: 10, cmd: 'worker-start' },
      ]),
      listSessions: () => [
        { sessionId: 'run', larkAppId: 'app-online', botName: 'Online', title: 'run', status: 'working', spawnedAt: 10_000, workerPid: 20 },
        {
          sessionId: 'wait',
          larkAppId: 'app-online',
          botName: 'Online',
          title: 'wait',
          status: 'active',
          spawnedAt: 40_000,
          lastMessageAt: 60_000,
          agentAttention: { kind: 'blocked', reason: 'need input', at: 70_000 },
        },
        { sessionId: 'start', larkAppId: 'app-offline', botName: 'Offline', title: 'start', status: 'starting', spawnedAt: 80_000, workerPid: 30 },
      ],
      listDaemons: () => [
        { larkAppId: 'app-online', botName: 'Online', status: 'online' },
        { larkAppId: 'app-offline', botName: 'Offline', pid: 10, status: 'offline' },
      ],
      readCliMarkers: () => new Map(),
      nowMs: () => 100_000,
    });

    svc.sampleOnce();

    expect(svc.current().runtime.sampleHealth.status).toBe('fresh');
    expect(svc.current().runtime.daemons).toEqual({ total: 2, online: 1, offline: 1 });
    expect(svc.current().runtime.sessions).toMatchObject({
      total: 3,
      working: 1,
      starting: 1,
      waiting: 1,
      unattributed: 1,
    });
    expect(svc.current().runtime.sessions.longestRunning).toMatchObject({ sessionId: 'run', durationMs: 90_000 });
    expect(svc.current().runtime.sessions.longestWaiting).toMatchObject({ sessionId: 'wait', durationMs: 30_000 });
    expect(svc.current().bots.find(bot => bot.larkAppId === 'app-online')?.runtime.sessions).toEqual({
      total: 2,
      working: 1,
      starting: 0,
      waiting: 1,
    });
    expect(svc.current().bots.find(bot => bot.larkAppId === 'app-offline')?.runtime).toEqual({
      daemonStatus: 'offline',
      sessions: {
        total: 1,
        working: 0,
        starting: 1,
        waiting: 0,
      },
    });
  });

  it('keeps all current sessions but only tracked sessions in history', () => {
    let tick = 0;
    let now = 0;
    const svc = createResourceMonitorService({
      intervalMs: 10_000,
      topSessionLimit: 1,
      sessionHistoryMs: 60_000,
      aggregateHistoryMs: 60_000,
      sampleProcfs: () => tick++ === 0
        ? sample([
          { pid: 10, ppid: 1, rssBytes: 10, cpuTicks: 10, cmd: 'daemon' },
          { pid: 20, ppid: 10, rssBytes: 10, cpuTicks: 10, cmd: 'worker-hot' },
          { pid: 30, ppid: 10, rssBytes: 10, cpuTicks: 10, cmd: 'worker-cold' },
        ], 100)
        : sample([
          { pid: 10, ppid: 1, rssBytes: 10, cpuTicks: 20, cmd: 'daemon' },
          { pid: 20, ppid: 10, rssBytes: 100, cpuTicks: 100, cmd: 'worker-hot' },
          { pid: 30, ppid: 10, rssBytes: 10, cpuTicks: 20, cmd: 'worker-cold' },
        ], 200),
      listSessions: () => [
        { sessionId: 'hot', larkAppId: 'app', botName: 'bot', title: 'hot', status: 'working', workerPid: 20 },
        { sessionId: 'cold', larkAppId: 'app', botName: 'bot', title: 'cold', status: 'idle', workerPid: 30 },
      ],
      listDaemons: () => [{ larkAppId: 'app', botName: 'bot', pid: 10 }],
      readCliMarkers: () => new Map(),
      nowMs: () => (now += 10_000),
    });

    svc.sampleOnce();
    svc.sampleOnce();

    expect(svc.current().sessions.map(s => s.sessionId)).toEqual(['hot', 'cold']);
    expect(svc.current().rankings.tracked).toEqual(['hot']);
    expect(svc.current().bots[0].sessions.count).toBe(2);
    expect(svc.current().bots[0].sessions.rssBytes).toBe(110);
    expect(svc.history('1h').sessions.map(s => s.sessionId)).toEqual(['hot']);
  });

  it('prunes history for sessions after they leave the tracked set', () => {
    let tick = 0;
    let now = 0;
    const svc = createResourceMonitorService({
      intervalMs: 10_000,
      topSessionLimit: 1,
      topGraceMs: 0,
      sessionHistoryMs: 60_000,
      aggregateHistoryMs: 60_000,
      sampleProcfs: () => {
        const samples = [
          [
            { pid: 20, ppid: 1, rssBytes: 100, cpuTicks: 10, cmd: 'worker-a' },
            { pid: 30, ppid: 1, rssBytes: 10, cpuTicks: 10, cmd: 'worker-b' },
          ],
          [
            { pid: 20, ppid: 1, rssBytes: 10, cpuTicks: 20, cmd: 'worker-a' },
            { pid: 30, ppid: 1, rssBytes: 200, cpuTicks: 200, cmd: 'worker-b' },
          ],
          [
            { pid: 20, ppid: 1, rssBytes: 300, cpuTicks: 500, cmd: 'worker-a' },
            { pid: 30, ppid: 1, rssBytes: 10, cpuTicks: 210, cmd: 'worker-b' },
          ],
        ] as ProcfsSample['processes'][];
        return sample(samples[Math.min(tick++, samples.length - 1)], 1000 + tick * 1000);
      },
      listSessions: () => [
        { sessionId: 'a', larkAppId: 'app', botName: 'bot', title: 'A', status: 'working', workerPid: 20 },
        { sessionId: 'b', larkAppId: 'app', botName: 'bot', title: 'B', status: 'working', workerPid: 30 },
      ],
      listDaemons: () => [{ larkAppId: 'app', botName: 'bot' }],
      readCliMarkers: () => new Map(),
      nowMs: () => (now += 10_000),
    });

    svc.sampleOnce();
    expect(svc.history('1h').sessions.map(s => s.sessionId)).toEqual(['a']);

    svc.sampleOnce();
    expect(svc.history('1h').sessions.map(s => s.sessionId)).toEqual(['b']);

    svc.sampleOnce();
    const history = svc.history('1h').sessions;
    expect(history.map(s => s.sessionId)).toEqual(['a']);
    expect(history[0].series.rssBytes).toEqual([300]);
  });

  it('returns unsupported snapshots without throwing', () => {
    const svc = createResourceMonitorService({
      intervalMs: 10_000,
      sampleProcfs: () => ({
        supported: false,
        sampledAt: 123,
        reason: 'procfs_unavailable',
        totalCpuTicks: 0,
        idleCpuTicks: 0,
        loadavg: { load1: 0, load5: 0, load15: 0 },
        mem: { memTotalBytes: 0, memAvailableBytes: 0, swapTotalBytes: 0, swapFreeBytes: 0 },
        processes: [],
      }),
      listSessions: () => [
        { sessionId: 'live', larkAppId: 'app', botName: 'bot', status: 'working', spawnedAt: 100 },
      ],
      listDaemons: () => [
        { larkAppId: 'app', botName: 'bot', status: 'online' },
        { larkAppId: 'pid-only', botName: 'pid-only', pid: 999 },
        { larkAppId: 'no-pid', botName: 'no-pid' },
        { larkAppId: 'explicit-unknown', botName: 'explicit-unknown', status: 'unknown' },
      ],
      readCliMarkers: () => new Map(),
      nowMs: () => 123,
    });

    svc.sampleOnce();

    expect(svc.current()).toMatchObject({
      ok: true,
      supported: false,
      cpuReady: false,
      reason: 'procfs_unavailable',
      bots: [],
      sessions: [],
    });
    expect(svc.current().runtime.sampleHealth.status).toBe('unsupported');
    expect(svc.current().runtime.daemons).toEqual({ total: 4, online: 1, offline: 1 });
    expect(svc.current().runtime.sessions).toMatchObject({ total: 1, working: 1, unattributed: 1 });
    expect(svc.history('3h')).toMatchObject({
      ok: true,
      supported: false,
      bots: [],
      sessions: [],
    });
  });

  it('computes host CPU from /proc/stat idle deltas instead of visible process totals', () => {
    let tick = 0;
    const svc = createResourceMonitorService({
      intervalMs: 10_000,
      sampleProcfs: () => tick++ === 0
        ? sample([{ pid: 10, ppid: 1, rssBytes: 10, cpuTicks: 10, cmd: 'botmux' }], 100, 80)
        : sample([{ pid: 10, ppid: 1, rssBytes: 10, cpuTicks: 20, cmd: 'botmux' }], 200, 150),
      listSessions: () => [],
      listDaemons: () => [{ larkAppId: 'app', botName: 'bot', pid: 10 }],
      listBotmuxPids: () => [10],
      readCliMarkers: () => new Map(),
      nowMs: () => tick * 10_000,
    });

    svc.sampleOnce();
    svc.sampleOnce();

    expect(svc.current().host?.cpuPct).toBe(30);
    expect(svc.current().botmux?.cpuPct).toBe(10);
  });

  it('marks CPU unavailable until the second supported sample has a usable delta', () => {
    let tick = 0;
    const svc = createResourceMonitorService({
      intervalMs: 10_000,
      sampleProcfs: () => tick++ === 0
        ? sample([
          { pid: 10, ppid: 1, rssBytes: 10, cpuTicks: 10, cmd: 'botmux' },
          { pid: 20, ppid: 10, rssBytes: 20, cpuTicks: 20, cmd: 'worker' },
        ], 100, 80)
        : sample([
          { pid: 10, ppid: 1, rssBytes: 10, cpuTicks: 20, cmd: 'botmux' },
          { pid: 20, ppid: 10, rssBytes: 20, cpuTicks: 40, cmd: 'worker' },
        ], 200, 150),
      listSessions: () => [{ sessionId: 's1', larkAppId: 'app', botName: 'bot', status: 'working', workerPid: 20 }],
      listDaemons: () => [{ larkAppId: 'app', botName: 'bot', pid: 10 }],
      listBotmuxPids: () => [10],
      readCliMarkers: () => new Map(),
      nowMs: () => tick * 10_000,
    });

    svc.sampleOnce();

    expect(svc.current().cpuReady).toBe(false);
    expect(svc.current().host?.cpuPct).toBe(0);
    expect(svc.current().botmux?.cpuPct).toBe(0);
    expect(svc.current().sessions[0].current.cpuPct).toBe(0);

    svc.sampleOnce();

    expect(svc.current().cpuReady).toBe(true);
    expect(svc.current().host?.cpuPct).toBe(30);
    expect(svc.current().botmux?.cpuPct).toBe(30);
    expect(svc.current().sessions[0].current.cpuPct).toBe(20);
  });

  it('does not write first-sample CPU zeroes into history before CPU is ready', () => {
    let tick = 0;
    const svc = createResourceMonitorService({
      intervalMs: 10_000,
      aggregateHistoryMs: 60_000,
      sampleProcfs: () => tick++ === 0
        ? sample([{ pid: 10, ppid: 1, rssBytes: 100, cpuTicks: 10, cmd: 'botmux' }], 100, 80)
        : sample([{ pid: 10, ppid: 1, rssBytes: 150, cpuTicks: 30, cmd: 'botmux' }], 200, 150),
      listSessions: () => [],
      listDaemons: () => [{ larkAppId: 'app', botName: 'bot', pid: 10 }],
      listBotmuxPids: () => [10],
      readCliMarkers: () => new Map(),
      nowMs: () => tick * 10_000,
    });

    svc.sampleOnce();

    expect(svc.current().cpuReady).toBe(false);
    expect(svc.history('1h').host?.cpuPct).toEqual([]);
    expect(svc.history('1h').host?.memUsedPct).toEqual([50]);
    expect(svc.history('1h').botmux?.cpuPct).toEqual([]);
    expect(svc.history('1h').botmux?.rssBytes).toEqual([100]);

    svc.sampleOnce();

    expect(svc.current().cpuReady).toBe(true);
    expect(svc.history('1h').host?.cpuPct).toEqual([30]);
    expect(svc.history('1h').host?.memUsedPct).toEqual([50, 50]);
    expect(svc.history('1h').botmux?.cpuPct).toEqual([20]);
    expect(svc.history('1h').botmux?.rssBytes).toEqual([100, 150]);
  });

  it('includes the dashboard process in botmux totals when no bot daemons are registered', () => {
    let tick = 0;
    const svc = createResourceMonitorService({
      intervalMs: 10_000,
      sampleProcfs: () => tick++ === 0
        ? sample([{ pid: 99, ppid: 1, rssBytes: 100, cpuTicks: 10, cmd: 'dashboard' }], 100, 80)
        : sample([{ pid: 99, ppid: 1, rssBytes: 150, cpuTicks: 30, cmd: 'dashboard' }], 200, 150),
      listSessions: () => [],
      listDaemons: () => [],
      listBotmuxPids: () => [99],
      readCliMarkers: () => new Map(),
      nowMs: () => tick * 10_000,
    });

    svc.sampleOnce();
    svc.sampleOnce();

    expect(svc.current().botmux).toEqual({ rssBytes: 150, cpuPct: 20 });
  });
});
