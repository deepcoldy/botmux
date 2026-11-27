import type { FailedTurnRecord, CliTurnPayload } from '../types.js';

/** Change only the original message and selected image hints. Preserve the
 * frozen caller/envelope; rebuilding it from current config could grant the
 * retry a different identity or add newer conversation context. */
export function editFailedPrompt(record: FailedTurnRecord, text: string, keepImages: boolean): CliTurnPayload | undefined {
  const xml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let content = record.cliInput;
  const wrapped = /<user_message>([\s\S]*?)<\/user_message>/g;
  const matches = [...content.matchAll(wrapped)];
  if (matches.length === 1) content = content.replace(wrapped, () => `<user_message>\n${xml(text)}\n</user_message>`);
  else if (matches.length === 0 && record.userPrompt && content.startsWith(record.userPrompt)) content = text + content.slice(record.userPrompt.length);
  else return;
  if (!keepImages) {
    content = content.replace(/<attachments\b[^>]*>[\s\S]*?<\/attachments>/g, block => {
      const stripped = block.replace(/\s*<image\b[^>]*\/>/g, '');
      return /<(?:file|video)\b/.test(stripped) ? stripped : '';
    });
    // Structured image inputs need a native-specific edit path; never silently
    // keep an image after the user selected Remove.
    if (record.codexAppInput) return;
  }
  return { content, attachments: (record.attachments ?? []).filter(a => keepImages || a.type !== 'image'),
    ...(record.trustedCaller ? { trustedCaller: { ...record.trustedCaller } } : {}) };
}
