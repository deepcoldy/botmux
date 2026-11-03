/**
 * Locate Markdown code (inline spans and fenced blocks) in outgoing text, so
 * `@Name` written inside code is treated as a literal example rather than a
 * mention — both by the prose `@BotName` scanner and by the inline `<at>`
 * rewriter, which must agree on what counts as code.
 */

/**
 * Sorted, non-overlapping `[start, end)` offsets of Markdown code in `text`.
 *
 * Fenced blocks (a run of ≥3 backticks or ≥3 tildes, closed by an equal-length
 * run) are found first and blanked to spaces of equal length, so their fences
 * aren't misread as inline runs while offsets stay aligned; then balanced
 * inline backtick runs (`…`, ``…``) are found. `~~strike~~` (double tilde) is
 * NOT a fence — an @Bot inside strikethrough is still a real prose mention.
 * Unbalanced stray backticks are harmless literals.
 */
export function codeSpanRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const masked = text.replace(/(`{3,}|~{3,})[\s\S]*?\1/g, (block, _fence, offset: number) => {
    ranges.push([offset, offset + block.length]);
    return ' '.repeat(block.length);
  });
  for (const m of masked.matchAll(/(`+)[\s\S]*?\1/g)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  // An inline span can only wrap a whole (blanked) fence, never cut through one,
  // so an overlapping range is always fully contained in the previous one.
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] < last[1]) continue;
    merged.push(range);
  }
  return merged;
}

/**
 * Blank out Markdown code so a bot name written *inside code* — an example
 * command in backticks, a fenced snippet, a quoted `@Bot` in an explanation —
 * is NOT mistaken for a real `@Bot` handoff by the prose auto-injection scanner
 * (which would otherwise wake that bot). Each code region collapses to a single
 * space; see {@link codeSpanRanges} for what counts as code.
 */
export function stripCodeSpans(text: string): string {
  let out = '';
  let cursor = 0;
  for (const [start, end] of codeSpanRanges(text)) {
    out += `${text.slice(cursor, start)} `;
    cursor = end;
  }
  return out + text.slice(cursor);
}
