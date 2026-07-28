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
