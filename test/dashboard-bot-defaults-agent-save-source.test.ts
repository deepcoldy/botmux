import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { BotAgentSection } from '../src/dashboard/web/bot-defaults-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('Bot Defaults agent save state patch', () => {
  it('patches Forge launch mode and read-isolation capability from the save response', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => (init?.method === 'PUT'
        ? { ok: true, cliId: 'traex', selectionKey: 'forge-x-traex', cliLaunchMode: 'forge-traex', model: '',
          readIsolation: true, readIsolationSupported: true }
        : { models: [], source: 'static', profiles: [] }),
    })) as unknown as typeof fetch;
    const patchBot = vi.fn();
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    try {
      act(() => {
        renderer = TestRenderer.create(createElement(BotAgentSection, {
          bot: { larkAppId: 'cli_forge', cliId: 'traex', model: '', agentSelectionKey: 'forge-x-traex' },
          sessionFallback: 'traex',
          cliState: {
            options: [{ id: 'forge-x-traex', label: 'Forge x TraeX', cliLaunchMode: 'forge-traex' as const }],
            ttadkModelDefault: '',
            ttadkModelSuggestions: [],
          },
          patchBot,
        }));
      });
      await act(async () => { renderer!.root.findByProps({ 'data-action': 'save-agent' }).props.onClick(); });
      expect(patchBot).toHaveBeenLastCalledWith('cli_forge', expect.objectContaining({
        cliLaunchMode: 'forge-traex',
        agentSelectionKey: 'forge-x-traex',
        readIsolation: true,
        readIsolationSupported: true,
      }));
    } finally {
      if (renderer) act(() => renderer!.unmount());
      globalThis.fetch = previousFetch;
    }
  });
});
