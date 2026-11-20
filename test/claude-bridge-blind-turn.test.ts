import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { terminalInputSubmits } from '../src/adapters/cli/tui-input.js';
import { splitTranscriptEventsByCutoff } from '../src/services/claude-transcript.js';
import {
  BLIND_TURN_MIN_BUSY_MS,
  BridgeBlindTurnWatch,
  blindTurnNeedsNotice,
  replyRecordsStampedWithin,
  UNREAD_TURN_RELOCATE_RETRIES,
  UNREAD_TURN_RELOCATE_RETRY_MS,
} from '../src/services/claude-bridge-blind-turn.js';

const OLD = '/claude/projects/-w/6b50f4a4-3392-43df-837b-02261f498b43.jsonl';
const NEW = '/claude/projects/-w/76cd870a-7bd4-46e7-b191-34290ff42dc2.jsonl';
const LONG = BLIND_TURN_MIN_BUSY_MS + 1;
const ESC = '\x1b';
const paste = (text: string): string => `\x1b[200~${text}\x1b[201~`;

/** Every look for an unread turn's transcript that one judgement schedules. */
const LOOK_AGAIN_WINDOW_MS = UNREAD_TURN_RELOCATE_RETRY_MS * UNREAD_TURN_RELOCATE_RETRIES;

type Located = 'moved' | 'mid-rewrite' | 'none';
type Records = Array<{ type?: string; subtype?: string; timestamp?: string }>;
/** A reply record Claude wrote at `atMs`. */
const stamped = (atMs: number): Records => [{ type: 'assistant', timestamp: new Date(atMs).toISOString() }];

/** The real worker functions over one shared scope: the PreCompact signal, a
 *  web-terminal forward, the prompt-ready judge, its later looks for the
 *  transcript and the hook every transcript switch calls. The bridge grows only
 *  when a test says so, so every busy span below reads as unread unless the
 *  compaction exemption holds. `relocate` answers each attempt to locate the
 *  transcript Claude writes; a 'moved' one switches onto NEW the way the real
 *  switch does, replaying `movedLive()` as live — by default a record written
 *  as the latest busy span began. */
