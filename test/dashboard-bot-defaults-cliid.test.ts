import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { displayCliId } from '../src/dashboard/web/bot-defaults.js';
import {
  BOT_DEFAULTS_TABS,
  BotAgentSection,
  BotDefaultsTabs,
  CardBehaviorSection,
  CodexAppDisplaySection,
  type BotDefaultsTab,
} from '../src/dashboard/web/bot-defaults-page.js';
import { isOnboardingSubmitDisabled } from '../src/dashboard/web/bot-onboarding.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('bot defaults task tabs', () => {
  it('renders five accessible categories and supports pointer selection', () => {
    const onChange = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(BotDefaultsTabs, {
        active: 'common' satisfies BotDefaultsTab,
        onChange,
      }));
    });

    const tabs = renderer.root.findAllByProps({ role: 'tab' });
    expect(BOT_DEFAULTS_TABS).toEqual(['common', 'sessions', 'security', 'cards', 'advanced']);
    expect(tabs).toHaveLength(5);
    expect(tabs[0]!.props['aria-selected']).toBe(true);
    expect(tabs[1]!.props.tabIndex).toBe(-1);

    act(() => tabs[2]!.props.onClick());
    expect(onChange).toHaveBeenCalledWith('security');
  });

  it('wraps arrow-key navigation and supports Home / End', () => {
    const onChange = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(BotDefaultsTabs, {
        active: 'common' satisfies BotDefaultsTab,
        onChange,
      }));
    });
    const tabs = renderer.root.findAllByProps({ role: 'tab' });
    const event = (key: string) => ({ key, preventDefault: vi.fn() });

    act(() => tabs[0]!.props.onKeyDown(event('ArrowLeft')));
    expect(onChange).toHaveBeenLastCalledWith('advanced');
    act(() => tabs[4]!.props.onKeyDown(event('ArrowRight')));
    expect(onChange).toHaveBeenLastCalledWith('common');
    act(() => tabs[2]!.props.onKeyDown(event('Home')));
    expect(onChange).toHaveBeenLastCalledWith('common');
    act(() => tabs[2]!.props.onKeyDown(event('End')));
    expect(onChange).toHaveBeenLastCalledWith('advanced');
  });
});

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

