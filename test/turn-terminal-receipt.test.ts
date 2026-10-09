/**
 * Lifecycle coverage for the independent bottom-of-thread terminal strip.
 * These tests drive the real worker IPC handler so the receipt cannot regress
 * into a prompt convention that depends on the model emitting visible output.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const botConfig: Record<string, unknown> = {
  larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'traex',
};

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  getMessageDetail: vi.fn(async () => ({
    items: [{ chat_id: 'oc_chat', msg_type: 'interactive', body: {
      content: JSON.stringify({ schema: '2.0', body: { elements: [] } }),
    } }],
  })),
  addReaction: vi.fn(async () => 'reaction_id'),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  },
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{}'),
  buildSessionCard: vi.fn(() => '{}'),
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
  buildTurnFailedCard: vi.fn(() => JSON.stringify({ failure: true })),
  buildTurnTerminalReceiptCard: vi.fn((kind: string) => JSON.stringify({ kind })),
  appendTurnTerminalReceiptToCard: vi.fn((card: string, kind: string) => JSON.stringify({
    ...JSON.parse(card), terminal: kind,
  })),
  getCliDisplayName: vi.fn(() => 'TraeX'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: botConfig,
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  getOwnerOpenId: vi.fn(() => undefined),
  getBotClient: vi.fn(),
  getBotBrand: vi.fn(() => undefined),
  resolveBrandLabel: vi.fn(() => undefined),
  resolveReplyDelivery: vi.fn(() => botConfig.replyDelivery),
  normalizeUsageDisplay: vi.fn(() => 'footer'),
  resolveUsageDisplay: vi.fn(() => 'footer'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-terminal-receipt' },
    daemon: { backendType: 'pty', cliId: 'traex' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  createSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import {
  initWorkerPool,
  __testOnly_setupWorkerHandlers,
  recordTurnExplicitMention,
} from '../src/core/worker-pool.js';
import { beginFinalOutputDelivery } from '../src/core/final-output-delivery-drain.js';
import { armSilentScheduledTurn } from '../src/core/silent-schedule-turns.js';
import { buildTurnFailedCard, buildTurnTerminalReceiptCard } from '../src/im/lark/card-builder.js';
import { getMessageDetail, updateMessage } from '../src/im/lark/client.js';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';

function makeDs(): DaemonSession {
  const fakeWorker = new EventEmitter() as any;
  fakeWorker.killed = false;
  fakeWorker.send = vi.fn();
  fakeWorker.kill = vi.fn();
  fakeWorker.pid = 99999;
  fakeWorker.stdout = new EventEmitter();
  fakeWorker.stderr = new EventEmitter();
  return {
    session: {
      sessionId: 'sid-terminal-receipt',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'fixture',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
      cliId: 'traex',
    },
    worker: fakeWorker,
    workerPort: 0,
    workerToken: 'tok',
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '1',
    lastMessageAt: Date.now(),
    hasHistory: false,
  } as any;
}

function bindLarkTurn(ds: DaemonSession, turnId: string, root = 'om_exact_root'): void {
  ds.session.turnReplyContexts = {
    ...(ds.session.turnReplyContexts ?? {}),
    [turnId]: { target: { mode: 'thread', rootMessageId: root } },
  };
  ds.currentTurnId = turnId;
}

function terminalMsg(
  turnId: string,
  extra: Partial<Extract<WorkerToDaemon, { type: 'turn_terminal' }>> = {},
): Extract<WorkerToDaemon, { type: 'turn_terminal' }> {
  return {
    type: 'turn_terminal',
    sessionId: 'sid-terminal-receipt',
    turnId,
    status: 'completed',
    ...extra,
  };
}

const sessionReplyMock = vi.fn(async () => 'om_terminal_receipt');

describe('independent turn terminal receipt', () => {
  beforeEach(() => {
    for (const key of Object.keys(botConfig)) delete botConfig[key];
    Object.assign(botConfig, {
      larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'traex',
    });
    sessionReplyMock.mockReset();
    sessionReplyMock.mockResolvedValue('om_terminal_receipt' as any);
    (buildTurnFailedCard as any).mockClear();
    (buildTurnTerminalReceiptCard as any).mockClear();
    initWorkerPool({
      sessionReply: sessionReplyMock,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('posts one completed strip for an ordinary Lark turn', async () => {
    const ds = makeDs();
    bindLarkTurn(ds, 'om_turn_done');
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('om_turn_done'));

    await vi.waitFor(() => expect(sessionReplyMock).toHaveBeenCalledTimes(1));
    expect(buildTurnTerminalReceiptCard).toHaveBeenCalledWith('completed', expect.anything());
    const call = sessionReplyMock.mock.calls[0] as any[];
    expect(call[2]).toBe('interactive');
    expect(call[4]).toBe('om_turn_done');
    expect(call[5]?.replyTarget).toEqual({ mode: 'thread', rootMessageId: 'om_exact_root' });
    expect(call[5]?.uuid).toMatch(/^tr_[0-9a-f]{47}$/);
  });

  it('patches the last standard reply card instead of appending a strip', async () => {
    const ds = makeDs();
    bindLarkTurn(ds, 'om_turn_card');
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'explicit_reply_observed',
      turnId: 'om_turn_card',
      messageId: 'om_answer_card',
      responseKind: 'final',
      terminalCarrier: 'standard_reply_card',
    } satisfies WorkerToDaemon);
    (ds.worker as any).emit('message', terminalMsg('om_turn_card'));

    await vi.waitFor(() => expect(updateMessage).toHaveBeenCalledWith(
      'app_test',
      'om_answer_card',
      expect.stringContaining('"terminal":"completed"'),
    ));
    expect(getMessageDetail).toHaveBeenCalledWith(
      'app_test',
      'om_answer_card',
      { userCardContent: true },
    );
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });

  it('treats a suppression sentinel as completed when an explicit body was sent', async () => {
    const ds = makeDs();
    bindLarkTurn(ds, 'om_turn_explicit_then_sentinel');
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'explicit_reply_observed',
      turnId: 'om_turn_explicit_then_sentinel',
      messageId: 'om_answer_card',
      responseKind: 'final',
      terminalCarrier: 'standard_reply_card',
    } satisfies WorkerToDaemon);
    (ds.worker as any).emit('message', terminalMsg('om_turn_explicit_then_sentinel', {
      outputDisposition: 'nothing_to_send',
    }));

    await vi.waitFor(() => expect(updateMessage).toHaveBeenCalledWith(
      'app_test',
      'om_answer_card',
      expect.stringContaining('"terminal":"completed"'),
    ));
    expect(ds.silentIdleTurnId).toBeUndefined();
    expect(buildTurnTerminalReceiptCard).not.toHaveBeenCalled();
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });

  it('appends the strip when the last carrier is not patchable', async () => {
    const ds = makeDs();
    bindLarkTurn(ds, 'om_turn_file');
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'explicit_reply_observed',
      turnId: 'om_turn_file',
      messageId: 'om_file',
      responseKind: 'final',
      terminalCarrier: 'non_patchable',
    } satisfies WorkerToDaemon);
    (ds.worker as any).emit('message', terminalMsg('om_turn_file'));

    await vi.waitFor(() => expect(sessionReplyMock).toHaveBeenCalledTimes(1));
    expect(updateMessage).not.toHaveBeenCalledWith('app_test', 'om_file', expect.anything());
  });

  it('does not PATCH a claimed card outside the session chat', async () => {
    const ds = makeDs();
    bindLarkTurn(ds, 'om_turn_cross_chat');
    vi.mocked(getMessageDetail).mockResolvedValueOnce({
      items: [{ chat_id: 'oc_other', msg_type: 'interactive', body: {
        content: JSON.stringify({ schema: '2.0', body: { elements: [] } }),
      } }],
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'explicit_reply_observed',
      turnId: 'om_turn_cross_chat',
      messageId: 'om_other_chat_card',
      terminalCarrier: 'standard_reply_card',
    } satisfies WorkerToDaemon);
    (ds.worker as any).emit('message', terminalMsg('om_turn_cross_chat'));

    await vi.waitFor(() => expect(sessionReplyMock).toHaveBeenCalledTimes(1));
    expect(updateMessage).not.toHaveBeenCalledWith('app_test', 'om_other_chat_card', expect.anything());
  });

  it('uses only the streaming card when the turn produced no visible body', async () => {
    const ds = makeDs();
    ds.workerReady = true;
    ds.streamCardId = 'om_stream';
    ds.lastScreenStatus = 'idle';
    bindLarkTurn(ds, 'om_turn_silent_stream');
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('om_turn_silent_stream', {
      outputDisposition: 'nothing_to_send',
    }));

    await vi.waitFor(() => expect(updateMessage).toHaveBeenCalledWith('app_test', 'om_stream', '{}', expect.objectContaining({ beforeWrite: expect.any(Function) })));
    expect(ds.silentIdleTurnId).toBe('om_turn_silent_stream');
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });

  it('turn ending with nothing_to_send posts the compact silent strip, not the legacy text receipt', async () => {
    const ds = makeDs();
    bindLarkTurn(ds, 'om_turn_silent');
    recordTurnExplicitMention(ds, 'om_turn_silent', true);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('om_turn_silent', {
      outputDisposition: 'nothing_to_send',
    }));

    await vi.waitFor(() => expect(sessionReplyMock).toHaveBeenCalledTimes(1));
    expect(buildTurnTerminalReceiptCard).toHaveBeenCalledWith('silent', expect.anything());
    expect(sessionReplyMock.mock.calls[0]?.[2]).toBe('interactive');
  });

  it('keeps an ambiguous failure on the existing failure-card UI without adding a strip', async () => {
    const ds = makeDs();
    bindLarkTurn(ds, 'om_turn_ambiguous');
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('om_turn_ambiguous', {
      status: 'ambiguous',
      errorCode: 'cli_exit',
    }));

    await vi.waitFor(() => expect(sessionReplyMock).toHaveBeenCalledTimes(1));
    expect(buildTurnFailedCard).toHaveBeenCalledTimes(1);
    expect(buildTurnTerminalReceiptCard).not.toHaveBeenCalled();
  });

  it.each(['failed', 'cancelled'] as const)(
    'does not append a terminal strip for a %s turn',
    async status => {
      const ds = makeDs();
      bindLarkTurn(ds, `om_turn_${status}`);
      __testOnly_setupWorkerHandlers(ds, ds.worker as any);

      (ds.worker as any).emit('message', terminalMsg(`om_turn_${status}`, { status }));

      await new Promise(resolve => setTimeout(resolve, 20));
      expect(buildTurnTerminalReceiptCard).not.toHaveBeenCalled();
    },
  );

  it('waits for the same-turn fallback answer before posting the strip', async () => {
    const ds = makeDs();
    bindLarkTurn(ds, 'om_turn_ordered');
    const finishAnswer = beginFinalOutputDelivery(ds, 'om_turn_ordered');
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('om_turn_ordered'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(sessionReplyMock).not.toHaveBeenCalled();

    finishAnswer();
    await vi.waitFor(() => expect(sessionReplyMock).toHaveBeenCalledTimes(1));
  });

  it('deduplicates duplicate terminal events with one stable provider UUID', async () => {
    const ds = makeDs();
    bindLarkTurn(ds, 'om_turn_duplicate');
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('om_turn_duplicate', { dispatchAttempt: 1 }));
    (ds.worker as any).emit('message', terminalMsg('om_turn_duplicate', { dispatchAttempt: 2 }));

    await vi.waitFor(() => expect(sessionReplyMock).toHaveBeenCalledTimes(1));
    expect(ds.terminalReceiptTurnIds?.has('om_turn_duplicate')).toBe(true);
  });

  it('does not append a stale awaiting-input strip after a newer turn starts', async () => {
    const ds = makeDs();
    bindLarkTurn(ds, 'om_turn_old');
    const finishAnswer = beginFinalOutputDelivery(ds, 'om_turn_old');
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('om_turn_old'));
    ds.currentTurnId = 'om_turn_new';
    finishAnswer();

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(sessionReplyMock).not.toHaveBeenCalled();
    expect(ds.terminalReceiptTurnIds?.has('om_turn_old')).toBe(true);
  });

  it.each([
    ['card-off', { disableStreamingCard: true }],
    ['private-card', { privateCard: true }],
    ['transcript delivery', { replyDelivery: 'transcript' }],
  ])('keeps %s sessions on their existing UI contract', async (_label, override) => {
    Object.assign(botConfig, override);
    const ds = makeDs();
    bindLarkTurn(ds, 'om_turn_excluded');
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('om_turn_excluded'));

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });

  it.each([
    ['card-off', { disableStreamingCard: true }],
    ['private-card', { privateCard: true }],
    ['transcript delivery', { replyDelivery: 'transcript' }],
    ['no-card chat', { noCardChats: ['oc_chat'] }],
  ])('keeps the legacy explicit-@ silent receipt in %s sessions', async (_label, override) => {
    Object.assign(botConfig, override);
    const ds = makeDs();
    bindLarkTurn(ds, 'om_turn_excluded_silent');
    recordTurnExplicitMention(ds, 'om_turn_excluded_silent', true);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('om_turn_excluded_silent', {
      outputDisposition: 'nothing_to_send',
    }));

    await vi.waitFor(() => expect(sessionReplyMock).toHaveBeenCalledTimes(1));
    expect(buildTurnTerminalReceiptCard).not.toHaveBeenCalled();
    expect(sessionReplyMock.mock.calls[0]?.[2]).toBe('text');
  });

  it('does not duplicate the terminal UI of unified reply-card mode', async () => {
    Object.assign(botConfig, { cliId: 'codex', replyCardMode: 'unified' });
    const ds = makeDs();
    ds.session.cliId = 'codex';
    bindLarkTurn(ds, 'om_turn_unified');
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('om_turn_unified'));

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(buildTurnTerminalReceiptCard).not.toHaveBeenCalled();
  });

  it('excludes silent schedules, VC receivers, and turns without a frozen Lark context', async () => {
    const schedule = makeDs();
    bindLarkTurn(schedule, 'schedule:task:fire');
    armSilentScheduledTurn(schedule, 'schedule:task:fire');
    __testOnly_setupWorkerHandlers(schedule, schedule.worker as any);
    (schedule.worker as any).emit('message', terminalMsg('schedule:task:fire'));

    const vc = makeDs();
    (vc.session as any).vcMeetingReceiver = true;
    bindLarkTurn(vc, 'om_turn_vc');
    __testOnly_setupWorkerHandlers(vc, vc.worker as any);
    (vc.worker as any).emit('message', terminalMsg('om_turn_vc'));

    const api = makeDs();
    api.currentTurnId = 'trigger-api';
    __testOnly_setupWorkerHandlers(api, api.worker as any);
    (api.worker as any).emit('message', terminalMsg('trigger-api'));

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });

  it('retries transport failure with the same UUID', async () => {
    const ds = makeDs();
    bindLarkTurn(ds, 'om_turn_retry');
    sessionReplyMock
      .mockRejectedValueOnce(new Error('lark timeout'))
      .mockResolvedValueOnce('om_terminal_receipt' as any);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('om_turn_retry'));
    // Use the production one-second retry delay here. Bun and Node advance
    // promise continuations around fake timers differently, which made this
    // transport assertion runtime-dependent even though the retry was sound.
    await vi.waitFor(() => expect(sessionReplyMock).toHaveBeenCalledTimes(2), {
      timeout: 2_500,
      interval: 20,
    });
    expect((sessionReplyMock.mock.calls[0]?.[5] as any).uuid)
      .toBe((sessionReplyMock.mock.calls[1]?.[5] as any).uuid);
  });
});
