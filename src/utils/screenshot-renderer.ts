/**
 * Renders an xterm-headless buffer to a PNG buffer using @napi-rs/canvas.
 * ANSI 256-color palette + RGB true color, bold weight, inverse, default fg/bg.
 * Tokyo Night theme (matches src/worker.ts web terminal).
 */
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import xtermHeadless from '@xterm/headless';
type Terminal = InstanceType<typeof xtermHeadless.Terminal>;

// ─── Font registration ──────────────────────────────────────────────────────
// @napi-rs/canvas does NOT auto-discover system fonts on Linux; we must
// explicitly register a path. We build an ordered fallback chain so missing
// glyphs in the primary font (e.g. emoji, dingbats) get picked up by a later
// font in the chain (skia walks the family list per glyph).

const fontFamilyChain: string[] = [];
let fontInitialized = false;

function tryRegister(path: string, alias?: string): boolean {
  if (!existsSync(path)) return false;
  try { GlobalFonts.registerFromPath(path, alias); return true; }
  catch { return false; }
}

function ensureFontRegistered(): void {
  if (fontInitialized) return;
  fontInitialized = true;

  // 1. Project-bundled font(s) under assets/fonts/ — drop a TTF here to override defaults.
  const projectFontDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'fonts');
  for (const fname of ['BotmuxMono-Regular.ttf', 'BotmuxMono.ttf', 'BotmuxMono-Regular.otf']) {
    if (tryRegister(join(projectFontDir, fname), 'BotmuxMono')) {
      tryRegister(join(projectFontDir, 'BotmuxMono-Bold.ttf'), 'BotmuxMono');
      fontFamilyChain.push('BotmuxMono');
      break;
    }
  }

  // 2. CJK monospace — primary for Latin + Han glyphs.
  //    Linux: Noto Sans CJK（需要 fonts-noto-cjk 包）；macOS: 系统自带 PingFang/Hiragino。
  const cjkCandidates: Array<{ regular: string; bold?: string; family: string }> = [
    { regular: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', bold: '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', family: 'Noto Sans Mono CJK SC' },
    { regular: '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc', bold: '/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc', family: 'Noto Sans Mono CJK SC' },
    { regular: '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc', bold: '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Bold.ttc', family: 'Noto Sans Mono CJK SC' },
    { regular: '/usr/share/fonts/opentype/noto/NotoSansMonoCJK-Regular.ttc', bold: '/usr/share/fonts/opentype/noto/NotoSansMonoCJK-Bold.ttc', family: 'Noto Sans Mono CJK SC' },
    { regular: '/System/Library/Fonts/PingFang.ttc', family: 'PingFang SC' },
    { regular: '/System/Library/Fonts/STHeiti Light.ttc', family: 'Heiti SC' },
    { regular: '/Library/Fonts/Hiragino Sans GB.ttc', family: 'Hiragino Sans GB' },
    { regular: '/System/Library/Fonts/Hiragino Sans GB.ttc', family: 'Hiragino Sans GB' },
  ];
  for (const c of cjkCandidates) {
    if (tryRegister(c.regular)) {
      if (c.bold) tryRegister(c.bold);
      fontFamilyChain.push(c.family);
      break;
    }
  }

  // 3. Latin monospace — DejaVu/Liberation cover dingbats (❯, ✓, etc.) and
  //    most box-drawing/geometric symbols not in CJK font.
  const latinCandidates: Array<[string, string]> = [
    ['/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', 'DejaVu Sans Mono'],
    ['/usr/share/fonts/dejavu/DejaVuSansMono.ttf', 'DejaVu Sans Mono'],
    ['/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf', 'Liberation Mono'],
    ['/usr/share/fonts/liberation/LiberationMono-Regular.ttf', 'Liberation Mono'],
  ];
  for (const [p, name] of latinCandidates) {
    if (tryRegister(p)) {
      // Best-effort bold companion
      tryRegister(p.replace(/Regular\.ttf$/, 'Bold.ttf'));
      tryRegister(p.replace(/SansMono\.ttf$/, 'SansMono-Bold.ttf'));
      fontFamilyChain.push(name);
      break;
    }
  }

  // 4. Color emoji — Noto Color Emoji on Linux, Apple Color Emoji on macOS.
  //    skia handles CBDT/CBLC + COLR/CPAL color formats.
  const emojiCandidates: Array<[string, string]> = [
    ['/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', 'Noto Color Emoji'],
    ['/usr/share/fonts/noto/NotoColorEmoji.ttf', 'Noto Color Emoji'],
    ['/usr/share/fonts/google-noto-emoji/NotoColorEmoji.ttf', 'Noto Color Emoji'],
    ['/Library/Fonts/Apple Color Emoji.ttc', 'Apple Color Emoji'],
    ['/System/Library/Fonts/Apple Color Emoji.ttc', 'Apple Color Emoji'],
  ];
  for (const [p, name] of emojiCandidates) {
    if (tryRegister(p)) { fontFamilyChain.push(name); break; }
  }

  if (fontFamilyChain.length === 0) fontFamilyChain.push('monospace');
}

