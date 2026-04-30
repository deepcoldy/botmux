/**
 * Markdown → Feishu interactive card v2 body builder.
 *
 * Shared by `cli.ts` (`botmux send`) and `core/worker-pool.ts` (bridge
 * fallback final_output forwarding) so a model reply going through either
 * path renders identically in the Lark thread — same chrome, same markdown
 * rendering, same table widget.
 *
 * Pure: no I/O, no module-level state. Exported helpers are tested by their
 * call sites' integration tests; no separate unit suite to keep the module
 * dependency-free.
 */

/** Feishu card markdown element doesn't render ATX headings → promote to bold. */
export function transformHeadings(md: string): string {
  return md.replace(/^#{1,6}\s+(.+)$/gm, (_m, c: string) => `**${c.trim()}**`);
}

/** Parse a contiguous pipe-table block into a Feishu card v2 `table` element. */
export function parseTableBlock(block: string): any | null {
  const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const rows = lines.map(l => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
  const sepIdx = rows.findIndex(r => r.length > 0 && r.every(c => /^:?-{2,}:?$/.test(c)));
  const header = rows[0];
  const body = sepIdx === 1 ? rows.slice(2) : rows.slice(1);
  if (header.length === 0) return null;
  const columns = header.map((h, i) => ({
    name: `c${i}`,
    display_name: h || ' ',
    data_type: 'lark_md',
    width: 'auto',
  }));
  const tableRows = body.map(r => {
    const o: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) o[`c${i}`] = r[i] ?? '';
    return o;
  });
  return {
    tag: 'table',
    page_size: Math.min(10, Math.max(1, tableRows.length || 1)),
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
    rows: tableRows,
  };
}

/**
 * Split markdown into card v2 body elements:
 *   1. Fenced code blocks are preserved verbatim (shielded from heading/table
 *      transforms so `#` and `|` inside code don't get mis-parsed).
 *   2. Pipe-table blocks in prose become native `table` elements.
 *   3. Everything else becomes a `markdown` element with ATX headings promoted
 *      to bold (Feishu's markdown element doesn't render `#`).
 * Consecutive markdown fragments are merged so the card keeps reasonable
 * element counts.
 */
export function buildCardBodyElements(md: string): any[] {
  const elements: any[] = [];
  let buffer = '';
  const flushBuffer = () => {
    const t = buffer.replace(/^\s+|\s+$/g, '');
    if (t) elements.push({ tag: 'markdown', content: transformHeadings(t) });
    buffer = '';
  };

  // Segment by fenced code blocks (``` ... ```)
  const fenceRe = /^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm;
  const segments: Array<{ type: 'prose' | 'code'; text: string }> = [];
  let fCursor = 0;
  let fm: RegExpExecArray | null;
  while ((fm = fenceRe.exec(md)) !== null) {
    if (fm.index > fCursor) segments.push({ type: 'prose', text: md.slice(fCursor, fm.index) });
    segments.push({ type: 'code', text: fm[0] });
    fCursor = fm.index + fm[0].length;
  }
  if (fCursor < md.length) segments.push({ type: 'prose', text: md.slice(fCursor) });

  for (const seg of segments) {
    if (seg.type === 'code') {
      buffer += (buffer && !buffer.endsWith('\n') ? '\n' : '') + seg.text + '\n';
      continue;
    }
    const tableRe = /(?:^[ \t]*\|.+\|[ \t]*\r?\n?){2,}/gm;
    let tCursor = 0;
    let tm: RegExpExecArray | null;
    while ((tm = tableRe.exec(seg.text)) !== null) {
      buffer += seg.text.slice(tCursor, tm.index);
      flushBuffer();
      const table = parseTableBlock(tm[0]);
      if (table) elements.push(table);
      else buffer += tm[0];
      tCursor = tm.index + tm[0].length;
    }
    buffer += seg.text.slice(tCursor);
  }
  flushBuffer();
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
