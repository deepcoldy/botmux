/**
 * The main-bot wake through the REAL `triggerSessionTurn` (design 2026-11-03
 * §13.6): Lark, session store, worker pool and session manager are mocked at
 * the same boundary as trigger-session-root-message.test.ts; the trigger
 * itself, the issuer and the issuance ledger are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';

const mockGetMessageChatId = vi.fn();
const mockGetChatMode = vi.fn(async () => 'topic');
const mockSendMessage = vi.fn(async () => 'om_new_topic');
vi.mock('../src/im/lark/client.js', () => ({
  getMessageChatId: (...args: any[]) => mockGetMessageChatId(...args),
  getChatMode: (...args: any[]) => mockGetChatMode(...args),
  sendMessage: (...args: any[]) => mockSendMessage(...args),
  listChatBotMembers: vi.fn(async () => []),
}));

const mockGetBot = vi.fn();
vi.mock('../src/bot-registry.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/bot-registry.js')>();
  return { ...actual,
    getBot: (id: string) => mockGetBot(id) ?? actual.getBot(id),
    effectiveDefaultWorkingDir: vi.fn(() => '/tmp'),
  };
});

const mockIsInChat = vi.fn(async () => true);
vi.mock('../src/services/groups-store.js', () => ({
  isInChat: (...args: any[]) => mockIsInChat(...args),
}));

vi.mock('../src/services/oncall-store.js', () => ({
  getOncallStatus: vi.fn(() => undefined),
}));

const mockCreateSession = vi.fn();
const mockUpdateSession = vi.fn();
const mockCloseSession = vi.fn();
vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  createSession: (...args: any[]) => mockCreateSession(...args),
  updateSession: (...args: any[]) => mockUpdateSession(...args),
  closeSession: (...args: any[]) => mockCloseSession(...args),
}));

vi.mock('../src/services/message-queue.js', () => ({
  ensureQueue: vi.fn(),
}));

const mockForkWorker = vi.fn();
const mockQueuedTailAdmission = vi.fn();
/** Every sendWorkerInput call: (turnId, opts) — what the real worker-pool receives. */
const sentInputs = vi.hoisted(() => ({ calls: [] as Array<{ turnId?: string; opts: any }>, refuse: false }));
const activeKeyLocks = vi.hoisted(() => ({
  byMap: new WeakMap<Map<string, any>, Map<string, Promise<void>>>(),
}));
/** Routing keys the registration gate treats as reserved by a quarantined
 *  session (the real gate consults findQuarantinedRoutingConflict). */
const routeQuarantine = vi.hoisted(() => ({ keys: new Set<string>() }));
vi.mock('../src/core/worker-pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/worker-pool.js')>();
  return {
  forkWorker: (...args: any[]) => mockForkWorker(...args),
  sendWorkerInput: (ds: any, payload: any, turnId?: string, opts: any = {}) => {
    sentInputs.calls.push({ turnId, opts });
    if (sentInputs.refuse) return false;
    if (!ds.worker || ds.worker.killed) return false;
    if (actual.hasQueuedActivationAdmissionGate(ds)) return mockQueuedTailAdmission(ds, payload, turnId, opts);
    ds.worker.send({
      type: 'message',
      content: typeof payload === 'string' ? payload : payload.content,
      ...(typeof payload === 'object' && payload.codexAppInput
        ? { codexAppInput: payload.codexAppInput }
        : {}),
      ...(turnId ? { turnId } : {}),
      ...(opts.dispatchAttempt !== undefined
        ? { dispatchAttempt: opts.dispatchAttempt }
        : {}),
    });
    return true;
  },
  hasQueuedActivationAdmissionGate: actual.hasQueuedActivationAdmissionGate,
  admitQueuedActivationTail: actual.admitQueuedActivationTail,
  getCurrentCliVersion: vi.fn(() => 'test-cli-version'),
  withActiveSessionKeyLock: vi.fn(async (map: Map<string, any>, key: string, action: () => any) => {
    let locks = activeKeyLocks.byMap.get(map);
    if (!locks) {
      locks = new Map();
      activeKeyLocks.byMap.set(map, locks);
    }
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => hold);
    locks.set(key, tail);
    await previous.catch(() => {});
    try { return await action(); }
    finally {
      release();
      if (locks.get(key) === tail) locks.delete(key);
    }
  }),
  setActiveSessionIfActive: (map: Map<string, any>, key: string, ds: any) => {
    if (routeQuarantine.keys.has(key)) return false;
    if (map.has(key) && map.get(key) !== ds) return false;
    map.set(key, ds);
    return true;
  },
  closeSession: vi.fn(async () => ({ ok: true, outcome: 'closed', alreadyClosed: false, known: true })),
  getDaemonBootId: () => 'test-boot-id',
  };
});

