/**
 * collectNativePrint: how a native print process that stops reading stdin is
 * classified (#2325). Every process is spawned through the function itself,
 * which owns and reaps its process group.
 */
import { describe, expect, it } from 'vitest';
import { collectNativePrint } from '../src/services/constrained-invocation/print-process.js';

const supported = ['linux', 'darwin'].includes(process.platform);
// Larger than any pipe buffer: the write cannot finish before the reader closes.
const bigInput = 'x'.repeat(1 << 20);

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

  it('returns the output of a process that reads all of its input', async () => {
    await expect(run('/bin/cat', [], 'hello\n')).resolves.toBe('hello\n');
  });
});
