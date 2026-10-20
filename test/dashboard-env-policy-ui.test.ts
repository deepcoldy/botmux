import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { EnvPolicySection, EnvSection } from '../src/dashboard/web/bot-defaults-page.js';
import type { BotDefaultsRow } from '../src/dashboard/web/bot-defaults.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());

it('saves strict names to the selected bot and resets drafts on a bot change', async () => {
  const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
  vi.stubGlobal('fetch', fetcher);
  const patchBot = vi.fn(); let view!: TestRenderer.ReactTestRenderer;
  act(() => { view = TestRenderer.create(React.createElement(EnvPolicySection, { bot: { larkAppId: 'app_a' } as BotDefaultsRow, patchBot })); });
  const mode = () => view.root.findByProps({ 'data-input': 'envPolicyMode' });
  act(() => mode().props.onChange({ currentTarget: { value: 'strict' } }));
  act(() => view.root.findByProps({ 'data-input': 'envPolicyNames' }).props.onChange({ currentTarget: { value: 'HTTPS_PROXY, NODE_EXTRA_CA_CERTS' } }));
  await act(async () => { view.root.findByProps({ 'data-action': 'save-env-policy' }).props.onClick(); });
  expect(fetcher).toHaveBeenCalledWith('/api/bots/app_a/env-policy', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ envPolicy: { mode: 'strict', inherit: ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS'] } }) }));
  expect(patchBot).toHaveBeenCalledWith('app_a', { envPolicy: { mode: 'strict', inherit: ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS'] } });
  act(() => view.update(React.createElement(EnvPolicySection, { bot: { larkAppId: 'app_b' } as BotDefaultsRow, patchBot })));
  expect(mode().props.value).toBe('inherit');
  expect(view.root.findAllByProps({ 'data-input': 'envPolicyNames' })).toHaveLength(0);
  act(() => view.unmount());
});

it('never renders stored credential values, including legacy save responses', async () => {
  const sentinel = 'private-value-sentinel';
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, env: JSON.stringify({ MODEL_AUTH: sentinel }), envKeys: ['MODEL_AUTH'] }) })));
  const patchBot = vi.fn(); let view!: TestRenderer.ReactTestRenderer;
  act(() => { view = TestRenderer.create(React.createElement(EnvSection, { bot: { larkAppId: 'app_a', env: JSON.stringify({ MODEL_AUTH: sentinel }), envKeys: ['MODEL_AUTH'] } as BotDefaultsRow, patchBot })); });
  const input = () => view.root.findByProps({ 'data-input': 'env' });
  expect(input().props.value).toBe('');
  expect(JSON.stringify(view.toJSON()).includes(sentinel)).toBe(false);
  act(() => input().props.onChange({ currentTarget: { value: JSON.stringify({ MODEL_AUTH: sentinel }) } }));
  await act(async () => { view.root.findByProps({ 'data-action': 'save-env' }).props.onClick(); });
  expect(input().props.value).toBe('');
  expect(JSON.stringify(view.toJSON()).includes(sentinel)).toBe(false);
  expect(patchBot).toHaveBeenCalledWith('app_a', { env: '', envKeys: ['MODEL_AUTH'] });
  act(() => view.unmount());
});