function compactionWorker(relocate: () => Located = () => 'none', movedLive?: () => Records) {
  const watch = new BridgeBlindTurnWatch();
  const send = vi.fn();
  const pending: Array<{ started: boolean; isLocal: boolean; turnId: string }> = [];
  let busySinceMs = 0;
  let offset = 100;
  const scope: Record<string, unknown> = {};
  /** A transcript switch onto NEW that replays `live`. */
  const switchTo = (live: Records): void => {
    scope.bridgeJsonlPath = NEW;
    (scope.settleUnreadClaudeTurnLookOnSwitch as (live: Records) => void)(live);
  };
  const relocateUnreadClaudeTranscript = vi.fn((_blindSinceMs: number) => {
    const located = relocate();
    if (located === 'moved') switchTo(movedLive ? movedLive() : stamped(busySinceMs));
    return located;
  });
  const bridgeDrainAndMaybeEmit = vi.fn();
  Object.assign(scope, {
    lastInitConfig: { cliId: 'claude-code', adoptMode: false },
    bridgeBlindTurnWatch: watch,
    bridgeQueue: { peek: () => pending },
    bridgeJsonlPath: OLD,
    bridgeReadPosition: () => ({ path: OLD, offset }),
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
    isPromptReady: true,
    promptReadyEdges: 1,
    unreadClaudeTurnLook: undefined,
    PENDING_MARK_SKEW_MS: 5_000,
    replyRecordsStampedWithin,
    UNREAD_TURN_RELOCATE_RETRY_MS,
    UNREAD_TURN_RELOCATE_RETRIES,
  });
  for (const name of [
    'scheduleUnreadClaudeTurnLook', 'unreadClaudeTurnUndisturbed', 'recheckUnreadClaudeTurn',
    'notifyUnreadClaudeTurn', 'settleUnreadClaudeTurnLookOnSwitch',
  ]) {
    scope[name] = loadWorkerFunction(name, scope);
  }
  const judgeNow = loadWorkerFunction<() => void>('judgeClaudeBridgeTurn', scope);
  return {
    scope,
    watch,
    pending,
    relocateUnreadClaudeTranscript,
    bridgeDrainAndMaybeEmit,
    compactionSignal: loadWorkerFunction<(hookStartedAtMs: number) => void>('handleClaudeCompactionSignal', scope),
    webInput: loadWorkerFunction<(data: string) => void>('noteWebTerminalInput', scope),
    /** The prompt-ready judgement alone. */
    judgeNow,
    teardown: loadWorkerFunction<() => void>('settleUnreadClaudeTurnLookOnTeardown', scope),
    /** The judgement, and every later look it schedules. */
    judge: () => { judgeNow(); vi.advanceTimersByTime(LOOK_AGAIN_WINDOW_MS); },
    busy: () => { busySinceMs = Date.now(); watch.noteTurnStarted({ path: OLD, offset }, busySinceMs); },
    /** A bridge follower switches onto NEW, replaying `live`. */
    switchTo,
    /** The bridge reads something of the transcript it is on. */
    grow: () => { offset += 100; },
    noticeMessages: () => send.mock.calls.map(([message]) => message).filter(message => message?.type === 'user_notify'),
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
    const w = compactionWorker(() => 'moved');
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

describe('worker：判定时 Claude 的 pid 记录正被原地改写，先再找几次再决定是否告警', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => vi.useRealTimers());

  /** A busy span the bridge read nothing of, judged at its prompt edge.
   *  Returns when it began and when it was judged. */
  const unreadTurn = (w: ReturnType<typeof compactionWorker>): { startedAtMs: number; judgedAtMs: number } => {
    w.busy();
    const startedAtMs = Date.now();
    vi.advanceTimersByTime(LONG);
    w.judgeNow();
    return { startedAtMs, judgedAtMs: Date.now() };
  };
  /** Answers `first` to the judgement, then `rest` to every later look. */
  const looks = (first: Located, rest: Located) => {
    let n = 0;
    return (): Located => (n++ === 0 ? first : rest);
  };

  it('记录读不到以外的定位失败（没有记录、找不到进程）：当场告警，不再找', () => {
    const w = compactionWorker(() => 'none');
    unreadTurn(w);
    expect(w.notices()).toBe(1);
    vi.advanceTimersByTime(LOOK_AGAIN_WINDOW_MS);
    expect(w.relocateUnreadClaudeTranscript).toHaveBeenCalledTimes(1);
    expect(w.notices()).toBe(1);
  });

  it('下一次读到了记录、切过去补读到了这段漏读：按提示符边沿出队，不告警', () => {
    const w = compactionWorker(looks('mid-rewrite', 'moved'));
    const { startedAtMs } = unreadTurn(w);
    expect(w.notices()).toBe(0);
    vi.advanceTimersByTime(UNREAD_TURN_RELOCATE_RETRY_MS);
    expect(w.relocateUnreadClaudeTranscript.mock.calls).toEqual([[startedAtMs], [startedAtMs]]);
    expect(w.bridgeDrainAndMaybeEmit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(LOOK_AGAIN_WINDOW_MS);
    expect(w.relocateUnreadClaudeTranscript).toHaveBeenCalledTimes(2);
    expect(w.notices()).toBe(0);
  });

  it('下一次切到的 transcript 里没有这段漏读（判定后才写的内容，如直连终端敲的 /resume）：告警', () => {
    const w = compactionWorker(looks('mid-rewrite', 'moved'), () => stamped(Date.now()));
    unreadTurn(w);
    vi.advanceTimersByTime(UNREAD_TURN_RELOCATE_RETRY_MS);
    expect(w.bridgeDrainAndMaybeEmit).not.toHaveBeenCalled();
    expect(w.notices()).toBe(1);
  });

  it('一直读不到：最后一次再找也失败才告警，并带上没读到的飞书轮次', () => {
    const w = compactionWorker(() => 'mid-rewrite');
    w.pending.push({ started: false, isLocal: false, turnId: 'om_unread' });
    unreadTurn(w);
    vi.advanceTimersByTime(LOOK_AGAIN_WINDOW_MS - 1);
    expect(w.relocateUnreadClaudeTranscript).toHaveBeenCalledTimes(UNREAD_TURN_RELOCATE_RETRIES);
    expect(w.notices()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(w.relocateUnreadClaudeTranscript).toHaveBeenCalledTimes(1 + UNREAD_TURN_RELOCATE_RETRIES);
    expect(w.noticeMessages()).toEqual([
      { type: 'user_notify', message: 'worker.claude_bridge_turn_unread', turnId: 'om_unread' },
    ]);
  });

  it('再找时记录读出来了、却没有别的 transcript：不再等，当场告警', () => {
    const w = compactionWorker(looks('mid-rewrite', 'none'));
    unreadTurn(w);
    vi.advanceTimersByTime(UNREAD_TURN_RELOCATE_RETRY_MS);
    expect(w.notices()).toBe(1);
    vi.advanceTimersByTime(LOOK_AGAIN_WINDOW_MS);
    expect(w.relocateUnreadClaudeTranscript).toHaveBeenCalledTimes(2);
    expect(w.notices()).toBe(1);
  });

  it.each([
    ['开始了新的一轮', (w: ReturnType<typeof compactionWorker>) => w.busy()],
    ['离开了提示符', (w: ReturnType<typeof compactionWorker>) => { w.scope.isPromptReady = false; }],
    ['离开又回到提示符（如 /clear、/resume）', (w: ReturnType<typeof compactionWorker>) => { w.scope.promptReadyEdges = 2; }],
    ['写入了飞书消息', (w: ReturnType<typeof compactionWorker>) => { w.scope.lastWrittenCliInput = { content: 'next' }; }],
    ['Web 终端提交了输入', (w: ReturnType<typeof compactionWorker>) => { w.scope.webTerminalSubmitGeneration = 1; }],
  ])('再找之前 Claude %s：这段漏读之后已有别的内容，补读不可靠，照常告警', (_label, disturb) => {
    const w = compactionWorker(looks('mid-rewrite', 'moved'));
    unreadTurn(w);
    disturb(w);
    vi.advanceTimersByTime(UNREAD_TURN_RELOCATE_RETRY_MS);
    expect(w.relocateUnreadClaudeTranscript).toHaveBeenCalledTimes(1);
    expect(w.bridgeDrainAndMaybeEmit).not.toHaveBeenCalled();
    expect(w.notices()).toBe(1);
  });

  it('pid 周期跟随切过去、补读到了这段漏读：结清，之后再被扰动、再切换或被拆掉都不告警', () => {
    const w = compactionWorker(() => 'mid-rewrite');
    const { startedAtMs } = unreadTurn(w);
    w.switchTo(stamped(startedAtMs + 1_000));
    w.busy();
    w.switchTo(stamped(Date.now()));
    vi.advanceTimersByTime(LOOK_AGAIN_WINDOW_MS);
    w.teardown();
    expect(w.relocateUnreadClaudeTranscript).toHaveBeenCalledTimes(1);
    expect(w.notices()).toBe(0);
  });

  it('漏读之前写的记录也算：一轮的首条记录可以早于 busy 证据', () => {
    const w = compactionWorker(() => 'mid-rewrite');
    const { startedAtMs } = unreadTurn(w);
    w.switchTo(stamped(startedAtMs - 1_000));
    vi.advanceTimersByTime(LOOK_AGAIN_WINDOW_MS);
    expect(w.notices()).toBe(0);
  });

  it.each([
    ['只补读到判定之后写的内容（直连终端敲的 /resume）', (t: { judgedAtMs: number }) => stamped(t.judgedAtMs + 1)],
    ['什么都没补读到（指纹回退从更新的飞书消息起补读）', () => []],
    ['补读到的都是漏读开始很久以前的内容', (t: { startedAtMs: number }) => stamped(t.startedAtMs - 60_000)],
  ])('跟随切走但%s：这段漏读没有送达，告警', (_label, live) => {
    const w = compactionWorker(() => 'mid-rewrite');
    const times = unreadTurn(w);
    w.switchTo(live(times as { startedAtMs: number; judgedAtMs: number }));
    vi.advanceTimersByTime(UNREAD_TURN_RELOCATE_RETRY_MS);
    expect(w.relocateUnreadClaudeTranscript).toHaveBeenCalledTimes(1);
    expect(w.notices()).toBe(1);
  });

  it('Claude 先被扰动、之后跟随才切过去：补读里可能夹着下一轮，不算送达，告警', () => {
    const w = compactionWorker(() => 'mid-rewrite');
    const { startedAtMs } = unreadTurn(w);
    w.busy();
    w.switchTo(stamped(startedAtMs + 1_000));
    vi.advanceTimersByTime(UNREAD_TURN_RELOCATE_RETRY_MS);
    expect(w.notices()).toBe(1);
  });

  it('再找期间 bridge 读到了下一轮（这段漏读已结束）：不再告警', () => {
    const w = compactionWorker(() => 'mid-rewrite');
    unreadTurn(w);
    w.busy();
    w.grow();
    w.scope.promptReadyEdges = 2;
    w.judgeNow();
    vi.advanceTimersByTime(LOOK_AGAIN_WINDOW_MS);
    expect(w.relocateUnreadClaudeTranscript).toHaveBeenCalledTimes(1);
    expect(w.notices()).toBe(0);
  });

  it('再找期间 bridge 被拆掉（CLI 退出或重启）：当场告警，不随 bridge 一起丢掉', () => {
    const w = compactionWorker(() => 'mid-rewrite');
    unreadTurn(w);
    w.teardown();
    expect(w.notices()).toBe(1);
    w.watch.reset();
    vi.advanceTimersByTime(LOOK_AGAIN_WINDOW_MS);
    expect(w.relocateUnreadClaudeTranscript).toHaveBeenCalledTimes(1);
    expect(w.notices()).toBe(1);
  });

  it('已告警过的这段漏读里再漏读一轮：不再找、不再告警', () => {
    const w = compactionWorker(() => 'mid-rewrite');
    unreadTurn(w);
    vi.advanceTimersByTime(LOOK_AGAIN_WINDOW_MS);
    expect(w.notices()).toBe(1);
    w.scope.promptReadyEdges = 2;
    unreadTurn(w);
    vi.advanceTimersByTime(LOOK_AGAIN_WINDOW_MS);
    expect(w.relocateUnreadClaudeTranscript).toHaveBeenCalledTimes(2 + UNREAD_TURN_RELOCATE_RETRIES);
    expect(w.notices()).toBe(1);
  });
});

describe.each(['performRotationSwitch', 'bridgeApplyFingerprintSwitch'])('worker：%s 结清正在再找的漏读', (switchFn) => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  afterEach(() => vi.useRealTimers());

  /** The real switch onto NEW while a look for a run judged at 90s (begun at
   *  80s) is pending; NEW holds `records`, all replayed as live. */
  function switchWhileLooking(records: Records) {
    const look = vi.fn();
    const watch = new BridgeBlindTurnWatch();
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 80_000);
    watch.noteTurnEnded({ path: OLD, offset: 100 }, 90_000);
    const run = {
      path: OLD, blindSinceMs: 80_000, judgedAtMs: 90_000,
      promptReadyEdge: 1, writtenInput: undefined, webSubmitGeneration: 0,
    };
    const scope: Record<string, unknown> = {
      bridgeJsonlPath: OLD, bridgeBaselineDone: false, bridgeWatcher: null, bridgeOffset: 0,
      log: () => {}, cliName: () => 'Claude',
      dirname: (path: string) => path.slice(0, path.lastIndexOf('/')),
      drainTranscript: () => ({ newOffset: 1, events: records }),
      splitTranscriptEventsByCutoff,
      beginNewBridgeTranscriptGeneration: () => {},
      bridgeQueue: { absorb: () => {}, ingest: () => {} },
      seedModelFallbackFromTranscript: () => {}, observeModelFallbackEvents: () => {},
      observeClaudeBackgroundTasks: () => {}, bridgeMarkStalePidStateForAcceptedSid: () => {},
      bridgeRememberSessionIdForPath: () => {},
      sessionIdFromJsonlPath: (path: string) => path.slice(path.lastIndexOf('/') + 1, -'.jsonl'.length),
      fsWatch: () => ({ close: () => {} }),
      performBridgeIngestAndScheduleQuietEmit: () => {},
      bridgeBlindTurnWatch: watch, isPromptReady: true, promptReadyEdges: 1,
      lastWrittenCliInput: undefined, webTerminalSubmitGeneration: 0,
      PENDING_MARK_SKEW_MS: 5_000, replyRecordsStampedWithin,
      unreadClaudeTurnLook: { run, timer: setTimeout(look, UNREAD_TURN_RELOCATE_RETRY_MS) },
    };
    for (const name of ['unreadClaudeTurnUndisturbed', 'settleUnreadClaudeTurnLookOnSwitch']) {
      scope[name] = loadWorkerFunction(name, scope);
    }
    loadWorkerFunction<(path: string, reason: string, cutoffMs: number) => void>(switchFn, scope)(NEW, 'test', 0);
    vi.advanceTimersByTime(UNREAD_TURN_RELOCATE_RETRY_MS);
    return { look, settled: scope.unreadClaudeTurnLook === undefined };
  }

  it('补读到漏读期间写的记录：结清，不再找', () => {
    const { look, settled } = switchWhileLooking(stamped(85_000));
    expect(settled).toBe(true);
    expect(look).not.toHaveBeenCalled();
  });

  it('只补读到判定之后的记录：留给再找去告警', () => {
    const { look, settled } = switchWhileLooking(stamped(95_000));
    expect(settled).toBe(false);
    expect(look).toHaveBeenCalledTimes(1);
  });
});

