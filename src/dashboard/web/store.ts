import { useSyncExternalStore } from 'react';
import type { Session, Schedule } from './api.js';

class Store {
  sessions = new Map<string, Session>();
  schedules = new Map<string, Schedule>();
  online = true;
  private listeners = new Set<() => void>();
  private version = 0;

  upsertSessions(rows: Session[]) {
    for (const r of rows) this.sessions.set(r.sessionId, r);
    this.emit();
  }
  upsertSchedules(rows: Schedule[]) {
    for (const r of rows) this.schedules.set(r.id, r);
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
    } else {
      return;
    }
    this.emit();
  }
  setOnline(v: boolean) {
    if (this.online !== v) {
      this.online = v;
      this.emit();
    }
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.version;
  private emit() {
    this.version += 1;
    for (const fn of this.listeners) fn();
  }
}

export const store = new Store();

export function useStoreVersion(): number {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export async function bootstrap(): Promise<void> {
  const [s, sch] = await Promise.all([
    fetch('/api/sessions').then((r) => r.json()),
    fetch('/api/schedules').then((r) => r.json()),
  ]);
  store.upsertSessions(s.sessions ?? []);
  store.upsertSchedules(sch.schedules ?? []);

  const es = new EventSource('/events');
  const types = [
    'session.spawned',
    'session.update',
    'session.exited',
    'schedule.created',
    'schedule.updated',
    'schedule.deleted',
    'schedule.fired',
    'heartbeat',
  ];
  for (const t of types) {
    es.addEventListener(t, (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        store.applySse(t, data.body ?? data);
      } catch {
        /* skip malformed */
      }
    });
  }
  es.onerror = () => store.setOnline(false);
  es.onopen = () => store.setOnline(true);
}
