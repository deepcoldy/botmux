// Real relay admission + real final-output delivery; only the CLI process and Lark network are mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateTriggerRequest, type TriggerRequest } from '../src/services/trigger-types.js';
import { buildOrchestratorReportTrigger, deliverReportSessionRelay, retryAutomaticDispatchReport } from '../src/core/report-session-relay.js';
import type { DaemonSession } from '../src/core/types.js';

let tempDir: string;
let prevDataDir: string | undefined;

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/im/lark/client.js', () => ({
  getMessageChatId: vi.fn(),
  getChatMode: vi.fn(async () => 'group'),
  sendMessage: vi.fn(async () => 'om_x'),
  replyMessage: vi.fn(async () => 'om_x'),
  listChatBotMembers: vi.fn(async () => []),
}));

const mockGetBot = vi.fn(() => ({ config: { cliId: 'codex-app', apiOnly: true } }));
vi.mock('../src/bot-registry.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/bot-registry.js')>(),
  getBot: (...a: any[]) => mockGetBot(...a),
  effectiveDefaultWorkingDir: vi.fn(() => '/tmp'),
}));

vi.mock('../src/services/groups-store.js', () => ({ isInChat: vi.fn(async () => true) }));
vi.mock('../src/services/oncall-store.js', () => ({ getOncallStatus: vi.fn(() => undefined) }));

const existingRows: any[] = [];
vi.mock('../src/services/session-store.js', () => ({
  createSession: vi.fn(),
  updateSession: vi.fn(),
  getSession: vi.fn((id: string) => existingRows.find(s => s.sessionId === id)),
  getOwnedSession: vi.fn((id: string) => existingRows.find(s => s.sessionId === id)),
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
}));

vi.mock('../src/services/message-queue.js', () => ({ ensureQueue: vi.fn() }));
vi.mock('../src/core/session-manager.js', () => ({
  buildFollowUpContent: vi.fn((p: string) => p),
  buildFollowUpCliInput: vi.fn((p: string) => ({ content: p })),
  buildNewTopicPrompt: vi.fn((p: string) => p),
  buildNewTopicCliInput: vi.fn((p: string) => ({ content: p })),
  ensureSessionWhiteboard: vi.fn(),
  getAvailableBots: vi.fn(async () => []),
  rememberLastCliInput: vi.fn(),
}));
vi.mock('../src/services/default-worktree.js', () => ({ botAutoWorktreeEnabled: vi.fn(() => false) }));
vi.mock('../src/im/lark/card-handler.js', () => ({ runAutoWorktreeCommit: vi.fn(async () => {}) }));

// worker-pool: sendWorkerInput (worker-live) + forkWorker (dormant) are the two
// dispatch side effects. Either can be made to throw/refuse on demand.
let forkShouldThrow = false;
let sendShouldRefuse = false;
let queuedActivationGateActive = false;
const mockForkWorker = vi.fn(() => { if (forkShouldThrow) throw new Error('injected fork failure'); });
const mockSendWorkerInput = vi.fn(() => !sendShouldRefuse);
const mockCloseSession = vi.fn(async () => ({ ok: true, alreadyClosed: false, known: true }));
vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: (...a: any[]) => mockForkWorker(...a),
  sendWorkerInput: (...a: any[]) => mockSendWorkerInput(...a),
  getCurrentCliVersion: vi.fn(() => 'test'),
  setActiveSessionIfActive: (map: Map<string, any>, key: string, ds: any) => { map.set(key, ds); return true; },
  closeSession: (...a: any[]) => mockCloseSession(...a),
  getDaemonBootId: () => 'boot-CURRENT',
  withActiveSessionKeyLock: (_map: any, _key: string, action: () => any) => action(),
  hasQueuedActivationAdmissionGate: () => queuedActivationGateActive,
}));

import { triggerSessionTurn } from '../src/core/trigger-session.js';
import * as asyncTriggerStore from '../src/services/async-trigger-store.js';
import { sessionKey } from '../src/core/types.js';

const APP = 'local_riff';
const SID = 'sess_existing';
const CHAT = `http_async_${'0'.repeat(8)}-0000-0000-0000-000000000000`;

function existingDs(overrides: Partial<DaemonSession> = {}): DaemonSession {
  const s = { sessionId: SID, chatId: CHAT, rootMessageId: '', scope: 'chat', status: 'active', createdAt: '2026-06-01T00:00:00.000Z' };
  return {
    session: s,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: APP,
    chatId: CHAT,
    chatType: 'group',
    scope: 'chat',
    spawnedAt: 1,
    cliVersion: 'test',
    lastMessageAt: 1,
    hasHistory: true,
    ...overrides,
  } as DaemonSession;
}

