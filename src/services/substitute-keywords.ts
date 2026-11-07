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
      const post = content?.zh_cn ?? content?.en_us ?? content;
      if (!Array.isArray(post?.content)) return false;
      const paragraphs = post.content.map((paragraph: unknown) => {
        if (!Array.isArray(paragraph)) return '';
        return paragraph.map(node =>
          (node?.tag === 'text' || node?.tag === 'a') && typeof node.text === 'string'
            ? node.text : ' ',
        ).join('');
      });
      text = [typeof post.title === 'string' ? post.title : '', ...paragraphs].join('\n');
    }
    const lower = text.toLowerCase();
    return keywords.some(keyword => lower.includes(keyword.toLowerCase()));
  } catch {
    return false;
  }
}
