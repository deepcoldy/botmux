import * as pty from 'node-pty';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionBackend, SpawnOpts, SessionProbe } from './types.js';
import { zellijEnv, probeZellijFunctional } from '../../setup/ensure-zellij.js';
import { resolveUserShell, buildBotmuxEnvAssignments, SHELL_WRAPPER_SCRIPT } from './tmux-backend.js';
import { logger } from '../../utils/logger.js';

/**
 * ZellijBackend — session backend using zellij for process persistence.
 *
 * Architecture: pty-under-zellij (the "B route"), the zellij analogue of the
 * legacy TmuxBackend (pty-under-tmux):
 *   - A node-pty process runs `zellij --session … --layout-string …` (fresh)
 *     or `zellij attach …` (reattach). The node-pty is the only zellij client.
 *   - All output flows through the pty (onData/onExit work unchanged) — we get
 *     the raw rendered byte stream for free, sidestepping zellij `subscribe`'s
 *     "whole-viewport-snapshot" model that doesn't fit botmux's xterm pipeline.
 *   - Input goes through pty.write(). We start zellij in **locked mode with
 *     keybindings cleared** (generated config), so every byte we write —
 *     including Ctrl-C, arrows, bracketed-paste markers — passes straight to
 *     the focused CLI pane with zero keybinding interception (the moral
 *     equivalent of tmux's single prefix key, but with nothing reserved).
 *   - resize() is pty.resize(): the attached client's size drives the pane, so
 *     the headless-default 25-column problem never bites (the pty is the size).
 *   - kill() only detaches (kills the pty client); the zellij server keeps the
 *     CLI running, so a daemon restart re-attaches with `zellij attach`.
 *   - destroySession() runs `zellij delete-session -f` (kill + purge the
 *     resurrectable corpse) on explicit /close.
 *
 * Naming: zellij sessions are named `bmx-<sessionId.slice(0,8)>`, same as tmux.
 */
export class ZellijBackend implements SessionBackend {
  private process: pty.IPty | null = null;
  private readonly sessionName: string;
  private readonly ownsSession: boolean;
  private reattaching = false;
  private configPath: string | null = null;
  private tmpConfigDir: string | null = null;
  /** Set by kill()/destroySession() so the pty-client exit they cause (an
   *  intentional detach/teardown — the zellij session survives) is NOT
   *  reported as a CLI exit. A real CLI exit leaves this false. */
  private intentionalExit = false;
  /** Cached CLI pid. The CLI subprocess starts asynchronously after spawn(),
   *  so the first getChildPid() may be null; once resolved it's stable for the
   *  session lifetime (single CLI pane → pane exit ends the session). */
  private resolvedCliPid: number | null = null;
  /** Explicit pane target for adopt mode (e.g. "terminal_2"). When null,
   *  zellij `action` commands address the focused pane — correct for managed
   *  mode where the single CLI pane is always focused. */
  private readonly paneId: string | null;

  // PtyHandle fields the worker sets (parallel to TmuxBackend / PtyBackend) so
  // the claude-code adapter can verify submits and follow the session id.
  claudeJsonlPath?: string;
  cliPid?: number;
  cliCwd?: string;

  constructor(sessionName: string, opts?: { ownsSession?: boolean; isReattach?: boolean; paneId?: string }) {
    this.sessionName = sessionName;
    this.ownsSession = opts?.ownsSession ?? true;
    this.reattaching = opts?.isReattach ?? false;
    this.paneId = opts?.paneId ?? null;
  }

  // ─── Static helpers (mirror TmuxBackend) ──────────────────────────────────

  static isAvailable(): boolean {
    return probeZellijFunctional().ok;
  }

  static sessionName(sessionId: string): string {
    return `bmx-${sessionId.slice(0, 8)}`;
  }

  /** Names of LIVE (non-exited) zellij sessions. A killed-but-serialised
   *  session lingers in `list-sessions` as "(EXITED - attach to resurrect)";
   *  we must not treat those as reattachable, so filter them out. */
  static liveSessions(): string[] {
    const probe = ZellijBackend.probeLiveSessions();
    return probe.ok ? probe.sessions : [];
  }

