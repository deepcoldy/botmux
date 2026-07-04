/**
 * Markdown → Feishu interactive card v2 body builder.
 *
 * Shared by `cli.ts` (`botmux send`) and `core/worker-pool.ts` (bridge
 * fallback final_output forwarding) so a model reply going through either
 * path renders identically in the Lark thread — same chrome, same markdown
 * rendering, same table widget.
 *
 * Implementation note: parsing is delegated to `markdown-it` (CommonMark +
 * GFM tables) instead of hand-rolled regex. The previous regex-based fence
 * splitter mis-fired on two real cases observed in production:
 *   1. Code fences directly adjacent to a prose line (no blank line) — Feishu's
 *      markdown widget needs blank lines around fences, and the old splitter
 *      didn't enforce them, so fences leaked through as literal `\`\`\`` text.
 *   2. Nested 3-backtick fences — the non-greedy regex closed the outer fence
 *      at the first inner one, garbling everything after it.
 * markdown-it tokenizes correctly per CommonMark and gives us blank-line
 * normalization for free. For nested fences users should use 4+ backticks for
 * the outer block (CommonMark spec).
 */

import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { t, type Locale } from '../../i18n/index.js';

const md = new MarkdownIt({ html: false, linkify: false, breaks: false });

/** Default footer brand when a bot has no custom `brandLabel` configured. */
export const DEFAULT_BRAND_LABEL = '[botmux](https://github.com/deepcoldy/botmux)';

/**
 * Resolve the brand segment to render in a card footer from a bot's configured
 * `brandLabel` (see {@link resolveBrandLabel}):
 *   • `undefined` (unset)  → the default botmux link
 *   • `''` / whitespace    → `null` (brand suppressed)
 *   • any other string     → returned verbatim (markdown allowed)
 * Returning `null` lets callers drop the brand — and, when there's also no
 * recipient, the whole footer (HR included) — so an empty brand reads clean.
 */
export function brandFooterSegment(brand: string | undefined): string | null {
  if (brand === undefined) return DEFAULT_BRAND_LABEL;
  return brand.trim() ? brand : null;
}

/** Build a Feishu native `table` element from a `table_open … table_close` token slice. */
function buildTableFromTokens(tokens: Token[]): any | null {
  const headerCells: string[] = [];
  const bodyRows: string[][] = [];
  let inHead = false;
  let inBody = false;
  let currentRow: string[] | null = null;
  let inCell = false;

  for (const t of tokens) {
    switch (t.type) {
      case 'thead_open': inHead = true; break;
      case 'thead_close': inHead = false; break;
      case 'tbody_open': inBody = true; break;
      case 'tbody_close': inBody = false; break;
      case 'tr_open': currentRow = []; break;
      case 'tr_close':
        if (inBody && currentRow) bodyRows.push(currentRow);
        currentRow = null;
        break;
      case 'th_open':
      case 'td_open': inCell = true; break;
      case 'th_close':
      case 'td_close': inCell = false; break;
      case 'inline':
        if (inCell) {
          if (inHead) headerCells.push(t.content);
          else if (currentRow) currentRow.push(t.content);
        }
        break;
    }
  }

  if (headerCells.length === 0) return null;

  const columns = headerCells.map((h, i) => ({
    name: `c${i}`,
    display_name: h || ' ',
    data_type: 'lark_md',
    width: 'auto',
  }));
  const rows = bodyRows.map(r => {
    const o: Record<string, string> = {};
    for (let i = 0; i < headerCells.length; i++) o[`c${i}`] = r[i] ?? '';
    return o;
  });
  return {
    tag: 'table',
    page_size: Math.min(10, Math.max(1, rows.length || 1)),
    row_height: 'low',
    header_style: {
      text_align: 'left',
      text_size: 'normal',
      background_style: 'grey',
      text_color: 'default',
      bold: true,
      lines: 1,
    },
    columns,
    rows,
  };
}

function sliceLines(lines: string[], map: [number, number]): string {
  return lines.slice(map[0], map[1]).join('\n');
}

