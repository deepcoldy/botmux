import { stripAnsiForLog } from './crash-log.js';
import type { CodexUpdateDialogKey } from './codex-update-dialog.js';

/**
 * Codex's one-time model-migration picker.
 *
 * When the configured model has an upgrade that this CODEX_HOME has not
 * acknowledged yet (`[notice.model_migrations]`), Codex 0.162 replaces its
 * startup composer with a modal picker before the first prompt:
 *
 *   Meet GPT-6 Sol
 *   › 1. Try new model
 *     2. Use existing model
 *   enter/esc confirm · ^c quit
 *
 * The picker owns Enter/Esc/arrow keys and drops pasted text, and both Enter
 * and Esc confirm the highlighted "Try new model" row. Unlike the update
 * picker and the rate-limit nudge there is no process-level `-c` opt-out:
 * `notice` only has per-migration flags plus the `model_migrations` map
 * (current → target), and the target comes from Codex's runtime model
 * catalog. Botmux therefore resolves the picker on screen and always keeps
 * the configured model ("Use existing model") — it never switches a user's
 * global model on their behalf (same policy as `hide_rate_limit_model_nudge`).
 */

// Numbered option rows, whitespace removed: `› 1. Try new model` → `›1.trynewmodel`.
const TRY_NEW_MODEL_ROW = /\d+\.trynewmodel/;
const USE_EXISTING_MODEL_ROW = /\d+\.useexistingmodel/;
const OPTION_ROW = /^\s*([›>»])?\s*(\d+)\.\s*(.+?)\s*$/;
// Any prompt-marker row (`› Ask Codex…`, `› draft`, `› 1. …`).
const PROMPT_ROW = /^\s*[›>»]/;
// Rows the picker may render below its options; the last one must be its
// native confirm footer (codex-cli 0.162.1: `enter/esc confirm · ^c quit`).
const MAX_ROWS_BELOW_PICKER = 2;
const PICKER_CONFIRM_FOOTER = /^\s*enter\/esc\s+confirm\b/i;
const TRY_NEW_MODEL_LABEL = /^Try new model$/i;
const USE_EXISTING_MODEL_LABEL = /^Use existing model$/i;

/**
 * Stream-side detector. PTY chunks place the picker's words with cursor
 * addressing (no spaces/newlines between them), so compare whitespace-free
 * text across a bounded tail. Both numbered option rows are required.
 */
export class CodexModelMigrationDialogGuard {
  private tail = '';

  inspect(data: string): boolean {
    const plain = stripAnsiForLog(data).replace(/\s+/g, '').toLowerCase();
    this.tail = (this.tail + plain).slice(-4_096);
    if (!TRY_NEW_MODEL_ROW.test(this.tail) || !USE_EXISTING_MODEL_ROW.test(this.tail)) return false;
    // A later composer redraw must not inherit the menu words.
    this.tail = '';
    return true;
  }

  reset(): void {
    this.tail = '';
  }
}

interface PickerOption {
  line: number;
  selected: boolean;
  label: string;
}

/** The picker's option rows on a rendered screen, or undefined when the
 * screen does not show it as the ACTIVE input surface. Option rows may be
 * separated by one blank/description line; the lowest block holding both
 * choices is the candidate. Keys are only ever synthesized on POSITIVE modal
 * evidence: the block must be the bottom pane and the last non-blank row below
 * it must be the picker's own confirm footer, with no prompt row in between.
 * The same two rows as transcript text (a resumed conversation quoting the
 * menu) or as a multi-line composer draft sit above a composer / status
 * footer instead, and typing Down+Enter there would submit the user's draft.
 * If Codex rewords the footer the picker is simply not recognised: input then
 * flows as it did before this guard, it is never held indefinitely. */
function migrationPickerOptions(screen: string): PickerOption[] | undefined {
  // tmux captures end rows with \r\n; never let that read as a blank row.
  const lines = stripAnsiForLog(screen.replace(/\r\n?/g, '\n')).split('\n');
  const rows = lines.flatMap((text, line) => {
    const match = text.match(OPTION_ROW);
    return match ? [{ line, selected: !!match[1], label: match[3]! }] : [];
  });
  const blocks: PickerOption[][] = [];
  for (const row of rows) {
    const block = blocks.at(-1);
    if (block && row.line - block.at(-1)!.line <= 2) block.push(row);
    else blocks.push([row]);
  }
  const block = blocks.reverse().find(candidate =>
    candidate.some(option => TRY_NEW_MODEL_LABEL.test(option.label))
    && candidate.some(option => USE_EXISTING_MODEL_LABEL.test(option.label)));
  if (!block) return undefined;
  const below = lines.slice(block.at(-1)!.line + 1).filter(text => text.trim());
  if (below.length === 0 || below.length > MAX_ROWS_BELOW_PICKER) return undefined;
  if (below.some(text => PROMPT_ROW.test(text))) return undefined;
  if (!PICKER_CONFIRM_FOOTER.test(below.at(-1)!)) return undefined;
  return block;
}

/** True while a rendered screen shows the migration picker. */
export function isCodexModelMigrationScreen(screen: string): boolean {
  return migrationPickerOptions(screen) !== undefined;
}

/**
 * Keys that move from the highlighted row to "Use existing model" and
 * confirm it. Returns undefined (fail closed — wait for a later render)
 * unless exactly one row is visibly highlighted: Enter/Esc on an unknown
 * selection could accept the new model.
 */
export function codexModelMigrationSafeKeys(screen: string): CodexUpdateDialogKey[] | undefined {
  const options = migrationPickerOptions(screen);
  if (!options) return undefined;
  const selected = options.flatMap((option, index) => option.selected ? [index] : []);
  if (selected.length !== 1) return undefined;
  const safe = options.findIndex(option => USE_EXISTING_MODEL_LABEL.test(option.label));
  const distance = safe - selected[0]!;
  const direction: CodexUpdateDialogKey = distance > 0 ? 'Down' : 'Up';
  return [...Array(Math.abs(distance)).fill(direction), 'Enter'];
}
