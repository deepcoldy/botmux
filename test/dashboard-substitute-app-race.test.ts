import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotDefaultsPage } from '../src/dashboard/web/bot-defaults-page.js';

let renderer: TestRenderer.ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function mountPage() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const preview = deferred<Response>();
  const saves: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/bots') return new Response(JSON.stringify({ bots: [{
      larkAppId: 'cli_receiver', cliId: 'riff',
      substituteMode: { enabled: true, targets: [{ email: 'original@example.com', openId: 'ou_original', name: 'Original' }] },
    }] }));
    if (url.endsWith('/substitute-targets/resolve')) return preview.promise;
    if (url.endsWith('/substitute-mode')) {
      saves.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, substituteMode: saves.at(-1) }));
    }
    return new Response('{}', { status: 404 });
  }));
  await act(async () => { renderer = TestRenderer.create(React.createElement(BotDefaultsPage)); });
  await act(async () => renderer!.root.findByProps({ id: 'bd-tab-sessions' }).props.onClick());
  const row = () => renderer!.root.findByProps({ className: 'bd-substitute-target-row' });
  const input = () => row().find(node => node.type === 'input' && String(node.props['data-input']).startsWith('substituteTargetId-'));
  const selector = () => row().find(node => typeof node.type !== 'string' && String(node.props.dataInput).startsWith('substituteTargetType-'));
  return { preview, saves, row, input, selector };
}

describe('substitute target editing through the dashboard page', () => {
  it('ignores a person resolution completed after switching to an App ID and saves only the App ID', async () => {
    const page = await mountPage();
    await act(async () => page.input().props.onBlur());
    await act(async () => page.selector().props.onChange('appId'));
    await act(async () => page.input().props.onChange({ currentTarget: { value: 'cli_external' } }));
    await act(async () => page.preview.resolve(new Response(JSON.stringify({ resolution: { ok: true, openId: 'ou_original', name: 'Original' } }))));
    expect(page.input().props.value).toBe('cli_external');
    await act(async () => renderer!.root.findByProps({ 'data-action': 'save-substitute-mode' }).props.onClick());
    expect(page.saves[0].targets).toEqual([{ appId: 'cli_external' }]);
  });

  it('clears pending UI when an edited value makes the completed request stale', async () => {
    const page = await mountPage();
    await act(async () => page.input().props.onBlur());
    await act(async () => page.input().props.onChange({ currentTarget: { value: 'replacement@example.com' } }));
    await act(async () => page.preview.resolve(new Response(JSON.stringify({ resolution: { ok: true, openId: 'ou_original', name: 'Original' } }))));
    expect(page.input().props.value).toBe('replacement@example.com');
    expect(page.row().findAllByProps({ className: 'bd-substitute-target-resolving' })).toHaveLength(0);
  });

  it('discards a preview after switching to App ID and back to the original person field', async () => {
    const page = await mountPage();
    await act(async () => page.input().props.onBlur());
    await act(async () => page.selector().props.onChange('appId'));
    await act(async () => page.selector().props.onChange('email'));
    await act(async () => page.preview.resolve(new Response(JSON.stringify({ resolution: { ok: true, openId: 'ou_stale', name: 'Stale preview' } }))));
    await act(async () => renderer!.root.findByProps({ 'data-action': 'save-substitute-mode' }).props.onClick());
    expect(page.saves[0].targets[0]).toMatchObject({ email: 'original@example.com', openId: 'ou_original', name: 'Original' });
  });
});
