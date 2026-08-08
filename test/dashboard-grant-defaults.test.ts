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

function submitDefaults(root: TestRenderer.ReactTestInstance): void {
  root.findByProps({ className: 'bd-grant-defaults' }).props.onSubmit({
    preventDefault: vi.fn(),
  });
}

describe('dashboard grant defaults', () => {
  const previousFetch = globalThis.fetch;

  afterEach(() => {
    (globalThis as any).fetch = previousFetch;
    vi.restoreAllMocks();
  });

  it('keeps the original blank-quota interaction and adds the duration selector', () => {
    const { root } = renderGrantSection();
    expect(root.findByProps({ 'data-input': 'grantDefaultDurationMs' }).props.value).toBe(String(HOUR));
    expect(root.findByProps({ 'data-input': 'quotaLimit' }).props.value).toBe('');
    expect(root.findByProps({ 'data-input': 'quotaLimit' }).props.disabled).toBe(false);
    expect(root.findByProps({ 'data-input': 'quotaLimit' }).props.placeholder).toBe('留空＝授权卡每人 3 条');
    expect(root.findByProps({ 'data-input': 'quotaLimit' }).props['aria-label']).toBe('默认消息额度');
    expect(root.findByProps({ 'data-input': 'quotaLimit' }).props['aria-describedby']).toBe('grant-defaults-state');
    expect(root.findAllByProps({ 'data-action': 'toggle-grant-quota-oncall' })).toHaveLength(0);
    expect(root.findByProps({ className: 'bd-grant-defaults' }).props.noValidate).toBe(true);
    expect(root.findByProps({ 'data-grant-defaults-state': true }).children.join('')).toContain('1 小时 · 授权卡每人 3 条；Oncall 不限');
    expect(root.findByProps({ 'data-action': 'save-grant-defaults' }).props.disabled).toBe(true);
    expect(root.findAllByProps({ 'data-action': 'reset-grant-defaults' })).toHaveLength(0);
  });

  it('saves changed duration and quota in one patch', async () => {
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
          grantDefaultDurationMs: 8 * HOUR,
          messageQuotaDefaultLimit: 5,
        }),
      } as any;
    });

    const { root, patchBot } = renderGrantSection();
    act(() => root.findByProps({ dataInput: 'grantDefaultDurationMs' }).props.onChange(String(8 * HOUR)));
    act(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onChange({ currentTarget: { value: '5' } }));
    await flushAction(() => submitDefaults(root));

    expect(requests).toEqual([{
      url: '/api/bots/app_grant/grant-prefs',
      body: { grantDefaultDurationMs: 8 * HOUR, messageQuotaDefaultLimit: 5 },
    }]);
    expect(patchBot).toHaveBeenCalledWith('app_grant', expect.objectContaining({
      grantDefaultDurationMs: 8 * HOUR,
      messageQuotaDefaultLimit: 5,
    }));
    expect(root.findByProps({ 'data-grant-defaults-state': true }).children.join('')).toContain('8 小时 · 每人 5 条（授权卡与 Oncall）');
    expect(root.findByProps({ 'data-action': 'save-grant-defaults' }).props.disabled).toBe(true);
  });

  it('restores both built-in defaults through the familiar fields', async () => {
    const requests: any[] = [];
    (globalThis as any).fetch = vi.fn(async (_url: string, init?: any) => {
      requests.push(JSON.parse(init?.body ?? '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          autoGrantRequestCards: true,
          restrictGrantCommands: false,
          grantDefaultDurationMs: null,
          messageQuotaDefaultLimit: null,
        }),
      } as any;
    });

    const { root } = renderGrantSection({ grantDefaultDurationMs: 24 * HOUR, messageQuotaDefaultLimit: 12 });
    act(() => root.findByProps({ dataInput: 'grantDefaultDurationMs' }).props.onChange(String(HOUR)));
    act(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onChange({ currentTarget: { value: '' } }));
    await flushAction(() => submitDefaults(root));

    expect(requests).toEqual([{ grantDefaultDurationMs: null, messageQuotaDefaultLimit: null }]);
    expect(root.findByProps({ 'data-input': 'grantDefaultDurationMs' }).props.value).toBe(String(HOUR));
    expect(root.findByProps({ 'data-input': 'quotaLimit' }).props.value).toBe('');
  });

  it('keeps unsaved drafts when saving fails', async () => {
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, error: 'write_failed' }),
    } as any));

    const { root } = renderGrantSection();
    act(() => root.findByProps({ dataInput: 'grantDefaultDurationMs' }).props.onChange(String(7 * 24 * HOUR)));
    act(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onChange({ currentTarget: { value: '9' } }));
    await flushAction(() => submitDefaults(root));

    expect(root.findByProps({ 'data-input': 'grantDefaultDurationMs' }).props.value).toBe(String(7 * 24 * HOUR));
    expect(root.findByProps({ 'data-input': 'quotaLimit' }).props.value).toBe('9');
    expect(root.findByProps({ 'data-grant-defaults-state': true }).children.join('')).toContain('1 小时 · 授权卡每人 3 条');
    expect(root.findByProps({ 'data-grant-status': '' }).children.join('')).toContain('write_failed');
  });

  it('keeps unsaved limit drafts when a toggle prop changes', () => {
    const initialBot = { larkAppId: 'app_grant', autoGrantRequestCards: true };
    const { renderer, root, patchBot } = renderGrantSection(initialBot);
    act(() => root.findByProps({ dataInput: 'grantDefaultDurationMs' }).props.onChange(String(8 * HOUR)));
    act(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onChange({ currentTarget: { value: '9' } }));

    act(() => {
      renderer.update(React.createElement(GrantSection, {
        bot: { ...initialBot, autoGrantRequestCards: false },
        patchBot,
      }));
    });

    expect(root.findByProps({ 'data-input': 'grantDefaultDurationMs' }).props.value).toBe(String(8 * HOUR));
    expect(root.findByProps({ 'data-input': 'quotaLimit' }).props.value).toBe('9');
    expect(root.findByProps({ 'data-action': 'save-grant-defaults' }).props.disabled).toBe(false);
  });

  it('preserves a legacy quota above the editor limit when only duration changes', async () => {
    const requests: any[] = [];
    (globalThis as any).fetch = vi.fn(async (_url: string, init?: any) => {
      requests.push(JSON.parse(init?.body ?? '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          autoGrantRequestCards: true,
          restrictGrantCommands: false,
          grantDefaultDurationMs: 8 * HOUR,
          messageQuotaDefaultLimit: 5000,
        }),
      } as any;
    });
    const { root } = renderGrantSection({ messageQuotaDefaultLimit: 5000 });
    act(() => root.findByProps({ dataInput: 'grantDefaultDurationMs' }).props.onChange(String(8 * HOUR)));

    await flushAction(() => submitDefaults(root));

    expect(requests).toEqual([{ grantDefaultDurationMs: 8 * HOUR }]);
    expect(root.findByProps({ 'data-input': 'quotaLimit' }).props.value).toBe('5000');
    expect(root.findByProps({ 'data-grant-defaults-state': true }).children.join('')).toContain('授权卡 1000 条；Oncall 5000 条');
  });

  it('keeps an edited three-message quota explicit so oncall remains limited', async () => {
    const requests: any[] = [];
    (globalThis as any).fetch = vi.fn(async (_url: string, init?: any) => {
      requests.push(JSON.parse(init?.body ?? '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          autoGrantRequestCards: true,
          restrictGrantCommands: false,
          grantDefaultDurationMs: null,
          messageQuotaDefaultLimit: 3,
        }),
      } as any;
    });
    const { root } = renderGrantSection({ messageQuotaDefaultLimit: 5 });
    act(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onChange({ currentTarget: { value: '3' } }));

    await flushAction(() => submitDefaults(root));

    expect(requests).toEqual([{ messageQuotaDefaultLimit: 3 }]);
    expect(root.findByProps({ 'data-grant-defaults-state': true }).children.join('')).toContain('每人 3 条（授权卡与 Oncall）');
  });

  it('clears a custom quota back to card-only three messages and unlimited oncall', async () => {
    const requests: any[] = [];
    (globalThis as any).fetch = vi.fn(async (_url: string, init?: any) => {
      requests.push(JSON.parse(init?.body ?? '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          autoGrantRequestCards: true,
          restrictGrantCommands: false,
          grantDefaultDurationMs: null,
          messageQuotaDefaultLimit: null,
        }),
      } as any;
    });
    const { root } = renderGrantSection({ messageQuotaDefaultLimit: 3 });
    act(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onChange({ currentTarget: { value: '' } }));

    await flushAction(() => submitDefaults(root));

    expect(requests).toEqual([{ messageQuotaDefaultLimit: null }]);
    expect(root.findByProps({ 'data-input': 'quotaLimit' }).props.value).toBe('');
    expect(root.findByProps({ 'data-grant-defaults-state': true }).children.join('')).toContain('授权卡每人 3 条；Oncall 不限');
  });

  it('shows a field-level accessible error for an invalid quota', () => {
    const { root } = renderGrantSection();
    act(() => root.findByProps({ 'data-input': 'quotaLimit' }).props.onChange({ currentTarget: { value: '1001' } }));

    act(() => submitDefaults(root));

    const input = root.findByProps({ 'data-input': 'quotaLimit' });
    expect(input.props['aria-invalid']).toBe(true);
    expect(input.props['aria-describedby']).toBe('grant-defaults-state grant-default-quota-error');
    expect(root.findByProps({ id: 'grant-default-quota-error' }).props.role).toBe('alert');
  });

});
