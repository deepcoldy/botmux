/**
 * TmuxPipeBackend — observe a user-owned tmux pane WITHOUT attaching to its
 * session. Used by /adopt mode to avoid the renderer conflict that arises
 * when a normal `tmux attach-session` client coexists with a tmux -CC
 * (iTerm2 control mode) client on the same server (interleaved ANSI vs
 * control-protocol writes corrupt cursor / status-bar / alt-screen state).
 *
 * Architecture (no PTY, no attach):
 *   - mkfifo a unique fifo under /tmp
 *   - `tmux pipe-pane -O -t <pane> 'cat > <fifo>'` — tmux replicates every
 *     byte the pane writes into the fifo (append-only, '-O' overwrites any
 *     existing pipe).
 *   - fs.createReadStream(<fifo>) — we read tmux's verbatim ANSI stream.
 *   - All writes (sendText / sendSpecialKeys / pasteText / copy-mode keys)
 *     go through `tmux send-keys / paste-buffer -t <pane>` — so the pane's
 *     real address ("0:2.0") is the addressing target, not a synthetic
 *     session name.
 *   - `tmux capture-pane -e -p -t <pane> -S -` returns the current screen
 *     with ANSI; the worker uses it to seed new web-terminal connections
 *     so they don't start from a blank screen.
 *
 * The user's source session is never attached, never zoomed, never
 * grouped — fully zero-touch from tmux's perspective beyond the pipe-pane
 * subscription, which is automatically detached when we kill the backend.
 */
import * as fs from 'node:fs';
import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { SessionBackend, SessionProbe, SpawnOpts } from './types.js';
import { tmuxEnv } from '../../setup/ensure-tmux.js';
import { buildBotmuxEnvAssignments, resolveUserShell, shellWrapperScript, shellCommandArgv, shellKindForPath, TmuxBackend, isTmuxServerLevelErrorText, isExecTimeoutError } from './tmux-backend.js';
import { resolveBotmuxWrapperBinDir } from '../../core/botmux-wrapper.js';
import { LivenessGate, ADOPT_LIVENESS_MAX_FAILURES } from './liveness-gate.js';

