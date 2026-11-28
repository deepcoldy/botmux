/**
 * Readable text for an outbound interactive card (`botmux send --card-file`,
 * `--card-json`, `--diff`), recorded as `SessionTurnReply.text` so turn
 * readers (`GET /api/sessions/:id/turns`) can show what the card said.
 *
 * Leaf rendering delegates to {@link extractCardContent} — the same normalizer
 * used for inbound/history/quoted cards — while preserving each element's
 * boundary and source kind (`plain` vs `markdown` vs `table`) so that:
 *   - a bounded copy of the card (depth / node / character budget, charging
 *     every visited element and property including primitives) prevents
 *     abusive or huge JSON from blowing the stack, memory, or CPU;
 *   - header subtitles and collapsible panel titles are extracted with their
 *     own source tag (`plain_text` stays literal, `markdown`/`lark_md` is
 *     normalized as Markdown);
 *   - Lark-only inline markup (`<font>`, `<text_tag>`, `<number_tag>`, `<br>`)
 *     and GFM table spacing are applied ONLY to Markdown elements (and per
 *     element, respecting fenced code, CommonMark indented code blocks, and
 *     backslash-aware inline code spans);
 *   - `plain_text` segments keep literal markup untouched while neutralizing
 *     fence-opening lines (` ``` ` / `~~~`) and isolating unclosed backticks so
 *     they cannot swallow subsequent independent elements in GFM renderers;
 *   - `undefined` is returned instead of `[卡片]` / `[卡片 (模板)]` placeholders,
 *     so callers omit `text` rather than store a zero-information string.
 *
 * Privacy scrubbing is NOT done here: `recordSessionTurnReplies` runs every
 * reply text through `publicMessageText` before it is persisted.
 */
import { extractCardContent, isPlaceholderOnlyText } from './message-parser.js';
import { NEXT_STEP_ELEMENT_ID } from './next-step-card.js';
import { TURN_RECAP_ELEMENT_ID } from './turn-recap-card.js';

const MAX_CARD_DEPTH = 32;
const MAX_CARD_NODES = 5_000;
const MAX_CARD_STRING_CHARS = 128 * 1024;
const MAX_REPLY_TEXT_CHARS = 64 * 1024;
/** Mirrors message-parser's pre-resolved text sentinel: honouring it on an
 *  outbound card would let the JSON claim text the card never displays. */
const RESOLVED_TEXT_KEY = '__botmux_card_text__';
const LEAF_SENTINEL_TITLE = '__botmux_card_reply_leaf__';
const LEAF_SENTINEL_PREFIX = `[卡片: ${LEAF_SENTINEL_TITLE}]`;

interface Budget {
  nodes: number;
  chars: number;
}

interface FenceState {
  char: string;
  length: number;
}

interface PreparedSegment {
  text: string;
  startsWithTable: boolean;
  endsWithTable: boolean;
  startsWithIndentedCode?: boolean;
  unclosedFence?: FenceState;
  hasUnclosedInlineCode?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isMarkdownTag(tag: unknown): boolean {
  return tag === 'markdown' || tag === 'lark_md' || tag === 'md';
}

function isBudgetExhausted(budget: Budget): boolean {
  return budget.nodes >= MAX_CARD_NODES || budget.chars >= MAX_CARD_STRING_CHARS;
}

function boundedCopy(value: unknown, depth: number, budget: Budget): unknown {
  if (isBudgetExhausted(budget)) return undefined;
  budget.nodes += 1;
  if (typeof value === 'string') {
    const room = MAX_CARD_STRING_CHARS - budget.chars;
    if (room <= 0) return undefined;
    const kept = value.length > room ? value.slice(0, room) : value;
    budget.chars += kept.length;
    return kept;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_CARD_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) {
      if (isBudgetExhausted(budget)) break;
      const copied = boundedCopy(value[i], depth + 1, budget);
      if (copied !== undefined) out.push(copied);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const key in value) {
    if (isBudgetExhausted(budget)) break;
    if (!Object.hasOwn(value, key)) continue;
    if (key === RESOLVED_TEXT_KEY) {
      budget.nodes += 1;
      continue;
    }
    const copied = boundedCopy((value as Record<string, unknown>)[key], depth + 1, budget);
    if (copied !== undefined) out[key] = copied;
  }
  return out;
}

function firstLocaleValue(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  return value.zh_cn ?? value.en_us ?? Object.values(value)[0];
}

/** Extract visible text and its source kind from a title/subtitle value. */
function extractTypedTitle(value: unknown): { kind: 'plain' | 'markdown'; text: string } | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? { kind: 'plain', text: trimmed } : undefined;
  }
  if (!isRecord(value)) return undefined;
  const text = value.text;
  let content: string | undefined;
  let tag: unknown;
  if (typeof value.content === 'string') {
    content = value.content;
    tag = value.tag;
  } else if (isRecord(text) && typeof text.content === 'string') {
    content = text.content;
    tag = text.tag ?? value.tag;
  } else if (typeof text === 'string') {
    content = text;
    tag = value.tag;
  }
  const trimmed = content?.trim();
  return trimmed ? { kind: isMarkdownTag(tag) ? 'markdown' : 'plain', text: trimmed } : undefined;
}

