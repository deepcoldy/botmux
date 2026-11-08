import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __testOnly_resetBotRegistry, loadBotConfigs, registerBot } from '../src/bot-registry.js';
import { setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { BotAgentSection } from '../src/dashboard/web/bot-defaults-page.js';
import type { BotDefaultsRow } from '../src/dashboard/web/bot-defaults.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const appId = 'cli_dashboard_effort';
const flash = 'minimax/MiniMax-M3.1-Flash';
const originalFetch = globalThis.fetch;
let dir: string | undefined;
let configPath: string;
let server: IpcServerHandle | undefined;
let renderer: TestRenderer.ReactTestRenderer | undefined;
let finishSave: ((result: { status: number; body: unknown }) => void) | undefined;
let failSave: ((error: unknown) => void) | undefined;

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
  finishSave = undefined;
  failSave = undefined;
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
        options: [{ id: bot.cliId!, label: bot.cliId!, modelChoices: [flash, 'minimax/MiniMax-M3'] }],
        ttadkModelDefault: '',
        ttadkModelSuggestions: [],
      },
      patchBot: () => undefined,
    }));
  });
}

async function setup(cliId: string, model: string, reasoningEffort?: string): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'dashboard-effort-save-'));
  configPath = join(dir, 'bots.json');
  vi.stubEnv('BOTS_CONFIG', configPath);
  writeFileSync(configPath, JSON.stringify([{ larkAppId: appId, larkAppSecret: 'fixture', cliId, model, reasoningEffort }]));
  loadBotConfigs().forEach(registerBot);
  setLarkAppId(appId);
  server = await startIpcServer({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  // Keep model discovery local; send the component's actual save payload to
  // the real IPC write handler so an accidental empty value reaches disk.
  vi.stubGlobal('fetch', (async (url, init) => {
    const path = String(url);
    if (path === `/api/bots/${appId}/agent` && init?.method === 'PUT') {
      try {
        const response = await originalFetch(`${base}/api/bot-agent`, init);
        finishSave?.({ status: response.status, body: await response.clone().json() });
        return response;
      } catch (error) {
        failSave?.(error);
        throw error;
      }
    }
    if (path.startsWith('/api/cli-options/models?')) {
      return new Response(JSON.stringify({ models: [], source: 'static' }));
    }
    if (path.startsWith('/api/cli-options/availability?')) {
      return new Response(JSON.stringify({ status: 'unknown' }));
    }
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch);
  await renderStored();
}

function effortPicker() {
  return renderer!.root.findByProps({ dataInput: 'agentReasoningEffort' });
}

async function save(): Promise<void> {
  const completed = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    finishSave = resolve;
    failSave = reject;
  });
  await act(async () => {
    renderer!.root.findByProps({ 'data-action': 'save-agent' }).props.onClick();
    expect(await completed).toMatchObject({ status: 200, body: { ok: true } });
  });
}

describe('Dashboard reasoning effort save and reload', () => {
  it.each([
    ['minimax', flash],
    ['minimax', `${flash}#thinking`],
    ['zcode', 'grok-4.6'],
    ['remote-runner', 'gpt-6-astra'],
  ])('preserves an untouched %s effort through the real save handler (%s)', async (cliId, model) => {
    await setup(cliId, model, 'high');
    await save();
    expect(stored().reasoningEffort).toBe('high');
    expect(loadBotConfigs()[0]!.reasoningEffort).toBe('high');
    await renderStored();
    expect(effortPicker().props.value).toBe('high');
  });

  it('offers the five verified MiniMax levels and persists both selection and explicit clearing', async () => {
    await setup('minimax', flash);
    const picker = effortPicker();
    expect(picker.props.value).toBe('');
    expect(picker.props.options.map((option: { value: string }) => option.value))
      .toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
    act(() => picker.props.onChange('max'));
    await save();
    expect(stored().reasoningEffort).toBe('max');
    await renderStored();
    expect(effortPicker().props.value).toBe('max');
    act(() => effortPicker().props.onChange(''));
    await save();
    expect(stored()).not.toHaveProperty('reasoningEffort');
    expect(loadBotConfigs()[0]!.reasoningEffort).toBeUndefined();
  });

  it.each(['', 'minimax/MiniMax-M3', 'minimax/MiniMax-M3.1-Flash-Preview', 'other/MiniMax-M3.1-Flash'])(
    'does not advertise MiniMax effort for an unverified model: %s', async model => {
      await setup('minimax', model);
      expect(effortPicker().props.options.map((option: { value: string }) => option.value)).toEqual(['']);
      await save();
      expect(stored()).not.toHaveProperty('reasoningEffort');
    },
  );

  it('clears the selected effort when the user changes to an unsupported MiniMax model', async () => {
    await setup('minimax', flash, 'high');
    act(() => renderer!.root.findByProps({ dataInput: 'agentModel' }).props.onChange('minimax/MiniMax-M3'));
    expect(effortPicker().props.value).toBe('');
    expect(effortPicker().props.options.map((option: { value: string }) => option.value)).toEqual(['']);
    await save();
    expect(stored()).toMatchObject({ model: 'minimax/MiniMax-M3' });
    expect(stored()).not.toHaveProperty('reasoningEffort');
  });
});
