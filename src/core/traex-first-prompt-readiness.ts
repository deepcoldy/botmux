/**
 * TraeX first-prompt readiness observation and native-viewport evidence store.
 *
 * Separates the 90s timeout-warning horizon from the stop-observing horizon,
 * stages sanitized native plain-text captures inside a throwaway
 * TerminalRenderer at the pane's real geometry (never mutating the worker's
 * long-lived renderer), and binds published readiness evidence strictly to the
 * live backend, generation, renderer, screen revision, PTY output generation,
 * Web-input generation, control-write/interrupt revisions, and pane geometry.
 */

import type { ITerminalAddon } from '@xterm/headless';
import * as unicode11 from '@xterm/addon-unicode11';
import { stripAnsiScreenText } from '../utils/idle-detector.js';
import { TerminalRenderer, readViewportText } from '../utils/terminal-renderer.js';

type Unicode11Module = typeof import('@xterm/addon-unicode11');
const { Unicode11Addon } = ((unicode11 as Partial<Unicode11Module>).Unicode11Addon
  ? unicode11
  : (unicode11 as unknown as { default: Unicode11Module }).default);

/** Active polling interval before the 90s timeout-warning horizon. */
export const TRAEX_FIRST_PROMPT_FAST_POLL_MS = 1_000;
/** Lower-frequency recovery polling interval at/after the 90s timeout-warning horizon. */
export const TRAEX_FIRST_PROMPT_SLOW_POLL_MS = 5_000;

/** Upper bounds on temporary TerminalRenderer allocation for native viewport staging. */
export const MAX_NATIVE_VIEWPORT_STAGING_COLS = 1_024;
export const MAX_NATIVE_VIEWPORT_STAGING_ROWS = 512;

/** C0/C1 control characters (excluding \t) that must never execute as live VT
 *  control sequences when staging plain-text viewport captures. */
// eslint-disable-next-line no-control-regex
const UNSAFE_PLAIN_VIEWPORT_CONTROLS_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const ZERO_WIDTH_RE = /^[\p{Mn}\p{Me}\p{Cf}ᅠ-ᇿ​-‏︀-️]+$/u;
const UNAMBIGUOUS_WIDE_CP_RE = /[ᄀ-ᅟ〈〉⺀-〾぀-㉇㉐-䶿一-꓆ꥠ-ꥼ가-힣豈-﫿︐-︙︰-﹫！-｠￠-￦\u{1b000}-\u{1b001}\u{1f200}-\u{1f251}\u{20000}-\u{3fffd}]/u;
const UNAMBIGUOUS_WIDE_EMOJI_RE = /\p{Emoji_Presentation}/u;
const XTERM_POTENTIALLY_WIDE_CP_RE = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Regional_Indicator}]/u;

export interface PaneDimensions {
  readonly cols: number;
  readonly rows: number;
}

export interface TraexWebInputSettleInput {
  readonly webInputGeneration: number;
  readonly webInputGenerationAtSpawn: number | undefined;
  readonly pendingWebInput: boolean;
  readonly nowMs: number;
  readonly lastWebInputAtMs: number;
  readonly screenRevision: number;
  readonly webInputScreenRevision: number;
  readonly settleMs: number;
}

export interface TraexWebInputSettleStatus {
  readonly settled: boolean;
  readonly remainingMs: number;
}

export interface TraexNativeViewportScope {
  readonly backend: object;
  readonly spawnGeneration: number;
  readonly lifetimeNonce: number | undefined;
  readonly renderer: object;
  readonly screenRevision: number;
  readonly outputGeneration: number;
  readonly webInputGeneration: number;
  readonly controlWriteRevision: number;
  readonly interruptGeneration: number;
  readonly gridRevision: number;
  readonly webResizedGrid: PaneDimensions | null;
  /** Exact pane dimensions staged inside the temporary renderer. */
  readonly paneSize: PaneDimensions | null;
  /** O(1) live pane size when supported synchronously by the backend (HcBackend);
   *  undefined for backends whose pane size requires an async query (TmuxPipeBackend). */
  readonly syncPaneSize: PaneDimensions | null | undefined;
}

export interface TraexNativeViewportEvidence {
  readonly scope: TraexNativeViewportScope;
  readonly formattedScreen: string;
  readonly plainScreen: string;
  /** True iff Web input was unchanged since spawn or had fully settled at capture. */
  readonly webInputSettled: boolean;
  readonly capturedAtMs: number;
}

