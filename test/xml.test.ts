import { describe, expect, it } from 'vitest';
import { escapeXmlText } from '../src/utils/xml.js';

describe('escapeXmlText', () => {
  it('escapes XML text delimiters once and in the correct order', () => {
    expect(escapeXmlText('<tag>A & B</tag>')).toBe('&lt;tag&gt;A &amp; B&lt;/tag&gt;');
  });
});
