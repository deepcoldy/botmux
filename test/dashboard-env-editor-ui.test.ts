import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

const confirmMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../src/dashboard/web/confirm-modal.js', async (orig) => ({
  ...(await orig<typeof import('../src/dashboard/web/confirm-modal.js')>()),
  confirm: confirmMock,
}));

import { EnvSection } from '../src/dashboard/web/bot-defaults-page.js';
import type { BotDefaultsRow } from '../src/dashboard/web/bot-defaults.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.unstubAllGlobals(); confirmMock.mockClear(); });

const bot = { larkAppId: 'app_a', envKeys: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'] } as BotDefaultsRow;

function render(patchBot = vi.fn()) {
  let view!: TestRenderer.ReactTestRenderer;
  act(() => { view = TestRenderer.create(React.createElement(EnvSection, { bot, patchBot })); });
  return view;
}
const okFetch = (envKeys: string[]) => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, envKeys }) }));
const text = (view: TestRenderer.ReactTestRenderer) => JSON.stringify(view.toJSON());

it('renders stored names as removable chips after a refresh', () => {
  const view = render();
  const chips = view.root.findAll(n => n.props['data-env-key'] !== undefined);
  expect(chips.map(c => c.props['data-env-key'])).toEqual(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
  act(() => view.unmount());
});

it('previews a pasted launcher script (names + tags only) and merge-saves it', async () => {
  const fetcher = okFetch(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']);
  vi.stubGlobal('fetch', fetcher);
  const patchBot = vi.fn();
  const view = render(patchBot);
  const script = "exec env \\\n  ANTHROPIC_BASE_URL='http://gw:8080' \\\n  ANTHROPIC_MODEL='secret-model-sentinel' \\\n  claude \"$@\"";
  act(() => view.root.findByProps({ 'data-input': 'env' }).props.onChange({ currentTarget: { value: script } }));
  const preview = view.root.findByProps({ 'data-env-preview': '' });
  const previewText = JSON.stringify(preview.findAllByType('li').map(li => li.findAllByType('span').map(s => s.children.join(''))));
  expect(previewText).toContain('覆盖');
  expect(previewText).toContain('新增');
  // Preview shows names only — never the pasted values.
  const previewJson = preview.findAll(() => true).flatMap(n => n.children.filter(c => typeof c === 'string')).join('|');
  expect(previewJson).toContain('ANTHROPIC_MODEL');
  expect(previewJson).not.toContain('secret-model-sentinel');
  expect(previewJson).not.toContain('http://gw:8080');
  await act(async () => { view.root.findByProps({ 'data-action': 'save-env' }).props.onClick(); });
  expect(fetcher).toHaveBeenCalledWith('/api/bots/app_a/env', expect.objectContaining({
    method: 'PUT', body: JSON.stringify({ env: script, mode: 'merge' }),
  }));
  expect(patchBot).toHaveBeenCalledWith('app_a', { env: '', envKeys: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'] });
  expect(view.root.findByProps({ 'data-input': 'env' }).props.value).toBe('');
  act(() => view.unmount());
});

it('blocks saving reserved keys, unparsable text, and blank input', () => {
  const view = render();
  const save = () => view.root.findByProps({ 'data-action': 'save-env' });
  expect(save().props.disabled).toBe(true);  // blank no longer means "clear"
  act(() => view.root.findByProps({ 'data-input': 'env' }).props.onChange({ currentTarget: { value: 'CLAUDE_CONFIG_DIR=/x\nA=1' } }));
  expect(save().props.disabled).toBe(true);
  expect(text(view)).toContain('CLAUDE_CONFIG_DIR');
  act(() => view.root.findByProps({ 'data-input': 'env' }).props.onChange({ currentTarget: { value: 'A="oops' } }));
  expect(save().props.disabled).toBe(true);
  act(() => view.unmount());
});

it('warns which stored names a replace-save would drop', () => {
  const view = render();
  act(() => view.root.findByProps({ 'data-input': 'env' }).props.onChange({ currentTarget: { value: 'ANTHROPIC_BASE_URL=x' } }));
  act(() => view.root.findByProps({ 'data-input': 'envMode-replace' }).props.onChange());
  expect(text(view)).toContain('ANTHROPIC_AUTH_TOKEN');
  act(() => view.unmount());
});

it('removes a single key and clears all only after confirmation', async () => {
  const fetcher = okFetch(['ANTHROPIC_BASE_URL']);
  vi.stubGlobal('fetch', fetcher);
  const view = render();
  await act(async () => { view.root.findAllByProps({ 'data-action': 'remove-env-key' })[0].props.onClick(); });
  expect(confirmMock).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenLastCalledWith('/api/bots/app_a/env', expect.objectContaining({
    body: JSON.stringify({ env: '', mode: 'merge', remove: ['ANTHROPIC_AUTH_TOKEN'] }),
  }));

  confirmMock.mockResolvedValueOnce(false);
  await act(async () => { view.root.findByProps({ 'data-action': 'clear-env' }).props.onClick(); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { view.root.findByProps({ 'data-action': 'clear-env' }).props.onClick(); });
  expect(fetcher).toHaveBeenLastCalledWith('/api/bots/app_a/env', expect.objectContaining({
    body: JSON.stringify({ env: '', mode: 'replace' }),
  }));
  act(() => view.unmount());
});
