// Reactive client cache + SSE consumer for the botmux dashboard SPA.
type Session = Record<string, any> & { sessionId: string; status: string };
type Schedule = Record<string, any> & { id: string };

export interface StoreSnapshot {
  sessions: ReadonlyMap<string, Session>;
  schedules: ReadonlyMap<string, Schedule>;
  online: boolean;
  version: number;
  /** Effective schedule timezone (IANA) the scheduler fires in — used to render
   *  schedule nextRunAt/lastRunAt in the SAME zone regardless of browser zone.
   *  Empty ⇒ fall back to the browser's local zone (legacy behavior). */
  scheduleTimeZone: string;
  /** P1-14：本次身份能否读到排程。Workbench-only（飞书 H5 / 平台 teammate|guest）
   *  身份对 `/api/schedules` 是明确的 401，取不到就是取不到——UI 该隐藏排程区块，
   *  而不是画一个永远为空的面板。false 同时覆盖「没有能力所以没请求」和「请求
   *  失败」两种情况。 */
  schedulesAvailable: boolean;
  /** True once the first authoritative `/api/sessions` snapshot has been
   *  installed. UI uses it to hold a skeleton instead of flashing an empty
   *  list before the bootstrap fetch lands. Stays true forever after. */
  bootstrapped: boolean;
}

class Store {
  sessions = new Map<string, Session>();
  schedules = new Map<string, Schedule>();
  online = true;
  scheduleTimeZone = '';
  schedulesAvailable = true;
  private bootstrapped = false;
  private version = 0;
  private snapshot: StoreSnapshot = {
    sessions: this.sessions,
    schedules: this.schedules,
    online: this.online,
    version: this.version,
    scheduleTimeZone: this.scheduleTimeZone,
    schedulesAvailable: this.schedulesAvailable,
    bootstrapped: false,
  };
  private listeners = new Set<() => void>();
  // Bot roster changes don't live in this cache (the Bot 配置 page owns its own
  // /api/bots fetch), so relay them through a dedicated listener set instead of
  // bumping the snapshot version. Signature-deduped server-side.
  private botsListeners = new Set<() => void>();
  // Run history is intentionally not part of Schedule rows. The schedules page
  // uses this narrow signal to refresh its task-local, read-only log preview.
  private scheduleRunLogListeners = new Set<(taskId?: string) => void>();

  setScheduleTimeZone(tz: string) {
    if (typeof tz === 'string' && tz && this.scheduleTimeZone !== tz) {
      this.scheduleTimeZone = tz;
      this.emit();
    }
  }

