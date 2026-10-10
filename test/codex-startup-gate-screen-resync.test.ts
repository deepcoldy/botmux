/**
 * 快照型后端（ZMX）下 codex 启动闸永不解除的回归测试。
 *
 * 缺陷链路：IdleDetector 的启动闸只认 feed() 里出现的已初始化横幅，而 ZMX 的
 * 屏幕来源是 `zmx history`（返回当前屏，不是追加字节流）。只有「新屏是旧屏的
 * 前缀扩展」才会作为 PTY 数据发出；`model: loading` → `model: <真实值>` 是原地
 * 重绘，走的是 screen resync，而 resync 按设计不喂 IdleDetector。于是启动闸永远
 * 停在 pending，排队消息在整个会话生命周期里被静默扣住。
 *
 * 夹具 zmx-history-initialized.txt 是真实抓取的 `zmx history <session>` 输出
 * （botmux 实际调用的形态，不带 --vt），仅把工作目录名匿名化。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IdleDetector, stripAnsiScreenText } from '../src/utils/idle-detector.js';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';
import { normaliseZmxHistory } from '../src/adapters/backend/zmx-backend.js';

const INITIALIZED_SCREEN = readFileSync(
  join(process.cwd(), 'test/fixtures/codex-startup/zmx-history-initialized.txt'),
  'utf8',
);

const RESUMED_HISTORY = readFileSync(
  join(process.cwd(), 'test/fixtures/codex-startup/zmx-history-resumed.txt'), 'utf8',
);

/** idle-detector.ts 内部常量，此处复述用于断言边界。 */
const QUIESCENCE_MS = 2_000;

/** 按原行宽把横幅值换掉，保持真实版面（列宽参与正则匹配）。 */
function setBannerValue(screen: string, label: string, value: string): string {
  const re = new RegExp(`^│ ${label}:.*│$`, 'm');
  const original = screen.match(re)?.[0];
  if (!original) throw new Error(`夹具缺少 ${label} 横幅行`);
  const head = `│ ${label}:${' '.repeat(Math.max(1, 13 - label.length))}${value}`;
  return screen.replace(re, `${head.padEnd(original.length - 1)}│`);
}

/** codex 初始化期间把两个值渲染成 loading，其余版面不变。 */
const LOADING_SCREEN = setBannerValue(
  setBannerValue(INITIALIZED_SCREEN, 'model', 'loading'),
  'directory',
  'loading',
);

function newDetector() {
  const detector = new IdleDetector(createCodexAdapter('/bin/codex'));
  const idle = vi.fn();
  detector.onIdle(idle);
  return { detector, idle };
}

describe('codex 启动闸：真实 renderer 到检测器的链路', () => {
  it.each(['\n', '\r\n'])('ZMX %j 换行的初始化横幅经 120x24 renderer 后仍能开闸', async (eol) => {
    const renderer = new TerminalRenderer(120, 24);
    const { detector } = newDetector();
    try {
      detector.feed(LOADING_SCREEN);
      // 与 worker resync 一样：新 renderer + 等待解析完成；不能把夹具直接交给检测器。
      await renderer.writeAndFlush(normaliseZmxHistory(INITIALIZED_SCREEN.replace(/\r?\n/g, eol)));
      expect(detector.isStartupPending()).toBe(true);
      expect(detector.observeStartupScreen(renderer.rawSnapshot({ preserveFormatting: true }))).toBe(true);
      expect(detector.isStartupPending()).toBe(false);
    } finally {
      detector.dispose();
      renderer.dispose();
    }
  });

  it('旧的已初始化横幅滚出视口后不能给仍在 loading 的当前画面开闸', async () => {
    const renderer = new TerminalRenderer(120, 24);
    const { detector } = newDetector();
    try {
      detector.feed(LOADING_SCREEN);
      await renderer.writeAndFlush(normaliseZmxHistory(`${INITIALIZED_SCREEN}\n${'old output\n'.repeat(24)}${LOADING_SCREEN}`));
      const screen = renderer.rawSnapshot({ preserveFormatting: true });
      expect(screen).not.toContain('model:       gpt-6-astra');
      expect(screen).toContain('model:        loading');
      expect(detector.observeStartupScreen(screen)).toBe(false);
      expect(detector.isStartupPending()).toBe(true);
    } finally {
      detector.dispose();
      renderer.dispose();
    }
  });
});

