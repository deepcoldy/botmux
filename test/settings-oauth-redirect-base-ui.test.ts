import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'bun:test';
import {
  OAuthRedirectBaseRow,
  currentBrowserOrigin,
  isValidOAuthRedirectBase,
} from '../src/dashboard/web/settings-page.js';

type RowProps = { value: string; disabled: boolean; onSave(value: string): void };

function render(overrides: Partial<RowProps> = {}) {
  const props: RowProps = { value: '', disabled: false, onSave: vi.fn(), ...overrides };
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(React.createElement(OAuthRedirectBaseRow, props)); });
  return { renderer, props };
}

const input = (r: TestRenderer.ReactTestRenderer) => r.root.findByProps({ 'data-input': 'oauthRedirectBase' });
const saveButton = (r: TestRenderer.ReactTestRenderer) => r.root.findByProps({ 'data-action': 'oauth-redirect-base-save' });
const useCurrentButton = (r: TestRenderer.ReactTestRenderer) => r.root.findByProps({ 'data-action': 'oauth-redirect-base-use-current' });
const hint = (r: TestRenderer.ReactTestRenderer): string =>
  r.root.findByProps({ 'data-oauth-redirect-base-preview': true }).children.join('');

afterEach(() => { vi.unstubAllGlobals(); });

// 前端这份校验必须与服务端 normalizeOAuthRedirectBase 同口径，否则要么放行了会被
// 服务端打回的值（用户看到裸错误码），要么拦掉了服务端本来接受的值。
describe('isValidOAuthRedirectBase', () => {
  it('accepts http(s) origins with or without an explicit port / trailing slash', () => {
    for (const value of [
      'https://botmux.example.com',
      'https://botmux.example.com/',
      'http://10.1.2.3:7891',
      'HTTPS://Botmux.Example.COM',
    ]) {
      expect(isValidOAuthRedirectBase(value), value).toBe(true);
    }
  });

  it('rejects anything that is not a bare http(s) origin', () => {
    for (const value of [
      'botmux.example.com',            // 没有协议
      'ftp://botmux.example.com',      // 非 http(s)
      'https://botmux.example.com/x',  // 带路径：dashboard 是 /oauth/callback 精确匹配
      'https://botmux.example.com?a=1',
      'https://botmux.example.com#a',
      'https://user:pw@botmux.example.com',
      'http://',
      '',
    ]) {
      expect(isValidOAuthRedirectBase(value), value).toBe(false);
    }
  });
});

describe('currentBrowserOrigin', () => {
  it('reads the origin the browser is actually on', () => {
    vi.stubGlobal('location', { href: 'https://m-abc.platform.example/settings?tab=access#x' });
    expect(currentBrowserOrigin()).toBe('https://m-abc.platform.example');
  });

  it('returns empty string outside a browser (no location)', () => {
    vi.stubGlobal('location', undefined);
    expect(currentBrowserOrigin()).toBe('');
  });

  it('refuses non-http(s) origins (file:// page, opaque origin) instead of filling in a dud', () => {
    vi.stubGlobal('location', { href: 'file:///home/me/dashboard.html' });
    expect(currentBrowserOrigin()).toBe('');
    vi.stubGlobal('location', { href: 'about:blank' });
    expect(currentBrowserOrigin()).toBe('');
  });
});

describe('OAuthRedirectBaseRow (dashboard settings)', () => {
  it('shows the resulting callback URL and saves the trimmed value', () => {
    const onSave = vi.fn();
    const { renderer } = render({ onSave });

    act(() => input(renderer).props.onChange({ currentTarget: { value: '  https://botmux.example.com/  ' } }));
    expect(hint(renderer)).toContain('https://botmux.example.com/oauth/callback');

    act(() => saveButton(renderer).props.onClick());
    expect(onSave).toHaveBeenCalledWith('https://botmux.example.com');
  });

  it('blocks the save button on an invalid base and explains why', () => {
    const onSave = vi.fn();
    const { renderer } = render({ onSave });

    act(() => input(renderer).props.onChange({ currentTarget: { value: 'https://botmux.example.com/sub/path' } }));
    expect(saveButton(renderer).props.disabled).toBe(true);
    expect(hint(renderer)).toContain('路径');

    act(() => saveButton(renderer).props.onClick());
    expect(onSave).not.toHaveBeenCalled();
  });

  it('an empty value is a valid save: it clears the setting', () => {
    const onSave = vi.fn();
    const { renderer } = render({ value: 'https://botmux.example.com', onSave });

    act(() => input(renderer).props.onChange({ currentTarget: { value: '' } }));
    expect(saveButton(renderer).props.disabled).toBe(false);
    act(() => saveButton(renderer).props.onClick());
    expect(onSave).toHaveBeenCalledWith('');
  });

  it('「用当前访问地址填入」 fills the browser origin — the one signal the server cannot derive', () => {
    // 中心化平台的隧道重写 Host 且不带 X-Forwarded-Host，服务端只会推成回环地址；
    // 浏览器自己最清楚它是从哪个 origin 打开的，这颗按钮的全部价值就在这儿。
    vi.stubGlobal('location', { href: 'https://m-abc.platform.example/settings' });
    const onSave = vi.fn();
    const { renderer } = render({ onSave });

    act(() => useCurrentButton(renderer).props.onClick());
    expect(input(renderer).props.value).toBe('https://m-abc.platform.example');
    act(() => saveButton(renderer).props.onClick());
    expect(onSave).toHaveBeenCalledWith('https://m-abc.platform.example');
  });

  it('read-only visitors cannot edit or save', () => {
    vi.stubGlobal('location', { href: 'https://m-abc.platform.example/settings' });
    const onSave = vi.fn();
    const { renderer } = render({ value: 'https://botmux.example.com', disabled: true, onSave });

    expect(input(renderer).props.disabled).toBe(true);
    expect(saveButton(renderer).props.disabled).toBe(true);
    expect(useCurrentButton(renderer).props.disabled).toBe(true);
  });
});
