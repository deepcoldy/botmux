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

export async function bootstrap(options: DashboardBootstrapOptions = {}) {
  const canReadSchedules = options.canReadSchedules ?? (() => true);
  // Establish SSE before fetching snapshots, then buffer events while each
  // authoritative snapshot is installed.
  const buffered: Array<{ type: string; body: any }> = [];
  let snapshotReady = false;
  const es = new EventSource('/events');
  const types = [
    'session.spawned', 'session.update', 'session.exited',
    'schedule.created', 'schedule.updated', 'schedule.deleted',
    'schedule.fired', 'schedule.timezone', 'bots.changed', 'heartbeat',
  ];
  for (const type of types) {
    es.addEventListener(type, e => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        const body = data.body ?? data;
        if (snapshotReady) store.applySse(type, body);
        else buffered.push({ type, body });
      } catch { /* skip malformed */ }
    });
  }

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

  es.onerror = () => store.setOnline(false);
  es.onopen = () => {
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

  // Never gate the first snapshot on `onopen`: a buffering reverse proxy can
  // delay the stream indefinitely, and a board with slightly stale rows beats
  // an empty one. On failure the stream is deliberately left open so
  // EventSource keeps retrying on its own and the open handler above recovers
  // without a manual refresh.
  await reconcileSnapshot();
}
