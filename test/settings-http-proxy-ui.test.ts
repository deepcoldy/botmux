import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { HttpProxyRow, isValidHttpProxy } from '../src/dashboard/web/settings-page.js';
import { normalizeHttpProxy } from '../src/dashboard/settings-write-applier.js';

type RowProps = { value: string; disabled: boolean; onSave(value: string): void };

function render(overrides: Partial<RowProps> = {}) {
  const props: RowProps = { value: '', disabled: false, onSave: vi.fn(), ...overrides };
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(React.createElement(HttpProxyRow, props)); });
  return { renderer, props };
}

const input = (r: TestRenderer.ReactTestRenderer) => r.root.findByProps({ 'data-input': 'httpProxy' });
const saveButton = (r: TestRenderer.ReactTestRenderer) => r.root.findByProps({ 'data-action': 'http-proxy-save' });
const hint = (r: TestRenderer.ReactTestRenderer): string =>
  r.root.findByProps({ 'data-http-proxy-hint': true }).children.join('');

function type(r: TestRenderer.ReactTestRenderer, value: string) {
  act(() => { input(r).props.onChange({ currentTarget: { value } }); });
}

// 前端校验必须与服务端 normalizeHttpProxy 同口径：否则要么放行会被打回的值
// （用户看到裸错误码），要么拦掉服务端本来接受的值。
describe('isValidHttpProxy', () => {
  it('agrees with the server-side normalizer', () => {
    for (const value of [
      'http://127.0.0.1:7890',
      'https://proxy.example.com:8443/',
      'http://user:p%40ss@proxy.example.com:8080',
      '127.0.0.1:7890',
      'socks5://127.0.0.1:1080',
      'http://127.0.0.1:7890/proxy',
      'http://127.0.0.1:7890?x=1',
      'http://',
    ]) {
      expect(isValidHttpProxy(value), value).toBe(normalizeHttpProxy(value) !== null);
    }
  });
});

describe('HttpProxyRow', () => {
  it('shows the env-var fallback when unset and keeps save disabled until edited', () => {
    const { renderer } = render();
    expect(hint(renderer)).toContain('HTTPS_PROXY');
    expect(saveButton(renderer).props.disabled).toBe(true);
  });

  it('saves a valid proxy without its trailing slash', () => {
    const { renderer, props } = render();
    type(renderer, ' http://127.0.0.1:7890/ ');
    expect(saveButton(renderer).props.disabled).toBe(false);
    act(() => { saveButton(renderer).props.onClick(); });
    expect(props.onSave).toHaveBeenCalledWith('http://127.0.0.1:7890');
  });

  it('blocks an invalid proxy and explains the expected form', () => {
    const { renderer, props } = render();
    type(renderer, 'socks5://127.0.0.1:1080');
    expect(saveButton(renderer).props.disabled).toBe(true);
    expect(hint(renderer)).toContain('http://');
    act(() => { saveButton(renderer).props.onClick(); });
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it('clears a configured proxy by saving an empty value', () => {
    const { renderer, props } = render({ value: 'http://127.0.0.1:7890' });
    type(renderer, '');
    act(() => { saveButton(renderer).props.onClick(); });
    expect(props.onSave).toHaveBeenCalledWith('');
  });
});
