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
