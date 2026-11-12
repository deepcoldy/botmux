import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlashCommandPermissionsSection } from '../src/dashboard/web/bot-defaults-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());

describe('Dashboard CLI command-name configuration', () => {
  it('shows defaults and saves extra command names through the existing config endpoint', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true, status: 200,
      json: async () => init?.method === 'PUT'
        ? { ok: true, customPassthroughCommands: '/export /goal' }
        : { ok: true, commands: [], summary: { total: 0, synced: 0, missing: 0, outdated: 0, remoteExtra: 0 } },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const patchBot = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(SlashCommandPermissionsSection, {
        bot: { larkAppId: 'app1', cliId: 'traex', defaultPassthroughCommands: ['/model', '/goal'], customPassthroughCommands: '' }, patchBot,
      }));
    });
    const defaults = renderer.root.findByProps({ 'data-default-passthrough-commands': '' });
    expect(defaults.findAllByType('code').map(node => node.children.join(''))).toEqual(['/model', '/goal']);
    await act(async () => renderer.root.findByProps({ 'data-input': 'customPassthroughCommands' }).props.onChange({ currentTarget: { value: '/export /goal' } }));
    await act(async () => { await renderer.root.findByProps({ 'data-action': 'save-custom-passthrough' }).props.onClick(); });
    expect(fetchMock).toHaveBeenCalledWith('/api/bots/app1/custom-passthrough', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ customPassthroughCommands: '/export /goal' }),
    }));
    expect(patchBot).toHaveBeenCalledWith('app1', { customPassthroughCommands: '/export /goal' });
    expect(renderer.root.findByProps({ 'data-input': 'customPassthroughCommands' }).props.value).toBe('/export /goal');
    await act(async () => renderer.unmount());
  });
});
