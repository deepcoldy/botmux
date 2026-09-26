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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { InflightInputTracker } from '../src/core/inflight-input-tracker.js';
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

describe('worker 接线（source-lock）', () => {
  const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
  const timeoutStart = source.indexOf('const releaseFirstPromptTimeout = ');
  const timeoutBody = source.slice(timeoutStart, source.indexOf('setTimeout(() => releaseFirstPromptTimeout(FIRST_PROMPT_TIMEOUT_MS', timeoutStart));
  const seedStart = source.indexOf('function armFirstPromptTimeoutPromptSeed(');
  const seedBody = source.slice(seedStart, source.indexOf('\n}\n', seedStart));

  it('边界状态必须在清零之前取样', () => {
    const snapIdx = timeoutBody.indexOf('const wasAwaitingPostHookPrompt = awaitingPostSessionStartPromptEvidence;');
    const clearIdx = timeoutBody.indexOf('awaitingPostSessionStartPromptEvidence = false;');
    expect(snapIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(snapIdx);
  });

  it('只在 type-ahead flush 分支 arm，且由纯函数守卫、队列状态在 flush 之前取', () => {
    const flushBranch = timeoutBody.slice(timeoutBody.indexOf("=== 'flush') {"));
    const gateIdx = flushBranch.indexOf('shouldArmFirstPromptTimeoutPromptSeed({');
    const pendingIdx = flushBranch.indexOf('hasPendingInput: hasPendingInputForFlush(),');
    const flushIdx = flushBranch.indexOf('flushPending();');
    const armIdx = flushBranch.indexOf('if (armPromptSeed && backend) armFirstPromptTimeoutPromptSeed(backend);');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(pendingIdx).toBeGreaterThan(gateIdx);
    expect(flushIdx).toBeGreaterThan(pendingIdx);
    expect(armIdx).toBeGreaterThan(flushIdx);
    expect(armIdx).toBeLessThan(flushBranch.indexOf('return;'));
  });

  it('轮询期间的继续条件走纯函数，且每个字段都喂真实状态', () => {
    expect(seedBody).toContain('stillWaiting: firstPromptSeedStillWaiting({');
    expect(seedBody).toContain('sameBackend: backend === observedBackend,');
    expect(seedBody).toContain('promptReady: isPromptReady,');
    expect(seedBody).toContain('hasPendingInput: hasPendingInputForFlush(),');
    expect(seedBody).toContain('hasUnackedInput: inflightInputs.hasUnacked(),');
    expect(seedBody).toContain('outputSinceArm: !ptyOutputGeneration.isCurrent(armed.outputGeneration),');
    // 屏幕 resync 不算活动：它 reset 了 IdleDetector 却不喂数据，停掉兜底会把提示符再次困住。
    expect(seedBody).not.toContain('armed.outputAtMs');
    expect(seedBody).toContain('inputSinceArm: webTerminalInputGeneration !== armed.webInputGeneration');
    expect(seedBody).toContain('|| currentBotmuxTurnId !== armed.turnId,');
  });

  it('等待窗口从最近一次 resync 重新计时（晚到的 resync 也能等满静默窗口）', () => {
    expect(seedBody).toContain('elapsedMs: Date.now() - Math.max(armed.at, lastPtyOutputAtMs),');
  });

  it('静默窗口把网页终端输入也算作活动（arm 前刚敲的回车可能还没回显）', () => {
    expect(seedBody).toContain('const quietMs = Date.now() - Math.max(lastPtyOutputAtMs, lastWebTerminalInputAtMs);');
  });

  it('SessionStart 边界记下网页终端输入代数，arm 判据拿它比较', () => {
    const boundaryIdx = source.indexOf('SessionStart boundary recorded');
    const stampIdx = source.lastIndexOf('webTerminalInputGenerationAtBoundary = webTerminalInputGeneration;', boundaryIdx);
    expect(stampIdx).toBeGreaterThan(-1);
    expect(boundaryIdx - stampIdx).toBeLessThan(200);
    expect(timeoutBody).toContain('webInputSinceBoundary: webTerminalInputGeneration !== webTerminalInputGenerationAtBoundary,');
  });

  it('网页终端的可写输入在转发给 backend 之前登记', () => {
    const handlerStart = source.indexOf("} else if (msg.type === 'input' && typeof msg.data === 'string') {");
    const handler = source.slice(handlerStart, source.indexOf("} else if (msg.type === 'scroll'", handlerStart));
    const authIdx = handler.indexOf('if (!authedClients.has(ws)) return;');
    const stampIdx = handler.indexOf('lastWebTerminalInputAtMs = Date.now();');
    const genIdx = handler.indexOf('webTerminalInputGeneration++;');
    const writeIdx = handler.indexOf('backend?.write(msg.data);');
    expect(authIdx).toBeGreaterThan(-1);
    expect(stampIdx).toBeGreaterThan(authIdx);
    expect(genIdx).toBeGreaterThan(authIdx);
    expect(writeIdx).toBeGreaterThan(Math.max(stampIdx, genIdx));
  });

  it('arm 时记下输出代数与时间戳，重试沿用同一份（否则每次重试都会把围栏往后挪）', () => {
    expect(seedBody).toContain('outputGeneration: ptyOutputGeneration.snapshot(),');
    expect(seedBody).toContain('webInputGeneration: webTerminalInputGeneration,');
    expect(seedBody).toContain('turnId: currentBotmuxTurnId,');
    expect(seedBody).toContain('armFirstPromptTimeoutPromptSeed(observedBackend, armed, decision.retryInMs');
  });

  it('屏幕判据用输入框形状，不用裸 readyPattern；并且读渲染画面', () => {
    expect(seedBody).toContain('screenHasReadyPattern: screenShowsFramedReadyPrompt()');
    const probe = source.slice(
      source.indexOf('function screenShowsFramedReadyPrompt'),
      seedStart,
    );
    expect(probe).toContain('renderer?.rawSnapshot()');
    expect(probe).toContain('screenShowsFramedPrompt(screen, pattern)');
    expect(probe).toContain('catch { return false; }');
  });

  it('复用 post-hook 兜底的定时器，spawn/kill 的清理路径一并覆盖', () => {
    expect(seedBody).toContain('clearPostHookEvidenceFallback();');
    expect(seedBody).toContain('postHookEvidenceFallbackTimer = setTimeout(');
    expect(seedBody).toContain('idleDetector?.seedReadyEvidence()');
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
