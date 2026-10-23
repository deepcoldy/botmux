import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

async function runLongEntry(enabled: boolean, executable?: string) {
  const env = { ...process.env };
  delete env.BOTMUX_MCODE_E2E_BIN;
  delete env.BOTMUX_MCODE_LONG_E2E;
  if (enabled) env.BOTMUX_MCODE_LONG_E2E = '1';
  if (executable !== undefined) env.BOTMUX_MCODE_E2E_BIN = executable;
  // Launch the runtime's real test CLI, not the test module outside a runner.
  const args = process.versions.bun
    ? ['test', './test/minimax-exec-long.e2e.ts', '--timeout=750000']
    : [resolve('node_modules/vitest/vitest.mjs'), 'run', '--project', 'e2e', 'test/minimax-exec-long.e2e.ts'];
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data.toString(); });
  child.stderr.on('data', data => { output += data.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    const code = await new Promise<number | null>((resolveCode, reject) => {
      child.once('error', reject);
      child.once('close', resolveCode);
    });
    return { code, output };
  } finally { clearTimeout(timer); }
}

describe('native long-test admission', () => {
  it('keeps the optional test runnable without native dependencies when not enabled', async () => {
    expect((await runLongEntry(false)).code).toBe(0);
  });

  it.each([undefined, '/nonexistent/botmux-fixture-mcode'])('fails a requested check with unavailable executable %s', async executable => {
    const result = await runLongEntry(true, executable);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain(executable ? 'native_inference_failed' : 'BOTMUX_MCODE_E2E_BIN');
  });
});
