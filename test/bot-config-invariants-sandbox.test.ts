import { describe, expect, it } from 'vitest';
import { botConfigInvariantError } from '../src/services/bot-config-invariants.js';

describe('botConfigInvariantError — sandbox tri-state', () => {
  it('leaves a normal entry alone', () => {
    expect(botConfigInvariantError({ cliId: 'codex-app' })).toBeUndefined();
    expect(botConfigInvariantError({ cliId: 'codex-app', sandbox: false })).toBeUndefined();
    expect(botConfigInvariantError({ cliId: 'codex-app', sandbox: 'off' })).toBeUndefined();
  });

  it('flags codexBrowser combined with every active sandbox representation', () => {
    const base = { cliId: 'codex-app', codexBrowser: { enabled: true } };
    expect(botConfigInvariantError({ ...base, sandbox: true })).toBe('codex_browser_config_conflict');
    expect(botConfigInvariantError({ ...base, sandbox: 'oncall' })).toBe('codex_browser_config_conflict');
    // Mutation-guard: the scratch string must count as an active sandbox — a
    // `=== true`-only check would let a scratch bot enable codexBrowser.
    expect(botConfigInvariantError({ ...base, sandbox: 'scratch' })).toBe('codex_browser_config_conflict');
    expect(botConfigInvariantError({ ...base, readIsolation: true })).toBe('codex_browser_config_conflict');
  });

  it('still allows codexBrowser when the sandbox is explicitly off', () => {
    expect(botConfigInvariantError({
      cliId: 'codex-app',
      codexBrowser: { enabled: true },
      sandbox: 'off',
    })).toBeUndefined();
  });

  it('flags existingAppServer combined with scratch/oncall', () => {
    expect(botConfigInvariantError({
      cliId: 'codex',
      existingAppServer: { endpoint: 'http://x' },
      sandbox: 'scratch',
    })).toBe('existing_app_server_sandbox_conflict');
    expect(botConfigInvariantError({
      cliId: 'codex',
      existingAppServer: { endpoint: 'http://x' },
      sandbox: 'oncall',
    })).toBe('existing_app_server_sandbox_conflict');
    expect(botConfigInvariantError({
      cliId: 'codex',
      existingAppServer: { endpoint: 'http://x' },
      sandbox: 'off',
    })).toBeUndefined();
  });

  it('keeps the codex-app cliId requirement', () => {
    expect(botConfigInvariantError({ cliId: 'codex', codexBrowser: true }))
      .toBe('codex_browser_requires_codex_app');
  });
});
