import { expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

// Run the real worker spawn body with filesystem/policy boundaries injected.
// Stop at managed launch preflight so no real CLI or daemon can be started.
function spawnHarness() {
  const reachedManaged = vi.fn(() => { throw new Error('MANAGED_PREFLIGHT_REACHED'); });
  const noop = () => {};
  const scope: Record<string, unknown> = {
    followBotTraeHome: noop,
    protectedHttpEgressCliSupportError: () => undefined,
    protectedMcpRedactedEnvKeys: () => [],
    codexRpcEngine: null,
    networkPolicySupportError: () => undefined,
    networkProxyLaunchError: async () => undefined,
    cliSpawnGeneration: 0,
    resetCodexModelMigrationState: noop,
    backgroundTaskTracker: { reset: noop },
    dirname, join, homedir, tmpdir,
    ensureSessionTempDir: () => tmpdir(),
    pinSessionMcpGatewaySocketRoot: noop,
    applySessionTempEnv: noop,
    submitFailureChains: new Map(),
    inputDeliveryEvidence: new Map(),
    queuedActivationReceipts: new Map(),
    forceClearSessionRenameInFlight: noop,
    shouldEnableProgramStatus: () => false,
    cliAdapter: null,
    retiredTurnIds: new Set(),
    lstatSync: () => { throw new Error('absent'); },
    deviceCredentialIsolationMarkerPath: () => '/fenced-marker',
    DEVICE_AUTHORITY_DIRECTORY: 'device',
    DEVICE_CREDENTIAL_FILE: 'credential',
    protectedMcpHomePaths: () => [],
    credentialIsolationRequired: () => false,
    inflightInputs: { takeCarryOver: () => [] },
    validateCliLaunchModeConfig: reachedManaged,
  };
  return { body: loadWorkerFunction<(cfg: unknown) => Promise<void>>('spawnCliBody', scope), reachedManaged };
}

it.each([undefined, 'tmux', 'zellij', 'herdr', 'orca'])('rejects an adopt init without an observation target (%s)', async adoptSource => {
  const { body, reachedManaged } = spawnHarness();
  await expect(body({ adoptMode: true, adoptSource, cliId: 'traex', sessionId: 'adopt', backendType: 'tmux' }))
    .rejects.toThrow(/missing adopt terminal/i);
  expect(reachedManaged).not.toHaveBeenCalled();
});

it('keeps ordinary init on the managed launch path', async () => {
  const { body, reachedManaged } = spawnHarness();
  await expect(body({ cliId: 'traex', sessionId: 'managed', backendType: 'tmux' }))
    .rejects.toThrow('MANAGED_PREFLIGHT_REACHED');
  expect(reachedManaged).toHaveBeenCalledOnce();
});
