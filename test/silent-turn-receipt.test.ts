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
import { buildStreamingCard } from '../src/im/lark/card-builder.js';
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
    sessionReplyMock.mockResolvedValue('om_receipt' as any);
    (buildStreamingCard as any).mockClear();
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
    const firstOpts = sessionReplyMock.mock.calls[0]?.[5] as { uuid?: string } | undefined;
    expect(firstOpts?.uuid).toMatch(/^sr_[0-9a-f]+$/);
    expect(firstOpts?.uuid?.length).toBeLessThanOrEqual(50);
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

  it('A→B→A dispatchAttempt replay: interleaved turns do not defeat the dedupe', async () => {
    const ds = makeDs();
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    recordTurnExplicitMention(ds, 'om_turn_A', true);
    (ds.worker as any).emit('message', terminalMsg('om_turn_A', { outputDisposition: 'nothing_to_send', dispatchAttempt: 1 }));
    await vi.waitFor(() => expect(sessionReplyMock).toHaveBeenCalledTimes(1));

    // An unrelated @'d silent turn lands in between — a single-slot dedupe
    // would be overwritten here and let A's replay re-post.
    recordTurnExplicitMention(ds, 'om_turn_B', true);
    (ds.worker as any).emit('message', terminalMsg('om_turn_B', { outputDisposition: 'nothing_to_send' }));
    await vi.waitFor(() => expect(sessionReplyMock).toHaveBeenCalledTimes(2));

    recordTurnExplicitMention(ds, 'om_turn_A', true);
    (ds.worker as any).emit('message', terminalMsg('om_turn_A', { outputDisposition: 'nothing_to_send', dispatchAttempt: 2 }));
    await new Promise(r => setTimeout(r, 20));
    expect(sessionReplyMock).toHaveBeenCalledTimes(2);
  });

  it('a long queue of un-@\'d turns never evicts an in-flight @\'d turn', async () => {
    const ds = makeDs();
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    // The @'d turn is dispatched FIRST and is still running while 50 plain
    // (type-ahead / queued) messages are admitted behind it.
    recordTurnExplicitMention(ds, 'om_turn_first_at', true);
    for (let i = 0; i < 50; i++) recordTurnExplicitMention(ds, `om_turn_plain_${i}`, false);

    (ds.worker as any).emit('message', terminalMsg('om_turn_first_at', { outputDisposition: 'nothing_to_send' }));
    await vi.waitFor(() => expect(sessionReplyMock).toHaveBeenCalledTimes(1));
  });

  it('re-dispatch without an @ clears a stale mention record', () => {
    const ds = makeDs();
    recordTurnExplicitMention(ds, 'om_turn_x', true);
    recordTurnExplicitMention(ds, 'om_turn_x', false);
    expect(ds.turnExplicitMentions?.has('om_turn_x')).toBe(false);
  });

  it('vcMeetingReceiver session: no flag and no receipt even when @\'d', async () => {
    const ds = makeDs();
    (ds.session as any).vcMeetingReceiver = true;
    recordTurnExplicitMention(ds, 'om_turn_vc', true);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('om_turn_vc', { outputDisposition: 'nothing_to_send' }));

    await new Promise(r => setTimeout(r, 20));
    expect(ds.silentIdleTurnId).toBeUndefined();
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });

  it('failed receipt send releases the claim so a replay compensates', async () => {
    const ds = makeDs();
    recordTurnExplicitMention(ds, 'om_turn_retry', true);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    sessionReplyMock.mockRejectedValueOnce(new Error('lark 500') as any);
    (ds.worker as any).emit('message', terminalMsg('om_turn_retry', { outputDisposition: 'nothing_to_send', dispatchAttempt: 1 }));
    await vi.waitFor(() => expect(ds.silentReceiptTurnIds?.has('om_turn_retry')).toBe(false));

    (ds.worker as any).emit('message', terminalMsg('om_turn_retry', { outputDisposition: 'nothing_to_send', dispatchAttempt: 2 }));
    await vi.waitFor(() => expect(sessionReplyMock).toHaveBeenCalledTimes(2));
    // A timeout can be commit-unknown: the first request may have reached Lark
    // even though the client rejected. Both attempts must therefore carry the
    // SAME provider UUID so Lark collapses them into one visible message.
    const firstUuid = (sessionReplyMock.mock.calls[0]?.[5] as { uuid?: string } | undefined)?.uuid;
    const retryUuid = (sessionReplyMock.mock.calls[1]?.[5] as { uuid?: string } | undefined)?.uuid;
    expect(firstUuid).toBeTruthy();
    expect(retryUuid).toBe(firstUuid);
    // ...and the compensating post is itself deduped against a third replay.
    (ds.worker as any).emit('message', terminalMsg('om_turn_retry', { outputDisposition: 'nothing_to_send', dispatchAttempt: 3 }));
    await new Promise(r => setTimeout(r, 20));
    expect(sessionReplyMock).toHaveBeenCalledTimes(2);
  });

  it('terminal arriving AFTER the card settled to idle re-patches it with the silent label', async () => {
    const ds = makeDs();
    ds.workerReady = true;
    ds.streamCardId = 'om_card';
    ds.lastScreenStatus = 'idle';
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('om_turn_late', { outputDisposition: 'nothing_to_send' }));

    await vi.waitFor(() => {
      const calls = (buildStreamingCard as any).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      // silentIdle is the last positional arg of buildStreamingCard.
      expect(calls[calls.length - 1][19]).toBe(true);
    });
  });

  it('stale terminal from a PREVIOUS turn: no relabel, but the receipt is still owed', async () => {
    const ds = makeDs();
    ds.workerReady = true;
    ds.streamCardId = 'om_card';
    ds.lastScreenStatus = 'idle';
    recordTurnExplicitMention(ds, 'om_turn_old', true);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    // Type-ahead: a follow-up turn was admitted while om_turn_old still ran.
    ds.currentTurnId = 'om_turn_new';
    (ds.worker as any).emit('message', terminalMsg('om_turn_old', { outputDisposition: 'nothing_to_send' }));

    await vi.waitFor(() => expect(sessionReplyMock).toHaveBeenCalledTimes(1));
    expect(ds.silentIdleTurnId).toBeUndefined();
  });

  it('current-turn terminal still relabels when lineage is known', async () => {
    const ds = makeDs();
    ds.currentTurnId = 'om_turn_live';
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('om_turn_live', { outputDisposition: 'nothing_to_send' }));

    await vi.waitFor(() => expect(ds.silentIdleTurnId).toBe('om_turn_live'));
  });

  it('durably-suppressed replay attempt posts no receipt (same gate as other aux UI)', async () => {
    const ds = makeDs();
    ds.suppressedFinalOutputTurns = new Map([['om_turn_sup', 1]]);
    recordTurnExplicitMention(ds, 'om_turn_sup', true);
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);

    (ds.worker as any).emit('message', terminalMsg('om_turn_sup', {
      outputDisposition: 'nothing_to_send', dispatchAttempt: 1,
    }));

    await new Promise(r => setTimeout(r, 20));
    expect(sessionReplyMock).not.toHaveBeenCalled();
    // The guard covers the RECEIPT only — the label still follows the ordinary
    // rule, so a suppressed turn is not mislabelled 「等待输入」. Pinning this
    // boundary here stops the guard from being moved onto the label later.
    expect(ds.silentIdleTurnId).toBe('om_turn_sup');
    // ...and the suppressed attempt must NOT have eaten the origin record.
    expect(ds.turnExplicitMentions?.has('om_turn_sup')).toBe(true);

    // An attempt above the watermark closes the loop — exactly once.
    (ds.worker as any).emit('message', terminalMsg('om_turn_sup', {
      outputDisposition: 'nothing_to_send', dispatchAttempt: 2,
    }));
    await vi.waitFor(() => expect(sessionReplyMock).toHaveBeenCalledTimes(1));
    await new Promise(r => setTimeout(r, 20));
    expect(sessionReplyMock).toHaveBeenCalledTimes(1);
  });

  it('recordTurnExplicitMention keeps a bounded FIFO of positives', () => {
    const ds = makeDs();
    for (let i = 0; i < 200; i++) recordTurnExplicitMention(ds, `om_turn_${i}`, true);
    expect(ds.turnExplicitMentions!.size).toBeLessThanOrEqual(64);
    // Newest entries survive; oldest were evicted.
    expect(ds.turnExplicitMentions!.has('om_turn_199')).toBe(true);
    expect(ds.turnExplicitMentions!.has('om_turn_0')).toBe(false);
  });
});

