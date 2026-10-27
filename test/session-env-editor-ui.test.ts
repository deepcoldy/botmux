import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionEnvEditor, SessionEnvLiveModal } from '../src/dashboard/web/session-env-editor.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());

const SECRET = 'raw-secret-sentinel-9999';
const zh = createDashboardTranslator('zh');

function botView(canReveal: boolean) {
  return {
    ok: true,
    scope: 'bot',
    canReveal,
    larkAppId: 'app_a',
    inherit: { mode: 'inherit' },
    backendType: 'tmux',
    overlayApplies: true,
    identityLockedKeys: ['ZDOTDIR', 'BASH_ENV'],
    identityIgnoredKeys: [],
    notInheritedKeys: [],
    reserved: { keys: ['TMPDIR'], prefixes: ['BOTMUX'] },
    redactedHostKeys: ['GITHUB_TOKEN'],
    conflicts: [],
    sessions: [
      { sessionId: 's1', larkAppId: 'app_a', title: 'old topic', backendType: 'tmux', tmuxSocket: 'botmux', stale: true },
      { sessionId: 's2', larkAppId: 'app_a', title: 'fresh topic', backendType: 'tmux', stale: false },
    ],
    rows: [
      { key: 'ANTHROPIC_AUTH_TOKEN', state: 'set', source: 'bot', entry: 'set', value: '••••••9999', masked: true,
        lower: { source: 'host', state: 'inherited', value: '••••••0000', masked: true } },
      { key: 'BYTECLOUD_AUTH_AS', state: 'unset', source: 'global', value: '••••••', masked: true },
      { key: 'EDITOR', state: 'inherited', source: 'host', value: 'vim' },
      { key: 'HTTPS_PROXY', state: 'set', source: 'global', value: 'http://proxy.example.com:8080',
        lower: { source: 'host', state: 'inherited', value: 'http://corp-proxy.example.com:3128' } },
      { key: 'LANG', state: 'inherited', source: 'host', value: 'C' },
      { key: 'PATH', state: 'inherited', source: 'host', value: '/usr/bin', lock: 'no-unset' },
    ],
  };
}

function stubFetch(view: object, extra: Record<string, object> = {}) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    const body = extra[key] ?? (url.includes('/reveal') ? { ok: true, value: SECRET } : view);
    return { ok: true, status: 200, json: async () => body } as Response;
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

async function render(el: React.ReactElement) {
  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => { view = TestRenderer.create(el); });
  return view;
}
const text = (v: TestRenderer.ReactTestRenderer) => JSON.stringify(v.toJSON());
const row = (v: TestRenderer.ReactTestRenderer, key: string) => v.root.find(n => n.props['data-env-row'] === key);
const button = (n: TestRenderer.ReactTestInstance, action: string) => n.findAll(c => c.type === 'button' && c.props['data-action'] === action);
const shownRows = (v: TestRenderer.ReactTestRenderer) => v.root.findAll(n => n.type === 'tr' && n.props['data-env-row'] !== undefined).map(n => n.props['data-env-row']);
const foldRow = (v: TestRenderer.ReactTestRenderer) => v.root.find(n => n.type === 'tr' && n.props['data-session-env-inherited'] !== undefined);
const nodeText = (n: TestRenderer.ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : nodeText(c)).join('');
const toggleInherited = (v: TestRenderer.ReactTestRenderer) => act(() => v.root.findByProps({ 'data-action': 'toggle-inherited' }).props.onClick());

