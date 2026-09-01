/**
 * 复现 "First prompt timeout" 的触发条件。
 *
 * 背景：worker.ts 在每次 spawn CLI 时 armed 一个 15s 定时器
 * (FIRST_PROMPT_TIMEOUT_MS)。若届时 IdleDetector 还没判定空闲，就打
 * "First prompt timeout — enabling screen updates and flushing queued messages"
 * 并强行把排队的首条消息灌进 PTY（实测使首条消息延迟从 p50 1s 变成 14s）。
 *
 * 这组测试把「什么情况下 15s 内判不出空闲」固化下来。
 *
 * Run:  pnpm vitest run test/first-prompt-timeout-repro.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IdleDetector } from '../src/utils/idle-detector.js';
import type { CliAdapter } from '../src/adapters/cli/types.js';

/** claude-code 适配器的真实 readyPattern（src/adapters/cli/claude-code.ts:1147）。 */
const CLAUDE_READY = /❯/;

/** idle-detector.ts 内部常量，此处复述用于断言边界。 */
const QUIESCENCE_MS = 2_000;
const SPINNER_GUARD_MS = 3_000;
/** worker.ts:1368 FIRST_PROMPT_TIMEOUT_MS —— 判不出空闲的预算。 */
const FIRST_PROMPT_TIMEOUT_MS = 15_000;

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

function setup(readyPattern?: RegExp) {
  const detector = new IdleDetector(makeCli(readyPattern));
  const cb = vi.fn();
  detector.onIdle(cb);
  return { detector, cb };
}

