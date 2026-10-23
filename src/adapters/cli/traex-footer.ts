import { stripAnsiScreenText } from '../../utils/idle-detector.js';

/**
 * TraeX 0.209.x busy evidence from a FULL authoritative viewport.
 *
 * 0.209 replaced the braille spinner with geometric glyphs and moved the
 * interrupt hint into the status parentheses, mid-line. Viewports rendered
 * from a recorded traecli 0.209.1 session:
 *
 *   ◆ 好
 *   ✧ Working… (3s • ↓ 9 tokens • esc to interrupt)     ← status row
 *   ─────────────────────────────────────────────        ← composer top rule
 *   ❯ Summarize recent commits                          ← composer
 *     model · Context 99% left · /tmp/w                 ← status bar
 *
 * and once the turn settles the status row becomes "  Worked for 3s • …".
 * None of busyPattern's braille / line-anchored arms match that, so 0.209 had
 * no viewport busy evidence at all.
 *
 * Why rows, not a regex over busyProbeRegion(): `◆` is also the transcript
 * bullet, and replies or composer drafts can quote a complete status line or
 * even a whole footer. The only thing an example cannot fake is GEOMETRY —
 * the live status row and the composer's first row are the only rows of
 * that shape at COLUMN 0, two rows apart. That
 * needs the whole viewport: busyProbeRegion() keeps only its tail, which a
 * long draft fills, dropping the real composer row.
 */

const GLYPH_FRAMES = '⋄◇◆✦◈❖✧';

/** Column-0 status row: glyph, a spinner label starting with a capital
 *  letter ("Working…", "Shh, it's thinking…" — see TRAEX_SPINNER_LABELS),
 *  then parentheses that OPEN with the elapsed time ("1s",
 *  "1m 5s") and later carry the interrupt hint. Diff repaints have been seen
 *  spelling it "interupt". The label must start right after the glyph: a
 *  reply whose first line IS an example renders as "◆ ❖ Working… (…)". */
const STATUS_ROW = new RegExp(
  `^[${GLYPH_FRAMES}][ \\t][A-Z][^…()\\n]{0,40}…[ \\t]+`
  + `\\(\\d+[hms](?:[ \\t]+\\d+[hms])*[ \\t]+•[^)]{0,160}\\besc to interr?upt\\b[^)]{0,160}\\)[ \\t]*$`,
);

/** Composer's first row. Measured on a live 0.209.1 pane: only this row
 *  starts a prompt at column 0 — user turns render as "▍ …", reply
 *  continuations and composer-draft continuations are indented two columns,
 *  so a quoted "❯ …" never reaches column 0. */
const PROMPT_ROW = /^[›❯](?:[ \t]|$)/;

/**
 * True only when the row two above the composer is a live status row. The
 * row between is the composer's top rule: a ─ run in tmux captures, blank
 * after the renderer's cleanBoxDrawing, or carrying stale repaint text / a
 * title ("──── Output code block ─"). Anything ambiguous returns false — the
 * pre-0.209 behaviour (no viewport busy evidence), which never wedges input.
 */
export function traexViewportFooterBusy(screen: string): boolean {
  const rows = stripAnsiScreenText(screen).split(/\r?\n/);
  const composer = rows.findIndex(row => PROMPT_ROW.test(row));
  if (composer < 2) return false;
  return STATUS_ROW.test(rows[composer - 2]!);
}

// Native empty-composer suggestions from TraeX 0.210.1's string table.
// Arbitrary draft text must not be mistaken for a composer ready to receive
// Botmux's queued paste.
const EMPTY_COMPOSER_HINTS = new Set([
  '',
  'Ask TraeCode CLI to do anything',
  'Explain this codebase',
  'Summarize recent commits',
  'Implement {feature}',
  'Find and fix a bug in @filename',
  'Write tests for @filename',
  'Improve documentation in @filename',
  'Run /review on my current changes',
  'Use /skills to list available skills',
  'Check recently modified functions for compatibility',
  'How many files have been modified?',
  'Will this algorithm scale well?',
]);

/**
 * Resume can paint a loading banner, then replace it with history and a fully
 * initialized composer without repainting the resolved banner cells. Only the
 * bottom input surface and its model/context footer can release that hold.
 * The worker supplies an authoritative rendered viewport, never raw PTY bytes.
 */
export function traexRestoredComposerReady(screen: string): boolean {
  const rows = stripAnsiScreenText(screen).trimEnd().split(/\r?\n/);
  let composer = rows.length - 1;
  while (composer >= 0 && !PROMPT_ROW.test(rows[composer]!)) composer--;
  if (composer < 0 || !EMPTY_COMPOSER_HINTS.has(rows[composer]!.slice(1).trim())) return false;
  const footer = rows.slice(composer + 1).filter(row => row.trim());
  // TraeX 0.209/0.210: optional bottom rule, initialized model/context row,
  // then the access/shortcut row. Extra rows can be a draft, picker or dialog.
  if (/^[ \t]*─+[ \t]*$/.test(footer[0] ?? '')) footer.shift();
  if (footer.length < 1 || footer.length > 2) return false;
  if (!/^[ \t]*\S[^│\r\n]* · (?:[^│\r\n]* · )?Context \d+% (?:left|used)(?: · [^\r\n]*)?[ \t]*$/.test(footer[0]!)) return false;
  if (footer.length === 2 && !/^[ \t]*(?:☢ )?(?:Full Access|Read Only|Auto|Default)[^\r\n]* · (?:\? for shortcuts|← for agents)/.test(footer[1]!)) return false;
  // Check the live area above the composer, not stale quoted transcript rows.
  const live = rows.slice(Math.max(0, composer - 3), composer + 1).join('\n');
  return !/(?:model|directory):[ \t]*loading\b|Resuming session|esc to interr?upt|Queued for (?:capacity|next turn)|Too many requests right now/i.test(live);
}