describe('SessionEnvEditor (bot scope)', () => {
  it('shows masked values and offers reveal only to the owner', async () => {
    stubFetch(botView(false));
    const v = await render(React.createElement(SessionEnvEditor, { scope: { kind: 'bot', larkAppId: 'app_a' } }));
    expect(text(v)).not.toContain(SECRET);
    expect(v.root.findAll(n => n.props['data-action'] === 'reveal-env')).toHaveLength(0);
    act(() => v.unmount());

    stubFetch(botView(true));
    const owner = await render(React.createElement(SessionEnvEditor, { scope: { kind: 'bot', larkAppId: 'app_a' } }));
    const reveal = button(row(owner, 'ANTHROPIC_AUTH_TOKEN'), 'reveal-env')[0]!;
    expect(text(owner)).not.toContain(SECRET);
    await act(async () => { await reveal.props.onClick(); });
    expect(text(owner)).toContain(SECRET);
    act(() => owner.unmount());
  });

  it('notifies the Bot payload owner after a successful env save', async () => {
    stubFetch(botView(true));
    const onEnvSaved = vi.fn();
    const v = await render(React.createElement(SessionEnvEditor, { scope: { kind: 'bot', larkAppId: 'app_a', onEnvSaved } }));
    toggleInherited(v);
    await act(async () => { button(row(v, 'LANG'), 'remove-session-env')[0]!.props.onClick(); });
    expect(onEnvSaved).toHaveBeenCalledOnce();
    act(() => v.unmount());
  });

  it('maps row actions to set-layer ops', async () => {
    const fetcher = stubFetch(botView(true));
    const v = await render(React.createElement(SessionEnvEditor, { scope: { kind: 'bot', larkAppId: 'app_a' } }));
    const put = () => fetcher.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'PUT');
    toggleInherited(v);

    // own entry → restore = reset
    await act(async () => { button(row(v, 'ANTHROPIC_AUTH_TOKEN'), 'reset-session-env')[0]!.props.onClick(); });
    // inherited → remove = unset
    await act(async () => { button(row(v, 'LANG'), 'remove-session-env')[0]!.props.onClick(); });
    expect(put().map(c => [c[0], JSON.parse(String((c[1] as RequestInit).body))])).toEqual([
      ['/api/bots/app_a/session-env', { ops: [{ op: 'reset', key: 'ANTHROPIC_AUTH_TOKEN' }] }],
      ['/api/bots/app_a/session-env', { ops: [{ op: 'unset', key: 'LANG' }] }],
    ]);
    // PATH can be overridden, never removed; a value removed by the global layer
    // offers no second remove at bot level.
    expect(button(row(v, 'PATH'), 'remove-session-env')).toHaveLength(0);
    expect(button(row(v, 'PATH'), 'override-session-env')).toHaveLength(1);
    expect(button(row(v, 'BYTECLOUD_AUTH_AS'), 'remove-session-env')).toHaveLength(0);
    act(() => v.unmount());
  });

  it('shows only this layer\'s own entries; everything inherited (incl. the global layer\'s changes) folds into one row', async () => {
    stubFetch(botView(true));
    const v = await render(React.createElement(SessionEnvEditor, { scope: { kind: 'bot', larkAppId: 'app_a' } }));
    expect(shownRows(v)).toEqual(['ANTHROPIC_AUTH_TOKEN']);
    expect(foldRow(v).props['data-session-env-inherited']).toBe('closed');
    // 摘要里点明有几条来自全局层的设置 / 去掉，不点开也知道。
    expect(nodeText(foldRow(v))).toContain(zh('sessionEnv.inheritedShowGlobal', { count: 5, global: 2 }));

    toggleInherited(v);
    // 展开后全局层的改动排在宿主继承前面。
    expect(shownRows(v)).toEqual(['ANTHROPIC_AUTH_TOKEN', 'BYTECLOUD_AUTH_AS', 'HTTPS_PROXY', 'EDITOR', 'LANG', 'PATH']);
    expect(foldRow(v).props['data-session-env-inherited']).toBe('open');
    toggleInherited(v);
    expect(shownRows(v)).toEqual(['ANTHROPIC_AUTH_TOKEN']);
    act(() => v.unmount());
  });

  it('searches the folded variables too, without expanding first', async () => {
    stubFetch(botView(true));
    const v = await render(React.createElement(SessionEnvEditor, { scope: { kind: 'bot', larkAppId: 'app_a' } }));
    act(() => v.root.findByProps({ 'data-input': 'session-env-filter' }).props.onChange({ currentTarget: { value: 'lan' } }));
    expect(shownRows(v)).toEqual(['LANG']);
    expect(button(row(v, 'LANG'), 'remove-session-env')).toHaveLength(1);
    act(() => v.root.findByProps({ 'data-input': 'session-env-filter' }).props.onChange({ currentTarget: { value: '' } }));
    expect(shownRows(v)).toEqual(['ANTHROPIC_AUTH_TOKEN']);
    act(() => v.unmount());
  });

  it('refuses identity-wrapper names before sending (set or pasted)', async () => {
    const fetcher = stubFetch(botView(true));
    const v = await render(React.createElement(SessionEnvEditor, { scope: { kind: 'bot', larkAppId: 'app_a' } }));
    act(() => v.root.findByProps({ 'data-action': 'add-session-env' }).props.onClick());
    act(() => v.root.findByProps({ 'data-input': 'session-env-key' }).props.onChange({ currentTarget: { value: 'ZDOTDIR' } }));
    expect(v.root.findByProps({ 'data-action': 'submit-session-env' }).props.disabled).toBe(true);
    act(() => v.root.findByProps({ 'data-input': 'session-env-key' }).props.onChange({ currentTarget: { value: 'MY_VAR' } }));
    expect(v.root.findByProps({ 'data-action': 'submit-session-env' }).props.disabled).toBe(false);
    act(() => v.root.findByProps({ 'data-action': 'paste-session-env' }).props.onClick());
    act(() => v.root.findByProps({ 'data-input': 'session-env-paste' }).props.onChange({ currentTarget: { value: 'BASH_ENV=/x\nOK=1' } }));
    expect(v.root.findByProps({ 'data-action': 'submit-session-env-paste' }).props.disabled).toBe(true);
    expect(fetcher.mock.calls.some(c => (c[1] as RequestInit | undefined)?.method === 'PUT')).toBe(false);
    act(() => v.unmount());
  });

  it('lists only the running sessions that still use the old environment', async () => {
    stubFetch(botView(true));
    const v = await render(React.createElement(SessionEnvEditor, { scope: { kind: 'bot', larkAppId: 'app_a' } }));
    const stale = v.root.find(n => n.props['data-session-env-stale'] === '');
    expect(stale.findAll(n => n.props.className === 'se-stale-title').map(n => n.props.children)).toEqual(['old topic']);
    act(() => v.unmount());
  });

  it('saves the inheritance mode through the existing env-policy route', async () => {
    const fetcher = stubFetch(botView(true));
    const onPolicySaved = vi.fn();
    const v = await render(React.createElement(SessionEnvEditor, { scope: { kind: 'bot', larkAppId: 'app_a', onPolicySaved } }));
    act(() => v.root.findByProps({ 'data-input': 'envPolicyMode' }).props.onChange({ currentTarget: { value: 'strict' } }));
    act(() => v.root.findByProps({ 'data-input': 'envPolicyNames' }).props.onChange({ currentTarget: { value: 'HTTPS_PROXY, NO_PROXY' } }));
    await act(async () => { await v.root.findByProps({ 'data-action': 'save-env-policy' }).props.onClick(); });
    expect(fetcher).toHaveBeenCalledWith('/api/bots/app_a/env-policy', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ envPolicy: { mode: 'strict', inherit: ['HTTPS_PROXY', 'NO_PROXY'] } }),
    }));
    expect(onPolicySaved).toHaveBeenCalledWith({ mode: 'strict', inherit: ['HTTPS_PROXY', 'NO_PROXY'] });
    act(() => v.unmount());
  });
});

