/**
 * Unit tests for IdleDetector.
 *
 * Covers constructor, feed(), onIdle(), completion pattern matching,
 * quiescence detection, ANSI stripping, reset(), dispose(), and edge cases.
 *
 * Run:  pnpm vitest run test/idle-detector.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IdleDetector } from '../src/utils/idle-detector.js';
import type { CliAdapter } from '../src/adapters/cli/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Build a minimal CliAdapter stub with the given patterns. */
function makeCli(opts: {
  completionPattern?: RegExp;
  readyPattern?: RegExp;
} = {}): CliAdapter {
  return {
    id: 'test-cli',
    resolvedBin: '/usr/bin/test-cli',
    buildArgs: () => [],
    writeInput: async () => {},
    completionPattern: opts.completionPattern,
    readyPattern: opts.readyPattern,
    systemHints: [],
    altScreen: false,
  };
}

// ─── Constructor ──────────────────────────────────────────────────────────

describe('IdleDetector: constructor', () => {
  it('should accept a CliAdapter with completionPattern', () => {
    const cli = makeCli({ completionPattern: /\$\s*$/ });
    const detector = new IdleDetector(cli);
    expect(detector).toBeInstanceOf(IdleDetector);
    detector.dispose();
  });

  it('should accept a CliAdapter without completionPattern', () => {
    const cli = makeCli();
    const detector = new IdleDetector(cli);
    expect(detector).toBeInstanceOf(IdleDetector);
    detector.dispose();
  });

  it('should accept a CliAdapter with readyPattern', () => {
    const cli = makeCli({ readyPattern: />\s*$/ });
    const detector = new IdleDetector(cli);
    expect(detector).toBeInstanceOf(IdleDetector);
    detector.dispose();
  });
});

// ─── onIdle callback ──────────────────────────────────────────────────────

describe('IdleDetector: onIdle()', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should register a callback that fires on idle', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('some output');
    // Quiescence timeout is 2000ms, then spinner guard check
    vi.advanceTimersByTime(2000);
    // Spinner guard is 3000ms from last spinner; since lastSpinnerAt = 0,
    // Date.now() - 0 should be > 3000 after advancing enough time
    vi.advanceTimersByTime(3500);

    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should not fire callback if none registered', () => {
    const detector = new IdleDetector(makeCli());
    // No callback registered, should not throw
    detector.feed('some output');
    vi.advanceTimersByTime(10000);
    detector.dispose();
  });
});

// ─── Completion pattern matching ──────────────────────────────────────────

describe('IdleDetector: completion pattern', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should fire idle when completion pattern is matched', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /\$ $/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('command output\n$ ');
    // Completion pattern triggers a 500ms delay
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should not fire idle when pattern does not match', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /\$ $/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('still working...');
    vi.advanceTimersByTime(500);
    expect(cb).not.toHaveBeenCalled();
    detector.dispose();
  });

  it('should detect pattern built up across multiple feed() calls', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /DONE>$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('DON');
    vi.advanceTimersByTime(100);
    detector.feed('E>');
    // After second feed, outputTail contains "DONE>", pattern matches
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });
});

// ─── Quiescence detection ─────────────────────────────────────────────────