/** Render a single leaf element through `extractCardContent` so botmux footer
 *  stripping, heading promotion, mention resolution, and button/table/image
 *  formatting stay identical to the shared parser. */
function renderLeafElement(leaf: Record<string, unknown>): string | undefined {
  const rendered = extractCardContent(JSON.stringify({
    title: LEAF_SENTINEL_TITLE,
    body: { elements: [leaf] },
  }));
  if (rendered === LEAF_SENTINEL_PREFIX) return undefined;
  if (rendered.startsWith(`${LEAF_SENTINEL_PREFIX}\n`)) {
    const body = rendered.slice(LEAF_SENTINEL_PREFIX.length + 1);
    return body.trim() ? body : undefined;
  }
  return undefined;
}

function stripChildContainers(el: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key in el) {
    if (!Object.hasOwn(el, key)) continue;
    if (key === 'extra' || key === 'columns' || key === 'actions' || key === 'elements' || key === 'fields') {
      continue;
    }
    out[key] = el[key];
  }
  return out;
}

// ─── GFM normalization ───────────────────────────────────────────────────────
// Turn readers render `reply.text` as plain GFM with raw HTML disabled, so
// Lark-only inline tags and `<br>` in Markdown nodes would show up as literal
// source. Code (fenced blocks, CommonMark indented blocks, and inline spans)
// and `plain_text` nodes are protected from Lark tag stripping.

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
// Attribute and label lengths are capped so text full of unclosed tags stays
// linear instead of rescanning to the end from every `<`.
const TAG_ATTRS = String.raw`(?:[^>"']|"[^"]{0,256}"|'[^']{0,256}'){0,512}`;
/** Opening and closing `<font>` tags alike are dropped: unwrapping every pair
 *  and dropping every orphan give the same text, without pairing nested tags. */
const FONT_TAG_RE = new RegExp(String.raw`<\/?font\b${TAG_ATTRS}>`, 'gi');
const BADGE_PAIR_RE = new RegExp(String.raw`<(text_tag|number_tag)\b${TAG_ATTRS}>([^<]{0,256})<\/\1\s*>`, 'gi');
const BADGE_ORPHAN_RE = new RegExp(String.raw`<\/?(?:text_tag|number_tag)\b${TAG_ATTRS}>`, 'gi');
const BR_RE = /<br\s*\/?>/gi;
const ATX_HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const THEMATIC_BREAK_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const SETEXT_UNDERLINE_RE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const LIST_ITEM_RE = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]*)/;
const TABLE_DELIMITER_CELL_RE = /^\s*:?-+:?\s*$/;
const PLACEHOLDER_OPEN = '';
const PLACEHOLDER_CLOSE = '';

function isEscapedAt(text: string, index: number, floor: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= floor && text[i] === '\\'; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/** Measure CommonMark leading indentation in columns (tab stops every 4 cols). */
function leadingIndentColumns(line: string): number {
  let cols = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === ' ') cols += 1;
    else if (ch === '\t') cols += 4 - (cols % 4);
    else break;
  }
  return cols;
}

/** If `line` opens a CommonMark list item, return the content column width
 *  used to distinguish list-continuation paragraphs from indented code. */
function listItemContentColumn(line: string): number | null {
  const match = LIST_ITEM_RE.exec(line);
  if (!match) return null;
  const indent = match[1]!.length;
  const marker = match[2]!;
  const after = match[3]!;
  const rest = line.slice(match[0].length);
  // A list marker must be followed by whitespace or end-of-line.
  if (after.length === 0 && rest.length > 0) return null;
  let cols = indent + marker.length;
  let wsCols = 0;
  for (let i = 0; i < after.length; i += 1) {
    const ch = after[i];
    if (ch === ' ') wsCols += 1;
    else if (ch === '\t') wsCols += 4 - ((cols + wsCols) % 4);
  }
  // CommonMark §5.2: empty content or >=5 spaces after marker collapses to 1.
  if (rest.length === 0 || wsCols >= 5) return cols + 1;
  return cols + wsCols;
}

