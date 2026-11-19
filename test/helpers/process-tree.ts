/**
 * Kill a spawned child together with everything still running below it.
 *
 * SIGKILL takes down only the process it is sent to. A worker killed in the
 * middle of a synchronous `tmux …` call leaves that client running — and when
 * the test then deletes the worker's private TMUX_TMPDIR, a client that has not
 * resolved its socket yet falls back to /tmp, i.e. the HOST's tmux servers
 * (the tmux fence refuses it and fails the file: #2214). So the whole tree goes
 * down before the caller removes anything that tree uses.
 *
 * The child is stopped first, so it cannot fork while its tree is read; every
 * descendant found is stopped too, until a read finds nothing new. Only then
 * does SIGKILL go to all of them. A daemon that already left the tree (a tmux
 * server double-forks away from the client that started it) is not touched, so
 * a test can kill a worker and keep the pane it created.
 */
import { spawnSync, type ChildProcess } from 'node:child_process';
import { PROCESS_TABLE_MAX_BUFFER } from '../../src/utils/exec-limits.js';

function childrenByParent(): Map<number, number[]> {
  const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', maxBuffer: PROCESS_TABLE_MAX_BUFFER });
  // A failed or truncated listing would silently drop descendants and turn the
  // tree kill back into killing the root alone — fail loudly instead.
  if (out.error || out.status !== 0) {
    throw new Error(`ps failed: ${out.error?.message ?? `exit ${out.status}`} ${out.stderr ?? ''}`.trim());
  }
  const byParent = new Map<number, number[]>();
  for (const line of (out.stdout ?? '').split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !ppid) continue;
    const list = byParent.get(ppid);
    if (list) list.push(pid);
    else byParent.set(ppid, [pid]);
  }
  return byParent;
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(pid, sig); } catch { /* already gone */ }
}

/** Every process below `root` that is in the tree now. */
function descendantPids(root: number): number[] {
  const byParent = childrenByParent();
  const found: number[] = [];
  const queue = [...(byParent.get(root) ?? [])];
  while (queue.length) {
    const pid = queue.shift()!;
    found.push(pid);
    queue.push(...(byParent.get(pid) ?? []));
  }
  return found;
}

/** Stop `child` and its descendants, SIGKILL all of them, and wait (bounded)
 *  for `child` to exit. No-op for a child that has already exited.
 *  Never rejects: it runs in finally blocks and cleanups, where an error of its
 *  own would replace the test's real failure and skip the cleanup after it. A
 *  process table it cannot read is reported as a warning, and `child` is still
 *  killed. */
export async function killProcessTree(child: ChildProcess, waitMs = 2_000): Promise<void> {
  const root = child.pid;
  if (!root || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(done => child.once('exit', () => done()));
  const tree = new Set<number>([root]);
  signal(root, 'SIGSTOP');
  try {
    for (;;) {
      const fresh = descendantPids(root).filter(pid => !tree.has(pid));
      if (fresh.length === 0) break;
      for (const pid of fresh) {
        tree.add(pid);
        signal(pid, 'SIGSTOP');
      }
    }
  } catch (error) {
    process.emitWarning(`killProcessTree: process table unreadable, killing only what was found (pid ${[...tree].join(', ')}): ${(error as Error).message}`);
  }
  // Whatever was found — the root at least — never stays stopped.
  for (const pid of tree) signal(pid, 'SIGKILL');
  await Promise.race([exited, new Promise(done => setTimeout(done, waitMs))]);
}
