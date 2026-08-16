#!/usr/bin/env node
// 生成 src/cli/terminal-width.ts:终端 cell 宽度表,供 `botmux list` 交互 TUI 的
// 列宽/行宽计算使用。目标不是「匹配某一个终端」,而是一个**跨终端保守上界**:
// 对任何真实终端,本表给出的宽度都 >= 该终端实际绘制的宽度,从而
// 「layoutWidth <= termWidth」能真正推出「物理行不折」——因为过计只会让单元格
// 被多截一点(安全),欠计才会溢出折行(危险,标题被挤出屏幕)。
//
// 宽度=2 的判据(取并集,只增不减):
//   (a) @xterm/addon-unicode11 wcwidth==2(Unicode 11 East-Asian-Width + 当时的 emoji);
//   (b) 固定的 Unicode 17.0 Emoji_Presentation 集(见 emoji-presentation.mjs,取自官方
//       emoji-data.txt)——覆盖 Unicode 14/15/16/17 新增 emoji(🫠🩷🛘🪊…),这些在
//       xterm-11 表里还是 1,但现代本地/SSH 终端按 2 画,只锁旧 oracle 会欠计。用固定集
//       (而非运行时 \p{Emoji_Presentation})保证生成结果不随 Node 的 ICU 版本漂移,也不落后标准。
// 宽度=0 沿用 xterm-11 的零宽集(控制符、组合记号、ZWJ、VS15 等);这些即使个别
// 终端画成别的宽度,过计方向也安全。**例外**:VS16(U+FE0F)记 1 格(见下 widthOf),
// 因为它把前字符提升为 emoji 呈现、grapheme-aware 终端据此画 2 格。逐码点求和、不做
// grapheme 聚合(与 xterm 一致:ZWJ 家庭 = 2+0+2+0+2 = 6;过计对不折行无害)。
//
// 注意:Tab/ESC/C0/C1 等会移动光标的控制符不在宽度表职责内——它们在渲染前由
// cli.ts 的 sanitize 统一清理(不能靠"宽度"表达一个跳到 tab stop 的动作)。
//
// 用法:
//   node scripts/generate-terminal-width.mjs           # 写回 src/cli/terminal-width.ts
//   node scripts/generate-terminal-width.mjs --check    # 只校验现有文件是否最新(CI/测试用)
//
// 防漂移:test/terminal-width-generated.test.ts 会以 --check 语义断言当前
// 依赖(xterm addon + Node Unicode 表)生成的内容与已提交文件一致;任一升级导致
// 宽度变化时该测试转红,重新跑本脚本(无 --check)提交即可。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import xtermHeadless from '@xterm/headless';
import unicode11 from '@xterm/addon-unicode11';
import { EMOJI_PRESENTATION_RANGES } from './emoji-presentation.mjs';
import { EAST_ASIAN_WIDE_RANGES } from './east-asian-width.mjs';

const { Terminal } = xtermHeadless;
const { Unicode11Addon } = unicode11;
const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'terminal-width.ts');
const MAX_CODEPOINT = 0x10FFFF; // 全 Unicode 码点空间——高位 tag/VS 等也要正确归类

// 现代 emoji 与 East_Asian_Width=W/F 都用**固定**的 Unicode 17.0 官方数据判定(见
// emoji-presentation.mjs / east-asian-width.mjs),而不是运行时 \p{…}/EAW——后者取决于
// 当前 Node 捆绑的 ICU/Unicode 版本(Node 22 目前才 Unicode 16),既让生成表跨机器不一致
// (CI build 因此红过),又落后于最新 Unicode 标准而漏掉新 emoji/新判定为宽的码点。
// 钉死到官方 U17 数据保证生成结果处处逐字节相同,且已认识最新 emoji 与最新 EAW。
const inFlatRanges = (r, cp) => {
  let lo = 0;
  let hi = r.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < r[mid * 2]) hi = mid - 1;
    else if (cp > r[mid * 2 + 1]) lo = mid + 1;
    else return true;
  }
  return false;
};
const isEmojiPresentation = cp => inFlatRanges(EMOJI_PRESENTATION_RANGES, cp);
const isEastAsianWide = cp => inFlatRanges(EAST_ASIAN_WIDE_RANGES, cp);

