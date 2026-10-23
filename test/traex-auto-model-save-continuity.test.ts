import React, { useState } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotAgentSection } from '../src/dashboard/web/bot-defaults-page.js';
import { TraexAutoModelEditor } from '../src/dashboard/web/traex-auto-model-editor.js';
import { writeAutoModelDraft } from '../src/dashboard/web/traex-auto-model-preferences.js';
import { resolveBotCodexRpcInput } from '../src/services/codex-rpc-input-policy.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const cliState = { options: [{ id: 'traex', label: 'TraeX' }], ttadkModelDefault: '', ttadkModelSuggestions: [] };
const model = 'gpt-6-astra';
const pool = { enabled: true as const, models: [model], queueTimeoutMs: 30_000,
  modelSettings: { [model]: { reasoningEffort: 'xhigh' as const, modelBackendVariant: 'max' as const } } };
const catalog = { models: [model], source: 'live', modelCapabilities: [{ slug: model, serviceTiers: [],
  reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], contextVariants: [
    { id: 'standard', contextWindow: 272000, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'max', contextWindow: 800000, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
  ] }] };
let rendered: TestRenderer.ReactTestRenderer | undefined;
let saved: any;
const entries = new Map<string, string>();
afterEach(() => { if (rendered) act(() => rendered!.unmount()); rendered = undefined; vi.unstubAllGlobals(); entries.clear(); });
async function mount(bot: any, onSaved?: (patch: any) => void, modelCatalog = catalog) {
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value), removeItem: (key: string) => entries.delete(key) } });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') saved = JSON.parse(init.body as string);
    return { ok: true, status: 200, json: async () => init?.method === 'PUT'
      ? { ok: true, cliId: 'traex', model: saved.model, traexAutoModel: saved.traexAutoModel,
          reasoningEffort: saved.reasoningEffort || null, modelBackendVariant: saved.modelBackendVariant || null }
      : modelCatalog };
  }));
  const props = { bot, sessionFallback: 'traex', cliState, patchBot: (_id: string, patch: any) => {
    onSaved?.(patch);
    rendered!.update(React.createElement(BotAgentSection, { ...props, bot: { ...bot, ...patch } }));
  } };
  await act(async () => { rendered = TestRenderer.create(React.createElement(BotAgentSection, props)); });
}
describe('Auto editor save and draft continuity', () => {
  it('preserves a saved effort while a future model catalog loads', async () => {
    await mount({ larkAppId: 'future-effort', cliId: 'traex', model: 'future-live-model', reasoningEffort: 'xhigh' }, undefined, {
      ...catalog, models: ['future-live-model'], modelCapabilities: [{ ...catalog.modelCapabilities[0]!, slug: 'future-live-model' }],
    });
    await act(async () => { rendered!.root.findByProps({ 'data-action': 'save-agent' }).props.onClick(); });
    expect(saved.reasoningEffort).toBe('xhigh');
  });
  it('disabling preserves preferred model reasoning advertised by the live catalog', async () => {
    await mount({ larkAppId: 'review-disable', cliId: 'traex', model: 'auto', traexAutoModel: pool });
    act(() => rendered!.root.findByProps({ 'data-input': 'autoModelEnabled' }).props.onChange({ currentTarget: { checked: false } }));
    await act(async () => { rendered!.root.findByProps({ 'data-action': 'save-agent' }).props.onClick(); });
    expect(saved.model).toBe(model);
    expect(saved.reasoningEffort).toBe('xhigh');
  });
  it('saving disabled state does not mark it dirty again', async () => {
    await mount({ larkAppId: 'review-disable-dirty', cliId: 'traex', model: 'auto', traexAutoModel: pool });
    act(() => rendered!.root.findByProps({ 'data-input': 'autoModelEnabled' }).props.onChange({ currentTarget: { checked: false } }));
    await act(async () => { rendered!.root.findByProps({ 'data-action': 'save-agent' }).props.onClick(); });
    expect(saved.traexAutoModel).toBeNull();
    expect(rendered!.root.findByType(TraexAutoModelEditor).props.dirty).toBe(false);
  });
  it('editing another agent field does not activate a dormant pool', async () => {
    const bot = { larkAppId: 'review-dormant', cliId: 'traex', model, traexAutoModel: pool, codexRpcInput: true };
    expect(resolveBotCodexRpcInput(bot, true)).toBe(true);
    await mount(bot);
    await act(async () => { rendered!.root.findByProps({ 'data-action': 'save-agent' }).props.onClick(); });
    expect(saved.model).toBe(model);
  });
  it('a save response from an unmounted editor does not erase a newer draft', async () => {
    const bot = { larkAppId: 'review-stale-save', cliId: 'traex', model: 'auto', traexAutoModel: pool };
    let finishSave!: (value: any) => void;
    const saveResponse = new Promise(resolve => { finishSave = resolve; });
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value), removeItem: (key: string) => entries.delete(key) } });
    let oldSaved: any;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') { oldSaved = JSON.parse(init.body as string); return saveResponse; }
      return { ok: true, status: 200, json: async () => catalog };
    }));
    const props = { bot, sessionFallback: 'traex', cliState, patchBot: vi.fn() };
    await act(async () => { rendered = TestRenderer.create(React.createElement(BotAgentSection, props)); });
    act(() => rendered!.root.findByType(TraexAutoModelEditor).props.onModels(['old-save-model']));
    await act(async () => { rendered!.root.findByProps({ 'data-action': 'save-agent' }).props.onClick(); });
    act(() => rendered!.unmount());
    await act(async () => { rendered = TestRenderer.create(React.createElement(BotAgentSection, props)); });
    act(() => rendered!.root.findByType(TraexAutoModelEditor).props.onModels(['new-draft-model']));
    expect([...entries.values()][0]).toContain('new-draft-model');
    await act(async () => finishSave({ ok: true, status: 200, json: async () => ({
      ok: true, cliId: 'traex', model: 'auto', traexAutoModel: oldSaved.traexAutoModel,
    }) }));
    expect(entries.size).toBe(1);
    expect([...entries.values()][0]).toContain('new-draft-model');
  });
});

