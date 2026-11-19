import { describe, expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { repairCardStrongPunctuation } from '../src/im/lark/card-strong-punctuation.js';
import { buildCanonicalFinalReplyCard, buildCardBodyElements } from '../src/im/lark/md-card.js';
import { buildTurnReplyCard } from '../src/im/lark/turn-reply-card.js';

const md = new MarkdownIt({ html: false, linkify: false });
const fence = '```';

function strongTexts(text: string): string[] {
  const html = md.render(text);
  return [...html.matchAll(/<strong>(.*?)<\/strong>/g)].map(match => match[1]!);
}

/** Visible prose from the token stream, so the assertion never has to re-strip
 *  rendered HTML with a tag regex. */
function visibleText(text: string): string {
  let out = '';
  const walk = (tokens: readonly Token[]): void => {
    for (const token of tokens) {
      if (token.children) walk(token.children);
      else if (token.type === 'text' || token.type === 'code_inline') out += token.content;
      else if (token.type === 'softbreak' || token.type === 'hardbreak') out += '\n';
    }
  };
  walk(md.parse(text, {}));
  return out;
}

describe('repairCardStrongPunctuation: pairs CommonMark would reject', () => {
  it.each([
    ['**空数据边界：**当前平台函数', '**空数据边界**：当前平台函数', ['空数据边界']],
    ['**说明（重要）**后面', '**说明（重要**）后面', ['说明（重要']],
    ['说明**（重要）**后面', '说明（**重要**）后面', ['重要']],
    ['**a:**b', '**a**:b', ['a']],
    ['**结论。**下一步', '**结论**。下一步', ['结论']],
    ['**真的吗？！**是的', '**真的吗**？！是的', ['真的吗']],
    ['- **标签：**正文', '- **标签**：正文', ['标签']],
    ['> **引用：**正文', '> **引用**：正文', ['引用']],
    ['1. **第一步：**安装', '1. **第一步**：安装', ['第一步']],
    ['**用 `bun`：**安装', '**用 `bun`**：安装', ['用 <code>bun</code>']],
  ])('%s', (input, expected, strong) => {
    const repaired = repairCardStrongPunctuation(input);
    expect(repaired).toBe(expected);
    expect(repaired).toHaveLength(input.length);
    expect(strongTexts(repaired)).toEqual(strong);
    expect(visibleText(repaired)).not.toContain('**');
    // Idempotent: a repaired reply is already renderable.
    expect(repairCardStrongPunctuation(repaired)).toBe(repaired);
  });

  it('repairs every label in a multi-line reply and keeps the rest of the bytes', () => {
    const input = ['**背景：**线上报错', '', '**原因（已确认）**配置缺失', '', '**你好**再见'].join('\n');
    expect(repairCardStrongPunctuation(input)).toBe(
      ['**背景**：线上报错', '', '**原因（已确认**）配置缺失', '', '**你好**再见'].join('\n'));
  });

  it('repairs adjacent lines whose broken delimiters mis-pair across the soft break', () => {
    // Without the repair markdown-it pairs line 2's closer with line 3's
    // opener: a bold span covering「后面是正文\n说明」plus two literal `**`.
    const input = ['**空数据边界：**当前平台函数', '**说明（重要）**后面是正文', '说明**（重要）**后面是正文'].join('\n');
    const repaired = repairCardStrongPunctuation(input);
    expect(repaired).toBe(['**空数据边界**：当前平台函数', '**说明（重要**）后面是正文', '说明（**重要**）后面是正文'].join('\n'));
    expect(strongTexts(repaired)).toEqual(['空数据边界', '说明（重要', '重要']);
    expect(visibleText(repaired)).not.toContain('**');
  });

  it('keeps an intentional bold span across a soft break', () => {
    const input = '**第一行\n第二行**正文';
    expect(repairCardStrongPunctuation(input)).toBe(input);
  });

  it('repairs labels inside table cells', () => {
    const input = ['| 项 | 说明 |', '| --- | --- |', '| a | **注意：**必填 |'].join('\n');
    expect(repairCardStrongPunctuation(input)).toBe(input.replace('**注意：**必填', '**注意**：必填'));
  });

  it('keeps a following already-valid pair on the same line intact', () => {
    expect(repairCardStrongPunctuation('**a：**b **c**')).toBe('**a**：b **c**');
  });

  it('still repairs the tail of a long reply when one candidate cannot pair', () => {
    // The bold inside link text is recognised by the label prefilter, and a
    // truncated trailing `**` (below) makes its own candidate fail the gate —
    // either way the whole-reply batch is not accepted, so chunked fallback
    // verification must still repair every label in the tail.
    const input = ['详见 [**文档：**说明](https://example.com/doc)。', '',
      ...Array.from({ length: 100 }, (_, i) => `- **要点${i}：**说明文字`)].join('\n');
    const repaired = repairCardStrongPunctuation(input);
    expect(repaired).toContain('**要点99**：说明文字');
    expect(repaired).not.toContain('：**说明文字');
    // The unrepairable candidate itself keeps the author's bytes.
    expect(repaired).toContain('[**文档：**说明](https://example.com/doc)');
    // Repaired output is stable: a second pass must not find more work.
    expect(repairCardStrongPunctuation(repaired)).toBe(repaired);
  });

  it('keeps repairing through the chunked fallback when a stray run spoils the batch', () => {
    // Unlike link text, `**注意：**正文**` (one extra unpaired `**`, e.g. a
    // truncated stream) is NOT removed by the label prefilter: its candidate
    // makes the batched verification fail, so this is the shape that actually
    // forces the chunked fallback. It stays byte-identical, and the 100 labels
    // after it — past both the old 64-candidate budget and chunk boundaries —
    // must all be repaired.
    const stray = '**注意：**正文**';
    const input = [stray, '',
      ...Array.from({ length: 100 }, (_, i) => `- **要点${i}：**说明文字`)].join('\n');
    const repaired = repairCardStrongPunctuation(input);
    expect(repaired.startsWith(`${stray}\n`)).toBe(true);
    expect(repaired).toContain('**要点99**：说明文字');
    expect((repaired.match(/要点\d+：\*\*/g) ?? []).length).toBe(0);
    expect(repairCardStrongPunctuation(repaired)).toBe(repaired);
  });

  it('recognises link labels via the parser, not a raw bracket scan', () => {
    // A '[' inside an inline code span is literal: the later `](u)` does not
    // open a link, so the label must still be repaired.
    expect(repairCardStrongPunctuation('`[n` **x：**y](u)')).toBe('`[n` **x**：y](u)');
    // A space in an unwrapped destination is not a valid link either.
    expect(repairCardStrongPunctuation('[a **x：**y](1 2)')).toBe('[a **x**：y](1 2)');
    // Real link text and image alt stay byte-for-byte untouched.
    expect(repairCardStrongPunctuation('详见 [**文档：**说明](https://example.com)。'))
      .toBe('详见 [**文档：**说明](https://example.com)。');
    expect(repairCardStrongPunctuation('![**图：**说明](https://example.com/a.png)'))
      .toBe('![**图：**说明](https://example.com/a.png)');
  });

  it('does not let a link inside an image alt hide a repairable pair', () => {
    // markdown-it parses an image's alt with a fresh inline state, so a link
    // inside the alt reports offsets relative to the alt slice. Trusting those
    // would place the label span over an unrelated part of the line and skip a
    // pair that is plainly outside any link. Only spans measured against the
    // line itself may be used.
    const key = 'img_v2_041b28e3-5680-48c2-9af2-5d5d5b1f3f0';
    expect(repairCardStrongPunctuation(`ab**标签：**正文 ![见[example](https://example.com)](${key})`))
      .toBe(`ab**标签**：正文 ![见[example](https://example.com)](${key})`);
    expect(repairCardStrongPunctuation('a**x：**y ![[xxxxxxxxxx](u)](i.png)'))
      .toBe('a**x**：y ![[xxxxxxxxxx](u)](i.png)');
  });
});

describe('repairCardStrongPunctuation: leaves everything else byte-identical', () => {
  it.each([
    ['already valid: plain', '**你好**再见'],
    ['already valid: punctuation outside', '**你好**：再见'],
    ['already valid: space after closer', '**你好：** 再见'],
    ['already valid: line end after closer', '**你好：**'],
    ['already valid: punctuation after closer', '**你好：**，再见'],
    ['already valid: whole line', '**说明（重要）**'],
    ['single asterisk emphasis', '*标签：*正文'],
    ['underscore strong', '__标签：__正文'],
    ['triple asterisks', '***标签：***正文'],
    ['nested emphasis', '**标签 *重点*：**正文'],
    ['escaped opener', '\\**标签：**正文'],
    ['escaped closer', '**标签：\\**正文'],
    ['escaped trailing punctuation', '**a\\:**b'],
    ['inline code', '`**标签：**正文`'],
    ['double-backtick inline code', '``**标签：**正文``'],
    ['fenced code', [fence, '**标签：**正文', fence].join('\n')],
    ['tilde fenced code', ['~~~', '**标签：**正文', '~~~'].join('\n')],
    ['indented code', ['段落', '', '    **标签：**正文'].join('\n')],
    ['link text', '[**标签：**正文](https://example.com)'],
    ['link destination', '[文档](https://example.com/**a：**b)'],
    ['bare url', 'https://example.com/**a:**b'],
    ['across lines', '**标签：\n**正文'],
    ['across paragraphs', '**标签：\n\n**正文'],
    ['unbalanced', '**标签：**正文**'],
    ['only punctuation inside', '文**：**字'],
    ['feishu font tag', "**<font color='red'>注意：</font>**正文"],
    ['strikethrough inside', '**~~旧~~：**正文'],
    // The moved punctuation can change how underscore emphasis pairs elsewhere
    // on the same line: moving `/` (or '，') across the delimiter turns these
    // into a bold span and the existing `_…_` italic disappears. The markdown-it
    // gate's em-count invariance check rejects such a rewrite.
    ['underscore em adjacent (lead punct)', 'b**/_**_'],
    ['underscore em adjacent (trail punct)', '**_，**p_'],
    ['no asterisks', '标签：正文'],
  ])('%s', (_label, input) => {
    expect(repairCardStrongPunctuation(input)).toBe(input);
  });
});

describe('card body rendering', () => {
  it('final reply cards carry the repaired markdown, outside code fences only', () => {
    const input = ['**空数据边界：**当前平台函数', '', fence, '**空数据边界：**当前平台函数', fence].join('\n');
    const content = buildCardBodyElements(input, process.cwd(), 'disabled')
      .filter(element => element.tag === 'markdown')
      .map(element => element.content)
      .join('\n');
    expect(content).toBe(['**空数据边界**：当前平台函数', '', fence, '**空数据边界：**当前平台函数', fence].join('\n'));
  });

  it('table cells built as native lark_md columns are repaired too', () => {
    const input = ['| 项 | 说明 |', '| --- | --- |', '| a | **注意：**必填 |'].join('\n');
    const table = buildCardBodyElements(input, process.cwd(), 'disabled').find(element => element.tag === 'table');
    expect(JSON.stringify(table)).toContain('**注意**：必填');
    expect(JSON.stringify(table)).not.toContain('**注意：**必填');
  });
});

describe('turn reply card process panel', () => {
  it('repairs model narration but leaves tool output raw', () => {
    const card = JSON.parse(buildTurnReplyCard({
      larkAppId: 'app_test', sessionId: 'session', turnId: 'om_turn', mode: 'unified', chatId: 'oc_chat', rootId: 'om_root',
      version: 1, phase: 'completed', createdAtMs: 0, durationMs: 1200,
      progress: ['**背景：**线上报错', '**结论：**已修复'],
      finalCard: buildCanonicalFinalReplyCard({ markdown: '完整答复' }),
      tools: [{ id: 't', name: 'Read', subject: 'a.md', result: '**原文：**保持' }],
    }, { showProcess: true, showToolResults: true, canStop: true }));
    const panel = JSON.stringify(card.body.elements.find((element: any) => element.tag === 'collapsible_panel'));
    expect(panel).toContain('💬 **背景**：线上报错');
    expect(panel).toContain('💬 **结论**：已修复');
    expect(panel).toContain('**原文：**保持');
  });
});