/** activeSessions map holding one existing session keyed canonically. */
function activeWith(ds: DaemonSession): Map<string, DaemonSession> {
  return new Map<string, DaemonSession>([[sessionKey(CHAT, APP), ds]]);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'trig-turn-idem-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = tempDir;
  existingRows.length = 0;
  existingRows.push({ sessionId: SID, chatId: CHAT, scope: 'chat', status: 'active' });
  mockGetBot.mockImplementation(() => ({ config: { cliId: 'codex-app', apiOnly: true } }));
  forkShouldThrow = false; sendShouldRefuse = false; queuedActivationGateActive = false;
  mockForkWorker.mockClear(); mockSendWorkerInput.mockClear(); mockCloseSession.mockClear();
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR; else process.env.SESSION_DATA_DIR = prevDataDir;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('zero prompt report delivery', () => {
  it.each(['live', 'dormant'] as const)('automatic report to a %s lead retries once and posts its final to Lark', async (mode) => {
    const ds = existingDs({ worker: mode === 'live' ? { killed: false, send: vi.fn() } as any : null });
    mockGetBot.mockReturnValue({ config: { cliId: 'claude-code', apiOnly: false } });
    ds.chatId = ds.session.chatId = 'oc_lead';
    ds.session.rootMessageId = 'om_lead';
    existingRows[0].chatId = 'oc_lead';
    ds.latestAsyncTriggerId = 'real-http-request';
    const activeSessions = activeWith(ds);
    const decision = { ok: true as const, source: { sessionId: 'sub', larkAppId: 'cli_sub' },
      target: { sessionId: SID, larkAppId: APP }, dispatchRoot: 'om_dispatch',
      sourceName: 'review', content: 'review result', projectUpdate: {} };
    const key = 'zero-prompt:sub:turn-1';
    const triggerMeta = { requestId: key, receivedAt: '2026-09-25T07:00:00.000Z', turnIdempotencyKey: key };
    const shape = validateTriggerRequest(buildOrchestratorReportTrigger(decision, triggerMeta));
    expect(shape.ok).toBe(true);
    let lost = true;
    const fetchTarget = vi.fn(async (_path: string, init: RequestInit) => {
      const req = JSON.parse(init.body as string) as TriggerRequest;
      const result = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });
      expect(result.ok).toBe(true);
      if (lost) { lost = false; throw new Error('response lost after acceptance'); }
      expect(result.idempotent).toBe(true);
      return { ok: true, status: 200, json: async () => result };
    });
    const work = retryAutomaticDispatchReport(async () => {
      const response = await deliverReportSessionRelay({ decision, triggerMeta, fetchTarget,
        postProjectUpdate: async () => ({ projectSynced: false }) });
      expect(response.status).toBe(200);
    });
    await work;
    expect(fetchTarget).toHaveBeenCalledTimes(2);
    expect(mode === 'live' ? mockSendWorkerInput : mockForkWorker).toHaveBeenCalledTimes(1);
    expect(ds.asyncTriggerResults).toBeUndefined();
    expect(ds.latestAsyncTriggerId).toBe('real-http-request');
    expect(asyncTriggerStore.lookup(SID)).toBeUndefined();
    const turnOpts = mode === 'live' ? mockSendWorkerInput.mock.calls[0][3] : mockForkWorker.mock.calls[0][2];
    expect(turnOpts?.atMostOnce).toBe(true);
    const output = await vi.importActual<typeof import('../src/core/worker-pool.js')>('../src/core/worker-pool.js');
    const sessionReply = vi.fn(async () => 'om_lead_reply');
    output.initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() });
    const turnId = mode === 'live' ? mockSendWorkerInput.mock.calls[0][2] as string : turnOpts.turnId;
    const input = (mode === 'live' ? mockSendWorkerInput : mockForkWorker).mock.calls[0][1];
    expect(input.content).not.toContain('botmux_http_response_mode');
    const completed = await new Promise<boolean>(resolve => {
      output.__testOnly_deliverFinalOutput(ds, { type: 'final_output', turnId, lastUuid: 'lead-final', content: 'consolidated result' }, 'test', 0, resolve);
    });
    expect(completed).toBe(true);
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls[0][1]).toContain('consolidated result');
  });
});