let submitted: any;
let finishSave!: (value: any) => void;
function mocks() {
  const response = new Promise(resolve => { finishSave = resolve; });
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value), removeItem: (key: string) => entries.delete(key) } });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') { submitted = JSON.parse(init.body as string); return response; }
    return { ok: true, status: 200, json: async () => ({ models: ['gpt-6-astra'], source: 'live' }) };
  }));
}
async function complete() { await act(async () => finishSave({ ok: true, status: 200, json: async () => ({
  ok: true, cliId: 'traex', model: submitted.model, traexAutoModel: submitted.traexAutoModel,
}) })); }
describe('Concurrent editor saves', () => {
  it('does not replace a newer draft saved by another browser tab', async () => {
    mocks();
    const pool = { enabled: true as const, models: ['gpt-6-astra'], queueTimeoutMs: 30000 };
    await act(async () => { rendered = TestRenderer.create(React.createElement(BotAgentSection, {
      bot: { larkAppId: 'tab-bot', cliId: 'traex', model: 'auto', traexAutoModel: pool },
      sessionFallback: 'traex', cliState, patchBot: vi.fn(),
    })); });
    act(() => rendered!.root.findByType(TraexAutoModelEditor).props.onModels(['old-save-model']));
    await act(async () => rendered!.root.findByProps({ 'data-action': 'save-agent' }).props.onClick());
    writeAutoModelDraft('tab-bot', { reselectPerTurn: true, models: ['other-tab-draft'], modelSettings: {},
      timeoutSeconds: '17', cooldownSeconds: '31' });
    await complete();
    expect([...entries.values()][0]).toContain('other-tab-draft');
  });
  it('keeps the saved Bot cache current when its child editor unmounts on Bot selection', async () => {
    mocks();
    function Parent() {
      const [bots, setBots] = useState<any[]>([
        { larkAppId: 'bot-a', cliId: 'traex', model: 'gpt-6-astra' },
        { larkAppId: 'bot-b', cliId: 'traex', model: 'gpt-6-astra' },
      ]);
      const [selected, setSelected] = useState('bot-a');
      const bot = bots.find(row => row.larkAppId === selected);
      return React.createElement(React.Fragment, null,
        React.createElement('button', { 'data-nav': 'a', onClick: () => setSelected('bot-a') }),
        React.createElement('button', { 'data-nav': 'b', onClick: () => setSelected('bot-b') }),
        React.createElement(BotAgentSection, { key: bot.larkAppId, bot, sessionFallback: 'traex', cliState,
          patchBot: (appId: string, patch: any) => setBots(rows => rows.map(row => row.larkAppId === appId ? { ...row, ...patch } : row)) }));
    }
    await act(async () => { rendered = TestRenderer.create(React.createElement(Parent)); });
    act(() => rendered!.root.findByProps({ 'data-input': 'autoModelEnabled' }).props.onChange({ currentTarget: { checked: true } }));
    await act(async () => rendered!.root.findByProps({ 'data-action': 'save-agent' }).props.onClick());
    act(() => rendered!.root.findByProps({ 'data-nav': 'b' }).props.onClick());
    await complete();
    await act(async () => rendered!.root.findByProps({ 'data-nav': 'a' }).props.onClick());
    expect(submitted.model).toBe('auto');
    expect(rendered!.root.findByProps({ 'data-input': 'autoModelEnabled' }).props.checked).toBe(true);
  });
  it('retains a saved effort on an unknown model while its live capability loads', async () => {
    mocks();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({
      models: ['future-live-model'], source: 'live', modelCapabilities: [{ slug: 'future-live-model',
        serviceTiers: [], reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], contextVariants: [
          { id: 'standard', contextWindow: 272000, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
        ] }],
    }) })));
    await act(async () => { rendered = TestRenderer.create(React.createElement(BotAgentSection, {
      bot: { larkAppId: 'future-model', cliId: 'traex', model: 'future-live-model', reasoningEffort: 'xhigh', modelBackendVariant: 'standard' },
      sessionFallback: 'traex', cliState, patchBot: vi.fn(),
    })); });
    expect(rendered!.root.findByProps({ dataInput: 'agentReasoningEffort' }).props.value).toBe('xhigh');
  });
  it('retains same-editor defaults discovered while its earlier save is in flight', async () => {
    mocks();
    let finishModels!: (value: any) => void;
    const modelResponse = new Promise(resolve => { finishModels = resolve; });
    const putResponse = new Promise(resolve => { finishSave = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') { submitted = JSON.parse(init.body as string); return putResponse; }
      return modelResponse;
    }));
    const bot = { larkAppId: 'same-editor', cliId: 'traex', model: 'gpt-6-astra' };
    const props = { bot, sessionFallback: 'traex', cliState,
      patchBot: (_id: string, patch: any) => rendered!.update(React.createElement(BotAgentSection, { ...props, bot: { ...bot, ...patch } })) };
    await act(async () => { rendered = TestRenderer.create(React.createElement(BotAgentSection, props)); });
    act(() => rendered!.root.findByProps({ 'data-input': 'autoModelEnabled' }).props.onChange({ currentTarget: { checked: true } }));
    await act(async () => rendered!.root.findByProps({ 'data-action': 'save-agent' }).props.onClick());
    await act(async () => finishModels({ ok: true, status: 200, json: async () => ({ models: ['gpt-6-astra'], source: 'live',
      modelCapabilities: [{ slug: 'gpt-6-astra', serviceTiers: [], reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        contextVariants: [{ id: 'max', contextWindow: 800000, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] }] }],
    }) }));
    expect(submitted.traexAutoModel.modelSettings['gpt-6-astra'].modelBackendVariant).toBeUndefined();
    await complete();
    const editor = rendered!.root.findByType(TraexAutoModelEditor);
    expect(editor.props.modelSettings['gpt-6-astra'].modelBackendVariant).toBe('max');
    expect(editor.props.dirty).toBe(true);
  });
});
