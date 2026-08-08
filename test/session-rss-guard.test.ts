import { describe, expect, it, vi } from 'vitest';
import { sweepOversizedSessions } from '../src/core/session-rss-guard.js';
import type { ProcessResourceSample } from '../src/core/resource-monitor/types.js';

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  updateSessionPid: vi.fn(),
  updateSession: vi.fn(),
}));
vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ config: {} })),
}));

const MiB = 1024 * 1024;

function proc(pid: number, ppid: number, rssMiB: number, startTicks = pid * 10): ProcessResourceSample {
  return {
    pid,
    ppid,
    rssBytes: rssMiB * MiB,
    cpuTicks: 0,
    startTicks,
    cmd: `p${pid}`,
  };
}

function ds(sessionId: string, opts: Record<string, unknown> = {}) {
  return {
    session: { sessionId, status: 'active' },
    worker: { pid: 100, killed: false },
    workerGeneration: 1,
    initConfig: { backendType: 'tmux' },
    lastScreenStatus: 'idle',
    larkAppId: 'app',
    ...opts,
  } as any;
}

describe('sweepOversizedSessions', () => {
  it('does nothing when the guard threshold is unset', () => {
    const suspend = vi.fn();
    const active = new Map<string, any>([
      ['s1', ds('s1')],
    ]);

    expect(sweepOversizedSessions(active, {
      processes: [proc(100, 1, 100), proc(101, 100, 900)],
      suspend,
    })).toEqual([]);
    expect(suspend).not.toHaveBeenCalled();
  });

  it('suspends an idle resumable session over the RSS threshold', () => {
    const suspend = vi.fn(() => true);
    const active = new Map<string, any>([
      ['s1', ds('s1')],
    ]);

    const res = sweepOversizedSessions(active, {
      maxSessionRssMiB: 512,
      processes: [proc(100, 1, 120), proc(101, 100, 450)],
      suspend,
    });

    expect(res).toEqual([{
      sessionId: 's1',
      rssBytes: 570 * MiB,
      thresholdBytes: 512 * MiB,
      pids: [100, 101],
    }]);
    expect(suspend).toHaveBeenCalledWith(active.get('s1'), 'session_rss_guard');
  });

  it('skips busy, adopted, and non-resumable sessions', () => {
    const suspend = vi.fn(() => true);
    const active = new Map<string, any>([
      ['busy', ds('busy', { worker: { pid: 100, killed: false }, lastScreenStatus: 'working' })],
      ['adopt', ds('adopt', { worker: { pid: 200, killed: false }, adoptedFrom: { tmuxTarget: 'user:0.1' } })],
      ['pty', ds('pty', { worker: { pid: 300, killed: false }, initConfig: { backendType: 'pty' } })],
    ]);

    const res = sweepOversizedSessions(active, {
      maxSessionRssMiB: 128,
      processes: [
        proc(100, 1, 300),
        proc(200, 1, 300),
        proc(300, 1, 300),
      ],
      suspend,
    });

    expect(res).toEqual([]);
    expect(suspend).not.toHaveBeenCalled();
  });

  it('includes a trusted attested CLI pid outside the worker subtree', () => {
    const suspend = vi.fn(() => true);
    const active = new Map<string, any>([
      ['s1', ds('s1', {
        worker: { pid: 100, killed: false },
        localProcessAttestation: {
          workerGeneration: 1,
          backendType: 'tmux',
          credentialIsolated: false,
          cliPid: 500,
          cliProcStart: '5000',
        },
      })],
    ]);

    const res = sweepOversizedSessions(active, {
      maxSessionRssMiB: 512,
      processes: [
        proc(100, 1, 80),
        proc(500, 1, 350, 5000),
        proc(501, 500, 220),
      ],
      suspend,
      processStart: (pid) => pid === 500 ? '5000' : String(pid * 10),
    });

    expect(res.map(x => ({ sessionId: x.sessionId, pids: x.pids, rssMiB: x.rssBytes / MiB }))).toEqual([
      { sessionId: 's1', pids: [100, 500, 501], rssMiB: 650 },
    ]);
  });

  it('ignores a stale attested CLI pid when procStart no longer matches', () => {
    const suspend = vi.fn(() => true);
    const active = new Map<string, any>([
      ['s1', ds('s1', {
        worker: { pid: 100, killed: false },
        localProcessAttestation: {
          workerGeneration: 1,
          backendType: 'tmux',
          credentialIsolated: false,
          cliPid: 500,
          cliProcStart: 'old-start',
        },
      })],
    ]);

    const res = sweepOversizedSessions(active, {
      maxSessionRssMiB: 512,
      processes: [
        proc(100, 1, 80),
        proc(500, 1, 600, 5000),
      ],
      suspend,
      processStart: () => 'new-start',
    });

    expect(res).toEqual([]);
    expect(suspend).not.toHaveBeenCalled();
  });
});
