import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import {
  BLIND_TURN_MIN_BUSY_MS,
  BridgeBlindTurnWatch,
  blindTurnNeedsNotice,
} from '../src/services/claude-bridge-blind-turn.js';

const OLD = '/claude/projects/-w/6b50f4a4-3392-43df-837b-02261f498b43.jsonl';
const NEW = '/claude/projects/-w/76cd870a-7bd4-46e7-b191-34290ff42dc2.jsonl';
const LONG = BLIND_TURN_MIN_BUSY_MS + 1;

describe('worker 压缩事件与漏读通知', () => {
  afterEach(() => vi.useRealTimers());
  it.each(['web', 'written', 'pending'])('维护期间出现 %s 输入时仍报告真实漏读', (input) => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    const watch = new BridgeBlindTurnWatch();
    const send = vi.fn();
    const pending: Array<{ started: boolean; isLocal: boolean; turnId: string }> = [];
    const scope = {
      lastInitConfig: { cliId: 'claude-code', adoptMode: false },
      bridgeBlindTurnWatch: watch,
      bridgeQueue: { peek: () => pending },
      bridgeJsonlPath: OLD,
      bridgeReadPosition: () => ({ path: OLD, offset: 100 }),
      bridgeIngest: vi.fn(), relocateUnreadClaudeTranscript: () => false,
      zeroPromptTerminalSync: () => true, readSendMarkers: () => [],
      webTerminalInputGeneration: 0, lastWebTerminalInputAtMs: 0,
      lastWrittenCliInput: undefined as unknown,
      blindTurnNeedsNotice, cliName: () => 'Claude', log: vi.fn(), t: (key: string) => key, send,
    };
    const signal = loadWorkerFunction<(at: number) => void>('handleClaudeCompactionSignal', scope);
    const judge = loadWorkerFunction<() => void>('judgeClaudeBridgeTurn', scope);
    signal(100);
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 101);
    if (input === 'web') scope.webTerminalInputGeneration++;
    else if (input === 'written') scope.lastWrittenCliInput = {};
    else pending.push({ started: false, isLocal: false, turnId: 'new-input' });
    // 重复开始信号不能重置输入快照，导致吞掉此前已送入的输入。
    signal(100);
    vi.advanceTimersByTime(LONG + 1);
    judge();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'user_notify' }));
  });
  it('维护开始先于 JSONL 落盘时不通知；下一轮真实漏读仍触发通知', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const watch = new BridgeBlindTurnWatch();
    const send = vi.fn();
    const scope = {
      lastInitConfig: { cliId: 'claude-code', adoptMode: false },
      bridgeBlindTurnWatch: watch,
      bridgeQueue: { peek: () => [] },
      bridgeJsonlPath: OLD,
      bridgeReadPosition: () => ({ path: OLD, offset: 100 }),
      bridgeIngest: vi.fn(),
      relocateUnreadClaudeTranscript: () => false,
      zeroPromptTerminalSync: () => true,
      readSendMarkers: () => [],
      blindTurnNeedsNotice,
      cliName: () => 'Claude',
      log: vi.fn(),
      t: (key: string) => key,
      send,
    };
    const signal = loadWorkerFunction<(startedAtMs: number) => void>('handleClaudeCompactionSignal', scope);
    const judge = loadWorkerFunction<() => void>('judgeClaudeBridgeTurn', scope);
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 0);
    signal(0);
    vi.advanceTimersByTime(65_000);
    judge();
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(31_000);
    watch.noteCompactionFinished();
    watch.noteTurnStarted({ path: OLD, offset: 100 }, Date.now());
    vi.advanceTimersByTime(LONG);
    judge();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'user_notify' }));
  });
});