describe('replyRecordsStampedWithin', () => {
  const at = (atMs: number) => new Date(atMs).toISOString();

  it('counts a reply stamped inside the window, bounds included: an assistant record or a turn_duration', () => {
    expect(replyRecordsStampedWithin(stamped(1_000), 1_000, 2_000)).toBe(true);
    expect(replyRecordsStampedWithin(stamped(2_000), 1_000, 2_000)).toBe(true);
    expect(replyRecordsStampedWithin([{ type: 'system', subtype: 'turn_duration', timestamp: at(1_500) }], 1_000, 2_000)).toBe(true);
    expect(replyRecordsStampedWithin([...stamped(500), ...stamped(1_500)], 1_000, 2_000)).toBe(true);
  });

  it('ignores replies outside the window, records without a timestamp, and records that are no reply', () => {
    expect(replyRecordsStampedWithin([...stamped(999), ...stamped(2_001)], 1_000, 2_000)).toBe(false);
    expect(replyRecordsStampedWithin([{ type: 'assistant' }, { type: 'assistant', timestamp: 'not a time' }], 1_000, 2_000)).toBe(false);
    expect(replyRecordsStampedWithin([], 1_000, 2_000)).toBe(false);
    // A /clear command record, a compact boundary and its summary around the run.
    expect(replyRecordsStampedWithin([
      { type: 'user', timestamp: at(1_500) },
      { type: 'system', subtype: 'compact_boundary', timestamp: at(1_500) },
      { type: 'user', timestamp: at(1_600) },
    ], 1_000, 2_000)).toBe(false);
  });
});

