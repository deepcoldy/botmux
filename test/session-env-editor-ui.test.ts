import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionEnvEditor, SessionEnvLiveModal } from '../src/dashboard/web/session-env-editor.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());

const SECRET = 'raw-secret-sentinel-9999';

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

  it('maps row actions to set-layer ops', async () => {
    const fetcher = stubFetch(botView(true));
    const v = await render(React.createElement(SessionEnvEditor, { scope: { kind: 'bot', larkAppId: 'app_a' } }));
    const put = () => fetcher.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'PUT');

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
