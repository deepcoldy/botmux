import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __testOnly_resetBotRegistry, loadBotConfigs, registerBot } from '../src/bot-registry.js';
import { setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import {
  fetchDetectedModels,
  mergeModelCandidates,
  modelSuggestionsForOption,
  type BotDefaultsRow,
  type CliOptionsState,
} from '../src/dashboard/web/bot-defaults.js';
import { BotAgentSection } from '../src/dashboard/web/bot-defaults-page.js';
import { BotOnboardingDialog } from '../src/dashboard/web/bot-onboarding.js';
import { ModelPickerField } from '../src/dashboard/web/field-controls.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const onboarding = readFileSync(new URL('../src/dashboard/web/bot-onboarding.tsx', import.meta.url), 'utf8');

const cliState: CliOptionsState = {
  options: [],
  ttadkModelDefault: 'glm-5.1',
  ttadkModelSuggestions: ['ttadk-a', 'ttadk-b'],
};

describe('bot-onboarding 的 import 边界', () => {
  // 源码结构护栏(K1)：onboarding 被 app.tsx 静态引入，若它从 bot-defaults-page 取控件，
  // 整页（8k 行）会被打进首屏 chunk，路由级懒加载失效——这是 import 依赖方向，只能读源码。
  // 来历：#1850 把 ModelPickerField 挪进 field-controls 正是为了切断这条边。
  it('does not statically import the lazily loaded bot-defaults-page', () => {
    expect(onboarding).not.toMatch(/from\s+['"]\.\/bot-defaults-page(?:\.js)?['"]/);
  });
});

describe('BotAgentSection runtime catalog hydration', () => {
  it('clears the previous runtime catalog while the replacement runtime is still loading', async () => {
    const previousFetch = globalThis.fetch;
    let resolveReplacement!: (response: any) => void;
    let modelRequests = 0;
    (globalThis as any).fetch = vi.fn(async (url: string) => {
      if (!String(url).includes('/api/cli-options/models')) throw new Error(`unexpected request: ${url}`);
      modelRequests += 1;
      if (modelRequests === 1) {
        return { ok: true, status: 200, json: async () => ({ models: ['old-live'], source: 'live' }) } as any;
      }
      return new Promise(resolve => { resolveReplacement = resolve; });
    });

    const cliOptions: CliOptionsState = {
      options: [{ id: 'codex', label: 'Codex', modelChoices: ['static-model'] }],
      ttadkModelDefault: '',
      ttadkModelSuggestions: [],
    };
    const bot = (executable: string) => ({
      larkAppId: 'cli_runtime_catalog',
      cliId: 'codex',
      agentSelectionKey: 'codex',
      model: '',
      cliRuntime: { id: executable, displayName: executable, executable, source: 'configured' as const },
      cliPathOverride: executable,
    });

    let renderer!: TestRenderer.ReactTestRenderer;
    try {
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(BotAgentSection, {
          bot: bot('/opt/old-codex'),
          sessionFallback: 'codex',
          cliState: cliOptions,
          patchBot: () => undefined,
        }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(renderer.root.findByProps({ dataInput: 'agentModel' }).props.options).toEqual(['old-live']);

      act(() => {
        renderer.update(React.createElement(BotAgentSection, {
          bot: bot('/opt/new-codex'),
          sessionFallback: 'codex',
          cliState: cliOptions,
          patchBot: () => undefined,
        }));
      });
      expect(modelRequests).toBe(2);
      expect(renderer.root.findByProps({ dataInput: 'agentModel' }).props.options).toEqual(['static-model']);

      await act(async () => {
        resolveReplacement({ ok: true, status: 200, json: async () => ({ models: ['new-live'], source: 'live' }) });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(renderer.root.findByProps({ dataInput: 'agentModel' }).props.options).toEqual(['new-live']);
    } finally {
      if (renderer) act(() => renderer.unmount());
      (globalThis as any).fetch = previousFetch;
    }
  });
});

const FOLLOW_CLI_DEFAULT = '跟随 CLI 默认';
const PINNED_MODEL = 'gpt-6.1-sol';
const LIVE_MODELS = [PINNED_MODEL, 'gpt-6-astra'];

type MenuOption = { value: string; label: unknown };

describe('BotAgentSection 主模型选择器', () => {
  const appId = 'cli_model_default_reset';
  const originalFetch = globalThis.fetch;
  let dir: string | undefined;
  let configPath: string;
  let server: IpcServerHandle | undefined;
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  const agentSaveBodies: Array<Record<string, unknown>> = [];

  afterEach(async () => {
    if (renderer) act(() => renderer!.unmount());
    renderer = undefined;
    if (server) await server.close();
    server = undefined;
    setLarkAppId('');
    __testOnly_resetBotRegistry();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    agentSaveBodies.length = 0;
  });

  function stored(): Record<string, unknown> {
    return JSON.parse(readFileSync(configPath, 'utf8'))[0];
  }

  async function renderStored(): Promise<void> {
    if (renderer) act(() => renderer!.unmount());
    const bot = loadBotConfigs()[0]!;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(BotAgentSection, {
        bot: { ...bot, agentSelectionKey: bot.cliId } as BotDefaultsRow,
        sessionFallback: bot.cliId!,
        cliState: {
          options: [{ id: 'codex', label: 'Codex', modelChoices: ['static-model'] }],
          ttadkModelDefault: '',
          ttadkModelSuggestions: [],
        },
        patchBot: () => undefined,
      }));
    });
  }

  function modelMenu() {
    return renderer!.root.findByProps({ id: 'bd-menu-agentModel' });
  }

  it('固定过模型的 Bot 能从下拉顶部选回「跟随 CLI 默认」，保存清掉 model，重新加载仍显示跟随默认', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dashboard-model-default-'));
    configPath = join(dir, 'bots.json');
    vi.stubEnv('BOTS_CONFIG', configPath);
    writeFileSync(configPath, JSON.stringify([
      { larkAppId: appId, larkAppSecret: 'fixture', cliId: 'codex', model: PINNED_MODEL },
    ]));
    loadBotConfigs().forEach(registerBot);
    setLarkAppId(appId);
    server = await startIpcServer({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${server.port}`;
    let finishSave: ((result: { status: number; body: unknown }) => void) | undefined;
    // 模型探测留在本地；保存走组件真实发出的请求体，交给真实 IPC 写入处理落盘。
    vi.stubGlobal('fetch', (async (url, init) => {
      const path = String(url);
      if (path === `/api/bots/${appId}/agent` && init?.method === 'PUT') {
        agentSaveBodies.push(JSON.parse(String(init.body)));
        const response = await originalFetch(`${base}/api/bot-agent`, init);
        finishSave?.({ status: response.status, body: await response.clone().json() });
        return response;
      }
      if (path.startsWith('/api/cli-options/models?')) {
        return new Response(JSON.stringify({ models: LIVE_MODELS, source: 'live' }));
      }
      if (path.startsWith('/api/cli-options/availability?')) {
        return new Response(JSON.stringify({ status: 'unknown' }));
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch);
    await renderStored();

    const pinnedMenu = modelMenu();
    expect(pinnedMenu.props.label).toBe(PINNED_MODEL);
    expect(pinnedMenu.props.options[0]).toEqual({ value: '', label: FOLLOW_CLI_DEFAULT });
    expect(pinnedMenu.props.options.map((option: MenuOption) => option.value).slice(1, 3)).toEqual(LIVE_MODELS);

    act(() => pinnedMenu.props.onChange(''));
    expect(modelMenu().props.label).toBe(FOLLOW_CLI_DEFAULT);

    const completed = new Promise<{ status: number; body: unknown }>(resolve => { finishSave = resolve; });
    await act(async () => {
      renderer!.root.findByProps({ 'data-action': 'save-agent' }).props.onClick();
      expect(await completed).toMatchObject({ status: 200, body: { ok: true } });
    });
    expect(agentSaveBodies).toHaveLength(1);
    expect(agentSaveBodies[0]).toMatchObject({ cliId: 'codex', model: '' });
    expect(stored()).not.toHaveProperty('model');
    expect(loadBotConfigs()[0]!.model).toBeUndefined();

    await renderStored();
    expect(renderer!.root.findByType(ModelPickerField).props.value).toBe('');
    expect(modelMenu().props.label).toBe(FOLLOW_CLI_DEFAULT);
  });
});

describe('BotOnboardingDialog 模型选择器', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('选过具体模型后能选回「跟随 CLI 默认」，创建请求不再带 model', async () => {
    const startBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/bot-onboarding/start' && init?.method === 'POST') {
        startBodies.push(JSON.parse(String(init.body)));
        // 终态 job：表单提交到此为止，不进入轮询。
        return new Response(JSON.stringify({ job: { id: 'job_model_default', status: 'failed', message: 'stop' } }));
      }
      if (url.startsWith('/api/cli-options/models?')) {
        return new Response(JSON.stringify({ models: LIVE_MODELS, source: 'live' }));
      }
      if (url.startsWith('/api/cli-options/availability?')) {
        return new Response(JSON.stringify({ status: 'available' }));
      }
      if (url === '/api/cli-options') {
        return new Response(JSON.stringify({
          options: [{ id: 'codex', label: 'Codex', modelChoices: [PINNED_MODEL] }],
          ttadkModelSuggestions: [],
        }));
      }
      throw new Error(`unexpected request: ${url}`);
    }));

    let renderer!: TestRenderer.ReactTestRenderer;
    try {
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(BotOnboardingDialog, { open: true, onClose: () => undefined }));
        await Promise.resolve();
        await Promise.resolve();
      });
      const modelMenu = () => renderer.root.findByProps({ id: 'bd-menu-ob-model' });
      expect(modelMenu().props.label).toBe(FOLLOW_CLI_DEFAULT);

      await act(async () => {
        modelMenu().props.onChange(PINNED_MODEL);
      });
      expect(modelMenu().props.label).toBe(PINNED_MODEL);
      expect(modelMenu().props.options[0]).toEqual({ value: '', label: FOLLOW_CLI_DEFAULT });

      await act(async () => {
        modelMenu().props.onChange('');
      });
      expect(renderer.root.findByType(ModelPickerField).props.value).toBe('');
      expect(modelMenu().props.label).toBe(FOLLOW_CLI_DEFAULT);

      await act(async () => {
        renderer.root.findByProps({ id: 'onboarding-form' }).props.onSubmit({ preventDefault() {} });
        await Promise.resolve();
      });
      expect(startBodies).toHaveLength(1);
      expect(startBodies[0]).toMatchObject({ cliId: 'codex' });
      expect(startBodies[0]).not.toHaveProperty('model');
    } finally {
      if (renderer) act(() => renderer.unmount());
    }
  });
});

describe('mergeModelCandidates', () => {
  it('detected 非空时使用 runtime 权威目录', () => {
    expect(mergeModelCandidates(['a', 'b'], ['b', 'c', 'd'])).toEqual(['b', 'c', 'd']);
  });

  it('去重保序', () => {
    expect(mergeModelCandidates(['a', 'a', 'b'], ['b', 'b', 'c'])).toEqual(['b', 'c']);
  });

  it('detected 为 null/undefined 时回退 static', () => {
    expect(mergeModelCandidates(['a', 'b'], null)).toEqual(['a', 'b']);
    expect(mergeModelCandidates(['a', 'b'], undefined)).toEqual(['a', 'b']);
  });

  it('detected 为空数组时回退 static（探测无结果，静态候选仍可用）', () => {
    expect(mergeModelCandidates(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});

describe('modelSuggestionsForOption', () => {
  it('非 ttadk 返回 modelChoices', () => {
    expect(
      modelSuggestionsForOption({ id: 'codex', label: 'Codex', modelChoices: ['m1', 'm2'] }, cliState),
    ).toEqual(['m1', 'm2']);
  });

  it('非 ttadk 无 modelChoices 返回 []', () => {
    expect(modelSuggestionsForOption({ id: 'codex', label: 'Codex' }, cliState)).toEqual([]);
  });

  it('ttadk 网关项行为不变：返回 ttadkModelSuggestions', () => {
    expect(
      modelSuggestionsForOption({ id: 'ttadk', label: 'ttadk', gateway: 'ttadk' }, cliState),
    ).toEqual(['ttadk-a', 'ttadk-b']);
  });

  it('ttadk CoCo（acceptsModel=false）不返回 ttadk 建议，改走 modelChoices', () => {
    expect(
      modelSuggestionsForOption(
        { id: 'ttadk', label: 'ttadk', gateway: 'ttadk', acceptsModel: false, modelChoices: ['coco-only'] },
        cliState,
      ),
    ).toEqual(['coco-only']);
  });
});

describe('fetchDetectedModels (fail-soft)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('200 返回 models 与 source', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        models: ['a', 'b'], source: 'live', detectedAt: 123,
        reasoningEffortsByModel: { a: ['low', 'ultra'] },
      }),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    expect(await fetchDetectedModels('codex', 'cli_mkk')).toEqual({
      models: ['a', 'b'], source: 'live', reasoningEffortsByModel: { a: ['low', 'ultra'] },
    });
    expect(fetchSpy).toHaveBeenCalledWith('/api/cli-options/models?key=codex&bot=cli_mkk');
  });

  it('携带 Bot ID 让服务端按该 Bot 的 runtime/env 探测', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: ['a'], source: 'static' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchDetectedModels('codex', 'cli_runtime_bot');
    expect(fetchMock).toHaveBeenCalledWith('/api/cli-options/models?key=codex&bot=cli_runtime_bot');
  });

  it('200 可选返回模型能力目录，并过滤形状异常的条目', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        models: ['gpt-6-astra'],
        source: 'live',
        detectedAt: 123,
        modelCapabilities: [
          { slug: 'gpt-6-astra', serviceTiers: ['priority', 1] },
          { slug: 2, serviceTiers: ['priority'] },
          'bad',
        ],
      }),
    })));
    expect(await fetchDetectedModels('codex')).toEqual({
      models: ['gpt-6-astra'],
      source: 'live',
      modelCapabilities: [{ slug: 'gpt-6-astra', serviceTiers: ['priority'] }],
    });
  });

  it('过滤非字符串项；source 非 live 归为 static', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: ['a', 1, null], source: 'weird' }),
    })));
    expect(await fetchDetectedModels('codex')).toEqual({ models: ['a'], source: 'static' });
  });

  it('400/非 200 返回 null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, error: 'unknown_selection_key' }),
    })));
    expect(await fetchDetectedModels('nope')).toBeNull();
  });

  it('models 非数组返回 null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: 'a,b' }),
    })));
    expect(await fetchDetectedModels('codex')).toBeNull();
  });

  it('fetch 抛错返回 null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect(await fetchDetectedModels('codex')).toBeNull();
  });
});
