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
 *       backend-side hazard (callback fires post-kill) and the worker-side
 *       generation fence wiring.
 *
 * worker.ts installs process-wide IPC/services at import time, so its wiring is
 * pinned by source-structure assertions (same approach as
 * worker-restart-race.test.ts / worker-app-runner-control-wiring.test.ts). The
 * P1 adopt decision is exercised as a pure predicate.
 *
 * Run:  pnpm vitest run test/restart-worker-null-reattach.test.ts
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { RiffBackend } from '../src/adapters/backend/riff-backend.js';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const workerPoolSource = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');

// ─── P1: pure adopt-skip decision ───────────────────────────────────────────

describe('P1 shouldDestroyPaneBeforeRestart (pure decision)', () => {
  it('is imported from worker-pool without triggering its heavy spawn wiring', async () => {
    const mod = await import('../src/core/worker-pool.js');
    expect(typeof mod.shouldDestroyPaneBeforeRestart).toBe('function');
  });

  it('destroys the pane for an ordinary owned session', async () => {
    const { shouldDestroyPaneBeforeRestart } = await import('../src/core/worker-pool.js');
    expect(shouldDestroyPaneBeforeRestart({ initConfig: { adoptMode: false } as any, adoptedFrom: undefined }))
      .toBe(true);
    expect(shouldDestroyPaneBeforeRestart({ initConfig: undefined, adoptedFrom: undefined }))
      .toBe(true);
  });

  it('NEVER destroys an adopted user pane (bridge invariant)', async () => {
    const { shouldDestroyPaneBeforeRestart } = await import('../src/core/worker-pool.js');
    // adoptMode frozen on the live init config
    expect(shouldDestroyPaneBeforeRestart({ initConfig: { adoptMode: true } as any, adoptedFrom: undefined }))
      .toBe(false);
    // adoptedFrom stamped on the daemon session (restored adopt session)
    expect(shouldDestroyPaneBeforeRestart({
      initConfig: undefined,
      adoptedFrom: { source: 'tmux', tmuxTarget: 'dev:1.2', cliId: 'claude-code', cwd: '/tmp' } as any,
    })).toBe(false);
  });
});

// ─── P1: worker-pool wiring (kill BEFORE fork, no-worker branch only) ─────────

