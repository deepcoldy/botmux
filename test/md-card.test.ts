/**
 * Unit tests for src/im/lark/md-card.ts.
 *
 * Run:  pnpm vitest run test/md-card.test.ts
 *
 * Covers the two production rendering bugs that motivated the markdown-it
 * rewrite plus baseline behaviors that must not regress.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCardBodyElements,
  buildMarkdownCard,
  buildContextualReplyCard,
  brandFooterSegment,
  DEFAULT_BRAND_LABEL,
  hasMarkdown,
} from '../src/im/lark/md-card.js';

function mdElements(out: any[]): Array<{ tag: 'markdown'; content: string }> {
  return out.filter(e => e.tag === 'markdown');
}

describe('buildCardBodyElements', () => {
  it('returns [] for empty input', () => {
    expect(buildCardBodyElements('')).toEqual([]);
  });

  it('plain text → single markdown element', () => {
    const out = buildCardBodyElements('hello world');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tag: 'markdown', content: 'hello world' });
  });

  it('promotes ATX headings to bold (Feishu markdown widget can\'t render #)', () => {
    const out = buildCardBodyElements('# Title\n\nbody text');
    const text = mdElements(out)[0].content;
    expect(text).toContain('**Title**');
    expect(text).not.toMatch(/^#\s/m);
  });

  it('Bug A: code fence with no blank line before/after still emits a fenced block', () => {
    // This is the exact shape of the production bug: prose line directly
    // followed by ```ts, no blank line. The Feishu widget needs blank lines
    // around fences to recognise them.
    const input = ['是同步返回：', '```ts', 'const x = 1', '```', 'next prose'].join('\n');
    const out = buildCardBodyElements(input);
    const content = mdElements(out)[0].content;
    // Fence must be preserved as a code block.
    expect(content).toMatch(/```ts\nconst x = 1\n```/);
    // And must have a blank line before the opening fence and after the closing fence.
    expect(content).toMatch(/是同步返回：\n\n```ts/);
    expect(content).toMatch(/```\n\nnext prose/);
  });

  it('Bug B: 3-backtick nested fences don\'t corrupt later prose', () => {
    // CommonMark treats this as TWO adjacent code blocks (the "outer" closes
    // at the first inner ```). markdown-it parses the same way. The
    // important guarantee is: no stray ``` literals leak into the rendered
    // markdown content, and prose after the blocks survives intact.
    const input = [
      '**给你一个 prompt：**',
      '```plain_text',
      '外层第一行',
      '```',
      'const x = 1',
      '```',
      '外层最后一行',
      '```',
      '',
      '后续散文段落',
    ].join('\n');
    const out = buildCardBodyElements(input);
    const content = mdElements(out).map(e => e.content).join('\n\n');
    // Trailing prose must survive untouched.
    expect(content).toContain('后续散文段落');
    // No stray fence character runs other than balanced ``` pairs.
    const fenceRuns = content.match(/```/g) ?? [];
    expect(fenceRuns.length % 2).toBe(0);
  });

  it('4-backtick outer fence preserves a 3-backtick inner verbatim (CommonMark nesting)', () => {
    const input = [
      '````plain_text',
      'instruction:',
      '```',
      'inner code',
      '```',
      '````',
    ].join('\n');
    const out = buildCardBodyElements(input);
    const content = mdElements(out)[0].content;
    expect(content).toMatch(/^````plain_text/m);
    expect(content).toMatch(/```\ninner code\n```/);
    expect(content).toMatch(/^````$/m);
  });

  it('GFM pipe table → native `table` element (not text)', () => {
    const input = [
      '| Col A | Col B |',
      '| --- | --- |',
      '| a1 | b1 |',
      '| a2 | b2 |',
    ].join('\n');
    const out = buildCardBodyElements(input);
    const tables = out.filter(e => e.tag === 'table');
    expect(tables).toHaveLength(1);
    expect(tables[0].columns).toHaveLength(2);
    expect(tables[0].columns[0].display_name).toBe('Col A');
    expect(tables[0].rows).toEqual([
      { c0: 'a1', c1: 'b1' },
      { c0: 'a2', c1: 'b2' },
    ]);
  });

  it('table flanked by prose → prose, table, prose are separate elements', () => {
    const input = [
      'before',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      'after',
    ].join('\n');
    const out = buildCardBodyElements(input);
    expect(out.map(e => e.tag)).toEqual(['markdown', 'table', 'markdown']);
    expect(out[0].content).toBe('before');
    expect(out[2].content).toBe('after');
  });

  it('bullet list survives as one markdown block', () => {
    const input = ['- one', '- two', '- three'].join('\n');
    const out = buildCardBodyElements(input);
    expect(mdElements(out)[0].content).toContain('- one');
    expect(mdElements(out)[0].content).toContain('- three');
  });

  it('preserves the original backtick run when re-emitting fences', () => {
    const input = '`````\nfive backticks\n`````';
    const out = buildCardBodyElements(input);
    expect(mdElements(out)[0].content).toMatch(/^`````/);
  });

  it('defensive unescape: line-start escaped fences (\\` × 3) are recovered', () => {
    // Production bug: an LLM bot wrote `\`\`\`` inside `<<'EOF'` so the
    // markdown reaching us has literal backslash-backticks. CommonMark says
    // each `\\\`` is just a literal backtick, so no fence opens. Our
    // pre-processor strips the backslashes on whole-line escaped fences and
    // recovers the code block.
    const input = ['prose:', '\\`\\`\\`', 'const x = 1', '\\`\\`\\`', 'after'].join('\n');
    const out = buildCardBodyElements(input);
    const content = mdElements(out)[0].content;
    expect(content).toMatch(/```\nconst x = 1\n```/);
    expect(content).not.toContain('\\`');
  });

  it('defensive unescape: opening with language tag works', () => {
    const input = ['\\`\\`\\`bash', 'echo hi', '\\`\\`\\`'].join('\n');
    const out = buildCardBodyElements(input);
    expect(mdElements(out)[0].content).toMatch(/```bash\necho hi\n```/);
  });

  it('defensive unescape: mixed (escaped open + real close) still recovers', () => {
    const input = ['\\`\\`\\`ts', 'const a = 2', '```'].join('\n');
    const out = buildCardBodyElements(input);
    expect(mdElements(out)[0].content).toMatch(/```ts\nconst a = 2\n```/);
  });

  it('defensive unescape: indented fence (≤3 spaces) is normalized', () => {
    const input = ['  \\`\\`\\`', 'code', '  \\`\\`\\`'].join('\n');
    const out = buildCardBodyElements(input);
    expect(mdElements(out)[0].content).toMatch(/```\s*\ncode\s*\n```/);
  });

  it('defensive unescape: inline \\` is left alone', () => {
    // Inline backslash-backtick is a legitimate CommonMark escape — we must
    // not touch it. Only whole-line pure escape sequences trigger.
    const input = 'use \\`raw\\` to escape backticks inline';
    const out = buildCardBodyElements(input);
    // Source still contains the inline escape; markdown-it renders it as a
    // literal backtick which is fine.
    expect(mdElements(out)[0].content).toContain('\\`raw\\`');
  });

  it('defensive unescape: line with text mixed in is left alone', () => {
    // "Use \\`\\`\\` for fences" is prose mentioning escape syntax — the line
    // is not pure escaped backticks, so we don't touch it.
    const input = 'Use \\`\\`\\` for fences';
    const out = buildCardBodyElements(input);
    expect(mdElements(out)[0].content).toContain('\\`\\`\\`');
  });
});

describe('buildMarkdownCard', () => {
  it('appends footer hr + grey link element', () => {
    const json = buildMarkdownCard('hello');
    const card = JSON.parse(json);
    const tags = card.body.elements.map((e: any) => e.tag);
    expect(tags).toContain('hr');
    const last = card.body.elements[card.body.elements.length - 1];
    expect(last.content).toContain('[botmux](');
  });

  it('addresses recipient in footer when openId is provided', () => {
    const json = buildMarkdownCard('hi', 'ou_abc');
    const card = JSON.parse(json);
    const last = card.body.elements[card.body.elements.length - 1];
    expect(last.content).toContain('<at id=ou_abc></at>');
  });

  it('omits recipient line when openId is undefined', () => {
    const json = buildMarkdownCard('hi');
    const card = JSON.parse(json);
    const last = card.body.elements[card.body.elements.length - 1];
    expect(last.content).not.toContain('<at id=');
  });
});

describe('hasMarkdown', () => {
  it('detects fences', () => expect(hasMarkdown('a\n```\nx\n```')).toBe(true));
  it('detects headings', () => expect(hasMarkdown('# title')).toBe(true));
  it('detects bold', () => expect(hasMarkdown('hello **world**')).toBe(true));
  it('detects pipe tables', () => expect(hasMarkdown('| a | b |\n| - | - |')).toBe(true));
  it('returns false for plain text', () => expect(hasMarkdown('just words here')).toBe(false));
  it('returns false for empty', () => expect(hasMarkdown('')).toBe(false));
});

// ─── Footer brand label (per-bot configurable) ────────────────────────────

describe('brandFooterSegment', () => {
  it('undefined (unset) → default botmux brand', () => {
    expect(brandFooterSegment(undefined)).toBe(DEFAULT_BRAND_LABEL);
  });
  it('empty / whitespace → null (brand off)', () => {
    expect(brandFooterSegment('')).toBeNull();
    expect(brandFooterSegment('   ')).toBeNull();
  });
  it('custom string → verbatim (markdown allowed)', () => {
    expect(brandFooterSegment('[Acme](https://acme.test)')).toBe('[Acme](https://acme.test)');
  });
});

describe('buildMarkdownCard footer brand', () => {
  const lastEl = (json: string) => { const els = JSON.parse(json).body.elements; return els[els.length - 1]; };

  it('unset brand → default botmux footer', () => {
    expect(lastEl(buildMarkdownCard('hi', 'ou_x')).content).toContain(DEFAULT_BRAND_LABEL);
  });

  it('custom brand → custom footer, no botmux', () => {
    const c = lastEl(buildMarkdownCard('hi', 'ou_x', '[Acme](https://acme.test)')).content;
    expect(c).toContain('[Acme](https://acme.test)');
    expect(c).toContain('发送给');
    expect(c).not.toContain('botmux');
  });

  it('empty brand + recipient → footer keeps 发送给 only, no brand', () => {
    const c = lastEl(buildMarkdownCard('hi', 'ou_x', '')).content;
    expect(c).toContain('发送给');
    expect(c).not.toContain('botmux');
  });

  it('empty brand + no recipient → no footer at all (no orphan hr)', () => {
    const els = JSON.parse(buildMarkdownCard('hi', undefined, '')).body.elements;
    expect(els.some((e: any) => e.tag === 'hr')).toBe(false);
    expect(els.some((e: any) => e.text_size === 'notation_small_v2')).toBe(false);
    expect(JSON.stringify(els)).not.toContain('botmux');
    expect(els.some((e: any) => e.tag === 'markdown' && /hi/.test(e.content))).toBe(true);
  });
});

describe('buildContextualReplyCard footer brand', () => {
  it('custom brand renders; default botmux omitted', () => {
    const els = JSON.parse(buildContextualReplyCard({
      title: 'T', assistantText: 'a', assistantLabel: 'Claude', recipientOpenId: 'ou_x', brand: 'Acme',
    })).body.elements;
    const last = els[els.length - 1];
    expect(last.text_size).toBe('notation_small_v2');
    expect(last.content).toContain('Acme');
    expect(last.content).not.toContain('botmux');
  });

  it('empty brand + no recipient → no grey footer element', () => {
    const els = JSON.parse(buildContextualReplyCard({
      title: 'T', assistantText: 'a', assistantLabel: 'Claude', brand: '',
    })).body.elements;
    expect(els.some((e: any) => e.text_size === 'notation_small_v2')).toBe(false);
    expect(JSON.stringify(els)).not.toContain('botmux');
  });
});
