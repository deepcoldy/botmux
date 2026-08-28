/**
 * Unit tests for RiffBackend — write serialization (no duplicate task-execute
 * on rapid writes) and sandbox access-URL handling (directAccessUrl preference
 * + accessUrl origin rewrite onto the configured baseUrl).
 *
 * Run:  pnpm vitest run test/riff-backend.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { RiffBackend, parseRiffRepoName, deriveRiffRepoFromWorkingDir, deriveRiffReposFromDirs } from '../src/adapters/backend/riff-backend.js';

const BASE = 'https://riff-boe.example.com';

type FetchCall = { url: string; init?: RequestInit };

/** Never-ending SSE body so streamTask stays pending without emitting events. */
function pendingSseResponse(): Response {
  const body = new ReadableStream<Uint8Array>({ start() { /* never pushes */ } });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function taskResponse(id: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ success: true, data: { id, status: 'running', ...extra } });
}

describe('RiffBackend', () => {
  let calls: FetchCall[];
  let resolvers: Array<(r: Response) => void>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    calls = [];
    resolvers = [];
    fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u.includes('/api2/task-stream')) return pendingSseResponse();
      if (u.includes('/api/task-detail')) {
        return Response.json({ success: true, data: { task: {} } });
      }
      // task-cancel：即时成功（mock fetch 不接 AbortSignal，挂起会假死测试）
      if (u.includes('/api/task-cancel')) {
        return Response.json({ success: true, data: {} });
      }
      // task-execute / task-follow-up: resolve manually so tests control timing
      return new Promise<Response>((resolve) => { resolvers.push(resolve); });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeBackend(config: Record<string, unknown> = {}): RiffBackend {
    return new RiffBackend({ baseUrl: BASE, jwt: 'test-jwt', ...config } as any, 'session-1');
  }

  const flush = () => new Promise((r) => setTimeout(r, 0));

  describe('write serialization', () => {
    it('queues a second write until the first task-execute returns (no duplicate createTask)', async () => {
      const be = makeBackend();
      be.spawn('', [], {} as any);

      be.write('first message');
      be.write('second message');
      await flush();

      // Only ONE task-execute in flight — the second write must wait.
      const execCalls = () => calls.filter(c => c.url.includes('/api/task-execute'));
      const followCalls = () => calls.filter(c => c.url.includes('/api/task-follow-up'));
      expect(execCalls().length).toBe(1);
      expect(followCalls().length).toBe(0);

      // First task lands → second write becomes a follow-up, not a new task.
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      expect(execCalls().length).toBe(1);
      expect(followCalls().length).toBe(1);
      const followBody = JSON.parse(String(followCalls()[0]!.init?.body));
      expect(followBody.parentTaskId).toBe('task-1');
      expect(String(followBody.prompt)).toContain('second message');
    });

    it('routes the next message after task completion to follow-up (sandbox continuity)', async () => {
      const be = makeBackend({ injectStatusLines: false });
      be.spawn('', [], {} as any);
      be.write('first');
      await flush();
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      // Task completes — the next turn must still follow up on task-1, not
      // cold-boot a brand-new task/sandbox.
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-1');
      await flush(); await flush();

      be.write('second');
      await flush();
      resolvers.shift()!(taskResponse('task-2'));
      await flush();
      expect(calls.filter(c => c.url.includes('/api/task-execute')).length).toBe(1);
      const follow = calls.filter(c => c.url.includes('/api/task-follow-up'));
      expect(follow.length).toBe(1);
      expect(JSON.parse(String(follow[0]!.init?.body)).parentTaskId).toBe('task-1');
    });

    it('falls back to a fresh task after a follow-up failure', async () => {
      const be = makeBackend({ injectStatusLines: false });
      be.spawn('', [], {} as any);
      be.write('first');
      await flush();
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-1');
      await flush(); await flush();

      be.write('second');
      await flush();
      resolvers.shift()!(new Response('gone', { status: 410 }));
      await flush();
      // Lineage broken → next message starts a new task instead of failing forever.
      be.write('third');
      await flush();
      expect(calls.filter(c => c.url.includes('/api/task-execute')).length).toBe(2);
    });

    it('ignores a duplicate done event (no double turn-boundary)', async () => {
      const be = makeBackend({ injectStatusLines: false });
      const done = vi.fn();
      be.onTaskDone(done);
      (be as any).currentTaskId = 'task-1';
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-1');
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-1');
      await flush(); await flush();
      expect(done).toHaveBeenCalledTimes(1);
    });

    it('cross-turn duplicate done: A done → B write → A duplicate done must not fire mid-B', async () => {
      const be = makeBackend({ injectStatusLines: false });
      const done = vi.fn();
      be.onTaskDone(done);
      be.spawn('', [], {} as any);
      be.write('first');
      await flush();
      resolvers.shift()!(taskResponse('task-A'));
      await flush();
      // A completes → boundary fires once, queued follow-up becomes task B.
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-A');
      await flush(); await flush();
      expect(done).toHaveBeenCalledTimes(1);
      be.write('second');
      await flush();
      resolvers.shift()!(taskResponse('task-B'));
      await flush();
      expect((be as any).taskDone).toBe(false); // B is running
      // A's duplicate done arrives ~500ms later (observed live): must be inert.
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-A');
      await flush(); await flush();
      expect(done).toHaveBeenCalledTimes(1);
      expect((be as any).taskDone).toBe(false); // B must not be marked done
      // B's own done still fires the boundary normally.
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-B');
      await flush(); await flush();
      expect(done).toHaveBeenCalledTimes(2);
    });
  });

  describe('graceful shutdown detach drain', () => {
    it('fences new writes, waits for a slow create, returns its exact id, and never cancels or streams it', async () => {
      const be = makeBackend({ injectStatusLines: false });
      const ids: Array<string | null> = [];
      be.onTaskId(id => ids.push(id));
      be.spawn('', [], {} as any);
      be.write('opening turn');
      await flush();

      let settled = false;
      const prepare = be.prepareShutdownDetach().then(result => {
        settled = true;
        return result;
      });
      await flush();
      expect(settled).toBe(false);

      // This write arrived after the shutdown fence and must not extend the
      // drain or create a new remote task.
      be.write('must be rejected');
      resolvers.shift()!(taskResponse('task-shutdown-late'));
      const result = await prepare;

      expect(result).toEqual({ ok: true, taskId: 'task-shutdown-late' });
      expect(ids).toEqual(['task-shutdown-late']);
      expect(calls.filter(c => c.url.includes('/api/task-execute')).length).toBe(1);
      expect(calls.filter(c => c.url.includes('/api/task-follow-up')).length).toBe(0);
      expect(calls.filter(c => c.url.includes('/api/task-cancel')).length).toBe(0);
      expect(calls.filter(c => c.url.includes('/api2/task-stream')).length).toBe(0);
    });

    it('drains two writes accepted before the fence and reports the newest child lineage', async () => {
      const be = makeBackend({ injectStatusLines: false });
      const ids: Array<string | null> = [];
      be.onTaskId(id => ids.push(id));
      be.write('first accepted write');
      be.write('second accepted write');
      await flush();

      const prepare = be.prepareShutdownDetach();
      resolvers.shift()!(taskResponse('task-drain-1'));
      await flush();
      const follow = calls.find(c => c.url.includes('/api/task-follow-up'));
      expect(follow).toBeDefined();
      expect(JSON.parse(String(follow!.init?.body)).parentTaskId).toBe('task-drain-1');
      resolvers.shift()!(taskResponse('task-drain-2'));

      await expect(prepare).resolves.toEqual({ ok: true, taskId: 'task-drain-2' });
      expect(ids).toEqual(['task-drain-1', 'task-drain-2']);
      expect(calls.filter(c => c.url.includes('/api/task-cancel')).length).toBe(0);
      expect(calls.filter(c => c.url.includes('/api2/task-stream')).length).toBe(0);
    });

    it('abort restores admission and reconnects the exact drained task', async () => {
      const be = makeBackend({ injectStatusLines: false });
      be.write('opening turn');
      await flush();
      const prepare = be.prepareShutdownDetach();
      resolvers.shift()!(taskResponse('task-abort-resume'));
      await expect(prepare).resolves.toEqual({ ok: true, taskId: 'task-abort-resume' });
      expect(calls.filter(c => c.url.includes('/api2/task-stream')).length).toBe(0);

      await be.abortShutdownDetach();
      await flush();
      expect(calls.filter(c => c.url.includes('/api2/task-stream?id=task-abort-resume')).length).toBe(1);

      be.write('follow-up after aborted shutdown');
      await flush();
      expect(calls.filter(c => c.url.includes('/api/task-follow-up')).length).toBe(1);
    });

    it('abort invalidates a still-draining prepare and restores admission only after it settles', async () => {
      const be = makeBackend({ injectStatusLines: false });
      be.write('accepted before shutdown');
      await flush();

      const prepare = be.prepareShutdownDetach();
      let abortSettled = false;
      const abort = be.abortShutdownDetach().then(result => {
        abortSettled = true;
        return result;
      });
      await flush();
      expect(abortSettled).toBe(false);
      expect((be as any).shutdownDetaching).toBe(true);

      resolvers.shift()!(taskResponse('task-abort-during-drain'));
      await expect(prepare).resolves.toEqual({
        ok: false,
        taskId: 'task-abort-during-drain',
        error: 'shutdown_detach_aborted',
      });
      await expect(abort).resolves.toEqual({ ok: true, taskId: 'task-abort-during-drain' });
      expect((be as any).shutdownDetachPrepared).toBe(false);
      expect((be as any).shutdownDetaching).toBe(false);
      expect(calls.filter(c => c.url.includes('/api/task-cancel'))).toHaveLength(0);
    });
  });

  describe('SSE clean EOF without done (finding C)', () => {
    it('treats a clean EOF with no done event as a stream failure — session must not stay busy forever', async () => {
      const be = makeBackend({ injectStatusLines: false });
      (be as any).maxReconnectAttempts = 0; // skip the timed retries in test
      const done = vi.fn();
      be.onTaskDone(done);
      // task-stream responds 200 then closes immediately WITHOUT a done event.
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        calls.push({ url: u });
        if (u.includes('/api2/task-stream')) {
          return new Response(new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), { status: 200 });
        }
        if (u.includes('/api/task-detail')) return Response.json({ success: true, data: { task: {} } });
        return taskResponse('task-1');
      });
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      await flush();
      // Reconnect budget exhausted (0) → emitError → turn boundary fires so
      // queued follow-ups are not stuck.
      expect(done).toHaveBeenCalledTimes(1);
    });

    it('CRLF-framed done event is parsed (proxy-normalized SSE)', async () => {
      const be = makeBackend({ injectStatusLines: false });
      (be as any).maxReconnectAttempts = 0;
      const done = vi.fn();
      be.onTaskDone(done);
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        calls.push({ url: u });
        if (u.includes('/api2/task-stream')) {
          const body = 'event:done\r\ndata:{"status":"completed"}\r\n\r\n';
          return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }), { status: 200 });
        }
        if (u.includes('/api/task-detail')) return Response.json({ success: true, data: { task: {} } });
        return taskResponse('task-1');
      });
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      await flush();
      expect(done).toHaveBeenCalledTimes(1); // CRLF 分帧被归一化，done 正常触发（无 EOF 误判）
    });

    it('EOF-tail done (no trailing blank line) is still processed', async () => {
      const be = makeBackend({ injectStatusLines: false });
      (be as any).maxReconnectAttempts = 0;
      const done = vi.fn();
      be.onTaskDone(done);
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        calls.push({ url: u });
        if (u.includes('/api2/task-stream')) {
          const body = 'event:done\ndata:{"status":"completed"}';  // 无结尾空行
          return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }), { status: 200 });
        }
        if (u.includes('/api/task-detail')) return Response.json({ success: true, data: { task: {} } });
        return taskResponse('task-1');
      });
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      await flush();
      expect(done).toHaveBeenCalledTimes(1);
    });

    it('clean EOF AFTER done is normal shutdown — no error, no second boundary', async () => {
      const be = makeBackend({ injectStatusLines: false });
      (be as any).maxReconnectAttempts = 0;
      const done = vi.fn();
      be.onTaskDone(done);
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        calls.push({ url: u });
        if (u.includes('/api2/task-stream')) {
          const body = 'event:done\ndata:{"status":"completed"}\n\n';
          return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }), { status: 200 });
        }
        if (u.includes('/api/task-detail')) return Response.json({ success: true, data: { task: {} } });
        return taskResponse('task-1');
      });
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      await flush();
      expect(done).toHaveBeenCalledTimes(1); // done event only — EOF added nothing
    });
  });

  describe('SSE reconnect budget refund keyed on connection lifetime (~183s connection cap)', () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // These tests intentionally leave reconnect loops in flight (pending/looping
    // streams). Track every backend and kill() it after each test so a leaked
    // loop can't keep incrementing the NEXT test's shared fetchMock counter
    // (kill sets `killed`, which makes the streamTask catch bail).
    let liveBackends: RiffBackend[] = [];
    const track = (be: RiffBackend) => { liveBackends.push(be); return be; };
    afterEach(() => { liveBackends.forEach(b => b.kill()); liveBackends = []; });
    // Healthy long connection: emits init(running), STAYS OPEN past the health
    // threshold, then cleanly EOFs — models a task-stream connection severed by
    // the ~183s proxy cap. The delay before close is what makes it "healthy".
    const healthyThenEof = (openMs: number, status = 'running') =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(c) {
            c.enqueue(new TextEncoder().encode(`event:init\ndata:{"status":"${status}"}\n\n`));
            await sleep(openMs);
            c.close();
          },
        }),
        { status: 200 },
      );
    // Pathological: connects, emits init(running), then EOFs INSTANTLY (sub-
    // threshold lifetime) — the stale-running-orphan hot loop. Must NOT refund.
    const initThenInstantEof = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('event:init\ndata:{"status":"running"}\n\n'));
            c.close();
          },
        }),
        { status: 200 },
      );
    // Dead endpoint: connects 200 then EOFs immediately with nothing.
    const bareEof = () =>
      new Response(new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), { status: 200 });
    // init replaying a TERMINAL status (task finished while a prior connection
    // was dead — its `done` was lost with the closed stream).
    const initTerminalThenEof = (status = 'completed') =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(`event:init\ndata:{"status":"${status}"}\n\n`));
            c.close();
          },
        }),
        { status: 200 },
      );

    it('a connection that lived past the health threshold refunds the budget → many ~183s caps never falsely fail', async () => {
      const be = track(makeBackend({ injectStatusLines: false }));
      (be as any).reconnectBaseDelayMs = 0; // collapse backoff for a fast test
      (be as any).reconnectMaxDelayMs = 0;
      (be as any).reconnectHealthyConnMs = 15; // healthy = lived ≥15ms (test scale)
      const done = vi.fn();
      const errored = vi.fn();
      be.onTaskDone(done);
      be.onData((d: string) => { if (d.includes('重连失败')) errored(); });

      // 12 consecutive healthy caps — WAY past the 6-attempt budget. If a
      // healthy-lived break did not refund, this would emitError long before 12.
      let streamHits = 0;
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        calls.push({ url: u });
        if (u.includes('/api2/task-stream')) {
          streamHits++;
          return streamHits <= 12 ? healthyThenEof(80) : pendingSseResponse();
        }
        if (u.includes('/api/task-detail')) return Response.json({ success: true, data: { task: {} } });
        return taskResponse('task-1');
      });
      be.spawn('', [], {} as any);
      be.write('long runner task');
      // Real time must elapse for the 80ms-open connections — poll on progress.
      for (let i = 0; i < 400 && streamHits <= 8; i++) await sleep(10);
      for (let i = 0; i < 20; i++) await flush();

      expect(streamHits).toBeGreaterThan(6);       // survived past the raw budget
      expect(errored).not.toHaveBeenCalled();       // never surfaced 重连失败
      expect(done).not.toHaveBeenCalled();          // still running
      // Healthy break refunds to 0 then increments to 1 — settles at 1, never
      // accumulates toward 6 however many caps occur. That is the fix.
      expect((be as any).reconnectAttempts).toBeLessThanOrEqual(1);
    });

    it('a stale-running-orphan hot loop (init then INSTANT EOF, sub-threshold) exhausts the budget — the reopened-infinite-retry-hole guard', async () => {
      const be = track(makeBackend({ injectStatusLines: false }));
      (be as any).reconnectBaseDelayMs = 0;
      (be as any).reconnectMaxDelayMs = 0;
      (be as any).reconnectHealthyConnMs = 10_000; // instant EOF (few ms) << 10s → never refunds
      const done = vi.fn();
      const errored = vi.fn();
      be.onTaskDone(done);
      be.onData((d: string) => { if (d.includes('重连失败')) errored(); });

      // The critical regression case: task is running (init=running) so the
      // terminal-status completion path never fires, but the connection EOFs
      // instantly every time. Keying refund on init-receipt would loop forever;
      // keying on lifetime lets the budget exhaust and bail.
      let streamHits = 0;
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        calls.push({ url: u });
        if (u.includes('/api2/task-stream')) { streamHits++; return initThenInstantEof(); }
        if (u.includes('/api/task-detail')) return Response.json({ success: true, data: { task: {} } });
        return taskResponse('task-1');
      });
      be.spawn('', [], {} as any);
      be.write('stale-running orphan');
      for (let i = 0; i < 60; i++) await flush();

      // 1 initial + 6 reconnects = 7, then bail. BOUNDED — no infinite hot loop.
      expect(streamHits).toBe(7);
      expect(errored).toHaveBeenCalledTimes(1);
      expect(done).toHaveBeenCalledTimes(1); // emitError fires the turn boundary
    });

    it('a reconnect whose init replays a TERMINAL status completes the turn cleanly — no error (the false-positive being fixed)', async () => {
      const be = track(makeBackend({ injectStatusLines: false }));
      (be as any).reconnectBaseDelayMs = 0;
      (be as any).reconnectMaxDelayMs = 0;
      (be as any).reconnectHealthyConnMs = 20;
      const done = vi.fn();
      const errored = vi.fn();
      be.onTaskDone(done);
      be.onData((d: string) => { if (d.includes('重连失败')) errored(); });

      // First connection: healthy-lived running then EOF (the ~183s cap).
      // Reconnect: init replays completed (task finished during the dead window).
      // Terminal completion must fire even though the reconnect's own connection
      // is short-lived — completion does NOT depend on the lifetime gate.
      let streamHits = 0;
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        calls.push({ url: u });
        if (u.includes('/api2/task-stream')) {
          streamHits++;
          return streamHits === 1 ? healthyThenEof(40) : initTerminalThenEof('completed');
        }
        if (u.includes('/api/task-detail')) return Response.json({ success: true, data: { task: { output: 'final result' } } });
        return taskResponse('task-1');
      });
      be.spawn('', [], {} as any);
      be.write('task that completes during the dead window');
      for (let i = 0; i < 200 && streamHits < 2; i++) await sleep(10);
      for (let i = 0; i < 20; i++) await flush();

      expect(errored).not.toHaveBeenCalled();      // the whole point: no false 重连失败
      expect(done).toHaveBeenCalledTimes(1);        // completion fired exactly once
      expect((be as any).taskDone).toBe(true);
    });

    it('a dead endpoint (connect→instant EOF, sub-threshold) still exhausts the budget and fails — no infinite retry', async () => {
      const be = track(makeBackend({ injectStatusLines: false }));
      (be as any).reconnectBaseDelayMs = 0;
      (be as any).reconnectMaxDelayMs = 0;
      (be as any).reconnectHealthyConnMs = 10_000; // instant EOF (few ms) << 10s → never refunds
      const done = vi.fn();
      const errored = vi.fn();
      be.onTaskDone(done);
      be.onData((d: string) => { if (d.includes('重连失败')) errored(); });

      let streamHits = 0;
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        calls.push({ url: u });
        if (u.includes('/api2/task-stream')) { streamHits++; return bareEof(); }
        if (u.includes('/api/task-detail')) return Response.json({ success: true, data: { task: {} } });
        return taskResponse('task-1');
      });
      be.spawn('', [], {} as any);
      be.write('doomed task');
      for (let i = 0; i < 40; i++) await flush();

      // 1 initial + 6 reconnects = 7 stream attempts, then bail. Crucially BOUNDED.
      expect(streamHits).toBe(7);
      expect(errored).toHaveBeenCalledTimes(1);
      expect(done).toHaveBeenCalledTimes(1); // emitError fires the turn boundary
    });

    // The connection-never-established path is DISTINCT from "connect then EOF":
    // fetch throws / !resp.ok bail BEFORE connectionStartedAtMs is stamped, so it
    // stays at its sentinel. The lifetime gate must treat "never stamped" as
    // NOT-healthy (no refund), else a permanent 404 (task GC'd) or 401 (jwt dead)
    // would compute a bogus huge lifetime, refund forever, and hot-loop a request
    // storm with no idle backstop. These lock that path to bounded early-stop.
    it('a permanent !resp.ok (404 task-gone / 401) never refunds → bounded early-stop, no request storm', async () => {
      const be = track(makeBackend({ injectStatusLines: false }));
      (be as any).reconnectBaseDelayMs = 0;
      (be as any).reconnectMaxDelayMs = 0;
      (be as any).reconnectHealthyConnMs = 10_000;
      const done = vi.fn();
      const errored = vi.fn();
      be.onTaskDone(done);
      be.onData((d: string) => { if (d.includes('重连失败')) errored(); });

      let streamHits = 0;
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        calls.push({ url: u });
        // task-stream returns 404 → !resp.ok → throws before the connection is
        // ever stamped (connectionStartedAtMs stays at its never-connected value).
        if (u.includes('/api2/task-stream')) { streamHits++; return new Response('gone', { status: 404 }); }
        if (u.includes('/api/task-detail')) return Response.json({ success: true, data: { task: {} } });
        return taskResponse('task-1');
      });
      be.spawn('', [], {} as any);
      be.write('task that was GC-ed');
      for (let i = 0; i < 40; i++) await flush();

      // Must be BOUNDED: 1 initial + 6 reconnects = 7, then emitError. A bogus
      // "healthy lifetime" from an unstamped clock would loop unbounded here.
      expect(streamHits).toBe(7);
      expect(errored).toHaveBeenCalledTimes(1);
      expect(done).toHaveBeenCalledTimes(1);
    });

    it('a fetch that throws (network error) before connecting never refunds → bounded early-stop', async () => {
      const be = track(makeBackend({ injectStatusLines: false }));
      (be as any).reconnectBaseDelayMs = 0;
      (be as any).reconnectMaxDelayMs = 0;
      (be as any).reconnectHealthyConnMs = 10_000;
      const done = vi.fn();
      const errored = vi.fn();
      be.onTaskDone(done);
      be.onData((d: string) => { if (d.includes('重连失败')) errored(); });

      let streamHits = 0;
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        calls.push({ url: u });
        if (u.includes('/api2/task-stream')) { streamHits++; throw new Error('ECONNREFUSED'); }
        if (u.includes('/api/task-detail')) return Response.json({ success: true, data: { task: {} } });
        return taskResponse('task-1');
      });
      be.spawn('', [], {} as any);
      be.write('unreachable endpoint');
      for (let i = 0; i < 40; i++) await flush();

      expect(streamHits).toBe(7);       // bounded — no infinite reconnect
      expect(errored).toHaveBeenCalledTimes(1);
      expect(done).toHaveBeenCalledTimes(1);
    });
  });

  describe('restart lineage resume (finding D)', () => {
    it('resumeParentTaskId makes the first write a follow-up on the persisted parent', async () => {
      const be = makeBackend({ resumeParentTaskId: 'task-old', injectStatusLines: false });
      const ids: string[] = [];
      be.onTaskId(id => ids.push(id));
      expect(ids).toEqual(['task-old']); // immediate replay for late subscribers
      be.spawn('', [], {} as any);
      be.write('after restart');
      await flush();
      expect(calls.filter(c => c.url.includes('/api/task-execute')).length).toBe(0);
      const follow = calls.filter(c => c.url.includes('/api/task-follow-up'));
      expect(follow.length).toBe(1);
      expect(JSON.parse(String(follow[0]!.init?.body)).parentTaskId).toBe('task-old');
      resolvers.shift()!(taskResponse('task-new'));
      await flush();
      expect(ids).toEqual(['task-old', 'task-new']); // new id announced for persistence
    });
  });

  describe('stdout log line separation (finding: app_server char-wall)', () => {
    // riff ships each stdout log line BARE (no trailing newline). The relay must
    // re-add a separator per log event, else consecutive events concatenate into
    // one unreadable "wall" — the exact symptom seen with codex_app_server, whose
    // stdout logs are one JSON.stringify(event) per line (thread.started, etc).
    it('separates consecutive stdout log events instead of concatenating them', () => {
      const be = makeBackend({ injectStatusLines: false });
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      (be as any).currentTaskId = 'task-1';
      // Use content-bearing lines (not thread.started/turn.started lifecycle
      // markers — those are now suppressed by the route-B noise backstop). The
      // char-wall invariant under test is: consecutive bare stdout lines get a
      // separator, never butt together into `}{`.
      (be as any).handleSseEvent('event:log\ndata:{"group":"stdout","text":"{\\"type\\":\\"item.completed\\",\\"n\\":1}"}', 'task-1');
      (be as any).handleSseEvent('event:log\ndata:{"group":"stdout","text":"{\\"type\\":\\"item.completed\\",\\"n\\":2}"}', 'task-1');
      const out = lines.join('');
      // The two events must not butt together (…}{… would be the wall).
      expect(out).not.toContain('}{');
      // Each event renders on its own line (emitText normalizes \n → \r\n).
      expect(out).toContain('{"type":"item.completed","n":1}\r\n');
      expect(out).toContain('{"type":"item.completed","n":2}\r\n');
    });

    it('does not double-space a stdout log (bare line + exactly one separator)', () => {
      const be = makeBackend({ injectStatusLines: false });
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      (be as any).currentTaskId = 'task-1';
      (be as any).handleSseEvent('event:log\ndata:{"group":"stdout","text":"hello"}', 'task-1');
      expect(lines.join('')).toBe('hello\r\n');
    });

    it('leaves the output/chunk path raw (chunks may be partial lines)', () => {
      const be = makeBackend({ injectStatusLines: false });
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      (be as any).currentTaskId = 'task-1';
      (be as any).handleSseEvent('event:output\ndata:{"chunk":"par"}', 'task-1');
      (be as any).handleSseEvent('event:output\ndata:{"chunk":"tial"}', 'task-1');
      // No synthetic newline injected between chunks — they join seamlessly.
      expect(lines.join('')).toBe('partial');
    });
  });

  describe('route-B display projection (feat/riff-agent-log-display)', () => {
    // riff attaches a per-line `display: TaskLogDisplay` on stdout log events —
    // a human-readable projection of a codex app-server event. We render a
    // timeline row from it instead of the raw JSON line.
    const logEvt = (payload: Record<string, unknown>) =>
      `event:log\ndata:${JSON.stringify(payload)}`;

    it('renders an agent_message display as a [回答] row, not raw JSON', () => {
      const be = makeBackend({ injectStatusLines: false });
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      (be as any).currentTaskId = 'task-1';
      (be as any).handleSseEvent(
        logEvt({ group: 'stdout', text: '{"type":"item.completed",...}', display: { kind: 'message', title: '回答', text: 'Hello there' } }),
        'task-1',
      );
      const out = lines.join('');
      expect(out).toContain('[回答] Hello there');
      // The raw JSON `text` is NOT emitted when a display projection exists.
      expect(out).not.toContain('item.completed');
    });

    it('renders a completed command as [命令] <cmd> (exit 0) in green (no output case)', () => {
      const be = makeBackend({ injectStatusLines: false });
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      (be as any).currentTaskId = 'task-1';
      // A command with no captured output: riff omits `text`, so header only.
      (be as any).handleSseEvent(
        logEvt({ group: 'stdout', text: '{}', display: { kind: 'command', title: '命令执行', command: 'ls -la', status: 'completed', exitCode: 0, summary: '命令执行完成' } }),
        'task-1',
      );
      const out = lines.join('');
      expect(out).toContain('[命令执行] ls -la (exit 0)');
      expect(out).toContain('\x1b[32m'); // green for exit 0
      // MUST NOT print `summary` ('命令执行完成') as a fake output line.
      expect(out).not.toContain('命令执行完成');
    });

    it('renders captured command output (riff folds stdout into display.text) below the header', () => {
      const be = makeBackend({ injectStatusLines: false });
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      (be as any).currentTaskId = 'task-1';
      // riff's collapseCommandOutputIntoPrimary puts the real stdout in `text`.
      (be as any).handleSseEvent(
        logEvt({ group: 'stdout', text: '{}', display: { kind: 'command', title: '命令执行', command: 'echo hello', status: 'completed', exitCode: 0, summary: '命令执行完成', text: 'hello' } }),
        'task-1',
      );
      const out = lines.join('');
      expect(out).toContain('[命令执行] echo hello (exit 0)');
      expect(out).toContain('hello'); // the real output IS rendered
      expect(out).not.toContain('命令执行完成'); // summary still never rendered
    });

    it('renders multi-line command output verbatim with CRLF normalization', () => {
      const be = makeBackend({ injectStatusLines: false });
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      (be as any).currentTaskId = 'task-1';
      (be as any).handleSseEvent(
        logEvt({ group: 'stdout', text: '{}', display: { kind: 'command', title: '命令', command: 'ls', status: 'completed', exitCode: 0, text: 'file1\nfile2' } }),
        'task-1',
      );
      const out = lines.join('');
      expect(out).toContain('file1\r\nfile2');
      expect(out).not.toMatch(/[^\r]\n/); // no bare LF (would stair-step)
    });

    it('renders a failed command in red with its exit code', () => {
      const be = makeBackend({ injectStatusLines: false });
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      (be as any).currentTaskId = 'task-1';
      (be as any).handleSseEvent(
        logEvt({ group: 'stdout', text: '{}', display: { kind: 'command', title: '命令', command: 'false', status: 'failed', exitCode: 2, summary: '命令执行失败' } }),
        'task-1',
      );
      const out = lines.join('');
      expect(out).toContain('[命令] false (exit 2)');
      expect(out).toContain('\x1b[31m'); // red
      expect(out).not.toContain('命令执行失败'); // summary not printed as output
    });

    it('does NOT color a still-running command green (no exit code yet)', () => {
      const be = makeBackend({ injectStatusLines: false });
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      (be as any).currentTaskId = 'task-1';
      (be as any).handleSseEvent(
        logEvt({ group: 'stdout', text: '{}', display: { kind: 'command', title: '命令', command: 'sleep 5', status: 'running' } }),
        'task-1',
      );
      const out = lines.join('');
      expect(out).toContain('[命令] sleep 5');
      expect(out).not.toContain('(exit'); // no exit code segment while running
      expect(out).not.toContain('\x1b[32m'); // NOT green while running
    });

    it('dims reasoning/usage rows (actual ANSI dim, not a no-op)', () => {
      const be = makeBackend({ injectStatusLines: false });
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      (be as any).currentTaskId = 'task-1';
      (be as any).handleSseEvent(
        logEvt({ group: 'stdout', text: '{}', display: { kind: 'reasoning', title: '思路', text: 'thinking...' } }),
        'task-1',
      );
      const out = lines.join('');
      expect(out).toContain('[思路] thinking...');
      expect(out).toContain('\x1b[2m'); // faint
    });

    it('does not double-space consecutive display rows', () => {
      const be = makeBackend({ injectStatusLines: false });
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      (be as any).currentTaskId = 'task-1';
      (be as any).handleSseEvent(logEvt({ group: 'stdout', text: '{}', display: { kind: 'message', title: '回答', text: 'A' } }), 'task-1');
      (be as any).handleSseEvent(logEvt({ group: 'stdout', text: '{}', display: { kind: 'message', title: '回答', text: 'B' } }), 'task-1');
      const out = lines.join('');
      // No blank line between the two rows: no CRLFCRLF anywhere in the stream.
      expect(out).not.toContain('\r\n\r\n');
    });

    it('normalizes internal newlines in a multi-line display body (no stair-step)', () => {
      const be = makeBackend({ injectStatusLines: false });
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      (be as any).currentTaskId = 'task-1';
      (be as any).handleSseEvent(
        logEvt({ group: 'stdout', text: '{}', display: { kind: 'tool', title: '工具调用', text: 'line1\nline2' } }),
        'task-1',
      );
      const out = lines.join('');
      // Every newline in the emitted row is a CRLF — no bare \n left to stair-step.
      expect(out).not.toMatch(/[^\r]\n/);
      expect(out).toContain('line1\r\nline2');
    });

    it('falls back to raw line (with separator) when display is absent (#805)', () => {
      const be = makeBackend({ injectStatusLines: false });
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      (be as any).currentTaskId = 'task-1';
      (be as any).handleSseEvent(logEvt({ group: 'stdout', text: 'plain shell output' }), 'task-1');
      expect(lines.join('')).toBe('plain shell output\r\n');
    });

    it('defensively suppresses a bare codex noise line that slipped through un-projected', () => {
      const be = makeBackend({ injectStatusLines: false });
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      (be as any).currentTaskId = 'task-1';
      // No display + a bare lifecycle event = riff would normally have downgraded
      // it to channel:'raw'; if it slips through, we must not re-wall.
      (be as any).handleSseEvent(logEvt({ group: 'stdout', text: '{"type":"thread.started","thread_id":"t1"}' }), 'task-1');
      expect(lines.join('')).toBe('');
    });

    it('suppresses response.completed / response.done noise (kept in sync with riff)', () => {
      const be = makeBackend({ injectStatusLines: false });
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      (be as any).currentTaskId = 'task-1';
      (be as any).handleSseEvent(logEvt({ group: 'stdout', text: '{"type":"response.completed"}' }), 'task-1');
      (be as any).handleSseEvent(logEvt({ group: 'stdout', text: '{"type":"response.done"}' }), 'task-1');
      expect(lines.join('')).toBe('');
    });

    it('does NOT suppress plain output that merely contains braces', () => {
      const be = makeBackend({ injectStatusLines: false });
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      (be as any).currentTaskId = 'task-1';
      (be as any).handleSseEvent(logEvt({ group: 'stdout', text: '{"result": 42} done' }), 'task-1');
      // Not a bare codex lifecycle event → passes through as normal output.
      expect(lines.join('')).toBe('{"result": 42} done\r\n');
    });
  });

  describe('task isolation (finding F)', () => {
    it('stale stream events are inert once a newer task is current', () => {
      const be = makeBackend({ injectStatusLines: false });
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      (be as any).currentTaskId = 'task-B';
      (be as any).handleSseEvent('event:output\ndata:{"chunk":"OLD-A-OUTPUT"}', 'task-A');
      expect(lines.join('')).not.toContain('OLD-A-OUTPUT');
    });

    it("A's late task-detail must not overwrite B's sandbox URL", async () => {
      const be = makeBackend();
      const urls: string[] = [];
      be.onAccessUrl(u => urls.push(u));
      let resolveDetail!: (r: Response) => void;
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        calls.push({ url: u });
        if (u.includes('/api/task-detail')) return new Promise<Response>((r) => { resolveDetail = r; });
        return pendingSseResponse();
      });
      (be as any).currentTaskId = 'task-A';
      const p = (be as any).fetchDirectAccessUrl('task-A');
      // getJwt is now async, so the task-detail fetch (which assigns resolveDetail)
      // only fires after a microtask. Flush before driving the response.
      await flush();
      (be as any).currentTaskId = 'task-B';
      resolveDetail(Response.json({ success: true, data: { task: { directAccessUrl: 'https://old-a.example/' } } }));
      await p;
      expect(urls).not.toContain('https://old-a.example/');
    });
  });

  describe('completedTaskIds bounded eviction (finding E)', () => {
    it('never evicts the just-completed task — its duplicate done stays inert past 64 turns', async () => {
      const be = makeBackend({ injectStatusLines: false });
      const done = vi.fn();
      be.onTaskDone(done);
      for (let i = 1; i <= 70; i++) {
        (be as any).currentTaskId = `task-${i}`;
        (be as any).taskDone = false;
        (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', `task-${i}`);
      }
      await flush(); await flush();
      expect(done).toHaveBeenCalledTimes(70);
      // 第 70 轮的 duplicate done（~500ms 后到达）必须仍被吞掉
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-70');
      await flush(); await flush();
      expect(done).toHaveBeenCalledTimes(70);
      expect(((be as any).completedTaskIds as Set<string>).size).toBeLessThanOrEqual(64);
    });
  });

  describe('onTaskDone turn boundary', () => {
    it('fires when the done SSE event arrives', async () => {
      const be = makeBackend({ injectStatusLines: false });
      const done = vi.fn();
      be.onTaskDone(done);
      (be as any).currentTaskId = 'task-1';
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed","exitCode":0}', 'task-1');
      await flush(); await flush();
      expect(done).toHaveBeenCalledTimes(1);
      expect((be as any).taskDone).toBe(true);
    });

    it('fires when task creation fails, so queued follow-ups are not stuck', async () => {
      const be = makeBackend();
      const done = vi.fn();
      be.onTaskDone(done);
      fetchMock.mockImplementation(async () => { throw new Error('network down'); });
      be.write('hello');
      await flush();
      expect(done).toHaveBeenCalledTimes(1);
    });
  });

  describe('JWT resolved after attachment prep (safety-window sampling point)', () => {
    it('reads the JWT AFTER slow attachment reads, right before fetch', async () => {
      const be = makeBackend({ injectStatusLines: false });
      be.spawn('', [], {} as any);

      const order: string[] = [];
      // Slow attachment read: records its ordering and yields to the event loop.
      (be as any).readFileAsBlob = async (_p: string) => {
        order.push('readFileAsBlob');
        await new Promise((r) => setTimeout(r, 5));
        return new Blob(['x']);
      };
      // getJwt must be sampled AFTER the attachment prep so the safety-window
      // freshness check reflects the token that actually goes on the wire.
      const realGetJwt = (be as any).getJwt.bind(be);
      (be as any).getJwt = () => { order.push('getJwt'); return realGetJwt(); };

      be.write('hello <attachments><file path="/tmp/a.bin" name="a.bin"/></attachments>');
      // The write runs through the async writeChain, then a 5ms attachment read,
      // then fetch — give it enough turns to reach the (manually-resolved) fetch.
      for (let i = 0; i < 6; i++) await flush();
      await new Promise((r) => setTimeout(r, 10));
      for (let i = 0; i < 4; i++) await flush();
      resolvers.shift()?.(taskResponse('task-1'));
      await flush();

      // The upload actually carried the JWT header…
      const exec = calls.find((c) => c.url.includes('/api/task-execute'));
      expect(exec, `no task-execute; calls=${calls.map((c) => c.url).join(',')}; order=${JSON.stringify(order)}`).toBeTruthy();
      expect((exec!.init?.headers as any)?.['x-jwt-token']).toBe('test-jwt');
      // …and the create-path JWT was sampled AFTER the attachment read (a later
      // getJwt from the SSE stream connection may follow — we only require that
      // the FIRST getJwt, the one on the create request, comes after the read).
      const firstRead = order.indexOf('readFileAsBlob');
      const firstJwt = order.indexOf('getJwt');
      expect(firstRead).toBeGreaterThanOrEqual(0);
      expect(firstJwt).toBeGreaterThan(firstRead);
    });
  });

  describe('agent hardcode + reasoning effort', () => {
    it('always sends agent=codex, even when legacy config still says aiden', async () => {
      const be = makeBackend({ injectStatusLines: false, agent: 'aiden' });
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      const exec = calls.find(c => c.url.includes('/api/task-execute'))!;
      expect(JSON.parse(String(exec.init?.body)).config.agent).toBe('codex');
    });

    it('passes a valid reasoningEffort through and drops invalid/empty ones', async () => {
      for (const [effort, expected] of [['xhigh', 'xhigh'], ['bogus', undefined], [undefined, undefined]] as const) {
        calls.length = 0; resolvers.length = 0;
        const be = makeBackend({ injectStatusLines: false, reasoningEffort: effort });
        be.spawn('', [], {} as any);
        be.write('hi');
        await flush();
        resolvers.shift()!(taskResponse('task-1'));
        await flush();
        const exec = calls.find(c => c.url.includes('/api/task-execute'))!;
        expect(JSON.parse(String(exec.init?.body)).config.reasoningEffort).toBe(expected);
      }
    });
  });

  describe('sandbox cluster', () => {
    it('sends the selected cluster as the task-execute top-level field', async () => {
      const be = makeBackend({ injectStatusLines: false, sandboxCluster: 'cn' });
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      const exec = calls.find(c => c.url.includes('/api/task-execute'))!;
      const body = JSON.parse(String(exec.init?.body));
      expect(body.sandboxCluster).toBe('cn');
      expect(body.config.sandboxCluster).toBeUndefined();
    });

    it('sends boe when the cluster is not configured', async () => {
      const be = makeBackend({ injectStatusLines: false });
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      const exec = calls.find(c => c.url.includes('/api/task-execute'))!;
      expect(JSON.parse(String(exec.init?.body)).sandboxCluster).toBe('boe');
    });
  });

  describe('repo reuse (复用本地仓库+分支)', () => {
    it('parseRiffRepoName normalizes git specs to group/repo (host-agnostic; registry validation is server-side)', () => {
      expect(parseRiffRepoName('git@git.example.com:webinfra/agent-monorepo.git')).toBe('webinfra/agent-monorepo');
      expect(parseRiffRepoName('https://git.example.com/webinfra/agent-monorepo.git')).toBe('webinfra/agent-monorepo');
      expect(parseRiffRepoName('https://git.example.com/webinfra/agent-monorepo/')).toBe('webinfra/agent-monorepo');
      expect(parseRiffRepoName('webinfra/agent-monorepo')).toBe('webinfra/agent-monorepo');
      // Host is not inspected — any git host parses to group/repo; the riff API
      // rejects out-of-registry names downstream, not this local parser.
      expect(parseRiffRepoName('git@github.com:deepcoldy/botmux.git')).toBe('deepcoldy/botmux');
      expect(parseRiffRepoName('https://github.com/deepcoldy/botmux')).toBe('deepcoldy/botmux');
      // Non-repo specs still return null.
      expect(parseRiffRepoName('https://git.example.com/notarepo')).toBeNull();
      expect(parseRiffRepoName('')).toBeNull();
    });

    it('derives repoName + pinned branch when the branch exists on the remote', () => {
      const git = (answers: Record<string, string | null>) => (args: string[]) =>
        answers[args.join(' ')] ?? null;
      const derived = deriveRiffRepoFromWorkingDir('/repo', git({
        'remote get-url origin': 'git@git.example.com:webinfra/agent-monorepo.git',
        'rev-parse --abbrev-ref HEAD': 'feat/x',
        'rev-parse --verify --quiet refs/remotes/origin/feat/x': 'abc123',
        'rev-list --count refs/remotes/origin/feat/x..HEAD': '0',
        'status --porcelain': null,
      }));
      expect(derived).toEqual({ repo: { repoName: 'webinfra/agent-monorepo', repoBranch: 'feat/x' }, warnings: [] });
    });

    it('warns on unpushed branch (falls back to default branch) and dirty tree', () => {
      const git = (answers: Record<string, string | null>) => (args: string[]) =>
        answers[args.join(' ')] ?? null;
      const derived = deriveRiffRepoFromWorkingDir('/repo', git({
        'remote get-url origin': 'git@git.example.com:g/r.git',
        'rev-parse --abbrev-ref HEAD': 'local-only',
        'status --porcelain': ' M src/a.ts',
      }));
      expect(derived!.repo).toEqual({ repoName: 'g/r' });
      expect(derived!.warnings.some(w => w.includes('未推送到远端'))).toBe(true);
      expect(derived!.warnings.some(w => w.includes('未提交改动'))).toBe(true);
    });

    it('multi-repo: derives the EXPLICIT stamped dirs in user-selection order (B,A stays B,A)', () => {
      const perDir: Record<string, { repo: any; warnings: string[] } | null> = {
        '/wt/b': { repo: { repoName: 'g/b', repoBranch: 'wt/x' }, warnings: [] },
        '/wt/a': { repo: { repoName: 'g/a' }, warnings: ['本地分支 wt/y 未推送到远端，沙箱将使用默认分支'] },
      };
      const derived = deriveRiffReposFromDirs(['/wt/b', '/wt/a'], (dir: string) => perDir[dir] ?? null);
      // 用户选 B,A → primary 必须是 B（顺序即语义，不随文件系统枚举漂移）
      expect(derived!.repos).toEqual([{ repoName: 'g/b', repoBranch: 'wt/x' }, { repoName: 'g/a' }]);
      expect(derived!.warnings).toEqual(['[g/a] 本地分支 wt/y 未推送到远端，沙箱将使用默认分支']);
    });

    it('multi-repo: returns null when no stamped dir derives (never scans children)', () => {
      expect(deriveRiffReposFromDirs(['/x/a', '/x/b'], () => null)).toBeNull();
    });

    it('plain non-git workingDir derives nothing (no repo attached)', () => {
      const git = () => null;
      expect(deriveRiffRepoFromWorkingDir('/home/user', git)).toBeNull();
    });

    it('returns null for non-git dirs; external-host origins parse (registry check is server-side)', () => {
      const git = (answers: Record<string, string | null>) => (args: string[]) =>
        answers[args.join(' ')] ?? null;
      // Host is no longer gated locally — an external origin parses to group/repo
      // and is rejected by the riff API's registry, not by this deriver.
      expect(deriveRiffRepoFromWorkingDir('/repo', git({ 'remote get-url origin': 'git@github.com:a/b.git' }))!.repo)
        .toEqual({ repoName: 'a/b' });
      // No origin (not a git repo) still yields null.
      expect(deriveRiffRepoFromWorkingDir('/repo', git({}))).toBeNull();
    });

    it('sends config.repos in the API-native shape and a status line', async () => {
      const be = makeBackend({ repos: [{ repoName: 'g/r', repoBranch: 'dev' }], repoWarnings: ['本地工作区有未提交改动，沙箱只能看到已推送内容'] });
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      const exec = calls.find(c => c.url.includes('/api/task-execute'))!;
      const body = JSON.parse(String(exec.init?.body));
      expect(body.config.repos).toEqual([{ repoName: 'g/r', repoBranch: 'dev' }]);
      expect(lines.join('')).toContain('[riff] 仓库: g/r@dev');
      expect(lines.join('')).toContain('⚠️ 本地工作区有未提交改动');
    });

    it('ignores stale defaultRepo config — repos come only from config.repos', async () => {
      const be = makeBackend({ defaultRepo: 'https://git.example.com/g/r.git', defaultBranch: 'dev', injectStatusLines: false } as any);
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      const exec = calls.find(c => c.url.includes('/api/task-execute'))!;
      expect(JSON.parse(String(exec.init?.body)).config.repos).toBeUndefined();
    });
  });

  describe('close race with in-flight create/follow-up (finding L-race)', () => {
    it('close during create: the late task is cancelled, never streamed or adopted', async () => {
      const be = makeBackend({ injectStatusLines: false });
      be.spawn('', [], {} as any);
      be.write('hello');
      await flush();
      // create HTTP 尚未返回时 /close
      const destroyP = be.destroySession();
      await flush();
      resolvers.shift()!(taskResponse('task-late'));
      await new Promise((r) => setTimeout(r, 20));
      await destroyP;
      const cancels = calls.filter(c => c.url.includes('/api/task-cancel'));
      expect(cancels.length).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(String(cancels[cancels.length - 1]!.init?.body ?? '{}')).id ?? JSON.parse(String(cancels[0]!.init?.body)).id).toBe('task-late');
      expect(calls.filter(c => c.url.includes('/api2/task-stream')).length).toBe(0);
      // The cancelled child remains the exact lineage anchor until durable
      // close commit. An abort can therefore continue from it, not its stale
      // parent; it is still never streamed while prepare is fenced.
      expect((be as any).currentTaskId).toBe('task-late');
    });

    it('close during follow-up: the late follow-up task is cancelled', async () => {
      const be = makeBackend({ injectStatusLines: false });
      be.spawn('', [], {} as any);
      be.write('first');
      await flush();
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-1');
      await flush(); await flush();
      be.write('second');
      await flush();
      const destroyP = be.destroySession();
      await flush();
      resolvers.shift()!(taskResponse('task-late-2'));
      await new Promise((r) => setTimeout(r, 20));
      await destroyP;
      const cancelIds = calls.filter(c => c.url.includes('/api/task-cancel')).map(c => JSON.parse(String(c.init?.body)).id);
      expect(cancelIds).toContain('task-late-2');
      // Preserve the cancelled child as retry lineage, but never stream it.
      expect((be as any).currentTaskId).toBe('task-late-2');
      expect(calls.filter(c => c.url.includes('/api2/task-stream?id=task-late-2')).length).toBe(0);
    });
  });

  describe('close prepare / abort / retry state contract', () => {
    it('restores write admission after cancel failure, then allows a close retry', async () => {
      const be = makeBackend({ resumeParentTaskId: 'task-parent', injectStatusLines: false });
      let cancelCalls = 0;
      fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        calls.push({ url: u, init });
        if (u.includes('/api/task-cancel')) {
          cancelCalls++;
          return cancelCalls <= 2
            ? new Response('cancel failed', { status: 500 })
            : Response.json({ success: true, data: {} });
        }
        if (u.includes('/api/task-follow-up')) return taskResponse('task-after-failure');
        if (u.includes('/api2/task-stream')) return pendingSseResponse();
        if (u.includes('/api/task-detail')) return Response.json({ success: true, data: { task: {} } });
        return taskResponse('unexpected-create');
      });

      const failed = await be.destroySession();
      expect(failed).toMatchObject({ ok: false, taskId: 'task-parent' });
      expect((be as any).closing).toBe(false);

      be.write('continue after failed close');
      await flush(); await flush();
      const follow = calls.find(c => c.url.includes('/api/task-follow-up'));
      expect(follow).toBeDefined();
      expect(JSON.parse(String(follow!.init?.body)).parentTaskId).toBe('task-parent');

      const retried = await be.destroySession();
      expect(retried).toEqual({ ok: true, taskId: 'task-after-failure' });
    });

    it('aborts a successful prepare without losing a late-created child lineage', async () => {
      const be = makeBackend({ injectStatusLines: false });
      be.write('opening message');
      await flush();
      const preparedP = be.destroySession();
      resolvers.shift()!(taskResponse('task-late-prepared'));
      const prepared = await preparedP;
      expect(prepared).toEqual({ ok: true, taskId: 'task-late-prepared' });
      expect((be as any).closing).toBe(true);

      await be.abortDestroySession();
      expect((be as any).closing).toBe(false);
      be.write('continue after durable commit failure');
      await flush();
      const follow = calls.find(c => c.url.includes('/api/task-follow-up'));
      expect(follow).toBeDefined();
      expect(JSON.parse(String(follow!.init?.body)).parentTaskId).toBe('task-late-prepared');
    });

    it('does not reopen admission when close timeout wins during an in-flight cancel', async () => {
      const be = makeBackend({ resumeParentTaskId: 'task-timeout-parent', injectStatusLines: false });
      (be as any).destroyDeadlineMs = 10;
      let resolveCancel!: (response: Response) => void;
      fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        calls.push({ url: u, init });
        if (u.includes('/api/task-cancel')) {
          return new Promise<Response>(resolve => { resolveCancel = resolve; });
        }
        if (u.includes('/api/task-follow-up')) return taskResponse('task-after-timeout');
        if (u.includes('/api2/task-stream')) return pendingSseResponse();
        if (u.includes('/api/task-detail')) return Response.json({ success: true, data: { task: {} } });
        return taskResponse('unexpected-create');
      });

      let settled = false;
      const closeP = be.destroySession().then(result => { settled = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(settled).toBe(false);
      be.write('must remain fenced');
      await flush();
      expect(calls.filter(c => c.url.includes('/api/task-follow-up')).length).toBe(0);

      resolveCancel(Response.json({ success: true, data: {} }));
      const result = await closeP;
      expect(result).toEqual({ ok: false, taskId: 'task-timeout-parent', error: 'close_timeout' });
      expect((be as any).closing).toBe(false);

      be.write('admitted after cancel settled');
      await flush();
      expect(calls.filter(c => c.url.includes('/api/task-follow-up')).length).toBe(1);
    });

    it('cannot publish a prepared close after an abort races a late successful cancel', async () => {
      const be = makeBackend({ resumeParentTaskId: 'task-abort-race', injectStatusLines: false });
      let resolveCancel!: (response: Response) => void;
      fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        calls.push({ url: u, init });
        if (u.includes('/api/task-cancel')) {
          return new Promise<Response>(resolve => { resolveCancel = resolve; });
        }
        if (u.includes('/api/task-follow-up')) return taskResponse('task-after-abort-race');
        if (u.includes('/api2/task-stream')) return pendingSseResponse();
        if (u.includes('/api/task-detail')) return Response.json({ success: true, data: { task: {} } });
        return taskResponse('unexpected-create');
      });

      let closeSettled = false;
      const close = be.destroySession().then(result => {
        closeSettled = true;
        return result;
      });
      await flush();
      expect(resolveCancel).toBeTypeOf('function');

      let abortSettled = false;
      const abort = be.abortDestroySession().then(() => { abortSettled = true; });
      await flush();
      expect(closeSettled).toBe(false);
      expect(abortSettled).toBe(false);
      expect((be as any).closing).toBe(true);

      resolveCancel(Response.json({ success: true, data: {} }));
      await expect(close).resolves.toEqual({
        ok: false,
        taskId: 'task-abort-race',
        error: 'close_aborted',
      });
      await abort;
      expect((be as any).closePrepared).toBe(false);
      expect((be as any).closing).toBe(false);

      be.write('admitted after exact abort');
      await flush();
      expect(calls.filter(c => c.url.includes('/api/task-follow-up'))).toHaveLength(1);
    });
  });

  describe('close teardown awaits pending cancel (finding L-race hard proof)', () => {
    it('destroySession does NOT resolve while the late-task cancel is still pending', async () => {
      const be = makeBackend({ injectStatusLines: false });
      let resolveCancel!: (r: Response) => void;
      const cancelCalls: string[] = [];
      fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        calls.push({ url: u, init });
        if (u.includes('/api/task-cancel')) {
          cancelCalls.push(JSON.parse(String(init?.body)).id);
          return new Promise<Response>((r) => { resolveCancel = r; }); // cancel 挂起
        }
        if (u.includes('/api2/task-stream')) return pendingSseResponse();
        if (u.includes('/api/task-detail')) return Response.json({ success: true, data: { task: {} } });
        return new Promise<Response>((resolve) => { resolvers.push(resolve); });
      });
      be.spawn('', [], {} as any);
      be.write('hello');
      await flush();
      let destroyed = false;
      const destroyP = be.destroySession().then(() => { destroyed = true; });
      await flush();
      // create 返回 late task —— closing 已立，late cancel 在链内 await
      resolvers.shift()!(taskResponse('task-late'));
      await new Promise((r) => setTimeout(r, 30));
      expect(cancelCalls).toContain('task-late');
      expect(destroyed).toBe(false); // cancel 未 resolve 前 teardown 不得完成
      resolveCancel(Response.json({ success: true, data: {} }));
      await destroyP;
      expect(destroyed).toBe(true);
      expect(calls.filter(c => c.url.includes('/api2/task-stream')).length).toBe(0);
    });
  });

  describe('close deadline boundary (no inner chain window)', () => {
    it('create resolving late (after destroy started) still gets its cancel awaited before teardown', async () => {
      const be = makeBackend({ injectStatusLines: false });
      (be as any).destroyDeadlineMs = 1_000; // 注入小预算便于边界测试
      let resolveCancel!: (r: Response) => void;
      const cancelIds: string[] = [];
      fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        calls.push({ url: u, init });
        if (u.includes('/api/task-cancel')) {
          cancelIds.push(JSON.parse(String(init?.body)).id);
          return new Promise<Response>((r) => { resolveCancel = r; });
        }
        if (u.includes('/api2/task-stream')) return pendingSseResponse();
        if (u.includes('/api/task-detail')) return Response.json({ success: true, data: { task: {} } });
        return new Promise<Response>((resolve) => { resolvers.push(resolve); });
      });
      be.spawn('', [], {} as any);
      be.write('hello');
      await flush();
      let destroyed = false;
      const destroyP = be.destroySession().then(() => { destroyed = true; });
      // create 晚于 destroy 启动才返回（模拟 chain 窗口末端）
      await new Promise((r) => setTimeout(r, 120));
      resolvers.shift()!(taskResponse('task-late-edge'));
      await new Promise((r) => setTimeout(r, 60));
      expect(cancelIds).toContain('task-late-edge');
      expect(destroyed).toBe(false); // teardown 必须等到 late cancel，不因内层窗口提前 resolve
      resolveCancel(Response.json({ success: true, data: {} }));
      await destroyP;
      expect(destroyed).toBe(true);
      expect(calls.filter(c => c.url.includes('/api2/task-stream')).length).toBe(0);
    });
  });

  describe('final report ordering (F-edge)', () => {
    it('emits the completed task report BEFORE firing the turn boundary', async () => {
      const be = makeBackend({ injectStatusLines: false });
      const order: string[] = [];
      be.onData((d) => { if (d.includes('REPORT-A')) order.push('report'); });
      be.onTaskDone(() => order.push('boundary'));
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        calls.push({ url: u });
        if (u.includes('/api/task-detail')) {
          await new Promise((r) => setTimeout(r, 10)); // 模拟 detail 延迟
          return Response.json({ success: true, data: { task: { resultOutput: { displayReport: { content: 'REPORT-A' } } } } });
        }
        return pendingSseResponse();
      });
      (be as any).currentTaskId = 'task-A';
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-A');
      await new Promise((r) => setTimeout(r, 30));
      expect(order).toEqual(['report', 'boundary']);
    });
  });

  describe('prompt single @-rule (finding K/2)', () => {
    it('escapes tag-like tokens in the built-in system prose without rewriting the heredoc', async () => {
      const be = makeBackend({ injectStatusLines: false });
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      const exec = calls.find(c => c.url.includes('/api/task-execute'))!;
      const prompt = String(JSON.parse(String(exec.init?.body)).config.userPrompt);
      const system = prompt.slice(
        prompt.indexOf('<system>'),
        prompt.indexOf('</system>') + '</system>'.length,
      );
      const systemProse = system.replace(/<\/?system>/g, '');

      expect(system).toContain('&lt;message_id&gt;');
      expect(system).toContain('&lt;open_id&gt;');
      expect(system).toContain('&lt;sender&gt;');
      expect(system).toContain("botmux send <<'EOF'");
      expect(system).not.toContain("botmux send &lt;&lt;'EOF'");
      expect(systemProse.match(/<[^<>\r\n]+>/g) ?? []).toEqual([]);
    });

    it('payload prompt forbids mention-back and keeps mandatory routing under a custom systemPrompt', async () => {
      const be = makeBackend({ injectStatusLines: false, systemPrompt: '你是 QA 专家，回答尽量简短。' });
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      const exec = calls.find(c => c.url.includes('/api/task-execute'))!;
      const prompt = String(JSON.parse(String(exec.init?.body)).config.userPrompt);
      expect(prompt).toContain('NEVER use `--mention-back`');       // 禁用规则在
      expect(prompt).not.toMatch(/--mention-back（|→ ?--mention-back/); // 无推荐语
      expect(prompt).toContain('COMPLETION CONTRACT');               // mandatory 未被替换
      expect(prompt).toContain('你是 QA 专家');                      // 自定义作为追加
      expect(prompt.indexOf('COMPLETION CONTRACT')).toBeLessThan(prompt.indexOf('你是 QA 专家'));
    });
  });

  describe('status line redaction (finding S)', () => {
    it('sandbox status line shows host only, never the full capability URL', async () => {
      const be = makeBackend();
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      (be as any).currentTaskId = 'task-9';
      (be as any).handleSseEvent('event:init\ndata:{"directAccessUrl":"https://port-8080-v1-SECRETSANDBOXID.sandbox.example.com/?folder=x"}', 'task-9');
      const out = lines.join('');
      expect(out).toContain('Sandbox 已就绪');
      // 可写能力编码在唯一子域——hostname 的任何部分都不得出现在群可见输出里
      expect(out).not.toContain('SECRETSANDBOXID');
      expect(out).not.toContain('port-8080');
      expect(out).not.toContain('sandbox.example.com');
    });
  });

  describe('access URL handling', () => {
    it('rewrites accessUrl origin onto the configured baseUrl', async () => {
      const be = makeBackend();
      const urls: string[] = [];
      be.onAccessUrl((u) => urls.push(u));
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      resolvers.shift()!(taskResponse('task-1', {
        accessUrl: 'https://riff.example.com/sandbox-access?sessionId=abc&folder=%2Fx',
      }));
      await flush();
      expect(urls).toContain(`${BASE}/sandbox-access?sessionId=abc&folder=%2Fx`);
    });

    it('prefers directAccessUrl and never downgrades back to a frontend URL', async () => {
      const be = makeBackend();
      const urls: string[] = [];
      be.onAccessUrl((u) => urls.push(u));
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      resolvers.shift()!(taskResponse('task-1', {
        accessUrl: 'https://riff.example.com/sandbox-access?sessionId=abc',
        directAccessUrl: 'https://port-8080-v1-abc.sandbox.example.com/?folder=%2Fx',
      }));
      await flush();
      expect(urls[urls.length - 1]).toBe('https://port-8080-v1-abc.sandbox.example.com/?folder=%2Fx');

      // A later frontend-only URL must not replace the direct terminal URL.
      (be as any).updateAccessUrl({ accessUrl: 'https://riff.example.com/sandbox-access?sessionId=late' });
      expect(urls[urls.length - 1]).toBe('https://port-8080-v1-abc.sandbox.example.com/?folder=%2Fx');
    });

    it('upgrades to directAccessUrl from a task-detail fetch after an SSE accessUrl', async () => {
      const be = makeBackend();
      const urls: string[] = [];
      be.onAccessUrl((u) => urls.push(u));
      (be as any).currentTaskId = 'task-9';
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        calls.push({ url: u });
        if (u.includes('/api/task-detail')) {
          return Response.json({ success: true, data: { task: {
            accessUrl: 'https://riff.example.com/sandbox-access?sessionId=z',
            directAccessUrl: 'https://port-8080-z.sandbox.example.com/',
          } } });
        }
        return pendingSseResponse();
      });
      // Simulate the SSE init event carrying only the frontend accessUrl.
      (be as any).handleSseEvent('event:init\ndata:{"accessUrl":"https://riff.example.com/sandbox-access?sessionId=z"}', 'task-9');
      expect(urls[urls.length - 1]).toBe(`${BASE}/sandbox-access?sessionId=z`);
      await flush();
      expect(urls[urls.length - 1]).toBe('https://port-8080-z.sandbox.example.com/');
    });
  });

  describe('create/follow-up 401 retry with refreshed JWT (申晗: startup must actually get a JWT)', () => {
    /** A task-execute fetch mock: first POST 401s, the retry (if any) 200s.
     *  task-stream stays pending; task-detail/cancel resolve instantly. */
    function authRetryFetch(): { execHeaders: Array<string | undefined> } {
      const execHeaders: Array<string | undefined> = [];
      let execCount = 0;
      const mock = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/api/task-execute')) {
          execCount += 1;
          const h = (init?.headers ?? {}) as Record<string, string>;
          execHeaders.push(h['x-jwt-token']);
          return execCount === 1
            ? new Response('unauthorized', { status: 401 })
            : Response.json({ success: true, data: { id: 'task-ok', status: 'running' } });
        }
        if (u.includes('/api2/task-stream')) return pendingSseResponse();
        return Response.json({ success: true, data: {} });
      });
      vi.stubGlobal('fetch', mock);
      return { execHeaders };
    }

    it('retries ONCE with a freshly-refreshed token after a 401 and succeeds', async () => {
      const { execHeaders } = authRetryFetch();
      const be = makeBackend();
      // Script getJwt: stale token first, forced refresh yields a different one.
      const gj = vi.spyOn(be as any, 'getJwt').mockImplementation(async (opts: any) => {
        return opts?.forceRefresh ? 'JWT-FRESH' : 'JWT-STALE';
      });
      be.spawn('', [], {} as any);
      be.write('hello');
      await flush(); await flush();

      // Two task-execute POSTs: the stale-token attempt (401), then the refreshed retry.
      expect(execHeaders).toEqual(['JWT-STALE', 'JWT-FRESH']);
      // The retry used a forced refresh.
      expect(gj.mock.calls.some(c => (c[0] as any)?.forceRefresh === true)).toBe(true);
      // Task adopted → currentTaskId set from the successful retry.
      expect((be as any).currentTaskId).toBe('task-ok');
    });

    it('does NOT retry when the forced refresh yields the SAME token (no pointless replay)', async () => {
      const { execHeaders } = authRetryFetch();
      const be = makeBackend();
      // Refresh produces nothing new — same token both times.
      vi.spyOn(be as any, 'getJwt').mockResolvedValue('JWT-SAME');
      const emitErr = vi.spyOn(be as any, 'emitError');
      be.spawn('', [], {} as any);
      be.write('hello');
      await flush(); await flush();

      // Only the first POST happened; no retry because the token was unchanged.
      expect(execHeaders).toEqual(['JWT-SAME']);
      // The 401 surfaces as a turn-ending error (unchanged pre-existing behaviour).
      expect(emitErr).toHaveBeenCalled();
    });
  });
});