const mockRememberLastCliInput = vi.fn();
const mockGetAvailableBots = vi.fn(async () => []);
const mockBuildFollowUpCliInput = vi.fn((prompt: string, _sessionId?: string, opts?: any) => ({
  content: `follow:${prompt}`,
  codexAppInput: opts?.cliId === 'codex-app' && opts?.codexAppText ? { text: opts.codexAppText } : undefined,
}));
const mockBuildNewTopicCliInput = vi.fn((prompt: string, ...args: any[]) => ({
  content: `new:${prompt}`,
  codexAppInput: args[1] === 'codex-app' && args[10]?.codexAppText ? { text: args[10].codexAppText } : undefined,
}));
vi.mock('../src/core/session-manager.js', () => ({
  buildFollowUpContent: vi.fn((prompt: string) => `follow:${prompt}`),
  buildFollowUpCliInput: (...args: any[]) => mockBuildFollowUpCliInput(...args),
  buildNewTopicPrompt: vi.fn((prompt: string) => `new:${prompt}`),
  buildNewTopicCliInput: (...args: any[]) => mockBuildNewTopicCliInput(...args),
  ensureSessionWhiteboard: vi.fn(),
  getAvailableBots: (...args: any[]) => mockGetAvailableBots(...args),
  rememberLastCliInput: (...args: any[]) => mockRememberLastCliInput(...args),
}));

const mockBotAutoWorktreeEnabled = vi.fn(() => false);
vi.mock('../src/services/default-worktree.js', () => ({
  botAutoWorktreeEnabled: (...args: any[]) => mockBotAutoWorktreeEnabled(...args),
}));

const mockRunAutoWorktreeCommit = vi.fn(async () => {});
vi.mock('../src/im/lark/card-handler.js', () => ({
  runAutoWorktreeCommit: (...args: any[]) => mockRunAutoWorktreeCommit(...args),
}));
import { triggerSessionTurn } from '../src/core/trigger-session.js';
import { __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { sessionKey } from '../src/core/types.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflowMainWake, workflowMainWakeSessionState } from '../src/core/workflow-main-wake.js';
import { readV3MainWakeIssued } from '../src/workflows/v3/main-wake-ledger.js';
import { validateDag } from '../src/workflows/v3/dag.js';
import { appendEvent } from '../src/workflows/v3/journal.js';

const APP = 'app1';
const CHAT = 'oc_root_chat';
const ROOT = 'om_root_msg';
const RUN = 'wake-trig-run';
const BINDING = { larkAppId: APP, chatId: CHAT, rootMessageId: ROOT, ownerOpenId: 'ou_initiator' };

function mainDs(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    session: { sessionId: 'sess_main', chatId: CHAT, rootMessageId: ROOT, scope: 'thread', status: 'active', createdAt: '2026-06-01T00:00:00.000Z', quoteTargetId: 'om_member_running' },
    worker: null, workerPort: null, workerToken: null, larkAppId: APP, chatId: CHAT, chatType: 'group', scope: 'thread',
    spawnedAt: 1, cliVersion: 'test-cli-version', lastMessageAt: 1, hasHistory: true, ...overrides,
  } as DaemonSession;
}

