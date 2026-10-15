import { afterEach, describe, expect, it } from 'vitest';
import { workerExitDashboardEvent } from '../src/core/worker-exit-dashboard-event.js';
import { Aggregator } from '../src/dashboard/aggregator.js';
import { store } from '../src/dashboard/web/store.js';

afterEach(() => store.sessions.clear());
describe('worker exit lifecycle projection', () => {
  it.each([0, 1, null])('keeps an active conversation dormant after worker exit %s in both caches', code => {
    const row = { sessionId: 'sid', status: 'idle', webPort: 1234, workerPid: 5678 };
    const aggregator = new Aggregator();
    aggregator.applyEvent('app', { type: 'session.spawned', body: { session: { ...row } } });
    store.applySse('session.spawned', { session: { ...row } });
    const event = workerExitDashboardEvent('sid', 'active', code);
    aggregator.applyEvent('app', event); store.applySse(event.type, event.body);
    expect(aggregator.getSessions()[0]).toMatchObject({ sessionId: 'sid', status: 'dormant', webPort: null, workerPid: null });
    expect(store.sessions.get('sid')).toMatchObject({ status: 'dormant', webPort: null, workerPid: null });
  });
  it('preserves a real close and never reopens it as dormant', () => {
    const aggregator = new Aggregator();
    aggregator.applyEvent('app', { type: 'session.spawned', body: { session: { sessionId: 'sid', status: 'idle' } } });
    const event = workerExitDashboardEvent('sid', 'closed', 0);
    expect(event.type).toBe('session.exited'); aggregator.applyEvent('app', event);
    expect(aggregator.getSessions()[0].status).toBe('closed');
  });
});
