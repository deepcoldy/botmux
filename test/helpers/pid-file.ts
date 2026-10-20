import { readFileSync } from 'node:fs';

/** Shell redirection creates the file before echo writes the PID and newline. */
export function readPidFile(path: string): number | undefined {
  let value: string;
  try { value = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  // Require the terminating newline so even a partially written PID is not ready.
  if (!/^[1-9][0-9]*\n$/.test(value)) return undefined;
  const pid = Number(value.trim());
  // Never let fixture cleanup signal a process group (0/negative) or init (1).
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

export async function waitForPidFile(path: string, timeoutMs = 8_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  do {
    const pid = readPidFile(path);
    if (pid !== undefined) return pid;
    if (Date.now() >= deadline) break;
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  } while (true);
  throw new Error(`Timed out waiting for a complete positive PID in ${path}`);
}

/** Best-effort fixture cleanup that can never signal init or a process group. */
export function killFixturePid(pid: number, signal: NodeJS.Signals = 'SIGKILL'): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { return process.kill(pid, signal); }
  catch { return false; }
}
