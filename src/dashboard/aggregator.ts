// src/dashboard/aggregator.ts
import type { DaemonInfo } from './registry.js';
import type { DashboardEvent } from '../core/dashboard-events.js';

type Row = { sessionId: string; larkAppId: string; [k: string]: unknown };
type Sched = { id: string; [k: string]: unknown };

/**
 * Aggregates session and schedule state across all online daemons.
 * Pure state machine — no I/O. The dashboard process feeds it events from
 * each daemon's SSE stream (via subscribeDaemon below) and from initial
 * hydration calls (via GET /api/sessions /api/schedules).
 */
export class Aggregator {
  private sessions = new Map<string, Row>();
  private schedules = new Map<string, Sched>();
  private listeners = new Set<(e: DashboardEvent & { larkAppId: string }) => void>();

  applyEvent(larkAppId: string, ev: DashboardEvent): void {
    switch (ev.type) {
      case 'session.spawned': {
        const r = ev.body.session as Row;
        this.sessions.set(r.sessionId, { ...r, larkAppId });
        break;
      }
      case 'session.update': {
        const cur = this.sessions.get(ev.body.sessionId);
        if (cur) this.sessions.set(ev.body.sessionId, { ...cur, ...ev.body.patch });
        break;
      }
      case 'session.exited': {
        const cur = this.sessions.get(ev.body.sessionId);
        if (cur) this.sessions.set(ev.body.sessionId, { ...cur, status: 'closed' });
        break;
      }
      case 'schedule.created':
        this.schedules.set((ev.body.schedule as Sched).id, ev.body.schedule as Sched);
        break;
      case 'schedule.updated': {
        const cur = this.schedules.get(ev.body.id);
        if (cur) this.schedules.set(ev.body.id, { ...cur, ...ev.body.patch });
        break;
      }
      case 'schedule.deleted':
        this.schedules.delete(ev.body.id);
        break;
      // schedule.fired and heartbeat are pass-through (no cache mutation)
    }
    for (const fn of this.listeners) {
      try { fn({ ...ev, larkAppId } as any); } catch { /* swallow */ }
    }
  }

  /** Bulk-load on dashboard start before SSE catches up. Idempotent. */
  hydrateSessions(larkAppId: string, rows: Row[]): void {
    for (const r of rows) this.sessions.set(r.sessionId, { ...r, larkAppId });
  }
  hydrateSchedules(rows: Sched[]): void {
    for (const r of rows) this.schedules.set(r.id, r);
  }

  getSessions(): Row[] { return [...this.sessions.values()]; }
  getSchedules(): Sched[] { return [...this.schedules.values()]; }

  /** sessionId → owning daemon's larkAppId (used for write routing). */
  ownerOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.larkAppId;
  }

  /** Whether a session row with this id exists at all in the aggregator,
   *  regardless of `larkAppId` presence. Mirrors `scheduleExists`; lets
   *  the Route B write gate tell apart "legacy row with no owner" from
   *  "unknown id" so the close/resume/locate handler can route legacy rows
   *  to the caller's bot instead of 404'ing them. */
  sessionExists(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }
  scheduleOwnerOf(id: string): string | undefined {
    return (this.schedules.get(id) as { larkAppId?: string } | undefined)?.larkAppId;
  }

  /** Whether a schedule row with this id exists at all in the aggregator,
   *  regardless of `larkAppId` presence. Used by the Route B write gate to
   *  distinguish a "legacy row with no owner" from a genuinely "unknown id"
   *  — the former should still proxy somewhere (the caller's bot), the
   *  latter is a 404 (codex 2026-06-10 schedules slice 2a blocker). */
  scheduleExists(id: string): boolean {
    return this.schedules.has(id);
  }

  on(fn: (e: DashboardEvent & { larkAppId: string }) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/**
 * Subscribe to one daemon's SSE stream and feed events into the aggregator.
 * Auto-reconnects on error with 1s backoff. Returns an abort function.
 */
export function subscribeDaemon(
  d: DaemonInfo,
  agg: Aggregator,
  onError: (e: Error) => void,
): () => void {
  const ctrl = new AbortController();
  const url = `http://127.0.0.1:${d.ipcPort}/api/events`;

  (async () => {
    while (!ctrl.signal.aborted) {
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`bad status ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let evt = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.startsWith('event:')) evt = line.slice(6).trim();
            else if (line.startsWith('data:') && evt) {
              const data = line.slice(5).trim();
              try {
                const body = JSON.parse(data);
                agg.applyEvent(d.larkAppId, { type: evt, body } as any);
              } catch {
                // Skip malformed frame
              }
              evt = '';
            }
          }
        }
      } catch (e) {
        if (!ctrl.signal.aborted) onError(e as Error);
        await new Promise(r => setTimeout(r, 1_000));
      }
    }
  })();

  return () => ctrl.abort();
}
