import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Prepare adapter-declared single writable files (CliAdapter.sandboxWritableFiles)
 * for a read-write bind into the oncall file sandbox.
 *
 * bwrap cannot bind a missing source, and the generic authPaths pre-create
 * would mkdir a DIRECTORY in a file's place, so a missing entry is created here
 * as an EMPTY regular file (append flag: never truncates a file that appears
 * concurrently). Only paths that are regular files afterwards are returned:
 * a directory, symlink or other special file at the path is left untouched and
 * NOT bound, so a host-side link can never redirect the read-write grant.
 * Failures are per-path and silent — the CLI then sees what it would have seen
 * without this grant.
 */
export function prepareSandboxWritableFiles(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of new Set(paths)) {
    if (!path || !path.startsWith('/')) continue;
    try {
      let missing = false;
      try { lstatSync(path); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') continue;
        missing = true;
      }
      if (missing) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, '', { flag: 'a', mode: 0o644 });
      }
      if (lstatSync(path).isFile()) out.push(path);
    } catch { /* best effort: leave this path unbound */ }
  }
  return out;
}
