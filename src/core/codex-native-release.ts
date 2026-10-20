import { execFileSync } from 'node:child_process';
import { readProcessStartIdentity } from '../utils/process-identity.js';
import { pidNotProvablyGone } from '../utils/process-alive.js';
import { PROCESS_TABLE_MAX_BUFFER } from '../utils/exec-limits.js';

/** Capture before teardown, while descendants are still attributable to owned
 * roots. Never infer that an unreadable/missing process tree is empty. */
export function captureCodexNativeProcesses(roots: readonly number[]): Array<{ pid: number; started: string }> {
  if (!roots.length || roots.some(pid => !Number.isSafeInteger(pid) || pid <= 1)) throw new Error('native roots unavailable');
  const text = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], {
    encoding: 'utf8', timeout: 1_000, maxBuffer: PROCESS_TABLE_MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const rows = text.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  if (roots.some(pid => !rows.some(row => row[0] === pid))) throw new Error('native root identity unavailable');
  const included = new Set(roots);
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, parent] of rows) if (included.has(parent!) && !included.has(pid!)) { included.add(pid!); changed = true; }
  }
  if (included.size > 64) throw new Error('native process tree exceeds bounded proof');
  return [...included].map(pid => {
    const started = readProcessStartIdentity(pid);
    if (!started) throw new Error('native process identity unavailable');
    return { pid, started };
  });
}

export async function waitForCodexNativeRelease(processes: readonly { pid: number; started: string }[], timeoutMs = 3_500): Promise<boolean> {
  if (!processes.length) return false;
  const deadline = Date.now() + timeoutMs;
  do {
    const gone = processes.every(({ pid, started }) => {
      const now = readProcessStartIdentity(pid);
      return now ? now !== started : !pidNotProvablyGone(pid);
    });
    if (gone) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return false;
}
