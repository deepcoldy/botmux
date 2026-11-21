/**
 * Claude Code's prompt suggestion: after a turn the CLI predicts the user's
 * next input and paints it greyed out (SGR 2) in the empty input box, where
 * Tab/→ would accept it. It exists only on screen — the transcript and hooks
 * never carry it — so this reads the rendered cells.
 *
 * Shape (Claude Code 2.1.3xx, captured from live panes; fixtures under
 * test/fixtures/claude-prompt-suggestion/):
 *
 *   ──────────────────── <title> ─   ← rule (a session title may sit at its right end)
 *   ❯ <suggestion, every cell dim>    ← the single input row
 *   ──────────────────────────────   ← rule
 *     ⏵⏵ bypass permissions on …      ← footer
 *
 * Some sessions also show the CLI's own cursor as one inverse cell, which then
 * sits on the suggestion's first character instead of being dim.
 *
 * Only that exact shape counts. A typed draft is not dim; a multi-row input
 * box, another prompt style or no rules at all reads as "no suggestion", so a
 * layout this does not know degrades to showing nothing rather than a guess.
 */
import { screenRowText, type ScreenRow } from './terminal-cells.js';

const RULE_RE = /^─{20,}/;
const PROMPT_RE = /^❯[\u00a0 ]/;
/** The CLI's own static example (`Try "fix lint errors"`), drawn the same way
 * in an input box that has never been used. It is not a prediction. */
const STATIC_EXAMPLE_RE = /^Try "[^"]*"$/;
/** A meta answer from the suggestion model instead of a suggestion, never
 * something to send as input. Observed live as the literal `<no response>` and
 * as a whole-line parenthetical (`（无建议：…）`). */
const META_PLACEHOLDER_RE = /^(?:<[^<>]+>|\([^()]*\)|（[^（）]*）)$/;

function isRule(row: ScreenRow | undefined): boolean {
  return !!row && RULE_RE.test(screenRowText(row));
}

export function claudePromptSuggestion(rows: readonly ScreenRow[]): string | undefined {
  let bottom = -1;
  for (let y = rows.length - 1; y >= 0; y--) {
    if (isRule(rows[y])) { bottom = y; break; }
  }
  if (bottom < 2 || !isRule(rows[bottom - 2])) return undefined;
  const input = rows[bottom - 1];
  if (!PROMPT_RE.test(screenRowText(input))) return undefined;
  const body = input.slice(2);
  let sawDim = false;
  for (const cell of body) {
    if (!cell.ch.trim() || (cell.inverse && !cell.dim)) continue;
    if (!cell.dim) return undefined;
    sawDim = true;
  }
  if (!sawDim) return undefined;
  const suggestion = screenRowText(body).replace(/\s+/g, ' ').trim();
  if (STATIC_EXAMPLE_RE.test(suggestion) || META_PLACEHOLDER_RE.test(suggestion)) return undefined;
  return suggestion;
}