describe('BridgeBlindTurnWatch', () => {
  it('hook 前已有排队输入但尚未 busy，也不能豁免下一轮漏读', () => {
    const watch = new BridgeBlindTurnWatch();
    watch.noteCompactionStarted(true, 100);
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 200);
    expect(watch.noteTurnEnded({ path: OLD, offset: 100 }, 200 + LONG).kind).toBe('blind');
  });
  it('维护期间才到达的新输入也必须重新判断，不能被之前的空 queue 豁免', () => {
    for (const completed of [false, true]) {
      const watch = new BridgeBlindTurnWatch();
      watch.noteCompactionStarted(false, 100);
      watch.noteTurnStarted({ path: OLD, offset: 100 }, 101);
      if (completed) watch.noteCompactionFinished();
      expect(watch.noteTurnEnded({ path: OLD, offset: 100 }, 101 + LONG, true).kind).toBe('blind');
    }
  });

  it('迟到的维护开始不能清除正在运行的本地模型轮次', () => {
    const watch = new BridgeBlindTurnWatch();
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 1_000);
    watch.noteCompactionStarted(false, 2_000);
    expect(watch.noteTurnEnded({ path: OLD, offset: 100 }, 1_000 + LONG).kind).toBe('blind');
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 10_000);
    watch.noteCompactionStarted(false, 2_000);
    expect(watch.noteTurnEnded({ path: OLD, offset: 100 }, 10_000 + LONG).kind).toBe('blind');
  });

  it('空闲压缩的提示符先于 compact_boundary 落盘时，不把维护当成漏读回复', () => {
    const watch = new BridgeBlindTurnWatch();
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 0);
    watch.noteCompactionStarted(false, 0);
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 100);
    expect(watch.noteTurnEnded({ path: OLD, offset: 100 }, 65_000)).toEqual({ kind: 'none' });
    watch.noteCompactionFinished();
    expect(watch.noteTurnEnded({ path: OLD, offset: 200 }, 96_000)).toEqual({ kind: 'none' });
    watch.noteTurnStarted({ path: OLD, offset: 200 }, 100_000);
    expect(watch.noteTurnEnded({ path: OLD, offset: 200 }, 100_000 + LONG).kind).toBe('blind');
  });

  it('已存在待处理模型轮次时，PreCompact 不屏蔽真正漏读的告警', () => {
    const watch = new BridgeBlindTurnWatch();
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 0);
    watch.noteCompactionStarted(true, 100);
    watch.noteCompactionFinished();
    expect(watch.noteTurnEnded({ path: OLD, offset: 100 }, LONG).kind).toBe('blind');
  });

  it('压缩取消或完成信号迟到，都不能屏蔽下一轮真实漏读', () => {
    const watch = new BridgeBlindTurnWatch();
    watch.noteCompactionStarted(false, 0);
    expect(watch.noteTurnEnded({ path: OLD, offset: 100 }, LONG)).toEqual({ kind: 'none' });
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 10_000);
    watch.noteCompactionFinished();
    expect(watch.noteTurnEnded({ path: OLD, offset: 100 }, 10_000 + LONG).kind).toBe('blind');
  });

  it('空闲压缩不清除此前真正漏读 run 的恢复起点和通知去重', () => {
    const watch = new BridgeBlindTurnWatch();
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 0);
    watch.noteTurnEnded({ path: OLD, offset: 100 }, LONG);
    watch.noteReported();
    watch.noteCompactionStarted(false, 9_000);
    watch.noteTurnEnded({ path: OLD, offset: 200 }, 10_000);
    watch.noteCompactionFinished();
    watch.noteTurnStarted({ path: OLD, offset: 200 }, 20_000);
    expect(watch.noteTurnEnded({ path: OLD, offset: 200 }, 20_000 + LONG))
      .toMatchObject({ kind: 'blind', blindSinceMs: 0, reported: true });
  });

  it('a turn whose transcript grew, or that moved the bridge to another file, was read', () => {
    const watch = new BridgeBlindTurnWatch();
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 0);
    expect(watch.noteTurnEnded({ path: OLD, offset: 180 }, LONG)).toEqual({ kind: 'read' });
    watch.noteTurnStarted({ path: OLD, offset: 180 }, 0);
    expect(watch.noteTurnEnded({ path: NEW, offset: 0 }, LONG)).toEqual({ kind: 'read' });
  });

  it('a turn the bridge read nothing of is blind; a run of them replays from the first', () => {
    const watch = new BridgeBlindTurnWatch();
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 1_000);
    // Repeated evidence of the same turn keeps its start.
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 1_500);
    expect(watch.noteTurnEnded({ path: OLD, offset: 100 }, 1_000 + LONG))
      .toEqual({ kind: 'blind', turnStartedAtMs: 1_000, blindSinceMs: 1_000, reported: false });
    watch.noteReported();
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 90_000);
    expect(watch.noteTurnEnded({ path: OLD, offset: 100 }, 90_000 + LONG))
      .toEqual({ kind: 'blind', turnStartedAtMs: 90_000, blindSinceMs: 1_000, reported: true });
  });

  it('a read turn ends the run: the next blind one starts a new run and is reported again', () => {
    const watch = new BridgeBlindTurnWatch();
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 0);
    watch.noteTurnEnded({ path: OLD, offset: 100 }, LONG);
    watch.noteReported();
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 10_000);
    expect(watch.noteTurnEnded({ path: OLD, offset: 200 }, 10_000 + LONG)).toEqual({ kind: 'read' });
    watch.noteTurnStarted({ path: OLD, offset: 200 }, 20_000);
    expect(watch.noteTurnEnded({ path: OLD, offset: 200 }, 20_000 + LONG))
      .toEqual({ kind: 'blind', turnStartedAtMs: 20_000, blindSinceMs: 20_000, reported: false });
  });

  it('judges nothing without turn evidence, for a brief flicker, or after a teardown', () => {
    const watch = new BridgeBlindTurnWatch();
    expect(watch.noteTurnEnded({ path: OLD, offset: 100 }, LONG)).toEqual({ kind: 'none' });
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 0);
    expect(watch.noteTurnEnded({ path: OLD, offset: 100 }, BLIND_TURN_MIN_BUSY_MS - 1)).toEqual({ kind: 'none' });
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 0);
    watch.reset();
    expect(watch.noteTurnEnded({ path: OLD, offset: 100 }, LONG)).toEqual({ kind: 'none' });
  });
});

describe('blindTurnNeedsNotice', () => {
  it('always when the transcript is how every reply reaches the group', () => {
    expect(blindTurnNeedsNotice({ transcriptCarriesEveryReply: true, unreadLarkTurn: false, sentDuringTurn: true })).toBe(true);
  });

  it('with `botmux send` delivery, only for a Lark turn the model did not answer itself', () => {
    expect(blindTurnNeedsNotice({ transcriptCarriesEveryReply: false, unreadLarkTurn: true, sentDuringTurn: false })).toBe(true);
    expect(blindTurnNeedsNotice({ transcriptCarriesEveryReply: false, unreadLarkTurn: true, sentDuringTurn: true })).toBe(false);
    // A terminal-local turn is never forwarded in this mode, read or not.
    expect(blindTurnNeedsNotice({ transcriptCarriesEveryReply: false, unreadLarkTurn: false, sentDuringTurn: false })).toBe(false);
  });
});
