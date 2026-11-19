import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { emitHookEventMock, policy, asks } = vi.hoisted(() => ({
  emitHookEventMock: vi.fn(), policy: { enabled: true, cliEnabled: true }, asks: [] as any[],
}));
vi.mock('../src/core/ask-broker.js', () => ({ listPendingAsks: () => asks }));

vi.mock('../src/services/hook-runner.js', () => ({
  emitHookEvent: (...args: unknown[]) => emitHookEventMock(...args),
}));

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
  buildTuiPromptCard: vi.fn(() => '{"type":"tui"}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{"type":"tui-resolved"}'),
  getCliDisplayName: vi.fn(() => 'Claude'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'codex', noProgressNotify: policy },
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
    daemon: { backendType: 'tmux', cliId: 'codex', noProgressNotify: policy },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  ensureSessionWhiteboard: vi.fn(),
  persistStreamCardState: vi.fn(),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn(() => ({ tokenUsage: null })),
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


import { __testOnly_setupWorkerHandlers, initWorkerPool } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkflowNodeSessionMarker } from '../src/types.js';
import { createWorkflowNodeDaemon, type WorkflowNodeDaemonDeps } from '../src/core/workflow-node-daemon.js';
import { createWorkflowHandoffBinding, recordWorkflowHandoffBinding, revokeWorkflowHandoff } from '../src/core/workflow-handoff-binding.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * ADV-1 through the real worker IPC seam (design 2026-11-03 §5.5): the worker
 * reports `turn_execution_started` for the handoff turn, then again for a
 * person's message it typed into that running CLI turn (type-ahead with
 * cross-principal isolation off). A stop of the node must still interrupt
 * the CLI — the handoff turn is running — however many turns started since.
 */

const SECRET = 'host-binding-secret';
const NONCE = 'wfh_aaaaaaaaaaaaaaaaaaaaaaaa';
const H = 'om_handoff';

async function world(initialStatus: string | undefined = 'working') {
  // The binding secret lives next to the data dir: keep both in our own dir.
  const dataDir = join(mkdtempSync(join(tmpdir(), 'wp-main-topic-')), 'data');
  mkdirSync(dataDir, { recursive: true });
  await recordWorkflowHandoffBinding(dataDir, SECRET, createWorkflowHandoffBinding(SECRET, {
    nonce: NONCE, publishRoot: 'om_root', targetLarkAppId: 'app_test', targetChatId: 'oc_chat', sourceLarkAppId: 'cli_main',
    workflow: { runId: 'r', nodeId: 'n', attemptId: 'n/attempts/001', revision: 1 }, placement: 'main',
  }));
  const worker = Object.assign(new EventEmitter(), {
    killed: false, send: vi.fn(), kill: vi.fn(), pid: 4242,
    stdout: new EventEmitter(), stderr: new EventEmitter(),
  });
  const marker: WorkflowNodeSessionMarker = {
    runId: 'r', nodeId: 'n', attemptId: 'n/attempts/001', handoffMessageId: H, nonce: NONCE,
    publishRoot: 'om_root', orchestratorAppId: 'cli_main', registeredAt: new Date().toISOString(), placement: 'main',
  };
  const ds = {
    session: { sessionId: 'sid-main-topic', rootMessageId: 'om_root', chatId: 'oc_chat', status: 'active',
      createdAt: new Date().toISOString(), chatType: 'group', cliId: 'claude-code', workingDir: '/repo', workflowNode: marker },
    worker, workerPort: 9999, workerToken: 'tok', larkAppId: 'app_test', chatId: 'oc_chat', chatType: 'group',
    scope: 'thread', spawnedAt: 1, lastMessageAt: 2, hasHistory: true, workingDir: '/repo',
    displayMode: 'hidden', lastScreenContent: '', lastScreenStatus: initialStatus, workerReady: true,
  } as unknown as DaemonSession;
  const interrupted: string[] = [];
  const deps = {
    selfLarkAppId: () => 'app_test', dataDir: () => dataDir, baseDir: () => dataDir,
    sendCard: async () => 'om_x', replyCard: async () => 'om_x', patchCard: async () => {},
    resolveBotInChat: async () => ({ ok: true, openId: 'ou_x' }), targetOpensTopicSessions: async () => 'yes',
    daemonPort: () => undefined, hostSecret: () => 's', bindingSecret: () => SECRET,
    postDaemon: async () => ({ status: 200, body: { ok: true } }), ensureGrant: async () => {},
    loadSessions: () => [], isProcessAlive: () => true, activeSessions: () => [ds], updateSession: () => {},
    getSessionWorkingDir: () => '/repo', findNodeSession: () => undefined,
    interruptTurn: (session: DaemonSession) => { interrupted.push(session.session.sessionId); return true; },
    proveBotSender: async () => true, deliverSelfTurn: async () => ({ sessionId: 'x' }), prepareTurnIdentity: async () => {},
    attachmentsDir: () => dataDir, loadRun: () => undefined, botWorkingDirConfig: () => ({}),
    daemonAppliesNodeWorkingDir: () => true, daemonReadsNodeProjectDir: () => true, drive: () => {}, botName: (id: string) => id, warn: () => {},
    handoffIdentity: { botTools: () => [], checkSelf: async () => ({ status: 'not_required' }) },
  } as unknown as WorkflowNodeDaemonDeps;
  const nodeDaemon = createWorkflowNodeDaemon(deps);
  initWorkerPool({
    sessionReply: vi.fn(async () => 'om_notice'), getSessionWorkingDir: () => '/repo', getActiveCount: () => 1, closeSession: vi.fn(),
    onWorkflowNodeTurnStarted: (session: DaemonSession, context: { turnId: string; startedAt: number }) => nodeDaemon.onTurnStarted(session, context),
    onWorkflowNodeTurnSettled: (session: DaemonSession, context: { turnId?: string; at: number }) => nodeDaemon.onTurnSettled(session, context),
    onWorkflowNodeInputCommitted: (session: DaemonSession, context: { turnId: string; committedAt: number }) => nodeDaemon.onInputCommitted(session, context),
  } as any);
  __testOnly_setupWorkerHandlers(ds, worker as any);
  const started = (turnId: string) => worker.emit('message', { type: 'turn_execution_started', turnId, startedAtMs: Date.now() });
  const screen = (status: string, turnId?: string) =>
    worker.emit('message', { type: 'screen_update', content: 'x', status, ...(turnId ? { turnId } : {}) });
  return { dataDir, ds, nodeDaemon, interrupted, started, screen };
}

