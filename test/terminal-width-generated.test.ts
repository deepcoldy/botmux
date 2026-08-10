import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import xtermHeadless from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { codePointCellWidth, terminalCellWidth } from '../src/cli/terminal-width.js';

const { Terminal } = xtermHeadless;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * src/cli/terminal-width.ts is a generated artifact (scripts/generate-terminal-width.mjs
 * sweeps @xterm/addon-unicode11's wcwidth ∪ a pinned Unicode-16 Emoji_Presentation set).
 * The table is a CROSS-TERMINAL CONSERVATIVE UPPER BOUND, not a match for one terminal:
 * the picker must never UNDER-count (that wraps a row and hides the pinned title), while
 * over-counting only truncates a cell slightly early. These tests pin that contract.
 */
describe('terminal-width generated table', () => {
  it('is up to date with the installed deps (no drift)', () => {
    // Throws (non-zero exit) if the committed file differs from a fresh generation.
    expect(() =>
      execFileSync('node', ['scripts/generate-terminal-width.mjs', '--check'], { cwd: ROOT }),
    ).not.toThrow();
  });

  it('never under-counts vs the project xterm Unicode-11 terminal', () => {
    const term = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const core = term as unknown as { _core?: any };
    const svc = core._core?._inputHandler?._unicodeService ?? core._core?.unicodeService;
    expect(typeof svc?.wcwidth).toBe('function');

    // Upper-bound contract: our width >= what xterm-11 paints, for every code point.
    // (Zero-width and wide code points must match; width-1 code points may be lifted
    // to 2 for modern emoji — never dropped below xterm.)
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      expect(codePointCellWidth(cp)).toBeGreaterThanOrEqual(svc.wcwidth(cp));
    }
  });

  it('counts modern (Unicode 14+) emoji as two cells that xterm-11 still scores as one', () => {
    // These wrap the picker on any terminal that renders current emoji two cells
    // wide; xterm-11 under-counts them, so the pinned Unicode-17 emoji set matters.
    // (Widths are checked against our table, not the running Node's \p{…} regex,
    // so the assertion is deterministic regardless of Node's bundled ICU version —
    // Node 22 ships Unicode 16 and would not even recognise the U17 ones below.)
    for (const e of ['🫠', '🩷', '🫨', '🪿', '🫎', '🪼']) {
      expect(terminalCellWidth(e)).toBe(2);
    }
    // Unicode 17.0 additions (released after Node 22's bundled Unicode 16). These
    // are the case a runtime \p{Emoji_Presentation} would miss on current Node.
    for (const e of ['🛘', '🪊', '🪎', '🫈', '🫍', '🫪', '🫯']) {
      expect(terminalCellWidth(e)).toBe(2);
    }
    // Classic wide emoji + CJK stay 2; text-presentation symbols stay 1.
    for (const two of ['🤖', '🎉', '你', '（']) expect(terminalCellWidth(two)).toBe(2);
    for (const one of ['A', '©', '®', '™', '★', '①', '—']) expect(terminalCellWidth(one)).toBe(1);
  });

  it('counts non-emoji code points that later Unicode marked East_Asian_Width Wide', () => {
    // The width-2 set must union the current Unicode East_Asian_Width=W/F data, not
    // just xterm-11's decade-old EAW. The trigram block U+2630..U+2637 (☰..☷) is
    // Wide since Unicode 16 but xterm-11 scores it 1; a modern terminal paints it
    // two wide, so an all-☰ title would wrap if we under-counted it.
    for (let cp = 0x2630; cp <= 0x2637; cp++) {
      expect(codePointCellWidth(cp)).toBe(2);
    }
  });

  it('keeps combining marks / ZWJ / text variation selector zero width (per-code-point sum)', () => {
    expect(codePointCellWidth(0x200d)).toBe(0); // ZWJ
    expect(codePointCellWidth(0x0301)).toBe(0); // combining acute
    expect(codePointCellWidth(0xfe0e)).toBe(0); // VS15 (text presentation, stays narrow)
    // No grapheme clustering: a ZWJ family emoji sums its parts (2+0+2+0+2 = 6),
    // which over-counts vs a single glyph — safe for the no-wrap invariant.
    expect(terminalCellWidth('👨‍👩‍👧')).toBe(6);
  });

  it('budgets one cell for VS16 so emoji + variation selector is never under-counted', () => {
    // VS16 (U+FE0F) itself is zero-width, but it promotes a preceding default-text
    // glyph to emoji presentation — a grapheme-aware terminal paints ❤+VS16 (❤️) two
    // cells wide. The per-code-point model can't look back, so VS16 carries a 1-cell
    // budget: text-base(1) + VS16(1) = 2, matching what the terminal draws.
    expect(codePointCellWidth(0xfe0f)).toBe(1);
    for (const e of ['❤️', '☂️', '⚠️', '✍️', '✌️']) {
      expect(terminalCellWidth(e)).toBe(2);
    }
    // An already-wide emoji + VS16 over-counts (2+1=3) — harmless upper bound.
    expect(terminalCellWidth('🤖️')).toBe(3);
  });
});
