/**
 * Per-worker bounded stderr ring — the daemon-side buffer that lets crash
 * cards show the worker's death cause instead of a bare exit code.
 *
 * Run:  bunx vitest run --project unit test/worker-stderr-ring.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  createWorkerStderrRing,
  WORKER_ERROR_MARKER,
} from '../src/core/worker-stderr-ring.js';

describe('worker stderr ring', () => {
  it('renders empty string when nothing was pushed', () => {
    const ring = createWorkerStderrRing();
    expect(ring.render()).toBe('');
  });

  it('keeps at most 200 normal lines, dropping the oldest', () => {
    const ring = createWorkerStderrRing();
    for (let i = 0; i < 250; i++) ring.push(`line-${i}`);
    const out = ring.render({ maxLines: 1000, maxChars: 100_000 });
    const lines = out.split('\n');
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe('line-50');
    expect(lines[lines.length - 1]).toBe('line-249');
  });

  it('enforces the ~8KB char cap on normal lines, dropping the oldest', () => {
    const ring = createWorkerStderrRing();
    ring.push('a'.repeat(4000));
    ring.push('b'.repeat(4000));
    ring.push('c'.repeat(4000));
    const out = ring.render({ maxLines: 1000, maxChars: 100_000 });
    // 12KB pushed; the oldest chunk is dropped so the surviving tail fits ~8KB.
    expect(out).not.toContain('a');
    expect(out).toContain('b');
    expect(out).toContain('c');
    expect(out.length).toBeLessThanOrEqual(8192);
  });

  it('keeps a single oversized line stored (render truncates it)', () => {
    const ring = createWorkerStderrRing();
    ring.push(`HEAD${'x'.repeat(10_000)}TAIL`);
    const out = ring.render();
    // The line survives in the ring; the render char cap takes its tail.
    expect(out).toContain('TAIL');
    expect(out.length).toBeLessThanOrEqual(8192);
  });

  it('pins marker lines to the top even after >200 newer normal lines', () => {
    const ring = createWorkerStderrRing();
    ring.push(`${WORKER_ERROR_MARKER} ROOT-CAUSE`);
    for (let i = 0; i < 250; i++) ring.push(`normal-${i}`);
    const out = ring.render({ maxLines: 1000, maxChars: 100_000 });
    const lines = out.split('\n');
    expect(lines[0]).toContain('ROOT-CAUSE');
    expect(lines[lines.length - 1]).toBe('normal-249');
  });

  it('bounds marker lines to 20, newest survive (line cap)', () => {
    const ring = createWorkerStderrRing();
    for (let i = 0; i < 25; i++) {
      ring.push(`${WORKER_ERROR_MARKER} fatal-${i} ${'y'.repeat(40)}`);
    }
    const out = ring.render({ maxLines: 1000, maxChars: 100_000 });
    const markerLines = out.split('\n').filter(l => l.includes('fatal-'));
    expect(markerLines).toHaveLength(20);
    expect(markerLines[0]).toContain('fatal-5');
    expect(markerLines[markerLines.length - 1]).toContain('fatal-24');
  });

  it('bounds marker lines to ~2KB, dropping the oldest markers', () => {
    const ring = createWorkerStderrRing();
    for (let i = 0; i < 10; i++) ring.pushMarker(`m-${i}-${'q'.repeat(300)}`);
    const out = ring.render({ maxLines: 1000, maxChars: 100_000 });
    // 10 × ~305 chars ≈ 3KB over the 2KB marker cap; the oldest markers go,
    // newest stay, and the surviving section fits.
    expect(out).not.toContain('m-0-');
    expect(out).toContain('m-9-');
    expect(out.length).toBeLessThanOrEqual(2048);
  });

  it('treats pushMarker lines as pinned markers without requiring the literal', () => {
    const ring = createWorkerStderrRing();
    ring.pushMarker('structured worker_fatal message');
    for (let i = 0; i < 250; i++) ring.push(`n-${i}`);
    const out = ring.render({ maxLines: 1000, maxChars: 100_000 });
    expect(out.split('\n')[0]).toBe('structured worker_fatal message');
  });

  it('ignores empty lines', () => {
    const ring = createWorkerStderrRing();
    ring.push('');
    ring.push('   ');
    ring.pushMarker('');
    ring.push('real');
    expect(ring.render()).toBe('real');
  });

  it('strips ANSI sequences on render', () => {
    const ring = createWorkerStderrRing();
    ring.push('\x1b[1;31mred boom\x1b[0m');
    ring.pushMarker('\x1b[32mfatal in green\x1b[0m');
    const out = ring.render();
    expect(out).toContain('red boom');
    expect(out).toContain('fatal in green');
    expect(out).not.toContain('\x1b[');
  });

  it('render maxLines limits the normal tail, markers still come first', () => {
    const ring = createWorkerStderrRing();
    ring.pushMarker('THE-MARKER');
    for (let i = 0; i < 30; i++) ring.push(`tail-${i}`);
    const out = ring.render({ maxLines: 5, maxChars: 100_000 });
    const lines = out.split('\n');
    expect(lines[0]).toBe('THE-MARKER');
    expect(lines.slice(1)).toEqual([
      'tail-25', 'tail-26', 'tail-27', 'tail-28', 'tail-29',
    ]);
  });

  it('render maxChars trims normal lines before dropping markers', () => {
    const ring = createWorkerStderrRing();
    ring.pushMarker('KEEP-MARKER');
    ring.push('z'.repeat(400));
    ring.push('a'.repeat(400));
    const out = ring.render({ maxLines: 1000, maxChars: 500 });
    expect(out).toContain('KEEP-MARKER');
    // The oldest normal line is sacrificed to fit; newest tail stays.
    expect(out).not.toContain('z');
    expect(out).toContain('a');
    expect(out.length).toBeLessThanOrEqual(500);
  });
});
