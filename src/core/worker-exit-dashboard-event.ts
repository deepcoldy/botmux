import type { DashboardEvent } from './dashboard-events.js';

/** Worker death releases a process, not the durable conversation. A recoverable
 * active row must stay dormant in both the aggregator and browser cache. */
export function workerExitDashboardEvent(
  sessionId: string, status: 'active' | 'closed', code: number | null,
): DashboardEvent {
  return status === 'active'
    ? { type: 'session.update', body: { sessionId, patch: { status: 'dormant', webPort: null, workerPid: null } } }
    : { type: 'session.exited', body: { sessionId, reason: code === 0 ? 'graceful' : `exit_code_${code}` } };
}
