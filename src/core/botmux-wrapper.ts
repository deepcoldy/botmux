/**
 * Helpers for the `~/.botmux/bin` wrapper that lets CLI sessions call
 * `botmux send` / `botmux schedule` without a global npm install.
 *
 * Split out from worker-pool / attempt-resume / daemon so the
 * platform-sensitive bits (PATH delimiter, Windows `.cmd` wrapper) live in one
 * pure, unit-tested place instead of being duplicated as inline string concat.
 */
import { delimiter } from 'node:path';

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
 */
export function botmuxWrapperFiles(
  cliScript: string,
  nodePath: string,
  platform: NodeJS.Platform = process.platform,
): BotmuxWrapperFile[] {
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
