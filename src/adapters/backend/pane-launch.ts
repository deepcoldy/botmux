/**
 * Private launch file for shell-wrapped tmux panes.
 *
 * tmux sends a whole command to its server as ONE imsg (client.c): the argv
 * after tmux's own global flags (`-L` / `-S`) is packed NUL-terminated behind a
 * 4-byte argc, and the imsg (16-byte header included) may not exceed
 * MAX_IMSGSIZE = 16384. So Σ(strlen(argv[i]) + 1) ≤ 16364. Measured on tmux
 * 3.3a (same code in 3.5a and master): 16364 starts the session, 16365–16380
 * fail with "failed to send command", ≥ 16381 with "command too long".
 *
 * The CLI launch used to travel inline in that command:
 *   <shell> <flags> -c <wrapper> _ <cwd> -u K… K=V… <bin> <args…>
 * A Grok `--rules` system prompt plus first turn (~10 KB, mostly CJK), the
 * session env overlay's `-u` removals and a long PATH crossed the cap
 * (2026-10-24), and the error echoed the whole command into the chat.
 *
 * Now everything variable — the wrapper (cd, unset, PATH, `exec /usr/bin/env`),
 * every env(1) operand and the CLI argv — is written to a 0600 file in a 0700
 * per-session directory under SESSION_DATA_DIR, and the pane only sources it:
 *   <shell> <flags> -c '. "$1"' _ <file>        (fish: -c 'source $argv[1]' <file>)
 * The file restores the exact positional parameters (`set --`, fish `set argv`)
 * and then runs the unchanged wrapper in the same shell, after the same rcfile,
 * so the CLI gets byte-identical argv, environment and cwd. Its first command
 * deletes it: the per-bot env values it carries live on disk only until the
 * pane shell has read them (they used to sit in tmux's #{pane_start_command}).
 * ~/.botmux is deny-by-default inside the file sandbox, so a sandboxed CLI can
 * neither read nor plant a launch file.
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Type-only: session-store imports this module for its close-time cleanup, and
// many tests mock tmux-backend.js down to a few names.
import type { ShellKind } from './tmux-backend.js';

/** Largest packed command (argv after tmux's global flags) tmux will send. */
export const TMUX_COMMAND_MAX_BYTES = 16_364;

/** Bytes tmux packs for `argv` (everything after its own `-L` / `-S`). */
export function tmuxCommandBytes(argv: readonly string[]): number {
  let total = 0;
  for (const arg of argv) total += Buffer.byteLength(arg, 'utf8') + 1;
  return total;
}

export class TmuxCommandTooLongError extends Error {
  constructor(readonly bytes: number, tmuxSaid?: string) {
    super(`启动命令过长，被 tmux 拒绝（${tmuxSaid ? `tmux：${tmuxSaid}，` : ''}本次 ${bytes} 字节，tmux 单条命令上限 ${TMUX_COMMAND_MAX_BYTES} 字节）`);
    this.name = 'TmuxCommandTooLongError';
  }
}

/** Refuse a command tmux would reject, before tmux echoes it anywhere. */
export function assertTmuxCommandFits(argv: readonly string[]): void {
  const bytes = tmuxCommandBytes(argv);
  if (bytes > TMUX_COMMAND_MAX_BYTES) throw new TmuxCommandTooLongError(bytes);
}

const PANE_LAUNCH_DIR_NAME = 'pane-launch';
const LAUNCH_FILE_PATTERN = /^launch-[0-9a-f]{16}\.sh$/;
/** The pane shell reads its file right after its rcfile, normally within
 *  seconds. Older siblings belong to a generation whose shell never got there. */
const STALE_LAUNCH_FILE_MS = 60_000;

function safeSessionStem(sessionId: string): string {
  const stem = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return /^\.*$/.test(stem) ? '_' : stem;
}

/** Per-session directory for launch files (pass as SpawnOpts.paneLaunchDir). */
export function paneLaunchDir(dataDir: string, sessionId: string): string {
  return join(dataDir, PANE_LAUNCH_DIR_NAME, safeSessionStem(sessionId));
}