describe('IdleDetector: quiescence detection', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should fire idle after PTY silence (no spinner)', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);

    // Feed plain text (no spinner chars)
    detector.feed('hello world');

    // 2000ms quiescence timer fires, then quiescenceCheck runs
    // lastSpinnerAt = 0, so sinceSpinner = Date.now() which is > 3000ms from epoch
    // with fake timers, Date.now() starts at some value; advance enough
    vi.advanceTimersByTime(2000);
    // After quiescence check, spinner guard needs Date.now() - lastSpinnerAt >= 3000
    // lastSpinnerAt is 0. Date.now() in vitest fake timers starts at real time, so should pass.
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should delay idle if spinner was recently seen', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);

    // Feed spinner character (⠋ = U+280B, in SPINNER_RE)
    detector.feed('loading ⠋');

    vi.advanceTimersByTime(2000);
    // Spinner was just seen, so spinner guard delays idle
    expect(cb).not.toHaveBeenCalled();

    // Advance past spinner guard (3000ms) + buffer (200ms)
    vi.advanceTimersByTime(3500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should reset quiescence timer on each new feed', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('output 1');
    vi.advanceTimersByTime(1500);  // Not yet 2000ms
    expect(cb).not.toHaveBeenCalled();

    // New data resets the timer
    detector.feed('output 2');
    vi.advanceTimersByTime(1500);  // 1500ms from last feed, not 3000ms total
    expect(cb).not.toHaveBeenCalled();

    // Now let it expire
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should suppress quiescence when readyPattern is set but not yet seen', () => {
    const detector = new IdleDetector(makeCli({ readyPattern: /READY>/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('still loading...');
    vi.advanceTimersByTime(10000);  // Even after long silence
    expect(cb).not.toHaveBeenCalled();

    // Now ready pattern appears
    detector.feed('READY>');
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });
});

// ─── ANSI stripping ──────────────────────────────────────────────────────

describe('IdleDetector: ANSI stripping', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should strip CSI sequences before pattern matching', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /DONE$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    // Feed "DONE" wrapped in ANSI color codes
    detector.feed('\x1b[32mDONE\x1b[0m');
    // After stripping: "DONE"
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should convert CSI cursor-forward to spaces', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /A {3}B$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    // \x1b[3C = move cursor forward 3 positions -> 3 spaces
    detector.feed('A\x1b[3CB');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should strip OSC sequences (title changes)', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /prompt>$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('\x1b]0;My Terminal\x07prompt>');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should strip character set designation sequences', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /ready$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('\x1b(0ready');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });
});

// ─── feed() behavior ─────────────────────────────────────────────────────

describe('IdleDetector: feed()', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should ignore data after already idle', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /DONE$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('DONE');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);

    // Feed more data after idle — should be ignored
    cb.mockClear();
    detector.feed('more data DONE');
    vi.advanceTimersByTime(500);
    expect(cb).not.toHaveBeenCalled();
    detector.dispose();
  });

  it('should keep only last 500 chars in outputTail', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /END$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    // Feed 600 chars of padding followed by "END" — only last 500 visible
    const padding = 'x'.repeat(600);
    detector.feed(padding + 'END');
    vi.advanceTimersByTime(500);
    // "END" should still be in the last 500 chars
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should not detect pattern pushed out of 500-char tail', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /^MARKER/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('MARKER');
    // Now push MARKER out of the tail buffer
    detector.feed('y'.repeat(500));
    vi.advanceTimersByTime(10000);
    // The pattern /^MARKER/ won't match from tail since it's been overwritten
    // It will go through quiescence instead
    expect(cb).toHaveBeenCalled();
    detector.dispose();
  });
});

// ─── reset() ──────────────────────────────────────────────────────────────

describe('IdleDetector: reset()', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should allow detecting idle again after reset', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /DONE$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    // First idle
    detector.feed('DONE');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);

    // Reset and trigger again
    detector.reset();
    detector.feed('DONE');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(2);
    detector.dispose();
  });

  it('should clear outputTail on reset', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /DONE$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    // Feed partial pattern
    detector.feed('DON');
    detector.reset();

    // Feed the remainder — should NOT match since tail was cleared
    detector.feed('E');
    vi.advanceTimersByTime(500);
    expect(cb).not.toHaveBeenCalled();

    // Let quiescence handle it instead (need to wait past spinner guard)
    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should cancel pending timers on reset', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('data');
    // Timer is pending (2000ms)
    vi.advanceTimersByTime(1000);
    detector.reset();

    // Original timer should have been cleared
    vi.advanceTimersByTime(2000);
    expect(cb).not.toHaveBeenCalled();
    detector.dispose();
  });

  it('should reset readySeen flag so quiescence is suppressed again', () => {
    const detector = new IdleDetector(makeCli({ readyPattern: /READY>/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    // See ready pattern, then go idle
    detector.feed('READY>');
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(1);

    // After reset, readySeen is false again — quiescence suppressed
    detector.reset();
    detector.feed('output without ready');
    vi.advanceTimersByTime(10000);
    expect(cb).toHaveBeenCalledTimes(1);  // Still 1, no new idle
    detector.dispose();
  });

  it('should set lastSpinnerAt to current time on reset', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);

    // Advance time so lastSpinnerAt (initially 0) is far in the past
    vi.advanceTimersByTime(10000);

    // Reset sets lastSpinnerAt = Date.now(), which acts as a spinner guard
    detector.reset();
    detector.feed('output');

    // After 2000ms quiescence, the spinner guard should still be active
    // because lastSpinnerAt was just set to Date.now()
    vi.advanceTimersByTime(2000);
    expect(cb).not.toHaveBeenCalled();

    // After spinner guard expires (3000ms + 200ms from reset)
    vi.advanceTimersByTime(1500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });
});