  /**
   * `schedules === null` ⇒ 本次身份读不到排程（无能力，或请求 401/403/非 JSON）。
   * 排程表清空并标记 {@link StoreSnapshot.schedulesAvailable} 为 false，但**会话
   * 快照照常落库**——P1-14 的整个要害就是别让排程的失败连累会话列表。
   */
  replaceSnapshot(rows: Session[], schedules: Schedule[] | null, scheduleTimeZone?: string) {
    this.sessions.clear();
    for (const row of rows) this.sessions.set(row.sessionId, row);
    this.schedules.clear();
    for (const schedule of schedules ?? []) this.schedules.set(schedule.id, schedule);
    this.schedulesAvailable = schedules !== null;
    if (scheduleTimeZone) this.scheduleTimeZone = scheduleTimeZone;
    this.bootstrapped = true;
    this.emit();
    if (schedules !== null) {
      for (const fn of this.scheduleRunLogListeners) fn();
    }
  }
  applySse(type: string, body: any) {
    if (type === 'session.spawned') {
      this.sessions.set(body.session.sessionId, body.session);
    } else if (type === 'session.update') {
      const cur = this.sessions.get(body.sessionId);
      if (cur) this.sessions.set(body.sessionId, { ...cur, ...body.patch });
    } else if (type === 'session.exited') {
      const cur = this.sessions.get(body.sessionId);
      if (cur) this.sessions.set(body.sessionId, { ...cur, status: 'closed' });
    } else if (type === 'schedule.created') {
      this.schedules.set(body.schedule.id, body.schedule);
    } else if (type === 'schedule.updated') {
      const cur = this.schedules.get(body.id);
      if (cur) this.schedules.set(body.id, { ...cur, ...body.patch });
    } else if (type === 'schedule.deleted') {
      this.schedules.delete(body.id);
    } else if (type === 'schedule.fired') {
      if (typeof body?.id === 'string') {
        for (const fn of this.scheduleRunLogListeners) fn(body.id);
      }
      return; // history lives behind the task-scoped log endpoint
    } else if (type === 'schedule.timezone') {
      // Effective schedule timezone changed (settings save → daemon realign) —
      // re-render all schedule times in the new zone without a page reload.
      if (typeof body?.timezone === 'string' && body.timezone) this.scheduleTimeZone = body.timezone;
    } else if (type === 'bots.changed') {
      // Bot roster changed (bot added / removed / renamed). Notify subscribers
      // so the Bot 配置 page re-fetches /api/bots without a manual refresh.
      for (const fn of this.botsListeners) fn();
      return; // no snapshot mutation — bots aren't cached here
    } else {
      return; // heartbeat — no cache mutation
    }
    this.emit();
  }
  onBotsChanged(fn: () => void) { this.botsListeners.add(fn); return () => this.botsListeners.delete(fn); }
  onScheduleRunLogsChanged(fn: (taskId?: string) => void) {
    this.scheduleRunLogListeners.add(fn);
    return () => this.scheduleRunLogListeners.delete(fn);
  }
  setOnline(v: boolean) {
    if (this.online !== v) { this.online = v; this.emit(); }
  }
  on(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  getSnapshot(): StoreSnapshot { return this.snapshot; }
  private emit() {
    this.version += 1;
    this.snapshot = {
      sessions: this.sessions,
      schedules: this.schedules,
      online: this.online,
      version: this.version,
      scheduleTimeZone: this.scheduleTimeZone,
      schedulesAvailable: this.schedulesAvailable,
      bootstrapped: this.bootstrapped,
    };
    for (const fn of this.listeners) fn();
  }
}

export const store = new Store();

export interface DashboardBootstrapOptions {
  /**
   * P1-14：本次身份是否具备 `/api/schedules` 读能力。
   *
   * 本机管理身份有；`publicReadOnly` 下的匿名访客有（脱敏版）；**Workbench-only
   * 身份没有**——飞书 H5 会话与平台 teammate/guest 走的是 `decideWorkbenchH5Auth`
   * 窄门禁，排程不在能力表里，服务端明确回 401 + HTML 登录页。所以这里先按能力
   * 决定要不要发这一跳请求，省掉一次注定 401 的往返。
   *
   * 缺省 true 只是保持既有调用方的行为：**无论返回真假，排程都不会拖垮会话
   * 快照**——那条容错在 {@link fetchSchedulesSnapshot} 里兜底。
   */
  canReadSchedules?: () => boolean;
}

interface SchedulesSnapshot {
  schedules: Schedule[];
  timezone?: string;
}

/**
 * 拉排程快照，且**永不 reject**。
 *
 * 这是 P1-14 的修复点：旧代码写 `fetch('/api/schedules').then(r => r.json())` 并
 * 塞进 `Promise.all`，于是 Workbench-only 身份拿到的那份 401 HTML 让 `.json()`
 * 抛 SyntaxError，整个 `Promise.all` 连同已经成功的 `/api/sessions` 一起废掉，
 * `replaceSnapshot` 永远不执行——生产环境的工作台一进去就是空会话列表。
 *
 * 现在任何形式的拿不到（非 2xx、网络错误、响应不是 JSON）统一降级成 `null`，
 * 由调用方标记「排程不可用」，会话快照照常落库。
 */
async function fetchSchedulesSnapshot(): Promise<SchedulesSnapshot | null> {
  try {
    const res = await fetch('/api/schedules');
    if (!res.ok) return null;
    const body = await res.json();
    return {
      schedules: Array.isArray(body?.schedules) ? body.schedules as Schedule[] : [],
      timezone: typeof body?.timezone === 'string' ? body.timezone : undefined,
    };
  } catch {
    return null;
  }
}

// ─── `/events` 的连接寿命 ─────────────────────────────────────────────────────
//
// 经中心化平台访问时，浏览器↔平台目前只协商到 HTTP/1.1，浏览器对同一 host 最多并发
// 6 条连接，而同一台机器的所有标签页共用一个机器子域。每个标签页常驻一条
// `/events`，开到第 7 个页面，它的 HTML / API 就全在浏览器里排队——表现为「新开的
// dashboard 连不上，关掉旧页才好」。下面两条规则让一个标签页只在「流确实活着、
// 确实有人在看」时才占着这条连接。

/**
 * 服务端每 15s 推一帧 `heartbeat`（dashboard.ts 的 `/events`）。OPEN 状态下连续
 * 这么久一帧都没有，就是僵尸流：连接还挂着，上游早没了。典型来源是 daemon 重启时
 * 平台反代没把上游中断传给浏览器——EventSource 自己看不出来，永远不会重连，页面
 * 停在旧数据上，还白占一条连接。
 */
export const SSE_STALE_MS = 45_000;
const SSE_WATCHDOG_TICK_MS = 5_000;
/** 标签页在后台待满这么久就关掉 `/events`；回到前台立即重连并重拉快照。 */
export const SSE_HIDDEN_SUSPEND_MS = 60_000;
/** `EventSource.OPEN`。不读静态常量，测试替身不必实现它。 */
const EVENT_SOURCE_OPEN = 1;

export async function bootstrap(options: DashboardBootstrapOptions = {}) {
  const canReadSchedules = options.canReadSchedules ?? (() => true);
  // Establish SSE before fetching snapshots, then buffer events while each
  // authoritative snapshot is installed.
  const buffered: Array<{ type: string; body: any }> = [];
  let snapshotReady = false;
  const types = [
    'session.spawned', 'session.update', 'session.exited',
    'schedule.created', 'schedule.updated', 'schedule.deleted',
    'schedule.fired', 'schedule.timezone', 'bots.changed', 'bots.roster', 'heartbeat',
  ];

  let syncInFlight: Promise<void> | null = null;
  let requestedReconcile = 0;
  let completedReconcile = 0;
  const reconcileSnapshot = (): Promise<void> => {
    requestedReconcile += 1;
    if (syncInFlight) return syncInFlight;
    syncInFlight = (async () => {
      while (completedReconcile < requestedReconcile) {
        const generation = requestedReconcile;
        snapshotReady = false;
        try {
          // 会话快照是**必需**资源：它失败仍然让 bootstrap reject，EventSource
          // 保持打开、下一次 open 重试（见文件末尾注释与对应测试）。排程是**可选**
          // 资源：拿不到只是这一块降级，绝不能反过来吃掉会话快照。
          const [s, sch] = await Promise.all([
            fetch('/api/sessions').then(r => r.json()),
            canReadSchedules() ? fetchSchedulesSnapshot() : Promise.resolve(null),
          ]);
          store.replaceSnapshot(
            s.sessions ?? [],
            sch ? sch.schedules : null,
            sch?.timezone,
          );
          completedReconcile = generation;
        } finally {
          snapshotReady = true;
          for (const event of buffered.splice(0)) {
            store.applySse(event.type, event.body);
          }
        }
      }
    })().finally(() => {
      syncInFlight = null;
    });
    return syncInFlight;
  };

  // 当前这条流及其活性记录；后台挂起期间为 null。流被替换后，旧流迟到的回调一律按
  // `live !== stream` 丢弃，免得已关掉的连接再改在线状态、往 store 里写帧。
  interface LiveStream {
    source: EventSource;
    /** 恢复出来的连接（看门狗判死 / 回到前台 / EventSource 原生重试），区别于页面打开时的首连。 */
    recovery: boolean;
    opened: boolean;
    lastFrameAt: number;
    lastHeartbeat: { ts: number; at: number } | null;
    /**
     * 看门狗只守**已证明逐帧实时**的流。判据是 dashboard 自己的相邻两帧心跳：到达间隔
     * 与服务端时间戳间隔相当，才说明链路在逐帧转发。缓冲型反代要么一帧不给（永不上岗），
     * 要么攒一批一起放——同一批里相邻心跳到达间隔≈0、时间戳却差 15s，判为非实时并撤岗，
     * 批次之间的静默就不会被当成僵尸。每条流各自重新证明，不继承上一条的结论：换了一条
     * 连接，链路行为未必相同。
     */
    realtime: boolean;
  }
  let live: LiveStream | null = null;
  // 最近一次得知的 Bot 名册摘要（`bots.roster` / `bots.changed` 带来）；null = 还没收到过。
  let rosterDigest: string | null = null;

  const deliver = (type: string, body: any): void => {
    if (snapshotReady) store.applySse(type, body);
    else buffered.push({ type, body });
  };

  const onFrame = (stream: LiveStream, type: string, body: any): void => {
    if (type === 'heartbeat') {
      // 只看 dashboard 自己的心跳：daemon 的心跳也经 aggregator 转发进来，几条挤在同一刻
      // 到达很正常，拿它们比节奏会把实时链路误判成「攒批」。
      const ts = body?.ts;
      if (body?.source === 'dashboard' && typeof ts === 'number') {
        const at = Date.now();
        const prev = stream.lastHeartbeat;
        if (prev && ts > prev.ts) stream.realtime = (at - prev.at) * 2 >= ts - prev.ts;
        stream.lastHeartbeat = { ts, at };
      }
    } else if (type === 'bots.roster') {
      // 服务端每次建流先推一份对账摘要（phase: connect）。Bot 名册不在快照里，断线 /
      // 后台挂起期间漏掉的 `bots.changed` 只能靠比对它补发；没变就不发——Bot 配置页重拉
      // 会卸掉编辑器、丢掉未保存的草稿。恢复时手里还没有基线（首份摘要没赶在断开前到达），
      // 就当它变了。连接期间的 live 摘要只同步基线，不触发刷新。
      const digest = body?.digest;
      if (typeof digest !== 'string') return;
      const changed = body?.phase === 'connect'
        && (rosterDigest === null ? stream.recovery : digest !== rosterDigest);
      rosterDigest = digest;
      if (changed) deliver('bots.changed', body);
      return;
    } else if (type === 'bots.changed' && typeof body?.digest === 'string') {
      rosterDigest = body.digest;
    }
    deliver(type, body);
  };

  const connect = (recovery: boolean): void => {
    const source = new EventSource('/events');
    const stream: LiveStream = {
      source, recovery, opened: false, lastFrameAt: Date.now(), lastHeartbeat: null, realtime: false,
    };
    live = stream;
    for (const type of types) {
      source.addEventListener(type, e => {
        if (live !== stream) return;
        stream.lastFrameAt = Date.now();
        try {
          const data = JSON.parse((e as MessageEvent).data);
          onFrame(stream, type, data.body ?? data);
        } catch { /* skip malformed */ }
      });
    }
    source.onerror = () => {
      if (live === stream) store.setOnline(false);
    };
    source.onopen = () => {
      if (live !== stream) return;
      // EventSource 原生重试复用同一个对象、再触发一次 open：这是一次新的 HTTP 响应，
      // 活性证据得从头来过，不能拿上一次响应的心跳当证明；名册补发也按恢复处理。
      if (stream.opened) stream.recovery = true;
      stream.opened = true;
      stream.realtime = false;
      stream.lastHeartbeat = null;
      stream.lastFrameAt = Date.now();
      store.setOnline(true);
      // Reconcile on EVERY open, first one included. Constructing an EventSource
      // does not mean the server-side listener exists yet, so a snapshot taken
      // before this point can miss whatever happened in that window; a reconnect
      // can additionally miss deletes, which only a fresh snapshot converges.
      // reconcileSnapshot coalesces, so overlapping calls collapse into one extra
      // round instead of a fetch per event.
      void reconcileSnapshot().catch(() => {
        // The live stream remains useful; the next open retries the snapshot.
      });
    };
  };
  const disconnect = (): void => {
    const stream = live;
    live = null;
    stream?.source.close();
  };
  // 重新建流（看门狗判死 / 回到前台）。快照不等新流 open：缓冲型反代可以把 open 一直
  // 压着，挂起或僵尸期间漏掉的变化得马上补拉；open 之后那一轮对齐照旧，兜住订阅建立
  // 之前的竞态。
  const reconnect = (): void => {
    connect(true);
    void reconcileSnapshot().catch(() => {
      // The next open retries the snapshot.
    });
  };

  connect(false);

  setInterval(() => {
    const stream = live;
    if (!stream || !stream.realtime || stream.source.readyState !== EVENT_SOURCE_OPEN) return;
    if (Date.now() - stream.lastFrameAt < SSE_STALE_MS) return;
    // close() 会中止那条挂死的请求、把连接还给浏览器。
    disconnect();
    store.setOnline(false);
    reconnect();
  }, SSE_WATCHDOG_TICK_MS);

  if (typeof document !== 'undefined') {
    let suspendTimer: ReturnType<typeof setTimeout> | null = null;
    const onVisibilityChange = (): void => {
      if (document.hidden) {
        if (live && !suspendTimer) {
          suspendTimer = setTimeout(() => {
            suspendTimer = null;
            // 挂起是主动的，不翻 online：后台页没人看，回前台立刻重连，翻了
            // 只会在切回来的那一下闪一次「离线」。重连失败自有 onerror 去翻。
            if (document.hidden) disconnect();
          }, SSE_HIDDEN_SUSPEND_MS);
        }
        return;
      }
      if (suspendTimer) {
        clearTimeout(suspendTimer);
        suspendTimer = null;
      }
      if (!live) reconnect();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    // 在后台打开的标签页（中键 / 恢复会话）同样要计时。
    onVisibilityChange();
  }

  // Never gate the first snapshot on `onopen`: a buffering reverse proxy can
  // delay the stream indefinitely, and a board with slightly stale rows beats
  // an empty one. On failure the stream is deliberately left open so
  // EventSource keeps retrying on its own and the open handler above recovers
  // without a manual refresh.
  await reconcileSnapshot();
}
