/**
 * Bot config page → isolation & permissions → lark-cli app binding: the
 * "use the owner's Feishu identity when nobody started the turn" switch writes
 * the per-bot route, and is disabled where it has no effect.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { LarkToolBindingSection } from '../src/dashboard/web/bot-defaults-page.js';
import type { BotDefaultsRow } from '../src/dashboard/web/bot-defaults.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.unstubAllGlobals(); });

function render(bot: Partial<BotDefaultsRow>, patchBot = vi.fn()) {
  let view!: TestRenderer.ReactTestRenderer;
  const row = { larkAppId: 'app_a', ...bot } as BotDefaultsRow;
  act(() => { view = TestRenderer.create(React.createElement(LarkToolBindingSection, { bot: row, patchBot })); });
  return view;
}
const toggle = (view: TestRenderer.ReactTestRenderer) => view.root.findByProps({ 'data-action': 'toggle-lark-user-owner-fallback' });
const note = (view: TestRenderer.ReactTestRenderer) => view.root.findAll(node => node.props['data-lark-user-owner-fallback-note'] !== undefined)
  .map(node => node.props['data-lark-user-owner-fallback-note']);

it('is on by default and turns off through the per-bot route', async () => {
  const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, larkUserOwnerFallback: false }) }));
  vi.stubGlobal('fetch', fetcher);
  const patchBot = vi.fn();
  const view = render({}, patchBot);
  expect(toggle(view).props.checked).toBe(true);
  expect(toggle(view).props.disabled).toBe(false);
  await act(async () => { toggle(view).props.onChange({ currentTarget: { checked: false } }); });
  expect(fetcher).toHaveBeenCalledWith('/api/bots/app_a/lark-user-owner-fallback', expect.objectContaining({
    method: 'PUT', body: JSON.stringify({ enabled: false }),
  }));
  expect(patchBot).toHaveBeenCalledWith('app_a', { larkUserOwnerFallback: false });
  act(() => view.unmount());
});

it('shows a saved off', () => {
  const view = render({ larkUserOwnerFallback: false });
  expect(toggle(view).props.checked).toBe(false);
  act(() => view.unmount());
});

it('is disabled with a note where it has no effect: per-person Feishu identity, or the binding off', () => {
  for (const triggerUserAuth of [
    { enabled: true, capabilities: ['lark-user' as const] },
    { enabled: true, tools: ['lark-cli' as const] },
  ]) {
    const strict = render({ triggerUserAuth });
    expect(toggle(strict).props.disabled).toBe(true);
    expect(note(strict)).toEqual(['per-person']);
    act(() => strict.unmount());
  }
  const unbound = render({ larkToolBinding: false });
  expect(toggle(unbound).props.disabled).toBe(true);
  expect(note(unbound)).toEqual(['unbound']);
  act(() => unbound.unmount());
  // Per-person auth that leaves the Feishu identity out keeps it usable.
  const other = render({ triggerUserAuth: { enabled: true, capabilities: ['bytecloud'] } });
  expect(toggle(other).props.disabled).toBe(false);
  expect(note(other)).toEqual([]);
  act(() => other.unmount());
});
