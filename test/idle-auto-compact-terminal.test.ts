/**
 * Idle auto-compact turn_terminal wiring: a non-completed terminal for our
 * synthetic `auto-compact:idle:*` turn must settle through the REAL worker
 * message handler (the same path as the safe-composer refusal), so the topic
 * is never told a cancelled/failed compact ran.
 *
 * Run: bun run vitest run test/idle-auto-compact-terminal.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';

let tempDir: string;
vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  addReaction: vi.fn(async () => 'reaction_id'),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  },
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{}'),
  buildSessionCard: vi.fn(() => '{}'),
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
  getCliDisplayName: vi.fn(() => 'Claude Code'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_idle_term', larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  getBotClient: vi.fn(),
  getBotBrand: vi.fn(() => undefined),
  getOwnerOpenId: vi.fn(),
  resolveBrandLabel: vi.fn(() => undefined),
  resolveUsageDisplay: vi.fn(() => 'footer'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { get dataDir() { return tempDir; } },
    daemon: { backendType: 'pty', cliId: 'claude-code' },
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

import { initWorkerPool, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';

const TURN_ID = 'auto-compact:idle:mvyldemo';
const sessionReply = vi.fn(async () => 'om_reply');

function fixture() {
  const worker = Object.assign(new EventEmitter(), {
    killed: false, send: vi.fn(), kill: vi.fn(), pid: 99999,
    stdout: new EventEmitter(), stderr: new EventEmitter(),
  });
  const ds = {
    session: {
      sessionId: 'sid-idle-term', rootMessageId: 'om_root', chatId: 'http_idle_term', title: 'fixture',
      status: 'active', createdAt: Date.now(), updatedAt: Date.now(), pid: null,
      chatType: 'group', cliId: 'claude-code',
      idleAutoCompact: {
        enabled: true,
        handledIdleSince: 1000,
        idleSince: 1000,
        inFlight: { turnId: TURN_ID, since: Date.now() - 60_000, idleMinutes: 55, tokens: 200_000 },
      },
    },
    worker, workerPort: 0, workerToken: 'tok', larkAppId: 'app_idle_term', chatId: 'http_idle_term',
    chatType: 'group', spawnedAt: Date.now(), cliVersion: '1',
    lastMessageAt: Date.now(), hasHistory: false,
    idleAutoCompactDispatchedTurnId: TURN_ID,
  } as unknown as DaemonSession;
  __testOnly_setupWorkerHandlers(ds, worker as any);
  const listeners = worker.listeners('message');
  expect(listeners).toHaveLength(1);
  const ipc = async (msg: WorkerToDaemon) => { await listeners[0](msg); };
  const terminal = async (status: 'completed' | 'failed' | 'cancelled' | 'ambiguous', errorCode?: string, composerRefusal?: string) =>
    ipc({
      type: 'turn_terminal', sessionId: ds.session.sessionId, turnId: TURN_ID, status,
      ...(errorCode ? { errorCode } : {}), ...(composerRefusal ? { composerRefusal } : {}),
    });
  const directInput = async () => ipc({ type: 'terminal_input', submitted: true, at: Date.now() });
  return { ds, terminal, directInput, ipc };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'idle-term-'));
  vi.clearAllMocks();
  initWorkerPool({ sessionReply, getSessionWorkingDir: () => tempDir,
    getActiveCount: () => 1, closeSession: vi.fn() } as any);
});
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('idle auto-compact settles on the real turn_terminal handler', () => {
  it('queues "interrupted" and saves when the compact turn is cancelled', async () => {
    const { ds, terminal } = fixture();
    await terminal('cancelled', 'cancelled');
    expect(ds.session.idleAutoCompact?.inFlight).toBeUndefined();
    expect(ds.idleAutoCompactPendingNotice).toEqual({ kind: 'interrupted', idleMinutes: 55 });
    expect(ds.idleAutoCompactDispatchedTurnId).toBeUndefined();
    expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
  });

  it('queues "interrupted" on an ambiguous terminal too', async () => {
    const { ds, terminal } = fixture();
    await terminal('ambiguous', 'cli_exit');
    expect(ds.session.idleAutoCompact?.inFlight).toBeUndefined();
    expect(ds.idleAutoCompactPendingNotice?.kind).toBe('interrupted');
  });

  it('a refused draft settles at once with the reason the worker gave', async () => {
    const { ds, terminal } = fixture();
    await terminal('failed', 'safe_composer_required', 'composer_not_empty');
    expect(ds.session.idleAutoCompact?.inFlight).toBeUndefined();
    expect(ds.session.idleAutoCompact?.handledIdleSince).toBe(1000);
    expect(ds.idleAutoCompactPendingNotice).toEqual({ kind: 'refused', idleMinutes: 55, reason: 'draft', attempts: 1 });
    expect(ds.idleAutoCompactDispatchedTurnId).toBeUndefined();
    expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
  });

  it('an unrecognised input box releases the stretch for another try, saved, with no notice yet', async () => {
    const { ds, terminal } = fixture();
    await terminal('failed', 'safe_composer_required', 'prompt_not_framed');
    expect(ds.session.idleAutoCompact?.inFlight).toBeUndefined();
    expect(ds.session.idleAutoCompact?.handledIdleSince).toBeUndefined();
    expect(ds.session.idleAutoCompact?.retry).toEqual({ stretch: 1000, attempts: 1, reason: 'unconfirmed' });
    expect(ds.idleAutoCompactPendingNotice).toBeUndefined();
    expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
  });

  it('marks only a threshold away-summary refusal for later re-arming', async () => {
    const { ds, ipc } = fixture();
    await ipc({
      type: 'turn_terminal', sessionId: ds.session.sessionId, turnId: 'auto-compact:threshold',
      status: 'failed', errorCode: 'safe_composer_required', composerRefusal: 'away_summary_pending',
    });
    expect(ds.autoCompactAwaySummaryDeferred).toBe(true);
    ds.autoCompactAwaySummaryDeferred = undefined;
    await ipc({
      type: 'turn_terminal', sessionId: ds.session.sessionId, turnId: 'auto-compact:threshold-2',
      status: 'failed', errorCode: 'safe_composer_required', composerRefusal: 'prompt_not_framed',
    });
    expect(ds.autoCompactAwaySummaryDeferred).toBeUndefined();
  });

  it('keeps an idle away-summary refusal on idle retry, never threshold deferral', async () => {
    const { ds, terminal } = fixture();
    await terminal('failed', 'safe_composer_required', 'away_summary_pending');
    expect(ds.session.idleAutoCompact?.retry).toEqual({ stretch: 1000, attempts: 1, reason: 'busy' });
    expect(ds.autoCompactAwaySummaryDeferred).toBeUndefined();
  });

  it('does not set threshold deferral for an idle away-summary refusal whose claim is gone', async () => {
    const { ds, terminal } = fixture();
    // A newer turn / toggle / restart already retired the matching idle claim.
    ds.session.idleAutoCompact!.inFlight = undefined;
    await terminal('failed', 'safe_composer_required', 'away_summary_pending');
    expect(ds.autoCompactAwaySummaryDeferred).toBeUndefined();
  });

  it('a direct Web submit is persisted as user activity, not a local repaint', async () => {
    const { ds, directInput } = fixture();
    ds.session.idleAutoCompact!.retry = { stretch: 1000, attempts: 1, reason: 'unconfirmed' };
    await directInput();
    expect(ds.session.idleAutoCompact?.inFlight?.busyBeforeSettled).toBe(true);
    expect(ds.session.idleAutoCompact?.retry).toBeUndefined();
    expect(ds.session.idleAutoCompact?.handledIdleSince).toBe(1000);
    expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
  });

  it('a reason this daemon does not know reads as unknown, never as a draft', async () => {
    const { ds, terminal } = fixture();
    await terminal('failed', 'safe_composer_required', 'some_future_reason');
    expect(ds.session.idleAutoCompact?.retry?.reason).toBe('unknown');
    expect(ds.idleAutoCompactPendingNotice).toBeUndefined();
  });

  it('does not touch the marker when the compact completed', async () => {
    const { ds, terminal } = fixture();
    await terminal('completed');
    expect(ds.session.idleAutoCompact?.inFlight?.turnId).toBe(TURN_ID);
    expect(ds.idleAutoCompactPendingNotice).toBeUndefined();
  });
});

// 源码结构护栏(K3)：suspendWorker 销毁 CLI 时必须连同闲置压缩的热区间、arm 与持久化镜像一起清，
// 否则无消息冷唤醒会立刻对冷启 CLI 发 /compact（消息不会重发，但会无缓存重读整个
// 上下文）。该路径依赖完整 PTY/tmux 后端，没有可单测的 seam；纯函数行为见
// clearIdleAutoCompactStretch 在 test/idle-auto-compact.test.ts 的用例。
describe('suspend wiring guard', () => {
  it('suspendWorker clears the persisted idle auto-compact stretch', () => {
    const source = readFileSync(join(__dirname, '../src/core/worker-pool.ts'), 'utf8');
    const anchor = 'ds.idleSinceAt = undefined;';
    const at = source.indexOf(anchor);
    expect(at).toBeGreaterThan(0);
    const window = source.slice(at, at + 600);
    expect(window).toContain('clearIdleAutoCompactStretch(ds)');
    expect(window).toContain('ds.idleAutoCompactPendingNotice = undefined');
    expect(window).toContain('ds.idleAutoCompactDispatchedTurnId = undefined');
  });
});