describe('SessionEnvEditor (global scope)', () => {
  it('shows only the global entries and keeps both tmux server tables collapsed until opened', async () => {
    stubFetch({
      ok: true,
      scope: 'global',
      canReveal: true,
      reserved: { keys: ['TMPDIR'], prefixes: ['BOTMUX'] },
      redactedHostKeys: [],
      conflicts: [],
      sessions: [],
      rows: [
        { key: 'EDITOR', state: 'inherited', source: 'host', value: 'vim' },
        { key: 'HTTPS_PROXY', state: 'set', source: 'global', entry: 'set', value: 'http://proxy.example.com:8080' },
        { key: 'LANG', state: 'inherited', source: 'host', value: 'C' },
      ],
      tmuxServers: [
        { socket: null, managed: false, found: true, vars: [{ key: 'A', value: '1' }] },
        { socket: 'botmux', managed: true, found: true, vars: [{ key: 'B', value: '2' }] },
      ],
    });
    const v = await render(React.createElement(SessionEnvEditor, { scope: { kind: 'global' } }));
    expect(shownRows(v)).toEqual(['HTTPS_PROXY']);
    expect(nodeText(foldRow(v))).toContain(zh('sessionEnv.inheritedShow', { count: 2 }));
    const tmux = v.root.find(n => n.props['data-session-env-tmux'] === '');
    const servers = tmux.findAll(n => n.type === 'details');
    expect(servers).toHaveLength(2);
    expect(servers.map(d => !!d.props.open)).toEqual([false, false]);
    // 表格还在，展开就能看到并移除（<details> 的展开由浏览器负责）。
    expect(tmux.findAll(n => n.type === 'tr').map(n => nodeText(n.findAll(c => c.type === 'td')[0]!))).toEqual(['A', 'B']);
    act(() => v.unmount());
  });
});

describe('SessionEnvLiveModal', () => {
  it('marks a stale session, and says when a session was never stamped', async () => {
    const live = (stale: boolean | null) => ({ ok: true, pid: 42, backendType: 'tmux', stale, rows: [{ key: 'A', value: '1', source: 'host' }], missingSetKeys: [] });
    for (const [stale, staleCount, unrecordedCount] of [[true, 1, 0], [null, 0, 1], [false, 0, 0]] as const) {
      stubFetch({}, { 'GET /api/bots/app_a/sessions/s1/env': live(stale) });
      const v = await render(React.createElement(SessionEnvLiveModal, { open: true, larkAppId: 'app_a', sessionId: 's1', onClose: () => {} }));
      await act(async () => { await new Promise(r => setTimeout(r, 0)); });
      expect(v.root.findAll(n => n.props['data-live-env-stale'] === '')).toHaveLength(staleCount);
      expect(v.root.findAll(n => n.props['data-live-env-unrecorded'] === '')).toHaveLength(unrecordedCount);
      act(() => v.unmount());
    }
  });

  it('explains why a session environment cannot be read', async () => {
    stubFetch({}, { 'GET /api/bots/app_a/sessions/s1/env': { ok: false, error: 'unsupported_platform' } });
    const v = await render(React.createElement(SessionEnvLiveModal, { open: true, larkAppId: 'app_a', sessionId: 's1', onClose: () => {} }));
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(v.root.findAll(n => n.props['data-live-env-error'] === 'unsupported_platform')).toHaveLength(1);
    act(() => v.unmount());
  });
});
