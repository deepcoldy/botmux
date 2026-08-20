/**
 * Behavioral coverage for deliberate-silence closure (「派活必须回报最终状态」):
 *
 * A turn the model closed with a bare BOTMUX_NOTHING_TO_SEND sentinel reaches
 * the daemon as `turn_terminal` + `outputDisposition: 'nothing_to_send'`. The
 * daemon must
 *   ① mark the session (ds.silentIdleTurnId) so idle-card rebuilds render
 *     「已处理 · 判定无需回复」 instead of a hung-looking 「等待输入」, and
 *   ② when the triggering Lark message explicitly @-mentioned this bot (a
 *     dispatched task), post ONE auto receipt into the thread — silence is a
 *     final status that must be reported, and must never be double-posted on
 *     dispatchAttempt replays.
 *
 * These drive the real worker-pool IPC handler via __testOnly_setupWorkerHandlers
 * + a fake worker (mirrors async-terminal-settle.test.ts) so the guards are
 * exercised, not just pinned in source.
 *
 * Run:  pnpm vitest run test/silent-turn-receipt.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
  getCliDisplayName: vi.fn(() => 'Codex'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'codex' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  getBotClient: vi.fn(),
  getBotBrand: vi.fn(() => undefined),
  resolveBrandLabel: vi.fn(() => undefined),
  resolveUsageDisplay: vi.fn(() => 'footer'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
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

import {
  initWorkerPool,
  __testOnly_setupWorkerHandlers,
  recordTurnExplicitMention,
} from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';
import { EventEmitter } from 'node:events';

function makeDs(): DaemonSession {
  const fakeWorker = new EventEmitter() as any;
  fakeWorker.killed = false;
  fakeWorker.send = vi.fn();
  fakeWorker.kill = vi.fn();
  fakeWorker.pid = 99999;
  fakeWorker.stdout = new EventEmitter();
  fakeWorker.stderr = new EventEmitter();
  const ds: DaemonSession = {
    session: {
      sessionId: 'sid-silent-receipt',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'fixture',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
      cliId: 'codex',
    },
    worker: fakeWorker,
    workerPort: 0,
    workerToken: 'tok',
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1',
    lastMessageAt: Date.now(),
    hasHistory: false,
  } as any;
  return ds;
}

function terminalMsg(
  turnId: string,
  extra: Partial<Extract<WorkerToDaemon, { type: 'turn_terminal' }>> = {},
): Extract<WorkerToDaemon, { type: 'turn_terminal' }> {
  return {
    type: 'turn_terminal',
    sessionId: 'sid-silent-receipt',
    turnId,
    status: 'completed',
    ...extra,
  };
}

const sessionReplyMock = vi.fn(async () => 'om_receipt');

describe('deliberate-silence closure (turn_terminal nothing_to_send)', () => {
  beforeEach(() => {
    sessionReplyMock.mockClear();
    initWorkerPool({
      sessionReply: sessionReplyMock,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    } as any);
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('explicitly-@\'d silent turn: marks silentIdleTurnId and posts ONE receipt', async () => {
    const ds = makeDs();
    recordTurnExplicitMention(ds, 'om_turn_at', true);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('om_turn_at', { outputDisposition: 'nothing_to_send' }));

    await vi.waitFor(() => {
      expect(ds.silentIdleTurnId).toBe('om_turn_at');
      expect(sessionReplyMock).toHaveBeenCalledTimes(1);
    });
    const [anchorId, content] = sessionReplyMock.mock.calls[0] as any[];
    expect(anchorId).toBe('om_root');
    expect(String(content)).toContain('自动回执');
    // The receipt must never carry an @ (it must not re-trigger any bot).
    expect(String(content)).not.toContain('<at');
    // The per-turn mention record is consumed.
    expect(ds.turnExplicitMentions?.has('om_turn_at')).toBe(false);
  });

  it('silent turn WITHOUT explicit @: marks the card flag but posts no receipt', async () => {
    const ds = makeDs();
    recordTurnExplicitMention(ds, 'om_turn_plain', false);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('om_turn_plain', { outputDisposition: 'nothing_to_send' }));

    await vi.waitFor(() => expect(ds.silentIdleTurnId).toBe('om_turn_plain'));
    await new Promise(r => setTimeout(r, 20));
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });

  it('turn with no origin record at all (non-Lark turn): flag only, no receipt', async () => {
    const ds = makeDs();
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('trigger-xyz', { outputDisposition: 'nothing_to_send' }));

    await vi.waitFor(() => expect(ds.silentIdleTurnId).toBe('trigger-xyz'));
    await new Promise(r => setTimeout(r, 20));
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });

  it('dispatchAttempt replay of the same turn does not double-post the receipt', async () => {
    const ds = makeDs();
    recordTurnExplicitMention(ds, 'om_turn_replay', true);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('om_turn_replay', { outputDisposition: 'nothing_to_send', dispatchAttempt: 1 }));
    await vi.waitFor(() => expect(sessionReplyMock).toHaveBeenCalledTimes(1));

    // Replay: re-record (a re-dispatch would re-run the daemon record step) and
    // emit a second terminal for the same logical turn.
    recordTurnExplicitMention(ds, 'om_turn_replay', true);
    (ds.worker as any).emit('message', terminalMsg('om_turn_replay', { outputDisposition: 'nothing_to_send', dispatchAttempt: 2 }));
    await new Promise(r => setTimeout(r, 20));
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
  });

  it('failed terminal never triggers the silent closure even if flagged', async () => {
    const ds = makeDs();
    recordTurnExplicitMention(ds, 'om_turn_failed', true);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('om_turn_failed', {
      status: 'failed', errorCode: 'boom', outputDisposition: 'nothing_to_send',
    }));

    await new Promise(r => setTimeout(r, 20));
    expect(ds.silentIdleTurnId).toBeUndefined();
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });

  it('bare completed terminal (no disposition) never triggers the silent closure', async () => {
    const ds = makeDs();
    recordTurnExplicitMention(ds, 'om_turn_bare', true);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('om_turn_bare'));

    await new Promise(r => setTimeout(r, 20));
    expect(ds.silentIdleTurnId).toBeUndefined();
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });

  it('recordTurnExplicitMention keeps a bounded FIFO', () => {
    const ds = makeDs();
    for (let i = 0; i < 20; i++) recordTurnExplicitMention(ds, `om_turn_${i}`, i % 2 === 0);
    expect(ds.turnExplicitMentions!.size).toBeLessThanOrEqual(8);
    // Newest entries survive; oldest were evicted.
    expect(ds.turnExplicitMentions!.has('om_turn_19')).toBe(true);
    expect(ds.turnExplicitMentions!.has('om_turn_0')).toBe(false);
  });
});
