import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { CodexReasoningEffort } from './codex-reasoning-effort.js';
import { isNativeReasoningEffort } from './native-reasoning-observation.js';
import { parseCodexEffortMenu } from '../utils/codex-effort-menu.js';
import type { Session } from '../types.js';

export type TerminalEffortCli = 'claude-code' | 'codex' | 'traex' | 'grok';
export interface TerminalEffortBinding {
  cliId: string; nativeSessionId: string; cliSpawnGeneration: number;
}
export interface TerminalEffortChoice {
  nonce: string;
  cliId: TerminalEffortCli;
  nativeSessionId: string;
  cliSpawnGeneration: number;
  requestedEffort: CodexReasoningEffort;
  requestedAtMs: number;
  confirmedAtMs: number;
  model?: string;
  source: 'terminal-input' | 'claude-command';
  enableEpoch: number;
  expectedPreference: string;
}
export const TERMINAL_EFFORT_CHOICE_WINDOW_MS = 60_000;

function supported(id: string): id is TerminalEffortCli {
  return ['claude-code', 'codex', 'traex', 'grok'].includes(id);
}
function owner(binding: TerminalEffortBinding): string {
  return JSON.stringify([binding.cliId, binding.nativeSessionId, binding.cliSpawnGeneration]);
}
function effortLabel(label: string): CodexReasoningEffort | undefined {
  const match = /^(low|medium|high|xhigh|max|ultra|extra high|very high)\b/i.exec(label.trim());
  const value = match?.[1]?.toLowerCase().replace(/(?:extra|very) high/, 'xhigh');
  return isNativeReasoningEffort(value) ? value : undefined;
}
/** Require a live effort picker, its selection cursor and its native footer. */
function selectedMenuEffort(screen: string): CodexReasoningEffort | undefined {
  const codex = parseCodexEffortMenu(screen);
  if (codex?.kind === 'effort' || codex?.kind === 'advanced') {
    return effortLabel(codex.rows.find(row => row.selected)?.label ?? '');
  }
  const lines = screen.split(/\r?\n/);
  let heading = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*(?:Select|Choose|Change)\s+(?:reasoning\s+)?effort(?:\s+level)?\s*[:?]?\s*$/i.test(lines[i]!)) { heading = i; break; }
  }
  if (heading < 0 || !lines.slice(heading + 1).some(line => /enter.*(?:select|confirm|apply).*esc/i.test(line))) return;
  const selected = lines.slice(heading + 1).flatMap(line => {
    const match = /^\s*[❯›>●◉]\s*(?:\d+[.)]\s*)?(.+)$/.exec(line);
    return match ? [effortLabel(match[1]!)] : [];
  }).filter((value): value is CodexReasoningEffort => value !== undefined);
  return selected.length === 1 ? selected[0] : undefined;
}

interface Reading { binding: TerminalEffortBinding; effort: CodexReasoningEffort | null; model?: string; atMs: number }
export function terminalEffortPreferenceKey(row: Pick<Session, 'reasoningEffort' | 'cliLaunchSnapshot' | 'topicReasoningEffort' | 'modelPin'> & { model?: string }): string {
  const snapshot = row.cliLaunchSnapshot ? { ...row.cliLaunchSnapshot, reasoningEffort: undefined } : null;
  return JSON.stringify([row.reasoningEffort ?? null, row.cliLaunchSnapshot?.reasoningEffort ?? null,
    row.topicReasoningEffort ?? null, row.modelPin ?? null,
    createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), row.model ?? null]);
}
interface Pending { owner: string; atMs: number; expected?: CodexReasoningEffort; model?: string; before: CodexReasoningEffort | null; enableEpoch: number; expectedPreference: string }

/** An input is intent only. A newer native selection must confirm the exact level.
 * Mouse/paste/cursor-edit ambiguity never fabricates a command or selection. */
export class TerminalEffortChoiceTracker {
  private lines = new WeakMap<object, string>();
  private last: Reading | undefined;
  private pending: Pending | undefined;
  private sequence = 0;
  reset(): void { this.lines = new WeakMap(); this.last = undefined; this.pending = undefined; }
  model(binding: TerminalEffortBinding): string | undefined {
    return this.last && owner(this.last.binding) === owner(binding) ? this.last.model : undefined;
  }

