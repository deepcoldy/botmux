import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { applyWorkerLaunchModel } from '../src/core/worker-launch-model.js';
import { applyRespawnConfigPatch } from '../src/core/respawn-config-patch.js';
import { classifyMergedRestart, restartLaunchSettings } from '../src/core/restart-followup-policy.js';

describe('statusline generation across folded restarts', () => {
  let scope: Record<string, any>;

  beforeEach(() => {
    scope = {
      lastInitConfig: { cliId: 'claude-code', model: 'opus', backendType: 'pty' },
      codexAutoUpgrade: undefined,
      effectiveBackendType: 'pty',
      backend: { getChildPid: () => 123 },
      cliRestartInProgress: true,
      tmuxRestartTimer: undefined,
      pendingLaunchConvergence: undefined,
      activeRestartAttemptId: undefined,
      pendingStatuslineLaunchGen: undefined,
      statuslineLaunchGenAtSpawn: { generation: 1, token: 'gen-current' },
      cliSpawnGeneration: 1,
      currentCliCredentialIsolated: false,
      applyWorkerLaunchModel,
      applyRespawnConfigPatch,
      classifyMergedRestart,
      restartLaunchSettings,
      configureTraexAutoModel: vi.fn(),
      restartCliProcess: vi.fn(async () => {}),
      log: vi.fn(),
      send: vi.fn(),
      readProcessStartIdentity: vi.fn(() => 'proc-start'),
      currentBotmuxTurnId: 'turn-current',
      publishSandboxRelayCapability: vi.fn(() => true),
    };
    scope.restartWindowLaunch = restartLaunchSettings(scope.lastInitConfig);
    scope.foldRestartIntoWindow = loadWorkerFunction('foldRestartIntoWindow', scope);
    scope.publishLocalProcessAttestation = loadWorkerFunction('publishLocalProcessAttestation', scope);
  });

  it('re-attests the current generation and drops an adopted token when no second spawn occurs', async () => {
    await loadWorkerMessageHandler('restart', scope)({
      type: 'restart', attemptId: 'attempt-folded', model: 'opus', statuslineLaunchGen: 'gen-folded',
    });

    expect(scope.restartCliProcess).not.toHaveBeenCalled();
    expect(scope.pendingStatuslineLaunchGen).toBeUndefined();
    expect(scope.activeRestartAttemptId).toBe('attempt-folded');
    const attestation = scope.send.mock.calls.at(-1)?.[0];
    expect(attestation).toMatchObject({
      type: 'local_process_attestation', cliSpawnGeneration: 1, statuslineLaunchGen: 'gen-current',
    });
    expect(attestation.statuslineLaunchGen).not.toBe('gen-folded');
    expect(scope.publishSandboxRelayCapability).not.toHaveBeenCalled();
  });

  it('keeps the pending token when changed settings require a convergence spawn', async () => {
    await loadWorkerMessageHandler('restart', scope)({
      type: 'restart', attemptId: 'attempt-converge', model: 'sonnet', statuslineLaunchGen: 'gen-converge',
    });

    expect(scope.pendingLaunchConvergence).toMatchObject({ attemptId: 'attempt-converge' });
    expect(scope.pendingStatuslineLaunchGen).toBe('gen-converge');
    expect(scope.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'local_process_attestation' }));
  });
});
