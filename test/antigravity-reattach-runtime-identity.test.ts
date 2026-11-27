/**
 * A daemon restart re-attaches agy mid-turn. The runtime identity the new
 * worker publishes first must already name the conversation the live process
 * holds, or the session contract cannot tell this CLI from another: it opens a
 * new runtime, and a reply that finished while no worker was attached is
 * refused before the conversation id is learned (2026-11-20, v3.59.22).
 *
 * The real worker function runs against an injected module scope; the agy
 * lookup is the adapter's own resolver (the same observation the worker later
 * persists as the session's CLI session id).
 */
import { describe, expect, it, vi } from 'vitest';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const LIVE = 'eeb1eff1-8614-46c5-83a0-512806c17aba';

function antigravityScope(overrides: Record<string, unknown> = {}) {
  const scope = new WorkerSessionEventScope({ appId: 'a', sessionId: 's' }, { workerId: 'w', generation: 2 });
  const resolveActiveSessionId = vi.fn((_pty: { cliPid?: number; cliCwd?: string }) => LIVE as string | undefined);
  const env: Record<string, unknown> = {
    backend: { cliPid: 1520027, isReattach: true },
    codexRpcEngine: undefined,
    effectiveBackendType: 'tmux',
    lastInitConfig: { cliId: 'antigravity', cliSessionId: LIVE, workingDir: '/work' },
    cliAdapter: { resolveActiveSessionId },
    workerSessionEventScope: scope,
    readProcessStartIdentity: () => '461270632',
    nativeSessionForkPending: () => false,
    lastSpawnEffectiveResume: false,
    lastSpawnEffectiveCliSessionId: undefined,
    ...overrides,
  };
  const readIdentity = loadWorkerFunction<(binding: any) => any>('runtimeIdentityForContract', env);
  return { scope, env, resolveActiveSessionId, readIdentity };
}

describe('runtimeIdentityForContract for a re-attached Antigravity CLI', () => {
  it('names the conversation the live process holds on the first binding', () => {
    const s = antigravityScope();
    expect(s.readIdentity(s.scope.beginRuntime())).toEqual({
      backend: 'tmux', physicalId: '1520027:461270632', proof: 'process_start', nativeSessionId: LIVE,
    });
    expect(s.resolveActiveSessionId).toHaveBeenCalledWith({ cliPid: 1520027, cliCwd: '/work' });
  });

  it('stays bare while agy has not shown a conversation', () => {
    const s = antigravityScope();
    s.resolveActiveSessionId.mockReturnValue(undefined);
    expect(s.readIdentity(s.scope.beginRuntime())).toEqual({
      backend: 'tmux', physicalId: '1520027:461270632', proof: 'process_start',
    });
  });

  it('does not claim a conversation other than the one this spawn resumed', () => {
    const s = antigravityScope({ lastSpawnEffectiveResume: true, lastSpawnEffectiveCliSessionId: '0b0e2b4a-0000-4000-8000-000000000001' });
    expect(s.readIdentity(s.scope.beginRuntime()).nativeSessionId).toBeUndefined();
  });

  it('names a native rotation completed before persistent reattach', () => {
    const s = antigravityScope({
      lastSpawnEffectiveResume: true,
      lastSpawnEffectiveCliSessionId: '0b0e2b4a-0000-4000-8000-000000000001',
      lastSpawnPersistentReattach: true,
    });
    expect(s.readIdentity(s.scope.beginRuntime()).nativeSessionId).toBe(LIVE);
  });

  it('does not claim a conversation while a native fork is moving the CLI to another', () => {
    const s = antigravityScope({ nativeSessionForkPending: () => true });
    expect(s.readIdentity(s.scope.beginRuntime()).nativeSessionId).toBeUndefined();
  });

  it('leaves a fresh launch to the later observation', () => {
    const s = antigravityScope({ backend: { cliPid: 1520027, isReattach: false } });
    expect(s.readIdentity(s.scope.beginRuntime()).nativeSessionId).toBeUndefined();
    expect(s.resolveActiveSessionId).not.toHaveBeenCalled();
  });

  it('leaves an agy driven through a runner channel to that channel', () => {
    const s = antigravityScope({ cliAdapter: { resolveActiveSessionId: vi.fn(() => LIVE), runnerFramedInput: true } });
    expect(s.readIdentity(s.scope.beginRuntime()).nativeSessionId).toBeUndefined();
  });

  it('keeps the conversation a binding already proved', () => {
    const s = antigravityScope();
    const bound = s.scope.beginRuntime();
    bound.identity = { backend: 'tmux', physicalId: '1520027:461270632', proof: 'process_start', nativeSessionId: LIVE };
    s.resolveActiveSessionId.mockReturnValue('0b0e2b4a-0000-4000-8000-000000000002');
    expect(s.readIdentity(bound).nativeSessionId).toBe(LIVE);
  });
});
