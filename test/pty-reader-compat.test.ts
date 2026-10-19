import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { resolveBunExecutable, spawnSyncBunTsEvalWithRepoImports, spawnNodeTsScript } from './helpers/ts-runner.js';

async function probe(runtime: 'node' | 'bun', mode: string) {
  const env = { ...process.env, BOTMUX_TEST_PTY_PROBE_MODE: mode };
  if (runtime === 'bun') {
    const result = spawnSyncBunTsEvalWithRepoImports("await import('./test/fixtures/pty-reader-probe.ts')", {
      cwd: process.cwd(), env, encoding: 'utf8', timeout: 8000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, String(result.stderr)).toBe(0);
    return JSON.parse(String(result.stdout).trim());
  }
  const child = spawnNodeTsScript(resolve('test/fixtures/pty-reader-probe.ts'), [], { env, stdio: 'pipe' });
  let output = ''; let error = '';
  child.stdout!.on('data', data => { output += data; });
  child.stderr!.on('data', data => { error += data; });
  const code = await new Promise<number | null>((resolveExit, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Node PTY probe timed out')); }, 8000);
    child.on('error', reject);
    child.once('close', code => { clearTimeout(timer); resolveExit(code); });
  });
  expect(code, error).toBe(0);
  return JSON.parse(output.trim());
}

describe.skipIf(process.platform === 'win32')('PTY nonblocking reader compatibility', () => {
  for (const runtime of ['node', 'bun'] as const) {
    describe.skipIf(runtime === 'bun' && !resolveBunExecutable())(runtime, () => {
      it('survives idle gaps and decodes UTF-8 split across separate writes', async () => {
        const result = await probe(runtime, 'gap');
        expect(result.output).toBe('first你好last');
        expect(result.elapsedMs).toBeGreaterThanOrEqual(350);
        expect(result.exit).toEqual({ exitCode: 0, signal: 0 });
      });
      it('preserves interactive input and terminal resizing', async () => {
        const result = await probe(runtime, 'input');
        expect(result.output).toContain('31 99');
        expect(result.output).toContain('reply:hello');
        expect(result.exit).toEqual({ exitCode: 0, signal: 0 });
      });
      it('keeps an idle child alive until explicitly cancelled and reports its signal', async () => {
        const result = await probe(runtime, 'cancel');
        expect(result.liveBeforeKill).toBe(true);
        expect(result.output).toBe('READY');
        expect(result.exit.signal).toBe(15);
      });
      it('nudgeRead keeps keystroke echo off the 20ms idle retry', async () => {
        // Each round trip starts after an idle gap, so without a nudge the Bun
        // reader is parked in its 20ms retry and roughly every other echo pays
        // it. With the nudge the echo is picked up by the fast-poll window.
        const result = await probe(runtime, 'echo-nudge');
        expect(result.output).toContain('r:11;');
        const slow = (result.echoLatencies as number[]).filter(ms => ms >= 15);
        expect(slow.length, JSON.stringify(result.echoLatencies)).toBeLessThanOrEqual(2);
      });
      it('preserves buffered output across pause/resume and large bursts', async () => {
        const result = await probe(runtime, 'pause');
        expect(result.output).toBe('first' + 'A'.repeat(262144) + 'last');
        expect(result.exit).toEqual({ exitCode: 0, signal: 0 });
      });
    });
  }
});