// ─── dispose() ────────────────────────────────────────────────────────────

describe('IdleDetector: dispose()', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should clear pending timers', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('data');
    detector.dispose();

    vi.advanceTimersByTime(10000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('should null out the callback', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /DONE$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.dispose();

    // Reset to un-idle, then trigger — callback should be null
    detector.reset();
    detector.feed('DONE');
    vi.advanceTimersByTime(500);
    expect(cb).not.toHaveBeenCalled();
  });
});

// ─── Spinner interaction ──────────────────────────────────────────────────

describe('IdleDetector: spinner handling', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should not treat spinner chars as spinners when readyPattern already seen', () => {
    // When readySeen is true, spinner chars in status bar should be ignored
    const detector = new IdleDetector(makeCli({ readyPattern: /READY>/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('READY>');
    // readySeen is now true; feed a dot spinner — should NOT update lastSpinnerAt
    vi.advanceTimersByTime(100);
    detector.feed('\u00B7');  // middle dot ·
    vi.advanceTimersByTime(2000);
    // Should idle without spinner guard delay
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should not update spinner timestamp when completion pattern matches', () => {
    // Spinner chars that are part of the completion marker should be ignored
    const detector = new IdleDetector(makeCli({
      completionPattern: /\u2738$/,  // ✸ — a decorative spinner-like char
    }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('\u2738');
    // Should trigger completion path (500ms), not be blocked by spinner guard
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────

describe('IdleDetector: edge cases', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should handle rapid sequential feed calls', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /PROMPT>$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    // Rapid-fire feeds
    for (let i = 0; i < 100; i++) {
      detector.feed(`line ${i}\n`);
    }
    detector.feed('PROMPT>');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should handle empty string feed', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('');
    // Should not crash; timer still set
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should handle pattern split across chunks with ANSI in between', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /COMPLETE$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('COM');
    detector.feed('\x1b[32m');  // ANSI color (stripped)
    detector.feed('PLETE');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should handle completion pattern overriding quiescence timer', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /DONE$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    // Feed non-matching data to start quiescence timer
    detector.feed('working...');
    vi.advanceTimersByTime(1000);

    // Now feed completion pattern — should switch to completion path
    detector.feed('DONE');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should fire idle only once even if multiple conditions met', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /DONE$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('DONE');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);

    // Advance more — should not fire again
    vi.advanceTimersByTime(10000);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should handle readyPattern appearing in same chunk as other data', () => {
    const detector = new IdleDetector(makeCli({ readyPattern: /\u23F5\u23F5/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    // Ready pattern in one big chunk with lots of status bar data after it
    detector.feed('loading output...\u23F5\u23F5 status bar info here');
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should detect readyPattern in the current chunk even if pushed out of tail', () => {
    const detector = new IdleDetector(makeCli({ readyPattern: /READY/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    // READY at the start followed by >500 chars that push it out of tail
    detector.feed('READY' + 'x'.repeat(600));
    // readySeen should be true because stripped chunk is checked directly
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });
});
