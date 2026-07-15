import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { displayCliId } from '../src/dashboard/web/bot-defaults.js';
import { BotAgentSection, CodexAppDisplaySection } from '../src/dashboard/web/bot-defaults-page.js';
import { isOnboardingSubmitDisabled } from '../src/dashboard/web/bot-onboarding.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('bot defaults cli label', () => {
  it('prefers /api/bots cliId before session fallback', () => {
    expect(displayCliId({ larkAppId: 'cli_traex', cliId: 'traex' }, 'codex')).toBe('traex');
    expect(displayCliId({ larkAppId: 'cli_traex' }, 'codex')).toBe('codex');
    expect(displayCliId({ larkAppId: 'cli_traex', cliId: '' }, '')).toBe('');
  });

  it('renders an editable CLI and model section from /api/bots values', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(BotAgentSection, {
        bot: { larkAppId: 'cli_traex', cliId: 'traex', model: 'glm-5.1' },
        sessionFallback: 'codex',
        cliState: {
          options: [
            { id: 'claude-code', label: 'Claude' },
            { id: 'codex', label: 'Codex' },
            { id: 'traex', label: 'traex' },
          ],
          ttadkModelDefault: 'glm-5.1',
          ttadkModelSuggestions: [],
        },
        patchBot: () => undefined,
      }));
    });
    const root = renderer.root;
    expect(root.findByProps({ 'data-input': 'agentCliId' }).props.value).toBe('traex');
    expect(root.findByProps({ 'data-input': 'agentModel' }).props.value).toBe('glm-5.1');
    expect(root.findAllByProps({ 'data-action': 'save-agent' })).toHaveLength(1);
  });

  it('marks a locally missing Agent in the dropdown and shows an inline warning', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(BotAgentSection, {
        bot: { larkAppId: 'cli_missing', cliId: 'codex', model: '' },
        sessionFallback: 'codex',
        cliState: {
          options: [
            { id: 'codex', label: 'Codex', available: false, command: 'codex' },
          ],
          ttadkModelDefault: 'glm-5.1',
          ttadkModelSuggestions: [],
        },
        patchBot: () => undefined,
      }));
    });
    const root = renderer.root;
    const dropdown = root.findByProps({ dataInput: 'agentCliId' });
    expect(dropdown.props.options[0].label).toContain('未安装');
    expect(root.findByProps({ className: 'hint-warn' }).children.join('')).toContain('codex');
  });
});

describe('bot onboarding Agent availability warning', () => {
  it('does not hard-disable submit from the PATH-only option-list probe', () => {
    expect(isOnboardingSubmitDisabled(false, 'reuse')).toBe(false);
    expect(isOnboardingSubmitDisabled(false, 'qr')).toBe(false);
    expect(isOnboardingSubmitDisabled(true, 'reuse')).toBe(true);
    expect(isOnboardingSubmitDisabled(false, 'checking')).toBe(true);
  });
});

describe('riff CLI switch persistence (PR #467 P1)', () => {
  it('save-riff persists the CLI selection via PUT /agent before PUT /riff', async () => {
    const requests: Array<{ method: string; url: string; body: any }> = [];
    (globalThis as any).fetch = async (url: string, init?: any) => {
      requests.push({ method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      const body = String(url).endsWith('/agent')
        ? { ok: true, cliId: 'riff', wrapperCli: null, model: '', selectionKey: 'riff' }
        : { ok: true, riff: JSON.stringify({ baseUrl: 'https://riff.example' }) };
      return { ok: true, status: 200, json: async () => body } as any;
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(BotAgentSection, {
        bot: { larkAppId: 'cli_x', cliId: 'codex', model: '' },
        sessionFallback: 'codex',
        cliState: {
          options: [
            { id: 'codex', label: 'Codex' },
            { id: 'riff', label: 'Riff' },
          ],
          ttadkModelDefault: 'glm-5.1',
          ttadkModelSuggestions: [],
        },
        patchBot: () => undefined,
      }));
    });
    const root = renderer.root;
    // 下拉切到 riff → RiffSection 出现，「保存 Agent」按钮隐藏
    // （DropdownField 是自定义组件：按组件 prop dataInput 定位并调用其 onChange）
    act(() => { root.findByProps({ dataInput: 'agentCliId' }).props.onChange('riff'); });
    expect(root.findAllByProps({ 'data-action': 'save-agent' })).toHaveLength(0);
    const baseUrlInput = root.findByProps({ 'data-input': 'riff-base-url' });
    act(() => { baseUrlInput.props.onChange({ currentTarget: { value: 'https://riff.example' } }); });
    // 点「保存 Riff 配置」→ 先 PUT /riff 存配置，成功后再 PUT /agent 落盘
    // cliId=riff（反过来会在 /riff 失败时留下已切 riff+空配置+旧会话被关的半配置态）
    await act(async () => { await root.findByProps({ 'data-action': 'save-riff' }).props.onClick(); });
    const puts = requests.filter(r => r.method === 'PUT');
    expect(puts.map(r => r.url.split('/').pop())).toEqual(['riff', 'agent']);
    expect(puts[1]!.body).toEqual({ cliId: 'riff', model: '' });
  });
});

