import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const mocks = vi.hoisted(() => ({ request: vi.fn(), create: vi.fn(), reply: vi.fn(), patch: vi.fn(), upload: vi.fn() }));
vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {
  request = mocks.request;
  im = { v1: {
    message: { create: mocks.create, reply: mocks.reply, patch: mocks.patch },
    file: { create: mocks.upload },
    chat: { get: async () => ({ code: 0, data: { chat_mode: 'group' } }) },
  } };
} }));
import {
  initWorkerPool, setActiveSessionsRegistry, getActiveSessionsRegistry,
  postTurnStartingCard, postFreshStreamingCard, scheduleCardPatch, closeSession, __testOnly_setupWorkerHandlers as setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import { updateTurnReplyCard } from '../src/core/turn-reply-card.js';
import { registerBot, getBot } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import * as sessionStore from '../src/services/session-store.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import { __testOnly_activeSessions as activeSessions, __testOnly_sessionReply as sessionReply } from '../src/daemon.js';
import { __testOnly_resetLarkGate } from '../src/im/lark/api-gate.js';

const APP = 'cli_worker_card_owner';
const oldDataDir = config.session.dataDir;
const originalRegistry = getActiveSessionsRegistry();
let home: string;
let ds: DaemonSession;
let unavailable: boolean;

beforeEach(() => {
  vi.clearAllMocks(); __testOnly_resetLarkGate();
  vi.stubEnv('BOTMUX_LARK_QPS', '100000');
  vi.stubEnv('BOTMUX_LARK_GATE_RETRY_BASE_MS', '1');
  home = mkdtempSync(join(tmpdir(), 'worker-topic-output-'));
  const data = join(home, 'data'); mkdirSync(data, { mode: 0o700 });
  config.session.dataDir = data;
  unavailable = false;
  activeSessions.clear(); setActiveSessionsRegistry(activeSessions);
  registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
    topicUnavailablePolicy: 'stop', replyCardMode: 'legacy' });
  ds = { larkAppId: APP, chatId: 'oc_source', scope: 'chat', chatType: 'group',
    currentReplyTarget: { turnId: 'turn-new', rootMessageId: 'om_new' },
    session: { sessionId: 'sid_worker_output', larkAppId: APP, chatId: 'oc_source', scope: 'chat',
      rootMessageId: 'om_source', cliId: 'claude-code', status: 'active', title: 'source', workingDir: data },
  } as unknown as DaemonSession;
  sessionStore.init(APP);
  const stored = sessionStore.createSession('oc_source', 'om_source', 'source', 'group', 'chat');
  ds.session = { ...stored, ...ds.session, sessionId: stored.sessionId };
  sessionStore.updateSession(ds.session);
  activeSessions.set(activeSessionKey(ds), ds);
  initWorkerPool({ sessionReply, getSessionWorkingDir: () => data, getActiveCount: () => 1, closeSession: vi.fn() });
  mocks.request.mockReset().mockImplementation(async ({ method, url }) => {
    if (method === 'GET' && url.includes('/im/v1/chats/')) return { code: 0, data: { chat_mode: 'group' } };
    if (method !== 'GET' || !url.includes('/im/v1/messages/')) throw new Error('Unexpected provider request');
    const id = url.split('/').at(-1);
    return { code: 0, data: { items: [{ message_id: id, chat_id: 'oc_source',
      ...(id === 'om_sent' ? { root_id: 'om_source' } : {}), deleted: id === 'om_source' && unavailable }] } };
  });
  mocks.create.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_sent' } });
  mocks.reply.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_sent' } });
  mocks.patch.mockReset().mockResolvedValue({ code: 0 });
  mocks.upload.mockReset().mockResolvedValue({ file_key: 'file_overflow' });
});
afterEach(() => {
  activeSessions.clear(); setActiveSessionsRegistry(originalRegistry);
  ds.session.status = 'closed';
  sessionStore.init(APP, { owner: false });
  config.session.dataDir = oldDataDir;
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs(); __testOnly_resetLarkGate();
});

