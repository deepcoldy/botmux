/**
 * Same-bot quota fallback chain switch: which limits it takes over, what the
 * next CLI/model launches with, and that the interrupted request continues as
 * the original sender at the original destination.
 *
 * Worker lifecycle and the session store are mocked at the module boundary,
 * like the failure card's retry tests; the bot registry is real.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const killWorkerMock = vi.fn();
const forkWorkerMock = vi.fn((..._args: any[]) => true);
const prepareMock = vi.fn(async (..._args: any[]) => {});
const destroyPaneMock = vi.fn();
let activeDs: any;

vi.mock('../src/core/worker-pool.js', () => ({
  killWorker: (ds: any) => {
    killWorkerMock(ds);
    const worker = ds.worker;
    ds.worker = null;
    queueMicrotask(() => worker?.emit('exit', 0));
  },
  forkWorker: (...a: any[]) => forkWorkerMock(...a),
  prepareFailedTurnRecoveryIdentity: (...a: any[]) => prepareMock(...a),
  destroyLivePaneBeforeRestart: (...a: any[]) => destroyPaneMock(...a),
  findActiveBySessionId: () => activeDs,
  isSessionRestartInFlight: () => false,
  isSessionTransferring: () => false,
  WORKER_SIGKILL_BACKSTOP_MS: 7_000,
  waitForWorkerExit: (worker: any) => new Promise(resolve => worker.once('exit', () => resolve(true))),
}));
vi.mock('../src/core/session-manager.js', () => ({
  buildNewTopicCliInput: (prompt: string, _sid: string, cliId: string) => ({ content: `<opening ${cliId}>${prompt}` }),
  buildFollowUpCliInput: (prompt: string) => ({ content: `<follow-up>${prompt}` }),
  persistStreamCardState: () => {},
  rememberLastCliInput: (ds: any, userPrompt: string, input: any, turnId: string) => {
    ds.lastUserPrompt = userPrompt;
    ds.lastCliInput = input.content;
    ds.lastCliInputTurnId = turnId;
  },
}));
const recoverMock = vi.fn(async (..._args: any[]): Promise<any> => ({ ok: true, state: 'accepted', turnId: 'bmx-recovery-1' }));
vi.mock('../src/core/failed-turn-recovery.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/failed-turn-recovery.js')>(),
  recoverFailedTurn: (...a: any[]) => recoverMock(...a),
}));
vi.mock('../src/services/session-store.js', () => ({ updateSession: () => {} }));
vi.mock('../src/core/session-mutation-guard.js', () => ({ hasProtectedSessionMutationOwnership: () => false }));
vi.mock('../src/im/lark/event-dispatcher.js', () => ({ canTalk: () => true, canOperate: () => true }));

import { registerBot } from '../src/bot-registry.js';
import {
  QUOTA_FALLBACK_SAME_CLI_RETRIES,
  QUOTA_FALLBACK_TURN_PREFIX,
  startQuotaFallbackChainSwitch,
} from '../src/core/quota-fallback-chain-switch.js';

const APP = 'cli_chainsource';
const TURN = 'om_interrupted';
const HUMAN = 'ou_human';

function fakeWorker(): any {
  const worker = new EventEmitter() as any;
  worker.killed = false;
  worker.exitCode = null;
  worker.signalCode = null;
  return worker;
}

function makeDs(overrides: Record<string, any> = {}, session: Record<string, any> = {}): any {
  const worker = fakeWorker();
  return {
    larkAppId: APP,
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    worker,
    hasHistory: true,
    lastCliInputTurnId: TURN,
    lastUserPrompt: '把登录页的报错修掉',
    activeInteractiveTurn: {
      turnId: TURN,
      caller: { requestUserOpenId: HUMAN, requestLarkAppId: APP, senderType: 'user' },
      userPrompt: '把登录页的报错修掉',
    },
    session: {
      sessionId: 'sess-chain',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      status: 'active',
      ownerOpenId: 'ou_owner',
      cliId: 'claude-code',
      model: 'claude-opus-5-5',
      cliSessionId: 'claude-native-1',
      agentFrozen: true,
      replyTargets: {
        [TURN]: { rootMessageId: 'om_root', senderOpenId: HUMAN, participants: [{ openId: HUMAN, isBot: false }], updatedAt: '2026-11-23T00:00:00.000Z' },
      },
      ...session,
    },
    ...overrides,
  };
}

function trigger(ds: any, kind: 'usage' | 'rate' = 'rate', transient = false) {
  const reply = vi.fn(async (_text: string) => 'om_notice');
  const fallThrough = vi.fn();
  return { reply, fallThrough, args: { kind, transient, sourceTurnId: TURN, worker: ds.worker, reply, fallThrough } };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

describe('quota fallback chain switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forkWorkerMock.mockImplementation(() => true);
    prepareMock.mockImplementation(async () => {});
    registerBot({
      larkAppId: APP,
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      model: 'claude-opus-5-5',
      allowedUsers: ['ou_owner'],
      env: { ANTHROPIC_BASE_URL: 'https://relay.example' },
      quotaFallbackChain: {
        enabled: true,
        kinds: ['usage', 'rate'],
        steps: [{ cliId: 'traex', model: 'GPT-6.1-Sol' }, { cliId: 'traex', model: 'DeepSeek-V4.1-Flash' }],
      },
    } as any);
  });

  it('moves a Claude session to a fresh TraeX conversation with a handoff of the interrupted request', async () => {
    const ds = makeDs();
    activeDs = ds;
    const { reply, fallThrough, args } = trigger(ds);
    expect(startQuotaFallbackChainSwitch(ds, args)).toBe(true);
    expect(reply).not.toHaveBeenCalled();
    await settle();

    expect(killWorkerMock).toHaveBeenCalledTimes(1);
    expect(destroyPaneMock).toHaveBeenCalledTimes(1);
    expect(forkWorkerMock).toHaveBeenCalledTimes(1);
    const [forkedDs, input, opts] = forkWorkerMock.mock.calls[0]!;
    expect(forkedDs).toBe(ds);
    expect(input.content).toMatch(/^<opening traex>/);
    expect(input.content).toContain('botmux history');
    expect(input.content).toContain('把登录页的报错修掉');
    expect(opts).toMatchObject({ resume: false, atMostOnce: true, trustedCaller: { requestUserOpenId: HUMAN, source: 'failed_turn_recovery' } });
    expect(opts.turnId.startsWith(QUOTA_FALLBACK_TURN_PREFIX)).toBe(true);

    expect(ds.session.quotaFallback).toEqual({ step: 1, cliId: 'traex', model: 'GPT-6.1-Sol' });
    expect(ds.session.cliLaunchSnapshot).toMatchObject({ state: 'pending', cliId: 'traex', model: 'GPT-6.1-Sol' });
    expect(ds.session.cliSessionId).toBeUndefined();
    expect(ds.hasHistory).toBe(false);
    expect(ds.session.replyTargets[opts.turnId]).toMatchObject({ rootMessageId: 'om_root', senderOpenId: HUMAN });
    expect(ds.session.failedTurnRecovery).toMatchObject({ originalTurnId: TURN, turnId: opts.turnId });
    expect(prepareMock).toHaveBeenCalledWith(ds, opts.turnId);
    expect(ds.lastCliInputTurnId).toBe(opts.turnId);
    expect(ds.quotaFallbackChainSwitching).toBe(false);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]![0]).toContain('TRAE · GPT-6.1-Sol');
    expect(fallThrough).not.toHaveBeenCalled();
  });

  it('switches the model on the same CLI by resuming its native conversation', async () => {
    const ds = makeDs({}, {
      cliId: 'traex',
      model: 'GPT-6.1-Sol',
      cliSessionId: 'traex-thread-1',
      cliLaunchSnapshot: { version: 1, state: 'resolved', entryId: 'traex', cliId: 'traex', model: 'GPT-6.1-Sol' },
      quotaFallback: { step: 1, cliId: 'traex', model: 'GPT-6.1-Sol' },
    });
    activeDs = ds;
    const { args } = trigger(ds, 'usage');
    expect(startQuotaFallbackChainSwitch(ds, args)).toBe(true);
    await settle();

    const [, input, opts] = forkWorkerMock.mock.calls[0]!;
    expect(opts.resume).toBe(true);
    expect(input.content).toMatch(/^<follow-up>/);
    expect(input.content).not.toContain('botmux history');
    expect(ds.session.quotaFallback).toEqual({ step: 2, cliId: 'traex', model: 'DeepSeek-V4.1-Flash' });
    expect(ds.session.cliSessionId).toBe('traex-thread-1');
    expect(ds.session.cliLaunchSnapshot.state).toBe('resolved');
  });

  it('leaves the limit to the existing notice once the chain is used up', () => {
    const ds = makeDs({}, { cliId: 'traex', quotaFallback: { step: 2, cliId: 'traex', model: 'DeepSeek-V4.1-Flash' },
      cliLaunchSnapshot: { version: 1, state: 'resolved', entryId: 'traex', cliId: 'traex' } });
    activeDs = ds;
    expect(startQuotaFallbackChainSwitch(ds, trigger(ds).args)).toBe(false);
    expect(killWorkerMock).not.toHaveBeenCalled();
  });

  it.each([
    ['the limit kind is not configured', (ds: any) => {
      registerBot({ larkAppId: APP, larkAppSecret: 'secret', cliId: 'claude-code', allowedUsers: ['ou_owner'],
        quotaFallbackChain: { enabled: true, kinds: ['usage'], steps: [{ cliId: 'traex' }] } } as any);
      return ds;
    }],
    ['a newer message is already queued', (ds: any) => { ds.pendingFollowUps = ['再看下注册页']; return ds; }],
    ['the limit is not on the last input', (ds: any) => { ds.lastCliInputTurnId = 'om_other'; return ds; }],
    ['the session picked its CLI with /cli', (ds: any) => {
      ds.session.cliLaunchSnapshot = { version: 1, state: 'resolved', entryId: 'claude-code', cliId: 'claude-code' };
      return ds;
    }],
    ['an HTTP caller is waiting for the turn', (ds: any) => { ds.pendingWaitPromises = new Map([[TURN, {}]]); return ds; }],
    ['the original caller is unknown', (ds: any) => {
      ds.activeInteractiveTurn = undefined;
      ds.session.replyTargets[TURN].participants = [{ openId: HUMAN, isBot: true }];
      return ds;
    }],
  ])('does not take over when %s', (_name, prepare) => {
    const ds = prepare(makeDs());
    activeDs = ds;
    expect(startQuotaFallbackChainSwitch(ds, trigger(ds).args)).toBe(false);
    expect(killWorkerMock).not.toHaveBeenCalled();
  });

  it('keeps the worker and hands the limit back when the caller identity cannot be prepared', async () => {
    prepareMock.mockImplementation(async () => { throw new Error('identity_material_unavailable'); });
    const ds = makeDs();
    activeDs = ds;
    const { reply, fallThrough, args } = trigger(ds);
    expect(startQuotaFallbackChainSwitch(ds, args)).toBe(true);
    await settle();

    expect(killWorkerMock).not.toHaveBeenCalled();
    expect(forkWorkerMock).not.toHaveBeenCalled();
    expect(ds.session.quotaFallback).toBeUndefined();
    expect(ds.session.failedTurnRecovery).toBeUndefined();
    expect(Object.keys(ds.session.replyTargets)).toEqual([TURN]);
    expect(fallThrough).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
  });

  it('restores the previous CLI and reports the failure when the new CLI cannot start', async () => {
    forkWorkerMock.mockImplementation(() => false);
    const ds = makeDs();
    activeDs = ds;
    const { reply, fallThrough, args } = trigger(ds);
    expect(startQuotaFallbackChainSwitch(ds, args)).toBe(true);
    await settle();

    expect(killWorkerMock).toHaveBeenCalledTimes(1);
    expect(ds.session).toMatchObject({ cliId: 'claude-code', cliSessionId: 'claude-native-1', model: 'claude-opus-5-5' });
    expect(ds.session.cliLaunchSnapshot).toBeUndefined();
    expect(ds.session.quotaFallback).toBeUndefined();
    expect(ds.session.failedTurnRecovery).toBeUndefined();
    expect(ds.hasHistory).toBe(true);
    expect(fallThrough).not.toHaveBeenCalled();
    expect(reply.mock.calls.at(-1)![0]).toMatch(/^<at id=ou_owner><\/at> /);
  });

  it('restores the previous CLI when cleanup throws after the old worker is retired', async () => {
    destroyPaneMock.mockImplementationOnce(() => { throw new Error('tmux unavailable'); });
    const ds = makeDs();
    activeDs = ds;
    const { reply, fallThrough, args } = trigger(ds);
    startQuotaFallbackChainSwitch(ds, args);
    await settle();

    expect(forkWorkerMock).not.toHaveBeenCalled();
    expect(ds.session.quotaFallback).toBeUndefined();
    expect(ds.session.cliSessionId).toBe('claude-native-1');
    expect(fallThrough).not.toHaveBeenCalled();
    expect(reply.mock.calls.at(-1)![0]).toMatch(/^<at id=ou_owner><\/at> /);
  });

  it('stops quietly when the session is closed while the old worker exits', async () => {
    const ds = makeDs();
    activeDs = ds;
    killWorkerMock.mockImplementationOnce(() => { activeDs = undefined; });
    const { reply, fallThrough, args } = trigger(ds);
    expect(startQuotaFallbackChainSwitch(ds, args)).toBe(true);
    await settle();

    expect(forkWorkerMock).not.toHaveBeenCalled();
    expect(ds.session.quotaFallback).toBeUndefined();
    expect(reply).not.toHaveBeenCalled();
    expect(fallThrough).not.toHaveBeenCalled();
  });

  it('owns repeated limit edges while one switch is in flight', async () => {
    const ds = makeDs();
    activeDs = ds;
    expect(startQuotaFallbackChainSwitch(ds, trigger(ds).args)).toBe(true);
    expect(startQuotaFallbackChainSwitch(ds, trigger(ds, 'usage').args)).toBe(true);
    await settle();
    expect(forkWorkerMock).toHaveBeenCalledTimes(1);
  });

  describe('transient rate limits', () => {
    afterEach(() => vi.useRealTimers());

    function limitedOn(ds: any, turnId: string): void {
      ds.lastCliInputTurnId = turnId;
      ds.session.lastFailedTurn = { turnId, failedAt: '2026-11-24T00:00:00.000Z', limitedSnapshot: true };
    }

    it('retries the same CLI five times with growing delays before switching', async () => {
      vi.useFakeTimers();
      const ds = makeDs();
      activeDs = ds;
      limitedOn(ds, TURN);
      const first = trigger(ds, 'rate', true);
      expect(startQuotaFallbackChainSwitch(ds, first.args)).toBe(true);
      expect(first.reply.mock.calls[0]![0]).toContain('最多 5 次');

      const delays: number[] = [];
      for (let attempt = 1; attempt <= QUOTA_FALLBACK_SAME_CLI_RETRIES; attempt++) {
        const before = recoverMock.mock.calls.length;
        let waited = 0;
        while (recoverMock.mock.calls.length === before) { await vi.advanceTimersByTimeAsync(1_000); waited += 1_000; }
        delays.push(waited);
        expect(recoverMock.mock.calls.at(-1)![1]).toMatchObject({ turnId: ds.session.lastFailedTurn.turnId, mode: 'retry' });
        // The retried turn hits the limit again as a recovery of the original turn.
        const retryTurn = `bmx-recovery-${attempt}`;
        ds.session.failedTurnRecovery = { originalTurnId: TURN, turnId: retryTurn, caller: ds.activeInteractiveTurn.caller };
        ds.activeInteractiveTurn = { ...ds.activeInteractiveTurn, turnId: retryTurn };
        limitedOn(ds, retryTurn);
        expect(startQuotaFallbackChainSwitch(ds, { ...first.args, sourceTurnId: retryTurn })).toBe(true);
      }
      expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
      expect(killWorkerMock).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.runOnlyPendingTimersAsync();
      expect(forkWorkerMock).toHaveBeenCalledTimes(1);
      expect(ds.session.quotaFallback).toEqual({ step: 1, cliId: 'traex', model: 'GPT-6.1-Sol' });
      expect(ds.session.failedTurnRecovery.originalTurnId).toBe(TURN);
      expect(first.reply.mock.calls.filter(call => String(call[0]).includes('最多 5 次'))).toHaveLength(1);
    });

    it('switches at once when the limit states a reset time', () => {
      const ds = makeDs();
      activeDs = ds;
      expect(startQuotaFallbackChainSwitch(ds, trigger(ds, 'rate', false).args)).toBe(true);
      expect(recoverMock).not.toHaveBeenCalled();
      expect(ds.quotaFallbackChainSwitching).toBe(true);
    });

    it('does not count another limited frame while a retry is still waiting', async () => {
      vi.useFakeTimers();
      const ds = makeDs();
      activeDs = ds;
      limitedOn(ds, TURN);
      const { args } = trigger(ds, 'rate', true);
      startQuotaFallbackChainSwitch(ds, args);
      expect(startQuotaFallbackChainSwitch(ds, args)).toBe(true);
      expect(ds.quotaFallbackChainRetries.attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(recoverMock).toHaveBeenCalledTimes(1);
      expect(ds.quotaFallbackChainRetries.timer).toBeUndefined();
    });

    it.each([
      ['refused', { ok: false, error: 'session_not_active' }],
      ['admitted with an unknown outcome', { ok: true, state: 'dispatch_unknown', turnId: 'bmx-recovery-x' }],
    ])('hands the limit back when a retry is %s', async (_name, result) => {
      vi.useFakeTimers();
      recoverMock.mockImplementationOnce(async () => result);
      const ds = makeDs();
      activeDs = ds;
      limitedOn(ds, TURN);
      const { fallThrough, args } = trigger(ds, 'rate', true);
      startQuotaFallbackChainSwitch(ds, args);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(recoverMock).toHaveBeenCalledTimes(1);
      expect(fallThrough).toHaveBeenCalledTimes(1);
      expect(forkWorkerMock).not.toHaveBeenCalled();
    });
  });
});
