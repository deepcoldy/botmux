/**
 * Make every write of a WeCom bridge state file fail, through the real file
 * system: the bridge writes state.json atomically (a unique temp file renamed
 * over it), and renaming a file over a directory fails on Linux and macOS
 * alike, for root too. No test-only switch in production code.
 *
 * The current state.json (if any) is moved aside and a non-empty directory
 * takes its place; the returned function removes the directory and moves the
 * file back. While blocked, nothing can read the state file either: construct
 * a new bridge only after unblocking.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function blockWecomStateWrites(stateFile: string): () => void {
  const backup = `${stateFile}.blocked-by-test`;
  const moved = existsSync(stateFile);
  if (moved) {
    renameSync(stateFile, backup);
  }
  mkdirSync(stateFile);
  writeFileSync(join(stateFile, 'blocked'), '');
  return () => {
    rmSync(stateFile, { recursive: true, force: true });
    if (moved) {
      renameSync(backup, stateFile);
    }
  };
}
