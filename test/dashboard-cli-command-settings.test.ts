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
    await act(async () => renderer.root.findByProps({ 'data-input': 'customPassthroughCommands' }).props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: false }, preventDefault() {} }));
    await act(async () => { await renderer.root.findByProps({ 'data-action': 'save-custom-passthrough' }).props.onClick(); });
    expect(fetchMock).toHaveBeenCalledWith('/api/bots/app1/custom-passthrough', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ customPassthroughCommands: '/export /goal' }),
    }));
    expect(patchBot).toHaveBeenCalledWith('app1', { customPassthroughCommands: '/export /goal' });
    expect(renderer.root.findAll(node => typeof node.props['data-command-tag'] === 'string').map(node => node.props['data-command-tag']))
      .toEqual(['/export', '/goal']);
    expect(renderer.root.findByProps({ 'data-input': 'customPassthroughCommands' }).props.value).toBe('');
    await act(async () => renderer.unmount());
  });
});

async function tagEditor(initial = '') {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
    ok: true, status: 200,
    json: async () => init?.method === 'PUT'
      ? { ok: true, ...JSON.parse(String(init.body)) }
      : { ok: true, commands: [], summary: { total: 0, synced: 0, missing: 0, outdated: 0, remoteExtra: 0 } },
  }));
  vi.stubGlobal('fetch', fetchMock);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(SlashCommandPermissionsSection, {
    bot: { larkAppId: 'app1', cliId: 'traex', customPassthroughCommands: initial }, patchBot: vi.fn(),
  })); });
  const input = () => renderer.root.findByProps({ 'data-input': 'customPassthroughCommands' });
  const tags = () => renderer.root.findAll(node => typeof node.props['data-command-tag'] === 'string').map(node => node.props['data-command-tag']);
  const type = async (value: string) => { await act(async () => input().props.onChange({ currentTarget: { value } })); };
  const key = async (value: string, composing = false) => { await act(async () => input().props.onKeyDown({ key: value, nativeEvent: { isComposing: composing }, preventDefault() {} })); };
  const save = async () => { await act(async () => { await renderer.root.findByProps({ 'data-action': 'save-custom-passthrough' }).props.onClick(); }); };
  const close = async () => { await act(async () => renderer.unmount()); };
  return { renderer, input, tags, type, key, save, close, fetchMock };
}

describe('command tag input', () => {
  it('commits individual commands, normalizes and deduplicates them', async () => {
    const editor = await tagEditor();
    await editor.type('GOAL'); await editor.key('Enter');
    await editor.type('/export'); await editor.key(',');
    await editor.type('/GOAL'); await editor.key('Tab');
    expect(editor.tags()).toEqual(['/goal', '/export']);
    expect(editor.input().props.value).toBe('');
    await editor.close();
  });
  it('removes a tag using its button and the last tag using Backspace', async () => {
    const editor = await tagEditor('/goal /export /review');
    await act(async () => editor.renderer.root.findByProps({ 'data-remove-command': '/goal' }).props.onClick());
    expect(editor.tags()).toEqual(['/export', '/review']);
    // Backspace edits a non-empty draft; it must not consume a tag.
    await editor.type('/x'); await editor.key('Backspace');
    expect(editor.tags()).toEqual(['/export', '/review']);
    await editor.type(''); await editor.key('Backspace');
    expect(editor.tags()).toEqual(['/export']);
    await editor.key('Backspace');
    expect(editor.tags()).toEqual([]);
    await editor.save();
    expect(editor.fetchMock).toHaveBeenLastCalledWith('/api/bots/app1/custom-passthrough', expect.objectContaining({ body: JSON.stringify({ customPassthroughCommands: '' }) }));
    await editor.close();
  });
  it('pastes multiple commands while respecting the selected draft text', async () => {
    const editor = await tagEditor('/goal');
    await editor.type('/old');
    await act(async () => editor.input().props.onPaste({
      clipboardData: { getData: () => '/export, /review\n/custom-command' },
      currentTarget: { selectionStart: 0, selectionEnd: 4 }, preventDefault() {},
    }));
    expect(editor.tags()).toEqual(['/goal', '/export', '/review', '/custom-command']);
    await editor.close();
  });
  it('includes an unfinished valid command when Save is clicked', async () => {
    const editor = await tagEditor('/goal');
    await editor.type('/export'); await editor.save();
    expect(editor.fetchMock).toHaveBeenLastCalledWith('/api/bots/app1/custom-passthrough', expect.objectContaining({ body: JSON.stringify({ customPassthroughCommands: '/goal /export' }) }));
    expect(editor.tags()).toEqual(['/goal', '/export']);
    await editor.close();
  });
  it('keeps invalid drafts visible and prevents saving a daemon command', async () => {
    const editor = await tagEditor('/goal');
    await editor.type('/status'); await editor.key('Enter'); await editor.save();
    expect(editor.tags()).toEqual(['/goal']);
    expect(editor.input().props.value).toBe('/status');
    expect(editor.input().props['aria-invalid']).toBe(true);
    expect(editor.fetchMock.mock.calls.filter(call => call[1]?.method === 'PUT')).toHaveLength(0);
    await editor.close();
  });
  it('does not commit an Enter used during IME composition, and commits on blur', async () => {
    const editor = await tagEditor();
    await editor.type('/goal'); await editor.key('Enter', true);
    expect(editor.tags()).toEqual([]);
    await act(async () => editor.input().props.onBlur());
    expect(editor.tags()).toEqual(['/goal']);
    await editor.close();
  });
});