/** True when `source` has a CommonMark blank line starting at newline `idx`. */
function blankLineEndAt(source: string, newlineIdx: number): number {
  let j = newlineIdx + 1;
  while (j < source.length && (source[j] === ' ' || source[j] === '\t')) j += 1;
  if (j < source.length && source[j] === '\n') return j;
  return -1;
}

/** CommonMark §6.1 backtick code-span scanner:
 *  - Respects backslash escapes before an opening backtick run (`\`` is literal,
 *    `\\`` opens a real code span).
 *  - Inside a code span, backslashes are literal and do NOT escape closing
 *    backticks (so `` `foo\` `` closes cleanly).
 *  - Never crosses a blank line (paragraph boundary).
 *  - Linear O(n) worst-case time via per-paragraph failed-length tracking. */
function maskInlineCodeSpans(source: string): {
  masked: string;
  codeSpans: string[];
  hasTrailingUnclosedInlineCode: boolean;
} {
  const len = source.length;
  const codeSpans: string[] = [];
  const failedLengths = new Set<number>();
  let out = '';
  let hasTrailingUnclosedInlineCode = false;
  let i = 0;

  while (i < len) {
    const ch = source[i]!;
    if (ch === '\n') {
      const blankEnd = blankLineEndAt(source, i);
      if (blankEnd >= 0) {
        failedLengths.clear();
        hasTrailingUnclosedInlineCode = false;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < len && (source[i + 1] === '\\' || source[i + 1] === '`')) {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch !== '`') {
      out += ch;
      i += 1;
      continue;
    }

    let runEnd = i + 1;
    while (runEnd < len && source[runEnd] === '`') runEnd += 1;
    const tickLen = runEnd - i;

    if (failedLengths.has(tickLen)) {
      out += source.slice(i, runEnd);
      hasTrailingUnclosedInlineCode = true;
      i = runEnd;
      continue;
    }

    let closeStart = -1;
    let closeEnd = -1;
    let j = runEnd;
    while (j < len) {
      if (source[j] === '\n' && blankLineEndAt(source, j) >= 0) break;
      if (source[j] === '`') {
        let end = j + 1;
        while (end < len && source[end] === '`') end += 1;
        if (end - j === tickLen) {
          closeStart = j;
          closeEnd = end;
          break;
        }
        j = end;
        continue;
      }
      j += 1;
    }

    if (closeStart >= 0) {
      codeSpans.push(source.slice(i, closeEnd));
      out += `${PLACEHOLDER_OPEN}${codeSpans.length - 1}${PLACEHOLDER_CLOSE}`;
      i = closeEnd;
    } else {
      failedLengths.add(tickLen);
      out += source.slice(i, runEnd);
      hasTrailingUnclosedInlineCode = true;
      i = runEnd;
    }
  }

  return { masked: out, codeSpans, hasTrailingUnclosedInlineCode };
}

/** Split a candidate GFM table row into cells. Outer pipes are optional, but
 *  at least one unescaped pipe must be present so ordinary prose lines and
 *  Setext headings are never mistaken for table rows. */
function splitTableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let hasUnescapedPipe = false;
  let start = 0;
  let end = trimmed.length;
  if (trimmed[0] === '|') {
    hasUnescapedPipe = true;
    start = 1;
  }
  if (end > start && trimmed[end - 1] === '|' && !isEscapedAt(trimmed, end - 1, start)) {
    hasUnescapedPipe = true;
    end -= 1;
  }
  const cells: string[] = [];
  let cellStart = start;
  for (let i = start; i < end; i += 1) {
    if (trimmed[i] === '|' && !isEscapedAt(trimmed, i, cellStart)) {
      hasUnescapedPipe = true;
      cells.push(trimmed.slice(cellStart, i));
      cellStart = i + 1;
    }
  }
  cells.push(trimmed.slice(cellStart, end));
  return hasUnescapedPipe ? cells : null;
}

/** Returns column count when `line` is a valid GFM table delimiter row, else 0. */
function tableDelimiterColumnCount(line: string): number {
  if (!line.includes('|') || line.includes('\\')) return 0;
  const cells = splitTableCells(line);
  if (!cells || cells.length === 0) return 0;
  for (const cell of cells) {
    if (!TABLE_DELIMITER_CELL_RE.test(cell)) return 0;
  }
  return cells.length;
}

function isTableHeaderLine(line: string, expectedCols: number): boolean {
  if (ATX_HEADING_RE.test(line)) return false;
  const cells = splitTableCells(line);
  return cells !== null && cells.length === expectedCols;
}

function isTableBodyLine(line: string): boolean {
  if (ATX_HEADING_RE.test(line)) return false;
  return splitTableCells(line) !== null;
}

