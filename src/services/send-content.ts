/**
 * Recover paragraph breaks when a caller puts literal `\\n\\n` in the
 * positional `botmux send` argument. Shell quotes do not expand those escapes,
 * while positional arguments are documented as single-line content.
 *
 * This is intentionally a narrow heuristic: content with real line breaks and
 * single literal `\\n` escapes is left unchanged. Callers keep stdin and
 * --content-file outside this positional-only normalization.
 */
export function normalizePositionalSendContent(content: string): string {
  if (/[\r\n]/.test(content) || !content.includes('\\n\\n')) return content;
  return content.replaceAll('\\n\\n', '\n\n');
}
