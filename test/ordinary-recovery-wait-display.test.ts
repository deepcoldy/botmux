/**
 * What a person sees while an ordinary-turn recovery waits for the provider:
 * the live status card is PATCHed whenever the wait starts, moves or ends, and
 * the one "waiting for the provider" notice is checked again right before it
 * is written (a recovery that moved on in between must not announce a wait).
 * Production closures from worker-pool.ts run with explicit host stubs.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../src/i18n/index.js';
import { formatClockTime } from '../src/utils/clock-time.js';
import type { OrdinaryTurnRecoveryState } from '../src/services/ordinary-turn-recovery.js';
import { loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';

const NOW = Date.parse('2026-11-13T11:08:19.343Z');

function backoff(over: Partial<OrdinaryTurnRecoveryState> = {}): OrdinaryTurnRecoveryState {
  return {
    logicalTurnId: 'om_task', currentTurnId: 'om_task', continuationsStarted: 0, status: 'backoff',
    nextAttemptAt: NOW + 120_000, providerRetryAt: NOW + 117_000, windowEndsAt: NOW + 55 * 60_000,
    windowMinutes: 55, windowFollowsCache: true,
    ...over,
  };
}

describe('live status card while a continuation waits', () => {
  function harness() {
    const scope: Record<string, any> = {
      ordinaryRecoveryWaitCardKeys: new WeakMap(),
      scheduleActiveRuntimePatch: vi.fn(),
      logger: { warn: vi.fn() },
      tag: () => 'test',
    };
    const refresh = loadWorkerPoolFunction<(ds: any) => void>('refreshOrdinaryRecoveryWaitCard', scope);
    const ds: any = { session: {} };
    return { scope, refresh, ds };
  }

  it('is patched when the wait starts, moves and ends — and not on writes that change none of that', () => {
    const { scope, refresh, ds } = harness();
    ds.session.ordinaryTurnRecovery = { ...backoff(), status: 'running', nextAttemptAt: undefined };
    refresh(ds);
    expect(scope.scheduleActiveRuntimePatch).not.toHaveBeenCalled();
    ds.session.ordinaryTurnRecovery = backoff();
    refresh(ds);
    refresh(ds);
    expect(scope.scheduleActiveRuntimePatch).toHaveBeenCalledTimes(1);
    ds.session.ordinaryTurnRecovery = backoff({ nextAttemptAt: NOW + 300_000 });
    refresh(ds);
    expect(scope.scheduleActiveRuntimePatch).toHaveBeenCalledTimes(2);
    ds.session.ordinaryTurnRecovery = { ...backoff(), status: 'dispatching', nextAttemptAt: undefined };
    refresh(ds);
    ds.session.ordinaryTurnRecovery = { ...backoff(), status: 'running', nextAttemptAt: undefined };
    refresh(ds);
    expect(scope.scheduleActiveRuntimePatch).toHaveBeenCalledTimes(3);
  });

  it('never lets a failed PATCH escape into the recovery write', () => {
    const { scope, refresh, ds } = harness();
    scope.scheduleActiveRuntimePatch.mockImplementation(() => { throw new Error('card gone'); });
    ds.session.ordinaryTurnRecovery = backoff();
    expect(() => refresh(ds)).not.toThrow();
    expect(scope.logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('the waiting notice', () => {
  function harness(stillOwns = true) {
    const sessionReply = vi.fn(async (..._args: unknown[]) => 'om_notice');
    const scope: Record<string, any> = {
      localeForBot: () => 'zh',
      tr: t,
      sessionCliDisplayName: () => 'Claude',
      formatClockTime,
      ordinaryRecoveryWindowNote: loadWorkerPoolFunction('ordinaryRecoveryWindowNote', { tr: t }),
      ordinaryTurnRecoveryStillOwnsSession: () => stillOwns,
      requireCallbacks: () => ({ sessionReply }),
      sessionAnchorId: () => 'om_root',
      randomUUID,
      logger: { warn: vi.fn() },
      tag: () => 'test',
    };
    const notify = loadWorkerPoolFunction<(ds: any, state: OrdinaryTurnRecoveryState, botCfg: any) => void>(
      'notifyOrdinaryTurnRecoveryWaiting', scope);
    const state = backoff();
    const ds: any = { larkAppId: 'app', session: { sessionId: 'sid', ordinaryTurnRecovery: state } };
    return { scope, notify, ds, state, sessionReply };
  }

  it('says what is wrong, when it continues by itself and until when, as a plain reply in the topic', async () => {
    const h = harness();
    h.notify(h.ds, h.state, {});
    expect(h.sessionReply).toHaveBeenCalledTimes(1);
    const [anchor, content, msgType, appId, turnId, opts] = h.sessionReply.mock.calls[0] as any[];
    expect([anchor, msgType, appId, turnId]).toEqual(['om_root', 'text', 'app', 'om_task']);
    expect(content).toBe(t('worker.ordinary_recovery_waiting', {
      cliName: 'Claude',
      eta: t('worker.ordinary_recovery_waiting_eta', { eta: formatClockTime(h.state.providerRetryAt!, 'zh') }, 'zh'),
      at: formatClockTime(h.state.nextAttemptAt!, 'zh'),
      windowEnd: formatClockTime(h.state.windowEndsAt!, 'zh'),
      windowNote: t('worker.ordinary_recovery_window_note_cache', { minutes: '55' }, 'zh'),
    }, 'zh'));
    // Still waiting right before the write: it goes out.
    expect(() => opts.beforeWrite()).not.toThrow();
  });

  it('explains the limit by the prompt cache only when the limit is the 1-hour cache\'s', () => {
    const h = harness();
    const plain = backoff({ windowMinutes: 15, windowFollowsCache: undefined });
    h.ds.session.ordinaryTurnRecovery = plain;
    h.notify(h.ds, plain, {});
    const content = (h.sessionReply.mock.calls[0] as any[])[1] as string;
    expect(content).toContain(t('worker.ordinary_recovery_window_note', { minutes: '15' }, 'zh'));
    expect(content).not.toContain(t('worker.ordinary_recovery_window_note_cache', { minutes: '15' }, 'zh'));
  });

  it('is withdrawn right before the write once the recovery stopped waiting', async () => {
    const h = harness();
    h.sessionReply.mockImplementation(async (...args: unknown[]) => {
      const opts = args[5] as { beforeWrite: () => void };
      opts.beforeWrite();
      return 'om_notice';
    });
    // A new message replaced the wait between scheduling and sending.
    h.ds.session.ordinaryTurnRecovery = { logicalTurnId: 'om_newer', currentTurnId: 'om_newer', continuationsStarted: 0, status: 'running' };
    h.notify(h.ds, h.state, {});
    await vi.waitFor(() => expect(h.scope.logger.warn).toHaveBeenCalledTimes(1));
  });

  it('is not sent for a session this recovery no longer owns', async () => {
    const h = harness(false);
    h.sessionReply.mockImplementation(async (...args: unknown[]) => {
      (args[5] as { beforeWrite: () => void }).beforeWrite();
      return 'om_notice';
    });
    h.notify(h.ds, h.state, {});
    await vi.waitFor(() => expect(h.scope.logger.warn).toHaveBeenCalledTimes(1));
  });
});