function stripLarkInlineTags(masked: string): string {
  let out = masked.replace(FONT_TAG_RE, '');
  out = out.replace(BADGE_PAIR_RE, (_match, _tag: string, inner: string) => {
    const label = inner.trim();
    if (!label) return '';
    return label.includes('`') || label.includes('\n') ? `[${label}]` : `\`${label}\``;
  });
  return out.replace(BADGE_ORPHAN_RE, '');
}

function restoreCodeSpans(text: string, codeSpans: readonly string[]): string {
  if (codeSpans.length === 0) return text;
  return text.replace(
    new RegExp(`${PLACEHOLDER_OPEN}(\\d+)${PLACEHOLDER_CLOSE}`, 'g'),
    (_match, index: string) => codeSpans[Number(index)] ?? '',
  );
}

/** Normalize a Markdown cell value inside a native Schema 2.0 `table` widget. */
function normalizeMarkdownTableCell(raw: string): string {
  const source = raw.replaceAll(PLACEHOLDER_OPEN, '').replaceAll(PLACEHOLDER_CLOSE, '');
  const { masked, codeSpans } = maskInlineCodeSpans(source);
  const cleaned = stripLarkInlineTags(masked)
    .replace(BR_RE, ' / ')
    .replace(/\r\n?|\n/g, ' / ');
  return restoreCodeSpans(cleaned, codeSpans);
}

function transformTableCellValue(value: unknown, isMarkdownCol: boolean, depth = 0): unknown {
  if (depth >= MAX_CARD_DEPTH) return value;
  if (typeof value === 'string') {
    return isMarkdownCol ? normalizeMarkdownTableCell(value) : value.replace(/\r\n?|\n/g, ' / ');
  }
  if (Array.isArray(value)) {
    return value.map(item => transformTableCellValue(item, isMarkdownCol, depth + 1));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      out[key] = transformTableCellValue(value[key], isMarkdownCol, depth + 1);
    }
    return out;
  }
  return value;
}

/** Pre-normalize newlines (and `lark_md` columns) on a native table before
 *  handing it to `extractCardContent`, so plain-text cells keep literal `<font>`
 *  / `<br>` while embedded newlines still render cleanly as ` / `. */
function prepareNativeTable(el: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(el.columns)) return el;
  const colMarkdownByIndex: boolean[] = [];
  const colMarkdownByKey = new Map<string, boolean>();
  const columns = el.columns.map((col, index) => {
    if (!isRecord(col)) {
      colMarkdownByIndex.push(false);
      return col;
    }
    const isMd = isMarkdownTag(col.data_type);
    colMarkdownByIndex.push(isMd);
    if (typeof col.name === 'string' && col.name) colMarkdownByKey.set(col.name, isMd);
    return {
      ...col,
      ...(col.display_name !== undefined
        ? { display_name: transformTableCellValue(col.display_name, false) }
        : {}),
    };
  });
  const rows = Array.isArray(el.rows)
    ? el.rows.map(row => {
        if (Array.isArray(row)) {
          return row.map((cell, index) => transformTableCellValue(cell, colMarkdownByIndex[index] ?? false));
        }
        if (isRecord(row)) {
          const out: Record<string, unknown> = {};
          for (const key in row) {
            if (!Object.hasOwn(row, key)) continue;
            out[key] = transformTableCellValue(row[key], colMarkdownByKey.get(key) ?? false);
          }
          return out;
        }
        return row;
      })
    : el.rows;
  return { ...el, columns, rows };
}

interface NormalizedProseChunk {
  lines: string[];
  isTable: boolean[];
  hasUnclosedInlineCode: boolean;
}

function normalizeProseChunk(proseLines: readonly string[]): NormalizedProseChunk {
  const { masked: codeMasked, codeSpans, hasTrailingUnclosedInlineCode } = maskInlineCodeSpans(proseLines.join('\n'));
  const masked = stripLarkInlineTags(codeMasked);

  const rawLines = masked.split('\n');
  const lineIsTable = new Array<boolean>(rawLines.length).fill(false);

  let i = 0;
  while (i < rawLines.length) {
    const delimCols = i + 1 < rawLines.length ? tableDelimiterColumnCount(rawLines[i + 1]!) : 0;
    if (delimCols > 0 && isTableHeaderLine(rawLines[i]!, delimCols)) {
      lineIsTable[i] = true;
      lineIsTable[i + 1] = true;
      i += 2;
      while (i < rawLines.length && isTableBodyLine(rawLines[i]!)) {
        lineIsTable[i] = true;
        i += 1;
      }
      continue;
    }
    i += 1;
  }

  const lines: string[] = [];
  const isTable: boolean[] = [];
  for (let idx = 0; idx < rawLines.length; idx += 1) {
    if (lineIsTable[idx]) {
      const rendered = restoreCodeSpans(rawLines[idx]!.replace(BR_RE, ' / '), codeSpans);
      lines.push(rendered);
      isTable.push(true);
    } else {
      const expanded = restoreCodeSpans(rawLines[idx]!.replace(BR_RE, '\n'), codeSpans);
      for (const piece of expanded.split('\n')) {
        lines.push(piece);
        isTable.push(false);
      }
    }
  }
  return { lines, isTable, hasUnclosedInlineCode: hasTrailingUnclosedInlineCode };
}

