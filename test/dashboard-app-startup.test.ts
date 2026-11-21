import { describe, expect, it, vi } from 'vitest';
import { runDashboardStartup } from '../src/dashboard/web/app-startup.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('Dashboard startup orchestration', () => {
  it('runs deferred work and roster invalidation while bootstrap is still pending', async () => {
    const route = deferred();
    const boot = deferred();
    const events: string[] = [];
    let deferredTask: (() => void) | undefined;
    let rosterListener: (() => void) | undefined;
    let listenerAtRoute: (() => void) | undefined;
    let deferredAtBootstrap: (() => void) | undefined;
    let settled = false;
    const startup = runDashboardStartup({
      route: () => {
        events.push('route');
        listenerAtRoute = rosterListener;
        return route.promise;
      },
      bootstrap: () => {
        events.push('bootstrap');
        deferredAtBootstrap = deferredTask;
        return boot.promise;
      },
      afterNextPaint: task => { deferredTask = task; events.push('defer'); },
      optional: () => { events.push('optional'); },
      onBotsChanged: listener => { rosterListener = listener; events.push('listen'); },
      reloadNameMaps: () => { events.push('reload-names'); },
      onBootstrapError: error => { throw error; },
    });
    void startup.then(() => { settled = true; });

    try {
      expect(listenerAtRoute).toBeTypeOf('function');
      expect(deferredAtBootstrap).toBeTypeOf('function');
      rosterListener?.();
      deferredTask?.();
      expect(events).toContain('reload-names');
      expect(events).toContain('optional');
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      boot.resolve();
      route.resolve();
      await startup;
    }
  });

  it('keeps the existing bootstrap failure degradation and waits for the route', async () => {
    const failure = new Error('snapshot unavailable');
    const onBootstrapError = vi.fn();
    await runDashboardStartup({
      route: async () => {},
      bootstrap: async () => { throw failure; },
      afterNextPaint: task => { task(); },
      optional: vi.fn(),
      onBotsChanged: vi.fn(),
      reloadNameMaps: vi.fn(),
      onBootstrapError,
    });
    expect(onBootstrapError).toHaveBeenCalledWith(failure);
  });
});
