import { describe, expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import { repairReplyMarkdown } from '../src/services/reply-markdown.js';
import { buildCardBodyElements } from '../src/im/lark/md-card.js';

const fence = '```';
const body = ['123 update', '└ 456 download'].join('\n');
const malformed = ['实际进程：' + fence + 'plain_text', body, fence, '', '**接下来请选择：**', '1. 保持下载', '2. 清理残留'].join('\n');
const expected = malformed.replace('：' + fence, '：\n' + fence);
const md = new MarkdownIt();

describe('display repair for misplaced reply fences', () => {
  it('recovers the process block without swallowing the later bold text and choices', () => {
    const repaired = repairReplyMarkdown(malformed);
    expect(repaired).toBe(expected);
    const code = md.parse(repaired, {}).filter(token => token.type === 'fence');
    expect(code).toHaveLength(1);
    expect(code[0].content).toBe(body + '\n');
    const card = buildCardBodyElements(repaired);
    const markdown = card.filter(element => element.tag === 'markdown').map(element => element.content).join('\n');
    expect(md.parse(markdown, {}).filter(token => token.type === 'fence')[0].content).toBe(body + '\n');
    expect(markdown).toContain('**接下来请选择：**');
    expect(repairReplyMarkdown(repaired)).toBe(repaired);
  });

  it.each(['text', 'txt', 'plaintext', 'PLAIN_TEXT', 'JSON', 'bash', 'sh', 'shell', 'zsh', 'javascript', 'js', 'typescript', 'ts', 'python', 'py', 'yaml', 'yml', 'toml', 'sql'])('accepts the explicit supported language %s', language => {
    const input = ['结果: ' + fence + language, 'data', fence].join('\n');
    expect(repairReplyMarkdown(input)).toBe(input.replace(': ', ': \n'));
  });

  it.each([
    ['valid code', ['结果：', fence + 'plain_text', body, fence].join('\n')],
    ['nested Markdown example', ['````markdown', malformed, '````'].join('\n')],
    ['tilde outer fence', ['~~~~markdown', malformed, '~~~~'].join('\n')],
    ['escaped outer example', ['\\`\\`\\`\\`markdown', malformed, '\\`\\`\\`\\`'].join('\n')],
    ['inline literal', '`实例：' + fence + 'plain_text`'],
    ['paragraph with literal inline code', '`Markdown 示例`\n' + malformed],
    ['escaped marker', ['实例：\\`\\`\\`plain_text', body, fence].join('\n')],
    ['indented example', malformed.split('\n').map(line => '    ' + line).join('\n')],
    ['blockquote example', malformed.split('\n').map(line => '> ' + line).join('\n')],
    ['list example', ['1. 实例：' + fence + 'plain_text', '   data', '   ' + fence].join('\n')],
    ['unknown language', ['实例：' + fence + 'unknown-lang', body, fence].join('\n')],
    ['missing language', ['实例：' + fence, body, fence].join('\n')],
    ['no label boundary', ['这是字符 ' + fence + 'plain_text', body, fence].join('\n')],
    ['incomplete stream', ['实例：' + fence + 'plain_text', body].join('\n')],
    ['empty body', ['实例：' + fence + 'plain_text', '', fence].join('\n')],
    ['ambiguous embedded fence', ['实例：' + fence + 'plain_text', 'literal ' + fence + 'text', fence].join('\n')],
    ['embedded escaped fence', ['实例：' + fence + 'plain_text', '\\`\\`\\`text', fence].join('\n')],
    ['long output', ['实例：' + fence + 'plain_text', ...Array(80).fill('line'), fence].join('\n')],
    ['large output', ['实例：' + fence + 'plain_text', 'x'.repeat(16_385), fence].join('\n')],
    ['large UTF-8 output', ['实例：' + fence + 'plain_text', '字'.repeat(6_000), fence].join('\n')],
  ])('preserves %s', (_name, input) => {
    expect(repairReplyMarkdown(input)).toBe(input);
  });

  it.each(['    ', '\t'])('preserves %j indentation on a paragraph continuation with an unindented closing fence', indent => {
    // CommonMark keeps an indented continuation inside the top-level paragraph.
    // The unindented closing fence cannot mask a missing opening-line guard.
    const input = ['示例说明', indent + '实例：' + fence + 'plain_text', body, fence].join('\n');
    expect(repairReplyMarkdown(input)).toBe(input);
    expect(repairReplyMarkdown(repairReplyMarkdown(input))).toBe(input);
  });

  it('preserves CRLF and every original body character', () => {
    const input = malformed.replaceAll('\n', '\r\n');
    expect(repairReplyMarkdown(input)).toBe(expected.replaceAll('\n', '\r\n'));
  });

  it('repairs independent misplaced blocks after the first closing fence', () => {
    const input = malformed + '\n\n' + malformed.replace('实际进程', '另一组进程');
    expect(repairReplyMarkdown(input)).toBe(expected + '\n\n' + expected.replace('实际进程', '另一组进程'));
  });

  it('recovers the Traex JSON + Bash example without swallowing the second block or later prose', () => {
    const input = ['修改这一项即可： ```JSON', '{', '  "workingDir": "/workspace"', '}', fence,
      '', '建议做法： ```bash', 'echo ready', fence, '', '**重启后生效。**'].join('\n');
    const repaired = repairReplyMarkdown(input);
    expect(repaired).toBe(input.replaceAll('： ```', '： \n```'));
    const markdown = buildCardBodyElements(repaired).filter(e => e.tag === 'markdown').map(e => e.content).join('\n');
    const blocks = md.parse(markdown, {}).filter(t => t.type === 'fence');
    expect(blocks.map(t => t.info.toLowerCase())).toEqual(['json', 'bash']);
    expect(blocks.map(t => t.content)).toEqual(['{\n  "workingDir": "/workspace"\n}\n', 'echo ready\n']);
    expect(md.parse(markdown, {}).filter(t => t.type === 'inline').at(-1)?.content).toBe('**重启后生效。**');
    expect(input).toContain('即可： ```JSON');
    expect(repairReplyMarkdown(repaired)).toBe(repaired);
  });

  it.each(['markdown', 'md', 'mermaid', 'vega-lite', 'json extra', 'bash title="example"'])('leaves ambiguous or semantic fence %s unchanged', language => {
    const input = ['示例：' + fence + language, 'data', fence].join('\n');
    expect(repairReplyMarkdown(input)).toBe(input);
  });

  it('caps repairs at 16 blocks without changing the remaining raw content', () => {
    const input = Array(17).fill(malformed).join('\n\n');
    expect(repairReplyMarkdown(input)).toBe([...Array(16).fill(expected), malformed].join('\n\n'));
  });
});
