// src/core/dashboard-events.ts
import { logger } from '../utils/logger.js';

/** Event union — every payload is JSON-serialisable. */
export type DashboardEvent =
  | { type: 'session.spawned';   body: { session: any /* SessionRow */ } }
  | { type: 'session.update';    body: { sessionId: string; patch: Record<string, any> } }
  | { type: 'session.exited';    body: { sessionId: string; reason?: string } }
  | { type: 'schedule.created';  body: { schedule: any /* ScheduleRow */ } }
  | { type: 'schedule.updated';  body: { id: string; patch: Record<string, any> } }
  | { type: 'schedule.deleted';  body: { id: string } }
  | { type: 'schedule.fired';    body: { id: string; runAt: number; status: 'ok'|'error'; error?: string } }
  | { type: 'schedule.timezone'; body: { timezone: string } }
  | { type: 'heartbeat';         body: { ts: number } };

export type Subscriber = (event: DashboardEvent) => void;

export class DashboardEventBus {
  private subs = new Set<Subscriber>();

  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  publish(event: DashboardEvent): void {
    for (const fn of this.subs) {
      try { fn(event); } catch (err) {
        // Subscriber errors must not break publishing.
        logger.error(`[dashboard-events] subscriber threw: ${err}`);
      }
    }
  }
}

/** Process-wide singleton — daemon publishers and IPC SSE handler share. */
export const dashboardEventBus = new DashboardEventBus();
