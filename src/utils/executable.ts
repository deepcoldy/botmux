import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const WINDOWS_EXEC_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com'];

/** Candidate file paths for a bare command on Windows: PATHEXT list plus the
 *  extensionless form (a real .exe without extension is unusual but valid). */
function windowsCandidates(dir: string, cmd: string, pathext: string[]): string[] {
  const withExt = pathext.length > 0
    ? pathext.map(p => join(dir, `${cmd}${p}`))
    : WINDOWS_EXEC_EXTENSIONS.map(p => join(dir, `${cmd}${p}`));
  return [join(dir, cmd), ...withExt];
}

/**
 * Locate an executable the way `execvp` will at spawn time: an absolute path is
 * checked directly, a bare name is searched across the current process's PATH.
 * On Windows, PATHEXT extensions (.exe/.cmd/.bat/.com) are appended so a
 * bare `claude` resolves to `claude.cmd` from an npm global install.
 * Returns the resolved absolute path, or null when nothing runnable is found.
 *
 * `platform` is injectable for tests (defaults to the real platform).
 */
export function locateExecutable(
  cmd: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!cmd) return null;
  if (isAbsolute(cmd)) return isExecutable(cmd) ? cmd : null;
  const isWindows = platform === 'win32';
  const pathext = isWindows
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(s => s.trim()).filter(Boolean)
    : [];
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidates = isWindows
      ? windowsCandidates(dir, cmd, pathext)
      : [join(dir, cmd)];
    for (const candidate of candidates) {
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}
