import { describe, expect, it, vi } from 'vitest';
import { cliIdForComm, findLaunchedCliPid, isNonInteractiveCodexArgv } from '../src/core/session-discovery.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

describe('Codex launcher probes', () => {
  const candidates = (argv: string[]) => ({
    childrenOf: (pid: number) => pid === 100 ? [200] : [],
    commOf: (pid: number) => pid === 200 ? 'codex' : undefined,
    cmdlineOf: () => ['/opt/codex', ...argv],
    isZombie: () => false,
  });

  it.each([
    ['debug', 'models'],
    ['-c', 'model="example"', 'debug', 'models'],
    ['--version'],
    ['--help'],
    ['completion', 'bash'],
    ['app-server', '--listen', 'stdio://'],
    ['exec', 'task'],
    ['resume', '--help'],
    ['fork', '--help'],
  ].map(argv => ({ argv })))('does not select a noninteractive Codex command: $argv', ({ argv }) => {
    expect(findLaunchedCliPid(100, 'codex', 6, candidates(argv))).toBeNull();
  });

  it.each([
    [],
    ['resume', 'thread-id'],
    ['fork', 'thread-id'],
    ['-c', 'note="debug"', '--model', 'model', '-C', '/tmp/debug'],
    ['--profile', 'debug'],
    ['--profile', 'team debug'],
    ['-C', '/tmp/project review'],
    ['--remote-auth-token-env', 'debug'],
    ['resume', 'debug'],
    ['--image', 'debug'],
    ['--', 'debug'],
    ['explain this code'],
    ['debug the code'],
  ].map(argv => ({ argv })))('keeps interactive Codex and option values intact: $argv', ({ argv }) => {
    expect(findLaunchedCliPid(100, 'codex', 6, candidates(argv))).toBe(200);
  });

  it('continues to the interactive sibling of a metadata probe', () => {
    expect(findLaunchedCliPid(100, 'codex', 6, {
      childrenOf: pid => pid === 100 ? [200, 300] : [],
      commOf: () => 'codex',
      cmdlineOf: pid => ['/opt/codex', ...(pid === 200 ? ['debug', 'models'] : [])],
    })).toBe(300);
  });

  it('leaves the process-discovery contract of other CLIs unchanged', () => {
    expect(findLaunchedCliPid(100, 'traex', 6, {
      ...candidates(['debug', 'models']), commOf: () => 'traex',
    })).toBe(200);
  });

  it('skips an unreaped probe even when its argv is already empty', () => {
    expect(findLaunchedCliPid(100, 'codex', 6, {
      childrenOf: pid => pid === 100 ? [200, 300] : [],
      commOf: () => 'codex', cmdlineOf: () => [],
      isZombie: pid => pid === 200,
    })).toBe(300);
  });

  it('does not mistake a native metadata command for an already-bound interactive leaf', () => {
    const scope = {
      readComm: () => 'codex',
      readCmdline: () => ['/opt/codex', 'debug', 'models'],
      cliIdForComm, isNonInteractiveCodexArgv,
      isZombieProcess: () => false,
    };
    const native = loadWorkerFunction<(pid: number) => boolean>('codexProcessIsNativeLeaf', scope);
    expect(native(200)).toBe(false);
    scope.readCmdline = () => ['/opt/codex', 'resume', 'thread-id'];
    expect(native(200)).toBe(true);
    scope.readCmdline = () => [];
    scope.isZombieProcess = () => true;
    expect(native(200)).toBe(false);
  });
});