describe('a main-topic handoff turn with a person\'s message folded in (worker IPC seam)', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(join(dir, '..'), { recursive: true, force: true }); dir = undefined; });

  it('the stop interrupts the running CLI turn', async () => {
    const w = await world();
    dir = w.dataDir;
    w.started(H);
    expect(w.ds.session.workflowNode).toMatchObject({ handoffStartedAt: expect.any(String) });
    w.started('om_person_merged');
    await revokeWorkflowHandoff(w.dataDir, SECRET, NONCE, 'timeout', Date.now());
    w.nodeDaemon.stopRoute({ nonce: NONCE, sessionId: 'sid-main-topic', reason: 'timeout' });
    expect(w.interrupted).toEqual(['sid-main-topic']);
  });

  it('WP-a: the working → idle edge of the handoff turn settles it', async () => {
    const w = await world();
    dir = w.dataDir;
    w.started(H); w.screen('working', H); w.screen('idle', H);
    expect(w.ds.session.workflowNode).toMatchObject({ handoffSettledAt: expect.any(String) });
  });

  it('WP-c: an idle edge that names no turn (a respawned worker\'s envelope) settles it too — a later wake is not interrupted', async () => {
    const w = await world();
    dir = w.dataDir;
    w.started(H); w.screen('working'); w.screen('idle');
    expect(w.ds.session.workflowNode).toMatchObject({ handoffSettledAt: expect.any(String) });
    w.started('workflow-event:other:1');
    await revokeWorkflowHandoff(w.dataDir, SECRET, NONCE, 'timeout', Date.now());
    w.nodeDaemon.stopRoute({ nonce: NONCE, sessionId: 'sid-main-topic', reason: 'timeout' });
    expect(w.interrupted).toEqual([]);
  });

  it('WP-b: restored after a restart (no idle edge to see, another worker generation) — a later wake is not interrupted', async () => {
    const w = await world(undefined);
    dir = w.dataDir;
    // The persisted marker of the run before the restart: started in an
    // earlier worker generation, its idle never observed.
    w.ds.session.workflowNode = {
      ...w.ds.session.workflowNode!, handoffStartedAt: new Date().toISOString(),
      handoffWorkerGeneration: (w.ds.workerGeneration ?? 0) - 1,
    };
    // No idle edge reaches the daemon for that turn.
    expect(w.ds.session.workflowNode?.handoffSettledAt).toBeUndefined();
    w.started('workflow-event:other:1');
    await revokeWorkflowHandoff(w.dataDir, SECRET, NONCE, 'timeout', Date.now());
    w.nodeDaemon.stopRoute({ nonce: NONCE, sessionId: 'sid-main-topic', reason: 'timeout' });
    expect(w.interrupted).toEqual([]);
  });

  it('before the handoff turn started (only someone else\'s turn running), nothing is interrupted', async () => {
    const w = await world();
    dir = w.dataDir;
    w.started('om_person_ahead');
    await revokeWorkflowHandoff(w.dataDir, SECRET, NONCE, 'timeout', Date.now());
    w.nodeDaemon.stopRoute({ nonce: NONCE, sessionId: 'sid-main-topic', reason: 'timeout' });
    expect(w.interrupted).toEqual([]);
    // It is interrupted the moment it starts.
    w.started(H);
    expect(w.interrupted).toEqual(['sid-main-topic']);
  });
});
