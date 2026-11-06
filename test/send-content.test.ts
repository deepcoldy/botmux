import { describe, expect, it } from 'vitest';
import { normalizePositionalSendContent } from '../src/services/send-content.js';

describe('normalizePositionalSendContent', () => {
  it('turns literal paragraph separators into real blank lines', () => {
    expect(normalizePositionalSendContent('第一段\\n\\n第二段'))
      .toBe('第一段\n\n第二段');
  });

  it('does not reinterpret a single literal newline escape', () => {
    expect(normalizePositionalSendContent('代码字面量 \\n'))
      .toBe('代码字面量 \\n');
  });

  it('does not touch content that already contains a real newline', () => {
    expect(normalizePositionalSendContent('第一段\n第二段里的 \\n\\n'))
      .toBe('第一段\n第二段里的 \\n\\n');
    expect(normalizePositionalSendContent('第一段\r\n第二段里的 \\n\\n'))
      .toBe('第一段\r\n第二段里的 \\n\\n');
  });
});
