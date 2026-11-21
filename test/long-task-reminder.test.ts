import { afterEach, describe, expect, it, vi } from 'vitest';
import { LongTaskReminderController, runningLongTasks } from '../src/core/long-task-reminder.js';
import type { DaemonSession } from '../src/core/types.js';
import { DEFAULT_LONG_TASK_REMINDER, normalizeLongTaskReminderConfig } from '../src/services/long-task-reminder-policy.js';

/** Native execution and clock fixture; no admission-time or idle-time guesses. */
function harness() {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  /** A positively observed native execution on the active worker. */
  const session = {
    session: { sessionId: 's1', status: 'active', workerGeneration: 1 },
    worker: { killed: false }, workerGeneration: 1,
    replyExecutionStarts: new Map([[JSON.stringify(['om_turn', null]), { startedAtMs: 0, workerGeneration: 1 }]]),
  } as unknown as DaemonSession;
  /** Mutable config models immediate console updates. */
  const config = { ...DEFAULT_LONG_TASK_REMINDER, enabled: true };
  /** Registry can remove sessions while an outbound gate is waiting. */
  const sessions = [session];
  /** Provider boundary invokes the real controller's late validation. */
  const send = vi.fn(async (_task, _elapsed, _uuid, beforeWrite) => { beforeWrite(); });
  /** Exercise the production scan engine under a controllable wall clock. */
  const controller = new LongTaskReminderController({
    config: () => config, sessions: () => sessions, canSend: () => true, send, now: Date.now,
  });
  /** Move epoch time directly; scans retain the same production state machine. */
  async function at(minutes: number): Promise<void> {
    vi.setSystemTime(minutes * 60_000);
    await controller.scan();
  }
  return { session, sessions, config, send, controller, at };
}

afterEach(() => { vi.useRealTimers(); });

describe('long task reminder configuration', () => {
  it('accepts valid independent windows and rejects unsafe coercion/bounds', () => {
    expect(normalizeLongTaskReminderConfig({ enabled: true, thresholdMinutes: 10, intervalMinutes: 3 }))
      .toEqual({ enabled: true, thresholdMinutes: 10, intervalMinutes: 3 });
    for (const invalid of [0, -1, 1.5, 10081, NaN, Infinity, '10', undefined]) {
      expect(normalizeLongTaskReminderConfig({ enabled: true, thresholdMinutes: invalid, intervalMinutes: 10 })).toBeUndefined();
      expect(normalizeLongTaskReminderConfig({ enabled: true, thresholdMinutes: 10, intervalMinutes: invalid })).toBeUndefined();
    }
    expect(normalizeLongTaskReminderConfig({ ...DEFAULT_LONG_TASK_REMINDER, enabled: 'true' })).toBeUndefined();
  });
});

describe('long task reminder runtime', () => {
  it('defaults to ten minutes for first and repeated cards', async () => {
    /** Default values are tested through delivery behavior, not constant equality. */
    const h = harness();
    await h.at(9.99);
    expect(h.send).not.toHaveBeenCalled();
    await h.at(10);
    expect(h.send).toHaveBeenCalledTimes(1);
    await h.at(19.99);
    expect(h.send).toHaveBeenCalledTimes(1);
    await h.at(20);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[1][2]).not.toBe(h.send.mock.calls[0][2]);
  });

  it('hot-applies separate windows without resetting execution time on progress or follow-ups', async () => {
    /** A newer admitted message must not steal the running turn's execution clock. */
    const h = harness();
    h.config.thresholdMinutes = 12;
    h.config.intervalMinutes = 3;
    h.session.currentTurnId = 'om_queued_followup';
    h.session.lastMessageAt = 11 * 60_000;
    await h.at(11);
    expect(h.send).not.toHaveBeenCalled();
    await h.at(12);
    expect(h.send.mock.calls[0][0].turnId).toBe('om_turn');
    await h.at(14.99);
    expect(h.send).toHaveBeenCalledTimes(1);
    await h.at(15);
    expect(h.send).toHaveBeenCalledTimes(2);
    h.config.intervalMinutes = 5;
    await h.at(18);
    expect(h.send).toHaveBeenCalledTimes(2);
    await h.at(20);
    expect(h.send).toHaveBeenCalledTimes(3);
  });

  it.each(['terminal', 'cancelled', 'replaced', 'removed', 'disabled', 'queued'])(
    'stops reminders when %s while a provider write is waiting', async reason => {
      /** The provider gate yields before the final source/config revalidation. */
      const h = harness();
      h.send.mockImplementationOnce(async (_task, _elapsed, _uuid, beforeWrite) => {
        switch (reason) {
          case 'terminal': h.session.replyExecutionStarts!.get(JSON.stringify(['om_turn', null]))!.completed = true; break;
          case 'cancelled': h.session.worker!.killed = true; break;
          case 'replaced': h.session.workerGeneration = 2; break;
          case 'removed': h.sessions.length = 0; break;
          case 'disabled': h.config.enabled = false; break;
          case 'queued': h.session.session.queued = true; break;
        }
        beforeWrite();
      });
      await h.at(10);
      await expect(h.send.mock.results[0].value).rejects.toThrow('no_longer_due');
      await h.at(30);
      expect(h.send).toHaveBeenCalledTimes(1);
    },
  );

  it('does not count queued or stale-worker observations as running tasks', () => {
    /** No native input write means no task duration exists yet. */
    const h = harness();
    h.session.replyExecutionStarts!.clear();
    expect(runningLongTasks(h.session)).toEqual([]);
    h.session.replyExecutionStarts!.set(JSON.stringify(['om_old', null]), { startedAtMs: 0, workerGeneration: 0 });
    expect(runningLongTasks(h.session)).toEqual([]);
  });

  it('reuses the unresolved delivery UUID and retries after bounded backoff', async () => {
    /** A failed response may still mean Lark accepted the original UUID. */
    const h = harness();
    h.send.mockRejectedValueOnce(new Error('provider response lost'));
    await h.at(10);
    await h.at(10.5);
    expect(h.send).toHaveBeenCalledTimes(1);
    await h.at(11);
    expect(h.send.mock.calls[1][2]).toBe(h.send.mock.calls[0][2]);
    await h.at(20);
    expect(h.send).toHaveBeenCalledTimes(2);
    await h.at(21);
    expect(h.send).toHaveBeenCalledTimes(3);
  });

  it('serializes overlapping scans and does not burst after missed intervals', async () => {
    /** Hold a genuine pending send while the next periodic scan is invoked. */
    const h = harness();
    /** Deferred completion models a slow outbound provider. */
    let finish!: () => void;
    h.send.mockImplementationOnce(async (_task, _elapsed, _uuid, beforeWrite) => {
      await new Promise<void>(resolve => { finish = resolve; });
      beforeWrite();
    });
    vi.setSystemTime(100 * 60_000);
    /** Keep the first scan alive to test the single-flight gate. */
    const pending = h.controller.scan();
    await h.controller.scan();
    expect(h.send).toHaveBeenCalledTimes(1);
    finish();
    await pending;
    await h.at(100);
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});