/** Escape a CommonMark fence-opening marker run on a `plain_text` line so the
 *  literal backticks/tildes stay visible in GFM without opening a code block
 *  that swallows subsequent card elements. */
function escapePlainFenceLine(line: string): string {
  const match = FENCE_RE.exec(line);
  if (!match) return line;
  const marker = match[1]!;
  const rest = line.slice(match[0].length);
  if (marker[0] === '`' && rest.includes('`')) return line;
  const prefix = line.slice(0, match[0].length - marker.length);
  const escapedMarker = marker.replace(/./g, ch => `\\${ch}`);
  return `${prefix}${escapedMarker}${rest}`;
}

/** Prepare a `plain_text` segment: never strips Lark tags or rewrites `<br>`,
 *  while ensuring literal fence markers or stray backticks cannot leak GFM
 *  code state across element boundaries. */
function preparePlainSegment(text: string): PreparedSegment {
  const safeText = text.split('\n').map(escapePlainFenceLine).join('\n');
  const { hasTrailingUnclosedInlineCode } = maskInlineCodeSpans(safeText);
  return {
    text: safeText,
    startsWithTable: false,
    endsWithTable: false,
    ...(hasTrailingUnclosedInlineCode ? { hasUnclosedInlineCode: true } : {}),
  };
}

/** Normalize a single independent Markdown element. Fenced code, CommonMark
 *  indented code blocks, and inline code spans are protected, and code states
 *  never cross element boundaries. */
