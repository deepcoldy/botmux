import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COMPANION_BOT_APP_ID_ENV,
  COMPANION_SECRET_FILE_ENV,
  resolveCompanionStartupConfig,
} from '../src/config.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('companion startup secret-file configuration', () => {
  it('uses only the dedicated path environment variable and never reads a secret', () => {
    const env = {
      [COMPANION_SECRET_FILE_ENV]: ' /run/secrets/botmux/companion ',
      [COMPANION_BOT_APP_ID_ENV]: ' local_test_bot ',
      BOTMUX_DASHBOARD_SECRET_FILE: '/run/secrets/botmux/dashboard',
    };

    expect(resolveCompanionStartupConfig(env)).toEqual({
      secretFile: '/run/secrets/botmux/companion',
      botAppId: 'local_test_bot',
    });
  });

  it('ignores a foreign secret-file var when the dedicated one is unset', () => {
    expect(resolveCompanionStartupConfig({
      BOTMUX_DASHBOARD_SECRET_FILE: '/run/secrets/botmux/dashboard',
    })).toEqual({ secretFile: undefined, botAppId: undefined });
  });

  it('has no fallback when the dedicated path is absent or blank', () => {
    expect(resolveCompanionStartupConfig({})).toEqual({ secretFile: undefined, botAppId: undefined });
    expect(resolveCompanionStartupConfig({ [COMPANION_SECRET_FILE_ENV]: ' \t\n' }))
      .toEqual({ secretFile: undefined, botAppId: undefined });
  });

  it('captures the dedicated path in the daemon startup config after dotenv loading', async () => {
    vi.stubEnv(COMPANION_SECRET_FILE_ENV, '/run/secrets/botmux/companion');
    vi.stubEnv(COMPANION_BOT_APP_ID_ENV, 'local_test_bot');
    vi.resetModules();

    const { config } = await import('../src/config.js');
    expect(config.companion).toEqual({ secretFile: '/run/secrets/botmux/companion', botAppId: 'local_test_bot' });
  });
});
