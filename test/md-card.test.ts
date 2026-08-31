/**
 * Unit tests for src/im/lark/md-card.ts.
 *
 * Run:  pnpm vitest run test/md-card.test.ts
 *
 * Covers the two production rendering bugs that motivated the markdown-it
 * rewrite plus baseline behaviors that must not regress.
 */
import { describe, it, expect } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendReplyCardFooterToV2Card,
  buildCardBodyElements,
  buildCanonicalFinalReplyCard,
  buildImageCardElements,
  buildMarkdownCard,
  buildContextualReplyCard,
  buildReplyCardFooter,
  brandFooterSegment,
  cardUsageFooterSegment,
  cardUsageRuntimeSegment,
  createReplyCard,
  DEFAULT_BRAND_LABEL,
  extractFirstReplyCardHeading,
  hasMarkdown,
  normalizeLocalHomeLinks,
} from '../src/im/lark/md-card.js';

function mdElements(out: any[]): Array<{ tag: 'markdown'; content: string }> {
  return out.filter(e => e.tag === 'markdown');
}

describe('reply-card layout envelope and title extraction', () => {
  it('keeps the ordinary v2 envelope identical when no header is requested', () => {
    expect(createReplyCard([{ tag: 'markdown', content: '正文' }])).toEqual({
      schema: '2.0',
      config: { update_multi: true, width_mode: 'fill' },
      body: {
        direction: 'vertical',
        elements: [{ tag: 'markdown', content: '正文' }],
      },
    });
  });

  it('puts an optional Card 2.0 header on the same canonical envelope', () => {
    const header = {
      template: 'indigo' as const,
      title: { tag: 'plain_text' as const, content: '交接 · 下一位接手发布' },
    };
    expect(createReplyCard([], header)).toMatchObject({
      schema: '2.0',
      config: { update_multi: true, width_mode: 'fill' },
      header,
      body: { direction: 'vertical', elements: [] },
    });
  });

  it('consumes only the first top-level ATX H1/H2 and preserves the rest', () => {
    const input = [
      '> # 引用标题',
      '',
      '```md',
      '# 代码里的标题',
      '```',
      '',
      '### 细节',
      '',
      '## **发布** [说明](https://example.com) `v2`',
      '',
      '正文',
      '',
      '# 第二个标题',
    ].join('\n');
    const extracted = extractFirstReplyCardHeading(input);

    expect(extracted.heading).toBe('发布 说明 v2');
    expect(extracted.markdown).not.toContain('## **发布**');
    expect(extracted.markdown).toContain('> # 引用标题');
    expect(extracted.markdown).toContain('# 代码里的标题');
    expect(extracted.markdown).toContain('### 细节');
    expect(extracted.markdown).toContain('# 第二个标题');
  });

  it('does not consume H3, setext, or an empty ATX heading', () => {
    for (const input of ['### 细节\n\n正文', '旧标题\n===\n\n正文', '#\n\n正文']) {
      expect(extractFirstReplyCardHeading(input)).toEqual({ markdown: input });
    }
  });
});