  input(client: object, data: string, binding: TerminalEffortBinding, options: {
    enabled: boolean; ready: boolean; screen?: string; now?: number; enableEpoch?: number; readPreference?: () => string | undefined;
  }): void {
    const now = options.now ?? Date.now();
    if (!options.enabled || !options.ready || !supported(binding.cliId) || !binding.nativeSessionId
      || this.last && owner(this.last.binding) !== owner(binding)) {
      this.lines.delete(client); this.pending = undefined; return;
    }
    let line = this.lines.get(client) ?? '';
    // Only single-line composer input is interpreted. Arbitrary terminal
    // protocols and bracketed/multiline paste do not supply user provenance.
    if (data.includes('\x1b[200~') || data.includes('\x1b[<') || /\r.*\r|\n.*\n/s.test(data)) {
      this.lines.delete(client); this.pending = undefined; return;
    }
    for (let i = 0; i < data.length; i++) {
      const char = data[i]!;
      if (char === '\x1b') {
        const arrow = /^\x1b\[[AB]/.exec(data.slice(i));
        if (arrow && !line && this.pending?.expected === undefined) { i += arrow[0].length - 1; continue; }
        this.pending = undefined; line = ''; break;
      }
      if (char === '\x03' || char === '\x15') { line = ''; this.pending = undefined; continue; }
      if (char === '\x7f' || char === '\b') { line = line.slice(0, -1); continue; }
      if (char === '\r' || char === '\n') {
        const explicit = /^\/(?:effort|reasoning|reasoning-effort)\s+(low|medium|high|xhigh|max|ultra)\s*$/i.exec(line);
        const menu = /^\/(?:effort|reasoning|reasoning-effort|model)\s*$/i.test(line);
        const selected = !line && this.pending && options.screen ? selectedMenuEffort(options.screen) : undefined;
        if (explicit || menu || selected) {
          if (this.last && owner(this.last.binding) === owner(binding)) {
            const expectedPreference = options.readPreference?.();
            if (!expectedPreference) { this.pending = undefined; line = ''; continue; }
            this.pending = { owner: owner(binding), atMs: now,
              expected: explicit ? explicit[1]!.toLowerCase() as CodexReasoningEffort : selected,
              before: this.last.effort, model: this.last.model, enableEpoch: options.enableEpoch ?? 0, expectedPreference };
          }
        } else if (!(line === '' && this.pending?.expected === undefined && parseCodexEffortMenu(options.screen ?? '')?.kind === 'model')) this.pending = undefined;
        line = '';
      } else if (char >= ' ' && char <= '~' && line.length < 160) line += char;
      else { line = ''; this.pending = undefined; }
    }
    this.lines.set(client, line);
  }

  observe(reading: Reading, enabled: boolean, evidence: 'native-settings' | 'native-footer' | 'native-summary' | 'statusline', enableEpoch = 0): TerminalEffortChoice | undefined {
    const now = Date.now();
    const previous = this.last;
    this.last = reading;
    const pending = this.pending;
    if (!enabled || !pending || pending.enableEpoch !== enableEpoch || pending.owner !== owner(reading.binding)
      || reading.atMs < pending.atMs || reading.atMs > now
      || now - pending.atMs > TERMINAL_EFFORT_CHOICE_WINDOW_MS) {
      if (!enabled || pending && (pending.enableEpoch !== enableEpoch || pending.owner !== owner(reading.binding) || now - pending.atMs > TERMINAL_EFFORT_CHOICE_WINDOW_MS)) this.pending = undefined;
      return;
    }
    if (!pending.expected || reading.effort !== pending.expected || !supported(reading.binding.cliId)) return;
    if (pending.model && reading.model && pending.model.toLowerCase() !== reading.model.toLowerCase()) {
      this.pending = undefined; return;
    }
    // A viewport/file refresh of an unchanged launch default is not an ACK.
    // Native settings has an explicit ACK; other readers must observe a change.
    if (evidence !== 'native-settings' && (pending.before === reading.effort || previous?.effort === reading.effort && previous.atMs >= pending.atMs)) return;
    this.pending = undefined;
    return { nonce: `${owner(reading.binding)}:${++this.sequence}`, ...reading.binding,
      cliId: reading.binding.cliId, requestedEffort: pending.expected, requestedAtMs: pending.atMs,
      confirmedAtMs: reading.atMs, ...(reading.model ? { model: reading.model } : {}), source: 'terminal-input',
      enableEpoch: pending.enableEpoch, expectedPreference: pending.expectedPreference };
  }
}

/** Claude records native local commands separately from ordinary user text.
 * Read only a bounded tail; the caller supplies the exact native-session path. */
export function readClaudeEffortCommandReceipt(path: string, nativeSessionId: string, notBefore: number, now = Date.now()): {
  effort: CodexReasoningEffort; atMs: number; nonce: string;
} | undefined {
  let fd: number | undefined;
  try {
    const stat = statSync(path);
    const offset = Math.max(0, stat.size - 256 * 1024);
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(Math.min(stat.size, 256 * 1024));
    const bytes = readSync(fd, buffer, 0, buffer.length, offset);
    const lines = buffer.subarray(0, bytes).toString('utf8').split('\n');
    if (offset) lines.shift();
    let command: { effort: CodexReasoningEffort; atMs: number; nonce: string } | undefined;
    let result: typeof command;
    for (const line of lines) {
      let record: any;
      try { record = JSON.parse(line); } catch { continue; }
      const atMs = Date.parse(record.timestamp);
      if (record.type !== 'user' || record.sessionId !== nativeSessionId || !Number.isFinite(atMs)
        || atMs < notBefore || atMs > now || typeof record.message?.content !== 'string') continue;
      const content = record.message.content;
      const requested = /^<command-name>\/effort<\/command-name>\s*<command-message>effort<\/command-message>\s*<command-args>(low|medium|high|xhigh|max|ultra)<\/command-args>\s*$/.exec(content);
      if (requested) {
        command = { effort: requested[1] as CodexReasoningEffort, atMs, nonce: String(record.uuid ?? `${atMs}:${requested[1]}`) };
        continue;
      }
      const applied = /^<local-command-stdout>Set effort level to (low|medium|high|xhigh|max|ultra)\b[\s\S]*<\/local-command-stdout>\s*$/.exec(content);
      if (command && applied && command.effort === applied[1] && atMs >= command.atMs
        && atMs - command.atMs <= TERMINAL_EFFORT_CHOICE_WINDOW_MS) result = command;
      else if (!/^<local-command-(?:caveat|stdout|stderr)>/.test(content)) command = undefined;
    }
    return result;
  } catch { return; }
  finally { if (fd !== undefined) closeSync(fd); }
}
