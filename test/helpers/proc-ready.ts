/**
 * Wait until a freshly spawned pid is identifiable via cmdline.
 *
 * Spawn returning a pid is not enough. Under load (CI `bun-test` in particular)
 * `/proc/<pid>/cmdline` can still be empty for a few milliseconds after fork,
 * before exec fills it. Production identity guards treat that empty string as
 * "cannot identify" and fail-closed — measured in `legacy-pm2-reaper.test.ts`
 * as `deleted=[]` for a sleeper that was in fact the tagged daemon.
 *
 * That fail-closed is correct in production (a long-running pm2 daemon has a
 * populated cmdline; empty means zombie or pid reuse). Tests that spawn a
 * fixture and immediately feed its pid to those guards must wait here first,
 * otherwise the same race flakes the file red.
 *
 * Linux reads `/proc` (same interface the reaper uses, including musl).
 * Elsewhere falls back to `ps -p -o command=`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Block for `ms` without an async boundary. */
export function spinMs(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB */ }
}

/** Pid's argv as one string, or '' when unreadable / not yet exec'd / zombie. */
export function readPidCmdline(pid: number): string {
  if (process.platform === 'linux') {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
      return raw.replace(/\0+$/, '').split('\0').join(' ').trim();
    } catch {
      return '';
    }
  }
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' });
  return (ps.stdout || '').trim();
}

/**
 * Block until `needle` appears in pid's cmdline. Throws on timeout so the
 * race surfaces as a fixture error instead of a silent `deleted=[]`.
 */
export function waitForPidCmdline(pid: number, needle: string, timeoutMs = 2_000): string {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cmd = readPidCmdline(pid);
    if (cmd.includes(needle)) {
      try { process.kill(pid, 0); } catch {
        throw new Error(`pid ${pid} exited before cmdline contained ${JSON.stringify(needle)}`);
      }
      return cmd;
    }
    spinMs(20);
  }
  throw new Error(`pid ${pid} cmdline never contained ${JSON.stringify(needle)}`);
}

/**
 * Block until a pidfile exists AND holds a complete, valid positive pid.
 *
 * Path existence is not readiness. A writer's open(O_CREAT|O_TRUNC) makes the
 * file visible before its write lands the digits; a reader polling in another
 * process can catch that window under CI load and read '' (the file exists but
 * is momentarily empty), so `parseInt` yields NaN. Wait on the COMPLETE CONTENT
 * (all digits, positive), not on `existsSync` — the read-side of the same
 * create-then-write race the session-env JSON poll handles.
 *
 * Guarantees only "a complete positive integer is currently on disk", NOT that
 * it is the writer's final value: a process that legitimately rewrites the same
 * pidfile (e.g. `4` then `4242`) returns on the first complete pid. Callers
 * needing the settled value must read after the writer quiesces.
 */
export function readPidFileWhenReady(pidFilePath: string, timeoutMs = 2_000): number {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const raw = readFileSync(pidFilePath, 'utf-8').trim();
      if (/^\d+$/.test(raw)) {
        const pid = Number.parseInt(raw, 10);
        if (pid > 0) return pid;
      }
      last = raw;
    } catch {
      // Not created yet, or replaced mid-read; poll again.
    }
    spinMs(20);
  }
  throw new Error(`pidfile ${pidFilePath} never held a valid pid (last content was ${JSON.stringify(last)})`);
}