describe('Codex App history switch', () => {
  it('keeps the clean-history control visible when the nested Codex dependency is unavailable', () => {
    let agentRenderer!: TestRenderer.ReactTestRenderer;
    let displayRenderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      agentRenderer = TestRenderer.create(React.createElement(BotAgentSection, {
        bot: { larkAppId: 'cli_codex_app_missing', cliId: 'codex-app', model: '' },
        sessionFallback: 'codex-app',
        cliState: {
          options: [{
            id: 'codex-app',
            label: 'Codex App',
            available: false,
            command: 'codex',
            availabilityReason: '找不到嵌套 codex',
          }],
          ttadkModelDefault: 'glm-5.1',
          ttadkModelSuggestions: [],
        },
        patchBot: () => undefined,
      }));
      displayRenderer = TestRenderer.create(React.createElement(CodexAppDisplaySection, {
        bot: { larkAppId: 'cli_codex_app_missing', cliId: 'codex-app' },
        putCardPref: vi.fn(),
      }));
    });

    expect(agentRenderer.root.findByProps({ className: 'hint-warn' }).children.join('')).toContain('codex');
    expect(displayRenderer.root.findByProps({ 'data-action': 'toggle-codex-app-clean-input' }).props.checked).toBe(false);
  });

  it('renders a real default-off Codex App history switch and persists the opt-in', async () => {
    const putCardPref = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: { ok: true, codexAppCleanInput: true },
    }));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(CodexAppDisplaySection, {
        bot: { larkAppId: 'cli_codex_app', cliId: 'codex-app' },
        putCardPref,
      }));
    });

    const toggle = renderer.root.findByProps({ 'data-action': 'toggle-codex-app-clean-input' });
    expect(toggle.props.checked).toBe(false);
    const renderedText = JSON.stringify(renderer.toJSON());
    expect(renderedText).toContain('只影响 Codex App');
    expect(renderedText).toContain('默认关闭，保持原有兼容行为');

    await act(async () => {
      toggle.props.onChange({ currentTarget: { checked: true } });
      await Promise.resolve();
    });
    expect(putCardPref).toHaveBeenCalledWith({ codexAppCleanInput: true });
    expect(renderer.root.findByProps({ 'data-action': 'toggle-codex-app-clean-input' }).props.checked).toBe(true);
  });

  it('rolls the Codex App history switch back when persistence fails', async () => {
    const putCardPref = vi.fn(async () => ({
      ok: false,
      status: 500,
      body: { error: 'write_failed' },
    }));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(CodexAppDisplaySection, {
        bot: { larkAppId: 'cli_codex_app', cliId: 'codex-app' },
        putCardPref,
      }));
    });

    const toggle = renderer.root.findByProps({ 'data-action': 'toggle-codex-app-clean-input' });
    await act(async () => {
      toggle.props.onChange({ currentTarget: { checked: true } });
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({ 'data-action': 'toggle-codex-app-clean-input' }).props.checked).toBe(false);
    expect(renderer.root.findByProps({ 'data-codex-app-clean-input-status': '' }).children.join(''))
      .toContain('write_failed');
  });
});
