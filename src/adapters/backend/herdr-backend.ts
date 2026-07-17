import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as pty from 'node-pty';
import xtermHeadless from '@xterm/headless';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import type { BackendType, SessionBackend, SpawnOpts, SessionProbe } from './types.js';
import { logger } from '../../utils/logger.js';

const { Terminal } = xtermHeadless;

export type PersistentBackendType = Exclude<BackendType, 'pty'>;

export interface HerdrExternalTarget {
  sessionName: string;
  target: string;
  paneId?: string;
}

const MIN_STREAMING_VERSION = [0, 7, 2] as const;
const OBSERVER_RESTART_DELAY_MS = 500;
const OBSERVER_RESTART_MAX_DELAY_MS = 5000;
const OBSERVER_DEGRADED_AFTER_FAILURES = 3;
const MAX_AGENT_PROBE_FAILURES = 3;
const MAX_OBSERVER_BACKOFF_EXPONENT = 8;
const MAX_PENDING_DATA_CHARS = 1_000_000;
// Snapshot reads are now only used on explicit capture calls. Live output uses
// `terminal session observe` and never scans this fixed window.
const READ_LINES = 10_000;
// Inter-attempt sleep while waiting for `herdr server` to come up.
// Synchronous (execFileSync 'sleep') because spawn() must stay sync.
const SERVER_BOOT_POLL_MS = 100;
const SERVER_BOOT_DEADLINE_MS = 5000;

const TERMINAL_STREAM_MESSAGE_SCHEMA = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('terminal.frame'),
    seq: z.number().int().nonnegative(),
    full: z.boolean(),
    encoding: z.literal('ansi'),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    bytes: z.string(),
  }),
  z.object({
    type: z.literal('terminal.closed'),
    reason: z.string().optional(),
  }),
]);

type JsonCommandResult = { ok: true; value: any | undefined } | { ok: false };

export interface HerdrWebTerminalSize {
  cols: number;
  rows: number;
}

export interface HerdrWebTerminalCursor {
  col: number;
  row: number;
}

/** One native Herdr terminal frame. A full frame replaces the current grid. */
export interface HerdrTerminalFrame {
  data: string;
  full: boolean;
  seq: number;
  width: number;
  height: number;
}

function tryJsonCommand(args: string[], opts?: { timeout?: number; input?: string; env?: NodeJS.ProcessEnv }): JsonCommandResult {
  try {
    const out = execFileSync('herdr', args, {
      encoding: 'utf-8',
      input: opts?.input,
      stdio: opts?.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      timeout: opts?.timeout ?? 5000,
      maxBuffer: 16 * 1024 * 1024,
      env: opts?.env,
    }).trim();
    return { ok: true, value: out ? JSON.parse(out) : undefined };
  } catch {
    return { ok: false };
  }
}

function jsonCommand(args: string[], opts?: { timeout?: number; input?: string; env?: NodeJS.ProcessEnv }): any | undefined {
  const result = tryJsonCommand(args, opts);
  return result.ok ? result.value : undefined;
}

function runHerdr(args: string[], opts?: { timeout?: number; input?: string }): boolean {
  try {
    execFileSync('herdr', args, {
      input: opts?.input,
      stdio: opts?.input === undefined ? 'ignore' : ['pipe', 'ignore', 'ignore'],
      timeout: opts?.timeout ?? 5000,
    });
    return true;
  } catch {
    return false;
  }
}

function herdrSessionArgs(sessionName: string, args: string[]): string[] {
  return ['--session', sessionName, ...args];
}

function extractAgent(raw: any): any | undefined {
  return raw?.result?.agent;
}

function extractAgents(raw: any): any[] {
  const agents = raw?.result?.agents;
  return Array.isArray(agents) ? agents : [];
}

// Whether a matched `agent list` row represents an exited CLI. Verified against
// herdr v0.6.6: a live agent carries `agent_status` ('unknown' | 'working' |
// 'idle' | 'blocked' | 'done'); once the underlying process exits, herdr drops
// the row entirely (so absence — handled by the caller — is the primary exit
// signal). We still defensively treat an explicit terminal marker as exited so
// a future herdr that keeps a tombstone row (e.g. agent_status:'exited' or a
// running:false / status fields) doesn't hang the session.
function agentRowExited(agent: any): boolean {
  return agent?.agent_status === 'exited'
    || agent?.status === 'exited'
    || agent?.running === false;
}

