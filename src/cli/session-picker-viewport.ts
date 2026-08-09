/**
 * Pure vertical-scroll geometry for the interactive `botmux list` session
 * picker. Extracted from the TUI render loop so the window math can be
 * regression-tested without an alt-screen: given the cursor, the previous
 * scroll offset, the row count and the terminal height, decide which
 * contiguous window of rows is visible and how many are hidden above/below.
 *
 * The picker used to print every row unconditionally, so a long session list
 * overflowed the alt-screen and pushed the title, header and top rows off the
 * top (only the tail stayed visible). This keeps the cursor row inside a fixed
 * viewport and pins the surrounding chrome.
 */

export interface ScrollWindowInput {
  /** Index of the highlighted row. */
  cursor: number;
  /** First visible row index carried over from the previous render. */
  scrollTop: number;
  /** Total number of rows. */
  rowCount: number;
  /** Terminal height in rows (process.stdout.rows). */
  termRows: number;
  /** Rows reserved for the pinned title/header/footer chrome. */
  chromeRows: number;
  /** Never shrink the row viewport below this many rows. Default 3. */
  minViewportRows?: number;
}

export interface ScrollWindow {
  /** Clamped first-visible row index to use this render (feed back next time). */
  scrollTop: number;
  /** Number of row slots the viewport can show. */
  viewportRows: number;
  /** First visible row index (inclusive) — same as scrollTop. */
  viewStart: number;
  /** One past the last visible row index (exclusive). */
  viewEnd: number;
  /** Rows scrolled off the top. */
  hiddenAbove: number;
  /** Rows scrolled off the bottom. */
  hiddenBelow: number;
}

/**
 * Resolve the visible row window. Guarantees:
 *   - the cursor is always within [viewStart, viewEnd);
 *   - scrollTop is clamped to [0, max(0, rowCount - viewportRows)] so the last
 *     page is fully packed (no blank tail with content still hidden above);
 *   - hiddenAbove/hiddenBelow are exact and never negative.
 */
export function computeSessionPickerScrollWindow(input: ScrollWindowInput): ScrollWindow {
  const { cursor, rowCount, termRows, chromeRows } = input;
  const minViewportRows = input.minViewportRows ?? 3;
  const viewportRows = Math.max(minViewportRows, termRows - chromeRows);

  let scrollTop = input.scrollTop;
  // Follow the cursor: scroll up to reveal it, or down to keep it in view.
  if (cursor < scrollTop) scrollTop = cursor;
  else if (cursor >= scrollTop + viewportRows) scrollTop = cursor - viewportRows + 1;

  // Clamp so we never scroll past the last full page or before the first row.
  const maxTop = Math.max(0, rowCount - viewportRows);
  if (scrollTop > maxTop) scrollTop = maxTop;
  if (scrollTop < 0) scrollTop = 0;

  const viewEnd = Math.min(rowCount, scrollTop + viewportRows);
  return {
    scrollTop,
    viewportRows,
    viewStart: scrollTop,
    viewEnd,
    hiddenAbove: scrollTop,
    hiddenBelow: rowCount - viewEnd,
  };
}
