import { describe, it, expect } from 'vitest';
import { stripAnsiForLog, tailChars } from '../src/utils/crash-log.js';

describe('tailChars', () => {
  it('returns the input unchanged when within the cap', () => {
    expect(tailChars('hello', 10)).toBe('hello');
    expect(tailChars('hello', 5)).toBe('hello');
  });

  it('keeps only the last `max` chars when over the cap', () => {
    expect(tailChars('abcdefg', 3)).toBe('efg');
  });
});

describe('stripAnsiForLog', () => {
  it('strips SGR / CSI color and cursor sequences', () => {
    expect(stripAnsiForLog('\x1b[1;31mred\x1b[0m text')).toBe('red text');
    expect(stripAnsiForLog('a\x1b[2Kb')).toBe('ab');
  });

  it('strips OSC-8 hyperlinks and OSC-0 titles (BEL- and ST-terminated)', () => {
    const s = 'before\x1b]8;;https://x.com\x07link\x1b]8;;\x07\x1b]0;title\x07after';
    expect(stripAnsiForLog(s)).toBe('beforelinkafter');
    // ST (ESC \) terminator variant.
    expect(stripAnsiForLog('x\x1b]0;t\x1b\\y')).toBe('xy');
  });

  it('normalizes CR to LF and collapses 3+ blank lines', () => {
    expect(stripAnsiForLog('a\r\n\n\n\nb')).toBe('a\n\nb');
  });

  it('does NOT catastrophically backtrack on a dense run of unterminated OSC (ReDoS guard)', () => {
    // A 200 KB tail of `ESC]` with no BEL/ST is exactly what a corrupted /
    // binary stream flushed to the TTY right before a crash looks like. The
    // pre-fix regex took ~18 s here (O(n²) backtracking) and froze the worker's
    // synchronous exit handler. The fix must complete in well under a second.
    const pathological = '\x1b]'.repeat(100_000); // ~200 KB
    const start = Date.now();
    const out = stripAnsiForLog(pathological);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(1000);
    expect(out).toBe('');
  });
});
