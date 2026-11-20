import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const identity = { runnerPid: 50, runnerProcStart: '500', enginePid: 60, engineProcStart: '600' };
function fixture(cliId = 'dsh', dshRuntime?: string) {
  const scope: any = {
    lastInitConfig: { cliId, dshRuntime }, cliSpawnGeneration: 3,
    dshProcessAttestation: { generation: 3, executable: '/bin/botmux', args: ['__dsh-runner'] },
    captureDshProcessIdentity: vi.fn(() => ({ ...identity })),
    readProcessStartIdentity: (pid: number) => String(pid * 10),
    codexRpcEngine: undefined, codexAppEngineIdentity: undefined, codexAppRunnerProcessIdentity: undefined,
    effectiveBackendType: 'tmux', currentCliCredentialIsolated: false,
    send: vi.fn(), currentBotmuxTurnId: 'turn1', publishSandboxRelayCapability: vi.fn(() => true),
    backend: { getChildPid: () => 40 },
    decodeCodexAppPayload: (s: string) => JSON.parse(Buffer.from(s, 'base64').toString()),
    handleTrustedCodexAppMarker: vi.fn(),
  };
  const publish = loadWorkerFunction<(pid: number, enginePid?: number) => boolean>('publishLocalProcessAttestation', scope);
  scope.publishLocalProcessAttestation = vi.fn(publish);
  const marker = loadWorkerFunction<(body: string) => void>('handleAppRunnerOscMarker', scope);
  const ready = (payload = {}) => marker(`process_ready:${Buffer.from(JSON.stringify(payload)).toString('base64')}`);
  return { scope, publish, ready };
}

describe('worker DSH engine attestation', () => {
  it('publishes a kernel-proven engine before the current-turn snapshot', () => {
    const { scope, ready } = fixture();
    scope.publishSandboxRelayCapability.mockImplementation(() => {
      expect(scope.send).toHaveBeenCalledWith(expect.objectContaining({ enginePid: 60, engineProcStart: '600', cliPid: 40 }));
      return true;
    });
    ready({ enginePid: 999, engineProcStart: 'forged' });
    expect(scope.captureDshProcessIdentity).toHaveBeenCalledWith(40, '/bin/botmux', ['__dsh-runner']);
    expect(scope.dshProcessAttestation.identity).toEqual(identity);
    ready();
    expect(scope.publishSandboxRelayCapability).toHaveBeenCalledTimes(1);
  });

  it('leaves an unproven marker without an engine root, then can prove initialization', () => {
    const { scope, ready } = fixture();
    scope.captureDshProcessIdentity.mockReturnValueOnce(undefined);
    ready({ enginePid: 999 });
    expect(scope.send.mock.calls[0][0].enginePid).toBeUndefined();
    expect(scope.dshProcessAttestation.identity).toBeUndefined();
    ready();
    expect(scope.send.mock.calls[1][0].enginePid).toBe(60);
  });

  it.each(['enginePid', 'engineProcStart', 'runnerPid', 'runnerProcStart'])('cannot replace a frozen %s within the generation', key => {
    const { scope, publish } = fixture();
    publish(40);
    scope.captureDshProcessIdentity.mockReturnValue({ ...identity, [key]: typeof identity[key as keyof typeof identity] === 'number' ? 99 : '990' });
    publish(40);
    expect(scope.send.mock.calls[1][0].enginePid).toBeUndefined();
    expect(scope.dshProcessAttestation.identity).toEqual(identity);
  });

  it('does not carry an identity into a later CLI generation', () => {
    const { scope, publish, ready } = fixture();
    publish(40);
    scope.cliSpawnGeneration++;
    ready();
    publish(40);
    expect(scope.send.mock.calls[1][0].enginePid).toBeUndefined();
    expect(scope.captureDshProcessIdentity).toHaveBeenCalledTimes(1);
  });

  it.each([['dsh', 'tui'], ['codex-app', undefined], ['claude-code', undefined]])('does not change %s/%s execution roots', (cliId, runtime) => {
    const { scope, publish, ready } = fixture(cliId, runtime);
    ready();
    publish(40);
    expect(scope.captureDshProcessIdentity).not.toHaveBeenCalled();
    expect(scope.send.mock.calls[0][0].enginePid).toBeUndefined();
  });

  it('attests the SDK engine when the persisted runtime is explicitly official', () => {
    const { scope, ready } = fixture('dsh', 'official');
    ready();
    expect(scope.captureDshProcessIdentity).toHaveBeenCalledTimes(1);
    expect(scope.send.mock.calls[0][0].enginePid).toBe(60);
    expect(scope.send.mock.calls[0][0].engineProcStart).toBe('600');
  });
});