function extractReadText(raw: any): string {
  return typeof raw?.result?.read?.text === 'string' ? raw.result.read.text : '';
}


export class HerdrBackend implements SessionBackend {
  private serverProcess: ChildProcess | null = null;
  private observerProcess: ChildProcess | null = null;
  private observerRestartTimer: NodeJS.Timeout | null = null;
  private observerBuffer = '';
  private streamDecoder = new StringDecoder('utf8');
  private lastFrameSeq = -1;
  private observerSawFrame = false;
  private observerFailures = 0;
  private agentProbeFailures = 0;
  private observerProbeGeneration = 0;
  private pendingFullFrame = false;
  private pendingData = '';
  private pendingFrames: HerdrTerminalFrame[] = [];
  private readonly dataCbs: Array<(d: string) => void> = [];
  private readonly frameCbs: Array<(frame: HerdrTerminalFrame) => void> = [];
  private readonly webCursorCbs: Array<(cursor: HerdrWebTerminalCursor) => void> = [];
  private readonly exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
  private readonly agentName = 'botmux';
  private paneId: string | undefined;
  private exited = false;
  private started = false;
  private cols = 200;
  private rows = 50;
  private webAttach: pty.IPty | null = null;
  private webCursorTerminal: InstanceType<typeof Terminal> | null = null;
  private webCursor: HerdrWebTerminalCursor | null = null;
  private webCursorTimer: NodeJS.Timeout | null = null;
  private webOwner: object | null = null;
  private webSize: HerdrWebTerminalSize | null = null;
  private readonly webViewers = new Map<object, HerdrWebTerminalSize | null>();

  private childEnv: Record<string, string> | undefined;

  claudeJsonlPath?: string;
  cliPid?: number;
  cliCwd?: string;

  constructor(
    private readonly sessionName: string,
    private readonly opts: { createSession?: boolean; isReattach?: boolean; externalTarget?: HerdrExternalTarget } = {},
  ) {
    if (opts.externalTarget?.paneId) this.paneId = opts.externalTarget.paneId;
  }

