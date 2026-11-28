/**
 * Readable text for an outbound interactive card (`botmux send --card-file`,
 * `--card-json`, `--diff`), recorded as `SessionTurnReply.text` so turn
 * readers (`GET /api/sessions/:id/turns`) can show what the card said.
 *
 * Rendering itself is {@link extractCardContent} — the same normalizer used
 * for inbound/history/quoted cards — so a card reads the same in every view.
 * This wrapper only adds what a recording path needs on top of it:
 *   - a bounded copy of the card (depth / node / character budget), so an
 *     abusive or accidentally huge JSON cannot blow the stack or the CPU;
 *   - header subtitles and collapsible panel titles lifted into ordinary
 *     text nodes (the shared renderer skips them);
 *   - `undefined` instead of the `[卡片]` / `[卡片 (模板)]` placeholders, so
 *     callers omit `text` rather than store a zero-information string;
 *   - plain GFM output (Lark `<font>` / `<text_tag>` / `<number_tag>` / `<br>`
 *     rewritten, tables set off by blank lines), because turn readers render
 *     the text with raw HTML disabled.
 *
 * Privacy scrubbing is NOT done here: `recordSessionTurnReplies` runs every
 * reply text through `publicMessageText` before it is persisted.
 */
import { extractCardContent, isPlaceholderOnlyText } from './message-parser.js';

const MAX_CARD_DEPTH = 32;
const MAX_CARD_NODES = 5_000;
const MAX_CARD_STRING_CHARS = 128 * 1024;
const MAX_REPLY_TEXT_CHARS = 64 * 1024;
/** Mirrors message-parser's pre-resolved text sentinel: honouring it on an
 *  outbound card would let the JSON claim text the card never displays. */
const RESOLVED_TEXT_KEY = '__botmux_card_text__';

interface Budget {
  nodes: number;
  chars: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedCopy(value: unknown, depth: number, budget: Budget): unknown {
  if (typeof value === 'string') {
    const room = MAX_CARD_STRING_CHARS - budget.chars;
    if (room <= 0) return undefined;
    const kept = value.length > room ? value.slice(0, room) : value;
    budget.chars += kept.length;
    return kept;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_CARD_DEPTH || budget.nodes >= MAX_CARD_NODES) return undefined;
  budget.nodes += 1;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      if (budget.nodes >= MAX_CARD_NODES) break;
      const copied = boundedCopy(item, depth + 1, budget);
      if (copied !== undefined) out.push(copied);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (budget.nodes >= MAX_CARD_NODES) break;
    if (key === RESOLVED_TEXT_KEY) continue;
    const copied = boundedCopy(item, depth + 1, budget);
    if (copied !== undefined) out[key] = copied;
  }
  return out;
}

/** Visible text of a title-like value: string, `{content}`, `{text:{content}}`. */
function titleText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!isRecord(value)) return undefined;
  const text = value.text;
  const candidate = typeof value.content === 'string'
    ? value.content
    : isRecord(text) && typeof text.content === 'string'
      ? text.content
      : typeof text === 'string' ? text : undefined;
  return candidate?.trim() || undefined;
}

function firstLocaleValue(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  return value.zh_cn ?? value.en_us ?? Object.values(value)[0];
}

/** Prepend a collapsible panel's header title to its body, recursively. */
function liftPanelTitles(value: unknown, depth = 0): unknown {
  if (depth >= MAX_CARD_DEPTH) return value;
  if (Array.isArray(value)) return value.map(item => liftPanelTitles(item, depth + 1));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = liftPanelTitles(item, depth + 1);
  if (out.tag === 'collapsible_panel') {
    const header = isRecord(out.header) ? out.header : undefined;
    const title = titleText(header?.title);
    if (title) {
      const children = Array.isArray(out.elements) ? out.elements : [];
      out.elements = [{ tag: 'markdown', content: title }, ...children];
    }
  }
  return out;
}

function readableCardShape(card: Record<string, unknown>): Record<string, unknown> {
  const out = liftPanelTitles(card) as Record<string, unknown>;
  const body = isRecord(out.body) ? { ...out.body } : undefined;
  if (body) out.body = body;

  // Schema 1.0 i18n cards carry no top-level `elements`/`header`.
  if (!Array.isArray(body?.elements) && !Array.isArray(out.elements)) {
    const localized = firstLocaleValue(out.i18n_elements);
    if (Array.isArray(localized)) out.elements = localized;
  }
  if (!isRecord(out.header) && isRecord(firstLocaleValue(out.i18n_header))) {
    out.header = firstLocaleValue(out.i18n_header);
  }

  const header = isRecord(out.header) ? out.header : undefined;
  const subtitle = titleText(header?.subtitle);
  if (subtitle) {
    const target: Record<string, unknown> = Array.isArray(body?.elements) || (body && !Array.isArray(out.elements))
      ? body!
      : out;
    const elements = Array.isArray(target.elements) ? target.elements : [];
    const formatA = elements.length > 0 && Array.isArray(elements[0]);
    target.elements = [
      formatA ? [{ tag: 'text', text: subtitle }] : { tag: 'markdown', content: subtitle },
      ...elements,
    ];
  }
  return out;
}

