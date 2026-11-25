/**
 * HcBackend — a botmux session in a herdr-core (hc) terminal, pipe mode.
 *
 * spawn() creates (or, for a reattach, verifies) the terminal synchronously
 * through the hc CLI, then one framed connection carries everything else:
 *   - a non-observe attach at the worker's size (the worker leads the size,
 *     like tmux pipe mode); its first paint seeds a local ScreenMirror that
 *     answers every synchronous capture in TmuxPipeBackend's formats, and
 *     reaches the worker only as that mirror's capture (onScreenResync, or
 *     onData for what a fresh program drew before the attach); later bytes
 *     go to the mirror and then to onData untouched;
 *   - an events subscription for this terminal (finished, removed, size);
 *   - input as AUTOMATIC_INPUT frames: never takes the size, never counts as
 *     a person typing, with tmux key names encoded locally.
 * A core restart or crash leaves the program running: the backend reconnects,
 * checks the terminal is still this session's, reattaches and resyncs.
 */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { parseProgramStatusPayload, type ProgramStatusEvent } from '../../utils/program-status-parser.js';
import type { ScreenRow } from '../../utils/terminal-cells.js';
import type { SessionBackend, SpawnOpts } from './types.js';
import type { PaneLaunchFile } from './pane-launch.js';
import { SERVER_OUTAGE_ESCALATE_MS, writeManagedPaneLaunch } from './tmux-pipe-backend.js';
import { HcClient, isHcError, type HcChannelClose, type HcChunkInfo, type HcStream, type HcSubscription } from './hc/client.js';
import { hcOwnerLabels, isHcTerminalOwnedBy, killHcTerminal, type HcKillOutcome, type HcTarget } from './hc/cli-ops.js';
import { ensureHcCore, hcPaneXdgRestore } from './hc/core.js';
import { bracketedPasteFrame, encodeTmuxKey, encodeTmuxKeys, pasteBufferBytes, type KeyEncodingModes } from './hc/keys.js';
import { HC_MIRROR_SCROLLBACK_LINES, ScreenMirror } from './hc/screen-mirror.js';
import {
  HC_STARTUP_RETRY_DELAYS_MS,
  hcCallSync,
  isTransientHcFailure,
  prepareHcSyncCore,
  sleepHcStartupRetry,
  startHcCoreSync,
  type HcSyncCore,
  type HcSyncReply,
} from './hc/sync-rpc.js';
import type { HcEnd, HcEvent, HcRunParams, HcSnapshot, HcTerminalRecord } from './hc/types.js';
import { asHcTerminalRecord, parseHcEnd } from './hc/types.js';

/** Codex instance binding of the CLI a terminal runs (tmux keeps it in the session env). */
export const HC_INSTANCE_LABEL = 'botmux_codex_instance';

/**
 * How the core lost a program it reports ended for `reason`, if it did:
 *  - `replaced`: a core answers, but the program is gone with the holder
 *    that ran it, or with the core that a restart replaced;
 *  - `gone`: the core stopped (or the host is shutting down), taking every
 *    terminal with it.
 * Any other reason is the program's own end. These are the core's own words,
 * never an inference from a silent socket.
 */
function serverLossFor(reason: string | null | undefined): HcServerLossKind | undefined {
  switch (reason) {
    case 'holder_lost':
    case 'stopped_by_restart':
      return 'replaced';
    case 'server_stop':
    case 'host_shutdown':
      return 'gone';
    default:
      return undefined;
  }
}
const GET_TIMEOUT_MS = 5_000;
const RUN_TIMEOUT_MS = 15_000;
/** hc's kill escalates HUP, TERM, KILL with 0.5 s, 0.5 s and 2 s waits. */
const KILL_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 10_000;
/** The core writes a heartbeat into an idle event stream every 15 s. */
const HEARTBEAT_TIMEOUT_MS = 45_000;
const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000];
/** TmuxPipeBackend.captureViewportAsync's own deadline. */
const VIEWPORT_WAIT_MS = 1_000;
const PAINT_REPORT_TAIL_BYTES = 64 * 1024;
/** A paint ends with the win32-input mode, then the program's latest status reports. */
const PAINT_INPUT_MODE_ON = '\x1b[?9001h';
const PAINT_INPUT_MODE_OFF = '\x1b[?9001l';
const STATUS_REPORT = /\x1b\]7501;[^\x1b\x07]*(?:\x1b\\|\x07)/g;
const STATUS_PREFIX = '\x1b]7501;';
/** The worker's 7501 parser passes a longer unfinished report through as text. */
const MAX_STATUS_REPORT = 4096;
/** History above the screen read from a program that ended before its first attach (TmuxPipeBackend's PANE_DEATH_SCREEN_HISTORY_LINES). */
const STARTUP_DEATH_HISTORY_LINES = 50;
/** Bound on the round trip an Enter written on its own waits for (TmuxPipeBackend's send-keys deadline). */
const OWN_WRITE_ROUND_TRIP_MS = 5_000;
/** One terminal.run call's own label: tells its terminal apart after a reply that never came. */
const RUN_LABEL = 'botmux_run';
/** Only the latest request can still take effect; older ones are kept to recognise their acknowledgements. */
const MAX_REQUESTED_SIZES = 8;

export interface HcBackendOptions {
  /** The full botmux session id: the owner label checked before any reattach or kill. */
  sessionId: string;
  /** Attach to the live terminal named target.sessionName instead of creating one. */
  isReattach?: boolean;
  /** The worker's own env (never a CLI child env): hc's control env is derived from it. */
  env?: NodeJS.ProcessEnv;
}

/** The kinds of SessionBackend.exitedBecauseServerLost, as the daemon's outage coordinator groups them. */
export type HcServerLossKind = 'replaced' | 'gone' | 'unreachable';

/** One input, encoded when it is written. `ownWrite`: it must reach the program as a write of its own. */
interface QueuedInput {
  encode: () => string;
  ownWrite: boolean;
}

/** An Enter waiting for its round trip (see submitBracketedPaste), and the input queued behind it, in order. */
interface InputBarrier {
  held: QueuedInput;
  queued: QueuedInput[];
}

/** A core process: its pid (server.status) and the id of its state, which only a wipe of that state resets. */
interface HcCoreInstance {
  pid: number;
  id: string | null;
}

