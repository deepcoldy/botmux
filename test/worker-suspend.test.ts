import { describe, expect, it, vi } from 'vitest';
import type { BackendType } from '../src/adapters/backend/types.js';
import type { CliId } from '../src/adapters/cli/types.js';

vi.mock('../src/services/session-store.js', () => ({
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

import { suspendWorker } from '../src/core/worker-pool.js';
import { isSuspendableBackendType } from '../src/core/persistent-backend.js';

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

const BACKENDS: BackendType[] = ['pty', 'tmux', 'herdr', 'zellij'];

describe('worker suspend backend gating', () => {
  it.each(BACKENDS)('classifies %s correctly', (backend) => {
    expect(isSuspendableBackendType(backend)).toBe(backend !== 'pty');
  });

  it.each(CLI_IDS)('does not special-case CLI adapter %s', (_cliId) => {
    expect(isSuspendableBackendType('tmux')).toBe(true);
    expect(isSuspendableBackendType('herdr')).toBe(true);
    expect(isSuspendableBackendType('zellij')).toBe(true);
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
  it('suspends a persistent worker without closing the active session', () => {
    const worker = fakeWorker();
    const ds: any = {
      session: { sessionId: 'sid-1', status: 'active' },
      initConfig: { backendType: 'tmux' },
      worker,
      workerPort: 3456,
      workerToken: 'token',
      exitEventEmitted: false,
    };

    const didSuspend = suspendWorker(ds, 'idle_budget');

    expect(didSuspend).toBe(true);
    expect(worker.send).toHaveBeenCalledWith({ type: 'suspend' });
    expect(ds.session.status).toBe('active');
    expect(ds.worker).toBe(null);
    expect(ds.workerPort).toBe(null);
    expect(ds.workerToken).toBe(null);
  });

  it('does not suspend pty workers', () => {
    const worker = fakeWorker();
    const ds: any = {
      session: { sessionId: 'sid-pty', status: 'active' },
      initConfig: { backendType: 'pty' },
      worker,
      workerPort: 3456,
      workerToken: 'token',
    };

    expect(suspendWorker(ds, 'idle_budget')).toBe(false);
    expect(worker.send).not.toHaveBeenCalled();
    expect(ds.worker).toBe(worker);
  });
});
