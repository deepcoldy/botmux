import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { CardBehaviorSection, patchCardPrefsFromBody } from '../src/dashboard/web/bot-defaults-page.js';
import type { BotDefaultsRow } from '../src/dashboard/web/bot-defaults.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../src/dashboard/web/toast.js', () => ({ toast: vi.fn() }));

it('saves native CoT independently, rolls back a failed save, and keeps the choice across modes', async () => {
  let fail = false;
  const putCardPref = vi.fn(async () => ({ ok: !fail, status: fail ? 503 : 200, body: {} }));
  const bot: BotDefaultsRow = { larkAppId: 'cli_native_ui', replyCardMode: 'unified', cotEnabled: false };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(CardBehaviorSection, { bot, putCardPref })); });
  const toggle = (action: string) => renderer.root.findByProps({ 'data-action': action });
  try {
    expect(toggle('toggle-cot').props.checked).toBe(false);
    expect(toggle('toggle-reply-card-native-cot').props.checked).toBe(false);
    await act(async () => toggle('toggle-reply-card-native-cot').props.onChange({ currentTarget: { checked: true } }));
    expect(putCardPref).toHaveBeenLastCalledWith({ replyCardNativeCot: true });
    expect(toggle('toggle-reply-card-native-cot').props.checked).toBe(true);
    expect(toggle('toggle-cot').props.checked).toBe(false);
    fail = true;
    await act(async () => toggle('toggle-reply-card-native-cot').props.onChange({ currentTarget: { checked: false } }));
    expect(toggle('toggle-reply-card-native-cot').props.checked).toBe(true);
    for (const replyCardMode of ['legacy', 'unified'] as const) {
      await act(async () => renderer.update(React.createElement(CardBehaviorSection, {
        bot: { ...bot, replyCardMode, replyCardNativeCot: true }, putCardPref,
      })));
      expect(renderer.root.findAllByProps({ 'data-action': 'toggle-reply-card-native-cot' })).toHaveLength(replyCardMode === 'legacy' ? 0 : 1);
    }
    expect(toggle('toggle-reply-card-native-cot').props.checked).toBe(true);
    expect(patchCardPrefsFromBody({ ...bot, replyCardNativeCot: true }, { replyCardNativeCot: false }).replyCardNativeCot).toBe(false);
  } finally { await act(async () => renderer.unmount()); }
});