function cardReply(body: string, type: string, uuid: string, beforeWrite: () => void | Promise<void>) {
  return sessionReply('oc_source', body, type, APP, 'om_turn_old', {
    uuid, beforeWrite, sourceSessionId: ds.session.sessionId,
    replyTarget: { mode: 'thread', rootMessageId: 'om_source' },
  });
}
function cardEvent(kind: 'new-card' | 'overflow') {
  const text = 'large result\n'.repeat(10000);
  return kind === 'new-card'
    ? { kind: 'progress' as const, text: 'Working' }
    : { kind: 'final' as const, text, source: 'bridge' as const,
      card: JSON.stringify({ schema: '2.0', config: {}, body: { elements: [{ tag: 'markdown', content: text }] } }) };
}
function prepareStatusCard() {
  ds.workerReady = true;
  ds.currentReplyTarget = { turnId: 'om_turn_old', rootMessageId: 'om_source' };
  ds.streamCardPending = true;
  ds.streamCardPendingTurnId = 'om_turn_old';
}
const publications = ['starting', 'fresh'] as const;
const replies = ['new-card', 'overflow'] as const;
const timings = ['lookup', 'retry'] as const;

describe('card ownership at the provider write', () => {
  it.each(publications.flatMap(kind => timings.map(timing => [kind, timing] as const)))(
    'does not publish a %s card after its nonce changes during %s', async (kind, timing) => {
    prepareStatusCard();
    if (timing === 'lookup') {
      const read = mocks.request.getMockImplementation()!;
      mocks.request.mockImplementationOnce(async input => {
        const result = await read(input); ds.streamCardNonce = 'replacement'; return result;
      });
    } else {
      mocks.reply.mockImplementationOnce(async () => {
        ds.streamCardNonce = 'replacement'; throw { isAxiosError: true, response: { status: 429 } };
      });
    }
    const result = kind === 'starting'
      ? await postTurnStartingCard(ds, sessionReply, 'om_turn_old')
      : await postFreshStreamingCard(ds, sessionReply);
    expect(result).toBe(false);
    expect(mocks.reply).toHaveBeenCalledTimes(timing === 'lookup' ? 0 : 1);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(ds.streamCardNonce).toBe('replacement');
  });

  it.each(replies.flatMap(kind => timings.map(timing => [kind, timing] as const)))(
    'does not send %s after owner loss during %s', async (kind, timing) => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
      topicUnavailablePolicy: 'stop', replyCardMode: 'unified' });
    let owns = true;
    if (timing === 'lookup') {
      const read = mocks.request.getMockImplementation()!;
      mocks.request.mockImplementationOnce(async input => { const result = await read(input); owns = false; return result; });
    } else {
      mocks.reply.mockImplementationOnce(async () => {
        owns = false; throw { isAxiosError: true, response: { status: 429 } };
      });
    }
    await expect(updateTurnReplyCard(ds, 'om_turn_old', cardEvent(kind), cardReply,
      { owns: () => owns, forceVisible: true })).rejects.toThrow('no longer owns');
    expect(mocks.reply).toHaveBeenCalledTimes(timing === 'lookup' ? 0 : 1);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.upload).toHaveBeenCalledTimes(kind === 'overflow' ? 1 : 0);
  });

  it.each(publications)('publishes an owned %s card at the original target', async kind => {
    prepareStatusCard();
    const result = kind === 'starting'
      ? await postTurnStartingCard(ds, sessionReply, 'om_turn_old')
      : await postFreshStreamingCard(ds, sessionReply);
    expect(result).toBe(true);
    expect(ds.streamCardId).toBe('om_sent');
    expect(mocks.reply).toHaveBeenCalledOnce();
    expect(mocks.reply.mock.calls[0][0]).toMatchObject({ path: { message_id: 'om_source' }, data: { reply_in_thread: true } });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(replies)('publishes an owned %s and preserves the original thread', async kind => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
      topicUnavailablePolicy: 'stop', replyCardMode: 'unified' });
    const result = await updateTurnReplyCard(ds, 'om_turn_old', cardEvent(kind), cardReply, { forceVisible: true });
    expect(result?.delivered).toBe(true);
    expect(result?.record.overflowMessageId).toBe(kind === 'overflow' ? 'om_sent' : undefined);
    expect(mocks.upload).toHaveBeenCalledTimes(kind === 'overflow' ? 1 : 0);
    for (const [request] of mocks.reply.mock.calls) expect(request.path.message_id).toBe('om_source');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects a reply card after its session moves even without a worker predicate', async () => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
      topicUnavailablePolicy: 'stop', replyCardMode: 'unified' });
    const read = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementationOnce(async input => { const result = await read(input); ds.chatId = 'oc_moved'; return result; });
    await expect(updateTurnReplyCard(ds, 'om_turn_old', cardEvent('new-card'), cardReply,
      { forceVisible: true })).rejects.toThrow('no longer owns');
    expect(mocks.reply).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('native worker card publication', () => {
  it.each((['ready', 'screen_update'] as const).flatMap(kind =>
    (['lookup', 'retry', 'none'] as const).map(timing => [kind, timing] as const)))(
    'preserves %s publication ownership through %s', async (kind, timing) => {
    prepareStatusCard();
    const worker = Object.assign(new EventEmitter(), {
      killed: false, send: vi.fn(), kill: vi.fn(), pid: 12345,
      stdout: new EventEmitter(), stderr: new EventEmitter(),
    });
    ds.worker = worker as any;
    ds.lastScreenStatus = 'working';
    ds.displayMode = 'hidden';
    const pending: Promise<unknown>[] = [];
    initWorkerPool({ sessionReply: (...args) => {
      const work = sessionReply(...args); pending.push(work); return work;
    }, getSessionWorkingDir: () => ds.session.workingDir!, getActiveCount: () => 1, closeSession: vi.fn() });
    setupWorkerHandlers(ds, worker as any);
    if (timing === 'lookup') {
      const read = mocks.request.getMockImplementation()!;
      mocks.request.mockImplementationOnce(async input => {
        const result = await read(input); ds.streamCardNonce = 'replacement'; return result;
      });
    } else if (timing === 'retry') {
      mocks.reply.mockImplementationOnce(async () => {
        ds.streamCardNonce = 'replacement'; throw { isAxiosError: true, response: { status: 429 } };
      });
    }
    await worker.listeners('message')[0](kind === 'ready'
      ? { type: 'ready', port: 9999, token: 'fixture', turnId: 'om_turn_old' }
      : { type: 'screen_update', content: 'working', status: 'working', turnId: 'om_turn_old' });
    await Promise.allSettled(pending);
    expect(pending).not.toHaveLength(0);
    expect(mocks.reply).toHaveBeenCalledTimes(timing === 'lookup' ? 0 : 1);
    expect(mocks.create).not.toHaveBeenCalled();
    if (timing === 'none') {
      expect(ds.streamCardId).toBe('om_sent');
      expect(mocks.reply.mock.calls[0][0].path.message_id).toBe('om_source');
    } else expect(ds.streamCardNonce).toBe('replacement');
  });
});


