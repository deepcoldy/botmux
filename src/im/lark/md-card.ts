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

const md = new MarkdownIt({ html: false, linkify: false, breaks: false });

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
 * `[botmux](github)` link + optional `发送给：@<owner>` mention.
 *
 * `recipientOpenId` (when given) renders as `<at id=…></at>` in the
 * footer — typically the session owner. Pass `undefined` to omit the
 * addressing line (e.g. top-level broadcasts have no specific recipient).
 */
export function buildMarkdownCard(md: string, recipientOpenId?: string): string {
  const elements = md ? buildCardBodyElements(md) : [];
  const footerParts = ['[botmux](https://github.com/deepcoldy/botmux)'];
  if (recipientOpenId) footerParts.push(`发送给：<at id=${recipientOpenId}></at>`);
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    text_size: 'notation_small_v2',
    content: `<font color='grey'>${footerParts.join(' · ')}</font>`,
  });
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
}): string {
  const { title, userText, assistantText, assistantLabel, recipientOpenId } = opts;
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
      content: `**👤 你**\n\n${quoteLines(u || '(空)')}`,
    });
  }

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content: `**🤖 ${assistantLabel}**`,
  });

  const bodyElements = assistantText.trim()
    ? buildCardBodyElements(assistantText)
    : [{ tag: 'markdown', content: '*(空)*' }];
  for (const el of bodyElements) elements.push(el);

  const footerParts = ['[botmux](https://github.com/deepcoldy/botmux)'];
  if (recipientOpenId) footerParts.push(`发送给：<at id=${recipientOpenId}></at>`);
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    text_size: 'notation_small_v2',
    content: `<font color='grey'>${footerParts.join(' · ')}</font>`,
  });

  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    body: { direction: 'vertical', elements },
  });
}
