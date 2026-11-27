import { describe, expect, it } from 'vitest';
import { escapeNoticeMarkdown, noticeMarkdownLink } from '../src/core/decision-board/notice-card.js';

describe('公告卡片的 Markdown 行首边界', () => {
  it.each([
    { raw: '# heading', escaped: '\\# heading' },
    { raw: '## heading', escaped: '\\## heading' },
    { raw: '###### heading', escaped: '\\###### heading' },
    { raw: '#', escaped: '\\#' },
    { raw: '##', escaped: '\\##' },
    { raw: '  ## indented', escaped: '  \\## indented' },
    { raw: '  ##', escaped: '  \\##' },
  ])('ATX 标题标记按普通文字显示：$raw', ({ raw, escaped }) => {
    expect(escapeNoticeMarkdown(raw)).toBe(escaped);
  });

  it.each(['####### not a heading', '#######', '#1 item', 'C# note'])('非标题的 # 保持不变：%s', raw => {
    expect(escapeNoticeMarkdown(raw)).toBe(raw);
  });

  it('Setext 等号下划线不改变上一行 owner 原文', () => {
    expect(escapeNoticeMarkdown('literal\n===\n  =  \nnot an underline =')).toBe(
      'literal\n\\===\n  \\=  \nnot an underline =',
    );
  });

  it('一至三个空格后接 Tab 也不会形成缩进代码块', () => {
    expect(escapeNoticeMarkdown(' \tliteral\n  \tliteral\n   \tliteral')).toBe(
      ' &#32;literal\n  &#32;literal\n   &#32;literal',
    );
  });

  it('右括号形式的 ordered list 已由括号转义覆盖', () => {
    expect(escapeNoticeMarkdown('1) literal')).toBe('1\\) literal');
  });
});

describe('公告卡片链接的 scheme 门', () => {
  it.each([
    'javascript:alert(1)',
    'ftp://example.test/file',
    '//example.test/protocol-relative',
  ])('非 HTTP(S) 地址只显示转义后的文字：%s', url => {
    expect(noticeMarkdownLink('label [x]', url)).toBe('label \\[x\\]');
  });

  it('HTTP(S) 大小写均可，括号仍按链接边界编码', () => {
    expect(noticeMarkdownLink('docs', 'HTTPS://example.test/a(b)')).toBe(
      '[docs](HTTPS://example.test/a%28b%29)',
    );
  });
});
