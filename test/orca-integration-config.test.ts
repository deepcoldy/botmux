import { describe, expect, it } from 'vitest';
import { orcaLaunchSupportError } from '../src/core/orca-support.js';
import { botConfigInvariantError } from '../src/services/bot-config-invariants.js';
import { defaultReplyDeliveryFor, effectiveReplyDelivery } from '../src/core/reply-delivery.js';
import { resolvePairedBackendId, isRemoteCliId } from '../src/core/remote-cli-ids.js';
import { resolveCliSelection, CLI_SELECT_TREE } from '../src/setup/cli-selection.js';
import { createCliAdapter } from '../src/adapters/cli/registry.js';
import { checkCliAvailability } from '../src/setup/cli-availability.js';

describe('Orca native selection', () => {
  it.each(['orca-codex', 'orca-claude'] as const)('pairs %s with the existing structured backend', async cliId => {
    expect(resolveCliSelection(cliId)).toEqual({ cliId });
    expect(isRemoteCliId(cliId)).toBe(true);
    expect(resolvePairedBackendId(cliId, 'tmux', 'pty')).toBe('remote-runner');
    expect(checkCliAvailability({ cliId })).toMatchObject({ available: true, localExecutableRequired: false });
    const adapter = await createCliAdapter(cliId);
    expect(adapter.injectsSessionContext).toBe(true);
    expect(adapter.resolvedBin).toBe(process.execPath);
    expect(defaultReplyDeliveryFor(cliId)).toBe('transcript');
    expect(effectiveReplyDelivery(undefined, cliId)).toBe('transcript');
    expect(botConfigInvariantError({ cliId, replyDelivery: 'send' })).toBe('orca_requires_transcript_delivery');
  });

  it('keeps existing CLI and backend choices unchanged', () => {
    expect(resolvePairedBackendId('remote-runner', 'tmux', 'pty')).toBe('remote-runner');
    expect(resolvePairedBackendId('codex', 'tmux', 'pty')).toBe('tmux');
    expect(resolvePairedBackendId('codex', 'remote-runner', 'pty')).toBe('pty');
    expect(defaultReplyDeliveryFor('codex')).toBe('send');
    expect(CLI_SELECT_TREE.find(g => g.key === 'orca')?.children?.map(c => c.cliId)).toEqual(['orca-codex', 'orca-claude']);
  });

  it.each([
    { sandbox: true }, { sandbox: 'scratch' }, { readIsolation: true },
    { sandboxNetwork: false }, { sandboxNetworkPolicy: { mode: 'deny' } },
    { envPolicy: { mode: 'strict' } }, { triggerUserAuth: { enabled: true } },
    { envUnset: ['TOKEN'] }, { codexAuthSync: 'isolated' }, { cliConfigDir: '/profile' },
    { credentialsSourceDir: '/credentials' }, { wrapperCli: 'wrapper' },
    { startupCommands: ['something'] }, { disableCliBypass: true },
    { env: { ANTHROPIC_AUTH_TOKEN: 'test-only' } },
  ])('refuses isolation/identity settings the external runtime cannot enforce: %j', settings => {
    expect(orcaLaunchSupportError({ cliId: 'orca-codex', ...settings }, {})).toBeTruthy();
    expect(botConfigInvariantError({ cliId: 'orca-codex', ...settings })).toBe('orca_runtime_configuration_conflict');
    expect(orcaLaunchSupportError({ cliId: 'codex', ...settings }, {})).toBeUndefined();
  });

  it('checks daemon-wide isolation and permits an explicit local profile', () => {
    expect(orcaLaunchSupportError({ cliId: 'orca-codex' }, { BOTMUX_SANDBOX: '1' })).toBeTruthy();
    expect(orcaLaunchSupportError({ cliId: 'orca-codex', startupCommands: [],
      env: { ORCA_USER_DATA_PATH: '/profiles/example' } }, {})).toBeUndefined();
  });
});