function normalizeMarkdownElement(text: string): PreparedSegment {
  const source = text.replaceAll(PLACEHOLDER_OPEN, '').replaceAll(PLACEHOLDER_CLOSE, '');
  const lines: string[] = [];
  const isTable: boolean[] = [];
  let prose: string[] = [];
  let trailingUnclosedInlineCode = false;
  let startsWithIndentedCode = false;
  let sawContentLine = false;

  const flushProse = () => {
    if (prose.length === 0) return;
    const chunk = normalizeProseChunk(prose);
    for (let i = 0; i < chunk.lines.length; i += 1) {
      lines.push(chunk.lines[i]!);
      isTable.push(chunk.isTable[i]!);
    }
    trailingUnclosedInlineCode = chunk.hasUnclosedInlineCode;
    prose = [];
  };

  let fence: FenceState | undefined;
  let inIndentedCode = false;
  let indentedThreshold = 4;
  let pendingIndentedBlanks: string[] = [];
  let canStartIndentedCode = true;
  let listContentIndent = 0;
  let inProseTable = false;

  const emitRawLine = (line: string) => {
    lines.push(line);
    isTable.push(false);
  };

  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    const isBlank = trimmed.length === 0;

    if (fence) {
      emitRawLine(line);
      const markerMatch = FENCE_RE.exec(line);
      const marker = markerMatch?.[1];
      const rest = markerMatch ? line.slice(markerMatch[0].length) : '';
      if (marker && marker[0] === fence.char && marker.length >= fence.length && !rest.trim()) {
        fence = undefined;
        canStartIndentedCode = true;
      }
      continue;
    }

    if (inIndentedCode) {
      if (isBlank) {
        pendingIndentedBlanks.push(line);
        continue;
      }
      if (leadingIndentColumns(line) >= indentedThreshold) {
        for (const blank of pendingIndentedBlanks) emitRawLine(blank);
        pendingIndentedBlanks = [];
        emitRawLine(line);
        continue;
      }
      inIndentedCode = false;
      if (pendingIndentedBlanks.length > 0) {
        for (const blank of pendingIndentedBlanks) emitRawLine(blank);
        pendingIndentedBlanks = [];
      }
      canStartIndentedCode = true;
      if (leadingIndentColumns(line) < listContentIndent) listContentIndent = 0;
    }

    const markerMatch = FENCE_RE.exec(line);
    const marker = markerMatch?.[1];
    const rest = markerMatch ? line.slice(markerMatch[0].length) : '';
    if (marker && !(marker[0] === '`' && rest.includes('`'))) {
      flushProse();
      trailingUnclosedInlineCode = false;
      inProseTable = false;
      sawContentLine = true;
      fence = { char: marker[0]!, length: marker.length };
      emitRawLine(line);
      continue;
    }

    if (isBlank) {
      prose.push(line);
      canStartIndentedCode = true;
      inProseTable = false;
      continue;
    }

    // If a GFM table in prose just ended on a non-table line, an indented code
    // block may legally begin on this line.
    if (inProseTable && !isTableBodyLine(line)) {
      inProseTable = false;
      canStartIndentedCode = true;
    }

    const indentCols = leadingIndentColumns(line);
    const threshold = listContentIndent + 4;
    if (canStartIndentedCode && indentCols >= threshold) {
      flushProse();
      trailingUnclosedInlineCode = false;
      inProseTable = false;
      if (!sawContentLine) startsWithIndentedCode = true;
      sawContentLine = true;
      inIndentedCode = true;
      indentedThreshold = threshold;
      emitRawLine(line);
      continue;
    }

    sawContentLine = true;
    const prevProseLine = prose.length > 0 ? prose[prose.length - 1]! : undefined;
    const delimCols = !inProseTable && prevProseLine !== undefined ? tableDelimiterColumnCount(line) : 0;
    if (delimCols > 0 && isTableHeaderLine(prevProseLine!, delimCols)) {
      inProseTable = true;
      canStartIndentedCode = false;
      listContentIndent = 0;
    } else if (inProseTable) {
      canStartIndentedCode = false;
    } else if (ATX_HEADING_RE.test(line) || THEMATIC_BREAK_RE.test(line) || SETEXT_UNDERLINE_RE.test(line)) {
      canStartIndentedCode = true;
      listContentIndent = 0;
    } else {
      const listCol = listItemContentColumn(line);
      if (listCol !== null) {
        listContentIndent = listCol;
      } else if (indentCols < listContentIndent) {
        listContentIndent = 0;
      }
      canStartIndentedCode = false;
    }
    prose.push(line);
  }

  if (pendingIndentedBlanks.length > 0) {
    for (const blank of pendingIndentedBlanks) emitRawLine(blank);
  }
  flushProse();

  // Insert blank lines around GFM tables within this element.
  const separated: string[] = [];
  const separatedIsTable: boolean[] = [];
  let idx = 0;
  while (idx < lines.length) {
    if (!isTable[idx]) {
      separated.push(lines[idx]!);
      separatedIsTable.push(false);
      idx += 1;
      continue;
    }
    if (separated.length > 0 && separated[separated.length - 1]!.trim()) {
      separated.push('');
      separatedIsTable.push(false);
    }
    while (idx < lines.length && isTable[idx]) {
      separated.push(lines[idx]!);
      separatedIsTable.push(true);
      idx += 1;
    }
    if (idx < lines.length && lines[idx]!.trim()) {
      separated.push('');
      separatedIsTable.push(false);
    }
  }

  return {
    text: separated.join('\n'),
    startsWithTable: separatedIsTable.length > 0 && separatedIsTable[0]!,
    endsWithTable: separatedIsTable.length > 0 && separatedIsTable[separatedIsTable.length - 1]!,
    ...(startsWithIndentedCode ? { startsWithIndentedCode: true } : {}),
    ...(fence ? { unclosedFence: fence } : {}),
    ...(!fence && trailingUnclosedInlineCode ? { hasUnclosedInlineCode: true } : {}),
  };
}

// ─── Card tree segment extraction ────────────────────────────────────────────

function canJoinNoteInline(prev: PreparedSegment, next: PreparedSegment): boolean {
  return !prev.unclosedFence
    && !prev.endsWithTable
    && !prev.hasUnclosedInlineCode
    && !prev.text.includes('\n')
    && !next.unclosedFence
    && !next.startsWithTable
    && !next.endsWithTable
    && !next.startsWithIndentedCode
    && !next.hasUnclosedInlineCode
    && !next.text.includes('\n');
}

