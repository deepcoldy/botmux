/**
 * A local copy of an hc terminal's screen, fed with its attach stream, so the
 * synchronous capture methods of SessionBackend answer in the exact formats
 * TmuxPipeBackend produces without a round trip to the core.
 */

import xtermHeadless from '@xterm/headless';
import type { Terminal as HeadlessTerminal, ITerminalAddon } from '@xterm/headless';
import * as unicode11 from '@xterm/addon-unicode11';
import { composeSeedBody, paneInputModeSeed, type PaneInputModes } from '../tmux-pipe-backend.js';
import { plainRows, serializeRows } from './ansi-serialize.js';

const { Terminal } = xtermHeadless;

type Unicode11Module = typeof import('@xterm/addon-unicode11');
const { Unicode11Addon } = ((unicode11 as Partial<Unicode11Module>).Unicode11Addon
  ? unicode11
  : (unicode11 as unknown as { default: Unicode11Module }).default);

/**
 * Every live session holds one mirror, so its depth is a memory budget: about
 * 10 MB at 160 columns under Bun (xterm keeps ~3 KB per line there, plus
 * ~2.5 MB per terminal), where tmux's 50 000-line history-limit would cost
 * ~140 MB. hc itself keeps only history_mb = 5 (~3 600 lines at 160 columns),
 * so an attach paint still fills it; the web terminal grows its own
 * scrollback from live output past this seed.
 */
export const HC_MIRROR_SCROLLBACK_LINES = 3_000;

const ALT_SCREEN_PREFIX = '\x1b[?1049h\x1b[H\x1b[2J';

export interface ScreenMirrorOptions {
  cols: number;
  rows: number;
  scrollback?: number;
}

/** The parts of xterm's core the public API does not expose. */
interface XtermCore {
  /** Parses `data` before returning; `Terminal.write` only queues it. */
  writeSync(data: string | Uint8Array): void;
  coreMouseService: { activeEncoding: string };
  coreService: { isCursorHidden: boolean };
}

export class ScreenMirror {
  private term: HeadlessTerminal;
  private core: XtermCore;
  private readonly scrollback: number;

  constructor(opts: ScreenMirrorOptions) {
    this.scrollback = opts.scrollback ?? HC_MIRROR_SCROLLBACK_LINES;
    [this.term, this.core] = this.create(opts.cols, opts.rows);
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  get applicationCursorKeys(): boolean {
    return this.term.modes.applicationCursorKeysMode;
  }

  get applicationKeypad(): boolean {
    return this.term.modes.applicationKeypadMode;
  }

  get bracketedPaste(): boolean {
    return this.term.modes.bracketedPasteMode;
  }

  get altScreen(): boolean {
    return this.term.buffer.active.type === 'alternate';
  }

  /** Live program output. Every capture taken after this returns reflects it. */
  write(data: string | Uint8Array): void {
    if (data.length > 0) this.core.writeSync(data);
  }

  /**
   * Bytes of an hc full-screen paint. Its clear replaces a screen this mirror
   * already holds, so it must not push that screen into scrollback the way a
   * program's clear does. A paint that replays history (the attach paint)
   * belongs on a fresh or freshly `reset` mirror.
   */
  writePaint(data: string | Uint8Array): void {
    this.term.options.scrollOnEraseInDisplay = false;
    try {
      this.write(data);
    } finally {
      this.term.options.scrollOnEraseInDisplay = true;
    }
  }

  /** Drops the screen, scrollback and modes, keeping the size. */
  reset(): void {
    const { cols, rows } = this.term;
    this.term.dispose();
    [this.term, this.core] = this.create(cols, rows);
  }

  resize(cols: number, rows: number): void {
    if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows);
  }

  dispose(): void {
    this.term.dispose();
  }

  /** TmuxPipeBackend.getPaneSize. */
  size(): { cols: number; rows: number } {
    return { cols: this.term.cols, rows: this.term.rows };
  }

  /** No character anywhere, in scrollback or on either screen. */
  isBlank(): boolean {
    for (const buffer of new Set([this.term.buffer.normal, this.term.buffer.active])) {
      for (let y = 0; y < buffer.length; y++) {
        if (buffer.getLine(y)?.translateToString(true).trim()) return false;
      }
    }
    return true;
  }

  /** TmuxPipeBackend.captureViewport: `capture-pane -e -p` of the visible rows, CRLF line ends. */
  captureViewport(): string {
    const buffer = this.term.buffer.active;
    return this.altPrefix() + serializeRows(buffer, buffer.baseY, buffer.baseY + this.term.rows);
  }

  /**
   * TmuxPipeBackend.captureCurrentScreen: `capture-pane -e -p -S - -E -` then
   * the cursor. On the alternate screen tmux still returns the main screen's
   * history ahead of the alternate rows.
   */
  captureCurrentScreen(): string {
    const active = this.term.buffer.active;
    const rows = this.term.rows;
    let body: string;
    if (active.type === 'alternate') {
      const normal = this.term.buffer.normal;
      body = serializeRows(normal, 0, normal.baseY) + serializeRows(active, 0, rows);
    } else {
      body = serializeRows(active, 0, active.baseY + rows);
    }
    return this.altPrefix() + composeSeedBody(body, { x: active.cursorX, y: active.cursorY });
  }

  /** TmuxPipeBackend.captureViewportAsync: plain `capture-pane -p`, every row ending in LF. */
  viewportText(): string {
    const buffer = this.term.buffer.active;
    return plainRows(buffer, buffer.baseY, buffer.baseY + this.term.rows);
  }

  /** TmuxPipeBackend.captureInputState. */
  captureInputState(): { viewport: string; cursor: { x: number; y: number } } {
    const buffer = this.term.buffer.active;
    return { viewport: this.viewportText(), cursor: { x: buffer.cursorX, y: buffer.cursorY } };
  }

  /** The flags tmux reports through PANE_MODE_FLAGS_FORMAT. */
  inputModes(): PaneInputModes {
    const modes = this.term.modes;
    return {
      mouseStandard: modes.mouseTrackingMode === 'vt200',
      mouseButton: modes.mouseTrackingMode === 'drag',
      mouseAll: modes.mouseTrackingMode === 'any',
      mouseSgr: this.core.coreMouseService.activeEncoding === 'SGR',
      appCursorKeys: modes.applicationCursorKeysMode,
      appKeypad: modes.applicationKeypadMode,
      cursorVisible: !this.core.coreService.isCursorHidden,
    };
  }

  /** TmuxPipeBackend.capturePaneInputModes. */
  capturePaneInputModes(): string {
    return paneInputModeSeed(this.inputModes());
  }

  private altPrefix(): string {
    return this.term.buffer.active.type === 'alternate' ? ALT_SCREEN_PREFIX : '';
  }

  private create(cols: number, rows: number): [HeadlessTerminal, XtermCore] {
    const term = new Terminal({
      cols,
      rows,
      scrollback: this.scrollback,
      allowProposedApi: true,
      scrollOnEraseInDisplay: true,
      logLevel: 'error',
    });
    const core = (term as unknown as { _core?: Partial<XtermCore> })._core;
    if (
      typeof core?.writeSync !== 'function'
      || typeof core.coreMouseService?.activeEncoding !== 'string'
      || typeof core.coreService?.isCursorHidden !== 'boolean'
    ) {
      term.dispose();
      throw new Error('@xterm/headless no longer exposes writeSync / mouse encoding / cursor visibility on its core');
    }
    term.loadAddon(new Unicode11Addon() as unknown as ITerminalAddon);
    term.unicode.activeVersion = '11';
    return [term, core as XtermCore];
  }
}