describe('Codex-compatible runtime editor', () => {
  const cliState = {
    options: [
      { id: 'claude-code', label: 'Claude' },
      { id: 'codex', label: 'Codex' },
      { id: 'traex', label: 'traex' },
      { id: 'ttadk-x-codex', label: 'Codex via TTADK' },
    ],
    ttadkModelDefault: 'glm-5.1',
    ttadkModelSuggestions: [],
  };

  function renderAgent(bot: Record<string, any>, patchBot = vi.fn()) {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(BotAgentSection, {
        bot: { larkAppId: 'cli_runtime', model: '', ...bot },
        sessionFallback: 'codex',
        cliState,
        patchBot,
      }));
    });
    return { renderer, root: renderer.root, patchBot };
  }

  it('defaults old payloads to Official Codex and keeps wrapper or non-Codex selections unchanged', () => {
    const official = renderAgent({ cliId: 'codex' });
    expect(official.root.findByProps({ 'data-input': 'agentRuntimeMode' }).props.value).toBe('official');
    expect(official.root.findByProps({ dataInput: 'agentReasoningEffort' }).props.value).toBe('');
    expect(official.root.findAllByProps({ 'data-input': 'agentRuntimeId' })).toHaveLength(0);

    const otherCli = renderAgent({ cliId: 'traex', agentSelectionKey: 'traex' });
    expect(otherCli.root.findAllByProps({ 'data-codex-runtime': '' })).toHaveLength(0);

    const wrapper = renderAgent({
      cliId: 'codex',
      wrapperCli: 'ttadk codex',
      agentSelectionKey: 'ttadk-x-codex',
    });
    expect(wrapper.root.findAllByProps({ 'data-codex-runtime': '' })).toHaveLength(0);

    const oldWrapperPayload = renderAgent({ cliId: 'codex', wrapperCli: 'custom-launcher codex' });
    expect(oldWrapperPayload.root.findAllByProps({ 'data-codex-runtime': '' })).toHaveLength(0);
  });

  it('shows and saves the configured Codex reasoning effort', async () => {
    const previousFetch = globalThis.fetch;
    const requests: any[] = [];
    (globalThis as any).fetch = vi.fn(async (_url: string, init?: any) => {
      // 模型下拉的 on-demand 探测请求（GET /api/cli-options/models）与本测试
      // 断言的 save 请求无关：返回空静态结果且不记入 requests，避免污染断言。
      if (String(_url).includes('/api/cli-options/models')) return { ok: true, status: 200, json: async () => ({ models: [], source: 'static' }) } as any;
      const body = JSON.parse(init?.body ?? '{}');
      requests.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, cliId: 'codex', model: '', reasoningEffort: body.reasoningEffort, selectionKey: 'codex' }),
      } as any;
    });
    try {
      const { root } = renderAgent({ cliId: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' });
      const picker = root.findByProps({ dataInput: 'agentReasoningEffort' });
      expect(picker.props.value).toBe('high');
      act(() => picker.props.onChange('ultra'));
      await act(async () => {
        root.findByProps({ 'data-action': 'save-agent' }).props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(requests).toEqual([{ cliId: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'ultra' }]);
    } finally {
      (globalThis as any).fetch = previousFetch;
    }
  });

  it('shows Grok reasoning effort and omits Codex-only max/ultra for grok-4.5', async () => {
    const previousFetch = globalThis.fetch;
    const requests: any[] = [];
    (globalThis as any).fetch = vi.fn(async (_url: string, init?: any) => {
      // 模型下拉的 on-demand 探测请求（GET /api/cli-options/models）与本测试
      // 断言的 save 请求无关：返回空静态结果且不记入 requests，避免污染断言。
      if (String(_url).includes('/api/cli-options/models')) return { ok: true, status: 200, json: async () => ({ models: [], source: 'static' }) } as any;
      const body = JSON.parse(init?.body ?? '{}');
      requests.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, cliId: 'grok', model: 'grok-4.5', reasoningEffort: body.reasoningEffort, selectionKey: 'grok' }),
      } as any;
    });
    try {
      const grokCliState = {
        options: [
          { id: 'grok', label: 'Grok' },
          { id: 'codex', label: 'Codex' },
        ],
        ttadkModelDefault: '',
        ttadkModelSuggestions: [],
      };
      let renderer!: TestRenderer.ReactTestRenderer;
      act(() => {
        renderer = TestRenderer.create(React.createElement(BotAgentSection, {
          bot: { larkAppId: 'cli_grok', cliId: 'grok', model: 'grok-4.5', reasoningEffort: 'high' },
          sessionFallback: 'grok',
          cliState: grokCliState,
          patchBot: () => undefined,
        }));
      });
      const picker = renderer.root.findByProps({ dataInput: 'agentReasoningEffort' });
      expect(picker.props.value).toBe('high');
      const options = picker.props.options as Array<{ value: string; label: string }>;
      expect(options.map(option => option.value)).toEqual(['', 'low', 'medium', 'high']);
      expect(options[0]?.label).toBe('跟随 Grok 默认值');
      expect(options.map(option => option.value)).not.toContain('xhigh');
      expect(options.map(option => option.value)).not.toContain('ultra');
      act(() => picker.props.onChange('medium'));
      await act(async () => {
        renderer.root.findByProps({ 'data-action': 'save-agent' }).props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(requests).toEqual([{ cliId: 'grok', model: 'grok-4.5', reasoningEffort: 'medium' }]);
    } finally {
      (globalThis as any).fetch = previousFetch;
    }
  });

  it('shows TraeX reasoning effort with conservative common options', async () => {
    const previousFetch = globalThis.fetch;
    const requests: any[] = [];
    (globalThis as any).fetch = vi.fn(async (_url: string, init?: any) => {
      if (String(_url).includes('/api/cli-options/models')) return { ok: true, status: 200, json: async () => ({ models: [], source: 'static' }) } as any;
      const body = JSON.parse(init?.body ?? '{}');
      requests.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, cliId: 'traex', model: 'DeepSeek-V4-Pro', reasoningEffort: body.reasoningEffort, selectionKey: 'traex' }),
      } as any;
    });
    try {
      const traexCliState = {
        options: [
          { id: 'traex', label: 'TraeX' },
          { id: 'codex', label: 'Codex' },
        ],
        ttadkModelDefault: '',
        ttadkModelSuggestions: [],
      };
      let renderer!: TestRenderer.ReactTestRenderer;
      act(() => {
        renderer = TestRenderer.create(React.createElement(BotAgentSection, {
          bot: { larkAppId: 'cli_traex', cliId: 'traex', model: 'DeepSeek-V4-Pro', reasoningEffort: 'medium' },
          sessionFallback: 'traex',
          cliState: traexCliState,
          patchBot: () => undefined,
        }));
      });
      const picker = renderer.root.findByProps({ dataInput: 'agentReasoningEffort' });
      expect(picker.props.value).toBe('medium');
      const options = picker.props.options as Array<{ value: string; label: string }>;
      expect(options.map(option => option.value)).toEqual(['', 'low', 'medium', 'high']);
      expect(options[0]?.label).toBe('跟随 TraeX 默认值');
      act(() => picker.props.onChange('high'));
      await act(async () => {
        renderer.root.findByProps({ 'data-action': 'save-agent' }).props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(requests).toEqual([{ cliId: 'traex', model: 'DeepSeek-V4-Pro', reasoningEffort: 'high' }]);
    } finally {
      (globalThis as any).fetch = previousFetch;
    }
  });

  const dshCliState = {
    options: [
      { id: 'codex', label: 'Codex' },
      { id: 'dsh', label: 'dsh' },
    ],
    ttadkModelDefault: '',
    ttadkModelSuggestions: [],
  };

  function renderDsh(bot: Record<string, any>, patchBot = vi.fn()) {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(BotAgentSection, {
        bot: { larkAppId: 'cli_dsh', model: '', ...bot },
        sessionFallback: 'dsh',
        cliState: dshCliState as any,
        patchBot,
      }));
    });
    return { renderer, root: renderer.root, patchBot };
  }

  it('shows the dsh turn timeout in minutes and PUTs it as milliseconds', async () => {
    const previousFetch = globalThis.fetch;
    const requests: any[] = [];
    (globalThis as any).fetch = vi.fn(async (_url: string, init?: any) => {
      // 模型下拉的 on-demand 探测请求（GET /api/cli-options/models）与本测试
      // 断言的 save 请求无关：返回空静态结果且不记入 requests，避免污染断言。
      if (String(_url).includes('/api/cli-options/models')) return { ok: true, status: 200, json: async () => ({ models: [], source: 'static' }) } as any;
      const body = JSON.parse(init?.body ?? '{}');
      requests.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, cliId: 'dsh', model: '', turnTimeoutMs: body.turnTimeoutMs, selectionKey: 'dsh' }),
      } as any;
    });
    try {
      // 1_800_000 ms = 30 min
      const { root } = renderDsh({ cliId: 'dsh', turnTimeoutMs: 1_800_000 });
      const input = root.findByProps({ 'data-input': 'agentTurnTimeout' });
      expect(input.props.value).toBe('30');
      act(() => input.props.onChange({ currentTarget: { value: '45' } }));
      await act(async () => {
        root.findByProps({ 'data-action': 'save-agent' }).props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });
      // 45 min → 2_700_000 ms
      expect(requests).toEqual([{ cliId: 'dsh', model: '', reasoningEffort: '', turnTimeoutMs: 2_700_000 }]);
    } finally {
      (globalThis as any).fetch = previousFetch;
    }
  });

  it('clears the dsh turn timeout to the runner default when emptied', async () => {
    const previousFetch = globalThis.fetch;
    const requests: any[] = [];
    (globalThis as any).fetch = vi.fn(async (_url: string, init?: any) => {
      // 模型下拉的 on-demand 探测请求（GET /api/cli-options/models）与本测试
      // 断言的 save 请求无关：返回空静态结果且不记入 requests，避免污染断言。
      if (String(_url).includes('/api/cli-options/models')) return { ok: true, status: 200, json: async () => ({ models: [], source: 'static' }) } as any;
      const body = JSON.parse(init?.body ?? '{}');
      requests.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, cliId: 'dsh', model: '', turnTimeoutMs: null, selectionKey: 'dsh' }),
      } as any;
    });
    try {
      const { root } = renderDsh({ cliId: 'dsh', turnTimeoutMs: 1_800_000 });
      const input = root.findByProps({ 'data-input': 'agentTurnTimeout' });
      expect(input.props.value).toBe('30');
      act(() => input.props.onChange({ currentTarget: { value: '' } }));
      await act(async () => {
        root.findByProps({ 'data-action': 'save-agent' }).props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });
      // Empty → '' so the daemon deletes the field (revert to 10-min default).
      expect(requests).toEqual([{ cliId: 'dsh', model: '', reasoningEffort: '', turnTimeoutMs: '' }]);
    } finally {
      (globalThis as any).fetch = previousFetch;
    }
  });

  it('omits the turn timeout field for non-dsh CLIs', () => {
    const { root } = renderDsh({ cliId: 'codex' });
    expect(root.findAllByProps({ 'data-input': 'agentTurnTimeout' })).toHaveLength(0);
  });

  it('shows a legal non-whole-minute timeout and preserves it on a model-only save', async () => {
    const previousFetch = globalThis.fetch;
    const requests: any[] = [];
    (globalThis as any).fetch = vi.fn(async (_url: string, init?: any) => {
      // 模型下拉的 on-demand 探测请求（GET /api/cli-options/models）与本测试
      // 断言的 save 请求无关：返回空静态结果且不记入 requests，避免污染断言。
      if (String(_url).includes('/api/cli-options/models')) return { ok: true, status: 200, json: async () => ({ models: [], source: 'static' }) } as any;
      const body = JSON.parse(init?.body ?? '{}');
      requests.push(body);
      return {
        ok: true,
        status: 200,
        // Daemon preserved the stored ms because the field was absent from the body.
        json: async () => ({ ok: true, cliId: 'dsh', model: body.model, turnTimeoutMs: 90_001, selectionKey: 'dsh' }),
      } as any;
    });
    try {
      // 90_001 ms is a legal positive integer but not a whole minute.
      const { root } = renderDsh({ cliId: 'dsh', model: 'm0', turnTimeoutMs: 90_001 });
      const input = root.findByProps({ 'data-input': 'agentTurnTimeout' });
      // Shown as exact decimal minutes (≈ 1.5000166667), never blanked.
      expect(input.props.value).not.toBe('');
      expect(Math.round(Number(input.props.value) * 60_000)).toBe(90_001);
      // Edit only the model, then save. The untouched timeout must be omitted so
      // the daemon preserves 90_001 instead of clearing it.
      const modelInput = root.findByProps({ 'data-input': 'agentModel' });
      act(() => modelInput.props.onChange({ currentTarget: { value: 'm1' } }));
      await act(async () => {
        root.findByProps({ 'data-action': 'save-agent' }).props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(requests).toEqual([{ cliId: 'dsh', model: 'm1', reasoningEffort: '' }]);
      expect(Object.prototype.hasOwnProperty.call(requests[0], 'turnTimeoutMs')).toBe(false);
    } finally {
      (globalThis as any).fetch = previousFetch;
    }
  });

  it('re-saves the displayed non-whole-minute value back to the exact stored ms', async () => {
    const previousFetch = globalThis.fetch;
    const requests: any[] = [];
    (globalThis as any).fetch = vi.fn(async (_url: string, init?: any) => {
      // 模型下拉的 on-demand 探测请求（GET /api/cli-options/models）与本测试
      // 断言的 save 请求无关：返回空静态结果且不记入 requests，避免污染断言。
      if (String(_url).includes('/api/cli-options/models')) return { ok: true, status: 200, json: async () => ({ models: [], source: 'static' }) } as any;
      const body = JSON.parse(init?.body ?? '{}');
      requests.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, cliId: 'dsh', model: '', turnTimeoutMs: body.turnTimeoutMs, selectionKey: 'dsh' }),
      } as any;
    });
    try {
      const { root } = renderDsh({ cliId: 'dsh', turnTimeoutMs: 90_001 });
      const input = root.findByProps({ 'data-input': 'agentTurnTimeout' });
      const shown = input.props.value; // e.g. "1.5000166667"
      // Re-enter the exact displayed minutes (a touch) and save: rounding to the
      // nearest ms must reproduce 90_001, not error on a ~2e-6 float mismatch.
      act(() => input.props.onChange({ currentTarget: { value: shown } }));
      await act(async () => {
        root.findByProps({ 'data-action': 'save-agent' }).props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(requests).toEqual([{ cliId: 'dsh', model: '', reasoningEffort: '', turnTimeoutMs: 90_001 }]);
      expect(root.findAllByProps({ 'data-turn-timeout-error': '' })).toHaveLength(0);
    } finally {
      (globalThis as any).fetch = previousFetch;
    }
  });

  it('blocks the save and shows an inline error on invalid turn timeout input', async () => {
    const previousFetch = globalThis.fetch;
    const requests: any[] = [];
    (globalThis as any).fetch = vi.fn(async (_url: string, init?: any) => {
      // 模型下拉的 on-demand 探测请求（GET /api/cli-options/models）与本测试
      // 断言的 save 请求无关：返回空静态结果且不记入 requests，避免污染断言。
      if (String(_url).includes('/api/cli-options/models')) return { ok: true, status: 200, json: async () => ({ models: [], source: 'static' }) } as any;
      requests.push(JSON.parse(init?.body ?? '{}'));
      return { ok: true, status: 200, json: async () => ({ ok: true, cliId: 'dsh', model: '', turnTimeoutMs: null, selectionKey: 'dsh' }) } as any;
    });
    try {
      const { root } = renderDsh({ cliId: 'dsh', turnTimeoutMs: 600_000 });
      const input = root.findByProps({ 'data-input': 'agentTurnTimeout' });
      // 0 is not a clearable blank and not a positive timeout → must error, not clear.
      act(() => input.props.onChange({ currentTarget: { value: '0' } }));
      await act(async () => {
        root.findByProps({ 'data-action': 'save-agent' }).props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });
      // No PUT happened; an inline error is shown.
      expect(requests).toEqual([]);
      expect(root.findAllByProps({ 'data-turn-timeout-error': '' }).length).toBeGreaterThan(0);
    } finally {
      (globalThis as any).fetch = previousFetch;
    }
  });

  it('blocks the save when the minutes value exceeds the arm-able millisecond bound', async () => {
    const previousFetch = globalThis.fetch;
    const requests: any[] = [];
    (globalThis as any).fetch = vi.fn(async (_url: string, init?: any) => {
      // 模型下拉的 on-demand 探测请求（GET /api/cli-options/models）与本测试
      // 断言的 save 请求无关：返回空静态结果且不记入 requests，避免污染断言。
      if (String(_url).includes('/api/cli-options/models')) return { ok: true, status: 200, json: async () => ({ models: [], source: 'static' }) } as any;
      requests.push(JSON.parse(init?.body ?? '{}'));
      return { ok: true, status: 200, json: async () => ({ ok: true, cliId: 'dsh', model: '', turnTimeoutMs: null, selectionKey: 'dsh' }) } as any;
    });
    try {
      const { root } = renderDsh({ cliId: 'dsh', turnTimeoutMs: 600_000 });
      const input = root.findByProps({ 'data-input': 'agentTurnTimeout' });
      // 40000 min = 2.4e9 ms > 2_147_483_647 ms → invalid (would overflow setTimeout).
      act(() => input.props.onChange({ currentTarget: { value: '40000' } }));
      await act(async () => {
        root.findByProps({ 'data-action': 'save-agent' }).props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(requests).toEqual([]);
      expect(root.findAllByProps({ 'data-turn-timeout-error': '' }).length).toBeGreaterThan(0);
    } finally {
      (globalThis as any).fetch = previousFetch;
    }
  });

  it('shows a legacy path as read-only and omits cliRuntime on a model-only save', async () => {
    const previousFetch = globalThis.fetch;
    const requests: any[] = [];
    const legacyPath = '/opt/legacy/bin/legacy-codex';
    (globalThis as any).fetch = vi.fn(async (_url: string, init?: any) => {
      // 模型下拉的 on-demand 探测请求（GET /api/cli-options/models）与本测试
      // 断言的 save 请求无关：返回空静态结果且不记入 requests，避免污染断言。
      if (String(_url).includes('/api/cli-options/models')) return { ok: true, status: 200, json: async () => ({ models: [], source: 'static' }) } as any;
      requests.push(JSON.parse(init?.body ?? '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          cliId: 'codex',
          cliRuntime: null,
          cliPathOverride: legacyPath,
          wrapperCli: null,
          model: 'new-model',
          selectionKey: 'codex',
          closedMismatchedSessions: 0,
        }),
      } as any;
    });

    try {
      const patchBot = vi.fn();
      const { root } = renderAgent({
        cliId: 'codex',
        cliPathOverride: legacyPath,
        model: 'old-model',
      }, patchBot);
      expect(root.findByProps({ 'data-input': 'agentRuntimeMode' }).props.value).toBe('legacy');
      expect(root.findByProps({ 'data-runtime-legacy': '' })).toBeTruthy();
      const legacyInput = root.findByProps({ 'data-input': 'agentRuntimeLegacyPath' });
      expect(legacyInput.props.value).toBe(legacyPath);
      expect(legacyInput.props.readOnly).toBe(true);

      act(() => root.findByProps({ 'data-input': 'agentModel' }).props.onChange({ currentTarget: { value: 'new-model' } }));
      await act(async () => {
        root.findByProps({ 'data-action': 'save-agent' }).props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(requests).toEqual([{ cliId: 'codex', model: 'new-model', reasoningEffort: '' }]);
      expect(patchBot).toHaveBeenCalledWith('cli_runtime', expect.objectContaining({
        cliRuntime: null,
        cliPathOverride: legacyPath,
      }));
    } finally {
      (globalThis as any).fetch = previousFetch;
    }
  });

  async function saveAgentWithSweep(body: Record<string, unknown>) {
    const previousFetch = globalThis.fetch;
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        cliId: 'codex',
        cliRuntime: null,
        cliPathOverride: null,
        wrapperCli: null,
        model: '',
        selectionKey: 'codex',
        ...body,
      }),
    } as any));
    try {
      const { root } = renderAgent({ cliId: 'codex' });
      await act(async () => {
        root.findByProps({ 'data-action': 'save-agent' }).props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });
      const status = root.findByProps({ 'data-agent-status': '' });
      return { text: status.children.join(''), className: String(status.props.className ?? '') };
    } finally {
      (globalThis as any).fetch = previousFetch;
    }
  }

  it('warns about RESIDUAL sessions on their own (remote not cancelled)', async () => {
    // Proven separately from `failed`: a combined payload would stay green if
    // only one of the two branches existed.
    const { text, className } = await saveAgentWithSweep({
      closedMismatchedSessions: 3,
      closedMismatchedResidual: 2,
      closedMismatchedFailed: 0,
    });

    expect(text).toContain('2');
    // Localised residual copy, not the failure copy.
    expect(text).toContain('远端会话未取消');
    expect(text).not.toContain('关闭失败');
    expect(text).not.toContain('✓');
    expect(className).toContain('hint-warn-inline');
    expect(className).not.toContain('hint-ok');
  });

  it('warns about FAILED closes on their own (rows still active)', async () => {
    const { text, className } = await saveAgentWithSweep({
      closedMismatchedSessions: 1,
      closedMismatchedResidual: 0,
      closedMismatchedFailed: 4,
    });

    expect(text).toContain('4');
    expect(text).toContain('关闭失败');
    expect(text).not.toContain('远端会话未取消');
    expect(text).not.toContain('✓');
    expect(className).toContain('hint-warn-inline');
    expect(className).not.toContain('hint-ok');
  });

  it('shows the residual task ids on success, not just a count', async () => {
    // A count is not actionable; the id is the only handle for manual cleanup.
    const { text } = await saveAgentWithSweep({
      closedMismatchedSessions: 2,
      closedMismatchedResidual: 1,
      closedMismatchedFailed: 0,
      closedMismatchedResidualTaskIds: ['mojo-parked-9'],
    });

    expect(text).toContain('mojo-parked-9');
  });

  it('reports an aborted switch with its residual ids, and does not patch the bot', async () => {
    const previousFetch = globalThis.fetch;
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({
        ok: false,
        error: 'agent_switch_close_failed',
        closedMismatchedSessions: 1,
        closedMismatchedResidual: 1,
        closedMismatchedFailed: 1,
        closedMismatchedResidualTaskIds: ['mojo-parked-9'],
      }),
    } as any));
    try {
      const patchBot = vi.fn();
      const { root } = renderAgent({ cliId: 'codex' }, patchBot);
      await act(async () => {
        root.findByProps({ 'data-action': 'save-agent' }).props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });

      const text = root.findByProps({ 'data-agent-status': '' }).children.join('');
      // Not a bare error code: says the switch did NOT happen, plus the counts…
      expect(text).toContain('Agent 未切换');
      // …and the surviving remote id.
      expect(text).toContain('mojo-parked-9');
      // The config was not committed, so the local bot row must not be patched.
      expect(patchBot).not.toHaveBeenCalled();
    } finally {
      (globalThis as any).fetch = previousFetch;
    }
  });

  it('shows unknown (and stays warn) when a residual count arrives with no ids', async () => {
    // Malformed payload must fail CLOSED: the count alone is evidence a remote
    // session survived, so it cannot render as a silent success.
    const { text, className } = await saveAgentWithSweep({
      closedMismatchedSessions: 1,
      closedMismatchedResidual: 1,
      closedMismatchedResidualTaskIds: [],
    });

    expect(text).toContain('unknown');
    expect(text).not.toContain('✓');
    expect(className).toContain('hint-warn-inline');
  });

  it('drops the green tick when ids arrive with no residual count', async () => {
    // The mirror case: ids are evidence too. This used to print "manual cleanup
    // required" AND the green tick at the same time.
    const { text, className } = await saveAgentWithSweep({
      closedMismatchedSessions: 1,
      closedMismatchedResidualTaskIds: ['mojo-parked-9'],
    });

    expect(text).toContain('mojo-parked-9');
    expect(text).not.toContain('✓');
    expect(className).not.toContain('hint-ok');
  });

  it('reports a commit failure that happened AFTER sessions were closed', async () => {
    // Third post-close exit: the closes are irreversible, so this response is the
    // only report of the surviving remote sessions.
    const previousFetch = globalThis.fetch;
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        ok: false,
        error: 'agent_switch_commit_failed',
        reason: 'ENOSPC',
        closedMismatchedSessions: 2,
        closedMismatchedResidual: 1,
        closedMismatchedFailed: 0,
        closedMismatchedResidualTaskIds: ['mojo-parked-9'],
      }),
    } as any));
    try {
      const patchBot = vi.fn();
      const { root } = renderAgent({ cliId: 'codex' }, patchBot);
      await act(async () => {
        root.findByProps({ 'data-action': 'save-agent' }).props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });

      const text = root.findByProps({ 'data-agent-status': '' }).children.join('');
      expect(text).toContain('Agent 未切换');
      expect(text).toContain('mojo-parked-9');
      expect(patchBot).not.toHaveBeenCalled();
    } finally {
      (globalThis as any).fetch = previousFetch;
    }
  });

  it('keeps the green tick when the sweep was completely clean', async () => {
    const { text, className } = await saveAgentWithSweep({
      closedMismatchedSessions: 2,
      closedMismatchedResidual: 0,
      closedMismatchedFailed: 0,
    });

    expect(text).toContain('✓');
    expect(className).toContain('hint-ok');
  });

  it('explicitly clears a legacy path and reports sessions closed by the runtime switch', async () => {
    const previousFetch = globalThis.fetch;
    const requests: any[] = [];
    (globalThis as any).fetch = vi.fn(async (_url: string, init?: any) => {
      // 模型下拉的 on-demand 探测请求（GET /api/cli-options/models）与本测试
      // 断言的 save 请求无关：返回空静态结果且不记入 requests，避免污染断言。
      if (String(_url).includes('/api/cli-options/models')) return { ok: true, status: 200, json: async () => ({ models: [], source: 'static' }) } as any;
      requests.push(JSON.parse(init?.body ?? '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          cliId: 'codex',
          cliRuntime: null,
          cliPathOverride: null,
          wrapperCli: null,
          model: '',
          selectionKey: 'codex',
          closedMismatchedSessions: 2,
        }),
      } as any;
    });

    try {
      const { root } = renderAgent({
        cliId: 'codex',
        cliPathOverride: '/opt/legacy/bin/legacy-codex',
      });
      act(() => root.findByProps({ 'data-action': 'runtime-official' }).props.onClick());
      await act(async () => {
        root.findByProps({ 'data-action': 'save-agent' }).props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(requests).toEqual([{ cliId: 'codex', model: '', reasoningEffort: '', cliRuntime: null }]);
      expect(root.findByProps({ 'data-agent-status': '' }).children.join('')).toContain('2');
    } finally {
      (globalThis as any).fetch = previousFetch;
    }
  });

  it('migrates a legacy path into a structured custom runtime without retyping the executable', async () => {
    const previousFetch = globalThis.fetch;
    const requests: any[] = [];
    const legacyPath = '/opt/legacy/bin/legacy-codex';
    const savedRuntime = {
      id: 'legacy-codex',
      executable: legacyPath,
      update: { provider: 'none' },
    };
    (globalThis as any).fetch = vi.fn(async (_url: string, init?: any) => {
      // 模型下拉的 on-demand 探测请求（GET /api/cli-options/models）与本测试
      // 断言的 save 请求无关：返回空静态结果且不记入 requests，避免污染断言。
      if (String(_url).includes('/api/cli-options/models')) return { ok: true, status: 200, json: async () => ({ models: [], source: 'static' }) } as any;
      requests.push(JSON.parse(init?.body ?? '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          cliId: 'codex',
          cliRuntime: savedRuntime,
          cliPathOverride: null,
          wrapperCli: null,
          model: '',
          selectionKey: 'codex',
          closedMismatchedSessions: 0,
          runtimeProbe: { version: '1.2.3', updateProvider: 'none' },
        }),
      } as any;
    });

    try {
      const { root } = renderAgent({ cliId: 'codex', cliPathOverride: legacyPath });
      act(() => root.findByProps({ 'data-action': 'runtime-custom' }).props.onClick());
      expect(root.findByProps({ 'data-input': 'agentRuntimeExecutable' }).props.value).toBe(legacyPath);
      act(() => root.findByProps({ 'data-input': 'agentRuntimeId' }).props.onChange({ currentTarget: { value: 'legacy-codex' } }));
      act(() => root.findByProps({ dataInput: 'agentRuntimeUpdateProvider' }).props.onChange('none'));
      await act(async () => {
        root.findByProps({ 'data-action': 'save-agent' }).props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(requests).toEqual([{ cliId: 'codex', model: '', reasoningEffort: '', cliRuntime: savedRuntime }]);
    } finally {
      (globalThis as any).fetch = previousFetch;
    }
  });

  it('hydrates every custom runtime field, including an npm update source', () => {
    const { root } = renderAgent({
      cliId: 'codex',
      cliRuntime: {
        id: 'forge-codex',
        displayName: 'Forge Codex',
        executable: '/opt/forge/bin/forge-codex',
        update: { provider: 'npm', packageName: '@forge/codex' },
      },
    });

    expect(root.findByProps({ 'data-input': 'agentRuntimeMode' }).props.value).toBe('custom');
    expect(root.findByProps({ 'data-input': 'agentRuntimeId' }).props.value).toBe('forge-codex');
    expect(root.findByProps({ 'data-input': 'agentRuntimeDisplayName' }).props.value).toBe('Forge Codex');
    expect(root.findByProps({ 'data-input': 'agentRuntimeExecutable' }).props.value).toBe('/opt/forge/bin/forge-codex');
    expect(root.findByProps({ 'data-input': 'agentRuntimeUpdateProvider' }).props.value).toBe('npm');
    expect(root.findByProps({ 'data-input': 'agentRuntimePackageName' }).props.value).toBe('@forge/codex');
  });

  it('omits cliRuntime when only the model changes on an existing structured runtime', async () => {
    const previousFetch = globalThis.fetch;
    const requests: any[] = [];
    const runtime = { id: 'forge-codex', executable: 'forge-codex', update: { provider: 'none' } };
    (globalThis as any).fetch = vi.fn(async (_url: string, init?: any) => {
      // 模型下拉的 on-demand 探测请求（GET /api/cli-options/models）与本测试
      // 断言的 save 请求无关：返回空静态结果且不记入 requests，避免污染断言。
      if (String(_url).includes('/api/cli-options/models')) return { ok: true, status: 200, json: async () => ({ models: [], source: 'static' }) } as any;
      requests.push(JSON.parse(init?.body ?? '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          cliId: 'codex',
          cliRuntime: runtime,
          cliPathOverride: null,
          wrapperCli: null,
          model: 'gpt-next',
          selectionKey: 'codex',
          closedMismatchedSessions: 0,
        }),
      } as any;
    });

    try {
      const { root } = renderAgent({ cliId: 'codex', cliRuntime: runtime, model: 'gpt-old' });
      act(() => root.findByProps({ 'data-input': 'agentModel' }).props.onChange({ currentTarget: { value: 'gpt-next' } }));
      await act(async () => {
        root.findByProps({ 'data-action': 'save-agent' }).props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(requests).toEqual([{ cliId: 'codex', model: 'gpt-next', reasoningEffort: '' }]);
    } finally {
      (globalThis as any).fetch = previousFetch;
    }
  });

  it('PUTs a structured custom runtime and surfaces the backend probe', async () => {
    const previousFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: any }> = [];
    const savedRuntime = {
      id: 'forge-codex',
      displayName: 'Forge Codex',
      executable: 'forge-codex',
      update: { provider: 'npm', packageName: '@forge/codex' },
    };
    (globalThis as any).fetch = vi.fn(async (url: string, init?: any) => {
      if (String(url).includes('/api/cli-options/models')) return { ok: true, status: 200, json: async () => ({ models: [], source: 'static' }) } as any;
      requests.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          cliId: 'codex',
          cliRuntime: savedRuntime,
          wrapperCli: null,
          model: '',
          selectionKey: 'codex',
          runtimeProbe: { version: '1.4.2', updateProvider: 'npm' },
        }),
      } as any;
    });

    try {
      const patchBot = vi.fn();
      const { root } = renderAgent({ cliId: 'codex' }, patchBot);
      act(() => root.findByProps({ 'data-action': 'runtime-custom' }).props.onClick());
      act(() => root.findByProps({ 'data-input': 'agentRuntimeId' }).props.onChange({ currentTarget: { value: ' forge-codex ' } }));
      act(() => root.findByProps({ 'data-input': 'agentRuntimeDisplayName' }).props.onChange({ currentTarget: { value: ' Forge Codex ' } }));
      act(() => root.findByProps({ 'data-input': 'agentRuntimeExecutable' }).props.onChange({ currentTarget: { value: ' forge-codex ' } }));
      act(() => root.findByProps({ dataInput: 'agentRuntimeUpdateProvider' }).props.onChange('npm'));
      act(() => root.findByProps({ 'data-input': 'agentRuntimePackageName' }).props.onChange({ currentTarget: { value: ' @forge/codex ' } }));
      await act(async () => {
        root.findByProps({ 'data-action': 'save-agent' }).props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(requests).toEqual([{
        url: '/api/bots/cli_runtime/agent',
        body: { cliId: 'codex', model: '', reasoningEffort: '', cliRuntime: savedRuntime },
      }]);
      expect(patchBot).toHaveBeenCalledWith('cli_runtime', expect.objectContaining({ cliRuntime: savedRuntime }));
      const probeText = root.findByProps({ 'data-runtime-status': '' }).children.join('');
      expect(probeText).toContain('1.4.2');
      expect(probeText).toContain('npm');
    } finally {
      (globalThis as any).fetch = previousFetch;
    }
  });

  it('clears the draft after leaving Codex and PUTs null when switching back to official', async () => {
    const previousFetch = globalThis.fetch;
    const requests: any[] = [];
    (globalThis as any).fetch = vi.fn(async (_url: string, init?: any) => {
      // 模型下拉的 on-demand 探测请求（GET /api/cli-options/models）与本测试
      // 断言的 save 请求无关：返回空静态结果且不记入 requests，避免污染断言。
      if (String(_url).includes('/api/cli-options/models')) return { ok: true, status: 200, json: async () => ({ models: [], source: 'static' }) } as any;
      requests.push(JSON.parse(init?.body ?? '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, cliId: 'codex', cliRuntime: null, wrapperCli: null, model: '', selectionKey: 'codex' }),
      } as any;
    });

    try {
      const { root } = renderAgent({
        cliId: 'codex',
        cliRuntime: { id: 'forge-codex', executable: 'forge-codex', update: { provider: 'none' } },
      });
      act(() => root.findByProps({ dataInput: 'agentCliId' }).props.onChange('traex'));
      expect(root.findAllByProps({ 'data-codex-runtime': '' })).toHaveLength(0);
      act(() => root.findByProps({ dataInput: 'agentCliId' }).props.onChange('codex'));
      expect(root.findByProps({ 'data-input': 'agentRuntimeMode' }).props.value).toBe('official');
      expect(root.findAllByProps({ 'data-input': 'agentRuntimeId' })).toHaveLength(0);

      await act(async () => {
        root.findByProps({ 'data-action': 'save-agent' }).props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(requests[requests.length - 1]).toEqual({ cliId: 'codex', model: '', reasoningEffort: '', cliRuntime: null });
    } finally {
      (globalThis as any).fetch = previousFetch;
    }
  });

  it('shows backend runtime probe errors instead of the generic error code', async () => {
    const previousFetch = globalThis.fetch;
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        ok: false,
        error: 'runtime_unavailable',
        message: 'daemon PATH 找不到 forge-codex',
      }),
    }) as any);

    try {
      const { root } = renderAgent({
        cliId: 'codex',
        cliRuntime: { id: 'forge-codex', executable: 'forge-codex', update: { provider: 'none' } },
      });
      await act(async () => {
        root.findByProps({ 'data-action': 'save-agent' }).props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });
      const runtimeError = root.findByProps({ 'data-runtime-status': '' }).children.join('');
      expect(runtimeError).toContain('daemon PATH 找不到 forge-codex');
      expect(runtimeError).not.toContain('runtime_unavailable');
    } finally {
      (globalThis as any).fetch = previousFetch;
    }
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
  it('save-riff saves the riff config first, then persists the CLI selection (PUT /riff → /agent)', async () => {
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
    // Agent 配置已下线：面板不得再渲染 riff-agent 输入框
    expect(root.findAllByProps({ 'data-input': 'riff-agent' })).toHaveLength(0);
    // 运行环境选择 CN、思考等级选择 xhigh → 保存的 PUT /riff 必须一起携带
    // sandboxCluster / reasoningEffort。
    act(() => { root.findByProps({ dataInput: 'riff-sandbox-cluster' }).props.onChange('cn'); });
    act(() => { root.findByProps({ dataInput: 'riff-reasoning-effort' }).props.onChange('xhigh'); });
    const baseUrlInput = root.findByProps({ 'data-input': 'riff-base-url' });
    act(() => { baseUrlInput.props.onChange({ currentTarget: { value: 'https://riff.example' } }); });
    // 点「保存 Riff 配置」→ 先 PUT /riff 存配置，成功后再 PUT /agent 落盘
    // cliId=riff（反过来会在 /riff 失败时留下已切 riff+空配置+旧会话被关的半配置态）
    await act(async () => { await root.findByProps({ 'data-action': 'save-riff' }).props.onClick(); });
    const puts = requests.filter(r => r.method === 'PUT');
    expect(puts.map(r => r.url.split('/').pop())).toEqual(['riff', 'agent']);
    expect(puts[1]!.body).toEqual({ cliId: 'riff', model: '' });
    expect(JSON.parse(puts[0]!.body.riff)).toMatchObject({ sandboxCluster: 'cn', reasoningEffort: 'xhigh' });
  });
});