class TerminalGone extends Error {
  constructor(readonly end: HcEnd | null, readonly serverLoss: HcServerLossKind | undefined, reason: string) {
    super(reason);
  }
}

function endOf(record: HcTerminalRecord): HcEnd {
  return {
    reason: record.reason ?? 'exited',
    exit_code: record.exit_code ?? null,
    signal: record.signal ?? null,
    finished_ms: record.finished_ms ?? null,
  };
}

/** PtyBackend's convention: a signal death has no code; anything else has one. */
function exitStatus(end: HcEnd | null): { code: number | null; signal: string | null } {
  if (end?.signal != null) return { code: end.exit_code, signal: String(end.signal) };
  return { code: end?.exit_code ?? 1, signal: null };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * env(1) prefix that hands the pinned XDG dirs back as the worker had them
 * before the shell reads its rcfile (fish finds its config there).
 */
export function hcXdgRestoreArgv(workerEnv: NodeJS.ProcessEnv): string[] {
  const { set, unset } = hcPaneXdgRestore(workerEnv);
  return [
    '/usr/bin/env',
    ...unset.flatMap(key => ['-u', key]),
    ...Object.entries(set).map(([key, value]) => `${key}=${value}`),
  ];
}

/**
 * `terminal.run` that rides out a stalled core, as TmuxPipeBackend's
 * new-session does. A run whose reply never came may still have created the
 * terminal (the core works on after hc's client is killed), so every attempt
 * carries one label of this call, and after a failure that could hide a
 * creation the name is looked up: a terminal with that label is the result.
 * A refusal hc answered is returned at once.
 */
export function runHcTerminalSync(
  core: HcSyncCore,
  params: HcRunParams & { name: string },
  timeoutMs: number,
): HcSyncReply<HcTerminalRecord> {
  const runId = randomBytes(8).toString('hex');
  const run: HcRunParams = { ...params, labels: { ...params.labels, [RUN_LABEL]: runId } };
  for (let attempt = 0; ; attempt++) {
    const ran = hcCallSync<HcTerminalRecord>(core, 'terminal.run', run, timeoutMs);
    const record = ran.ok ? asHcTerminalRecord(ran.value) : null;
    if (record) return { ok: true, value: record };
    const failure = ran.ok ? { ok: false as const, kind: null, message: 'hc terminal.run 返回了无法识别的记录' } : ran;
    // Before the first attempt nothing of this call can hold the name.
    const takenByEarlierAttempt = failure.kind === 'name_taken' && attempt > 0;
    if (!isTransientHcFailure(failure.kind) && !takenByEarlierAttempt) return failure;
    const own = lookUpRun(core, params.name, runId);
    if (own.record) return { ok: true, value: own.record };
    if ((takenByEarlierAttempt && own.answered) || attempt >= HC_STARTUP_RETRY_DELAYS_MS.length) return failure;
    process.stderr.write(
      `[hc-backend] terminal.run ${params.name} failed (attempt ${attempt + 1}/${HC_STARTUP_RETRY_DELAYS_MS.length + 1}); retrying: ${failure.message}\n`,
    );
    sleepHcStartupRetry(HC_STARTUP_RETRY_DELAYS_MS[attempt]!);
  }
}

/** The terminal `name` resolves to, if a run labelled `runId` made it; `answered` once hc said anything. */
function lookUpRun(core: HcSyncCore, name: string, runId: string): { record: HcTerminalRecord | null; answered: boolean } {
  const got = hcCallSync<HcTerminalRecord>(core, 'terminal.get', { terminal: name }, GET_TIMEOUT_MS);
  if (!got.ok) return { record: null, answered: got.kind === 'not_found' };
  const record = asHcTerminalRecord(got.value);
  if (!record) return { record: null, answered: false };
  return { record: record.name === name && record.labels?.[RUN_LABEL] === runId ? record : null, answered: true };
}

/** A paint's screen, through the win32-input mode, and the status reports after it; null reports when the mode is not there. */
function splitPaint(text: string): { screen: string; reports: string[] | null } {
  const mode = Math.max(text.lastIndexOf(PAINT_INPUT_MODE_ON), text.lastIndexOf(PAINT_INPUT_MODE_OFF));
  if (mode < 0) return { screen: text, reports: null };
  const end = mode + PAINT_INPUT_MODE_ON.length;
  return { screen: text.slice(0, end), reports: text.slice(end).match(STATUS_REPORT) ?? [] };
}

function parseStatusReport(report: string): ProgramStatusEvent | null {
  return parseProgramStatusPayload(report.slice(STATUS_PREFIX.length).replace(/(?:\x1b\\|\x07)$/, ''));
}

/** What the idle detector keeps of a report. */
function statusKey(event: ProgramStatusEvent): string {
  return JSON.stringify([event.state, event.kind, event.progress, event.app, event.msg]);
}

/** A report applied to records by id ('' is the root), as the idle detector applies it. */
function applyStatus(records: Map<string, string>, event: ProgramStatusEvent): void {
  if (event.state !== 'clear') {
    records.set(event.id ?? '', statusKey(event));
  } else if (event.id === undefined) {
    records.clear();
  } else {
    for (const id of [...records.keys()]) {
      if (id === event.id || id.startsWith(`${event.id}/`)) records.delete(id);
    }
  }
}

/** The end of `text` (from `from` on) that a later chunk may complete into a report. */
function unfinishedReport(text: string, from: number): string {
  const open = text.lastIndexOf(STATUS_PREFIX);
  if (open >= from && text.length - open <= MAX_STATUS_REPORT) {
    const stop = text.slice(open + STATUS_PREFIX.length).search(/[\x1b\x07]/);
    if (stop < 0 || open + STATUS_PREFIX.length + stop === text.length - 1) return text.slice(open);
  }
  for (let length = Math.min(STATUS_PREFIX.length - 1, text.length - from); length > 0; length--) {
    if (text.endsWith(STATUS_PREFIX.slice(0, length))) return text.slice(-length);
  }
  return '';
}

export class HcBackend implements SessionBackend {
  readonly supportsRawCommandPasteLine = true;
  readonly target: HcTarget;
  /** Claude Code session JSONL path, set by the worker (see TmuxPipeBackend). */
  claudeJsonlPath?: string;
  /** PID of the spawned Claude Code child, set by the worker. */
  cliPid?: number;
  /** Working directory the CLI was spawned in, set by the worker. */
  cliCwd?: string;

  private readonly sessionId: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly _isReattach: boolean;
  private cols = 0;
  private rows = 0;
  private address: string | null = null;
  private pid: number | null = null;
  /** The terminal this spawn() created, for retireSessionCreatedBySpawn(). */
  private createdAddress: string | null = null;
  private launchFile: PaneLaunchFile | null = null;

  private mirror: ScreenMirror | null = null;
  /** Receives the current stream's first paint: the mirror itself on the first attach, a fresh one on a reattach. */
  private paintTarget: ScreenMirror | null = null;
  private paintTail = '';
  /** The mirror holds a complete paint and the stream behind it is attached. */
  private seeded = false;
  /** A capture answered empty before the first paint: deliver the screen through onScreenResync. */
  private resyncOwed = false;
  private readonly seedWaiters = new Set<() => void>();

  private client: HcClient | null = null;
  private stream: HcStream | null = null;
  private sub: HcSubscription | null = null;
  private decoder = new StringDecoder('utf8');
  /** Bumped on every teardown, so a connect still in flight drops what it opens. */
  private generation = 0;
  private everAttached = false;
  /**
   * Input sent before the first paint completes, delivered in order after it.
   * Kept unencoded: until that paint the mirror does not know the program's
   * keyboard and paste modes.
   */
  private pendingInput: QueuedInput[] | null = [];
  /**
   * An Enter that waits to be written on its own (see submitBracketedPaste)
   * and the input behind it; null when nothing waits. A detach writes it at
   * once (flushInputBarrier); a lost connection drops it.
   */
  private inputBarrier: InputBarrier | null = null;
  /** Sizes sent to the core that no `size` event has acknowledged yet, oldest first. */
  private requestedSizes: Array<{ cols: number; rows: number }> = [];
  /** The program's 7501 records as onData delivered them to the worker, by id. */
  private readonly heardStatus = new Map<string, string>();
  /** Delivered text that may begin a report the next delivery completes. */
  private statusCarry = '';
  /** A later paint of the current stream, held until its status reports are in. */
  private repaint: Buffer[] = [];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private unreachableSince: number | null = null;
  /**
   * The core that last showed the terminal live: spawn's, then each
   * connection's that verified it. While that same process answers, it holds
   * the same state, so it cannot have lost the terminal with its state.
   */
  private vouchingCore: HcCoreInstance | null = null;

  /** Detached (kill) or the program ended. */
  private exited = false;
  /** The program ended (or its terminal is gone): no pid any more. */
  private terminalEnded = false;
  /** Set when the terminal ended with its core rather than on its own. */
  private serverLossAtExit: HcServerLossKind | undefined;
  private pendingExit: { code: number | null; signal: string | null } | null = null;
  private readonly dataCbs: Array<(data: string) => void> = [];
  private readonly exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
  private readonly resyncCbs: Array<(snapshot: string) => void> = [];
  private readonly sizeCbs: Array<(size: { cols: number; rows: number }) => void> = [];

  constructor(target: HcTarget, opts: HcBackendOptions) {
    if (!opts.sessionId) throw new Error('HcBackend 需要完整的会话 id');
    this.target = target;
    this.sessionId = opts.sessionId;
    this.env = opts.env ?? process.env;
    this._isReattach = opts.isReattach ?? false;
  }

  get isReattach(): boolean {
    return this._isReattach;
  }

  // ─── SessionBackend ──────────────────────────────────────────────────────────────

  spawn(bin: string, args: string[], opts: SpawnOpts): void {
    if (opts.strictEnv && this._isReattach && !opts.strictEnvReattach) throw new Error('Refusing unverified strict hc reattach');
    this.cols = opts.cols;
    this.rows = opts.rows;
    const core = prepareHcSyncCore(this.target, this.env);
    const started = startHcCoreSync(core);
    const record = this._isReattach
      ? this.verifyExistingTerminal(core, opts)
      : this.createTerminal(core, bin, args, opts);
    if (!record) return;
    this.address = record.address;
    this.pid = record.pid ?? null;
    this.vouchingCore = { pid: started.pid, id: null };
    this.mirror = new ScreenMirror({ cols: this.cols, rows: this.rows });
    this.paintTarget = this.mirror;
    void this.connect();
  }

  write(data: string): boolean {
    return this.sendText(data);
  }

  sendText(text: string): boolean {
    return this.input(() => text);
  }

  sendSpecialKeys(...keys: string[]): boolean {
    return this.input(() => encodeTmuxKeys(keys, this.keyModes()));
  }

  sendLines(lines: string[], softNewlineKey: string): boolean {
    if (lines.length === 0) return false;
    return this.input(() => lines.join(encodeTmuxKey(softNewlineKey, this.keyModes())));
  }

  /** tmux `paste-buffer -p`: markers only while the program has bracketed paste on. */
  pasteText(text: string): boolean {
    return this.input(() => pasteBufferBytes(text, this.mirror?.bracketedPaste ?? false));
  }

  /**
   * Markers around the raw text whatever the program's modes, then Enter as
   * a write of its own, as TmuxPipeBackend does: crossterm (Codex) reads 1024
   * bytes per edge-triggered wakeup, so an Enter in the same pty write as a
   * frame that fills a read exactly stays in the tty until the next key. hc
   * writes every input frame to the pty as it reaches the holder, so two
   * frames sent back to back can still land in one read; the Enter is sent
   * only once the core has answered a round trip after the frame (the core
   * forwards input before it serves a later request on the connection),
   * tmux's one client round trip. Input written meanwhile queues behind it,
   * and a detach meanwhile writes them at once (flushInputBarrier).
   */
  submitBracketedPaste(text: string): boolean {
    if (!this.input(() => bracketedPasteFrame(text))) return false;
    return this.input(() => '\r', true);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.exited) return;
    this.mirror?.resize(cols, rows);
    if (this.paintTarget !== this.mirror) this.paintTarget?.resize(cols, rows);
    if (this.stream?.resize(cols, rows)) this.requestSize(cols, rows);
  }

  onData(cb: (data: string) => void): void {
    this.dataCbs.push(cb);
  }

  /** A reattach replaces the worker's screen state with the mirror's (history plus screen). */
  onScreenResync(cb: (snapshot: string) => void): void {
    this.resyncCbs.push(cb);
  }

  /** Another viewer took the terminal's size (or gave it back). */
  onPaneSizeChange(cb: (size: { cols: number; rows: number }) => void): void {
    this.sizeCbs.push(cb);
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    if (this.pendingExit) {
      try { cb(this.pendingExit.code, this.pendingExit.signal); } catch { /* listener crash is benign */ }
      return;
    }
    this.exitCbs.push(cb);
  }

  exitedBecauseServerReplaced(): boolean {
    return this.exitedBecauseServerLost() !== undefined;
  }

  /**
   * After onExit: how the core holding the terminal lost it, when that ended
   * the program (see serverLossFor; a restarted core, or one whose state was
   * wiped, that no longer has the terminal reads as `replaced`, see
   * lossUnlessVouched; one unreachable for the outage window as
   * `unreachable`). The core's socket lets the daemon fold every session
   * that lost the same core into ONE outage, apart from any tmux server's.
   */
  exitedBecauseServerLost(): { backend: 'hc'; kind: HcServerLossKind; socketName: string } | undefined {
    if (!this.exited || this.serverLossAtExit === undefined) return undefined;
    return { backend: 'hc', kind: this.serverLossAtExit, socketName: this.target.socket };
  }

  /** Detach only: the terminal and its program keep running. */
  kill(): void {
    if (this.exited) return;
    this.exited = true;
    this.flushInputBarrier();
    this.teardown();
  }

  destroySession(): void {
    this.kill();
    const outcome = killHcTerminal(this.target, this.sessionId, { env: this.env });
    this.logKillOutcome('destroySession', outcome);
    this.discardLaunchFile();
  }

  /**
   * After spawn() threw: end and remove the terminal this very spawn() created,
   * by its address and only while its labels still name this session.
   */
  retireSessionCreatedBySpawn(): boolean {
    const address = this.createdAddress;
    if (!address) return false;
    let core: HcSyncCore;
    try {
      core = prepareHcSyncCore(this.target, this.env);
    } catch {
      return false;
    }
    const got = hcCallSync<HcTerminalRecord>(core, 'terminal.get', { terminal: address }, GET_TIMEOUT_MS);
    const record = got.ok ? asHcTerminalRecord(got.value) : null;
    if (!record || record.name !== this.target.sessionName || !isHcTerminalOwnedBy(record.labels, this.sessionId)) return false;
    if (record.state === 'live') {
      const killed = hcCallSync<HcTerminalRecord>(core, 'terminal.kill', { terminal: address }, KILL_TIMEOUT_MS);
      if (!killed.ok) return false;
    }
    const removed = hcCallSync(core, 'terminal.rm', { terminal: address }, GET_TIMEOUT_MS);
    if (!removed.ok && removed.kind !== 'not_found') return false;
    this.createdAddress = null;
    this.discardLaunchFile();
    return true;
  }

  getChildPid(): number | null {
    return this.getStablePanePid();
  }

  /**
   * The pane's root process from the terminal record (the scope supervisor
   * sh), for as long as the terminal runs. The worker's `cliPid` refinement
   * to a wrapper's descendant never moves it, and a reconnect re-verifies the
   * same terminal, so it stays one pane's identity until that pane ends.
   */
  getStablePanePid(): number | null {
    return this.terminalEnded ? null : this.pid;
  }

  getAttachInfo(): null {
    return null;
  }

  isPaneAlive(): boolean {
    return !this.exited && this.address !== null;
  }

  captureCurrentScreen(): string {
    return this.capture(mirror => mirror.captureCurrentScreen(), '');
  }

  captureViewport(): string {
    return this.capture(mirror => mirror.captureViewport(), '');
  }

  capturePaneInputModes(): string {
    return this.capture(mirror => mirror.capturePaneInputModes(), '');
  }

  captureInputState(): { viewport: string; cursor: { x: number; y: number } } | null {
    return this.capture(mirror => mirror.captureInputState(), null);
  }

  /**
   * TmuxPipeBackend.captureViewportCells, from the mirror (ScreenMirror.
   * viewportCells). The mirror takes every size the core takes (another
   * viewer's included), so a web or local terminal that resized the pane
   * cannot skew it. Null when the terminal is gone or no complete paint has
   * arrived yet; unlike the other captures this never owes the worker a resync.
   */
  captureViewportCells(): ScreenRow[] | null {
    if (this.exited || !this.seeded) return null;
    const rows = this.mirror!.viewportCells();
    return rows.length > 0 ? rows : null;
  }

  /** Waits (bounded) for the first paint rather than answering an unknown screen. */
  captureViewportAsync(): Promise<string> {
    if (this.exited) return Promise.resolve('');
    if (this.seeded) return Promise.resolve(this.mirror!.viewportText());
    return new Promise(resolveText => {
      const done = (): void => {
        clearTimeout(timer);
        this.seedWaiters.delete(done);
        resolveText(!this.exited && this.seeded ? this.mirror!.viewportText() : '');
      };
      const timer = setTimeout(done, VIEWPORT_WAIT_MS);
      this.seedWaiters.add(done);
    });
  }

  getPaneSize(): { cols: number; rows: number } | null {
    if (this.exited || !this.mirror) return null;
    return this.mirror.size();
  }

  getPaneSizeAsync(): Promise<{ cols: number; rows: number } | null> {
    return Promise.resolve(this.getPaneSize());
  }

  // ─── spawn ─────────────────────────────────────────────────────────────────────────

  private createTerminal(core: HcSyncCore, bin: string, args: string[], opts: SpawnOpts): HcTerminalRecord {
    const { launchFile, paneArgv } = writeManagedPaneLaunch(bin, args, opts);
    const instanceIdentity = opts.env?.BOTMUX_CODEX_INSTANCE_BINDING;
    const params: HcRunParams & { name: string } = {
      argv: opts.strictEnv ? paneArgv : [...hcXdgRestoreArgv(opts.env ?? process.env), ...paneArgv],
      name: this.target.sessionName,
      cwd: resolve(opts.cwd),
      size: { cols: opts.cols, rows: opts.rows },
      labels: { ...hcOwnerLabels(this.sessionId), ...(instanceIdentity ? { [HC_INSTANCE_LABEL]: instanceIdentity } : {}) },
      no_parent: true,
      no_notify: true,
    };
    const ran = runHcTerminalSync(core, params, RUN_TIMEOUT_MS);
    if (!ran.ok) {
      // No terminal we can vouch for will read the file, and it holds the per-bot env values.
      launchFile.discard();
      process.stdout.write(
        `[hc-backend] terminal.run ${this.target.sessionName} failed: ${ran.message}\n`
        + `[hc-backend]   launch file ${launchFile.path}: ${launchFile.bytes} bytes, ${launchFile.argc} args, cli ${opts.cliBin ?? bin}\n`,
      );
      if (ran.kind === 'name_taken') {
        throw new Error(`hc 终端名 ${this.target.sessionName} 已被一个运行中的终端占用`);
      }
      throw new Error(`hc 终端创建失败：${ran.message}`);
    }
    const record = ran.value;
    this.createdAddress = record.address;
    this.launchFile = launchFile;
    launchFile.sweepStaleSiblings();
    return record;
  }

  /**
   * The reattach target must be this session's terminal (hc reuses names and
   * ids once it loses its state). A finished one is a corpse: report its exit
   * and remove it, as TmuxPipeBackend does with a remain-on-exit pane.
   */
  private verifyExistingTerminal(core: HcSyncCore, opts: SpawnOpts): HcTerminalRecord | null {
    const name = this.target.sessionName;
    const got = hcCallSync<HcTerminalRecord>(core, 'terminal.get', { terminal: name }, GET_TIMEOUT_MS);
    if (!got.ok) {
      if (got.kind === 'not_found') {
        this.exited = true;
        this.terminalEnded = true;
        this.serverLossAtExit = 'replaced';
        this.fireExit(1, null);
        throw new Error(`hc 终端 ${name} 已不存在（${this.target.socket}），无法重新连接`);
      }
      throw new Error(`无法读取 hc 终端 ${name}：${got.message}`);
    }
    const record = asHcTerminalRecord(got.value);
    if (!record || record.name !== name) throw new Error(`hc get ${name} 返回了无法识别的记录`);
    if (!isHcTerminalOwnedBy(record.labels, this.sessionId)) {
      const owner = record.labels?.botmux_sid;
      throw new Error(
        `hc 终端 ${name}（${record.address}）${owner ? `属于会话 ${owner}` : '不是 botmux 创建的'}，拒绝重新连接；没有改动它`,
      );
    }
    const instanceIdentity = opts.env?.BOTMUX_CODEX_INSTANCE_BINDING;
    if (instanceIdentity && record.labels[HC_INSTANCE_LABEL] !== instanceIdentity) {
      throw new Error('Codex instance identity mismatch: existing hc terminal preserved; attachment refused');
    }
    if (record.state === 'live') return record;
    this.exited = true;
    this.terminalEnded = true;
    const end = endOf(record);
    this.serverLossAtExit = serverLossFor(end.reason);
    const removed = hcCallSync(core, 'terminal.rm', { terminal: record.address }, GET_TIMEOUT_MS);
    if (!removed.ok && removed.kind !== 'not_found') {
      process.stderr.write(`[hc-backend] could not remove finished terminal ${record.address}: ${removed.message}\n`);
    }
    const status = exitStatus(end);
    this.fireExit(status.code, status.signal);
    return null;
  }

  // ─── connection ─────────────────────────────────────────────────────────────────

  private async openClient(): Promise<HcClient> {
    try {
      return await HcClient.connect(this.target.socket, { timeoutMs: CONNECT_TIMEOUT_MS });
    } catch (err) {
      if (!isHcError(err, 'unreachable')) throw err;
      // A core started from the control env adopts the holders that kept the programs running.
      await ensureHcCore({ env: this.env, core: this.target });
      return HcClient.connect(this.target.socket, { timeoutMs: CONNECT_TIMEOUT_MS });
    }
  }

  private async connect(): Promise<void> {
    const generation = this.generation;
    const address = this.address!;
    const stale = (): boolean => this.generation !== generation || this.exited;
    let client: HcClient | null = null;
    try {
      client = await this.openClient();
      if (stale()) {
        client.close();
        return;
      }
      if (!client.hasFeature('automatic_input')) {
        throw new Error(`hc core ${client.version} 不支持 automatic_input`);
      }
      const core = await this.coreInstance(client);
      await this.verifyLive(client, address, core);
      const sub = await client.subscribe({ terminal: address }, { timeoutMs: CALL_TIMEOUT_MS, heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS });
      if (stale()) {
        client.close();
        return;
      }
      const listed = sub.snapshot.terminals.find(t => t.address === address);
      // This core showed it live a moment ago: it was removed since.
      if (!listed) throw new TerminalGone(null, undefined, `hc 终端 ${address} 在订阅时已被移除`);
      if (listed.state === 'finished') throw new TerminalGone(endOf(listed), serverLossFor(listed.reason), 'finished');
      let stream: HcStream;
      const size = { cols: this.cols, rows: this.rows };
      try {
        stream = await client.attach(
          { terminal: address, ...size, history: HC_MIRROR_SCROLLBACK_LINES, resumed: false },
          { timeoutMs: CALL_TIMEOUT_MS },
        );
      } catch (err) {
        if (isHcError(err, 'rpc') && err.kind === 'finished') await this.verifyLive(client, address, core);
        throw err;
      }
      if (stale()) {
        client.close();
        return;
      }
      this.adopt(client, sub, stream, size);
    } catch (err) {
      if (stale()) {
        client?.close();
        return;
      }
      if (err instanceof TerminalGone) {
        if (err.end && client && !this.everAttached && !this._isReattach) {
          await this.deliverStartupOutput(client, address);
          if (stale()) {
            client.close();
            return;
          }
        }
        this.client = client;
        this.finish(err.end, err.serverLoss);
        return;
      }
      client?.close();
      process.stderr.write(`[hc-backend] ${this.target.sessionName}: attach to ${address} failed: ${describeError(err)}\n`);
      this.scheduleReconnect();
    }
  }

  /**
   * A fresh program that ended before its first attach never reached the
   * stream, so the worker would hear only its exit code. Read what it last
   * printed (its own startup error, usually) and hand that on as output: it
   * reaches the worker's log tail, claude_exit and crash notice the way
   * TmuxPipeBackend's create-time pipe (#3448) and dead-pane screen read with
   * history (#3539) keep a CLI's startup error. History is read for a fresh
   * terminal only, as there: a reattached one may be long-lived. Best effort.
   */
  private async deliverStartupOutput(client: HcClient, address: string): Promise<void> {
    let text: unknown;
    try {
      text = (await client.call<{ text?: unknown }>(
        'terminal.read', { terminal: address, lines: STARTUP_DEATH_HISTORY_LINES }, { timeoutMs: CALL_TIMEOUT_MS },
      ))?.text;
    } catch (err) {
      process.stderr.write(`[hc-backend] ${this.target.sessionName}: could not read the output of a CLI that exited at startup: ${describeError(err)}\n`);
      return;
    }
    const body = typeof text === 'string' ? text.replace(/\s+$/, '') : '';
    if (!body) return;
    process.stderr.write(`[hc-backend] ${this.target.sessionName}: CLI last output before it exited at startup (tail):\n${body}\n`);
    this.emitText(`${body.split('\n').join('\r\n')}\r\n`);
  }

  /** The core process a connection reached. */
  private async coreInstance(client: HcClient): Promise<HcCoreInstance> {
    const status = await client.call<{ pid?: unknown; core?: { id?: unknown } } | null>('server.status', {}, { timeoutMs: CALL_TIMEOUT_MS });
    if (typeof status?.pid !== 'number') throw new Error('hc server.status 的应答缺少 pid');
    const id = status.core?.id;
    return { pid: status.pid, id: typeof id === 'string' ? id : null };
  }

  /**
   * Throws TerminalGone unless `address` is still this session's live
   * terminal on `core`, the core the connection reached; records `core` as
   * the one that vouches for it when it is.
   */
  private async verifyLive(client: HcClient, address: string, core: HcCoreInstance): Promise<void> {
    let record: HcTerminalRecord | null;
    try {
      record = asHcTerminalRecord(await client.call<HcTerminalRecord>('terminal.get', { terminal: address }, { timeoutMs: CALL_TIMEOUT_MS }));
    } catch (err) {
      if (isHcError(err, 'rpc') && err.kind === 'not_found') {
        throw new TerminalGone(null, this.lossUnlessVouched(core), `hc 终端 ${address} 已不存在`);
      }
      throw err;
    }
    if (!record) throw new Error(`hc terminal.get ${address} 返回了无法识别的记录`);
    if (record.name !== this.target.sessionName || !isHcTerminalOwnedBy(record.labels, this.sessionId)) {
      throw new TerminalGone(
        null,
        this.lossUnlessVouched(core),
        `hc 终端 ${address} 已换成了别的终端（${record.name ?? '无名'}，${record.labels?.botmux_sid ?? '无会话'}）`,
      );
    }
    if (record.state === 'finished') {
      throw new TerminalGone(endOf(record), serverLossFor(record.reason), 'finished');
    }
    this.vouchingCore = core;
  }

  /**
   * A terminal gone from `core`, or an address it now gives another, means
   * the core lost the terminal with its state only when `core` is not the
   * process that last showed it live (a restart, a crash) or its state was
   * wiped since: `replaced`. The same process with the same state lost
   * nothing; somebody removed the terminal (`hc kill` and `hc rm` while this
   * backend was reconnecting), and the program ended like any other.
   */
  private lossUnlessVouched(core: HcCoreInstance): HcServerLossKind | undefined {
    const last = this.vouchingCore;
    const sameCore = last !== null && last.pid === core.pid && (last.id === null || last.id === core.id);
    return sameCore ? undefined : 'replaced';
  }

  private adopt(client: HcClient, sub: HcSubscription, stream: HcStream, attachedAt: { cols: number; rows: number }): void {
    this.client = client;
    this.sub = sub;
    this.stream = stream;
    this.decoder = new StringDecoder('utf8');
    if (this.everAttached) this.paintTarget = new ScreenMirror({ cols: this.cols, rows: this.rows });
    this.everAttached = true;
    this.paintTail = '';
    this.repaint = [];
    stream.onData((chunk, info) => this.onStreamData(stream, chunk, info));
    stream.onClose(info => this.onStreamClose(stream, info));
    sub.onEvent(event => this.onEvent(sub, event));
    sub.onMissed(snapshot => this.onSnapshot(sub, snapshot));
    sub.onClose(info => this.onSubscriptionClose(sub, info));
    client.onDisconnect(({ error }) => this.onDisconnect(client, error.message));
    this.requestedSizes = [attachedAt];
    // A resize while the attach was on its way had no stream to go to.
    if ((attachedAt.cols !== this.cols || attachedAt.rows !== this.rows) && stream.resize(this.cols, this.rows)) {
      this.requestSize(this.cols, this.rows);
    }
  }

  private onStreamData(stream: HcStream, chunk: Buffer, info: HcChunkInfo): void {
    if (stream !== this.stream) return;
    if (info.firstPaint) {
      this.paintTarget!.writePaint(chunk);
      this.paintTail = (this.paintTail + chunk.toString('latin1')).slice(-PAINT_REPORT_TAIL_BYTES);
      if (info.paintDone) this.finishFirstPaint();
      return;
    }
    if (info.paint) {
      this.mirror!.writePaint(chunk);
      this.repaint.push(chunk);
      if (info.paintDone) this.finishRepaint();
      return;
    }
    this.mirror!.write(chunk);
    this.emitData(chunk);
  }

  /** A later paint stands in for output the core dropped: its screen repairs the worker's, its reports only say what changed. */
  private finishRepaint(): void {
    const { screen, reports } = splitPaint(this.decoder.write(Buffer.concat(this.repaint)));
    this.repaint = [];
    this.emitText(screen);
    if (reports) this.emitText(this.statusNews(reports));
    process.stderr.write(`[hc-backend] ${this.target.sessionName}: the core dropped output this viewer had not read and repainted the screen\n`);
  }

  private finishFirstPaint(): void {
    const reattached = this.paintTarget !== this.mirror;
    if (reattached) {
      this.mirror!.dispose();
      this.mirror = this.paintTarget;
    }
    this.paintTarget = null;
    this.seeded = true;
    this.unreachableSince = null;
    this.reconnectAttempt = 0;
    const mirror = this.mirror!;
    if (reattached || this.resyncOwed) {
      this.resyncOwed = false;
      const snapshot = mirror.captureCurrentScreen();
      for (const cb of this.resyncCbs) {
        try { cb(snapshot); } catch { /* listener crash is benign */ }
      }
    } else if (!mirror.isBlank()) {
      // What a fresh program drew before the attach reaches the worker the way a reattach seed does.
      this.emitText(mirror.captureCurrentScreen());
    }
    // The program's latest status reports, made while nobody was attached, exist only in the paint.
    const { reports } = splitPaint(this.paintTail);
    if (reports) this.emitText(this.statusNews(reports));
    this.paintTail = '';
    const queued = this.pendingInput;
    this.pendingInput = null;
    this.drainInput(queued ?? []);
    for (const waiter of [...this.seedWaiters]) waiter();
  }

  /**
   * The reports of a paint that the worker has not heard: records that
   * changed, or went away, while their output did not reach it. A record
   * repeated as it stood would reach the idle detector as a fresh report,
   * after a submit the program has not answered yet.
   */
  private statusNews(reports: string[]): string {
    const painted = new Map<string, { report: string; key: string }>();
    for (const report of reports) {
      const event = parseStatusReport(report);
      if (event && event.state !== 'clear') painted.set(event.id ?? '', { report, key: statusKey(event) });
    }
    const heard = new Map(this.heardStatus);
    const news: string[] = [];
    // While the program runs, only a bare `clear` removes the root record, and it takes every record.
    if (heard.has('') && !painted.has('')) {
      heard.clear();
      news.push(`${STATUS_PREFIX}state=clear\x1b\\`);
    }
    for (const id of [...heard.keys()]) {
      if (!heard.has(id) || painted.has(id)) continue;
      applyStatus(heard, { state: 'clear', id });
      news.push(`${STATUS_PREFIX}state=clear:id=${id}\x1b\\`);
    }
    for (const [id, { report, key }] of painted) {
      if (heard.get(id) !== key) news.push(report);
    }
    return news.join('');
  }

  private emitData(chunk: Buffer): void {
    this.emitText(this.decoder.write(chunk));
  }

  private emitText(data: string): void {
    if (!data || this.dataCbs.length === 0) return;
    this.hearStatus(data);
    for (const cb of this.dataCbs) {
      try { cb(data); } catch { /* listener crash shouldn't kill the stream */ }
    }
  }

  /** Follows the delivered text's 7501 reports as the worker's parser reads them. */
  private hearStatus(text: string): void {
    const scan = this.statusCarry + text;
    let end = 0;
    for (const match of scan.matchAll(STATUS_REPORT)) {
      const event = parseStatusReport(match[0]);
      if (event) applyStatus(this.heardStatus, event);
      end = match.index! + match[0].length;
    }
    this.statusCarry = unfinishedReport(scan, end);
  }

  private onStreamClose(stream: HcStream, info: HcChannelClose): void {
    if (stream !== this.stream) return;
    if (info.kind === 'ended') {
      this.finish(info.end, serverLossFor(info.end.reason));
    } else if (info.kind === 'detached') {
      this.dropConnection('the core detached this viewer');
    }
  }

  private onSubscriptionClose(sub: HcSubscription, info: HcChannelClose): void {
    if (sub !== this.sub || info.kind === 'disconnected') return;
    this.dropConnection('the core ended the event stream');
  }

  private onEvent(sub: HcSubscription, event: HcEvent): void {
    if (sub !== this.sub || event.terminal !== this.address) return;
    switch (event.type) {
      case 'finished':
      case 'lost': {
        const end = parseHcEnd(event.data);
        if (end) this.finish(end, serverLossFor(end.reason));
        return;
      }
      case 'removed':
        this.finish(null, undefined);
        return;
      case 'size': {
        const cols = event.data?.cols;
        const rows = event.data?.rows;
        if (typeof cols === 'number' && typeof rows === 'number') this.onCoreSize(cols, rows);
        return;
      }
    }
  }

  private onSnapshot(sub: HcSubscription, snapshot: HcSnapshot): void {
    if (sub !== this.sub) return;
    const record = snapshot.terminals.find(t => t.address === this.address);
    if (!record) this.finish(null, undefined);
    else if (record.state === 'finished') this.finish(endOf(record), serverLossFor(record.reason));
    else this.onCoreSize(record.cols, record.rows);
  }

  private requestSize(cols: number, rows: number): void {
    this.requestedSizes.push({ cols, rows });
    if (this.requestedSizes.length > MAX_REQUESTED_SIZES) this.requestedSizes.shift();
  }

  /**
   * The core's size changed. A size this backend asked for acknowledges that
   * request and every older one; while a newer request is still on its way
   * the acknowledged size is already superseded. Any other size is another
   * viewer leading, which none of this backend's requests outranks.
   */
  private onCoreSize(cols: number, rows: number): void {
    const acked = this.requestedSizes.findIndex(size => size.cols === cols && size.rows === rows);
    const superseded = acked >= 0 && acked < this.requestedSizes.length - 1;
    this.requestedSizes = acked >= 0 ? this.requestedSizes.slice(acked + 1) : [];
    if (!superseded) this.applyCoreSize(cols, rows);
  }

  private applyCoreSize(cols: number, rows: number): void {
    const mirror = this.mirror;
    if (!mirror || (mirror.cols === cols && mirror.rows === rows)) return;
    mirror.resize(cols, rows);
    if (this.paintTarget !== mirror) this.paintTarget?.resize(cols, rows);
    for (const cb of this.sizeCbs) {
      try { cb({ cols, rows }); } catch { /* listener crash is benign */ }
    }
  }

  private onDisconnect(client: HcClient, reason: string): void {
    if (client !== this.client || this.exited) return;
    process.stderr.write(`[hc-backend] ${this.target.sessionName}: lost the hc connection (${reason}); reconnecting\n`);
    this.detachStreams();
    this.scheduleReconnect();
  }

  /** Forget this connection and attach again (which re-checks the terminal). */
  private dropConnection(reason: string): void {
    const client = this.client;
    if (!client || this.exited) return;
    process.stderr.write(`[hc-backend] ${this.target.sessionName}: ${reason}; reattaching\n`);
    this.detachStreams();
    client.close();
    this.scheduleReconnect();
  }

  private detachStreams(): void {
    this.generation++;
    this.client = null;
    this.stream = null;
    this.sub = null;
    this.seeded = false;
    this.inputBarrier = null;
    if (this.paintTarget && this.paintTarget !== this.mirror) this.paintTarget.dispose();
    this.paintTarget = null;
  }

  private scheduleReconnect(): void {
    if (this.exited || this.reconnectTimer) return;
    this.unreachableSince ??= Date.now();
    if (Date.now() - this.unreachableSince >= SERVER_OUTAGE_ESCALATE_MS) {
      process.stderr.write(
        `[hc-backend] ${this.target.sessionName}: hc core ${this.target.socket} unreachable for ${Math.round((Date.now() - this.unreachableSince) / 1000)}s; treating the terminal as lost\n`,
      );
      this.finish(null, 'unreachable');
      return;
    }
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!;
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.exited) void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  // ─── exit ──────────────────────────────────────────────────────────────────────────

  /**
   * The program ended (`end`), or its terminal is gone (`end` null). A finished
   * record is removed through the connection that saw it end, like tmux reaps
   * a remain-on-exit corpse; the name never blocks the next generation anyway.
   */
  private finish(end: HcEnd | null, serverLoss: HcServerLossKind | undefined): void {
    if (this.exited) return;
    this.exited = true;
    this.terminalEnded = true;
    this.serverLossAtExit = serverLoss;
    const client = this.client;
    const address = this.address;
    this.teardown(end !== null);
    if (end && client && address && !client.closed) {
      client.call('terminal.rm', { terminal: address }, { timeoutMs: CALL_TIMEOUT_MS })
        .catch(() => { /* already removed, or the core went away */ })
        .finally(() => client.close());
    }
    const status = exitStatus(end);
    this.fireExit(status.code, status.signal);
  }

  /** Drop every stream, timer and buffer. `keepClient` leaves the connection for finish() to close. */
  private teardown(keepClient = false): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const { client, stream, sub } = this;
    this.detachStreams();
    stream?.close();
    sub?.close();
    if (!keepClient) client?.close();
    this.pendingInput = null;
    this.inputBarrier = null;
    this.mirror?.dispose();
    this.mirror = null;
    for (const waiter of [...this.seedWaiters]) waiter();
  }

  private fireExit(code: number | null, signal: string | null): void {
    if (this.pendingExit) return;
    this.pendingExit = { code, signal };
    for (const cb of this.exitCbs) {
      try { cb(code, signal); } catch { /* listener crash is benign */ }
    }
  }

  // ─── helpers ──────────────────────────────────────────────────────────────────────

  /** False only when the input provably cannot arrive: detached, ended, or the connection is down. */
  private input(encode: () => string, ownWrite = false): boolean {
    if (this.exited) return false;
    const queue = this.pendingInput ?? this.inputBarrier?.queued;
    if (queue) {
      queue.push({ encode, ownWrite });
      return true;
    }
    if (!this.stream) return false;
    return this.writeInput({ encode, ownWrite });
  }

  /** Writes one input on the current stream; one that needs a write of its own goes after a round trip. */
  private writeInput(item: QueuedInput): boolean {
    const stream = this.stream!;
    const client = this.client;
    if (!item.ownWrite || !client) return stream.writeAutomatic(item.encode());
    const barrier: InputBarrier = { held: item, queued: [] };
    this.inputBarrier = barrier;
    const release = (): void => {
      // A detach meanwhile wrote this barrier, or a lost connection dropped it.
      if (this.inputBarrier !== barrier) return;
      this.inputBarrier = null;
      stream.writeAutomatic(item.encode());
      this.drainInput(barrier.queued);
    };
    client.call('terminal.get', { terminal: this.address }, { timeoutMs: OWN_WRITE_ROUND_TRIP_MS }).then(release, release);
    return true;
  }

  /** Writes queued input in order, stopping behind an Enter that waits for its own write. */
  private drainInput(items: QueuedInput[]): void {
    for (let i = 0; i < items.length; i++) {
      if (this.inputBarrier) {
        this.inputBarrier.queued.push(...items.slice(i));
        return;
      }
      if (this.exited || !this.stream) return;
      this.writeInput(items[i]!);
    }
  }

  /**
   * A detach leaves the program running, so input already accepted (input()
   * said true) must still reach it: the Enter waiting for its round trip and
   * the input queued behind it go out now, in order, ahead of the detach on
   * the same stream. Without the round trip the Enter may share a read with
   * the paste before it, which still submits the paste; dropping it would
   * leave the paste in the composer and lose what queued behind (a /stop's
   * C-c). Once the connection is gone the barrier went with it, and nothing
   * is written anywhere: the paste may have reached the program, and an Enter
   * sent through another connection could submit a draft typed since.
   */
  private flushInputBarrier(): void {
    const barrier = this.inputBarrier;
    const stream = this.stream;
    this.inputBarrier = null;
    if (!barrier || !stream) return;
    for (const item of [barrier.held, ...barrier.queued]) {
      if (!stream.writeAutomatic(item.encode())) return;
    }
  }

  private keyModes(): KeyEncodingModes {
    return {
      applicationCursorKeys: this.mirror?.applicationCursorKeys ?? false,
      applicationKeypad: this.mirror?.applicationKeypad ?? false,
    };
  }

  /** Captures answer only from a complete paint on a live stream, like tmux answering at all. */
  private capture<T>(read: (mirror: ScreenMirror) => T, unknown: T): T {
    if (this.exited) return unknown;
    if (!this.seeded) {
      this.resyncOwed = true;
      return unknown;
    }
    return read(this.mirror!);
  }

  private discardLaunchFile(): void {
    this.launchFile?.discard();
    this.launchFile = null;
  }

  private logKillOutcome(op: string, outcome: HcKillOutcome): void {
    if (outcome.result === 'killed' || outcome.result === 'removed' || outcome.result === 'missing') return;
    process.stderr.write(
      `[hc-backend] ${op} ${this.target.sessionName}: ${outcome.result === 'mismatch'
        ? `left ${outcome.address} alone (owner ${outcome.owner ?? 'none'})`
        : outcome.reason}\n`,
    );
  }
}
