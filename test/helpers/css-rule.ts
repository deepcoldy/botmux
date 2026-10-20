/** Return one flat CSS rule body without allowing assertions to cross `}`. */
export function cssRuleBody(source: string, selector: string, from = 0): string {
  const marker = `${selector} {`;
  const start = source.indexOf(marker, from);
  if (start === -1) throw new Error(`selector not found in CSS: ${selector}`);
  const bodyStart = start + marker.length;
  const end = source.indexOf('}', bodyStart);
  if (end === -1) throw new Error(`unterminated CSS rule: ${selector}`);
  const nestedStart = source.indexOf('{', bodyStart);
  if (nestedStart !== -1 && nestedStart < end) {
    throw new Error(`nested CSS rule is unsupported: ${selector}`);
  }
  return source.slice(bodyStart, end);
}