function fontSpec(bold: boolean): string {
  const families = fontFamilyChain.map(f => `"${f}"`).join(', ');
  return `${bold ? 'bold ' : ''}${FONT_SIZE}px ${families}, monospace`;
}

/** Detect whether the leading codepoint is an emoji/symbol pictograph that
 *  uses bitmap glyph metrics — these need vertical centering, not top-align. */
function isPictograph(ch: string): boolean {
  if (!ch) return false;
  const cp = ch.codePointAt(0) ?? 0;
  return (
    (cp >= 0x1F300 && cp <= 0x1FAFF) ||   // emoji + extended pictographs
    (cp >= 0x1F900 && cp <= 0x1F9FF) ||   // supplemental symbols
    (cp >= 0x1F1E6 && cp <= 0x1F1FF) ||   // regional indicators (flags)
    (cp >= 0x2600 && cp <= 0x27BF) ||     // misc symbols + dingbats (✓✗★⚠ etc.)
    cp === 0x231A || cp === 0x231B ||      // ⌚ ⌛
    cp === 0x23E9 || cp === 0x23EA || cp === 0x23EB || cp === 0x23EC ||
    cp === 0x23F0 || cp === 0x23F3 ||      // ⏰ ⏳
    cp === 0x25FD || cp === 0x25FE ||      // ◽ ◾
    cp === 0x2B50 || cp === 0x2B55 ||      // ⭐ ⭕
    cp === 0x303D || cp === 0x3297 || cp === 0x3299
  );
}

const BG = '#1a1b26';
const FG = '#a9b1d6';

const ANSI16 = [
  '#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6',
  '#414868', '#ff7a93', '#b9f27c', '#ff9e64', '#7da6ff', '#bb9af7', '#0db9d7', '#c0caf5',
];

const PALETTE_256 = (() => {
  const p = [...ANSI16];
  const ramp = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        p.push(`#${ramp[r].toString(16).padStart(2, '0')}${ramp[g].toString(16).padStart(2, '0')}${ramp[b].toString(16).padStart(2, '0')}`);
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = (8 + i * 10).toString(16).padStart(2, '0');
    p.push(`#${v}${v}${v}`);
  }
  return p;
})();

const FONT_SIZE = 14;
const CELL_W = 8.4;
const CELL_H = 18;
const PADDING = 8;

function colorOf(cell: any, isBg: boolean): string | null {
  const isDefault = isBg ? cell.isBgDefault() : cell.isFgDefault();
  if (isDefault) return null;
  const isRGB = isBg ? cell.isBgRGB() : cell.isFgRGB();
  const isPalette = isBg ? cell.isBgPalette() : cell.isFgPalette();
  const v: number = isBg ? cell.getBgColor() : cell.getFgColor();
  if (isRGB) return `#${v.toString(16).padStart(6, '0')}`;
  if (isPalette) return PALETTE_256[v] ?? null;
  return null;
}

export interface CaptureOpts {
  cols: number;
  rows: number;
  startY: number;
}

/** Capture a section of the terminal buffer to a PNG buffer. */
export function captureToPng(terminal: Terminal, opts: CaptureOpts): Buffer {
  ensureFontRegistered();
  const { cols, rows, startY } = opts;
  const buffer = terminal.buffer.active;

  const W = Math.ceil(PADDING * 2 + cols * CELL_W);
  const H = PADDING * 2 + rows * CELL_H;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  ctx.textBaseline = 'top';
  ctx.font = fontSpec(false);
  let currentBold = false;

  for (let row = 0; row < rows; row++) {
    const line = buffer.getLine(startY + row);
    if (!line) continue;

    let col = 0;
    while (col < cols) {
      const cell = line.getCell(col);
      if (!cell) { col++; continue; }
      const w = cell.getWidth();
      if (w === 0) { col++; continue; }

      const ch = cell.getChars();
      const x = PADDING + col * CELL_W;
      const y = PADDING + row * CELL_H;

      let fg = colorOf(cell, false) ?? FG;
      let bg = colorOf(cell, true);
      if (cell.isInverse()) {
        const tmp = bg ?? BG;
        bg = fg;
        fg = tmp;
      }

      if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(x, y, CELL_W * w, CELL_H);
      }

      if (ch && ch !== ' ') {
        const bold = !!cell.isBold();
        if (bold !== currentBold) {
          currentBold = bold;
          ctx.font = fontSpec(bold);
        }
        ctx.fillStyle = fg;
        // Pictographs (emoji + dingbats) use bitmap metrics that don't align with
        // text top-baseline — center them vertically in the cell instead.
        if (isPictograph(ch)) {
          ctx.textBaseline = 'middle';
          ctx.fillText(ch, x, y + CELL_H / 2);
          ctx.textBaseline = 'top';
        } else {
          ctx.fillText(ch, x, y + 2);
        }
      }

      col += w;
    }
  }

  return canvas.toBuffer('image/png');
}
