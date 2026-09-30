import type { ObserveBackend, SpawnOpts } from './types.js';
import {
  callOrca,
  callOrcaSync,
  matchesOrcaTerminalIdentity,
  type OrcaExpectedTerminalIdentity,
  type OrcaTerminalIdentity,
} from '../../services/orca-cli.js';
import { logger } from '../../utils/logger.js';
import { stripAnsiForLog } from '../../utils/crash-log.js';
import { LivenessGate, ADOPT_LIVENESS_MAX_FAILURES } from './liveness-gate.js';
import { queryOrcaRelayPtyMetadata } from '../../services/orca-relay.js';

const POLL_MS = 700;
const SIZE_POLL_MS = 5_000;
const WEB_INPUT_BATCH_MS = 25;
const WEB_HISTORY_MAX_CHARS = 1_000_000;
const CLEAR_HOME = '\x1b[H\x1b[2J';
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

export function renderOrcaTranscriptHistory(
  events: readonly { kind: string; text: string }[],
): string {
  return events.flatMap((event) => {
    const label = event.kind === 'user'
      ? 'User'
      : event.kind === 'assistant_final' ? 'Assistant' : undefined;
    const text = stripAnsiForLog(event.text)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    if (event.kind === 'user' && /^(?:# AGENTS\.md instructions\b|<(?:environment_context|recommended_plugins|permissions)\b)/.test(text)) {
      return [];
    }
    return label && text ? [`── ${label} ──\r\n${text.replace(/\n/g, '\r\n')}`] : [];
  }).join('\r\n\r\n');
}

interface TerminalReadResult {
  terminal?: {
    status?: 'running' | 'exited' | 'unknown';
    tail?: string[];
    source?: 'screen' | 'screen-unavailable' | 'stream';
    draft?: string | null;
  };
}
interface TerminalSendResult {
  send?: { accepted?: boolean };
}

interface TerminalShowResult {
  terminal?: OrcaTerminalIdentity;
}

/** Observe and drive an Orca terminal through its public CLI. The CLI already
 * routes local and SSH-host terminals through the running Orca instance, so
 * Botmux does not need a second pairing configuration. */
export class OrcaBackend implements ObserveBackend {
  readonly supportsRawCommandPasteLine = true;
  private readonly dataCbs: Array<(data: string) => void> = [];
  private readonly exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
  private readonly liveness = new LivenessGate(ADOPT_LIVENESS_MAX_FAILURES);
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private sizeTimer: ReturnType<typeof setInterval> | null = null;
  private webInputTimer: ReturnType<typeof setTimeout> | null = null;
  private pollInFlight = false;
  private sizeInFlight = false;
  private livenessConfirmInFlight = false;
  private stopped = false;
  private lastScreen = '';
  private webHistory = '';
  private pendingText = '';
  private pendingPaste = false;
  private hasUnsubmittedDraft = false;
  private webInputBuffer = '';
  private webWriteChain: Promise<void> = Promise.resolve();
  private cols = 120;
  private rows = 50;
  private readonly sizeCbs: Array<(size: { cols: number; rows: number }) => void> = [];

  cliPid?: number;
  cliCwd?: string;

  constructor(
    private readonly identity: OrcaExpectedTerminalIdentity,
    private readonly bracketedPaste = false,
    private sizeVerified = false,
  ) {}

  setWebHistory(history: string): void {
    this.webHistory = history.slice(-WEB_HISTORY_MAX_CHARS);
  }

  appendWebHistory(history: string): void {
    if (!history) return;
    this.setWebHistory(this.webHistory ? `${this.webHistory}\r\n\r\n${history}` : history);
  }

  spawn(_bin: string, _args: string[], opts: SpawnOpts): void {
    this.cols = opts.cols;
    this.rows = opts.rows;
    void this.refreshSize();
    void this.poll();
    this.pollTimer = setInterval(() => { void this.poll(); }, POLL_MS);
    this.sizeTimer = setInterval(() => { void this.refreshSize(); }, SIZE_POLL_MS);
  }

  private relayPtyId(): string | undefined {
    const separator = this.identity.ptyId?.indexOf('@@') ?? -1;
    return separator >= 0 ? this.identity.ptyId!.slice(separator + 2) || undefined : undefined;
  }

  private async refreshSize(): Promise<void> {
    const relayPtyId = this.relayPtyId();
    if (!relayPtyId || this.stopped || this.sizeInFlight) return;
    this.sizeInFlight = true;
    try {
      const current = (await queryOrcaRelayPtyMetadata([relayPtyId])).get(relayPtyId);
      if (!current?.cols || !current.rows) return;
      const changed = current.cols !== this.cols || current.rows !== this.rows;
      const newlyVerified = !this.sizeVerified;
      this.sizeVerified = true;
      this.cols = current.cols;
      this.rows = current.rows;
      if (changed || newlyVerified) {
        for (const cb of this.sizeCbs) cb({ cols: this.cols, rows: this.rows });
      }
    } finally {
      this.sizeInFlight = false;
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const result = await callOrca<TerminalReadResult>([
        'terminal', 'read', '--terminal', this.identity.terminalHandle, '--screen', '--limit', '1000',
      ]);
      if (this.stopped) return;
      if (!result.ok) {
        if (result.kind === 'missing' && this.liveness.record(false)) void this.confirmMissing();
        return;
      }
      this.liveness.reset();
      const terminal = result.value.terminal;
      if (!terminal || terminal.status === 'exited') {
        this.handleExit();
        return;
      }
      const lines = terminal.tail ?? [];
      const draft = typeof terminal.draft === 'string' ? terminal.draft : '';
      this.hasUnsubmittedDraft = draft.length > 0;
      const screen = terminal.source === 'screen'
        ? [...lines, ...(draft ? [`› ${stripAnsiForLog(draft).replace(/[\r\n]/g, ' ')}`] : [])].join('\r\n')
        : '[Orca current screen is unavailable]';
      if (screen === this.lastScreen) return;
      this.lastScreen = screen;
      const frame = CLEAR_HOME + screen;
      for (const cb of this.dataCbs) cb(frame);
    } catch (error) {
      logger.debug(`[orca-adopt] screen poll failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.pollInFlight = false;
    }
  }

  private async confirmMissing(): Promise<void> {
    if (this.stopped || this.livenessConfirmInFlight) return;
    this.livenessConfirmInFlight = true;
    try {
      const result = await callOrca<TerminalShowResult>([
        'terminal', 'show', '--terminal', this.identity.terminalHandle,
      ]);
      if (!result.ok) {
        if (result.kind === 'missing') this.handleExit();
        return;
      }
      const terminal = result.value.terminal;
      if (!terminal || !matchesOrcaTerminalIdentity(terminal, this.identity)) {
        this.handleExit();
        return;
      }
      this.liveness.reset();
    } finally {
      this.livenessConfirmInFlight = false;
    }
  }

  private identityMatchesSync(): boolean {
    const result = callOrcaSync<TerminalShowResult>([
      'terminal', 'show', '--terminal', this.identity.terminalHandle,
    ]);
    if (!result.ok) return false;
    const matches = !!result.value.terminal
      && matchesOrcaTerminalIdentity(result.value.terminal, this.identity);
    if (!matches) this.handleExit();
    return matches;
  }

  inspectDraftSync(): 'clean' | 'draft' | 'unknown' {
    if (!this.identityMatchesSync()) return 'unknown';
    const result = callOrcaSync<TerminalReadResult>([
      'terminal', 'read', '--terminal', this.identity.terminalHandle, '--screen', '--limit', '1',
    ]);
    if (!result.ok || result.value.terminal?.status !== 'running') return 'unknown';
    this.hasUnsubmittedDraft = typeof result.value.terminal.draft === 'string'
      && result.value.terminal.draft.length > 0;
    return this.hasUnsubmittedDraft ? 'draft' : 'clean';
  }

  write(data: string): boolean {
    if (this.stopped) return false;
    if (data === '\x03') {
      this.flushWebInput();
      this.queueWebRequest(['terminal', 'send', '--terminal', this.identity.terminalHandle, '--interrupt']);
      return true;
    }
    if (data.includes('\x1b')) {
      this.flushWebInput();
      this.queueWebRequest(['terminal', 'send', '--terminal', this.identity.terminalHandle, '--text', data]);
      return true;
    }
    this.webInputBuffer += data;
    if (data.endsWith('\r') || this.webInputBuffer.length >= 1024) this.flushWebInput();
    else this.armWebInputFlush();
    return true;
  }

  private armWebInputFlush(): void {
    if (this.webInputTimer) clearTimeout(this.webInputTimer);
    this.webInputTimer = setTimeout(() => {
      this.webInputTimer = null;
      this.flushWebInput();
    }, WEB_INPUT_BATCH_MS);
  }

  private flushWebInput(): void {
    if (this.webInputTimer) clearTimeout(this.webInputTimer);
    this.webInputTimer = null;
    if (!this.webInputBuffer) return;
    const enter = this.webInputBuffer.endsWith('\r');
    const text = enter ? this.webInputBuffer.slice(0, -1) : this.webInputBuffer;
    this.webInputBuffer = '';
    const args = ['terminal', 'send', '--terminal', this.identity.terminalHandle];
    if (text) args.push('--text', text);
    if (enter) args.push('--enter');
    this.queueWebRequest(args);
  }

  private queueWebRequest(args: string[]): void {
    this.webWriteChain = this.webWriteChain.then(async () => {
      if (this.stopped) return;
      const identity = await callOrca<TerminalShowResult>([
        'terminal', 'show', '--terminal', this.identity.terminalHandle,
      ]);
      if (!identity.ok) {
        logger.warn('[orca-adopt] Web Terminal input refused: target identity could not be verified');
        return;
      }
      if (!identity.value.terminal
        || !matchesOrcaTerminalIdentity(identity.value.terminal, this.identity)) {
        logger.warn('[orca-adopt] Web Terminal input refused: target identity changed');
        this.handleExit();
        return;
      }
      const result = await callOrca<TerminalSendResult>(args, 15_000);
      if (!result.ok || result.value.send?.accepted !== true) {
        logger.warn(`[orca-adopt] Web Terminal input rejected: ${result.ok ? 'not accepted' : result.message}`);
      }
    }).catch(error => logger.warn(`[orca-adopt] Web Terminal input failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Stage adapter text until Enter so one Orca request owns text + submit. */
  sendText(text: string): boolean {
    if (this.hasUnsubmittedDraft) throw new Error('Orca terminal has an unsubmitted local draft');
    this.pendingText += text;
    return true;
  }

  pasteText(text: string): boolean {
    if (this.hasUnsubmittedDraft) throw new Error('Orca terminal has an unsubmitted local draft');
    this.pendingText += text;
    this.pendingPaste = true;
    return true;
  }

  sendSpecialKeys(...keys: string[]): boolean {
    for (const key of keys) {
      if (key === 'Enter') {
        const text = this.pendingText;
        const bracketedPaste = this.pendingPaste;
        this.pendingText = '';
        this.pendingPaste = false;
        this.submit(text, true, bracketedPaste && this.bracketedPaste);
      } else if (key === 'C-c') {
        this.interrupt();
      } else {
        return false;
      }
    }
    return true;
  }

  private submit(text: string, enter: boolean, bracketedPaste = false): void {
    if (!this.identityMatchesSync()) throw new Error('Orca terminal identity could not be verified');
    const args = ['terminal', 'send', '--terminal', this.identity.terminalHandle];
    if (text) {
      args.push('--text', bracketedPaste ? `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}` : text);
    }
    if (enter) args.push('--enter');
    const result = callOrcaSync<TerminalSendResult>(args, 15_000);
    if (!result.ok) throw new Error(`Orca terminal send was not confirmed: ${result.message}`);
    if (result.value.send?.accepted !== true) throw new Error('Orca terminal rejected input');
    this.hasUnsubmittedDraft = false;
  }

  private interrupt(): void {
    if (!this.identityMatchesSync()) throw new Error('Orca terminal identity could not be verified');
    const result = callOrcaSync<TerminalSendResult>([
      'terminal', 'send', '--terminal', this.identity.terminalHandle, '--interrupt',
    ], 15_000);
    if (!result.ok) throw new Error(`Orca terminal interrupt was not confirmed: ${result.message}`);
    if (result.value.send?.accepted !== true) throw new Error('Orca terminal rejected interrupt');
  }

  resize(_cols: number, _rows: number): void { /* observing must not resize Orca */ }
  onData(cb: (data: string) => void): void { this.dataCbs.push(cb); }
  onExit(cb: (code: number | null, signal: string | null) => void): void { this.exitCbs.push(cb); }
  getChildPid(): number | null { return this.cliPid ?? null; }
  captureCurrentScreen(): string { return this.lastScreen ? CLEAR_HOME + this.lastScreen : ''; }
  captureWebHistory(): string {
    if (!this.webHistory || !this.lastScreen) return this.webHistory || this.captureCurrentScreen();
    const screenLines = this.lastScreen.split('\r\n').length;
    const bottomPadding = '\r\n'.repeat(Math.max(0, this.rows - screenLines));
    return `${this.webHistory}\r\n${this.lastScreen}${bottomPadding}`;
  }
  captureViewport(): string { return this.captureCurrentScreen(); }
  getPaneSize(): { cols: number; rows: number } | null { return { cols: this.cols, rows: this.rows }; }
  hasAuthoritativePaneSize(): boolean { return this.sizeVerified; }
  onPaneSizeChange(cb: (size: { cols: number; rows: number }) => void): void { this.sizeCbs.push(cb); }
  isPaneAlive(): boolean { return !this.stopped; }
  kill(): void { this.stop(); }
  destroySession(): void { this.stop(); }

  private stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.sizeTimer) clearInterval(this.sizeTimer);
    if (this.webInputTimer) clearTimeout(this.webInputTimer);
    this.pollTimer = null;
    this.sizeTimer = null;
    this.webInputTimer = null;
    this.webInputBuffer = '';
    this.pendingText = '';
    this.pendingPaste = false;
  }

  private handleExit(): void {
    if (this.stopped) return;
    this.stop();
    for (const cb of this.exitCbs) cb(0, null);
  }
}
