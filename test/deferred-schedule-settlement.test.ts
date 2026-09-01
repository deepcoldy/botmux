import { describe, expect, it, vi } from 'bun:test';
import { settleDeferredScheduleRun } from '../src/core/deferred-schedule-settlement.js';
import type { DaemonSession } from '../src/core/types.js';

function makeSession(): DaemonSession {
  return {
    session: {
      sessionId: 'sess-deferred',
      chatId: 'oc_chat',
      rootMessageId: 'schedule-run:task-1:run-1',
      title: 'hidden schedule',
      status: 'active',
      createdAt: '2026-07-21T00:00:00.000Z',
      scope: 'chat',
      deferredScheduleRun: {
        taskId: 'task-1',
        turnId: 'schedule:task-1:run-1',
        routingAnchor: 'schedule-run:task-1:run-1',
        createdAt: '2026-07-21T00:00:00.000Z',
      },
    },
    scope: 'chat',
    chatId: 'oc_chat',
    larkAppId: 'cli_app',
    lastScreenStatus: 'idle',
  } as DaemonSession;
}

describe('deferred schedule turn settlement', () => {
  it('auto-closes an unmaterialized hidden run at exact terminal completion', async () => {
    const closeSession = vi.fn(async () => ({ ok: true as const }));
    const result = await settleDeferredScheduleRun(makeSession(), {
      turnId: 'schedule:task-1:run-1', source: 'terminal',
    }, { reconcile: () => undefined, closeSession });

    expect(result).toEqual({ action: 'closed' });
    expect(closeSession).toHaveBeenCalledWith('sess-deferred');
  });

  it('retains a materialized session for human follow-ups', async () => {
    const closeSession = vi.fn(async () => ({ ok: true as const }));
    const result = await settleDeferredScheduleRun(makeSession(), {
      turnId: 'schedule:task-1:run-1', source: 'terminal',
    }, { reconcile: () => 'om_materialized', closeSession });

    expect(result).toEqual({ action: 'materialized', rootMessageId: 'om_materialized' });
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('ignores stale turn edges and non-idle screen fallbacks', async () => {
    const ds = makeSession();
    ds.lastScreenStatus = 'working';
    const closeSession = vi.fn(async () => ({ ok: true as const }));
    const deps = { reconcile: vi.fn(() => undefined), closeSession };

    expect(await settleDeferredScheduleRun(ds, {
      turnId: 'schedule:task-1:stale', source: 'terminal',
    }, deps)).toEqual({ action: 'ignored' });
    expect(await settleDeferredScheduleRun(ds, {
      turnId: 'schedule:task-1:run-1', source: 'idle',
    }, deps)).toEqual({ action: 'ignored' });
    expect(deps.reconcile).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
  });


  it('does NOT report closed when the close is refused', async () => {
    // A refused close leaves the row ACTIVE. Reporting it as `closed` is the same
    // false success this work removes, only at the settlement seam — and the
    // daemon would then log "Auto-closed" for a session that is still running.
    const closeSession = vi.fn(async () => ({ ok: false as const, error: 'mojo_cancel_failed' }));

    const result = await settleDeferredScheduleRun(makeSession(), {
      turnId: 'schedule:task-1:run-1', source: 'terminal',
    }, { reconcile: () => undefined, closeSession });

    expect(closeSession).toHaveBeenCalledWith('sess-deferred');
    expect(result).toEqual({ action: 'close_refused', error: 'mojo_cancel_failed' });
  });
});
