import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as registry from '../src/bot-registry.js';
import { sessionModelChoices } from '../src/im/lark/session-model-picker.js';

const detectModelsMock = vi.fn();
const staticModelChoicesMock = vi.fn();
let sharedProbeCanRun = true;

vi.mock('../src/services/model-catalog.js', () => ({
  detectModels: (...args: any[]) => detectModelsMock(...args),
  staticModelChoices: (...args: any[]) => staticModelChoicesMock(...args),
  mergeModelChoices: (staticChoices: readonly string[], live: readonly string[] | null) => ({
    models: [...new Set(live && live.length > 0 ? live : staticChoices)],
    source: live && live.length > 0 ? 'live' : 'static',
  }),
}));

vi.mock('../src/dashboard/model-catalog-request.js', () => ({
  modelCatalogProbeContext: (key: string) => ({
    cliId: key,
    runtimeExecutable: undefined,
    runtimeContext: 'probe-context',
    probeEnv: {},
    probeSettingsEnv: {},
    fingerprint: 'probe-fingerprint',
    canProbe: sharedProbeCanRun,
  }),
}));

const app = 'session-model-catalogue-test';
let bot: any;

beforeEach(() => {
  sharedProbeCanRun = true;
  bot = {
    larkAppId: app,
    cliId: 'claude-code',
    backendType: 'tmux',
    model: 'configured-model',
    customModels: ['gateway/custom'],
  };
  detectModelsMock.mockReset();
  detectModelsMock.mockResolvedValue(['live-model']);
  staticModelChoicesMock.mockReset();
  staticModelChoicesMock.mockReturnValue(['static-model']);
  vi.spyOn(registry, 'getBot').mockImplementation(() => ({ config: bot }) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function sessionFixture() {
  return {
    larkAppId: app,
    activeModel: 'observed-model',
    session: {
      larkAppId: app,
      cliId: 'claude-code',
      backendType: 'tmux',
      agentFrozen: true,
      model: 'observed-model',
    },
  } as any;
}

it('matching sessions probe their runtime and include configured custom models', async () => {
  const models = await sessionModelChoices(sessionFixture());

  expect(detectModelsMock).toHaveBeenCalledTimes(1);
  expect(detectModelsMock.mock.calls[0][0]).toBe('claude-code');
  expect(models).toEqual(['gateway/custom', 'configured-model', 'observed-model', 'live-model']);
});

it('共享上下文判定数据根已重定向时，会话选择器不调用 live 目录', async () => {
  sharedProbeCanRun = false;
  const models = await sessionModelChoices(sessionFixture());

  expect(detectModelsMock).not.toHaveBeenCalled();
  expect(models).not.toContain('live-model');
  expect(models).toContain('static-model');
});

it('runtime-deviating launch snapshots neither probe nor inherit bot candidates', async () => {
  const ds = sessionFixture();
  ds.session.cliLaunchSnapshot = {
    version: 1,
    state: 'resolved',
    entryId: 'claude-code',
    cliId: 'claude-code',
    cliRuntime: null,
    cliPathOverride: '/snapshot/claude',
    wrapperCli: null,
    cliLaunchMode: null,
    model: null,
    reasoningEffort: null,
    launchShell: null,
    startupCommands: [],
  };

  const models = await sessionModelChoices(ds);

  expect(detectModelsMock).not.toHaveBeenCalled();
  expect(staticModelChoicesMock).toHaveBeenCalledWith('claude-code');
  expect(models).toEqual(['observed-model', 'static-model']);
  expect(models).not.toContain('gateway/custom');
  expect(models).not.toContain('configured-model');
});
