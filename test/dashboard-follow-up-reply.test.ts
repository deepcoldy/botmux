import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { CardBehaviorSection, patchCardPrefsFromBody } from '../src/dashboard/web/bot-defaults-page.js';
import type { BotDefaultsRow } from '../src/dashboard/web/bot-defaults.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../src/dashboard/web/toast.js', () => ({ toast: vi.fn() }));

it('shows the mid-turn reply switch with the bot\'s value, saves it, and rolls back a failed save', async () => {
  let fail = false;
  const putCardPref = vi.fn(async () => ({ ok: !fail, status: fail ? 503 : 200, body: {} }));
  const bot: BotDefaultsRow = { larkAppId: 'cli_follow_ui' };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(CardBehaviorSection, { bot, putCardPref })); });
  const toggle = () => renderer.root.findByProps({ 'data-action': 'toggle-follow-up-reply' });
  try {
    expect(toggle().props.checked).toBe(false);
    await act(async () => toggle().props.onChange({ currentTarget: { checked: true } }));
    expect(putCardPref).toHaveBeenLastCalledWith({ followUpReply: true });
    expect(toggle().props.checked).toBe(true);
    fail = true;
    await act(async () => toggle().props.onChange({ currentTarget: { checked: false } }));
    expect(putCardPref).toHaveBeenLastCalledWith({ followUpReply: false });
    expect(toggle().props.checked).toBe(true);
    await act(async () => renderer.update(React.createElement(CardBehaviorSection, { bot: { ...bot, followUpReply: false }, putCardPref })));
    expect(toggle().props.checked).toBe(false);
    await act(async () => renderer.update(React.createElement(CardBehaviorSection, { bot: { ...bot, followUpReply: true }, putCardPref })));
    expect(toggle().props.checked).toBe(true);
    expect(patchCardPrefsFromBody({ ...bot, followUpReply: false }, { followUpReply: true }).followUpReply).toBe(true);
  } finally { await act(async () => renderer.unmount()); }
});
