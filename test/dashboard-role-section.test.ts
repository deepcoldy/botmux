import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoleSection } from '../src/dashboard/web/bot-defaults-page.js';
import { t } from '../src/dashboard/web/ui.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const appId = 'cli_role';
const roleUrl = `/api/team/local-bots/${appId}/role`;
const originalFetch = globalThis.fetch;
const renderers: TestRenderer.ReactTestRenderer[] = [];

type Reply = { status?: number; body: Record<string, unknown>; wait?: Promise<void> };
type Call = { url: string; method: string; body?: any };

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function mount(getReplies: Reply[], putReplies: Reply[] = [], teamRole = 'cached') {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/role-profiles') {
      return { ok: true, status: 200, json: async () => ({ ok: true, profiles: [] }) } as Response;
    }
    if (url !== roleUrl) throw new Error(`unexpected fetch: ${method} ${url}`);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
    const reply = (method === 'PUT' ? putReplies : getReplies).shift();
    if (!reply) throw new Error(`missing ${method} reply`);
    if (reply.wait) await reply.wait;
    const status = reply.status ?? 200;
    return { ok: status < 400, status, json: async () => reply.body } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  const patchBot = vi.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(RoleSection, {
      bot: { larkAppId: appId, teamRole }, patchBot,
    }));
    await flush();
  });
  renderers.push(renderer);
  const textarea = () => renderer.root.findByProps({ 'data-input': 'teamRole' });
  const save = () => renderer.root.findByProps({ 'data-action': 'save-role' });
  const edit = async (value: string) => {
    await act(async () => { textarea().props.onChange({ currentTarget: { value } }); });
  };
  const click = async (node: TestRenderer.ReactTestInstance) => {
    await act(async () => { node.props.onClick(); await flush(); });
  };
  return {
    renderer, calls, patchBot, textarea, save, edit, click,
    text: () => JSON.stringify(renderer.toJSON()),
  };
}

afterEach(() => {
  for (const renderer of renderers.splice(0)) act(() => renderer.unmount());
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
});

describe('RoleSection compare-and-set', () => {
  it('uses one same-origin GET snapshot and advances expectedRole from the persisted PUT value', async () => {
    const h = await mount([
      { body: { ok: true, role: 'original', injectMode: 'once' } },
    ], [
      { body: { ok: true, role: 'persisted replacement', injectMode: 'once' } },
      { body: { ok: true, role: 'second', injectMode: 'once' } },
    ]);

    expect(h.textarea().props.value).toBe('original');
    expect(h.calls.filter(call => call.method === 'GET')).toHaveLength(1);
    await h.edit(' replacement ');
    await h.click(h.save());
    await h.edit('second');
    await h.click(h.save());

    const puts = h.calls.filter(call => call.method === 'PUT');
    expect(puts.map(call => call.body)).toEqual([
      { role: ' replacement ', injectMode: 'once', expectedRole: 'original', expectedInjectMode: 'once' },
      { role: 'second', injectMode: 'once', expectedRole: 'persisted replacement', expectedInjectMode: 'once' },
    ]);
    expect(h.patchBot).toHaveBeenLastCalledWith(appId, { teamRole: 'second' });
  });

  it('sends both expectations on the delete path too', async () => {
    const h = await mount([
      { body: { ok: true, role: 'original', injectMode: 'once' } },
    ], [
      { body: { ok: true, role: '', injectMode: 'once' } },
    ]);
    await h.edit('');
    await h.click(h.save());
    expect(h.calls.filter(call => call.method === 'PUT').map(call => call.body)).toEqual([
      { role: '', injectMode: 'once', expectedRole: 'original', expectedInjectMode: 'once' },
    ]);
  });

  it('on 409 preserves the draft, disables saving, and reloads a fresh snapshot', async () => {
    const h = await mount([
      { body: { ok: true, role: 'original', injectMode: 'once' } },
      { body: { ok: true, role: 'operator edit', injectMode: 'every' } },
    ], [
      { status: 409, body: { ok: false, error: 'role_changed' } },
      { body: { ok: true, role: 'resolved', injectMode: 'every' } },
    ]);

    await h.edit('stale draft');
    await h.click(h.save());
    expect(h.text()).toContain(t('botDefaults.roleConflict'));
    expect(h.textarea().props.value).toBe('stale draft');
    expect(h.textarea().props.readOnly).toBe(true);
    expect(h.save().props.disabled).toBe(true);

    const reload = h.renderer.root.findByProps({ 'data-action': 'reload-role' });
    await h.click(reload);
    expect(h.textarea().props.value).toBe('operator edit');
    expect(h.save().props.disabled).toBe(false);
    expect(h.renderer.root.findAllByProps({ 'data-action': 'reload-role' })).toHaveLength(0);

    await h.edit('resolved');
    await h.click(h.save());
    expect(h.calls.filter(call => call.method === 'PUT').at(-1)?.body).toEqual({
      role: 'resolved', injectMode: 'every', expectedRole: 'operator edit', expectedInjectMode: 'every',
    });
  });

  it('keeps the conflict draft while a reload is pending or fails', async () => {
    let releaseReload!: () => void;
    const wait = new Promise<void>(resolve => { releaseReload = resolve; });
    const h = await mount([
      { body: { ok: true, role: 'original', injectMode: 'once' } },
      { status: 500, body: { ok: false, error: 'reload_failed' }, wait },
    ], [
      { status: 409, body: { ok: false, error: 'role_changed' } },
    ]);

    await h.edit('stale draft');
    await h.click(h.save());
    await h.click(h.renderer.root.findByProps({ 'data-action': 'reload-role' }));
    expect(h.textarea().props.value).toBe('stale draft');
    expect(h.textarea().props.disabled).toBe(true);
    expect(h.renderer.root.findByProps({ 'data-action': 'reload-role' }).props.disabled).toBe(true);

    await act(async () => { releaseReload(); await flush(); });
    expect(h.textarea().props.value).toBe('stale draft');
    expect(h.text()).toContain(t('botDefaults.roleLoadErr'));
    expect(h.save().props.disabled).toBe(true);
    expect(h.renderer.root.findByProps({ 'data-action': 'reload-role' }).props.disabled).toBe(false);
  });
});