  static isAvailable(): boolean {
    try {
      const output = execFileSync('herdr', ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      });
      const match = /^herdr\s+(\d+)\.(\d+)\.(\d+)/i.exec(output.trim());
      if (!match) return false;
      const installed = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
      for (let index = 0; index < MIN_STREAMING_VERSION.length; index++) {
        if (installed[index] > MIN_STREAMING_VERSION[index]) return true;
        if (installed[index] < MIN_STREAMING_VERSION[index]) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  static sessionName(sessionId: string): string {
    return `bmx-${sessionId.slice(0, 8)}`;
  }

  static hasSession(name: string): boolean {
    return HerdrBackend.probeSession(name) === 'exists';
  }

  /**
   * Tri-state existence probe. A failed/timed-out `session list` (tryJsonCommand
   * → {ok:false}) yields 'unknown' rather than collapsing into 'missing', so a
   * transient herdr-server hiccup on restore can't be mistaken for a gone
   * session. A present-but-not-running row is a genuine zombie → 'missing'.
   */
  static probeSession(name: string): SessionProbe {
    const result = tryJsonCommand(['session', 'list', '--json']);
    if (!result.ok) return 'unknown';
    return extractSessions(result.value).some((s: any) => s?.name === name && s?.running === true)
      ? 'exists'
      : 'missing';
  }

  static killSession(name: string): void {
    // stop AND delete. `session stop` alone leaves the session dir + agent
    // metadata on disk (verified on herdr v0.6.6: the session lingers with
    // running:false). When the server is later rebooted for the same name —
    // e.g. the resume:true respawn after a /restart — herdr AUTO-RESTORES the
    // old `botmux` agent row pointing at a DEAD pane. spawn()'s reuse branch
    // would then treat that zombie as a live agent, skip `agent start`, and the
    // new CLI would never run (the pane shows only a shell prompt). Deleting
    // the session clears that metadata so the next spawn starts clean.
    runHerdr(['session', 'stop', name, '--json'], { timeout: 5000 });
    runHerdr(['session', 'delete', name, '--json'], { timeout: 5000 });
  }

  static listBotmuxSessions(): string[] {
    const raw = jsonCommand(['session', 'list', '--json']);
    return extractSessions(raw)
      .map((s: any) => typeof s?.name === 'string' ? s.name : '')
      .filter((name: string) => name.startsWith('bmx-'));
  }

  get isReattach(): boolean {
    return this.opts.isReattach ?? false;
  }

  spawn(bin: string, args: string[], opts: SpawnOpts): void {
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.cliCwd = opts.cwd;
    // worker.ts builds opts.env via redactChildEnv() (drops bare LARK_APP_*)
    // and injects BOTMUX_SESSION_ID/CHAT_ID/LARK_APP_ID/ROOT_MESSAGE_ID. We
    // must thread this env into the herdr daemon spawn AND the agent-start
    // call so the CLI inside herdr sees the same env the PTY/tmux backends
    // would have given it. Otherwise:
    //   - botmux send/ask in the CLI see no BOTMUX_* and exit 2
    //   - the worker's bare LARK_APP_SECRET (still in process.env) leaks
    //     into the CLI process via plain process.env inheritance
    // Skip on externalTarget: that's the user's own pre-existing herdr
    // session; we can't (and shouldn't) re-env an already-running CLI.
    //
    // Per-bot env (opts.injectEnv, e.g. ANTHROPIC_BASE_URL/AUTH_TOKEN for a GLM
    // bot): herdr runs a per-session server (one `herdr --session <name> server`
    // per botmux session, see ensureServer), so unlike tmux/zellij there is no
    // shared cross-bot server whose global env we'd pollute — merging it into
    // childEnv is safe (same reasoning as the pty backend). childEnv flows to
    // both the daemon spawn and the agent-start call, and the daemon forks the
    // CLI as its child, so the per-bot env reaches the CLI. Already sanitized by
    // the worker. Appended last so it wins over a same-named key in opts.env.
    this.childEnv = this.opts.externalTarget
      ? undefined
      : { ...opts.env, ...(opts.injectEnv ?? {}) };
    this.ensureServer();

    const external = this.opts.externalTarget;
    if (external) {
      this.paneId = external.paneId ?? external.target;
    } else {
      // Reuse an existing `botmux` agent ONLY when we're genuinely re-attaching
      // to a still-alive session (daemon restart while the herdr server kept
      // running). On a fresh start — including the resume:true respawn after a
      // /restart — we must always `agent start` the new CLI. Reusing here is
      // what made /restart silently no-op: herdr can resurrect a dead `botmux`
      // row from persisted metadata, and reuse would skip `agent start` so the
      // new command never ran. killSession() now deletes that metadata, but we
      // also gate reuse on isReattach so a stale row can never be adopted.
      const existing = this.isReattach ? this.getAgent() : undefined;
      if (existing) {
        this.paneId = existing.pane_id;
      } else {
        const started = jsonCommand(herdrSessionArgs(this.sessionName, [
          'agent', 'start', this.agentName,
          '--cwd', opts.cwd,
          '--', bin, ...args,
        ]), { timeout: 10_000, env: this.childEnv });
        const agent = extractAgent(started);
        if (!agent) throw new Error(`failed to start herdr agent ${this.agentName} in ${this.sessionName}`);
        this.paneId = agent.pane_id;
      }
    }

    this.started = true;
    this.startObserver();
  }

  write(data: string): void {
    if (this.exited) return;
    const target = this.paneId ?? this.agentName;
    runHerdr(herdrSessionArgs(this.sessionName, ['pane', 'send-text', target, data]), { timeout: 5000 });
  }

  sendText(text: string): void {
    this.write(text);
  }

  sendSpecialKeys(...keys: string[]): void {
    if (this.exited) return;
    const target = this.paneId ?? this.agentName;
    runHerdr(herdrSessionArgs(this.sessionName, ['pane', 'send-keys', target, ...keys]), { timeout: 5000 });
  }

  pasteText(text: string): void {
    this.write(text);
  }

  resize(cols: number, rows: number): void {
    if (this.cols === cols && this.rows === rows) return;
    this.cols = cols;
    this.rows = rows;
    if (!this.started || this.exited) return;
    this.stopObserver();
    this.startObserver();
  }

  acquireWebTerminal(viewer: object): HerdrWebTerminalSize | null {
    if (this.opts.externalTarget || this.exited) return null;
    if (!this.webViewers.has(viewer)) this.webViewers.set(viewer, null);
    return this.webOwner && this.webOwner !== viewer ? this.webSize : null;
  }

  resizeWebTerminal(viewer: object, cols: number, rows: number): HerdrWebTerminalSize | null {
    if (this.opts.externalTarget || this.exited || !this.webViewers.has(viewer)) return null;
    const size = { cols, rows };
    this.webViewers.set(viewer, size);
    if (!this.webOwner) this.webOwner = viewer;
    if (this.webOwner !== viewer) return null;

    if (this.webAttach) {
      this.webCursorTerminal?.resize(cols, rows);
      this.webAttach.resize(cols, rows);
    } else if (!this.startWebAttach(size)) {
      return null;
    }
    this.webSize = size;
    // The managed attach owns the real agent PTY size. Resize it first so the
    // CLI receives SIGWINCH, then restart the observer at the same grid and
    // wait for its authoritative full rebaseline.
    this.resize(cols, rows);
    return size;
  }

  releaseWebTerminal(viewer: object): object | null {
    if (this.opts.externalTarget || !this.webViewers.has(viewer)) return null;
    const wasOwner = this.webOwner === viewer;
    this.webViewers.delete(viewer);
    if (!wasOwner) return null;

    if (this.webViewers.size === 0) {
      this.resetWebTerminal();
      return null;
    }
    const promoted = this.webViewers.keys().next().value as object;
    this.webOwner = promoted;
    return promoted;
  }

  isWebTerminalOwner(viewer: object): boolean {
    return this.webOwner === viewer;
  }

  onData(cb: (data: string) => void): void {
    this.dataCbs.push(cb);
    if (!this.pendingData || this.exited) return;
    try { cb(this.pendingData); } catch { /* listener crash must not kill the observer */ }
  }

  /** Structured native stream; callers must replace rather than append full frames. */
  onTerminalFrame(cb: (frame: HerdrTerminalFrame) => void): void {
    this.frameCbs.push(cb);
    if (this.pendingFrames.length > 0 && !this.exited) {
      for (const frame of this.pendingFrames) {
        try { cb(frame); } catch { /* listener crash must not kill the observer */ }
      }
    }
    // A structured consumer has received the same initial frames and will keep
    // receiving all future data. Do not retain a duplicate compatibility
    // stream forever when no onData listener exists (the normal worker path).
    if (this.dataCbs.length === 0) this.pendingData = '';
  }

  /** Cursor coordinates from the real managed attach stream (0-based). */
  onWebTerminalCursor(cb: (cursor: HerdrWebTerminalCursor) => void): void {
    this.webCursorCbs.push(cb);
  }

  getWebTerminalCursor(): HerdrWebTerminalCursor | null {
    return this.webCursor;
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCbs.push(cb);
  }

  kill(): void {
    if (this.exited) return;
    this.exited = true;
    this.resetWebTerminal();
    this.stopObserver();
    this.pendingData = '';
    this.pendingFrames = [];
    this.serverProcess = null;
  }

  destroySession(): void {
    this.kill();
    // Only tear down the herdr session if botmux owns it. An adopted external
    // target (externalTarget) is the user's own herdr session — botmux merely
    // observes it, so /close must detach (kill) without stopping their CLI.
    // Mirrors TmuxPipeBackend's ownsSession guard.
    if (!this.opts.externalTarget) {
      HerdrBackend.killSession(this.sessionName);
    }
  }

  getChildPid(): number | null {
    return this.cliPid ?? null;
  }

  getAttachInfo() {
    return null;
  }

  captureCurrentScreen(): string {
    return this.readRecentAnsi();
  }

  captureCurrentScreenAsync(): Promise<string> {
    const target = this.paneId ?? this.agentName;
    return new Promise(resolve => {
      execFile(
        'herdr',
        herdrSessionArgs(this.sessionName, [
          'agent', 'read', target,
          '--source', 'recent', '--lines', String(READ_LINES), '--format', 'ansi',
        ]),
        { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            resolve('');
            return;
          }
          try {
            resolve(extractReadText(stdout.trim() ? JSON.parse(stdout) : undefined));
          } catch {
            resolve('');
          }
        },
      );
    });
  }

  captureViewport(): string {
    return this.readVisibleAnsi();
  }

  getPaneSize(): { cols: number; rows: number } | null {
    return { cols: this.cols, rows: this.rows };
  }

  private ensureServer(): void {
    if (HerdrBackend.hasSession(this.sessionName)) return;
    if (this.opts.externalTarget) throw new Error(`herdr session ${this.sessionName} is not running`);
    // Pass childEnv to the herdr daemon: the daemon forks the agent CLI as
    // its own child, so the daemon's env is what the CLI ultimately
    // inherits. Without this, the CLI would see worker.ts process.env (bare
    // LARK_APP_SECRET, no BOTMUX_*).
    this.serverProcess = spawn('herdr', ['--session', this.sessionName, 'server'], {
      stdio: 'ignore',
      detached: true,
      env: this.childEnv,
    });
    this.serverProcess.unref();

    // Bounded poll with sleeps so we don't pin a core spamming `session list`
    // while the herdr server is still binding its socket.
    const deadline = Date.now() + SERVER_BOOT_DEADLINE_MS;
    while (Date.now() < deadline) {
      if (HerdrBackend.hasSession(this.sessionName)) return;
      sleepSync(SERVER_BOOT_POLL_MS);
    }
    throw new Error(`failed to start herdr session ${this.sessionName}`);
  }

  private startWebAttach(size: HerdrWebTerminalSize): boolean {
    const target = this.paneId ?? this.agentName;
    const cursorTerminal = new Terminal({
      cols: size.cols,
      rows: size.rows,
      scrollback: 0,
      allowProposedApi: true,
    });
    try {
      const attach = pty.spawn('herdr', [
        '--session', this.sessionName,
        'agent', 'attach', target,
      ], {
        name: 'xterm-256color',
        cols: size.cols,
        rows: size.rows,
        env: this.childEnv ?? {},
      });
      this.webAttach = attach;
      this.resetWebCursorTracking();
      this.webCursorTerminal = cursorTerminal;
      attach.onData(data => {
        // The polling read API returns screen text but no cursor metadata. The
        // managed attach stream is the authoritative source for cursor moves;
        // render it headlessly and relay only the final coordinates.
        cursorTerminal.write(data, () => {
          if (this.webCursorTerminal !== cursorTerminal) return;
          if (this.webCursorTimer) clearTimeout(this.webCursorTimer);
          this.webCursorTimer = setTimeout(() => {
            this.webCursorTimer = null;
            if (this.webCursorTerminal !== cursorTerminal) return;
            const buffer = cursorTerminal.buffer.active;
            const cursor = { col: buffer.cursorX, row: buffer.cursorY };
            if (this.webCursor?.col === cursor.col && this.webCursor?.row === cursor.row) return;
            this.webCursor = cursor;
            for (const cb of this.webCursorCbs) {
              try { cb(cursor); } catch { /* listener crash shouldn't kill attach */ }
            }
          }, 10);
          this.webCursorTimer.unref?.();
        });
      });
      attach.onExit(({ exitCode, signal }) => {
        if (this.webAttach !== attach) return;
        this.webAttach = null;
        this.resetWebCursorTracking();
        logger.warn(
          `[herdr] web terminal attach exited session=${this.sessionName} target=${target} ` +
          `code=${exitCode} signal=${signal ?? 'null'}`,
        );
      });
      return true;
    } catch (err: any) {
      cursorTerminal.dispose();
      logger.error(
        `[herdr] web terminal attach failed session=${this.sessionName} target=${target}: ` +
        `${err?.message ?? err}`,
      );
      return false;
    }
  }

  private resetWebTerminal(): void {
    const attach = this.webAttach;
    this.webAttach = null;
    this.webOwner = null;
    this.webSize = null;
    this.webViewers.clear();
    this.resetWebCursorTracking();
    if (attach) {
      try { attach.kill(); } catch { /* already gone */ }
    }
  }

  private resetWebCursorTracking(): void {
    if (this.webCursorTimer) clearTimeout(this.webCursorTimer);
    this.webCursorTimer = null;
    const cursorTerminal = this.webCursorTerminal;
    this.webCursorTerminal = null;
    this.webCursor = null;
    cursorTerminal?.dispose();
  }

  private getAgent(): any | undefined {
    const raw = jsonCommand(herdrSessionArgs(this.sessionName, ['agent', 'get', this.agentName]), { timeout: 5000 });
    return extractAgent(raw);
  }

  private listAgentsAsync(cb: (agents: any[] | null) => void): void {
    execFile(
      'herdr',
      herdrSessionArgs(this.sessionName, ['agent', 'list']),
      { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          cb(null);
          return;
        }
        try {
          cb(extractAgents(stdout.trim() ? JSON.parse(stdout) : undefined));
        } catch {
          cb(null);
        }
      },
    );
  }