export interface TraexNativeViewportReadContext {
  readonly closeRequested: boolean;
  readonly restartingWithoutReplacement: boolean;
  readonly pendingWebInput: boolean;
  readonly backend: object | null | undefined;
  readonly spawnGeneration: number;
  readonly lifetimeNonce: number | undefined;
  readonly renderer: object | null | undefined;
  readonly screenRevision: number;
  readonly outputGenerationCurrent: (snapshot: number) => boolean;
  readonly webInputGeneration: number;
  readonly controlWriteRevision: number;
  readonly interruptGeneration: number;
  readonly gridRevision: number;
  readonly webResizedGrid: PaneDimensions | null;
  readonly syncPaneSize: PaneDimensions | null | undefined;
}

export interface TraexNativeViewportOwner {
  readonly backend: object;
  readonly spawnGeneration: number;
  readonly lifetimeNonce: number | undefined;
  readonly renderer: object;
}

export type StagedNativeViewportResult =
  | {
    readonly ok: true;
    readonly formattedScreen: string;
    readonly plainScreen: string;
    readonly dimensions: PaneDimensions;
    readonly lineCount: number;
  }
  | {
    readonly ok: false;
    readonly reason: 'empty' | 'invalid-dimensions' | 'scrolled' | 'wrapped';
  };

interface XtermCoreWriteSync {
  writeSync(data: string): void;
}

export interface TimerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

const DEFAULT_TIMER_CLOCK: TimerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

/** Alert horizon != stop-observing horizon: keep fast 1s sampling before the
 *  90s warning deadline, then drop to low-frequency 5s observation afterward. */
export function nextTraexFirstPromptPollDelayMs(nowMs: number, alertDeadlineAtMs: number): number {
  return nowMs < alertDeadlineAtMs
    ? TRAEX_FIRST_PROMPT_FAST_POLL_MS
    : TRAEX_FIRST_PROMPT_SLOW_POLL_MS;
}

export function isValidPaneDimensions(size: PaneDimensions | null | undefined): size is PaneDimensions {
  if (!size) return false;
  return Number.isInteger(size.cols)
    && Number.isInteger(size.rows)
    && size.cols >= 1
    && size.cols <= MAX_NATIVE_VIEWPORT_STAGING_COLS
    && size.rows >= 1
    && size.rows <= MAX_NATIVE_VIEWPORT_STAGING_ROWS;
}

export function paneDimensionsEqual(
  a: PaneDimensions | null | undefined,
  b: PaneDimensions | null | undefined,
): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a.cols === b.cols && a.rows === b.rows;
}

/** Sanitize a plain-text viewport capture into CRLF lines with all stray ANSI
 *  and C0/C1 control codes stripped so nothing inside cell text can execute as
 *  live VT escapes inside the temporary renderer. Strips at most one trailing
 *  line ending so a full-height capture does not scroll row 0 off screen. */
export function normalizePlainViewportLines(rawViewport: string): string[] {
  const withoutSingleTrailing = rawViewport.replace(/\r?\n$/, '');
  return withoutSingleTrailing.split(/\r?\n/).map((line) =>
    stripAnsiScreenText(line).replace(UNSAFE_PLAIN_VIEWPORT_CONTROLS_RE, ''),
  );
}

/** Measure both (1) a strict lower bound on tmux/terminal grapheme-cluster
 *  columns (used to reject genuine ABA width shrinks without false positives
 *  across Unicode versions) and (2) an upper bound on @xterm/headless Unicode11
 *  columns (which does not combine ZWJ / skin-tone / flag clusters). */
function measureSanitizedLineWidths(line: string): { minGraphemeCols: number; xtermUpperCols: number } {
  let minGraphemeCols = 0;
  let xtermUpperCols = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(line)) {
    if (ZERO_WIDTH_RE.test(segment)) continue;
    if (segment === '\t') {
      minGraphemeCols += 1;
      xtermUpperCols = (Math.floor(xtermUpperCols / 8) + 1) * 8;
      continue;
    }
    const minWidth = (UNAMBIGUOUS_WIDE_EMOJI_RE.test(segment) || UNAMBIGUOUS_WIDE_CP_RE.test(segment))
      ? 2
      : 1;
    minGraphemeCols += minWidth;

    let segXterm = 0;
    for (const ch of segment) {
      if (ZERO_WIDTH_RE.test(ch)) continue;
      segXterm += (XTERM_POTENTIALLY_WIDE_CP_RE.test(ch) || UNAMBIGUOUS_WIDE_CP_RE.test(ch)) ? 2 : 1;
    }
    xtermUpperCols += Math.max(minWidth, segXterm);
  }
  return { minGraphemeCols, xtermUpperCols };
}

