/**
 * Escape raw text rendered inside an XML or XML-like element.
 * Call once at the render boundary; pre-escaped entities would be double-escaped.
 */
export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escape complete angle-bracket tokens embedded in XML prompt prose.
 *
 * This is intentionally narrower than `escapeXmlText`: shell operators such
 * as the `<<'EOF'` heredoc marker have no closing `>` and must remain copyable.
 * Apply it to prose fields before rendering them, never to a serialized block
 * whose real structural tags must stay intact.
 *
 * Any complete `<...>` span is treated as a tag-like token. Do not apply this
 * helper to arbitrary shell/math prose where unrelated `<` and `>` operators
 * may occur on the same line (for example, `cmd < input > output`).
 */
export function escapeXmlTagLikeTokens(value: string): string {
  return value.replace(/<[^<>\r\n]+>/g, token => escapeXmlText(token));
}
