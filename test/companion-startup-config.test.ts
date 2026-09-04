import { afterEach, describe, expect, it, vi } from 'vitest';

import {
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
      BOTMUX_DASHBOARD_SECRET_FILE: '/run/secrets/botmux/dashboard',
    };

    expect(resolveCompanionStartupConfig(env)).toEqual({
      secretFile: '/run/secrets/botmux/companion',
    });
  });

  it('has no fallback when the dedicated path is absent or blank', () => {
    expect(resolveCompanionStartupConfig({})).toEqual({ secretFile: undefined });
    expect(resolveCompanionStartupConfig({ [COMPANION_SECRET_FILE_ENV]: ' \t\n' }))
      .toEqual({ secretFile: undefined });
  });

  it('captures the dedicated path in the daemon startup config after dotenv loading', async () => {
    vi.stubEnv(COMPANION_SECRET_FILE_ENV, '/run/secrets/botmux/companion');
    vi.resetModules();

    const { config } = await import('../src/config.js');
    expect(config.companion).toEqual({ secretFile: '/run/secrets/botmux/companion' });
  });
});
