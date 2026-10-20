import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FrozenSessionReplyTarget } from '../src/types.js';

const mocks = vi.hoisted(() => ({ request: vi.fn(), create: vi.fn(), reply: vi.fn(), patch: vi.fn(), upload: vi.fn() }));
vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {
  request = mocks.request;
  im = { v1: {
    message: { create: mocks.create, reply: mocks.reply, patch: mocks.patch }, file: { create: mocks.upload },
    chat: { get: async () => ({ code: 0, data: { chat_mode: 'group' } }) },
  } };
} }));
import {
  initWorkerPool, setActiveSessionsRegistry, getActiveSessionsRegistry,
  __testOnly_deliverFinalOutput as deliverFinalOutput,
  __testOnly_setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import { updateTurnReplyCard } from '../src/core/turn-reply-card.js';
import { registerBot } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import { __testOnly_activeSessions as activeSessions, __testOnly_sessionReply as sessionReply, useOrdinaryOutputDelivery } from '../src/daemon.js';
import { __testOnly_resetLarkGate } from '../src/im/lark/api-gate.js';
import { getTurnResultRuntime, setTurnResultRuntime } from '../src/core/turn-result-runtime.js';
import { observeTurnResultTerminal } from '../src/core/turn-result-session.js';
import { TopicSendError } from '../src/cli/topic-send-guard.js';
import { TurnReplyCardStore } from '../src/services/turn-reply-card.js';
import * as sessionStore from '../src/services/session-store.js';

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
    workerGeneration: 1,
    currentReplyTarget: { turnId: 'turn-new', rootMessageId: 'om_new' },
    session: { sessionId: 'sid_worker_output', larkAppId: APP, chatId: 'oc_source', scope: 'chat',
      rootMessageId: 'om_source', cliId: 'claude-code', status: 'active', title: 'source', workingDir: data, workerGeneration: 1,
      turnReplyContexts: { om_turn_old: { target: { mode: 'thread', rootMessageId: 'om_source' }, sourceMessageId: 'om_turn_old' } } },
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
  setTurnResultRuntime(undefined);
  activeSessions.clear(); setActiveSessionsRegistry(originalRegistry);
  config.session.dataDir = oldDataDir;
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs(); __testOnly_resetLarkGate();
});

function final(target?: FrozenSessionReplyTarget, owns: () => boolean = () => true, content = 'answer'): Promise<{ owned: boolean; messageId?: string }> {
  return new Promise(resolve => deliverFinalOutput(ds, {
    type: 'final_output', turnId: 'om_turn_old', content, lastUuid: 'output-1',
  }, 'fixture', 0, (owned, messageId) => resolve({ owned, messageId }), owns, target));
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for worker result delivery');
}

