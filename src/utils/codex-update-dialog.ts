import { stripAnsiForLog } from './crash-log.js';

export type CodexUpdateDialogAction = 'pass' | 'dismiss' | 'suppress';

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