describe('buildCardBodyElements', () => {
  it('returns [] for empty input', () => {
    expect(buildCardBodyElements('')).toEqual([]);
  });

  it('plain text → single markdown element', () => {
    const out = buildCardBodyElements('hello world');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tag: 'markdown', content: 'hello world' });
  });

  it('promotes H1/H2 to standalone heading components', () => {
    const out = buildCardBodyElements('# Title\n\nbody text');
    expect(out).toEqual([
      { tag: 'markdown', element_id: 'botmux_md_h1_1', text_size: 'heading-2', content: 'Title' },
      { tag: 'markdown', content: 'body text' },
    ]);

    expect(buildCardBodyElements('## Section\n\nbody')).toEqual([
      { tag: 'markdown', element_id: 'botmux_md_h2_1', text_size: 'heading-2', content: 'Section' },
      { tag: 'markdown', content: 'body' },
    ]);
  });

  it('encodes the original ATX level and a per-card sequence in heading element ids', () => {
    // Message reads strip text_size, so the element id is the only carrier of
    // heading hierarchy that survives Lark normalization (see message-parser).
    const out = buildCardBodyElements('# 结果\n\n正文\n\n## 验证\n\n更多\n\n## 下一步\n\n尾声');
    const ids = out.filter((e: any) => e.element_id).map((e: any) => e.element_id);
    expect(ids).toEqual(['botmux_md_h1_1', 'botmux_md_h2_2', 'botmux_md_h2_3']);
  });

  it('keeps H3-H6 compact as bold markdown', () => {
    const out = buildCardBodyElements('### Detail\n\nbody text');
    expect(out).toEqual([{ tag: 'markdown', content: '**Detail**\n\nbody text' }]);
  });

  it('keeps setext headings on the compact fallback path', () => {
    const out = buildCardBodyElements('Legacy title\n===\n\nbody text');
    expect(out).toEqual([{ tag: 'markdown', content: '**Legacy title**\n\nbody text' }]);
  });

  it('keeps structured heading, prose, table, and code sections in source order', () => {
    const input = [
      '# 执行结果',
      '',
      '核心链路已验证。',
      '',
      '| 项目 | 结果 |',
      '| --- | --- |',
      '| build | pass |',
      '',
      '## 验证命令',
      '',
      '```bash',
      'bun run build',
      '```',
    ].join('\n');
    const out = buildCardBodyElements(input);

    expect(out.map(element => element.tag)).toEqual([
      'markdown', 'markdown', 'table', 'markdown', 'markdown',
    ]);
    expect(out[0]).toMatchObject({ text_size: 'heading-2', content: '执行结果' });
    expect(out[1].content).toBe('核心链路已验证。');
    expect(out[2].rows).toEqual([{ c0: 'build', c1: 'pass' }]);
    expect(out[3]).toMatchObject({ text_size: 'heading-2', content: '验证命令' });
    expect(out[4].content).toContain('```bash\nbun run build\n```');
  });

  it('bounds promoted headings and preserves overflow headings as bold text', () => {
    const input = Array.from(
      { length: 8 },
      (_, index) => `# Section ${index + 1}\n\nbody ${index + 1}`,
    ).join('\n\n');
    const out = buildCardBodyElements(input);
    const promoted = out.filter(element => element.text_size === 'heading-2');
    const rendered = mdElements(out).map(element => element.content).join('\n\n');

    expect(promoted).toHaveLength(6);
    expect(rendered).toContain('**Section 7**');
    expect(rendered).toContain('**Section 8**');
    expect(rendered).toContain('body 8');
  });

  it('does not promote heading-looking lines inside a code fence', () => {
    const out = buildCardBodyElements('```markdown\n# literal heading\n```');
    expect(out).toEqual([{
      tag: 'markdown',
      content: '```markdown\n# literal heading\n```',
    }]);
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

describe('normalizeLocalHomeLinks', () => {
  const home = '/Users/alice';
  const absoluteHomeFileExists = (path: string) => path.startsWith('/Users/alice/');

  it('restores the leading slash dropped from a current-home link', () => {
    expect(normalizeLocalHomeLinks('[report](Users/alice/work/report.md)', home, '/tmp/project', absoluteHomeFileExists))
      .toBe('[report](/Users/alice/work/report.md)');
    expect(normalizeLocalHomeLinks('[report](users/alice/work/report.md)', home, '/tmp/project', absoluteHomeFileExists))
      .toBe('[report](/Users/alice/work/report.md)');
  });

  it('supports an angle-bracket destination containing spaces', () => {
    expect(normalizeLocalHomeLinks('[report](<Users/alice/My Project/report.md>)', home, '/tmp/project', absoluteHomeFileExists))
      .toBe('[report](</Users/alice/My Project/report.md>)');
  });

  it('repairs a destination with a CommonMark-escaped slash', () => {
    expect(normalizeLocalHomeLinks(
      '[report](Users/alice\\/work/report.md)', home, '/tmp/project',
      path => path === '/Users/alice/work/report.md',
    )).toBe('[report](/Users/alice\\/work/report.md)');
  });

  it('does not alter absolute, web, or unrelated relative links', () => {
    const input = [
      '[absolute](/Users/alice/work/a.md)',
      '[web](https://example.test/Users/alice/a.md)',
      '[relative](Users/guide.md)',
      '[other user](Users/bob/a.md)',
    ].join('\n');
    expect(normalizeLocalHomeLinks(input, home)).toBe(input);
  });

  it('preserves a current-home-shaped target when it exists relative to cwd', () => {
    const seen: string[] = [];
    const input = '[report](Users/alice/work/report.md)';
    const output = normalizeLocalHomeLinks(input, home, '/tmp/project', path => {
      seen.push(path);
      return path === '/tmp/project/Users/alice/work/report.md';
    });

    expect(output).toBe(input);
    expect(seen).toEqual(['/tmp/project/Users/alice/work/report.md']);
  });

  it('uses the source case when checking a cwd-relative target on Linux', () => {
    const input = '[case-relative](Home/alice/a.md)';
    const seen: string[] = [];
    const output = normalizeLocalHomeLinks(input, '/home/alice', '/tmp/project', path => {
      seen.push(path);
      return path === '/tmp/project/Home/alice/a.md' || path === '/home/alice/a.md';
    });

    expect(output).toBe(input);
    expect(seen).toEqual(['/tmp/project/Home/alice/a.md']);
  });

  it('preserves an exact-case relative file using real filesystem checks', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-md-card-case-'));
    const fakeHome = join(root, 'home', 'alice');
    const cwd = join(root, 'project');
    const canonicalRelative = fakeHome.replace(/^\/+/, '');
    const sourceRelative = canonicalRelative.replace(/home\/alice$/, 'Home/alice');
    try {
      mkdirSync(join(fakeHome), { recursive: true });
      mkdirSync(join(cwd, sourceRelative), { recursive: true });
      writeFileSync(join(fakeHome, 'a.md'), 'absolute');
      writeFileSync(join(cwd, sourceRelative, 'a.md'), 'relative');
      const input = `[case-relative](${sourceRelative}/a.md)`;
      expect(normalizeLocalHomeLinks(input, fakeHome, cwd)).toBe(input);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('repairs a current-home-shaped target when it does not exist relative to cwd', () => {
    expect(normalizeLocalHomeLinks(
      '[report](Users/alice/work/report.md)',
      home,
      '/tmp/project',
      path => path === '/Users/alice/work/report.md',
    )).toBe('[report](/Users/alice/work/report.md)');
  });

  it('repairs Codex :line and :line:column file destinations', () => {
    const exists = (path: string) => path === '/Users/alice/work/file.ts';
    expect(normalizeLocalHomeLinks(
      '[line](Users/alice/work/file.ts:57)', home, '/tmp/project', exists,
    )).toBe('[line](/Users/alice/work/file.ts:57)');
    expect(normalizeLocalHomeLinks(
      '[column](Users/alice/work/file.ts:57:9)', home, '/tmp/project', exists,
    )).toBe('[column](/Users/alice/work/file.ts:57:9)');
  });

  it('prefers a real filename containing a numeric colon suffix', () => {
    const seen: string[] = [];
    const exists = (path: string) => {
      seen.push(path);
      return path === '/Users/alice/work/file.ts:57';
    };
    expect(normalizeLocalHomeLinks(
      '[file](Users/alice/work/file.ts:57)', home, '/tmp/project', exists,
    )).toBe('[file](/Users/alice/work/file.ts:57)');
    expect(seen).toContain('/Users/alice/work/file.ts:57');
    expect(seen).not.toContain('/Users/alice/work/file.ts');
  });

  it('does not guess when neither the relative nor absolute target exists', () => {
    const input = '[report](Users/alice/work/missing.md)';
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', () => false)).toBe(input);
  });

  it('does not allow a home-shaped target to escape the home via dot segments', () => {
    const input = '[passwd](Users/alice/../../../etc/passwd)';
    const seen: string[] = [];
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', path => {
      seen.push(path);
      return path === '/etc/passwd';
    })).toBe(input);
    expect(seen).toEqual([]);
  });

  it('does not let a source-position fallback escape the home', () => {
    const input = '[escape](Users/alice/..:123)';
    const seen: string[] = [];
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', path => {
      seen.push(path);
      return path === '/Users/alice/..';
    })).toBe(input);
    expect(seen).toEqual([
      '/tmp/project/Users/alice/..:123',
      '/Users/alice/..:123',
    ]);
  });

  it('uses lexical repair without filesystem probes when requested', () => {
    const seen: string[] = [];
    expect(normalizeLocalHomeLinks(
      '[report](Users/alice/work/report.md)',
      home,
      '/tmp/project',
      path => { seen.push(path); return true; },
      'lexical',
    )).toBe('[report](/Users/alice/work/report.md)');
    expect(seen).toEqual([]);

    expect(normalizeLocalHomeLinks(
      '[escape](Users/alice/..:123)', home, '/tmp/project', () => true, 'lexical',
    )).toBe('[escape](Users/alice/..:123)');
  });

  it('leaves prepared content untouched without filesystem probes when disabled', () => {
    const input = '[report](Users/alice/work/report.md)';
    expect(normalizeLocalHomeLinks(
      input,
      home,
      '/tmp/project',
      () => { throw new Error('filesystem probe must stay disabled'); },
      'disabled',
    )).toBe(input);
  });

  it('never rewrites explicit dot-relative targets', () => {
    const input = [
      '[same dir](./Users/alice/report.md)',
      '[parent dir](../Users/alice/report.md)',
    ].join('\n');
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', () => false)).toBe(input);
  });

  it('does not rewrite examples inside inline or fenced code', () => {
    const input = [
      '`[inline](Users/alice/a.md)`',
      '```markdown',
      '[fenced](Users/alice/b.md)',
      '```',
      '[real](Users/alice/c.md)',
    ].join('\n');
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', absoluteHomeFileExists)).toBe([
      '`[inline](Users/alice/a.md)`',
      '```markdown',
      '[fenced](Users/alice/b.md)',
      '```',
      '[real](/Users/alice/c.md)',
    ].join('\n'));
  });

  it('does not rewrite a link-shaped example in an indented code block', () => {
    const input = [
      '    [indented](Users/alice/a.md)',
      '',
      '[real](Users/alice/a.md)',
    ].join('\n');
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', absoluteHomeFileExists)).toBe([
      '    [indented](Users/alice/a.md)',
      '',
      '[real](/Users/alice/a.md)',
    ].join('\n'));
  });

  it('does not rewrite a link-shaped example in a multiline code span', () => {
    const input = [
      '`first line',
      '[code](Users/alice/a.md)',
      'last line`',
      '',
      '[real](Users/alice/a.md)',
    ].join('\n');
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', absoluteHomeFileExists)).toBe([
      '`first line',
      '[code](Users/alice/a.md)',
      'last line`',
      '',
      '[real](/Users/alice/a.md)',
    ].join('\n'));
  });

  it('does not rewrite malformed link syntax that markdown-it rejects', () => {
    const input = '[not closed](Users/alice/a.md';
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', absoluteHomeFileExists)).toBe(input);
  });

  it('does not treat vertical-tab or form-feed as valid link whitespace', () => {
    const input = [
      '[vertical](\vUsers/alice/a.md)',
      '[form](\fUsers/alice/a.md)',
      '[real](Users/alice/a.md)',
    ].join('\n');
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', absoluteHomeFileExists)).toBe([
      '[vertical](\vUsers/alice/a.md)',
      '[form](\fUsers/alice/a.md)',
      '[real](/Users/alice/a.md)',
    ].join('\n'));
  });

  it('does not rewrite escaped link syntax or image destinations', () => {
    const input = [
      '\\[escaped](Users/alice/a.md)',
      '![image](Users/alice/a.md)',
      '[real](Users/alice/a.md)',
    ].join('\n');
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', absoluteHomeFileExists)).toBe([
      '\\[escaped](Users/alice/a.md)',
      '![image](Users/alice/a.md)',
      '[real](/Users/alice/a.md)',
    ].join('\n'));
  });

  it('does not rewrite code inside nested blockquote and list fences', () => {
    const input = [
      '> ```markdown',
      '> [quoted](Users/alice/a.md)',
      '> ```',
      '',
      '- item',
      '  ```markdown',
      '  [listed](Users/alice/a.md)',
      '  ```',
      '',
      '[real](Users/alice/a.md)',
    ].join('\n');
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', absoluteHomeFileExists)).toBe([
      '> ```markdown',
      '> [quoted](Users/alice/a.md)',
      '> ```',
      '',
      '- item',
      '  ```markdown',
      '  [listed](Users/alice/a.md)',
      '  ```',
      '',
      '[real](/Users/alice/a.md)',
    ].join('\n'));
  });

  it('preserves CRLF, angle brackets, query, fragment, and link title bytes', () => {
    const input = '[report](  <Users/alice/My Project/a.md?raw=1#L2>  "title"  )\r\nnext';
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', absoluteHomeFileExists))
      .toBe('[report](  </Users/alice/My Project/a.md?raw=1#L2>  "title"  )\r\nnext');
  });

  it('uses markdown semantics with lone-CR line endings', () => {
    const input = [
      'intro',
      '',
      '~~~',
      '[fenced](Users/alice/a.md)',
      '~~~',
      '',
      '    [indented](Users/alice/a.md)',
      '',
      '[real](Users/alice/a.md)',
    ].join('\r');
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', absoluteHomeFileExists)).toBe([
      'intro',
      '',
      '~~~',
      '[fenced](Users/alice/a.md)',
      '~~~',
      '',
      '    [indented](Users/alice/a.md)',
      '',
      '[real](/Users/alice/a.md)',
    ].join('\r'));
  });

  it('repairs a multiline link destination inside a blockquote', () => {
    const input = '> [report](\n> Users/alice/a.md)';
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', absoluteHomeFileExists))
      .toBe('> [report](\n> /Users/alice/a.md)');
  });

  it('repairs real links inside GFM table cells', () => {
    const input = [
      '| file | note |',
      '| --- | --- |',
      '| [report](Users/alice/a.md) | keep |',
    ].join('\n');
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', absoluteHomeFileExists)).toBe([
      '| file | note |',
      '| --- | --- |',
      '| [report](/Users/alice/a.md) | keep |',
    ].join('\n'));
  });

  it('keeps exact offsets for a table link after an escaped pipe', () => {
    const input = [
      '| file |',
      '| --- |',
      '| before \\| [report](Users/alice/a.md) |',
    ].join('\n');
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', absoluteHomeFileExists)).toBe([
      '| file |',
      '| --- |',
      '| before \\| [report](/Users/alice/a.md) |',
    ].join('\n'));
  });

  it('does not combine link syntax across table cell boundaries', () => {
    const input = [
      '| first | second |',
      '| --- | --- |',
      '| [label | ](Users/alice/a.md) |',
    ].join('\n');
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', absoluteHomeFileExists)).toBe(input);
  });

  it('does not let an unmatched backtick in one table cell hide a real link in the next', () => {
    const input = [
      '| first | second |',
      '| --- | --- |',
      '| `code | [report](Users/alice/a.md) |',
    ].join('\n');
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', absoluteHomeFileExists)).toBe([
      '| first | second |',
      '| --- | --- |',
      '| `code | [report](/Users/alice/a.md) |',
    ].join('\n'));
  });

  it('repairs a link in a leading-pipe table nested in a blockquote', () => {
    const input = [
      '> | first | second |',
      '> | --- | --- |',
      '> | keep | [report](Users/alice/a.md) |',
    ].join('\n');
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', absoluteHomeFileExists)).toBe([
      '> | first | second |',
      '> | --- | --- |',
      '> | keep | [report](/Users/alice/a.md) |',
    ].join('\n'));
  });

  it('repairs repeated links in separate table cells independently', () => {
    const input = [
      '| first | second |',
      '| --- | --- |',
      '| [one](Users/alice/a.md) | [two](Users/alice/a.md) |',
    ].join('\n');
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', absoluteHomeFileExists)).toBe([
      '| first | second |',
      '| --- | --- |',
      '| [one](/Users/alice/a.md) | [two](/Users/alice/a.md) |',
    ].join('\n'));
  });

  it('repairs a destination that repeats the home prefix later in its path', () => {
    const input = '[nested](Users/alice/archive/Users/alice/a.md)';
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', path => (
      path === '/Users/alice/archive/Users/alice/a.md'
    ))).toBe('[nested](/Users/alice/archive/Users/alice/a.md)');
  });

  it('repairs a link reference destination but not an image-only reference', () => {
    const input = [
      '[report][file]',
      '![preview][image]',
      '',
      '[file]: Users/alice/a.md',
      '[image]: Users/alice/image.png',
    ].join('\n');
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', absoluteHomeFileExists)).toBe([
      '[report][file]',
      '![preview][image]',
      '',
      '[file]: /Users/alice/a.md',
      '[image]: Users/alice/image.png',
    ].join('\n'));
  });

  it('does not let an unmatched backtick suppress later link repair', () => {
    const input = 'unmatched ` example\n[real](Users/alice/c.md)';
    expect(normalizeLocalHomeLinks(input, home, '/tmp/project', absoluteHomeFileExists))
      .toBe('unmatched ` example\n[real](/Users/alice/c.md)');
  });

  it('supports a Linux home directory', () => {
    expect(normalizeLocalHomeLinks(
      '[log](home/alice/run.log)',
      '/home/alice',
      '/tmp/project',
      path => path === '/home/alice/run.log',
    ))
      .toBe('[log](/home/alice/run.log)');
  });

  it('is applied by the card rendering pipeline', () => {
    const home = homedir().replace(/\/+$/, '');
    const missingSlash = home.replace(/^\/+/, '');
    const content = mdElements(buildCardBodyElements(`[report](${missingSlash})`))[0].content;
    expect(content).toBe(`[report](${home})`);
  });

  it('restores escaped fences before the card pipeline normalizes links', () => {
    const home = homedir().replace(/\/+$/, '');
    const relativeHome = home.replace(/^\/+/, '');
    const input = [
      '\\`\\`\\`markdown',
      `[code](${relativeHome})`,
      '\\`\\`\\`',
      '',
      `[real](${relativeHome})`,
    ].join('\n');
    const content = mdElements(buildCardBodyElements(input, tmpdir()))[0].content;
    expect(content).toContain(`[code](${relativeHome})`);
    expect(content).toContain(`[real](${home})`);
  });

  it('uses the caller working directory when the card pipeline disambiguates a relative target', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'botmux-md-card-cwd-'));
    const relativeHome = homedir().replace(/^\/+|\/+$/g, '');
    mkdirSync(join(cwd, relativeHome), { recursive: true });
    try {
      const input = `[home](${relativeHome})`;
      const content = mdElements(buildCardBodyElements(input, cwd))[0].content;
      expect(content).toBe(input);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('buildMarkdownCard', () => {
  it('uses wide-screen chrome consistently across ordinary reply builders', () => {
    const cards = [
      buildMarkdownCard('hello'),
      buildCanonicalFinalReplyCard({ markdown: 'hello' }),
      buildContextualReplyCard({
        title: 'Local turn',
        assistantText: 'hello',
        assistantLabel: 'Codex',
      }),
    ].map(json => JSON.parse(json));

    for (const card of cards) {
      expect(card.config).toEqual({ update_multi: true, width_mode: 'fill' });
    }
  });

  it('keeps explicit builder and fallback-final body layout identical', () => {
    const markdown = '# 结果\n\n已完成。\n\n## 验证\n\n- build\n- test';
    const explicitSendElements = buildImageCardElements(markdown, []);
    const fallbackElements = JSON.parse(buildCanonicalFinalReplyCard({
      markdown,
      brand: '',
    })).body.elements;

    expect(fallbackElements).toEqual(explicitSendElements);
  });

  it('renders native context in the reply-card footer (token stays off the footer)', () => {
    const json = buildMarkdownCard('hello', 'ou_abc', undefined, 'zh', undefined, 'filesystem', {
      context: { usedTokens: 159_861, windowTokens: 258_400, percentUsed: 62 },
      tokens: { in: 3_739_570, out: 23_299 },
    });
    const card = JSON.parse(json);
    const footer = card.body.elements.at(-1).content;

    expect(footer).toContain('上下文 159.9K/258.4K (62%)');
    // Footer variant is context-only (design: keep the cramped footer clean);
    // the cumulative token line lives on the streaming card, not here.
    expect(footer).not.toContain('Token');
    expect(footer).not.toContain('↑3.7M');
    expect(footer).toContain('<at id=ou_abc></at>');
  });

  it('omits malformed native usage instead of rendering NaN or Infinity', () => {
    const json = buildMarkdownCard('hello', undefined, '', 'zh', undefined, 'filesystem', {
      context: { usedTokens: Number.NaN, windowTokens: 258_400 },
      tokens: { in: Number.POSITIVE_INFINITY, out: 23_299 },
    });
    const card = JSON.parse(json);
    const rendered = JSON.stringify(card);

    expect(card.body.elements.map((element: any) => element.tag)).not.toContain('hr');
    expect(rendered).not.toContain('上下文');
    expect(rendered).not.toContain('Token');
    expect(rendered).not.toContain('NaN');
    expect(rendered).not.toContain('Infinity');
  });

  it('does not invent a percentage when the native snapshot has no percentage', () => {
    const json = buildMarkdownCard('hello', undefined, '', 'zh', undefined, 'filesystem', {
      context: { usedTokens: 12_345, windowTokens: 100_000 },
      tokens: null,
    });
    const footer = JSON.parse(json).body.elements.at(-1).content;

    expect(footer).toContain('上下文 12.3K/100K');
    expect(footer).not.toContain('(12%)');
    expect(footer).not.toContain('Token');
  });

  it('reply-card footer omits token entirely when context is absent (context-only footer)', () => {
    const json = buildMarkdownCard('hello', undefined, '', 'zh', undefined, 'filesystem', {
      context: null,
      tokens: { in: 67_890, out: 123 },
    });
    const card = JSON.parse(json);
    const rendered = JSON.stringify(card);
    // Footer is context-only; with no context there is nothing to show, so the
    // token line does NOT leak into the footer (it lives on the streaming card).
    expect(rendered).not.toContain('Token');
    expect(rendered).not.toContain('上下文');
    expect(card.body.elements.map((element: any) => element.tag)).not.toContain('hr');
  });

  it('streaming variant renders 本轮 + 累计 token (context missing)', () => {
    const seg = cardUsageFooterSegment(
      { context: null, tokens: { in: 67_890, out: 123 }, turnTokens: { in: 5_000, out: 1_200 } },
      'zh',
      'streaming',
    );
    expect(seg).toContain('本轮 ↑5K ↓1.2K');
    expect(seg).toContain('累计 ↑67.9K ↓123');
    expect(seg).not.toContain('上下文');
  });

  it('keeps the metric formatter runtime-free so the streaming renderer owns the tail', () => {
    const seg = cardUsageFooterSegment(
      {
        context: { usedTokens: 80_700, windowTokens: 258_400, percentUsed: 31 },
        tokens: { in: 1_400_000, out: 7_800 },
        model: 'GPT-5.6-Sol',
        reasoningEffort: 'xhigh',
      },
      'zh',
      'streaming',
    );
    expect(seg).toBe('上下文 80.7K/258.4K (31%) · 累计 ↑1.4M ↓7.8K');
    expect(seg).not.toContain('GPT-5.6-Sol');
  });

  it('cardUsageRuntimeSegment renders a compact model (bold) + effort tail', () => {
    expect(cardUsageRuntimeSegment(
      { context: null, tokens: null, model: 'GPT-5.6-Sol', reasoningEffort: 'xhigh' },
      true,
    )).toBe('**GPT-5.6-Sol** xhigh');
    // no effort -> model only, no trailing space/placeholder
    expect(cardUsageRuntimeSegment(
      { context: null, tokens: null, model: 'gpt-4o' },
      true,
    )).toBe('**gpt-4o**');
    // no model -> nothing
    expect(cardUsageRuntimeSegment(
      { context: null, tokens: null, reasoningEffort: 'xhigh' },
      true,
    )).toBeNull();
    // no metric line to anchor to -> nothing (matches footer contract)
    expect(cardUsageRuntimeSegment(
      { context: null, tokens: null, model: 'GPT-5.6-Sol', reasoningEffort: 'xhigh' },
      false,
    )).toBeNull();
  });

  it('strips a leading provider/ routing prefix from the model name', () => {
    // model_hub/es1_orange_o48 → es1_orange_o48 (relay namespace hidden);
    // underscores are markdown-escaped by the shared compact formatter.
    expect(cardUsageRuntimeSegment(
      { context: null, tokens: null, model: 'model_hub/es1_orange_o48' },
      true,
    )).toBe('**es1\\_orange\\_o48**');
    // a value with no slash is untouched
    expect(cardUsageRuntimeSegment(
      { context: null, tokens: null, model: 'gpt-5.6-sol' },
      true,
    )).toBe('**gpt-5.6-sol**');
    // only a clean single-token prefix + one slash is removed
    expect(cardUsageRuntimeSegment(
      { context: null, tokens: null, model: 'a/b/c' },
      true,
    )).toBe('**b/c**');
  });

  it('does not create a standalone runtime line without native usage metrics', () => {
    expect(cardUsageFooterSegment(
      {
        context: null,
        tokens: null,
        model: 'GPT-5.6-Sol',
        reasoningEffort: 'xhigh',
      },
      'zh',
      'streaming',
    )).toBeNull();
  });

  it('escapes runtime labels and truncates long model names', () => {
    const seg = cardUsageRuntimeSegment(
      {
        context: { usedTokens: 1 },
        tokens: null,
        model: `[very-long-${'x'.repeat(60)}] <at id=ou_fake></at>`,
        reasoningEffort: '*xhigh*',
      },
      true,
    )!;
    expect(seg).toContain('**\\[very-long-');
    expect(seg).toContain('…** \\*xhigh\\*');
    expect(seg).not.toContain('<at id=ou_fake>');
    expect(seg.length).toBeLessThan(100);
  });

  it('omits an all-zero token line (new session / synthetic zero-usage record)', () => {
    // A brand-new topic's first read can catch a transcript record whose usage
    // object has zero/absent token fields → in=out=0. Rendering "↑0 ↓0" is
    // meaningless noise, so the token segment must be omitted (streaming variant,
    // where token would otherwise show).
    const seg = cardUsageFooterSegment(
      { context: null, tokens: { in: 0, out: 0 }, turnTokens: { in: 0, out: 0 } },
      'zh',
      'streaming',
    );
    expect(seg).toBeNull();
  });

  it('streaming variant still renders when only one direction is zero (real one-sided usage)', () => {
    const seg = cardUsageFooterSegment(
      { context: null, tokens: { in: 12_345, out: 0 }, turnTokens: null },
      'zh',
      'streaming',
    );
    expect(seg).toContain('累计 ↑12.3K ↓0');
  });

  it('promotes rounded compact values at unit boundaries (streaming token)', () => {
    const seg = cardUsageFooterSegment(
      {
        context: { usedTokens: 999_950, windowTokens: 999_950_000 },
        tokens: { in: 999_950_000, out: 999_950 },
        turnTokens: null,
      },
      'en',
      'streaming',
    );
    expect(seg).toContain('Context 1M/1B');
    expect(seg).toContain('Total ↑1B ↓1M');
    expect(seg).not.toMatch(/1000[KM]/);
  });

  it('omits the usage footer when the Agent CLI reports neither metric', () => {
    const json = buildMarkdownCard('hello', undefined, '', 'zh', undefined, 'filesystem', {
      context: null,
      tokens: null,
    });
    const card = JSON.parse(json);
    const rendered = JSON.stringify(card);

    expect(card.body.elements.map((element: any) => element.tag)).not.toContain('hr');
    expect(rendered).not.toContain('上下文');
    expect(rendered).not.toContain('Token');
    expect(rendered).not.toContain('不可用');
  });

  it('keeps brand and recipient chrome when usage is entirely missing', () => {
    const json = buildMarkdownCard('hello', 'ou_abc', undefined, 'zh', undefined, 'filesystem', {
      context: null,
      tokens: null,
    });
    const footer = JSON.parse(json).body.elements.at(-1).content;

    expect(footer).toContain('[botmux](');
    expect(footer).toContain('<at id=ou_abc></at>');
    expect(footer).not.toContain('上下文');
    expect(footer).not.toContain('Token');
    expect(footer).not.toContain('不可用');
  });

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

describe('buildReplyCardFooter', () => {
  it('centralizes brand, usage, and ordered recipients for every reply-card path', () => {
    const footer = buildReplyCardFooter({
      brand: 'Acme',
      usage: {
        context: { usedTokens: 12_345 },
        tokens: { in: 67_890, out: 123 },
      },
      recipientOpenIds: ['ou_owner', 'ou_reviewer'],
      locale: 'zh',
    });

    expect(footer?.content).toContain(
      'Acme [·](https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1) '
      + '上下文 12.3K · '
      + '发送给：<at id=ou_owner></at> <at id=ou_reviewer></at>',
    );
    // Footer is context-only — the cumulative token line does not appear here.
    expect(footer?.content).not.toContain('Token');
    expect(footer?.content).not.toContain('\u200B');
    expect(footer?.element).toMatchObject({
      tag: 'markdown',
      element_id: 'botmux_reply_footer',
      text_size: 'notation',
      content: footer?.content,
    });
  });

  it('appends the canonical signed footer to caller-supplied v2 cards', () => {
    const original = {
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: 'body' }] },
    };
    const card = appendReplyCardFooterToV2Card(original, {
      brand: '',
      recipientOpenIds: ['ou_owner', 'ou_owner'],
      locale: 'en',
    }) as any;

    expect(card).not.toBe(original);
    expect(original.body.elements).toHaveLength(1);
    expect(card.body.elements.at(-1)).toMatchObject({
      tag: 'markdown',
      element_id: 'botmux_reply_footer',
      content: expect.stringContaining('Sent to: <at id=ou_owner></at>'),
    });
    expect(card.body.elements.at(-1).content).toContain(
      '[·](https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1)',
    );
  });

  it('rejects caller-supplied cards without schema-2 body elements', () => {
    expect(appendReplyCardFooterToV2Card(
      { elements: [] },
      { brand: '', recipientOpenIds: ['ou_owner'] },
    )).toBeNull();
    expect(appendReplyCardFooterToV2Card(
      { schema: '1.0', body: { elements: [] } },
      { brand: '', recipientOpenIds: ['ou_owner'] },
    )).toBeNull();
  });

  it('rejects a custom card that already occupies the canonical footer id', () => {
    expect(appendReplyCardFooterToV2Card(
      {
        schema: '2.0',
        body: {
          elements: [{
            tag: 'column_set',
            columns: [{
              tag: 'column',
              elements: [{ tag: 'markdown', element_id: 'botmux_reply_footer', content: 'x' }],
            }],
          }],
        },
      },
      { brand: '', recipientOpenIds: ['ou_owner'] },
    )).toBeNull();
  });

  it('rejects footer-id collisions in localized header tag components', () => {
    expect(appendReplyCardFooterToV2Card(
      {
        schema: '2.0',
        header: {
          i18n_text_tag_list: {
            zh_cn: [{
              tag: 'text_tag',
              element_id: 'botmux_reply_footer',
              text: { tag: 'plain_text', content: '状态' },
            }],
          },
        },
        body: { elements: [{ tag: 'markdown', content: 'body' }] },
      },
      { brand: '', recipientOpenIds: ['ou_owner'] },
    )).toBeNull();
  });

  it('does not treat callback payload fields as card element-id collisions', () => {
    const card = appendReplyCardFooterToV2Card(
      {
        schema: '2.0',
        body: {
          elements: [{
            tag: 'button',
            text: { tag: 'plain_text', content: '提交' },
            behaviors: [{
              type: 'callback',
              value: { tag: 'deploy', element_id: 'botmux_reply_footer' },
            }],
          }],
        },
      },
      { brand: '', recipientOpenIds: ['ou_owner'] },
    ) as any;

    expect(card).not.toBeNull();
    expect(card.body.elements.at(-1).element_id).toBe('botmux_reply_footer');
  });

  it('does NOT sign a default-brand-only footer (no usage, no recipient) — avoids a dangling "botmux ·"', () => {
    const footer = buildReplyCardFooter({});
    expect(footer?.content).toContain(DEFAULT_BRAND_LABEL);
    // Brand alone is legitimate content with no `@` → no ownership marker, so it
    // renders "botmux" without a trailing separator dot.
    expect(footer?.content).not.toContain(
      '[·](https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1)',
    );
  });

  it('still signs a usage-only footer (brand disabled) with the versioned marker', () => {
    const footer = buildReplyCardFooter({
      brand: '', // brand off
      usage: { context: { usedTokens: 5_000, windowTokens: 200_000, percentUsed: 2.5 }, tokens: null, turnTokens: null },
    });
    expect(footer?.content).toContain(
      '[·](https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1)',
    );
  });

  it('still signs a recipient-only footer (brand disabled) with the versioned marker', () => {
    const footer = buildReplyCardFooter({
      brand: '',
      recipientOpenIds: ['ou_abc'],
    });
    expect(footer?.content).toContain(
      '[·](https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1)',
    );
    expect(footer?.content).toContain('<at id=ou_abc></at>');
  });

  it('signs a default-brand + usage footer (marker as the first separator)', () => {
    const footer = buildReplyCardFooter({
      usage: { context: { usedTokens: 5_000, windowTokens: 200_000, percentUsed: 2.5 }, tokens: null, turnTokens: null },
    });
    expect(footer?.content).toContain(DEFAULT_BRAND_LABEL);
    expect(footer?.content).toContain(
      '[·](https://github.com/deepcoldy/bot%6Dux#reply-card-footer-v1)',
    );
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
  it('normalizes custom brands to the footer single-line invariant', () => {
    expect(brandFooterSegment(' Acme\n  Team\r\nBot ')).toBe('Acme Team Bot');
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
    expect(els.some((e: any) => e.element_id === 'botmux_reply_footer')).toBe(false);
    expect(JSON.stringify(els)).not.toContain('botmux');
    expect(els.some((e: any) => e.tag === 'markdown' && /hi/.test(e.content))).toBe(true);
  });
});

describe('buildCardBodyElements image rows', () => {
  it('a line of 2+ raw images → one side-by-side column_set row', () => {
    const out = buildCardBodyElements('**Menu**\n\n![](img_v2_k1) ![](img_v2_k2)\n\n![](img_v2_k3)');
    const rows = out.filter(e => e.tag === 'column_set');
    expect(rows).toHaveLength(1);
    expect(rows[0].columns.map((c: any) => c.elements[0].img_key)).toEqual(['img_v2_k1', 'img_v2_k2']);
    expect(rows[0].columns[0].elements[0].mode).toBe('fit_horizontal');
    // a lone trailing image stays inline markdown, not a row
    const md = mdElements(out).map(e => e.content).join('\n');
    expect(md).toContain('![](img_v2_k3)');
  });

  it('a line with a single image is NOT turned into a row', () => {
    const out = buildCardBodyElements('![](img_v2_only)');
    expect(out.some(e => e.tag === 'column_set')).toBe(false);
  });

  it('image-looking lines inside code fences are left intact (no row)', () => {
    const out = buildCardBodyElements('```\n![](img_v2_a) ![](img_v2_b)\n```');
    expect(out.some(e => e.tag === 'column_set')).toBe(false);
    expect(mdElements(out).map(e => e.content).join('\n')).toContain('![](img_v2_a) ![](img_v2_b)');
  });

  it('a row of non-img_key srcs (model URL/text images) is NOT promoted', () => {
    // A model reply emitting `![](https://…) ![](…)` must not become a native
    // img row — a URL "img_key" makes Feishu reject the whole card. Stays md.
    const url = '![](https://x.test/a.png) ![](https://x.test/b.png)';
    const out = buildCardBodyElements(url);
    expect(out.some(e => e.tag === 'column_set')).toBe(false);
    expect(mdElements(out).map(e => e.content).join('\n')).toContain('https://x.test/a.png');
  });

  it('a row mixing one img_key and one URL is NOT promoted (all-or-nothing)', () => {
    const out = buildCardBodyElements('![](img_v2_real) ![](https://x.test/b.png)');
    expect(out.some(e => e.tag === 'column_set')).toBe(false);
  });

  it('near-miss srcs (img_v2foo.png / img_v2:x) are NOT treated as img_keys', () => {
    // Full-key match required: a bare versioned prefix without the `_<id>` part
    // (or with stray punctuation) is not a real key → no native row.
    expect(buildCardBodyElements('![](img_v2foo.png) ![](img_v3bar.png)')
      .some(e => e.tag === 'column_set')).toBe(false);
    expect(buildCardBodyElements('![](img_v2:x) ![](img_v3:y)')
      .some(e => e.tag === 'column_set')).toBe(false);
  });

  it('image line inside a 4-backtick block with an inner 3-backtick fence stays code', () => {
    // The inner ``` must NOT close the outer ```` block; the image line after
    // it is still code, so it must not be promoted to a native row.
    const input = '````\n```\n![](img_v2_a) ![](img_v2_b)\n```\n````';
    const out = buildCardBodyElements(input);
    expect(out.some(e => e.tag === 'column_set')).toBe(false);
    expect(mdElements(out).map(e => e.content).join('\n')).toContain('![](img_v2_a) ![](img_v2_b)');
  });

  it('a 4-space indented image line (indented code block) is NOT promoted', () => {
    const out = buildCardBodyElements('text\n\n    ![](img_v2_a) ![](img_v2_b)');
    expect(out.some(e => e.tag === 'column_set')).toBe(false);
  });
});

describe('buildImageCardElements', () => {
  const K = ['img_v2_a', 'img_v2_b', 'img_v2_c', 'img_v2_d'];

  it('no images → identical to buildCardBodyElements', () => {
    expect(buildImageCardElements('hello **world**', [])).toEqual(
      buildCardBodyElements('hello **world**'),
    );
  });

  it('no placeholders → images appended full-width (stacked) at the end', () => {
    const out = buildImageCardElements('intro text', K.slice(0, 2));
    const md = mdElements(out).map(e => e.content).join('\n');
    expect(md).toContain('intro text');
    expect(md).toContain('![](img_v2_a)');
    expect(md).toContain('![](img_v2_b)');
    // appended on separate lines → stacked, not a side-by-side row
    expect(out.some(e => e.tag === 'column_set')).toBe(false);
  });

  it('single-index placeholder → inline full-width image, no trailing dup', () => {
    const out = buildImageCardElements('see ![](img:0) done', [K[0]]);
    const md = mdElements(out).map(e => e.content).join('\n');
    expect(md).toContain('![](img_v2_a)');
    expect(out.some(e => e.tag === 'column_set')).toBe(false);
  });

  it('grouped placeholder of 2 → one column_set row of 2 side-by-side imgs', () => {
    const out = buildImageCardElements('![](img:0,1)', K.slice(0, 2));
    const row = out.find(e => e.tag === 'column_set');
    expect(row).toBeTruthy();
    expect(row.columns).toHaveLength(2);
    expect(row.columns.map((c: any) => c.elements[0].img_key)).toEqual(['img_v2_a', 'img_v2_b']);
    expect(row.columns.every((c: any) => c.width === 'weighted')).toBe(true);
  });

  it('grouped placeholder of 3 → one row of 3', () => {
    const out = buildImageCardElements('![](img:0,1,2)', K.slice(0, 3));
    const row = out.find(e => e.tag === 'column_set');
    expect(row.columns).toHaveLength(3);
  });

  it('two grouped placeholders → two separate rows', () => {
    const out = buildImageCardElements('![](img:0,1)\n\n![](img:2,3)', K);
    const rows = out.filter(e => e.tag === 'column_set');
    expect(rows).toHaveLength(2);
    expect(rows[0].columns.map((c: any) => c.elements[0].img_key)).toEqual(['img_v2_a', 'img_v2_b']);
    expect(rows[1].columns.map((c: any) => c.elements[0].img_key)).toEqual(['img_v2_c', 'img_v2_d']);
  });

  it('text around a group splits into markdown before/after the row', () => {
    const out = buildImageCardElements('top\n\n![](img:0,1)\n\nbottom', K.slice(0, 2));
    expect(out[0]).toMatchObject({ tag: 'markdown', content: 'top' });
    expect(out[1].tag).toBe('column_set');
    expect(out[2]).toMatchObject({ tag: 'markdown', content: 'bottom' });
  });

  it('shares the six-heading promotion budget across image-row segments', () => {
    const input = Array.from({ length: 8 }, (_, index) => [
      `# Section ${index + 1}`,
      `body ${index + 1}`,
      index < 7 ? '![](img:0,1)' : '',
    ].filter(Boolean).join('\n\n')).join('\n\n');
    const out = buildImageCardElements(input, K.slice(0, 2));
    const promoted = out.filter(element => element.text_size === 'heading-2');
    const rendered = mdElements(out).map(element => element.content).join('\n\n');

    expect(out.filter(element => element.tag === 'column_set')).toHaveLength(7);
    expect(promoted).toHaveLength(6);
    expect(rendered).toContain('**Section 7**');
    expect(rendered).toContain('**Section 8**');
  });

  it('mixed: grouped row + an unreferenced image appended at the end', () => {
    const out = buildImageCardElements('![](img:0,1)', K.slice(0, 3));
    expect(out.some(e => e.tag === 'column_set')).toBe(true);
    const md = mdElements(out).map(e => e.content).join('\n');
    expect(md).toContain('![](img_v2_c)'); // index 2 never referenced → trailing
    expect(md).not.toContain('img_v2_a');  // a,b live in the row, not markdown
  });

  it('out-of-range indices in a group are dropped; sole valid one → single img', () => {
    const out = buildImageCardElements('![](img:0,9)', [K[0]]);
    // index 9 invalid → group collapses to a single full-width inline image.
    expect(out.some(e => e.tag === 'column_set')).toBe(false);
    expect(mdElements(out).map(e => e.content).join('\n')).toContain('![](img_v2_a)');
  });

  it('group with all indices out of range → literal text preserved', () => {
    const out = buildImageCardElements('![](img:7,8)', [K[0]]);
    expect(out.some(e => e.tag === 'column_set')).toBe(false);
    const md = mdElements(out).map(e => e.content).join('');
    expect(md).toContain('![](img:7,8)');
  });
});

describe('buildContextualReplyCard footer brand', () => {
  it('renders the same native usage footer as a regular reply card', () => {
    const els = JSON.parse(buildContextualReplyCard({
      title: 'T',
      assistantText: 'a',
      assistantLabel: 'Codex',
      recipientOpenId: 'ou_x',
      usage: {
        context: { usedTokens: 159_861, windowTokens: 258_400, percentUsed: 62 },
        tokens: { in: 3_739_570, out: 23_299 },
      },
    })).body.elements;
    const footer = els.at(-1).content;

    expect(footer).toContain('上下文 159.9K/258.4K (62%)');
    // Reply-card footer (contextual card too) is context-only; token off-footer.
    expect(footer).not.toContain('Token');
    expect(footer).toContain('<at id=ou_x></at>');
  });

  it('custom brand renders; default botmux omitted', () => {
    const els = JSON.parse(buildContextualReplyCard({
      title: 'T', assistantText: 'a', assistantLabel: 'Claude', recipientOpenId: 'ou_x', brand: 'Acme',
    })).body.elements;
    const last = els[els.length - 1];
    expect(last.text_size).toBe('notation');
    expect(last.content).toContain('Acme');
    expect(last.content).not.toContain('botmux');
  });

  it('empty brand + no recipient → no grey footer element', () => {
    const els = JSON.parse(buildContextualReplyCard({
      title: 'T', assistantText: 'a', assistantLabel: 'Claude', brand: '',
    })).body.elements;
    expect(els.some((e: any) => e.element_id === 'botmux_reply_footer')).toBe(false);
    expect(JSON.stringify(els)).not.toContain('botmux');
  });
});
