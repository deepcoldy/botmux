/**
 * TmuxPipeBackend — observe a user-owned tmux pane WITHOUT attaching to its
 * session. Used by /adopt mode to avoid the renderer conflict that arises
 * when a normal `tmux attach-session` client coexists with a tmux -CC
 * (iTerm2 control mode) client on the same server (interleaved ANSI vs
 * control-protocol writes corrupt cursor / status-bar / alt-screen state).
 *
 * Architecture (no PTY, no attach):
 *   - mkfifo a unique fifo under /tmp
 *   - `${this.tmuxCmd} pipe-pane -O -t <pane> '<copy> > <fifo>'` — tmux replicates every
 *     byte the pane writes into the fifo (append-only, '-O' overwrites any
 *     existing pipe). `<copy>` is `cat`, or a botmux relay where `cat` holds
 *     short writes (see tmux-pipe-relay.ts).
 *   - fs.createReadStream(<fifo>) — we read tmux's verbatim ANSI stream.
 *   - All writes (sendText / sendSpecialKeys / pasteText / copy-mode keys)
 *     go through `tmux send-keys / paste-buffer -t <pane>` — so the pane's
 *     real address ("0:2.0") is the addressing target, not a synthetic
 *     session name.
 *   - `${this.tmuxCmd} capture-pane -e -p -t <pane> -S -` returns the current screen
 *     with ANSI; the worker uses it to seed new web-terminal connections
 *     so they don't start from a blank screen.
 *
 * The user's source session is never attached, never zoomed, never
 * grouped — fully zero-touch from tmux's perspective beyond the pipe-pane
 * subscription, which is automatically detached when we kill the backend.
 */
