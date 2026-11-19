/**
 * ZCode busy/ready anchors.
 *
 * Every string below was captured from the live native TUI (zcode 0.16.9,
 * 160x45) on 2026-10-18, not written by hand. Two anchor families exist:
 *
 *   busy  — bottom status row `⠹ esc to interrupt` (spinner glyph varies at
 *           80ms, so only the words are anchored)
 *   idle  — composer placeholder `Type a prompt` / `输入提示词`
 *
 * The bug these tests pin down: without a readyPattern, a long tool run that
 * emits no PTY bytes for 2s (e.g. `sleep 180`) looked like an idle prompt, so
 * the worker wrote the next Feishu message into a busy TUI. ZCode then parked
 * it in its own queue panel and never executed it.
 *
 * Run:  pnpm vitest run test/zcode-idle-anchors.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createZcodeAdapter, ZCODE_BUSY_PLACEHOLDER, ZCODE_QUEUE_PANEL } from '../src/adapters/cli/zcode.js';
import { busyProbeRegion } from '../src/utils/busy-probe.js';
import { IdleDetector } from '../src/utils/idle-detector.js';

/** Live pane tail, busy turn (`sleep 8; echo TICK-*` running). */
const BUSY_SCREEN = [
  '                                                                                                                   ▼',
  '',
  '   Tool Bash running',
  '     command: sleep 8; echo TICK-5',
  '',
  '',
  ' ╭─ Yolo ──────────────────────────────────────────────────────────────────────────────────────────────────────────╮',
  ' │ Type to queue input                                                                                             │',
  ' │                                                                                                                 │',
  ' │                                                                                                                 │',
  ' │ deepseek-flash 93c45030-2f68-4023-a6c4-d2cdf04543c3 | high                                                      │',
  ' ╰─────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯',
  '  ⠹ esc to interrupt                                                                                           48.9K   /home/user/project',
].join('\n');

/** Same pane, turn finished: the only change is placeholder + status row. */
const IDLE_SCREEN = [
  '                                                                                                                   ▼',
  '',
  '   5 次独立 Bash 调用已按顺序全部完成，每次间隔前一条命令执行后才发起下一条。',
  '',
  '',
  ' ╭─ Yolo ──────────────────────────────────────────────────────────────────────────────────────────────────────────╮',
  ' │ Type a prompt                                                                                                   │',
  ' │                                                                                                                 │',
  ' │                                                                                                                 │',
  ' │ deepseek-flash 93c45030-2f68-4023-a6c4-d2cdf04543c3 | high                                                      │',
  ' ╰─────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯',
  '                                                                                                          18.6K (9%)   /home/user/project',
].join('\n');

/** Parked submit: the queue panel the user sees after typing while busy. */
const QUEUE_PANEL_SCREEN = [
  ' ┌─ Queue (1) ─────────────────────────────────────────────────────────────────────────────────────────────────────┐',
  ' │ Submitted after the next tool call.                                                                             │',
  ' │ 1.  停止，不要再执行 STEP-4/5/6，直接回复 STOPPED-INTERRUPT-2                                                   │',
  ' └─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘',
  ' ╭─ Yolo ──────────────────────────────────────────────────────────────────────────────────────────────────────────╮',
  ' │ Type to queue input                                                                                             │',
  ' ╰─────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯',
  '  ⠇ esc to interrupt                                                                                      18.8K   /tmp/zq-test',
].join('\n');

/** tmux `capture-pane -e` output carries SGR lead-ins before each line. */
const BUSY_SCREEN_ANSI = [
  '\x1b[48;2;15;20;25m \x1b[38;2;125;211;252m\x1b[48;2;22;27;34m╭─ Yolo ─────╮\x1b[39m',
  '\x1b[48;2;15;20;25m \x1b[38;2;125;211;252m\x1b[48;2;22;27;34m│\x1b[38;2;255;255;255m \x1b[38;2;148;163;184mType to queue input\x1b[38;2;255;255;255m   │\x1b[39m',
  '\x1b[48;2;15;20;25m  \x1b[38;2;125;211;252m⠹\x1b[38;2;148;163;184m esc to interrupt\x1b[38;2;255;255;255m   18.4K (9%)   /tmp/zq-test\x1b[39m',
].join('\n');

