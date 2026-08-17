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

describe('subscribeDaemon reconnect', () => {
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

  it('does not fire onReconnect on the first successful connection', async () => {
    let reconnects = 0;
    const abort = subscribeDaemon(
      daemon, new Aggregator(),
      () => {},
      () => Promise.resolve(neverEndingSSE()),
      () => { reconnects++; },
    );
    await new Promise(r => setTimeout(r, 100));
    abort();
    expect(reconnects).toBe(0);
  });

  it('fires onReconnect after a fetch failure and successful retry', async () => {
    let reconnects = 0;
    let call = 0;
    const abort = subscribeDaemon(
      daemon, new Aggregator(),
      () => {},
      () => {
        call++;
        if (call === 1) return Promise.reject(new Error('connection refused'));
        return Promise.resolve(neverEndingSSE());
      },
      () => { reconnects++; },
    );
    // Wait for: initial fail → 1s backoff → reconnect → onReconnect
    await new Promise(r => setTimeout(r, 1_500));
    abort();
    expect(reconnects).toBe(1);
  });
});