/** Find index of the matching close token at the same nesting depth. */
function findMatchingClose(tokens: Token[], openIdx: number): number {
  const open = tokens[openIdx];
  const close = open.type.replace(/_open$/, '_close');
  let depth = 1;
  for (let j = openIdx + 1; j < tokens.length; j++) {
    if (tokens[j].type === open.type) depth++;
    else if (tokens[j].type === close) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return tokens.length - 1;
}

/**
 * Defensive unescape: when a line consists solely of 3+ backslash-escaped
 * backticks (with optional ≤3-space indent and an info string with no
 * backticks), strip the backslashes so markdown-it sees a real fence.
 *
 * This shields against a common LLM/shell bug: writing `botmux send "$(cat
 * <<'EOF' \`\`\` ... \`\`\` EOF)"` puts literal `\\\`` into the markdown
 * because the model over-escapes inside a single-quoted heredoc. markdown-it
 * then treats each `\\\`` as a CommonMark backslash-escape (literal backtick),
 * so no fence opens and the code block renders as flat text in the card.
 *
 * The regex is intentionally tight — only whole lines that are pure escaped
 * fences are touched. Inline `\\\`` and code-block bodies that mention
 * `\\\`\\\`\\\`` (e.g. a markdown tutorial) are unaffected.
 */
function unescapeFenceLines(input: string): string {
  return input.replace(/^[ ]{0,3}(?:\\`){3,}[^\n`]*$/gm, m => m.replace(/\\`/g, '`'));
}

/**
 * Split markdown into card v2 body elements:
 *   1. Pipe tables → native `table` widget (Feishu's markdown widget can't
 *      render them as a grid).
 *   2. Headings → bold (Feishu's markdown widget doesn't render ATX `#`).
 *   3. Code fences → re-emitted with the original backtick run, joined with
 *      blank lines on either side (Feishu's widget needs them to recognise the
 *      fence).
 *   4. Everything else → original source slice, glued by blank lines.
 *
 * All non-table blocks are merged into a single `markdown` element to keep
 * card element counts modest.
 */
export function buildCardBodyElements(input: string): any[] {
  if (!input) return [];
  // Pre-pass: a line that is nothing but 2+ images renders as a side-by-side
  // image row (column_set) instead of stacked full-width images. Everything
  // else flows through the markdown element builder unchanged. Fence-aware so
  // image-looking lines inside ``` code blocks are left intact.
  const elements: any[] = [];
  for (const seg of splitImageRowSegments(unescapeFenceLines(input))) {
    if (seg.type === 'imgrow') elements.push(imageRowElement(seg.keys));
    else elements.push(...buildMarkdownElements(seg.content));
  }
  return elements;
}

function buildMarkdownElements(input: string): any[] {
  if (!input) return [];
  input = unescapeFenceLines(input);
  const tokens = md.parse(input, {});
  const lines = input.split('\n');
  const elements: any[] = [];
  const buf: string[] = [];

  const flushBuf = () => {
    const text = buf.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text) elements.push({ tag: 'markdown', content: text });
    buf.length = 0;
  };

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];

    if (t.level !== 0) { i++; continue; }

    if (t.type === 'table_open') {
      flushBuf();
      const j = findMatchingClose(tokens, i);
      const tableEl = buildTableFromTokens(tokens.slice(i, j + 1));
      if (tableEl) elements.push(tableEl);
      else if (t.map) buf.push(sliceLines(lines, t.map as [number, number]));
      i = j + 1;
      continue;
    }

    if (t.type === 'heading_open') {
      const inline = tokens[i + 1];
      const text = (inline?.content ?? '').replace(/^#{1,6}\s+/, '').trim();
      if (text) buf.push(`**${text}**`);
      i += 3; // heading_open, inline, heading_close
      continue;
    }

    if (t.type === 'fence' || t.type === 'code_block') {
      const fence = t.markup || '```';
      const info = (t.info || '').trim();
      const content = t.content.replace(/\n+$/, '');
      buf.push(`${fence}${info}\n${content}\n${fence}`);
      i++;
      continue;
    }

    if (t.type === 'hr') {
      buf.push('---');
      i++;
      continue;
    }

    if (t.type === 'html_block') {
      if (t.map) buf.push(sliceLines(lines, t.map as [number, number]));
      i++;
      continue;
    }

    // Generic open token (paragraph_open, bullet_list_open, ordered_list_open,
    // blockquote_open, …): slice source by the open-token's line map and skip
    // to the matching close.
    if (t.type.endsWith('_open') && t.map) {
      buf.push(sliceLines(lines, t.map as [number, number]));
      i = findMatchingClose(tokens, i) + 1;
      continue;
    }

    i++;
  }

  flushBuf();
  return elements;
}

/** A single uploaded image rendered full-width (legacy single-image look). */
function singleImgElement(imgKey: string): any {
  return { tag: 'img', img_key: imgKey, alt: { tag: 'plain_text', content: '' }, mode: 'fit_horizontal', preview: true };
}

/**
 * One row of N images side by side, each scaled to fit its column (aspect ratio
 * preserved — wide menu cards keep their full content, just smaller). A
 * `column_set` with equal weighted columns is used instead of the native
 * `img_combination` widget because the latter crops images to fill square-ish
 * cells, which would lop the sides off landscape images.
 */
function imageRowElement(imgKeys: string[]): any {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: 'small',
    columns: imgKeys.map(k => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_align: 'center',
      elements: [singleImgElement(k)],
    })),
  };
}

