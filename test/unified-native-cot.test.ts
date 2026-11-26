import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DaemonSession } from '../src/core/types.js';
import { config } from '../src/config.js';
import { getBot, getBotClient } from '../src/bot-registry.js';
import { updateMessage, MessageWithdrawnError } from '../src/im/lark/client.js';
import { replyCardModeFor, queueTurnReplyTools, flushTurnReplyTools, updateTurnReplyCard, updateReplyCardNativeThinking, prepareReplyCardNativeThinking, retireReplyCardDisplay, settleTurnReplyCardTerminal, supersedeTurnReplyCard, __testOnlyDrainTurnReplyTools } from '../src/core/turn-reply-card.js';
import { abortCotMessage, handleCotThinkingSuperseded, handleCotThinkingUpdate, finalizeCotMessage, cotMessageFinishStatus } from '../src/im/lark/cot-message.js';
import { TurnReplyCardStore, ReplyCardWithdrawnError } from '../src/services/turn-reply-card.js';
import { deliverStructuredNotice, StructuredNoticeCardPendingError } from '../src/services/structured-notice-delivery.js';
import { stageBridgeTurnNotice, readBridgeTurnJournal, acknowledgeBridgeTurnNotice } from '../src/services/bridge-turn-journal.js';
import { loadWorkerPoolMessageHandlers } from './helpers/worker-pool-message-harness.js';
import { loadWorkerPoolClosure, loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';
import { OutputDeliveryJournal } from '../src/services/output-delivery-journal.js';
import { OutputDeliveryCoordinator, OutputDeliveryTerminalError } from '../src/services/output-delivery-coordinator.js';
import { outputSnapshot } from '../src/services/universal-output-handoff.js';
import { TurnSendLedger } from '../src/services/turn-send-ledger.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { SessionController } from '../src/core/session-controller.js';

vi.mock('../src/config.js', () => ({ config: { session: { dataDir: '' } } }));
vi.mock('../src/bot-registry.js', () => ({ getBot: vi.fn(), getBotClient: vi.fn(), normalizeUsageDisplay: () => 'off' }));
vi.mock('../src/core/cost-calculator.js', () => ({ getSessionUsageSnapshot: vi.fn(() => ({ context: null, tokens: null })) }));
vi.mock('../src/im/lark/card-handler.js', () => ({ resolveCardOperatorUnionId: vi.fn() }));
vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}), uploadFile: vi.fn(), replyMessage: vi.fn(), sendMessage: vi.fn(),
  MessageWithdrawnError: class extends Error {},
}));

const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

