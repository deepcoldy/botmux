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

/** Native /model overlays replace the composer. Match only the live tail
 * below the final rule, never an old menu quoted in the transcript. Return
 * the page identity so recovery waits for redraw before sending another Esc.
 * Captured on 0.213.1: model -> backend variant -> reasoning level. */
export function traexModelPickerPage(screen: string): string | undefined {
  const rows = stripAnsiScreenText(screen).trimEnd().split(/\r?\n/);
  if (!/^\s*enter confirm\s*\|\s*esc go back\s*$/.test(rows.at(-1) ?? '')) return;
  let start = rows.length - 1;
  while (start >= 0 && !/^[ \t]*─{3,}[^\r\n]*$/.test(rows[start]!)) start--;
  if (start < 0) return;
  const tail = rows.slice(start + 1);
  const title = tail.find(row => /^  Select (?:Model and (?:Effort|Mode)|Reasoning Level for .+)\s*$/.test(row));
  if (!title || !tail.some(row => /^[›❯][ \t]+\d+\. /.test(row))) return;
  return title.trim();
}

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
  'Ask TRAE CLI to do anything',
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
 * Fresh 0.211 startup and resume can paint an initialized composer without
 * the old model/directory banner. Only the bottom input surface and its
 * model/context footer can prove initialization. Context — is the native
 * empty-session footer before token usage exists.
 * The worker supplies an authoritative rendered viewport, never raw PTY bytes.
 */
