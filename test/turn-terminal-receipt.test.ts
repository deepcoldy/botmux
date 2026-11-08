/**
 * Lifecycle coverage for the independent bottom-of-thread terminal strip.
 * These tests drive the real worker IPC handler so the receipt cannot regress
 * into a prompt convention that depends on the model emitting visible output.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const botConfig: Record<string, unknown> = {
  larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'traex',
};

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  resolveCardKitId: vi.fn(async () => 'card_answer'),
  patchCardStreamElement: vi.fn(async () => {}),
  getMessageDetail: vi.fn(async () => ({
    items: [{ chat_id: 'oc_chat', msg_type: 'interactive', body: {
      content: JSON.stringify({ schema: '2.0', body: { elements: [
        { tag: 'markdown', content: '- item**Next heading**' },
        { tag: 'markdown', element_id: 'botmux_reply_footer', content: 'brand' },
      ] } }),
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
  buildTurnTerminalFooterPatch: vi.fn((card: string, kind: string) => {
    const footer = JSON.parse(card).body?.elements?.find((e: any) => e.element_id === 'botmux_reply_footer');
    return footer ? { content: `${footer.content} terminal:${kind}` } : undefined;
  }),
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

// Fresh per run, not a fixed path: a reply-card record left by an earlier run
// already carries a messageId, so the unified case would PATCH locally where a
// fresh CI runner POSTs — and that late POST is what this file must wait for.
const dataDir = mkdtempSync(join(tmpdir(), 'botmux-terminal-receipt-'));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { get dataDir() { return dataDir; } },
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
import { beginFinalOutputDelivery, waitForFinalOutputDeliveryDrain } from '../src/core/final-output-delivery-drain.js';
import { armSilentScheduledTurn } from '../src/core/silent-schedule-turns.js';
import { buildTurnFailedCard, buildTurnTerminalReceiptCard } from '../src/im/lark/card-builder.js';
import { getMessageDetail, updateMessage, resolveCardKitId, patchCardStreamElement } from '../src/im/lark/client.js';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';

const sessions: DaemonSession[] = [];

function makeDs(): DaemonSession {
  const fakeWorker = new EventEmitter() as any;
  fakeWorker.killed = false;
  fakeWorker.send = vi.fn();
  fakeWorker.kill = vi.fn();
  fakeWorker.pid = 99999;
  fakeWorker.stdout = new EventEmitter();
  fakeWorker.stderr = new EventEmitter();
  const ds = {
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
  sessions.push(ds);
  return ds;
}

/** Invoke the real worker IPC handler exactly as EventEmitter#emit does —
 * synchronously, back to back, in listener order — but keep each async
 * listener's promise, so a test waits for the handler instead of a guessed delay. */
function deliver(ds: DaemonSession, ...msgs: WorkerToDaemon[]): Promise<void> {
  const worker = ds.worker as unknown as EventEmitter;
  return Promise.all(msgs.flatMap(msg =>
    worker.listeners('message').map(listener => listener.call(worker, msg)),
  )).then(() => undefined);
}

/** Wait until every deferred receipt pipeline the handler fenced (strip
 * retries, the interim re-decision) has finished. After the handler has
 * returned, a strip that was going to be posted has been posted by now.
 * Only work registered through beginFinalOutputDelivery is covered: the
 * unified reply-card publication runs outside that fence, so its test waits
 * for the POST itself — any new unfenced background write needs the same. */
