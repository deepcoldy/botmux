/**
 * resume 边界后 claude 不再重绘提示符 → 屏幕状态永久停在 working。
 *
 * 现场：挂起的会话被网页终端冷唤醒（没有要投递的消息）。claude --resume 在
 * SessionStart 信号送达 worker 之前就画完了转写和 ❯，之后再无输出。边界把
 * ready 证据清零，IdleDetector 的静默策略被 `!readySeen` 永久压住；type-ahead
 * CLI 的首轮超时只调 flushPending()，空队列下什么也不做。于是 isPromptReady
 * 永远为 false，屏幕状态恒报 working，等 idle 边沿的延迟挂起永远不兑现。
 *
 * Run:  bun run vitest run test/resume-first-prompt-seed.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { InflightInputTracker } from '../src/core/inflight-input-tracker.js';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';
import {
  decidePostHookPromptEvidence,
  firstPromptSeedStillWaiting,
  screenShowsFramedPrompt,
  shouldArmFirstPromptTimeoutPromptSeed,
} from '../src/utils/input-gate.js';
import type { CliAdapter } from '../src/adapters/cli/types.js';

/** claude-code 适配器的真实 readyPattern。 */
const CLAUDE_READY = /❯/;
const RULE = '─'.repeat(80);

/** 空闲的 claude 画面：转写 + 上下横线夹住的空输入框 + 状态栏。 */
const IDLE_SCREEN = [
  '⏺ Bash(git status)',
  '  ⎿  nothing to commit, working tree clean',
  '',
  '⏺ Done.',
  '',
  '✻ Worked for 12s · done 2:42 PM',
  '',
  RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

function makeCli(readyPattern?: RegExp): CliAdapter {
  return {
    id: 'test-cli',
    resolvedBin: '/usr/bin/test-cli',
    buildArgs: () => [],
    writeInput: async () => {},
    readyPattern,
    systemHints: [],
    altScreen: false,
  };
}

describe('resume 边界后无重绘：IdleDetector 层面的成因', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('边界前画好的 ❯ 被 resetReadyEvidence 清掉后，没有新输出就永远判不出空闲', () => {
    const detector = new IdleDetector(makeCli(CLAUDE_READY));
    const cb = vi.fn();
    detector.onIdle(cb);
    detector.feed('❯ ');                  // resume 在信号到达前就画完了提示符
    detector.resetReadyEvidence();         // SessionStart 边界
    vi.advanceTimersByTime(60_000);        // 远超 15s 首轮超时，屏幕一直不动
    expect(cb).not.toHaveBeenCalled();
    detector.dispose();
  });

  it('补一次 ready 证据后走完整静默判定即判空闲（修复所依赖的机制）', () => {
    const detector = new IdleDetector(makeCli(CLAUDE_READY));
    const cb = vi.fn();
    detector.onIdle(cb);
    detector.feed('❯ ');
    detector.resetReadyEvidence();
    vi.advanceTimersByTime(17_000);
    expect(detector.seedReadyEvidence()).toBe(true);
    vi.advanceTimersByTime(3_500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });
});

describe('shouldArmFirstPromptTimeoutPromptSeed', () => {
  it('边界仍未解决且队列为空 → arm', () => {
    expect(shouldArmFirstPromptTimeoutPromptSeed({ wasAwaitingPostHookPrompt: true, hasPendingInput: false, webInputSinceBoundary: false })).toBe(true);
  });

  it('有排队消息 → 不 arm（超时自己会 flush，回复会走正常路径重绘提示符）', () => {
    expect(shouldArmFirstPromptTimeoutPromptSeed({ wasAwaitingPostHookPrompt: true, hasPendingInput: true, webInputSinceBoundary: false })).toBe(false);
  });

  it('边界之后有人在网页终端敲过字 → 不 arm（那次提交可能还没回显）', () => {
    expect(shouldArmFirstPromptTimeoutPromptSeed({ wasAwaitingPostHookPrompt: true, hasPendingInput: false, webInputSinceBoundary: true })).toBe(false);
  });

  it('边界已拿到真证据（或根本没有边界）→ 不 arm', () => {
    expect(shouldArmFirstPromptTimeoutPromptSeed({ wasAwaitingPostHookPrompt: false, hasPendingInput: false, webInputSinceBoundary: false })).toBe(false);
  });
});

describe('screenShowsFramedPrompt', () => {
  it('上下横线夹住的空输入框 → true', () => {
    expect(screenShowsFramedPrompt(IDLE_SCREEN, CLAUDE_READY)).toBe(true);
  });

  it('横线与提示符之间隔着空行也算', () => {
    const screen = [RULE, '', '❯ ', '', RULE].join('\n');
    expect(screenShowsFramedPrompt(screen, CLAUDE_READY)).toBe(true);
  });

  it('选择器的 ❯ 1. Yes → false（上方是问句，不是横线）', () => {
    const screen = [
      RULE,
      ' Do you trust the files in this folder?',
      '',
      ' ❯ 1. Yes, proceed',
      '   2. No, exit',
      '',
      ' Enter to confirm · Esc to cancel',
    ].join('\n');
    expect(screenShowsFramedPrompt(screen, CLAUDE_READY)).toBe(false);
  });

  it('只有下方横线（输入框没画全）→ false', () => {
    const screen = ['⏺ Done.', '❯ ', RULE].join('\n');
    expect(screenShowsFramedPrompt(screen, CLAUDE_READY)).toBe(false);
  });

  it('只有上方横线 → false', () => {
    const screen = [RULE, '❯ ', '  ⏵⏵ bypass permissions on'].join('\n');
    expect(screenShowsFramedPrompt(screen, CLAUDE_READY)).toBe(false);
  });

  it('看的是最后一个 ❯：转写里残留的历史 ❯ 不能代替输入框', () => {
    const screen = ['❯ 旧的一条输入', '', '⏺ 正在回复…', '  ⎿  Running…'].join('\n');
    expect(screenShowsFramedPrompt(screen, CLAUDE_READY)).toBe(false);
    const withBox = [screen, '', RULE, '❯ ', RULE].join('\n');
    expect(screenShowsFramedPrompt(withBox, CLAUDE_READY)).toBe(true);
  });

  it('框线太短（表格、分隔符之类）不算输入框', () => {
    const screen = ['───', '❯ ', '───'].join('\n');
    expect(screenShowsFramedPrompt(screen, CLAUDE_READY)).toBe(false);
  });

  it('空画面 / 没有提示符 → false', () => {
    expect(screenShowsFramedPrompt('', CLAUDE_READY)).toBe(false);
    expect(screenShowsFramedPrompt([RULE, '  loading…', RULE].join('\n'), CLAUDE_READY)).toBe(false);
  });
});

describe('firstPromptSeedStillWaiting：只接受 arm 以来完全冻住的画面', () => {
  const frozen = {
    sameBackend: true,
    promptReady: false,
    hasPendingInput: false,
    hasUnackedInput: false,
    outputSinceArm: false,
    inputSinceArm: false,
  };

  it('画面冻住、无输入、未就绪、同一代 → 继续等', () => {
    expect(firstPromptSeedStillWaiting(frozen)).toBe(true);
  });

  it('arm 之后有任何输出（包括直接在网页终端敲字的回显）→ 交还正常路径', () => {
    expect(firstPromptSeedStillWaiting({ ...frozen, outputSinceArm: true })).toBe(false);
  });

  it('arm 之后有队列不记录的输入（网页终端直写 / 换了 turn）→ 退出，哪怕 CLI 还没回显', () => {
    expect(firstPromptSeedStillWaiting({ ...frozen, inputSinceArm: true })).toBe(false);
  });

  it('有在途输入 → 退出', () => {
    expect(firstPromptSeedStillWaiting({ ...frozen, hasUnackedInput: true })).toBe(false);
  });

  it('有排队输入 → 退出', () => {
    expect(firstPromptSeedStillWaiting({ ...frozen, hasPendingInput: true })).toBe(false);
  });

  it('提示符已自行就绪 → 退出', () => {
    expect(firstPromptSeedStillWaiting({ ...frozen, promptReady: true })).toBe(false);
  });

  it('backend 已换代 → 退出', () => {
    expect(firstPromptSeedStillWaiting({ ...frozen, sameBackend: false })).toBe(false);
  });
});

describe('首轮超时兜底复用 decidePostHookPromptEvidence 的静默/重试语义', () => {
  it('屏幕早已安静且输入框在 → 立刻 accept', () => {
    expect(decidePostHookPromptEvidence({
      stillWaiting: true, elapsedMs: 0, quietMs: 60_000, screenHasReadyPattern: true,
    })).toEqual({ action: 'accept' });
  });

  it('有新输出（例如刚写入一条消息）→ 等满静默窗口再看', () => {
    expect(decidePostHookPromptEvidence({
      stillWaiting: true, elapsedMs: 0, quietMs: 500, screenHasReadyPattern: true,
    }).action).toBe('retry');
  });

  it('不再等待（有在途输入 / 提示符已就绪）→ stop', () => {
    expect(decidePostHookPromptEvidence({
      stillWaiting: false, elapsedMs: 0, quietMs: 60_000, screenHasReadyPattern: true,
    })).toEqual({ action: 'stop' });
  });
});

describe('InflightInputTracker.hasUnacked', () => {
  it('写入后为 true，回到空闲提示符后为 false', () => {
    const tracker = new InflightInputTracker();
    expect(tracker.hasUnacked()).toBe(false);
    tracker.onWrite({ content: 'hi' });
    expect(tracker.hasUnacked()).toBe(true);
    tracker.onTurnComplete();
    expect(tracker.hasUnacked()).toBe(false);
  });
});

describe('screenShowsFramedPrompt × 真实 TerminalRenderer（渲染清洗层）', () => {
  const COLS = 80;
  const rule = '─'.repeat(COLS);
  // 与 claude 的实际输出同形：框线带颜色转义、行间用 \r\n，框线占满整行。
  const frame = [
    '⏺ Done.',
    '',
    `\x1b[2m${rule}\x1b[0m`,
    '\x1b[1m❯\x1b[0m ',
    `\x1b[2m${rule}\x1b[0m`,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\r\n');

  it('preserveFormatting 快照保留框线 → 判定为输入框', async () => {
    const r = new TerminalRenderer(COLS, 24);
    await r.writeAndFlush(frame);
    expect(screenShowsFramedPrompt(r.rawSnapshot({ preserveFormatting: true }), CLAUDE_READY)).toBe(true);
  });

  it('默认快照把 ─ 清洗成空格 → 判定失败（worker 必须传 preserveFormatting）', async () => {
    const r = new TerminalRenderer(COLS, 24);
    await r.writeAndFlush(frame);
    expect(screenShowsFramedPrompt(r.rawSnapshot(), CLAUDE_READY)).toBe(false);
  });

  it('真实渲染下选择器依旧被拒', async () => {
    const r = new TerminalRenderer(COLS, 24);
    await r.writeAndFlush([
      rule,
      ' Do you trust the files in this folder?',
      '',
      ' ❯ 1. Yes, proceed',
      '   2. No, exit',
    ].join('\r\n'));
    expect(screenShowsFramedPrompt(r.rawSnapshot({ preserveFormatting: true }), CLAUDE_READY)).toBe(false);
  });
});