describe('queued streaming-card PATCH ownership', () => {
  const changes = ['nonce', 'generation', 'turn', 'session', 'registry', 'chat', 'card', 'disabled', 'transport', 'scope', 'retirement'] as const;
  it.each(changes)('does not retry a PATCH after its %s owner changes', async change => {
    ds.streamCardId = 'om_status'; ds.streamCardNonce = 'nonce_original';
    ds.workerGeneration = 1; ds.currentTurnId = 'turn_original';
    let rejected = false;
    mocks.patch.mockImplementationOnce(async () => {
      if (change === 'nonce') ds.streamCardNonce = 'replacement';
      if (change === 'generation') ds.workerGeneration = 2;
      if (change === 'turn') ds.currentTurnId = 'turn_replacement';
      if (change === 'session') ds.session = { ...ds.session };
      if (change === 'registry') activeSessions.clear();
      if (change === 'chat') ds.chatId = 'oc_replacement';
      if (change === 'card') ds.streamCardId = 'om_replacement';
      if (change === 'disabled') getBot(APP).config.disableStreamingCard = true;
      if (change === 'transport') getBot(APP).config.apiOnly = true;
      if (change === 'scope') { ds.scope = 'thread'; ds.session.scope = 'thread'; }
      if (change === 'retirement') ds.remoteCloseState = { phase: 'preparing', requestId: 'close-status' } as any;
      rejected = true;
      throw { isAxiosError: true, response: { status: 429 } };
    });
    expect(scheduleCardPatch(ds, '{"status":"working"}', 'turn_original')).toBe(true);
    await vi.waitFor(() => expect(rejected).toBe(true));
    await vi.waitFor(() => expect(ds.cardPatchInFlight).toBe(false), { timeout: 3000 });
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(ds.streamCardId).toBe(change === 'card' ? 'om_replacement' : 'om_status');
  });

  it('still retries an owned PATCH at its original message', async () => {
    ds.streamCardId = 'om_status'; ds.streamCardNonce = 'nonce_original';
    mocks.patch.mockRejectedValueOnce({ isAxiosError: true, response: { status: 429 } });
    expect(scheduleCardPatch(ds, '{"status":"working"}')).toBe(true);
    await vi.waitFor(() => expect(ds.cardPatchInFlight).toBe(false), { timeout: 3000 });
    expect(mocks.patch).toHaveBeenCalledTimes(2);
    expect(mocks.patch.mock.calls.every(([request]) => request.path.message_id === 'om_status')).toBe(true);
  });

  it('drains the newer queued card after a stale PATCH loses ownership', async () => {
    ds.streamCardId = 'om_status'; ds.streamCardNonce = 'nonce_original';
    mocks.patch.mockImplementationOnce(async () => {
      ds.streamCardNonce = 'nonce_new'; ds.streamCardId = 'om_new_status';
      scheduleCardPatch(ds, '{"status":"new"}');
      throw { isAxiosError: true, response: { status: 429 } };
    });
    scheduleCardPatch(ds, '{"status":"old"}');
    await vi.waitFor(() => expect(ds.cardPatchInFlight).toBe(false), { timeout: 3000 });
    expect(mocks.patch.mock.calls.map(([request]) => request.path.message_id)).toEqual(['om_status', 'om_new_status']);
    expect(ds.pendingCardJson).toBeUndefined();
  });

  it('freezes the original card after close even when the active registry no longer owns the session', async () => {
    ds.streamCardId = 'om_status'; ds.streamCardNonce = 'nonce_original';
    mocks.patch.mockRejectedValueOnce({ isAxiosError: true, response: { status: 429 } });
    const result = await closeSession(ds.session.sessionId);
    expect(result.ok).toBe(true);
    await vi.waitFor(() => expect(ds.cardPatchInFlight).toBe(false), { timeout: 3000 });
    expect(ds.session.status).toBe('closed');
    expect(mocks.patch).toHaveBeenCalledTimes(2);
    expect(mocks.patch.mock.calls.every(([request]) => request.path.message_id === 'om_status')).toBe(true);
  });
});


