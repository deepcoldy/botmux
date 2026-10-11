/**
 * Recover paragraph breaks when a caller puts literal `\\n\\n` in the
 * positional `botmux send` argument. Shell quotes do not expand those escapes,
 * while positional arguments are documented as single-line content.
 *
 * Keep every other source byte-for-byte: stdin and --content-file may carry
 * code or serialized text where a literal escape is intentional.
 */
export function normalizePositionalSendContent(content: string): string {
  if (/[\r\n]/.test(content) || !content.includes('\\n\\n')) return content;
  return content.replaceAll('\\n\\n', '\n\n');
}
