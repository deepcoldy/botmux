import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupIdleCloseRow } from '../src/dashboard/web/group-idle-close.js';
import { setIdleCloseForGroup, type GroupsActionDeps } from '../src/dashboard/groups-action-helpers.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());

it('defaults off, allows only integers, persists units and retains drafts on failed saves', async () => {
  let failure = false;
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
    failure ? { ok: false, error: 'offline' } : { ok: true, settings: JSON.parse(init.body as string) },
  ), { status: failure ? 503 : 200 }));
  vi.stubGlobal('fetch', fetcher);
  const props = { chatId: 'oc_a', appId: 'app-a', botName: '助手', onSaved: vi.fn(async () => undefined) };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(GroupIdleCloseRow, props)); });
  const toggle = () => renderer.root.findByProps({ role: 'switch' });
  const input = () => renderer.root.findByProps({ type: 'number' });
  const save = () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
  const change = (value: string) => input().props.onChange({ currentTarget: { value } });
  try {
    expect(toggle().props.checked).toBe(false);
    expect(input().props.disabled).toBe(true);
    await act(async () => toggle().props.onChange({ currentTarget: { checked: true } }));
    expect(input().props).toMatchObject({ min: '1', step: '1', inputMode: 'numeric' });
    for (const invalid of ['1.5', '-2', '1e3', '+2', 'abc']) {
      await act(async () => change(invalid));
      expect(input().props.value).toBe('1');
    }
    await act(async () => change('0'));
    await act(async () => save());
    expect(fetcher).not.toHaveBeenCalled();
    expect(input().props['aria-invalid']).toBe(true);
    await act(async () => change('12'));
    await act(async () => renderer.root.findByType('select').props.onChange({ currentTarget: { value: 'hours' } }));
    failure = true;
    await act(async () => save());
    expect(input().props.value).toBe('12');
    expect(renderer.root.findByProps({ role: 'status' }).children.join('')).toContain('offline');
    expect(props.onSaved).not.toHaveBeenCalled();
    failure = false;
    await act(async () => save());
    expect(fetcher).toHaveBeenLastCalledWith('/api/groups/oc_a/idle-close/app-a', expect.objectContaining({
      method: 'PUT', body: '{"enabled":true,"duration":12,"unit":"hours"}',
    }));
    expect(props.onSaved).toHaveBeenCalledOnce();
    await act(async () => renderer.update(React.createElement(GroupIdleCloseRow, { ...props, disabled: true })));
    await act(async () => save());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(toggle().props.disabled).toBe(true);
  } finally { await act(async () => renderer.unmount()); }
});

it('proxies the exact bot/group and invalidates the snapshot only on success', async () => {
  const proxyToDaemon = vi.fn(async () => new Response('{"ok":true}'));
  const invalidateGroups = vi.fn();
  const deps = { proxyToDaemon, invalidateGroups } as unknown as GroupsActionDeps;
  expect(await setIdleCloseForGroup('oc_a', 'app-a', '{"enabled":false}', deps)).toEqual({ status: 200, body: { ok: true } });
  expect(proxyToDaemon).toHaveBeenCalledWith('app-a', '/api/group-idle-close/oc_a', expect.objectContaining({ method: 'PUT', body: '{"enabled":false}' }));
  expect(invalidateGroups).toHaveBeenCalledOnce();
  proxyToDaemon.mockResolvedValue(new Response('{"ok":false}', { status: 503 }));
  await setIdleCloseForGroup('oc_a', 'app-a', '{}', deps);
  expect(invalidateGroups).toHaveBeenCalledOnce();
});
