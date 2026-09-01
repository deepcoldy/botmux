import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';

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

/** 服务端对 Workbench-only 身份的真实答复：401 + HTML 登录页（不是 JSON）。 */
function authWallResponse(): Response {
  return new Response(
    '<h1>Token expired</h1><p>Run <code>botmux dashboard</code> to get a fresh URL.</p>',
    {
      status: 401,
      headers: { 'content-type': 'text/html; charset=utf-8', 'x-botmux-auth-scope': 'workbench' },
    },
  );
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

// ─── P1-14：Workbench-only 身份启动即空列表 ──────────────────────────────────
//
// 生产的飞书 H5 / 平台 teammate 身份走窄门禁，`/api/schedules` 不在能力表里，
// 服务端回的是 **401 + HTML 登录页**。旧 bootstrap 把 sessions 和 schedules 一起
// 塞进 `Promise.all`，那份 HTML 让 `.json()` 抛 SyntaxError，于是**已经成功的**
// 会话快照被一起丢掉，`replaceSnapshot` 从不执行——工作台一进去就是空会话列表。
describe('dashboard store bootstrap · optional resources cannot sink the session snapshot', () => {
  it('installs the sessions snapshot even when /api/schedules answers 401 with an HTML login page', async () => {
    const scheduleAttempts: Array<'wall' | 'network-error'> = ['wall', 'network-error'];
    const sessionRows = [
      [{ sessionId: 'workbench-session', status: 'idle', repoName: 'botmux' }],
      [{ sessionId: 'workbench-session', status: 'working', repoName: 'botmux' }],
    ];
    const fetchMock = vi.fn((path: string) => {
      if (path === '/api/sessions') {
        return Promise.resolve(jsonResponse({ sessions: sessionRows.shift() ?? [] }));
      }
      // 第一次是真实的 401 HTML 门禁页，第二次换成网络失败：两种「拿不到」都不许
      // 拖垮会话快照。
      return scheduleAttempts.shift() === 'wall'
        ? Promise.resolve(authWallResponse())
        : Promise.reject(new TypeError('Failed to fetch'));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { bootstrap, store } = await import('../src/dashboard/web/store.js');

    // bootstrap 必须正常完成：排程是可选资源，不是启动条件。
    await expect(bootstrap()).resolves.toBeUndefined();

    expect(store.sessions.get('workbench-session')).toMatchObject({ status: 'idle' });
    expect(store.getSnapshot().sessions.size).toBe(1);
    // 排程降级为空，并明确标记「读不到」，UI 据此隐藏排程区块而不是画空面板。
    expect(store.schedules.size).toBe(0);
    expect(store.getSnapshot().schedulesAvailable).toBe(false);

    // 重连后的 reconcile 走的是同一条路径，同样不能被排程失败废掉。
    FakeEventSource.instance?.open();
    await vi.waitFor(() => {
      expect(store.sessions.get('workbench-session')).toMatchObject({ status: 'working' });
    });
    expect(store.getSnapshot().schedulesAvailable).toBe(false);
  });

  it('skips the /api/schedules round trip entirely for an identity without the capability', async () => {
    const fetchMock = vi.fn((path: string) => Promise.resolve(
      path === '/api/sessions'
        ? jsonResponse({ sessions: [{ sessionId: 'h5-session', status: 'idle' }] })
        : authWallResponse(),
    ));
    vi.stubGlobal('fetch', fetchMock);
    const { bootstrap, store } = await import('../src/dashboard/web/store.js');

    await bootstrap({ canReadSchedules: () => false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions');
    expect(store.sessions.has('h5-session')).toBe(true);
    expect(store.getSnapshot().schedulesAvailable).toBe(false);
  });

  it('still loads schedules and the effective timezone for an identity that has the capability', async () => {
    const fetchMock = vi.fn((path: string) => Promise.resolve(
      path === '/api/sessions'
        ? jsonResponse({ sessions: [{ sessionId: 'owner-session', status: 'idle' }] })
        : jsonResponse({ schedules: [{ id: 'sch-1', nextRunAt: '2026-01-01T00:00:00Z' }], timezone: 'Asia/Shanghai' }),
    ));
    vi.stubGlobal('fetch', fetchMock);
    const { bootstrap, store } = await import('../src/dashboard/web/store.js');

    await bootstrap({ canReadSchedules: () => true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.sessions.has('owner-session')).toBe(true);
    expect(store.schedules.get('sch-1')).toMatchObject({ id: 'sch-1' });
    expect(store.getSnapshot().scheduleTimeZone).toBe('Asia/Shanghai');
    expect(store.getSnapshot().schedulesAvailable).toBe(true);
  });
});
