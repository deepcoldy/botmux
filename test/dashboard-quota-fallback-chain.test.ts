import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { QuotaFallbackChainSection } from '../src/dashboard/web/bot-defaults-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CLI_STATE = {
  options: [
    { id: 'claude-code', label: 'Claude', modelChoices: ['opus'] },
    { id: 'traex', label: 'TRAE', modelChoices: ['GPT-6.1-Sol'] },
    { id: 'ttadk-codex', label: 'TTADK Codex', gateway: 'ttadk' as const },
  ],
  ttadkModelDefault: '',
  ttadkModelSuggestions: [],
};

function renderSection(bot: Record<string, unknown>) {
  const calls: Array<{ url: string; body?: any }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: String(url), body });
    const payload = String(url).startsWith('/api/cli-options/models')
      ? { models: [], source: 'static' }
      : { ok: true, quotaFallbackChain: body?.enabled ? { enabled: true, kinds: body.kinds, steps: body.steps } : null };
    return { ok: true, status: 200, json: async () => payload };
  }) as unknown as typeof fetch;
  const patchBot = vi.fn();
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(createElement(QuotaFallbackChainSection, {
      bot: { larkAppId: 'cli_chain', cliId: 'claude-code', model: 'opus', ...bot } as any,
      cliState: CLI_STATE as any,
      startCli: 'claude-code',
      patchBot,
    }));
  });
  return {
    root: renderer!.root,
    patchBot,
    saves: () => calls.filter(call => call.url.endsWith('/quota-fallback-chain')),
    unmount() {
      if (renderer) act(() => renderer!.unmount());
      globalThis.fetch = previousFetch;
    },
  };
}

describe('QuotaFallbackChainSection', () => {
  it('saves the edited chain and patches the row from the daemon echo', async () => {
    const h = renderSection({
      quotaFallbackChain: { enabled: true, kinds: ['usage', 'rate'], steps: [{ cliId: 'traex', model: 'GPT-6.1-Sol' }] },
    });
    try {
      expect(h.root.findByProps({ 'data-input': 'quotaFallbackChainCli0' }).props.value).toBe('traex');
      const cliChoices = h.root.findAll(node => node.props.dataInput === 'quotaFallbackChainCli0')[0]!.props.options
        .map((option: any) => option.value);
      expect(cliChoices).toEqual(['', 'claude-code', 'traex']);

      await act(async () => {
        h.root.findByProps({ 'data-action': 'add-quota-fallback-chain-step' }).props.onClick();
      });
      await act(async () => {
        h.root.findAll(node => node.props.dataInput === 'quotaFallbackChainCli1')[0]!.props.onChange('traex');
      });
      await act(async () => {
        h.root.findAll(node => node.props.dataInput === 'quotaFallbackChainModel1')[0]!.props.onChange('DeepSeek-V4.1-Flash');
      });
      await act(async () => {
        await h.root.findByProps({ 'data-action': 'save-quota-fallback-chain' }).props.onClick();
      });

      const expected = {
        enabled: true,
        kinds: ['usage', 'rate'],
        steps: [{ cliId: 'traex', model: 'GPT-6.1-Sol' }, { cliId: 'traex', model: 'DeepSeek-V4.1-Flash' }],
      };
      expect(h.saves()).toEqual([{ url: '/api/bots/cli_chain/quota-fallback-chain', body: expected }]);
      expect(h.patchBot).toHaveBeenLastCalledWith('cli_chain', { quotaFallbackChain: expected });
    } finally {
      h.unmount();
    }
  });

  it('refuses to save an enabled chain with a step that has no CLI', async () => {
    const h = renderSection({});
    try {
      await act(async () => {
        h.root.findByProps({ 'data-action': 'toggle-quota-fallback-chain' }).props.onChange({ currentTarget: { checked: true }, target: { checked: true } });
      });
      await act(async () => {
        await h.root.findByProps({ 'data-action': 'save-quota-fallback-chain' }).props.onClick();
      });
      expect(h.saves()).toEqual([]);
      expect(h.patchBot).not.toHaveBeenCalled();
    } finally {
      h.unmount();
    }
  });
});
