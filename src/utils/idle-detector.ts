import type { CliAdapter } from '../adapters/cli/types.js';

export type IdleEvidenceSource = 'screen' | 'external' | 'program-status';

/** OSC 7501 report after the worker has decoded `msg`. Unknown keys are ignored. */
export interface ProgramStatusEvent {
  state: 'idle' | 'working' | 'done' | 'blocked' | 'error' | 'clear';
  id?: string;
  app?: string;
  kind?: string;
  msg?: string;
  progress?: number;
}

export interface ProgramStatusBlock {
  kind?: 'permission' | 'question' | 'auth';
  msg?: string;
}

/**
 * After our own submit, how long to wait for the next OSC 7501 report before
 * leaving authority mode. Silence while a `working` record is held does not
 * use this timer: the spec has no heartbeat, and a long think must stay busy.
 */
export const PROGRAM_STATUS_FALLBACK_MS = 15_000;

const PROGRAM_STATUS_RECORD_CAP = 64;
const PROGRAM_STATUS_EVICTED_BUSY_CAP = 256;
const PROGRAM_STATUS_STATES = new Set<ProgramStatusEvent['state']>([
  'idle', 'working', 'done', 'blocked', 'error', 'clear',
]);
const PROGRAM_STATUS_ID_SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;
const PROGRAM_STATUS_APP = /^[A-Za-z0-9_.+-]{1,32}$/;
const PROGRAM_STATUS_KINDS = new Set(['permission', 'question', 'auth']);
const PROGRAM_STATUS_CONTROL = /[\u0000-\u001f\u007f\u0080-\u009f]/g;
/** Bidi overrides and isolates. Stripped from `msg` so a status line cannot
 *  reverse surrounding text. The event itself is kept. */
const PROGRAM_STATUS_BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** Zero-width spaces and joiners that can be abused for invisible text injection. */
const PROGRAM_STATUS_ZERO_WIDTH = /[\u200b-\u200d\ufeff]/g;

/** Spinner frames — animate while CLI is working.
 *  Includes Claude Code symbols, all Unicode braille patterns (6-dot & 8-dot
 *  such as Ink / Antigravity dots ⣾⣽⣻⢿⡿⣟⣯⣷), and OpenCode progress bar chars (■⬝). */
const SPINNER_RE = /[·✢✳✶✻✽\u2800-\u28ff■⬝]/;

/** Default quiescence timeout (ms) — idle if PTY silent + no recent spinner */
const QUIESCENCE_MS = 2_000;
/** Spinner guard — don't declare idle if spinner seen within this window */
const SPINNER_GUARD_MS = 3_000;

/** Strip ANSI escape sequences from a screen/PTY text before running
 *  line-anchored adapter patterns. Shared by the IdleDetector PTY stream path
 *  and the worker's viewport busy probes: both must see IDENTICAL text, since
 *  patterns (e.g. claude-code's footer regex) anchor on `^` and tmux
 *  `capture-pane -e` emits SGR color codes at line starts that break the
 *  anchor unless stripped first. Cursor-forward sequences (`ESC[nC`) are
 *  expanded to spaces because they represent real horizontal gaps.
 *
 *  Covers what tmux capture-pane actually emits (verified against tmux 3.5a
 *  grid output): CSI with `:` subparameters (e.g. `ESC[4:3m`), OSC hyperlinks
 *  terminated by ST (`ESC \`) as well as BEL, charset designation (`ESC( B`),
 *  and bare SO/SI charset-shift bytes (0x0e/0x0f). Leaving any of these at a
 *  line start keeps a `^`-anchored pattern from binding. */
