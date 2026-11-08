import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { terminalInputSubmits } from '../src/adapters/cli/tui-input.js';
import {
  BLIND_TURN_MIN_BUSY_MS,
  BridgeBlindTurnWatch,
  blindTurnNeedsNotice,
} from '../src/services/claude-bridge-blind-turn.js';

const OLD = '/claude/projects/-w/6b50f4a4-3392-43df-837b-02261f498b43.jsonl';
const NEW = '/claude/projects/-w/76cd870a-7bd4-46e7-b191-34290ff42dc2.jsonl';
const LONG = BLIND_TURN_MIN_BUSY_MS + 1;
const ESC = '\x1b';
const paste = (text: string): string => `\x1b[200~${text}\x1b[201~`;

/** The real worker functions over one shared scope: the PreCompact signal, a
 *  web-terminal forward and the prompt-ready judge. The bridge never grows, so
 *  every busy span below reads as unread unless the compaction exemption holds. */
function compactionWorker(relocate: () => boolean = () => false) {
  const watch = new BridgeBlindTurnWatch();
  const send = vi.fn();
  const pending: Array<{ started: boolean; isLocal: boolean; turnId: string }> = [];
  const relocateUnreadClaudeTranscript = vi.fn(relocate);
  const bridgeDrainAndMaybeEmit = vi.fn();
  const scope: Record<string, unknown> = {
    lastInitConfig: { cliId: 'claude-code', adoptMode: false },
    bridgeBlindTurnWatch: watch,
    bridgeQueue: { peek: () => pending },
    bridgeJsonlPath: OLD,
    bridgeReadPosition: () => ({ path: OLD, offset: 100 }),
    bridgeIngest: vi.fn(),
    bridgeDrainAndMaybeEmit,
    relocateUnreadClaudeTranscript,
    zeroPromptTerminalSync: () => true,
    readSendMarkers: () => [],
    lastWebTerminalInputAtMs: 0,
    webTerminalInputGeneration: 0,
    lastWebTerminalSubmitAtMs: 0,
    webTerminalSubmitGeneration: 0,
    lastWrittenCliInput: undefined,
    claudeCompactionInputSnapshot: undefined,
    terminalInputSubmits,
    blindTurnNeedsNotice,
    cliName: () => 'Claude',
    log: vi.fn(),
    t: (key: string) => key,
    send,
  };
  return {
    scope,
    pending,
    relocateUnreadClaudeTranscript,
    bridgeDrainAndMaybeEmit,
    compactionSignal: loadWorkerFunction<(hookStartedAtMs: number) => void>('handleClaudeCompactionSignal', scope),
    webInput: loadWorkerFunction<(data: string) => void>('noteWebTerminalInput', scope),
    judge: loadWorkerFunction<() => void>('judgeClaudeBridgeTurn', scope),
    busy: () => watch.noteTurnStarted({ path: OLD, offset: 100 }, Date.now()),
    notices: () => send.mock.calls.filter(([message]) => message?.type === 'user_notify').length,
  };
}

