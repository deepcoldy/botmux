// src/dashboard/aggregator.ts
import type { DaemonInfo } from './registry.js';
import type { DashboardEvent } from '../core/dashboard-events.js';

type Row = { sessionId: string; larkAppId: string; [k: string]: unknown };
type Sched = { id: string; [k: string]: unknown };
const SESSION_PRESENTATION_FIELDS = ['botAvatarUrl', 'repoName', 'gitBranch'] as const;

function mergeSpawnedRow(current: Row | undefined, incoming: Row, larkAppId: string): Row {
  const next: Row = { ...incoming, larkAppId };
  if (current && current.workingDir === next.workingDir) {
    for (const field of SESSION_PRESENTATION_FIELDS) {
      if (next[field] === undefined && current[field] !== undefined) {
        next[field] = current[field];
      }
    }
  }
  return next;
}

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
    let emitted = ev;
    switch (ev.type) {
      case 'session.spawned': {
        const r = ev.body.session as Row;
        const next = mergeSpawnedRow(this.sessions.get(r.sessionId), r, larkAppId);
        this.sessions.set(r.sessionId, next);
        emitted = { ...ev, body: { session: next } };
        break;
      }
      case 'session.update': {
        const cur = this.sessions.get(ev.body.sessionId);
        if (cur) {
          const patch = { ...ev.body.patch };
          if (
            Object.prototype.hasOwnProperty.call(patch, 'workingDir')
            && patch.workingDir !== cur.workingDir
          ) {
            patch.repoName = null;
            patch.gitBranch = null;
          }
          this.sessions.set(ev.body.sessionId, { ...cur, ...patch });
          emitted = { ...ev, body: { ...ev.body, patch } };
        }
        break;
      }
      case 'session.exited': {
        const cur = this.sessions.get(ev.body.sessionId);
        if (cur) this.sessions.set(ev.body.sessionId, { ...cur, status: 'closed' });
        break;
      }
      case 'schedule.created': {
        const schedule = ev.body.schedule as Sched & { larkAppId?: string };
        // Tag ownerless rows with the reporting daemon so scoped reconcile
        // (hydrateSchedules) can account for them.
        this.schedules.set(schedule.id, {
          ...schedule,
          larkAppId: schedule.larkAppId ?? larkAppId,
        });
        break;
      }
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
      try { fn({ ...emitted, larkAppId } as any); } catch { /* swallow */ }
    }
  }

  /** Bulk-load on dashboard start before SSE catches up. Idempotent. */
  hydrateSessions(larkAppId: string, rows: Row[]): void {
    for (const r of rows) {
      this.sessions.set(r.sessionId, mergeSpawnedRow(this.sessions.get(r.sessionId), r, larkAppId));
    }
  }
  /**
   * Per-daemon reconcile for schedules. Upserts `rows` and REMOVES schedules
   * owned by `larkAppId` that are absent from the snapshot: a
   * `schedule.deleted` missed while the SSE stream was down would otherwise
   * ghost forever, since upsert alone can't delete. Schedules owned by other
   * daemons (and ownerless rows) are untouched. Rows missing `larkAppId`
   * are tagged with the hydrating daemon, which is authoritative for them
   * (they came from its /api/schedules).
   */
  hydrateSchedules(larkAppId: string, rows: Sched[]): void {
    const incoming = new Set(rows.map(r => r.id));
    for (const r of rows) {
      const owner = (r as { larkAppId?: string }).larkAppId ?? larkAppId;
      this.schedules.set(r.id, { ...r, larkAppId: owner });
    }
    for (const [id, cur] of this.schedules) {
      if (cur.larkAppId === larkAppId && !incoming.has(id)) this.schedules.delete(id);
    }
  }

  getSessions(): Row[] { return [...this.sessions.values()]; }
  getSession(sessionId: string): Row | undefined { return this.sessions.get(sessionId); }
  getSchedules(): Sched[] { return [...this.schedules.values()]; }

  /** sessionId → owning daemon's larkAppId (used for write routing). */
  ownerOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.larkAppId;
  }

  /** sessionId → owning bot daemon's terminal reverse-proxy port. Used by the
   *  dashboard `/s/*` bridge to route a terminal request to the right daemon's
   *  proxy (each bot daemon runs its own terminal proxy on proxyBasePort+idx).
   *  undefined when the session is unknown or its daemon's proxy isn't up. */
  terminalProxyPortOf(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.proxyPort as number | undefined;
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
 * Auto-reconnects on error OR clean EOF with 1s backoff. Returns an abort
 * function.
 *
 * `onConnected` fires after EVERY successful stream establishment — the first
 * connection included — BEFORE any frame is read, and receives the
 * subscription's abort signal. While it runs, incoming frames stay queued in
 * the stream; once it resolves, reading begins and the queued frames are
 * applied in order. The caller uses it to install an authoritative snapshot
 * (GET /api/sessions) that is therefore at least as fresh as every frame
 * applied afterwards: a slow snapshot response can never clobber state that
 * a faster SSE event already delivered (the reverse race of a naive
 * post-subscribe hydrate). The same barrier on reconnect recovers events
 * missed while the stream was down.
 *
 * The signal is also the generation arbitration: if this subscription is
 * aborted (daemon offline, superseded by a newer generation) while the
 * callback is in flight, the callback MUST discard its result instead of
 * applying it — otherwise the stale generation's snapshot reverse-clobbers
 * the newer one. The callback should fetch with
 * `AbortSignal.any([signal, timeout])` and re-check `signal.aborted` before
 * every aggregator mutation. If `onConnected` throws, frames are still read
 * (best-effort).
 */
export function subscribeDaemon(
  d: DaemonInfo,
  agg: Aggregator,
  onError: (e: Error) => void,
  fetchImpl: typeof fetch = fetch,
  onConnected?: (signal: AbortSignal) => Promise<void> | void,
): () => void {
  const ctrl = new AbortController();
  const url = `http://127.0.0.1:${d.ipcPort}/api/events`;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  // Clear the reconnect backoff immediately on abort so the loop exits
  // without waiting the full second.
  ctrl.signal.addEventListener('abort', () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
  }, { once: true });

  const applyFrame = (evt: string, body: unknown): void => {
    if (evt === 'session.spawned' && d.botAvatarUrl && (body as { session?: unknown })?.session) {
      const session = (body as { session: Record<string, unknown> }).session;
      (body as { session: unknown }).session = { ...session, botAvatarUrl: d.botAvatarUrl };
    }
    agg.applyEvent(d.larkAppId, { type: evt, body } as any);
  };

  (async () => {
    while (!ctrl.signal.aborted) {
      try {
        const res = await fetchImpl(url, { signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`bad status ${res.status}`);

        // Snapshot barrier: install the caller's authoritative snapshot
        // before any frame is applied. Frames arriving during this call
        // remain queued in the stream and are applied afterwards, in order,
        // so the snapshot can never overwrite fresher SSE-delivered state.
        // The subscription signal is passed through as the generation
        // arbitration — the callback must not apply after abort.
        if (onConnected) {
          try {
            await onConnected(ctrl.signal);
          } catch (e) {
            onError(e instanceof Error ? e : new Error(String(e)));
          }
        }
        if (ctrl.signal.aborted) break;

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let evt = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            // Clean EOF of an established stream means the daemon went away.
            // Treat it as a disconnect: fall through to the backoff +
            // barrier re-run path instead of silently tight-looping.
            throw new Error('sse stream ended (clean EOF)');
          }
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.startsWith('event:')) evt = line.slice(6).trim();
            else if (line.startsWith('data:') && evt) {
              const data = line.slice(5).trim();
              try {
                applyFrame(evt, JSON.parse(data));
              } catch {
                // Skip malformed frame
              }
              evt = '';
            }
          }
        }
      } catch (e) {
        if (ctrl.signal.aborted) break;
        onError(e as Error);
        await new Promise(r => { reconnectTimer = setTimeout(r, 1_000); });
        reconnectTimer = undefined;
      }
    }
  })();

  return () => ctrl.abort();
}