function collectNoteSegment(el: Record<string, unknown>, segments: PreparedSegment[]): void {
  if (!Array.isArray(el.elements)) return;
  const children: PreparedSegment[] = [];
  for (const child of el.elements) {
    if (!isRecord(child)) continue;
    const raw = typeof child.content === 'string'
      ? child.content
      : isRecord(child.text) && typeof child.text.content === 'string'
        ? child.text.content
        : '';
    if (!raw) continue;
    const tag = child.tag ?? (isRecord(child.text) ? child.text.tag : undefined);
    const isMd = isMarkdownTag(tag);
    const rendered = renderLeafElement({ tag: isMd ? 'markdown' : 'plain_text', content: raw });
    if (!rendered) continue;
    const prepared = isMd ? normalizeMarkdownElement(rendered) : preparePlainSegment(rendered);
    if (prepared.text.trim()) children.push(prepared);
  }
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i]!;
    const prev = segments.length > 0 ? segments[segments.length - 1] : undefined;
    // Preserve inline single-line space-joining for ordinary note items while
    // keeping multi-line / fence / table / unclosed-code children separate so
    // their block metadata is never lost.
    if (prev && i > 0 && canJoinNoteInline(prev, child)) {
      segments[segments.length - 1] = {
        ...prev,
        text: `${prev.text} ${child.text}`,
      };
    } else {
      segments.push(child);
    }
  }
}

function pushTypedSegment(segments: PreparedSegment[], kind: 'plain' | 'markdown', text: string): void {
  const prepared = kind === 'markdown' ? normalizeMarkdownElement(text) : preparePlainSegment(text);
  if (prepared.text.trim()) segments.push(prepared);
}

function collectElementSegments(el: unknown, segments: PreparedSegment[], depth = 0): void {
  if (!isRecord(el) || depth >= MAX_CARD_DEPTH) return;
  const tag = el.tag;

  if (el.element_id === NEXT_STEP_ELEMENT_ID && (tag === 'column_set' || tag === 'form')) return;
  if (el.element_id === TURN_RECAP_ELEMENT_ID && tag === 'collapsible_panel') return;

  if (tag === 'markdown') {
    const rendered = renderLeafElement(stripChildContainers(el));
    if (rendered) pushTypedSegment(segments, 'markdown', rendered);
  } else if (tag === 'plain_text') {
    const rendered = renderLeafElement(stripChildContainers(el));
    if (rendered) pushTypedSegment(segments, 'plain', rendered);
  } else if (tag === 'div') {
    if (el.text !== undefined || el.content !== undefined) {
      const rendered = renderLeafElement({
        tag: 'div',
        ...(el.text !== undefined ? { text: el.text } : {}),
        ...(el.content !== undefined ? { content: el.content } : {}),
      });
      if (rendered) {
        const isMd = isRecord(el.text) && isMarkdownTag(el.text.tag);
        pushTypedSegment(segments, isMd ? 'markdown' : 'plain', rendered);
      }
    }
    if (Array.isArray(el.fields)) {
      for (const field of el.fields) {
        if (!isRecord(field)) continue;
        const rendered = renderLeafElement({ tag: 'div', fields: [field] });
        if (!rendered) continue;
        const fieldTag = isRecord(field.text) ? field.text.tag : field.tag;
        pushTypedSegment(segments, isMarkdownTag(fieldTag) ? 'markdown' : 'plain', rendered);
      }
    }
  } else if (tag === 'table') {
    const rendered = renderLeafElement(prepareNativeTable(el));
    if (rendered) {
      segments.push({ text: rendered, startsWithTable: true, endsWithTable: true });
    }
    return;
  } else if (tag === 'note') {
    collectNoteSegment(el, segments);
    return;
  } else if (tag === 'collapsible_panel') {
    const header = isRecord(el.header) ? el.header : undefined;
    const title = extractTypedTitle(header?.title);
    if (title) {
      const rendered = renderLeafElement({
        tag: title.kind === 'markdown' ? 'markdown' : 'plain_text',
        content: title.text,
      });
      if (rendered) pushTypedSegment(segments, title.kind, rendered);
    }
  } else {
    const rendered = renderLeafElement(stripChildContainers(el));
    if (rendered) pushTypedSegment(segments, 'plain', rendered);
  }

  if (el.extra) collectElementSegments(el.extra, segments, depth + 1);
  if (Array.isArray(el.columns)) {
    for (const col of el.columns) {
      if (isRecord(col) && Array.isArray(col.elements)) {
        for (const child of col.elements) collectElementSegments(child, segments, depth + 1);
      }
    }
  }
  if (Array.isArray(el.actions)) {
    for (const child of el.actions) collectElementSegments(child, segments, depth + 1);
  }
  if (Array.isArray(el.elements)) {
    for (const child of el.elements) collectElementSegments(child, segments, depth + 1);
  }
}

