export interface CodexComposerInputState {
  viewport: string;
  cursor: { x: number; y: number };
}

export type CodexComposerState = 'empty' | 'draft' | 'unknown';

/**
 * Infer whether the cursor is inside a non-empty Codex composer.
 *
 * Codex leaves the cursor immediately after the `› ` marker while its empty
 * placeholder is visible. A real single-line draft moves the cursor to the
 * right; a multi-line draft moves it below the marker row. This lets botmux
 * distinguish the placeholder from user-authored text without depending on
 * the placeholder copy, color, or locale.
 *
 * KNOWN LIMITATION (fail-open, accepted): the signal is cursor position alone.
 * A single-line draft whose cursor the user moved back to the very start
 * (`cursor.x` at the empty-composer column) is indistinguishable from an empty
 * composer and reports 'empty' — the Lark message would still be appended. A
 * truly fail-closed detector would need composer content evidence (ANSI style
 * runs / a stronger Codex state probe), not just the cursor. This guard only
 * covers the common case where the cursor is still at/after the draft it typed.
 */
export function detectCodexComposerState(
  input: CodexComposerInputState | null | undefined,
): CodexComposerState {
  if (!input) return 'unknown';
  const { cursor } = input;
  if (!Number.isInteger(cursor.x) || !Number.isInteger(cursor.y) || cursor.x < 0 || cursor.y < 0) {
    return 'unknown';
  }

  const lines = input.viewport.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (cursor.y >= lines.length) return 'unknown';

  // Codex keeps the composer compact. Limit the backward scan so an old user
  // prompt higher in the viewport cannot be mistaken for the live composer.
  const firstCandidateRow = Math.max(0, cursor.y - 12);
  for (let row = cursor.y; row >= firstCandidateRow; row -= 1) {
    const line = lines[row] ?? '';
    const marker = /^(\s*)›/.exec(line);
    if (!marker) continue;
    // NOTE on Codex's update picker (`› 1. Update now` / `› 2. Skip`): we do
    // NOT special-case it. The adapter's readyPattern excludes it so a queued
    // message can't auto-select a menu item, but here the only consequence of
    // treating a picker row as a composer is the state we return, and BOTH
    // outcomes are safe: a picker is never something a Lark message should be
    // injected into, so classifying it as 'draft' (refuse) is fine, and 'empty'
    // merely falls through to the normal write. Adding a `\d+.` exclusion here
    // would instead turn a legitimate numbered draft (e.g. `› 1. 买牛奶`) into
    // 'unknown' → the message gets appended and clobbers the draft: the exact
    // fail-open bug this guard exists to prevent. So the bare marker stays.

    if (row < cursor.y) return 'draft';
    const emptyCursorX = marker[1]!.length + 2; // visible `› ` prefix
    return cursor.x > emptyCursorX ? 'draft' : 'empty';
  }

  return 'unknown';
}
