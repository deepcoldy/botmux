import { describe, expect, it } from 'vitest';
import { extractHttpUrlSpans } from '../src/services/link-ref-extractor.js';

describe('extractHttpUrlSpans', () => {
  it.each([
    ['参见（https://A.test/p(a)#Frag），然后继续。', ['https://A.test/p(a)#Frag']],
    ['[授权](https://auth.test/login#步骤)', ['https://auth.test/login#步骤']],
    ['<http://example.test/a%2Fb>', ['http://example.test/a%2Fb']],
    ['English https://example.test/a next https://example.test/b.', ['https://example.test/a', 'https://example.test/b']],
    ['嵌套 https://example.test/a(b(c))', ['https://example.test/a(b(c))']],
    ['case HTTPS://Example.TEST/Path#Frag', ['HTTPS://Example.TEST/Path#Frag']],
    ['**[问题](https://example.test/p?x=1&x=&encoded=%2F#Frag)**', ['https://example.test/p?x=1&x=&encoded=%2F#Frag']],
    ['_[问题](https://example.test/p)_', ['https://example.test/p']],
    ['[一](https://example.test/a)[二](https://example.test/b)', ['https://example.test/a', 'https://example.test/b']],
    ['**[嵌套](https://example.test/p(a(b))?wild=**#Frag)**', ['https://example.test/p(a(b))?wild=**#Frag']],
    ['[空白](  https://example.test/p)**后续正文', ['https://example.test/p']],
    [String.raw`**[转义](https://example.test/p\))**`, [String.raw`https://example.test/p\)`]],
    ['**[标点](https://example.test/p.)**', ['https://example.test/p.']],
    ['裸链接 https://example.test/p?wild=**', ['https://example.test/p?wild=**']],
    ['](https://example.test/p?x=1)&y=2', ['https://example.test/p?x=1)&y=2']],
    [String.raw`\[问题](https://example.test/p?x=1)&y=2`, ['https://example.test/p?x=1)&y=2']],
    ['`[问题](https://example.test/p?x=1)&y=2`', ['https://example.test/p?x=1)&y=2']],
    ['```text\n[问题](https://example.test/p?x=1)&y=2\n```', ['https://example.test/p?x=1)&y=2']],
    ['    [问题](https://example.test/p?x=1)&y=2', ['https://example.test/p?x=1)&y=2']],
    ['**[标点](https://example.test/p. "标题")**', ['https://example.test/p.']],
    ['**[尖括号](<https://example.test/p)>)**', ['https://example.test/p)']],
    ['**![图片](https://example.test/image)**', ['https://example.test/image']],
    ['[https://other.test/p](https://example.test/p)https://next.test/p', ['https://other.test/p', 'https://example.test/p', 'https://next.test/p']],
    ['> **[问题](https://example.test/p)**\r\n\r\n- [二](https://example.test/q)', ['https://example.test/p', 'https://example.test/q']],
    ['https://example.test/p?x=[title](https://other.test/a(b))&literal=**', ['https://example.test/p?x=[title](https://other.test/a(b))&literal=**']],
    ['| **[问题](https://example.test/p)** |\n| --- |', ['https://example.test/p']],
    ['| a\\|b **[问题](https://example.test/p)** | **[问题](https://example.test/p)** |\n| --- | --- |', ['https://example.test/p', 'https://example.test/p']],
  ])('returns exact source spans for %s', (source, expected) => {
    const spans = extractHttpUrlSpans(source);
    expect(spans.map((span) => span.originalUrl)).toEqual(expected);
    for (const span of spans) {
      expect(source.slice(span.start, span.end)).toBe(span.originalUrl);
    }
  });

  it.each([
    'ftp://example.test/file',
    '/preview_platform/problem?x=1',
    'https:///missing-host',
    'https://user:password@example.test/p',
    'https://[invalid-host',
  ])('rejects non-HTTP, relative, malformed, or credential-bearing input: %s', (source) => {
    expect(extractHttpUrlSpans(source)).toEqual([]);
  });

  it('does not normalize duplicate parameters, empty values, encoding, or fragments', () => {
    const source = 'https://example.test/p' + '?b=2&a=1&a=&encoded=%2F&unicode=%E4%B8%AD#A%20B';
    expect(extractHttpUrlSpans(source)).toEqual([{ start: 0, end: source.length, originalUrl: source }]);
  });
});
