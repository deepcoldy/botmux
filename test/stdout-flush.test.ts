import { describe, expect, it } from 'vitest';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

/**
 * Child-process regression for `writeAndFlush`: a payload far beyond the pipe
 * buffer (64 KiB) and the ~146 KiB observed partial-flush ceiling must reach the
 * parent intact even though the child calls process.exit() right after.
 */
function runChild(bytes: number): Promise<{ code: number | null; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawnTsEvalWithRepoImports(`
      import { writeAndFlush } from './src/cli/stdout-flush.js';
      const payload = 'x'.repeat(${bytes});
      await writeAndFlush(process.stdout, payload);
      process.exit(0);
    `, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] });
    const chunks: Buffer[] = [];
    // Drain slowly so the child really hits backpressure before exiting.
    child.stdout!.pause();
    setTimeout(() => child.stdout!.resume(), 300);
    child.stdout!.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: Buffer.concat(chunks) }));
  });
}

describe('writeAndFlush over a real pipe', () => {
  it('delivers a 2 MiB payload completely before an explicit exit', async () => {
    const size = 2 * 1024 * 1024;
    const { code, stdout } = await runChild(size);
    expect(code).toBe(0);
    expect(stdout.length).toBe(size);
  }, 30_000);
});