  /** Like liveSessions(), but distinguishes "command failed/timed out" ({ok:false})
   *  from "command succeeded, zero live sessions" ({ok:true, sessions:[]}). The
   *  tri-state probe builds on this so a transient `list-sessions` failure isn't
   *  read as "session gone". */
  static probeLiveSessions(): { ok: true; sessions: string[] } | { ok: false } {
    try {
      const out = execFileSync('zellij', ['list-sessions', '--no-formatting'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
        env: zellijEnv(),
      });
      return {
        ok: true,
        sessions: out
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 0 && !/EXITED/i.test(l))
          .map(l => l.split(/\s+/)[0]!)
          .filter(Boolean),
      };
    } catch {
      return { ok: false };
    }
  }

  static hasSession(name: string): boolean {
    return ZellijBackend.probeSession(name) === 'exists';
  }

  static probeSession(name: string): SessionProbe {
    const probe = ZellijBackend.probeLiveSessions();
    if (!probe.ok) return 'unknown';
    return probe.sessions.includes(name) ? 'exists' : 'missing';
  }

  /**
   * Tri-state liveness of the zellij SERVER (not a specific session). Mirrors
   * TmuxBackend.serverState — see that doc for why 'missing' must be
   * disambiguated before driving a destructive restore-time close.
   *
   *   - 'running' — list-sessions succeeded with ≥1 live session.
   *   - 'down'    — list-sessions succeeded with ZERO live sessions, i.e. nothing
   *                 survives (a machine reboot wipes every session at once).
   *   - 'unknown' — list-sessions failed/timed out (can't tell).
   */
  static serverState(): 'running' | 'down' | 'unknown' {
    const probe = ZellijBackend.probeLiveSessions();
    if (!probe.ok) return 'unknown';
    return probe.sessions.length > 0 ? 'running' : 'down';
  }

  /** Kill + purge a session (so no resurrectable corpse accumulates). */
  static killSession(name: string): void {
    try {
      spawnSync('zellij', ['delete-session', name, '-f'], { stdio: 'ignore', timeout: 4000, env: zellijEnv() });
    } catch { /* doesn't exist */ }
  }

  static listBotmuxSessions(): string[] {
    return ZellijBackend.liveSessions().filter(s => s.startsWith('bmx-'));
  }

  // ─── SessionBackend implementation ────────────────────────────────────────

  spawn(bin: string, args: string[], opts: SpawnOpts): void {
    // Reattach if the session is already live (daemon restarted, CLI survived).
    this.reattaching = this.reattaching || ZellijBackend.hasSession(this.sessionName);
    logger.debug(
      `[zellij:${this.sessionName}] spawn ${this.reattaching ? 'reattach' : 'new'} ` +
      `bin=${bin} args=${JSON.stringify(args)} cwd=${opts.cwd} ${opts.cols}x${opts.rows}`,
    );

    const { configPath, layoutPath } = this.writeRuntimeFiles(bin, args, opts);
    this.configPath = configPath;
    const childEnv = zellijEnv(opts.env);

    // Fresh: `--new-session-with-layout <file>` FORCES a new named session with
    // our layout (plain `--session … --layout-string` instead ATTACHES to the
    // name and errors "no active session"). Reattach: `attach <name>` rejoins
    // the surviving session (daemon restarted, CLI still running inside).
    const zellijArgs = this.reattaching
      ? ['--config', configPath, 'attach', this.sessionName]
      : ['--config', configPath, '--session', this.sessionName,
         '--new-session-with-layout', layoutPath];

    this.process = pty.spawn('zellij', zellijArgs, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: childEnv,
    });
  }

  /** Write the per-session config (locked mode + cleared keybinds so pty.write
   *  passes through untouched, no startup tips / pane frames) and, for a fresh
   *  spawn, the single-pane layout file. Both live in one temp dir cleaned on
   *  kill(). On reattach the layout file is unused but harmless. */
  private writeRuntimeFiles(bin: string, args: string[], opts: SpawnOpts): { configPath: string; layoutPath: string } {
    this.tmpConfigDir = mkdtempSync(join(tmpdir(), 'bmx-zellij-'));
    const configPath = join(this.tmpConfigDir, 'config.kdl');
    const layoutPath = join(this.tmpConfigDir, 'layout.kdl');
    writeFileSync(configPath, ZELLIJ_CONFIG_KDL);
    if (!this.reattaching) writeFileSync(layoutPath, buildLayoutString(bin, args, opts));
    return { configPath, layoutPath };
  }

  get isReattach(): boolean {
    return this.reattaching;
  }

  // ── Input ──
  // In locked mode with cleared keybinds, raw bytes written to the client pty
  // are forwarded verbatim to the focused pane — so every input path collapses
  // to pty.write(), exactly like TmuxBackend.write().

  write(data: string): void {
    this.process?.write(data);
  }

  /** Literal text, no Enter. */
  sendText(text: string): void {
    this.process?.write(text);
  }

  /** Special keys by tmux-style name (Enter, Escape, C-c, M-Enter, …). */
  sendSpecialKeys(...keys: string[]): void {
    for (const key of keys) {
      this.process?.write(tmuxKeyToBytes(key));
    }
  }

  /** Bracketed paste: wrap with \e[200~ … \e[201~ so TUIs (CoCo/Ink/Codex)
   *  detect the paste boundary and don't treat embedded \n as Enter. Mirrors
   *  `tmux paste-buffer -p`. */
  pasteText(text: string): void {
    this.process?.write(`\x1b[200~${text}\x1b[201~`);
  }

  resize(cols: number, rows: number): void {
    this.process?.resize(cols, rows);
  }

  /** Must be called AFTER spawn(). */
  onData(cb: (data: string) => void): void {
    this.process?.onData(cb);
  }

  /** Must be called AFTER spawn(). */
  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.process?.onExit(({ exitCode, signal }) => {
      // Suppress the pty-client exit caused by our own kill()/destroySession()
      // (intentional detach/teardown — the zellij session survives, so a
      // claude_exit here would falsely tear the worker down on restart). A real
      // CLI exit (pane closes → single-pane session ends) leaves intentionalExit
      // false and is forwarded. Mirrors TmuxPipeBackend's intentional-detach
      // semantics (pty-under TmuxBackend lacked this — the gap Codex flagged).
      if (this.intentionalExit) return;
      cb(exitCode, signal !== undefined ? String(signal) : null);
    });
  }

  /** CLI pid. May be null immediately after spawn() (the CLI subprocess starts
   *  asynchronously); the worker retries. Cached once resolved. */
  getChildPid(): number | null {
    if (this.resolvedCliPid !== null) return this.resolvedCliPid;
    this.resolvedCliPid = findPaneCliPid(this.sessionName, '');
    return this.resolvedCliPid;
  }

  /** Detach only — kills the pty client, leaves the zellij session running. */
  kill(): void {
    this.intentionalExit = true;
    if (this.process) {
      try { this.process.kill(); } catch { /* already dead */ }
      this.process = null;
    }
    this.cleanupConfig();
  }

  /** Kill the zellij session permanently (explicit /close). */
  destroySession(): void {
    this.kill();
    if (this.ownsSession) {
      ZellijBackend.killSession(this.sessionName);
    }
  }

  private cleanupConfig(): void {
    if (this.tmpConfigDir) {
      try { rmSync(this.tmpConfigDir, { recursive: true, force: true }); } catch { /* benign */ }
      this.tmpConfigDir = null;
      this.configPath = null;
    }
  }
}