// ─── GFM normalization ───────────────────────────────────────────────────────
// Turn readers render `reply.text` as plain GFM with raw HTML disabled, so
// Lark-only inline tags and `<br>` would show up as literal source. Code
// (fenced blocks and inline spans) is left exactly as authored.

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE_RE = /(?<!`)(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g;
// Attribute and label lengths are capped so text full of unclosed tags stays
// linear instead of rescanning to the end from every `<`.
const TAG_ATTRS = String.raw`(?:[^>"']|"[^"]{0,256}"|'[^']{0,256}'){0,512}`;
/** Opening and closing `<font>` tags alike are dropped: unwrapping every pair
 *  and dropping every orphan give the same text, without pairing nested tags. */
const FONT_TAG_RE = new RegExp(String.raw`<\/?font\b${TAG_ATTRS}>`, 'gi');
const BADGE_PAIR_RE = new RegExp(String.raw`<(text_tag|number_tag)\b${TAG_ATTRS}>([^<]{0,256})<\/\1\s*>`, 'gi');
const BADGE_ORPHAN_RE = new RegExp(String.raw`<\/?(?:text_tag|number_tag)\b${TAG_ATTRS}>`, 'gi');
const BR_RE = /<br\s*\/?>/gi;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_DELIMITER_RE = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;
const PLACEHOLDER_OPEN = '';
const PLACEHOLDER_CLOSE = '';

function normalizeProse(segment: string): string {
  const codeSpans: string[] = [];
  let out = segment.replace(INLINE_CODE_RE, span => {
    codeSpans.push(span);
    return `${PLACEHOLDER_OPEN}${codeSpans.length - 1}${PLACEHOLDER_CLOSE}`;
  });
  out = out.replace(FONT_TAG_RE, '');
  out = out.replace(BADGE_PAIR_RE, (_match, _tag: string, inner: string) => {
    const label = inner.trim();
    if (!label) return '';
    return label.includes('`') || label.includes('\n') ? `[${label}]` : `\`${label}\``;
  });
  out = out.replace(BADGE_ORPHAN_RE, '');
  out = out
    .split('\n')
    .map(line => (TABLE_ROW_RE.test(line) ? line.replace(BR_RE, ' / ') : line.replace(BR_RE, '\n')))
    .join('\n');
  return out.replace(
    new RegExp(`${PLACEHOLDER_OPEN}(\\d+)${PLACEHOLDER_CLOSE}`, 'g'),
    (_match, index: string) => codeSpans[Number(index)] ?? '',
  );
}

/** Give every GFM table (header row + delimiter row) a blank line on both
 *  sides so renderers do not fold it into the preceding paragraph. */
function separateTables(lines: readonly string[], inCode: readonly boolean[]): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const isTableStart = !inCode[index] && index + 1 < lines.length && !inCode[index + 1]
      && TABLE_ROW_RE.test(lines[index]!) && TABLE_DELIMITER_RE.test(lines[index + 1]!);
    if (!isTableStart) {
      out.push(lines[index]!);
      index += 1;
      continue;
    }
    if (out.length > 0 && out[out.length - 1]!.trim()) out.push('');
    while (index < lines.length && !inCode[index] && TABLE_ROW_RE.test(lines[index]!)) {
      out.push(lines[index]!);
      index += 1;
    }
    if (index < lines.length && lines[index]!.trim()) out.push('');
  }
  return out;
}

function normalizeCardReplyMarkdown(text: string): string {
  const source = text.replaceAll(PLACEHOLDER_OPEN, '').replaceAll(PLACEHOLDER_CLOSE, '');
  const lines: string[] = [];
  const inCode: boolean[] = [];
  let prose: string[] = [];
  const flushProse = () => {
    if (prose.length === 0) return;
    for (const line of normalizeProse(prose.join('\n')).split('\n')) {
      lines.push(line);
      inCode.push(false);
    }
    prose = [];
  };
  let fence: { char: string; length: number } | undefined;
  for (const line of source.split('\n')) {
    const marker = FENCE_RE.exec(line)?.[1];
    if (fence) {
      lines.push(line);
      inCode.push(true);
      if (marker && marker[0] === fence.char && marker.length >= fence.length && !line.slice(line.indexOf(marker) + marker.length).trim()) {
        fence = undefined;
      }
      continue;
    }
    if (marker) {
      flushProse();
      fence = { char: marker[0]!, length: marker.length };
      lines.push(line);
      inCode.push(true);
      continue;
    }
    prose.push(line);
  }
  flushProse();
  return separateTables(lines, inCode).join('\n');
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
    if (!isRecord(bounded)) return undefined;
    const rendered = clampReplyText(extractCardContent(JSON.stringify(readableCardShape(bounded))));
    const text = normalizeCardReplyMarkdown(rendered).trim();
    if (!text || isPlaceholderOnlyText(text)) return undefined;
    return clampReplyText(text);
  } catch {
    return undefined;
  }
}
