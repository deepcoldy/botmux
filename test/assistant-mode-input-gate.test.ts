/**
 * Assistant mode, live worker: input to a session that is not owned by the
 * chat's current owner (a pre-mode session whose retirement was refused, an
 * owner change) is refused with a resend notice and never reaches the worker.
 *
 * Run:  npx vitest run --project unit test/assistant-mode-input-gate.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const admission = vi.hoisted(() => ({ decision: { kind: 'allow' } as any }));
vi.mock('../src/core/assistant-spawn.js', () => ({
  decideAssistantAdmission: () => admission.decision,
  decideAssistantLiveInputAdmission: () => admission.decision,
}));

// ─── Mocks (mirror crash-loop-diagnostic.test.ts harness) ────────────────
vi.mock('../src/im/lark/client.js', () => {
  class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  }
  return {
    updateMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    MessageWithdrawnError,
  };
});

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{"type":"streaming"}'),
  buildSessionCard: vi.fn(() => '{"type":"session"}'),
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
  getCliDisplayName: vi.fn(() => 'Claude'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'tmux', cliId: 'claude-code' },
  },
}));

const updateSessionMock = vi.fn();
const sessionReplyMock = vi.fn(async () => 'om_reply');
vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: (...args: any[]) => updateSessionMock(...args),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  persistStreamCardState: vi.fn(),
  ensureSessionWhiteboard: vi.fn(),
  rememberLastCliInput: vi.fn(),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn(),
}));

vi.mock('../src/skills/installer.js', () => ({
  ensureSkills: vi.fn(),
}));

vi.mock('../src/adapters/cli/registry.js', () => ({
  createCliAdapterSync: vi.fn(),
}));

vi.mock('../src/adapters/cli/claude-code.js', () => ({
  claudeJsonlPathForSession: vi.fn(),
}));

vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: class {},
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));



import { initWorkerPool, sendWorkerInput } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import { getBot } from '../src/bot-registry.js';

const sessionReply = vi.fn(async () => 'om_reply');

function liveSession(): { ds: DaemonSession; worker: any } {
  const worker = new EventEmitter() as any;
  worker.killed = false; worker.send = vi.fn(); worker.kill = vi.fn(); worker.pid = 4242;
  const ds = {
    session: { sessionId: 'sid-assistant-gate', rootMessageId: 'om_root', chatId: 'oc_chat', title: 't', status: 'active', createdAt: Date.now(), chatType: 'p2p' },
    worker, workerPort: null, workerToken: null, larkAppId: 'app_test', chatId: 'oc_chat', chatType: 'p2p',
    spawnedAt: Date.now(), cliVersion: '1.0', lastMessageAt: Date.now(), hasHistory: true,
    displayMode: 'hidden', lastScreenContent: '', lastScreenStatus: 'idle',
  } as unknown as DaemonSession;
  return { ds, worker };
}

describe('assistant-mode input gate on a live worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() } as any);
  });

  it('refuses input to a session the current owner does not own and tells the user to resend', () => {
    vi.mocked(getBot).mockReturnValue({ config: { larkAppId: 'app_test', larkAppSecret: 's', cliId: 'claude-code', assistantMode: true }, resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'B' } as any);
    admission.decision = { kind: 'reject', expected: 'ou_owner' };
    const { ds, worker } = liveSession();
    expect(sendWorkerInput(ds, 'hello', 'om_turn_1')).toBe(false);
    expect(worker.send.mock.calls.some((c: any[]) => c[0]?.type === 'message')).toBe(false);
    expect(sessionReply).toHaveBeenCalledWith('om_root', expect.stringContaining('⚠️'), 'text', 'app_test', 'om_turn_1');
  });

  it('owned sessions and bots without assistant mode are untouched', () => {
    vi.mocked(getBot).mockReturnValue({ config: { larkAppId: 'app_test', larkAppSecret: 's', cliId: 'claude-code', assistantMode: true }, resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'B' } as any);
    admission.decision = { kind: 'allow' };
    const owned = liveSession();
    expect(sendWorkerInput(owned.ds, 'hello', 'om_turn_2')).toBe(true);
    vi.mocked(getBot).mockReturnValue({ config: { larkAppId: 'app_test', larkAppSecret: 's', cliId: 'claude-code' }, resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'B' } as any);
    admission.decision = { kind: 'reject' };
    const plain = liveSession();
    expect(sendWorkerInput(plain.ds, 'hello', 'om_turn_3')).toBe(true);
    expect(sessionReply).not.toHaveBeenCalled();
  });
});
