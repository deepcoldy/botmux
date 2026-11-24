import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskRoutingSection } from '../src/dashboard/web/bot-defaults-page.js';
import type { BotDefaultsRow } from '../src/dashboard/web/bot-defaults.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.unstubAllGlobals(); });

function render(bot: Partial<BotDefaultsRow>, patchBot = vi.fn()) {
  let view!: TestRenderer.ReactTestRenderer;
  const row = { larkAppId: 'app_a', ...bot } as BotDefaultsRow;
  act(() => { view = TestRenderer.create(React.createElement(TaskRoutingSection, { bot: row, patchBot })); });
  return view;
}

const toggle = (view: TestRenderer.ReactTestRenderer) =>
  view.root.findByProps({ 'data-action': 'toggle-task-routing' });

describe('bot task-routing participation switch', () => {
  it('opts in through the per-bot route while preserving the saved profile', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        taskRouting: { enabled: true, costTier: 'low', strengths: '小修', limitations: '不做迁移' },
      }),
    }));
    vi.stubGlobal('fetch', fetcher);
    const patchBot = vi.fn();
    const view = render({ taskRouting: { enabled: false, costTier: 'low', strengths: '小修', limitations: '不做迁移' } }, patchBot);
    expect(toggle(view).props.checked).toBe(false);

    await act(async () => { toggle(view).props.onChange({ currentTarget: { checked: true } }); });

    expect(fetcher).toHaveBeenCalledWith('/api/bots/app_a/task-routing', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({
        taskRouting: { enabled: true, costTier: 'low', strengths: '小修', limitations: '不做迁移' },
      }),
    }));
    expect(patchBot).toHaveBeenCalledWith('app_a', {
      taskRouting: { enabled: true, costTier: 'low', strengths: '小修', limitations: '不做迁移' },
    });
    act(() => view.unmount());
  });

  it('opts out and accepts the daemon sparse null response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, taskRouting: null }),
    })));
    const patchBot = vi.fn();
    const view = render({ taskRouting: { enabled: true, costTier: 'high' } }, patchBot);
    expect(toggle(view).props.checked).toBe(true);

    await act(async () => { toggle(view).props.onChange({ currentTarget: { checked: false } }); });

    expect(patchBot).toHaveBeenCalledWith('app_a', { taskRouting: null });
    act(() => view.unmount());
  });

  it('disables the switch where selection always excludes the bot', () => {
    for (const bot of [
      { apiOnly: true },
      { steward: { enabled: true } },
    ]) {
      const view = render(bot);
      expect(toggle(view).props.disabled).toBe(true);
      act(() => view.unmount());
    }
  });
});