it('drops a queued status PATCH when its source lookup observes owner replacement', async () => {
  ds.streamCardId = 'om_status'; ds.streamCardNonce = 'nonce_original';
  const read = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementationOnce(async request => {
    const result = await read(request); ds.streamCardNonce = 'nonce_new'; return result;
  });
  scheduleCardPatch(ds, '{"status":"working"}');
  await vi.waitFor(() => expect(ds.cardPatchInFlight).toBe(false), { timeout: 3000 });
  expect(mocks.patch).not.toHaveBeenCalled();
});

it('replaces pending active renders with a close freeze while the old PATCH is retrying', async () => {
  ds.streamCardId = 'om_status'; ds.streamCardNonce = 'nonce_original';
  let reject!: (error: unknown) => void;
  mocks.patch.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  scheduleCardPatch(ds, '{"status":"working"}');
  await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
  scheduleCardPatch(ds, '{"status":"queued_working"}');
  expect((await closeSession(ds.session.sessionId)).ok).toBe(true);
  reject({ isAxiosError: true, response: { status: 429 } });
  await vi.waitFor(() => expect(ds.cardPatchInFlight).toBe(false), { timeout: 3000 });
  expect(mocks.patch).toHaveBeenCalledTimes(2);
  expect(mocks.patch.mock.calls[1][0].data.content).not.toContain('queued_working');
  expect(ds.session.status).toBe('closed');
  expect(ds.pendingCardJson).toBeUndefined();
});


it.each(['private', 'disabled'] as const)('does not retry a close freeze after the card becomes %s', async change => {
  ds.streamCardId = 'om_status'; ds.streamCardNonce = 'nonce_original';
  mocks.patch.mockImplementationOnce(async () => {
    if (change === 'private') getBot(APP).config.privateCard = true;
    else getBot(APP).config.disableStreamingCard = true;
    throw { isAxiosError: true, response: { status: 429 } };
  });
  expect((await closeSession(ds.session.sessionId)).ok).toBe(true);
  await vi.waitFor(() => expect(ds.cardPatchInFlight).toBe(false), { timeout: 3000 });
  expect(mocks.patch).toHaveBeenCalledTimes(1);
});

it('does not clear a reused card after an old PATCH reports it withdrawn', async () => {
  ds.streamCardId = 'om_status'; ds.streamCardNonce = 'nonce_original';
  mocks.patch.mockImplementationOnce(async () => {
    ds.streamCardNonce = 'nonce_new';
    scheduleCardPatch(ds, '{"status":"new"}');
    return { code: 230011, msg: 'Message recalled' };
  });
  scheduleCardPatch(ds, '{"status":"old"}');
  await vi.waitFor(() => expect(ds.cardPatchInFlight).toBe(false), { timeout: 3000 });
  expect(ds.streamCardId).toBe('om_status');
  expect(ds.streamCardNonce).toBe('nonce_new');
  expect(mocks.patch).toHaveBeenCalledTimes(2);
});