describe('zcode adapter: idle anchors', () => {
  const adapter = createZcodeAdapter('/bin/zcode');

  it('defines both anchors (previously neither existed)', () => {
    expect(adapter.busyPattern).toBeDefined();
    expect(adapter.readyPattern).toBeDefined();
  });

  it('busyPattern matches the live busy footer, not the idle pane', () => {
    const busy = adapter.busyPattern!;
    expect(busy.test(busyProbeRegion(BUSY_SCREEN))).toBe(true);
    expect(busy.test(busyProbeRegion(IDLE_SCREEN))).toBe(false);
    // The queue panel keeps the busy footer too — parking is still "busy".
    expect(busy.test(busyProbeRegion(QUEUE_PANEL_SCREEN))).toBe(true);
  });

  it('busyPattern survives the animated spinner frame and ANSI SGR lead-ins', () => {
    const busy = adapter.busyPattern!;
    // All 10 frames of ZCode's braille spinner must match; the glyph itself is
    // never part of the anchor.
    for (const frame of ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']) {
      expect(busy.test(`  ${frame} esc to interrupt   18.4K (9%)`)).toBe(true);
    }
    expect(busy.test(busyProbeRegion(BUSY_SCREEN_ANSI))).toBe(true);
  });

  it('busyPattern does not fire on the words alone in prose or on the idle hint', () => {
    const busy = adapter.busyPattern!;
    expect(busy.test('press esc to interrupt')).toBe(false);
    expect(busy.test('The flag says "esc to interrupt" in the docs.')).toBe(false);
  });

  it('readyPattern matches the idle placeholder in both locales', () => {
    const ready = adapter.readyPattern!;
    expect(ready.test(busyProbeRegion(IDLE_SCREEN))).toBe(true);
    expect(ready.test(' │ Type a prompt')).toBe(true);
    expect(ready.test(' │ 输入提示词')).toBe(true);
  });

  it('readyPattern never matches the busy or queued placeholder', () => {
    const ready = adapter.readyPattern!;
    expect(ready.test(busyProbeRegion(BUSY_SCREEN))).toBe(false);
    expect(ready.test(' │ Type to queue input')).toBe(false);
    expect(ready.test(' │ 输入内容会排队')).toBe(false);
    expect(ready.test(busyProbeRegion(QUEUE_PANEL_SCREEN))).toBe(false);
    // The panel hint mentions tool calls, not the composer.
    expect(ready.test(' │ Submitted after the next tool call.')).toBe(false);
  });

  it('busy-placeholder and queue-panel anchors cover exactly the busy states', () => {
    // Pinned so an upstream wording change fails here instead of silently
    // turning readyPattern into "anything that is not the busy footer".
    expect(ZCODE_BUSY_PLACEHOLDER.test(' │ Type to queue input')).toBe(true);
    expect(ZCODE_BUSY_PLACEHOLDER.test(' │ 输入内容会排队')).toBe(true);
    expect(ZCODE_BUSY_PLACEHOLDER.test(' │ Type a prompt')).toBe(false);

    expect(ZCODE_QUEUE_PANEL.test(' │ Submitted after the next tool call.')).toBe(true);
    expect(ZCODE_QUEUE_PANEL.test(' │ 下一次工具调用后提交。')).toBe(true);
    expect(ZCODE_QUEUE_PANEL.test(' │ Type a prompt')).toBe(false);
  });

  it('does not opt into type-ahead: parked submits are dropped by ZCode', () => {
    // Measured on 0.16.9: a submit typed during a turn lands in the queue panel
    // and is NOT drained when the turn ends (session_input stays `admitted`).
    // Enabling type-ahead would therefore silently discard user messages.
    expect(adapter.supportsTypeAhead).toBeUndefined();
  });

  it('writes one message per idle edge', () => {
    // The 22:46 incident wrote three buffered messages back-to-back after a
    // single idle; only the first ran. postTerminalPromptFence makes
    // shouldStopPendingBatch() stop the flush after one write.
    expect(adapter.postTerminalPromptFence).toBe(true);
  });

  it('interrupts with Escape, because Ctrl+C exits the CLI', () => {
    // Verified on 0.16.9: one Ctrl+C during `sleep 40` killed the whole zcode
    // process (tmux session gone). Escape aborted the same turn and left the
    // composer usable. Both the card's Stop button (card-handler stop_turn)
    // and `/stop` go through handleTermAction(), which normalises interrupt
    // keys to this field; handleExactTurnInterrupt() reads it too.
    expect(adapter.interruptKey).toBe('esc');
  });
});

describe('zcode IdleDetector: a silent long tool run is not idle', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('owns no idle while the busy footer is on screen (the 22:46 root cause)', () => {
    const detector = new IdleDetector(createZcodeAdapter('/bin/zcode'));
    const onIdle = vi.fn();
    detector.onIdle(onIdle);

    // A turn started: the TUI paints the busy footer.
    detector.feed(BUSY_SCREEN);
    // `sleep 180` emits nothing for minutes. Quiescence alone used to declare
    // this idle after 2s and flush the next Feishu message into the composer.
    vi.advanceTimersByTime(180_000);
    expect(onIdle).not.toHaveBeenCalled();
    detector.dispose();
  });

  it('fires idle only once the idle placeholder is actually drawn', () => {
    const detector = new IdleDetector(createZcodeAdapter('/bin/zcode'));
    const onIdle = vi.fn();
    detector.onIdle(onIdle);

    detector.feed(BUSY_SCREEN);
    vi.advanceTimersByTime(120_000);
    expect(onIdle).not.toHaveBeenCalled();

    // Turn ends; the composer flips back to the idle placeholder.
    detector.feed(IDLE_SCREEN);
    vi.advanceTimersByTime(2_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    detector.dispose();
  });
});

// ─── Preemption: a new message stops the running turn ─────────────────────

/**
 * The concrete failure that motivated this adapter: ZCode rented a GPU, the
 * user said "stop and release it", and the message was parked in the queue
 * panel until the turn they were trying to abort finished — by which point the
 * money was spent. Waiting for idle is not an acceptable answer here.
 *
 * These tests drive the real worker handler through `vm`, the same technique
 * `worker-exact-interrupt.test.ts` uses, so the assertions track the shipping
 * code rather than a copy of it.
 */
describe('zcode preemption of a running turn', () => {
  it('adapter opts in and uses Escape as the interrupt', () => {
    const adapter = createZcodeAdapter('/bin/zcode');
    expect(adapter.preemptsOnNewMessage).toBe(true);
    expect(adapter.interruptKey).toBe('esc');
  });
});
