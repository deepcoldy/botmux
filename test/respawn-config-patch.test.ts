/**
 * Worker-side fold of the daemon's latest launch settings into lastInitConfig
 * before an in-worker respawn (restart IPC, or a message to a crash-parked worker).
 */
import { describe, expect, it } from 'vitest';
import { applyRespawnConfigPatch, type RespawnPatchTarget } from '../src/core/respawn-config-patch.js';

type Cfg = RespawnPatchTarget & { nativeSessionTitle?: string; reasoningEffort?: string; cliId: string };

function forkSnapshot(): Cfg {
  return {
    cliId: 'claude-code',
    workingDir: '/repo',
    startupCommands: ['/effort max', '/effort ultracode'],
    launchShell: 'zsh',
    model: 'opus',
    env: { A: '1' },
    larkToolBinding: true,
    reasoningEffort: 'high',
    nativeSessionTitle: '用户手动改的名字',
  };
}

describe('applyRespawnConfigPatch', () => {
  it('replaces the fork-time startup commands with the carried ones', () => {
    const cfg = forkSnapshot();
    const result = applyRespawnConfigPatch(cfg, { startupCommands: ['/effort xhigh'] });
    expect(cfg.startupCommands).toEqual(['/effort xhigh']);
    expect(result.startupCommandsChanged).toBe(true);
  });

  it('null clears them, an empty list clears them, undefined keeps the snapshot', () => {
    const cleared = forkSnapshot();
    applyRespawnConfigPatch(cleared, { startupCommands: null, launchShell: null });
    expect(cleared.startupCommands).toBeUndefined();
    expect(cleared.launchShell).toBeUndefined();

    const empty = forkSnapshot();
    applyRespawnConfigPatch(empty, { startupCommands: [] });
    expect(empty.startupCommands).toBeUndefined();

    const kept = forkSnapshot();
    const result = applyRespawnConfigPatch(kept, {});
    expect(kept).toEqual(forkSnapshot());
    expect(result).toEqual({ traexReconfigure: false, startupCommandsChanged: false });
  });

  it('reports no change when the carried commands equal the snapshot', () => {
    const cfg = forkSnapshot();
    expect(applyRespawnConfigPatch(cfg, { startupCommands: ['/effort max', '/effort ultracode'] }).startupCommandsChanged).toBe(false);
  });

  it('does not alias the carried array', () => {
    const cfg = forkSnapshot();
    const carried = ['/effort xhigh'];
    applyRespawnConfigPatch(cfg, { startupCommands: carried });
    carried.push('/model sonnet');
    expect(cfg.startupCommands).toEqual(['/effort xhigh']);
  });

  it('every carried field follows the tri-state contract', () => {
    // (That /rename is never replayed is guarded end-to-end in
    // worker-restart-startup-commands.integration.test.ts.)
    const cfg = forkSnapshot();
    applyRespawnConfigPatch(cfg, {
      startupCommands: ['/effort xhigh'], launchShell: 'bash', model: 'sonnet', env: null,
      envUnset: ['X'], envFingerprint: 'fp', larkToolBinding: null, workingDir: '/repo2', codexRpcInput: false,
    });
    expect(cfg).toMatchObject({
      startupCommands: ['/effort xhigh'], launchShell: 'bash', model: 'sonnet', env: undefined,
      envUnset: ['X'], envFingerprint: 'fp', larkToolBinding: false, workingDir: '/repo2', codexRpcInput: false,
    });
  });

  it('an empty workingDir is ignored; traex reconfigure follows traexAutoModel or codexRpcInput', () => {
    const cfg = forkSnapshot();
    expect(applyRespawnConfigPatch(cfg, { workingDir: '' }).traexReconfigure).toBe(false);
    expect(cfg.workingDir).toBe('/repo');
    expect(applyRespawnConfigPatch(cfg, { codexRpcInput: true }).traexReconfigure).toBe(true);
    expect(applyRespawnConfigPatch(cfg, { traexAutoModel: null }).traexReconfigure).toBe(true);
  });
});