/**
 * 扫出宽度区间。宽度=2 取 xterm-11-wide ∪ U17 Emoji_Presentation ∪ U17 EAW(W/F)
 * (保守上界);宽度=0 沿用 xterm-11 零宽集(优先级最高,组合记号/ZWJ 不会被误提为宽)。
 * 返回互斥的两组 [start,end] 连续区间。
 */
function extractRanges() {
  const term = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  const svc = term._core?._inputHandler?._unicodeService ?? term._core?.unicodeService;
  if (!svc || typeof svc.wcwidth !== 'function') {
    throw new Error('无法从 @xterm/headless 取到 unicodeService.wcwidth;xterm 内部结构可能已变，需更新本脚本');
  }
  // 每个码点归一到 0/1/2。
  // 特例:VS16(U+FE0F,emoji 变体选择符)本身零宽,但它会把前一个默认文本呈现的
  // 字符「提升为 emoji 呈现」——grapheme-aware 终端据此把 ❤+FE0F(❤️)画成 2 格。
  // 逐码点模型无法看前一个字符,故给 FE0F 记 1 格预算:默认文本 base(1)+FE0F(1)=2(正确);
  // 本已宽 2 的 emoji + FE0F 会过计成 3(安全侧,保守上界只多截不折行)。VS15(U+FE0E,
  // 强制文本/窄呈现)仍归 0。
  const widthOf = cp => {
    if (cp === 0xFE0F) return 1;
    const w = svc.wcwidth(cp);
    if (w === 0 || w === 2) return w;
    // w === 1(含 xterm 对未知/负值的兜底):现代 emoji 或 U17 EAW 宽字符提为 2。
    return (isEmojiPresentation(cp) || isEastAsianWide(cp)) ? 2 : 1;
  };
  const ranges = targetWidth => {
    const out = [];
    let start = -1;
    for (let cp = 0; cp <= MAX_CODEPOINT; cp++) {
      if (widthOf(cp) === targetWidth) {
        if (start < 0) start = cp;
      } else if (start >= 0) {
        out.push([start, cp - 1]);
        start = -1;
      }
    }
    if (start >= 0) out.push([start, MAX_CODEPOINT]);
    return out;
  };
  return { wide: ranges(2), zero: ranges(0) };
}

const hex = n => '0x' + n.toString(16).toUpperCase().padStart(4, '0');

function emitArray(name, ranges) {
  const flat = ranges.flatMap(([a, b]) => [a, b]);
  const lines = [];
  for (let i = 0; i < flat.length; i += 24) {
    lines.push('  ' + flat.slice(i, i + 24).map(hex).join(', ') + ',');
  }
  return `const ${name}: readonly number[] = [\n${lines.join('\n')}\n];`;
}