function shellescape(s: string): string {
  // Single-quote-escape, replacing internal ' with '\''
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Blocking sleep for the synchronous spawn path (SessionBackend.spawn is sync).
 *  Atomics.wait is allowed on Node's main thread and burns no CPU — spawn only
 *  runs during session startup, so briefly blocking the worker is fine. */
function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Retry delays for startup-time tmux commands (new-session / pipe-pane).
 *  A daemon restore or a post-outage restart herd hammers the shared server
 *  with connects; first attempts routinely eat an instant ECONNREFUSED
 *  (accept-backlog overflow). Two spaced retries ride out a several-second
 *  stall instead of surfacing "会话启动失败" to every chat at once. */
const STARTUP_TMUX_RETRY_DELAYS_MS = [1000, 3000];

let startupRetrySleepFn: (ms: number) => void = sleepSyncMs;

/** Test seam: the startup retries sleep SYNCHRONOUSLY (Atomics.wait ignores
 *  fake timers), which would add real seconds to the unit suite. Pass null to
 *  restore the real sleep. */
export function setStartupTmuxRetrySleepForTests(fn: ((ms: number) => void) | null): void {
  startupRetrySleepFn = fn ?? sleepSyncMs;
}

/** Is a failed startup-time tmux command worth retrying? A clean non-zero exit
 *  whose stderr is NOT a connection-level error means the server answered and
 *  rejected deterministically ("can't find pane", "duplicate session", bad
 *  option) — retrying only delays the same failure. Everything else (connect
 *  refused/no socket, command timeout, spawn-level EMFILE/EAGAIN) is plausibly
 *  transient under a stalled/overloaded shared server. */
function isRetryableStartupTmuxFailure(err: any): boolean {
  // Deadline first (2026-08-23 regression): a timed-out client can exit
  // cleanly in the same window the kill fires, so the throw carries a numeric
  // status + empty stderr alongside ETIMEDOUT. Reading that as "the server
  // answered and rejected deterministically" turned a new-session that had
  // actually SUCCEEDED server-side into a fatal, user-visible 会话启动失败
  // during the post-outage restart storm. A timeout is never deterministic.
  if (isExecTimeoutError(err)) return true;
  if (err && typeof err.status === 'number' && !err.signal) {
    return isTmuxServerLevelErrorText((err.stderr?.toString?.() ?? '').trim());
  }
  return true;
}

/** Convert `\n` to `\r\n` while leaving existing `\r\n` alone. Exported for
 *  unit tests; used to normalise tmux capture-pane output before sending it
 *  to xterm.js (which treats bare LF as "down one row, keep column"). */
export function normaliseCaptureLineEndings(s: string): string {
  return s.replace(/\r?\n/g, '\r\n');
}

/**
 * Compose the web-terminal seed body from a normalised capture-pane snapshot
 * and the pane's cursor position.
 *
 * The receiving xterm replays this body and then resumes the LIVE pipe-pane
 * byte stream. Claude Code (and other Ink TUIs) repaint their bottom block with
 * height-RELATIVE moves (`\x1b[<n>A` + `\r\n`), so the FIRST live redraw assumes
 * the cursor sits exactly where the pane's cursor is. Raw capture-pane output
 * carries no cursor position and ends with a trailing newline — that newline
 * scrolls the receiving grid one row PAST the content (desyncing the viewport
 * from the app's coordinates) and parks the cursor on the bottom row instead of
 * the app's real row. The first relative redraw then lands a row low, and
 * because the CLI tracks position relatively, every subsequent frame stays
 * shifted (the status-line update bleeds into the line below — the bug 示例用户
 * reported).
 *
 * Fix: strip the SINGLE trailing line terminator so no extra scroll happens,
 * then restore the cursor with CUP (`\x1b[row;colH`). Strip exactly one `\r\n`,
 * NOT a greedy `(\r\n)+` — capture-pane emits every pane row including trailing
 * BLANK rows below the cursor (Claude's bottom row is usually blank). Greedily
 * stripping would delete those blank rows and shift the whole grid up one row,
 * parking the cursor above the real input line (an upward drift — the same bug,
 * mirrored). CUP is viewport-relative and tmux's `cursor_x`/`cursor_y` are
 * 0-based viewport coordinates, so +1 each lands correctly even when the capture
 * includes full scrollback. Verified against a real 208x62 Claude pane.
 * Exported for tests.
 */
export function composeSeedBody(
  normalisedCapture: string,
  cursor: { x: number; y: number } | null,
): string {
  const body = normalisedCapture.replace(/\r\n$/, '');
  if (!cursor) return body;
  return body + `\x1b[${cursor.y + 1};${cursor.x + 1}H`;
}

/** Pane input modes tmux tracks per pane but capture-pane cannot express.
 *  A capture-pane seed carries screen cells only — the DECSET state that tells
 *  the receiving xterm to REPORT mouse events (or use app cursor keys) is
 *  gone, so a mouse-mode TUI (grok build: 1003+1006) never hears clicks from
 *  a freshly-connected web client. */
export interface PaneInputModes {
  mouseStandard: boolean; // DECSET 1000 — press/release reporting
  mouseButton: boolean;   // DECSET 1002 — 1000 + drag motion
  mouseAll: boolean;      // DECSET 1003 — 1002 + any motion
  mouseSgr: boolean;      // DECSET 1006 — SGR extended encoding
  appCursorKeys: boolean; // DECSET 1 (DECCKM) — \x1bOA-style arrows
  appKeypad: boolean;     // DECKPAM
  cursorVisible: boolean; // DECTCEM — emit hide only (xterm default is visible)
}

/** Render {@link PaneInputModes} as the escape sequence that re-asserts them on
 *  a fresh xterm. Appended AFTER the seed body: DECSET never moves the cursor,
 *  so composeSeedBody's cursor restore stays intact. Exported for tests. */
export function paneInputModeSeed(m: PaneInputModes): string {
  let seq = '';
  if (m.mouseStandard) seq += '\x1b[?1000h';
  if (m.mouseButton) seq += '\x1b[?1002h';
  if (m.mouseAll) seq += '\x1b[?1003h';
  if (m.mouseSgr) seq += '\x1b[?1006h';
  if (m.appCursorKeys) seq += '\x1b[?1h';
  if (m.appKeypad) seq += '\x1b=';
  if (!m.cursorVisible) seq += '\x1b[?25l';
  return seq;
}

/** tmux display-message format string matching {@link parsePaneModeFlags}. */
export const PANE_MODE_FLAGS_FORMAT =
  '#{mouse_standard_flag} #{mouse_button_flag} #{mouse_all_flag} #{mouse_sgr_flag}'
  + ' #{keypad_cursor_flag} #{keypad_flag} #{cursor_flag}';

/** Parse the {@link PANE_MODE_FLAGS_FORMAT} output. Null on malformed output
 *  (pane vanished mid-query → tmux prints an error line, not flags). */
export function parsePaneModeFlags(out: string): PaneInputModes | null {
  const f = out.trim().split(/\s+/);
  if (f.length !== 7 || f.some(v => v !== '0' && v !== '1')) return null;
  return {
    mouseStandard: f[0] === '1',
    mouseButton: f[1] === '1',
    mouseAll: f[2] === '1',
    mouseSgr: f[3] === '1',
    appCursorKeys: f[4] === '1',
    appKeypad: f[5] === '1',
    cursorVisible: f[6] === '1',
  };
}

/**
 * Spread lifecycle probes after a mass daemon restore. Workers are separate
 * processes, so a process-local mutex cannot prevent them all from hitting the
 * same default tmux server on the same millisecond. A stable target-derived
 * offset keeps probes distributed without introducing test/runtime randomness.
 */
export function tmuxLifecycleInitialDelayMs(target: string): number {
  let hash = 2166136261;
  for (let i = 0; i < target.length; i += 1) {
    hash ^= target.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 1000 + ((hash >>> 0) % 750);
}

/**
 * Every backend with a live fifo reader, so process exit can unblock them all.
 *
 * A parked fifo read wedges `process.exit()` forever in uv__threadpool_cleanup
 * (see teardownFifoReader for the full mechanism), and several production exit
 * paths never call kill(): sendFatalWorkerErrorAndExit(), the
 * uncaughtException / unhandledRejection handlers, and the
 * existing-App-Server parent-exit branch all exit directly. Making the fix
 * depend on every caller remembering to tear down first would leave the
 * original wedge reachable, so the backend registers itself here and the
 * process-exit hook below is the backstop. Entries are removed on teardown, so
 * a normally-closed backend leaves nothing behind.
 */
const liveFifoReaders = new Set<TmuxPipeBackend>();
let fifoExitHookInstalled = false;

function installFifoExitHook(): void {
  if (fifoExitHookInstalled) return;
  fifoExitHookInstalled = true;
  // 'exit' only admits synchronous work — which is exactly what this is: one
  // write() plus one unlink() per reader. Cannot be an async cleanup.
  process.on('exit', () => {
    for (const backend of liveFifoReaders) {
      try { backend.wakeFifoReaderForExit(); } catch { /* best-effort */ }
    }
  });
}

/** Live fifo readers awaiting the exit-hook wake. Test-only: lets a regression
 *  assert that a failed spawn deregistered itself, which "the process exited"
 *  cannot show once the exit hook is in place. */
export function __testOnly_liveFifoReaderCount(): number {
  return liveFifoReaders.size;
}

export class TmuxPipeBackend implements SessionBackend {
  readonly supportsRawCommandPasteLine = true;
  /** Real tmux pane address (e.g. "0:2.0") or botmux session name (bmx-*). */
  private readonly paneTarget: string;
  private readonly fifoPath: string;
  private readStream: fs.ReadStream | null = null;
  /** Read end of the fifo, kept so teardown can close it explicitly.
   *  `createReadStream(..., { autoClose: false })` never closes it for us. */
  private fifoFd: number | null = null;
  /** Set once teardownFifoReader() has run, so the reader's own EBADF-on-close
   *  (see the 'error' handler) is recognised as expected teardown noise. Not
   *  `exited`: the spawn-failure path tears the reader down without ever
   *  marking the backend exited. */
  private fifoTornDown = false;
  /** Write end, opened at spawn() and held for the lifetime of the reader.
   *  Teardown writes one byte here to unblock the parked read (see
   *  teardownFifoReader). Acquired UP FRONT on purpose: opening it at teardown
   *  instead would need the pathname to still exist and a spare fd at the worst
   *  possible moment — both verified to fail and re-wedge the process (fifo
   *  already unlinked → ENOENT; fd table exhausted → EMFILE). */
  private fifoWakeFd: number | null = null;
  /** Streaming UTF-8 decoder. The fifo read emits raw Buffer chunks at libuv's
   *  64KB highWaterMark boundary, which can fall in the middle of a multi-byte
   *  character (CJK = 3 bytes, box-drawing = 3 bytes, emoji = 4 bytes). Decoding
   *  each chunk independently with `chunk.toString('utf8')` would split that
   *  character into U+FFFD replacement chars on both halves — one wide glyph
   *  becomes 2-3 garbage chars and every following column shifts right, which
   *  is the intermittent "错位" seen in the web terminal during heavy CLI
   *  re-renders (a full redraw is a big burst, far more likely to cross a 64KB
   *  boundary). StringDecoder holds the incomplete trailing bytes and prepends
   *  them to the next chunk, so a character split across reads is reassembled. */
  private readonly decoder = new StringDecoder('utf8');
  private readonly dataCbs: Array<(d: string) => void> = [];
  /** Bounded tail of the decoded output tmux most recently replicated from the
   *  pane (kept to the last RECENT_OUTPUT_MAX UTF-16 code units, not an exact
   *  byte count — fine for a diagnostic). Crash diagnostic: when a send fails
   *  because the pane vanished, capture-pane can no longer read the (now-gone)
   *  screen — but this text was already received over the pipe and is the
   *  CLI's actual final stdout/stderr (e.g. a gateway/API error) right before
   *  it exited. */
  private recentOutput = '';
  private static readonly RECENT_OUTPUT_MAX = 4096;
  private readonly exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
  private lifecycleTimer: NodeJS.Timeout | null = null;
  private lastUnknownProbeLogAt = 0;
  /** Debounce authoritative pane-missing replies. Probe timeouts / EMFILE /
   *  spawn failures are classified as unknown and never enter this destructive
   *  counter. (Adopted CLI pid-death stays decisive.) */
  private readonly livenessGate = new LivenessGate(ADOPT_LIVENESS_MAX_FAILURES);
  /** Consecutive lifecycle probes that did NOT answer 'exists' (missing OR
   *  unknown). Drives probe-interval backoff only — never a teardown decision:
   *  during a shared-server outage hundreds of workers re-probing every second
   *  are themselves part of the connect-storm that keeps the accept backlog
   *  overflowing. */
  private probeSetbackStreak = 0;
  /** Wall-clock start of an unbroken run of CONNECTION-level probe failures
   *  (see probePaneAddressability serverLevel). Connection failures are
   *  'unknown' and never trip the liveness gate — but a genuinely dead server
   *  also produces them forever, and its panes ARE dead. Escalate to pane-exit
   *  only after the server has been continuously unreachable for
   *  SERVER_OUTAGE_ESCALATE_MS. Cleared by any server-answered probe; probe
   *  timeouts leave it untouched (a wedged-but-alive server neither proves nor
   *  disproves the outage). */
  private serverUnreachableSince: number | null = null;
  private static readonly SERVER_OUTAGE_ESCALATE_MS = 60_000;
  private cols = 200;
  private rows = 50;
  private exited = false;
  /** Set after pipe-pane subscription is active so kill() knows to cancel it. */
  private pipeAttached = false;
  private readonly createSession: boolean;
  private readonly ownsSession: boolean;
  private readonly _isReattach: boolean;
  /** Adopt-mode CLI pid. Pane liveness alone is insufficient because the CLI
   *  can exit back to the user's shell while the tmux pane stays alive. */
  private readonly watchCliPid: number | undefined;

  /** Claude Code session JSONL path — set by worker for claude-code sessions so
   *  the claude-code adapter can verify paste+Enter submissions via file growth. */
  claudeJsonlPath?: string;
  /** PID of the spawned Claude Code child — used by the claude-code adapter to
   *  follow Claude's authoritative session id via ~/.claude/sessions/<pid>.json. */
  cliPid?: number;
  /** Working directory the CLI was spawned in — cross-checked against the pid
   *  file's cwd field so a recycled PID can't mislead the resolver. */
  cliCwd?: string;

  /** Whether this backend re-attached to an existing bmx-* tmux session
   *  (rather than creating a new detached one). Mirrors TmuxBackend.isReattach
   *  so the worker can branch on reattach behaviour without a private-cast. */
  get isReattach(): boolean {
    return this._isReattach;
  }

  constructor(paneTarget: string, opts?: { createSession?: boolean; ownsSession?: boolean; isReattach?: boolean; cliPid?: number }) {
    this.paneTarget = paneTarget;
    this.createSession = opts?.createSession ?? false;
    this.ownsSession = opts?.ownsSession ?? false;
    this._isReattach = opts?.isReattach ?? false;
    this.watchCliPid = opts?.cliPid;
    // Per-instance fifo so concurrent adopt sessions don't collide.
    this.fifoPath = join(tmpdir(), `botmux-pipe-${randomBytes(8).toString('hex')}.fifo`);
  }

  // ─── SessionBackend implementation ────────────────────────────────────────

  /** spawn() sets up the pipe-pane subscription + fifo reader. In managed
   *  mode it first creates a detached bmx-* tmux session that runs the CLI. */
  spawn(bin: string, args: string[], opts: SpawnOpts): void {
    // Self-heal a server polluted by a pre-upgrade botmux before we touch it
    // (once per daemon process; no-op on a server this build booted clean).
    // TmuxPipeBackend is the live backend on this path, so the scrub must be
    // triggered here — TmuxBackend is only used for its static helpers.
    TmuxBackend.scrubServerGlobalEnvOnce();
    this.cols = opts.cols;
    this.rows = opts.rows;

    if (this.createSession) {
      this.createDetachedSession(bin, args, opts);
    } else if (this.ownsSession && this._isReattach) {
      // Backfill tmux options on an existing bmx-* session — daemon may have
      // been upgraded since the session was originally created, and options
      // like set-clipboard / window-size largest are idempotent to re-apply.
      this.applySessionOptions();
    }

    // Step 1: create the fifo. mkfifo is POSIX; linux/darwin both have it.
    spawnSync('mkfifo', [this.fifoPath], { stdio: 'ignore' });

    // Step 2: open the read end with O_RDWR (no O_NONBLOCK).
    //
    // Why O_RDWR? Avoids the fifo open chicken-and-egg: opening O_RDONLY
    // alone blocks until a writer arrives, opening O_WRONLY alone blocks
    // until a reader arrives. Holding both ends ourselves makes either
    // peer's open() return immediately.
    //
    // Why NOT O_NONBLOCK? libuv's ReadStream issues blocking read() calls
    // from its threadpool — that's how it stays responsive without
    // burning CPU. With O_NONBLOCK the very first read() on an empty
    // fifo returns EAGAIN, which libuv surfaces as an error, and the
    // stream dies before tmux ever gets a chance to write a byte. (This
    // exact bug ate the bridge final_output pipeline on first ship: an
    // strace showed worker only read its IPC fd, never the fifo.)
    const fd = fs.openSync(this.fifoPath, fs.constants.O_RDWR);
    this.fifoFd = fd;
    // Acquire the wake-up write end NOW, while the pathname exists and the fd
    // table has room. Teardown must never need to allocate anything.
    // O_NONBLOCK so a full pipe fails with EAGAIN instead of parking here.
    //
    // FAIL CLOSED if this fails. Without a wake fd the reader can be unblocked
    // by nobody — not teardown, not the exit hook — so continuing would build
    // exactly the unkillable reader this whole fix exists to prevent (verified:
    // a wake-open failure alone re-wedges the process). This is also the only
    // moment where bailing is safe: the read stream does not exist yet, so no
    // read is parked and there is nothing to unblock. The failure modes all
    // mean the session is doomed anyway — EMFILE will sink the following
    // execSync(tmux …) too, and ENOENT means the fifo pathname is already gone.
    try {
      // Test seam: the fail-closed path below is only reachable when this open
      // fails, and EMFILE/ENOENT cannot be provoked from a test without
      // destabilising the whole process. The env var is read on every spawn but
      // is only ever set by this repo's own test, so production behaviour is
      // unchanged.
      if (process.env.BOTMUX_TEST_FORCE_WAKE_OPEN_FAIL === '1') {
        const injected: NodeJS.ErrnoException = new Error('EMFILE: injected by test');
        injected.code = 'EMFILE';
        throw injected;
      }
      this.fifoWakeFd = fs.openSync(this.fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    } catch (err) {
      this.fifoWakeFd = null;
      try { fs.closeSync(fd); } catch { /* best effort */ }
      this.fifoFd = null;
      try { fs.unlinkSync(this.fifoPath); } catch { /* best effort */ }
      throw err;
    }
    this.readStream = fs.createReadStream('', { fd, autoClose: false, highWaterMark: 64 * 1024 });
    // From here on a parked read can wedge process exit, so make this reader
    // reachable from the exit hook even if nothing ever calls kill().
    installFifoExitHook();
    liveFifoReaders.add(this);

    this.readStream.on('data', (chunk) => {
      // StringDecoder reassembles multi-byte chars split across chunk
      // boundaries (see `decoder` field doc). A string chunk would only
      // appear if the stream were created with an encoding — it isn't, but
      // keep the guard so the decoder path stays the single source of truth.
      const data = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
      if (data) {
        this.recentOutput = (this.recentOutput + data).slice(-TmuxPipeBackend.RECENT_OUTPUT_MAX);
      }
      for (const cb of this.dataCbs) {
        try { cb(data); } catch { /* listener crash shouldn't kill the stream */ }
      }
    });
    this.readStream.on('error', (err: any) => {
      // Teardown noise, not a fault: destroy() closes the read fd itself when
      // no read is in flight (despite autoClose:false), so our own backstop
      // close races it and the stream reports EBADF on a reader we are
      // deliberately dismantling. Logging it would put a scary line in every
      // worker's stderr on every normal close.
      if (this.fifoTornDown && err?.code === 'EBADF') return;
      // Errors are best-effort logged via the worker's stderr (we can't
      // pull a logger in a backend without circular imports). Don't fire
      // exit — the user's CLI is still alive, we just lost realtime view.
      process.stderr.write(`[tmux-pipe-backend] read error: ${err?.message ?? err}\n`);
    });

    // Step 3: ask tmux to replicate the pane's bytes into our fifo.
    // -O causes tmux to overwrite any prior pipe-pane subscription.
    // The shell command must redirect to the fifo; tmux runs it via /bin/sh.
    // Bounded retries: this exact command failing with an instant clean
    // connect error during a shared-server stall / restart herd is what turned
    // the 2026-08-20 outage into user-visible "会话启动失败" across chats.
    // Retrying is idempotent (-O overwrites any prior subscription); a
    // deterministic server-answered rejection (pane genuinely gone) is
    // re-thrown at once instead of delaying the same failure.
    for (let attempt = 0; ; attempt++) {
      try {
        execSync(
          `tmux pipe-pane -O -t ${shellescape(this.paneTarget)} 'cat > ${shellescape(this.fifoPath)}'`,
          { stdio: ['ignore', 'ignore', 'pipe'], timeout: 5000, env: tmuxEnv() },
        );
        this.pipeAttached = true;
        this.startLifecycleWatcher();
        break;
      } catch (err: any) {
        if (!isRetryableStartupTmuxFailure(err) || attempt >= STARTUP_TMUX_RETRY_DELAYS_MS.length) {
          // The fifo reader is already live (step 2) with a blocking read parked
          // on it. Throwing out of spawn() without this leaves that read alive
          // forever and wedges the process at exit exactly like the bug
          // teardownFifoReader() exists to prevent — the caller only sees a
          // failed spawn and has no handle to clean up.
          this.teardownFifoReader();
          this.fireExit(1, null);
          throw err;
        }
        const detail = (err?.stderr?.toString?.() ?? '').trim() || err?.message || String(err);
        process.stderr.write(
          `[tmux-pipe-backend] pipe-pane attach failed (attempt ${attempt + 1}/${STARTUP_TMUX_RETRY_DELAYS_MS.length + 1}); retrying: ${detail}\n`,
        );
        startupRetrySleepFn(STARTUP_TMUX_RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  write(data: string): boolean {
    // No PTY to write to — interpret as a literal send-keys.
    return this.sendText(data);
  }

  sendText(text: string): boolean {
    if (this.exited) return false;
    this.exitCopyModeIfNeeded();
    return this.guardedSend('send-keys (text)', () => {
      execFileSync('tmux', ['send-keys', '-t', this.paneTarget, '-l', '--', text], {
        stdio: 'ignore',
        timeout: 5000,
        env: tmuxEnv(),
      });
    });
  }

  sendSpecialKeys(...keys: string[]): boolean {
    if (this.exited) return false;
    this.exitCopyModeIfNeeded();
    return this.guardedSend(`send-keys ${keys.join(' ')}`, () => {
      execFileSync('tmux', ['send-keys', '-t', this.paneTarget, ...keys], {
        stdio: 'ignore',
        timeout: 5000,
        env: tmuxEnv(),
      });
    });
  }

  /**
   * Paste text into the pane via load-buffer + paste-buffer.
   * The -p flag asks tmux to wrap the buffer in bracketed-paste markers
   * (\e[200~ … \e[201~) when the application has requested bracketed paste.
   * This is REQUIRED for CoCo/Ink: without the markers the TUI treats the
   * paste as a rapid input burst and swallows the trailing Enter as a soft
   * newline, stranding the message in the input box (it then gets submitted
   * by the *next* paste — the "replies to the previous message" off-by-one).
   * NB: this is the default/local tmux runtime backend path (see
   * selectSessionBackend), not the only backend type in the repo.
   */
  pasteText(text: string): boolean {
    if (this.exited) return false;
    this.exitCopyModeIfNeeded();
    const bufferName = `botmux-${randomBytes(8).toString('hex')}`;
    return this.guardedSend('paste-buffer', () => {
      let loaded = false;
      try {
        execFileSync('tmux', ['load-buffer', '-b', bufferName, '-'], {
          input: text,
          stdio: ['pipe', 'ignore', 'ignore'],
          timeout: 5000,
          env: tmuxEnv(),
        });
        loaded = true;
        execFileSync('tmux', ['paste-buffer', '-b', bufferName, '-t', this.paneTarget, '-d', '-p'], {
          stdio: 'ignore',
          timeout: 5000,
          env: tmuxEnv(),
        });
        loaded = false;
      } finally {
        if (loaded) {
          try {
            execFileSync('tmux', ['delete-buffer', '-b', bufferName], {
              stdio: 'ignore',
              timeout: 1000,
              env: tmuxEnv(),
            });
          } catch { /* best-effort cleanup after a failed paste */ }
        }
      }
    });
  }

  /**
   * Run a tmux write (send-keys / load-buffer / paste-buffer) that must never
   * crash the worker on failure.
   *
   * Background: when the CLI process exits mid-write its tmux session/pane is
   * destroyed, so the very next `tmux send-keys` returns exit 1. The 1s
   * lifecycle watcher hasn't fired yet, so `this.exited` is still false and the
   * guard above doesn't help. Previously execFileSync's synchronous throw
   * propagated through writeInput → flushPending (a fire-and-forget async with
   * no .catch) → unhandledRejection, which killed the entire worker process
   * (and with it every Lark session it served).
   *
   * Classify the failure instead of letting it escape:
   *   - pane GONE  → the CLI exited; convert to a normal onExit so the worker
   *                  tears the session down and tells the user "CLI exited",
   *                  exactly like the lifecycle watcher would have.
   *   - pane ALIVE → a transient tmux hiccup; log and drop the keystroke. The
   *                  claude-code adapter's JSONL retry/verify loop will catch a
   *                  non-submission and surface a submit-failure notice.
   *
   * Either way this method never throws — every send-keys caller (web-terminal
   * keys, TUI input, the typing loop) stays crash-safe without its own guard.
   *
   * Returns true when the write succeeded, false when it was dropped (pane gone
   * or a pane-alive hiccup). Callers that verify submission (runner adapters)
   * read this to report a non-submission; the many fire-and-forget callers
   * (web-terminal keys, copy-mode) just ignore it.
   */
  private guardedSend(op: string, run: () => void): boolean {
    try {
      run();
      return true;
    } catch (err: any) {
      // A kill()/handlePaneExit() may have flipped exited between the guard
      // and here; if so the teardown already happened.
      if (this.exited) return false;
      const paneProbe = this.probePaneAddressability(2000);
      process.stderr.write(
        `[tmux-pipe-backend] ${op} failed (pane ${paneProbe.state.toUpperCase()}): ${err?.message ?? err}\n`,
      );
      if (paneProbe.state === 'missing') {
        // Diagnostic: the pane is gone, so capture-pane can't read the final
        // screen. Instead dump the tail tmux already replicated over the pipe
        // — the CLI's real last stdout/stderr before it exited, which often
        // explains WHY it exited (e.g. a gateway/API error line).
        const tail = this.recentOutput.trim();
        if (tail) {
          process.stderr.write(`[tmux-pipe-backend] CLI last output before exit (tail):\n${tail}\n`);
        }
        this.handlePaneExit();
      }
      return false;
    }
  }

  private exitCopyModeIfNeeded(): void {
    if (this.exited) return;

    try {
      const inMode = execFileSync('tmux', ['display-message', '-p', '-t', this.paneTarget, '#{pane_in_mode}'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
        env: tmuxEnv(),
      }).trim();

      if (inMode === '1') {
        execFileSync('tmux', ['send-keys', '-t', this.paneTarget, '-X', 'cancel'], {
          stdio: 'ignore',
          timeout: 1000,
          env: tmuxEnv(),
        });
      }
    } catch {
      // Pane may be gone or tmux may be restarting; keep the original write path best-effort.
    }
  }

  enterCopyMode(): void {
    if (this.exited) return;
    execFileSync('tmux', ['copy-mode', '-e', '-t', this.paneTarget], {
      stdio: 'ignore',
      timeout: 5000,
      env: tmuxEnv(),
    });
  }

  sendCopyModeCommand(xCommand: string): void {
    if (this.exited) return;
    execFileSync('tmux', ['send-keys', '-t', this.paneTarget, '-X', xCommand], {
      stdio: 'ignore',
      timeout: 5000,
      env: tmuxEnv(),
    });
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.ownsSession) {
      execFileSync('tmux', ['resize-window', '-t', this.paneTarget, '-x', String(cols), '-y', String(rows)], {
        stdio: 'ignore',
        timeout: 5000,
        env: tmuxEnv(),
      });
    }
  }

  onData(cb: (data: string) => void): void {
    this.dataCbs.push(cb);
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCbs.push(cb);
  }

  kill(): void {
    if (this.exited) return;
    this.exited = true;
    this.stopLifecycleWatcher();
    // Cancel tmux's pipe subscription. Calling pipe-pane without a command
    // turns it off for the target pane.
    if (this.pipeAttached) {
      try {
        execSync(`tmux pipe-pane -t ${shellescape(this.paneTarget)}`, { stdio: 'ignore', timeout: 3000, env: tmuxEnv() });
      } catch { /* pane may already be gone — benign */ }
      this.pipeAttached = false;
    }
    this.teardownFifoReader();
  }

  destroySession(): void {
    this.kill();
    if (this.ownsSession) {
      TmuxBackend.killSession(this.paneTarget);
    }
  }

  getChildPid(): number | null {
    try {
      const out = execSync(
        `tmux display-message -p -t ${shellescape(this.paneTarget)} '#{pane_pid}'`,
        // Explicit stdio: execSync's default leaks the child's stderr to the
        // parent — when tmux server is unavailable this would spam
        // "error connecting to /tmp/tmux-UID/default" into daemon-error.log
        // every poll. Capture stderr in the result instead.
        // tmuxEnv() also strips $TMUX so we don't target a dead parent server.
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000, env: tmuxEnv() },
      ).trim();
      const pid = parseInt(out, 10);
      return pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  getAttachInfo() {
    return null;
  }

  // ─── Pipe-specific helpers ────────────────────────────────────────────────

  private startLifecycleWatcher(): void {
    this.stopLifecycleWatcher();
    this.livenessGate.reset();
    this.probeSetbackStreak = 0;
    this.serverUnreachableSince = null;
    const poll = () => {
      if (this.exited) return;
      // The watched CLI pid (adopt mode) is a pure process.kill(pid,0) syscall —
      // it can only report ESRCH (gone) or EPERM (alive), never a transient
      // timeout / EMFILE failure. So pid-death is DECISIVE: tear down at once.
      // This keeps the ≤1s guard against routing Lark input into the user's bare
      // shell after the CLI exits to a still-alive pane. Only the flaky pane
      // probe below gets debounced.
      if (!this.isCliPidAlive()) {
        process.stderr.write(`[tmux-pipe-backend] adopted CLI pid ${this.watchCliPid} exited; detaching observer\n`);
        this.handlePaneExit();
        return;
      }
      const probe = this.probePaneAddressability(2000);
      this.probeSetbackStreak = probe.state === 'exists' ? 0 : this.probeSetbackStreak + 1;
      this.recordPaneProbe(probe);
      if (!this.exited) this.lifecycleTimer = setTimeout(poll, this.nextProbeDelayMs());
    };
    this.lifecycleTimer = setTimeout(poll, tmuxLifecycleInitialDelayMs(this.paneTarget));
  }

  /**
   * Probe-interval backoff: 1s while healthy, then 3s / 9s (capped) while probes
   * keep NOT answering 'exists'. Two purposes:
   *   - stretches the missing-streak teardown window from ~3s to ~13s+, so a
   *     short shared-server stall no longer converts into a fleet-wide teardown;
   *   - sheds probe load exactly when the shared server is struggling — the
   *     per-second re-probes from every worker are themselves connect-storm fuel
   *     (each refused connect frees a backlog slot another worker instantly
   *     takes).
   * Detection latency for a genuinely dead pane grows to ~13s worst-case, which
   * is acceptable: writes still fail fast via guardedSend (its own probe fires
   * teardown immediately when the pane is authoritatively gone), and adopt-mode
   * pid-death above stays on the ≤ current-interval path.
   */
  private nextProbeDelayMs(): number {
    if (this.probeSetbackStreak <= 0) return 1000;
    return Math.min(1000 * 3 ** this.probeSetbackStreak, 9000);
  }

  /**
   * Tri-state pane probe. A clean tmux rejection that the SERVER actually
   * answered is `missing`; timeout, signal, EMFILE/ENFILE and spawn failures
   * are `unknown`, because the shared server never answered. Collapsing those
   * into false caused every worker to destroy a live bmx-* session when the
   * default server had a short outage.
   *
   * CONNECTION-level clean failures ("error connecting to <socket>", "lost
   * server" — see isTmuxServerLevelErrorText) are `unknown` too, flagged
   * `serverLevel` so the caller can run the dead-server escalation clock: a
   * briefly stalled server refuses connects instantly (unix-socket backlog
   * overflow ⇒ clean ECONNREFUSED), which is indistinguishable from a missing
   * pane by exit status alone. Misreading it as `missing` mass-tore-down every
   * live session across all bots at once (2026-08-20 incident).
   */
  private probePaneAddressability(timeoutMs: number): { state: SessionProbe; reason?: string; serverLevel?: boolean } {
    try {
      const paneId = execFileSync(
        'tmux', ['display-message', '-p', '-t', this.paneTarget, '#{pane_id}'],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs, env: tmuxEnv() },
      ).trim();
      return { state: paneId.length > 0 ? 'exists' : 'missing', reason: paneId.length > 0 ? undefined : 'empty pane id' };
    } catch (err: any) {
      // Deadline first: a timed-out probe can carry a clean numeric exit when
      // the client's completion races the kill (isExecTimeoutError). That is
      // "no answer", never an authoritative 'missing'.
      if (isExecTimeoutError(err)) {
        return { state: 'unknown', reason: 'probe deadline (ETIMEDOUT)' };
      }
      if (err && typeof err.status === 'number' && !err.signal) {
        const stderr = (err.stderr?.toString?.() ?? '').trim();
        if (isTmuxServerLevelErrorText(stderr)) {
          return { state: 'unknown', reason: stderr, serverLevel: true };
        }
        return { state: 'missing', reason: stderr || `tmux display-message exited ${err.status}` };
      }
      const detail = (err?.stderr?.toString?.() ?? '').trim()
        || err?.code
        || err?.signal
        || err?.message
        || 'tmux probe got no answer';
      return { state: 'unknown', reason: String(detail) };
    }
  }

  /**
   * Debounce authoritative pane-missing replies. Tearing down on the FIRST
   * failed probe used to produce spurious disconnects; worse, timeout/EMFILE
   * were collapsed into the same boolean false and could accumulate to the
   * threshold. Unknown results now keep the session attached and reset the
   * destructive streak. Only consecutive `missing` replies plus a final
   * `missing` confirmation detach the observer. Any success resets.
   * (pid-death is handled decisively in the watcher — see startLifecycleWatcher.)
   */
  private recordPaneProbe(probe: { state: SessionProbe; reason?: string; serverLevel?: boolean }): void {
    if (this.exited) return;
    if (probe.state === 'unknown') {
      // Unknown is not evidence of death. Reset the destructive streak so a
      // timeout cannot combine with later unrelated misses, and rate-limit the
      // diagnostic because every managed worker polls this shared server.
      this.livenessGate.reset();
      if (probe.serverLevel) {
        // Connection-level failure: could be a live-but-stalled server (ride it
        // out) or a genuinely dead one (its panes died with it). Run the
        // escalation clock — only an UNBROKEN run of connection failures longer
        // than SERVER_OUTAGE_ESCALATE_MS declares the server (and this pane)
        // dead. Probe timeouts deliberately don't clear the clock: a wedged
        // server never produced an answer either way.
        if (this.serverUnreachableSince === null) {
          this.serverUnreachableSince = Date.now();
        } else if (Date.now() - this.serverUnreachableSince >= TmuxPipeBackend.SERVER_OUTAGE_ESCALATE_MS) {
          process.stderr.write(
            `[tmux-pipe-backend] tmux server continuously unreachable for ${Math.round((Date.now() - this.serverUnreachableSince) / 1000)}s; declaring ${this.ownsSession ? 'managed' : 'adopted'} pane dead (${probe.reason ?? 'connection error'})\n`,
          );
          this.handlePaneExit();
          return;
        }
      }
      const now = Date.now();
      if (now - this.lastUnknownProbeLogAt >= 30_000) {
        this.lastUnknownProbeLogAt = now;
        process.stderr.write(
          `[tmux-pipe-backend] tmux pane probe unavailable; keeping ${this.ownsSession ? 'managed' : 'adopted'} session attached (${probe.reason ?? 'unknown error'})\n`,
        );
      }
      return;
    }

    // Server answered (exists OR authoritative missing) — the outage clock
    // only measures unbroken connection-level silence.
    this.serverUnreachableSince = null;

    const alive = probe.state === 'exists';
    if (!this.livenessGate.record(alive)) {
      if (probe.state === 'missing') {
        process.stderr.write(
          `[tmux-pipe-backend] ${this.ownsSession ? 'managed' : 'adopted'} pane missing (${this.livenessGate.consecutiveFailures}/${ADOPT_LIVENESS_MAX_FAILURES}); retrying before teardown\n`,
        );
      }
      return;
    }
    // Threshold reached — one final authoritative probe with a more lenient
    // timeout so a transiently overloaded tmux server gets a fair chance to
    // answer before we detach a pane that's actually still alive.
    const confirm = this.probePaneAddressability(3000);
    if (confirm.state !== 'missing') {
      this.livenessGate.reset();
      process.stderr.write(
        `[tmux-pipe-backend] pane ${confirm.state === 'exists' ? 'recovered' : 'probe remained unavailable'} on final check; staying attached${confirm.reason ? ` (${confirm.reason})` : ''}\n`,
      );
      return;
    }
    // Server-level circuit breaker: destroying worker/session state over a
    // "missing" verdict is only safe when the SERVER is not merely UNREACHABLE.
    // The cross-check distinguishes the server's two failure modes:
    //   - 'unreachable' (connect refused / lost server / timeout / spawn fail):
    //     the client never reached the server, which may be a live-but-stalled
    //     shared server — stay attached and let the outage clock run.
    //   - 'down' ("no server running"): the server answered that it is not
    //     running. For a SOLE-SESSION socket that happens precisely BECAUSE
    //     this pane died (its session was the server's last, so the server
    //     exited) — the pane is authoritatively gone, so fall through to
    //     teardown. Collapsing 'down' into "not answering" hung a sole-session
    //     worker forever: the authoritative-missing branch above reset
    //     serverUnreachableSince every probe, so the 60s escalation never
    //     accrued and this cross-check blocked teardown on every pass.
    const reach = TmuxPipeBackend.tmuxServerReachability(3000);
    if (reach === 'unreachable') {
      this.livenessGate.reset();
      if (this.serverUnreachableSince === null) this.serverUnreachableSince = Date.now();
      process.stderr.write(
        `[tmux-pipe-backend] pane reported missing but tmux server is not answering; treating as server outage and staying attached\n`,
      );
      return;
    }
    process.stderr.write(
      `[tmux-pipe-backend] ${this.ownsSession ? 'managed' : 'adopted'} pane gone after ${ADOPT_LIVENESS_MAX_FAILURES} consecutive authoritative misses; detaching observer\n`,
    );
    this.handlePaneExit();
  }

  /** Three-state server reachability cross-check. A running server always has
   *  at least one session (tmux exits when its last session closes), so a clean
   *  `list-sessions` success ⇒ 'up'. The two failure modes must NOT be
   *  collapsed, or the pre-teardown cross-check hangs a sole-session worker:
   *   - 'down': the server answered that it is not running ("no server
   *     running"). Authoritative; for a sole-session socket this happens
   *     because the pane died. Teardown is safe.
   *   - 'unreachable': connect refused / lost server / timeout / spawn failure
   *     — the client never got an answer, so the server may be live-but-stalled.
   *     Stay attached.
   *  Uses the same connection-level classifier as the pane probe so both agree
   *  on what "the client never reached the server" looks like. Never
   *  destructive on its own. */
  private static tmuxServerReachability(timeoutMs: number): 'up' | 'down' | 'unreachable' {
    try {
      execFileSync('tmux', ['list-sessions'], {
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: timeoutMs,
        env: tmuxEnv(),
      });
      return 'up';
    } catch (err: any) {
      // Deadline first — same race as probePaneAddressability: a clean exit
      // status attached to an ETIMEDOUT throw is still "no answer".
      if (isExecTimeoutError(err)) return 'unreachable';
      if (err && typeof err.status === 'number' && !err.signal) {
        const stderr = (err.stderr?.toString?.() ?? '').trim();
        // Connection-level wording ("error connecting", "lost server") ⇒ the
        // client never reached the server ⇒ unreachable. Anything else the
        // server actually answered — "no server running" included ⇒ down.
        return isTmuxServerLevelErrorText(stderr) ? 'unreachable' : 'down';
      }
      // Timeout (signal/killed) or spawn failure (ENOENT/EACCES — no numeric
      // exit status) ⇒ no answer ever reached us.
      return 'unreachable';
    }
  }

  private stopLifecycleWatcher(): void {
    if (this.lifecycleTimer) {
      clearInterval(this.lifecycleTimer);
      this.lifecycleTimer = null;
    }
  }

  /**
   * Tear down the fifo reader so this process can actually exit.
   *
   * `readStream.destroy()` alone is NOT enough, and getting this wrong wedges
   * the whole worker: libuv services the (deliberately blocking, see spawn())
   * fifo read from its threadpool, and destroy() only detaches the JS stream —
   * the threadpool thread stays parked inside the kernel `read()`. Because we
   * hold the fifo O_RDWR, a writer always exists, so that read never sees EOF
   * and never returns. `process.exit()` then blocks forever in
   * uv__threadpool_cleanup joining that thread, with the event loop already
   * stopped so the process cannot even self-kill on a timer. Observed in
   * production as every worker of a daemon stuck mid-exit: the daemon still
   * considered them live and kept delivering turns, so each message came back
   * as "Worker 未能接收这条消息" (worker.input_delivery_failed) forever.
   *
   * The wake-up byte is what unblocks that read. It goes through a SEPARATE
   * write fd (never our own O_RDWR one) opened back in spawn(): at teardown
   * nobody is draining the pipe any more, so if tmux left it full a blocking
   * write would hang exactly like the bug we are fixing (verified). That fd is
   * acquired UP FRONT rather than here because teardown is precisely when
   * acquiring one can fail — the fifo may already be unlinked (ENOENT) or the
   * fd table exhausted (EMFILE), and both were verified to re-wedge the
   * process while the old code silently swallowed the error. The byte is never
   * observed by callers: the stream is destroyed first, so nothing reads it and
   * it dies with the fifo on the unlink below.
   */
  /**
   * Last-resort unblock for the process-exit hook.
   *
   * Writes the wake-up byte so the parked threadpool read can return and
   * uv__threadpool_cleanup can join it, then unlinks the fifo: a named fifo is
   * a filesystem object and outlives the process, so skipping this would strew
   * /tmp with botmux-pipe-* on every exit that bypasses teardown. Deliberately
   * minimal otherwise — no stream teardown, nothing that could block. Safe
   * after a real teardown (fifoWakeFd is null by then) and safe to call twice.
   */
  wakeFifoReaderForExit(): void {
    if (this.fifoWakeFd === null) return;
    try { fs.writeSync(this.fifoWakeFd, '\0'); } catch { /* already unblocked */ }
    try { fs.unlinkSync(this.fifoPath); } catch { /* already gone */ }
  }

  private teardownFifoReader(): void {
    liveFifoReaders.delete(this);
    this.fifoTornDown = true;
    if (this.readStream) {
      try { this.readStream.destroy(); } catch { /* already closed */ }
      this.readStream = null;
    }
    if (this.fifoWakeFd !== null) {
      // EAGAIN (pipe full) is fine: a full pipe means the read already has data
      // to return, so it is not parked. Any other error is equally non-fatal —
      // we are tearing down regardless.
      try { fs.writeSync(this.fifoWakeFd, '\0'); } catch { /* already unblocked */ }
      try { fs.closeSync(this.fifoWakeFd); } catch { /* already closed */ }
      this.fifoWakeFd = null;
    }
    if (this.fifoFd !== null) {
      // Closing the read fd is nominally ours (autoClose:false), but destroy()
      // DOES close it itself when no read is in flight — verified: after a
      // synchronous destroy() the fd is already EBADF. So this close is a
      // best-effort backstop for the in-flight case, and EBADF here is the
      // normal, expected outcome rather than a fault. Clear the field first so
      // a late 'error' handler re-entering teardown cannot close it twice (by
      // then the number could name a freshly-opened unrelated file).
      const fd = this.fifoFd;
      this.fifoFd = null;
      try { fs.closeSync(fd); } catch { /* stream already closed it */ }
    }
    try { fs.unlinkSync(this.fifoPath); } catch { /* already gone */ }
  }

  private handlePaneExit(): void {
    if (this.exited) return;
    this.exited = true;
    this.stopLifecycleWatcher();
    if (this.pipeAttached) {
      try {
        execSync(`tmux pipe-pane -t ${shellescape(this.paneTarget)}`, { stdio: 'ignore', timeout: 3000, env: tmuxEnv() });
      } catch { /* pane may already be gone — benign */ }
      this.pipeAttached = false;
    }
    this.teardownFifoReader();
    this.fireExit(1, null);
  }

  private createDetachedSession(bin: string, args: string[], opts: SpawnOpts): void {
    const shellSpec = resolveUserShell(process.env, opts.launchShell);
    const envAssignments = buildBotmuxEnvAssignments(opts.env, opts.injectEnv);
    const script = shellWrapperScript(
      resolveBotmuxWrapperBinDir(opts.env ?? process.env),
      shellKindForPath(shellSpec.shell),
    );
    const argv = [
      'new-session',
      '-d',
      '-s', this.paneTarget,
      '-x', String(opts.cols),
      '-y', String(opts.rows),
      '--',
      ...shellCommandArgv(shellSpec, script, [
        opts.cwd,
        ...envAssignments,
        bin, ...args,
      ]),
    ];
    // Bounded retries against a stalled shared server (instant clean
    // ECONNREFUSED under backlog overflow), a command timeout, or a
    // spawn-level EMFILE/EAGAIN. A server-answered deterministic rejection
    // (bad option, …) is re-thrown at once. "duplicate session" on a RETRY
    // means an earlier timed-out attempt actually created the session
    // server-side → treat as success.
    for (let attempt = 0; ; attempt++) {
      try {
        execFileSync('tmux', argv, {
          cwd: opts.cwd,
          stdio: ['ignore', 'ignore', 'pipe'],
          timeout: 5000,
          env: tmuxEnv(opts.env),
        });
        break;
      } catch (err: any) {
        const stderrText = (err?.stderr?.toString?.() ?? '').trim();
        if (attempt > 0 && /duplicate session/i.test(stderrText)) break;
        if (!isRetryableStartupTmuxFailure(err) || attempt >= STARTUP_TMUX_RETRY_DELAYS_MS.length) throw err;
        process.stderr.write(
          `[tmux-pipe-backend] new-session failed (attempt ${attempt + 1}/${STARTUP_TMUX_RETRY_DELAYS_MS.length + 1}); retrying: ${stderrText || err?.message || err}\n`,
        );
        startupRetrySleepFn(STARTUP_TMUX_RETRY_DELAYS_MS[attempt]);
      }
    }
    this.applySessionOptions();
  }

  private applySessionOptions(): void {
    const t = shellescape(this.paneTarget);
    const env = tmuxEnv();
    try {
      // status bar ON: shows tmux's window list so a user who manually
      // `tmux attach -t <session>`es can navigate windows. Zero effect on the
      // Lark card / web terminal — both read PANE bytes (capture-pane /
      // pipe-pane), while the status bar is a client-level overlay that never
      // enters the pane stream (and capture-pane never includes it). The
      // original `status off` was a defensive guard from the early
      // capture-screenshot backend; verified geometry-neutral on the pipe
      // backend (toggling status on a detached session changes neither pane
      // size nor cursor), so it's safe to default ON.
      // Bounded: these are cosmetic and best-effort, but without a timeout a
      // wedged shared server would pin the worker's startup path indefinitely.
      execSync(`tmux set-option -t ${t} status on`, { stdio: 'ignore', env, timeout: 5000 });
      execSync(`tmux set-option -t ${t} mouse on`, { stdio: 'ignore', env, timeout: 5000 });
      execSync(`tmux set-option -s set-clipboard on`, { stdio: 'ignore', env, timeout: 5000 });
      execSync(`tmux set-option -t ${t} history-limit 50000`, { stdio: 'ignore', env, timeout: 5000 });
      execSync(`tmux set-option -t ${t} window-size largest`, { stdio: 'ignore', env, timeout: 5000 });
    } catch { /* session may not be ready yet — benign */ }
  }

  /** Snapshot the full pane history WITH ANSI escapes (`-S - -E -`).
   *
   *  Used by web reattach so a brand-new web client sees the whole prior
   *  conversation. For the screenshot / screen_update fast path use
   *  `captureViewport()` instead — that one only returns the visible pane
   *  and is safe to seed a transient xterm-headless with.
   *
   *  IMPORTANT: tmux capture-pane separates rows with bare `\n`, no `\r`.
   *  xterm.js (and any VT100-compliant emulator) treats a bare LF as
   *  "move down one row, keep column" — every captured line lands further
   *  to the right than the previous one. Normalising every `\n` to `\r\n`
   *  makes the snapshot render correctly. The live pipe-pane stream itself
   *  doesn't need this fix — applications write proper `\r\n`. */
  captureCurrentScreen(): string {
    return this.captureWithBounds('-S - -E -', { restoreCursor: true });
  }

  /** Escape sequence re-asserting the pane's live input modes (mouse tracking,
   *  app cursor keys, cursor visibility) on a fresh web-terminal xterm. The
   *  worker appends this to write-capable clients' capture-pane seed — without
   *  it a mouse-mode TUI (grok build enables 1003+1006) never receives clicks,
   *  so double-click-to-expand etc. silently do nothing in the web terminal.
   *  Empty string when the pane is gone or tmux can't be queried. */
  capturePaneInputModes(): string {
    if (this.exited) return '';
    try {
      const out = execSync(
        `tmux display-message -p -t ${shellescape(this.paneTarget)} ${shellescape(PANE_MODE_FLAGS_FORMAT)}`,
        // Explicit stdio — see getChildPid for why default leaks tmux stderr.
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000, env: tmuxEnv() },
      );
      const modes = parsePaneModeFlags(out);
      return modes ? paneInputModeSeed(modes) : '';
    } catch {
      return '';
    }
  }

  /** Snapshot ONLY the currently visible pane (no scrollback). Equivalent to
   *  `tmux capture-pane` with no `-S`/`-E` flags, which defaults to the
   *  viewport. This is the right input for a transient xterm-headless seed:
   *  the snapshot row count matches the transient terminal's row count, so
   *  no normal-buffer scroll happens and the rendered screenshot lines up
   *  with what the user is seeing in the web terminal right now. */
  captureViewport(): string {
    // No `-S`/`-E` flags = tmux default = current viewport only.
    return this.captureWithBounds('');
  }

  captureInputState(): {
    viewport: string;
    cursor: { x: number; y: number };
  } | null {
    if (this.exited) return null;
    const cursor = this.getCursorPosition();
    if (!cursor) return null;
    try {
      const viewport = execFileSync(
        'tmux', ['capture-pane', '-p', '-t', this.paneTarget],
        {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 2000,
          maxBuffer: 16 * 1024 * 1024,
          env: tmuxEnv(),
        },
      );
      return { viewport, cursor };
    } catch {
      return null;
    }
  }

  private captureWithBounds(bounds: string, opts?: { restoreCursor?: boolean }): string {
    if (this.exited) return '';
    try {
      const altOn = this.isPaneInAltBuffer();
      const raw = execSync(
        `tmux capture-pane -e -p -t ${shellescape(this.paneTarget)}${bounds ? ' ' + bounds : ''}`,
        // Explicit stdio — see getChildPid for why default leaks tmux stderr.
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: tmuxEnv() },
      );
      const normalised = normaliseCaptureLineEndings(raw);
      const body = opts?.restoreCursor
        ? composeSeedBody(normalised, this.getCursorPosition())
        : normalised;

      if (altOn) {
        // The pane's CLI (e.g. Claude Code, vim) is in the alternate screen
        // buffer. capture-pane returns the alt-buffer's content but no
        // mode-switch escape sequence — we have to bracket the snapshot
        // with `enter alt screen + home + clear` so xterm.js renders it in
        // the alt buffer instead of leaking it into the main buffer where
        // it would persist after the application exits.
        return `\x1b[?1049h\x1b[H\x1b[2J${body}`;
      }
      return body;
    } catch {
      return '';
    }
  }

  /** Current pane cursor position (0-based, viewport-relative — matches xterm
   *  CUP semantics). Used to restore the cursor in the web-terminal seed so the
   *  CLI's first height-relative redraw lands on the right row. */
  private getCursorPosition(): { x: number; y: number } | null {
    if (this.exited) return null;
    try {
      const out = execSync(
        `tmux display-message -p -t ${shellescape(this.paneTarget)} '#{cursor_x} #{cursor_y}'`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000, env: tmuxEnv() },
      ).trim();
      const [x, y] = out.split(/\s+/).map(s => parseInt(s, 10));
      if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0) return { x, y };
      return null;
    } catch {
      return null;
    }
  }

  /** Current real tmux pane dimensions. Drives transient-renderer sizing so
   *  the screenshot canvas matches whatever the web client resized the pane
   *  to. Returns null if tmux can't be queried (pane gone, server gone). */
  getPaneSize(): { cols: number; rows: number } | null {
    if (this.exited) return null;
    try {
      const out = execSync(
        `tmux display-message -p -t ${shellescape(this.paneTarget)} '#{pane_width} #{pane_height}'`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000, env: tmuxEnv() },
      ).trim();
      const [cols, rows] = out.split(/\s+/).map(s => parseInt(s, 10));
      if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
        return { cols, rows };
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Cheap probe: is the adopted pane currently in the alternate screen
   *  buffer? Used by captureCurrentScreen to decide whether the snapshot
   *  needs an alt-buffer-enter prefix for correct rendering. */
  private isPaneInAltBuffer(): boolean {
    try {
      const out = execSync(
        `tmux display-message -p -t ${shellescape(this.paneTarget)} '#{alternate_on}'`,
        // Explicit stdio — see getChildPid for why default leaks tmux stderr.
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000, env: tmuxEnv() },
      ).trim();
      return out === '1';
    } catch {
      return false;
    }
  }

  /** True if the underlying pane is still addressable in tmux. Cheap check —
   *  used by callers to detect "user closed the pane while we were piping". */
  isPaneAlive(): boolean {
    if (this.exited) return false;
    return this.probePaneAddressability(2000).state === 'exists';
  }

  /** Unknown pid → pane-only liveness. EPERM still means the process exists. */
  private isCliPidAlive(): boolean {
    if (this.watchCliPid === undefined) return true;
    try {
      process.kill(this.watchCliPid, 0);
      return true;
    } catch (err: any) {
      return err?.code === 'EPERM';
    }
  }

  private fireExit(code: number | null, signal: string | null): void {
    for (const cb of this.exitCbs) {
      try { cb(code, signal); } catch { /* listener crash is benign */ }
    }
  }
}
