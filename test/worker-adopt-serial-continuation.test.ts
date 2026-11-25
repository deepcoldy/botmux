import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

describe('adopted-pane serial continuation boundary', () => {
  it('queues a serial continuation instead of writing it into a busy adopted pane', async () => {
    const pendingAdoptMessages: any[] = [];
    const flushPending = vi.fn();
    const writeDirect = vi.fn();
    const scope: Record<string, any> = {
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
      queueAfterActiveTurn: true as const,
      trustedCaller: {
        requestUserOpenId: 'ou_reply_bot', requestLarkAppId: 'app', senderType: 'bot' as const,
        taskContinuation: {
          appId: 'app', openId: 'ou_human_b', sourceSessionId: 'source', sourceTurnId: 'om_source_b',
        },
      },
    };

    await admit(item);

    expect(pendingAdoptMessages).toEqual([item]);
    expect(writeDirect).not.toHaveBeenCalled();
    expect(flushPending).toHaveBeenCalledOnce();
  });

  it('keeps the existing direct path for an ordinary adopted-pane message', async () => {
    const writeDirect = vi.fn(async () => 'completed');
    const scope: Record<string, any> = {
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
      undefined, undefined, expect.anything(), true,
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
