import type { CodexDrainResult } from '../services/codex-transcript.js';
import type { CodexAppEffortResult } from '../types.js';
type CodexThreadSettings = NonNullable<CodexDrainResult['latestThreadSettings']>;

type Menu = { kind: 'model' | 'effort' | 'advanced'; rows: Array<{ label: string; selected: boolean }> };
const LABELS: Record<string, RegExp> = {
  low: /^Low\b/i, medium: /^Medium\b/i, high: /^High\b/i,
  xhigh: /^(Extra high|Very high)\b/i, max: /^Max\b/i, ultra: /^Ultra\b/i,
};

/** Safety bound for paging the model list. Codex 0.162 ships ~15 models, so
 *  this is only a guard against a screen that never settles; the real stop
 *  condition is the viewport no longer changing after Down. */
const MODEL_MENU_SCROLL_MAX = 60;

/** Model-identity key shared by row matching and receipt verification.
 *  The startup config slug is preserved verbatim by `turn_context`, while the
 *  picker renders display spacing (`GPT-6.1 Sol` vs slug `GPT-6.1-Sol`) and
 *  `models_cache.json` keeps mixed casing (`GPT-6.1-Sol` vs `gpt-6-astra`):
 *  compare case-insensitively and ignore hyphen/space differences. Dots stay
 *  significant (6.1 is not 61). */
function modelIdentityKey(value: string): string {
  return value.toLowerCase().replace(/[\s-]+/g, '');
}

export function sameModelIdentity(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && modelIdentityKey(a) === modelIdentityKey(b);
}

/** Extract the comparable model name from a picker row label.
 *  Rows can carry:
 *  - a trailing marker: `GPT-6-Astra (current)`;
 *  - a description column padded with ≥2 spaces:
 *    `GPT-6.1 Sol   GPT-6.1 Sol via Codex Bridge.` (Codex 0.162), possibly
 *    with the marker between name and description.
 *  Single spaces inside a display name (`GPT-6.1 Sol`) stay significant;
 *  only the ≥2-space / tab gap marks the column boundary. */
function modelRowName(label: string): string {
  const nameColumn = label.split(/ {2,}|\t/)[0]!.trim();
  return nameColumn.replace(/(?:\s*\([^)]*\))+\s*$/, '').trim();
}

/** Only recognize the native picker with its footer, never prose in scrollback. */
export function parseCodexEffortMenu(screen: string): Menu | undefined {
  const lines = screen.split(/\r?\n/);
  let title = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*(Select Model and Effort|Select Reasoning Level for .+|Advanced Reasoning)\s*$/.test(lines[i]!)) { title = i; break; }
  }
  if (title < 0) return;
  const tail = lines.slice(title + 1);
  if (!tail.some(line => /enter (?:select|default).*esc back/i.test(line))) return;
  // A later live composer means the title belongs to old output, not a picker.
  if (tail.some(line => /^\s*[›»]\s*(?!\d+\.)\S/.test(line))) return;
  const rows = tail.flatMap(line => {
    const match = /^\s*([›»]?)\s*\d+\.\s+(.+?)\s*$/.exec(line);
    return match ? [{ label: match[2]!, selected: !!match[1] }] : [];
  });
  if (!rows.length || rows.filter(row => row.selected).length !== 1) return;
  const heading = lines[title]!.trim();
  return { kind: heading === 'Select Model and Effort' ? 'model'
    : heading === 'Advanced Reasoning' ? 'advanced' : 'effort', rows };
}

export function hasEmptyCodexComposer(screen: string): boolean {
  const row = screen.split(/\r?\n/).reverse().find(line => /^\s*[›»]/.test(line));
  // Deliberately reject unknown placeholders and drafts, including a draft with
  // its cursor moved to column zero. Never clear a user's composer to open /model.
  return !!row && /^\s*[›»]\s*(?:Ask Codex to do anything)?\s*$/.test(row);
}

export interface CodexEffortMenuIO {
  screen(): Promise<string>;
  command(): Promise<void>;
  key(key: 'Up' | 'Down' | 'Enter' | 'Escape' | 's'): void;
  /** Only settings appended AFTER this operation started, from its exact rollout. */
  settings(): CodexThreadSettings | undefined;
  isCurrent(): boolean;
  signal: AbortSignal;
  deadline: number;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
}