describe('worker final-output topic transport', () => {
  it.each([
    ['stale_worker', 'stale'],
    ['delivery_suppressed_for_turn', 'suppressed'],
    ['trusted_caller_mismatch', 'caller'],
  ] as const)('rejects trusted delivery with %s before any Lark side effect', async (expected, mode) => {
    ds.session.turnReplyContexts!.om_turn_old = {
      target: { mode: 'thread', rootMessageId: 'om_source' },
      sourceMessageId: 'om_turn_old', senderOpenId: 'ou_requester',
    };
    ds.session.replyTargets = { om_turn_old: {
      rootMessageId: 'om_source', senderOpenId: 'ou_requester', updatedAt: new Date().toISOString(),
    } };
    if (mode === 'suppressed') {
      ds.suppressedFinalOutputTurns = new Map([['om_turn_old', 1]]);
    }
    const sent: unknown[] = [];
    const worker = Object.assign(new EventEmitter(), { pid: process.pid, connected: true,
      send: (message: unknown) => { sent.push(message); return true; },
      stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, kill: () => true });
    ds.worker = worker as never;
    __testOnly_setupWorkerHandlers(ds, ds.worker!, undefined, 1);
    worker.emit('message', {
      type: 'plugin_result_delivery', requestId: `req_${mode}`,
      sessionId: mode === 'stale' ? 'sid_stale' : ds.session.sessionId,
      pluginId: 'reference-reporter', turnId: 'om_turn_old', dispatchAttempt: 1,
      callerOpenId: mode === 'caller' ? 'ou_other' : 'ou_requester', callerUnionId: 'on_requester',
      deliveryId: `delivery_${mode}_20261015`, viewToken: 'view_token_abcdefghijklmnopqrstuvwxyz',
      expiresAt: '2099-10-16T00:00:00.000Z', fileCount: 1, responseKind: 'final',
    });
    await waitFor(() => sent.some(message => (message as any)?.type === 'plugin_result_delivery_result'));
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'plugin_result_delivery_result', ok: false, error: expected,
    }));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.reply).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it.each([
    ['sentinel terminal', 'nothing_to_send' as const],
    ['ordinary terminal', undefined],
  ])('records trusted plugin delivery before the %s result terminal', async (_label, outputDisposition) => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code', brand: 'lark',
      turnResults: { enabled: true }, replyCardMode: 'legacy' });
    ds.session.turnReplyContexts!.om_turn_old = {
      target: { mode: 'thread', rootMessageId: 'om_source' },
      sourceMessageId: 'om_turn_old', senderOpenId: 'ou_requester',
    };
    ds.session.replyTargets = { om_turn_old: {
      rootMessageId: 'om_source', senderOpenId: 'ou_requester', updatedAt: new Date().toISOString(),
    } };
    const sent: unknown[] = [];
    const worker = Object.assign(new EventEmitter(), { pid: process.pid, connected: true,
      send: (message: unknown) => { sent.push(message); return true; },
      stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, kill: () => true });
    ds.worker = worker as never;
    mocks.upload.mockReset().mockResolvedValue({ file_key: 'file_trusted' });
    mocks.reply.mockImplementation(async input => ({ code: 0, data: {
      message_id: input.data.msg_type === 'file' ? 'om_attachment' : 'om_primary',
    } }));
    __testOnly_setupWorkerHandlers(ds, ds.worker!, undefined, 1);
    worker.emit('message', {
      type: 'plugin_result_delivery', requestId: 'req_trusted', sessionId: ds.session.sessionId,
      pluginId: 'reference-reporter', turnId: 'om_turn_old', callerOpenId: 'ou_requester', callerUnionId: 'on_requester',
      deliveryId: 'delivery_20261014', viewToken: 'view_token_abcdefghijklmnopqrstuvwxyz',
      expiresAt: '2099-10-16T00:00:00.000Z', fileCount: 1, responseKind: 'final',
    });
    await waitFor(() => sent.some(message => (message as any)?.type === 'plugin_result_delivery_result'));
    const entryReply = mocks.reply.mock.calls.find(([input]) => input.data.msg_type === 'interactive');
    const entryCard = JSON.parse(entryReply?.[0].data.content ?? '{}');
    const entryLinks = entryCard.elements?.[1]?.actions?.[0]?.multi_url;
    expect(entryLinks?.url).toMatch(/^https:\/\/applink\.larksuite\.com\/client\/web_url\/open\?/);
    expect(entryLinks?.pc_url).toBe(entryLinks?.url);
    expect(entryLinks?.android_url).toContain('/plugin-result-access/view_token_abcdefghijklmnopqrstuvwxyz');
    expect(entryLinks?.ios_url).toBe(entryLinks?.android_url);
    worker.emit('message', { type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'om_turn_old', status: 'completed', ...(outputDisposition ? { outputDisposition } : {}) });
    await waitFor(() => getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old').status === 'ready');
    const lookup = getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old');
    expect(lookup?.status).toBe('ready');
    if (lookup?.status !== 'ready') throw new Error('Expected trusted delivery result');
    expect(lookup.result.output).toEqual({ status: 'unavailable', reason: 'trusted_plugin_delivery' });
    expect(lookup.result.deliveries).toEqual([{
      channel: 'im', status: 'delivered', platform: 'lark', chatId: 'oc_source', parentMessageId: 'om_source',
      messages: [{ kind: 'primary', messageId: 'om_primary' }],
    }]);
    expect(JSON.stringify(lookup)).not.toContain('CONFIDENTIAL_BUSINESS_SENTINEL');
    expect(JSON.stringify(lookup)).not.toContain('result.xlsx');
  });

  it.each([
    ['delivered', true],
    ['failed', false],
  ])('records a non-leaking %s trusted plugin delivery terminal', async (expectedStatus, primarySucceeds) => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
      turnResults: { enabled: true }, replyCardMode: 'legacy' });
    ds.session.turnReplyContexts!.om_turn_old = {
      target: { mode: 'thread', rootMessageId: 'om_source' },
      sourceMessageId: 'om_turn_old', senderOpenId: 'ou_requester',
    };
    ds.session.replyTargets = { om_turn_old: {
      rootMessageId: 'om_source', senderOpenId: 'ou_requester', updatedAt: new Date().toISOString(),
    } };
    const sent: unknown[] = [];
    const worker = Object.assign(new EventEmitter(), { pid: process.pid, connected: true,
      send: (message: unknown) => { sent.push(message); return true; },
      stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, kill: () => true });
    ds.worker = worker as never;
    mocks.reply.mockImplementation(async () => {
      if (!primarySucceeds) throw new Error('CONFIDENTIAL_PROVIDER_SENTINEL');
      return { code: 0, data: { message_id: 'om_primary' } };
    });
    mocks.upload.mockReset().mockRejectedValue(new Error('/private/CONFIDENTIAL_FILE_SENTINEL.xlsx'));
    __testOnly_setupWorkerHandlers(ds, ds.worker!, undefined, 1);
    worker.emit('message', {
      type: 'plugin_result_delivery', requestId: 'req_failed', sessionId: ds.session.sessionId,
      pluginId: 'reference-reporter', turnId: 'om_turn_old', callerOpenId: 'ou_requester', callerUnionId: 'on_requester',
      deliveryId: 'delivery_20261015', viewToken: 'view_token_abcdefghijklmnopqrstuvwxyz',
      expiresAt: '2099-10-16T00:00:00.000Z', fileCount: 1, responseKind: 'final',
    });
    await waitFor(() => sent.some(message => (message as any)?.type === 'plugin_result_delivery_result'));
    worker.emit('message', { type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'om_turn_old', status: 'failed' });
    await waitFor(() => getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old').status === 'ready');
    const lookup = getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old');
    expect(lookup?.status).toBe('ready');
    if (lookup?.status !== 'ready') throw new Error('Expected failed trusted delivery result');
    expect(lookup.result.output.status).toBe('unavailable');
    expect(lookup.result.deliveries[0]).toEqual({
      channel: 'im', status: expectedStatus, platform: 'lark', chatId: 'oc_source', parentMessageId: 'om_source',
      messages: primarySucceeds ? [{ kind: 'primary', messageId: 'om_primary' }] : [],
      ...(!primarySucceeds ? { reason: 'trusted_plugin_delivery_failed' } : {}),
    });
    expect(JSON.stringify(lookup)).not.toMatch(/CONFIDENTIAL|secret\.xlsx|private/);
    expect(JSON.stringify(sent)).not.toMatch(/CONFIDENTIAL|secret\.xlsx|private/);
  });

  it.each([
    ['failed', false],
  ])('lets a normal successful final replace a %s trusted plugin attempt', async (_status, primarySucceeds) => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
      turnResults: { enabled: true }, replyCardMode: 'legacy' });
    ds.session.turnReplyContexts!.om_turn_old = {
      target: { mode: 'thread', rootMessageId: 'om_source' },
      sourceMessageId: 'om_turn_old', senderOpenId: 'ou_requester',
    };
    ds.session.replyTargets = { om_turn_old: {
      rootMessageId: 'om_source', senderOpenId: 'ou_requester', updatedAt: new Date().toISOString(),
    } };
    const sent: unknown[] = [];
    const worker = Object.assign(new EventEmitter(), { pid: process.pid, connected: true,
      send: (message: unknown) => { sent.push(message); return true; },
      stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, kill: () => true });
    ds.worker = worker as never;
    mocks.reply.mockImplementation(async () => {
      if (!primarySucceeds) throw new Error('CONFIDENTIAL_PROVIDER_SENTINEL');
      return { code: 0, data: { message_id: 'om_plugin_partial' } };
    });
    mocks.upload.mockReset().mockRejectedValue(new Error('/private/CONFIDENTIAL_FILE_SENTINEL.xlsx'));
    __testOnly_setupWorkerHandlers(ds, ds.worker!, undefined, 1);
    worker.emit('message', {
      type: 'plugin_result_delivery', requestId: 'req_recover', sessionId: ds.session.sessionId,
      pluginId: 'reference-reporter', turnId: 'om_turn_old', callerOpenId: 'ou_requester', callerUnionId: 'on_requester',
      deliveryId: 'delivery_20261016', viewToken: 'view_token_abcdefghijklmnopqrstuvwxyz',
      expiresAt: '2099-10-16T00:00:00.000Z', fileCount: 1, responseKind: 'final',
    });
    await waitFor(() => sent.some(message => (message as any)?.type === 'plugin_result_delivery_result'));

    mocks.reply.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_fallback_final' } });
    mocks.upload.mockReset().mockResolvedValue({ file_key: 'unused' });
    await final({ mode: 'thread', rootMessageId: 'om_source' }, () => true, 'safe fallback answer');
    worker.emit('message', { type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'om_turn_old', status: 'completed' });
    await waitFor(() => getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old').status === 'ready');
    const lookup = getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old');
    expect(lookup).toMatchObject({
      status: 'ready',
      result: {
        execution: { status: 'completed' },
        output: { status: 'available', content: 'safe fallback answer', source: 'transcript' },
        deliveries: [{ status: 'delivered', messages: [{ kind: 'primary', messageId: 'om_fallback_final' }] }],
      },
    });
    expect(JSON.stringify(lookup)).not.toMatch(/CONFIDENTIAL|secret\.xlsx|private|om_plugin_partial/);
  });

  it('keeps ordinary result collection alive when durable delivery is disabled', async () => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code', turnResults: { enabled: true } });
    useOrdinaryOutputDelivery();
    observeTurnResultTerminal(ds, { type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'om_turn_old', status: 'completed' }, 1);
    await final({ mode: 'thread', rootMessageId: 'om_source' });
    expect(getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old').status).toBe('ready');
  });

  it('clears retained results when the actual terminal adapter sees revoked mode', async () => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code', turnResults: { enabled: true } });
    observeTurnResultTerminal(ds, { type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'om_turn_old', status: 'completed' }, 1);
    await final({ mode: 'thread', rootMessageId: 'om_source' });
    ds.session.vcMeetingReceiver = {} as never;
    observeTurnResultTerminal(ds, { type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'om_turn_old', status: 'completed' }, 1);
    delete ds.session.vcMeetingReceiver;
    expect(getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old')).toEqual({ status: 'not_found' });
  });

  it('rejects unrelated unsupported turns without clearing an admitted result', async () => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code', turnResults: { enabled: true } });
    observeTurnResultTerminal(ds, { type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'om_turn_old', status: 'completed' }, 1);
    await final({ mode: 'thread', rootMessageId: 'om_source' });
    observeTurnResultTerminal(ds, { type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'om_synthetic', status: 'completed', outputDisposition: 'nothing_to_send' }, 1);
    expect(getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_synthetic')).toEqual({ status: 'not_found' });
    expect(getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old').status).toBe('ready');
  });

  it.each(['vc', 'headless'])('preserves ordinary results after an unadmitted %s session terminates', async mode => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code', turnResults: { enabled: true } });
    observeTurnResultTerminal(ds, { type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'om_turn_old', status: 'completed' }, 1);
    await final({ mode: 'thread', rootMessageId: 'om_source' });
    const other = {
      ...ds, chatId: 'oc_unsupported', session: { ...ds.session, sessionId: 'sid_unsupported', chatId: 'oc_unsupported',
        ...(mode === 'vc' ? { vcMeetingReceiver: {} as never } : { headless: true }) },
    } as DaemonSession;
    activeSessions.set(activeSessionKey(other), other);
    observeTurnResultTerminal(other, { type: 'turn_terminal', sessionId: other.session.sessionId,
      turnId: 'om_never_admitted', status: 'completed', outputDisposition: 'nothing_to_send' }, 1);
    expect(getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old')).toMatchObject({
      status: 'ready', result: { output: { content: 'answer' } },
    });
    expect(getTurnResultRuntime()?.read(APP, other.session.sessionId, 'om_never_admitted')).toEqual({ status: 'not_found' });
  });

  it('preserves an earlier ready turn when a new generation terminates an unsupported turn', async () => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code', turnResults: { enabled: true } });
    observeTurnResultTerminal(ds, { type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'om_turn_old', status: 'completed' }, 1);
    await final({ mode: 'thread', rootMessageId: 'om_source' });
    ds.workerGeneration = 2;
    ds.session.workerGeneration = 2;
    ds.session.headless = true;
    observeTurnResultTerminal(ds, { type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'om_new_headless', dispatchAttempt: 1, status: 'completed', outputDisposition: 'nothing_to_send' }, 2);
    delete ds.session.headless;
    expect(getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old').status).toBe('ready');
    expect(getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_new_headless', 1)).toEqual({ status: 'not_found' });
  });

  it('rejects terminal facts when daemon and persisted worker generations disagree', () => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code', turnResults: { enabled: true } });
    ds.workerGeneration = 2;
    observeTurnResultTerminal(ds, { type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'om_turn_old', status: 'completed', outputDisposition: 'nothing_to_send' }, 1);
    expect(getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old')).toEqual({ status: 'not_found' });
    ds.workerGeneration = 1;
    observeTurnResultTerminal(ds, { type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'om_turn_old', status: 'completed', outputDisposition: 'nothing_to_send' }, 1);
    expect(getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old').status).toBe('ready');
  });

  it('retains the acknowledged final attachment after primary content audit rejection', async () => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
      turnResults: { enabled: true }, replyCardMode: 'unified' });
    mocks.upload.mockResolvedValue({ file_key: 'file_result' });
    mocks.reply.mockImplementation(async input => input.data.msg_type === 'file'
      ? { code: 0, data: { message_id: 'om_overflow' } }
      : { code: 230028, msg: 'content audit rejected' });
    observeTurnResultTerminal(ds, { type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'om_turn_old', status: 'completed' }, 1);
    await final({ mode: 'thread', rootMessageId: 'om_source' }, () => true, '完整内容'.repeat(20000));
    const lookup = getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old');
    expect(lookup?.status === 'ready' && lookup.result.output.status).toBe('unavailable');
    expect(lookup?.status === 'ready' && lookup.result.deliveries[0]).toMatchObject({
      status: 'partial', messages: [{ kind: 'attachment', messageId: 'om_overflow' }],
    });
  });
  it('uses the actual worker terminal handler only for an admitted IM input', async () => {
    sessionStore.init(APP);
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'traex',
      turnResults: { enabled: true }, replyCardMode: 'legacy' });
    const worker = Object.assign(new EventEmitter(), { pid: process.pid, send: () => true,
      stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, kill: () => true });
    ds.worker = worker as never;
    ds.session.cliId = 'traex';
    ds.session.status = 'active';
    __testOnly_setupWorkerHandlers(ds, ds.worker!, undefined, 1);
    worker.emit('message', { type: 'turn_terminal', sessionId: ds.session.sessionId, turnId: 'om_synthetic',
      status: 'completed', outputDisposition: 'nothing_to_send' });
    worker.emit('message', { type: 'turn_terminal', sessionId: ds.session.sessionId, turnId: 'om_turn_old',
      status: 'completed', outputDisposition: 'nothing_to_send' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_synthetic')).toEqual({ status: 'not_found' });
    const lookup = getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old');
    expect(lookup?.status === 'ready' && lookup.result.source.messageId).toBe('om_turn_old');
    expect(lookup?.status === 'ready' && lookup.result.output).toEqual({ status: 'empty' });
  });
  it('preserves the original explicit final instead of the subsequent transcript', async () => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
      turnResults: { enabled: true }, replyCardMode: 'unified' });
    const target = { mode: 'thread' as const, rootMessageId: 'om_source' };
    await updateTurnReplyCard(ds, 'om_turn_old', {
      kind: 'final', text: 'already delivered final', card: '{"schema":"2.0","body":{"elements":[{"tag":"markdown","content":"already delivered final"}]}}', source: 'explicit',
    }, (body, type, uuid) => sessionReply('oc_source', body, type, APP, 'om_turn_old', { uuid, sourceSessionId: ds.session.sessionId, replyTarget: target }));
    observeTurnResultTerminal(ds, { type: 'turn_terminal', sessionId: ds.session.sessionId, turnId: 'om_turn_old', status: 'completed' }, 1);
    const beforeFallback = getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old');
    expect(beforeFallback?.status).toBe('not_ready');
    await final(target, () => true, 'different transcript');
    const lookup = getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old');
    expect(lookup?.status === 'ready' && lookup.result.output).toEqual({ status: 'unavailable', reason: 'explicit_publication_unproven' });
    expect(lookup?.status === 'ready' && lookup.result.deliveries[0].status).toBe('unknown');
  });

  it('collects an acknowledged explicit record from another sender only after the native terminal', async () => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
      turnResults: { enabled: true }, replyCardMode: 'unified' });
    const store = new TurnReplyCardStore(config.session.dataDir);
    const key = { larkAppId: APP, sessionId: ds.session.sessionId, turnId: 'om_turn_old' };
    await store.prepare(key, { mode: 'unified', chatId: ds.chatId, rootId: ds.chatId });
    await store.update(key, { kind: 'final', text: 'explicit sender final', source: 'explicit',
      card: '{"schema":"2.0","body":{"elements":[{"tag":"markdown","content":"explicit sender final"}]}}' }, {
      beforeEffect: () => {}, render: record => record.finalCard!, send: async () => 'om_explicit',
      patch: async () => {}, isWithdrawn: () => false,
    });
    expect(getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old').status).toBe('not_found');
    observeTurnResultTerminal(ds, { type: 'turn_terminal', sessionId: ds.session.sessionId, turnId: 'om_turn_old', status: 'completed' }, 1);
    const lookup = getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old');
    expect(lookup?.status).toBe('not_ready');
  });

  it.each(['local-headless-example', 'trg_http', 'om_settled_http'])('does not classify %s as an ordinary IM input', turnId => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
      turnResults: { enabled: true }, replyCardMode: 'legacy' });
    ds.session.turnReplyContexts = { [turnId]: { target: { mode: 'thread', rootMessageId: 'om_source' } } };
    if (turnId === 'om_settled_http') ds.settledHttpTerminalTurns = new Set([turnId]);
    observeTurnResultTerminal(ds, { type: 'turn_terminal', sessionId: ds.session.sessionId, turnId,
      status: 'completed', outputDisposition: 'nothing_to_send' }, 1);
    expect(getTurnResultRuntime()?.read(APP, ds.session.sessionId, turnId)).toEqual({ status: 'not_found' });
  });

  it('does not treat a synthetic message-shaped turn with a reply context as IM admission', () => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
      turnResults: { enabled: true }, replyCardMode: 'legacy' });
    ds.session.turnReplyContexts = { om_synthetic: { target: { mode: 'thread', rootMessageId: 'om_source' } } };
    observeTurnResultTerminal(ds, { type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'om_synthetic', status: 'completed', outputDisposition: 'nothing_to_send' }, 1);
    expect(getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_synthetic')).toEqual({ status: 'not_found' });
  });

  it('does not import an earlier explicit publication under a newer worker generation', async () => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
      turnResults: { enabled: true }, replyCardMode: 'unified' });
    const store = new TurnReplyCardStore(config.session.dataDir);
    const key = { larkAppId: APP, sessionId: ds.session.sessionId, turnId: 'om_turn_old' };
    await store.prepare(key, { mode: 'unified', chatId: ds.chatId, rootId: 'om_source' });
    await store.update(key, { kind: 'final', text: 'previous generation result', source: 'explicit',
      card: '{"schema":"2.0","body":{"elements":[{"tag":"markdown","content":"previous generation result"}]}}' }, {
      beforeEffect: () => {}, render: record => record.finalCard!, send: async () => 'om_previous',
      patch: async () => {}, isWithdrawn: () => false,
    });
    ds.workerGeneration = 2;
    ds.session.workerGeneration = 2;
    delete ds.session.turnReplyContexts;
    observeTurnResultTerminal(ds, { type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'om_turn_old', status: 'completed' }, 2);
    expect(getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old')).toEqual({ status: 'not_found' });
  });

  it('does not export a cached bridge publication as newly acknowledged by the current generation', async () => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
      turnResults: { enabled: true }, replyCardMode: 'unified' });
    const store = new TurnReplyCardStore(config.session.dataDir);
    const key = { larkAppId: APP, sessionId: ds.session.sessionId, turnId: 'om_turn_old' };
    await store.prepare(key, { mode: 'unified', chatId: ds.chatId, rootId: ds.chatId });
    await store.update(key, { kind: 'final', text: 'answer', source: 'bridge',
      card: '{"schema":"2.0","body":{"elements":[{"tag":"markdown","content":"answer"}]}}' }, {
      beforeEffect: () => {}, render: record => record.finalCard!, send: async () => 'om_cached',
      patch: async () => {}, isWithdrawn: () => false,
    });
    observeTurnResultTerminal(ds, { type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'om_turn_old', status: 'completed' }, 1);
    await final({ mode: 'thread', rootMessageId: 'om_source' });
    const lookup = getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old');
    expect(lookup?.status === 'ready' && lookup.result.output.status).toBe('unavailable');
    expect(lookup?.status === 'ready' && lookup.result.deliveries[0].status).toBe('unknown');
  });

  it('retains the acknowledged overflow when the final primary write remains unknown', async () => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
      turnResults: { enabled: true }, replyCardMode: 'unified' });
    mocks.upload.mockResolvedValue({ file_key: 'file_result' });
    mocks.reply.mockImplementation(async input => {
      if (input.data.msg_type === 'file') return { code: 0, data: { message_id: 'om_overflow' } };
      throw new TopicSendError('TOPIC_SEND_BLOCKED', 'unknown primary response');
    });
    observeTurnResultTerminal(ds, { type: 'turn_terminal', sessionId: ds.session.sessionId, turnId: 'om_turn_old', status: 'completed' }, 1);
    {
      await final({ mode: 'thread', rootMessageId: 'om_source' }, () => true, '完整答复'.repeat(20000));
      const lookup = getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old');
      expect(lookup?.status === 'ready' && lookup.result.output.status).toBe('unavailable');
      expect(lookup?.status === 'ready' && lookup.result.deliveries[0]).toMatchObject({
        status: 'partial', messages: [{ kind: 'attachment', messageId: 'om_overflow' }],
      });
    }
  });

  it('returns the complete long answer and the actual independent overflow attachment', async () => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
      turnResults: { enabled: true }, replyCardMode: 'unified' });
    mocks.upload.mockResolvedValue({ file_key: 'file_result' });
    mocks.reply.mockImplementation(async input => ({ code: 0, data: { message_id: input.data.msg_type === 'file' ? 'om_overflow' : 'om_sent' } }));
    const answer = '完整结果与证据'.repeat(6000);
    observeTurnResultTerminal(ds, { type: 'turn_terminal', sessionId: ds.session.sessionId, turnId: 'om_turn_old', status: 'completed' }, 1);
    await final({ mode: 'thread', rootMessageId: 'om_source' }, () => true, answer);
    const lookup = getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old');
    expect(lookup?.status === 'ready' && lookup.result.output.content).toBe(answer);
    expect(lookup?.status === 'ready' && lookup.result.deliveries[0].messages).toEqual([
      { kind: 'primary', messageId: 'om_sent' }, { kind: 'attachment', messageId: 'om_overflow' },
    ]);
  });

  it.each(['vc', 'isolated', 'adopted'])('does not collect a final for %s mode', async mode => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
      turnResults: { enabled: true }, replyCardMode: 'legacy', ...(mode === 'isolated' ? { readIsolation: true } : {}) });
    if (mode === 'vc') ds.session.vcMeetingReceiver = {} as never;
    if (mode === 'adopted') ds.adoptedFrom = 'fixture';
    observeTurnResultTerminal(ds, { type: 'turn_terminal', sessionId: ds.session.sessionId, turnId: 'om_turn_old', status: 'completed' }, 1);
    expect(getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old')).toEqual({ status: 'not_found' });
  });
  it.each(['terminal', 'delivery'])('returns exact ordinary final facts with %s first', async first => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
      turnResults: { enabled: true }, replyCardMode: 'legacy' });
    const terminal = () => observeTurnResultTerminal(ds, {
      type: 'turn_terminal', sessionId: ds.session.sessionId, turnId: 'om_turn_old',
      status: 'completed', completedAtMs: 1791849600000, durationMs: 1200,
    }, 1);
    if (first === 'terminal') terminal();
    await final({ mode: 'thread', rootMessageId: 'om_source' });
    if (first === 'delivery') terminal();
    const lookup = getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old');
    expect(lookup?.status).toBe('ready');
    if (lookup?.status !== 'ready') throw new Error('Expected ready result');
    expect(lookup.result.output).toEqual({ status: 'available', format: 'markdown', source: 'transcript', content: 'answer' });
    expect(lookup.result.deliveries).toEqual([{
      channel: 'im', status: 'delivered', platform: 'lark', chatId: 'oc_source', parentMessageId: 'om_source',
      messages: [{ kind: 'primary', messageId: 'om_sent' }],
    }]);
  });

  it('does not reinterpret an unavailable target as successful delivery', async () => {
    registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code',
      turnResults: { enabled: true }, topicUnavailablePolicy: 'stop', replyCardMode: 'legacy' });
    observeTurnResultTerminal(ds, { type: 'turn_terminal', sessionId: ds.session.sessionId,
      turnId: 'om_turn_old', status: 'completed' }, 1);
    unavailable = true;
    await final({ mode: 'thread', rootMessageId: 'om_source' });
    const lookup = getTurnResultRuntime()?.read(APP, ds.session.sessionId, 'om_turn_old');
    expect(lookup?.status === 'ready' && lookup.result.deliveries[0].status).toBe('failed');
    expect(lookup?.status === 'ready' && lookup.result.deliveries[0].messages).toEqual([]);
  });
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