/**
 * Every live-card rebuild must carry the silent-idle flag, or an unrelated
 * patch (display-mode toggle, frozen-card migration, runtime badge) silently
 * reverts 「已处理 · 判定无需回复」 back to 「等待输入」 — the exact regression
 * this feature exists to prevent. Enforced structurally because the flag is a
 * positional argument that is trivially forgotten at a NEW call site: a
 * behavioral test only covers the paths someone remembered to write.
 */
describe('buildStreamingCard call sites all pass silentIdleCardFlag', () => {
  const files = [
    'src/core/worker-pool.ts',
    'src/daemon.ts',
    'src/im/lark/card-handler.ts',
  ];

  /** Slice the full argument list of each `buildStreamingCard(` call. */
  function callArgs(src: string): { line: number; args: string }[] {
    const out: { line: number; args: string }[] = [];
    const needle = 'buildStreamingCard(';
    for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) {
      // Skip the import/export/definition mentions — only real invocations.
      const before = src.slice(Math.max(0, i - 20), i);
      if (/(function|import|export)\s*[{\s]*$/.test(before)) continue;
      let depth = 0;
      let j = i + needle.length - 1;
      for (; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')' && --depth === 0) break;
      }
      out.push({ line: src.slice(0, i).split('\n').length, args: src.slice(i, j) });
    }
    return out;
  }

  for (const file of files) {
    it(`${file}`, async () => {
      const { readFileSync } = await import('node:fs');
      const calls = callArgs(readFileSync(file, 'utf8'));
      expect(calls.length).toBeGreaterThan(0);
      const missing = calls
        .filter(c => !/(?:silentIdleCardFlag\(|\.silentIdle\b)/.test(c.args))
        .map(c => `${file}:${c.line}`);
      expect(missing).toEqual([]);
    });
  }

  /**
   * Same structural argument for `dshRuntime`, the trailing positional that
   * decides whether a `dsh` bot's card keeps the 🗜️ compact button: bare `'dsh'`
   * is the headless JSON-RPC runner (raw `/compact` is dropped as non-frame
   * input), while `dshRuntime: 'tui'` is the PTY-driven dsh-tui — a real
   * interactive TUI that accepts it. Forgetting the argument is FAIL-CLOSED (the
   * button hides, matching the pre-existing behaviour for dsh), so a miss is not
   * a broken button — but it does silently drop the affordance on a CLI that
   * supports it, which no behavioural test at another call site would catch.
   */
  for (const file of files) {
    it(`${file} — passes dshRuntime`, async () => {
      const { readFileSync } = await import('node:fs');
      const calls = callArgs(readFileSync(file, 'utf8'));
      expect(calls.length).toBeGreaterThan(0);
      const missing = calls
        .filter(c => !/dshRuntime/.test(c.args))
        .map(c => `${file}:${c.line}`);
      expect(missing).toEqual([]);
    });
  }
});