/** Session close: drop whatever a launch left behind. Best-effort. */
export function removePaneLaunchDir(dataDir: string, sessionId: string): void {
  try { rmSync(paneLaunchDir(dataDir, sessionId), { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** The shell script that used to be the pane's `-c` argument, plus the
 *  positional parameters it used to receive after `_` (fish: as $argv). */
export interface PaneLaunchScript {
  kind: ShellKind;
  script: string;
  argv: readonly string[];
}

/** The pane's `-c` script now: read the launch file named by its argument.
 *  POSIX shells get it as $1 after the `_` placeholder, fish as $argv[1]. */
export function paneLaunchLoader(kind: ShellKind): string {
  return kind === 'fish' ? 'source $argv[1]' : '. "$1"';
}

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function fishSingleQuote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** File body: remove itself (and `ownDir`, a private temp dir made just for
 *  it), restore the positional parameters, run the script. */
export function renderPaneLaunchFile(launch: PaneLaunchScript, selfPath: string, ownDir?: string): string {
  const fish = launch.kind === 'fish';
  const quote = fish ? fishSingleQuote : shSingleQuote;
  // `command` skips an rcfile alias such as rm='rm -i' (same syntax in fish).
  const removeSelf = `command rm -f -- ${quote(selfPath)}`
    + (ownDir ? `; command rmdir -- ${quote(ownDir)} 2>/dev/null` : '');
  return [
    removeSelf,
    [fish ? 'set argv' : 'set --', ...launch.argv.map(quote)].join(' '),
    launch.script,
    '',
  ].join('\n');
}

export interface PaneLaunchFile {
  readonly path: string;
  readonly bytes: number;
  readonly argc: number;
  /** Remove the file if the pane never read it (and a fallback dir made for it). */
  discard(): void;
  /** Once a fresh session exists, older unread files of this session are dead. */
  sweepStaleSiblings(now?: number): void;
}

/**
 * Write the launch file. `dir` is the per-session directory from
 * {@link paneLaunchDir}; callers without one (tests, standalone backend use)
 * get a private mkdtemp directory, which the file removes along with itself
 * (or discard() does, if no shell ever reads it).
 */
export function writePaneLaunchFile(dir: string | undefined, launch: PaneLaunchScript): PaneLaunchFile {
  // execve would refuse these; the shell would silently truncate at the NUL.
  if (launch.argv.some(arg => arg.includes('\0'))) throw new Error('启动参数含有 NUL 字节，无法启动 CLI');
  const ownDir = dir === undefined;
  const target = dir ?? mkdtempSync(join(tmpdir(), 'botmux-pane-launch-'));
  if (!ownDir) mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  const path = join(target, `launch-${randomBytes(8).toString('hex')}.sh`);
  const body = renderPaneLaunchFile(launch, path, ownDir ? target : undefined);
  try {
    writeFileSync(path, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (ownDir) { try { rmdirSync(target); } catch { /* not empty / gone */ } }
    throw err;
  }
  return {
    path,
    bytes: Buffer.byteLength(body, 'utf8'),
    argc: launch.argv.length,
    discard() {
      try { rmSync(path, { force: true }); } catch { /* best-effort */ }
      if (ownDir) { try { rmdirSync(target); } catch { /* not empty / gone */ } }
    },
    sweepStaleSiblings(now = Date.now()) {
      if (ownDir) return;
      let names: string[];
      try { names = readdirSync(target); } catch { return; }
      for (const name of names) {
        const sibling = join(target, name);
        if (sibling === path || !LAUNCH_FILE_PATTERN.test(name)) continue;
        try {
          const st = lstatSync(sibling);
          if (st.isFile() && now - st.mtimeMs > STALE_LAUNCH_FILE_MS) rmSync(sibling, { force: true });
        } catch { /* raced with its own shell */ }
      }
    },
  };
}