describe('worker：空闲压缩期间的输入与漏读通知', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ['ESC', [ESC]],
    ['Ctrl-C', ['\x03']],
    ['ArrowUp', ['\x1b[A']],
    ['没提交的字符', ['h', 'ello']],
    ['括号粘贴里的换行', [paste('line1\rline2')]],
  ])('Web 终端在压缩期间按 %s 不算新输入：不误报；之后真正漏读的一轮照常告警', (_label, chunks) => {
    const w = compactionWorker();
    w.compactionSignal(Date.now());
    w.busy();
    vi.advanceTimersByTime(2_000);
    for (const chunk of chunks) w.webInput(chunk);
    vi.advanceTimersByTime(LONG);
    w.judge();
    expect(w.notices()).toBe(0);

    w.busy();
    vi.advanceTimersByTime(LONG);
    w.judge();
    expect(w.notices()).toBe(1);
  });

  it.each([
    ['Web 提交', ['hello\r']],
    ['多段输入后回车', ['h', 'el', 'lo', '\r']],
    ['未开括号粘贴时粘贴带换行', ['line1\rline2']],
    ['粘贴后再回车', [paste('line1\rline2'), '\r']],
    ['粘贴与回车在同一段', [`${paste('line1')}\r`]],
  ])('Web 终端在压缩期间%s：仍报告漏读', (_label, chunks) => {
    const w = compactionWorker();
    w.compactionSignal(Date.now());
    w.busy();
    vi.advanceTimersByTime(2_000);
    for (const chunk of chunks) w.webInput(chunk);
    vi.advanceTimersByTime(LONG);
    w.judge();
    expect(w.notices()).toBe(1);
  });

  it.each([
    ['ESC', ESC, 0],
    ['Web 提交', 'hello\r', 1],
  ])('hook 晚到：hook 已开始、信号还没到 worker 时按了 %s', (_label, data, expected) => {
    const w = compactionWorker();
    const hookStartedAtMs = Date.now();
    vi.advanceTimersByTime(500);
    w.webInput(data);
    vi.advanceTimersByTime(500);
    w.compactionSignal(hookStartedAtMs);
    w.busy();
    vi.advanceTimersByTime(LONG);
    w.judge();
    expect(w.notices()).toBe(expected);
  });

  it.each(['web', 'written', 'pending'])('压缩期间出现 %s 输入时仍报告漏读；重复的开始信号不重置输入快照', (input) => {
    const w = compactionWorker();
    const hookStartedAtMs = Date.now();
    w.compactionSignal(hookStartedAtMs);
    w.busy();
    if (input === 'web') w.webInput('hello\r');
    else if (input === 'written') w.scope.lastWrittenCliInput = {};
    else w.pending.push({ started: false, isLocal: false, turnId: 'new-input' });
    w.compactionSignal(hookStartedAtMs);
    vi.advanceTimersByTime(LONG);
    w.judge();
    expect(w.notices()).toBe(1);
  });

  it('提示符先于 compact_boundary 落盘时不通知；下一轮真实漏读仍触发通知', () => {
    const w = compactionWorker();
    w.busy();
    w.compactionSignal(Date.now());
    vi.advanceTimersByTime(65_000);
    w.judge();
    expect(w.notices()).toBe(0);
    vi.advanceTimersByTime(31_000);
    (w.scope.bridgeBlindTurnWatch as BridgeBlindTurnWatch).noteCompactionFinished();
    w.busy();
    vi.advanceTimersByTime(LONG);
    w.judge();
    expect(w.notices()).toBe(1);
  });

  it('压缩跨度里 Claude 实际写的是另一个 transcript 时（直接 attach 的终端可能在里面跑了一轮），照常切过去补读，但不告警', () => {
    const w = compactionWorker(() => true);
    const hookStartedAtMs = Date.now();
    w.compactionSignal(hookStartedAtMs);
    w.busy();
    vi.advanceTimersByTime(LONG);
    w.judge();
    expect(w.relocateUnreadClaudeTranscript).toHaveBeenCalledWith(hookStartedAtMs);
    expect(w.bridgeDrainAndMaybeEmit).toHaveBeenCalledTimes(1);
    expect(w.notices()).toBe(0);
  });
});

describe('terminalInputSubmits', () => {
  it.each([
    ['\r', true],
    ['\n', true],
    [`${ESC}\r`, true],
    ['\x7f', false],
    [paste('a\nb\n'), false],
    ['\x1b[200~没收尾的粘贴\r', false],
  ])('%j → %s', (data, expected) => {
    expect(terminalInputSubmits(data)).toBe(expected);
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
    expect(watch.noteTurnEnded({ path: OLD, offset: 100 }, 65_000)).toEqual({ kind: 'maintenance', turnStartedAtMs: 0 });
    watch.noteCompactionFinished();
    expect(watch.noteTurnEnded({ path: OLD, offset: 200 }, 96_000)).toEqual({ kind: 'none' });
    watch.noteTurnStarted({ path: OLD, offset: 200 }, 100_000);
    expect(watch.noteTurnEnded({ path: OLD, offset: 200 }, 100_000 + LONG).kind).toBe('blind');
  });

  it('压缩跨度里 bridge 读到了新内容：与没有压缩时一样算读到，结束之前的漏读 run', () => {
    const watch = new BridgeBlindTurnWatch();
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 0);
    watch.noteTurnEnded({ path: OLD, offset: 100 }, LONG);
    watch.noteReported();
    watch.noteCompactionStarted(false, 9_000);
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 10_000);
    expect(watch.noteTurnEnded({ path: OLD, offset: 200 }, 10_000 + LONG)).toEqual({ kind: 'read' });
    watch.noteTurnStarted({ path: OLD, offset: 200 }, 20_000);
    expect(watch.noteTurnEnded({ path: OLD, offset: 200 }, 20_000 + LONG))
      .toMatchObject({ kind: 'blind', blindSinceMs: 20_000, reported: false });
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
