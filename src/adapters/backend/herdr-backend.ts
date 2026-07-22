import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import * as pty from 'node-pty';
import xtermHeadless from '@xterm/headless';
import type { BackendType, SessionBackend, SpawnOpts, SessionProbe } from './types.js';
import { logger } from '../../utils/logger.js';

const { Terminal } = xtermHeadless;

export type PersistentBackendType = Exclude<BackendType, 'pty'>;

export interface HerdrExternalTarget {
  sessionName: string;
  target: string;
  paneId?: string;
}

interface HerdrBackendOptions {
  createSession?: boolean;
  isReattach?: boolean;
  externalTarget?: HerdrExternalTarget;
  /** Managed agent inside a user's existing herdr session. */
  agentName?: string;
  /** Whether /close should stop the whole herdr session. */
  ownsSession?: boolean;
  /** Whether /close should close just the managed pane in a shared session. */
  ownsAgent?: boolean;
}

// Slow output-streaming poll. We deliberately avoid the original 250ms tick:
// herdr exposes `wait agent-status`, which we use to fire an immediate read on
// every idle/working/blocked transition. The 500ms timer is a fallback for the
// in-the-middle-of-working case where output streams without a status flip.
const POLL_INTERVAL_MS = 500;
const READ_LINES = 10_000;
const MAX_AGENT_PROBE_FAILURES = 3;
// Inter-attempt sleep while waiting for `herdr server` to come up.
// Synchronous (execFileSync 'sleep') because spawn() must stay sync.
const SERVER_BOOT_POLL_MS = 100;
const SERVER_BOOT_DEADLINE_MS = 5000;
// `herdr wait agent-status` blocks until the requested status, or succeeds
// immediately when that status is already current. We cap it so a long-stuck
// agent still re-arms the watcher and we never accumulate an
// indefinitely-orphaned subprocess on process teardown.
const STATUS_WAIT_TIMEOUT_MS = 30_000;
// Herdr 0.7.5 replaced the free-form `agent start --cwd -- <argv...>` command
// with a managed-agent facade that targets an existing shell pane and launches
// one of Herdr's known coding-agent kinds. The command itself waits for the TUI
// to become interactive, so let it use its 30s default plus a small IPC margin.
const PANE_AGENT_START_TIMEOUT_MS = 30_000;
const PANE_AGENT_EXEC_TIMEOUT_MS = PANE_AGENT_START_TIMEOUT_MS + 5_000;
// Watch the full useful lifecycle, not just settled statuses. Herdr's
// `wait agent-status --status X` is level-triggered: when the pane is already
// in X it succeeds immediately. After one status wins we therefore exclude it
// from the next cohort until another lifecycle status wins. Watching `working`
// is what re-enables `done`/`blocked`/`idle` for the following turn without
// hot-looping on the settled state between turns.
const WATCHED_STATUSES = ['working', 'done', 'blocked', 'idle'] as const;
type WatchedStatus = typeof WATCHED_STATUSES[number];

type JsonCommandResult = { ok: true; value: any | undefined } | { ok: false };

const PANE_AGENT_KIND_BY_EXECUTABLE: Readonly<Record<string, string>> = {
  pi: 'pi',
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  'cursor-agent': 'cursor',
  agy: 'agy',
  omp: 'omp',
  opencode: 'opencode',
  copilot: 'copilot',
  kimi: 'kimi',
  'kiro-cli': 'kiro',
  grok: 'grok',
  hermes: 'hermes',
};

export interface HerdrWebTerminalSize {
  cols: number;
  rows: number;
}

