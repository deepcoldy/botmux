import { stripAnsiForLog } from './crash-log.js';

export type CodexUpdateDialogAction = 'pass' | 'dismiss' | 'suppress';
export type CodexUpdateDialogKey = 'Up' | 'Down' | 'Enter';

/** Resolve a safe path from the currently selected row to a non-upgrade row.
 * Returning no keys is fail-closed: the caller waits for a rendered snapshot
 * instead of guessing where the selection cursor is. */
export function codexUpdateDialogSafeKeys(data: string): CodexUpdateDialogKey[] | undefined {
  const lines = stripAnsiForLog(data).replace(/\r/g, '\n').split('\n');
  const options = lines.flatMap(line => {
    const match = line.match(/^\s*([›>])?\s*(\d+)\.\s*(.+?)\s*$/);
    if (!match) return [];
    return [{ selected: !!match[1], number: Number(match[2]), label: match[3]! }];
  });
  const selected = options.find(option => option.selected);
  const safe = selected && /^(?:skip|remind me later)\b/i.test(selected.label)
    ? selected
    : options.find(option => /^(?:skip|remind me later)\b/i.test(option.label));
  if (!selected || !safe) return undefined;
  if (selected.number === safe.number) return ['Enter'];
  const direction: CodexUpdateDialogKey = selected.number < safe.number ? 'Down' : 'Up';
  return [...Array(Math.abs(safe.number - selected.number)).fill(direction), 'Enter'];
}

/**
 * Detect Codex's startup update picker across PTY chunks.
 *
 * Most launches disable the picker with `check_for_update_on_startup=false`.
 * Aiden is the exception: its `aiden x codex` launcher rejects every Codex
 * `-c` / `--config` override, so the worker needs a narrow compatibility
 * fallback. The picker has used both "Skip" and "Remind me later" for its
 * non-upgrade choice across Codex releases.
 */
export class CodexUpdateDialogGuard {
  private tail = '';
  private dismissed = false;

  inspect(data: string): CodexUpdateDialogAction {
    const plain = stripAnsiForLog(data).replace(/\s+/g, '').toLowerCase();
    this.tail = (this.tail + plain).slice(-4_096);

    const hasUpdateChoice = this.tail.includes('updatenow');
    const hasDeferredChoice = this.tail.includes('skip') || this.tail.includes('remindmelater');
    if (!hasUpdateChoice || !hasDeferredChoice) return 'pass';

    // Start fresh so a later real composer redraw cannot inherit menu words.
    this.tail = '';
    if (this.dismissed) return 'suppress';
    this.dismissed = true;
    return 'dismiss';
  }

  reset(): void {
    this.tail = '';
    this.dismissed = false;
  }
}

/** A resumed Aiden TUI can omit the banner needed by the startup gate. Ask for
 * one redraw only at its empty composer; this is not permission to send input. */
export function aidenCodexResumeNeedsRedraw(screen: string): boolean {
  if (/(?:model|directory):\s*loading\b|Resuming session|esc to interrupt|Queued for capacity/i.test(screen)) return false;
  const lines = screen.trimEnd().split(/\r?\n/).filter(line => line.trim());
  return /^\s*›\s*(?:Ask Codex to do anything)?\s*$/.test(lines.at(-2) ?? '')
    && /^\s*\S+ (?:low|medium|high|xhigh|max|ultra) · (?:\/|~)\S*(?: · [^\r\n]+)?\s*$/.test(lines.at(-1) ?? '');
}