export function traexRestoredComposerReady(
  screen: string,
  opts: { resumedSession?: boolean } = {},
): boolean {
  const rows = stripAnsiScreenText(screen).trimEnd().split(/\r?\n/);
  let composer = rows.length - 1;
  while (composer >= 0 && !PROMPT_ROW.test(rows[composer]!)) composer--;
  if (composer < 0 || !EMPTY_COMPOSER_HINTS.has(rows[composer]!.slice(1).trim())) return false;
  const footer = rows.slice(composer + 1).filter(row => row.trim());
  // TraeX 0.209–0.211: optional bottom rule, initialized model/context row,
  // then the access/shortcut row. Extra rows can be a draft, picker or dialog.
  if (/^[ \t]*─+[ \t]*$/.test(footer[0] ?? '')) footer.shift();
  if (footer.length < 1 || footer.length > 2) return false;
  // Recorded 0.212.1 cold start: marketplace Git access failure replaces
  // BOTH native footer rows with a nonblocking notification for ~30s. The
  // initialized startup banner and an empty composer still prove readiness.
  // An exact resume can scroll that cold-start banner out of the viewport;
  // its host-provided launch context replaces the banner requirement only
  // for this known nonblocking notification, never arbitrary dialog text.
  const startupRows = rows.slice(0, composer);
  const repositoryNotice = footer.length === 1
    && /^[ \t]*无法访问 Git 仓库 `[^`\r\n]+`，请确认该仓库权限或地址。[ \t]*$/.test(footer[0]!)
    && (opts.resumedSession === true || (
      startupRows.some(row => /^[ \t]*(?:█ ◆ ◆ █[ \t]+)?TRAE CLI \(v\d[^\r\n]*\)[ \t]*$/.test(row))
      && startupRows.some(row => /^[ \t]*permissions:[ \t]+\S/.test(row))
    ))
    && !startupRows.some(row => /(?:model|directory):[ \t]*loading\b/i.test(row));
  // TraeX 0.214.1 cold start draws the empty composer with a bare shortcut
  // hint before the model/context footer resolves (measured: the model list
  // fetch can take tens of seconds, leaving this frame on screen past the
  // first-prompt hard timeout). Accept it only when the single footer row
  // consists solely of native hint tokens. Recorded blocking pages (folder
  // trust, migration, hooks review, sign-in, session lock) replace the
  // composer and fail the empty-composer hint check above; anything rendered
  // above an intact composer is covered by the worker's startup-blocker
  // probes and its flush-time re-checks, not by this predicate.
  // Startup diagnostics (e.g. an unparsable SKILL.md) are collected in the
  // bottom warning indicator, right-aligned on the hint row. A wide pane shows
  // `⚠ N warning(s) · f2 to view`; narrow panes degrade it to `⚠ N · f2` and
  // then bare `⚠ N` (measured thresholds: 52 / 25 / 15 cols). It is a notice,
  // not an input owner, so a hint row carrying any of these shapes is still
  // the native composer footer. Below ~25 cols the hint tokens themselves are
  // dropped and the warning indicator becomes the whole footer row.
  const warningIndicator = '⚠[ \\t]+\\d+(?:[ \\t]+warnings?[ \\t]+·[ \\t]+f2[ \\t]+to[ \\t]+view|[ \\t]+·[ \\t]+f2)?';
  const warningSuffix = `(?:[ \\t]+${warningIndicator})?`;
  const hintOnlyRow = new RegExp(`^[ \\t]*(?:\\? for shortcuts|← for agents)(?:[ \\t]+·[ \\t]+(?:\\? for shortcuts|← for agents))*${warningSuffix}[ \\t]*$`);
  const warningOnlyRow = new RegExp(`^[ \\t]*${warningIndicator}[ \\t]*$`);
  const warningOnlyFooter = warningOnlyRow.test(footer[footer.length - 1]!);
  const shortcutOnlyFooter = footer.length === 1 && (hintOnlyRow.test(footer[0]!) || warningOnlyFooter);
  // A working directory wider than the pane truncates the model/context row
  // with a U+2026 ellipsis before the Context cell can render. Such a row
  // still contains the native ` · ` cell separator and ends on the
  // truncation marker, which ordinary notifications never do. The bottom
  // pane only emits native status cells (toasts render above the composer),
  // so this arm deliberately trusts the footer-region geometry; revisit it if
  // a future build moves notification content below the composer.
  const truncatedStatusRow = /^[ \t]*(?![^\r\n]*│)\S[^\r\n]* · [^\r\n]*…[ \t]*$/;
  if (!repositoryNotice && !shortcutOnlyFooter
    && !/^[ \t]*\S[^│\r\n]* · (?:[^│\r\n]* · )?Context (?:\d+% (?:left|used)|—)(?: · [^\r\n]*)?[ \t]*$/.test(footer[0]!)
    && !truncatedStatusRow.test(footer[0]!)) return false;
  // Only the model cell is initialization evidence; a cwd named "loading"
  // in a later footer cell must not strand an otherwise initialized prompt.
  if (!repositoryNotice && /\bloading\b/i.test(footer[0]!.split(' · ', 1)[0]!)) return false;
  // approval_policy=never and custom permission profiles (e.g. a managed
  // qdh-topic profile) omit the standard permission label, so the second
  // footer row is a bare hint row; on a narrow pane the hint tokens are
  // dropped entirely and only the width-degraded warning indicator remains.
  if (footer.length === 2 && !hintOnlyRow.test(footer[1]!) && !warningOnlyRow.test(footer[1]!)
    && !/^[ \t]*(?:[☢▧] )?(?:Full Access|Read Only|Auto Mode|Workspace Edit|Auto|Default)[^\r\n]* · (?:\? for shortcuts|← for agents)/.test(footer[1]!)) return false;
  // A login banner can be taller than the nearby live-status region. Inspect
  // all rows above the composer for native login prompts, but do not treat
  // a transcript sentence mentioning login as an active input owner.
  if (rows.slice(0, composer).some(row => /^(?:Sign in\b|Press (?:enter|return) to open (?:the )?browser\b|(?:waiting for|awaiting) authori[sz]ation\b)/i.test(row))) return false;
  // Check the live area above the composer, not stale quoted transcript rows.
  const live = rows.slice(Math.max(0, composer - 3), composer + 1).join('\n');
  return !/(?:model|directory):[ \t]*loading\b|Resuming session|esc to interr?upt|Queued for (?:capacity|next turn)|Too many requests right now/i.test(live);
}