/** Shared Web-input settle predicate matching worker.ts's startup fence. */
export function isTraexWebInputSettled(input: TraexWebInputSettleInput): TraexWebInputSettleStatus {
  if (input.pendingWebInput) {
    return { settled: false, remainingMs: Math.max(0, input.settleMs) };
  }
  if (input.webInputGenerationAtSpawn === undefined
    || input.webInputGeneration === input.webInputGenerationAtSpawn) {
    return { settled: true, remainingMs: 0 };
  }
  const sinceInputMs = input.nowMs - input.lastWebInputAtMs;
  const requiredMs = input.screenRevision === input.webInputScreenRevision
    ? input.settleMs * 3
    : input.settleMs;
  if (!Number.isFinite(sinceInputMs) || sinceInputMs < requiredMs) {
    const remainingMs = Number.isFinite(sinceInputMs)
      ? Math.max(0, requiredMs - sinceInputMs)
      : Math.max(0, requiredMs);
    return { settled: false, remainingMs };
  }
  return { settled: true, remainingMs: 0 };
}

function enableUnicode11(xterm: TerminalRenderer['xterm']): void {
  try {
    xterm.loadAddon(new Unicode11Addon() as unknown as ITerminalAddon);
    xterm.unicode.activeVersion = '11';
  } catch {
    // Keep default Unicode tables if the addon is unavailable in a custom runtime.
  }
}

/**
 * Build and validate a native plain-text viewport capture inside a temporary
 * TerminalRenderer sized to the pane's real geometry, then dispose it
 * unconditionally before returning.
 *
 * - Strips stray ANSI and C0/C1 control codes (including U+009B CSI / U+009D OSC
 *   / bare \r) before staging so cell text can never execute live VT escapes.
 * - Rejects row overflow (`lines.length > rows`) and genuine horizontal width
 *   overflow (`minGraphemeCols > cols`, catching ABA width shrinks) while sizing
 *   xterm's buffer wide enough for unjoined ZWJ / skin-tone / flag grapheme
 *   clusters emitted by real tmux 3.5+ panes.
 */
export function stageNativeViewportInTempRendererSync(
  rawViewport: string,
  dimensions: PaneDimensions,
): StagedNativeViewportResult {
  if (!rawViewport || !rawViewport.trim()) return { ok: false, reason: 'empty' };
  if (!isValidPaneDimensions(dimensions)) return { ok: false, reason: 'invalid-dimensions' };

  const sanitizedLines = normalizePlainViewportLines(rawViewport);
  if (sanitizedLines.length > dimensions.rows) return { ok: false, reason: 'scrolled' };

  let maxXtermCols = dimensions.cols;
  for (const line of sanitizedLines) {
    const { minGraphemeCols, xtermUpperCols } = measureSanitizedLineWidths(line);
    if (minGraphemeCols > dimensions.cols) return { ok: false, reason: 'wrapped' };
    if (xtermUpperCols > maxXtermCols) maxXtermCols = xtermUpperCols;
  }

  // Cap xterm staging width to avoid unbounded canvas allocations on pathological inputs.
  const tempCols = Math.min(maxXtermCols, MAX_NATIVE_VIEWPORT_STAGING_COLS * 2);
  const normalized = sanitizedLines.join('\r\n');
  const temp = new TerminalRenderer(tempCols, dimensions.rows);
  try {
    temp.xterm.options.logLevel = 'error';
    enableUnicode11(temp.xterm);
    const core = (temp.xterm as unknown as { _core?: Partial<XtermCoreWriteSync> })._core;
    if (typeof core?.writeSync === 'function') {
      core.writeSync(normalized);
    } else {
      throw new Error('xterm core.writeSync unavailable');
    }
    const buffer = temp.xterm.buffer.active;
    if (buffer.baseY !== 0) return { ok: false, reason: 'scrolled' };
    for (let y = 0; y < dimensions.rows; y++) {
      if (buffer.getLine(y)?.isWrapped === true) {
        return { ok: false, reason: 'wrapped' };
      }
    }
    const formattedScreen = readViewportText(temp.xterm, {
      filter: false,
      preserveFormatting: true,
      readCols: tempCols,
      rows: dimensions.rows,
    });
    if (!formattedScreen.trim()) return { ok: false, reason: 'empty' };
    const plainScreen = readViewportText(temp.xterm, {
      filter: false,
      preserveFormatting: false,
      readCols: tempCols,
      rows: dimensions.rows,
    });
    return {
      ok: true,
      formattedScreen,
      plainScreen,
      dimensions: Object.freeze({ cols: dimensions.cols, rows: dimensions.rows }),
      lineCount: sanitizedLines.length,
    };
  } finally {
    temp.dispose();
  }
}

