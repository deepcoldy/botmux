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
}

class Store {
  sessions = new Map<string, Session>();
  schedules = new Map<string, Schedule>();
  online = true;
  scheduleTimeZone = '';
  private version = 0;
  private snapshot: StoreSnapshot = {
    sessions: this.sessions,
    schedules: this.schedules,
    online: this.online,
    version: this.version,
    scheduleTimeZone: this.scheduleTimeZone,
  };
  private listeners = new Set<() => void>();
  // Bot roster changes don't live in this cache (the Bot 配置 page owns its own
  // /api/bots fetch), so relay them through a dedicated listener set instead of
  // bumping the snapshot version. Signature-deduped server-side.
  private botsListeners = new Set<() => void>();

  setScheduleTimeZone(tz: string) {
    if (typeof tz === 'string' && tz && this.scheduleTimeZone !== tz) {
      this.scheduleTimeZone = tz;
      this.emit();
    }
  }

  replaceSnapshot(rows: Session[], schedules: Schedule[], scheduleTimeZone?: string) {
    this.sessions.clear();
    for (const row of rows) this.sessions.set(row.sessionId, row);
    this.schedules.clear();
    for (const schedule of schedules) this.schedules.set(schedule.id, schedule);
    if (scheduleTimeZone) this.scheduleTimeZone = scheduleTimeZone;
    this.emit();
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
      return; // heartbeat / schedule.fired — no cache mutation
    }
    this.emit();
  }
  onBotsChanged(fn: () => void) { this.botsListeners.add(fn); return () => this.botsListeners.delete(fn); }
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
    };
    for (const fn of this.listeners) fn();
  }
}

export const store = new Store();

export async function bootstrap() {
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
          const [s, sch] = await Promise.all([
            fetch('/api/sessions').then(r => r.json()),
            fetch('/api/schedules').then(r => r.json()),
          ]);
          store.replaceSnapshot(
            s.sessions ?? [],
            sch.schedules ?? [],
            typeof sch.timezone === 'string' ? sch.timezone : undefined,
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