// ─── Pure helpers (unit-testable) ───────────────────────────────────────────

/**
 * Locked mode + cleared keybinds => the client pty forwards every byte to the
 * focused pane with no zellij interception. No startup tips / pane frames so
 * the captured stream is just the CLI (we don't need to hide chrome, but a
 * clean single pane keeps screenshots faithful and the renderer simple).
 */
export const ZELLIJ_CONFIG_KDL = `// botmux-generated — do not edit
show_startup_tips false
pane_frames false
default_mode "locked"
keybinds clear-defaults=true {
}
`;

/** Escape a string for a KDL double-quoted value. */
export function kdlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Build the `--layout-string` KDL: a single full-screen pane that execs the CLI
 * through the user's shell (same wrapper TmuxBackend uses, so PATH / NVM / pnpm
 * / mise shims load from rcfiles). Command + args go in via execvp semantics —
 * no shell-quoting needed (KDL strings carry spaces/quotes), only KDL escaping.
 *
 *   pane command="<shell>" close_on_exit=true {
 *       args "<flag>"… "-c" "<script>" "_" "<cwd>" "KEY=VAL"… "<bin>" "<arg>"…
 *   }
 */
export function buildLayoutString(bin: string, args: string[], opts: SpawnOpts): string {
  const shellSpec = resolveUserShell();
  const envAssignments = buildBotmuxEnvAssignments(opts.env, opts.injectEnv);
  const paneArgs = [
    ...shellSpec.flags, '-c', SHELL_WRAPPER_SCRIPT, '_',
    opts.cwd,
    ...envAssignments,
    bin, ...args,
  ];
  const argsKdl = paneArgs.map(kdlString).join(' ');
  return [
    'layout {',
    `    pane command=${kdlString(shellSpec.shell)} close_on_exit=true {`,
    `        args ${argsKdl}`,
    '    }',
    '}',
  ].join('\n');
}