/** Future-turn setting only. This intentionally does not claim turn/settings/update. */
export async function applyCodexEffortMenu(
  io: CodexEffortMenuIO, model: string, effort: string,
): Promise<CodexAppEffortResult> {
  if (!LABELS[effort]) return { status: 'invalid' };
  const now = io.now ?? Date.now;
  const delay = io.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let opened = false;
  let confirmed = false;
  let previousAction: string | undefined;
  let selected = false;
  // Last model-page viewport and Down count for scrolling to an off-screen
  // target. Without a (current) marker the CLI neither marks nor auto-scrolls
  // to the current model, so a long list opens on rows 1..N and the target can
  // be below the fold; we move the cursor Down until it appears.
  let modelFrame: string | undefined;
  let modelScrolls = 0;
  const alive = () => io.isCurrent() && !io.signal.aborted && now() < io.deadline;
  try {
    const initial = await io.screen();
    if (!alive() || !hasEmptyCodexComposer(initial) || parseCodexEffortMenu(initial)) {
      return { status: 'unavailable', reason: 'cli_menu_unavailable' };
    }
    await io.command();
    opened = true;
    while (alive()) {
      const settings = io.settings();
      if (selected && settings?.model && sameModelIdentity(settings.model, model) && settings.reasoningEffort === effort) {
        confirmed = true;
        return { status: 'future_only', reason: 'cli_next_turn' };
      }
      const screen = await io.screen();
      if (!alive()) break;
      const menu = parseCodexEffortMenu(screen);
      if (menu && !selected) {
        const current = menu.rows.findIndex(row => row.selected);
        // The `(current)` marker is primary. Codex 0.162 omits it entirely
        // when the config slug casing differs from the catalog (e.g.
        // `gpt-6.1-sol` vs `GPT-6.1-Sol`); fall back to the row whose display
        // name matches the configured model, so the current model is still
        // kept instead of failing with an empty choice list.
        const isCurrentModelRow = (label: string): boolean => /\(current\)/i.test(label)
          || sameModelIdentity(modelRowName(label), model);
        let target = menu.rows.findIndex(row => menu.kind === 'model'
          ? isCurrentModelRow(row.label) : LABELS[effort]!.test(row.label));
        if (target < 0 && menu.kind === 'effort' && ['max', 'ultra'].includes(effort)) {
          target = menu.rows.findIndex(row => /^More reasoning(?:…|\.\.\.)/.test(row.label));
        }
        if (target < 0 && menu.kind === 'model') {
          // Target is not in the current viewport. Page Down to reveal more
          // rows (this also moves the highlight). When the frame stops
          // changing the list has reached its end without a match, or the
          // scroll bound is hit — either way fail closed with invalid.
          const frame = JSON.stringify(menu.rows);
          if (frame === modelFrame || modelScrolls >= MODEL_MENU_SCROLL_MAX) {
            return { status: 'invalid', choices: Object.keys(LABELS).filter(level => menu.rows.some(row => LABELS[level]!.test(row.label))) };
          }
          modelFrame = frame;
          modelScrolls++;
          io.key('Down');
          await delay(80);
          continue;
        }
        if (target < 0) return { status: 'invalid', choices: Object.keys(LABELS).filter(level => menu.rows.some(row => LABELS[level]!.test(row.label))) };
        const action = JSON.stringify([menu.kind, menu.rows]);
        // Wait for the cursor/page to advance before sending another key. A
        // fixed sleep + a fixed number of Downs can act on a stale viewport.
        if (action !== previousAction) {
          previousAction = action;
          if (current !== target) io.key(current < target ? 'Down' : 'Up');
          else if (menu.kind === 'model' || /^More reasoning/.test(menu.rows[target]!.label)) io.key('Enter');
          else {
            if (!/enter default\s*·\s*s session\s*·\s*esc back/i.test(screen)) {
              return { status: 'unavailable', reason: 'cli_menu_unavailable' };
            }
            io.key('s'); // Enter changes defaults; this operation is session scoped.
            selected = true;
          }
        }
      }
      await delay(80);
    }
    return { status: 'error' };
  } catch {
    return { status: 'error' };
  } finally {
    // Dismiss only recognizable menus that we opened, never Ctrl+C a task or
    // send Escape into an unrelated prompt/replacement backend.
    if (opened && !confirmed && io.isCurrent()) {
      let dismissed: string | undefined;
      let escapes = 0;
      for (let n = 0; n < 15; n++) {
        const screen = await io.screen().catch(() => '');
        const menu = parseCodexEffortMenu(screen);
        if (!io.isCurrent() || !menu) break;
        const signature = JSON.stringify(menu);
        if (signature !== dismissed) {
          if (escapes === 3) break;
          try { io.key('Escape'); } catch { break; }
          dismissed = signature;
          escapes++;
        }
        await delay(80);
      }
    }
  }
}
