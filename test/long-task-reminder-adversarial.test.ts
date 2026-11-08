import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';

/** The remote provider and configured outbound hook are the only side-effect spies. */
const remote = vi.hoisted(() => ({ create: vi.fn(), hook: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({
  getBotClient: () => ({ im: { v1: { message: { create: remote.create } } } }),
  getBot: () => ({ config: { cliId: 'codex', larkAppId: 'cli_probe' } }),
  getAllBots: () => [], loadBotConfigs: () => [], formatLarkError: String,
}));
vi.mock('../src/services/hook-runner.js', () => ({ emitHookEvent: remote.hook }));
vi.mock('../src/services/group-context-settings-store.js', () => ({ getGroupContextSettings: () => ({ enabled: false }) }));

import { LongTaskReminderController } from '../src/core/long-task-reminder.js';
import { sendLongTaskReminder } from '../src/services/long-task-reminder-notification.js';
import { armSilentScheduledTurn } from '../src/core/silent-schedule-turns.js';
import { __testOnly_resetLarkGate } from '../src/im/lark/api-gate.js';
import { canSendLongTaskReminder } from '../src/core/long-task-reminder-eligibility.js';

/** Drive the production controller and transport under a Date-only fake clock. */
function runtime() {
  /** The original group is real, even when the exact turn is silent. */
  const ds = {
    larkAppId: 'cli_probe', chatId: 'oc_probe', scope: 'chat',
    worker: { killed: false }, workerGeneration: 1,
    session: { sessionId: 's_probe', status: 'active', workerGeneration: 1, title: 'task',
      turnReplyContexts: { om_turn: { target: { mode: 'plain', chatId: 'oc_probe' } } } },
    replyExecutionStarts: new Map([[JSON.stringify(['om_turn', 1]), { startedAtMs: 0, workerGeneration: 1 }]]),
  } as unknown as DaemonSession;
  /** Hot settings simulate writes made while the provider is waiting. */
  const config = { enabled: true, thresholdMinutes: 10, intervalMinutes: 10 };
  /** This is exactly the daemon's current destination predicate. */
  const controller = new LongTaskReminderController({ config: () => config, sessions: () => [ds],
    canSend: canSendLongTaskReminder,
    send: sendLongTaskReminder, now: Date.now });
  return { ds, config, controller };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(0);
  vi.stubEnv('BOTMUX_LARK_QPS', '100000');
  __testOnly_resetLarkGate();
  remote.create.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_notice' } });
  remote.hook.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  __testOnly_resetLarkGate();
});

describe('independent long-task notification boundary probes', () => {
  it.each(['silent', 'suppressed-attempt', 'meeting-driven'] as const)('does not publish a %s turn through an auxiliary notification', async reason => {
    /** Silent schedule admission is the existing production suppression component. */
    const h = runtime();
    if (reason === 'silent') {
      armSilentScheduledTurn(h.ds, 'om_turn');
    } else if (reason === 'suppressed-attempt') {
      h.ds.suppressedFinalOutputTurns = new Map([['om_turn', 1]]);
    } else {
      h.ds.session.vcMeetingReceiver = {} as any;
    }
    vi.setSystemTime(10 * 60_000);
    expect(canSendLongTaskReminder(h.ds, 'om_turn', 1)).toBe(false);
    await h.controller.scan();
    expect(remote.create).not.toHaveBeenCalled();
  });

  it('does not execute ordinary outbound hooks for operational reminders', async () => {
    /** Reminder cards should not run commands configured for model-authored replies. */
    const h = runtime();
    vi.setSystemTime(10 * 60_000);
    await h.controller.scan();
    expect(remote.create).toHaveBeenCalledOnce();
    expect(remote.hook).not.toHaveBeenCalled();
  });

  it('stops at the provider boundary after configuration is disabled', async () => {
    /** Wrapper models a pending gate before the real client receives the write. */
    const h = runtime();
    /** Hold one pending operation across repeated scans. */
    let resume!: () => void;
    /** Count boundary entries independently of provider IO, which remains blocked. */
    const beforeGate = vi.fn();
    /** A second controller uses the exact same live runtime, only adding a deferred gate. */
    const gated = new LongTaskReminderController({ config: () => h.config, sessions: () => [h.ds], canSend: () => true,
      now: Date.now, send: async (...args) => {
        beforeGate();
        await new Promise<void>(resolve => { resume = resolve; });
        await sendLongTaskReminder(...args);
      } });
    vi.setSystemTime(10 * 60_000);
    /** The first tick remains pending while the user changes preferences. */
    const pending = gated.scan();
    /** Keep the overlapping promise observable without waiting on an accidental second gate. */
    const overlapping = gated.scan();
    expect(beforeGate).toHaveBeenCalledOnce();
    await overlapping;
    h.config.enabled = false;
    vi.setSystemTime(100 * 60_000);
    resume();
    await pending;
    expect(remote.create).not.toHaveBeenCalled();
  });

  it('reuses the same provider UUID after an ambiguous write and honors retry backoff', async () => {
    /** Simulate accepted-at-provider but the first response was lost. */
    const h = runtime();
    remote.create.mockRejectedValueOnce(new Error('response lost'));
    vi.setSystemTime(10 * 60_000);
    await h.controller.scan();
    vi.setSystemTime(10.5 * 60_000);
    await h.controller.scan();
    expect(remote.create).toHaveBeenCalledOnce();
    vi.setSystemTime(11 * 60_000);
    await h.controller.scan();
    expect(remote.create).toHaveBeenCalledTimes(2);
    expect(remote.create.mock.calls[1][0].data.uuid).toBe(remote.create.mock.calls[0][0].data.uuid);
    vi.setSystemTime(20 * 60_000);
    await h.controller.scan();
    expect(remote.create).toHaveBeenCalledTimes(2);
  });
});
