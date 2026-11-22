/**
 * The Codex RPC lifecycle on the hc backend: hc panes are identified and
 * replaced like tmux panes (the pid read itself runs against the real binary
 * in hc-worker-real.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { codexRpcEligible, codexRpcPaneBackend, orchestrateCodexRpcInit, type RpcInitEffects } from '../src/codex-rpc-lifecycle.js';
import type { DaemonToWorker } from '../src/types.js';

type InitCfg = Extract<DaemonToWorker, { type: 'init' }>;

function cfg(over: Partial<InitCfg> = {}): InitCfg {
  return {
    type: 'init',
    sessionId: 's1', chatId: 'c1', rootMessageId: 'r1', workingDir: '/tmp/x',
    cliId: 'codex', backendType: 'hc', prompt: 'hello',
    codexRpcInput: true,
    larkAppId: 'app', larkAppSecret: 'sec',
    ...over,
  } as InitCfg;
}

function effects(killGone: boolean) {
  const calls: string[] = [];
  const fx: RpcInitEffects = {
    paneInfo: () => { calls.push('paneInfo'); return { name: 'bmx-s1', live: true }; },
    paneIsRemote: () => { calls.push('paneIsRemote'); return true; },
    prepare: async () => { calls.push('prepare'); },
    engage: async () => { calls.push('engage'); return 'accepted'; },
    killVerify: async () => { calls.push('killVerify'); return killGone; },
    teardownEngine: () => { calls.push('teardownEngine'); },
    log: () => {},
    notify: () => { calls.push('notify'); },
  };
  return { fx, calls };
}

describe('Codex RPC on hc', () => {
  it('treats hc and tmux as the backends whose surviving pane it can replace', () => {
    expect(['tmux', 'hc'].map(codexRpcPaneBackend)).toEqual([true, true]);
    expect(['pty', 'zellij', 'herdr', 'zmx', undefined].map(codexRpcPaneBackend)).toEqual([false, false, false, false, false]);
  });

  it('admits a fresh codex/hc bot to RPC input', () => {
    expect(codexRpcEligible(cfg())).toBe(true);
  });

  it('replaces a surviving --remote hc pane when RPC input is switched off, and aborts if it cannot', async () => {
    const off = cfg({ codexRpcInput: false, prompt: '', resume: true, cliSessionId: 't1' });
    const replaced = effects(true);
    expect(await orchestrateCodexRpcInit(off, replaced.fx)).toMatchObject({ abortSpawn: false });
    expect(replaced.calls).toEqual(['paneInfo', 'paneIsRemote', 'killVerify']);

    const stuck = effects(false);
    expect(await orchestrateCodexRpcInit(off, stuck.fx)).toMatchObject({ abortSpawn: true });
    expect(stuck.calls).toEqual(['paneInfo', 'paneIsRemote', 'killVerify', 'notify']);

    const pty = effects(true);
    await orchestrateCodexRpcInit({ ...off, backendType: 'pty' } as InitCfg, pty.fx);
    expect(pty.calls).toEqual([]);
  });

  it('engages over a live --remote hc pane only after replacing it', async () => {
    const live = effects(true);
    const decision = await orchestrateCodexRpcInit(cfg({ resume: true, cliSessionId: 't1' }), live.fx);
    expect(decision).toMatchObject({ engaged: true, abortSpawn: false });
    expect(live.calls.indexOf('killVerify')).toBeGreaterThan(live.calls.indexOf('paneIsRemote'));
  });
});
