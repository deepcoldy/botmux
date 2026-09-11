import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runNativePtySmoke } from '../src/cli/pty-smoke.js';

const sourceHelperPath = process.platform === 'darwin'
  ? resolve(
      dirname(createRequire(import.meta.url).resolve('node-pty/lib/utils.js')),
      '..',
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper',
    )
  : undefined;

describe.skipIf(process.platform === 'win32')('native PTY release smoke', () => {
  it('executes a child without the node-pty ReadStream wrapper', async () => {
    const result = await runNativePtySmoke({
      helperPath: sourceHelperPath,
      timeoutMs: 10_000,
    });
    expect(result.pid).toBeGreaterThan(0);
    expect(result.helperPath).toContain('spawn-helper');
  });

  it('fails closed when the requested child cannot execute', async () => {
    await expect(runNativePtySmoke({
      file: '/definitely-missing-botmux-pty-smoke',
      helperPath: sourceHelperPath,
      timeoutMs: 10_000,
    })).rejects.toThrow(/native PTY child failed|posix_spawnp failed/);
  });
});
