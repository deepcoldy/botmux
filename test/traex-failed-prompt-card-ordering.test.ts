import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateMessage = vi.fn(async (_app: string, _id: string, _card: string) => {});
const getMessageDetail = vi.fn();
vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: (...args: [string, string, string]) => updateMessage(...args),
  getMessageDetail: (...args: unknown[]) => getMessageDetail(...args),
  addReaction: vi.fn(async () => 'reaction_id'),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {},
  MessageUpdateExpiredError: class MessageUpdateExpiredError extends Error {},
}));

let cliId = 'traex';
let replyCardMode: 'legacy' | 'unified' | undefined;
vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId, replyCardMode },
    resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  getOwnerOpenId: vi.fn(() => undefined),
  getBotClient: vi.fn(() => ({ request: vi.fn(async () => ({ code: 0, data: {} })) })),
  getBotBrand: vi.fn(() => undefined),
  resolveBrandLabel: vi.fn(() => undefined),
  resolveUsageDisplay: vi.fn(() => 'footer'),
  normalizeUsageDisplay: vi.fn(() => 'off'),
}));
vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(), updateSession: vi.fn(), createSession: vi.fn(), updateSessionPid: vi.fn(),
}));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import { initWorkerPool, sendWorkerInput, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import { recordFailedTurnTerminal } from '../src/core/failed-turn-recovery.js';
import { rememberLastCliInput } from '../src/core/session-manager.js';
import { setDefaultLocale } from '../src/i18n/index.js';
import type { DaemonSession } from '../src/core/types.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

setDefaultLocale('zh');
const SID = 'sess-traex-card-ordering';
let sessionReply: ReturnType<typeof vi.fn>;
let terminalRecordGate: (() => Promise<void>) | undefined;

beforeEach(() => {
  cliId = 'traex'; replyCardMode = undefined; terminalRecordGate = undefined;
  updateMessage.mockReset(); getMessageDetail.mockReset();
  sessionReply = vi.fn(async () => 'om_card_1');
  initWorkerPool({
    sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn(),
    onTurnTerminal: async (ds: DaemonSession, terminal: Extract<WorkerToDaemon, { type: 'turn_terminal' }>, context: { workerGeneration: number }) => {
      await terminalRecordGate?.();
      recordFailedTurnTerminal(ds, terminal, { workerGeneration: context.workerGeneration, caller: undefined, silent: false });
    },
  } as any);
});
afterEach(() => vi.clearAllMocks());

function session(mode: 'legacy' | 'unified') {
  replyCardMode = mode;
  const worker = new EventEmitter() as any;
  const toWorker: DaemonToWorker[] = [];
  Object.assign(worker, {
    killed: false, connected: true, pid: 99999, kill: vi.fn(), stdout: new EventEmitter(), stderr: new EventEmitter(),
    send: vi.fn((message: DaemonToWorker, callback?: (error: Error | null) => void) => {
      toWorker.push(message); callback?.(null); return true;
    }),
  });
  const ds = {
    session: {
      sessionId: SID, rootMessageId: 'om_root', chatId: 'oc_test', title: 'recovery', status: 'active',
      createdAt: Date.now(), updatedAt: Date.now(), pid: null, chatType: 'group', cliId: 'traex',
    },
    worker, workerPort: 0, workerToken: 'tok', larkAppId: 'app_test', chatId: 'oc_test', chatType: 'group',
    spawnedAt: Date.now(), cliVersion: '1', lastMessageAt: Date.now(), hasHistory: true,
  } as unknown as DaemonSession;
  __testOnly_setupWorkerHandlers(ds, worker);
  const fromWorker = async (message: WorkerToDaemon) => {
    worker.emit('message', message);
    await new Promise(done => setTimeout(done, 30));
  };
  const turnId = mode === 'unified' ? 'om_msg_1' : 'trg_1';
  expect(sendWorkerInput(ds, 'inspect this image', turnId)).toBe(true);
  rememberLastCliInput(ds, 'inspect this image', 'inspect this image', turnId);
  return { ds, fromWorker, turnId };
}

describe('TRAE failed-prompt final/terminal ordering', () => {
  it.each(['legacy', 'unified'] as const)('patches the actual final carrier after terminal recording (%s)', async mode => {
    const s = session(mode);
    await s.fromWorker({
      type: 'final_output', sessionId: SID, turnId: s.turnId, lastUuid: s.turnId, content: 'tool image upload failed',
      turnFailed: true, turnFailureCode: 'traex_tool_image_upload_failed',
    });
    await vi.waitFor(() => expect(sessionReply).toHaveBeenCalled());
    const finalCard = String(sessionReply.mock.calls[0]![1]);
    expect(finalCard).toContain('"action":"purge_images_continue"');
    expect(finalCard).not.toContain('"action":"retry_turn"');
    getMessageDetail.mockResolvedValue({ items: [{ chat_id: 'oc_test', msg_type: 'interactive', body: { content: finalCard } }] });
    let releaseRecord!: () => void;
    terminalRecordGate = () => new Promise<void>(resolve => { releaseRecord = resolve; });
    await s.fromWorker({
      type: 'turn_terminal', sessionId: SID, turnId: s.turnId, status: 'failed',
      errorCode: 'traex_tool_image_upload_failed', directFailure: true,
      traexPromptCheckpoint: { sessionId: '858ca892-1234-4abc-9def-0123456789ab', offset: 1, prefixHash: 'a'.repeat(64) } });
    try {
      if (mode === 'unified') {
        // Force the ordinary terminal render to finish while no failure record
        // exists; only the post-record refresh can add the controls later.
        await vi.waitFor(() => expect(updateMessage).toHaveBeenCalled());
        expect(updateMessage.mock.calls.every(call => !String(call[2]).includes('"action":"retry_turn"'))).toBe(true);
      }
    } finally {
      releaseRecord();
      terminalRecordGate = undefined;
    }
    await vi.waitFor(() => expect(s.ds.session.lastFailedTurn).toMatchObject({ turnId: s.turnId, directFailure: true }));
    await vi.waitFor(() => {
      expect(updateMessage.mock.calls.some(call => call[1] === 'om_card_1'
        && String(call[2]).includes('"action":"retry_turn"')
        && String(call[2]).includes('"action":"edit_failed_prompt"'))).toBe(true);
    });
    expect(sessionReply).toHaveBeenCalledOnce();
    // Let the publisher's acknowledged tail finish before this isolated fixture ends.
    await new Promise(done => setTimeout(done, 50));
  });
});
