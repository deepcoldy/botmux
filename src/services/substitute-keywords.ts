import { resolvePostBody } from '../im/lark/message-parser.js';

/** Match only text authored in this message, never mention labels or quoted/history data. */
export function matchesSubstituteKeywords(
  keywords: string[] | undefined,
  message: { content?: string; mentions?: Array<{ key?: string }> },
): boolean {
  if (!keywords?.length) return true;
  try {
    const content = JSON.parse(message.content ?? '{}');
    let text: string;
    if (typeof content?.text === 'string') {
      text = content.text;
      for (const mention of message.mentions ?? []) {
        if (mention.key) text = text.split(mention.key).join(' ');
      }
      text = text.replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, ' ');
    } else {
      // Reuse the locale-agnostic post projection so ja_jp/de_de/… rich-text
      // bodies match the same as zh_cn/en_us instead of being silently dropped.
      // An unrecognized/empty post resolves to no paragraphs → no keyword can
      // match, so this stays fail-closed.
      const post = resolvePostBody(content);
      const paragraphs = post.content.map((paragraph: unknown) => {
        if (!Array.isArray(paragraph)) return '';
        return paragraph.map(node =>
          (node?.tag === 'text' || node?.tag === 'a') && typeof node.text === 'string'
            ? node.text : ' ',
        ).join('');
      });
      text = [post.title, ...paragraphs].join('\n');
    }
    const lower = text.toLowerCase();
    return keywords.some(keyword => lower.includes(keyword.toLowerCase()));
  } catch {
    return false;
  }
}
