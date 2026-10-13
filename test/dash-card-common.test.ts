import { describe, expect, it } from 'vitest';
import { escapeLarkMd } from '../src/im/lark/dash-card-common.js';

describe('escapeLarkMd', () => {
  it('entity-escapes tag delimiters so user text cannot close our <font> wrapper', () => {
    expect(escapeLarkMd('</font><at id=ou_x></at>')).toBe('&lt;/font&gt;&lt;at id=ou\\_x&gt;&lt;/at&gt;');
    expect(escapeLarkMd('a & b')).toBe('a &amp; b');
  });

  it('escapes markdown controls', () => {
    expect(escapeLarkMd('my_file*name~`x`')).toBe('my\\_file\\*name\\~\\`x\\`');
  });

  it('escapes a user backslash so it cannot cancel the escape we add', () => {
    // Without escaping `\`, input `\*` became `\\*`: an escaped backslash
    // followed by a live `*`.
    expect(escapeLarkMd('\\*bold*')).toBe('\\\\\\*bold\\*');
    expect(escapeLarkMd('C:\\work\\repo')).toBe('C:\\\\work\\\\repo');
  });
});