async function settle(ds: DaemonSession): Promise<void> {
  expect(await waitForFinalOutputDeliveryDrain(ds, Date.now() + 10_000)).toBe(true);
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

  afterEach(async () => {
    // A fenced delivery still running here would land in the next test, after
    // its mockReset, and be counted against that test's assertions.
    await Promise.all(sessions.splice(0).map(settle));
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
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

  it.each(['traex', 'codex'] as const)('patches only the last standard reply footer (%s)', async cliId => {
    const ds = makeDs();
    botConfig.cliId = cliId;
    ds.session.cliId = cliId;
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

    await vi.waitFor(() => expect(patchCardStreamElement).toHaveBeenCalledWith(
      'app_test', 'card_answer', 'botmux_reply_footer',
      { content: 'brand terminal:completed' }, 1,
      expect.stringMatching(/^trf_[0-9a-f]{47}$/), 'om_answer_card',
    ));
    // A message read is a normalized representation, not a lossless update payload.
    expect(updateMessage).not.toHaveBeenCalled();
    expect(getMessageDetail).toHaveBeenCalledWith(
      'app_test',
      'om_answer_card',
      { userCardContent: true },
    );
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });

  it.each(['progress', 'auxiliary'] as const)(
    'does not promote an explicit %s card to completed',
    async responseKind => {
      const ds = makeDs();
      bindLarkTurn(ds, `om_turn_${responseKind}`);
      __testOnly_setupWorkerHandlers(ds, ds.worker as any);

      await deliver(ds, {
        type: 'explicit_reply_observed',
        turnId: `om_turn_${responseKind}`,
        messageId: `om_${responseKind}_card`,
        responseKind,
        terminalCarrier: 'standard_reply_card',
      }, terminalMsg(`om_turn_${responseKind}`, {
        outputDisposition: 'nothing_to_send',
      }));
      await settle(ds);

      expect(patchCardStreamElement).not.toHaveBeenCalled();
      expect(buildTurnTerminalReceiptCard).not.toHaveBeenCalled();
      expect(sessionReplyMock).not.toHaveBeenCalled();
      expect(ds.terminalReceiptTurnIds?.has(`om_turn_${responseKind}`)).not.toBe(true);
    },
  );

  it.each(['progress', 'auxiliary'] as const)(
    'keeps the explicit final carrier when a later %s send is observed',
    async responseKind => {
      const ds = makeDs();
      bindLarkTurn(ds, `om_turn_final_then_${responseKind}`);
      __testOnly_setupWorkerHandlers(ds, ds.worker as any);

      (ds.worker as any).emit('message', {
        type: 'explicit_reply_observed',
        turnId: `om_turn_final_then_${responseKind}`,
        messageId: 'om_final_card',
        responseKind: 'final',
        terminalCarrier: 'standard_reply_card',
      } satisfies WorkerToDaemon);
      (ds.worker as any).emit('message', {
        type: 'explicit_reply_observed',
        turnId: `om_turn_final_then_${responseKind}`,
        messageId: `om_later_${responseKind}_card`,
        responseKind,
        terminalCarrier: 'standard_reply_card',
      } satisfies WorkerToDaemon);
      (ds.worker as any).emit('message', terminalMsg(`om_turn_final_then_${responseKind}`));

      await vi.waitFor(() => expect(patchCardStreamElement).toHaveBeenCalled());
      expect(getMessageDetail).toHaveBeenCalledWith(
        'app_test',
        'om_final_card',
        { userCardContent: true },
      );
      expect(getMessageDetail).not.toHaveBeenCalledWith(
        'app_test',
        `om_later_${responseKind}_card`,
        expect.anything(),
      );
    },
  );

  it('promotes a later explicit final over an earlier progress carrier', async () => {
    const ds = makeDs();
    bindLarkTurn(ds, 'om_turn_progress_then_final');
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'explicit_reply_observed',
      turnId: 'om_turn_progress_then_final',
      messageId: 'om_progress_card',
      responseKind: 'progress',
      terminalCarrier: 'standard_reply_card',
    } satisfies WorkerToDaemon);
    (ds.worker as any).emit('message', {
      type: 'explicit_reply_observed',
      turnId: 'om_turn_progress_then_final',
      messageId: 'om_final_card',
      responseKind: 'final',
      terminalCarrier: 'standard_reply_card',
    } satisfies WorkerToDaemon);
    (ds.worker as any).emit('message', terminalMsg('om_turn_progress_then_final'));

    await vi.waitFor(() => expect(patchCardStreamElement).toHaveBeenCalled());
    expect(getMessageDetail).toHaveBeenCalledWith(
      'app_test',
      'om_final_card',
      { userCardContent: true },
    );
    expect(getMessageDetail).not.toHaveBeenCalledWith(
      'app_test',
      'om_progress_card',
      expect.anything(),
    );
  });

  it('patches the fallback final card when progress preceded it and the terminal arrives in flight', async () => {
    const ds = makeDs();
    const turnId = 'om_turn_progress_then_fallback';
    bindLarkTurn(ds, turnId);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', {
      type: 'explicit_reply_observed',
      turnId,
      messageId: 'om_progress_card',
      responseKind: 'progress',
      terminalCarrier: 'standard_reply_card',
    } satisfies WorkerToDaemon);

    // Hold the transcript fallback delivery AFTER its in-flight registration
    // but before the Lark round-trip resolves: the fallback final's carrier is
    // recorded only once this resolves — the exact ordered-IPC window in which
    // the worker's back-to-back turn_terminal reaches the daemon.
    let releaseDelivery: ((messageId: string) => void) | undefined;
    sessionReplyMock.mockImplementationOnce(
      () => new Promise<string>(resolve => { releaseDelivery = resolve; }) as any,
    );
    (ds.worker as any).emit('message', {
      type: 'final_output',
      sessionId: 'sid-terminal-receipt',
      content: '最终答复正文',
      lastUuid: 'uuid-fallback-final',
      turnId,
    } satisfies WorkerToDaemon);
    (ds.worker as any).emit('message', terminalMsg(turnId));

    // The card render has an async lead-in; wait until the send actually
    // starts (the Promise executor assigns releaseDelivery synchronously),
    // not just for the in-flight drain registration.
    await vi.waitFor(() => expect(sessionReplyMock).toHaveBeenCalledTimes(1));
    expect(
      ds.finalOutputDeliveriesByTurn?.get(turnId)?.size ?? 0,
    ).toBeGreaterThanOrEqual(1);
    // While the fallback final is still in flight the interim card is not
    // promoted and no independent strip is posted.
    expect(patchCardStreamElement).not.toHaveBeenCalled();
    expect(buildTurnTerminalReceiptCard).not.toHaveBeenCalled();
    expect(getMessageDetail).not.toHaveBeenCalled();
    expect(ds.terminalReceiptTurnIds?.has(turnId)).not.toBe(true);

    releaseDelivery!('om_fallback_final_card');

    await vi.waitFor(() => expect(patchCardStreamElement).toHaveBeenCalledWith(
      'app_test', 'card_answer', 'botmux_reply_footer',
      { content: 'brand terminal:completed' }, 1,
      expect.stringMatching(/^trf_[0-9a-f]{47}$/), 'om_fallback_final_card',
    ));
    // The interim progress card is never patched, and the sole sessionReply
    // call is the fallback card delivery itself — no independent strip.
    expect(getMessageDetail).not.toHaveBeenCalledWith(
      'app_test', 'om_progress_card', expect.anything(),
    );
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    expect(buildTurnTerminalReceiptCard).not.toHaveBeenCalled();
    // The claim is taken only after the drain, once the final has landed.
    expect(ds.terminalReceiptTurnIds?.has(turnId)).toBe(true);
  });

  it.each(['progress', 'auxiliary'] as const)(
    'keeps an interim-only %s turn footerless when no fallback final lands',
    async responseKind => {
      const ds = makeDs();
      const turnId = `om_turn_${responseKind}_no_fallback`;
      bindLarkTurn(ds, turnId);
      __testOnly_setupWorkerHandlers(ds, ds.worker as any);

      // A bare completed terminal (no final_output and no nothing-to-send
      // flag, e.g. the RPC hydration window) must not promote the interim card.
      await deliver(ds, {
        type: 'explicit_reply_observed',
        turnId,
        messageId: `om_${responseKind}_card`,
        responseKind,
        terminalCarrier: 'standard_reply_card',
      }, terminalMsg(turnId));
      await settle(ds);

      expect(patchCardStreamElement).not.toHaveBeenCalled();
      expect(buildTurnTerminalReceiptCard).not.toHaveBeenCalled();
      expect(sessionReplyMock).not.toHaveBeenCalled();
      expect(ds.terminalReceiptTurnIds?.has(turnId)).not.toBe(true);
    },
  );

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

    await vi.waitFor(() => expect(patchCardStreamElement).toHaveBeenCalledWith(
      'app_test', 'card_answer', 'botmux_reply_footer',
      { content: 'brand terminal:completed' }, 1,
      expect.stringMatching(/^trf_[0-9a-f]{47}$/), 'om_answer_card',
    ));
    // A message read is a normalized representation, not a lossless update payload.
    expect(updateMessage).not.toHaveBeenCalled();
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

  it('falls back without rewriting the answer when the footer is missing', async () => {
    const ds = makeDs();
    bindLarkTurn(ds, 'om_turn_no_footer');
    vi.mocked(getMessageDetail).mockResolvedValueOnce({
      items: [{ chat_id: 'oc_chat', msg_type: 'interactive', body: {
        content: JSON.stringify({ schema: '2.0', body: { elements: [] } }),
      } }],
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', {
      type: 'explicit_reply_observed', turnId: 'om_turn_no_footer',
      messageId: 'om_answer', terminalCarrier: 'standard_reply_card',
    } satisfies WorkerToDaemon);
    (ds.worker as any).emit('message', terminalMsg('om_turn_no_footer'));
    await vi.waitFor(() => expect(sessionReplyMock).toHaveBeenCalledTimes(1));
    expect(resolveCardKitId).not.toHaveBeenCalled();
    expect(patchCardStreamElement).not.toHaveBeenCalled();
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('retries one stable footer operation then falls back without replacing the body', async () => {
    const ds = makeDs();
    bindLarkTurn(ds, 'om_turn_patch_failure');
    vi.mocked(patchCardStreamElement)
      .mockRejectedValueOnce(new Error('CardKit unavailable'))
      .mockRejectedValueOnce(new Error('CardKit unavailable'))
      .mockRejectedValueOnce(new Error('CardKit unavailable'));
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', {
      type: 'explicit_reply_observed', turnId: 'om_turn_patch_failure',
      messageId: 'om_answer', terminalCarrier: 'standard_reply_card',
    } satisfies WorkerToDaemon);
    (ds.worker as any).emit('message', terminalMsg('om_turn_patch_failure'));
    // Use the production backoff (0/1/5s) with real timers, like the transport
    // retry case below: fake timers do not drive Bun's async continuations the
    // same way as vitest's, so advancing them never fires the retries.
    await vi.waitFor(() => expect(patchCardStreamElement).toHaveBeenCalledTimes(3), {
      timeout: 8_000,
      interval: 50,
    });
    const calls = vi.mocked(patchCardStreamElement).mock.calls;
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[2]).toEqual(calls[0]);
    await vi.waitFor(() => expect(sessionReplyMock).toHaveBeenCalledTimes(1), {
      timeout: 2_000,
      interval: 20,
    });
    expect(updateMessage).not.toHaveBeenCalled();
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

      await deliver(ds, terminalMsg(`om_turn_${status}`, { status }));
      await settle(ds);

      expect(buildTurnTerminalReceiptCard).not.toHaveBeenCalled();
    },
  );

  it('waits for the same-turn fallback answer before posting the strip', async () => {
    const ds = makeDs();
    bindLarkTurn(ds, 'om_turn_ordered');
    const finishAnswer = beginFinalOutputDelivery(ds, 'om_turn_ordered');
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    await deliver(ds, terminalMsg('om_turn_ordered'));
    // The handler has returned with the strip claimed, yet nothing is posted
    // while the same turn's answer is still in flight.
    expect(ds.terminalReceiptTurnIds?.has('om_turn_ordered')).toBe(true);
    expect(sessionReplyMock).not.toHaveBeenCalled();

    finishAnswer();
    await settle(ds);
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
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

    const handled = deliver(ds, terminalMsg('om_turn_old'));
    ds.currentTurnId = 'om_turn_new';
    finishAnswer();

    await handled;
    await settle(ds);
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

    await deliver(ds, terminalMsg('om_turn_excluded'));
    await settle(ds);

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

    await deliver(ds, terminalMsg('om_turn_unified'));
    await settle(ds);
    // The unified reply card owns the terminal UI and publishes it in the
    // background (store lock + durable write, then POST). Wait for that POST —
    // the reply-card transport is the sender that passes a beforeWrite guard;
    // left running, it lands in the next test after its mockReset.
    await vi.waitFor(() => expect(sessionReplyMock).toHaveBeenCalledWith(
      expect.anything(), expect.any(String), 'interactive', 'app_test', 'om_turn_unified',
      expect.objectContaining({ beforeWrite: expect.any(Function) }),
    ), { timeout: 5_000, interval: 20 });
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    expect(buildTurnTerminalReceiptCard).not.toHaveBeenCalled();
  });

  it('excludes silent schedules, VC receivers, and turns without a frozen Lark context', async () => {
    const schedule = makeDs();
    bindLarkTurn(schedule, 'schedule:task:fire');
    armSilentScheduledTurn(schedule, 'schedule:task:fire');
    __testOnly_setupWorkerHandlers(schedule, schedule.worker as any);
    const scheduleHandled = deliver(schedule, terminalMsg('schedule:task:fire'));

    const vc = makeDs();
    (vc.session as any).vcMeetingReceiver = true;
    bindLarkTurn(vc, 'om_turn_vc');
    __testOnly_setupWorkerHandlers(vc, vc.worker as any);
    const vcHandled = deliver(vc, terminalMsg('om_turn_vc'));

    const api = makeDs();
    api.currentTurnId = 'trigger-api';
    __testOnly_setupWorkerHandlers(api, api.worker as any);
    const apiHandled = deliver(api, terminalMsg('trigger-api'));

    await Promise.all([scheduleHandled, vcHandled, apiHandled]);
    await Promise.all([schedule, vc, api].map(settle));
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
