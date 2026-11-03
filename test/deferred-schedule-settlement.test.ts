import { describe, expect, it, vi } from 'vitest';
import {
  noteDeferredScheduleRunFailure,
  reportUndeliveredScheduleRun,
  SCHEDULE_PROMPT_UNDELIVERED_ERROR_CODE,
  settleDeferredScheduleRun,
} from '../src/core/deferred-schedule-settlement.js';
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

  it('closes a run whose prompt never reached the CLI as undelivered, also when its idle settles it', async () => {
    // The worker reports the undelivered prompt as a failed terminal and then
    // releases its idle; the idle re-arms settlement with its own context.
    const ds = makeSession();
    const closeSession = vi.fn(async () => ({ ok: true as const }));
    noteDeferredScheduleRunFailure(ds, {
      turnId: 'schedule:task-1:run-1', errorCode: SCHEDULE_PROMPT_UNDELIVERED_ERROR_CODE,
    });
    noteDeferredScheduleRunFailure(ds, { turnId: 'schedule:task-1:run-1' });

    const result = await settleDeferredScheduleRun(ds, {
      turnId: 'schedule:task-1:run-1', source: 'idle',
    }, { reconcile: () => undefined, closeSession });

    expect(result).toEqual({ action: 'closed', undelivered: true });
    expect(closeSession).toHaveBeenCalledWith('sess-deferred');
  });

  it('keeps an ordinary failed or completed run a plain close', async () => {
    const ds = makeSession();
    noteDeferredScheduleRunFailure(ds, { turnId: 'schedule:task-1:run-1', errorCode: 'api_error' });
    const closeSession = vi.fn(async () => ({ ok: true as const }));

    expect(await settleDeferredScheduleRun(ds, {
      turnId: 'schedule:task-1:run-1', source: 'terminal',
    }, { reconcile: () => undefined, closeSession })).toEqual({ action: 'closed' });
  });
});

describe('undelivered hidden run report', () => {
  const run = {
    taskId: 'task-1',
    turnId: 'schedule:task-1:run-1',
    routingAnchor: 'schedule-run:task-1:run-1',
    createdAt: '2026-07-21T00:00:00.000Z',
    runId: 'run-1',
  };

  it('turns the run log record into an error and tells the chat', async () => {
    const markRunLogUndelivered = vi.fn(() => true);
    const notifyChat = vi.fn(async () => 'om_notice');
    const warn = vi.fn();

    await reportUndeliveredScheduleRun(run, { markRunLogUndelivered, notifyChat, warn });

    expect(markRunLogUndelivered).toHaveBeenCalledWith('task-1', 'run-1');
    expect(notifyChat).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('still tells the chat when the run log cannot be updated, and says why', async () => {
    const notifyChat = vi.fn(async () => 'om_notice');
    const warn = vi.fn();

    await reportUndeliveredScheduleRun(run, {
      markRunLogUndelivered: () => { throw new Error('disk full'); },
      notifyChat,
      warn,
    });
    await reportUndeliveredScheduleRun({ ...run, runId: undefined }, {
      markRunLogUndelivered: () => { throw new Error('must not be asked without a run id'); },
      notifyChat,
      warn,
    });

    expect(notifyChat).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('disk full');
  });

  it('keeps the run log update when the chat notice fails', async () => {
    const markRunLogUndelivered = vi.fn(() => true);
    const warn = vi.fn();

    await reportUndeliveredScheduleRun(run, {
      markRunLogUndelivered,
      notifyChat: async () => { throw new Error('lark 500'); },
      warn,
    });

    expect(markRunLogUndelivered).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('lark 500');
  });
});