describe('riff save consumes the agent-switch close summary', () => {
  function renderRiff(agentBody: any, agentStatus = 200) {
    const patchBot = vi.fn();
    (globalThis as any).fetch = async (url: string) => (String(url).endsWith('/agent')
      ? { ok: agentStatus === 200, status: agentStatus, json: async () => agentBody } as any
      : { ok: true, status: 200, json: async () => ({ ok: true, riff: JSON.stringify({ baseUrl: 'https://riff.example' }) }) } as any);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(BotAgentSection, {
        bot: { larkAppId: 'cli_riff_sum', cliId: 'codex', model: '' },
        sessionFallback: 'codex',
        cliState: {
          options: [{ id: 'codex', label: 'Codex' }, { id: 'riff', label: 'Riff' }],
          ttadkModelDefault: 'glm-5.1',
          ttadkModelSuggestions: [],
        },
        patchBot,
      }));
    });
    act(() => { renderer.root.findByProps({ dataInput: 'agentCliId' }).props.onChange('riff'); });
    return { root: renderer.root, patchBot };
  }

  it('200 + residual: shows the id in the RIFF status and is not green', async () => {
    // setAgentStatus is rendered in the !isRiff branch, so a residual reported
    // there while Riff is selected is invisible. It has to land on this section.
    const { root } = renderRiff({
      ok: true,
      cliId: 'riff',
      wrapperCli: null,
      model: '',
      selectionKey: 'riff',
      closedMismatchedSessions: 1,
      closedMismatchedResidual: 1,
      closedMismatchedResidualTaskIds: ['mojo-parked-9'],
    });

    await act(async () => { await root.findByProps({ 'data-action': 'save-riff' }).props.onClick(); });

    const status = root.findByProps({ 'data-riff-status': '' });
    expect(status.children.join('')).toContain('mojo-parked-9');
    expect(status.children.join('')).not.toContain('✓');
  });

  it('409 aborted switch: shows Agent-not-switched + id, and does not patch cliId', async () => {
    const { root, patchBot } = renderRiff({
      ok: false,
      error: 'agent_switch_close_failed',
      closedMismatchedSessions: 1,
      closedMismatchedResidual: 1,
      closedMismatchedFailed: 1,
      closedMismatchedResidualTaskIds: ['mojo-parked-9'],
    }, 409);

    await act(async () => { await root.findByProps({ 'data-action': 'save-riff' }).props.onClick(); });

    const text = root.findByProps({ 'data-riff-status': '' }).children.join('');
    // Riff-specific truth: the /riff write already succeeded, so it must NOT claim
    // the config is unchanged — only the Agent selection failed to switch.
    expect(text).toContain('Riff 配置已保存');
    expect(text).toContain('Agent 选择未切换');
    expect(text).toContain('mojo-parked-9');
    // Exactly one status icon (the key used to carry its own ✗ as well).
    expect(text.match(/✗/g)?.length ?? 0).toBe(1);
    // The /riff write succeeded, but cliId must NOT be flipped to riff.
    expect(patchBot.mock.calls.some(c => (c[1] as any)?.cliId === 'riff')).toBe(false);
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

describe('reply-card usage display mode', () => {
  it('defaults to streaming and persists explicit footer/off changes', async () => {
    const putCardPref = vi.fn(async (patch: Record<string, string>) => ({
      ok: true,
      status: 200,
      body: { ok: true, ...patch },
    }));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(CardBehaviorSection, {
        bot: { larkAppId: 'cli_usage', usageSupported: true },
        putCardPref,
      }));
    });

    const menu = () => renderer.root.findByProps({ id: 'bd-menu-usageDisplay' });
    expect(menu().props.value).toBe('streaming');

    await act(async () => {
      menu().props.onChange('footer');
      await Promise.resolve();
    });
    expect(putCardPref).toHaveBeenLastCalledWith({ usageDisplay: 'footer' });
    expect(menu().props.value).toBe('footer');

    await act(async () => {
      menu().props.onChange('off');
      await Promise.resolve();
    });
    expect(putCardPref).toHaveBeenLastCalledWith({ usageDisplay: 'off' });
    expect(menu().props.value).toBe('off');
  });

  it('rolls back when persistence fails', async () => {
    const putCardPref = vi.fn(async () => ({
      ok: false,
      status: 500,
      body: { error: 'write_failed' },
    }));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(CardBehaviorSection, {
        bot: { larkAppId: 'cli_usage', usageSupported: true },
        putCardPref,
      }));
    });

    const menu = () => renderer.root.findByProps({ id: 'bd-menu-usageDisplay' });
    await act(async () => {
      menu().props.onChange('off');
      await Promise.resolve();
    });

    expect(menu().props.value).toBe('streaming');
    expect(renderer.root.findByProps({ 'data-card-pref-status': '' }).children.join(''))
      .toContain('write_failed');
  });
});

