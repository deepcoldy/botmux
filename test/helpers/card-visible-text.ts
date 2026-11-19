import MarkdownIt from 'markdown-it';
import { extractCardContent } from '../../src/im/lark/message-parser.js';

/** Read text after JSON and Markdown decoding, rather than matching escaped wire data. */
export function cardVisibleText(card: string): string {
  return new MarkdownIt().parse(extractCardContent(card), {})
    .map(block => (block.children ?? [block])
      .filter(token => ['text', 'code_inline', 'code_block', 'fence'].includes(token.type))
      .map(token => token.content).join(''))
    .join('\n');
}