describe('codex 启动闸：夹具与适配器正则的契约', () => {
  const adapter = createCodexAdapter('/bin/codex');

  it('真实 zmx history 抓屏能匹配已初始化横幅（codex 改版面时这里先红）', () => {
    expect(adapter.startupReadyPattern?.test(stripAnsiScreenText(INITIALIZED_SCREEN))).toBe(true);
    expect(adapter.startupPendingPattern?.test(stripAnsiScreenText(INITIALIZED_SCREEN))).toBe(false);
  });

  it('派生出的 loading 屏确实匹配 pending 横幅（保证下面的复现不是假的）', () => {
    expect(adapter.startupPendingPattern?.test(stripAnsiScreenText(LOADING_SCREEN))).toBe(true);
    expect(adapter.startupReadyPattern?.test(stripAnsiScreenText(LOADING_SCREEN))).toBe(false);
  });
});

describe('codex 启动闸：快照后端下的复现与修复', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('复现：已初始化横幅只以屏幕快照形式到达时，feed() 侧永远解不开启动闸', () => {
    const { detector } = newDetector();
    detector.feed(LOADING_SCREEN);
    expect(detector.isStartupPending()).toBe(true);

    // ZMX 把原地重绘发成 screen resync：feed() 收不到任何已初始化横幅。
    // 仅靠时间推进（含 worker 的 90s 硬上限）也不会有任何变化。
    vi.advanceTimersByTime(90_000);
    expect(detector.isStartupPending()).toBe(true);
  });

  it('修复：用权威画面判定横幅即可解除启动闸', () => {
    const { detector } = newDetector();
    detector.feed(LOADING_SCREEN);
    expect(detector.isStartupPending()).toBe(true);

    expect(detector.observeStartupScreen(INITIALIZED_SCREEN)).toBe(true);
    expect(detector.isStartupPending()).toBe(false);
  });

  it('解除启动闸本身不产生同步 idle 边沿：仍要走完整静默判定', () => {
    const { detector, idle } = newDetector();
    detector.feed(LOADING_SCREEN);

    detector.observeStartupScreen(INITIALIZED_SCREEN);
    expect(idle).not.toHaveBeenCalled();

    // 之前被闸否决、但仍在排期中的静默判定可以继续完成——这是预期：此时
    // readyPattern 证据来自真实 feed() 数据，spinner guard 也照常生效。
    vi.advanceTimersByTime(QUIESCENCE_MS + 100);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('生产顺序（闸在静默判定到点之后才解除）不会自己产生 idle —— worker 必须兜底', () => {
    const { detector, idle } = newDetector();
    detector.feed(LOADING_SCREEN);

    // 静默定时器到点时闸还没开：quiescenceCheck() 直接 return，且不重排。
    vi.advanceTimersByTime(QUIESCENCE_MS + 100);
    expect(idle).not.toHaveBeenCalled();

    // 之后横幅才初始化（ZMX 走 resync，不会再有 feed()）。闸开了，但没有任何
    // 东西会重新驱动静默判定——所以排队消息的投递只能由 worker 侧的复查 /
    // 首轮硬上限来保证。
    expect(detector.observeStartupScreen(INITIALIZED_SCREEN)).toBe(true);
    vi.advanceTimersByTime(90_000);
    expect(idle).not.toHaveBeenCalled();
  });

  it('scrollback 里的旧横幅不能解除当前仍在 loading 的闸（下方的横幅才算数）', () => {
    const { detector } = newDetector();
    detector.feed(LOADING_SCREEN);

    // 上一代 CLI 留在 scrollback 里的已初始化横幅 + 当前这一代仍在 loading。
    const staleAbove = `${INITIALIZED_SCREEN}\n${LOADING_SCREEN}`;
    expect(detector.observeStartupScreen(staleAbove)).toBe(false);
    expect(detector.isStartupPending()).toBe(true);

    // 反过来（loading 在上、已初始化在下）才是真的初始化完成。
    expect(detector.observeStartupScreen(`${LOADING_SCREEN}\n${INITIALIZED_SCREEN}`)).toBe(true);
    expect(detector.isStartupPending()).toBe(false);
  });

  it('初始化是单调的：完成后再出现 loading 也不重新武装', () => {
    const { detector } = newDetector();
    detector.feed(LOADING_SCREEN);
    detector.observeStartupScreen(INITIALIZED_SCREEN);

    expect(detector.observeStartupScreen(LOADING_SCREEN)).toBe(false);
    expect(detector.isStartupPending()).toBe(false);
    detector.feed(LOADING_SCREEN);
    expect(detector.isStartupPending()).toBe(false);
  });

  it.each(['feed', 'observeStartupScreen'] as const)('通过 %s 得到的初始化证据跨 resync/turn reset 保留，新进程重新等待', (observe) => {
    const { detector, idle } = newDetector();
    expect(detector.isStartupPending()).toBe(false);
    expect(detector.isStartupComplete()).toBe(false);
    detector[observe](INITIALIZED_SCREEN);
    detector.reset();
    detector.resetReadyEvidence();
    expect(detector.isStartupComplete()).toBe(true);
    expect(idle).not.toHaveBeenCalled();
    const replacement = newDetector().detector;
    expect(replacement.isStartupComplete()).toBe(false);
    replacement.dispose();
    detector.dispose();
  });

  it('尚未见过 loading 横幅时，观察屏幕不会凭空制造 pending 状态', () => {
    const { detector } = newDetector();
    expect(detector.isStartupPending()).toBe(false);
    expect(detector.observeStartupScreen(INITIALIZED_SCREEN)).toBe(true);
    expect(detector.isStartupPending()).toBe(false);
  });
});

/**
 * worker.ts 不导出任何符号，按仓库既有惯例（first-prompt-timeout-repro.test.ts、
 * worker-pipe-initial-screen-order.test.ts）用源码断言把接线钉住。
 */
describe('codex 启动闸：worker 侧接线', () => {
  const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

  it('观察启动横幅必须读渲染后的画面，不能读 scrollback 或过滤后的快照', () => {
    const start = source.indexOf('function observeStartupBannerOnScreen');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n}\n', start));
    expect(body).toContain('renderer?.rawSnapshot({ preserveFormatting: true })');
    expect(body).toContain('idleDetector?.observeStartupScreen(');
    expect(body).not.toContain('recentTerminalLogTail');
    expect(body).not.toContain('renderer?.snapshot()');
  });

  it('启动闸仍 pending 时先拉一次权威画面，且不再是死路一条', () => {
    const start = source.indexOf('const releaseFirstPromptTimeout');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n  };\n', start));

    // 等不到推送就主动拉一次。
    expect(body).toContain('observeStartupBannerOnScreen()');
    // 仍在 loading 时必须重排复查，且以首轮硬上限收口——旧实现在这里直接 return，
    // 没有任何定时器，闸一旦卡住排队消息就永远发不出去。
    expect(body).toContain('FIRST_PROMPT_STARTUP_RECHECK_MS');
    expect(body).toContain('FIRST_PROMPT_HARD_TIMEOUT_MS - elapsedMs');
    expect(body).toMatch(/setTimeout\(\s*\(\) => releaseFirstPromptTimeout\(nextElapsedMs/);
  });

  it('复查节奏受首轮硬上限约束', () => {
    expect(source).toMatch(/const FIRST_PROMPT_STARTUP_RECHECK_MS = [\d_]+;/);
  });
});

describe('Codex restored ZMX history startup evidence', () => {
  it.each([false, true])('accepts the 0.154 Context footer without a banner, loading observed=%s', (loadingSeen) => {
    const { detector, idle } = newDetector();
    try {
      if (loadingSeen) detector.feed(LOADING_SCREEN);
      const history = '› Ask Codex to do anything\n  gpt-6-astra low · Context 85% used · weekly 38% left';
      expect(detector.observeStartupHistory(history)).toBe(true);
      expect(detector.isStartupPending()).toBe(false);
      expect(detector.isStartupComplete()).toBe(true);
      expect(idle).not.toHaveBeenCalled();
    } finally { detector.dispose(); }
  });

  it.each(['~/Code/example', '/tmp/project'])('accepts a compact Context footer with directory %s', (directory) => {
    const { detector, idle } = newDetector();
    try {
      detector.feed(LOADING_SCREEN);
      const history = `› Ask Codex to do anything\n  custom-model medium · ${directory} · Context 85% used · weekly 38% left`;
      expect(detector.observeStartupHistory(history)).toBe(true);
      expect(detector.isStartupPending()).toBe(false);
      expect(detector.isStartupComplete()).toBe(true);
      expect(idle).not.toHaveBeenCalled();
    } finally { detector.dispose(); }
  });

  it('accepts the native initialized banner above a long conversation when its bottom composer is Ready', () => {
    const { detector, idle } = newDetector();
    try {
      const banner = INITIALIZED_SCREEN.split('\n\n  Tip:')[0];
      const history = banner + '\n' + 'old output\n'.repeat(60)
        + RESUMED_HISTORY.slice(RESUMED_HISTORY.lastIndexOf('›'));
      expect(detector.observeStartupHistory(history)).toBe(true);
      expect(detector.isStartupComplete()).toBe(true);
      expect(idle).not.toHaveBeenCalled();
    } finally { detector.dispose(); }
  });
  it.each([false, true])('releases resumed history without a banner, loading observed=%s', (loadingSeen) => {
    const { detector, idle } = newDetector();
    try {
      if (loadingSeen) detector.feed(LOADING_SCREEN);
      // The restoration marker can be far outside the synthetic 24-row viewport.
      const history = RESUMED_HISTORY.replace('• Previous conversation restored.', 'old output\n'.repeat(60));
      expect(detector.observeStartupHistory(history)).toBe(true);
      expect(detector.isStartupPending()).toBe(false);
      expect(detector.isStartupComplete()).toBe(true);
      expect(idle).not.toHaveBeenCalled();
      detector.reset();
      expect(detector.observeStartupHistory(history)).toBe(false);
      expect(detector.isStartupComplete()).toBe(true);
    } finally { detector.dispose(); }
  });

  it.each([
    ['no restoration marker or initialized footer', '› Ask Codex to do anything\n  custom-model medium · ~/Code/example · weekly 45% left'],
    ['footer before initialization', RESUMED_HISTORY.replace('› Ask', '│ model: loading │\n│ directory: loading │\n› Ask')],
    ['resuming', RESUMED_HISTORY.replace('› Ask', 'Resuming session...\n› Ask')],
    ['busy', RESUMED_HISTORY.replace('› Ask', 'Working (esc to interrupt)\n› Ask')],
    ['capacity queue', RESUMED_HISTORY.replace('› Ask', 'Queued for capacity\n› Ask')],
    ['draft', RESUMED_HISTORY.replace('› Ask Codex to do anything', '› unsent draft')],
    ['picker', RESUMED_HISTORY.replace('› Ask Codex to do anything', '› 1. Continue')],
    ['dialog after footer', RESUMED_HISTORY + '\nPress enter to continue'],
    ['stale ready before loading', RESUMED_HISTORY + '\n' + LOADING_SCREEN],
    ['uninitialized footer', RESUMED_HISTORY.replace(' · Ready', '').replace(/ · Context \d+% used/, '')],
    ['context footer with a draft', '› unsent draft\n  gpt-6-astra low · Context 85% used'],
    ['context footer before loading', '› Ask Codex to do anything\n  gpt-6-astra low · Context 85% used\n' + LOADING_SCREEN],
  ])('keeps input held for %s', (_name, history) => {
    const { detector, idle } = newDetector();
    try {
      detector.feed(LOADING_SCREEN);
      expect(detector.observeStartupHistory(history)).toBe(false);
      expect(detector.isStartupPending()).toBe(true);
      expect(idle).not.toHaveBeenCalled();
    } finally { detector.dispose(); }
  });
});
