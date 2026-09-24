import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OncallServiceSecretSettings } from '../src/dashboard/web/bot-defaults-page.js';

let renderer: TestRenderer.ReactTestRenderer;
let fetcher: ReturnType<typeof vi.fn>;
const input = () => renderer.root.findByType('input');
const button = () => renderer.root.findByType('button');
const text = () => JSON.stringify(renderer.toJSON());
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('document', { querySelector: () => ({ getAttribute: () => 'csrf-token' }) });
  fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, configured: true })));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => { renderer = TestRenderer.create(React.createElement(OncallServiceSecretSettings)); });
}
async function submit(value: string) {
  act(() => input().props.onChange({ currentTarget: { value } }));
  await act(async () => { renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
}

describe('Oncall service secret settings', () => {
  it('shows only configuration state, masks input and prevents blank overwrites', async () => {
    await render();
    expect(text()).toContain('已配置');
    expect(input().props.type).toBe('password');
    expect(input().props.autoComplete).toBe('new-password');
    expect(input().props.value).toBe('');
    expect(button().props.disabled).toBe(true);
    await submit('  ');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('sends CSRF with the new secret and clears it after saving', async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, configured: false })));
    await render();
    expect(text()).toContain('未配置');
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, configured: true, restartRequired: true })));
    await submit('new-service-secret');
    expect(fetcher.mock.calls[1]).toEqual(['/api/oncall-service-secret', {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-botmux-csrf': 'csrf-token' },
      body: JSON.stringify({ secret: 'new-service-secret' }),
    }]);
    expect(text()).toContain('已保存，重启 BotMux 后生效');
    expect(input().props.value).toBe('');
    expect(button().props.disabled).toBe(true);
    expect(text()).not.toContain('new-service-secret');
  });

  it('keeps the previous state on save failure and clears the attempted credential', async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, configured: false })));
    await render();
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: '保存失败' }), { status: 503 }));
    await submit('private-secret');
    expect(text()).toContain('未配置');
    expect(text()).toContain('保存失败');
    expect(text()).not.toContain('private-secret');
  });

  it('does not present a failed status read as an unconfigured credential', async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 403 }));
    await render();
    expect(text()).toContain('状态未确认');
    expect(text()).toContain('无法读取凭据状态');
    expect(input().props.disabled).toBe(true);
    expect(button().props.disabled).toBe(true);
  });
});
