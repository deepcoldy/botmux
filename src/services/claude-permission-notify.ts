import { createHash } from 'node:crypto';
import { claudeActionPrompt } from './claude-action-prompt.js';
import type { PendingAsk } from '../core/ask-types.js';

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Deliberately conservative: multiline/wrapped/truncated commands keep the
 * terminal fallback. No whitespace folding inside shell strings. */
function commandHash(command: unknown): string | undefined {
  if (typeof command !== 'string' || /[\r\n…]/.test(command) || !command.trim()) return;
  return hash(command.trim());
}

export function claudePermissionCommandHash(payload: unknown): string | undefined {
  const p = payload as { hook_event_name?: string; tool_name?: string; tool_input?: { command?: unknown } } | null;
  if (p?.hook_event_name !== 'PermissionRequest' || p.tool_name !== 'Bash') return;
  return commandHash(p.tool_input?.command);
}

export interface PermissionScreen {
  dialogId?: string;
  message?: string;
  commandHash?: string;
}

/** Only digests leave the worker; command text stays in the terminal. */
export function claudePermissionScreen(screen: string): PermissionScreen | undefined {
  const message = claudeActionPrompt(screen);
  if (!message) return;
  const lines = screen.trimEnd().split('\n').slice(-35);
  let question = -1;
  let title = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^Do you want to [^?]{0,140}\?$/.test(lines[i].trim())) { question = i; break; }
  }
  for (let i = question - 1; i >= Math.max(0, question - 15); i--) {
    if (/^Bash command(?: ·.*)?$/.test(lines[i].trim())) { title = i; break; }
  }
  let command: string | undefined;
  let bodyStart = -1;
  let bodyEnd = -1;
  if (title >= 0) {
    for (let i = title + 1; i < question; i++) {
      if (!/^[╌─━]{5,}$/.test(lines[i].trim())) continue;
      if (bodyStart < 0) bodyStart = i;
      else if (bodyEnd < 0) bodyEnd = i;
      else { bodyEnd = -1; break; }
    }
    if (bodyEnd === bodyStart + 2) {
      command = lines[bodyStart + 1].replace(/^\s*[│┃]\s?/, '').trim();
    }
  }
  // Include the dialog body to distinguish successive commands with identical
  // projected title/options. Never include conversation above this dialog.
  const start = title >= 0 ? title : Math.max(0, question - 15);
  const footer = lines.findIndex((line, i) => i > question && /^Esc to cancel\b/.test(line.trim()));
  return { message, dialogId: hash(lines.slice(start, footer + 1).join('\n')), commandHash: commandHash(command) };
}

interface PermissionScope {
  larkAppId: string;
  sessionId: string;
  chatId: string;
  rootMessageId: string | null;
}

/** A suppressed observation never consumes delivery dedup. Each static-screen
 * observation rechecks the broker so failed/finished hooks recover fallback. */
export class ClaudePermissionNotifier {
  private current?: string;
  private delivered?: string;
  private inFlight = new Set<string>();

  async observe(screen: PermissionScreen, scope: PermissionScope, asks: readonly PendingAsk[],
    deliver: (message: string) => Promise<boolean>, now = Date.now()): Promise<void> {
    if (!screen.dialogId || !screen.message) {
      this.current = undefined;
      this.delivered = undefined;
      return;
    }
    if (this.current !== screen.dialogId) {
      this.current = screen.dialogId;
      this.delivered = undefined;
    }
    if (this.delivered === screen.dialogId || this.inFlight.has(screen.dialogId)) return;
    const covered = screen.commandHash && asks.some(ask =>
      ask.originKind === 'hook' && ask.permissionCommandHash === screen.commandHash
      && ask.larkAppId === scope.larkAppId && ask.sessionId === scope.sessionId
      && ask.chatId === scope.chatId && ask.rootMessageId === scope.rootMessageId
      && !ask.settled && ask.hookWaiting === true && ask.deadlineAt > now && !!ask.cardMessageId);
    if (covered) return;
    const id = screen.dialogId;
    this.inFlight.add(id);
    try {
      if (await deliver(screen.message) && this.current === id) this.delivered = id;
    } finally {
      this.inFlight.delete(id);
    }
  }
}
