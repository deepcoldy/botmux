import { afterEach, describe, expect, it, vi } from 'vitest';

import { dashboardEventBus, type DashboardEvent } from '../src/core/dashboard-events.js';
import { repinSessionWorkingDir } from '../src/core/session-cwd.js';
import type { DaemonSession } from '../src/core/types.js';
import * as sessionStore from '../src/services/session-store.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('repinSessionWorkingDir', () => {
  it('publishes the canonical workingDir update after persisting it', () => {
    const updateSession = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    const events: DashboardEvent[] = [];
    const off = dashboardEventBus.subscribe(event => events.push(event));
    const ds = {
      workingDir: '/repo/old',
      session: {
        sessionId: 'session-one',
        workingDir: '/repo/old',
        riffRepoDirs: ['/repo/old'],
      },
    } as DaemonSession;

    try {
      repinSessionWorkingDir(ds, '/repo/new');
    } finally {
      off();
    }

    expect(ds.workingDir).toBe('/repo/new');
    expect(ds.session.workingDir).toBe('/repo/new');
    expect(ds.session.riffRepoDirs).toBeUndefined();
    expect(updateSession).toHaveBeenCalledWith(ds.session);
    expect(events).toContainEqual({
      type: 'session.update',
      body: {
        sessionId: 'session-one',
        patch: { workingDir: '/repo/new' },
      },
    });
  });

  it('does not publish an in-memory cwd when persistence fails', () => {
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {
      throw new Error('disk unavailable');
    });
    const events: DashboardEvent[] = [];
    const off = dashboardEventBus.subscribe(event => events.push(event));
    const ds = {
      workingDir: '/repo/old',
      session: { sessionId: 'session-one', workingDir: '/repo/old' },
    } as DaemonSession;

    try {
      expect(() => repinSessionWorkingDir(ds, '/repo/new')).toThrow('disk unavailable');
    } finally {
      off();
    }

    expect(events).toEqual([]);
  });
});
