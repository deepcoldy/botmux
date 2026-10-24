import { readFileSync, rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';

/**
 * A managed tmux pane runs `<shell> … -c <loader> [_] <launch file>`, and the
 * launch argv lives in that file (src/adapters/backend/pane-launch.ts). For
 * tests whose tmux is mocked (so no shell ever reads and deletes the file):
 * return the file and remove it together with the private temp directory the
 * backend made when the test passed no paneLaunchDir.
 */
export function takePaneLaunchFile(newSessionArgv: readonly string[]): { path: string; body: string } {
  const path = newSessionArgv[newSessionArgv.length - 1]!;
  const body = readFileSync(path, 'utf8');
  const dir = dirname(path);
  if (basename(dir).startsWith('botmux-pane-launch-')) rmSync(dir, { recursive: true, force: true });
  else rmSync(path, { force: true });
  return { path, body };
}
