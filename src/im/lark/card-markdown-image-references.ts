import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

const imageScanMd = new MarkdownIt({ html: false, linkify: false, breaks: false });
imageScanMd.validateLink = () => true;

export const FEISHU_IMG_KEY = /^img_v\d+_[A-Za-z0-9_-]+$/i;

export interface CardMarkdownImageReference {
  position: number;
  source: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function chooseMarkerPrefix(input: string): string {
  // Keep the marker URL-safe. MarkdownIt normalizes control characters inside
  // destinations, which would detach the marker from the preceding text token
  // and make every real image look absent.
  let prefix = 'bmxcardimgmarkerx';
  while (input.includes(prefix)) prefix += 'x';
  return prefix;
}

/**
 * Locate actual Markdown image tokens without mistaking fenced/inline code,
 * escaped syntax or ordinary links for attachments.
 */
export function cardMarkdownImageReferences(input: string): CardMarkdownImageReference[] {
  if (!input.includes('![')) return [];
  const prefix = chooseMarkerPrefix(input);
  const positions: number[] = [];
  const marked = input.replace(/\\.|!\[/gs, (match: string, offset: number) => {
    if (match !== '![') return match;
    const id = positions.push(offset) - 1;
    return `${prefix}${id}x![`;
  });
  const marker = new RegExp(`${escapeRegExp(prefix)}(\\d+)x$`);
  const images: CardMarkdownImageReference[] = [];
  const inspect = (tokens: Token[]): void => {
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.type === 'image') {
        const match = tokens[index - 1]?.content.match(marker);
        if (match) {
          images.push({
            position: positions[Number(match[1])],
            source: token.attrGet('src') ?? '',
          });
        }
      }
      if (token.children) inspect(token.children);
    }
  };
  inspect(imageScanMd.parse(marked, {}));
  return images.sort((a, b) => a.position - b.position);
}

/** Return unique Feishu image keys in the same order as the Markdown tokens. */
export function extractFeishuCardMarkdownImageKeys(input: string): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const reference of cardMarkdownImageReferences(input)) {
    if (!FEISHU_IMG_KEY.test(reference.source) || seen.has(reference.source)) continue;
    seen.add(reference.source);
    keys.push(reference.source);
  }
  return keys;
}
