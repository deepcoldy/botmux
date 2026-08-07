import { describe, expect, it } from 'vitest';
import { computeSessionPickerScrollWindow } from '../src/cli/session-picker-viewport.js';

/**
 * The interactive `botmux list` picker used to print every row unconditionally,
 * so a long session list overflowed the alt-screen and pushed the title/header/
 * top rows off the top (only the tail stayed visible). These tests pin the pure
 * scroll-window geometry that keeps the cursor inside a fixed viewport.
 */
describe('session picker scroll window', () => {
  const CHROME = 13;

  it('shows every row and no markers when the list fits the viewport', () => {
    const win = computeSessionPickerScrollWindow({
      cursor: 0, scrollTop: 0, rowCount: 5, termRows: 40, chromeRows: CHROME,
    });
    // 40 - 13 = 27 slots, only 5 rows → all visible, nothing hidden.
    expect(win.viewStart).toBe(0);
    expect(win.viewEnd).toBe(5);
    expect(win.hiddenAbove).toBe(0);
    expect(win.hiddenBelow).toBe(0);
  });

  it('keeps rows off the bottom when the list overflows a short terminal', () => {
    // termRows 24 → viewport 11. 48 rows, cursor at top.
    const win = computeSessionPickerScrollWindow({
      cursor: 0, scrollTop: 0, rowCount: 48, termRows: 24, chromeRows: CHROME,
    });
    expect(win.viewportRows).toBe(11);
    expect(win.viewStart).toBe(0);
    expect(win.viewEnd).toBe(11);
    expect(win.hiddenAbove).toBe(0);
    expect(win.hiddenBelow).toBe(37);
  });

  it('scrolls down to keep a cursor below the fold visible', () => {
    // Cursor at 20 with an 11-row viewport must be the last visible row.
    const win = computeSessionPickerScrollWindow({
      cursor: 20, scrollTop: 0, rowCount: 48, termRows: 24, chromeRows: CHROME,
    });
    expect(win.viewStart).toBe(10); // 20 - 11 + 1
    expect(win.viewEnd).toBe(21);
    expect(20).toBeGreaterThanOrEqual(win.viewStart);
    expect(20).toBeLessThan(win.viewEnd);
    expect(win.hiddenAbove).toBe(10);
    expect(win.hiddenBelow).toBe(27);
  });

  it('scrolls up to reveal a cursor above the current window', () => {
    const win = computeSessionPickerScrollWindow({
      cursor: 3, scrollTop: 30, rowCount: 48, termRows: 24, chromeRows: CHROME,
    });
    expect(win.viewStart).toBe(3);
    expect(win.hiddenAbove).toBe(3);
    expect(3).toBeGreaterThanOrEqual(win.viewStart);
    expect(3).toBeLessThan(win.viewEnd);
  });

  it('packs the last page fully — no blank tail while rows are still hidden above', () => {
    // Cursor at the very last row: the window must butt against the end and the
    // top must be clamped to rowCount - viewportRows, not left wherever it was.
    const win = computeSessionPickerScrollWindow({
      cursor: 47, scrollTop: 0, rowCount: 48, termRows: 24, chromeRows: CHROME,
    });
    expect(win.viewEnd).toBe(48);
    expect(win.viewStart).toBe(37); // 48 - 11
    expect(win.hiddenBelow).toBe(0);
    expect(win.hiddenAbove).toBe(37);
  });

  it('clamps a stale scrollTop that points past the last full page', () => {
    // A carried-over scrollTop bigger than the max (e.g. after rows were
    // deleted) must snap back so the final page stays packed.
    const win = computeSessionPickerScrollWindow({
      cursor: 5, scrollTop: 999, rowCount: 48, termRows: 24, chromeRows: CHROME,
    });
    // cursor 5 is above any late window, so it pulls scrollTop down to 5.
    expect(win.viewStart).toBe(5);
    expect(win.scrollTop).toBe(5);
    expect(5).toBeGreaterThanOrEqual(win.viewStart);
    expect(5).toBeLessThan(win.viewEnd);
  });

  it('never shrinks the viewport below the floor on a tiny terminal', () => {
    // termRows 10 - chrome 13 would be negative → floored to 3 rows.
    const win = computeSessionPickerScrollWindow({
      cursor: 0, scrollTop: 0, rowCount: 48, termRows: 10, chromeRows: CHROME,
    });
    expect(win.viewportRows).toBe(3);
    expect(win.viewEnd).toBe(3);
    expect(win.hiddenBelow).toBe(45);
  });

  it('keeps the cursor visible for every position across a full scroll sweep', () => {
    // Simulate arrow-down from 0 to the last row, feeding scrollTop forward like
    // the render loop does. The cursor must stay inside the window every step.
    const rowCount = 48;
    let scrollTop = 0;
    for (let cursor = 0; cursor < rowCount; cursor++) {
      const win = computeSessionPickerScrollWindow({
        cursor, scrollTop, rowCount, termRows: 24, chromeRows: CHROME,
      });
      scrollTop = win.scrollTop;
      expect(cursor).toBeGreaterThanOrEqual(win.viewStart);
      expect(cursor).toBeLessThan(win.viewEnd);
      expect(win.hiddenAbove).toBe(win.viewStart);
      expect(win.hiddenBelow).toBe(rowCount - win.viewEnd);
    }
  });
});
