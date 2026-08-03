import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (event: { data: string }) => void;

class FakeEventSource {
  static instance: FakeEventSource | null = null;
  readonly listeners = new Map<string, Listener>();
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instance = this;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }

  emit(type: string, body: unknown): void {
    this.listeners.get(type)?.({
      data: JSON.stringify({ body }),
    });
  }

  open(): void {
    this.onopen?.();
  }

  close(): void {
    this.closed = true;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>(done => { resolve = done; }),
    resolve,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body));
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.instance = null;
});

describe('dashboard store bootstrap', () => {
  it('fetches the snapshot without waiting for SSE open, then buffers races and reconciles on open', async () => {
    const initialSessions = deferred<Response>();
    const initialSchedules = deferred<Response>();
    const reconnectSessions = deferred<Response>();
    const reconnectSchedules = deferred<Response>();
    const sessionResponses = [initialSessions.promise, reconnectSessions.promise];
    const scheduleResponses = [initialSchedules.promise, reconnectSchedules.promise];
    const fetchMock = vi.fn((path: string) => (
      path === '/api/sessions'
        ? sessionResponses.shift()!
        : scheduleResponses.shift()!
    ));
    vi.stubGlobal('fetch', fetchMock);
    const { bootstrap, store } = await import('../src/dashboard/web/store.js');

    // A buffering reverse proxy can hold `onopen` back indefinitely. The board
    // must still load, so the snapshot request goes out immediately.
    const boot = bootstrap();
    const events = FakeEventSource.instance;
    expect(events?.url).toBe('/events');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Events that land while the snapshot is in flight are newer than it, so
    // they must be replayed on top instead of being lost to `replaceSnapshot`.
    events?.emit('session.spawned', {
      session: {
        sessionId: 'race-session',
        status: 'idle',
        repoName: 'botmux',
        gitBranch: 'feat/live',
      },
    });

    initialSessions.resolve(jsonResponse({
      sessions: [{
        sessionId: 'race-session',
        status: 'working',
        repoName: 'botmux',
        gitBranch: 'main',
      }, {
        sessionId: 'removed-while-offline',
        status: 'idle',
      }],
    }));
    initialSchedules.resolve(jsonResponse({ schedules: [{ id: 'deleted-schedule' }] }));
    await boot;

    expect(store.sessions.get('race-session')).toMatchObject({
      status: 'idle',
      gitBranch: 'feat/live',
    });
    expect(store.sessions.has('removed-while-offline')).toBe(true);
    expect(store.schedules.has('deleted-schedule')).toBe(true);

    // The first open counts too: the snapshot above may predate the server-side
    // subscription, so only a fresh snapshot converges deletes either way.
    events?.open();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    events?.emit('session.update', {
      sessionId: 'race-session',
      patch: { status: 'idle', gitBranch: 'feat/reconnected' },
    });
    reconnectSessions.resolve(jsonResponse({
      sessions: [{
        sessionId: 'race-session',
        status: 'working',
        repoName: 'botmux',
        gitBranch: 'main',
      }],
    }));
    reconnectSchedules.resolve(jsonResponse({ schedules: [] }));

    await vi.waitFor(() => {
      expect(store.sessions.get('race-session')).toMatchObject({
        status: 'idle',
        gitBranch: 'feat/reconnected',
      });
      expect(store.sessions.has('removed-while-offline')).toBe(false);
      expect(store.schedules.has('deleted-schedule')).toBe(false);
    });
  });

  it('keeps the stream open when the first snapshot fails so a later open recovers', async () => {
    let sessionCalls = 0;
    const fetchMock = vi.fn((path: string) => {
      if (path === '/api/sessions') {
        sessionCalls += 1;
        return sessionCalls === 1
          ? Promise.reject(new Error('snapshot unavailable'))
          : Promise.resolve(jsonResponse({
            sessions: [{ sessionId: 'recovered-session', status: 'idle' }],
          }));
      }
      return Promise.resolve(jsonResponse({ schedules: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { bootstrap, store } = await import('../src/dashboard/web/store.js');

    await expect(bootstrap()).rejects.toThrow('snapshot unavailable');
    const events = FakeEventSource.instance;
    // Closing here would kill EventSource's own retry and strand the page until
    // a manual refresh.
    expect(events?.closed).toBe(false);
    expect(store.sessions.has('recovered-session')).toBe(false);

    events?.open();
    await vi.waitFor(() => {
      expect(store.sessions.has('recovered-session')).toBe(true);
    });
  });
});
