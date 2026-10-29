import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';

/**
 * A managed tmux pane runs `<shell> … -c <loader> [_] <launch file>`, and the
 * launch argv lives in that file (src/adapters/backend/pane-launch.ts). For
 * tests whose tmux is mocked (so no shell ever reads and deletes the file):
 * return the file and remove it together with the private temp directory the
 * backend made when the test passed no paneLaunchDir.
 *
 * The launch file is not necessarily the LAST argv element: the creating
 * command also chains `\; set-option … remain-on-exit failed` so the option is
 * atomic with creation. Locate it by shape (a `launch-<hex>.sh` file that
 * exists) rather than by position or by its parent's name — tests pass their
 * own `paneLaunchDir` (often `/tmp`), so the directory name proves nothing.
 */
export function takePaneLaunchFile(newSessionArgv: readonly string[]): { path: string; body: string } {
  const path = newSessionArgv.find(
    arg => typeof arg === 'string' && /launch-[0-9a-f]+\.sh$/.test(arg) && existsSync(arg),
  ) ?? newSessionArgv[newSessionArgv.length - 1]!;
  const body = readFileSync(path, 'utf8');
  const dir = dirname(path);
  if (basename(dir).startsWith('botmux-pane-launch-')) rmSync(dir, { recursive: true, force: true });
  else rmSync(path, { force: true });
  return { path, body };
}