function collectCardSegments(card: Record<string, unknown>): PreparedSegment[] {
  const segments: PreparedSegment[] = [];
  const body = isRecord(card.body) ? card.body : undefined;
  let rootElements: unknown[] | null = Array.isArray(body?.elements)
    ? body.elements
    : Array.isArray(card.elements) ? card.elements : null;
  if (!rootElements) {
    const localized = firstLocaleValue(card.i18n_elements);
    if (Array.isArray(localized)) rootElements = localized;
  }

  let header = isRecord(card.header) ? card.header : undefined;
  if (!header) {
    const localizedHeader = firstLocaleValue(card.i18n_header);
    if (isRecord(localizedHeader)) header = localizedHeader;
  }

  // Header title and tag badges (plain text, rendered through extractCardContent).
  const headerShell: Record<string, unknown> = {};
  if (card.title !== undefined) headerShell.title = card.title;
  if (header) {
    const cleanHeader: Record<string, unknown> = {};
    if (header.title !== undefined) cleanHeader.title = header.title;
    if (header.text_tag_list !== undefined) cleanHeader.text_tag_list = header.text_tag_list;
    if (header.i18n_text_tag_list !== undefined) cleanHeader.i18n_text_tag_list = header.i18n_text_tag_list;
    if (Object.keys(cleanHeader).length > 0) headerShell.header = cleanHeader;
  }
  if (Object.keys(headerShell).length > 0) {
    const renderedHeader = extractCardContent(JSON.stringify(headerShell));
    if (renderedHeader && renderedHeader !== '[卡片]') {
      pushTypedSegment(segments, 'plain', renderedHeader);
    }
  }

  // Header subtitle preserves its source tag (`plain_text` vs `markdown`).
  const subtitle = extractTypedTitle(header?.subtitle);
  if (subtitle) {
    const rendered = renderLeafElement({
      tag: subtitle.kind === 'markdown' ? 'markdown' : 'plain_text',
      content: subtitle.text,
    });
    if (rendered) pushTypedSegment(segments, subtitle.kind, rendered);
  }

  if (rootElements) {
    const isFormatA = rootElements.length > 0 && Array.isArray(rootElements[0]);
    if (isFormatA) {
      const rendered = extractCardContent(JSON.stringify({ elements: rootElements }));
      if (rendered && rendered !== '[卡片]') {
        pushTypedSegment(segments, 'plain', rendered);
      }
    } else {
      for (const el of rootElements) collectElementSegments(el, segments, 0);
    }
  }

  return segments;
}

function assembleSegments(prepared: readonly PreparedSegment[]): string {
  if (prepared.length === 0) return '';

  const out: string[] = [];
  for (let i = 0; i < prepared.length; i += 1) {
    const current = prepared[i]!;
    const hasNext = i + 1 < prepared.length;
    const prev = i > 0 ? prepared[i - 1] : undefined;

    if (prev && out.length > 0) {
      const prevTailLine = out[out.length - 1]!;
      const currentHeadLine = current.text.split('\n', 1)[0] ?? '';
      const needBlankLine = (
        (prev.endsWithTable && currentHeadLine.trim().length > 0)
        || (current.startsWithTable && prevTailLine.trim().length > 0)
        || (current.startsWithIndentedCode && prevTailLine.trim().length > 0)
        || (prev.hasUnclosedInlineCode && prevTailLine.trim().length > 0 && currentHeadLine.trim().length > 0)
      );
      if (needBlankLine) out.push('');
    }

    for (const line of current.text.split('\n')) out.push(line);

    // Prevent an unclosed fenced code block in one element from swallowing
    // subsequent independent elements in downstream GFM renderers.
    if (current.unclosedFence && hasNext) {
      out.push(current.unclosedFence.char.repeat(current.unclosedFence.length));
    }
  }
  return out.join('\n');
}

function trimBlankLines(text: string): string {
  const lines = text.split('\n');
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]!.trim()) start += 1;
  while (end > start && !lines[end - 1]!.trim()) end -= 1;
  // String.trim() would turn a first-segment indented code block into prose by
  // deleting its four-space prefix. Remove boundary blank lines only.
  return lines.slice(start, end).join('\n');
}

function clampReplyText(text: string): string {
  if (text.length <= MAX_REPLY_TEXT_CHARS) return text;
  let cut = MAX_REPLY_TEXT_CHARS - 1;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}…`;
}

/** Readable text of an interactive card, or `undefined` when it has none.
 *  Never throws: malformed input degrades to `undefined`. */
export function extractInteractiveCardReplyText(card: unknown): string | undefined {
  try {
    const bounded = boundedCopy(card, 0, { nodes: 0, chars: 0 });
    if (!isRecord(bounded) || bounded.type === 'template') return undefined;
    const text = trimBlankLines(assembleSegments(collectCardSegments(bounded)));
    if (!text || isPlaceholderOnlyText(text)) return undefined;
    return clampReplyText(text);
  } catch {
    return undefined;
  }
}
