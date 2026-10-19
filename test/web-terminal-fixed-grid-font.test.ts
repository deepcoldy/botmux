/**
 * Fixed-grid font fitting of the web terminal page.
 *
 * An adopted pane (or a managed Herdr follower) pins xterm to the remote grid.
 * The page then picks the largest font at which the WHOLE grid fits the
 * container, like a remote desktop's "fit to window": no horizontal scrollbar
 * when the grid is wider than the auto font allows, and no large blank margin
 * when the browser is bigger than the grid. Bounded by the readable minimum and
 * a cap that keeps a tiny remote grid from turning into giant text.
 *
 * Whatever the font cannot fill (font sizes come in steps and the aspect ratio
 * rarely matches) is filled with line height and letter spacing.
 *
 * The page script lives inside worker.ts's template string; cut out the real
 * functions and run them against a stubbed xterm whose cell size follows the
 * quantized sizes Chromium measured at DPR 2, and xterm's own rounding for line
 * height (floored to device pixels) and letter spacing (whole device pixels).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

function slice(fromMarker: string, lastFunction: string): string {
  const start = source.indexOf(fromMarker);
  const last = source.indexOf(lastFunction, start);
  const end = source.indexOf('\n}', last);
  if (start < 0 || last < 0 || end < 0) throw new Error(`page script not found: ${fromMarker}`);
  return source.slice(start, end + 2);
}

const sizerScript = slice('var _WB_FONT_MIN=', 'function _wbTerminalWidth(){');
const applyScript = slice('function _wbApplyAutoFontSize(){', 'function _wbStretchFixedGrid(){');
const DPR = 2;

/** [cell width, cell height] per font size, measured in Chromium (DPR 2). */
const CELL: Record<number, [number, number]> = {
  9: [5, 13], 9.5: [5.5, 13], 10: [6, 14], 10.5: [6, 14], 11: [6.5, 15], 11.5: [6.5, 15],
  12: [7, 17], 12.5: [7.5, 17], 13: [7.5, 18], 13.5: [8, 18], 14: [8, 19], 14.5: [8.5, 20],
  15: [9, 20], 15.5: [9, 22], 16: [9.5, 22], 16.5: [9.5, 23], 17: [10, 23], 17.5: [10, 24],
  18: [10.5, 24], 18.5: [11, 25], 19: [11, 26], 19.5: [11.5, 27], 20: [11.5, 27], 20.5: [12, 28],
  21: [12.5, 28], 21.5: [12.5, 29], 22: [13, 30], 22.5: [13.5, 31], 23: [13.5, 32], 23.5: [14, 32],
  24: [14, 33],
};

interface Page {
  apply(): boolean;
  term: { cols: number; rows: number; options: { fontSize: number; lineHeight: number; letterSpacing: number } };
  setFixed(fixed: boolean): void;
  setLineHeightBase(base: number): void;
}

/** xterm's cell size: line height floors to device pixels, letter spacing adds whole device pixels. */
function cellOf(o: { fontSize: number; lineHeight: number; letterSpacing: number }): [number, number] {
  const [w, h] = CELL[o.fontSize];
  return [(w * DPR + Math.round(o.letterSpacing)) / DPR, Math.floor(h * DPR * o.lineHeight) / DPR];
}

function boot(opts: {
  width: number; height: number; cols: number; rows: number; fixed: boolean; measurable?: boolean;
  /** Computed padding of .xterm; omitted = the plain fixed-grid 15px right allowance. */
  padding?: { top: number; right: number; bottom: number; left: number };
}): Page {
  const host = { clientWidth: opts.width, clientHeight: opts.height };
  const options = { fontSize: 14, lineHeight: 1, letterSpacing: 0 };
  const element = {};
  const term = {
    cols: opts.cols,
    rows: opts.rows,
    options,
    element,
    _core: {
      _renderService: {
        get dimensions() {
          const [width, height] = opts.measurable === false ? [0, 0] : cellOf(options);
          return { css: { cell: { width, height } } };
        },
      },
    },
  };
  const state = { fixedSize: opts.fixed };
  const page = new Function(
    'document', 'window', 'term', 'state',
    `${sizerScript}
${applyScript}
return {
  apply: function(){ fixedSize = state.fixedSize; return _wbApplyAutoFontSize(); },
  setLineHeightBase: function(base){ _wbLineHeightBase = base; term.options.lineHeight = base; },
};
var fixedSize;`,
  )(
    { getElementById: (id: string) => (id === 'terminal' ? host : null) },
    {
      innerWidth: opts.width,
      devicePixelRatio: DPR,
      getComputedStyle: (el: unknown) => {
        if (el !== element) throw new Error('unexpected element');
        const p = opts.padding ?? { top: 0, right: 15, bottom: 0, left: 0 };
        return {
          paddingTop: `${p.top}px`, paddingRight: `${p.right}px`,
          paddingBottom: `${p.bottom}px`, paddingLeft: `${p.left}px`,
        };
      },
    },
    term,
    state,
  );
  return { ...page, term, setFixed(fixed: boolean) { state.fixedSize = fixed; } };
}

/** Rendered grid size under the page's current options. */
function gridOf(page: Page): { width: number; height: number } {
  const [w, h] = cellOf(page.term.options);
  return { width: w * page.term.cols, height: h * page.term.rows };
}

/** The grid fits at font `f` (15px is the fixed-grid scrollbar allowance). */
function fitsAt(f: number, width: number, height: number, cols: number, rows: number): boolean {
  const [w, h] = CELL[f];
  return w * cols <= width - 15 && h * rows <= height;
}

