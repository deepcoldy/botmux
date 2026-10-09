import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FrozenSessionReplyTarget } from '../src/types.js';

const mocks = vi.hoisted(() => ({ request: vi.fn(), create: vi.fn(), reply: vi.fn(), patch: vi.fn() }));
vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {
  request = mocks.request;
  im = { v1: {
    message: { create: mocks.create, reply: mocks.reply, patch: mocks.patch },
    chat: { get: async () => ({ code: 0, data: { chat_mode: 'group' } }) },
  } };
} }));
import {
  initWorkerPool, setActiveSessionsRegistry, getActiveSessionsRegistry,
  __testOnly_deliverFinalOutput as deliverFinalOutput,
} from '../src/core/worker-pool.js';
import { updateTurnReplyCard } from '../src/core/turn-reply-card.js';
import { registerBot } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import { __testOnly_activeSessions as activeSessions, __testOnly_sessionReply as sessionReply } from '../src/daemon.js';
import { __testOnly_resetLarkGate } from '../src/im/lark/api-gate.js';

const APP = 'cli_worker_topic_output';
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
});
afterEach(() => {
  activeSessions.clear(); setActiveSessionsRegistry(originalRegistry);
  config.session.dataDir = oldDataDir;
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs(); __testOnly_resetLarkGate();
});

function final(target?: FrozenSessionReplyTarget, owns: () => boolean = () => true): Promise<{ owned: boolean; messageId?: string }> {
  return new Promise(resolve => deliverFinalOutput(ds, {
    type: 'final_output', turnId: 'om_turn_old', content: 'answer', lastUuid: 'output-1',
  }, 'fixture', 0, (owned, messageId) => resolve({ owned, messageId }), owns, target));
}

describe('worker final-output topic transport', () => {
  it.each(['thread', 'quote'] as const)('blocks the withdrawn frozen %s target without changing destination', async mode => {
    unavailable = true;
    const result = await final({ mode, rootMessageId: 'om_source' });
    expect(result).toEqual({ owned: false, messageId: undefined });
    expect(mocks.reply).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
    expect(ds.session.status).toBe('active');
  }, 30000);

  it.each(['thread', 'quote'] as const)('preserves an available frozen %s target despite a newer live turn', async mode => {
    expect(await final({ mode, rootMessageId: 'om_source' })).toMatchObject({ owned: true, messageId: 'om_sent' });
    expect(mocks.reply).toHaveBeenCalledOnce();
    expect(mocks.reply.mock.calls[0][0]).toMatchObject({
      path: { message_id: 'om_source' },
      data: mode === 'thread' ? { reply_in_thread: true } : {},
    });
    if (mode === 'quote') expect(mocks.reply.mock.calls[0][0].data.reply_in_thread).toBeUndefined();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rechecks the original target after provider throttling instead of using the new live target', async () => {
    mocks.reply.mockImplementationOnce(async () => {
      unavailable = true;
      ds.currentReplyTarget = { turnId: 'turn-newer', rootMessageId: 'om_newer' };
      throw { isAxiosError: true, response: { status: 429 } };
    });
    expect(await final({ mode: 'thread', rootMessageId: 'om_source' })).toMatchObject({ owned: false });
    expect(mocks.reply).toHaveBeenCalledOnce();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls.every(([r]) => r.url.endsWith('/om_source'))).toBe(true);
  }, 30000);

  it('freezes the ordinary final target before a daemon retry outlives its turn record', async () => {
    ds.currentReplyTarget = { turnId: 'om_turn_old', rootMessageId: 'om_source' };
    mocks.reply.mockImplementationOnce(async () => {
      unavailable = true;
      ds.currentReplyTarget = { turnId: 'turn-new', rootMessageId: 'om_new' };
      throw new Error('temporary connection failure');
    });
    expect(await final()).toMatchObject({ owned: false });
    expect(mocks.reply).toHaveBeenCalledOnce();
    expect(mocks.create).not.toHaveBeenCalled();
  }, 30000);


  it.each(['lookup', 'retry'])('rechecks worker ownership before the final reply after %s', async timing => {
    let owns = true;
    const read = mocks.request.getMockImplementation()!;
    if (timing === 'lookup') {
      mocks.request.mockImplementationOnce(async input => { const result = await read(input); owns = false; return result; });
    } else {
      mocks.reply.mockImplementationOnce(async () => {
        owns = false;
        throw { isAxiosError: true, response: { status: 429 } };
      });
    }
    await final({ mode: 'thread', rootMessageId: 'om_source' }, () => owns);
    expect(mocks.reply).toHaveBeenCalledTimes(timing === 'retry' ? 1 : 0);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
  });

  it.each(['lookup', 'retry'])('rechecks worker ownership before patching an existing reply after %s', async timing => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
      topicUnavailablePolicy: 'stop', replyCardMode: 'unified' });
    let owns = true;
    const target = { mode: 'thread' as const, rootMessageId: 'om_source' };
    await updateTurnReplyCard(ds, 'om_turn_old', { kind: 'progress', text: 'Working' }, (body, type, uuid) =>
      sessionReply('oc_source', body, type, APP, 'om_turn_old', {
        uuid, sourceSessionId: ds.session.sessionId, replyTarget: target,
      }), { owns: () => owns, forceVisible: true });
    expect(mocks.reply).toHaveBeenCalledOnce();
    mocks.reply.mockClear(); mocks.patch.mockClear(); mocks.request.mockClear();
    const read = mocks.request.getMockImplementation()!;
    if (timing === 'lookup') {
      mocks.request.mockImplementationOnce(async input => { const result = await read(input); owns = false; return result; });
    } else {
      mocks.patch.mockImplementationOnce(async () => {
        owns = false;
        throw { isAxiosError: true, response: { status: 429 } };
      });
    }
    await final(target, () => owns);
    expect(mocks.patch).toHaveBeenCalledTimes(timing === 'retry' ? 1 : 0);
    expect(mocks.reply).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('keeps an explicitly unthreaded final at the chat level', async () => {
    unavailable = true;
    expect(await final({ mode: 'plain', chatId: 'oc_source' })).toMatchObject({ owned: true });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.reply).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls.filter(([r]) => r.url.includes('/im/v1/messages/'))).toHaveLength(0);
  });
});