/** A markdown image token: `![alt](src)`, capturing the src (img_key). */
const IMG_TOKEN_SRC = /!\[[^\]]*\]\(([^)\s]+)\)/g;
/**
 * A whole line that is nothing but 2+ image tokens (the "image row" form).
 * At most 3 leading spaces: a 4+-space indent is a CommonMark indented code
 * block, whose contents `markdown-it` protects — the pre-pass must not yank an
 * indented `![](k1) ![](k2)` line out of one and promote it to a native row.
 */
const IMG_ROW_LINE = /^ {0,3}(?:!\[[^\]]*\]\([^)\s]+\)\s*){2,}$/;
/**
 * Feishu-uploaded image keys look like `img_v2_<id>` / `img_v3_<id>` (the
 * `<id>` is alphanumerics, `-` and `_`). Only a line whose every src is a full
 * such key is promoted to a native `img` row — a model reply may emit a
 * `![](https://…) ![](…)` URL line (or other non-key src like `img_v2foo.png`),
 * and a native `img` element with a non-key as its "img_key" makes Feishu reject
 * the whole card. Non-key lines fall through to the markdown widget unchanged
 * (same as before this feature existed).
 */
const FEISHU_IMG_KEY = /^img_v\d+_[A-Za-z0-9_-]+$/i;

type BodySegment = { type: 'text'; content: string } | { type: 'imgrow'; keys: string[] };

/**
 * Split a markdown body into segments, pulling out lines that consist solely of
 * 2+ image tokens as `imgrow` segments (→ side-by-side row). Fence-aware: lines
 * inside ``` / ~~~ code blocks are never treated as image rows.
 */
function splitImageRowSegments(input: string): BodySegment[] {
  const segs: BodySegment[] = [];
  let buf: string[] = [];
  const flush = () => { if (buf.length) { segs.push({ type: 'text', content: buf.join('\n') }); buf = []; } };
  // Track the open fence's char AND run length so a 4-backtick outer block
  // isn't closed by an inner 3-backtick fence. Per CommonMark a closing fence
  // is the same char, length ≥ the opening run, and nothing but whitespace
  // after the run (no info string).
  let fenceChar = '';
  let fenceLen = 0;
  for (const line of input.split('\n')) {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const run = fence[1];
      const ch = run[0];
      if (!fenceChar) {
        fenceChar = ch;                           // opening fence
        fenceLen = run.length;
      } else if (ch === fenceChar && run.length >= fenceLen && fence[2].trim() === '') {
        fenceChar = '';                           // valid closing fence
        fenceLen = 0;
      }
      buf.push(line);
      continue;
    }
    if (!fenceChar && IMG_ROW_LINE.test(line)) {
      const keys = Array.from(line.matchAll(IMG_TOKEN_SRC), m => m[1]);
      if (keys.every(k => FEISHU_IMG_KEY.test(k))) {
        flush();
        segs.push({ type: 'imgrow', keys });
        continue;
      }
    }
    buf.push(line);
  }
  flush();
  return segs;
}