let base: string;
function seed(): string {
  const runDir = join(base, RUN);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'dag.json'), JSON.stringify({ schemaVersion: 2, runId: RUN, nodes: [{ id: 'a', type: 'goal', goal: 'a', bot: 'cli_w', depends: [], inputs: [] }] }));
  const j = join(runDir, 'journal.ndjson');
  appendEvent(j, { type: 'runStarted', runId: RUN, nodeExecutor: 'bot' });
  appendEvent(j, { type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/001', nodeExecutor: 'bot' });
  appendEvent(j, { type: 'nodeBlocked', nodeId: 'a', attemptId: 'a/attempts/001', errorClass: 'workerError', errorCode: 'BOT_REPORTED_BLOCKED', message: 'x' });
  return runDir;
}

/** The issuer wired the way daemon.ts wires it, over this test's sessions. */
function issuerOver(activeSessions: Map<string, DaemonSession>, clock = { t: 1_000_000 }) {
  const timers: Array<() => void> = [];
  const warnings: string[] = [];
  const wake = createWorkflowMainWake({
    baseDir: () => base,
    selfLarkAppId: () => APP,
    loadRun: (dir) => ({ dag: validateDag(JSON.parse(readFileSync(join(dir, 'dag.json'), 'utf-8'))) }),
    readBinding: () => BINDING,
    mainSessionAt: (b) => {
      const ds = b.rootMessageId ? activeSessions.get(sessionKey(b.rootMessageId, b.larkAppId)) : undefined;
      return ds && ds.session.status === 'active' ? { sessionId: ds.session.sessionId } : undefined;
    },
    sessionView: (sessionId) => {
      const ds = [...activeSessions.values()].find((s) => s.session.sessionId === sessionId);
      if (!ds) return undefined;
      return {
        sessionId,
        ...(ds.session.rootMessageId ? { rootMessageId: ds.session.rootMessageId } : {}),
        ...(ds.session.quoteTargetId ? { quoteTargetId: ds.session.quoteTargetId } : {}),
        ...(ds.initialStartPending ? { opening: true } : {}),
      };
    },
    sessionState: (sessionId) => workflowMainWakeSessionState(
      [...activeSessions.values()].find((s) => s.session.sessionId === sessionId),
      { sessionsRestored: true },
    ),
    deliver: (request, internal) => triggerSessionTurn(request, { larkAppId: APP, activeSessions }, internal),
    drive: () => {},
    listRunIds: () => [RUN],
    now: () => clock.t,
    warn: (m) => warnings.push(m),
    retryMs: 1_000,
    setTimer: (fn) => { timers.push(fn); return {}; },
  });
  const tick = async () => {
    for (const fn of timers.splice(0)) fn();
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  return { wake, warnings, tick };
}

describe('main-bot wake through the real trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sentInputs.calls = [];
    sentInputs.refuse = false;
    __testOnly_resetBotRegistry();
    base = mkdtempSync(join(tmpdir(), 'wake-trig-'));
    mockGetChatMode.mockReset().mockResolvedValue('topic');
    mockBotAutoWorktreeEnabled.mockReturnValue(false);
    mockGetBot.mockReturnValue({ config: { larkAppId: APP, cliId: 'claude-code', workingDir: '/tmp' }, botName: 'Bot', botOpenId: 'ou_bot' });
    mockGetMessageChatId.mockResolvedValue(CHAT);
    mockCreateSession.mockImplementation((chatId: string, rootMessageId: string, title: string, chatType: 'group' | 'p2p') => ({
      sessionId: 'sess_new', chatId, rootMessageId, title, chatType, status: 'active', createdAt: '2026-06-01T00:00:00.000Z',
    }));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('a main session mid-turn is not typed into: nothing reaches the worker until it is idle, then the wake is its own queued turn', async () => {
    const runDir = seed();
    const send = vi.fn();
    const ds = mainDs({ worker: { killed: false, send } as any, cliReady: true, lastScreenStatus: 'working' } as any);
    const active = new Map([[sessionKey(ROOT, APP), ds]]);
    const { wake } = issuerOver(active);
    await wake.scan(RUN);
    expect(send).not.toHaveBeenCalled();
    expect(sentInputs.calls).toEqual([]);
    expect(readV3MainWakeIssued(runDir, 3)).toBeUndefined();
    // The running turn ends.
    (ds as any).lastScreenStatus = 'idle';
    wake.onScreenStatus('sess_main', { status: 'idle', prevStatus: 'working', turnId: 'om_member_running' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).toHaveBeenCalledTimes(1);
    expect(sentInputs.calls).toEqual([{ turnId: 'workflow-event:wake-trig-run:3', opts: expect.objectContaining({ queueAfterActiveTurn: true }) }]);
    expect(readV3MainWakeIssued(runDir, 3)).toMatchObject({ sessionId: 'sess_main', turnPointersAtIssue: { quoteTargetId: 'om_member_running' } });
  });

  it('no live session: a new session in the main topic, its first turn the wake', async () => {
    const runDir = seed();
    const active = new Map<string, DaemonSession>();
    await issuerOver(active).wake.scan(RUN);
    expect(readV3MainWakeIssued(runDir, 3)).toMatchObject({ sessionId: 'sess_new', rootMessageId: ROOT });
    expect(mockForkWorker).toHaveBeenCalledTimes(1);
  });

  it('the worker refuses the input before accepting it: the record is taken back and the wake is retried', async () => {
    const runDir = seed();
    const send = vi.fn();
    const ds = mainDs({ worker: { killed: false, send } as any, cliReady: true, lastScreenStatus: 'idle' } as any);
    const active = new Map([[sessionKey(ROOT, APP), ds]]);
    const clock = { t: 1_000_000 };
    const { wake, tick, warnings } = issuerOver(active, clock);
    sentInputs.refuse = true;
    await wake.scan(RUN);
    expect(sentInputs.calls).toHaveLength(1);
    expect(readV3MainWakeIssued(runDir, 3)).toBeUndefined();
    expect(warnings.join('\n')).toContain('retry 1/');
    sentInputs.refuse = false;
    clock.t += 1_000;
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(readV3MainWakeIssued(runDir, 3)).toBeDefined();
  });
});