describe('Codex ownership PID refresh', () => {
  it('propagates capability-publication failures from the real attestation publisher', () => {
    const scope = {
      codexRpcEngine: undefined, codexAppEngineIdentity: undefined,
      codexAppRunnerProcessIdentity: undefined, effectiveBackendType: 'pty',
      currentCliCredentialIsolated: false, currentBotmuxTurnId: 'turn' as string | undefined,
      readProcessStartIdentity: () => 'birth-token', send: vi.fn(),
      publishSandboxRelayCapability: vi.fn(() => false),
    };
    const publish = loadWorkerFunction<(pid: number) => boolean>('publishLocalProcessAttestation', scope);
    expect(publish(300)).toBe(false);
    scope.publishSandboxRelayCapability.mockReturnValue(true);
    expect(publish(300)).toBe(true);
    scope.currentBotmuxTurnId = undefined;
    expect(publish(300)).toBe(true);
    expect(scope.publishSandboxRelayCapability).toHaveBeenCalledTimes(2);
  });

  function fixture() {
    const scope = {
      backend: { cliPid: 200, getChildPid: () => 100 },
      bridgeCliPid: 200,
      lastSpawnCodexLauncherActive: true,
      lastSpawnCodexLauncherPid: undefined as number | undefined,
      codexOwnershipAttestationPending: false,
      lastSpawnCodexExecutable: undefined,
      codexAdoptPendingPid: undefined,
      codexProcessIsNativeLeaf: vi.fn((pid: number) => pid === 300),
      readComm: vi.fn((pid: number): string | undefined => pid === 100 ? 'sh' : undefined),
      isZombieProcess: () => false,
      resolveCodexOwnershipPid: vi.fn(() => 300),
      publishLocalProcessAttestation: vi.fn(() => true),
      log: vi.fn(),
    };
    const current = loadWorkerFunction<() => number | undefined>('currentCodexObservedPid', scope);
    return { scope, current };
  }

  it('replaces a retired probe with the CLI under the same managed pane', () => {
    const { scope, current } = fixture();
    expect(current()).toBe(300);
    expect(scope.backend.cliPid).toBe(300);
    expect(scope.bridgeCliPid).toBe(300);
    expect(scope.publishLocalProcessAttestation).toHaveBeenCalledWith(300);
    current();
    expect(scope.resolveCodexOwnershipPid).toHaveBeenCalledTimes(1);
  });

  it('keeps resolving a live wrapper until its interactive child appears', () => {
    const { scope, current } = fixture();
    scope.resolveCodexOwnershipPid.mockReturnValueOnce(100);
    expect(current()).toBe(100);
    expect(current()).toBe(300);
    expect(scope.backend.cliPid).toBe(300);
  });

  it('preserves a live script-owned PID when discovery only finds its wrapper', () => {
    const { scope, current } = fixture();
    scope.readComm.mockImplementation(pid => pid === 200 ? 'node' : 'sh');
    scope.resolveCodexOwnershipPid.mockReturnValue(100);
    expect(current()).toBe(200);
    expect(scope.backend.cliPid).toBe(200);
    expect(scope.publishLocalProcessAttestation).not.toHaveBeenCalled();
  });

  it('replaces a zombie probe instead of preserving it while the native leaf is missing', () => {
    // The bounded resolver once wired a `codex debug`-style probe (pid 200) that
    // has now exited unreaped (zombie); rediscovery reaches only the live wrapper
    // (pid 100) because the interactive leaf has not forked yet. A zombie holds
    // no rollout fds, so preserving the wired pid would pin every ownership
    // check to a dead process — the live wrapper must win, and later observations
    // re-resolve the leaf from the same managed tree.
    const { scope, current } = fixture();
    scope.readComm.mockImplementation((pid: number) => pid === 200 ? 'codex' : 'sh');
    scope.isZombieProcess = (pid: number) => pid === 200;
    scope.resolveCodexOwnershipPid.mockReturnValue(100);
    expect(current()).toBe(100);
    expect(scope.backend.cliPid).toBe(100);
    expect(scope.bridgeCliPid).toBe(100);
    expect(scope.publishLocalProcessAttestation).toHaveBeenCalledWith(100);
  });

  it('retries a failed identity publication without returning to the retired PID', () => {
    const { scope, current } = fixture();
    scope.publishLocalProcessAttestation.mockReturnValueOnce(false);
    expect(current()).toBe(300);
    expect(scope.backend.cliPid).toBe(300);
    expect(scope.codexOwnershipAttestationPending).toBe(true);
    expect(current()).toBe(300);
    expect(scope.codexOwnershipAttestationPending).toBe(false);
    current();
    expect(scope.publishLocalProcessAttestation.mock.calls).toEqual([[300], [300]]);
  });

  it('uses the captured launcher when getChildPid aliases the mutable ownership field', () => {
    const { scope, current } = fixture();
    scope.backend.getChildPid = () => scope.backend.cliPid;
    scope.lastSpawnCodexLauncherPid = 100;
    expect(current()).toBe(300);
    expect(scope.resolveCodexOwnershipPid).toHaveBeenCalledWith(100, true, undefined);
  });

  it('resolves from the replacement backend after a restart', () => {
    const { scope, current } = fixture();
    current();
    const previous = scope.backend;
    scope.backend = { cliPid: 400, getChildPid: () => 500 };
    scope.resolveCodexOwnershipPid.mockReturnValue(600);
    expect(current()).toBe(600);
    expect(previous.cliPid).toBe(300);
    expect(scope.backend.cliPid).toBe(600);
    expect(scope.resolveCodexOwnershipPid).toHaveBeenLastCalledWith(500, true, undefined);
  });

  it('keeps adopted and other non-launcher PID bindings unchanged', () => {
    const { scope, current } = fixture();
    scope.lastSpawnCodexLauncherActive = false;
    expect(current()).toBe(200);
    expect(scope.resolveCodexOwnershipPid).not.toHaveBeenCalled();
  });
});
