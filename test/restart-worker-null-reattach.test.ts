/**
 * Regression tests for two PR #588 restart blockers (codex 复审 / Claude 复核):
 *
 *  P1 — worker-null "fake restart": requestSessionRestart's no-worker branch
 *       now forks a fresh worker. For a session that lost its worker but kept a
 *       live persistent pane (the normal post-daemon-restart state), spawnCli
 *       would REATTACH the surviving CLI instead of relaunching it, yet still
 *       emit `restart_result: succeeded`. The fix destroys the live pane before
 *       forking so the CLI physically relaunches. Adopt sessions are exempt.
 *
 *  P2 — stale Riff `taskDoneCb`: RiffBackend fires `taskDoneCb` from
 *       `fetchAndEmitOutput(...).finally(...)`, which can resolve AFTER
 *       destroySession()/kill() (neither clears the callback nor awaits the
 *       in-flight fetch). The worker's onTaskDone hook must therefore drop a
 *       callback from a superseded backend generation. This asserts the
 *       backend-side hazard (callback fires post-kill).
 *
 * The P1 restart is driven through the real requestSessionRestart with the
 * persistent-backend primitives stubbed; the P2 hazard is reproduced on a real
 * RiffBackend. (The worker-side generation fence lives in worker.ts and has no
 * unit seam.)
 *
 * Run:  pnpm vitest run test/restart-worker-null-reattach.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The no-worker restart branch: observe the pane teardown through the
// persistent-backend primitives and the fork attempt at forkWorker's first
// external call (the device-isolation spawn gate), which defers instead of
// spawning a real worker process.
const paneEvents: string[] = [];
const paneTarget: { current: unknown } = { current: undefined };
const paneMocks = vi.hoisted(() => ({ kill: vi.fn(), probe: vi.fn(), deferSpawn: vi.fn() }));
vi.mock('../src/core/persistent-backend.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  persistentBackendTargetForSession: () => paneTarget.current,
  killPersistentBackendTarget: paneMocks.kill,
  probePersistentBackendTarget: paneMocks.probe,
}));
vi.mock('../src/core/device-isolation-activation.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  currentDeviceIsolationFreezeLease: () => null,
  deferWorkerSpawnDuringDeviceIsolation: paneMocks.deferSpawn,
}));

import { RiffBackend } from '../src/adapters/backend/riff-backend.js';


// ─── P1: pure adopt-skip decision ───────────────────────────────────────────

describe('P1 shouldDestroyPaneBeforeRestart (pure decision)', () => {
  it('is imported from worker-pool without triggering its heavy spawn wiring', async () => {
    const mod = await import('../src/core/worker-pool.js');
    expect(typeof mod.shouldDestroyPaneBeforeRestart).toBe('function');
  });

  it('destroys the pane for an ordinary owned session', async () => {
    const { shouldDestroyPaneBeforeRestart } = await import('../src/core/worker-pool.js');
    expect(shouldDestroyPaneBeforeRestart({ initConfig: { adoptMode: false } as any, adoptedFrom: undefined, session: {} as any }))
      .toBe(true);
    expect(shouldDestroyPaneBeforeRestart({ initConfig: undefined, adoptedFrom: undefined, session: {} as any }))
      .toBe(true);
  });

  it('NEVER destroys an adopted user pane (bridge invariant)', async () => {
    const { shouldDestroyPaneBeforeRestart } = await import('../src/core/worker-pool.js');
    // adoptMode frozen on the live init config
    expect(shouldDestroyPaneBeforeRestart({ initConfig: { adoptMode: true } as any, adoptedFrom: undefined, session: {} as any }))
      .toBe(false);
    // adoptedFrom stamped on the daemon session (restored adopt session)
    expect(shouldDestroyPaneBeforeRestart({
      initConfig: undefined,
      adoptedFrom: { source: 'tmux', tmuxTarget: 'dev:1.2', cliId: 'claude-code', cwd: '/tmp' } as any,
      session: {} as any,
    })).toBe(false);
  });

  it('NEVER destroys the source of an existing App Server shared adopt', async () => {
    const { shouldDestroyPaneBeforeRestart } = await import('../src/core/worker-pool.js');
    expect(shouldDestroyPaneBeforeRestart({
      initConfig: undefined,
      adoptedFrom: undefined,
      session: {
        existingAppServerEndpoint: 'unix:///home/testuser/.codex/app-server-control/app-server-control.sock',
      } as any,
    })).toBe(false);
  });
});

// ─── P1: no-worker restart tears the pane down BEFORE forking (behavioral) ────

describe('P1 requestSessionRestart without a live worker', () => {
  const target = { backendType: 'tmux', sessionName: 'bmx-null-reattach' };
  let probes: string[];

  beforeEach(() => {
    paneEvents.length = 0;
    probes = [];
    paneTarget.current = target;
    paneMocks.kill.mockReset().mockImplementation(() => { paneEvents.push('kill'); });
    paneMocks.probe.mockReset().mockImplementation(() => {
      paneEvents.push('probe');
      return probes.shift() ?? 'missing';
    });
    paneMocks.deferSpawn.mockReset().mockImplementation(() => { paneEvents.push('fork'); return true; });
  });

  async function restartWithoutWorker(extra: Record<string, unknown> = {}) {
    const { requestSessionRestart, __testOnly_resetRestartCoordinator } = await import('../src/core/worker-pool.js');
    __testOnly_resetRestartCoordinator();
    const ds: any = { session: { sessionId: `null-reattach-${Math.random()}` }, larkAppId: 'cli_app', hasHistory: true, ...extra };
    const result = requestSessionRestart(ds, { source: 'slash', notify: vi.fn(async () => {}) } as any);
    __testOnly_resetRestartCoordinator();
    return result;
  }

  it('kills and confirms the live pane gone before the fresh fork', async () => {
    const result = await restartWithoutWorker();
    expect(result?.startFailure).toBeUndefined();
    expect(paneEvents).toEqual(['kill', 'probe', 'fork']);
    expect(paneMocks.kill).toHaveBeenCalledWith(target, expect.stringMatching(/^null-reattach-/));
  });

  it('retries the kill once when the pane survives, and only then', async () => {
    probes = ['exists', 'missing'];
    await restartWithoutWorker();
    expect(paneEvents).toEqual(['kill', 'probe', 'kill', 'probe', 'fork']);

    // An indeterminate probe is not a confirmed survivor: no retry.
    paneEvents.length = 0;
    probes = ['unknown'];
    await restartWithoutWorker();
    expect(paneEvents).toEqual(['kill', 'probe', 'fork']);
  });

  it('still reforks when the pane survives the retry (stranding is worse than the guarded bug)', async () => {
    probes = ['exists', 'exists'];
    await restartWithoutWorker();
    expect(paneEvents).toEqual(['kill', 'probe', 'kill', 'probe', 'fork']);
  });

  it('never kills an adopted pane or a session without a persistent target', async () => {
    await restartWithoutWorker({ adoptedFrom: { source: 'tmux', tmuxTarget: 'dev:1.2', cliId: 'claude-code', cwd: '/tmp' } });
    expect(paneEvents).toEqual(['fork']);
    paneEvents.length = 0;
    paneTarget.current = undefined;
    await restartWithoutWorker();
    expect(paneEvents).toEqual(['fork']);
  });
});

// ─── P2: RiffBackend stale-callback hazard (behavioral) ──────────────────────

describe('P2 RiffBackend stale taskDoneCb hazard', () => {
  let resolvers: Array<(r: Response) => void>;
  let fetchMock: ReturnType<typeof vi.fn>;
  const flush = () => new Promise((r) => setTimeout(r, 0));

  function pendingSse(): Response {
    const body = new ReadableStream<Uint8Array>({ start() { /* never pushes */ } });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  beforeEach(() => {
    resolvers = [];
    fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/api2/task-stream')) return pendingSse();
      // task-detail (final-output fetch): resolve manually so the test controls
      // WHEN the .finally(taskDoneCb) runs relative to kill().
      if (u.includes('/api/task-detail')) {
        return new Promise<Response>((resolve) => { resolvers.push(resolve); });
      }
      if (u.includes('/api/task-cancel')) return Response.json({ success: true, data: {} });
      // task-execute: resolve immediately with a running task id
      return Response.json({ success: true, data: { id: 'task-1', status: 'running' } });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('fires taskDoneCb AFTER kill() (proves the worker-side generation fence is required)', async () => {
    const be = new RiffBackend({ baseUrl: 'https://riff.test', jwt: 'jwt' } as any, 'session-1');
    let killedWhenDoneFired: boolean | undefined;
    be.onTaskDone(() => { killedWhenDoneFired = (be as any).killed === true; });
    be.onExit(() => { /* swallow */ });

    be.spawn('', [], {} as any);
    be.write('do work');
    await flush();

    // Task completes → RiffBackend launches fetchAndEmitOutput(taskId), whose
    // .finally() will call taskDoneCb. The detail fetch is still pending.
    (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-1');
    await flush();
    expect(killedWhenDoneFired).toBeUndefined(); // not fired yet — fetch pending

    // Detach the stream (worker teardown / restart). kill() does NOT clear the
    // pending final-output fetch nor its taskDoneCb.
    be.kill();
    expect((be as any).killed).toBe(true);

    // The in-flight detail fetch now resolves → .finally(taskDoneCb) runs.
    resolvers.shift()!(Response.json({ success: true, data: { task: {} } }));
    await flush(); await flush();

    // Hazard confirmed: the callback fires while the backend is already killed.
    // Without the worker's `backend !== observedBackend` fence this would reach
    // markPromptReady() and emit a premature restart success.
    expect(killedWhenDoneFired).toBe(true);
  });
});
