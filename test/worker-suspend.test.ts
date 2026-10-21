import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendType } from '../src/adapters/backend/types.js';
import type { CliId } from '../src/adapters/cli/types.js';

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

import {
  __testOnly_setSuspendBackingVerifier,
  destroySuspendBackingVerified,
  retiringWorkersForSession,
  suspendWorker,
} from '../src/core/worker-pool.js';
import { isSuspendableBackendType } from '../src/core/persistent-backend.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';

const CLI_IDS: CliId[] = [
  'claude-code',
  'seed',
  'aiden',
  'coco',
  'codex',
  'codex-app',
  'cursor',
  'gemini',
  'opencode',
  'antigravity',
  'mtr',
  'hermes',
  'mira',
  'traex',
  'pi',
  'copilot',
];

const BACKENDS: BackendType[] = ['pty', 'tmux', 'herdr', 'zellij', 'zmx'];

beforeEach(() => {
  vi.clearAllMocks();
  __testOnly_setSuspendBackingVerifier(() => true);
});
afterEach(() => __testOnly_setSuspendBackingVerifier());

describe('worker suspend backend gating', () => {
  it.each(BACKENDS)('classifies %s correctly', (backend) => {
    expect(isSuspendableBackendType(backend)).toBe(backend !== 'pty');
  });

  it.each(CLI_IDS)('does not special-case CLI adapter %s', (_cliId) => {
    expect(isSuspendableBackendType('tmux')).toBe(true);
    expect(isSuspendableBackendType('herdr')).toBe(true);
    expect(isSuspendableBackendType('zellij')).toBe(true);
    expect(isSuspendableBackendType('zmx')).toBe(true);
    expect(isSuspendableBackendType('pty')).toBe(false);
  });
});

function fakeWorker() {
  return {
    killed: false,
    pid: 12345,
    send: vi.fn(),
    once: vi.fn(),
    kill: vi.fn(),
    exitCode: null,
    signalCode: null,
  } as any;
}

