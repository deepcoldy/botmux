import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrantSection } from '../src/dashboard/web/bot-defaults-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const HOUR = 60 * 60 * 1000;

function renderGrantSection(bot: Record<string, any> = {}, patchBot = vi.fn()) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(GrantSection, {
      bot: { larkAppId: 'app_grant', ...bot },
      patchBot,
    }));
  });
  return { renderer, root: renderer.root, patchBot };
}

async function flushAction(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('dashboard grant defaults', () => {
  const previousFetch = globalThis.fetch;

  function installServer(initial: { duration?: number | null; quota?: number | null } = {}) {
    let duration = initial.duration ?? null;
    let quota = initial.quota ?? null;
    const requests: Array<{ url: string; body: any }> = [];
    (globalThis as any).fetch = vi.fn(async (url: string, init?: any) => {
      const body = JSON.parse(init?.body ?? '{}');
      requests.push({ url, body });
      if ('grantDefaultDurationMs' in body) duration = body.grantDefaultDurationMs;
      if ('messageQuotaDefaultLimit' in body) quota = body.messageQuotaDefaultLimit;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          autoGrantRequestCards: true,
          restrictGrantCommands: false,
          grantDefaultDurationMs: duration,
          messageQuotaDefaultLimit: quota,
        }),
      } as any;
    });
    return requests;
  }

  afterEach(() => {
    (globalThis as any).fetch = previousFetch;
    vi.restoreAllMocks();
  });

  it('shows the built-in values without save or reset buttons', () => {
    const requests = installServer();
    const { root } = renderGrantSection();
    expect(root.findByProps({ 'data-input': 'grantDefaultDurationMs' }).props.value).toBe(String(HOUR));
    expect(root.findByProps({ 'data-input': 'quotaLimit' }).props.value).toBe('');
    expect(root.findByProps({ 'data-input': 'quotaLimit' }).props.disabled).toBe(false);
    expect(root.findByProps({ 'data-input': 'quotaLimit' }).props.placeholder).toBe('留空＝内置默认：授权卡每人 3 条');
    expect(root.findByProps({ 'data-input': 'quotaLimit' }).props['aria-label']).toBe('消息额度覆盖');
    expect(root.findByProps({ 'data-input': 'quotaLimit' }).props['aria-describedby']).toBe('grant-defaults-state');
    expect(root.findAllByProps({ 'data-action': 'toggle-grant-quota-oncall' })).toHaveLength(0);
    expect(root.findByProps({ className: 'bd-grant-defaults' }).props.noValidate).toBe(true);
    expect(root.findByProps({ 'data-grant-defaults-state': true }).children.join('')).toContain('当前内置默认：1 小时 · 授权卡每人 3 条；Oncall 不限');
    expect(root.findAllByProps({ 'data-action': 'save-grant-defaults' })).toHaveLength(0);
    expect(root.findAllByProps({ 'data-action': 'reset-grant-defaults' })).toHaveLength(0);
    act(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onBlur());
    expect(requests).toHaveLength(0);
  });

  it('auto-saves duration selections and maps one hour back to the built-in value', async () => {
    const requests = installServer();
    const { root, patchBot } = renderGrantSection();
    await flushAction(() => root.findByProps({ dataInput: 'grantDefaultDurationMs' }).props.onChange(String(8 * HOUR)));

    expect(requests.map(request => request.body)).toEqual([{ grantDefaultDurationMs: 8 * HOUR }]);
    expect(patchBot).toHaveBeenCalledWith('app_grant', expect.objectContaining({
      grantDefaultDurationMs: 8 * HOUR,
    }));
    expect(root.findByProps({ 'data-grant-defaults-state': true }).children.join(''))
      .toContain('当前自定义：8 小时 · 消息额度为内置默认');
    expect(root.findAllByProps({ 'data-action': 'save-grant-defaults' })).toHaveLength(0);
    expect(root.findAllByProps({ 'data-action': 'reset-grant-defaults' })).toHaveLength(0);
    await flushAction(() => root.findByProps({ dataInput: 'grantDefaultDurationMs' }).props.onChange(String(HOUR)));
    expect(requests.map(request => request.body)).toEqual([
      { grantDefaultDurationMs: 8 * HOUR },
      { grantDefaultDurationMs: null },
    ]);
  });

  it('keeps quota as a draft until blur, then auto-saves it', async () => {
    const requests = installServer();
    const { root } = renderGrantSection();
    act(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onChange({ currentTarget: { value: '5' } }));
    expect(requests).toHaveLength(0);

    await flushAction(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onBlur());

    expect(requests.map(request => request.body)).toEqual([{ messageQuotaDefaultLimit: 5 }]);
    expect(root.findByProps({ 'data-grant-defaults-state': true }).children.join(''))
      .toContain('当前自定义：1 小时 · 每人 5 条（授权卡与 Oncall）');
  });

  it('submits quota through Enter by blurring exactly once', async () => {
    const requests = installServer({ quota: 5 });
    const { root } = renderGrantSection({ messageQuotaDefaultLimit: 5 });
    act(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onChange({ currentTarget: { value: '6' } }));
    const preventDefault = vi.fn();
    const blur = vi.fn(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onBlur());

    await flushAction(() => {
      root.findByProps({ 'data-input': 'quotaLimit' }).props.onKeyDown({
        key: 'Enter',
        preventDefault,
        currentTarget: { blur },
      });
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(blur).toHaveBeenCalledOnce();
    expect(requests.map(request => request.body)).toEqual([{ messageQuotaDefaultLimit: 6 }]);
  });

  it('clears a custom quota on blur and explains that this restores the built-in value', async () => {
    const requests = installServer({ quota: 10 });
    const { root } = renderGrantSection({ messageQuotaDefaultLimit: 10 });
    const quotaTip = root.findAll(node => String(node.props['aria-label'] ?? '').includes('当前使用自定义额度'))[0];
    expect(quotaTip.props['aria-label']).toContain('清空输入框并离开后');
    expect(quotaTip.props['aria-label']).toContain('授权卡恢复每人 3 条');

    act(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onChange({ currentTarget: { value: '' } }));
    expect(requests).toHaveLength(0);
    await flushAction(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onBlur());

    expect(requests.map(request => request.body)).toEqual([{ messageQuotaDefaultLimit: null }]);
    expect(root.findByProps({ 'data-grant-defaults-state': true }).children.join(''))
      .toContain('当前内置默认：1 小时 · 授权卡每人 3 条；Oncall 不限');
  });

  it('keeps an edited three-message quota explicit so oncall remains limited', async () => {
    const requests = installServer({ quota: 5 });
    const { root } = renderGrantSection({ messageQuotaDefaultLimit: 5 });
    act(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onChange({ currentTarget: { value: '3' } }));
    await flushAction(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onBlur());

    expect(requests.map(request => request.body)).toEqual([{ messageQuotaDefaultLimit: 3 }]);
    expect(root.findByProps({ 'data-grant-defaults-state': true }).children.join(''))
      .toContain('当前自定义：1 小时 · 每人 3 条（授权卡与 Oncall）');
  });

  it('rolls a failed duration selection back so the same choice can be retried', async () => {
    let fail = true;
    (globalThis as any).fetch = vi.fn(async (_url: string, init?: any) => {
      const body = JSON.parse(init?.body ?? '{}');
      if (fail) return {
        ok: false,
        status: 500,
        json: async () => ({ ok: false, error: 'duration_failed' }),
      } as any;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          autoGrantRequestCards: true,
          restrictGrantCommands: false,
          grantDefaultDurationMs: body.grantDefaultDurationMs,
          messageQuotaDefaultLimit: null,
        }),
      } as any;
    });
    const { root } = renderGrantSection();

    await flushAction(() => root.findByProps({ dataInput: 'grantDefaultDurationMs' }).props.onChange(String(8 * HOUR)));
    expect(root.findByProps({ 'data-input': 'grantDefaultDurationMs' }).props.value).toBe(String(HOUR));
    expect(root.findByProps({ 'data-grant-status': '' }).children.join('')).toContain('duration_failed');

    fail = false;
    await flushAction(() => root.findByProps({ dataInput: 'grantDefaultDurationMs' }).props.onChange(String(8 * HOUR)));
    expect(root.findByProps({ 'data-input': 'grantDefaultDurationMs' }).props.value).toBe(String(8 * HOUR));
    expect((globalThis.fetch as any).mock.calls).toHaveLength(2);
  });

  it('disables the limit fields while an auto-save request is in flight', async () => {
    let resolveFetch!: () => void;
    (globalThis as any).fetch = vi.fn(() => new Promise(resolve => {
      resolveFetch = () => resolve({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          autoGrantRequestCards: true,
          restrictGrantCommands: false,
          grantDefaultDurationMs: 8 * HOUR,
          messageQuotaDefaultLimit: null,
        }),
      } as any);
    }));
    const { root } = renderGrantSection();

    act(() => root.findByProps({ dataInput: 'grantDefaultDurationMs' }).props.onChange(String(8 * HOUR)));
    expect(root.findByProps({ dataInput: 'grantDefaultDurationMs' }).props.disabled).toBe(true);
    expect(root.findByProps({ 'data-input': 'quotaLimit' }).props.disabled).toBe(true);
    expect(root.findByProps({ 'data-grant-status': '' }).children.join('')).toContain('保存中');

    await act(async () => {
      resolveFetch();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(root.findByProps({ dataInput: 'grantDefaultDurationMs' }).props.disabled).toBe(false);
    expect(root.findByProps({ 'data-input': 'quotaLimit' }).props.disabled).toBe(false);
  });

  it('keeps a failed quota draft and retries it on the next blur', async () => {
    let fail = true;
    (globalThis as any).fetch = vi.fn(async () => {
      if (fail) return {
        ok: false,
        status: 500,
        json: async () => ({ ok: false, error: 'quota_failed' }),
      } as any;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          autoGrantRequestCards: true,
          restrictGrantCommands: false,
          grantDefaultDurationMs: null,
          messageQuotaDefaultLimit: 9,
        }),
      } as any;
    });
    const { root } = renderGrantSection({ messageQuotaDefaultLimit: 10 });
    act(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onChange({ currentTarget: { value: '9' } }));

    await flushAction(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onBlur());
    expect(root.findByProps({ 'data-input': 'quotaLimit' }).props.value).toBe('9');
    expect(root.findByProps({ 'data-grant-defaults-state': true }).children.join(''))
      .toContain('当前自定义：1 小时 · 每人 10 条');
    expect(root.findByProps({ 'data-grant-status': '' }).children.join('')).toContain('quota_failed');

    fail = false;
    await flushAction(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onBlur());
    expect(root.findByProps({ 'data-grant-defaults-state': true }).children.join(''))
      .toContain('当前自定义：1 小时 · 每人 9 条');
    expect((globalThis.fetch as any).mock.calls).toHaveLength(2);
  });

  it('keeps an unsaved quota draft when a toggle prop changes', () => {
    const initialBot = { larkAppId: 'app_grant', autoGrantRequestCards: true };
    const { renderer, root, patchBot } = renderGrantSection(initialBot);
    act(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onChange({ currentTarget: { value: '9' } }));

    act(() => {
      renderer.update(React.createElement(GrantSection, {
        bot: { ...initialBot, autoGrantRequestCards: false },
        patchBot,
      }));
    });

    expect(root.findByProps({ 'data-input': 'quotaLimit' }).props.value).toBe('9');
    expect(root.findAllByProps({ 'data-action': 'save-grant-defaults' })).toHaveLength(0);
    expect(root.findAllByProps({ 'data-action': 'reset-grant-defaults' })).toHaveLength(0);
  });

  it('keeps an uncommitted quota draft when duration auto-save succeeds', async () => {
    const requests = installServer();
    const { root } = renderGrantSection();
    act(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onChange({ currentTarget: { value: '9' } }));

    await flushAction(() => root.findByProps({ dataInput: 'grantDefaultDurationMs' }).props.onChange(String(8 * HOUR)));

    expect(requests.map(request => request.body)).toEqual([{ grantDefaultDurationMs: 8 * HOUR }]);
    expect(root.findByProps({ 'data-input': 'quotaLimit' }).props.value).toBe('9');
  });

  it('preserves a legacy quota above the editor limit when only duration changes', async () => {
    const requests = installServer({ quota: 5000 });
    const { root } = renderGrantSection({ messageQuotaDefaultLimit: 5000 });
    act(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onBlur());
    expect(requests).toHaveLength(0);
    expect(root.findByProps({ 'data-input': 'quotaLimit' }).props['aria-invalid']).toBeUndefined();

    await flushAction(() => root.findByProps({ dataInput: 'grantDefaultDurationMs' }).props.onChange(String(8 * HOUR)));

    expect(requests.map(request => request.body)).toEqual([{ grantDefaultDurationMs: 8 * HOUR }]);
    expect(root.findByProps({ 'data-input': 'quotaLimit' }).props.value).toBe('5000');
    expect(root.findByProps({ 'data-grant-defaults-state': true }).children.join('')).toContain('授权卡 1000 条；Oncall 5000 条');
    const quotaTip = root.findAll(node => String(node.props['aria-label'] ?? '').includes('当前使用兼容旧配置'))[0];
    expect(quotaTip.props['aria-label']).toContain('授权卡每人 1000 条');
    expect(quotaTip.props['aria-label']).toContain('Oncall 每人 5000 条');
  });

  it('saves the DM-open toggle through the grant-prefs endpoint', async () => {
    const requests: Array<{ url: string; body: any }> = [];
    (globalThis as any).fetch = vi.fn(async (url: string, init?: any) => {
      requests.push({ url, body: JSON.parse(init?.body ?? '{}') });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          autoGrantRequestCards: true,
          restrictGrantCommands: false,
          p2pOpen: true,
          grantDefaultDurationMs: null,
          messageQuotaDefaultLimit: null,
        }),
      } as any;
    });

    const { root, patchBot } = renderGrantSection();
    const toggle = root.findByProps({ 'data-action': 'toggle-p2p-open' });
    expect(toggle.props.checked).toBe(false);
    await flushAction(() => toggle.props.onChange({ currentTarget: { checked: true } }));

    expect(requests).toEqual([{ url: '/api/bots/app_grant/grant-prefs', body: { p2pOpen: true } }]);
    expect(patchBot).toHaveBeenCalledWith('app_grant', expect.objectContaining({ p2pOpen: true }));
    expect(root.findByProps({ 'data-action': 'toggle-p2p-open' }).props.checked).toBe(true);
  });

  it('rolls the DM-open toggle back when the save fails', async () => {
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, error: 'write_failed' }),
    } as any));

    const { root } = renderGrantSection({ p2pOpen: true });
    const toggle = root.findByProps({ 'data-action': 'toggle-p2p-open' });
    expect(toggle.props.checked).toBe(true);
    await flushAction(() => toggle.props.onChange({ currentTarget: { checked: false } }));

    // A failed write must not leave the UI claiming DMs are closed.
    expect(root.findByProps({ 'data-action': 'toggle-p2p-open' }).props.checked).toBe(true);
    expect(root.findByProps({ 'data-grant-status': '' }).children.join('')).toContain('write_failed');
  });

  it('keeps p2pOpen on when another grant pref is saved (response is a full snapshot)', async () => {
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        autoGrantRequestCards: true,
        restrictGrantCommands: true,
        p2pOpen: true,
        grantDefaultDurationMs: null,
        messageQuotaDefaultLimit: null,
      }),
    } as any));

    // Local state says DMs are closed, but the authoritative post-write snapshot
    // says they are open (another admin / the IM config card flipped it in between).
    const { root, patchBot } = renderGrantSection({ p2pOpen: false });
    await flushAction(() => root
      .findByProps({ 'data-action': 'toggle-restrict-grant' })
      .props.onChange({ currentTarget: { checked: true } }));

    // savePatch refills every field from the response, so the toggle must follow
    // the snapshot instead of keeping a stale "closed" reading of the DM gate.
    expect(root.findByProps({ 'data-action': 'toggle-p2p-open' }).props.checked).toBe(true);
    expect(patchBot).toHaveBeenCalledWith('app_grant', expect.objectContaining({ p2pOpen: true }));
  });

  it('shows a field-level accessible error for an invalid quota', () => {
    (globalThis as any).fetch = vi.fn();
    const { root } = renderGrantSection();
    act(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onChange({ currentTarget: { value: '1001' } }));
    act(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onBlur());

    const input = root.findByProps({ 'data-input': 'quotaLimit' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(input.props['aria-invalid']).toBe(true);
    expect(input.props['aria-describedby']).toBe('grant-defaults-state grant-default-quota-error');
    expect(root.findByProps({ id: 'grant-default-quota-error' }).props.role).toBe('alert');
  });

  it('does not clear a quota error when duration auto-save succeeds', async () => {
    installServer();
    const { root } = renderGrantSection();
    act(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onChange({ currentTarget: { value: '1001' } }));
    act(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onBlur());
    expect(root.findByProps({ id: 'grant-default-quota-error' }).props.role).toBe('alert');

    await flushAction(() => root.findByProps({ dataInput: 'grantDefaultDurationMs' }).props.onChange(String(8 * HOUR)));
    expect(root.findByProps({ id: 'grant-default-quota-error' }).props.role).toBe('alert');
  });

});
