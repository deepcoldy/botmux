import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { CardBehaviorSection, patchCardPrefsFromBody } from '../src/dashboard/web/bot-defaults-page.js';
import type { BotDefaultsRow } from '../src/dashboard/web/bot-defaults.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../src/dashboard/web/toast.js', () => ({ toast: vi.fn() }));

describe('foldBackgroundUpdates Dashboard toggle', () => {
  it('shows the switch with the bot value, saves it, rolls back failed saves, and syncs across bot switches', async () => {
    let fail = false;
    const putCardPref = vi.fn(async () => ({ ok: !fail, status: fail ? 503 : 200, body: {} }));
    const bot: BotDefaultsRow = { larkAppId: 'cli_fold_ui' };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(CardBehaviorSection, { bot, putCardPref }));
    });
    const toggle = () => renderer.root.findByProps({ 'data-action': 'toggle-fold-background-updates' });
    try {
      expect(toggle().props.checked).toBe(false);
      await act(async () => toggle().props.onChange({ currentTarget: { checked: true } }));
      expect(putCardPref).toHaveBeenLastCalledWith({ foldBackgroundUpdates: true });
      expect(toggle().props.checked).toBe(true);

      fail = true;
      await act(async () => toggle().props.onChange({ currentTarget: { checked: false } }));
      expect(putCardPref).toHaveBeenLastCalledWith({ foldBackgroundUpdates: false });
      expect(toggle().props.checked).toBe(true);

      await act(async () => renderer.update(React.createElement(CardBehaviorSection, {
        bot: { ...bot, foldBackgroundUpdates: false },
        putCardPref,
      })));
      expect(toggle().props.checked).toBe(false);

      await act(async () => renderer.update(React.createElement(CardBehaviorSection, {
        bot: { ...bot, foldBackgroundUpdates: true },
        putCardPref,
      })));
      expect(toggle().props.checked).toBe(true);

      expect(patchCardPrefsFromBody({ ...bot, foldBackgroundUpdates: false }, { foldBackgroundUpdates: true }).foldBackgroundUpdates).toBe(true);
    } finally {
      await act(async () => renderer.unmount());
    }
  });
});
