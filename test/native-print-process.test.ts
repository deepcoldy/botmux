/**
 * collectNativePrint: how a native print process that stops reading stdin is
 * classified (#2325). Every process is spawned through the function itself,
 * which owns and reaps its process group.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectNativePrint } from '../src/services/constrained-invocation/print-process.js';

const supported = ['linux', 'darwin'].includes(process.platform);
// Larger than any pipe buffer: the write cannot finish before the reader closes.
const bigInput = 'x'.repeat(1 << 20);

/** Alive and not a zombie (an orphan may wait a moment for its new parent to reap it). */
function running(pid: number): boolean {
  if (existsSync('/proc/self/stat')) {
    try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z'; } catch { return false; }
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Wait until an escaped descendant is reaped. The group SIGTERM/SIGKILL has
 * already been issued by the time collectNativePrint settles, but under CPU
 * contention signal delivery and the subreaper's zombie reaping can lag by a
 * few scheduler slices, so a one-shot alive/dead assertion races the host
 * scheduler. The invariant under test is that the descendant DOES get reaped,
 * hence a bounded poll rather than an immediate read. The deadline stays well
 * inside the test's 10s wall bound; a removed cleanup guard still fails it
 * because the fixture's `sleep 30` outlives the whole deadline.
 */
async function waitForReaped(pid: number, timeoutMs = 5_000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!running(pid)) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  expect(running(pid)).toBe(false);
}

function run(executable: string, args: string[], input = bigInput): Promise<string> {
  return collectNativePrint(executable, args, { cwd: '/tmp', env: { PATH: '/usr/bin:/bin' }, input }, new AbortController().signal);
}

describe.skipIf(!supported)('collectNativePrint when stdin closes early', () => {
  it('reports a missing executable by its exit status, whatever the write timing', async () => {
    await expect(run('/nonexistent/botmux-fixture-mcode', [])).rejects.toThrow('native_inference_failed');
    await expect(run('/nonexistent/botmux-fixture-mcode', [], 'small')).rejects.toThrow('native_inference_failed');
  });

  it('reports a process that failed after closing stdin as an inference failure', async () => {
    await expect(run('/bin/sh', ['-c', 'exec 0<&-; exit 3'])).rejects.toThrow('native_inference_failed');
  });

  it('still reports undelivered input when the process exits 0 without reading it', async () => {
    await expect(run('/bin/sh', ['-c', 'exec 0<&-; exit 0'])).rejects.toThrow('native_transport_closed');
  });

  it('does not hang on a descendant that keeps stdout open after stdin closed', async () => {
    const started = Date.now();
    // The native process exits without reading; its background child would
    // hold stdout for 30s and keep the run open without a deadline.
    await expect(run('/bin/sh', ['-c', 'exec 0<&-; sleep 30 & exit 3'])).rejects.toThrow('native_inference_failed');
    await expect(run('/bin/sh', ['-c', 'exec 0<&-; sleep 30 & exit 0'])).rejects.toThrow('native_transport_closed');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('does not hang on a descendant that holds both stdin and stdout, and reaps it (#2347)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-native-print-'));
    try {
      const pidFile = join(dir, 'descendant.pid');
      // A non-interactive shell gives `&` jobs /dev/null as stdin unless fd 0 is
      // redirected explicitly, so hand the background child the pipe through fd 4.
      const script = (status: number) => `exec 4<&0; sleep 30 <&4 4<&- & echo $! > "$1"; exit ${status}`;
      const started = Date.now();
      await expect(run('/bin/sh', ['-c', script(3), 'sh', pidFile])).rejects.toThrow('native_inference_failed');
      await waitForReaped(Number(readFileSync(pidFile, 'utf8')));
      await expect(run('/bin/sh', ['-c', script(0), 'sh', pidFile])).rejects.toThrow('native_transport_closed');
      await waitForReaped(Number(readFileSync(pidFile, 'utf8')));
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(!existsSync('/usr/bin/setsid'))('bounds the drain when a descendant escaped the process group', async () => {
    const started = Date.now();
    // Out of reach of the group kill: the pipes stay open until it exits by itself.
    const escaped = 'exec 4<&0; /usr/bin/setsid sleep 8 <&4 4<&- &';
    await expect(run('/bin/sh', ['-c', `${escaped} exit 0`])).rejects.toThrow('native_transport_closed');
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 30_000);

  it('reports a failed spawn, which never emits exit', async () => {
    await expect(collectNativePrint('/bin/cat', [], {
      cwd: '/nonexistent/botmux-fixture-cwd', env: { PATH: '/usr/bin:/bin' }, input: 'small',
    }, new AbortController().signal)).rejects.toThrow('native_spawn_failed');
  });

  it('returns the output of a process that reads all of its input', async () => {
    await expect(run('/bin/cat', [], 'hello\n')).resolves.toBe('hello\n');
  });
});