describe('unified replies with an independent native CoT channel', () => {
  let dir: string;
  let bot: ReturnType<typeof getBot>;
  let ds: DaemonSession;
  let request: ReturnType<typeof vi.fn>;
  let send: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.stubEnv('BOTMUX_SANDBOX', undefined);
    dir = mkdtempSync(join(tmpdir(), 'unified-native-cot-'));
    config.session.dataDir = dir;
    bot = { config: { larkAppId: 'app_native', cliId: 'claude-code', replyCardMode: 'unified' } } as ReturnType<typeof getBot>;
    vi.mocked(getBot).mockReturnValue(bot);
    request = vi.fn(async (req: any) => ({ code: 0, data: req.method === 'POST' ? { cot_id: 'cot_native', message_id: 'om_cot' } : {} }));
    vi.mocked(getBotClient).mockReturnValue({ request } as any);
    vi.mocked(updateMessage).mockReset().mockResolvedValue(undefined);
    send = vi.fn(async (_body: string, _type: string, _uuid: string, beforeWrite: () => unknown) => {
      await beforeWrite(); return 'om_answer';
    });
    ds = {
      larkAppId: 'app_native', chatId: 'oc_native', scope: 'thread', currentTurnId: 'om_turn',
      session: { sessionId: 'native-session', rootMessageId: 'om_root', chatId: 'oc_native', status: 'active', cliId: 'claude-code', backendType: 'tmux' },
    } as DaemonSession;
  });
  afterEach(async () => {
    // Queued tool flushes run on 1200ms unref timers and write through the
    // mutable config.session.dataDir. Drain them before removing this test's
    // dir so a late flush can neither race the rmdir nor land in the next test.
    await __testOnlyDrainTurnReplyTools();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  function worker(owns = true, suppressed = false) {
    return loadWorkerPoolMessageHandlers(['thinking_update'], {
      ds, ownsLifecycleMutation: () => owns, managedAuxUiSuppressed: () => suppressed,
      getBot, effectiveCliId: ds.session.cliId, replyCardModeFor, handleCotThinkingUpdate, queueTurnReplyTools, updateReplyCardNativeThinking,
      scopedReply: (body: string, type: string, _turn: string, opts: any) => send(body, type, opts.uuid, opts.beforeWrite),
    });
  }
  function persistentDisplayRetirement(
    owns: () => boolean = () => true,
    retire: typeof retireReplyCardDisplay = retireReplyCardDisplay,
  ) {
    const ipc = { send: vi.fn() };
    const sessionStore = { updateSession: vi.fn() };
    const textRetry = vi.fn(async () => {});
    const logger = { warn: vi.fn(), error: vi.fn() };
    const scope: Record<string, any> = {
      ds, worker: ipc, sessionStore, deliverStructuredNotice, StructuredNoticeCardPendingError,
      TurnReplyCardStore, ReplyCardWithdrawnError, config,
      turnNoticeOutbox: { deliver: textRetry }, turnNoticeHost: vi.fn(() => ({})),
      t: 'fixture', logger, emitSessionLifecycleHook: vi.fn(), managedAuxUiSuppressed: () => false,
      ownsLifecycleMutation: owns, retireReplyCardDisplay: retire, sendTurnNotice: vi.fn(),
      scopedReply: (body: string, type: string, _turn: string, opts: any) => send(body, type, opts.uuid, opts.beforeWrite),
    };
    scope.retireStructuredNoticeCard = loadWorkerPoolFunction('retireStructuredNoticeCard', scope);
    const handle = loadWorkerPoolMessageHandlers(['turn_display_retired'], scope, true);
    const msg = { type: 'turn_display_retired', turnId: 'om_turn', noticeId: 'a'.repeat(32), message: '', silent: true };
    return { handle, msg, ipc, sessionStore, textRetry, logger };
  }

  const update = (text: string) => ({ type: 'thinking_update', sessionId: 'native-session', turnId: 'om_turn', entries: [{ kind: 'thinking', text }] });
  const events = () => request.mock.calls.filter(([req]) => req.method === 'PUT')
    .flatMap(([req]) => req.data.events.map((e: any) => ({ type: e.event_type, content: JSON.parse(e.content) })));
  const finalAnswer = (text: string) => ({ kind: 'final' as const, text, source: 'bridge' as const,
    card: JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: text }] } }) });
  const internalRejection = 'output_internal_bridge_text';
  const attempt = 2;

  function internalOutput() {
    const journal = new OutputDeliveryJournal(dir, ds.larkAppId);
    const sink = { kind: 'im' as const, answerRequired: true as const, chatId: ds.chatId, chatType: 'group' as const,
      context: { target: { mode: 'thread' as const, rootMessageId: 'om_root' } },
      bridgeFinalExcludedTexts: ['generic'] };
    journal.rememberSink(ds.session.sessionId, 'om_turn', sink);
    const snapshot = outputSnapshot(ds.larkAppId, { type: 'final_output', sessionId: ds.session.sessionId,
      turnId: 'om_turn', dispatchAttempt: attempt, lastUuid: 'internal', content: 'generic', kind: 'bridge' });
    const record = journal.accept(snapshot, sink);
    return { journal, record };
  }

  function requiredDisplayScope(journal: OutputDeliveryJournal) {
    const finalize = vi.fn();
    const scope: Record<string, any> = {
      ds, journal, config, TurnSendLedger, INTERNAL_BRIDGE_FINAL_REJECTION: internalRejection,
      replyCardModeFor, retireReplyCardDisplay, settleTurnReplyCardTerminal,
      tr: () => 'reply pending', localeForBot: () => 'en',
      isReplayOfHeldCotTerminal: () => false, releaseHeldCotMessage: vi.fn(),
      cotMessageFinishStatus, hasCotMessageForTurn: () => true, finalizeCotMessage: finalize,
    };
    scope.requiredReplyCotHoldKey = loadWorkerPoolFunction('requiredReplyCotHoldKey', scope);
    scope.finalizeOrHoldCotMessage = loadWorkerPoolFunction('finalizeOrHoldCotMessage', scope);
    scope.requiredReplyDisplayDecision = loadWorkerPoolFunction('requiredReplyDisplayDecision', scope);
    scope.settleRequiredReplyCotMessage = loadWorkerPoolFunction('settleRequiredReplyCotMessage', scope);
    return { scope, finalize };
  }

  function readCard() {
    return new TurnReplyCardStore(dir).read({ larkAppId: ds.larkAppId, sessionId: ds.session.sessionId,
      turnId: 'om_turn', dispatchAttempt: attempt });
  }

  it.each(['claude-code', 'codex'] as const)('keeps a long %s turn on one answer card plus one native bubble', async cli => {
    ds.session.cliId = cli;
    bot.config.cotEnabled = false; // in-card activity off does not mute native CoT
    bot.config.replyCardNativeCot = true;
    const handle = worker();
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
    for (let i = 0; i < 4; i++) {
      const entries = Array.from({ length: i + 1 }, (_, n) => ({ kind: 'text', text: `progress ${n}` }));
      handle({ ...update(''), entries });
      await settle();
      await flushTurnReplyTools(ds, 'om_turn');
    }
    await updateTurnReplyCard(ds, 'om_turn', finalAnswer('final answer'), send);
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'terminal', phase: 'completed' }, send);
    finalizeCotMessage(ds, 'om_turn', 'completed');
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateMessage).mock.calls.every(([, id]) => id === 'om_answer')).toBe(true);
    expect(request.mock.calls.filter(([req]) => req.method === 'POST')).toHaveLength(1);
    expect(events().filter(e => e.type === 'REASONING_MESSAGE_CONTENT').map(e => e.content.delta))
      .toEqual(['progress 0', 'progress 1', 'progress 2', 'progress 3']);
    expect(events().at(-1)?.type).toBe('RUN_FINISHED');
    const card = new TurnReplyCardStore(dir).read({ larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn' })!;
    expect(card.finalText).toBe('final answer');
    expect(card.activity).toEqual([]);
    expect(vi.mocked(updateMessage).mock.calls.at(-1)?.[2]).toContain('final answer');
  });

  it.each(['create', 'prologue'] as const)('waits for a slow native %s before publishing the first answer', async stage => {
    bot.config.replyCardNativeCot = true;
    const order: string[] = [];
    let release!: () => void;
    request.mockImplementation(async (req: any) => {
      if ((stage === 'create' && req.method === 'POST') || (stage === 'prologue' && req.method === 'PUT')) {
        await new Promise<void>(resolve => { release = resolve; });
      }
      order.push(req.method === 'POST' ? 'thinking-created' : 'thinking-initialized');
      return { code: 0, data: req.method === 'POST' ? { cot_id: 'cot_native', message_id: 'om_cot' } : {} };
    });
    send.mockImplementation(async (_body, _type, _uuid, beforeWrite) => {
      await beforeWrite(); order.push('answer'); return 'om_answer';
    });
    const posting = updateTurnReplyCard(ds, 'om_turn', finalAnswer('first answer'), send);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(send).not.toHaveBeenCalled();
    release(); await posting;
    expect(order).toEqual(['thinking-created', 'thinking-initialized', 'answer']);
    // Later refreshes and explicit CLI readiness reuse the same native entity.
    await prepareReplyCardNativeThinking(ds, 'om_turn');
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'refresh' }, send);
    expect(request.mock.calls.filter(([req]) => req.method === 'POST')).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not add native thinking below an already visible answer after a mid-turn enable', async () => {
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
    bot.config.replyCardNativeCot = true;
    worker()(update('late enable'));
    await settle(); await flushTurnReplyTools(ds, 'om_turn');
    expect(request).not.toHaveBeenCalled();
    ds.currentTurnId = 'om_next';
    await updateTurnReplyCard(ds, 'om_next', { kind: 'start' }, send);
    expect(request.mock.calls.filter(([req]) => req.method === 'POST')).toHaveLength(1);
  });

  it('does not create a second thinking message when retrying an answer with a lost ACK', async () => {
    bot.config.replyCardNativeCot = true;
    const healthySend = send.getMockImplementation()!;
    send.mockRejectedValue(new Error('answer ACK lost'));
    await expect(updateTurnReplyCard(ds, 'om_turn', finalAnswer('answer'), send)).rejects.toThrow('answer ACK lost');
    const record = new TurnReplyCardStore(dir).read({ larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn' })!;
    expect(record.nativeCotReady).toBe(true);
    const failedSends = send.mock.calls.length;
    send.mockImplementation(healthySend);
    const restored = { ...ds, session: { ...ds.session } } as DaemonSession;
    await updateTurnReplyCard(restored, 'om_turn', { kind: 'refresh' }, send);
    expect(request.mock.calls.filter(([req]) => req.method === 'POST')).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(failedSends + 1);
    expect(new Set(send.mock.calls.map(call => call[2])).size).toBe(1);
  });

  it.each([undefined, false, true])('keeps native switch=%s independent of in-card activity', async native => {
    bot.config.replyCardNativeCot = native;
    const handle = worker();
    handle(update('reasoning'));
    await settle(); await flushTurnReplyTools(ds, 'om_turn');
    expect(request.mock.calls.some(([req]) => req.method === 'POST')).toBe(native === true);
    const card = new TurnReplyCardStore(dir).read({ larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn' })!;
    expect(card.activity).not.toEqual([]);
    expect(send).toHaveBeenCalledTimes(native === true ? 0 : 1);
    finalizeCotMessage(ds, 'om_turn', 'completed'); await settle();
  });

  it.each(['chat-off', 'stale-worker', 'managed-ui', 'wrong-session'] as const)('keeps %s updates from publishing native CoT', async reason => {
    bot.config.replyCardNativeCot = true;
    if (reason === 'chat-off') bot.config.noCotChats = [ds.chatId];
    worker(reason !== 'stale-worker', reason === 'managed-ui')({ ...update('hidden'), ...(reason === 'wrong-session' ? { sessionId: 'other' } : {}) });
    await settle(); await flushTurnReplyTools(ds, 'om_turn');
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['rejected', 'business-error', 'prologue-failed', 'chat-off-after-admission'] as const)('continues the answer card when native CoT is unavailable (%s), without sending a fallback answer', async failure => {
    bot.config.replyCardNativeCot = true;
    if (failure === 'rejected') request.mockRejectedValue(new Error('CoT unavailable'));
    if (failure === 'business-error') request.mockResolvedValue({ code: 99991672, msg: 'Access denied' });
    // The bubble exists, but its first push failed: it no longer carries progress.
    if (failure === 'prologue-failed') request.mockImplementation(async (req: any) => {
      if (req.method === 'POST' && String(req.url).endsWith('/message_cot')) return { code: 0, data: { cot_id: 'cot_native', message_id: 'om_cot' } };
      throw new Error('CoT push unavailable');
    });
    // Admission froze nativeCot=true; `/cot off` afterwards pauses the native channel.
    expect(replyCardModeFor(ds, 'om_turn')).toBe('unified');
    if (failure === 'chat-off-after-admission') bot.config.noCotChats = [ds.chatId];
    const handle = worker();
    handle(update('first')); await settle(); await flushTurnReplyTools(ds, 'om_turn');
    // Without a live thinking display the answer card is the progress surface.
    expect(send).toHaveBeenCalledTimes(1);
    handle(update('later')); await settle(); await flushTurnReplyTools(ds, 'om_turn');
    await updateTurnReplyCard(ds, 'om_turn', finalAnswer('answer survives'), send);
    expect(send).toHaveBeenCalledTimes(1);
    const creates = request.mock.calls.filter(([req]) => req.method === 'POST' && String(req.url).endsWith('/message_cot'));
    expect(creates).toHaveLength(failure === 'chat-off-after-admission' ? 0 : 1);
    expect(vi.mocked(updateMessage).mock.calls.at(-1)?.[2]).toContain('answer survives');
    const record = new TurnReplyCardStore(dir).read({ larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn' })!;
    expect(record).toMatchObject({ nativeCot: true, nativeCotReady: true });
    expect(record.nativeCotVisible).toBeUndefined();
  });

  it.each(['newer-turn', 'worker-lost', 'switched-off'] as const)('hands progress back to the answer card when native thinking retires mid-turn (%s)', async retirement => {
    bot.config.replyCardNativeCot = true;
    let cot = 0;
    request.mockImplementation(async (req: any) => ({ code: 0,
      data: req.method === 'POST' && String(req.url).endsWith('/message_cot') ? { cot_id: `cot_${++cot}`, message_id: `om_cot_${cot}` } : {} }));
    const handle = worker();
    const turnUpdate = (turnId: string, ...texts: string[]) => ({ type: 'thinking_update', sessionId: 'native-session', turnId,
      entries: texts.map(text => ({ kind: 'thinking', text })) });
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'refresh' }, send);
    handle(turnUpdate('om_turn', 'reading')); await settle(); await flushTurnReplyTools(ds, 'om_turn');
    expect(send).not.toHaveBeenCalled();
    if (retirement === 'newer-turn') {
      // A type-ahead follow-up is admitted while this turn keeps running.
      ds.currentTurnId = 'om_next';
      await updateTurnReplyCard(ds, 'om_next', { kind: 'refresh' }, send);
      await settle();
      expect(send).not.toHaveBeenCalled();
    } else if (retirement === 'worker-lost') {
      abortCotMessage(ds); await settle();
    } else {
      bot.config.noCotChats = [ds.chatId];
    }
    handle(turnUpdate('om_turn', 'reading', 'fixing')); await settle(); await flushTurnReplyTools(ds, 'om_turn');
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'progress', text: 'fix applied, running tests' }, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateMessage).mock.calls.at(-1)?.[2]).toContain('fix applied, running tests');
    const record = new TurnReplyCardStore(dir).read({ larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn' })!;
    expect(record.nativeCotVisible).toBeUndefined();
    if (retirement === 'newer-turn') {
      const next = new TurnReplyCardStore(dir).read({ larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_next' })!;
      expect(next).toMatchObject({ nativeCotVisible: true });
      expect(next.messageId).toBeUndefined();
    }
  });

  it.each([false, true])('keeps a handed-back turn on the answer card when the native channel is switched on again (/cot show=%s)', async shown => {
    bot.config.replyCardNativeCot = true;
    const handle = worker();
    const pushedText = () => JSON.stringify(request.mock.calls.filter(([req]) => req.method === 'PUT'));
    // Worker snapshots are cumulative.
    const steps = (count: number) => ({ ...update(''), entries: Array.from({ length: count }, (_, i) => ({ kind: 'thinking', text: `step ${i + 1}` })) });
    handle(steps(1)); await settle(); await flushTurnReplyTools(ds, 'om_turn');
    bot.config.noCotChats = [ds.chatId];
    handle(steps(2)); await settle(); await flushTurnReplyTools(ds, 'om_turn');
    expect(send).toHaveBeenCalledTimes(1);
    expect(new TurnReplyCardStore(dir).read({ larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn' }))
      .toMatchObject({ nativeCotHandedBack: true });
    // Switching the channel back on keeps progress on the card; `/cot show` asks for both.
    if (shown) ds.cotForced = true;
    else bot.config.noCotChats = [];
    handle(steps(3)); await settle(); await flushTurnReplyTools(ds, 'om_turn');
    expect(pushedText()).toContain('step 1');
    if (shown) expect(pushedText()).toContain('step 3');
    else expect(pushedText()).not.toContain('step 3');
    expect(vi.mocked(updateMessage).mock.calls.length).toBeGreaterThan(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps feeding native thinking when the barrier record predates the visibility field', async () => {
    bot.config.replyCardNativeCot = true;
    const handle = worker();
    // An older CLI ran the barrier: the display exists, but only nativeCotReady was written.
    expect(replyCardModeFor(ds, 'om_turn')).toBe('unified');
    expect(await prepareReplyCardNativeThinking(ds, 'om_turn')).toBe(true);
    const store = new TurnReplyCardStore(dir);
    const key = { larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn' };
    await store.update(key, { kind: 'progress', text: 'from an older CLI' }, {
      render: () => JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'card' }] } }),
      beforeEffect: () => {}, beforeCreate: async () => undefined, isWithdrawn: () => false,
      send: async () => 'om_cli_card', patch: async () => {},
    });
    expect(store.read(key)).toMatchObject({ nativeCotReady: true, messageId: 'om_cli_card' });
    handle({ ...update(''), entries: [{ kind: 'thinking', text: 'thinking 1' }, { kind: 'thinking', text: 'thinking 2' }] });
    await settle();
    expect(JSON.stringify(request.mock.calls.filter(([req]) => req.method === 'PUT'))).toContain('thinking 2');
  });

  it('does not hand a steer-merged turn back to a card before it is superseded', async () => {
    bot.config.replyCardNativeCot = true;
    const handle = worker();
    handle(update('reading')); await settle(); await flushTurnReplyTools(ds, 'om_turn');
    // The worker's last cumulative update is still buffered when the steer is confirmed.
    handle(update('reading', 'merging')); await settle();
    expect(handleCotThinkingSuperseded(ds, { type: 'thinking_superseded', sessionId: 'native-session', turnId: 'om_turn' } as any)).toBe(true);
    await settle(); await flushTurnReplyTools(ds, 'om_turn');
    await supersedeTurnReplyCard(ds, { turnId: 'om_turn' }, send, () => true);
    expect(send).not.toHaveBeenCalled();
    expect(new TurnReplyCardStore(dir).read({ larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn' })).toMatchObject({ phase: 'superseded', nativeCotVisible: true });
  });

  it.each([true, false])('reports native thinking as live to the answer barrier only when it carries the turn (switched off mid-create=%s)', async switchedOff => {
    bot.config.replyCardNativeCot = true;
    let releaseCreate!: () => void;
    request.mockImplementation(async (req: any) => {
      if (req.method === 'POST' && String(req.url).endsWith('/message_cot')) {
        await new Promise<void>(resolve => { releaseCreate = resolve; });
        return { code: 0, data: { cot_id: 'cot_native', message_id: 'om_cot' } };
      }
      return { code: 0, data: {} };
    });
    expect(replyCardModeFor(ds, 'om_turn')).toBe('unified');
    const ready = prepareReplyCardNativeThinking(ds, 'om_turn');
    await vi.waitFor(() => expect(releaseCreate).toBeTypeOf('function'));
    if (switchedOff) bot.config.noCotChats = [ds.chatId];
    releaseCreate();
    expect(await ready).toBe(!switchedOff);
  });

  it('keeps a finished turn on native thinking so a separately sent final adds no summary card', async () => {
    bot.config.replyCardNativeCot = true;
    const handle = worker();
    handle(update('reading')); await settle(); await flushTurnReplyTools(ds, 'om_turn');
    const key = { larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn' };
    expect(await new TurnReplyCardStore(dir).noteExternalFinal(key, ds.chatId)).toBe(true);
    // worker-pool starts the terminal card update, then settles the native display.
    const terminal = updateTurnReplyCard(ds, 'om_turn', { kind: 'terminal', phase: 'completed' }, send);
    finalizeCotMessage(ds, 'om_turn', 'completed');
    await terminal; await settle();
    expect(send).not.toHaveBeenCalled();
    expect(new TurnReplyCardStore(dir).read(key)).toMatchObject({ phase: 'completed', nativeCotVisible: true, externalFinal: true });
  });

  it.each([false, true])('settles eager thinking when its transcript never starts (card update failure=%s)', async fail => {
    bot.config.replyCardNativeCot = true;
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
    expect(send).not.toHaveBeenCalled();
    const fallback = vi.fn(async () => {});
    const handle = loadWorkerPoolMessageHandlers(['turn_display_retired'], {
      ds, t: 'fixture', logger: { warn: vi.fn(), error: vi.fn() }, emitSessionLifecycleHook: vi.fn(),
      sendTurnNotice: fallback, fallbackTurnId: (_ds: unknown, turn: string) => turn,
      managedAuxUiSuppressed: () => false, ownsLifecycleMutation: () => true,
      finalizeCotMessage, replyCardModeFor, flushTurnReplyTools,
      retireReplyCardDisplay: fail ? vi.fn(async () => { finalizeCotMessage(ds, 'om_turn', 'ambiguous'); throw new Error('PATCH unavailable'); }) : retireReplyCardDisplay,
      scopedReply: (body: string, type: string, _turn: string, opts: any) => send(body, type, opts.uuid, opts.beforeWrite),
    }, true);
    await handle({ type: 'turn_display_retired', turnId: 'om_turn', message: 'Transcript unavailable' });
    await settle();
    expect(send).toHaveBeenCalledTimes(fail ? 0 : 1);
    expect(request.mock.calls.some(([req]) => req.url.includes('/complete/'))).toBe(true);
    if (fail) {
      expect(fallback).toHaveBeenCalledTimes(1);
      expect(fallback).toHaveBeenCalledWith(ds, expect.objectContaining({ turnId: 'om_turn', content: 'Transcript unavailable' }), expect.any(Function));
    }
    else {
      expect(fallback).not.toHaveBeenCalled();
      expect(new TurnReplyCardStore(dir).read({ larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn' })?.phase).toBe('ambiguous');
      expect(send.mock.calls.at(-1)?.[0]).toContain('Transcript unavailable');
    }
  });

  it('silently retires an external-final display without adding a contradictory warning', async () => {
    bot.config.replyCardNativeCot = true;
    const key = { larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn' };
    // Prepare a real record without ever displaying a card or native bubble.
    new TurnReplyCardStore(dir).prepareSync(key, { mode: 'unified', chatId: ds.chatId, rootId: ds.session.rootMessageId });
    expect(await new TurnReplyCardStore(dir).noteExternalFinal(key, ds.chatId)).toBe(true);
    const fallback = vi.fn(async () => {});
    const handle = loadWorkerPoolMessageHandlers(['turn_display_retired'], {
      ds, t: 'fixture', logger: { warn: vi.fn(), error: vi.fn() }, emitSessionLifecycleHook: vi.fn(),
      sendTurnNotice: fallback, fallbackTurnId: (_ds: unknown, turn: string) => turn,
      managedAuxUiSuppressed: () => false, ownsLifecycleMutation: () => true,
      finalizeCotMessage, replyCardModeFor, flushTurnReplyTools, retireReplyCardDisplay,
      scopedReply: (body: string, type: string, _turn: string, opts: any) => send(body, type, opts.uuid, opts.beforeWrite),
    }, true);
    ds.replyCardRunningTurnId = 'om_turn';
    await handle({ type: 'turn_display_retired', turnId: 'om_turn', message: '', silent: true });
    await settle();
    expect(ds.replyCardRunningTurnId).toBeUndefined();
    expect(fallback).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(new TurnReplyCardStore(dir).read(key)).toMatchObject({
      externalFinal: true, phase: 'completed', displayRetired: true, progress: [],
    });
    // A later recovery pass sees the persisted display retirement and still
    // does not create a card for the already externally delivered turn.
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'recover' }, send);
    expect(send).not.toHaveBeenCalled();
  });

  it('retires a visible external-final card to a silent completed display', async () => {
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
    const key = { larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn' };
    expect(await new TurnReplyCardStore(dir).noteExternalFinal(key, ds.chatId)).toBe(true);
    const fallback = vi.fn(async () => {});
    const handle = loadWorkerPoolMessageHandlers(['turn_display_retired'], {
      ds, t: 'fixture', logger: { warn: vi.fn(), error: vi.fn() }, emitSessionLifecycleHook: vi.fn(),
      sendTurnNotice: fallback, fallbackTurnId: (_ds: unknown, turn: string) => turn,
      managedAuxUiSuppressed: () => false, ownsLifecycleMutation: () => true,
      finalizeCotMessage, replyCardModeFor, flushTurnReplyTools, retireReplyCardDisplay,
      scopedReply: (body: string, type: string, _turn: string, opts: any) => send(body, type, opts.uuid, opts.beforeWrite),
    }, true);
    await handle({ type: 'turn_display_retired', turnId: 'om_turn', message: '', silent: true });
    await settle();
    expect(fallback).not.toHaveBeenCalled();
    expect(new TurnReplyCardStore(dir).read(key)).toMatchObject({
      phase: 'completed', externalFinal: true, displayRetired: true, progress: [],
    });
    expect(new TurnReplyCardStore(dir).read(key)?.lastCard).not.toContain('botmux_turn_progress_');
  });

  it('continues silent retirement when the first card POST completes while retirement waits for its lock', async () => {
    let createStarted!: () => void;
    let releaseCreate!: () => void;
    const started = new Promise<void>(resolve => { createStarted = resolve; });
    const gate = new Promise<void>(resolve => { releaseCreate = resolve; });
    send.mockImplementationOnce(async (_body, _type, _uuid, beforeWrite) => {
      await beforeWrite();
      createStarted();
      await gate;
      return 'om_answer';
    });
    const key = { larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn' };
    new TurnReplyCardStore(dir).prepareSync(key, { mode: 'unified', chatId: ds.chatId, rootId: ds.session.rootMessageId });
    expect(await new TurnReplyCardStore(dir).noteExternalFinal(key, ds.chatId)).toBe(true);
    const creating = updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
    await started;
    const retiring = retireReplyCardDisplay(ds, { turnId: 'om_turn', message: '', silent: true }, send, () => true);
    releaseCreate();
    await Promise.all([creating, retiring]);
    expect(new TurnReplyCardStore(dir).read(key)).toMatchObject({
      messageId: 'om_answer', phase: 'completed', displayRetired: true, externalFinal: true,
    });
  }, 10_000);

  it('does not flush buffered activity into a new card for a silent never-shown display', async () => {
    const key = { larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn' };
    new TurnReplyCardStore(dir).prepareSync(key, { mode: 'unified', chatId: ds.chatId, rootId: ds.session.rootMessageId });
    queueTurnReplyTools(ds, { turnId: 'om_turn', entries: [{ kind: 'thinking', text: 'buffered before retirement' }] }, send, () => true);
    await expect(retireReplyCardDisplay(ds, { turnId: 'om_turn', message: '', silent: true }, send, () => true)).resolves.toBe(true);
    await __testOnlyDrainTurnReplyTools();
    expect(send).not.toHaveBeenCalled();
    expect(new TurnReplyCardStore(dir).read(key)).toMatchObject({ phase: 'completed', displayRetired: true });
  });

  it.each(['legacy', 'unified'] as const)('keeps the %s CoT open while a final receipt is pending', async mode => {
    bot.config.replyCardMode = mode;
    bot.config.replyCardNativeCot = true;
    if (mode === 'unified') await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
    const turn = { turnId: 'om_turn' };
    await retireReplyCardDisplay(ds, { ...turn, message: 'reply pending', preserveCot: true }, send, () => true);
    expect(cotMessageFinishStatus(ds, turn)).toBeUndefined();
    finalizeCotMessage(ds, turn.turnId, 'completed');
    expect(cotMessageFinishStatus(ds, turn)).toBe('done');
  });

  it.each(['legacy', 'unified'] as const)('settles a current terminal after an internal rejection as failed (%s)', async mode => {
    bot.config.replyCardMode = mode;
    const { journal, record } = internalOutput();
    try {
      if (mode === 'unified') await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send, { dispatchAttempt: attempt });
      expect(journal.claim(record.id, 'owner')).toBe(true);
      expect(journal.rejectTerminal(record.id, 'owner', internalRejection)).toBe(true);
      const { scope, finalize } = requiredDisplayScope(journal);
      const settleDisplay = loadWorkerPoolFunction<(
        session: DaemonSession, msg: any, outputs: OutputDeliveryJournal, sender: typeof send,
        owns: () => boolean, suppress: boolean, publishMissing: () => void,
      ) => { settleCard?: Promise<void | boolean>; requiredReplyMissing: boolean }>('settleCurrentTurnDisplay', scope);
      const result = settleDisplay(ds, { type: 'turn_terminal', sessionId: ds.session.sessionId,
        turnId: 'om_turn', dispatchAttempt: attempt, status: 'completed' }, journal, send, () => true, false, vi.fn());
      await result.settleCard;
      expect(result.requiredReplyMissing).toBe(true);
      expect(ds.requiredReplyCotHolds).toBeUndefined();
      expect(finalize).toHaveBeenCalledExactlyOnceWith(ds, 'om_turn', 'failed', attempt);
      if (mode === 'unified') expect(readCard()).toMatchObject({ phase: 'failed' });
      else expect(result.settleCard).toBeUndefined();
    } finally {
      journal.close();
    }
  });

  it.each(['legacy', 'unified'] as const)('settles the reply card when rejection follows a pending terminal (%s)', async mode => {
    bot.config.replyCardMode = mode;
    const { journal, record } = internalOutput();
    const worker = { send: vi.fn() };
    ds.worker = worker as any;
    ds.chatType = 'group';
    ds.initConfig = { finalOutputHandoff: { version: 2, token: 'tok' } } as any;
    try {
      if (mode === 'unified') {
        await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send, { dispatchAttempt: attempt });
        await retireReplyCardDisplay(ds, { turnId: 'om_turn', dispatchAttempt: attempt,
          message: 'reply pending', preserveCot: true }, send, () => true);
        expect(readCard()).toMatchObject({ phase: 'ambiguous', displayRetired: true });
      }
      const { scope, finalize } = requiredDisplayScope(journal);
      ds.requiredReplyCotHolds = new Map([[scope.requiredReplyCotHoldKey('om_turn', attempt), {
        turnId: 'om_turn', dispatchAttempt: attempt, finishStatus: 'completed', replyPending: true, backgroundPending: false,
      }]]);
      Object.assign(scope, {
        worker, t: 'probe', coordinator: new OutputDeliveryCoordinator(journal),
        ownsLifecycleMutation: () => true, ownsWorkerSession: () => true, isSessionTransferring: () => false,
        sessionController: undefined, managedAuxUiSuppressed: () => false,
        processFinalOutput: async () => { throw new OutputDeliveryTerminalError(internalRejection); },
        assertFrozenImDeliveryAllowed: vi.fn(), classifyFinalPublicationError: (error: unknown) => error,
        raiseDaemonAttention: () => false, publishAttentionPatch: vi.fn(), publishScopedImDeliveryStatus: vi.fn(),
        shouldDropMismatchedFinalOutput: () => false, shouldDropMismatchedHermesFinalOutput: () => false,
        scopedReply: (body: string, type: string, _turn: string, opts: any) => send(body, type, opts.uuid, opts.beforeWrite),
        logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });
      const runOutput = loadWorkerPoolClosure<(value: typeof record) => Promise<void>>('runOutput', scope);
      await runOutput(record);
      if (mode === 'unified') {
        await vi.waitFor(() => expect(readCard()).toMatchObject({ phase: 'failed' }), { timeout: 2_000 });
      } else {
        await settle();
        expect(readCard()).toBeUndefined();
      }
      expect(journal.read(record.id)).toMatchObject({ state: 'rejected', reason: internalRejection });
      expect(ds.requiredReplyCotHolds).toBeUndefined();
      expect(finalize).toHaveBeenCalledExactlyOnceWith(ds, 'om_turn', 'failed', attempt);
      expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'final_output_settled', id: record.id }));
    } finally {
      journal.close();
    }
  });

  it('replays the pending first POST through silent retirement and then patches the same card', async () => {
    const healthySend = send.getMockImplementation()!;
    send.mockRejectedValue(new Error('answer ACK lost'));
    await expect(updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send)).rejects.toThrow('answer ACK lost');
    const first = send.mock.calls[0];
    const failedSends = send.mock.calls.length;
    const key = { larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn' };
    expect(new TurnReplyCardStore(dir).read(key)?.pendingCreate).toBeDefined();

    send.mockImplementation(healthySend);
    await expect(retireReplyCardDisplay(ds, { turnId: 'om_turn', message: '', silent: true }, send, () => true)).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(failedSends + 1);
    expect(send.mock.calls.at(-1)!.slice(0, 3)).toEqual(first.slice(0, 3));
    expect(vi.mocked(updateMessage)).toHaveBeenCalledOnce();
    const retired = new TurnReplyCardStore(dir).read(key)!;
    expect(retired).toMatchObject({ messageId: 'om_answer', phase: 'completed', displayRetired: true });
    expect(retired.pendingCreate).toBeUndefined();
    expect(retired.pendingPatch).toBeUndefined();
    expect(retired.publishPending).toBeUndefined();
  }, 10_000);

  it('does not touch runtime or persistent display state when retirement does not own the turn', async () => {
    ds.replyCardRunningTurnId = 'om_turn';
    await expect(retireReplyCardDisplay(ds, { turnId: 'om_turn', message: '', silent: true }, send, () => false)).resolves.toBe(false);
    expect(ds.replyCardRunningTurnId).toBe('om_turn');
    expect(send).not.toHaveBeenCalled();
    expect(new TurnReplyCardStore(dir).read({
      larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn',
    })).toBeUndefined();
  });

  it('leaves the running-turn marker and record intact when ownership is lost at the publication barrier', async () => {
    const key = { larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn' };
    new TurnReplyCardStore(dir).prepareSync(key, { mode: 'unified', chatId: ds.chatId, rootId: ds.session.rootMessageId });
    const before = new TurnReplyCardStore(dir).read(key);
    ds.replyCardRunningTurnId = 'om_turn';
    let checks = 0;
    const owns = () => ++checks === 1;
    await expect(retireReplyCardDisplay(ds, { turnId: 'om_turn', message: '', silent: true }, send, owns))
      .rejects.toThrow('no longer owns delivery');
    expect(ds.replyCardRunningTurnId).toBe('om_turn');
    expect(new TurnReplyCardStore(dir).read(key)).toEqual(before);
    expect(send).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['legacy', 'unified'] as const)('finishes an active native CoT bubble as done on silent %s retirement', async mode => {
    if (mode === 'legacy') {
      bot.config.replyCardMode = 'legacy';
      bot.config.cotEnabled = true;
    } else {
      bot.config.replyCardNativeCot = true;
    }
    worker()(update('still thinking'));
    await settle();
    expect(request.mock.calls.some(([req]) => req.method === 'POST' && String(req.url).endsWith('/message_cot'))).toBe(true);
    await retireReplyCardDisplay(ds, { turnId: 'om_turn', message: '', silent: true }, send, () => true);
    await settle();
    expect(events().filter(event => event.type === 'RUN_FINISHED')).toEqual([
      { type: 'RUN_FINISHED', content: expect.objectContaining({ status: 'done' }) },
    ]);
    expect(request.mock.calls.filter(([req]) => req.url.includes('/complete/'))).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not fall back to a warning when silent retirement PATCH fails after a delivered final', async () => {
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
    await updateTurnReplyCard(ds, 'om_turn', finalAnswer('Already delivered'), send);
    vi.mocked(updateMessage)
      .mockRejectedValueOnce(new Error('PATCH unavailable'))
      .mockRejectedValueOnce(new Error('PATCH unavailable'))
      .mockRejectedValueOnce(new Error('PATCH unavailable'));
    const fallback = vi.fn(async () => {});
    const handle = loadWorkerPoolMessageHandlers(['turn_display_retired'], {
      ds, t: 'fixture', logger: { warn: vi.fn(), error: vi.fn() }, emitSessionLifecycleHook: vi.fn(),
      sendTurnNotice: fallback, fallbackTurnId: (_ds: unknown, turn: string) => turn,
      managedAuxUiSuppressed: () => false, ownsLifecycleMutation: () => true,
      finalizeCotMessage, replyCardModeFor, flushTurnReplyTools, retireReplyCardDisplay,
      scopedReply: (body: string, type: string, _turn: string, opts: any) => send(body, type, opts.uuid, opts.beforeWrite),
    }, true);
    await handle({ type: 'turn_display_retired', turnId: 'om_turn', message: '', silent: true });
    await settle();
    expect(fallback).not.toHaveBeenCalled();
    expect(new TurnReplyCardStore(dir).read({
      larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn',
    })).toMatchObject({ finalDelivered: true, displayRetired: true, progress: [] });
  });

  it('keeps silent legacy retirement off the user-visible warning path', async () => {
    bot.config.replyCardMode = 'legacy';
    const fallback = vi.fn(async () => {});
    const handle = loadWorkerPoolMessageHandlers(['turn_display_retired'], {
      ds, t: 'fixture', logger: { warn: vi.fn(), error: vi.fn() }, emitSessionLifecycleHook: vi.fn(),
      sendTurnNotice: fallback, fallbackTurnId: (_ds: unknown, turn: string) => turn,
      managedAuxUiSuppressed: () => false, ownsLifecycleMutation: () => true,
      finalizeCotMessage, replyCardModeFor, flushTurnReplyTools, retireReplyCardDisplay,
      scopedReply: send,
    }, true);
    await handle({ type: 'turn_display_retired', turnId: 'om_turn', message: '', silent: true });
    await settle();
    expect(fallback).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('coalesces overlapping display retirement and user notification into the existing topic reply card', async () => {
    bot.config.replyCardNativeCot = true;
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
    const fallback = vi.fn(async () => {});
    const handle = loadWorkerPoolMessageHandlers(['turn_display_retired', 'user_notify'], {
      ds, t: 'fixture', logger: { warn: vi.fn(), error: vi.fn() }, emitSessionLifecycleHook: vi.fn(),
      sendTurnNotice: fallback, managedAuxUiSuppressed: () => false, ownsLifecycleMutation: () => true,
      retireReplyCardDisplay,
      scopedReply: (body: string, type: string, _turn: string, opts: any) => send(body, type, opts.uuid, opts.beforeWrite),
    }, true);
    await Promise.all([
      handle({ type: 'turn_display_retired', turnId: 'om_turn', message: 'Transcript unavailable' }),
      handle({ type: 'user_notify', kind: 'structured_turn_not_collected', turnId: 'om_turn', message: 'Transcript unavailable' }),
    ]);
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    const record = new TurnReplyCardStore(dir).read({ larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn' });
    expect(record).toMatchObject({ phase: 'ambiguous', progress: ['Transcript unavailable'] });
  });

  it('dedupes a durable structured notice when its daemon ACK is lost', async () => {
    const worker = { send: vi.fn() };
    const sessionStore = { updateSession: vi.fn() };
    const scope: Record<string, any> = {
      ds, worker, sessionStore, deliverStructuredNotice, StructuredNoticeCardPendingError,
      TurnReplyCardStore, ReplyCardWithdrawnError, config,
      t: 'fixture', logger: { warn: vi.fn(), error: vi.fn() },
      emitSessionLifecycleHook: vi.fn(), managedAuxUiSuppressed: () => false, ownsLifecycleMutation: () => true,
      retireReplyCardDisplay,
      scopedReply: (body: string, type: string, _turn: string, opts: any) => send(body, type, opts.uuid, opts.beforeWrite),
    };
    scope.retireStructuredNoticeCard = loadWorkerPoolFunction('retireStructuredNoticeCard', scope);
    const handle = loadWorkerPoolMessageHandlers(['user_notify'], scope, true);
    const msg = { type: 'user_notify', kind: 'structured_turn_not_collected', turnId: 'om_turn',
      message: 'Transcript unavailable', noticeId: 'a'.repeat(32) };
    await handle(msg);
    await handle(msg); // same UUID after the first ACK was not observed by the worker

    expect(send).toHaveBeenCalledOnce();
    expect(worker.send).toHaveBeenCalledTimes(2);
    expect(worker.send).toHaveBeenCalledWith({
      type: 'structured_turn_not_collected_ack', turnId: 'om_turn', noticeId: 'a'.repeat(32),
    });
    expect(ds.session.turnNotices).toHaveLength(1);
    expect(ds.session.turnNotices?.[0]?.delivery).toMatchObject({ uuid: msg.noticeId, state: 'delivered' });
    expect(new TurnReplyCardStore(dir).read({
      larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn',
    })).toMatchObject({ phase: 'ambiguous', progress: ['Transcript unavailable'] });
  });

  it('keeps an unknown warning PATCH on the card and withholds ACK until its replay succeeds', async () => {
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
    const worker = { send: vi.fn() };
    const sessionStore = { updateSession: vi.fn() };
    const textRetry = vi.fn(async () => {});
    const scope: Record<string, any> = {
      ds, worker, sessionStore, deliverStructuredNotice, StructuredNoticeCardPendingError,
      TurnReplyCardStore, ReplyCardWithdrawnError, config,
      turnNoticeOutbox: { deliver: textRetry }, turnNoticeHost: vi.fn(),
      t: 'fixture', logger: { warn: vi.fn(), error: vi.fn() },
      emitSessionLifecycleHook: vi.fn(), managedAuxUiSuppressed: () => false, ownsLifecycleMutation: () => true,
      retireReplyCardDisplay,
      scopedReply: (body: string, type: string, _turn: string, opts: any) => send(body, type, opts.uuid, opts.beforeWrite),
    };
    scope.retireStructuredNoticeCard = loadWorkerPoolFunction('retireStructuredNoticeCard', scope);
    const handle = loadWorkerPoolMessageHandlers(['user_notify'], scope, true);
    const msg = { type: 'user_notify', kind: 'structured_turn_not_collected', turnId: 'om_turn',
      message: 'Transcript unavailable', noticeId: 'a'.repeat(32) };
    vi.mocked(updateMessage).mockRejectedValue(new Error('socket hang up'));
    await handle(msg);
    expect(worker.send).not.toHaveBeenCalled();
    expect(textRetry).not.toHaveBeenCalled();
    expect(ds.session.turnNotices?.[0]?.delivery.state).toBe('pending');
    expect(new TurnReplyCardStore(dir).read({
      larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn',
    })?.pendingPatch).toBeDefined();

    vi.mocked(updateMessage).mockResolvedValue(undefined);
    await handle(msg);
    expect(textRetry).not.toHaveBeenCalled();
    expect(worker.send).toHaveBeenCalledOnce();
    expect(worker.send).toHaveBeenCalledWith({
      type: 'structured_turn_not_collected_ack', turnId: 'om_turn', noticeId: msg.noticeId,
    });
    const retired = new TurnReplyCardStore(dir).read({
      larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn',
    });
    expect(retired).toMatchObject({ phase: 'ambiguous', progress: ['Transcript unavailable'] });
    expect(retired?.pendingPatch).toBeUndefined();
  }, 10_000);

  it('uses the stable-UUID text outbox after a definitive human card withdrawal', async () => {
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
    const worker = { send: vi.fn() };
    const sessionStore = { updateSession: vi.fn() };
    const textRetry = vi.fn(async () => {});
    const scope: Record<string, any> = {
      ds, worker, sessionStore, deliverStructuredNotice, StructuredNoticeCardPendingError,
      TurnReplyCardStore, ReplyCardWithdrawnError, config,
      turnNoticeOutbox: { deliver: textRetry }, turnNoticeHost: vi.fn(() => ({})),
      t: 'fixture', logger: { warn: vi.fn(), error: vi.fn() },
      emitSessionLifecycleHook: vi.fn(), managedAuxUiSuppressed: () => false, ownsLifecycleMutation: () => true,
      retireReplyCardDisplay,
      scopedReply: (body: string, type: string, _turn: string, opts: any) => send(body, type, opts.uuid, opts.beforeWrite),
    };
    scope.retireStructuredNoticeCard = loadWorkerPoolFunction('retireStructuredNoticeCard', scope);
    const handle = loadWorkerPoolMessageHandlers(['user_notify'], scope, true);
    const msg = { type: 'user_notify', kind: 'structured_turn_not_collected', turnId: 'om_turn',
      message: 'Transcript unavailable', noticeId: 'a'.repeat(32) };
    vi.mocked(updateMessage).mockRejectedValue(new MessageWithdrawnError());
    await handle(msg);
    await handle(msg);

    expect(textRetry).toHaveBeenCalledTimes(2);
    expect(textRetry.mock.calls.every(([, id]) => id === msg.noticeId)).toBe(true);
    expect(worker.send).toHaveBeenCalledTimes(2);
    expect(worker.send).toHaveBeenCalledWith({
      type: 'structured_turn_not_collected_ack', turnId: 'om_turn', noticeId: msg.noticeId,
    });
    expect(new TurnReplyCardStore(dir).read({
      larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn',
    })?.withdrawn).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  }, 15_000);

  it('does not classify a withdrawn card as text-safe after ownership is lost', async () => {
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
    vi.mocked(updateMessage).mockRejectedValue(new MessageWithdrawnError());
    await expect(updateTurnReplyCard(ds, 'om_turn', { kind: 'terminal', phase: 'completed' }, send))
      .rejects.toThrow(ReplyCardWithdrawnError);
    const scope: Record<string, any> = {
      ds, config, TurnReplyCardStore, ReplyCardWithdrawnError, StructuredNoticeCardPendingError,
      retireReplyCardDisplay: vi.fn(async () => { throw new ReplyCardWithdrawnError(); }),
    };
    const classify = loadWorkerPoolFunction('retireStructuredNoticeCard', scope);
    await expect(classify(ds, { turnId: 'om_turn', message: 'warning' }, send, () => false))
      .rejects.toThrow('no longer owns delivery');
  });

  it('still persists retirement when the preceding buffered tool PATCH exhausts its retries', async () => {
    bot.config.cotEnabled = true;
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
    queueTurnReplyTools(ds, { turnId: 'om_turn', entries: [{ kind: 'thinking', text: 'Buffered activity' }] }, send, () => true);
    vi.mocked(updateMessage)
      .mockRejectedValueOnce(new Error('PATCH unavailable'))
      .mockRejectedValueOnce(new Error('PATCH unavailable'))
      .mockRejectedValueOnce(new Error('PATCH unavailable'));
    await expect(retireReplyCardDisplay(ds, { turnId: 'om_turn', message: 'Transcript unavailable' }, send, () => true)).resolves.toBe(true);
    expect(new TurnReplyCardStore(dir).read({ larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn' }))
      .toMatchObject({ phase: 'ambiguous', progress: ['Transcript unavailable'] });
    expect(send).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('leaves the notice fallback available when isolation is enabled during a tool PATCH', async () => {
    bot.config.cotEnabled = true;
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
    queueTurnReplyTools(ds, { turnId: 'om_turn', entries: [{ kind: 'thinking', text: 'Buffered activity' }] }, send, () => true);
    vi.mocked(updateMessage).mockImplementationOnce(async () => { bot.config.readIsolation = true; });
    await expect(retireReplyCardDisplay(ds, { turnId: 'om_turn', message: 'Transcript unavailable' }, send, () => true)).resolves.toBe(false);
  });

  it.each(['barrier', 'thinking-update'] as const)('closes only its own native bubble when runtime changes during %s creation', async source => {
    bot.config.replyCardNativeCot = true;
    const contracts = new SessionContractStore(dir, ds.larkAppId);
    const controller = new SessionController(ds, contracts);
    const producer = controller.bindWorker(1).worker;
    const runtime = controller.reserveBinding('initial', producer);
    controller.bindRuntime('initial', producer, { backend: 'tmux', physicalId: 'initial', nativeSessionId: 'native_initial', proof: 'process_start' });
    const admission = controller.gateway.admit('thinking_update', {
      version: 2, session: controller.ref, producer, eventId: `${producer.workerId}:1`, sequence: 1, scope: { runtime },
    }, producer);
    let release!: () => void;
    const createGate = new Promise<void>(resolve => { release = resolve; });
    request.mockImplementation(async req => {
      if (req.method === 'POST' && req.url === '/open-apis/im/v1/message_cot') {
        await createGate;
        return { code: 0, data: { cot_id: 'cot_native', message_id: 'om_cot' } };
      }
      return { code: 0, data: {} };
    });
    const owns = () => controller.currentAuthority();
    let work: Promise<unknown> | undefined;
    try {
      if (source === 'thinking-update') {
        controller.run(admission, () => {
          replyCardModeFor(ds, 'om_turn');
          updateReplyCardNativeThinking(ds, { turnId: 'om_turn', entries: [{ kind: 'thinking', text: 'pending' }] }, owns);
        });
      }
      work = controller.run(admission, () => updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send, { owns }));
      void work.catch(() => {});
      await vi.waitFor(() => expect(request.mock.calls.some(([req]) => req.method === 'POST' && req.url === '/open-apis/im/v1/message_cot')).toBe(true));
      controller.reserveBinding('replacement', producer);
      controller.bindRuntime('replacement', producer, { backend: 'tmux', physicalId: 'replacement', nativeSessionId: 'native_replacement', proof: 'process_start' });
      release();
      await expect(work).rejects.toThrow('no longer owns delivery');
      await settle();
      expect(send).not.toHaveBeenCalled();
      expect(events()).toEqual([]);
      expect(request.mock.calls.filter(([req]) => req.url.includes('/complete/'))).toHaveLength(1);
    } finally { release(); await work?.catch(() => {}); contracts.close(); }
  });

  it('does not send a retirement fallback after runtime ownership is lost while awaiting its card PATCH', async () => {
    let owned = true;
    const fallback = vi.fn();
    const handle = loadWorkerPoolMessageHandlers(['turn_display_retired'], {
      ds, t: 'fixture', logger: { warn: vi.fn() }, ownsLifecycleMutation: () => owned,
      managedAuxUiSuppressed: () => false, scopedReply: vi.fn(), sendTurnNotice: fallback,
      retireReplyCardDisplay: async () => { owned = false; throw new Error('Runtime changed'); },
    }, true);
    await handle({ type: 'turn_display_retired', turnId: 'om_turn', message: 'Transcript unavailable' });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('rechecks notice ownership immediately before the provider write', async () => {
    let owned = true;
    const wrote = vi.fn();
    const notice = loadWorkerPoolFunction<(ds: DaemonSession, msg: unknown, owns: () => boolean) => Promise<void>>('sendTurnNotice', {
      randomUUID: () => 'notice_id', sessionAnchorId: () => 'om_root',
      requireCallbacks: () => ({ sessionReply: async (...args: any[]) => { owned = false; args[5].beforeWrite(); wrote(); } }),
    });
    await notice(ds, { kind: 'user_notify', turnId: 'om_turn', msgType: 'text', content: 'Transcript unavailable' }, () => owned);
    expect(wrote).not.toHaveBeenCalled();
  });

  it.each(['sandbox', 'unsupported-cli'] as const)('uses the legacy native preference after %s fallback', async reason => {
    bot.config.replyCardNativeCot = true;
    bot.config.cotEnabled = false;
    if (reason === 'sandbox') ds.session.sandbox = true;
    else ds.session.cliId = 'opencode';
    expect(replyCardModeFor(ds)).toBe('legacy');
    const handle = worker();
    handle(update('hidden')); await settle();
    expect(request).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    bot.config.cotEnabled = true;
    handle(update('legacy enabled')); await settle();
    expect(request.mock.calls.some(([req]) => req.method === 'POST')).toBe(true);
    finalizeCotMessage(ds, 'om_turn', 'completed'); await settle();
  });

  it('persists non-suppressed display retirement and dedupes its replay after a lost ACK', async () => {
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
    const f = persistentDisplayRetirement();
    await f.handle(f.msg);
    expect(f.ipc.send).toHaveBeenCalledWith({
      type: 'structured_turn_not_collected_ack', turnId: 'om_turn', noticeId: f.msg.noticeId,
    });
    expect(ds.session.turnNotices?.[0]).toMatchObject({
      carrier: 'silent', delivery: { uuid: f.msg.noticeId, state: 'delivered' },
    });
    expect(new TurnReplyCardStore(dir).read({
      larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn',
    })).toMatchObject({ phase: 'completed', displayRetired: true });
    const sends = send.mock.calls.length;
    const patches = vi.mocked(updateMessage).mock.calls.length;

    await f.handle(f.msg);
    expect(f.ipc.send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(sends);
    expect(vi.mocked(updateMessage)).toHaveBeenCalledTimes(patches);
    expect(f.textRetry).not.toHaveBeenCalled();
    expect(ds.session.turnNotices).toHaveLength(1);
  });

  it.each(['legacy', 'withdrawn'] as const)('keeps a persistent %s display retirement on the silent carrier', async mode => {
    if (mode === 'legacy') bot.config.replyCardMode = 'legacy';
    else {
      await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
      vi.mocked(updateMessage).mockRejectedValue(new MessageWithdrawnError());
    }
    const f = persistentDisplayRetirement();
    await f.handle(f.msg);

    expect(f.textRetry).not.toHaveBeenCalled();
    expect(f.ipc.send).toHaveBeenCalledOnce();
    expect(ds.session.turnNotices?.[0]).toMatchObject({
      carrier: 'silent', delivery: { uuid: f.msg.noticeId, state: 'delivered' },
    });
    expect(f.logger.warn).not.toHaveBeenCalled();
  });

  it('withholds ACK for a pending silent PATCH and settles only the same notice on replay', async () => {
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
    const f = persistentDisplayRetirement();
    vi.mocked(updateMessage).mockRejectedValue(new Error('PATCH result unknown'));
    await f.handle(f.msg);
    expect(f.ipc.send).not.toHaveBeenCalled();
    expect(f.textRetry).not.toHaveBeenCalled();
    expect(ds.session.turnNotices?.[0]).toMatchObject({ carrier: 'silent', delivery: { state: 'pending' } });
    expect(new TurnReplyCardStore(dir).read({
      larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn',
    })?.pendingPatch).toBeDefined();

    vi.mocked(updateMessage).mockResolvedValue(undefined);
    await f.handle(f.msg);
    expect(f.ipc.send).toHaveBeenCalledOnce();
    expect(f.ipc.send).toHaveBeenCalledWith({
      type: 'structured_turn_not_collected_ack', turnId: 'om_turn', noticeId: f.msg.noticeId,
    });
    expect(ds.session.turnNotices?.[0]?.delivery.state).toBe('delivered');
    expect(f.textRetry).not.toHaveBeenCalled();
  });

  it('leaves a persistent silent notice pending when card retirement loses ownership', async () => {
    let owned = true;
    const retire = vi.fn(async () => { owned = false; throw new Error('runtime replaced'); });
    const f = persistentDisplayRetirement(() => owned, retire as unknown as typeof retireReplyCardDisplay);
    await f.handle(f.msg);

    expect(f.ipc.send).not.toHaveBeenCalled();
    expect(f.textRetry).not.toHaveBeenCalled();
    expect(f.logger.warn).not.toHaveBeenCalled();
    expect(ds.session.turnNotices?.[0]).toMatchObject({ carrier: 'silent', delivery: { state: 'pending' } });
  });

  it('ACKs intentional suppression without consuming durable notice capacity', async () => {
    const worker = { send: vi.fn() };
    const handle = loadWorkerPoolMessageHandlers(['user_notify', 'turn_display_retired'], {
      ds, worker, ownsLifecycleMutation: () => true, managedAuxUiSuppressed: () => true,
    }, true);
    const journalPath = join(dir, 'suppressed.structured');
    for (let i = 0; i < 33; i++) {
      const warningId = i.toString(16).padStart(32, '0');
      const silentId = i.toString(16).padStart(32, 'f');
      stageBridgeTurnNotice(journalPath, {
        turnId: `om_warning_${i}`, noticeId: warningId, message: 'warning', createdAtMs: i,
      });
      await handle({ type: 'user_notify', kind: 'structured_turn_not_collected',
        turnId: `om_warning_${i}`, noticeId: warningId, message: 'warning' });
      acknowledgeBridgeTurnNotice(journalPath, `om_warning_${i}`, warningId);
      stageBridgeTurnNotice(journalPath, {
        turnId: `om_silent_${i}`, noticeId: silentId, message: '', createdAtMs: i, silent: true,
      });
      await handle({ type: 'turn_display_retired', turnId: `om_silent_${i}`, noticeId: silentId,
        message: '', silent: true });
      acknowledgeBridgeTurnNotice(journalPath, `om_silent_${i}`, silentId);
      expect(readBridgeTurnJournal(journalPath)).toEqual([]);
    }
    expect(worker.send).toHaveBeenCalledTimes(66);
    expect(ds.session.turnNotices).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('drain cancels a queued tools timer so it cannot write into a later test data dir', async () => {
    // A test that queues tool activity without an explicit flush leaves a
    // 1200ms unref timer. The store reads config.session.dataDir only when the
    // timer fires, so an undrained timer from a finished test writes into the
    // next test's dir (and races its teardown). Drain must cancel it outright.
    const nextDir = mkdtempSync(join(tmpdir(), 'unified-native-cot-drain-'));
    try {
      queueTurnReplyTools(ds, { turnId: 'om_turn', entries: [{ kind: 'thinking', text: 'buffered' }] }, send, () => true);
      await __testOnlyDrainTurnReplyTools();
      config.session.dataDir = nextDir;
      await new Promise(resolve => setTimeout(resolve, 1300));
      expect(readdirSync(nextDir)).toEqual([]);
      expect(send).not.toHaveBeenCalled();
    } finally {
      config.session.dataDir = dir;
      rmSync(nextDir, { recursive: true, force: true });
    }
  });

  it('drain waits for a tools flush already writing, so teardown cannot remove the dir under it', async () => {
    bot.config.cotEnabled = true;
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
    let releasePatch!: () => void;
    vi.mocked(updateMessage).mockImplementationOnce(() => new Promise<void>(resolve => { releasePatch = resolve; }));
    queueTurnReplyTools(ds, { turnId: 'om_turn', entries: [{ kind: 'thinking', text: 'in flight' }] }, send, () => true);
    const flushing = flushTurnReplyTools(ds, 'om_turn');
    await vi.waitFor(() => expect(releasePatch).toBeTypeOf('function'));
    let drained = false;
    const draining = __testOnlyDrainTurnReplyTools().then(() => { drained = true; });
    await settle();
    expect(drained).toBe(false);
    releasePatch();
    await Promise.all([flushing, draining]);
    expect(drained).toBe(true);
  });

  it('still appends trailing folded tools when the hold-release frame beats the 1200ms debounce', async () => {
    // Regression for the fold-background-updates trailing-progress race:
    // the worker flushes its last thinking_update and immediately sends the
    // zero-hold release frame; the daemon queues the tools update with a
    // 1200ms debounce, and reading cotHeldForBackground only at flush time
    // rejected the last batch on the already-completed unified card.
    vi.useFakeTimers();
    try {
      bot.config.cotEnabled = true;
      await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
      await updateTurnReplyCard(ds, 'om_turn', finalAnswer('main answer'), send);
      await updateTurnReplyCard(ds, 'om_turn', { kind: 'terminal', phase: 'completed' }, send);
      (ds as any).cotHeldForBackground = { turnId: 'om_turn' };

      queueTurnReplyTools(ds, {
        turnId: 'om_turn',
        entries: [{ kind: 'tool_call', id: 'tail-1', name: 'Monitor', args: '{}', subject: 'CI_TAIL_MARKER' }],
      }, send, () => true);
      // The release screen_update clears the hold before the debounce fires.
      (ds as any).cotHeldForBackground = undefined;
      await vi.advanceTimersByTimeAsync(1250);
      // Fake timers do not drain the voided timer callback's full async chain;
      // an explicit flush mirrors what the unref timer completes in production.
      await flushTurnReplyTools(ds, 'om_turn');

      const record = new TurnReplyCardStore(dir).read({
        larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn',
      })!;
      expect(record.phase).toBe('completed');
      expect(JSON.stringify(record.tools)).toContain('CI_TAIL_MARKER');
    } finally {
      vi.useRealTimers();
    }
  });

  it('admits tools flushed after a hold established post-enqueue, via the live hold read', async () => {
    // The OR branch: no hold at enqueue time (card still open), the hold is
    // established when the turn terminates with background tasks, and only
    // then does the 1200ms debounce flush against the completed card.
    vi.useFakeTimers();
    try {
      bot.config.cotEnabled = true;
      await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
      queueTurnReplyTools(ds, {
        turnId: 'om_turn',
        entries: [{ kind: 'tool_call', id: 'mid-1', name: 'Bash', args: '{}', subject: 'LIVE_HOLD_MARKER' }],
      }, send, () => true);
      await updateTurnReplyCard(ds, 'om_turn', finalAnswer('main answer'), send);
      await updateTurnReplyCard(ds, 'om_turn', { kind: 'terminal', phase: 'completed' }, send);
      (ds as any).cotHeldForBackground = { turnId: 'om_turn' };
      await vi.advanceTimersByTimeAsync(1250);
      await flushTurnReplyTools(ds, 'om_turn');

      const record = new TurnReplyCardStore(dir).read({
        larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn',
      })!;
      expect(JSON.stringify(record.tools)).toContain('LIVE_HOLD_MARKER');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the completed card immutable when neither queue-time nor live hold applies', async () => {
    vi.useFakeTimers();
    try {
      bot.config.cotEnabled = true;
      await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
      await updateTurnReplyCard(ds, 'om_turn', finalAnswer('main answer'), send);
      await updateTurnReplyCard(ds, 'om_turn', { kind: 'terminal', phase: 'completed' }, send);
      const before = JSON.stringify(new TurnReplyCardStore(dir).read({
        larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn',
      })!);

      queueTurnReplyTools(ds, {
        turnId: 'om_turn',
        entries: [{ kind: 'tool_call', id: 'stray-1', name: 'Bash', args: '{}', subject: 'STRAY_MARKER' }],
      }, send, () => true);
      await vi.advanceTimersByTimeAsync(1250);
      await flushTurnReplyTools(ds, 'om_turn');

      const after = JSON.stringify(new TurnReplyCardStore(dir).read({
        larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn',
      })!);
      expect(after).toBe(before);
      expect(after).not.toContain('STRAY_MARKER');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a merged batch observed while armed, even when the hold is released before flush', async () => {
    // Two thinking_update batches share one 1200ms pending entry. The first is
    // enqueued before any hold exists; the hold is then established; the second
    // batch merges into the same entry while armed; the release frame clears
    // the live hold before the debounce fires. The merged batch was observed
    // while the hold was active, so its progress must still be admitted.
    vi.useFakeTimers();
    try {
      bot.config.cotEnabled = true;
      await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
      await updateTurnReplyCard(ds, 'om_turn', finalAnswer('main answer'), send);
      await updateTurnReplyCard(ds, 'om_turn', { kind: 'terminal', phase: 'completed' }, send);

      queueTurnReplyTools(ds, {
        turnId: 'om_turn',
        entries: [{ kind: 'tool_call', id: 'batch-a', name: 'Bash', args: '{}', subject: 'BATCH_A_MARKER' }],
      }, send, () => true);
      (ds as any).cotHeldForBackground = { turnId: 'om_turn' };
      queueTurnReplyTools(ds, {
        turnId: 'om_turn',
        entries: [{ kind: 'tool_call', id: 'batch-b', name: 'Monitor', args: '{}', subject: 'MERGED_TAIL_MARKER' }],
      }, send, () => true);
      (ds as any).cotHeldForBackground = undefined;
      await vi.advanceTimersByTimeAsync(1250);
      await flushTurnReplyTools(ds, 'om_turn');

      const record = new TurnReplyCardStore(dir).read({
        larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn',
      })!;
      expect(record.phase).toBe('completed');
      expect(JSON.stringify(record.tools)).toContain('MERGED_TAIL_MARKER');
    } finally {
      vi.useRealTimers();
    }
  });
});
