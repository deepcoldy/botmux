import { describe, it, expect } from 'vitest';
import { Aggregator, subscribeDaemon } from '../src/dashboard/aggregator.js';

describe('Aggregator cache merge', () => {
  it('upsert via session.spawned and session.update', () => {
    const a = new Aggregator();
    a.applyEvent('appA', {
      type: 'session.spawned',
      body: { session: { sessionId: 's1', larkAppId: 'appA', status: 'starting' } as any },
    });
    expect(a.getSessions().length).toBe(1);
    a.applyEvent('appA', {
      type: 'session.update',
      body: { sessionId: 's1', patch: { status: 'idle' } },
    });
    expect(a.getSessions()[0].status).toBe('idle');
  });

  it('marks closed on session.exited (keeps row for closed-session view)', () => {
    const a = new Aggregator();
    a.applyEvent('appA', {
      type: 'session.spawned',
      body: { session: { sessionId: 's1', larkAppId: 'appA' } as any },
    });
    a.applyEvent('appA', { type: 'session.exited', body: { sessionId: 's1' } });
    expect(a.getSessions().length).toBe(1);
    expect(a.getSessions()[0].status).toBe('closed');
  });

  it('schedule lifecycle', () => {
    const a = new Aggregator();
    a.applyEvent('appA', {
      type: 'schedule.created',
      body: { schedule: { id: 't1', enabled: true } as any },
    });
    a.applyEvent('appA', {
      type: 'schedule.updated',
      body: { id: 't1', patch: { enabled: false } },
    });
    expect(a.getSchedules()[0].enabled).toBe(false);
    a.applyEvent('appA', { type: 'schedule.deleted', body: { id: 't1' } });
    expect(a.getSchedules().length).toBe(0);
  });

  it('hydrate seeds the cache', () => {
    const a = new Aggregator();
    a.hydrateSessions('appA', [{ sessionId: 's1', larkAppId: 'appA' } as any]);
    a.hydrateSchedules([{ id: 't1' } as any]);
    expect(a.getSessions().length).toBe(1);
    expect(a.getSchedules().length).toBe(1);
  });

  it('preserves presentation fields when a daemon replays the same working directory', () => {
    const a = new Aggregator();
    a.hydrateSessions('appA', [{
      sessionId: 's1',
      larkAppId: 'appA',
      workingDir: '/repo/a',
      botAvatarUrl: 'https://img.example/a.png',
      repoName: 'a',
      gitBranch: 'main',
    }]);
    const seen: any[] = [];
    a.on(event => seen.push(event));

    a.applyEvent('appA', {
      type: 'session.spawned',
      body: { session: { sessionId: 's1', workingDir: '/repo/a', status: 'idle' } as any },
    });

    expect(a.getSession('s1')).toMatchObject({
      botAvatarUrl: 'https://img.example/a.png',
      repoName: 'a',
      gitBranch: 'main',
      status: 'idle',
    });
    expect(seen[0].body.session).toMatchObject({
      repoName: 'a',
      gitBranch: 'main',
    });
  });

  it('clears stale repository fields immediately when workingDir changes', () => {
    const a = new Aggregator();
    a.hydrateSessions('appA', [{
      sessionId: 's1',
      larkAppId: 'appA',
      workingDir: '/repo/a',
      repoName: 'a',
      gitBranch: 'main',
    }]);
    const seen: any[] = [];
    a.on(event => seen.push(event));

    a.applyEvent('appA', {
      type: 'session.update',
      body: { sessionId: 's1', patch: { workingDir: '/repo/b' } },
    });

    expect(a.getSession('s1')).toMatchObject({
      workingDir: '/repo/b',
      repoName: null,
      gitBranch: null,
    });
    expect(seen[0].body.patch).toMatchObject({
      workingDir: '/repo/b',
      repoName: null,
      gitBranch: null,
    });
  });

  it('ownerOf returns larkAppId for known sessionId', () => {
    const a = new Aggregator();
    a.applyEvent('appA', {
      type: 'session.spawned',
      body: { session: { sessionId: 's1', larkAppId: 'appA' } as any },
    });
    expect(a.ownerOf('s1')).toBe('appA');
    expect(a.ownerOf('nonexistent')).toBeUndefined();
  });

  it('listeners receive events with larkAppId attached', () => {
    const a = new Aggregator();
    const seen: any[] = [];
    a.on(e => seen.push(e));
    a.applyEvent('appB', { type: 'session.spawned', body: { session: { sessionId: 's2' } as any } });
    expect(seen).toHaveLength(1);
    expect(seen[0].larkAppId).toBe('appB');
    expect(seen[0].type).toBe('session.spawned');
  });
});

