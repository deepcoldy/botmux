/**
 * Strip the most common markdown markers so a plain-text comment doesn't
 * show literal `**` / `#` / `> ` etc.  Conservative — only touches bold,
 * italic, headings, blockquote, list bullets, and inline code.
 *
 * Ported from lark-coding-agent-bridge/src/bot/comments.ts stripMarkdown.
 */
export function stripMarkdown(s: string): string {
  return s
    // headings: "# foo" -> "foo"
    .replace(/^#{1,6}\s+/gm, '')
    // bold: **foo** / __foo__
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    // italic: *foo* / _foo_  (avoid matching inside words)
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, '$1')
    .replace(/(?<![_\w])_([^_\n]+)_(?!\w)/g, '$1')
    // inline code: `foo`
    .replace(/`([^`]+)`/g, '$1')
    // unordered list bullets: "- foo" / "* foo"
    .replace(/^[-*]\s+/gm, '')
    // blockquote: "> foo"
    .replace(/^>\s?/gm, '')
    // remove fenced code-block backticks but keep contents
    .replace(/```[a-zA-Z]*\n?/g, '')
    .replace(/```/g, '');
}
