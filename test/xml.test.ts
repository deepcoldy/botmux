import { describe, expect, it } from 'vitest';
import { escapeXmlAttr, escapeXmlTagLikeTokens, escapeXmlText } from '../src/utils/xml.js';

describe('escapeXmlText', () => {
  it('escapes XML text delimiters once and in the correct order', () => {
    expect(escapeXmlText('<tag>A & B</tag>')).toBe('&lt;tag&gt;A &amp; B&lt;/tag&gt;');
  });
});

describe('escapeXmlAttr', () => {
  it('escapes quotes that would break out of an attribute', () => {
    expect(escapeXmlAttr('a"b\'c<d>&')).toBe('a&quot;b&apos;c&lt;d&gt;&amp;');
  });
});

describe('escapeXmlTagLikeTokens', () => {
  it('escapes complete tag-like prose tokens without rewriting shell heredocs', () => {
    const input = "botmux quoted <message_id>; botmux send <<'EOF'; --mention <对方 bot 的 open_id>";

    expect(escapeXmlTagLikeTokens(input)).toBe(
      "botmux quoted &lt;message_id&gt;; botmux send <<'EOF'; --mention &lt;对方 bot 的 open_id&gt;",
    );
  });
});