it.each([
  ['lookup', 'nonce'], ['retry', 'nonce'], ['lookup', 'turn'], ['retry', 'turn'], ['none', 'none'],
] as const)('keeps restored-card ownership through %s with %s changes', async (timing, change) => {
  ds.streamCardId = 'om_restored'; ds.streamCardNonce = 'nonce_original';
  ds.currentTurnId = 'om_turn_old'; ds.lastScreenStatus = 'idle'; ds.displayMode = 'hidden';
  const worker = Object.assign(new EventEmitter(), {
    killed: false, send: vi.fn(), kill: vi.fn(), pid: 12345,
    stdout: new EventEmitter(), stderr: new EventEmitter(),
  });
  ds.worker = worker as any;
  setupWorkerHandlers(ds, worker as any);
  const replace = () => {
    if (change === 'nonce') ds.streamCardNonce = 'nonce_replacement';
    if (change === 'turn') ds.currentTurnId = 'turn_replacement';
  };
  if (timing === 'lookup') {
    const read = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementationOnce(async request => { const result = await read(request); replace(); return result; });
  } else if (timing === 'retry') {
    mocks.patch.mockImplementationOnce(async () => { replace(); throw { isAxiosError: true, response: { status: 429 } }; });
  }
  await worker.listeners('message')[0]({ type: 'ready', port: 9999, token: 'fixture', turnId: 'om_turn_old' });
  expect(mocks.patch).toHaveBeenCalledTimes(timing === 'lookup' ? 0 : 1);
  expect(mocks.reply).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(ds.streamCardId).toBe('om_restored');
});


it.each(['primary-failure', 'primary-generation', 'post-lookup', 'post-retry', 'patch-lookup', 'patch-retry', 'none'] as const)(
  'retains fallback-card ownership through %s', async timing => {
  const localCli = await import('../src/services/local-cli-opener.js');
  let localReady = false;
  const enabled = vi.spyOn(localCli, 'isLocalCliOpenEnabled').mockReturnValue(true);
  const ready = vi.spyOn(localCli, 'isLocalCliOpenReady').mockImplementation(() => localReady);
  try {
    prepareStatusCard(); ds.currentTurnId = 'om_turn_old'; ds.lastScreenStatus = 'idle'; ds.displayMode = 'hidden';
    const worker = Object.assign(new EventEmitter(), {
      killed: false, send: vi.fn(), kill: vi.fn(), pid: 12345,
      stdout: new EventEmitter(), stderr: new EventEmitter(),
    });
    ds.worker = worker as any; setupWorkerHandlers(ds, worker as any);
    let primaryFailed = false, fallbackSent = false;
    const read = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async request => {
      const result = await read(request);
      if (timing === 'post-lookup' && primaryFailed || timing === 'patch-lookup' && fallbackSent) {
        ds.currentTurnId = 'turn_replacement';
      }
      return result;
    });
    mocks.reply.mockImplementationOnce(async () => {
      primaryFailed = true;
      if (timing === 'primary-failure') ds.currentTurnId = 'turn_replacement';
      if (timing === 'primary-generation') ds.streamCardTurnGeneration = (ds.streamCardTurnGeneration ?? 0) + 1;
      throw new Error('primary card failed');
    });
    mocks.reply.mockImplementationOnce(async () => {
      if (timing === 'post-retry') {
        ds.currentTurnId = 'turn_replacement'; throw { isAxiosError: true, response: { status: 429 } };
      }
      localReady = true; fallbackSent = true; return { code: 0, data: { message_id: 'om_sent' } };
    });
    if (timing === 'patch-retry') mocks.patch.mockImplementationOnce(async () => {
      ds.currentTurnId = 'turn_replacement'; throw { isAxiosError: true, response: { status: 429 } };
    });
    await worker.listeners('message')[0]({ type: 'ready', port: 9999, token: 'fixture', turnId: 'om_turn_old' });
    expect(mocks.reply).toHaveBeenCalledTimes(['primary-failure', 'primary-generation', 'post-lookup'].includes(timing) ? 1 : 2);
    expect(mocks.patch).toHaveBeenCalledTimes(timing === 'patch-retry' || timing === 'none' ? 1 : 0);
    expect(mocks.create).not.toHaveBeenCalled();
  } finally { enabled.mockRestore(); ready.mockRestore(); }
});