/**
 * Build card body elements from a `botmux send` body whose images were uploaded
 * via `--images` and referenced by `![alt](img:N)` placeholders (`N` is the
 * 0-based --images index):
 *
 *   - `![](img:3)`    — single index → full-width inline image.
 *   - `![](img:0,1)`  — 2+ comma-separated indices → one row of images side by
 *                       side. Row width = group size: `img:0,1` two per row,
 *                       `img:0,1,2` three per row. Each placeholder is one row.
 *   - any image not named by a placeholder is appended full-width at the end.
 *
 * Placeholders are resolved to plain `![](img_key)` markdown (grouped ones onto
 * a single line) and handed to {@link buildCardBodyElements}, whose image-row
 * pre-pass turns multi-image lines into the actual `column_set` rows. This keeps
 * one rendering path: a caller that embeds `![](img_key)` directly and puts two
 * on a line (e.g. the menu poster) gets the same grid without using `--images`.
 */
export function buildImageCardElements(md: string, imageKeys: string[]): any[] {
  if (imageKeys.length === 0) return md ? buildCardBodyElements(md) : [];

  const used = new Set<number>();
  const keyAt = (idx: number): string | null =>
    Number.isInteger(idx) && idx >= 0 && idx < imageKeys.length ? imageKeys[idx] : null;

  // Grouped placeholder `![](img:0,1[,2…])` → space-joined image tokens on one
  // line so the row pre-pass picks them up.
  let resolved = md.replace(/!\[[^\]]*\]\(img:(\d+(?:\s*,\s*\d+)+)\)/g, (full, list: string) => {
    const keys: string[] = [];
    for (const part of list.split(',')) {
      const idx = Number(part.trim());
      const key = keyAt(idx);
      if (key) { used.add(idx); keys.push(key); }
    }
    if (keys.length === 0) return full;            // all out of range → literal
    return keys.map(k => `![](${k})`).join(' ');
  });
  // Single-index placeholder `![alt](img:N)` → inline image (legacy).
  resolved = resolved.replace(/!\[([^\]]*)\]\(img:(\d+)\)/g, (full, alt: string, idxStr: string) => {
    const key = keyAt(Number(idxStr));
    if (!key) return full;
    used.add(Number(idxStr));
    return `![${alt}](${key})`;
  });

  // Trailing: images never referenced by any placeholder → single full-width,
  // each on its own line (stacked, legacy behaviour).
  const trailing = imageKeys.map((k, i) => (used.has(i) ? '' : `![](${k})`)).filter(Boolean).join('\n\n');
  if (trailing) resolved = resolved ? `${resolved}\n\n${trailing}` : trailing;

  return buildCardBodyElements(resolved);
}

/**
 * Heuristic: does `text` contain markdown syntax that renders badly as plain
 * text in Feishu (code fences, headings, lists, bold, inline code, links,
 * tables, blockquotes, hr)? Callers use this to decide between an interactive
 * card and a plain post.
 */
export function hasMarkdown(text: string): boolean {
  if (!text) return false;
  return (
    /```/.test(text) ||
    /^#{1,6}\s/m.test(text) ||
    /^\s{0,3}[-*+]\s+\S/m.test(text) ||
    /^\s{0,3}\d+\.\s+\S/m.test(text) ||
    /\*\*[^*\n]+\*\*/.test(text) ||
    /(^|[^`])`[^`\n]+`([^`]|$)/.test(text) ||
    /\[[^\]\n]+\]\([^)\n]+\)/.test(text) ||
    /^\s*\|.+\|\s*$/m.test(text) ||
    /^>\s/m.test(text) ||
    /^(?:---|\*\*\*|___)\s*$/m.test(text)
  );
}

