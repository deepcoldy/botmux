import { describe, expect, it } from 'vitest';

describe('terminal host refresh loop', () => {
  it('is not exposed as a daemon timer from worker-pool', async () => {
    const mod = await import('../src/core/worker-pool.js') as Record<string, unknown>;

    expect(mod).not.toHaveProperty('refreshTerminalHostCards');
    expect(mod).not.toHaveProperty('startTerminalHostRefreshLoop');
    expect(mod).not.toHaveProperty('__testOnly_resetTerminalHostRefresh');
  });
});
