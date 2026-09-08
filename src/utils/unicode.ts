/** Truncate to a UTF-16 code-unit budget without splitting a surrogate pair. */
export function truncateUtf16WellFormed(value: string, maxCodeUnits: number): string {
  let used = 0;
  let result = '';
  for (const codePoint of value) {
    const normalized = codePoint.length === 1
      && codePoint.charCodeAt(0) >= 0xd800
      && codePoint.charCodeAt(0) <= 0xdfff
      ? '\ufffd'
      : codePoint;
    if (used + normalized.length > maxCodeUnits) break;
    result += normalized;
    used += normalized.length;
  }
  return result;
}
