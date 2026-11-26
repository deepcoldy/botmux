import { describe, expect, it, vi } from 'vitest';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { inputForcesSerialTurn } from '../src/utils/pending-input-queue.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

describe('adopted-pane serial continuation boundary', () => {
  it('queues a promoted continuation even without an explicit serial marker', async () => {
    const pendingAdoptMessages: any[] = [];
    const flushPending = vi.fn();
    const writeDirect = vi.fn();
    const scope: Record<string, any> = {
      activeTurnAuthority: new ActiveTurnAuthority(),
      inputForcesSerialTurn,
      cliRestartInProgress: false,
      rawInputRestartGate: false,
      backend: {},
      pendingAdoptMessages,
      recoverSessionRenameAfterPersistentReattach: () => false,
      sessionRenameInFlight: () => false,
      runAdoptMessageForCapturedGeneration: writeDirect,
      flushPending,
      log: vi.fn(),
    };
    const admit = loadWorkerFunction<(item: any) => Promise<void>>('admitAdoptMessage', scope);
    const item = {
      content: 'task B result',
      turnId: 'om_reply_b',
      trustedCaller: {
        requestUserOpenId: 'ou_reply_bot', requestLarkAppId: 'app', senderType: 'bot' as const,
        taskContinuation: {
          appId: 'app', openId: 'ou_human_b', sourceSessionId: 'source', sourceTurnId: 'om_source_b',
        },
      },
    };

    await admit(item);

    expect(pendingAdoptMessages).toHaveLength(1);
    expect(pendingAdoptMessages[0]).toMatchObject({
      turnId: 'om_reply_b', queueAfterActiveTurn: true, trustedCaller: item.trustedCaller,
    });
    expect(writeDirect).not.toHaveBeenCalled();
    expect(flushPending).toHaveBeenCalledOnce();
  });

  it('queues a callerless follow-up instead of adopting the active continuation identity', async () => {
    const activeTurnAuthority = new ActiveTurnAuthority();
    const activeCaller = {
      requestUserOpenId: 'ou_reply_bot', requestLarkAppId: 'app', senderType: 'bot' as const,
      taskContinuation: {
        appId: 'app', openId: 'ou_human_a', sourceSessionId: 'source', sourceTurnId: 'om_source_a',
      },
    };
    expect(activeTurnAuthority.reserve({ turnId: 'om_active_a', caller: activeCaller })).toBe(true);
    expect(activeTurnAuthority.markStarted({ turnId: 'om_active_a', caller: activeCaller })).toBe(true);
    const pendingAdoptMessages: any[] = [];
    const writeDirect = vi.fn();
    const scope: Record<string, any> = {
      activeTurnAuthority,
      inputForcesSerialTurn,
      cliRestartInProgress: false,
      rawInputRestartGate: false,
      backend: {},
      pendingAdoptMessages,
      recoverSessionRenameAfterPersistentReattach: () => false,
      sessionRenameInFlight: () => false,
      runAdoptMessageForCapturedGeneration: writeDirect,
      flushPending: vi.fn(),
      log: vi.fn(),
    };
    const admit = loadWorkerFunction<(item: any) => Promise<void>>('admitAdoptMessage', scope);

    await admit({ content: 'unverified follow-up', turnId: 'om_followup_b' });

    expect(writeDirect).not.toHaveBeenCalled();
    expect(pendingAdoptMessages).toHaveLength(1);
    expect(pendingAdoptMessages[0]).toMatchObject({
      turnId: 'om_followup_b', queueAfterActiveTurn: true,
    });
  });

  it('keeps the existing direct path for an ordinary adopted-pane message', async () => {
    const writeDirect = vi.fn(async () => 'completed');
    const scope: Record<string, any> = {
      activeTurnAuthority: new ActiveTurnAuthority(),
      inputForcesSerialTurn,
      cliRestartInProgress: false,
      rawInputRestartGate: false,
      backend: {},
      pendingAdoptMessages: [],
      recoverSessionRenameAfterPersistentReattach: () => false,
      sessionRenameInFlight: () => false,
      runAdoptMessageForCapturedGeneration: writeDirect,
      flushPending: vi.fn(),
      log: vi.fn(),
    };
    const admit = loadWorkerFunction<(item: any) => Promise<void>>('admitAdoptMessage', scope);
    const item = { content: 'ordinary follow-up', turnId: 'om_human' };

    await admit(item);

    expect(writeDirect).toHaveBeenCalledOnce();
    expect(writeDirect.mock.calls[0]?.[0]).toBe(item);
    expect(scope.pendingAdoptMessages).toEqual([]);
    expect(scope.flushPending).not.toHaveBeenCalled();
  });

  it('carries the serial marker through the adopt queue to the literal write edge', async () => {
    const writeAdoptMessage = vi.fn(async () => 'completed');
    const scope: Record<string, any> = {
      captureAdoptWriteFence: () => ({ generation: 1, backend: {} }),
      adoptWriteFenceIsCurrent: () => true,
      adoptWriteQueue: {},
      writeAdoptMessage,
      runAdoptQueuedWriteSequence: async ({ write }: { write: () => Promise<string> }) => ({
        status: 'completed', value: await write(),
      }),
    };
    const run = loadWorkerFunction<(item: any, requeue: () => void) => Promise<string>>(
      'runAdoptMessageForCapturedGeneration', scope,
    );

    await expect(run({
      content: 'serial result', turnId: 'om_reply', queueAfterActiveTurn: true,
    }, vi.fn())).resolves.toBe('completed');

    expect(writeAdoptMessage).toHaveBeenCalledWith(
      'serial result', 'om_reply', undefined, undefined, undefined,
      undefined, undefined, expect.anything(), true, undefined,
      expect.objectContaining({ content: 'serial result', turnId: 'om_reply', queueAfterActiveTurn: true }),
    );
  });

  it('enforces the serial marker again when adopt authority starts', async () => {
    const marker = new Error('stop after authority assertion');
    const markActiveTurnStarted = vi.fn(() => { throw marker; });
    const scope: Record<string, any> = {
      rememberTurnLinkRefMode: vi.fn(),
      captureAdoptWriteFence: () => ({ generation: 1, backend: {} }),
      adoptWriteFenceIsCurrent: () => true,
      cliAdapter: {},
      renderer: { markNewTurn: vi.fn() },
      usageLimitTracker: { beginTurn: vi.fn(() => 1) },
      currentUsageLimitSnapshot: () => ({}),
      currentBotmuxTurnId: undefined,
      setCaptureIdentity: vi.fn(),
      markActiveTurnStarted,
    };
    const write = loadWorkerFunction<(...args: any[]) => Promise<string>>('writeAdoptMessage', scope);

    await expect(write(
      'serial result', 'om_reply', undefined, undefined, undefined,
      undefined, undefined, { generation: 1, backend: {} }, true,
    )).rejects.toBe(marker);
    expect(markActiveTurnStarted).toHaveBeenCalledWith(expect.objectContaining({
      turnId: 'om_reply',
      queueAfterActiveTurn: true,
    }));
  });
});