describe('worker：relocateUnreadClaudeTranscript 区分「记录正被改写」与「找不到」', () => {
  const FD_SID = '76cd870a-7bd4-46e7-b191-34290ff42dc2';
  /** An adopted pane (no launch-layer descent) whose pid-state record answers
   *  `pidState`, holding open the session files `open` names. */
  function relocate(pidState: unknown, open: string[]) {
    const switched: string[] = [];
    const scope: Record<string, unknown> = {
      lastInitConfig: { cliId: 'claude-code', adoptMode: true },
      bridgeCliPid: 4242, bridgeCliCwd: '/w', bridgeDataDir: '/claude',
      bridgeJsonlPath: OLD, bridgePathConfirmedAtMs: 1_000, bridgeStalePidStateSessionId: undefined,
      PENDING_MARK_SKEW_MS: 5_000,
      log: () => {},
      resolveJsonlFromPidState: () => pidState,
      bridgeRememberSessionIdForPath: () => {},
      switchBridgeToPidStatePath: (path: string) => { switched.push(path); },
      bridgeMarkStalePidStateForAcceptedSid: () => {},
      findOpenClaudeSessionIds: () => open,
      claudeJsonlPathForSession: (sid: string) => `/claude/projects/-w/${sid}.jsonl`,
      statSafe: () => ({ mtimeMs: 50_000 }),
      newestPath: (paths: string[]) => paths[0],
      sessionIdFromJsonlPath: (path: string) => path.slice(path.lastIndexOf('/') + 1, -'.jsonl'.length),
    };
    const located = loadWorkerFunction<(blindSinceMs: number) => string>('relocateUnreadClaudeTranscript', scope)(20_000);
    return { located, switched };
  }

  it('记录正被改写、也没有更新的打开文件：mid-rewrite，不切换', () => {
    expect(relocate('mid-rewrite', [])).toEqual({ located: 'mid-rewrite', switched: [] });
  });

  it('记录正被改写、但 Claude 打开的会话文件指向别的 transcript：照样切过去', () => {
    expect(relocate('mid-rewrite', [FD_SID])).toEqual({ located: 'moved', switched: [`/claude/projects/-w/${FD_SID}.jsonl`] });
  });

  it('没有记录、也没有打开文件：none', () => {
    expect(relocate(null, [])).toEqual({ located: 'none', switched: [] });
  });

  it('记录指向别的 transcript：切过去', () => {
    expect(relocate({ path: NEW, cliSessionId: '76cd870a-7bd4-46e7-b191-34290ff42dc2' }, []))
      .toEqual({ located: 'moved', switched: [NEW] });
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

  it('a turn is in progress from its start until the next prompt edge', () => {
    const watch = new BridgeBlindTurnWatch();
    expect(watch.turnInProgress()).toBe(false);
    watch.noteTurnStarted({ path: OLD, offset: 100 }, 1_000);
    expect(watch.turnInProgress()).toBe(true);
    watch.noteTurnEnded({ path: OLD, offset: 100 }, 1_500);
    expect(watch.turnInProgress()).toBe(false);
  });

  it('a run counts as unreported until it is reported, a turn is read, or the bridge is torn down', () => {
    const run = (watch: BridgeBlindTurnWatch): void => {
      watch.noteTurnStarted({ path: OLD, offset: 100 }, 1_000);
      watch.noteTurnEnded({ path: OLD, offset: 100 }, 1_000 + LONG);
    };
    const watch = new BridgeBlindTurnWatch();
    expect(watch.isUnreportedRun(1_000)).toBe(false);
    run(watch);
    expect(watch.isUnreportedRun(1_000)).toBe(true);
    expect(watch.isUnreportedRun(2_000)).toBe(false);
    watch.noteReported();
    expect(watch.isUnreportedRun(1_000)).toBe(false);

    const read = new BridgeBlindTurnWatch();
    run(read);
    read.noteTurnStarted({ path: OLD, offset: 100 }, 10_000);
    read.noteTurnEnded({ path: OLD, offset: 200 }, 10_000 + LONG);
    expect(read.isUnreportedRun(1_000)).toBe(false);

    const torn = new BridgeBlindTurnWatch();
    run(torn);
    torn.reset();
    expect(torn.isUnreportedRun(1_000)).toBe(false);
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
