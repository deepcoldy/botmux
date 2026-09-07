/**
 * Integration coverage for the daemon's limited-edge handoff wiring.
 *
 * Run: bun x vitest run --project unit test/quota-fallback-worker.test.ts
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveCurrent: vi.fn(),
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    resolveCurrentChatBotOpenIdsByLarkAppIds: mocks.resolveCurrent,
    updateMessage: mocks.updateMessage,
    deleteMessage: mocks.deleteMessage,
  };
});

import { registerBot } from '../src/bot-registry.js';
import {
  __testOnly_setupWorkerHandlers,
  clearUsageLimitState,
  initWorkerPool,
} from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import type { CliUsageLimitState } from '../src/utils/cli-usage-limit.js';
import { __testOnly_resetQuotaFallbackEvents } from '../src/services/quota-fallback.js';

const SOURCE = 'cli_qfsource';
const TARGET = 'cli_qftarget';
const TURN = 'om_human_turn';
const HUMAN = 'ou_human';
const TARGET_OPEN_ID = 'ou_backup';

function limit(kind: 'usage' | 'rate' = 'rate'): CliUsageLimitState {
  return {
    limited: true,
    kind,
    retryAtMs: Date.now() + 60_000,
    retryLabel: '5 min',
    retryReady: false,
  };
}

function fakeWorker() {
  const worker = new EventEmitter() as any;
  worker.killed = false;
  worker.send = vi.fn();
  worker.kill = vi.fn();
  worker.pid = 4242;
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  return worker;
}

function makeDs(overrides: Partial<DaemonSession> = {}): DaemonSession {
  const session: any = {
    sessionId: `sess-${Math.random().toString(36).slice(2)}`,
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    status: 'active',
    ownerOpenId: 'ou_owner',
    backendType: 'tmux',
    replyTargets: {
      [TURN]: {
        senderOpenId: HUMAN,
        participants: [{ openId: HUMAN, isBot: false }],
        updatedAt: new Date().toISOString(),
      },
    },
  };
  return {
    session,
    larkAppId: SOURCE,
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'chat',
    currentTurnId: TURN,
    ...overrides,
  } as unknown as DaemonSession;
}

function setup(sessionReply: ReturnType<typeof vi.fn>): void {
  initWorkerPool({
    sessionReply,
    getSessionWorkingDir: () => '/repo',
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

function fallbackReplies(sessionReply: ReturnType<typeof vi.fn>) {
  return sessionReply.mock.calls.filter(call => String(call[1]).includes(TARGET_OPEN_ID));
}

describe('daemon quota fallback handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testOnly_resetQuotaFallbackEvents();
    process.env.SESSION_DATA_DIR = mkdtempSync(join(tmpdir(), 'botmux-quota-fallback-'));
    registerBot({
      larkAppId: SOURCE,
      larkAppSecret: 'source-secret',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      disableStreamingCard: true,
      quotaFallbackBot: {
        enabled: true,
        targetAppId: TARGET,
        kinds: ['usage', 'rate'],
        message: 'Fixed daemon handoff.',
      },
    });
    registerBot({
      larkAppId: TARGET,
      larkAppSecret: 'target-secret',
      cliId: 'codex',
      allowedUsers: ['ou_owner'],
    });
    mocks.resolveCurrent.mockResolvedValue({
      ok: true,
      mappings: [{ larkAppId: TARGET, subjectOpenId: TARGET_OPEN_ID }],
    });
    mocks.updateMessage.mockResolvedValue('ok');
    mocks.deleteMessage.mockResolvedValue('ok');
  });

  it.each([
    { scope: 'chat' as const, backendType: 'pty' as const, disableStreamingCard: true },
    { scope: 'thread' as const, backendType: 'tmux' as const, disableStreamingCard: false },
  ])('sends one real mention at the original $scope landing point on $backendType', async ({ scope, backendType, disableStreamingCard }) => {
    registerBot({
      larkAppId: SOURCE,
      larkAppSecret: 'source-secret',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      disableStreamingCard,
      quotaFallbackBot: {
        enabled: true,
        targetAppId: TARGET,
        kinds: ['usage', 'rate'],
        message: 'Fixed daemon handoff.',
      },
    });
    const sessionReply = vi.fn(async () => 'om_reply');
    setup(sessionReply);
    const worker = fakeWorker();
    const ds = makeDs({ worker, workerPort: 9999, scope });
    ds.session.backendType = backendType;
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'screen_update',
      content: '429',
      status: 'limited',
      usageLimit: limit(),
      turnId: TURN,
    });
    await flush();

    const replies = fallbackReplies(sessionReply);
    expect(replies).toHaveLength(1);
    expect(replies[0][1]).toBe(`<at id=${TARGET_OPEN_ID}></at> Fixed daemon handoff.`);
    const expectedAnchor = scope === 'thread' ? 'om_root' : 'oc_chat';
    expect(replies[0].slice(0, 5)).toEqual([expectedAnchor, replies[0][1], 'text', SOURCE, TURN]);
    // The handoff uses daemon transport only; it never injects text back into
    // the exhausted worker/model input channel.
    expect(worker.send).not.toHaveBeenCalled();
  });

  it('deduplicates repeated frames and a same-bot event in another session for five minutes', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    setup(sessionReply);
    const worker = fakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 });
    __testOnly_setupWorkerHandlers(ds, worker);
    const state = limit();

    worker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: state, turnId: TURN });
    await flush();
    worker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: state, turnId: TURN });
    await flush();
    expect(fallbackReplies(sessionReply)).toHaveLength(1);
    expect(mocks.resolveCurrent).toHaveBeenCalledTimes(1);

    clearUsageLimitState(ds);
    ds.lastScreenStatus = 'working';
    worker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: state, turnId: TURN });
    await flush();
    expect(fallbackReplies(sessionReply)).toHaveLength(1);
    expect(mocks.resolveCurrent).toHaveBeenCalledTimes(1);

    const otherWorker = fakeWorker();
    const other = makeDs({ worker: otherWorker, workerPort: 9998 });
    __testOnly_setupWorkerHandlers(other, otherWorker);
    otherWorker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: state, turnId: TURN });
    await flush();
    expect(fallbackReplies(sessionReply)).toHaveLength(1);
    expect(mocks.resolveCurrent).toHaveBeenCalledTimes(1);
  });

  it('drops a stale async lookup after its episode clears', async () => {
    let finishFirst!: (value: {
      ok: true;
      mappings: Array<{ larkAppId: string; subjectOpenId: string }>;
    }) => void;
    const firstLookup = new Promise<{
      ok: true;
      mappings: Array<{ larkAppId: string; subjectOpenId: string }>;
    }>(resolve => { finishFirst = resolve; });
    mocks.resolveCurrent
      .mockImplementationOnce(() => firstLookup)
      .mockResolvedValue({
        ok: true,
        mappings: [{ larkAppId: TARGET, subjectOpenId: TARGET_OPEN_ID }],
      });

    const sessionReply = vi.fn(async () => 'om_reply');
    setup(sessionReply);
    const worker = fakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 });
    __testOnly_setupWorkerHandlers(ds, worker);
    const state = limit();

    worker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: state, turnId: TURN });
    await flush();
    expect(mocks.resolveCurrent).toHaveBeenCalledTimes(1);

    clearUsageLimitState(ds);
    ds.lastScreenStatus = 'working';
    worker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: state, turnId: TURN });
    await flush();
    expect(fallbackReplies(sessionReply)).toHaveLength(0);

    finishFirst({
      ok: true,
      mappings: [{ larkAppId: TARGET, subjectOpenId: TARGET_OPEN_ID }],
    });
    await flush();
    expect(fallbackReplies(sessionReply)).toHaveLength(0);
  });

  it('allows an acyclic bot-origin handoff to a second backup', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    setup(sessionReply);
    const worker = fakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 });
    ds.session.replyTargets![TURN] = {
      senderOpenId: 'ou_primary_bot',
      participants: [{ openId: 'ou_primary_bot', isBot: true }],
      updatedAt: new Date().toISOString(),
    };
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: limit(), turnId: TURN });
    await flush();

    expect(fallbackReplies(sessionReply)).toHaveLength(1);
    expect(mocks.resolveCurrent).toHaveBeenCalledTimes(1);
  });

  it('respects the configured limit kinds', async () => {
    registerBot({
      larkAppId: SOURCE,
      larkAppSecret: 'source-secret',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      disableStreamingCard: true,
      quotaFallbackBot: {
        enabled: true,
        targetAppId: TARGET,
        kinds: ['usage'],
        message: 'Fixed daemon handoff.',
      },
    });
    const sessionReply = vi.fn(async () => 'om_reply');
    setup(sessionReply);
    const worker = fakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: limit('rate'), turnId: TURN });
    await flush();
    expect(fallbackReplies(sessionReply)).toHaveLength(0);

    clearUsageLimitState(ds);
    ds.lastScreenStatus = 'working';
    worker.emit('message', { type: 'screen_update', content: 'quota', status: 'limited', usageLimit: limit('usage'), turnId: TURN });
    await flush();
    expect(fallbackReplies(sessionReply)).toHaveLength(1);
  });

  it('fails closed on target resolution and attempts only once after send failure', async () => {
    mocks.resolveCurrent.mockResolvedValueOnce({
      ok: false,
      error: 'subject_lark_app_not_in_chat',
      message: 'not in chat',
    });
    let failFallbackSend = false;
    const sessionReply = vi.fn(async (_anchor: string, content: string) => {
      if (failFallbackSend && content.includes(TARGET_OPEN_ID)) throw new Error('send failed');
      return 'om_reply';
    });
    setup(sessionReply);
    const worker = fakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 });
    __testOnly_setupWorkerHandlers(ds, worker);
    const state = limit();

    worker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: state, turnId: TURN });
    await flush();
    expect(fallbackReplies(sessionReply)).toHaveLength(0);
    expect(mocks.resolveCurrent).toHaveBeenCalledTimes(1);

    // Re-project an edge without clearing the episode. The daemon-wide event
    // window still forbids another resolution/send.
    ds.lastScreenStatus = 'working';
    worker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: state, turnId: TURN });
    await flush();
    expect(mocks.resolveCurrent).toHaveBeenCalledTimes(1);

    clearUsageLimitState(ds);
    // Advance to a later dedupe window; this branch is about send-failure
    // behavior after a fresh claim, not the five-minute suppression itself.
    __testOnly_resetQuotaFallbackEvents();
    ds.lastScreenStatus = 'working';
    failFallbackSend = true;
    mocks.resolveCurrent.mockResolvedValue({
      ok: true,
      mappings: [{ larkAppId: TARGET, subjectOpenId: TARGET_OPEN_ID }],
    });
    worker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: state, turnId: TURN });
    await flush();
    ds.lastScreenStatus = 'working';
    worker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: state, turnId: TURN });
    await flush();
    expect(fallbackReplies(sessionReply)).toHaveLength(1);
  });

  it('does not backfill a stale handoff during daemon restore silence', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    setup(sessionReply);
    const worker = fakeWorker();
    const ds = makeDs({ worker, workerPort: 9999, suppressRecoveryCard: true });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'screen_update', content: '429', status: 'limited', usageLimit: limit(), turnId: TURN });
    await flush();

    expect(fallbackReplies(sessionReply)).toHaveLength(0);
    expect(mocks.resolveCurrent).not.toHaveBeenCalled();
  });
});
