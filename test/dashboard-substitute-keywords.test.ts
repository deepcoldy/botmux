import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubstituteModeSection } from '../src/dashboard/web/bot-defaults-page.js';
import { sendJson } from '../src/dashboard/web/dashboard-api.js';
import type { BotDefaultsRow } from '../src/dashboard/web/bot-defaults.js';

vi.mock('../src/dashboard/web/dashboard-api.js', () => ({ sendJson: vi.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const bot = {
  larkAppId: 'app_test', substituteMode: {
    enabled: true, disclosure: 'prefix', targets: [{ openId: 'ou_sub', name: 'Substitute' }], keywords: ['incident'],
  },
} as BotDefaultsRow;

describe('substitute keyword editor', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  afterEach(() => {
    act(() => renderer?.unmount());
    vi.clearAllMocks();
  });

  async function render() {
    const patchBot = vi.fn();
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(SubstituteModeSection, { bot, patchBot }));
    });
    return patchBot;
  }

  function input() {
    return renderer.root.findByProps({ 'data-input': 'substituteKeywords' });
  }

  function replyWith(keywords?: string[]) {
    vi.mocked(sendJson).mockResolvedValue({
      ok: true, status: 200,
      body: { ok: true, substituteMode: { ...bot.substituteMode, keywords } },
    });
  }

  it('loads, edits, saves and displays the server-normalized keywords', async () => {
    const patchBot = await render();
    expect(input().props.value).toBe('incident');
    replyWith(['独立卡', 'Oncall']);
    await act(async () => input().props.onChange({ currentTarget: { value: ' 独立卡，Oncall\n独立卡; ' } }));
    await act(async () => renderer.root.findByProps({ 'data-action': 'save-substitute-mode' }).props.onClick());
    expect(sendJson).toHaveBeenCalledWith('PUT', '/api/bots/app_test/substitute-mode', expect.objectContaining({
      keywords: ['独立卡', 'Oncall'], targets: bot.substituteMode!.targets,
    }));
    expect(input().props.value).toBe('独立卡\nOncall');
    expect(patchBot).toHaveBeenCalledWith('app_test', { substituteMode: expect.objectContaining({ keywords: ['独立卡', 'Oncall'] }) });
  });

  it('clears keywords and follows config refreshes without retaining a previous bot value', async () => {
    await render();
    replyWith();
    await act(async () => input().props.onChange({ currentTarget: { value: '  ' } }));
    await act(async () => renderer.root.findByProps({ 'data-action': 'save-substitute-mode' }).props.onClick());
    expect(sendJson).toHaveBeenCalledWith('PUT', expect.any(String), expect.objectContaining({ keywords: [] }));
    expect(input().props.value).toBe('');
    await act(async () => {
      renderer.update(React.createElement(SubstituteModeSection, {
        bot: { ...bot, larkAppId: 'app_other', substituteMode: { ...bot.substituteMode!, keywords: ['new-keyword'] } },
        patchBot: vi.fn(),
      }));
    });
    expect(input().props.value).toBe('new-keyword');
  });
});