describe('subscribeDaemon barrier & reconnect', () => {
  const daemon = { larkAppId: 'appA', ipcPort: 19999, botName: 'A' } as any;

  /** A never-ending SSE stream (prevents tight reconnect loops in tests). */
  function neverEndingSSE(): Response {
    const stream = new ReadableStream({
      start(controller) {
        // Enqueue one event then hold the stream open forever.
        controller.enqueue(new TextEncoder().encode('event: ping\ndata: {}\n\n'));
        // Never close — the abort will release the reader.
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  /** An SSE stream that enqueues `frames` once, then ends with a clean EOF. */
  function eofSSE(frames: string[]): Response {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const f of frames) controller.enqueue(enc.encode(f));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  it('runs the barrier on the first connection before any frame is applied', async () => {
    const agg = new Aggregator();
    let barrierResolved = false;
    const abort = subscribeDaemon(
      daemon, agg,
      () => {},
      () => Promise.resolve(eofSSE([
        'event: session.spawned\ndata: {"session":{"sessionId":"s1","status":"idle"}}\n\n',
      ])),
      async () => {
        await new Promise(r => setTimeout(r, 100));
        barrierResolved = true;
      },
    );
    // The frame is queued in the stream while the barrier runs; not applied yet.
    await new Promise(r => setTimeout(r, 50));
    expect(barrierResolved).toBe(false);
    expect(agg.getSessions()).toHaveLength(0);
    // After the barrier resolves, the queued frame is applied.
    await new Promise(r => setTimeout(r, 100));
    expect(barrierResolved).toBe(true);
    expect(agg.getSessions()).toHaveLength(1);
    expect(agg.getSession('s1')?.status).toBe('idle');
    abort();
  });

  it('a slow barrier snapshot cannot clobber a queued SSE frame', async () => {
    // Repro of the reverse race: an event delivered over SSE at ~50ms used to
    // be overwritten by a slow snapshot response finishing at ~144ms. With the
    // barrier, the snapshot is installed BEFORE any frame is read, so the
    // queued frame always applies on top and wins.
    const agg = new Aggregator();
    const abort = subscribeDaemon(
      daemon, agg,
      () => {},
      () => Promise.resolve(eofSSE([
        'event: session.exited\ndata: {"sessionId":"s1"}\n\n',
      ])),
      async () => {
        await new Promise(r => setTimeout(r, 150));
        agg.hydrateSessions('appA', [{ sessionId: 's1', larkAppId: 'appA', status: 'idle' } as any]);
      },
    );
    await new Promise(r => setTimeout(r, 300));
    expect(agg.getSession('s1')?.status).toBe('closed');
    abort();
  });

  it('keeps reading frames when the barrier throws', async () => {
    const agg = new Aggregator();
    const errors: Error[] = [];
    const abort = subscribeDaemon(
      daemon, agg,
      e => errors.push(e),
      () => Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'event: session.spawned\ndata: {"session":{"sessionId":"s1"}}\n\n',
          ));
          // Hold open so the only error observed is the barrier's.
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })),
      async () => { throw new Error('snapshot fetch failed'); },
    );
    await new Promise(r => setTimeout(r, 100));
    abort();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('snapshot fetch failed');
    // The live stream still populated the aggregator (best-effort).
    expect(agg.getSessions()).toHaveLength(1);
  });

  it('skips the barrier on a failed fetch and runs it on the successful retry', async () => {
    let barriers = 0;
    let call = 0;
    const abort = subscribeDaemon(
      daemon, new Aggregator(),
      () => {},
      () => {
        call++;
        if (call === 1) return Promise.reject(new Error('connection refused'));
        return Promise.resolve(neverEndingSSE());
      },
      () => { barriers++; },
    );
    // Wait for: initial fail → 1s backoff → reconnect → barrier
    await new Promise(r => setTimeout(r, 1_500));
    abort();
    expect(barriers).toBe(1);
  });

  it('treats clean EOF as a disconnect: backs off and re-runs the barrier', async () => {
    const times: number[] = [];
    let call = 0;
    const abort = subscribeDaemon(
      daemon, new Aggregator(),
      () => {},
      () => {
        call++;
        if (call === 1) {
          // Established stream that ends immediately with a clean EOF.
          return Promise.resolve(eofSSE(['event: ping\ndata: {}\n\n']));
        }
        return Promise.resolve(neverEndingSSE());
      },
      () => { times.push(Date.now()); },
    );
    // Wait for: first connect → clean EOF → 1s backoff → reconnect → barrier
    await new Promise(r => setTimeout(r, 1_500));
    abort();
    expect(times).toHaveLength(2);
    // The backoff actually elapsed (without it, a tight loop would run
    // dozens of iterations in this window).
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(900);
  });
});