export interface HerdrWebTerminalCursor {
  col: number;
  row: number;
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

/** Required command variant used by multi-step Herdr protocols.
 *
 * `jsonCommand()` intentionally collapses command failures to undefined for
 * best-effort probes. Spawn is different: swallowing stderr turned Herdr
 * 0.7.5's actionable `unknown option: --cwd` into the generic
 * "failed to start agent" message. Keep command arguments (which may contain
 * credentials in --env values) out of the exception while preserving the
 * upstream error code/message.
 */
function requiredJsonCommand(
  operation: string,
  args: string[],
  opts?: { timeout?: number; input?: string; env?: NodeJS.ProcessEnv },
): any {
  let raw = '';
  try {
    raw = execFileSync('herdr', args, {
      encoding: 'utf-8',
      input: opts?.input,
      stdio: opts?.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      timeout: opts?.timeout ?? 5000,
      maxBuffer: 16 * 1024 * 1024,
      env: opts?.env,
    }).trim();
  } catch (err: any) {
    const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : err?.stderr?.toString?.().trim();
    const stdout = typeof err?.stdout === 'string' ? err.stdout.trim() : err?.stdout?.toString?.().trim();
    const detail = stderr || stdout;
    throw new Error(`${operation} failed${detail ? `: ${detail.slice(0, 1000)}` : ''}`);
  }
  if (!raw) throw new Error(`${operation} failed: empty response`);
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${operation} failed: invalid JSON response`);
  }
  if (value?.error) {
    const code = typeof value.error.code === 'string' ? value.error.code : 'unknown_error';
    const message = typeof value.error.message === 'string' ? value.error.message : 'unknown error';
    throw new Error(`${operation} failed: ${code}: ${message}`);
  }
  return value;
}

function herdrUsesPaneAgentStart(): boolean {
  try {
    const out = execFileSync('herdr', ['--version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\D|$)/.exec(out);
    if (!match) return false;
    const [, majorRaw, minorRaw, patchRaw] = match;
    const major = Number(majorRaw);
    const minor = Number(minorRaw);
    const patch = Number(patchRaw);
    return major > 0 || minor > 7 || (minor === 7 && patch >= 5);
  } catch {
    return false;
  }
}

function paneAgentKindForExecutable(bin: string): string | undefined {
  return PANE_AGENT_KIND_BY_EXECUTABLE[basename(bin)];
}

function environmentForPaneAgent(bin: string, childEnv: Record<string, string> | undefined): Record<string, string> {
  const env = { ...(childEnv ?? {}) };
  if (!isAbsolute(bin)) return env;
  const binDir = dirname(bin);
  const currentPath = env.PATH ?? process.env.PATH ?? '';
  const pathParts = currentPath.split(delimiter).filter(Boolean);
  env.PATH = [binDir, ...pathParts.filter(part => part !== binDir)].join(delimiter);
  return env;
}

function shellSingleQuote(value: string): string {
  if (value.includes('\0')) throw new Error('Herdr launch argument contains NUL');
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Build a short-lived canonical launcher for Herdr's managed-agent facade.
 *
 * Herdr 0.7.5 rejects control characters in `agent start` arguments, while
 * Botmux intentionally passes multiline system/initial prompts to several
 * CLIs. Put the exact executable + argv in a mode-0700 script and give Herdr
 * no agent arguments. The shell immediately execs the real CLI, so Herdr still
 * observes and validates the actual supported coding-agent process. The script
 * is removed as soon as Herdr reports the TUI interactive.
 */
function createPaneAgentLauncher(
  canonicalExecutable: string,
  bin: string,
  args: string[],
  originalPath: string,
): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-herdr-launch-'));
  const path = join(dir, canonicalExecutable);
  const command = [bin, ...args].map(shellSingleQuote).join(' ');
  writeFileSync(path, [
    '#!/bin/sh',
    // Minimise the lifetime of the mode-0700 file containing the exact argv.
    // The backend's finally block is the fallback if Herdr never executes it.
    '/bin/rm -f -- "$0"',
    '/bin/rmdir -- "${0%/*}" 2>/dev/null || true',
    `PATH=${shellSingleQuote(originalPath)}`,
    'export PATH',
    `exec ${command}`,
    '',
  ].join('\n'), { mode: 0o700 });
  return { dir, path };
}

function envCommandArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
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

function longestSuffixPrefix(previous: string, next: string): number {
  const max = Math.min(previous.length, next.length);
  for (let len = max; len > 0; len--) {
    if (previous.endsWith(next.slice(0, len))) return len;
  }
  return 0;
}

export class HerdrBackend implements SessionBackend {
  private serverProcess: ChildProcess | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private statusWaitProcesses: ChildProcess[] = [];
  private readonly dataCbs: Array<(d: string) => void> = [];
  private readonly snapshotCbs: Array<(snapshot: string) => void> = [];
  private readonly webCursorCbs: Array<(cursor: HerdrWebTerminalCursor) => void> = [];
  private readonly exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
  private readonly agentName: string;
  private paneId: string | undefined;
  private lastText = '';
  private exited = false;
  private started = false;
  private cols = 200;
  private rows = 50;
  private agentProbeFailures = 0;
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
    readonly sessionName: string,
    private readonly opts: HerdrBackendOptions = {},
  ) {
    this.agentName = opts.agentName ?? 'botmux';
    if (opts.externalTarget?.paneId) this.paneId = opts.externalTarget.paneId;
  }

  static isAvailable(): boolean {
    try {
      execFileSync('herdr', ['--version'], { stdio: 'ignore', timeout: 3000 });
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

  /** Pick a user-owned running session without creating anything. */
  static preferredRunningSession(): string | undefined {
    const raw = jsonCommand(['session', 'list', '--json']);
    const sessions = extractSessions(raw).filter((s: any) =>
      typeof s?.name === 'string' && s.running === true && !s.name.startsWith('bmx-'));
    const envSession = process.env.HERDR_SESSION;
    if (envSession && sessions.some((s: any) => s.name === envSession)) return envSession;
    return sessions.find((s: any) => s.default === true)?.name ?? sessions[0]?.name;
  }

  static hasAgent(sessionName: string, agentName: string): boolean {
    return HerdrBackend.probeAgent(sessionName, agentName) === 'exists';
  }

  /** Tri-state probe for a Botmux-managed agent inside a shared session. */
  static probeAgent(sessionName: string, agentName: string): SessionProbe {
    const result = tryJsonCommand(
      herdrSessionArgs(sessionName, ['agent', 'list']),
      { timeout: 5000 },
    );
    if (!result.ok) {
      // `agent list` can fail because this specific host session disappeared,
      // not only because the Herdr server is unavailable. Preserve the same
      // missing-vs-unknown distinction as whole-session lifecycle probes.
      return HerdrBackend.probeSession(sessionName) === 'missing' ? 'missing' : 'unknown';
    }
    const agent = extractAgents(result.value).find((row: any) => row?.name === agentName);
    return agent && !agentRowExited(agent) ? 'exists' : 'missing';
  }

  /** Close only the managed pane, never the surrounding user-owned session. */
  static killAgent(sessionName: string, agentName: string): void {
    const raw = jsonCommand(
      herdrSessionArgs(sessionName, ['agent', 'list']),
      { timeout: 5000 },
    );
    const paneId = extractAgents(raw).find((row: any) => row?.name === agentName)?.pane_id;
    if (typeof paneId === 'string' && paneId) {
      runHerdr(herdrSessionArgs(sessionName, ['pane', 'close', paneId]), { timeout: 5000 });
    }
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
      } else if (herdrUsesPaneAgentStart()) {
        this.paneId = this.startPaneAgent(bin, args, opts);
      } else {
        const envArgs = this.opts.ownsSession === false
          ? envCommandArgs(this.childEnv ?? {})
          : [];
        const started = requiredJsonCommand(
          `herdr agent start ${this.agentName} in ${this.sessionName}`,
          herdrSessionArgs(this.sessionName, [
          'agent', 'start', this.agentName,
          '--cwd', opts.cwd,
          ...envArgs,
          '--', bin, ...args,
          ]),
          { timeout: 10_000, env: this.childEnv },
        );
        const agent = extractAgent(started);
        if (!agent) throw new Error(`failed to start herdr agent ${this.agentName} in ${this.sessionName}`);
        this.paneId = agent.pane_id;
      }
    }

    this.started = true;
    // Baseline policy mirrors the tmux/PTY backends:
    //   - Fresh spawn: lastText='' so the first poll emits everything from
    //     t=0 (matches the PTY contract — listeners see all output even if
    //     the agent echoed before the first read).
    //   - Re-attach / external adopt: snapshot the current screen so we only
    //     stream new deltas. Worker.ts explicitly seeds the initial screen
    //     via captureCurrentScreen() in those paths.
    this.lastText = (this.isReattach || this.opts.externalTarget) ? this.readRecentAnsi() : '';
    this.startPolling();
    this.startStatusWatcher();
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
    this.cols = cols;
    this.rows = rows;
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
    this.cols = cols;
    this.rows = rows;
    this.webSize = size;
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
  }

  /** Full interpreted terminal frame for snapshot-aware web history merging. */
  onSnapshot(cb: (snapshot: string) => void): void {
    this.snapshotCbs.push(cb);
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
    this.stopPolling();
    this.stopStatusWatcher();
    this.serverProcess = null;
  }

  destroySession(): void {
    this.kill();
    // Adopted targets are observation-only. A managed agent placed in a user's
    // existing session owns its pane but never the surrounding herdr session.
    if (this.opts.ownsSession ?? !this.opts.externalTarget) {
      HerdrBackend.killSession(this.sessionName);
    } else if (this.opts.ownsAgent) {
      if (this.paneId) {
        runHerdr(herdrSessionArgs(this.sessionName, ['pane', 'close', this.paneId]), { timeout: 5000 });
      } else {
        HerdrBackend.killAgent(this.sessionName, this.agentName);
      }
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

  /** Herdr >=0.7.5 managed-agent launch protocol.
   *
   * The new facade no longer accepts an arbitrary executable or cwd directly:
   * create a shell workspace with the requested cwd/env, then ask Herdr to
   * launch a supported coding-agent kind in that exact root pane. Prepending
   * an absolute binary's directory to PATH preserves cliPathOverride installs
   * whose basename is still the canonical Herdr executable (for example a Pi
   * installed under ~/.local/bin/node/bin/pi).
   */
  private startPaneAgent(bin: string, args: string[], opts: SpawnOpts): string {
    const kind = paneAgentKindForExecutable(bin);
    if (!kind) {
      throw new Error(
        `Herdr >=0.7.5 cannot launch executable "${basename(bin)}" as a managed coding agent; ` +
        'use a Herdr-supported CLI executable or select the tmux backend',
      );
    }

    const workspaceEnv = environmentForPaneAgent(bin, this.childEnv);
    const originalPath = workspaceEnv.PATH ?? process.env.PATH ?? '';
    const launcher = createPaneAgentLauncher(basename(bin), bin, args, originalPath);
    workspaceEnv.PATH = [launcher.dir, originalPath].filter(Boolean).join(delimiter);
    let workspaceId: string | undefined;
    try {
      const created = requiredJsonCommand(
        `herdr workspace create for ${this.agentName} in ${this.sessionName}`,
        herdrSessionArgs(this.sessionName, [
          'workspace', 'create',
          '--cwd', opts.cwd,
          '--label', this.agentName,
          '--no-focus',
          ...envCommandArgs(workspaceEnv),
        ]),
        { timeout: 10_000, env: this.childEnv },
      );
      const paneId = created?.result?.root_pane?.pane_id;
      workspaceId = created?.result?.workspace?.workspace_id;
      if (typeof paneId !== 'string' || !paneId) {
        throw new Error(`herdr workspace create for ${this.agentName} in ${this.sessionName} failed: missing root pane`);
      }

      const started = requiredJsonCommand(
        `herdr agent start ${this.agentName} in ${this.sessionName}`,
        herdrSessionArgs(this.sessionName, [
          'agent', 'start', this.agentName,
          '--kind', kind,
          '--pane', paneId,
          '--timeout', String(PANE_AGENT_START_TIMEOUT_MS),
        ]),
        { timeout: PANE_AGENT_EXEC_TIMEOUT_MS, env: this.childEnv },
      );
      const agent = extractAgent(started);
      if (!agent?.pane_id) {
        throw new Error(`herdr agent start ${this.agentName} in ${this.sessionName} failed: missing agent pane`);
      }
      return agent.pane_id;
    } catch (err) {
      // Workspace creation succeeded but the CLI did not. Remove only the
      // workspace created by this attempt so a shared user session is never
      // left with an empty Botmux tab after a failed spawn.
      if (typeof workspaceId === 'string' && workspaceId) {
        runHerdr(
          herdrSessionArgs(this.sessionName, ['workspace', 'close', workspaceId]),
          { timeout: 5000 },
        );
      }
      throw err;
    } finally {
      rmSync(launcher.dir, { recursive: true, force: true });
    }
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

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private poll(): void {
    if (this.exited) return;
    const agents = this.listAgents();
    if (agents === null) {
      this.agentProbeFailures++;
      if (this.agentProbeFailures < MAX_AGENT_PROBE_FAILURES) return;
      this.handleExit(0, null);
      return;
    }
    this.agentProbeFailures = 0;
    // Exit detection. Verified against herdr v0.6.6: when the CLI process exits,
    // herdr DROPS the agent row from `agent list` (it does NOT keep a
    // running:false tombstone). So the primary signal is "our agent is no
    // longer in the list". We also treat an explicit terminal marker as exited
    // (agentRowExited) to stay robust if a future herdr keeps a tombstone row —
    // otherwise name-presence alone would never report the exit and the worker
    // would never emit `claude_exit`, hanging the session.
    const matchingAgent = agents.find(agent => agent?.name === this.agentName || agent?.pane_id === this.paneId);
    const agentExited = matchingAgent ? agentRowExited(matchingAgent) : true;
    if (this.started && agentExited) {
      const exitCode = typeof matchingAgent?.exit_code === 'number' ? matchingAgent.exit_code : 0;
      this.handleExit(exitCode, null);
      return;
    }

    this.readAndEmitDelta();
  }

  /** Read herdr pane recent output and emit the delta vs. last snapshot. */
  private readAndEmitDelta(): void {
    if (this.exited) return;
    const next = this.readRecentAnsi();
    if (!next || next === this.lastText) return;
    for (const cb of this.snapshotCbs) {
      try { cb(next); } catch { /* listener crash shouldn't kill polling */ }
    }
    let delta = '';
    if (next.startsWith(this.lastText)) {
      delta = next.slice(this.lastText.length);
    } else if (this.lastText.endsWith(next)) {
      this.lastText = next;
      return;
    } else {
      const overlap = longestSuffixPrefix(this.lastText, next);
      delta = overlap > 0 ? next.slice(overlap) : next;
    }
    this.lastText = next;
    if (!delta) return;
    for (const cb of this.dataCbs) {
      try { cb(delta); } catch { /* listener crash shouldn't kill polling */ }
    }
  }

  /**
   * Spawn one `herdr wait agent-status` child per useful status other than the
   * current one. The first to fire wins → we read+emit, tear down the losers,
   * and re-arm while excluding the winning (now-current) status.
   *
   * Excluding the current status is essential because Herdr waits are
   * level-triggered. Re-arming the same status immediately would make a pane
   * parked at `idle`/`done` spawn a new wait cohort every ~20ms and saturate
   * the Herdr API socket. `working` participates solely to advance the state
   * machine so settled statuses are eligible again on the next turn.
   */
  private startStatusWatcher(currentStatus?: WatchedStatus): void {
    if (this.exited) return;
    const paneTarget = this.paneId ?? this.agentName;
    if (!paneTarget) return;
    this.stopStatusWatcher();
    const cohort: ChildProcess[] = [];
    const armedAt = Date.now();
    for (const status of WATCHED_STATUSES) {
      if (status === currentStatus) continue;
      const child = spawn('herdr', [
        '--session', this.sessionName,
        'wait', 'agent-status', paneTarget,
        '--status', status,
        '--timeout', String(STATUS_WAIT_TIMEOUT_MS),
      ], { stdio: ['ignore', 'ignore', 'ignore'] });
      cohort.push(child);

      child.on('exit', (code) => {
        // Only the first child to finish (across the cohort) drives the
        // re-arm cycle; later finishers in the same cohort are dropped.
        if (!this.statusWaitProcesses.includes(child)) return;
        const wasFirstExit = this.statusWaitProcesses === cohort;
        // Drop this child from the active cohort.
        this.statusWaitProcesses = this.statusWaitProcesses.filter(c => c !== child);
        if (!wasFirstExit || this.exited) return;
        // First exit in this cohort — tear down siblings, then read+re-arm.
        this.stopStatusWatcher();
        this.readAndEmitDelta();

        // code 0 means the watched status is now current. Re-arm immediately,
        // but exclude that status from the next cohort: Herdr returns success
        // immediately while a status remains current, so including it again is
        // the level-triggered success storm this state machine prevents.
        if (code === 0) {
          this.startStatusWatcher(status);
          return;
        }

        // Non-zero storm guard: when the agent's pane has gone away (the CLI
        // exited), `herdr wait agent-status` returns code 1 within MILLISECONDS
        // rather than after the 30s timeout. The old code re-armed on every non-0 code
        // synchronously, so a dead pane spun a tight spawn loop (thousands of
        // `herdr wait` children/sec) that starved the 500ms poll timer → the
        // session never reported its exit and hung. So for a non-zero code we
        // first distinguish "real long timeout" (child lived a meaningful
        // fraction of the window — agent still working, re-arm normally) from
        // "instant return" (pane likely gone — check liveness; only re-arm via
        // a deferred timer, never synchronously, so poll() can run and we can't
        // spin). Verified on v0.6.6: the exited agent's row disappears from
        // `agent list`.
        const elapsed = Date.now() - armedAt;
        const returnedInstantly = elapsed < STATUS_WAIT_TIMEOUT_MS / 2;
        if (returnedInstantly) {
          const agents = this.listAgents();
          if (agents !== null) {
            const matching = agents.find(a => a?.pane_id === this.paneId || a?.name === this.agentName);
            const exited = matching ? agentRowExited(matching) : true;
            if (exited) {
              const exitCode = typeof matching?.exit_code === 'number' ? matching.exit_code : 0;
              this.handleExit(exitCode, null);
              return;
            }
          }
          // Agent still alive but the wait returned instantly (transient
          // herdr hiccup). Re-arm on a later tick, never synchronously, so we
          // can't spin: the deferred timer yields the loop to poll(). unref
          // so we never hold the event loop open.
          if (this.exited) return;
          const t = setTimeout(() => {
            if (!this.exited) this.startStatusWatcher(currentStatus);
          }, POLL_INTERVAL_MS);
          t.unref?.();
          return;
        }
        // A real long-timeout after ~30s: preserve the last winning status so
        // the periodic timeout itself cannot re-introduce a level-triggered
        // waiter for the unchanged current state.
        this.startStatusWatcher(currentStatus);
      });
      child.on('error', () => {
        // `herdr` missing or unspawnable: drop from cohort. Timer-based poll
        // still acts as the fallback signal.
        this.statusWaitProcesses = this.statusWaitProcesses.filter(c => c !== child);
      });
    }
    this.statusWaitProcesses = cohort;
  }

  private stopStatusWatcher(): void {
    const active = this.statusWaitProcesses;
    this.statusWaitProcesses = [];
    for (const child of active) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
  }

  private handleExit(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    this.resetWebTerminal();
    this.stopPolling();
    this.stopStatusWatcher();
    for (const cb of this.exitCbs) {
      try { cb(code, signal); } catch { /* listener crash shouldn't kill teardown */ }
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
