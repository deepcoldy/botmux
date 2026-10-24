import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotAgentSection } from '../src/dashboard/web/bot-defaults-page.js';
import { orchestrateCodexRpcInit, type RpcInitEffects } from '../src/codex-rpc-lifecycle.js';
import { requestSessionRestart, __testOnly_resetRestartCoordinator } from '../src/core/worker-pool.js';
import * as registry from '../src/bot-registry.js';
import * as globals from '../src/global-config.js';
import * as sessionStore from '../src/services/session-store.js';
import { classifyMergedRestart } from '../src/core/restart-followup-policy.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  __testOnly_resetRestartCoordinator();
  vi.restoreAllMocks();
});

describe('Automatic input compatibility in UI and session restart', () => {
  it.each([undefined, false, true])('saves Auto immediately without submitting the stored RPC preference ($0)', async override => {
    let saved: any;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (init?.method === 'PUT') saved = JSON.parse(String(init.body));
      return Response.json(init?.method === 'PUT'
        ? { ...saved, ok: true, codexRpcInputDefault: true, codexRpcInputEffective: false }
        : { models: ['first', 'backup'], source: 'live' });
    });
    let view: TestRenderer.ReactTestRenderer | undefined;
    try {
      await act(async () => { view = TestRenderer.create(createElement(BotAgentSection, {
        bot: { larkAppId: 'ui_rpc', cliId: 'traex', model: 'first',
          codexRpcInput: override, codexRpcInputDefault: true },
        sessionFallback: 'traex', patchBot: vi.fn(),
        cliState: { options: [{ id: 'traex', label: 'TraeX' }], ttadkModelDefault: '', ttadkModelSuggestions: [] },
      })); });
      act(() => view!.root.findByProps({ 'data-input': 'autoModelEnabled' }).props.onChange({ currentTarget: { checked: true } }));
      expect(view!.root.findAllByProps({ dataInput: 'agentRpcInput' })).toHaveLength(0);
      expect(view!.root.findAllByProps({ 'data-auto-model-conflict': '' })).toHaveLength(0);
      expect(view!.root.findByProps({ 'data-action': 'save-auto-model' }).props.disabled).toBe(false);
      await act(async () => { await view!.root.findByProps({ 'data-action': 'save-agent' }).props.onClick(); });
      expect(saved).not.toHaveProperty('codexRpcInput');
      expect(saved).toMatchObject({ model: 'auto',
        traexAutoModel: { enabled: true, models: ['first'] } });
      act(() => view!.root.findByProps({ 'data-input': 'autoModelEnabled' }).props.onChange({ currentTarget: { checked: false } }));
      await act(async () => { await view!.root.findByProps({ 'data-action': 'save-agent' }).props.onClick(); });
      expect(saved).not.toHaveProperty('codexRpcInput');
      expect(saved.traexAutoModel).toBeNull();
      expect(saved.model).not.toBe('auto');
    } finally { if (view) act(() => view!.unmount()); }
  });

  it.each([undefined, false, true])('adapts restart IPC with stored RPC=$0 and restores it when Auto is disabled', override => {
    vi.spyOn(globals, 'readGlobalConfig').mockReturnValue({ dashboard: { codexRpcInput: true } });
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    const botConfig: any = {
      larkAppId: 'restart_rpc', cliId: 'traex', model: 'auto', codexRpcInput: override,
      traexAutoModel: { enabled: true, models: ['first', 'backup'], queueTimeoutMs: 30_000 },
    };
    vi.spyOn(registry, 'getBot').mockReturnValue({ config: {
      ...botConfig,
    } } as any);
    const mockedBot = registry.getBot('restart_rpc').config;
    const send = vi.fn();
    const makeSession = (sessionId: string, fields: any = {}, extra: any = {}) => ({
      larkAppId: 'restart_rpc', session: { sessionId, cliId: 'traex', ...fields },
      worker: { killed: false, send }, ...extra,
    }) as any;
    const session = makeSession('auto-carrier');
    requestSessionRestart(session, { source: 'slash', notify: vi.fn(async () => {}) } as any);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'restart', codexRpcInput: false, traexAutoModel: botConfig.traexAutoModel, model: 'first',
    }));
    for (const [fields, extra] of [
      [{}, { spawnModelOverride: 'explicit-model' }],
      [{ dispatchLaunchSpec: { effective: { model: 'dispatch-model' } } }, {}],
      [{ wrapperCli: 'gateway' }, {}], [{ cliLaunchMode: 'remote' }, {}],
      [{ adoptedFrom: 'external' }, {}],
    ]) {
      requestSessionRestart(makeSession(`boundary-${send.mock.calls.length}`, fields, extra),
        { source: 'slash', notify: vi.fn(async () => {}) } as any);
      expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ codexRpcInput: override ?? true }));
    }
    mockedBot.model = 'first';
    mockedBot.traexAutoModel = undefined;
    requestSessionRestart(makeSession('disabled-carrier'), { source: 'slash', notify: vi.fn(async () => {}) } as any);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ codexRpcInput: override ?? true, traexAutoModel: null }));
    expect(mockedBot.codexRpcInput).toBe(override);
    expect(classifyMergedRestart({ windowLaunch: { codexRpcInput: true },
      requested: { codexRpcInput: false }, convergencePending: false })).toBe('converge');
  });

  it('replaces only a proven old RPC viewer when RPC was turned off and aborts on an unconfirmed removal', async () => {
    const cfg: any = { type: 'init', cliId: 'traex', backendType: 'tmux', codexRpcInput: false,
      resume: true, cliSessionId: 'native', sessionId: 'viewer', prompt: '' };
    const killVerify = vi.fn(async () => true);
    const fx: RpcInitEffects = {
      paneInfo: () => ({ name: 'bmx-viewer', live: true }), paneIsRemote: () => true,
      prepare: vi.fn(async () => {}), engage: vi.fn(async () => 'resumed'),
      killVerify, teardownEngine: vi.fn(), log: vi.fn(), notify: vi.fn(),
    };
    expect(await orchestrateCodexRpcInit(cfg, fx)).toMatchObject({ engaged: false, abortSpawn: false });
    expect(killVerify).toHaveBeenCalledWith('bmx-viewer');
    expect(fx.engage).not.toHaveBeenCalled();
    killVerify.mockClear();
    expect(await orchestrateCodexRpcInit(cfg, { ...fx, paneIsRemote: () => false })).toMatchObject({ abortSpawn: false });
    expect(killVerify).not.toHaveBeenCalled();
    killVerify.mockResolvedValue(false);
    expect(await orchestrateCodexRpcInit(cfg, fx)).toMatchObject({ abortSpawn: true });
    expect(fx.notify).toHaveBeenCalled();
  });
});
