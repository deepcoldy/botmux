import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'bun:test';
import {
  fetchDetectedModels,
  mergeModelCandidates,
  modelSuggestionsForOption,
  type CliOptionsState,
} from '../src/dashboard/web/bot-defaults.js';

const page = readFileSync(new URL('../src/dashboard/web/bot-defaults-page.tsx', import.meta.url), 'utf8');
const onboarding = readFileSync(new URL('../src/dashboard/web/bot-onboarding.tsx', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../src/dashboard/web/i18n.ts', import.meta.url), 'utf8');

const cliState: CliOptionsState = {
  options: [],
  ttadkModelDefault: 'glm-5.1',
  ttadkModelSuggestions: ['ttadk-a', 'ttadk-b'],
};

// 源码断言：两处模型输入都换成 ModelPickerField，旧的裸文本框 + datalist 已移除。
describe('ModelPickerField 源码接线', () => {
  it('bot-defaults-page 导出 ModelPickerField，BotAgentSection 使用它', () => {
    expect(page).toMatch(/export function ModelPickerField\b/);
    const agentSection = page.slice(page.indexOf('export function BotAgentSection'));
    expect(agentSection).toContain('<ModelPickerField');
    expect(agentSection).toContain('dataInput="agentModel"');
  });

  it('onboarding 也使用 ModelPickerField', () => {
    expect(onboarding).toContain("import { ModelPickerField } from './bot-defaults-page.js';");
    expect(onboarding).toContain('<ModelPickerField');
    expect(onboarding).toContain('dataInput="ob-model"');
  });

  it('旧的裸文本输入框与 datalist 已移除', () => {
    // 旧标记是字面量 data-input="agentModel" 的 <input type="text">；新代码只有
    // data-input={props.dataInput}（自定义模式真实输入框 + 下拉模式 hidden 锚点）。
    expect(page).not.toMatch(/<input[^>]*data-input="agentModel"/);
    expect(page).not.toContain('agent-model-suggestions');
    expect(onboarding).not.toContain('ob-model-suggestions');
  });

  it('中英 i18n 都含 4 个 modelPicker key', () => {
    for (const key of ['modelPickerDefault', 'modelPickerCustom', 'modelPickerBack', 'modelPickerDetected']) {
      expect(i18n.match(new RegExp(`'botDefaults\\.${key}'`, 'g'))).toHaveLength(2);
    }
  });
});

describe('mergeModelCandidates', () => {
  it('detected 优先：detected 在前，static 中缺失的补在末尾', () => {
    expect(mergeModelCandidates(['a', 'b'], ['b', 'c', 'd'])).toEqual(['b', 'c', 'd', 'a']);
  });

  it('去重保序', () => {
    expect(mergeModelCandidates(['a', 'a', 'b'], ['b', 'b', 'c'])).toEqual(['b', 'c', 'a']);
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
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: ['a', 'b'], source: 'live', detectedAt: 123 }),
    })));
    expect(await fetchDetectedModels('codex')).toEqual({ models: ['a', 'b'], source: 'live' });
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
