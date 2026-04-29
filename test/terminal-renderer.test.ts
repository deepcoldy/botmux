/**
 * Tests for the headless terminal renderer used by adopt-mode bridge to
 * feed the user's tmux pane bytes into an off-screen xterm and snapshot
 * its viewport for the Lark streaming card / screenshot.
 *
 * Live failure that motivated the width/dimensions fix: the source pane
 * was 270 cols wide but the renderer was hardcoded to 160. ANSI meant
 * for col 270 wrapped to the next visual row, snapshot read only 160
 * cols, and the resulting screenshot showed duplicated / stair-stepped
 * content + stretched gray bars.
 */
import { describe, it, expect } from 'vitest';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';
import { resolveRenderDimensions } from '../src/worker.js';

// xterm-headless processes writes asynchronously through an internal
// queue. Accessing the buffer immediately after .write() can show stale
// state; this helper writes via the callback overload + a microtask
// flush so tests deterministically observe the post-write buffer.
function writeAndFlush(r: TerminalRenderer, data: string): Promise<void> {
  return new Promise(resolve => {
    (r.xterm as any).write(data, () => resolve());
  });
}

describe('resolveRenderDimensions (worker init helper)', () => {
  it('non-adopt sessions keep PTY_COLS/PTY_ROWS defaults (160x50)', () => {
    expect(resolveRenderDimensions({})).toEqual({ cols: 160, rows: 50 });
    expect(resolveRenderDimensions({ adoptMode: false, adoptPaneCols: 999 })).toEqual({ cols: 160, rows: 50 });
  });

  it('adopt sessions key off pane dimensions', () => {
    expect(resolveRenderDimensions({ adoptMode: true, adoptPaneCols: 270, adoptPaneRows: 57 }))
      .toEqual({ cols: 270, rows: 57 });
  });

  it('adopt clamps oversized pane reports (defends against malformed init)', () => {
    expect(resolveRenderDimensions({ adoptMode: true, adoptPaneCols: 9_999, adoptPaneRows: 9_999 }))
      .toEqual({ cols: 320, rows: 100 });
  });

  it('adopt clamps too-narrow pane reports', () => {
    expect(resolveRenderDimensions({ adoptMode: true, adoptPaneCols: 1, adoptPaneRows: 1 }))
      .toEqual({ cols: 80, rows: 24 });
  });

  it('adopt without explicit dimensions falls back to PTY defaults under clamp', () => {
    // Missing adoptPaneCols → fall back to PTY_COLS=160 (still > MIN=80).
    expect(resolveRenderDimensions({ adoptMode: true }))
      .toEqual({ cols: 160, rows: 50 });
  });

  it('non-finite dimensions snap to lower clamp (no NaN propagation)', () => {
    expect(resolveRenderDimensions({ adoptMode: true, adoptPaneCols: NaN, adoptPaneRows: Infinity }))
      .toEqual({ cols: 80, rows: 100 });
  });
});

describe('TerminalRenderer width matches source pane', () => {
  it('renderer cols/rows are honoured by the underlying xterm', () => {
    const r270 = new TerminalRenderer(270, 57);
    expect(r270.xterm.cols).toBe(270);
    expect(r270.xterm.rows).toBe(57);
    r270.dispose();

    const r160 = new TerminalRenderer(160, 50);
    expect(r160.xterm.cols).toBe(160);
    expect(r160.xterm.rows).toBe(50);
    r160.dispose();
  });

  it('snapshot reads past the old 160-col clamp on a 270-col renderer', async () => {
    // Live failure: snapshot was clamped at 160 cols regardless of the
    // renderer's actual width, silently dropping any pane content past
    // col 160 from the screenshot. With the cap raised to 320 the renderer
    // at 270 cols can surface the full row. We write a marker substring
    // that lives entirely BEYOND col 160 and check it round-trips through
    // rawSnapshot — proves the snapshot reader sees the wider region.
    const r = new TerminalRenderer(270, 5);
    const marker = 'BEYOND_OLD_CLAMP_MARKER';
    // 161 spaces, then a unique marker — its first char lands at col 161.
    await writeAndFlush(r, ' '.repeat(161) + marker + '\r\n');
    const snap = r.rawSnapshot();
    expect(snap).toContain(marker);
    r.dispose();
  });

  it('legacy 160-col renderer would NOT see content past col 160 in row 1 (wrap symptom)', async () => {
    const r = new TerminalRenderer(160, 5);
    const marker = 'BEYOND_OLD_CLAMP_MARKER';
    // Same input — marker would land starting at col 161, which xterm
    // wraps to row 2 in a 160-col terminal. Row 1's read window
    // (cols 0..159) is therefore all spaces — must NOT contain the marker.
    // This is exactly the artefact that produced the duplicated /
    // stair-stepped screenshot in the live failure.
    await writeAndFlush(r, ' '.repeat(161) + marker + '\r\n');
    const snap = r.rawSnapshot();
    const firstRow = snap.split('\n')[0] ?? '';
    expect(firstRow).not.toContain(marker);
    r.dispose();
  });
});
