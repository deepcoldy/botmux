/**
 * Helpers for the `~/.botmux/bin` wrapper that lets CLI sessions call
 * `botmux send` / `botmux schedule` without a global npm install.
 *
 * Split out from worker-pool / attempt-resume / daemon so the
 * platform-sensitive bits (PATH delimiter, Windows `.cmd` wrapper) live in one
 * pure, unit-tested place instead of being duplicated as inline string concat.
 */
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * SINGLE SOURCE OF TRUTH for the `botmux` wrapper bin dir (codex P1). The daemon
 * WRITES the wrapper here and every consumer (worker-pool fork PATH, worker.ts
 * child-env prepends, tmux pane scripts) must PREPEND the SAME dir — otherwise a
 * core-only service that writes its wrapper to a dedicated dir but leaves the
 * consumers pointing at the shared `~/.botmux/bin` would resolve `botmux` to a
 * same-HOME fleet's wrapper (shared:dedicated:… PATH → shared wins).
 *
 *  - core-only (BOTMUX_CORE_ONLY=1): a DEDICATED `<SESSION_DATA_DIR>/bin`, so a
 *    same-HOME fleet's `~/.botmux/bin` is never consulted or clobbered.
 *  - normal fleet: the shared `~/.botmux/bin` (unchanged).
 *
 * Env-driven (not config) so it resolves identically in the daemon, a forked
 * worker, and a value baked into a tmux pane script — all of which see the same
 * BOTMUX_CORE_ONLY / SESSION_DATA_DIR. Falls back to ~/.botmux/bin if a core-only
 * process somehow lacks SESSION_DATA_DIR (defensive; the entrypoint always sets it).
 */
export function resolveBotmuxWrapperBinDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BOTMUX_CORE_ONLY === '1' && env.SESSION_DATA_DIR) {
    return join(env.SESSION_DATA_DIR, 'bin');
  }
  return join(env.HOME ?? env.USERPROFILE ?? homedir(), '.botmux', 'bin');
}

/**
 * Prepend the wrapper bin dir to a PATH string using the platform-correct
 * separator (':' on POSIX, ';' on Windows). Hardcoding ':' silently breaks the
 * inherited PATH on Windows, so route every PATH prepend through here.
 */
export function prependBotmuxBin(
  binDir: string,
  currentPath: string | undefined,
  delim: string = delimiter,
): string {
  return `${binDir}${delim}${currentPath ?? ''}`;
}

export interface BotmuxWrapperFile {
  /** Filename within ~/.botmux/bin. */
  name: string;
  content: string;
  /** chmod mode (ignored on Windows). */
  mode: number;
}

/**
 * The wrapper files to materialize in ~/.botmux/bin. Always a POSIX `sh`
 * wrapper (used by macOS/Linux and Git Bash/WSL); on Windows additionally a
 * `botmux.cmd` so native shells (cmd.exe / PowerShell) resolve `botmux` —
 * without it `botmux send` from a Windows-native CLI session fails. The `.cmd`
 * pins the daemon's current Node binary so it never depends on a PATH-resolved
 * `node`. Both wrappers point at THIS daemon's dist/cli.js.
 *
 * ⚠️ COMPILED-BINARY MODE (`standalone: true`) — do not collapse these branches.
 * Under a `bun build --compile` executable there is no `cli.js` on disk: the
 * module graph lives in the virtual, process-private `/$bunfs/` root, so
 * `__dirname` is `/$bunfs/root` and `cliScript` is `/$bunfs/root/cli.js`. Emitting
 * the Node form there produced a wrapper that was broken three ways over, and it
 * shipped: (1) the path does not exist outside the process; (2) it re-introduces a
 * hard `node` dependency, defeating the entire point of the self-contained binary;
 * and (3) `sh` expands the unescaped `$bunfs` inside the double quotes to the empty
 * string, so the wrapper actually resolved `//root/cli.js` — not even the literal
 * path. Worse, install.sh puts the BINARY at `~/.botmux/bin/botmux`, the very path
 * this wrapper targets, so writing it overwrote the running executable (verified:
 * a 94,582,912-byte ELF replaced by a 47-byte script, inode changed).
 *
 * The compiled form instead re-execs the binary itself, forwarding the user's
 * arguments verbatim. No hidden subcommand is involved: the compiled binary's
 * normal CLI dispatch already handles ordinary commands (`send`, `schedule`, …) —
 * the `__daemon`/`__worker`/… tokens exist only so internal spawners can reach
 * entry modules that have no `dist/*.js` on disk (see src/cli.ts's entry-token
 * block and src/core/self-spawn.ts). `exec` replaces the shell, so signals and
 * exit codes pass through unchanged.
 */
export function botmuxWrapperFiles(
  cliScript: string,
  nodePath: string,
  platform: NodeJS.Platform = process.platform,
  standalone = false,
): BotmuxWrapperFile[] {
  // Compiled binary: `exec <the binary> "$@"`. `binaryPath` is process.execPath —
  // the real on-disk executable, NOT a /$bunfs/ path.
  if (standalone) {
    const binaryPath = nodePath;
    const files: BotmuxWrapperFile[] = [
      { name: 'botmux', content: `#!/bin/sh\nexec "${binaryPath}" "$@"\n`, mode: 0o755 },
    ];
    if (platform === 'win32') {
      files.push({
        name: 'botmux.cmd',
        content: `@echo off\r\n"${binaryPath}" %*\r\n`,
        mode: 0o755,
      });
    }
    return files;
  }
  const files: BotmuxWrapperFile[] = [
    { name: 'botmux', content: `#!/bin/sh\nexec node "${cliScript}" "$@"\n`, mode: 0o755 },
  ];
  if (platform === 'win32') {
    files.push({
      name: 'botmux.cmd',
      content: `@echo off\r\n"${nodePath}" "${cliScript}" %*\r\n`,
      mode: 0o755,
    });
  }
  return files;
}
