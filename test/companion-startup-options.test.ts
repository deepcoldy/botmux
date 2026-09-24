import { describe, expect, it, vi } from 'vitest';
import { applyCompanionStartupOptions } from '../src/cli/companion-startup-options.js';
import { COMPANION_BOT_APP_ID_ENV, COMPANION_SECRET_FILE_ENV } from '../src/config.js';

const BOT = { larkAppId: 'local_test_bot', sandbox: true, cliId: 'codex' };

describe('companion start/restart options', () => {
  it('requires both options, validates the secret, and pins one isolated bot', () => {
    const env: NodeJS.ProcessEnv = {};
    const validateSecret = vi.fn();
    applyCompanionStartupOptions({
      argv: ['--companion-secret-file', '/secure/companion', '--companion-bot=local_test_bot'],
      env, bots: [BOT], validateSecret,
    });
    expect(validateSecret).toHaveBeenCalledWith('/secure/companion');
    expect(env).toMatchObject({
      [COMPANION_SECRET_FILE_ENV]: '/secure/companion',
      [COMPANION_BOT_APP_ID_ENV]: 'local_test_bot',
    });
  });

  it('rejects incomplete options and non-isolated, duplicate, or unsupported bots', () => {
    const apply = (bots: typeof BOT[]) => () => applyCompanionStartupOptions({
      argv: ['--companion-secret-file=/secure/companion', '--companion-bot', 'local_test_bot'],
      env: {}, bots, validateSecret: () => {},
    });
    expect(() => applyCompanionStartupOptions({ argv: ['--companion-bot', 'local_test_bot'], env: {}, bots: [BOT], validateSecret: () => {} })).toThrow('requires both');
    expect(apply([{ ...BOT, sandbox: false }])).toThrow('exactly one isolated codex/traex Bot');
    expect(apply([BOT, BOT])).toThrow('exactly one isolated codex/traex Bot');
    expect(apply([{ ...BOT, cliId: 'claude-code' }])).toThrow('exactly one isolated codex/traex Bot');
  });

  it('preserves existing behavior when the capability is not configured', () => {
    const env: NodeJS.ProcessEnv = { KEEP: 'yes' };
    applyCompanionStartupOptions({ argv: [], env, bots: [], validateSecret: () => { throw new Error('must not run'); } });
    expect(env).toEqual({ KEEP: 'yes' });
  });
});