/**
 * Map a tmux-style key name to the raw bytes a terminal emits for it. Covers
 * the names botmux's adapters / worker actually send (Enter, Escape, C-<x>,
 * M-<x>, arrows, Tab, BSpace, …). Unknown names fall back to the literal string
 * so a missing mapping degrades to "typed as-is" rather than dropping input.
 */
export function tmuxKeyToBytes(key: string): string {
  const named: Record<string, string> = {
    Enter: '\r',
    Tab: '\t',
    Escape: '\x1b',
    Esc: '\x1b',
    Space: ' ',
    BSpace: '\x7f',
    Backspace: '\x7f',
    Up: '\x1b[A',
    Down: '\x1b[B',
    Right: '\x1b[C',
    Left: '\x1b[D',
    Home: '\x1b[H',
    End: '\x1b[F',
    PageUp: '\x1b[5~',
    PageDown: '\x1b[6~',
    'M-Enter': '\x1b\r',
  };
  if (key in named) return named[key]!;

  // C-<x>: control byte. C-a..C-z → 0x01..0x1a; C-c → ETX (0x03), etc.
  const ctrl = key.match(/^C-([A-Za-z])$/);
  if (ctrl) {
    const c = ctrl[1]!.toLowerCase().charCodeAt(0) - 96; // 'a' -> 1
    return String.fromCharCode(c);
  }
  // M-<x>: ESC prefix (Alt).
  const meta = key.match(/^M-(.)$/);
  if (meta) return `\x1b${meta[1]}`;

  // Unknown: best-effort literal.
  return key;
}

/**
 * Find the zellij `--server …/<sessionName>` process pid. The session name is
 * the trailing path component of the server's socket argument, so we match the
 * cmdline ending in `/<sessionName>`.
 */
export function findServerPid(sessionName: string): number | null {
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,args='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      env: zellijEnv(),
    });
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const argv = m[2]!;
      if (/zellij\b.*--server\b/.test(argv) && new RegExp(`/${escapeRe(sessionName)}$`).test(argv.trim())) {
        return Number(m[1]);
      }
    }
  } catch { /* ps unavailable */ }
  return null;
}

/**
 * Best-effort CLI pid for the managed pane. With the SHELL_WRAPPER_SCRIPT's
 * `exec /usr/bin/env "$@"`, the CLI replaces the shell and becomes a direct
 * child of the zellij server, so the server's lone non-zellij child is the CLI.
 */
export function findPaneCliPid(sessionName: string, _binBasename: string): number | null {
  const server = findServerPid(sessionName);
  if (!server) return null;
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      env: zellijEnv(),
    });
    const children: number[] = [];
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const [pid, ppid, comm] = [Number(m[1]), Number(m[2]), m[3]!];
      if (ppid === server && comm !== 'zellij') children.push(pid);
    }
    // Single CLI pane → exactly one such child.
    return children.length > 0 ? children[0]! : null;
  } catch {
    return null;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