export function stripAnsiScreenText(str: string): string {
  return str
    // Cursor-forward: ESC[nC moves the cursor right n columns, which renders
    // as real horizontal whitespace on screen — preserve it as spaces.
    .replace(/\x1b\[(\d*)C/g, (_m, n) => ' '.repeat(Number(n) || 1))
    // CSI: ESC[ params(0x30–0x3F, includes ':' ';' '?') intermediates final.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // OSC: ESC] ... terminated by BEL (0x07) or ST (ESC \).
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    // Charset designation: ESC ( B / ESC ) 0 etc.
    .replace(/\x1b[()][0-9A-B]/g, '')
    // Remaining two-byte escape sequences.
    .replace(/\x1b[ -/]*[@-~]/g, '')
    // Bare SO/SI (G0/G1 charset shift) control bytes.
    .replace(/[\x0e\x0f]/g, '');
}

export class IdleDetector {
  private outputTail = '';
  private lastSpinnerAt = 0;
  private quiescenceTimer: ReturnType<typeof setTimeout> | null = null;
  private isIdle = false;
  /** One-shot latch: true forever after this IdleDetector instance publishes
   *  its first idle (screen or external). Gates the opt-in extended
   *  first-prompt quiescence and intentionally survives reset() — one
   *  IdleDetector exists per spawn, so "first" happens only once. */
  private firstIdlePublished = false;
  private idleCallback: ((source: IdleEvidenceSource) => void) | null = null;
  private busyCallback: (() => void) | null = null;
  private completionPattern: RegExp | undefined;
  private idleToBusyPattern: RegExp | undefined;
  private staticBusyPattern: RegExp | undefined;
  private staticBusyClearPattern: RegExp | undefined;
  private busyTransitionArmed = false;
  private readyPattern: RegExp | undefined;
  private readySeen = false;
  private startupPendingPattern: RegExp | undefined;
  private startupReadyPattern: RegExp | undefined;
  private firstPromptQuiescenceMs: number | undefined;
  private startupReadyFromHistory: CliAdapter['startupReadyFromHistory'];
  private startupTail = '';
  private startupPending = false;
  private startupComplete = false;
  private startupResume: CliAdapter['startupResume'];
  private startupHistorySeen = false;
  /** Pre-idle latch for static busy screens (capacity queue). Set from PTY
   *  chunks carrying explicit static-busy evidence (scanned across chunks
   *  via the rolling tail); suppresses screen-derived idle until a chunk
   *  with explicit composer evidence (staticBusyClearPattern) redraws.
   *  See CliAdapter.staticBusyPattern / staticBusyClearPattern. */
  private staticBusyLatch = false;
  /** Tail position of the last composer clear evidence. Queue evidence in
   *  the tail at or before this position is stale (from before the clear)
   *  and must not re-set the latch. -1 = no clear recorded. */
  private staticBusyClearTailPos = -1;
  /** True after the first accepted OSC 7501 report. Screen bytes no longer
   *  move idle until `clear` or the post-submit fallback. */
  private programStatusAuthority = false;
  private programStatusRecords = new Map<string, ProgramStatusRecord>();
  private evictedBusyIds = new Set<string>();
  private programStatusClock = 0;
  private programStatusFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private programStatusBlockInfo: ProgramStatusBlock | null = null;
  private programStatusErrorMsg: string | undefined;

  constructor(cli: CliAdapter, private readonly captureStartupScreen?: () => string) {
    this.completionPattern = cli.completionPattern;
    this.idleToBusyPattern = cli.idleToBusyPattern;
    this.staticBusyPattern = cli.staticBusyPattern;
    this.staticBusyClearPattern = cli.staticBusyClearPattern;
    this.readyPattern = cli.readyPattern;
    this.startupPendingPattern = cli.startupPendingPattern;
    this.startupReadyPattern = cli.startupReadyPattern;
    this.startupResume = cli.startupResume;
    this.firstPromptQuiescenceMs = cli.firstPromptQuiescenceMs;
    this.startupReadyFromHistory = cli.startupReadyFromHistory;
  }

  onIdle(cb: (source: IdleEvidenceSource) => void): void {
    this.idleCallback = cb;
  }

  onBusy(cb: () => void): void {
    this.busyCallback = cb;
  }

  /**
   * Seed readyPattern evidence for a prompt that IS on screen but was rendered
   * before resetReadyEvidence() cleared the flag. A new session (SessionStart
   * source=startup) never redraws after that boundary, so Strategy 2's
   * `!readySeen` early return would suppress quiescence detection forever.
   *
   * The caller must first confirm the PTY is quiet AND the current rendered
   * screen matches readyPattern. This only restores readySeen — a full
   * quiescence check (spinner guard included) still runs on top of it, so no
   * existing check is bypassed.
   */
  seedReadyEvidence(): boolean {
    if (this.programStatusAuthority) {
      // The post-SessionStart fallback only calls this once the viewport
      // already shows a prompt. Re-publish the OSC terminal state; do not
      // let the screen timer declare idle while a child is still working.
      if (this.isIdle || !this.isTerminalProgramStatus()) return false;
      this.markIdle('program-status');
      return true;
    }
    if (this.isIdle || this.readySeen) return false;
    this.readySeen = true;
    this.clearTimer();
    this.quiescenceCheck();
    return true;
  }

  feed(data: string): void {
    // Authority mode: a prompt redraw after `done` must not clear isIdle and
    // re-arm the 2s timer. Startup-banner tracking still runs; the tail is
    // kept only so a later fallback can see a prompt that already scrolled by.
    if (this.programStatusAuthority) {
      this.observeStartupChunk(data);
      this.rememberHeuristicTail(data);
      return;
    }

    // A botmux-owned submit calls reset() before writing input, but adopted
    // panes can also receive local terminal input while we are already idle.
    // Treat any later PTY data as a fresh cycle so that local work can become
    // idle and flush transcript-driven fallback output.
    if (this.isIdle) {
      this.isIdle = false;
      this.outputTail = '';
      this.readySeen = false;
      this.staticBusyClearTailPos = -1;
      this.lastSpinnerAt = Date.now();
    }

    const stripped = this.stripAnsi(data);
    this.observeStartupChunk(data);
    // Shift the clear position left when the tail window drops characters
    // from the head, so it stays relative to the current window.
    const combined = this.outputTail + stripped;
    const dropped = Math.max(0, combined.length - 500);
    this.outputTail = combined.slice(-500);
    if (this.staticBusyClearTailPos >= 0) {
      this.staticBusyClearTailPos = Math.max(-1, this.staticBusyClearTailPos - dropped);
    }

    // Only an explicitly opted-in CLI marker may turn a previously reported
    // idle cycle back into busy. Plain PTY activity — and legacy busyPattern
    // matches — can be a transcript redraw, so they are insufficient evidence.
    // Keep the edge armed across chunks, then emit at most once per cycle.
    if (
      this.busyTransitionArmed
      && this.idleToBusyPattern
      && (
        this.idleToBusyPattern.test(stripped)
        || this.idleToBusyPattern.test(this.outputTail)
      )
    ) {
      this.busyTransitionArmed = false;
      this.busyCallback?.();
    }

    // Track when the CLI's input prompt appears.
    // Check the current chunk too — a single chunk can contain the prompt
    // AND a full status-bar redraw (hundreds of chars), pushing the prompt
    // out of the 500-char outputTail before the check runs.
    const readyMatched = this.readyPattern && (
      this.readyPattern.test(stripped) || this.readyPattern.test(this.outputTail)
    );
    if (readyMatched) {
      this.readySeen = true;
    }

    // Pre-idle static-busy latch (capacity-queue screens).
    // SET: scan both the current chunk AND the rolling tail — the queue
    //  marker can be split across chunks ("Queued for cap" + "acity"), and
    //  the tail already holds the full text by the time the second chunk
    //  arrives (consistent with idleToBusy/completionPattern split-chunk
    //  handling).
    // CLEAR: explicit composer evidence (staticBusyClearPattern) in the
    //  CURRENT chunk. The broad readyPattern includes `\d+% left` (status
    //  bar), which the queue screen itself carries — using it to clear
    //  would re-open the false-idle bug when queue and status bar arrive
    //  in separate chunks.
    // ORDER: within a single chunk, whichever evidence appears LAST wins —
    //  a submitted user message (`› text`) followed by a fresh queue line
    //  must NOT clear the latch (the queue is fresher), while a queue line
    //  followed by a real composer redraw must clear it.
    // STALE-TAIL: after a clear, queue text lingering in the tail must not
    //  re-set the latch. Record the clear position in the tail; only queue
    //  evidence AFTER that position is fresh enough to set.
    if (this.staticBusyPattern) {
      const clearIdx = this.staticBusyClearPattern
        ? lastMatchIndex(this.staticBusyClearPattern, stripped)
        : -1;
      const staticChunkIdx = lastMatchIndex(this.staticBusyPattern, stripped);
      const staticTailIdx = lastMatchIndex(this.staticBusyPattern, this.outputTail);
      if (clearIdx >= 0 && clearIdx > staticChunkIdx) {
        this.staticBusyLatch = false;
        // Record where the clear landed in the tail so stale queue text
        // before it doesn't re-set the latch on the next chunk.
        const chunkStart = this.outputTail.length - stripped.length;
        this.staticBusyClearTailPos = chunkStart >= 0
          ? chunkStart + clearIdx
          : this.outputTail.length;
      } else if (staticTailIdx >= 0 && staticTailIdx > this.staticBusyClearTailPos) {
        this.staticBusyLatch = true;
      }
    }

    // Track spinner — but not if it's part of completion marker,
    // and not after ready pattern is seen (status bar chars like · are not real spinners)
    if (SPINNER_RE.test(stripped) && !(this.completionPattern?.test(stripped) || this.completionPattern?.test(this.outputTail)) && !this.readySeen) {
      this.lastSpinnerAt = Date.now();
    }

    // Strategy 1: CLI-specific completion marker
    // Check the current chunk too: a single full-screen redraw can contain
    // the completion line and enough trailing status text to push it out of
    // the 500-char tail before this check runs.
    if (this.completionPattern?.test(stripped) || this.completionPattern?.test(this.outputTail)) {
      this.clearTimer();
      this.quiescenceTimer = setTimeout(() => {
        this.quiescenceTimer = null;
        // A static-busy latch outranks a completion marker: the queue screen
        // can carry both, and the latch only clears on a composer redraw.
        if (!this.isIdle && !this.staticBusyLatch && !this.isStartupPending()) this.markIdle('screen');
      }, 500);
      return;
    }

    // Strategy 2: quiescence (PTY silence + no recent spinner)
    // When readyPattern is set, suppress quiescence until the input prompt appears.
    if (this.readyPattern && !this.readySeen) return;

    this.clearTimer();
    // Adapters without a prompt anchor (Bubble Tea TUIs such as OpenCode) can
    // still be booting when the default 2s quiet window expires; an opt-in
    // longer window applies only before THIS process's first idle. It buys a
    // couple more cold-start cycles but changes no readiness criterion: the
    // startup hold, spinner guard and static-busy latch all still apply, and
    // the completion branch above keeps its fixed 500ms.
    const quiescenceMs = !this.firstIdlePublished
      && !this.readyPattern
      && typeof this.firstPromptQuiescenceMs === 'number'
      && this.firstPromptQuiescenceMs > QUIESCENCE_MS
      ? this.firstPromptQuiescenceMs
      : QUIESCENCE_MS;
    this.quiescenceTimer = setTimeout(() => this.quiescenceCheck(), quiescenceMs);
  }

  reset(): void {
    const keepAuthority = this.programStatusAuthority;
    this.isIdle = false;
    this.busyTransitionArmed = false;
    this.outputTail = '';
    this.readySeen = false;
    this.staticBusyLatch = false;
    this.staticBusyClearTailPos = -1;
    this.lastSpinnerAt = Date.now();
    this.clearTimer();
    // A new submit invalidates the previous snapshot. Stale terminal states
    // (idle / done / error) must not immediately complete the turn we just started.
    // If any working or blocked record remains, keep authority and do not arm
    // the fallback timer — silence under an ongoing operation never takes fallback.
    for (const [id, rec] of [...this.programStatusRecords]) {
      if (rec.state === 'idle' || rec.state === 'done' || rec.state === 'error') {
        this.programStatusRecords.delete(id);
      }
    }
    const hasBusyRecord = this.hasBusyProgramStatus();
    if (!hasBusyRecord) {
      this.programStatusBlockInfo = null;
      this.programStatusErrorMsg = undefined;
    }
    this.clearProgramStatusFallback();
    if (keepAuthority) {
      this.programStatusAuthority = true;
      if (!hasBusyRecord && this.programStatusRecords.size === 0) {
        this.programStatusFallbackTimer = setTimeout(() => {
          this.programStatusFallbackTimer = null;
          this.exitProgramStatusAuthority();
        }, PROGRAM_STATUS_FALLBACK_MS);
      }
    }
  }

  /**
   * Drop prompt evidence observed before a SessionStart boundary. Unlike the
   * ordinary per-turn reset, this does not synthesize a recent spinner: once
   * Claude finishes the remaining parallel hooks, its newly rendered prompt
   * should need only the normal quiescence window.
   */
  resetReadyEvidence(): void {
    // SessionStart drops screen-prompt evidence. An OSC terminal snapshot
    // is not a selector's ❯: republish it so the post-hook fence, which is
    // armed before this call, sees a fresh program-status edge. A working
    // or blocked snapshot stays busy; Claude emits `idle` when the prompt
    // is actually ready.
    const republishTerminal = this.programStatusAuthority && this.isTerminalProgramStatus();
    this.isIdle = false;
    this.busyTransitionArmed = false;
    this.outputTail = '';
    this.readySeen = false;
    this.staticBusyLatch = false;
    this.staticBusyClearTailPos = -1;
    this.lastSpinnerAt = 0;
    this.clearTimer();
    if (republishTerminal) this.markIdle('program-status');
  }

  /**
   * OSC 7501 (Program Status Protocol). The first accepted report makes this
   * detector authoritative: `working`/`blocked` cannot be cleared by a quiet
   * screen, and `done`/`idle`/`error` complete the turn without the 2s wait.
   * `blocked` never completes the turn — that would flush queued input into
   * a permission or question prompt.
   */
  observeProgramStatus(event: ProgramStatusEvent): void {
    if (!PROGRAM_STATUS_STATES.has(event.state)) return;
    if (event.id !== undefined && !isProgramStatusId(event.id)) return;

    if (event.state === 'clear') {
      if (event.id === undefined) {
        this.exitProgramStatusAuthority();
        return;
      }
      this.deleteProgramStatusSubtree(event.id);
      if (this.programStatusRecords.size === 0 && this.evictedBusyIds.size === 0) {
        this.exitProgramStatusAuthority();
        return;
      }
      this.programStatusAuthority = true;
      this.clearProgramStatusFallback();
      this.applyProgramStatus();
      return;
    }

    const id = event.id ?? '';
    if (id) {
      this.evictedBusyIds.delete(id);
    }
    const kind = event.state === 'blocked' && event.kind && PROGRAM_STATUS_KINDS.has(event.kind)
      ? event.kind as ProgramStatusBlock['kind']
      : undefined;
    const progress = (event.state === 'working' || event.state === 'blocked')
      && typeof event.progress === 'number'
      && Number.isInteger(event.progress)
      && event.progress >= 0
      && event.progress <= 100
      ? event.progress
      : undefined;
    const app = typeof event.app === 'string' && PROGRAM_STATUS_APP.test(event.app)
      ? event.app
      : undefined;
    this.programStatusRecords.set(id, {
      state: event.state,
      kind,
      msg: typeof event.msg === 'string' ? sanitizeProgramStatusMsg(event.msg) : undefined,
      progress,
      app,
      at: ++this.programStatusClock,
    });
    this.evictProgramStatusRecords();
    this.programStatusAuthority = true;
    this.clearProgramStatusFallback();
    this.applyProgramStatus();
  }

  programStatusActive(): boolean {
    return this.programStatusAuthority;
  }

  /** Latest blocked record, for a later wait-card. Never logged here. */
  programStatusBlock(): ProgramStatusBlock | null {
    return this.programStatusBlockInfo;
  }

  programStatusError(): string | undefined {
    return this.programStatusErrorMsg;
  }

  /** External idle source — lets transcript-driven detectors (Claude jsonl
   *  Stop, Codex rollout assistant_final, CoCo events.jsonl finish_reason
   *  stop) push idle without waiting for screen-pattern + quiescence to
   *  agree. Idempotent within a turn (gated by isIdle); reset() re-arms it
   *  for the next turn — same lifecycle as the internal markIdle path. */
  fireIdle(): void {
    if (this.isIdle) return;
    // A transcript Stop must not flush queued input into a permission or
    // question prompt that OSC 7501 still reports as working or blocked.
    if (this.programStatusAuthority && this.hasBusyProgramStatus()) return;
    // Actual transcript completion proves the session initialized, even if
    // its loaded banner was omitted or the operator customized the footer.
    this.markStartupComplete();
    this.markIdle('external');
  }

  /** Shared by the worker's screen-ready and hard-timeout write paths. */
  isStartupPending(): boolean {
    return this.startupPending && !this.startupComplete;
  }

  /** Initialization is not a synthetic turn completion. */
  private markStartupComplete(): void {
    this.startupComplete = true;
    this.startupPending = false;
    this.startupTail = '';
    this.startupHistorySeen = false;
  }

  /** Positive initialization evidence, retained across resync/turn resets. */
  isStartupComplete(): boolean {
    return this.startupComplete;
  }

  /**
   * Startup-banner evidence read from an authoritative screen snapshot.
   *
   * feed() is the only other source of that evidence, and on a snapshot-based
   * backend it cannot carry it: ZMX's screen source is `zmx history`, which
   * returns the current screen instead of an append-only byte stream. Only a
   * snapshot that extends the previous one is published as PTY data; an
   * in-place repaint — exactly what `model: loading` → `model: <real>` is — is
   * published as a screen resync, which deliberately never reaches feed(). The
   * startup hold could therefore never be released on that backend and queued
   * input was held for the lifetime of the session.
   *
   * Deliberately narrower than feed(): it touches ONLY the startup latch, never
   * outputTail / readySeen / spinner / quiescence state, and it neither arms
   * nor fires a timer. Initialization allows the worker's existing type-ahead
   * path, but does not prove idle: readyPattern plus quiescence still gate that
   * independently. It does lift a veto: a quiescence check that
   * fed data had already armed, and that isStartupPending() was rejecting, can
   * complete afterwards. That is the point of the hold, not a bypass of it —
   * the evidence behind that check still came from feed().
   *
   * Unlike feed(), ready does NOT win unconditionally here. A snapshot carries
   * spatial order, and history includes scrollback: an initialized banner left
   * above the viewport by an earlier CLI generation must not release a hold
   * that the live banner still reports as loading. The lower banner wins.
   *
   * Returns true only on the transition that completes startup (for logging).
   */
  observeStartupScreen(screen: string): boolean {
    if (this.startupComplete || !this.startupPendingPattern) return false;
    const text = this.stripAnsi(screen);
    const pendingAt = lastMatchIndex(this.startupPendingPattern, text);
    const readyAt = this.startupReadyPattern
      ? lastMatchIndex(this.startupReadyPattern, text)
      : -1;
    if (readyAt >= 0 && readyAt > pendingAt) {
      this.startupComplete = true;
      this.startupPending = false;
      this.startupTail = '';
      this.publishHeldProgramStatusTerminal();
      return true;
    }
    if (pendingAt >= 0) this.startupPending = true;
    return false;
  }

  /** Full snapshot evidence, separate from feed(): history must never seed
   * readySeen, quiescence, or a synthetic turn completion. Also handles warm
   * reattach, where this detector has never observed the loading banner. */
  observeStartupHistory(history: string): boolean {
    if (this.startupComplete || !this.startupReadyFromHistory?.(this.stripAnsi(history))) return false;
    this.startupComplete = true;
    this.startupPending = false;
    this.startupTail = '';
    this.publishHeldProgramStatusTerminal();
    return true;
  }

  dispose(): void {
    this.clearTimer();
    this.clearProgramStatusFallback();
    this.programStatusAuthority = false;
    this.programStatusRecords.clear();
    this.evictedBusyIds.clear();
    this.programStatusBlockInfo = null;
    this.programStatusErrorMsg = undefined;
    this.idleCallback = null;
    this.busyCallback = null;
    this.busyTransitionArmed = false;
    this.staticBusyLatch = false;
    this.staticBusyClearTailPos = -1;
  }

  private quiescenceCheck(): void {
    this.quiescenceTimer = null;
    if (this.programStatusAuthority) return;
    if (this.isIdle) return;
    if (this.isStartupPending()) {
      if (!this.startupHistorySeen || !this.startupResume || !this.captureStartupScreen) return;
      let screen: string;
      try { screen = this.captureStartupScreen(); } catch { return; }
      if (!this.startupResume.isReady(screen)) return;
      this.markStartupComplete();
    }
    // Explicit static-busy evidence (capacity queue): the screen is not
    // quiescing into a prompt — it is parked on a queue notice. Do not mark
    // idle and do not re-arm: the latch clears on the composer redraw, whose
    // feed() re-arms quiescence.
    if (this.staticBusyLatch) return;
    const sinceSpinner = Date.now() - this.lastSpinnerAt;
    if (sinceSpinner < SPINNER_GUARD_MS) {
      this.quiescenceTimer = setTimeout(
        () => this.quiescenceCheck(),
        SPINNER_GUARD_MS - sinceSpinner + 200,
      );
      return;
    }
    this.markIdle('screen');
  }

  private markIdle(source: IdleEvidenceSource): void {
    this.isIdle = true;
    // One-shot, permanent for this spawn: reset()/resetReadyEvidence() do not
    // clear it, so the extended first-prompt window never applies twice.
    this.firstIdlePublished = true;
    // Arm before the callback: markPromptReady may synchronously flush queued
    // botmux input and call reset(), which must win and disarm this edge.
    this.busyTransitionArmed = true;
    this.outputTail = '';
    this.clearTimer();
    this.idleCallback?.(source);
  }

  private clearTimer(): void {
    if (this.quiescenceTimer) {
      clearTimeout(this.quiescenceTimer);
      this.quiescenceTimer = null;
    }
  }

  private stripAnsi(str: string): string {
    return stripAnsiScreenText(str);
  }

  private observeStartupChunk(data: string): void {
    if (this.startupComplete || !this.startupPendingPattern) return;
    // Preserve raw chunks until decoding: an ANSI style sequence can be
    // split between reads right before `loading`. Per-chunk stripping would
    // leave escape fragments inside the word and miss the startup hold.
    const rawStartup = this.startupTail + data;
    const startup = this.stripAnsi(rawStartup);
    if (this.startupResume?.historyPattern.test(startup)) this.startupHistorySeen = true;
    const pendingAt = lastMatchIndex(this.startupPendingPattern, startup);
    const readyAt = this.startupReadyPattern
      ? lastMatchIndex(this.startupReadyPattern, startup)
      : -1;
    // Initialization is monotonic for this CLI process. A restored pane may
    // seed its entire history in one chunk, including a quoted loading
    // banner after the actual loaded banner. Treat that exactly like two
    // feeds: once fully initialized, later text cannot re-arm startup.
    if (readyAt >= 0) {
      this.markStartupComplete();
      this.publishHeldProgramStatusTerminal();
    } else {
      if (pendingAt >= 0) this.startupPending = true;
      // Keep split banner evidence without retaining startup output
      // indefinitely. Unlike outputTail this survives a per-turn reset.
      this.startupTail = rawStartup.slice(-8_192);
    }
  }

  /** Prompt evidence retained while OSC 7501 owns idle, for the fallback only. */
  private rememberHeuristicTail(data: string): void {
    const stripped = this.stripAnsi(data);
    this.outputTail = (this.outputTail + stripped).slice(-500);
    if (this.readyPattern && (
      this.readyPattern.test(stripped) || this.readyPattern.test(this.outputTail)
    )) {
      this.readySeen = true;
    }
  }

  private hasBusyProgramStatus(): boolean {
    if (this.evictedBusyIds.size > 0) return true;
    for (const rec of this.programStatusRecords.values()) {
      if (rec.state === 'working' || rec.state === 'blocked') return true;
    }
    return false;
  }

  private isTerminalProgramStatus(): boolean {
    if (this.hasBusyProgramStatus()) return false;
    const root = this.programStatusRecords.get('');
    return !!root && (root.state === 'done' || root.state === 'idle' || root.state === 'error');
  }

  /** A terminal OSC snapshot waits out an explicit loading banner. Publishing
   *  idle first would be swallowed by the startup hold and never retried. */
  private publishHeldProgramStatusTerminal(): void {
    if (!this.programStatusAuthority || this.isStartupPending()) return;
    if (!this.isTerminalProgramStatus() || this.isIdle) return;
    this.markIdle('program-status');
  }

  private applyProgramStatus(): void {
    let blocked: ProgramStatusRecord | undefined;
    let busy = this.hasBusyProgramStatus();
    for (const rec of this.programStatusRecords.values()) {
      if (rec.state === 'blocked' && (!blocked || rec.at > blocked.at)) blocked = rec;
    }
    if (blocked) {
      this.programStatusBlockInfo = {
        ...(blocked.kind ? { kind: blocked.kind } : {}),
        ...(blocked.msg !== undefined ? { msg: blocked.msg } : {}),
      };
    } else {
      this.programStatusBlockInfo = null;
    }
    const root = this.programStatusRecords.get('');
    this.programStatusErrorMsg = root?.state === 'error' ? root.msg : undefined;
    if (busy) {
      this.lockProgramStatusBusy();
      return;
    }
    if (this.isTerminalProgramStatus()) {
      // A loading banner is still explicit evidence. OSC idle/done/error
      // must not retire that hold; the ready banner publishes the turn.
      if (this.isStartupPending()) return;
      this.markStartupComplete();
      if (!this.isIdle) this.markIdle('program-status');
    }
  }

  private lockProgramStatusBusy(): void {
    this.clearTimer();
    const wasIdle = this.isIdle;
    this.isIdle = false;
    this.busyTransitionArmed = false;
    if (wasIdle) this.busyCallback?.();
  }

  private deleteProgramStatusSubtree(id: string): void {
    const prefix = `${id}/`;
    for (const key of [...this.programStatusRecords.keys()]) {
      if (key === id || key.startsWith(prefix)) this.programStatusRecords.delete(key);
    }
    for (const key of [...this.evictedBusyIds]) {
      if (key === id || key.startsWith(prefix)) this.evictedBusyIds.delete(key);
    }
  }

  private evictProgramStatusRecords(): void {
    while (this.programStatusRecords.size > PROGRAM_STATUS_RECORD_CAP) {
      let oldestId: string | null = null;
      let oldestAt = Infinity;
      // Pass 1: Prioritize evicting terminal child records (idle / done / error)
      // so long-running working/blocked children are not prematurely purged.
      for (const [id, rec] of this.programStatusRecords) {
        if (id === '') continue;
        const isTerminal = rec.state === 'idle' || rec.state === 'done' || rec.state === 'error';
        if (isTerminal && rec.at < oldestAt) {
          oldestAt = rec.at;
          oldestId = id;
        }
      }
      // Pass 2: If no terminal children remain, evict oldest non-root child,
      // and retain sticky busy evidence so a terminal root cannot prematurely idle.
      if (oldestId === null) {
        for (const [id, rec] of this.programStatusRecords) {
          if (id === '') continue;
          if (rec.at < oldestAt) {
            oldestAt = rec.at;
            oldestId = id;
          }
        }
      }
      if (oldestId === null) return;
      const rec = this.programStatusRecords.get(oldestId);
      if (rec && (rec.state === 'working' || rec.state === 'blocked')) {
        this.evictedBusyIds.add(oldestId);
        if (this.evictedBusyIds.size > PROGRAM_STATUS_EVICTED_BUSY_CAP) {
          const oldest = this.evictedBusyIds.values().next().value;
          if (oldest) this.evictedBusyIds.delete(oldest);
        }
      }
      this.programStatusRecords.delete(oldestId);
    }
  }

  private exitProgramStatusAuthority(): void {
    const wasActive = this.programStatusAuthority;
    this.programStatusAuthority = false;
    this.programStatusRecords.clear();
    this.evictedBusyIds.clear();
    this.programStatusBlockInfo = null;
    this.programStatusErrorMsg = undefined;
    this.clearProgramStatusFallback();
    if (!wasActive || this.isIdle) return;
    if (this.readyPattern && !this.readySeen) return;
    this.clearTimer();
    this.quiescenceTimer = setTimeout(() => this.quiescenceCheck(), QUIESCENCE_MS);
  }

  private clearProgramStatusFallback(): void {
    if (this.programStatusFallbackTimer) {
      clearTimeout(this.programStatusFallbackTimer);
      this.programStatusFallbackTimer = null;
    }
  }
}

interface ProgramStatusRecord {
  state: Exclude<ProgramStatusEvent['state'], 'clear'>;
  kind?: ProgramStatusBlock['kind'];
  msg?: string;
  progress?: number;
  app?: string;
  at: number;
}

function sanitizeProgramStatusMsg(msg: string): string | undefined {
  const cleaned = msg
    .replace(PROGRAM_STATUS_CONTROL, '')
    .replace(PROGRAM_STATUS_BIDI, '')
    .replace(PROGRAM_STATUS_ZERO_WIDTH, '')
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function isProgramStatusId(id: string): boolean {
  if (id.length === 0 || id.length > 128) return false;
  const parts = id.split('/');
  if (parts.length > 8) return false;
  return parts.every(part => PROGRAM_STATUS_ID_SEGMENT.test(part));
}

/** Find the LAST match index of a regex in a string, or -1. Handles
 *  non-global regexes by cloning with the g flag. */
function lastMatchIndex(re: RegExp, s: string): number {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = g.exec(s)) !== null) {
    last = m.index;
    if (g.lastIndex === m.index) g.lastIndex++;
  }
  return last;
}
