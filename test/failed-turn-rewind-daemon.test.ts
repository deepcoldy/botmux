/**
 * The daemon side of cutting a turn that failed without output: the real
 * worker-pool IPC handlers and sendWorkerInput, a stand-in worker process, and
 * the daemon's own failed-turn bookkeeping (recordFailedTurnTerminal, as
 * daemon.ts wires it). The worker side (the cut itself) is covered by
 * worker-failed-turn-rewind.test.ts and failed-turn-rewind.integration.test.ts.
 *
 * Scenario of 2026-11-16: the upstream answered every request with a 503 and a
 * connector sent a bare "继续" after each failure; every attempt stacked a new
 * turn in the session and posted a new failure card.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateMessage = vi.fn(async (_app: string, _id: string, _card: string) => {});
vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: (...args: [string, string, string]) => updateMessage(...args),
  addReaction: vi.fn(async () => 'reaction_id'),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {},
  MessageUpdateExpiredError: class MessageUpdateExpiredError extends Error {},
}));

let cliId = 'claude-code';
vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  getOwnerOpenId: vi.fn(() => undefined),
  getBotClient: vi.fn(() => ({ request: vi.fn(async () => ({ code: 0, data: {} })) })),
  getBotBrand: vi.fn(() => undefined),
  resolveBrandLabel: vi.fn(() => undefined),
  resolveUsageDisplay: vi.fn(() => 'footer'),
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

import { initWorkerPool, sendWorkerInput, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import { recordFailedTurnTerminal } from '../src/core/failed-turn-recovery.js';
import { failedTurnRewindInFlight } from '../src/core/failed-turn-rewind.js';
import { rememberLastCliInput } from '../src/core/session-manager.js';
import { armSilentScheduledTurn } from '../src/core/silent-schedule-turns.js';
import { armTriggerFinalSuppression } from '../src/core/trigger-final-suppression.js';
import { setDefaultLocale, t } from '../src/i18n/index.js';
import { lookupCliDisplayName } from '../src/adapters/cli/display-names.js';
import type { DaemonSession } from '../src/core/types.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

setDefaultLocale('zh');

const SID = 'sess-failed-turn-rewind';
const HINT = '【决策看板 · 提示】巡检发现 1 项可以推进';
const failedTitle = t('card.turn_failed.title', { cliName: lookupCliDisplayName('claude-code') ?? 'Claude Code' });
const repeatLine = (count: number) => t('card.turn_failed.field_repeat', { count: String(count) });

let sessionReply: ReturnType<typeof vi.fn>;
let cardIds: string[];

beforeEach(() => {
  cliId = 'claude-code';
  updateMessage.mockReset();
  updateMessage.mockImplementation(async () => {});
  cardIds = ['om_card_1', 'om_card_2', 'om_card_3'];
  sessionReply = vi.fn(async () => cardIds.shift() ?? 'om_card_x');
  initWorkerPool({
    sessionReply,
    getSessionWorkingDir: () => '/tmp',
    getActiveCount: () => 1,
    closeSession: vi.fn(),
    // daemon.ts records the failed turn for /retry the same way.
    onTurnTerminal: (ds: DaemonSession, terminal: Extract<WorkerToDaemon, { type: 'turn_terminal' }>, context: { workerGeneration: number }) =>
      recordFailedTurnTerminal(ds, terminal, { workerGeneration: context.workerGeneration, caller: undefined, silent: false }),
  } as any);
});

afterEach(() => {
  vi.clearAllMocks();
});

function session() {
  const worker = new EventEmitter() as any;
  const toWorker: DaemonToWorker[] = [];
  Object.assign(worker, {
    killed: false, connected: true, pid: 99999, kill: vi.fn(), stdout: new EventEmitter(), stderr: new EventEmitter(),
    send: vi.fn((message: DaemonToWorker, callback?: (error: Error | null) => void) => { toWorker.push(message); callback?.(null); return true; }),
  });
  const ds = {
    session: {
      sessionId: SID, rootMessageId: 'om_root', chatId: 'oc_test', title: 'steward', status: 'active',
      createdAt: Date.now(), updatedAt: Date.now(), pid: null, chatType: 'group', cliId: 'claude-code',
    },
    worker, workerPort: 0, workerToken: 'tok', larkAppId: 'app_test', chatId: 'oc_test', chatType: 'group',
    spawnedAt: Date.now(), cliVersion: '1', lastMessageAt: Date.now(), hasHistory: true,
  } as unknown as DaemonSession;
  __testOnly_setupWorkerHandlers(ds, worker);
  const fromWorker = async (message: WorkerToDaemon) => {
    worker.emit('message', message);
    await new Promise(done => setTimeout(done, 30));
  };
  const failed = (turnId: string, extra: Partial<Extract<WorkerToDaemon, { type: 'turn_terminal' }>> = {}) => fromWorker({
    type: 'turn_terminal', sessionId: SID, turnId, status: 'failed', errorCode: 'provider_server_error', retryable: true, ...extra,
  });
  const rewound = (turnId: string, failedTurnId: string, outcome: 'rewound' | 'declined' = 'rewound', cut?: true) => fromWorker({
    type: 'failed_turn_rewind', turnId, failedTurnId, outcome, reason: 'test', ...(cut ? { cut } : {}),
  });
  /** An input the way trigger-session delivers one, and remembers it after. */
  const input = (turnId: string, content: string, opts: Parameters<typeof sendWorkerInput>[3] = {}) => {
    expect(sendWorkerInput(ds, content, turnId, opts)).toBe(true);
    rememberLastCliInput(ds, content, content, turnId);
    const sent = toWorker.filter(message => message.type === 'message' && message.turnId === turnId).at(-1);
    return sent as Extract<DaemonToWorker, { type: 'message' }>;
  };
  const failureCards = () => sessionReply.mock.calls.map(call => String((call as unknown[])[1])).filter(body => body.includes(failedTitle));
  return { ds, worker, toWorker, fromWorker, failed, rewound, input, failureCards };
}