describe('First prompt timeout: 触发条件', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('重绘间隔 < 2s 时，整个 15s 预算内都判不出空闲（这就是超时的直接成因）', () => {
    const { detector, cb } = setup(CLAUDE_READY);
    detector.feed('❯ ');                       // 提示符已经出现

    // Ink TUI 周期性重绘状态栏。每次 feed() 都 clearTimer() 并重排 2000ms，
    // 所以只要间隔小于 QUIESCENCE_MS，静默窗口永远排不满。
    let elapsed = 0;
    while (elapsed < FIRST_PROMPT_TIMEOUT_MS) {
      vi.advanceTimersByTime(1_500);
      elapsed += 1_500;
      detector.feed('\x1b[2Ktokens: 1234  ctx: 45%');
    }

    expect(cb).not.toHaveBeenCalled();         // → worker 打 First prompt timeout
    detector.dispose();
  });

  it('只要出现一次 >2s 的间隙就会判定空闲（同样的总输出量，只是时序不同）', () => {
    const { detector, cb } = setup(CLAUDE_READY);
    detector.feed('❯ ');
    vi.advanceTimersByTime(QUIESCENCE_MS + 100);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('提示符出现前的 spinner 会让判定再推迟约 1.2s（max(❯+2.0s, spinner+3.2s)）', () => {
    const { detector, cb } = setup(CLAUDE_READY);

    detector.feed('⠋ loading plugins');        // lastSpinnerAt = now（readySeen 尚为 false）
    detector.feed('❯ ');                       // readySeen = true，此后 spinner 不再计时

    vi.advanceTimersByTime(QUIESCENCE_MS);
    // quiescenceCheck: sinceSpinner ≈ 2000 < SPINNER_GUARD_MS → 重排 (3000-2000+200)
    expect(cb).not.toHaveBeenCalled();

    vi.advanceTimersByTime(SPINNER_GUARD_MS - QUIESCENCE_MS + 200);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('提示符未出现时，静默判定被完全抑制（静默再久也不算空闲）', () => {
    const { detector, cb } = setup(CLAUDE_READY);

    detector.feed('Loading MCP servers...');   // 没有 ❯
    vi.advanceTimersByTime(60_000);
    expect(cb).not.toHaveBeenCalled();

    detector.feed('❯ ');
    vi.advanceTimersByTime(QUIESCENCE_MS + 100);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('SessionStart 边界丢弃旧提示符证据，必须等一个新的 ❯ —— 这会吃掉 15s 预算', () => {
    const { detector, cb } = setup(CLAUDE_READY);

    detector.feed('❯ ');                       // hook 触发前就渲染过提示符
    detector.resetReadyEvidence();             // worker 在 SessionStart 边界调用

    vi.advanceTimersByTime(10_000);            // 旧证据作废，光静默不够
    expect(cb).not.toHaveBeenCalled();

    detector.feed('❯ ');                       // 新提示符
    vi.advanceTimersByTime(QUIESCENCE_MS + 100);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  // ── 修复：seedReadyEvidence() ──────────────────────────────────────────
  // 实测 6/6 超时都是 readySeen=false + msSincePty≈3-4s + 屏幕上确有 ❯，
  // 即「提示符在 resetReadyEvidence() 之前就渲染好了，此后不再重绘」。

  it('修复：补种证据后，被 !readySeen 永久抑制的静默判定得以完成', () => {
    const { detector, cb } = setup(CLAUDE_READY);

    detector.feed('❯ ');            // 边界之前提示符已渲染
    detector.resetReadyEvidence();  // SessionStart 边界丢弃证据
    detector.feed('status bar');    // 之后只有状态栏更新，不含 ❯

    vi.advanceTimersByTime(10_000); // 静默远超 2s，仍判不出（复现原缺陷）
    expect(cb).not.toHaveBeenCalled();

    // 调用方已自行确认 PTY 静默 + 屏幕含 readyPattern
    expect(detector.seedReadyEvidence()).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('修复不绕过 spinner guard：补种后仍需等满 3.2s', () => {
    const { detector, cb } = setup(CLAUDE_READY);

    detector.feed('⠋ still loading');  // lastSpinnerAt = now
    detector.resetReadyEvidence();     // 注意：这会把 lastSpinnerAt 清零
    detector.feed('⠋ still loading');  // 重新置上 spinner 时刻

    expect(detector.seedReadyEvidence()).toBe(true);
    expect(cb).not.toHaveBeenCalled();          // spinner guard 拦住

    vi.advanceTimersByTime(SPINNER_GUARD_MS + 200);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('已就绪或已空闲时补种是幂等的空操作', () => {
    const { detector, cb } = setup(CLAUDE_READY);
    detector.feed('❯ ');                        // readySeen 已为 true
    expect(detector.seedReadyEvidence()).toBe(false);

    vi.advanceTimersByTime(QUIESCENCE_MS + 100);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(detector.seedReadyEvidence()).toBe(false);   // 已 idle
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('边界值：恰好 2s 的间隙足够，1.9s 不够', () => {
    const a = setup(CLAUDE_READY);
    a.detector.feed('❯ ');
    vi.advanceTimersByTime(1_900);
    expect(a.cb).not.toHaveBeenCalled();
    a.detector.dispose();

    const b = setup(CLAUDE_READY);
    b.detector.feed('❯ ');
    vi.advanceTimersByTime(QUIESCENCE_MS);
    expect(b.cb).toHaveBeenCalledTimes(1);
    b.detector.dispose();
  });
});

/**
 * 上面那组只覆盖 IdleDetector 自身。判据逻辑在 input-gate.ts
 * 的 decidePostHookPromptEvidence()（见 test/input-gate.test.ts），worker 这边
 * 剩下的是「取什么数据、什么时候清定时器」—— worker.ts 不导出任何符号，按仓库
 * 既有惯例（worker-pipe-initial-screen-order.test.ts）用源码断言把接线钉住。
 */
describe('First prompt timeout: worker 侧兜底接线', () => {
  const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
  const fallbackStart = source.indexOf('function armPostHookPromptEvidenceFallback');
  const fallbackBody = source.slice(fallbackStart, source.indexOf('\n}\n', fallbackStart));

  it('兜底判据走 decidePostHookPromptEvidence，三个动作都接线', () => {
    expect(fallbackStart).toBeGreaterThan(-1);
    expect(fallbackBody).toContain('decidePostHookPromptEvidence({');
    expect(fallbackBody).toContain("if (decision.action === 'stop') return;");
    expect(fallbackBody).toContain("if (decision.action === 'retry')");
    // retry 必须用决策返回的延时重排自身，否则轮询节奏与判据脱钩。
    expect(fallbackBody).toContain('armPostHookPromptEvidenceFallback(startedAt, decision.retryInMs');
    // accept 只补种证据，仍由 IdleDetector 走完整静默判定。
    expect(fallbackBody).toContain('idleDetector?.seedReadyEvidence()');
  });

  it('提示符必须读渲染后的画面，不能读 PTY 追加日志', () => {
    // recentTerminalLogTail() 是 stripAnsi 后的 scrollback：TUI 擦掉的旧 ❯ 在
    // 那里照样匹配，会把首条消息灌进还没就绪的界面。必须用 rawSnapshot()；
    // snapshot() 也不行——它按设计过滤掉 bare prompt 行，恰好把 ❯ 滤没。
    const screenProbe = source.slice(
      source.indexOf('function screenShowsReadyPattern'),
      source.indexOf('function armPostHookPromptEvidenceFallback'),
    );
    expect(screenProbe).toContain('renderer?.rawSnapshot()');
    expect(screenProbe).not.toContain('recentTerminalLogTail');
    expect(screenProbe).not.toContain('renderer?.snapshot()');
    expect(fallbackBody).toContain('screenHasReadyPattern: screenShowsReadyPattern()');
    expect(fallbackBody).not.toContain('recentTerminalLogTail');
    // renderer 尚未就绪时按「屏幕上没有提示符」处理，继续轮询而不是抛错。
    expect(screenProbe).toContain('catch { return false; }');
  });

  it('兜底只在 SessionStart 边界 arm —— 这是挡住启动选择器的唯一保障', () => {
    // 选择器停在那儿等按键时屏幕是【静的】（这正是它当初骗过 readyPattern 的
    // 原因），所以静默窗口挡不住它。真正挡住它的是 arm 时机：SessionStart hook
    // 在选择器还没过去时不触发，兜底也就不会上场。这条断言一旦松掉（比如为了
    // 修 re-attach 把 arm 提前到收信号之前），选择器就重新暴露在射程内。
    const armCallIdx = source.indexOf('armPostHookPromptEvidenceFallback();');
    const boundaryIdx = source.indexOf('SessionStart boundary recorded');
    expect(armCallIdx).toBeGreaterThan(boundaryIdx);
    expect(armCallIdx - boundaryIdx).toBeLessThan(200);   // 紧挨着边界日志

    // 且这段必须落在 session_ready 消息分支内 —— 收到 ready 信号才 arm。
    const caseIdx = source.lastIndexOf("case 'session_ready':", armCallIdx);
    expect(caseIdx).toBeGreaterThan(-1);
    expect(armCallIdx - caseIdx).toBeLessThan(2_000);
  });

  it('兜底只对 source=startup arm —— resume/clear/compact 不进兜底射程', () => {
    // 兜底是为「新建会话画完提示符后不再重绘」而生。resume/clear/compact 会在
    // 边界后自行重绘一个新 ❯，fence 靠真证据自解；给它们 arm 反而会让回放中
    // 残留的历史 ❯ 满足静默门控、提前接受边界前的旧提示符，破坏 fresh-evidence
    // fence。所以 arm 调用必须被 startup gate 守着，而不是裸调用。
    const armLineStart = source.lastIndexOf('\n', source.indexOf('armPostHookPromptEvidenceFallback();'));
    const armLine = source.slice(armLineStart, source.indexOf('armPostHookPromptEvidenceFallback();') + 'armPostHookPromptEvidenceFallback();'.length);
    // arm 必须由 startup 判据守卫，不能裸调用（否则 resume 也会 arm）。
    expect(armLine).toContain('if (armPostHookFallback)');

    // 判据本身走 input-gate 的纯函数，并且喂进去的是 SessionStart 的 msg.source。
    const caseStart = source.indexOf("case 'session_ready':");
    const caseBody = source.slice(caseStart, source.indexOf('armPostHookPromptEvidenceFallback();', caseStart));
    expect(caseBody).toContain('shouldArmPostHookPromptEvidenceFallback({');
    expect(caseBody).toContain('source: msg.source,');

    // fence 本身（awaitingPostSessionStartPromptEvidence = true）必须对所有 source
    // 都设 —— resume 依赖它等真证据；只有 arm 才收窄到 startup。
    expect(caseBody).toContain('awaitingPostSessionStartPromptEvidence = true;');
  });

  it('每个清除等待标记的位置都必须同时清定时器', () => {
    // 否则陈旧回调会活到下一个周期。回调首行的 stillWaiting 检查只是第二道
    // 防线，不能替代生命周期清理。
    // 只看赋值，跳过 `let ...= false` 的声明本身。
    const assignments = [...source.matchAll(/(?<!let )awaitingPostSessionStartPromptEvidence = false;/g)];
    expect(assignments.length).toBeGreaterThanOrEqual(5);
    const missing = assignments.filter(m => !/^\s*clearPostHookEvidenceFallback\(\);/.test(
      source.slice(m.index + m[0].length),
    ));
    expect(missing.map(m => source.slice(m.index, m.index + 120))).toEqual([]);
  });

  it('定时期加的诊断日志不留在上游', () => {
    expect(source).not.toContain('First-prompt-timeout diagnostic');
    const detectorSource = readFileSync(join(process.cwd(), 'src/utils/idle-detector.ts'), 'utf8');
    expect(detectorSource).not.toContain('get readyPatternSeen');
    expect(detectorSource).not.toContain('get msSinceSpinner');
  });
});