  // NOTE: we use `agent read` (not `pane read`) for capture. Both accept the
  // same target shapes (pane_id, agent name, terminal_id), but `pane read`
  // prints raw text while `agent read` prints JSON with `result.read.text`.
  // Routing reads through JSON keeps the parsing path uniform with the rest
  // of the herdr CLI surface and gives us a hard "did the call succeed"
  // signal instead of treating raw bytes as opaque text.
  private readVisibleAnsi(): string {
    const target = this.paneId ?? this.agentName;
    return extractReadText(jsonCommand(
      herdrSessionArgs(this.sessionName, ['agent', 'read', target, '--source', 'visible', '--lines', String(this.rows), '--format', 'ansi']),
      { timeout: 5000 },
    ));
  }

  private readRecentAnsi(): string {
    const target = this.paneId ?? this.agentName;
    return extractReadText(jsonCommand(
      herdrSessionArgs(this.sessionName, ['agent', 'read', target, '--source', 'recent', '--lines', String(READ_LINES), '--format', 'ansi']),
      { timeout: 5000 },
    ));
  }

  private startObserver(): void {
    if (this.exited) return;
    const paneTarget = this.paneId ?? this.agentName;
    if (!paneTarget) return;
    clearTimeout(this.observerRestartTimer ?? undefined);
    this.observerRestartTimer = null;
    this.observerBuffer = '';
    this.streamDecoder = new StringDecoder('utf8');
    this.lastFrameSeq = -1;
    this.observerSawFrame = false;
    this.pendingFullFrame = false;

    const child = spawn('herdr', [
      '--session', this.sessionName,
      'terminal', 'session', 'observe', paneTarget,
      '--cols', String(this.cols),
      '--rows', String(this.rows),
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.observerProcess = child;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.consumeObserverChunk(child, chunk));
    child.on('error', error => {
      logger.warn(`[herdr:${this.sessionName}] terminal observer failed: ${error.message}`);
      this.handleObserverDisconnect(child);
    });
    child.on('exit', (code, signal) => {
      if (this.observerProcess !== child || this.exited) return;
      logger.debug(`[herdr:${this.sessionName}] terminal observer exited code=${code} signal=${signal}`);
      this.handleObserverDisconnect(child);
    });
  }

  private consumeObserverChunk(child: ChildProcess, chunk: string): void {
    if (this.observerProcess !== child || this.exited) return;
    this.observerBuffer += chunk;
    let newline = this.observerBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.observerBuffer.slice(0, newline).trim();
      this.observerBuffer = this.observerBuffer.slice(newline + 1);
      if (line) this.consumeObserverLine(child, line);
      if (this.observerProcess !== child || this.exited) return;
      newline = this.observerBuffer.indexOf('\n');
    }
  }

