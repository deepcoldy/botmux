import { describe, expect, it } from 'vitest';
import { runNativePtySmoke } from '../src/cli/pty-smoke.js';

describe.skipIf(process.platform === 'win32')('native PTY release smoke', () => {
  it('executes a child without the node-pty ReadStream wrapper', async () => {
    const result = await runNativePtySmoke({ timeoutMs: 10_000 });
    expect(result.pid).toBeGreaterThan(0);
    expect(result.helperPath).toContain('spawn-helper');
  });

  it('fails closed when the requested child cannot execute', async () => {
    await expect(runNativePtySmoke({
      file: '/definitely-missing-botmux-pty-smoke',
      timeoutMs: 10_000,
    })).rejects.toThrow(/native PTY child failed|posix_spawnp failed/);
  });
});