import * as fs from 'node:fs';
import { execSync, execFile, execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { SessionBackend, SessionProbe, SpawnOpts } from './types.js';
import { tmuxEnv, getTmuxVersionCached, tmuxVersionAtLeast, tmuxSupportsRemainOnExitFailed, resolveTmuxVersionAtSessionBoundary, serverTmuxVersion } from '../../setup/ensure-tmux.js';
import type { TmuxVersion } from '../../setup/ensure-tmux.js';
import { stripAnsiForLog, tailChars } from '../../utils/crash-log.js';
import { inheritBotEnv } from '../../core/env-policy.js';
import { strictPaneCommand } from './strict-env.js';
import { buildBotmuxEnvAssignments, resolveUserShell, shellWrapperScript, shellCommandArgv, shellKindForPath, TmuxBackend, isTmuxServerLevelErrorText, isExecTimeoutError, classifyTmuxCaptureError } from './tmux-backend.js';
import {
  assertTmuxCommandFits,
  paneLaunchLoader,
  TMUX_COMMAND_MAX_BYTES,
  TmuxCommandTooLongError,
  tmuxCommandBytes,
  writePaneLaunchFile,
  type PaneLaunchFile,
} from './pane-launch.js';
import { resolveBotmuxWrapperBinDir } from '../../core/botmux-wrapper.js';
import { LivenessGate, ADOPT_LIVENESS_MAX_FAILURES } from './liveness-gate.js';
import { tmuxCommand, tmuxSocketArgs } from './tmux-socket.js';
import { readUnreapedPaneExit, type UnreapedPaneExit } from './unreaped-pane-exit.js';
import { pipePaneShellCommand } from './tmux-pipe-relay.js';
import { createTmuxBootGate } from './tmux-anti-fork.js';

function shellescape(s: string): string {
  // Single-quote-escape, replacing internal ' with '\''
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** tmux argv for typing `text` literally into `target`.
 *
 *  tmux treats an argument whose LAST character is `;` as a command separator
 *  and strips it, even under `send-keys -l --` and even when argv comes from
 *  execFile (no shell involved): `send-keys -l -- 'X;'` types `X`, a lone `;`
 *  types nothing. The `\;` escape cannot be used generically either: tmux
 *  also unescapes backslashes before it (`'B\\;'` types `B;`). Callers chunk
 *  long input (Claude Code: 96 UTF-8 bytes per send), so any chunk or line that
 *  happens to end in `;` silently lost it; HTML-escaped group context (`&#10;`,
 *  `&lt;`, `&gt;`) made that frequent. Send trailing semicolons as hex keys
 *  (`send-keys -H 3b`, tmux >= 3.0) in the same tmux invocation instead. */
export function literalSendKeysArgs(target: string, text: string, version = getTmuxVersionCached()): string[] {
  const body = text.replace(/;+$/, '');
  const semicolons = text.length - body.length;
  // tmux < 3.0 has no `-H`: keep the old argv there (loses the `;` instead of
  // failing the whole send). An unknown version is assumed current.
  if (semicolons === 0 || (version !== null && !tmuxVersionAtLeast(version, 3, 0))) {
    return ['send-keys', '-t', target, '-l', '--', text];
  }
  const hex = ['send-keys', '-t', target, '-H', ...Array.from({ length: semicolons }, () => '3b')];
  return body ? ['send-keys', '-t', target, '-l', '--', body, ';', ...hex] : hex;
}

/** Quote one argument of a command string that tmux parses itself (an if-shell
 *  branch). tmux 2.x has no backslash escapes outside quotes, so the `'\''`
 *  form above splits there; every tmux unescapes `\\`, `\"`, `\$`, `\~` inside
 *  double quotes, and tmux 3.x expands a `~` that opens them (an adopted pane's
 *  target is the user's own session name). tmux 2.x also ends a command at an
 *  argument ending in `;`. */
function tmuxQuote(s: string): string {
  return `"${s.replace(/[\\"$~]/g, '\\$&')}"`;
}

/** `failed` was added in tmux 3.2. Older/unknown versions retain every exit
 *  with `on`; handlePaneExit() reads the status and reaps that pane, including
 *  clean exits, so keeping it does not leak a session. */
function remainOnExitMode(version = getTmuxVersionCached()): 'on' | 'failed' {
  return tmuxSupportsRemainOnExitFailed(version) ? 'failed' : 'on';
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

/** Evidence about WHY the pane died, collected best-effort after a terminal
 *  pipe-pane attach failure. All fields null/false when probes are inconclusive
 *  (server-level outage) — the caller then degrades to the raw error. */
export interface PipePaneDeathEvidence {
  paneDead: boolean;
  paneDeadStatus: string | null;
  lastScreen: string | null;
}

const PANE_DEATH_PROBE_TIMEOUT_MS = 1000;
const PANE_DEATH_SCREEN_TAIL_CHARS = 800;
/** History lines read above the visible screen for the post-mortem. When the
 *  pane dies, tmux writes its remain-on-exit banner ("Pane is dead (status N,
 *  …)") on the bottom row with a linefeed, scrolling the whole screen up one
 *  line. A CLI that died at startup usually printed a single line at the top —
 *  exactly the line that scrolls into history — so a visible-only capture
 *  kept tmux's banner and lost the reason (#3470). The tail cap still bounds
 *  what is reported. */
const PANE_DEATH_SCREEN_HISTORY_LINES = 50;

/** After #{pane_dead} flips, #{pane_dead_status} is populated a beat later
 *  (`1:` → `1:77` observed on tmux 3.3a; the gap widens under a loaded server).
 *  The teardown read polls that long at most for the real status. */
const PANE_DEATH_STATUS_POLL_MS = 50;
const PANE_DEATH_STATUS_MAX_POLLS = 20; // ≈1s wall budget, matching the empirically-validated fixture grace
/** The teardown/probe read. The pane and server pids let resolvePaneDeath ask
 *  the kernel for a status tmux has not published (see unreaped-pane-exit). */
const PANE_DEATH_FORMAT = '#{pane_dead}:#{pane_dead_status}:#{pane_pid}:#{pid}';
const PANE_DEATH_POLL_DEFAULTS = {
  attempts: PANE_DEATH_STATUS_MAX_POLLS,
  intervalMs: PANE_DEATH_STATUS_POLL_MS,
} as const;
/** The liveness read: ONE tmux round-trip answering both "is the pane
 *  addressable" (`#{pane_id}`; empty for an unknown target on tmux 3.x, which
 *  exits 0 there) and "is it a corpse kept by remain-on-exit" (the
 *  PANE_DEATH_FORMAT fields, so a dead answer already carries the status and
 *  the pids the kernel fallback needs). A probe used to be two display-message
 *  calls: `#{pane_id}`, then PANE_DEATH_FORMAT. `#{pane_id}` never contains `:`. */
const PANE_PROBE_FORMAT = `#{pane_id}:${PANE_DEATH_FORMAT}`;
/** The read every write already made to cancel copy-mode, extended with the
 *  liveness fields so a write can refuse a corpse without an extra command. */
const PANE_WRITE_CHECK_FORMAT = `${PANE_PROBE_FORMAT}:#{pane_in_mode}`;

function parsePositivePid(raw: string | undefined): number | undefined {
  const text = (raw ?? '').trim();
  if (!/^\d+$/.test(text)) return undefined;
  const pid = Number(text);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** A liveness probe's verdict. `unknown` = no authoritative answer (the server
 *  was not reached / did not answer in time); `serverLevel` marks connection
 *  failures, which feed the dead-server escalation clock. */
export interface PaneProbeResult {
  state: SessionProbe;
  reason?: string;
  serverLevel?: boolean;
}

/** What a server-answered {@link PANE_PROBE_FORMAT} line says. */
export type PaneProbeAnswer =
  | { state: 'exists'; serverPid: number | undefined }
  | { state: 'missing'; reason: string; deathLine?: string };

/**
 * Classify one answered liveness line (`#{pane_id}:` + PANE_DEATH_FORMAT, and
 * possibly more `:`-separated fields after it):
 *  - empty pane id → missing (tmux 3.x answers an unknown target with exit 0
 *    and every pane field empty);
 *  - `#{pane_dead}=1` → missing: a corpse kept by remain-on-exit still has a
 *    pane id, so the id alone would report it `exists` forever. `deathLine` is
 *    the PANE_DEATH_FORMAT part, for the exit-status capture;
 *  - anything else (`0`, or an unreadable flag) → exists. Death is only ever
 *    taken from an explicit `1`; it is never invented.
 */
export function classifyPaneProbeAnswer(raw: string): PaneProbeAnswer {
  const fields = String(raw ?? '').replace(/\r?\n$/, '').split(':');
  const paneId = (fields[0] ?? '').trim();
  if (!paneId) return { state: 'missing', reason: 'empty pane id' };
  if ((fields[1] ?? '').trim() === '1') {
    return { state: 'missing', reason: 'pane is dead (remain-on-exit remnant)', deathLine: fields.slice(1, 5).join(':') };
  }
  return { state: 'exists', serverPid: parsePositivePid(fields[4]) };
}

/**
 * Classify a liveness probe that did not produce an answer, from the error in
 * the shape `execFileSync` throws (an async failure goes through
 * {@link execFileErrorAsSyncShape} first, so both paths judge alike).
 *
 * A clean tmux rejection that the SERVER actually answered is `missing`;
 * timeout, signal, EMFILE/ENFILE and spawn failures are `unknown`, because the
 * shared server never answered. Collapsing those into "gone" caused every
 * worker to destroy a live bmx-* session when the server had a short outage.
 *
 * CONNECTION-level clean failures ("error connecting to <socket>", "lost
 * server" — see isTmuxServerLevelErrorText) are `unknown` too, flagged
 * `serverLevel` so the caller can run the dead-server escalation clock: a
 * briefly stalled server refuses connects instantly (unix-socket backlog
 * overflow), which is indistinguishable from a missing pane by exit status
 * alone. Misreading it as `missing` mass-tore-down every live session across
 * all bots at once (2026-08-20 incident).
 */
export function classifyPaneProbeFailure(err: any, command: string): PaneProbeResult {
  // Deadline first: a timed-out probe can carry a clean numeric exit when the
  // client's completion races the kill (isExecTimeoutError). That is "no
  // answer", never an authoritative 'missing'.
  if (isExecTimeoutError(err)) {
    return { state: 'unknown', reason: 'probe deadline (ETIMEDOUT)' };
  }
  if (err && typeof err.status === 'number' && !err.signal) {
    const stderr = (err.stderr?.toString?.() ?? '').trim();
    if (isTmuxServerLevelErrorText(stderr)) {
      return { state: 'unknown', reason: stderr, serverLevel: true };
    }
    return { state: 'missing', reason: stderr || `${command} exited ${err.status}` };
  }
  const detail = (err?.stderr?.toString?.() ?? '').trim()
    || err?.code
    || err?.signal
    || err?.message
    || 'tmux probe got no answer';
  return { state: 'unknown', reason: String(detail) };
}

/** Error in the shape `execFileSync` throws: `code: 'ETIMEDOUT'` for a deadline
 *  kill, a numeric `status` for an exit, a string `code` for a spawn failure. */
export interface SyncShapedExecError {
  message: string;
  code?: string;
  status: number | null;
  signal: string | null;
  stderr: string;
}

/**
 * Reshape `execFile`'s callback error like the one `execFileSync` throws, so
 * the probe classifiers judge the async and sync paths identically. Measured
 * the same on Node 24 and Bun 1.4.4: a deadline kill sets `killed` (with the
 * kill signal), an exit puts the status in a NUMERIC `code`, a spawn failure
 * puts the errno name in a string `code`, and stderr only arrives as the
 * callback argument.
 */
export function execFileErrorAsSyncShape(error: any, stderr: unknown): SyncShapedExecError {
  const code = error?.code;
  return {
    message: String(error?.message ?? error),
    // A deadline kill is "no answer" even when the exit raced it (same rule as
    // isExecTimeoutError on the sync path).
    code: error?.killed === true ? 'ETIMEDOUT' : (typeof code === 'string' ? code : undefined),
    status: typeof code === 'number' ? code : null,
    signal: typeof error?.signal === 'string' ? error.signal : null,
    stderr: String(stderr ?? ''),
  };
}

type TmuxRunResult = { ok: true; stdout: string } | { ok: false; error: SyncShapedExecError };

/** Run one tmux client without blocking the event loop. Never rejects: every
 *  failure (deadline, exit, spawn error, a synchronous throw) resolves as
 *  `ok: false` in the execFileSync error shape. SIGKILL on the deadline so a
 *  hung client always ends and the caller always gets an answer. */
function runTmuxAsync(args: readonly string[], timeoutMs: number): Promise<TmuxRunResult> {
  return new Promise((resolve) => {
    try {
      execFile('tmux', [...args], {
        encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', env: tmuxEnv(),
      }, (error, stdout, stderr) => {
        if (error) resolve({ ok: false, error: execFileErrorAsSyncShape(error, stderr) });
        else resolve({ ok: true, stdout: String(stdout ?? '') });
      });
    } catch (error) {
      resolve({ ok: false, error: execFileErrorAsSyncShape(error, '') });
    }
  });
}

/** `list-sessions` outcome → reachability. A clean success means a server is
 *  up. A clean failure whose stderr is connection-level means the client never
 *  reached the server (it may be live-but-stalled) → 'unreachable'; any other
 *  clean failure — "no server running" included — is the server's own answer
 *  → 'down'. Timeouts and spawn failures → 'unreachable'. */
function serverReachabilityFromFailure(err: any): 'down' | 'unreachable' {
  if (isExecTimeoutError(err)) return 'unreachable';
  if (err && typeof err.status === 'number' && !err.signal) {
    const stderr = (err.stderr?.toString?.() ?? '').trim();
    return isTmuxServerLevelErrorText(stderr) ? 'unreachable' : 'down';
  }
  return 'unreachable';
}

/**
 * Whether an authoritative "pane gone" verdict came from losing the whole tmux
 * server rather than from the CLI exiting: the pane was last seen alive on
 * server `lastLivePid`, and now a server with a DIFFERENT pid answers on the
 * same socket (it was killed or its socket was taken over and a fresh server
 * started there). Both pids must be known; anything unreadable is "no", so a
 * real CLI crash keeps counting toward the fresh-session fallback.
 */
export function paneLossWasServerReplacement(
  lastLivePid: number | undefined,
  answeringPid: number | undefined,
): boolean {
  return lastLivePid !== undefined && answeringPid !== undefined && lastLivePid !== answeringPid;
}

/**
 * Three-way verdict for a pane probed at teardown / reattach time.
 *
 *  - `alive`   — tmux explicitly answered `#{pane_dead}=0`. Never re-read,
 *                never reap: a live pane must not be torn down.
 *  - `dead`    — `#{pane_dead}=1`; `status` is the real exit code when tmux
 *                published it, or `null` for a signal death (empty status).
 *  - `unknown` — the probe could not get an answer (tmux client timeout, the
 *                session racing away, …). Distinct from `alive`: an
 *                inconclusive first read must be RETRIED, not taken as "the
 *                pane is fine" — a single timeout otherwise silently dropped
 *                both the real exit code and the corpse reaping (#2408).
 */
export type PaneDeathResolution =
  | { kind: 'alive' }
  | { kind: 'dead'; status: number | null }
  | { kind: 'unknown' };

/**
 * Merge the exit code captured while a probe confirmed the corpse with the
 * code read at terminal teardown.
 *  - a real code latched at confirmation (number) always wins;
 *  - otherwise a LATE real code from the terminal read is adopted even when
 *    the probe latched null (death confirmed but its publish window ran past
 *    the bounded wait under starvation) — discarding it is a 77 -> 1 doorway;
 *  - null at BOTH (or undefined + null) = code-less signal death -> null, and
 *    the caller falls back to the historic sentinel 1.
 * 0 passes through as 0 (`0 ?? 1 === 0`); a clean exit 0 never leaves a corpse
 * under remain-on-exit `failed`, so it is unreachable here but stays explicit.
 */
export function resolveReportedExitCode(
  observed: number | null | undefined,
  terminal: number | null,
): number | null {
  return typeof observed === 'number' ? observed : terminal;
}

/**
 * Resolve a pane's liveness + real exit status from raw
 * `#{pane_dead}:#{pane_dead_status}[:#{pane_pid}:#{pid}]` lines, accounting
 * for TWO ordering/load gaps:
 *
 *  1. tmux flips `#{pane_dead}` BEFORE `pane_dead_status` is visible
 *     (`1:` → `1:77` on tmux 3.3a; the gap widens under a loaded server).
 *  2. the FIRST read itself can be inconclusive (a tmux client timeout returns
 *     ''), and death is irreversible while an unreadable answer is not — so an
 *     unreadable first read is retried instead of being collapsed into
 *     "alive".
 *
 * Pure (read + wait injected) for deterministic unit tests:
 *  - `0:…` → alive immediately (never re-read, never reap);
 *  - `1:<code>` → dead with that code;
 *  - `1:` → dead with no status yet. tmux publishes the status only once it
 *    has reaped the pane process; until then that process is a zombie child
 *    of the server and the kernel holds its status, so `unreapedExit` (given
 *    the line's pane and server pids) is asked first: an exit code is
 *    returned at once, a signal death is `{dead, status:null}` at once.
 *    Otherwise poll up to `attempts` times for the code; an empty status at
 *    the deadline is a legitimate signal death and resolves to
 *    `{dead, status:null}` (we never invent a code);
 *  - `''`/unparseable → unknown: poll up to `attempts` times for ANY decisive
 *    answer. Once death has been observed it latches (a later unreadable line
 *    or an impossible-looking `0:` cannot undo it — dead panes do not revive).
 */
export function resolvePaneDeath(
  firstLine: string,
  readLine: () => string,
  sleep: (ms: number) => void,
  opts: { attempts: number; intervalMs: number } = PANE_DEATH_POLL_DEFAULTS,
  unreapedExit?: (panePid: number, serverPid: number) => UnreapedPaneExit | null,
): PaneDeathResolution {
  const steps = paneDeathSteps(firstLine, opts, unreapedExit);
  for (let step = steps.next(); ; ) {
    if (step.done) return step.value;
    sleep(step.value);
    step = steps.next(readLine());
  }
}

/** {@link resolvePaneDeath} with an asynchronous read and wait: same verdicts,
 *  same bounds, but the event loop keeps running between the reads. Used by
 *  the lifecycle watcher, which must never block the worker. */
export async function resolvePaneDeathAsync(
  firstLine: string,
  readLine: () => Promise<string>,
  sleep: (ms: number) => Promise<void>,
  opts: { attempts: number; intervalMs: number } = PANE_DEATH_POLL_DEFAULTS,
  unreapedExit?: (panePid: number, serverPid: number) => UnreapedPaneExit | null,
): Promise<PaneDeathResolution> {
  const steps = paneDeathSteps(firstLine, opts, unreapedExit);
  for (let step = steps.next(); ; ) {
    if (step.done) return step.value;
    await sleep(step.value);
    step = steps.next(await readLine());
  }
}

/** The verdict logic shared by the sync and async resolvers: yields the wait
 *  before each re-read and receives the next line. */
function* paneDeathSteps(
  firstLine: string,
  opts: { attempts: number; intervalMs: number },
  unreapedExit?: (panePid: number, serverPid: number) => UnreapedPaneExit | null,
): Generator<number, PaneDeathResolution, string> {
  // One raw line classified three ways.
  const classify = (line: string): { alive: true } | { code: string | null; pids: [number, number] } | null => {
    const [dead, status, panePid, serverPid] = String(line ?? '').trim().split(':');
    if (dead === '0') return { alive: true }; // explicitly alive
    if (dead !== '1') return null; // '' / unparseable / tmux error → unreadable
    const s = (status ?? '').trim();
    // dead; null = no status yet
    return { code: s.length > 0 ? s : null, pids: [Number(panePid), Number(serverPid)] };
  };

  let line = firstLine;
  let sawDead = false;
  for (let i = 0; i <= opts.attempts; i += 1) {
    const v = classify(line);
    if (v !== null && 'alive' in v) {
      // Explicit "alive" is authoritative only BEFORE death was observed. A
      // dead pane cannot revive; a `0:` after seeing death is a tmux glitch
      // and must not un-latch the verdict.
      if (!sawDead) return { kind: 'alive' };
    } else if (v !== null) {
      sawDead = true;
      if (v.code !== null) {
        const parsed = Number.parseInt(v.code, 10);
        return { kind: 'dead', status: Number.isInteger(parsed) ? parsed : null };
      }
      const kernel = unreapedExit?.(...v.pids) ?? null;
      if (kernel) return { kind: 'dead', status: kernel.kind === 'exited' ? kernel.code : null };
    }
    // v === null (unreadable) and dead-without-status both loop: read again.
    if (i === opts.attempts) break;
    line = yield opts.intervalMs;
  }
  return sawDead ? { kind: 'dead', status: null } : { kind: 'unknown' };
}

/** Build the readable startup error for a pane whose CLI process died
 *  immediately. Pure (no tmux calls) so the wording is unit-testable. */
export function buildPipePaneStartupError(rawErr: unknown, evidence: PipePaneDeathEvidence): Error {
  const statusLine = evidence.paneDeadStatus
    ? `exit status=${evidence.paneDeadStatus}`
    : '进程已退出（无退出码，可能被信号终止）';
  const rawFirstLine = (rawErr instanceof Error ? rawErr.message : String(rawErr ?? ''))
    .split('\n').map(line => line.trim()).find(line => line.length > 0);
  const lines = [
    `tmux pane 中的进程启动后立即退出（${statusLine}），这通常是 CLI 本身启动失败，而不是 tmux 未安装。`,
  ];
  if (evidence.lastScreen) lines.push(`最后一屏摘要：\n${evidence.lastScreen}`);
  if (rawFirstLine) lines.push(`原始 pipe-pane 错误：${rawFirstLine}`);
  return new Error(lines.join('\n'));
}

/** Best-effort post-mortem after a terminal pipe-pane failure. Runs one
 *  display-message and one capture-pane, each with a short timeout. Never
 *  throws and never emits noise: any failure/timeout returns an inconclusive
 *  evidence ({ paneDead: false }), and the caller keeps the raw error. A dead
 *  pane tmux has not reaped yet reads as status-less; its exit code then comes
 *  from the kernel, as on the teardown path (#2453), so the message does not
 *  call a plain non-zero exit a possible signal death. */
function collectPipePaneDeathEvidence(
  paneTarget: string,
  socketArgs: readonly string[],
  includeHistory: boolean,
): PipePaneDeathEvidence {
  let paneDead = false;
  let paneDeadStatus: string | null = null;
  try {
    const out = String(
      execFileSync(
        'tmux',
        [...socketArgs, 'display-message', '-p', '-t', paneTarget, PANE_DEATH_FORMAT],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PANE_DEATH_PROBE_TIMEOUT_MS, env: tmuxEnv() },
      ) ?? '',
    ).trim();
    const [dead, status, panePid, serverPid] = out.split(':');
    paneDead = dead === '1';
    paneDeadStatus = status && status.trim() ? status.trim() : null;
    if (paneDead && paneDeadStatus === null) {
      const kernel = readUnreapedPaneExit(Number(panePid), Number(serverPid));
      if (kernel?.kind === 'exited') paneDeadStatus = String(kernel.code);
    }
  } catch {
    return { paneDead: false, paneDeadStatus: null, lastScreen: null };
  }
  let lastScreen: string | null = null;
  // History is fresh-create-only: reattach/adopt targets may be long-lived user
  // panes whose off-screen commands and output must not enter the chat error.
  const historyArgs = includeHistory ? ['-S', `-${PANE_DEATH_SCREEN_HISTORY_LINES}`] : [];
  try {
    const out = String(
      execFileSync(
        'tmux',
        [...socketArgs, 'capture-pane', '-p', ...historyArgs, '-t', paneTarget],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PANE_DEATH_PROBE_TIMEOUT_MS, env: tmuxEnv() },
      ) ?? '',
    );
    const cleaned = stripAnsiForLog(out);
    lastScreen = cleaned ? tailChars(cleaned, PANE_DEATH_SCREEN_TAIL_CHARS) : null;
  } catch {
    lastScreen = null;
  }
  return { paneDead, paneDeadStatus, lastScreen };
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
  return 1000 + (stableTargetHash(target) % 750);
}

function stableTargetHash(target: string): number {
  let hash = 2166136261;
  for (let i = 0; i < target.length; i += 1) {
    hash ^= target.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Lifecycle probe cadence.
 *
 * Every worker used to ask the shared tmux server twice a second-ish (two
 * display-message calls every 1s), whether or not anything happened in its
 * pane. With ~260 sessions that alone kept one server near 100% CPU, and every
 * write and web-terminal attach of every bot queued behind those probes.
 *
 * Now a pane is probed every LIFECYCLE_ACTIVE_PROBE_MS only while it is
 * ACTIVE, and at the slower idle cadence otherwise:
 *  - a write into it, or the attach itself, makes it active for
 *    LIFECYCLE_ACTIVITY_WINDOW_MS and pulls an idle-scheduled probe forward;
 *  - SUSTAINED output (a run of output lasting at least
 *    LIFECYCLE_SUSTAINED_OUTPUT_MS, gaps no longer than
 *    LIFECYCLE_OUTPUT_ACTIVITY_WINDOW_MS) keeps it active for
 *    LIFECYCLE_OUTPUT_ACTIVITY_WINDOW_MS but never adds a probe by itself: a
 *    turn in progress streams output (spinner, timer) continuously, so it is on
 *    the fast cadence from the next scheduled probe on, while an isolated
 *    repaint of an idle CLI (e.g. a user statusline command that Claude
 *    re-runs every 60s) costs nothing;
 *  - while the server-outage clock runs (connection-level failures), the
 *    active cadence too, so the 60s escalation rests on as many samples as
 *    on an active pane (see nextProbeDelayMs).
 * The idle cadence is the cap on how late an idle pane's death is first seen;
 * writes never wait for it (a write reads the pane state first and refuses a
 * corpse, see preparePaneForWrite; a paste is guarded inside its own tmux
 * queue; a failed write probes at once, see guardedSend).
 */
export const LIFECYCLE_ACTIVE_PROBE_MS = 1_000;
export const LIFECYCLE_ACTIVITY_WINDOW_MS = 30_000;
export const LIFECYCLE_OUTPUT_ACTIVITY_WINDOW_MS = 5_000;
export const LIFECYCLE_SUSTAINED_OUTPUT_MS = 1_000;
export const LIFECYCLE_IDLE_PROBE_MAX_MS = 30_000;
const LIFECYCLE_IDLE_PROBE_SPREAD_MS = 5_000;
/** Backoff ceiling while probes keep NOT answering 'exists' (unchanged). */
const LIFECYCLE_SETBACK_MAX_MS = 9_000;
/** Adopted-CLI pid check cadence: a process.kill(pid, 0) syscall, no tmux. */
const ADOPT_PID_CHECK_MS = 1_000;

/** Idle cadence for one target: a stable value in
 *  [LIFECYCLE_IDLE_PROBE_MAX_MS - spread, LIFECYCLE_IDLE_PROBE_MAX_MS), so the
 *  workers of a mass restore — which all go idle at about the same time — do
 *  not keep probing in lock-step bursts. */
export function tmuxLifecycleIdleProbeMs(target: string): number {
  return LIFECYCLE_IDLE_PROBE_MAX_MS - LIFECYCLE_IDLE_PROBE_SPREAD_MS
    + (stableTargetHash(`idle:${target}`) % LIFECYCLE_IDLE_PROBE_SPREAD_MS);
}

/**
 * Delay before the next lifecycle probe.
 *  - healthy (last probe `exists`): the active or the idle cadence;
 *  - after an authoritative `missing`: the existing 3s / 9s confirmation
 *    backoff, whatever the cadence — the pane-gone debounce (3 misses + a
 *    final check) keeps its old ~12s length on idle panes too;
 *  - after `unknown` (server not answering): that same backoff, but never
 *    faster than the healthy cadence — re-probing a struggling shared server
 *    more often than usual is what feeds its connect storm.
 */
export function lifecycleProbeDelayMs(s: {
  recentlyActive: boolean;
  idleProbeMs: number;
  setbackStreak: number;
  lastState: SessionProbe;
}): number {
  const healthy = s.recentlyActive ? LIFECYCLE_ACTIVE_PROBE_MS : s.idleProbeMs;
  if (s.setbackStreak <= 0) return healthy;
  const backoff = Math.min(LIFECYCLE_ACTIVE_PROBE_MS * 3 ** s.setbackStreak, LIFECYCLE_SETBACK_MAX_MS);
  return s.lastState === 'unknown' ? Math.max(healthy, backoff) : backoff;
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

/** `<server pid> <session id> <created>`: session ids restart at `$0` with
 *  every new tmux server, so the server pid and creation time are part of it. */
const SESSION_IDENTITY_FORMAT = '#{pid} #{session_id} #{session_created}';

/** Printed by the guarded paste when the target pane turned out dead. */
const PASTE_REFUSED_DEAD_PANE = 'botmux-paste-refused-dead-pane';
const RETIRE_KILLED = 'botmux-retired-own-session';
const RETIRE_KEPT = 'botmux-kept-session';
const DEAD_PANE_MARKER = 'botmux-pane-dead-before-pipe';

function deadPaneSubscriptionError(): Error {
  return Object.assign(new Error('pane is dead'), { status: 1, stderr: 'pane is dead' });
}

function parseSessionIdentity(raw: string): string | null {
  // A queued legacy pipe-pane guard may print a second, death-marker line.
  const identity = raw.trim().split('\n')[0]!;
  return /^\d+ \$\d+ \d+$/.test(identity) ? identity : null;
}

/**
 * Why a startup tmux command failed, WITHOUT the command itself: an
 * execFileSync error message is "Command failed: tmux <every argument>", and
 * the worker forwards that message into the chat. Keeps tmux's own words and
 * the errno, which isTransientStartupFailure classifies.
 */
export function tmuxStartupFailureSummary(err: any): string {
  if (isExecTimeoutError(err)) return 'tmux 命令超时（ETIMEDOUT）';
  const stderrLine = String(err?.stderr ?? '').split('\n').map(line => line.trim()).find(Boolean);
  if (stderrLine) return stderrLine.length > 300 ? `${stderrLine.slice(0, 300)}…` : stderrLine;
  if (typeof err?.code === 'string') return `无法执行 tmux（${err.code}）`;
  if (typeof err?.status === 'number') return `tmux 退出码 ${err.status}`;
  if (err?.signal) return `tmux 被信号 ${err.signal} 终止`;
  return '未知错误';
}

/** The public error for a failed `new-session`. */
export function tmuxNewSessionError(err: any, commandBytes: number): Error {
  const summary = tmuxStartupFailureSummary(err);
  if (/command too long|failed to send command/i.test(summary)
    && (commandBytes > TMUX_COMMAND_MAX_BYTES || /command too long/i.test(summary))) {
    return new TmuxCommandTooLongError(commandBytes, summary);
  }
  return new Error(`tmux 创建会话失败：${summary}`);
}

export class TmuxPipeBackend implements SessionBackend {
  readonly supportsRawCommandPasteLine = true;
  /** Real tmux pane address (e.g. "0:2.0") or botmux session name (bmx-*). */
  private readonly paneTarget: string;
  /** Server this pane lives on (undefined = default server). */
  readonly socketName: string | undefined;
  /** Leading argv / shell prefix that address {@link socketName}. */
  private readonly tmuxArgs: readonly string[];
  private readonly tmuxCmd: string;
  private readonly fifoPath: string;
  private readStream: fs.ReadStream | null = null;
  /** Read end of the fifo. Once created, ReadStream alone owns its close. */
  private fifoFd: number | null = null;
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
  /**
   * Sticky exit state. `spawn()` can report an exit SYNCHRONOUSLY (reattach
   * finds a kept corpse and returns early), but the worker wires `onExit` only
   * AFTER `spawn()` returns — firing into an empty listener list there would
   * lose the event forever (no watcher is started on that branch), silently
   * stalling that session. An exit reported before any listener exists is
   * replayed to the next `onExit` registration.
   */
  private pendingExit: { code: number | null; signal: string | null } | null = null;
  /**
   * Real exit code captured AT THE MOMENT a lifecycle probe first confirms the
   * pane is a kept corpse (`#{pane_dead}=1`). Capturing it there — while the
   * corpse is fresh and `pane_dead_status` is most readable — is what makes a
   * deep-scheduler-stall still report 77/127: by the time the N-miss sequence
   * finishes (~13s) and handlePaneExit() reads status again, a starved tmux may
   * no longer answer. null = a confirmed dead pane with no published code
   * (signal death); undefined = death has not been confirmed by a probe yet.
   */
  private observedDeathStatus: number | null | undefined = undefined;
  /** Next lifecycle probe (a chained setTimeout) and when it is due. */
  private lifecycleTimer: NodeJS.Timeout | null = null;
  private lifecycleTimerDueAt = 0;
  /** Adopt mode: the 1s pid check, kept off the (possibly idle) tmux cadence. */
  private pidWatchTimer: NodeJS.Timeout | null = null;
  /** Bumped by every watcher start/stop. A probe is asynchronous, so its answer
   *  can land after kill()/teardown or after a restart of the watcher; an
   *  answer from an older epoch must not act. */
  private lifecycleEpoch = 0;
  /** Monotonic evidence clock, bumped by a SYNCHRONOUS authoritative exists.
   *  Async probes capture it before their first await: a newer live answer must
   *  invalidate an older missing chain even when the watcher was not stopped. */
  private livenessEvidenceGeneration = 0;
  /** The pane counts as active (fast probe cadence) until this time; pushed
   *  out by writes, the attach and output (see noteLifecycleActivity). */
  private activeUntil = 0;
  /** Start and latest chunk of the current run of pane output. */
  private outputRunStartedAt = 0;
  private lastOutputAt = 0;
  /** State of the last lifecycle probe (drives the cadence after a setback). */
  private lastProbeState: SessionProbe = 'exists';
  private lastUnknownProbeLogAt = 0;
  private lastCaptureErrorKey = '';
  private lastCaptureErrorLogAt = 0;
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
  /** tmux server pid (`#{pid}`) holding this pane. Anchored at attach time; the
   *  first probe that finds the pane alive fills it only if the attach-time
   *  read failed. Compared with the answering server at teardown time. */
  private lastLiveServerPid: number | undefined;
  /** Set when the pane was judged gone while a DIFFERENT tmux server answered
   *  on the same socket — the whole server was lost, the CLI did not exit. */
  private serverReplacedAtExit = false;
  /** Track the selected option, even if its reply is lost or the version refreshes. */
  private legacyRetention = false;
  /** Set after pipe-pane subscription is active so kill() knows to cancel it. */
  private pipeAttached = false;
  /** Identity of the session THIS spawn() created (`<server pid> <session id>
   *  <created>`), so a spawn that fails after creating it can retire exactly
   *  that session — never a same-named one another generation created. The
   *  server pid matters: session ids restart at `$0` with every new server. */
  private createdSession: { id: string; identity: string } | null = null;
  /** The file this spawn's pane sources (see pane-launch.ts). Its shell deletes
   *  it on read; kept so a pane we kill before that can take it along. */
  private launchFile: PaneLaunchFile | null = null;
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
   *  (rather than creating a new detached one), so the worker can branch on
   *  reattach behaviour without a private-cast. */
  get isReattach(): boolean {
    return this._isReattach;
  }

  /**
   * `socketName` selects the tmux server (`-L <name>`, see tmux-socket.ts).
   * Omitted = the default server: adopted panes are the user's own and always
   * live there, as do bmx-* sessions created before the dedicated socket.
   */
  constructor(paneTarget: string, opts?: { createSession?: boolean; ownsSession?: boolean; isReattach?: boolean; cliPid?: number; socketName?: string }) {
    this.paneTarget = paneTarget;
    this.socketName = opts?.socketName;
    this.tmuxArgs = tmuxSocketArgs(this.socketName);
    this.tmuxCmd = tmuxCommand(this.socketName);
    this.createSession = opts?.createSession ?? false;
    this.ownsSession = opts?.ownsSession ?? false;
    this._isReattach = opts?.isReattach ?? false;
    this.watchCliPid = opts?.cliPid;
    // Per-instance fifo so concurrent adopt sessions don't collide.
    this.fifoPath = join(tmpdir(), `botmux-pipe-${randomBytes(8).toString('hex')}.fifo`);
  }

  // ─── SessionBackend implementation ────────────────────────────────────────

  /** Prepare the reader before a managed CLI can emit its startup bytes. */
  spawn(bin: string, args: string[], opts: SpawnOpts): void {
    const instanceIdentity = opts.env?.BOTMUX_CODEX_INSTANCE_BINDING;
    if (this.ownsSession && !this.createSession && instanceIdentity) {
      // Fence managed reattachment before options or pipe-pane can touch the
      // existing session. User-owned adopted panes need no Botmux marker.
      TmuxBackend.assertInstanceIdentity(this.paneTarget, instanceIdentity, this.socketName);
    }
    // Self-heal a server polluted by a pre-upgrade botmux before we touch it
    // (once per daemon process; no-op on a server this build booted clean).
    // TmuxPipeBackend is the live backend on this path, so the scrub must be
    // triggered here — TmuxBackend is only used for its static helpers.
    TmuxBackend.scrubServerGlobalEnvOnce();
    if (opts.strictEnv && !this.createSession && !opts.strictEnvReattach) throw new Error('Refusing unverified strict tmux-pipe reattach');
    this.cols = opts.cols;
    this.rows = opts.rows;

    if (!this.createSession && this.ownsSession && this._isReattach) {
      // Backfill tmux options on an existing bmx-* session — daemon may have
      // been upgraded since the session was originally created, and options
      // like set-clipboard / window-size largest are idempotent to re-apply.
      this.applySessionOptions();
      this.restoreDetachedOwnedSessionSize();
      // Refuse to "attach" to a CONFIRMED corpse. applySessionOptions() above
      // set `remain-on-exit` (`failed` on tmux >= 3.2, `on` on older/unknown
      // builds, see remainOnExitMode()), which preserves a crashed CLI's pane
      // for status reporting — but a corpse is not a session anyone can talk to.
      // Reap it (the next generation must be able to create this name
      // afresh), then report its real exit so the crash-restart policy
      // decides instead of pretending to reattach. An `unknown` answer is
      // fail-open: the launch-selection probe already gates corpses upstream,
      // and refusing a reattach on an unreadable tmux answer would block a
      // healthy session — fall through and let the normal attach + lifecycle
      // watcher handle it.
      const corpseDeath = this.readPaneDeath();
      if (corpseDeath.kind === 'dead') {
        this.exited = true;
        this.killDeadPaneRemnant();
        this.fireExit(corpseDeath.status ?? 1, null);
        return;
      }
    } else if (!this.createSession) {
      // ADOPT path (worker attaching to a CLI it did not launch, keyed by its
      // pid): neither createDetachedSession() nor applySessionOptions() runs
      // here, so the once-per-session remain-on-exit decision never happens.
      // Resolve it against the RUNNING server anyway: without it
      // legacyRetention stays false and the pre-pipe-pane dead-pane guard is
      // skipped — on old tmux (2.8) subscribing to a retained corpse crashes
      // the WHOLE server, taking every session on that socket with it.
      this.legacyRetention = remainOnExitMode(
        serverTmuxVersion(this.tmuxArgs, resolveTmuxVersionAtSessionBoundary()),
      ) === 'on';
    }

    // Step 1: create the fifo. mkfifo is POSIX; linux/darwin both have it.
    const fifoCreation = spawnSync('mkfifo', [this.fifoPath], { encoding: 'utf8' });
    if (fifoCreation.error || fifoCreation.status !== 0) {
      const detail = fifoCreation.error?.message
        || String(fifoCreation.stderr || '').trim()
        || `exit=${fifoCreation.status}, signal=${fifoCreation.signal}`;
      throw new Error(`Could not create tmux FIFO ${this.fifoPath}: ${detail}. Check temporary storage capacity and free inodes.`);
    }

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
    let fd: number;
    try {
      fd = fs.openSync(this.fifoPath, fs.constants.O_RDWR);
    } catch (err) {
      try { fs.unlinkSync(this.fifoPath); } catch { /* best effort */ }
      throw err;
    }
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
    this.readStream = fs.createReadStream('', { fd, autoClose: true, highWaterMark: 64 * 1024 });
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
        // Output = a turn in progress: keep the lifecycle probe on the fast cadence.
        this.noteLifecycleActivity('output');
      }
      for (const cb of this.dataCbs) {
        try { cb(data); } catch { /* listener crash shouldn't kill the stream */ }
      }
    });
    this.readStream.on('error', (err: any) => {
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
    // The copier must forward short writes at once, or a quiet CLI's ready /
    // final bytes never reach the worker and its next input queues forever.
    const pipeShellCommand = pipePaneShellCommand(this.fifoPath);
    let queuedPipeError: { error: unknown } | undefined;
    if (this.createSession) {
      try {
        queuedPipeError = this.createDetachedSession(bin, args, opts, pipeShellCommand);
      } catch (err) {
        this.teardownFifoReader();
        throw err;
      }
      if (this.pipeAttached) {
        // Subscribing earlier must not turn an already-dead CLI into a
        // successful startup. Options/identity checks may have let it exit.
        if (this.readPaneDeath().kind === 'dead') {
          queuedPipeError = { error: deadPaneSubscriptionError() };
        } else {
          this.startLifecycleWatcher();
          return;
        }
      }
    }
    // Same-boundary decision as the applied remain-on-exit value: it was
    // resolved against the RUNNING server (serverTmuxVersion) in
    // createDetachedSession/applySessionOptions before this attach. Guard
    // whenever this session uses legacy `on` — including an unreadable
    // version (fail-closed: the extra verdict is harmless on a live pane).
    const guardDeadPane = this.legacyRetention;
    for (let attempt = 0; ; attempt++) {
      if (!queuedPipeError && this.ownsSession && instanceIdentity) {
        // An operator can replace this name during a retry wait. A successful
        // creation/preflight check does not authorize subscribing its successor.
        // Identity refusal is final, outside the transient tmux retry classifier.
        try {
          TmuxBackend.assertInstanceIdentity(this.paneTarget, instanceIdentity, this.socketName);
        } catch (err) {
          this.teardownFifoReader();
          throw err;
        }
      }
      try {
        // Count a failed queued subscription as the first attach attempt.
        // Retry only pipe-pane: the session has already been created.
        if (queuedPipeError) {
          const { error } = queuedPipeError;
          queuedPipeError = undefined;
          throw error;
        }
        if (guardDeadPane) {
          // tmux 2.8 can crash its server when pipe-pane dereferences an
          // already-dead pane's released event. Keep this check and subscription
          // in ONE server queue; a client-side probe would race the CLI exit.
          const guardedPipePane = `pipe-pane -O -t ${tmuxQuote(this.paneTarget)} ${tmuxQuote(pipeShellCommand)}`;
          const output = execSync(
            `${this.tmuxCmd} if-shell -F -t ${shellescape(this.paneTarget)} '#{pane_dead}' ${shellescape(`display-message -p ${DEAD_PANE_MARKER}`)} ${shellescape(guardedPipePane)}`,
            { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, env: tmuxEnv() },
          );
          if (String(output).trim() === DEAD_PANE_MARKER) {
            // Reuse the deterministic startup-failure teardown and diagnostic
            // path below. A retained pane is not a successful subscription.
            throw deadPaneSubscriptionError();
          }
        } else {
          execSync(
            `${this.tmuxCmd} pipe-pane -O -t ${shellescape(this.paneTarget)} ${shellescape(pipeShellCommand)}`,
            { stdio: ['ignore', 'ignore', 'pipe'], timeout: 5000, env: tmuxEnv() },
          );
        }
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
          // Whether a pipe-pane failure is a STARTUP failure or a lost session
          // depends on what THIS backend was asked to do:
          //
          //  - fresh create (createSession: true): the CLI was being brought
          //    up by us. pipe-pane failing means it never started / the tmux
          //    server stalled -> startup failure. Throw only (below) so the
          //    worker shows the startup-failed card; do NOT emit a process
          //    exit. (The worker wires onExit only after a successful spawn,
          //    and a sticky phantom 1 here mislabelled an infra stall as a
          //    crashed CLI, #2408.)
          //
          //  - biased reattach (createSession: false): attaching to a pane
          //    that was ALREADY supposed to exist. A pipe-pane "pane gone"
          //    means that session vanished - a real session-loss the worker
          //    recovers from. Report exit 1 (no real code exists at attach
          //    time). Use the createSession flag, not createdSession, so a
          //    fresh create whose identity failed to parse can't be mistaken
          //    for a reattach.
          if (!this.createSession) {
            this.fireExit(1, null);
          }
          const evidence = collectPipePaneDeathEvidence(this.paneTarget, this.tmuxArgs, this.createSession);
          throw evidence.paneDead ? buildPipePaneStartupError(err, evidence) : err;
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
    if (this.exited || !this.preparePaneForWrite()) return false;
    return this.guardedSend('send-keys (text)', () => {
      execFileSync('tmux', [...this.tmuxArgs, ...literalSendKeysArgs(this.paneTarget, text)], {
        stdio: 'ignore',
        timeout: 5000,
        env: tmuxEnv(),
      });
    });
  }

  sendSpecialKeys(...keys: string[]): boolean {
    if (this.exited || !this.preparePaneForWrite()) return false;
    return this.guardedSend(`send-keys ${keys.join(' ')}`, () => {
      execFileSync('tmux', [...this.tmuxArgs, 'send-keys', '-t', this.paneTarget, ...keys], {
        stdio: 'ignore',
        timeout: 5000,
        env: tmuxEnv(),
      });
    });
  }

  sendLines(lines: string[], softNewlineKey: string): boolean {
    if (this.exited || lines.length === 0 || !this.preparePaneForWrite()) return false;
    const args: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) args.push(';');
      args.push(...literalSendKeysArgs(this.paneTarget, lines[i]));
      if (i < lines.length - 1) {
        args.push(';');
        args.push('send-keys', '-t', this.paneTarget, softNewlineKey);
      }
    }
    return this.guardedSend('send-lines', () => {
      execFileSync('tmux', [...this.tmuxArgs, ...args], {
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
    return this.pasteBuffer(text, false);
  }

  /** The framed paste is one tmux command batch; Enter follows as a second,
   * back-to-back tmux call. Send ESC markers as literal keys: newer servers
   * sanitize ESC inside buffers.
   *
   * Enter must reach the pane as its own write. tmux turns one command batch
   * into a single write to the pane, and crossterm (Codex's input layer)
   * reads 1024 bytes at a time under edge-triggered epoll and returns as soon
   * as a read yields an event. When the frame up to `ESC[201~` fills a read
   * exactly, a CR riding in the same write stays in the tty with no new
   * readiness edge: the message sits in the composer until the next key.
   * A separate write always raises a fresh edge.
   *
   * The CR is sent synchronously right after the paste call returns, with no
   * timer, so the gap is one tmux client round-trip (milliseconds). The
   * comment this replaces ruled out a delayed adapter Enter, a window long
   * enough for a human to replace the draft or open backtrack; nothing in this
   * process runs between the two calls, and writeInput's history receipt
   * still decides whether the input was submitted. */
  submitBracketedPaste(text: string): boolean {
    if (!this.pasteBuffer(text, true)) return false;
    return this.guardedSend('send-keys (submit)', () => {
      execFileSync('tmux', [...this.tmuxArgs, 'send-keys', '-t', this.paneTarget, '-l', '--', '\r'], {
        stdio: 'ignore',
        timeout: 5000,
        env: tmuxEnv(),
      });
    });
  }

  private pasteBuffer(text: string, submit: boolean): boolean {
    if (this.exited || !this.preparePaneForWrite()) return false;
    const bufferName = `botmux-${randomBytes(8).toString('hex')}`;
    return this.guardedSend('paste-buffer', () => {
      // Empty load-buffer creates no buffer: paste-buffer would abort after
      // the opening marker. Queue the entire empty frame as literal keys.
      if (submit && text.length === 0) {
        execFileSync('tmux', [...this.tmuxArgs,
          'send-keys', '-t', this.paneTarget, '-l', '--', '\x1b[200~\x1b[201~'], {
          stdio: 'ignore',
          timeout: 5000,
          env: tmuxEnv(),
        });
        return;
      }
      let loaded = false;
      try {
        execFileSync('tmux', [...this.tmuxArgs, 'load-buffer', '-b', bufferName, '-'], {
          input: text,
          stdio: ['pipe', 'ignore', 'ignore'],
          timeout: 5000,
          env: tmuxEnv(),
        });
        loaded = true;
        // paste-buffer into a dead pane CRASHES the whole tmux server on tmux
        // <= 3.3a (measured: 2.8 "lost server", 3.3a "server exited
        // unexpectedly"; 3.4+ answers "target pane has exited"), taking every
        // session on that socket with it. preparePaneForWrite() refuses a corpse
        // it can read, but its read can time out, and the pane can die between
        // it and here. So the paste runs only behind `#{pane_dead}`, decided in
        // the SAME server queue (the pipe-pane guard's technique): a corpse
        // answers PASTE_REFUSED_DEAD_PANE instead of being pasted into. Measured
        // on 2.8 / 3.3a / 3.6a: a live pane still gets ESC[200~, the text and
        // ESC[201~ in order; a corpse gets the marker and the server survives.
        // send-keys into a corpse is harmless (dropped), so the frame markers
        // stay outside the guard and need no nested quoting.
        const guardedPaste = ['if-shell', '-F', '-t', this.paneTarget, '#{pane_dead}',
          `display-message -p ${PASTE_REFUSED_DEAD_PANE}`,
          ['paste-buffer', '-b', bufferName, '-t', this.paneTarget, '-d', submit ? '-r' : '-p'].map(tmuxQuote).join(' ')];
        const commands = submit
          ? ['send-keys', '-t', this.paneTarget, '-l', '--', '\x1b[200~', ';',
            ...guardedPaste, ';', 'send-keys', '-t', this.paneTarget, '-l', '--', '\x1b[201~']
          : guardedPaste;
        const printed = execFileSync('tmux', [...this.tmuxArgs, ...commands], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5000,
          env: tmuxEnv(),
        });
        if (String(printed ?? '').split('\n').some(line => line.trim() === PASTE_REFUSED_DEAD_PANE)) {
          // Not pasted (the buffer is still loaded: finally deletes it). Fail the
          // write; guardedSend's probe then reads the corpse and reports the exit.
          throw Object.assign(new Error('pane is dead; paste refused'), { status: 1, signal: null, stderr: 'pane is dead' });
        }
        loaded = false;
      } finally {
        if (loaded) {
          try {
            execFileSync('tmux', [...this.tmuxArgs, 'delete-buffer', '-b', bufferName], {
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
    // A write is activity: keep (or pull) the lifecycle probe onto the fast
    // cadence, so a CLI that dies right after it is seen as fast as before.
    this.noteLifecycleActivity('input');
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
        this.dumpRecentOutputTail();
        this.noteServerReplacedAtPaneLoss();
        this.handlePaneExit();
      }
      return false;
    }
  }

  /** Diagnostic for a pane found gone: capture-pane can no longer read its final
   *  screen, so dump the tail tmux already replicated over the pipe — the CLI's
   *  real last stdout/stderr, which often explains WHY it exited (e.g. a
   *  gateway/API error line). */
  private dumpRecentOutputTail(): void {
    const tail = this.recentOutput.trim();
    if (tail) {
      process.stderr.write(`[tmux-pipe-backend] CLI last output before exit (tail):\n${tail}\n`);
    }
  }

  /** Record the CLI's exit code from a corpse a probe just confirmed, the first
   *  time death is confirmed (a later real code replaces a latched `null`; a
   *  real code is never erased — death latches). Reading it while the corpse
   *  is fresh is what lets handlePaneExit() report 77/127 even when a starved
   *  tmux no longer answers by then (#2434). */
  private latchObservedDeath(verdict: PaneDeathResolution): void {
    if (verdict.kind !== 'dead') return;
    if (this.observedDeathStatus === undefined || (this.observedDeathStatus === null && verdict.status !== null)) {
      this.observedDeathStatus = verdict.status;
    }
  }

  /** {@link latchObservedDeath} for a dead answer (`deathLine` = its
   *  PANE_DEATH_FORMAT part). A status tmux has not published yet is waited
   *  for within resolvePaneDeath's bound, or taken from the kernel's record of
   *  the unreaped pane process (#2453). Synchronous: the write paths are. */
  private capturePaneDeathSync(deathLine: string): void {
    const readLine = (): string => {
      try {
        return String(
          execFileSync(
            'tmux',
            [...this.tmuxArgs, 'display-message', '-p', '-t', this.paneTarget, PANE_DEATH_FORMAT],
            { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PANE_DEATH_PROBE_TIMEOUT_MS, env: tmuxEnv() },
          ) ?? '',
        ).trim();
      } catch {
        return ''; // unreadable -> resolvePaneDeath retains the prior observation
      }
    };
    this.latchObservedDeath(resolvePaneDeath(deathLine, readLine, sleepSyncMs, undefined, readUnreapedPaneExit));
  }

  /** {@link capturePaneDeathSync} for the lifecycle watcher: the re-reads and
   *  the waits between them do not block the event loop. Once the watcher is
   *  stopped (kill/teardown) the remaining rounds run dry — no more tmux
   *  commands for a backend nobody watches. */
  private async capturePaneDeathAsync(deathLine: string, epoch: number, evidenceGeneration: number): Promise<void> {
    const readLine = async (): Promise<string> => {
      if (this.lifecycleEvidenceStale(epoch, evidenceGeneration)) return '';
      const r = await runTmuxAsync(
        [...this.tmuxArgs, 'display-message', '-p', '-t', this.paneTarget, PANE_DEATH_FORMAT],
        PANE_DEATH_PROBE_TIMEOUT_MS,
      );
      return r.ok ? r.stdout.trim() : '';
    };
    const sleep = (ms: number) => new Promise<void>((resolve) => {
      if (this.lifecycleEvidenceStale(epoch, evidenceGeneration)) resolve();
      else setTimeout(resolve, ms);
    });
    const verdict = await resolvePaneDeathAsync(deathLine, readLine, sleep, undefined, readUnreapedPaneExit);
    // A newer synchronous exists both cleared the old death latch and advanced
    // the generation. Do not let this older capture repopulate it afterwards.
    if (this.lifecycleEvidenceStale(epoch, evidenceGeneration)) return;
    this.latchObservedDeath(verdict);
  }

  /**
   * The read every write makes before it runs. It used to read only
   * `#{pane_in_mode}` (to cancel copy-mode, which would swallow the keys); it
   * now carries the liveness fields in that SAME command, so a write refuses a
   * corpse the lifecycle watcher has not reached yet — which matters now that
   * an idle pane is probed only every ~30s:
   *  - send-keys into a dead pane exits 0 and the keys are silently dropped;
   *  - paste-buffer into a dead pane crashes the WHOLE tmux server on tmux
   *    <= 3.3a (every session on that socket dies with it).
   * Only the server's explicit `#{pane_dead}=1` refuses the write; it then
   * reports the exit with the captured code, as guardedSend does for a pane
   * found gone. Everything else keeps the old best-effort behaviour: a failed
   * or timed-out read, or a pane not found, lets the write run and guardedSend
   * classifies its failure. Returns false when the write must not run.
   */
  private preparePaneForWrite(): boolean {
    if (this.exited) return false;
    let answer: string;
    try {
      answer = String(execFileSync('tmux', [...this.tmuxArgs, 'display-message', '-p', '-t', this.paneTarget, PANE_WRITE_CHECK_FORMAT], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
        env: tmuxEnv(),
      }) ?? '');
    } catch {
      // Pane may be gone or tmux may be restarting; keep the original write path best-effort.
      return true;
    }
    const verdict = classifyPaneProbeAnswer(answer);
    if (verdict.state === 'exists') this.noteAuthoritativePaneExists(verdict.serverPid);
    if (verdict.state === 'missing' && verdict.deathLine !== undefined) {
      process.stderr.write(`[tmux-pipe-backend] refusing write: pane ${this.paneTarget} is dead (remain-on-exit remnant); reporting the CLI exit\n`);
      this.capturePaneDeathSync(verdict.deathLine);
      this.dumpRecentOutputTail();
      this.noteServerReplacedAtPaneLoss();
      this.handlePaneExit();
      return false;
    }
    const inMode = answer.replace(/\r?\n$/, '').split(':')[5]?.trim();
    if (inMode === '1') {
      try {
        execFileSync('tmux', [...this.tmuxArgs, 'send-keys', '-t', this.paneTarget, '-X', 'cancel'], {
          stdio: 'ignore',
          timeout: 1000,
          env: tmuxEnv(),
        });
      } catch { /* best-effort, as before */ }
    }
    return true;
  }

  enterCopyMode(): void {
    if (this.exited) return;
    execFileSync('tmux', [...this.tmuxArgs, 'copy-mode', '-e', '-t', this.paneTarget], {
      stdio: 'ignore',
      timeout: 5000,
      env: tmuxEnv(),
    });
  }

  sendCopyModeCommand(xCommand: string): void {
    if (this.exited) return;
    execFileSync('tmux', [...this.tmuxArgs, 'send-keys', '-t', this.paneTarget, '-X', xCommand], {
      stdio: 'ignore',
      timeout: 5000,
      env: tmuxEnv(),
    });
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.ownsSession) {
      // resize-window landed in tmux 2.9; on older builds (2.8) it fails
      // silently under stdio:'ignore' and the window keeps its spawn size.
      // resize-pane works on every version and sets the same geometry here
      // (we own the pane's only window). Unknown version → keep the old
      // command so behaviour is unchanged where the probe can't answer.
      const version = getTmuxVersionCached();
      const subcommand = version !== null && !tmuxVersionAtLeast(version, 2, 9)
        ? 'resize-pane'
        : 'resize-window';
      execFileSync('tmux', [...this.tmuxArgs, subcommand, '-t', this.paneTarget, '-x', String(cols), '-y', String(rows)], {
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
    // Replay an exit spawn() reported before any listener existed (see
    // pendingExit) instead of silently dropping it.
    if (this.pendingExit) {
      try { cb(this.pendingExit.code, this.pendingExit.signal); } catch { /* listener crash is benign */ }
      return;
    }
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
        execSync(`${this.tmuxCmd} pipe-pane -t ${shellescape(this.paneTarget)}`, { stdio: 'ignore', timeout: 3000, env: tmuxEnv() });
      } catch { /* pane may already be gone — benign */ }
      this.pipeAttached = false;
    }
    this.teardownFifoReader();
  }

  destroySession(): void {
    this.kill();
    if (this.ownsSession) {
      TmuxBackend.killSession(this.paneTarget, this.socketName);
      this.discardLaunchFile();
    }
  }

  getChildPid(): number | null {
    try {
      const out = execSync(
        `${this.tmuxCmd} display-message -p -t ${shellescape(this.paneTarget)} '#{pane_pid}'`,
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
    this.lastProbeState = 'exists';
    this.serverUnreachableSince = null;
    // Anchor the server pid at ATTACH time: pipe-pane succeeding just proved
    // this server is alive and holds the pane. The first poll is delayed
    // 1.0–1.75s; waiting for it left a window in which a server replaced right
    // after a resume was indistinguishable from a CLI crash and still spent the
    // fresh-session fallback budget (the second-hit window in the 2026-11-06
    // fleet loss). An unreadable answer stays undefined and the first
    // successful probe below fills it later — same conservative semantics.
    if (this.lastLiveServerPid === undefined) this.lastLiveServerPid = this.readPaneServerPid(2000);
    // The attach itself counts as activity: a CLI that dies while booting is
    // seen on the fast cadence.
    this.activeUntil = Date.now() + LIFECYCLE_ACTIVITY_WINDOW_MS;
    if (this.watchCliPid !== undefined) {
      // The watched CLI pid (adopt mode) is a pure process.kill(pid,0) syscall —
      // it can only report ESRCH (gone) or EPERM (alive), never a transient
      // timeout / EMFILE failure. So pid-death is DECISIVE: tear down at once.
      // It runs on its OWN 1s timer, not on the tmux cadence (which goes idle):
      // this is the ≤1s guard against routing Lark input into the user's bare
      // shell after the CLI exits to a still-alive pane. It costs no tmux call.
      this.pidWatchTimer = setInterval(() => {
        if (!this.exited && !this.isCliPidAlive()) this.handleAdoptedCliPidExit();
      }, ADOPT_PID_CHECK_MS);
    }
    this.armLifecycleTimer(tmuxLifecycleInitialDelayMs(this.paneTarget));
  }

  private handleAdoptedCliPidExit(): void {
    process.stderr.write(`[tmux-pipe-backend] adopted CLI pid ${this.watchCliPid} exited; detaching observer\n`);
    this.handlePaneExit();
  }

  /** True once the watcher this async step belongs to has been stopped,
   *  restarted, or the pane torn down — its answer must not act any more. */
  private lifecycleStale(epoch: number): boolean {
    return this.exited || epoch !== this.lifecycleEpoch;
  }

  private lifecycleEvidenceStale(epoch: number, generation: number): boolean {
    return this.lifecycleStale(epoch) || generation !== this.livenessEvidenceGeneration;
  }

  /** Record fresh live evidence from a synchronous probe. Do not call this from
   *  an async answer: its ordering against newer synchronous evidence is not
   *  authoritative. A live answer also proves the server reachable, so all
   *  destructive clocks/streaks restart from this newer observation. */
  private noteAuthoritativePaneExists(serverPid: number | undefined): void {
    // A live pane only ever lives on the server that created it, so its server
    // pid needs recording once. Do this before any older async answer can act.
    if (this.lastLiveServerPid === undefined) this.lastLiveServerPid = serverPid;
    this.livenessEvidenceGeneration += 1;
    // A death observed by the invalidated chain belongs to the old lifecycle;
    // its exit code must not win over the next real death's code.
    this.observedDeathStatus = undefined;
    this.livenessGate.reset();
    this.probeSetbackStreak = 0;
    this.lastProbeState = 'exists';
    this.serverUnreachableSince = null;
  }

  private armLifecycleTimer(delayMs: number): void {
    if (this.lifecycleTimer) clearTimeout(this.lifecycleTimer);
    const epoch = this.lifecycleEpoch;
    this.lifecycleTimerDueAt = Date.now() + delayMs;
    this.lifecycleTimer = setTimeout(() => {
      this.lifecycleTimer = null;
      this.runLifecycleProbe(epoch).catch((err: any) => {
        // Never an unhandled rejection (that kills the worker): log and keep
        // watching on the normal cadence.
        process.stderr.write(`[tmux-pipe-backend] lifecycle probe failed unexpectedly: ${err?.message ?? err}\n`);
        if (!this.lifecycleStale(epoch)) this.armLifecycleTimer(this.nextProbeDelayMs());
      });
    }, delayMs);
  }

  /**
   * One lifecycle round: one asynchronous tmux command in the common case
   * (the probe answers `exists`). The event loop keeps running while tmux
   * answers — a slow shared server no longer stalls every worker's input,
   * IPC and web terminal for the length of each probe. The next round is
   * armed only after this one settled, so probes of one pane never overlap.
   */
  private async runLifecycleProbe(epoch: number): Promise<void> {
    if (this.lifecycleStale(epoch)) return;
    if (!this.isCliPidAlive()) {
      this.handleAdoptedCliPidExit();
      return;
    }
    const evidenceGeneration = this.livenessEvidenceGeneration;
    const probe = await this.probePaneAddressabilityAsync(2000, epoch, evidenceGeneration);
    if (this.lifecycleStale(epoch)) return;
    if (evidenceGeneration !== this.livenessEvidenceGeneration) {
      // A synchronous write-side probe saw the pane alive after this round
      // started. Its answer is newer, so this round must not reapply old misses.
      this.armLifecycleTimer(this.nextProbeDelayMs());
      return;
    }
    this.probeSetbackStreak = probe.state === 'exists' ? 0 : this.probeSetbackStreak + 1;
    this.lastProbeState = probe.state;
    await this.recordPaneProbe(probe, epoch, evidenceGeneration);
    if (!this.lifecycleStale(epoch)) this.armLifecycleTimer(this.nextProbeDelayMs());
  }

  /**
   * Activity in the pane keeps it on the fast cadence (see the cadence notes at
   * LIFECYCLE_ACTIVE_PROBE_MS). An INPUT (a write) also pulls a probe that is
   * waiting out the idle cadence forward to the active one — the first write
   * after a long idle stretch is exactly when a dead CLI should be noticed
   * fast. Output never pulls a probe forward. Only a healthy schedule moves:
   * during a missing streak the confirmation backoff runs its own clock (a
   * write every 500ms must not squeeze the 3s/9s debounce into 3s), and during
   * an unknown streak activity must not add probes to a struggling server.
   * Cheap: called for every output chunk.
   */
  private noteLifecycleActivity(kind: 'input' | 'output'): void {
    const now = Date.now();
    if (kind === 'output') {
      if (now - this.lastOutputAt > LIFECYCLE_OUTPUT_ACTIVITY_WINDOW_MS) this.outputRunStartedAt = now;
      this.lastOutputAt = now;
      // A single burst (a repaint) is not a turn in progress.
      if (now - this.outputRunStartedAt < LIFECYCLE_SUSTAINED_OUTPUT_MS) return;
    }
    const until = now + (kind === 'input' ? LIFECYCLE_ACTIVITY_WINDOW_MS : LIFECYCLE_OUTPUT_ACTIVITY_WINDOW_MS);
    if (until > this.activeUntil) this.activeUntil = until;
    if (kind !== 'input') return;
    if (this.exited || this.lifecycleTimer === null || this.probeSetbackStreak > 0) return;
    if (this.lifecycleTimerDueAt - now <= LIFECYCLE_ACTIVE_PROBE_MS) return;
    this.armLifecycleTimer(LIFECYCLE_ACTIVE_PROBE_MS);
  }

  /**
   * Delay to the next lifecycle probe — see lifecycleProbeDelayMs. Healthy
   * panes: 1s while active, the idle cadence otherwise. Setbacks keep the old
   * backoff (3s / 9s), which also stretches the missing-streak teardown window
   * to ~12s so a short shared-server stall no longer converts into a
   * fleet-wide teardown, and sheds probe load while the server struggles.
   * Detection latency for a genuinely dead pane: the time to the first probe
   * that sees it (≤ 1s active, ≤ the idle cadence idle) plus that ~12s
   * debounce; writes never wait for it (preparePaneForWrite / guardedSend),
   * and adopt-mode pid-death stays on its own 1s timer.
   */
  private nextProbeDelayMs(): number {
    return lifecycleProbeDelayMs({
      // While connection-level failures run the outage clock, sample at the
      // active cadence whatever the pane's activity: the 60s escalation must
      // rest on a dense run of failures. On the idle cadence 60s holds only ~3
      // samples, so an intermittent refusal storm (some connects refused, some
      // answered) "hits" every sample far more often and tears live sessions
      // down. Probe deadlines (a wedged server) do not start that clock and
      // keep the idle cadence: they shed load instead.
      recentlyActive: Date.now() < this.activeUntil || this.serverUnreachableSince !== null,
      idleProbeMs: tmuxLifecycleIdleProbeMs(this.paneTarget),
      setbackStreak: this.probeSetbackStreak,
      lastState: this.lastProbeState,
    });
  }

  /** `#{pid}` of the server holding this pane; undefined when unreadable.
   *  For an unknown target tmux 3.x exits 0 and still expands the server-level
   *  `#{pid}`, so the pane id is read in the same answer and must be non-empty. */
  private readPaneServerPid(timeoutMs: number): number | undefined {
    try {
      const answer = execFileSync(
        'tmux', [...this.tmuxArgs, 'display-message', '-p', '-t', this.paneTarget, '#{pane_id} #{pid}'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs, env: tmuxEnv() },
      );
      const [paneId = '', pid] = String(answer).replace(/\r?\n$/, '').split(' ');
      return paneId.trim() ? parsePositivePid(pid) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Tri-state pane probe, ONE tmux command (PANE_PROBE_FORMAT): `exists`,
   * authoritative `missing` (pane not found, or a corpse kept by
   * remain-on-exit), or `unknown` when the server gave no answer — see
   * classifyPaneProbeAnswer / classifyPaneProbeFailure. Synchronous: used by
   * the write path (guardedSend) and isPaneAlive(); the lifecycle watcher uses
   * the async twin below.
   */
  private probePaneAddressability(timeoutMs: number): PaneProbeResult {
    let raw: string;
    try {
      raw = String(execFileSync(
        'tmux', [...this.tmuxArgs, 'display-message', '-p', '-t', this.paneTarget, PANE_PROBE_FORMAT],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs, env: tmuxEnv() },
      ) ?? '');
    } catch (err: any) {
      return classifyPaneProbeFailure(err, `${this.tmuxCmd} display-message`);
    }
    const verdict = classifyPaneProbeAnswer(raw);
    if (verdict.state === 'exists') {
      // This synchronous answer can arrive while an older async final missing
      // confirmation is awaiting its turn on the event loop. Make that older
      // destructive sequence stale before returning the live verdict.
      this.noteAuthoritativePaneExists(verdict.serverPid);
      return { state: 'exists' };
    }
    if (verdict.deathLine !== undefined) this.capturePaneDeathSync(verdict.deathLine);
    return { state: 'missing', reason: verdict.reason };
  }

  /** {@link probePaneAddressability} without blocking the event loop. */
  private async probePaneAddressabilityAsync(timeoutMs: number, epoch: number, evidenceGeneration: number): Promise<PaneProbeResult> {
    const r = await runTmuxAsync(
      [...this.tmuxArgs, 'display-message', '-p', '-t', this.paneTarget, PANE_PROBE_FORMAT],
      timeoutMs,
    );
    if (!r.ok) return classifyPaneProbeFailure(r.error, `${this.tmuxCmd} display-message`);
    const verdict = classifyPaneProbeAnswer(r.stdout);
    if (verdict.state === 'exists') {
      // Even a read-only side effect must not come from an answer older than a
      // synchronous exists: this anchor drives server-replacement classification.
      if (this.lastLiveServerPid === undefined && !this.lifecycleEvidenceStale(epoch, evidenceGeneration)) {
        this.lastLiveServerPid = verdict.serverPid;
      }
      return { state: 'exists' };
    }
    if (verdict.deathLine !== undefined && !this.lifecycleEvidenceStale(epoch, evidenceGeneration)) {
      await this.capturePaneDeathAsync(verdict.deathLine, epoch, evidenceGeneration);
    }
    return { state: 'missing', reason: verdict.reason };
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
  private async recordPaneProbe(probe: PaneProbeResult, epoch: number, evidenceGeneration: number): Promise<void> {
    if (this.lifecycleEvidenceStale(epoch, evidenceGeneration)) return;
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
          this.noteServerReplacedAtPaneLoss();
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
    const confirm = await this.probePaneAddressabilityAsync(3000, epoch, evidenceGeneration);
    if (this.lifecycleEvidenceStale(epoch, evidenceGeneration)) return;
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
    const reach = await TmuxPipeBackend.tmuxServerReachability(3000, this.tmuxArgs);
    if (this.lifecycleEvidenceStale(epoch, evidenceGeneration)) return;
    if (reach === 'unreachable') {
      this.livenessGate.reset();
      if (this.serverUnreachableSince === null) this.serverUnreachableSince = Date.now();
      process.stderr.write(
        `[tmux-pipe-backend] pane reported missing but tmux server is not answering; treating as server outage and staying attached\n`,
      );
      return;
    }
    if (this.lifecycleEvidenceStale(epoch, evidenceGeneration)) return;
    process.stderr.write(
      `[tmux-pipe-backend] ${this.ownsSession ? 'managed' : 'adopted'} pane gone after ${ADOPT_LIVENESS_MAX_FAILURES} consecutive authoritative misses; detaching observer\n`,
    );
    this.noteServerReplacedAtPaneLoss();
    this.handlePaneExit();
  }

  /** pid of the tmux server currently answering on this socket, or undefined
   *  when nobody answers / the answer is unreadable. Read-only. */
  private static answeringServerPid(timeoutMs: number, socketArgs: readonly string[]): number | undefined {
    try {
      const out = execFileSync('tmux', [...socketArgs, 'list-sessions', '-F', '#{pid}'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: timeoutMs,
        env: tmuxEnv(),
      });
      return parsePositivePid(String(out).split('\n')[0]);
    } catch {
      return undefined;
    }
  }

  /** True when the last pane exit was caused by losing the whole tmux server
   *  (a different server now answers on the socket), not by the CLI exiting. */
  exitedBecauseServerReplaced(): boolean {
    return this.exited && this.serverReplacedAtExit;
  }

  /** Before a probe-confirmed teardown, latch whether a DIFFERENT server now
   *  answers on the socket. Idempotent and skipped when no live-server pid was
   *  ever anchored: an unreadable verdict stays "CLI exit", the conservative
   *  answer that keeps the crash-loop FRESH fallback. The adopt pid-death path
   *  does not call this — there the CLI process itself was observed gone. */
  private noteServerReplacedAtPaneLoss(): void {
    if (this.serverReplacedAtExit || this.lastLiveServerPid === undefined) return;
    const answeringPid = TmuxPipeBackend.answeringServerPid(3000, this.tmuxArgs);
    if (!paneLossWasServerReplacement(this.lastLiveServerPid, answeringPid)) return;
    this.serverReplacedAtExit = true;
    process.stderr.write(
      `[tmux-pipe-backend] the tmux server on this socket was replaced (was pid ${this.lastLiveServerPid}); the CLI did not exit on its own\n`,
    );
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
  private static async tmuxServerReachability(timeoutMs: number, socketArgs: readonly string[]): Promise<'up' | 'down' | 'unreachable'> {
    const r = await runTmuxAsync([...socketArgs, 'list-sessions', '-F', '#{session_id}'], timeoutMs);
    // Same connection-level classifier as the pane probe, so both agree on
    // what "the client never reached the server" looks like.
    return r.ok ? 'up' : serverReachabilityFromFailure(r.error);
  }

  private stopLifecycleWatcher(): void {
    // Any probe still awaiting tmux belongs to the old epoch and drops its answer.
    this.lifecycleEpoch += 1;
    if (this.lifecycleTimer) {
      clearTimeout(this.lifecycleTimer);
      this.lifecycleTimer = null;
    }
    if (this.pidWatchTimer) {
      clearInterval(this.pidWatchTimer);
      this.pidWatchTimer = null;
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
    // destroy() stops delivery now and closes the fd after any in-flight read
    // finishes. Never closeSync that fd as well: its number can be reused by
    // the next spawn before the stream's queued close runs (Bun and Node).
    const stream = this.readStream;
    this.readStream = null;
    // 有意保留：fifoFd 已无生产读者（#1394 起 fd 的关闭完全交给 ReadStream），但
    // test/fixtures/tmux-pipe-exit-fixture.ts 通过类型断言读取它；此处显式读一次以满足 noUnusedLocals。
    void this.fifoFd;
    this.fifoFd = null;
    stream?.destroy();
    if (this.fifoWakeFd !== null) {
      // EAGAIN (pipe full) is fine: a full pipe means the read already has data
      // to return, so it is not parked. Any other error is equally non-fatal —
      // we are tearing down regardless.
      try { fs.writeSync(this.fifoWakeFd, '\0'); } catch { /* already unblocked */ }
      try { fs.closeSync(this.fifoWakeFd); } catch { /* already closed */ }
      this.fifoWakeFd = null;
    }
    try { fs.unlinkSync(this.fifoPath); } catch { /* already gone */ }
  }

  private handlePaneExit(): void {
    if (this.exited) return;
    this.exited = true;
    this.stopLifecycleWatcher();
    if (this.pipeAttached) {
      try {
        execSync(`${this.tmuxCmd} pipe-pane -t ${shellescape(this.paneTarget)}`, { stdio: 'ignore', timeout: 3000, env: tmuxEnv() });
      } catch { /* pane may already be gone — benign */ }
      this.pipeAttached = false;
    }
    // Read the real exit status BEFORE tearing the fifo down / killing the
    // remnant: a retaining `remain-on-exit` (per remainOnExitMode()) keeps
    // exactly this pane addressable while it is dead, and
    // `#{pane_dead_status}` is the only carrier of 77/127 through tmux.
    // Order matters — after the kill below there is no pane left to ask.
    // Prefer the exit code captured WHILE a probe first confirmed the corpse
    // (observedDeathStatus): that read happened while the corpse was fresh and
    // tmux responsive to it. Only if no probe ever confirmed death do we read
    // here (e.g. reattach-corpse path or pid-death path). This is the #2434
    // fix: under deep starvation this terminal read can come back unreadable
    // ~13s after death, but the code was already latched at confirmation time.
    const death = this.readPaneDeath();
    // Effective real code: the latched probe capture wins over a now-unreadable
    // terminal read. observedDeathStatus: number = real code; null = confirmed
    // dead, signal (no code); undefined = no probe ever confirmed death.
    const observedCode = this.observedDeathStatus;
    this.teardownFifoReader();
    // We get here only after the lifecycle watcher's OWN authoritative miss
    // sequence (N consecutive misses + final confirm), so the owned pane is
    // already judged gone. Reap its remnant for anything but an explicit
    // live answer:
    //  - dead: remain-on-exit kept a corpse (signal death leaves status
    //    empty, which is exactly why cleanup keys on the verdict, not code);
    //  - unknown: every bounded re-read was unreadable (tmux timeout / the
    //    session racing away). A single transient read used to skip the reap
    //    AND fall back to code 1, leaking the corpse and hiding the real code
    //    (#2408). The session is authoritatively missing anyway, so best-effort
    //    kill it (a no-op if it already vanished).
    //  - alive: contradicting the watcher and theoretically unreachable; do
    //    not kill a live pane.
    if (death.kind !== 'alive') this.killDeadPaneRemnant();
    // Resolve the reported code from, in order:
    //  1. a real code latched when a probe confirmed the corpse (survives later
    //     starvation that makes the terminal read unreadable) — #2434;
    //  2. a real code from this terminal read if no probe captured one;
    //  3. historic sentinel 1 for unknown / status-less signal death.
    const terminalCode = death.kind === 'dead' ? death.status : null;
    // Merge the two observations of the dead pane's code:
    //  - a real code latched when a probe first confirmed death wins (it was
    //    read while the corpse was freshest);
    //  - otherwise a LATE real code from this terminal read is still adopted,
    //    even when the probe only latched `null` (death confirmed but its
    //    1: -> 1:code publish window ran past the bounded wait under
    //    starvation): discarding it would be a second 77 -> 1 doorway (#2434);
    // Merge is delegated to the documented pure resolveReportedExitCode
    // (number latch wins; otherwise a late terminal real code is adopted;
    // code-less/null at both sides stays null -> sentinel 1 below).
    const realCode = resolveReportedExitCode(observedCode, terminalCode);
    this.fireExit(realCode ?? 1, null);
  }

  /**
   * Whether the pane is a kept corpse, and the status the CLI returned if tmux
   * recorded one.
   * `#{pane_dead}` tells us the pane is dead rather than live;`#{pane_dead_status}`
   * carries the status the CLI actually returned. Both are only populated
   * because applySessionOptions() sets a retaining `remain-on-exit` per
   * session (`failed` on tmux >= 3.2, `on` on older/unknown builds).
   * A SIGNAL death leaves the status empty (tmux has no exit code to report),
   * so `dead` and `status` are deliberately separate. An `unknown` verdict
   * (every bounded re-read unreadable) means we could not classify the pane
   * this round — the caller (which only gets here after the lifecycle
   * watcher's own authoritative miss sequence) still tears the owned session
   * down but cannot supply a real exit code.
   *
   * Deliberately does NOT consult `#{pane_id}` for liveness: a dead-but-kept
   * pane still answers a pane_id, which is exactly the trap that would make a
   * liveness probe report `exists` forever (see probePaneAddressability).
   */
  private readPaneDeath(): PaneDeathResolution {
    let reaperNudged = false;
    // One display-message round; an error is an unreadable (empty) line.
    const readLine = (): string => {
      try {
        const line = String(
          execFileSync(
            'tmux',
            [...this.tmuxArgs, 'display-message', '-p', '-t', this.paneTarget, PANE_DEATH_FORMAT],
            { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PANE_DEATH_PROBE_TIMEOUT_MS, env: tmuxEnv() },
          ) ?? '',
        ).trim();
        // Dead-but-status-less line. The format carries pane/server pids
        // after the status (PANE_DEATH_FORMAT), so match the empty second
        // field rather than the whole literal.
        const [deadFlag, deadStatus] = line.split(':');
        if (this.legacyRetention && deadFlag === '1' && (deadStatus ?? '').trim() === '' && !reaperNudged) {
          reaperNudged = true;
          // Old libutempter builds can lose SIGCHLD while closing the pane,
          // leaving a zombie and an indefinitely empty status (tmux #4559).
          // One short job on THIS server wakes its child reaper; the existing
          // bounded reads below still decide the real status or signal fallback.
          try {
            execFileSync('tmux', [...this.tmuxArgs, 'run-shell', '-b', 'true'], {
              stdio: 'ignore', timeout: PANE_DEATH_PROBE_TIMEOUT_MS, env: tmuxEnv(),
            });
          } catch { /* best effort: keep the confirmed death and bounded retry */ }
        }
        return line;
      } catch {
        return '';
      }
    };
    // resolvePaneDeath retries both ordering gaps: status published a beat
    // after death, AND an unreadable FIRST line (a transient tmux timeout),
    // which used to be collapsed straight into "not dead". A status tmux has
    // not published because it has not reaped the pane yet comes from the
    // kernel instead (#2453).
    return resolvePaneDeath(readLine(), readLine, sleepSyncMs, undefined, readUnreapedPaneExit);
  }

  /** Take down the corpse a retaining `remain-on-exit` left behind (and its session).
   *  Best-effort and bounded: the pane is already dead, so failing here only
   *  leaves a stale session that the orphan reaper owns. */
  private killDeadPaneRemnant(): void {
    if (!this.ownsSession) return;
    try {
      execFileSync('tmux', [...this.tmuxArgs, 'kill-session', '-t', this.paneTarget], {
        stdio: 'ignore', timeout: 3000, env: tmuxEnv(),
      });
    } catch { /* already gone or another teardown won the race */ }
  }

  /**
   * A fresh launch found its session name taken. Launch selection reads a kept
   * corpse (every pane dead, retained by `remain-on-exit`) as 'missing', so the
   * next generation of that session comes here to create it — and used to fail
   * with "duplicate session" on every attempt until someone removed the corpse
   * by hand (2026-11-06: corpses left behind by a tmux server crash kept three
   * sessions from starting for hours). Reap the session ONLY when tmux itself
   * reports every one of its panes dead; a live pane, or an answer that cannot
   * be read, keeps the session and the original error. Managed `bmx-*`
   * sessions on this backend's own server only. Returns true once the corpse
   * was killed (or vanished meanwhile), i.e. creating the name again may work.
   *
   * Both commands name the session EXACTLY (`=name:` / `=name`). The corpse can
   * vanish between them (another teardown reaps it), and a bare `-t name` then
   * falls back to a PREFIX match — `kill-session` would hit a live session whose
   * name merely starts with ours; `list-panes -s -t =name` without the colon
   * even answers for some other session (both measured on tmux 3.3a). Lines are
   * still filtered by `#{session_name}` so no other session's panes can count.
   */
  private reapDeadSessionHoldingName(spawnEnv: NodeJS.ProcessEnv | undefined): boolean {
    if (!this.ownsSession || !this.paneTarget.startsWith('bmx-')) return false;
    let panes: string[];
    try {
      panes = String(execFileSync(
        'tmux',
        [...this.tmuxArgs, 'list-panes', '-s', '-t', `=${this.paneTarget}:`, '-F', '#{session_name}|#{pane_dead}:#{pane_dead_status}'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PANE_DEATH_PROBE_TIMEOUT_MS, env: tmuxEnv(spawnEnv) },
      ) ?? '').split('\n').map(line => line.trim()).filter(Boolean);
    } catch {
      return false;
    }
    const own = `${this.paneTarget}|`;
    if (panes.length === 0 || !panes.every(line => line.startsWith(own) && line.slice(own.length).startsWith('1:'))) return false;
    process.stdout.write(
      `[tmux-pipe-backend] ${this.paneTarget} is held by a dead session (pane_dead:status ${panes.map(line => line.slice(own.length)).join(', ')}); reaping it before creating the session afresh\n`,
    );
    try {
      execFileSync('tmux', [...this.tmuxArgs, 'kill-session', '-t', `=${this.paneTarget}`], {
        stdio: 'ignore', timeout: 3000, env: tmuxEnv(spawnEnv),
      });
    } catch { /* already gone; a creation that still collides reports the real error */ }
    return true;
  }

  private createDetachedSession(bin: string, args: string[], opts: SpawnOpts, pipeShellCommand: string): { error: unknown } | undefined {
    const instanceIdentity = opts.env?.BOTMUX_CODEX_INSTANCE_BINDING;
    // `new-session -e` only exists since tmux 3.2 (3.0/3.1 reject it with
    // "unknown flag", a deterministic non-retryable launch failure). On older
    // or unparsable versions the binding is written with set-environment after
    // a proven-fresh creation instead. Unknown version deliberately takes the
    // conservative path (never send a flag the server may not understand).
    // Session creation is a once-per-session boundary: if the cached probe is
    // unknown (a transient `tmux -V` timeout within the null TTL), re-ask once
    // rather than downgrading the whole session's exit-code channel on a
    // modern host. Still fail-closed if the fresh probe is unreadable.
    const tmuxVersion = serverTmuxVersion(this.tmuxArgs, resolveTmuxVersionAtSessionBoundary());
    const newSessionAcceptsE = tmuxVersionAtLeast(tmuxVersion, 3, 2);
    const remainOnExit = remainOnExitMode(tmuxVersion);
    this.legacyRetention = remainOnExit === 'on';
    // The launch itself goes through a private file (pane-launch.ts): the
    // shell, wrapper and argv are exactly what used to follow `--` inline.
    // Strict panes keep their direct `env -i` exec; /bin/sh -c reads no
    // profile, so it only loads the argv before exec'ing it.
    const shellSpec = opts.strictEnv ? { shell: '/bin/sh', flags: [] } : resolveUserShell(process.env, opts.launchShell);
    const shellKind = shellKindForPath(shellSpec.shell);
    const launchFile = writePaneLaunchFile(opts.paneLaunchDir, opts.strictEnv
      ? { kind: shellKind, script: 'exec "$@"', argv: strictPaneCommand(bin, args, opts) }
      : {
        kind: shellKind,
        script: shellWrapperScript(resolveBotmuxWrapperBinDir(opts.env ?? process.env), shellKind),
        argv: [
          opts.cwd,
          ...buildBotmuxEnvAssignments(
            opts.env,
            opts.injectEnv,
            opts.unsetEnv,
            opts.gitConfigPairs,
            opts.protectedUnsetEnv,
          ),
          bin, ...args,
        ],
      });
    this.launchFile = launchFile;
    const loader = paneLaunchLoader(shellKind);
    const argv = [
      'new-session',
      '-d',
      // Have tmux print the identity of the session THIS command created,
      // atomically with creating it (see createdSession).
      '-P', '-F', SESSION_IDENTITY_FORMAT,
      '-s', this.paneTarget,
      '-x', String(opts.cols),
      '-y', String(opts.rows),
      // On >= 3.2 mark atomically at creation, so a session whose creating
      // reply was lost to a timeout still carries the binding and can be
      // adopted via the duplicate path below.
      ...(instanceIdentity && newSessionAcceptsE ? ['-e', `BOTMUX_CODEX_INSTANCE_BINDING=${instanceIdentity}`] : []),
      '--',
      ...(opts.strictEnv
        ? [shellSpec.shell, '-c', loader, '_', launchFile.path]
        : shellCommandArgv(shellSpec, loader, [launchFile.path])),
      // `remain-on-exit` must be in effect BEFORE the CLI can exit, or a
      // fast death (exit 127 from a missing binary is sub-100ms) takes the
      // whole session with it and the exit status is gone forever. applySession
      // Options() at the end of this method is far too late — measured: a
      // `set-option` after the fact reports `: ` (no status) for exactly the
      // crash shape this channel exists to report. Chaining it into the SAME
      // tmux invocation (tmux runs `\;`-separated commands in one server queue,
      // in order) makes it atomic with creation. `failed` keeps a pane only for
      // a NON-zero exit. Before 3.2, `on` also retains clean exits until the
      // lifecycle watcher reads their status and removes the dead pane.
      ';', 'set-option', '-t', this.paneTarget, 'remain-on-exit', remainOnExit,
      // One server queue: subscribe before tmux can process the CLI's first
      // output. No later client invocation may replace a successful pipe,
      // since doing so could discard those one-shot startup/OSC bytes.
      ';', ...(this.legacyRetention
        ? ['if-shell', '-F', '-t', this.paneTarget, '#{pane_dead}',
          `display-message -p ${DEAD_PANE_MARKER}`,
          `pipe-pane -O -t ${tmuxQuote(this.paneTarget)} ${tmuxQuote(pipeShellCommand)}`]
        : ['pipe-pane', '-O', '-t', this.paneTarget, pipeShellCommand]),
    ];
    const commandBytes = tmuxCommandBytes(argv);
    // Every failure below ends here. The chat only ever sees `error` (tmux's
    // reason, never the argv); the command goes to the worker's stdout, i.e.
    // the daemon's local out log. The launch file goes too: no pane we can
    // vouch for will read it, and it holds the per-bot env values.
    const fail = (error: Error, detail: string): Error => {
      launchFile.discard();
      this.launchFile = null;
      process.stdout.write(
        `[tmux-pipe-backend] new-session ${this.paneTarget} failed: ${detail}\n`
        + `[tmux-pipe-backend]   command (${commandBytes}/${TMUX_COMMAND_MAX_BYTES} bytes): tmux ${[...this.tmuxArgs, ...argv].join(' ')}\n`
        + `[tmux-pipe-backend]   launch file ${launchFile.path}: ${launchFile.bytes} bytes, ${launchFile.argc} args, cli ${opts.cliBin ?? bin}\n`,
      );
      return error;
    };
    try {
      assertTmuxCommandFits(argv);
    } catch (err: any) {
      throw fail(err, err?.message ?? String(err));
    }
    // Bounded retries against a stalled shared server (instant clean
    // ECONNREFUSED under backlog overflow), a command timeout, or a
    // spawn-level EMFILE/EAGAIN. A server-answered deterministic rejection
    // (bad option, …) is re-thrown at once. "duplicate session" on a RETRY
    // means an earlier timed-out attempt actually created the session
    // server-side → treat as success.
    let createdIdentity: string | null = null;
    let queuedPipeError: { error: unknown } | undefined;
    let corpseReaped = false;
    // Anti-fork gate (default ON; BOTMUX_DISABLE_TMUX_ANTI_FORK=1 opts out):
    // BEFORE every new-session — including the first attempt — refuse to boot a
    // competing tmux server when a LIVE server still listens on this label but
    // is not answering (slow, or its socket file was unlinked under it). The
    // very first new-session already forks the orphan in that state (measured),
    // so this cannot live in the retry branch. One gate spans all attempts so
    // its bounded wait is not reset per attempt. Pass the SAME env the
    // new-session exec below uses, so the owner probe, -N capability and socket
    // path resolve against the launch's PATH/TMUX_TMPDIR (not daemon ambient).
    const bootSpawnEnv = opts.strictEnv ? inheritBotEnv(opts.env, { mode: 'strict' }) : opts.env;
    const bootGate = createTmuxBootGate(this.socketName, { env: bootSpawnEnv });
    for (let attempt = 0; ; attempt++) {
      // [] = normal spawn (attach, or a proven cold boot); ['-N'] = attach
      // only, never fork (tmux ≥ 3.2), closing the client-internal macOS
      // ECONNREFUSED fork race.
      let bootLeading: string[];
      try {
        bootLeading = bootGate.leadingArgs();
      } catch (gateErr: any) {
        // Bound-but-unreachable past the bounded wait. Route through fail() so
        // the secret-bearing pane launch file is discarded exactly like any
        // other startup failure (a throw here would otherwise leak it).
        if (opts.strictEnv) throw fail(gateErr, tmuxStartupFailureSummary(gateErr));
        throw fail(tmuxNewSessionError(gateErr, commandBytes), tmuxStartupFailureSummary(gateErr));
      }
      const noFork = bootLeading.includes('-N');
      try {
        const printed = execFileSync('tmux', [...this.tmuxArgs, ...bootLeading, ...argv], {
          cwd: opts.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 5000,
          env: tmuxEnv(bootSpawnEnv),
        });
        createdIdentity = parseSessionIdentity(String(printed ?? ''));
        if (String(printed).trim().split('\n').includes(DEAD_PANE_MARKER)) {
          queuedPipeError = { error: deadPaneSubscriptionError() };
        } else {
          this.pipeAttached = true;
        }
        break;
      } catch (err: any) {
        // new-session can succeed and print its identity before a later queue
        // command fails. Preserve that ownership for rollback, and hand the
        // failure to the existing bounded pipe-pane retry/diagnostic path.
        createdIdentity = parseSessionIdentity(String(err?.stdout ?? ''));
        if (createdIdentity) {
          queuedPipeError = { error: err };
          break;
        }
        const stderrText = (err?.stderr?.toString?.() ?? '').trim();
        // A -N spawn that answered "no server running" raced an owner dying
        // between the gate probe and the exec. Retry: the next gate cycle sees
        // no listener and permits a real cold boot (without -N).
        const noForkRacedAway = noFork && /no server running/i.test(stderrText);
        if (attempt > 0 && /duplicate session/i.test(stderrText)) {
          if (opts.strictEnv) throw fail(new Error('Refusing unverified strict tmux-pipe generation after a startup retry'), stderrText);
          // Either an earlier timed-out attempt of ours or a racing creator made
          // it — unprovable, so this spawn never claims (or retires) it.
          break;
        }
        // On the FIRST attempt nothing of ours can hold the name yet: it is an
        // older session. Only a confirmed corpse is reaped, once; then start
        // over (attempt 0 again — a collision now is not a timed-out retry).
        // The reap talks to the server this new-session just answered from
        // (same env, hence the same PATH / TMUX_TMPDIR socket resolution).
        if (attempt === 0 && !corpseReaped && /duplicate session/i.test(stderrText)
            && this.reapDeadSessionHoldingName(bootSpawnEnv)) {
          corpseReaped = true;
          attempt = -1;
          continue;
        }
        if ((!isRetryableStartupTmuxFailure(err) && !noForkRacedAway) || attempt >= STARTUP_TMUX_RETRY_DELAYS_MS.length) {
          if (opts.strictEnv) throw fail(new Error('Strict tmux pane startup failed (command environment redacted)'), tmuxStartupFailureSummary(err));
          throw fail(tmuxNewSessionError(err, commandBytes), tmuxStartupFailureSummary(err));
        }
        // stderr feeds the startup-failure card's recent-output block: summary only.
        process.stderr.write(
          `[tmux-pipe-backend] new-session failed (attempt ${attempt + 1}/${STARTUP_TMUX_RETRY_DELAYS_MS.length + 1}); retrying: ${opts.strictEnv ? 'strict command environment redacted' : tmuxStartupFailureSummary(err)}\n`,
        );
        startupRetrySleepFn(STARTUP_TMUX_RETRY_DELAYS_MS[attempt]);
      }
    }
    // Only the identity tmux printed for the creating command proves
    // ownership; a by-name lookup could return a racing creator's session.
    this.createdSession = createdIdentity
      ? { id: createdIdentity.split(' ')[1]!, identity: createdIdentity }
      : null;
    // This session now owns the name, so an older unread file of the same
    // session can no longer be read by anyone.
    launchFile.sweepStaleSiblings();
    // Pre-3.2 (or unknown) tmux: persist the binding in the session
    // environment AFTER a proven-fresh creation, since new-session could not
    // set it atomically. set-environment exists on every supported tmux and
    // writes only this session's table (never -g). A duplicate (a timed-out
    // earlier create or a concurrent creator) is never written to — it must
    // pass assertInstanceIdentity first, otherwise we could stamp our binding
    // onto another instance's session. If this write fails the assert below
    // fails too, spawn throws, and the worker retires the session we created.
    if (this.createdSession && instanceIdentity && !newSessionAcceptsE) {
      execFileSync('tmux',
        [...this.tmuxArgs, 'set-environment', '-t', this.paneTarget, 'BOTMUX_CODEX_INSTANCE_BINDING', instanceIdentity],
        { stdio: ['ignore', 'ignore', 'pipe'], timeout: 5000, env: tmuxEnv() });
    }
    // Fence both shapes before changing options or subscribing output: a
    // duplicate must carry the expected binding; on the fresh path this also
    // re-reads the marker just written/created (redundant but fail-closed —
    // only a millisecond-scale server stall right after creation can make it
    // throw, and the next worker cycle reattaches with the pane preserved).
    if (instanceIdentity) TmuxBackend.assertInstanceIdentity(this.paneTarget, instanceIdentity, this.socketName);
    // Reuse THIS creation's boundary resolution: same backend instance, same
    // once-per-session decision — resolving again would force a redundant
    // `tmux -V` (see applySessionOptions).
    this.applySessionOptions(tmuxVersion);
    return queuedPipeError;
  }

  /**
   * After spawn() threw: kill the tmux session this very spawn() created, if
   * any. Used by the worker before it rolls back the session's sandbox tree;
   * the caller re-probes by name to decide (anything but an authoritative
   * `missing` keeps the tree). Returns whether our own session was killed.
   *
   * The identity check and the kill are ONE server-side command (`if-shell -F`
   * evaluates the condition and runs the kill in the same server's queue): with
   * a check-then-kill pair, a server that exits in between could be replaced by
   * one that hands the saved id (`$0`) to an unrelated session, and the kill
   * would land there. A different server fails the `#{pid}` comparison.
   */
  retireSessionCreatedBySpawn(): boolean {
    const created = this.createdSession;
    if (!created) return false;
    const [serverPid, sessionId, createdAt] = created.identity.split(' ');
    const ours = `#{&&:#{==:#{pid},${serverPid}},#{&&:#{==:#{session_id},${sessionId}},#{==:#{session_created},${createdAt}}}}`;
    let outcome = '';
    try {
      outcome = execFileSync('tmux', [
        ...this.tmuxArgs,
        'if-shell', '-F', '-t', sessionId!, ours,
        `display-message -p ${RETIRE_KILLED} ; kill-session -t '${sessionId}'`,
        `display-message -p ${RETIRE_KEPT}`,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, env: tmuxEnv() });
    } catch {
      return false;
    }
    if (!outcome.split('\n').includes(RETIRE_KILLED)) return false;
    this.createdSession = null;
    this.discardLaunchFile();
    return true;
  }

  /** The pane is gone or going: its launch file, if still unread, never will be. */
  private discardLaunchFile(): void {
    this.launchFile?.discard();
    this.launchFile = null;
  }

  /**
   * Apply idempotent per-session tmux options.
   *
   * `version` is the boundary resolution the caller already paid for: the
   * fresh-creation path passes the createDetachedSession() result (already
   * server-aware) so the whole creation probes the running server ONCE — a
   * second probe would add another up-to-2s wait whenever that server is
   * unreachable, for a decision already made. The reattach path (spawn()
   * backfilling options onto a session an older build created) has no prior
   * resolution, so it omits the argument and asks the server once here.
   */
  private applySessionOptions(
    version: TmuxVersion | null = serverTmuxVersion(this.tmuxArgs, resolveTmuxVersionAtSessionBoundary()),
  ): void {
    const t = shellescape(this.paneTarget);
    const env = tmuxEnv();
    try {
      // Fresh sessions set this atomically with new-session. Reattached
      // sessions need it too, before any best-effort cosmetic option can fail.
      // `version` already reflects the RUNNING server (default arg above);
      // the binary on PATH can be newer than the server on this socket.
      const remainOnExit = remainOnExitMode(version);
      // A timed-out client may already have applied the option server-side.
      this.legacyRetention = remainOnExit === 'on';
      execSync(`${this.tmuxCmd} set-option -t ${t} remain-on-exit ${remainOnExit}`, { stdio: 'ignore', env, timeout: 5000 });
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
      execSync(`${this.tmuxCmd} set-option -t ${t} status on`, { stdio: 'ignore', env, timeout: 5000 });
      execSync(`${this.tmuxCmd} set-option -t ${t} mouse on`, { stdio: 'ignore', env, timeout: 5000 });
      execSync(`${this.tmuxCmd} set-option -s set-clipboard on`, { stdio: 'ignore', env, timeout: 5000 });
      execSync(`${this.tmuxCmd} set-option -t ${t} history-limit 50000`, { stdio: 'ignore', env, timeout: 5000 });
      // window-size largest exists since tmux 3.1; older builds reject the
      // option (and the shared try/catch would then skip the remain-on-exit
      // reapply below). Unknown version: keep trying.
      if (version === null || tmuxVersionAtLeast(version, 3, 1)) {
        execSync(`${this.tmuxCmd} set-option -t ${t} window-size largest`, { stdio: 'ignore', env, timeout: 5000 });
      }
    } catch { /* session may not be ready yet — benign */ }
  }

  /**
   * Repair geometry left behind by an old Web Terminal viewer before this
   * worker reattaches. A detached owned session has no human client whose
   * layout we could disrupt, so the worker's configured render dimensions are
   * authoritative. An attached session is left untouched.
   */
  private restoreDetachedOwnedSessionSize(): void {
    try {
      const attached = execFileSync(
        'tmux',
        [...this.tmuxArgs, 'display-message', '-p', '-t', this.paneTarget, '#{session_attached}'],
        {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 2000,
          env: tmuxEnv(),
        },
      ).trim();
      if (attached === '0') this.resize(this.cols, this.rows);
    } catch {
      // Reattach already proved the pane exists. Geometry repair is best-effort
      // and must not turn a transient tmux control failure into session loss.
    }
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
        `${this.tmuxCmd} display-message -p -t ${shellescape(this.paneTarget)} ${shellescape(PANE_MODE_FLAGS_FORMAT)}`,
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
   *  `${this.tmuxCmd} capture-pane` with no `-S`/`-E` flags, which defaults to the
   *  viewport. This is the right input for a transient xterm-headless seed:
   *  the snapshot row count matches the transient terminal's row count, so
   *  no normal-buffer scroll happens and the rendered screenshot lines up
   *  with what the user is seeing in the web terminal right now. */
  captureViewport(): string {
    // No `-S`/`-E` flags = tmux default = current viewport only.
    return this.captureWithBounds('');
  }

  /** Input admission needs current cells, not ANSI seeding/cursor modes.
   * One async native read also avoids captureWithBounds' synchronous mode
   * query. Never use the pipe renderer as a substitute: tmux can repaint
   * before Node has consumed the corresponding FIFO data callback. */
  captureViewportAsync(): Promise<string> {
    if (this.exited) return Promise.resolve('');
    return new Promise((resolve, reject) => {
      execFile('tmux', [...this.tmuxArgs, 'capture-pane', '-p', '-t', this.paneTarget], {
        encoding: 'utf8', timeout: 1_000, killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024, env: tmuxEnv(),
      }, (error, stdout) => {
        if (error) {
          this.noteCaptureError(error);
          reject(error);
        } else resolve(this.exited ? '' : stdout);
      });
    });
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
        'tmux', [...this.tmuxArgs, 'capture-pane', '-p', '-t', this.paneTarget],
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

  private noteCaptureError(err: unknown): void {
    const { kind, detail } = classifyTmuxCaptureError(err);
    const key = `${kind}:${detail}`;
    const now = Date.now();
    if (key === this.lastCaptureErrorKey && now - this.lastCaptureErrorLogAt < 30_000) return;
    this.lastCaptureErrorKey = key;
    this.lastCaptureErrorLogAt = now;
    process.stderr.write(`[tmux-pipe-backend] capture failed (kind=${kind}, socket=${this.socketName ?? 'default'}, target=${this.paneTarget}): ${detail}\n`);
  }

  private captureWithBounds(bounds: string, opts?: { restoreCursor?: boolean }): string {
    if (this.exited) return '';
    try {
      const altOn = this.isPaneInAltBuffer();
      const raw = execSync(
        `${this.tmuxCmd} capture-pane -e -p -t ${shellescape(this.paneTarget)}${bounds ? ' ' + bounds : ''}`,
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
    } catch (err) {
      this.noteCaptureError(err);
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
        `${this.tmuxCmd} display-message -p -t ${shellescape(this.paneTarget)} '#{cursor_x} #{cursor_y}'`,
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
        `${this.tmuxCmd} display-message -p -t ${shellescape(this.paneTarget)} '#{pane_width} #{pane_height}'`,
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
        `${this.tmuxCmd} display-message -p -t ${shellescape(this.paneTarget)} '#{alternate_on}'`,
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
    // An exit is a one-shot sticky state: never deliver two different verdicts
    // (e.g. an in-spawn corpse report racing the lifecycle watcher).
    if (this.pendingExit) return;
    this.pendingExit = { code, signal };
    for (const cb of this.exitCbs) {
      try { cb(code, signal); } catch { /* listener crash is benign */ }
    }
  }
}
