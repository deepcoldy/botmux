/**
 * The turn.finished notice is wired through the real worker IPC handler.
 * Deleting either publishTurnFinished call site, or emitting before the
 * durable callback accepts the terminal, fails these cases.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-finished-wire-'));

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  resolveCardKitId: vi.fn(async () => 'card'),
  patchCardStreamElement: vi.fn(async () => {}),
  getMessageDetail: vi.fn(async () => ({ items: [] })),
  addReaction: vi.fn(async () => 'reaction'),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {},
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'codex' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  getOwnerOpenId: vi.fn(() => undefined),
  getBotClient: vi.fn(),
  getBotBrand: vi.fn(() => undefined),
  resolveBrandLabel: vi.fn(() => undefined),
  resolveReplyDelivery: vi.fn(() => undefined),
  normalizeUsageDisplay: vi.fn(() => 'footer'),
  resolveUsageDisplay: vi.fn(() => 'footer'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { get dataDir() { return dataDir; } },
    daemon: { backendType: 'pty', cliId: 'codex' },
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

import { dashboardEventBus } from '../src/core/dashboard-events.js';
import { initWorkerPool, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';

const hookScript = join(dataDir, 'hook.js');
const markerDir = join(dataDir, 'markers');
writeFileSync(hookScript, `
  const fs = require('fs');
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const turnId = JSON.parse(body).turnId;
    fs.mkdirSync(${JSON.stringify(markerDir)}, { recursive: true });
    fs.writeFileSync(${JSON.stringify(markerDir)} + '/' + turnId, body);
  });
`);

const previousHooksJson = process.env.BOTMUX_HOOKS_JSON;
process.env.BOTMUX_HOOKS_JSON = JSON.stringify([{
  event: 'turn.finished',
  command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hookScript)}`,
  timeoutMs: 5000,
}]);

function makeDs(sessionId: string): DaemonSession {
  const fakeWorker = new EventEmitter() as any;
  fakeWorker.killed = false;
  fakeWorker.send = vi.fn();
  fakeWorker.kill = vi.fn();
  fakeWorker.pid = 4242;
  fakeWorker.stdout = new EventEmitter();
  fakeWorker.stderr = new EventEmitter();
  return {
    session: {
      sessionId,
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'fixture',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
      cliId: 'codex',
      ownerOpenId: 'ou_owner',
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
  } as DaemonSession;
}

function deliver(ds: DaemonSession, msg: WorkerToDaemon): Promise<void> {
  const worker = ds.worker as unknown as EventEmitter;
  return Promise.all(worker.listeners('message').map(listener => listener.call(worker, msg))).then(() => undefined);
}

async function readMarker(turnId: string): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < 4000) {
    try { return readFileSync(join(markerDir, turnId), 'utf8'); }
    catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  return '';
}

describe('turn.finished worker wiring', () => {
  const finished: Array<Record<string, unknown>> = [];
  let off = () => {};

  afterEach(() => {
    off();
    finished.length = 0;
    vi.mocked(sessionStore.updateSession).mockReset();
  });

  afterAll(() => {
    if (previousHooksJson === undefined) delete process.env.BOTMUX_HOOKS_JSON;
    else process.env.BOTMUX_HOOKS_JSON = previousHooksJson;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('publishes the hook and the loopback bus only after the terminal callback accepts', async () => {
    const ds = makeDs('sid-wire');
    ds.session.replyTargets = {
      om_wire: { senderOpenId: 'ou_sender', updatedAt: 't' },
    };
    let accept = true;
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => dataDir,
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onTurnTerminal: async () => {
        if (!accept) throw new Error('store down');
      },
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as never);
    off = dashboardEventBus.subscribe(event => {
      if (event.type === 'turn.finished' && (event.body as { sessionId?: string }).sessionId === 'sid-wire') {
        finished.push(event.body as Record<string, unknown>);
      }
    });

    accept = false;
    await deliver(ds, {
      type: 'turn_terminal',
      sessionId: 'sid-wire',
      turnId: 'om_wire',
      status: 'completed',
    });
    expect(finished).toEqual([]);

    accept = true;
    await deliver(ds, {
      type: 'turn_terminal',
      sessionId: 'sid-wire',
      turnId: 'om_wire',
      status: 'completed',
    });
    expect(finished).toEqual([expect.objectContaining({
      sessionId: 'sid-wire',
      turnId: 'om_wire',
      status: 'success',
      terminalStatus: 'completed',
      senderOpenId: 'ou_sender',
    })]);
    expect(JSON.stringify(finished)).not.toContain('ou_owner');
    const hookBody = await readMarker('om_wire');
    expect(hookBody).toContain('"event":"turn.finished"');
    expect(hookBody).toContain('ou_sender');
  });

  it('uses the Codex App ledger sender frozen at acceptance, and skips the notice when that persist throws', async () => {
    const ds = makeDs('sid-codex');
    ds.session.cliId = 'codex-app';
    ds.session.replyTargets = {
      'turn-frozen': { senderOpenId: 'ou_live', updatedAt: 't' },
    };
    ds.session.codexAppDispatchLedger = [{
      dispatchId: 'dispatch-frozen',
      turnId: 'turn-frozen',
      dispatchAttempt: 4,
      state: 'prepared',
      content: 'prompt',
      replyTargetSenderOpenId: 'ou_frozen',
      replyTarget: { mode: 'plain', chatId: 'oc_chat' },
    }];
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => dataDir,
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onTurnTerminal: async () => {},
    });
    __testOnly_setupWorkerHandlers(ds, ds.worker as never);
    off = dashboardEventBus.subscribe(event => {
      if (event.type === 'turn.finished' && (event.body as { sessionId?: string }).sessionId === 'sid-codex') {
        finished.push(event.body as Record<string, unknown>);
      }
    });

    vi.mocked(sessionStore.updateSession).mockImplementationOnce(() => {
      throw new Error('disk');
    });
    await deliver(ds, {
      type: 'final_output',
      sessionId: 'sid-codex',
      content: '',
      lastUuid: 'uuid-frozen',
      turnId: 'turn-frozen',
      dispatchAttempt: 4,
      codexAppSettlement: {
        requestId: 'req-frozen',
        generation: 'gen-frozen',
        seq: 1,
        dispatchId: 'dispatch-frozen',
      },
    });
    expect(finished).toEqual([]);

    vi.mocked(sessionStore.updateSession).mockImplementation(() => {});
    await deliver(ds, {
      type: 'final_output',
      sessionId: 'sid-codex',
      content: '',
      lastUuid: 'uuid-frozen',
      turnId: 'turn-frozen',
      dispatchAttempt: 4,
      codexAppSettlement: {
        requestId: 'req-frozen-2',
        generation: 'gen-frozen',
        seq: 1,
        dispatchId: 'dispatch-frozen',
      },
    });
    expect(finished).toEqual([expect.objectContaining({
      turnId: 'turn-frozen',
      dispatchAttempt: 4,
      status: 'success',
      terminalStatus: 'completed',
      senderOpenId: 'ou_frozen',
    })]);
    expect(JSON.stringify(finished)).not.toContain('ou_live');
  });
});