/**
 * Scope-fenced store for verified native-viewport readiness evidence.
 * Any mismatch on read permanently evicts the stored entry to prevent ABA reuse
 * after counter resets or restarts.
 */
export class TraexNativeViewportEvidenceStore {
  private entry: TraexNativeViewportEvidence | null = null;

  hasEntry(): boolean {
    return this.entry !== null;
  }

  publish(evidence: TraexNativeViewportEvidence): void {
    const scope: TraexNativeViewportScope = Object.freeze({
      ...evidence.scope,
      webResizedGrid: evidence.scope.webResizedGrid
        ? Object.freeze({ cols: evidence.scope.webResizedGrid.cols, rows: evidence.scope.webResizedGrid.rows })
        : null,
      paneSize: evidence.scope.paneSize
        ? Object.freeze({ cols: evidence.scope.paneSize.cols, rows: evidence.scope.paneSize.rows })
        : null,
      syncPaneSize: evidence.scope.syncPaneSize === undefined
        ? undefined
        : evidence.scope.syncPaneSize
          ? Object.freeze({ cols: evidence.scope.syncPaneSize.cols, rows: evidence.scope.syncPaneSize.rows })
          : null,
    });
    this.entry = Object.freeze({
      scope,
      formattedScreen: evidence.formattedScreen,
      plainScreen: evidence.plainScreen,
      webInputSettled: evidence.webInputSettled,
      capturedAtMs: evidence.capturedAtMs,
    });
  }

  clear(): void {
    this.entry = null;
  }

  /** Clear only if the currently stored evidence belongs to the given owner
   *  (prevents a cancelled or cross-generation stale probe from wiping a newer
   *  generation's live published evidence). */
  clearIfOwnedBy(owner: TraexNativeViewportOwner): void {
    const current = this.entry;
    if (!current) return;
    const { scope } = current;
    if (scope.backend === owner.backend
      && scope.spawnGeneration === owner.spawnGeneration
      && scope.lifetimeNonce === owner.lifetimeNonce
      && scope.renderer === owner.renderer) {
      this.entry = null;
    }
  }

  read(ctx: TraexNativeViewportReadContext): TraexNativeViewportEvidence | undefined {
    const current = this.entry;
    if (!current) return undefined;
    const { scope } = current;
    const valid = !ctx.closeRequested
      && !ctx.restartingWithoutReplacement
      && !ctx.pendingWebInput
      && ctx.backend != null
      && ctx.backend === scope.backend
      && ctx.spawnGeneration === scope.spawnGeneration
      && ctx.lifetimeNonce === scope.lifetimeNonce
      && ctx.renderer != null
      && ctx.renderer === scope.renderer
      && ctx.screenRevision === scope.screenRevision
      && ctx.outputGenerationCurrent(scope.outputGeneration)
      && ctx.webInputGeneration === scope.webInputGeneration
      && ctx.controlWriteRevision === scope.controlWriteRevision
      && ctx.interruptGeneration === scope.interruptGeneration
      && ctx.gridRevision === scope.gridRevision
      && paneDimensionsEqual(ctx.webResizedGrid, scope.webResizedGrid)
      && (scope.syncPaneSize === undefined || paneDimensionsEqual(ctx.syncPaneSize, scope.syncPaneSize));
    if (!valid) {
      this.entry = null;
      return undefined;
    }
    return current;
  }
}