describe('suspendWorker', () => {
  it('kills the exact backing and requires a positive missing post-probe', () => {
    const ds: any = {
      session: { sessionId: 'sid-verified', status: 'active' },
      initConfig: { backendType: 'tmux' },
      larkAppId: 'cli_test',
    };
    const kill = vi.fn();
    const probe = vi.fn()
      .mockReturnValueOnce('exists')
      .mockReturnValueOnce('missing');

    expect(destroySuspendBackingVerified(ds, { kill, probe })).toBe(true);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledWith(
      expect.objectContaining({ backendType: 'tmux', sessionName: expect.stringContaining('sid-veri') }),
      'sid-verified',
    );
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it.each(['exists', 'unknown'] as const)(
    'fails closed when the backing remains %s after retry',
    (finalProbe) => {
      const ds: any = {
        session: { sessionId: `sid-${finalProbe}`, status: 'active' },
        initConfig: { backendType: 'tmux' },
        larkAppId: 'cli_test',
      };
      const kill = vi.fn();
      const probe = vi.fn(() => finalProbe);

      expect(destroySuspendBackingVerified(ds, { kill, probe })).toBe(false);
      expect(kill).toHaveBeenCalledTimes(2);
      expect(probe).toHaveBeenCalledTimes(2);
    },
  );

  it('also fails closed when a parked crash-diagnostic shell cannot be verified gone', () => {
    const ds: any = {
      session: { sessionId: 'sid-diagnostic', status: 'active' },
      initConfig: { backendType: 'tmux' },
      larkAppId: 'cli_test',
      crashDiagnosticParked: true,
    };
    const kill = vi.fn();
    const probe = vi.fn(() => 'missing' as const);
    const killDiagnostic = vi.fn();
    const probeDiagnostic = vi.fn(() => 'unknown' as const);

    expect(destroySuspendBackingVerified(ds, {
      kill, probe, killDiagnostic, probeDiagnostic,
    })).toBe(false);
    expect(killDiagnostic).toHaveBeenCalledTimes(2);
    expect(probeDiagnostic).toHaveBeenCalledTimes(2);
    expect(kill).not.toHaveBeenCalled();
  });

  it('suspends a persistent worker without closing the active session', () => {
    const worker = fakeWorker();
    const order: string[] = [];
    __testOnly_setSuspendBackingVerifier(() => { order.push('backing-verified'); return true; });
    worker.send.mockImplementation(() => { order.push('worker-notified'); });
    const ds: any = {
      session: { sessionId: 'sid-1', status: 'active' },
      initConfig: { backendType: 'tmux' },
      worker,
      workerPort: 3456,
      workerToken: 'token',
      managedTurnOrigin: { capability: 'cap-live', turnId: 'om-live' },
      lastScreenStatus: 'idle',
      exitEventEmitted: false,
    };

    const didSuspend = suspendWorker(ds, 'idle_budget');

    expect(didSuspend).toBe(true);
    expect(order).toEqual(['backing-verified', 'worker-notified']);
    expect(worker.send).toHaveBeenCalledWith({ type: 'suspend' });
    expect(ds.session.status).toBe('active');
    expect(ds.worker).toBe(null);
    expect(ds.workerPort).toBe(null);
    expect(ds.workerToken).toBe(null);
    expect(ds.managedTurnOrigin).toBeUndefined();
    expect(ds.lastScreenStatus).toBeUndefined();
    // The daemon-side verifier proved the backing session + CLI gone before the
    // worker notification, so the next turn must cold-resume: mark history (→ forkWorker resume=true builds
    // --resume) and persist the suspend intent (→ restore won't zombie-close it).
    expect(ds.hasHistory).toBe(true);
    expect(ds.session.suspendedColdResume).toBe(true);
    expect(dashboardEventBus.publish).toHaveBeenCalledWith({
      type: 'session.update',
      body: {
        sessionId: 'sid-1',
        patch: { status: 'dormant', webPort: null, workerPid: null },
      },
    });
  });

  it('does not suspend pty workers', () => {
    const worker = fakeWorker();
    const ds: any = {
      session: { sessionId: 'sid-pty', status: 'active' },
      initConfig: { backendType: 'pty' },
      worker,
      workerPort: 3456,
      workerToken: 'token',
      managedTurnOrigin: { capability: 'cap-pty', turnId: 'om-pty' },
    };

    expect(suspendWorker(ds, 'idle_budget')).toBe(false);
    expect(worker.send).not.toHaveBeenCalled();
    expect(ds.worker).toBe(worker);
    expect(ds.managedTurnOrigin).toEqual({ capability: 'cap-pty', turnId: 'om-pty' });
  });

  it('does not persist dormant or notify the worker when teardown is unverified', () => {
    __testOnly_setSuspendBackingVerifier(() => false);
    const worker = fakeWorker();
    const ds: any = {
      session: { sessionId: 'sid-unverified', status: 'active' },
      initConfig: { backendType: 'tmux' },
      worker,
      workerPort: 3456,
      workerToken: 'token',
      lastScreenStatus: 'idle',
      exitEventEmitted: false,
    };

    expect(suspendWorker(ds, 'idle_budget')).toBe(false);
    expect(worker.send).not.toHaveBeenCalled();
    expect(ds.worker).toBe(worker);
    expect(ds.session.suspendedColdResume).toBeUndefined();
    expect(dashboardEventBus.publish).not.toHaveBeenCalled();
    // The retirement tracked before the verifier ran must be rolled back: a
    // still-live worker left in the retiring index biases the VC fence's
    // producer-liveness gate against this session.
    expect(retiringWorkersForSession('sid-unverified')).toEqual([]);
  });

  it('tracks the worker as retiring only after teardown is verified', () => {
    const worker = fakeWorker();
    const ds: any = {
      session: { sessionId: 'sid-retiring', status: 'active' },
      initConfig: { backendType: 'tmux' },
      worker,
      workerPort: 3456,
      workerToken: 'token',
      lastScreenStatus: 'idle',
      exitEventEmitted: false,
    };

    expect(suspendWorker(ds, 'idle_budget')).toBe(true);
    // Verified suspend marks retirement; release happens on the worker's exit.
    expect(retiringWorkersForSession('sid-retiring')).toContain(worker);
  });

  it('refuses suspension while the durable Codex App dispatch ledger is non-empty', () => {
    const worker = fakeWorker();
    const ds: any = {
      session: {
        sessionId: 'sid-owned',
        status: 'active',
        codexAppDispatchLedger: [
          { dispatchId: 'd-1', turnId: 't-1', state: 'prepared', content: 'owned' },
        ],
      },
      initConfig: { backendType: 'tmux' },
      worker,
      workerPort: 3456,
      workerToken: 'token',
      lastScreenStatus: 'idle',
    };

    expect(suspendWorker(ds, 'manual_suspend')).toBe(false);
    expect(worker.send).not.toHaveBeenCalled();
    expect(ds.worker).toBe(worker);
    expect(ds.workerPort).toBe(3456);
    expect(ds.workerToken).toBe('token');
  });

  it.each([
    ['missing', null],
    ['already killed', { killed: true }],
  ])('clears managed-turn authority when the worker generation is %s', (_state, worker) => {
    const ds: any = {
      session: { sessionId: 'sid-absent', status: 'active' },
      initConfig: { backendType: 'tmux' },
      worker,
      managedTurnOrigin: { capability: 'cap-stale', turnId: 'om-stale' },
    };

    expect(suspendWorker(ds, 'idle_budget')).toBe(false);
    expect(ds.managedTurnOrigin).toBeUndefined();
  });
});