/**
 * Build a complete Feishu interactive card (schema 2.0) from a markdown
 * body, with the same footer chrome `botmux send` uses: HR + small grey
 * brand segment + optional `发送给：@<owner>` mention.
 *
 * `recipientOpenId` (when given) renders as `<at id=…></at>` in the
 * footer — typically the session owner. Pass `undefined` to omit the
 * addressing line (e.g. top-level broadcasts have no specific recipient).
 *
 * `brand` is the sending bot's configured `brandLabel` (see
 * {@link brandFooterSegment}): unset → default botmux link, `''` → brand
 * suppressed, else custom. When brand and recipient are both absent the whole
 * footer (HR included) is omitted.
 */
export function buildMarkdownCard(md: string, recipientOpenId?: string, brand?: string, locale?: Locale): string {
  const elements = md ? buildCardBodyElements(md) : [];
  const footerParts: string[] = [];
  const brandSeg = brandFooterSegment(brand);
  if (brandSeg) footerParts.push(brandSeg);
  if (recipientOpenId) footerParts.push(`${t('card.sent_to', undefined, locale)}<at id=${recipientOpenId}></at>`);
  // Empty brand + no recipient → no footer at all (skip the orphan HR too).
  if (footerParts.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      text_size: 'notation_small_v2',
      content: `<font color='grey'>${footerParts.join(' · ')}</font>`,
    });
  }
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    body: { direction: 'vertical', elements },
  });
}

/** Prefix every line with `> ` so Feishu's markdown widget renders it as a
 *  blockquote even when the body contains blank lines. Empty lines become a
 *  bare `>` to keep the quote block contiguous. */
function quoteLines(text: string): string {
  return text
    .split('\n')
    .map(line => (line.length === 0 ? '>' : `> ${line}`))
    .join('\n');
}

/**
 * Build a contextual reply card: a title strip, an optional quoted user
 * prompt, and the assistant body rendered through the same markdown-it
 * pipeline as `buildMarkdownCard`. Used by:
 *   • `/adopt` 前最后一轮 preamble — surfaces the last turn of the
 *     adopted CLI session.
 *   • Local-terminal turns synced back to Lark — when the user types
 *     directly into the adopted pane, both sides of the exchange are
 *     posted so the thread sees a complete conversation.
 *
 * Empty `userText` is rendered as a `(空)` placeholder inside the quote so
 * the visual layout stays consistent; pass `undefined` to omit the user
 * section entirely (headless variant).
 */
export function buildContextualReplyCard(opts: {
  title: string;
  userText?: string;
  assistantText: string;
  assistantLabel: string;
  recipientOpenId?: string;
  brand?: string;
  locale?: Locale;
}): string {
  const { title, userText, assistantText, assistantLabel, recipientOpenId, brand, locale } = opts;
  const elements: any[] = [];

  elements.push({
    tag: 'markdown',
    text_size: 'heading_2_v2',
    content: title,
  });

  if (userText !== undefined) {
    const u = userText.trim();
    elements.push({
      tag: 'markdown',
      content: `**👤 ${t('card.you', undefined, locale)}**\n\n${quoteLines(u || t('common.empty_paren', undefined, locale))}`,
    });
  }

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content: `**🤖 ${assistantLabel}**`,
  });

  const bodyElements = assistantText.trim()
    ? buildCardBodyElements(assistantText)
    : [{ tag: 'markdown', content: `*${t('common.empty_paren', undefined, locale)}*` }];
  for (const el of bodyElements) elements.push(el);

  const footerParts: string[] = [];
  const brandSeg = brandFooterSegment(brand);
  if (brandSeg) footerParts.push(brandSeg);
  if (recipientOpenId) footerParts.push(`${t('card.sent_to', undefined, locale)}<at id=${recipientOpenId}></at>`);
  if (footerParts.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      text_size: 'notation_small_v2',
      content: `<font color='grey'>${footerParts.join(' · ')}</font>`,
    });
  }

  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    body: { direction: 'vertical', elements },
  });
}
