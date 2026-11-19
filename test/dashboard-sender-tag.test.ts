import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { SenderTagSection } from '../src/dashboard/web/bot-defaults-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('sender email preference UI', () => {
  it('saves independently while the master is off, reflects refreshes and rolls back failures', async () => {
    const patchBot = vi.fn();
    const putCardPref = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    const props = { bot: { larkAppId: 'app_test', senderTag: false }, patchBot, putCardPref };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(SenderTagSection, props)); });
    const toggle = () => renderer.root.findByProps({ 'data-action': 'toggle-sender-tag-hide-email' });
    expect(toggle().props.checked).toBe(false);
    expect(toggle().props.disabled).toBe(false);
    await act(async () => { toggle().props.onChange({ currentTarget: { checked: true } }); });
    expect(putCardPref).toHaveBeenCalledWith({ senderTagHideEmail: true });
    expect(patchBot).toHaveBeenCalledWith('app_test', { senderTagHideEmail: true });
    expect(toggle().props.checked).toBe(true);
    await act(async () => { renderer.update(React.createElement(SenderTagSection, { ...props, bot: { ...props.bot, senderTagHideEmail: true } })); });
    putCardPref.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { toggle().props.onChange({ currentTarget: { checked: false } }); });
    expect(toggle().props.checked).toBe(true);
    expect(patchBot).toHaveBeenCalledTimes(1);
    await act(async () => { renderer.update(React.createElement(SenderTagSection, { ...props, bot: { ...props.bot, senderTagHideEmail: false } })); });
    expect(toggle().props.checked).toBe(false);
    await act(async () => { renderer.unmount(); });
  });
});