function render({ wide, zero }) {
  return `/**
 * Terminal cell-width table for the interactive \`botmux list\` picker.
 *
 * This is a CROSS-TERMINAL CONSERVATIVE UPPER BOUND, not a match for any one
 * terminal: for any real terminal, the width here is >= what that terminal
 * paints. That direction is what makes the picker safe — the vertical viewport
 * assumes one session per physical row, so a cell must never render WIDER than
 * we budgeted (that wraps and pushes the pinned title off the alt-screen).
 * Over-counting only truncates a cell slightly early; under-counting wraps.
 *
 * Width 2 = union of:
 *   - \`@xterm/addon-unicode11\` wcwidth == 2 (Unicode 11 EAW + then-current emoji;
 *     also what the project's own xterm web terminal paints, see src/worker.ts);
 *   - a pinned Unicode 17.0 Emoji_Presentation set (Unicode 14/15/16/17 emoji
 *     like 🫠🩷🛘🪊 that xterm-11 still scores as 1 but modern terminals paint 2);
 *   - a pinned Unicode 17.0 East_Asian_Width = W/F set (e.g. the trigram block
 *     U+2630..U+2637 ☰, Wide since Unicode 16 — xterm-11 EAW is a decade behind).
 *   Both pinned from official UCD files (not the running Node's \\p{…}/EAW) so the
 *   table is identical on every Node regardless of the ICU/Unicode version it
 *   bundles, and does not lag the current Unicode standard.
 * Width 0 = xterm-11 zero-width set (controls, combining marks, ZWJ, variation
 * selectors) — checked first, so a combining mark that is also EAW-wide stays 0.
 * EXCEPTION: the emoji variation selector VS16 (U+FE0F) is given width 1, not 0.
 * VS16 promotes a preceding default-text glyph to emoji presentation, which a
 * grapheme-aware terminal paints two wide (❤ + VS16 = ❤️ = 2). The per-code-point
 * model can't look back, so budgeting 1 for VS16 makes text-base(1)+VS16(1) = 2
 * (correct); an already-wide emoji + VS16 over-counts to 3 (safe upper bound).
 * The text variation selector VS15 (U+FE0E, forces narrow) stays 0.
 * Per-code-point sum, NO grapheme clustering (a ZWJ family emoji is
 * 2+0+2+0+2 = 6) — over-counting there is harmless for the no-wrap invariant.
 *
 * Cursor-moving controls (Tab, ESC, C0/C1) are NOT handled here — width cannot
 * express "jump to next tab stop"; cli.ts sanitizes them out of dynamic text
 * before measuring/printing.
 *
 * Flat sorted [start,end,start,end,...] inclusive ranges over U+0000..U+10FFFF;
 * everything not listed is width 1. DO NOT hand-edit — regenerate with
 * \`node scripts/generate-terminal-width.mjs\` when the xterm addon or Node's
 * Unicode tables bump (test/terminal-width-generated.test.ts guards against drift).
 */

${emitArray('WIDE_RANGES', wide)}

${emitArray('ZERO_WIDTH_RANGES', zero)}

/** True when \`cp\` lies in a flat sorted inclusive range array (binary search). */
function inFlatRanges(ranges: readonly number[], cp: number): boolean {
  let lo = 0;
  let hi = ranges.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = ranges[mid * 2];
    const end = ranges[mid * 2 + 1];
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Cell width of a single code point under xterm Unicode 11 (0, 1, or 2). */
export function codePointCellWidth(cp: number): 0 | 1 | 2 {
  if (inFlatRanges(ZERO_WIDTH_RANGES, cp)) return 0;
  if (inFlatRanges(WIDE_RANGES, cp)) return 2;
  return 1;
}

/**
 * Display width of a string in terminal cells, matching xterm's
 * \`getStringCellWidth\` (per-code-point sum, no grapheme clustering).
 */
export function terminalCellWidth(str: string): number {
  let width = 0;
  for (const ch of str) width += codePointCellWidth(ch.codePointAt(0)!);
  return width;
}
`;
}

const generated = render(extractRanges());
const check = process.argv.includes('--check');

if (check) {
  let current = '';
  try {
    current = readFileSync(OUT_PATH, 'utf8');
  } catch {
    console.error(`✗ ${OUT_PATH} 不存在;运行 node scripts/generate-terminal-width.mjs 生成`);
    process.exit(1);
  }
  if (current !== generated) {
    console.error('✗ src/cli/terminal-width.ts 与当前 @xterm/addon-unicode11 不一致');
    console.error('  运行 `node scripts/generate-terminal-width.mjs` 重新生成并提交');
    process.exit(1);
  }
  console.log('✓ src/cli/terminal-width.ts 与 @xterm/addon-unicode11 一致');
} else {
  writeFileSync(OUT_PATH, generated);
  console.log(`✓ 已写入 ${OUT_PATH}`);
}
