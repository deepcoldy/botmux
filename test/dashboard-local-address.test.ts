import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { LocalAddressSection } from '../src/dashboard/web/bot-defaults-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('hide local addresses toggle', () => {
  it('starts off, saves the bot preference, reflects refreshes and rolls back failures', async () => {
    const patchBot = vi.fn();
    const putCardPref = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    const props = { bot: { larkAppId: 'app_test' }, patchBot, putCardPref };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(LocalAddressSection, props as any)); });
    const toggle = () => renderer.root.findByProps({ 'data-action': 'toggle-hide-local-addresses' });
    expect(toggle().props.checked).toBe(false);
    await act(async () => { toggle().props.onChange({ currentTarget: { checked: true } }); });
    expect(putCardPref).toHaveBeenCalledWith({ hideLocalAddresses: true });
    expect(patchBot).toHaveBeenCalledWith('app_test', { hideLocalAddresses: true });
    expect(toggle().props.checked).toBe(true);
    putCardPref.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { toggle().props.onChange({ currentTarget: { checked: false } }); });
    expect(toggle().props.checked).toBe(true);
    expect(patchBot).toHaveBeenCalledTimes(1);
    await act(async () => { renderer.update(React.createElement(LocalAddressSection, { ...props, bot: { larkAppId: 'app_test', hideLocalAddresses: false } } as any)); });
    expect(toggle().props.checked).toBe(false);
    await act(async () => { renderer.unmount(); });
  });
});