describe('card behavior defaults', () => {
  it('defaults to automatic cards while keeping explicit card-off controls usable', () => {
    let existing!: TestRenderer.ReactTestRenderer;
    let cardOff!: TestRenderer.ReactTestRenderer;
    const putCardPref = vi.fn(async () => ({ ok: true, status: 200, body: { ok: true } }));

    act(() => {
      existing = TestRenderer.create(React.createElement(CardBehaviorSection, {
        bot: { larkAppId: 'cli_existing' },
        putCardPref,
      }));
      cardOff = TestRenderer.create(React.createElement(CardBehaviorSection, {
        bot: { larkAppId: 'cli_new', disableStreamingCard: true },
        putCardPref,
      }));
    });

    expect(existing.root.findByProps({ 'data-action': 'toggle-disable-streaming' }).props.checked).toBe(true);
    expect(existing.root.findByProps({ 'data-card-off-options': true }).props.hidden).toBe(true);
    expect(cardOff.root.findByProps({ 'data-action': 'toggle-disable-streaming' }).props.checked).toBe(false);
    expect(cardOff.root.findByProps({ 'data-card-off-options': true }).props.hidden).toBe(false);
    expect(cardOff.root.findByProps({ 'data-action': 'toggle-silent-reactions' }).props.checked).toBe(true);
    expect(cardOff.root.findByProps({ 'data-action': 'toggle-silent-reactions' }).props.disabled).toBe(false);
    expect(cardOff.root.findByProps({ 'data-action': 'toggle-pin-streaming-card' }).props.checked).toBe(false);
    expect(cardOff.root.findByProps({ 'data-action': 'toggle-pin-streaming-card' }).props.disabled).toBe(false);
    expect(cardOff.root.findByProps({ 'data-action': 'toggle-writable-link' }).props.disabled).toBe(false);
    expect(cardOff.root.findByProps({ 'data-card-pref-status': '' }).props).toMatchObject({
      role: 'status',
      'aria-live': 'polite',
    });
  });

  it('pin streaming toggle defaults unchecked when the payload omits it', () => {
    const putCardPref = vi.fn(async () => ({ ok: true, status: 200, body: { ok: true } }));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(CardBehaviorSection, {
        bot: { larkAppId: 'cli_pin_absent' },
        putCardPref,
      }));
    });

    expect(renderer.root.findByProps({ 'data-action': 'toggle-pin-streaming-card' }).props.checked).toBe(false);
  });

  it('toggling pin streaming on persists pinStreamingCard=true', async () => {
    const putCardPref = vi.fn(async (patch: Record<string, boolean>) => ({
      ok: true,
      status: 200,
      body: { ok: true, ...patch },
    }));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(CardBehaviorSection, {
        bot: { larkAppId: 'cli_pin_toggle' },
        putCardPref,
      }));
    });

    const toggle = renderer.root.findByProps({ 'data-action': 'toggle-pin-streaming-card' });
    await act(async () => {
      toggle.props.onChange({ currentTarget: { checked: true } });
      await Promise.resolve();
    });

    expect(putCardPref).toHaveBeenCalledWith({ pinStreamingCard: true });
    expect(renderer.root.findByProps({ 'data-action': 'toggle-pin-streaming-card' }).props.checked).toBe(true);
  });

  it('enabling automatic cards persists disableStreamingCard=false', async () => {
    const putCardPref = vi.fn(async (patch: Record<string, boolean>) => ({
      ok: true,
      status: 200,
      body: { ok: true, ...patch },
    }));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(CardBehaviorSection, {
        bot: { larkAppId: 'cli_new', disableStreamingCard: true },
        putCardPref,
      }));
    });

    const toggle = renderer.root.findByProps({ 'data-action': 'toggle-disable-streaming' });
    await act(async () => {
      toggle.props.onChange({ currentTarget: { checked: true } });
      await Promise.resolve();
    });

    expect(putCardPref).toHaveBeenCalledWith({ disableStreamingCard: false });
    expect(renderer.root.findByProps({ 'data-action': 'toggle-disable-streaming' }).props.checked).toBe(true);
  });

  it('maps the no-card processing-status switch to the inverse storage field', async () => {
    const putCardPref = vi.fn(async (patch: Record<string, boolean>) => ({
      ok: true,
      status: 200,
      body: { ok: true, ...patch },
    }));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(CardBehaviorSection, {
        bot: { larkAppId: 'cli_no_card', disableStreamingCard: true },
        putCardPref,
      }));
    });

    const toggle = renderer.root.findByProps({ 'data-action': 'toggle-silent-reactions' });
    expect(toggle.props.checked).toBe(true);
    await act(async () => {
      toggle.props.onChange({ currentTarget: { checked: false } });
      await Promise.resolve();
    });

    expect(putCardPref).toHaveBeenCalledWith({ silentTurnReactions: true });
    expect(renderer.root.findByProps({ 'data-action': 'toggle-silent-reactions' }).props.checked).toBe(false);
  });

  it('rolls every card toggle back when persistence fails', async () => {
    const putCardPref = vi.fn(async () => ({
      ok: false,
      status: 500,
      body: { error: 'write_failed' },
    }));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(CardBehaviorSection, {
        bot: { larkAppId: 'cli_card_fail', disableStreamingCard: true },
        putCardPref,
      }));
    });

    for (const action of ['toggle-disable-streaming', 'toggle-silent-reactions', 'toggle-pin-streaming-card', 'toggle-writable-link', 'toggle-private-card']) {
      const before = renderer.root.findByProps({ 'data-action': action }).props.checked;
      await act(async () => {
        renderer.root.findByProps({ 'data-action': action }).props.onChange({ currentTarget: { checked: !before } });
        await Promise.resolve();
      });
      expect(renderer.root.findByProps({ 'data-action': action }).props.checked).toBe(before);
    }
    expect(renderer.root.findByProps({ 'data-card-pref-status': '' }).children.join('')).toContain('write_failed');
  });

  it('uses a single-flight save so another card setting cannot race it', async () => {
    let finish!: (value: { ok: true; status: 200; body: { ok: true } }) => void;
    const pending = new Promise<{ ok: true; status: 200; body: { ok: true } }>(resolve => { finish = resolve; });
    const putCardPref = vi.fn(() => pending);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(CardBehaviorSection, {
        bot: { larkAppId: 'cli_card_busy', disableStreamingCard: true, usageSupported: true },
        putCardPref,
      }));
    });

    act(() => {
      renderer.root.findByProps({ 'data-action': 'toggle-disable-streaming' }).props.onChange({ currentTarget: { checked: true } });
    });

    for (const action of ['toggle-disable-streaming', 'toggle-silent-reactions', 'toggle-pin-streaming-card', 'toggle-writable-link', 'toggle-private-card']) {
      expect(renderer.root.findByProps({ 'data-action': action }).props.disabled).toBe(true);
    }
    expect(renderer.root.findByProps({ id: 'bd-menu-usageDisplay' }).props.disabled).toBe(true);

    await act(async () => {
      finish({ ok: true, status: 200, body: { ok: true } });
      await pending;
    });
    expect(renderer.root.findByProps({ 'data-action': 'toggle-private-card' }).props.disabled).toBe(false);
  });
});