describe('a turn that failed without output, then more input (daemon side)', () => {
  it('records the failure as direct, sends the next input with the failed one, and keeps ONE card counting the failures', async () => {
    const s = session();
    rememberLastCliInput(s.ds, HINT, HINT, 'trg_1');
    await s.failed('trg_1', { directFailure: true });
    expect(s.ds.session.lastFailedTurn).toMatchObject({ turnId: 'trg_1', cliInput: HINT, directFailure: true, retryable: true, answersInChat: true });
    expect(s.failureCards()).toHaveLength(1);
    expect(s.ds.session.lastFailureCard).toEqual({ turnId: 'trg_1', messageId: 'om_card_1' });
    // Nothing ran: the card says so, and its button re-sends the input as it was.
    expect(s.failureCards()[0]).toContain(t('card.turn_failed.retry_direct').slice(0, 12));
    const card = JSON.parse(s.failureCards()[0]!);
    expect((card.body?.elements ?? card.elements).flatMap((el: any) => el.actions ?? [])
      .find((action: any) => action.value?.action === 'retry_turn')?.value).toMatchObject({ mode: 'resend', turn_id: 'trg_1' });

    // A connector's bare "继续": the worker is told to cut trg_1 and send both.
    const second = s.input('trg_2', '继续');
    expect(second.content).toBe('继续');
    expect(second.failedTurnRewind).toEqual({ failedTurnId: 'trg_1', failedInput: HINT, mode: 'merge', content: `${HINT}\n\n继续` });
    await s.rewound('trg_2', 'trg_1');
    expect(s.ds.lastCliInput).toBe(`${HINT}\n\n继续`);
    expect(s.ds.lastCliInputTurnId).toBe('trg_2');
    expect(s.ds.session.lastFailedTurn).toBeUndefined();
    expect(s.ds.session.failedTurnRewindChain).toEqual({ turnId: 'trg_2', originTurnId: 'trg_1', failures: 1, cardMessageId: 'om_card_1' });

    // It fails the same way: the card is updated in place, no second card.
    await s.failed('trg_2', { directFailure: true });
    expect(s.failureCards()).toHaveLength(1);
    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(updateMessage.mock.calls[0]![1]).toBe('om_card_1');
    expect(updateMessage.mock.calls[0]![2]).toContain(repeatLine(2));
    expect(s.ds.session.lastFailedTurn).toMatchObject({ turnId: 'trg_2', cliInput: `${HINT}\n\n继续`, directFailure: true });

    // The same bare "继续" again is not appended twice.
    const third = s.input('trg_3', '继续');
    expect(third.failedTurnRewind).toMatchObject({ failedTurnId: 'trg_2', content: `${HINT}\n\n继续` });
    await s.rewound('trg_3', 'trg_2');
    expect(s.ds.session.failedTurnRewindChain).toEqual({ turnId: 'trg_3', originTurnId: 'trg_1', failures: 2, cardMessageId: 'om_card_1' });
    expect(s.ds.lastUserPrompt).toBe(`${HINT}\n\n继续`);
    await s.failed('trg_3', { directFailure: true });
    expect(s.failureCards()).toHaveLength(1);
    expect(updateMessage.mock.calls.at(-1)![1]).toBe('om_card_1');
    expect(updateMessage.mock.calls.at(-1)![2]).toContain(repeatLine(3));

    // The provider is back: the re-sent input completes and the chain ends.
    s.input('trg_4', '继续');
    await s.rewound('trg_4', 'trg_3');
    await s.fromWorker({ type: 'turn_terminal', sessionId: SID, turnId: 'trg_4', status: 'completed' });
    expect(s.ds.session.failedTurnRewindChain).toBeUndefined();
  });

  it('the first card can be the recovery card of a chat message: the trigger that re-sends it updates that card', async () => {
    const s = session();
    // A chat message is a tracked ordinary turn: with automatic continuation
    // off (the default) its failure gets the recovery failure card.
    s.input('om_msg_1', HINT);
    await s.failed('om_msg_1', { directFailure: true });
    await new Promise(done => setTimeout(done, 100));
    expect(sessionReply).toHaveBeenCalledTimes(1);
    const cliName = lookupCliDisplayName('claude-code') ?? 'Claude Code';
    expect(String(sessionReply.mock.calls[0]![1])).toContain(t('card.recovery_failed.title_off', { cliName }));
    expect(s.ds.session.lastFailureCard).toEqual({ turnId: 'om_msg_1', messageId: 'om_card_1' });

    expect(s.input('trg_1', '继续').failedTurnRewind).toMatchObject({ failedTurnId: 'om_msg_1', mode: 'merge' });
    await s.rewound('trg_1', 'om_msg_1');
    await s.failed('trg_1', { directFailure: true });
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(updateMessage.mock.calls.map(call => call[1])).toEqual(['om_card_1']);
    expect(updateMessage.mock.calls[0]![2]).toContain(repeatLine(2));
  });

  it('a chat message re-sending a failed input fails again: its recovery card replaces the chain card in place', async () => {
    const s = session();
    rememberLastCliInput(s.ds, HINT, HINT, 'trg_1');
    await s.failed('trg_1', { directFailure: true });
    s.input('om_msg_2', '再看一下');
    await s.rewound('om_msg_2', 'trg_1');
    await s.failed('om_msg_2', { directFailure: true });
    await new Promise(done => setTimeout(done, 100));
    expect(s.failureCards()).toHaveLength(1);
    expect(updateMessage.mock.calls.map(call => call[1])).toEqual(['om_card_1']);
    const cliName = lookupCliDisplayName('claude-code') ?? 'Claude Code';
    expect(updateMessage.mock.calls[0]![2]).toContain(t('card.recovery_failed.title_off', { cliName }));
    expect(updateMessage.mock.calls[0]![2]).toContain(repeatLine(2));
  });

  it('a re-sent input that made progress before failing gets a card of its own and ends the chain', async () => {
    const s = session();
    rememberLastCliInput(s.ds, HINT, HINT, 'trg_1');
    await s.failed('trg_1', { directFailure: true });
    s.input('trg_2', '继续');
    await s.rewound('trg_2', 'trg_1');
    await s.failed('trg_2');
    expect(updateMessage).not.toHaveBeenCalled();
    expect(s.failureCards()).toHaveLength(2);
    expect(s.failureCards()[1]).not.toContain(repeatLine(2));
    // It may have done something: the existing caution and continue button stay.
    expect(s.failureCards()[1]).not.toContain(t('card.turn_failed.retry_direct').slice(0, 12));
    expect(s.ds.session.failedTurnRewindChain).toBeUndefined();
    // Not a direct failure: the next input goes in as it is.
    expect(s.input('trg_3', '继续').failedTurnRewind).toBeUndefined();
  });

  it('posts a new card when the old one cannot be updated, and keeps counting on the new one', async () => {
    const s = session();
    rememberLastCliInput(s.ds, HINT, HINT, 'trg_1');
    await s.failed('trg_1', { directFailure: true });
    s.input('trg_2', '继续');
    await s.rewound('trg_2', 'trg_1');
    updateMessage.mockRejectedValueOnce(new Error('message too old to update'));
    await s.failed('trg_2', { directFailure: true });
    expect(s.failureCards()).toHaveLength(2);
    expect(s.failureCards()[1]).toContain(repeatLine(2));
    expect(s.ds.session.failedTurnRewindChain).toMatchObject({ turnId: 'trg_2', cardMessageId: 'om_card_2' });
    s.input('trg_3', '继续');
    await s.rewound('trg_3', 'trg_2');
    expect(s.ds.session.failedTurnRewindChain).toEqual({ turnId: 'trg_3', originTurnId: 'trg_1', failures: 2, cardMessageId: 'om_card_2' });
  });

  it('a retry or an automatic continuation re-sends the failed input alone', async () => {
    const s = session();
    rememberLastCliInput(s.ds, HINT, HINT, 'trg_1');
    await s.failed('trg_1', { directFailure: true });
    const retry = s.input('retry-1', '[BOTMUX_CONTINUE] 继续', { failedTurnResendOf: 'trg_1' });
    expect(retry.content).toBe('[BOTMUX_CONTINUE] 继续');
    expect(retry.failedTurnRewind).toEqual({ failedTurnId: 'trg_1', failedInput: HINT, mode: 'resend', content: HINT });
    await s.rewound('retry-1', 'trg_1');
    expect(s.ds.lastCliInput).toBe(HINT);
    expect(s.ds.session.failedTurnRewindChain).toMatchObject({ turnId: 'retry-1', originTurnId: 'trg_1', failures: 1 });
  });

  // An old card (or a continuation of an older turn) pressed after another
  // turn failed: it must not cut and re-send that other turn.
  it('a retry re-sends only the turn it was made for, never whatever failed last', async () => {
    const s = session();
    rememberLastCliInput(s.ds, 'ORIGINAL_TASK', 'ORIGINAL_TASK', 'om_A');
    await s.failed('om_A', { directFailure: true });
    rememberLastCliInput(s.ds, 'NEWER_TASK', 'NEWER_TASK', 'trg_new');
    await s.failed('trg_new', { directFailure: true });
    expect(s.ds.session.lastFailedTurn?.turnId).toBe('trg_new');
    const old = s.input('bmx-recovery-retry-A', 'ORIGINAL_TASK', { failedTurnResendOf: 'om_A' });
    expect(old.content).toBe('ORIGINAL_TASK');
    expect(old.failedTurnRewind).toBeUndefined();
  });

  it('a retry aimed at a failed turn follows it along the chain of cuts that carried it on', async () => {
    const s = session();
    rememberLastCliInput(s.ds, HINT, HINT, 'trg_1');
    await s.failed('trg_1', { directFailure: true });
    s.input('trg_2', '继续');
    await s.rewound('trg_2', 'trg_1');
    await s.failed('trg_2', { directFailure: true });
    expect(s.ds.session.failedTurnRewindChain).toMatchObject({ turnId: 'trg_2', originTurnId: 'trg_1' });
    // The automatic continuation (or recovery card) of trg_1 re-sends what trg_2 carries now.
    expect(s.input('bmx-recovery-2', '[BOTMUX_RECOVERY] 继续', { failedTurnResendOf: 'trg_1' }).failedTurnRewind).toEqual({
      failedTurnId: 'trg_2', failedInput: `${HINT}\n\n继续`, mode: 'resend', content: `${HINT}\n\n继续`,
    });
    await s.rewound('bmx-recovery-2', 'trg_2');
    expect(s.ds.session.failedTurnRewindChain).toMatchObject({ turnId: 'bmx-recovery-2', originTurnId: 'trg_1', failures: 2 });
  });

  it('a declined cut changes nothing: the failed turn and its record stay, the input went in as it was', async () => {
    const s = session();
    rememberLastCliInput(s.ds, HINT, HINT, 'trg_1');
    await s.failed('trg_1', { directFailure: true });
    s.input('trg_2', '继续');
    await s.rewound('trg_2', 'trg_1', 'declined');
    expect(s.ds.lastCliInput).toBe('继续');
    expect(s.ds.session.lastFailedTurn).toMatchObject({ turnId: 'trg_1' });
    expect(s.ds.session.failedTurnRewindChain).toBeUndefined();
  });

  it.each([
    ['the turn made progress', { }, '继续', {}],
    ['the provider refused the request', { directFailure: true, retryable: false, errorCode: 'provider_invalid_request' }, '继续', {}],
    ['the request was cancelled (a stop)', { directFailure: true, errorCode: 'provider_cancelled' }, '继续', {}],
    ['the next input is a CLI command', { directFailure: true }, '/compact', {}],
    ['the next input is a durable delivery attempt', { directFailure: true }, '继续', { dispatchAttempt: 1 }],
  ] as const)('sends the next input as it is when %s', async (_label, terminal, content, opts) => {
    const s = session();
    rememberLastCliInput(s.ds, HINT, HINT, 'trg_1');
    await s.failed('trg_1', terminal as any);
    expect(s.input('trg_2', content, opts as any).failedTurnRewind).toBeUndefined();
  });

  it.each([
    ['a silent scheduled fire', (ds: DaemonSession) => armSilentScheduledTurn(ds, 'trg_2')],
    ['a trigger whose final output is suppressed', (ds: DaemonSession) => { ds.suppressedFinalOutputTurns = new Map([['trg_2', 1]]); }],
    ['an async HTTP trigger', (ds: DaemonSession) => { ds.asyncTriggerResults = new Map([['trg_2', { status: 'pending', createdAt: Date.now() } as any]]); }],
  ] as const)('does not fold the failed input into %s: its answer would not reach the chat', async (_label, arm) => {
    const s = session();
    rememberLastCliInput(s.ds, HINT, HINT, 'trg_1');
    await s.failed('trg_1', { directFailure: true });
    arm(s.ds);
    expect(s.input('trg_2', '继续').failedTurnRewind).toBeUndefined();
    // A retry of the failed input itself is not a fold.
    expect(s.input('retry-1', HINT, { failedTurnResendOf: 'trg_1' }).failedTurnRewind).toMatchObject({ mode: 'resend' });
  });

  it('folds a failed input only into a turn of the same sender, or of nobody in particular', async () => {
    const alice = { requestUserOpenId: 'ou_alice', requestLarkAppId: 'app_test', senderType: 'user' as const };
    const bob = { requestUserOpenId: 'ou_bob', requestLarkAppId: 'app_test', senderType: 'user' as const };
    const s = session();
    rememberLastCliInput(s.ds, 'alice 的任务', 'alice 的任务', 'om_alice');
    await s.failed('om_alice', { directFailure: true });
    s.ds.session.lastFailedTurn!.trustedCaller = alice;
    // Bob's message would run alice's task as bob.
    expect(s.input('om_bob', 'bob 的消息', { trustedCaller: bob }).failedTurnRewind).toBeUndefined();
    expect(s.input('om_alice_2', 'alice 补一句', { trustedCaller: alice }).failedTurnRewind).toMatchObject({ mode: 'merge' });
    await s.rewound('om_alice_2', 'om_alice', 'declined');
    // An unidentified input (a webhook's "继续") runs it with less authority, not more.
    expect(s.input('trg_1', '继续').failedTurnRewind).toMatchObject({ mode: 'merge' });
  });

  it('never folds an input nobody vouched for (a webhook\'s) into a person\'s turn', async () => {
    const alice = { requestUserOpenId: 'ou_alice', requestLarkAppId: 'app_test', senderType: 'user' as const };
    const s = session();
    rememberLastCliInput(s.ds, '外部事件', '外部事件', 'trg_1');
    await s.failed('trg_1', { directFailure: true });
    expect(s.ds.session.lastFailedTurn?.trustedCaller).toBeUndefined();
    expect(s.input('om_alice', 'alice 的消息', { trustedCaller: alice }).failedTurnRewind).toBeUndefined();
  });

  it('a late answer does not take the latest input back from a newer one', async () => {
    const s = session();
    rememberLastCliInput(s.ds, HINT, HINT, 'trg_1');
    await s.failed('trg_1', { directFailure: true });
    s.input('trg_2', '继续');
    // trg_3 arrived while trg_2's restart was running (the worker declined it).
    s.input('trg_3', '还在吗');
    await s.rewound('trg_3', 'trg_1', 'declined');
    await s.rewound('trg_2', 'trg_1');
    expect(s.ds.lastCliInputTurnId).toBe('trg_3');
    expect(s.ds.lastCliInput).toBe('还在吗');
    expect(s.ds.session.lastFailedTurn).toBeUndefined();
  });

  it('ignores an answer about another failed turn', async () => {
    const s = session();
    rememberLastCliInput(s.ds, HINT, HINT, 'trg_1');
    await s.failed('trg_1', { directFailure: true });
    s.input('trg_2', '继续');
    await s.rewound('trg_2', 'board:other');
    expect(s.ds.session.lastFailedTurn).toMatchObject({ turnId: 'trg_1' });
    expect(s.ds.session.failedTurnRewindChain).toBeUndefined();
    expect(s.ds.lastCliInput).toBe('继续');
  });

  it('ignores an answer from a stale worker generation', async () => {
    const s = session();
    rememberLastCliInput(s.ds, HINT, HINT, 'trg_1');
    await s.failed('trg_1', { directFailure: true });
    s.input('trg_2', '继续');
    const replacement = new EventEmitter() as any;
    Object.assign(replacement, { killed: false, connected: true, send: vi.fn(() => true) });
    s.ds.worker = replacement;
    await s.rewound('trg_2', 'trg_1');
    expect(s.ds.session.lastFailedTurn).toMatchObject({ turnId: 'trg_1' });
    expect(s.ds.session.failedTurnRewindChain).toBeUndefined();
    expect(s.ds.lastCliInput).toBe('继续');
  });

  it('while an input is re-sending the failed turn, nothing else re-sends it too', async () => {
    const s = session();
    rememberLastCliInput(s.ds, HINT, HINT, 'trg_1');
    await s.failed('trg_1', { directFailure: true });
    s.input('trg_2', '继续');
    expect(failedTurnRewindInFlight(s.ds, 'trg_1')).toBe(true);
    // An automatic continuation (or anything else) meanwhile goes in plainly.
    expect(s.input('bmx-recovery-1', '[BOTMUX_RECOVERY] 继续', { failedTurnResendOf: 'trg_1' }).failedTurnRewind).toBeUndefined();
    await s.rewound('trg_2', 'trg_1');
    expect(failedTurnRewindInFlight(s.ds, 'trg_1')).toBe(false);
  });

  // The failed turn's own exit is frozen when it fails: its HTTP / suppression
  // state is gone by the time the next input arrives (wait settled, marker
  // expired, daemon restarted), and folding it into a chat turn would post
  // an answer that was never meant for the chat.
  it.each([
    ['an HTTP wait result', (ds: DaemonSession) => { ds.pendingWaitPromises = new Map([['trg_1', { resolve: () => {}, reject: () => {} } as any]]); }],
    ['an async HTTP result', (ds: DaemonSession) => { ds.asyncTriggerResults = new Map([['trg_1', { status: 'pending', createdAt: Date.now() } as any]]); }],
    ['a trigger with its final output suppressed', (ds: DaemonSession) => armTriggerFinalSuppression(ds, 'trg_1')],
    ['a durable delivery with its final output suppressed', (ds: DaemonSession) => { ds.suppressedFinalOutputTurns = new Map([['trg_1', 1]]); }],
    // A failed final output can settle the HTTP wait before the terminal arrives.
    ['an HTTP result settled before its terminal', (ds: DaemonSession) => { ds.settledHttpTerminalTurns = new Set(['trg_1']); }],
  ] as const)('does not fold a failed input whose answer was %s into a chat turn', async (_label, arm) => {
    const s = session();
    rememberLastCliInput(s.ds, HINT, HINT, 'trg_1');
    arm(s.ds);
    await s.failed('trg_1', { directFailure: true });
    expect(s.ds.session.lastFailedTurn).toMatchObject({ turnId: 'trg_1', directFailure: true });
    expect(s.ds.session.lastFailedTurn?.answersInChat).toBeUndefined();
    // Whatever runtime state is left (or not, after a restart).
    s.ds.pendingWaitPromises?.clear();
    s.ds.asyncTriggerResults?.clear();
    s.ds.suppressedFinalOutputTurns?.clear();
    expect(s.input('trg_2', '继续').failedTurnRewind).toBeUndefined();
    // Its own retry still re-sends it.
    expect(s.input('retry-1', HINT, { failedTurnResendOf: 'trg_1' }).failedTurnRewind).toMatchObject({ mode: 'resend' });
  });

  it.each([
    ['the new turn answers in a document comment', (ds: DaemonSession) => { ds.docCommentTurns = new Map([['trg_2', { fileToken: 'f', fileType: 'docx', commentId: 'c' }]]); }],
    ['the failed turn answered in a document comment', (ds: DaemonSession) => { ds.session.docCommentTargets = { trg_1: { fileToken: 'f', fileType: 'docx', commentId: 'c', turnId: 'trg_1' } }; }],
  ] as const)('does not fold when %s: the answer would go elsewhere', async (_label, arm) => {
    const s = session();
    rememberLastCliInput(s.ds, HINT, HINT, 'trg_1');
    // Routing is registered when a turn is admitted, before it can fail.
    arm(s.ds);
    await s.failed('trg_1', { directFailure: true });
    expect(s.input('trg_2', '继续').failedTurnRewind).toBeUndefined();
  });

  it('leaves other CLIs alone', async () => {
    cliId = 'codex';
    const s = session();
    (s.ds.session as any).cliId = 'codex';
    rememberLastCliInput(s.ds, HINT, HINT, 'trg_1');
    await s.failed('trg_1', { directFailure: true });
    expect(s.input('trg_2', '继续').failedTurnRewind).toBeUndefined();
  });
});
