/**
 * Zero injection moved from the customization center into the Bot config page
 * (advanced tab) and the Agent config. The Bot page switch writes the existing
 * per-bot route and is locked when a linked Agent manages the section.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { PromptInjectionSection, zeroPromptSupportedFor } from '../src/dashboard/web/bot-defaults-page.js';
import type { BotDefaultsRow } from '../src/dashboard/web/bot-defaults.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.unstubAllGlobals(); });

function render(bot: Partial<BotDefaultsRow>, lock: any = null, patchBot = vi.fn()) {
  let view!: TestRenderer.ReactTestRenderer;
  const row = { larkAppId: 'app_a', ...bot } as BotDefaultsRow;
  act(() => { view = TestRenderer.create(React.createElement(PromptInjectionSection, { bot: row, patchBot, lock })); });
  return view;
}
const toggle = (view: TestRenderer.ReactTestRenderer) => view.root.findByProps({ 'data-action': 'toggle-prompt-injection' });

it('turns zero injection on through the per-bot route and patches the row', async () => {
  const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, promptInjection: 'none' }) }));
  vi.stubGlobal('fetch', fetcher);
  const patchBot = vi.fn();
  const view = render({ cliId: 'claude-code', promptInjection: 'default' }, null, patchBot);
  expect(toggle(view).props.checked).toBe(false);
  await act(async () => { toggle(view).props.onChange({ currentTarget: { checked: true } }); });
  expect(fetcher).toHaveBeenCalledWith('/api/bots/app_a/prompt-injection', expect.objectContaining({
    method: 'PUT', body: JSON.stringify({ promptInjection: 'none' }),
  }));
  expect(patchBot).toHaveBeenCalledWith('app_a', { promptInjection: 'none' });
  act(() => view.unmount());
});

it('refreshes the effective reply delivery shown next to it when zero injection is turned off', async () => {
  const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, promptInjection: 'default', replyDelivery: 'send' }) }));
  vi.stubGlobal('fetch', fetcher);
  const patchBot = vi.fn();
  const view = render({ cliId: 'claude-code', promptInjection: 'none', replyDelivery: 'transcript' }, null, patchBot);
  await act(async () => { toggle(view).props.onChange({ currentTarget: { checked: false } }); });
  expect(patchBot).toHaveBeenCalledWith('app_a', { promptInjection: 'default', replyDelivery: 'send' });
  act(() => view.unmount());
});

it('cannot be turned on for an unsupported CLI, but an enabled one can still be turned off', () => {
  const off = render({ cliId: 'gemini', promptInjection: 'default' });
  expect(toggle(off).props.disabled).toBe(true);
  expect(JSON.stringify(off.toJSON())).toContain('不支持零注入');
  act(() => off.unmount());
  const on = render({ cliId: 'gemini', promptInjection: 'none' });
  expect(toggle(on).props.disabled).toBe(false);
  act(() => on.unmount());
});

it('is locked when the linked Agent manages zero injection', () => {
  const view = render({ cliId: 'claude-code', promptInjection: 'none' }, { id: 'ag_abcd', name: '执行 Agent', sections: ['promptInjection'] });
  expect(view.root.findAll(node => node.props['data-agent-lock'] === 'promptInjection').length).toBeGreaterThan(0);
  expect(JSON.stringify(view.toJSON())).toContain('执行 Agent');
  act(() => view.unmount());
});

it('follows the row’s current CLI / backend / sandbox instead of a load-time snapshot', () => {
  // cursor's transcripts are unreachable under the scratch sandbox; switching the
  // sandbox off on the same page must enable the switch without a reload.
  expect(zeroPromptSupportedFor({ cliId: 'cursor', sandboxMode: 'scratch' })).toBe(false);
  expect(zeroPromptSupportedFor({ cliId: 'cursor', sandboxMode: 'off' })).toBe(true);
  expect(zeroPromptSupportedFor({ cliId: 'cursor', sandbox: true })).toBe(true);
  // A local CLI never spawns on a remote backend (paired back to a local one), so
  // a stale riff override does not block it; antigravity on zmx is unsupported.
  expect(zeroPromptSupportedFor({ cliId: 'claude-code', backendType: 'riff' })).toBe(true);
  expect(zeroPromptSupportedFor({ cliId: 'antigravity', backendType: 'zmx' })).toBe(false);
  // No override: the daemon's default backend decides.
  expect(zeroPromptSupportedFor({ cliId: 'antigravity', backendType: null, defaultBackendType: 'zmx' })).toBe(false);
  expect(zeroPromptSupportedFor({ cliId: 'antigravity', backendType: 'tmux', defaultBackendType: 'zmx' })).toBe(true);
  // A remote daemon default pairs back to pty for a local CLI (same rule as spawning).
  expect(zeroPromptSupportedFor({ cliId: 'claude-code', backendType: null, defaultBackendType: 'riff' })).toBe(true);
  expect(zeroPromptSupportedFor({ cliId: 'claude-code', backendType: null })).toBe(true);
  const scratch = render({ cliId: 'cursor', sandboxMode: 'scratch', promptInjection: 'default' });
  expect(toggle(scratch).props.disabled).toBe(true);
  act(() => scratch.update(React.createElement(PromptInjectionSection, {
    bot: { larkAppId: 'app_a', cliId: 'cursor', sandboxMode: 'off', promptInjection: 'default' } as BotDefaultsRow,
    patchBot: vi.fn(),
    lock: null,
  })));
  expect(toggle(scratch).props.disabled).toBe(false);
  act(() => scratch.unmount());
});

it('lives in the Bot config advanced tab, next to reply delivery', () => {
  const page = readFileSync(join(process.cwd(), 'src/dashboard/web/bot-defaults-page.tsx'), 'utf8');
  const advanced = page.slice(page.indexOf('aria-labelledby="bd-tab-advanced"'));
  expect(advanced.indexOf('<PromptInjectionSection')).toBeGreaterThan(-1);
  expect(advanced.indexOf('<PromptInjectionSection')).toBeLessThan(advanced.indexOf('<ReplyDeliverySection'));
});
