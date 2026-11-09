import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DaemonSession } from '../src/core/types.js';
import { config } from '../src/config.js';
import { getBot, getBotClient } from '../src/bot-registry.js';
import { updateMessage } from '../src/im/lark/client.js';
import { replyCardModeFor, queueTurnReplyTools, flushTurnReplyTools, updateTurnReplyCard, updateReplyCardNativeThinking, prepareReplyCardNativeThinking, retireReplyCardDisplay } from '../src/core/turn-reply-card.js';
import { handleCotThinkingUpdate, finalizeCotMessage } from '../src/im/lark/cot-message.js';
import { TurnReplyCardStore } from '../src/services/turn-reply-card.js';
import { loadWorkerPoolMessageHandlers } from './helpers/worker-pool-message-harness.js';
import { loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';
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
    vi.mocked(updateMessage).mockClear();
    send = vi.fn(async (_body: string, _type: string, _uuid: string, beforeWrite: () => unknown) => {
      await beforeWrite(); return 'om_answer';
    });
    ds = {
      larkAppId: 'app_native', chatId: 'oc_native', scope: 'thread', currentTurnId: 'om_turn',
      session: { sessionId: 'native-session', rootMessageId: 'om_root', chatId: 'oc_native', status: 'active', cliId: 'claude-code', backendType: 'tmux' },
    } as DaemonSession;
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

  function worker(owns = true, suppressed = false) {
    return loadWorkerPoolMessageHandlers(['thinking_update'], {
      ds, ownsLifecycleMutation: () => owns, managedAuxUiSuppressed: () => suppressed,
      getBot, effectiveCliId: ds.session.cliId, replyCardModeFor, handleCotThinkingUpdate, queueTurnReplyTools, updateReplyCardNativeThinking,
      scopedReply: (body: string, type: string, _turn: string, opts: any) => send(body, type, opts.uuid, opts.beforeWrite),
    });
  }
  const update = (text: string) => ({ type: 'thinking_update', sessionId: 'native-session', turnId: 'om_turn', entries: [{ kind: 'thinking', text }] });
  const events = () => request.mock.calls.filter(([req]) => req.method === 'PUT')
    .flatMap(([req]) => req.data.events.map((e: any) => ({ type: e.event_type, content: JSON.parse(e.content) })));

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
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'final', text: 'final answer', card: JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'final answer' }] } }), source: 'bridge' }, send);
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
    const posting = updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(send).not.toHaveBeenCalled();
    release(); await posting;
    expect(order).toEqual(['thinking-created', 'thinking-initialized', 'answer']);
    // Normal card PATCH and explicit CLI readiness reuse the same native entity.
    await prepareReplyCardNativeThinking(ds, 'om_turn');
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'progress', text: 'later' }, send);
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
    await expect(updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send)).rejects.toThrow('answer ACK lost');
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
    expect(send).toHaveBeenCalledTimes(1);
    finalizeCotMessage(ds, 'om_turn', 'completed'); await settle();
  });

  it.each(['chat-off', 'stale-worker', 'managed-ui', 'wrong-session'] as const)('keeps %s updates from publishing native CoT', async reason => {
    bot.config.replyCardNativeCot = true;
    if (reason === 'chat-off') bot.config.noCotChats = [ds.chatId];
    worker(reason !== 'stale-worker', reason === 'managed-ui')({ ...update('hidden'), ...(reason === 'wrong-session' ? { sessionId: 'other' } : {}) });
    await settle(); await flushTurnReplyTools(ds, 'om_turn');
    expect(request).not.toHaveBeenCalled();
  });

  it('continues the answer card when native CoT fails, without sending a fallback answer', async () => {
    bot.config.replyCardNativeCot = true;
    request.mockRejectedValue(new Error('CoT unavailable'));
    const handle = worker();
    handle(update('first')); await settle(); await flushTurnReplyTools(ds, 'om_turn');
    handle(update('later')); await settle(); await flushTurnReplyTools(ds, 'om_turn');
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'final', text: 'answer survives', card: JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'answer survives' }] } }), source: 'bridge' }, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateMessage).mock.calls.at(-1)?.[2]).toContain('answer survives');
  });

  it.each([false, true])('settles eager thinking when its transcript never starts (card update failure=%s)', async fail => {
    bot.config.replyCardNativeCot = true;
    await updateTurnReplyCard(ds, 'om_turn', { kind: 'start' }, send);
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
    expect(send).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.some(([req]) => req.url.includes('/complete/'))).toBe(true);
    if (fail) expect(fallback).toHaveBeenCalledWith(ds, expect.objectContaining({ turnId: 'om_turn', content: 'Transcript unavailable' }), expect.any(Function));
    else {
      expect(fallback).not.toHaveBeenCalled();
      expect(new TurnReplyCardStore(dir).read({ larkAppId: ds.larkAppId, sessionId: ds.session.sessionId, turnId: 'om_turn' })?.phase).toBe('ambiguous');
      expect(vi.mocked(updateMessage).mock.calls.at(-1)?.[2]).toContain('Transcript unavailable');
    }
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
});
