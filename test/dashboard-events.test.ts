// test/dashboard-events.test.ts
import { describe, it, expect, vi } from 'bun:test';
import { DashboardEventBus, type DashboardEvent } from '../src/core/dashboard-events.js';

describe('DashboardEventBus', () => {
  it('delivers published events to subscribers', () => {
    const bus = new DashboardEventBus();
    const seen: DashboardEvent[] = [];
    bus.subscribe(e => seen.push(e));
    bus.publish({ type: 'heartbeat', body: { ts: 1 } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ type: 'heartbeat', body: { ts: 1 } });
  });

  it('removes subscriber on unsubscribe and stops delivering', () => {
    const bus = new DashboardEventBus();
    const fn = vi.fn();
    const off = bus.subscribe(fn);
    off();
    bus.publish({ type: 'heartbeat', body: { ts: 2 } });
    expect(fn).not.toHaveBeenCalled();
  });

  it('isolates subscriber errors so other subscribers still receive', () => {
    const bus = new DashboardEventBus();
    bus.subscribe(() => { throw new Error('boom'); });
    const ok = vi.fn();
    bus.subscribe(ok);
    expect(() => bus.publish({ type: 'heartbeat', body: { ts: 3 } })).not.toThrow();
    expect(ok).toHaveBeenCalledOnce();
  });
});
