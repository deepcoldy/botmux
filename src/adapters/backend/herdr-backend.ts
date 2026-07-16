import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import type { BackendType, SessionBackend, SpawnOpts, SessionProbe } from './types.js';

export type PersistentBackendType = Exclude<BackendType, 'pty'>;

export interface HerdrExternalTarget {
  sessionName: string;
  target: string;
  paneId?: string;
}

const MIN_STREAMING_VERSION = [0, 7, 2] as const;
const OBSERVER_RESTART_DELAY_MS = 500;
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
  }).strict(),
  z.object({
    type: z.literal('terminal.closed'),
    reason: z.string().optional(),
  }).strict(),
]);

type JsonCommandResult = { ok: true; value: any | undefined } | { ok: false };

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
  private lastFrameSeq = 0;
  private pendingData = '';
  private readonly dataCbs: Array<(d: string) => void> = [];
  private readonly exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
  private readonly agentName = 'botmux';
  private paneId: string | undefined;
  private exited = false;
  private started = false;
  private cols = 200;
  private rows = 50;

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

  onData(cb: (data: string) => void): void {
    this.dataCbs.push(cb);
    if (!this.pendingData || this.exited) return;
    const pending = this.pendingData;
    this.pendingData = '';
    try { cb(pending); } catch { /* listener crash must not kill the observer */ }
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCbs.push(cb);
  }

  kill(): void {
    if (this.exited) return;
    this.exited = true;
    this.stopObserver();
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

  private getAgent(): any | undefined {
    const raw = jsonCommand(herdrSessionArgs(this.sessionName, ['agent', 'get', this.agentName]), { timeout: 5000 });
    return extractAgent(raw);
  }

  private listAgents(): any[] | null {
    const raw = tryJsonCommand(herdrSessionArgs(this.sessionName, ['agent', 'list']), { timeout: 5000 });
    return raw.ok ? extractAgents(raw.value) : null;
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
    this.lastFrameSeq = 0;

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
    }
    const data = this.streamDecoder.write(bytes);
    if (!data) return;
    if (this.dataCbs.length === 0) {
      this.pendingData = message.full ? data : this.pendingData + data;
      return;
    }
    for (const cb of this.dataCbs) {
      try { cb(data); } catch { /* listener crash must not kill the observer */ }
    }
  }

  private handleObserverDisconnect(child: ChildProcess): void {
    if (this.observerProcess !== child || this.exited) return;
    this.observerProcess = null;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }

    const agents = this.listAgents();
    if (agents !== null) {
      const matching = agents.find(agent => agent?.name === this.agentName || agent?.pane_id === this.paneId);
      if (!matching || agentRowExited(matching)) {
        const exitCode = typeof matching?.exit_code === 'number' ? matching.exit_code : 0;
        this.handleExit(exitCode, null);
        return;
      }
    }

    this.observerRestartTimer = setTimeout(() => {
      this.observerRestartTimer = null;
      if (!this.exited) this.startObserver();
    }, OBSERVER_RESTART_DELAY_MS);
    this.observerRestartTimer.unref?.();
  }

  private stopObserver(): void {
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
    this.stopObserver();
    this.pendingData = '';
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
