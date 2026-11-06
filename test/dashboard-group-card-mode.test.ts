import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupCardModeRow } from '../src/dashboard/web/group-card-mode.js';
import { setCardModeForGroup, type GroupsActionDeps } from '../src/dashboard/groups-action-helpers.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());

it('saves the exact bot/group switch, shows inherit vs chat-off detail and rolls back on failure', async () => {
  let failure = false;
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const { enabled } = JSON.parse(init.body as string);
    return new Response(JSON.stringify(failure ? { ok: false, error: 'offline' } : { ok: true, enabled, changed: true }), { status: failure ? 503 : 200 });
  });
  vi.stubGlobal('fetch', fetcher);
  const props = { chatId: 'oc_demo', appId: 'app-a', botName: '助手', chatEnabled: true, masterEnabled: true, onSaved: vi.fn(async () => undefined) };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(GroupCardModeRow, props)); });
  const toggle = () => renderer.root.findByProps({ role: 'switch' });
  const detail = () => renderer.root.find(node => node.props['data-card-mode-state'] !== undefined);
  try {
    expect(toggle().props.checked).toBe(true);
    expect(detail().props['data-card-mode-state']).toBe('inherit-on');

    await act(async () => toggle().props.onChange({ currentTarget: { checked: false } }));
    expect(fetcher).toHaveBeenLastCalledWith('/api/groups/oc_demo/card-mode/app-a', expect.objectContaining({ method: 'PUT', body: '{"enabled":false}' }));
    expect(toggle().props.checked).toBe(false);
    expect(detail().props['data-card-mode-state']).toBe('chat-off');
    expect(props.onSaved).toHaveBeenCalledOnce();

    failure = true;
    await act(async () => toggle().props.onChange({ currentTarget: { checked: true } }));
    expect(toggle().props.checked).toBe(false);
    expect(renderer.root.findByProps({ role: 'status' }).children.join('')).toContain('offline');
    expect(props.onSaved).toHaveBeenCalledOnce();

    // Snapshot refresh reflects the saved off; a later in-chat `/card on` flows back in.
    await act(async () => renderer.update(React.createElement(GroupCardModeRow, { ...props, chatEnabled: false })));
    expect(toggle().props.checked).toBe(false);
    // Bot-level off: "on" still inherits, flagged as not shown.
    await act(async () => renderer.update(React.createElement(GroupCardModeRow, { ...props, chatEnabled: true, masterEnabled: false })));
    expect(toggle().props.checked).toBe(true);
    expect(detail().props['data-card-mode-state']).toBe('inherit-off');

    await act(async () => renderer.update(React.createElement(GroupCardModeRow, { ...props, disabled: true })));
    await act(async () => toggle().props.onChange({ currentTarget: { checked: false } }));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(toggle().props.disabled).toBe(true);
  } finally { await act(async () => renderer.unmount()); }
});

it('proxies to the named bot daemon and invalidates the snapshot only on success', async () => {
  const proxyToDaemon = vi.fn(async () => new Response('{"ok":true,"enabled":false,"changed":true}'));
  const invalidateGroups = vi.fn();
  const deps = { proxyToDaemon, invalidateGroups } as unknown as GroupsActionDeps;
  expect(await setCardModeForGroup('oc_demo', 'app-a', '{"enabled":false}', deps))
    .toEqual({ status: 200, body: { ok: true, enabled: false, changed: true } });
  expect(proxyToDaemon).toHaveBeenCalledWith('app-a', '/api/group-card-mode/oc_demo', expect.objectContaining({ method: 'PUT', body: '{"enabled":false}' }));
  expect(invalidateGroups).toHaveBeenCalledOnce();
  proxyToDaemon.mockResolvedValue(new Response('{"ok":false,"error":"invalid_enabled"}', { status: 400 }));
  await setCardModeForGroup('oc_demo', 'app-a', '{}', deps);
  expect(invalidateGroups).toHaveBeenCalledOnce();
});

it.each([
  { path: 'success', initial: false, click: true, external: [true, false], ok: true },
  { path: 'failure', initial: true, click: false, external: [false], ok: false },
])('applies an external chat state that arrives mid-save once the save settles ($path)', async ({ initial, click, external, ok }) => {
  let respond!: (r: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { respond = resolve; })));
  const props = { chatId: 'oc_demo', appId: 'app-a', botName: '助手', chatEnabled: initial, masterEnabled: true, onSaved: vi.fn(async () => undefined) };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(GroupCardModeRow, props)); });
  const toggle = () => renderer.root.findByProps({ role: 'switch' });
  try {
    let saving!: Promise<void>;
    await act(async () => { saving = toggle().props.onChange({ currentTarget: { checked: click } }); });
    expect(toggle().props.disabled).toBe(true);
    // An in-chat /card on|off (or another Dashboard) lands while the PUT is in flight.
    for (const chatEnabled of external) {
      await act(async () => renderer.update(React.createElement(GroupCardModeRow, { ...props, chatEnabled })));
    }
    await act(async () => {
      respond(new Response(JSON.stringify(ok ? { ok: true, enabled: click, changed: true } : { ok: false, error: 'offline' }), { status: ok ? 200 : 503 }));
      await saving;
    });
    expect(toggle().props.disabled).toBe(false);
    expect(toggle().props.checked).toBe(false);
  } finally { await act(async () => renderer.unmount()); }
});