  private consumeObserverLine(child: ChildProcess, line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      logger.warn(`[herdr:${this.sessionName}] malformed terminal stream JSON: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const parsed = TERMINAL_STREAM_MESSAGE_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      logger.warn(`[herdr:${this.sessionName}] unsupported terminal stream record: ${parsed.error.message}`);
      return;
    }
    const message = parsed.data;
    if (message.type === 'terminal.closed') {
      logger.debug(`[herdr:${this.sessionName}] terminal stream closed: ${message.reason ?? 'no reason'}`);
      this.handleObserverDisconnect(child);
      return;
    }
    if (message.seq <= this.lastFrameSeq) return;
    this.lastFrameSeq = message.seq;
    const bytes = Buffer.from(message.bytes, 'base64');
    if (message.full) {
      this.streamDecoder = new StringDecoder('utf8');
      this.pendingFullFrame = true;
    }
    const data = this.streamDecoder.write(bytes);
    if (!data) return;
    const frame: HerdrTerminalFrame = {
      data,
      full: this.pendingFullFrame,
      seq: message.seq,
      width: message.width,
      height: message.height,
    };
    this.pendingFullFrame = false;
    this.observerSawFrame = true;
    this.observerFailures = 0;
    this.agentProbeFailures = 0;

    if (this.frameCbs.length === 0) {
      if (frame.full) this.pendingFrames = [frame];
      else this.pendingFrames.push(frame);
      // Listener registration is normally immediate after spawn. Keep a hard
      // bound anyway so a missing consumer cannot retain an unbounded stream.
      if (this.pendingFrames.length > 1024) this.pendingFrames.splice(0, this.pendingFrames.length - 1024);
    } else {
      this.pendingFrames = [];
      for (const cb of this.frameCbs) {
        try { cb(frame); } catch { /* listener crash must not kill the observer */ }
      }
    }

    // Compatibility surface for direct backend consumers. Worker uses the
    // structured API above so it can replace full frames instead of appending.
    if (this.dataCbs.length === 0) {
      if (this.frameCbs.length > 0) {
        this.pendingData = '';
        return;
      }
      this.pendingData = frame.full ? data : this.pendingData + data;
      if (this.pendingData.length > MAX_PENDING_DATA_CHARS) {
        this.pendingData = this.pendingData.slice(-MAX_PENDING_DATA_CHARS);
      }
      return;
    }
    this.pendingData = '';
    for (const cb of this.dataCbs) {
      try { cb(data); } catch { /* listener crash must not kill the observer */ }
    }
  }

  private handleObserverDisconnect(child: ChildProcess): void {
    if (this.observerProcess !== child || this.exited) return;
    this.observerProcess = null;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    const sawFrame = this.observerSawFrame;
    const generation = ++this.observerProbeGeneration;
    this.listAgentsAsync(agents => {
      if (this.exited || generation !== this.observerProbeGeneration) return;
      if (agents !== null) {
        this.agentProbeFailures = 0;
        const matching = agents.find(agent => agent?.name === this.agentName || agent?.pane_id === this.paneId);
        if (!matching || agentRowExited(matching)) {
          const exitCode = typeof matching?.exit_code === 'number' ? matching.exit_code : 0;
          this.handleExit(exitCode, null);
          return;
        }
      } else {
        this.agentProbeFailures++;
        if (this.agentProbeFailures >= MAX_AGENT_PROBE_FAILURES) {
          logger.error(
            `[herdr:${this.sessionName}] cannot verify agent after ${this.agentProbeFailures} attempts`,
          );
          this.handleExit(1, null);
          return;
        }
      }

      // A live agent plus an observer that repeatedly exits before producing
      // one valid frame can mean another client owns Herdr's single observer
      // slot. The CLI is still alive, so degrade to a capped retry instead of
      // fabricating an exit. Only a missing agent or consecutive probe failure
      // may end the backend.
      this.observerFailures = sawFrame
        ? 0
        : Math.min(this.observerFailures + 1, MAX_OBSERVER_BACKOFF_EXPONENT);
      if (this.observerFailures === OBSERVER_DEGRADED_AFTER_FAILURES) {
        logger.error(
          `[herdr:${this.sessionName}] terminal observer unavailable after ${this.observerFailures} attempts; agent is alive, retrying`,
        );
      }

      const delay = Math.min(
        OBSERVER_RESTART_MAX_DELAY_MS,
        OBSERVER_RESTART_DELAY_MS * (2 ** Math.max(0, this.observerFailures - 1)),
      );
      this.observerRestartTimer = setTimeout(() => {
        this.observerRestartTimer = null;
        if (!this.exited) this.startObserver();
      }, delay);
      this.observerRestartTimer.unref?.();
    });
  }

  private stopObserver(): void {
    this.observerProbeGeneration++;
    clearTimeout(this.observerRestartTimer ?? undefined);
    this.observerRestartTimer = null;
    const child = this.observerProcess;
    this.observerProcess = null;
    if (!child) return;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }

  private handleExit(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    this.resetWebTerminal();
    this.stopObserver();
    this.pendingData = '';
    this.pendingFrames = [];
    for (const cb of this.exitCbs) {
      try { cb(code, signal); } catch { /* listener crash must not kill teardown */ }
    }
  }
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  // Synchronous nap that doesn't pin a CPU core. `sleep` only accepts
  // fractional seconds with `.` separator on POSIX; clamp to ms granularity.
  const seconds = Math.max(0.05, ms / 1000);
  try {
    execFileSync('sleep', [seconds.toFixed(3)], { stdio: 'ignore', timeout: ms + 1000 });
  } catch {
    // best effort — if `sleep` is missing the caller will just retry sooner
  }
}

function extractSessions(raw: any): any[] {
  const sessions = raw?.sessions ?? raw?.result?.sessions;
  return Array.isArray(sessions) ? sessions : [];
}
