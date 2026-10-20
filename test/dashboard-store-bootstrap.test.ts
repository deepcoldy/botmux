import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (event: { data: string }) => void;

class FakeEventSource {
  static instance: FakeEventSource | null = null;
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Listener>();
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  /** 0 CONNECTING / 1 OPEN / 2 CLOSED，与浏览器 EventSource 同值。 */
  readyState = 0;

  constructor(readonly url: string) {
    FakeEventSource.instance = this;
    FakeEventSource.instances.push(this);
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
    this.readyState = 1;
    this.onopen?.();
  }

  fail(): void {
    this.readyState = 0;
    this.onerror?.();
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

/** 只实现 store 用到的那一点 Page Visibility API。 */
class FakeDocument {
  hidden = false;
  private readonly visibilityListeners = new Set<() => void>();

  addEventListener(type: string, listener: () => void): void {
    if (type === 'visibilitychange') this.visibilityListeners.add(listener);
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of this.visibilityListeners) listener();
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
  FakeEventSource.instances = [];
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

// ─── `/events` 连接寿命：僵尸流看门狗 + 后台标签页挂起 ─────────────────────────
//
// 经中心化平台访问时浏览器↔平台是 HTTP/1.1，同一机器子域最多 6 条并发连接，每个
// 标签页常驻一条 `/events`：第 7 个页面会整页卡在浏览器的连接队列里。daemon 重启
// 又会让平台反代把旧页面的 `/events` 挂成僵尸（不报错、不重连、白占连接）。
describe('dashboard store bootstrap · /events connection lifetime', () => {
  const HEARTBEAT_MS = 15_000;

  const sessionFetches = (fetchMock: ReturnType<typeof vi.fn>): number => (
    fetchMock.mock.calls.filter(([path]) => path === '/api/sessions').length
  );

  function okFetch() {
    return vi.fn((path: string) => Promise.resolve(
      path === '/api/sessions'
        ? jsonResponse({ sessions: [] })
        : jsonResponse({ schedules: [] }),
    ));
  }

  /** dashboard 自己按 15s 节奏推心跳、链路实时转发：每帧到达间隔 = 服务端时间戳间隔。 */
  async function liveHeartbeats(source: FakeEventSource, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      source.emit('heartbeat', { ts: Date.now(), source: 'dashboard' });
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('replaces an OPEN stream that went silent after live heartbeats, re-syncing at once and ignoring the dead one', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { bootstrap, store, SSE_STALE_MS } = await import('../src/dashboard/web/store.js');

    await bootstrap();
    const zombie = FakeEventSource.instances[0];
    zombie.open();
    await liveHeartbeats(zombie, 2);

    // 上游没了，但连接还挂着：没有 error，也没有任何帧。
    await vi.advanceTimersByTimeAsync(SSE_STALE_MS - HEARTBEAT_MS - 5_000);
    expect(zombie.closed).toBe(false);
    const fetchesBeforeReplace = sessionFetches(fetchMock);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(zombie.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(store.getSnapshot().online).toBe(false);
    // 不等新流 open 就补拉快照：僵尸期间漏掉的变化马上收敛。
    await vi.waitFor(() => expect(sessionFetches(fetchMock)).toBe(fetchesBeforeReplace + 1));

    const fresh = FakeEventSource.instances[1];
    expect(fresh.url).toBe('/events');
    fresh.open();
    expect(store.getSnapshot().online).toBe(true);

    // 被替换掉的旧流迟到的回调不能再改在线状态，也不能往 store 里写帧
    //（无论这一帧是直接落库，还是先进缓冲、等快照装好后回放）。
    zombie.fail();
    zombie.emit('session.spawned', { session: { sessionId: 'ghost', status: 'idle' } });
    await vi.advanceTimersByTimeAsync(100);
    expect(store.getSnapshot().online).toBe(true);
    expect(store.sessions.has('ghost')).toBe(false);
  });

  it('keeps a stream whose heartbeats keep arriving', async () => {
    vi.stubGlobal('fetch', okFetch());
    const { bootstrap } = await import('../src/dashboard/web/store.js');

    await bootstrap();
    const live = FakeEventSource.instances[0];
    live.open();
    await liveHeartbeats(live, 12);

    expect(live.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('never arms the watchdog on a stream that has not delivered a single frame (buffering proxy)', async () => {
    vi.stubGlobal('fetch', okFetch());
    const { bootstrap } = await import('../src/dashboard/web/store.js');

    await bootstrap();
    const buffered = FakeEventSource.instances[0];
    buffered.open();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(buffered.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('does not kill a healthy stream that a proxy flushes in batches', async () => {
    vi.stubGlobal('fetch', okFetch());
    const { bootstrap } = await import('../src/dashboard/web/store.js');

    await bootstrap();
    const batched = FakeEventSource.instances[0];
    batched.open();
    // 反代每 60s 才放行一次，一次吐出攒下的 4 帧心跳：时间戳相差 15s，到达却在同一刻。
    for (let flush = 0; flush < 6; flush++) {
      await vi.advanceTimersByTimeAsync(60_000);
      const base = Date.now() - 60_000;
      for (let i = 1; i <= 4; i++) batched.emit('heartbeat', { ts: base + i * HEARTBEAT_MS, source: 'dashboard' });
    }

    expect(batched.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('does not treat a single heartbeat as proof that frames flow in real time', async () => {
    vi.stubGlobal('fetch', okFetch());
    const { bootstrap } = await import('../src/dashboard/web/store.js');

    await bootstrap();
    const held = FakeEventSource.instances[0];
    held.open();
    // 反代先放出一帧，之后又把流压住：只凭一帧看不出链路是不是逐帧实时转发。
    held.emit('heartbeat', { ts: Date.now(), source: 'dashboard' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(held.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('judges realtime delivery by the dashboard\'s own heartbeat, not the daemon heartbeats relayed alongside it', async () => {
    vi.stubGlobal('fetch', okFetch());
    const { bootstrap, SSE_STALE_MS } = await import('../src/dashboard/web/store.js');

    await bootstrap();
    const stream = FakeEventSource.instances[0];
    stream.open();
    // 多 bot 机器：每个 daemon 的心跳也经 aggregator 转发，几条挤在同一刻到达。
    for (let round = 0; round < 3; round++) {
      stream.emit('heartbeat', { ts: Date.now(), source: 'dashboard' });
      for (let bot = 0; bot < 3; bot++) stream.emit('heartbeat', { ts: Date.now() + bot });
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    }
    // 链路一直是实时的；之后上游没了，这条流仍得被看门狗换掉。
    await vi.advanceTimersByTimeAsync(SSE_STALE_MS + 10_000);

    expect(stream.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('makes every replacement stream prove itself instead of inheriting the old stream\'s verdict', async () => {
    vi.stubGlobal('fetch', okFetch());
    const { bootstrap, SSE_STALE_MS } = await import('../src/dashboard/web/store.js');

    await bootstrap();
    const zombie = FakeEventSource.instances[0];
    zombie.open();
    await liveHeartbeats(zombie, 2);
    await vi.advanceTimersByTimeAsync(SSE_STALE_MS + 10_000);
    expect(zombie.closed).toBe(true);

    // 新连接 open 了但正文被缓冲：还没证明自己是实时的，不能套用上一条的结论把它反复关掉。
    const buffered = FakeEventSource.instances[1];
    buffered.open();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(buffered.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(2);

    // 它一旦自己证明了实时、随后又断流，照样归看门狗管。
    await liveHeartbeats(buffered, 2);
    await vi.advanceTimersByTimeAsync(SSE_STALE_MS + 10_000);
    expect(buffered.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it('makes a native EventSource retry prove itself again on the same object', async () => {
    vi.stubGlobal('fetch', okFetch());
    const { bootstrap, SSE_STALE_MS } = await import('../src/dashboard/web/store.js');

    await bootstrap();
    const stream = FakeEventSource.instances[0];
    stream.open();
    await liveHeartbeats(stream, 2);
    // 断线后 EventSource 自己重连成功（同一个对象再次 open），新响应的正文被缓冲着。
    stream.fail();
    stream.open();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(stream.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);

    // 新响应自己证明了实时、随后断流：照样归看门狗管。
    await liveHeartbeats(stream, 2);
    await vi.advanceTimersByTimeAsync(SSE_STALE_MS + 10_000);
    expect(stream.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('leaves a CONNECTING stream to EventSource\'s own retry', async () => {
    vi.stubGlobal('fetch', okFetch());
    const { bootstrap } = await import('../src/dashboard/web/store.js');

    await bootstrap();
    const retrying = FakeEventSource.instances[0];
    retrying.open();
    await liveHeartbeats(retrying, 2);
    retrying.fail();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(retrying.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('closes /events once the tab stays hidden, then reconnects and re-syncs at once on return', async () => {
    const doc = new FakeDocument();
    vi.stubGlobal('document', doc);
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { bootstrap, SSE_HIDDEN_SUSPEND_MS } = await import('../src/dashboard/web/store.js');

    await bootstrap();
    const first = FakeEventSource.instances[0];
    first.open();

    doc.setHidden(true);
    await vi.advanceTimersByTimeAsync(SSE_HIDDEN_SUSPEND_MS - 1_000);
    expect(first.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(first.closed).toBe(true);

    // 挂起期间不重连，看门狗也不会把它拉起来。
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(FakeEventSource.instances).toHaveLength(1);

    const fetchesBeforeReturn = sessionFetches(fetchMock);
    doc.setHidden(false);
    expect(FakeEventSource.instances).toHaveLength(2);
    // 快照不等新流 open：缓冲型反代可能一直压着 open，挂起期间的变化得马上补拉。
    await vi.waitFor(() => expect(sessionFetches(fetchMock)).toBe(fetchesBeforeReturn + 1));
  });

  it('relays bots.changed after a reconnect only when the roster digest actually moved', async () => {
    const doc = new FakeDocument();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('fetch', okFetch());
    const { bootstrap, store, SSE_HIDDEN_SUSPEND_MS } = await import('../src/dashboard/web/store.js');
    const botsChanged = vi.fn();
    store.onBotsChanged(botsChanged);

    const suspendAndReturn = async (): Promise<FakeEventSource> => {
      doc.setHidden(true);
      await vi.advanceTimersByTimeAsync(SSE_HIDDEN_SUSPEND_MS);
      doc.setHidden(false);
      const next = FakeEventSource.instances.at(-1)!;
      next.open();
      await vi.advanceTimersByTimeAsync(0);
      return next;
    };

    await bootstrap();
    const first = FakeEventSource.instances[0];
    first.open();
    first.emit('bots.roster', { digest: 'roster-a', phase: 'connect' });
    await vi.advanceTimersByTimeAsync(0);
    // 首连只是记下摘要，不是「漏了变更」。
    expect(botsChanged).not.toHaveBeenCalled();

    // 名册没变：切后台再回来不补发——否则 Bot 配置页重拉会卸掉编辑器、丢未保存草稿。
    (await suspendAndReturn()).emit('bots.roster', { digest: 'roster-a', phase: 'connect' });
    await vi.advanceTimersByTimeAsync(0);
    expect(botsChanged).not.toHaveBeenCalled();

    // 挂起期间名册变了：补发一次。
    const third = await suspendAndReturn();
    third.emit('bots.roster', { digest: 'roster-b', phase: 'connect' });
    await vi.advanceTimersByTimeAsync(0);
    expect(botsChanged).toHaveBeenCalledTimes(1);

    // 实时收到的 bots.changed 也会更新已知摘要，下次重连不重复补发。
    third.emit('bots.changed', { signature: 'x', digest: 'roster-c' });
    await vi.advanceTimersByTimeAsync(0);
    expect(botsChanged).toHaveBeenCalledTimes(2);
    const fourth = await suspendAndReturn();
    fourth.emit('bots.roster', { digest: 'roster-c', phase: 'connect' });
    await vi.advanceTimersByTimeAsync(0);
    expect(botsChanged).toHaveBeenCalledTimes(2);

    // 连接期间 daemon 原地重启（签名没变、代次变了）：live 摘要只同步基线、不触发刷新，
    // 之后挂起再恢复也不会拿着过期基线白白补发。
    fourth.emit('bots.roster', { digest: 'roster-d', phase: 'live' });
    await vi.advanceTimersByTimeAsync(0);
    expect(botsChanged).toHaveBeenCalledTimes(2);
    (await suspendAndReturn()).emit('bots.roster', { digest: 'roster-d', phase: 'connect' });
    await vi.advanceTimersByTimeAsync(0);
    expect(botsChanged).toHaveBeenCalledTimes(2);
  });

  it('relays bots.changed on recovery when the first roster digest never arrived before the stream closed', async () => {
    const doc = new FakeDocument();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('fetch', okFetch());
    const { bootstrap, store, SSE_HIDDEN_SUSPEND_MS } = await import('../src/dashboard/web/store.js');
    const botsChanged = vi.fn();
    store.onBotsChanged(botsChanged);

    await bootstrap();
    FakeEventSource.instances[0].open();
    // 首份摘要被缓冲着没到，标签页就进了后台：断开前手里没有基线。
    doc.setHidden(true);
    await vi.advanceTimersByTimeAsync(SSE_HIDDEN_SUSPEND_MS);
    doc.setHidden(false);
    const recovered = FakeEventSource.instances[1];
    recovered.open();
    recovered.emit('bots.roster', { digest: 'roster-a', phase: 'connect' });
    await vi.advanceTimersByTimeAsync(0);

    // 不知道挂起期间名册变没变，只能当它变了。
    expect(botsChanged).toHaveBeenCalledTimes(1);
  });

  it('treats a native EventSource retry as recovery for the roster baseline', async () => {
    vi.stubGlobal('fetch', okFetch());
    const { bootstrap, store } = await import('../src/dashboard/web/store.js');
    const botsChanged = vi.fn();
    store.onBotsChanged(botsChanged);

    await bootstrap();
    const stream = FakeEventSource.instances[0];
    stream.open();
    // 首份摘要没赶在断线前到达；EventSource 自己重连上之后才收到。
    stream.fail();
    stream.open();
    stream.emit('bots.roster', { digest: 'roster-a', phase: 'connect' });
    await vi.advanceTimersByTimeAsync(0);

    expect(botsChanged).toHaveBeenCalledTimes(1);
  });

  it('keeps the stream across short trips to the background, restarting the countdown each time', async () => {
    const doc = new FakeDocument();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('fetch', okFetch());
    const { bootstrap, SSE_HIDDEN_SUSPEND_MS } = await import('../src/dashboard/web/store.js');

    await bootstrap();
    const stream = FakeEventSource.instances[0];
    stream.open();
    doc.setHidden(true);
    await vi.advanceTimersByTimeAsync(SSE_HIDDEN_SUSPEND_MS / 2);
    doc.setHidden(false);
    await vi.advanceTimersByTimeAsync(SSE_HIDDEN_SUSPEND_MS / 4);
    // 第二次进后台要重新计满整段：上一次的倒计时不能接着走完。
    doc.setHidden(true);
    await vi.advanceTimersByTimeAsync(SSE_HIDDEN_SUSPEND_MS / 2);
    expect(stream.closed).toBe(false);
    doc.setHidden(false);
    await vi.advanceTimersByTimeAsync(SSE_HIDDEN_SUSPEND_MS * 2);

    expect(stream.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('starts the suspend countdown for a tab that was opened in the background', async () => {
    const doc = new FakeDocument();
    doc.hidden = true;
    vi.stubGlobal('document', doc);
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { bootstrap, store, SSE_HIDDEN_SUSPEND_MS } = await import('../src/dashboard/web/store.js');

    await bootstrap();
    // 后台打开也照常装好首份快照，只是不长期占着连接。
    expect(sessionFetches(fetchMock)).toBe(1);
    expect(store.getSnapshot().bootstrapped).toBe(true);
    await vi.advanceTimersByTimeAsync(SSE_HIDDEN_SUSPEND_MS);

    expect(FakeEventSource.instances[0].closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
