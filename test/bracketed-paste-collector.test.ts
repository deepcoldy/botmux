import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { createBracketedPasteCollector } from './helpers/bracketed-paste-collector.js';

const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

for (const [name, create] of [
  ['imported', createBracketedPasteCollector],
  ['embedded fake CLI', runInNewContext(`(${createBracketedPasteCollector.toString()})`) as typeof createBracketedPasteCollector],
] as const) {
  describe(`${name} bracketed paste input`, () => {
    it.each([
      [[paste('one') + '\r' + paste('two') + '\r'], ['one', 'two']],
      [[...paste('multiline\ntext\rinside'), '\r'], ['multiline\ntext\rinside']],
      [[paste('first'), '\r\n', paste('second') + '\n'], ['first', 'second']],
      [['\x1b[A', paste('first') + paste(' continuation') + '\r'], ['first continuation']],
    ])('preserves paste submission boundaries across chunks %j', (chunks, expected) => {
      const submitted: string[] = [];
      const collect = create(text => submitted.push(text));
      for (const chunk of chunks) collect(chunk);
      expect(submitted).toEqual(expected);
    });

    it('holds a complete paste until Enter arrives', () => {
      const submitted: string[] = [];
      const collect = create(text => submitted.push(text));
      collect(paste('draft'));
      expect(submitted).toEqual([]);
      collect('\r');
      expect(submitted).toEqual(['draft']);
    });

    it('ignores Enter without a paste and accepts a later paste', () => {
      const submitted: string[] = [];
      const collect = create(text => submitted.push(text));
      collect('\r\n');
      collect(paste('later') + '\r');
      expect(submitted).toEqual(['later']);
    });
  });
}
