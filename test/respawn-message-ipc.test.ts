import { describe, expect, it, vi } from 'vitest';
import { loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { applyRespawnConfigPatch, respawnConfigPatchFromMessage } from '../src/core/respawn-config-patch.js';

async function runRecoveryMessage(parked: boolean) {
  const lastInitConfig = {
    cliId: 'claude-code', workingDir: '/repo', adoptMode: false,
    replyDelivery: 'send' as const, startupCommands: ['/effort old'], launchShell: 'zsh',
  };
  const scope: Record<string, unknown> = {
    lastInitConfig,
    restoredDeploymentTurnId: undefined,
    applyWorkerLaunchModel: vi.fn(),
    backend: parked ? null : {},
    crashDiagnosticStopped: parked,
    applyRespawnConfigPatch,
    respawnConfigPatchFromMessage,
    finalHandoffAdmissionEnabled: false,
    isOrdinaryImTurnId: () => true,
    receiveOrdinaryImTurn: () => 'committed',
    acknowledgeTurnInputCommitted: vi.fn(),
    log: vi.fn(),
  };
  await loadWorkerMessageHandler('message', scope)({
    type: 'message', content: 'retry', turnId: 'om_duplicate',
    replyDelivery: 'transcript', startupCommands: ['/effort new'], launchShell: 'bash',
  });
  return lastInitConfig;
}

describe('worker message crash-park replyDelivery patch', () => {
  it('真正 parked 的恢复消息在分支内应用新投递方式与启动配置', async () => {
    expect(await runRecoveryMessage(true)).toMatchObject({
      replyDelivery: 'transcript', startupCommands: ['/effort new'], launchShell: 'bash',
    });
  });

  it('普通消息即使携带新值也不改变在跑 pane 的配置', async () => {
    expect(await runRecoveryMessage(false)).toMatchObject({
      replyDelivery: 'send', startupCommands: ['/effort old'], launchShell: 'zsh',
    });
  });
});