/**
 * Single-flight, token-fenced poller for TraeX first-prompt readiness.
 * Guarantees at most one armed timer at any time and immediate cancellation on
 * stop/teardown without leaking timers across spawn generations or worker exit.
 */
export class TraexFirstPromptReadinessPoller {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private runToken = 0;
  private readonly clock: TimerClock;

  constructor(clock: TimerClock = DEFAULT_TIMER_CLOCK) {
    this.clock = clock;
  }

  start(opts: {
    stillWaiting: () => boolean;
    check: (isCurrentRun: () => boolean) => Promise<void>;
    nextDelayMs: () => number;
    onError?: (err: unknown) => void;
  }): void {
    this.stop();
    const token = ++this.runToken;
    const isCurrentRun = (): boolean => this.runToken === token;
    const scheduleNext = (): void => {
      if (!isCurrentRun() || !opts.stillWaiting()) return;
      const delayMs = Math.max(1, Math.round(opts.nextDelayMs()));
      const handle = this.clock.setTimeout(() => {
        if (this.timer === handle) this.timer = undefined;
        void runTick();
      }, delayMs);
      handle.unref?.();
      this.timer = handle;
    };
    const runTick = async (): Promise<void> => {
      if (!isCurrentRun()) return;
      try {
        await opts.check(isCurrentRun);
      } catch (err) {
        opts.onError?.(err);
      } finally {
        scheduleNext();
      }
    };
    scheduleNext();
  }

  stop(): void {
    this.runToken += 1;
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * Single-flight controller for post-first-prompt on-demand native viewport
 * refresh (Phase 2: `awaitingFirstPrompt` already cleared while
 * `traexFirstInputAdmissionPending` is still armed, and a later redraw,
 * Web input, or write cleared earlier evidence).
 */
export class TraexNativeViewportRefreshController {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scheduledAtMs = 0;
  private scheduledDelayMs = 0;
  private active = false;
  private runToken = 0;
  private readonly clock: TimerClock;

  constructor(clock: TimerClock = DEFAULT_TIMER_CLOCK) {
    this.clock = clock;
  }

  trigger(opts: {
    stillNeeded: () => boolean;
    initialDelayMs: number;
    retryDelayMs: number;
    run: (isCurrentRun: () => boolean) => Promise<boolean>;
    onAdmitted?: () => void;
    onError?: (err: unknown) => void;
  }): boolean {
    if (this.active) return false;
    if (!opts.stillNeeded()) return false;
    const desiredDelayMs = Math.max(0, Math.round(opts.initialDelayMs));
    if (this.timer !== undefined) {
      // If a waiting retry backoff has longer remaining time than the caller's
      // desired initial delay (e.g. a fresh message arriving right after /stop),
      // reschedule sooner instead of stalling behind the stale retry timer.
      const remainingMs = Math.max(0, (this.scheduledAtMs + this.scheduledDelayMs) - this.clock.now());
      if (desiredDelayMs >= remainingMs) return false;
      this.stop();
    }
    const token = ++this.runToken;
    const isCurrentRun = (): boolean => this.runToken === token;
    const schedule = (delayMs: number): void => {
      if (!isCurrentRun() || !opts.stillNeeded()) return;
      const clampedMs = Math.max(0, Math.round(delayMs));
      this.scheduledAtMs = this.clock.now();
      this.scheduledDelayMs = clampedMs;
      const handle = this.clock.setTimeout(() => {
        if (this.timer === handle) this.timer = undefined;
        void execute();
      }, clampedMs);
      handle.unref?.();
      this.timer = handle;
    };
    const execute = async (): Promise<void> => {
      if (!isCurrentRun() || !opts.stillNeeded()) return;
      this.active = true;
      let admitted = false;
      try {
        admitted = await opts.run(isCurrentRun);
      } catch (err) {
        opts.onError?.(err);
      } finally {
        if (isCurrentRun()) {
          this.active = false;
          if (admitted) {
            opts.onAdmitted?.();
          } else if (opts.stillNeeded()) {
            schedule(opts.retryDelayMs);
          }
        }
      }
    };
    if (desiredDelayMs > 0) {
      schedule(desiredDelayMs);
    } else {
      void execute();
    }
    return true;
  }

  stop(): void {
    this.runToken += 1;
    this.active = false;
    this.scheduledAtMs = 0;
    this.scheduledDelayMs = 0;
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