describe('P1 requestSessionRestart wiring', () => {
  it('destroys the live pane before forking in the no-worker branch', () => {
    const fn = workerPoolSource.indexOf('export function requestSessionRestart');
    expect(fn).toBeGreaterThanOrEqual(0);
    const body = workerPoolSource.slice(fn, workerPoolSource.indexOf('\n}', fn) + 2);

    // Live-worker branch still sends the in-worker restart IPC — now also
    // carrying the latest per-bot env (dashboard edits apply on /restart).
    expect(body).toContain("ds.worker.send({ type: 'restart', attemptId, env: latestPerBotEnvForRestart(ds) }");

    // No-worker branch: pane teardown MUST precede forkWorker.
    const destroy = body.indexOf('destroyLivePaneBeforeRestart(ds)');
    const fork = body.indexOf('forkWorker(ds');
    expect(destroy).toBeGreaterThan(0);
    expect(fork).toBeGreaterThan(destroy);
  });

  it('destroyLivePaneBeforeRestart kills a resolved persistent target and probe-retries on survival', () => {
    const fn = workerPoolSource.indexOf('function destroyLivePaneBeforeRestart');
    expect(fn).toBeGreaterThanOrEqual(0);
    const body = workerPoolSource.slice(fn, fn + 2800);
    expect(body).toContain('shouldDestroyPaneBeforeRestart(ds)');
    expect(body).toContain('persistentBackendTargetForSession(ds)');
    expect(body).toContain('killPersistentBackendTarget(target, ds.session.sessionId)');
    // No target (e.g. PTY/riff/legacy-unstamped) → no-op, never throws.
    expect(body).toContain('if (!target) return;');

    // Fail-safe (codex 复审): the kill primitives swallow their own failures, so
    // a bare try/catch can't detect a failed kill. Must PROBE after killing.
    expect(body).toContain('probePersistentBackendTarget(target)');
    // A confirmed survivor after retry escalates to a loud error (not silent).
    expect(body).toContain('logger.error');
    expect(body).toMatch(/STILL alive after retry/);

    // Monotonic single-probe (codex 复审): the retry re-probe happens ONLY
    // inside the `exists` branch, so an 'unknown' first probe is never
    // mislabelled as a post-retry survivor. Guard against reintroducing an
    // unconditional second probe: exactly two probe calls, the second nested in
    // the exists branch.
    const probeCalls = body.match(/probePersistentBackendTarget\(target\)/g) ?? [];
    expect(probeCalls.length).toBe(2);
    const existsBranch = body.indexOf("if (probe === 'exists') {");
    const retryProbe = body.indexOf('probe = probePersistentBackendTarget(target);', existsBranch);
    const secondExistsCheck = body.indexOf("if (probe === 'exists') {", existsBranch + 1);
    expect(existsBranch).toBeGreaterThan(0);
    expect(retryProbe).toBeGreaterThan(existsBranch);
    // The re-probe is assigned before the second exists check evaluates it.
    expect(secondExistsCheck).toBeGreaterThan(retryProbe);

    // Three-state diagnostic (codex 复审): the terminal log must NOT lump
    // 'unknown' in with 'missing' — 'missing' promises a relaunch, 'unknown'
    // must only warn that a reattach is still possible, 'exists' errors. This
    // keeps the diagnostic from lying (the whole point of the fix).
    expect(body).toContain("} else if (probe === 'unknown') {");
    expect(body).toMatch(/kill outcome indeterminate/);
    expect(body).toMatch(/pane missing after kill — CLI will physically relaunch/);
    // Ordering: error(exists) → warn(unknown) → info(missing).
    const errIdx = body.indexOf('logger.error');
    const warnIndeterminate = body.indexOf('kill outcome indeterminate');
    const infoMissing = body.indexOf('pane missing after kill');
    expect(errIdx).toBeGreaterThan(0);
    expect(warnIndeterminate).toBeGreaterThan(errIdx);
    expect(infoMissing).toBeGreaterThan(warnIndeterminate);
  });

  it('probe survival does NOT block the refork (stranding is worse than the guarded bug)', () => {
    // The helper only logs on a surviving pane — it never returns early in a way
    // that would skip forkWorker. requestSessionRestart always reaches forkWorker
    // after destroyLivePaneBeforeRestart regardless of probe outcome.
    const fn = workerPoolSource.indexOf('export function requestSessionRestart');
    const body = workerPoolSource.slice(fn, workerPoolSource.indexOf('\n}', fn) + 2);
    const destroy = body.indexOf('destroyLivePaneBeforeRestart(ds)');
    const fork = body.indexOf('forkWorker(ds');
    expect(destroy).toBeGreaterThan(0);
    expect(fork).toBeGreaterThan(destroy);
    // No conditional/throw between them that could skip the fork.
    const between = body.slice(destroy, fork);
    expect(between).not.toMatch(/\breturn\b|\bthrow\b|if\s*\(/);
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

// ─── P2: worker-side generation fence + defensive success receipt (wiring) ───

describe('P2 worker onTaskDone generation fence', () => {
  it('onTaskDone drops callbacks from a superseded backend generation', () => {
    const hook = workerSource.indexOf('backend.onTaskDone?.(()');
    expect(hook).toBeGreaterThanOrEqual(0);
    const body = workerSource.slice(hook, hook + 900);
    // Same fence pattern as onAgentStatus / onExit siblings.
    expect(body).toContain('if (backend !== observedBackend) return;');
    // The generation check must precede the markPromptReady() re-arm. Match the
    // actual call (with semicolon) so the prose "markPromptReady()" in the
    // rationale comment above the fence isn't mistaken for it.
    const fence = body.indexOf('if (backend !== observedBackend) return;');
    const mark = body.indexOf('markPromptReady();');
    expect(mark).toBeGreaterThan(fence);
  });

  it('all three async backend ready/exit callbacks in setupBackendHandlers carry the generation fence', () => {
    // Within setupBackendHandlers the herdr onAgentStatus, the riff onTaskDone,
    // and the backend onExit all guard on `backend !== observedBackend` so a
    // superseded generation can neither re-arm prompt-ready nor tear down the
    // replacement. Anchored on the setupBackendHandlers occurrences (the adopt
    // observe-paths use a different, non-fenced onExit by design).
    const setup = workerSource.indexOf('const observedBackend = backend;');
    const handlersStart = workerSource.indexOf(
      'observedBackend.onData((data) =>',
      setup,
    );
    expect(setup).toBeGreaterThanOrEqual(0);
    expect(handlersStart).toBeGreaterThan(setup);
    const region = workerSource.slice(setup, setup + 6000);

    const agentStatus = region.indexOf('.onAgentStatus((status)');
    const taskDone = region.indexOf('backend.onTaskDone?.(()');
    const onExit = region.indexOf('backend.onExit((code, signal)');
    expect(agentStatus, 'onAgentStatus').toBeGreaterThanOrEqual(0);
    expect(taskDone, 'onTaskDone').toBeGreaterThanOrEqual(0);
    expect(onExit, 'onExit').toBeGreaterThanOrEqual(0);

    for (const [name, start] of [
      ['onAgentStatus', agentStatus],
      ['onTaskDone', taskDone],
      ['onExit', onExit],
    ] as const) {
      expect(region.slice(start, start + 700), name)
        .toContain('backend !== observedBackend');
    }
  });

  it('markPromptReady defers the restart success receipt when no backend is installed', () => {
    const guard = workerSource.indexOf('if (activeRestartAttemptId) {');
    expect(guard).toBeGreaterThanOrEqual(0);
    const body = workerSource.slice(guard, guard + 700);
    // Success is only reported behind a live-backend check; otherwise the
    // attempt id is preserved for the real replacement / coordinator timeout.
    const backendCheck = body.indexOf('if (backend) {');
    const succeeded = body.indexOf("status: 'succeeded'");
    expect(backendCheck).toBeGreaterThan(0);
    expect(succeeded).toBeGreaterThan(backendCheck);
  });
});
