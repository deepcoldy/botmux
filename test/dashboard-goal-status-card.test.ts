import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { CardBehaviorSection, patchCardPrefsFromBody } from '../src/dashboard/web/bot-defaults-page.js';
import type { BotDefaultsRow } from '../src/dashboard/web/bot-defaults.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../src/dashboard/web/toast.js', () => ({ toast: vi.fn() }));

it('shows the goal status card switch off by default, saves it, and rolls back a failed save', async () => {
  let fail = false;
  const putCardPref = vi.fn(async () => ({ ok: !fail, status: fail ? 503 : 200, body: {} }));
  const bot: BotDefaultsRow = { larkAppId: 'cli_goal_ui' };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(CardBehaviorSection, { bot, putCardPref })); });
  const toggle = () => renderer.root.findByProps({ 'data-action': 'toggle-goal-status-card' });
  try {
    expect(toggle().props.checked).toBe(false);
    await act(async () => toggle().props.onChange({ currentTarget: { checked: true } }));
    expect(putCardPref).toHaveBeenLastCalledWith({ goalStatusCard: true });
    expect(toggle().props.checked).toBe(true);
    fail = true;
    await act(async () => toggle().props.onChange({ currentTarget: { checked: false } }));
    expect(putCardPref).toHaveBeenLastCalledWith({ goalStatusCard: false });
    expect(toggle().props.checked).toBe(true);
    await act(async () => renderer.update(React.createElement(CardBehaviorSection, { bot: { ...bot, goalStatusCard: false }, putCardPref })));
    expect(toggle().props.checked).toBe(false);
    expect(patchCardPrefsFromBody({ ...bot, goalStatusCard: false }, { goalStatusCard: true }).goalStatusCard).toBe(true);
  } finally { await act(async () => renderer.unmount()); }
});
