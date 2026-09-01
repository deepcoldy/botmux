import { describe, expect, it, vi } from 'bun:test';
import { reloadExactDaemonBotConfig } from '../src/core/daemon-config-fence.js';

describe('explicit daemon final raw-index fence', () => {
  it('always reloads the raw slot after profile bootstrap', () => {
    const latest = {
      larkAppId: 'cli_exact',
      larkAppSecret: 'latest-secret',
      cliId: 'traex' as const,
    };
    const loadAtIndex = vi.fn(() => latest);

    expect(reloadExactDaemonBotConfig(4, 'cli_exact', loadAtIndex)).toBe(latest);
    expect(loadAtIndex).toHaveBeenCalledExactlyOnceWith(4);
  });

  it('rejects an App replacement instead of registering stale config', () => {
    expect(() => reloadExactDaemonBotConfig(4, 'cli_original', () => ({
      larkAppId: 'cli_replaced',
      larkAppSecret: 'other-secret',
      cliId: 'traex',
    }))).toThrow('BOTMUX_BOT_INDEX=4 target drifted during profile bootstrap');
  });

  it('propagates a pending or missing raw slot as a fatal final reload error', () => {
    expect(() => reloadExactDaemonBotConfig(4, 'cli_original', () => {
      throw new Error('Bot config [4] activation pending');
    })).toThrow('activation pending');
  });
});