describe('fixed-grid font fitting', () => {
  it.each([
    // [viewport, expected font] for a 213x58 Herdr pane.
    [2000, 1190, 15],   // bigger than the grid at 14px: grows to fill
    [1920, 1080, 13.5], // height-bound: 58 rows at 14px would overflow
    [1500, 900, 11.5],  // linear estimate says 12px, whose 213 cols need 1491px
  ])('fits a 213x58 grid into %ix%i at %spx and nothing larger', (width, height, font) => {
    const page = boot({ width, height, cols: 213, rows: 58, fixed: true });
    page.apply();
    expect(page.term.options.fontSize).toBe(font);
    expect(fitsAt(font, width, height, 213, 58)).toBe(true);
    expect(fitsAt(font + 0.5, width, height, 213, 58)).toBe(false);
  });

  it('stops at the readable minimum when even that cannot fit (scrolling remains)', () => {
    const page = boot({ width: 1000, height: 640, cols: 213, rows: 58, fixed: true });
    page.apply();
    expect(page.term.options.fontSize).toBe(9);
    expect(fitsAt(9, 1000, 640, 213, 58)).toBe(false);
    // Nothing to fill: spacing stays at its base.
    expect(page.term.options).toMatchObject({ lineHeight: 1, letterSpacing: 0 });
  });

  it('caps a tiny remote grid instead of blowing it up', () => {
    const page = boot({ width: 1920, height: 1080, cols: 80, rows: 24, fixed: true });
    page.apply();
    expect(page.term.options.fontSize).toBe(24);
  });

  it('leaves an owned grid on the plain auto font', () => {
    const page = boot({ width: 2000, height: 1190, cols: 213, rows: 58, fixed: false });
    expect(page.apply()).toBe(false);
    expect(page.term.options).toMatchObject({ fontSize: 14, lineHeight: 1, letterSpacing: 0 });
  });

  it('keeps the auto font while xterm has not measured a cell yet', () => {
    const page = boot({ width: 2000, height: 1190, cols: 213, rows: 58, fixed: true, measurable: false });
    expect(page.apply()).toBe(false);
    expect(page.term.options).toMatchObject({ fontSize: 14, lineHeight: 1, letterSpacing: 0 });
  });

  it('re-fits a fixed grid when the line height changes', () => {
    expect(source).toContain('if(!fixedSize)fit.fit();\n    else _wbApplyAutoFontSize();');
    expect(source).toContain("term.options.lineHeight=_d.termStyle==='reader'?1.15:1;\n    _wbLineHeightBase=term.options.lineHeight;");
  });
});

describe('fixed-grid spacing fill', () => {
  it.each([
    [2000, 1190],
    [2000, 1300], // width-bound: the font cannot grow, line height takes the rest
    [1920, 1080], // height-bound: letter spacing takes the spare width
    [1500, 900],
  ])('fills %ix%i to within one device pixel per row and per column', (width, height) => {
    const page = boot({ width, height, cols: 213, rows: 58, fixed: true });
    page.apply();
    const grid = gridOf(page);
    expect(grid.width).toBeLessThanOrEqual(width - 15);
    expect(grid.height).toBeLessThanOrEqual(height);
    // One more device pixel per row / per column would no longer fit.
    expect(grid.height + 58 / DPR).toBeGreaterThan(height);
    expect(grid.width + 213 / DPR).toBeGreaterThan(width - 15);
  });

  it('stretches line height but never past 1.5x of its base', () => {
    // A very tall window: the width bounds the font, the rest is far too much.
    const page = boot({ width: 2000, height: 3000, cols: 213, rows: 58, fixed: true });
    page.apply();
    expect(page.term.options.lineHeight).toBeGreaterThan(1);
    expect(page.term.options.lineHeight).toBeLessThanOrEqual(1.5);
    expect(gridOf(page).height).toBeLessThan(3000);
  });

  it('keeps letter spacing within 20% of the cell width', () => {
    // A very wide window: the height bounds the font.
    const page = boot({ width: 4000, height: 1080, cols: 213, rows: 58, fixed: true });
    page.apply();
    const [w] = CELL[page.term.options.fontSize];
    expect(page.term.options.letterSpacing / DPR).toBeLessThanOrEqual(w * 0.2);
    expect(page.term.options.letterSpacing).toBeGreaterThan(0);
  });

  it('builds on the reader line height and restores it after leaving the fixed grid', () => {
    const page = boot({ width: 2000, height: 1300, cols: 213, rows: 58, fixed: true });
    page.setLineHeightBase(1.15);
    page.apply();
    expect(page.term.options.lineHeight).toBeGreaterThanOrEqual(1.15);
    page.setFixed(false);
    page.apply();
    expect(page.term.options).toMatchObject({ fontSize: 14, lineHeight: 1.15, letterSpacing: 0 });
  });

  it('keeps the grid clear of the touch input bar and keyboard padding', () => {
    // Touch + write access: .xterm reserves --mobile-bar-h + --keyboard-inset below.
    const padding = { top: 0, right: 15, bottom: 91, left: 0 };
    const page = boot({ width: 1024, height: 768, cols: 80, rows: 24, fixed: true, padding });
    page.apply();
    const grid = gridOf(page);
    expect(grid.height).toBeLessThanOrEqual(768 - 91);
    expect(grid.width).toBeLessThanOrEqual(1024 - 15);
    // Without the reservation the same grid would have grown into the bar.
    const unpadded = boot({ width: 1024, height: 768, cols: 80, rows: 24, fixed: true });
    unpadded.apply();
    expect(gridOf(unpadded).height).toBeGreaterThan(768 - 91);
  });

  it('re-fits from the base spacing on every pass instead of compounding it', () => {
    const page = boot({ width: 1920, height: 1080, cols: 213, rows: 58, fixed: true });
    page.apply();
    const first = { ...page.term.options };
    page.apply();
    expect(page.term.options).toEqual(first);
  });
});
