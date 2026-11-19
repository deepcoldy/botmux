import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { HerdrConfigSection, herdrConfigVisible } from '../src/dashboard/web/bot-defaults-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('herdr config section visibility', () => {
  it('is visible only when the effective paired backend is herdr', () => {
    // bot 显式覆盖 backendType。
    expect(herdrConfigVisible({ cliId: 'claude-code', backendType: 'herdr' })).toBe(true);
    expect(herdrConfigVisible({ cliId: 'claude-code', backendType: 'tmux' })).toBe(false);
    expect(herdrConfigVisible({ cliId: 'claude-code', backendType: 'pty' })).toBe(false);
    // 覆盖缺省时看 daemon 默认后端。
    expect(herdrConfigVisible({ cliId: 'claude-code', backendType: null, defaultBackendType: 'herdr' })).toBe(true);
    expect(herdrConfigVisible({ cliId: 'claude-code', backendType: null, defaultBackendType: 'tmux' })).toBe(false);
    // 两者都未知 → 不展示。
    expect(herdrConfigVisible({ cliId: 'claude-code' })).toBe(false);
  });
});

describe('HerdrConfigSection', () => {
  function renderSection(bot: Record<string, unknown>, responses: Array<Record<string, unknown>>) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const body = responses.length > 0 ? responses.shift()! : { ok: true };
      return {
        ok: true,
        status: 200,
        json: async () => {
          // 模拟 daemon：回显归一后的 JSON（这里原样返回提交文本）。
          if (body.__echo && init?.body) {
            const received = JSON.parse(init.body as string) as { herdr?: string };
            return { ok: true, herdr: received.herdr ?? '' };
          }
          return body;
        },
      };
    }) as unknown as typeof fetch;
    const patchBot = vi.fn();
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      renderer = TestRenderer.create(createElement(HerdrConfigSection, {
        bot: { larkAppId: 'cli_herdr', cliId: 'claude-code', ...bot },
        patchBot,
      }));
    });
    return {
      root: renderer!.root,
      patchBot,
      calls,
      unmount() {
        if (renderer) act(() => renderer!.unmount());
        globalThis.fetch = previousFetch;
      },
    };
  }

  it('renders the stored herdr values in every control', () => {
    const h = renderSection({
      herdr: { sessionName: 'default', placement: 'split', workspace: 'w1', tab: '3', splitDirection: 'down', chatTypes: ['group'] },
    }, []);
    try {
      expect(h.root.findByProps({ 'data-input': 'herdr-session-name' }).props.value).toBe('default');
      expect(h.root.findByProps({ 'data-input': 'herdr-placement' }).props.value).toBe('split');
      expect(h.root.findByProps({ 'data-input': 'herdr-workspace' }).props.value).toBe('w1');
      expect(h.root.findByProps({ 'data-input': 'herdr-tab' }).props.value).toBe('3');
      expect(h.root.findByProps({ 'data-input': 'herdr-split-direction' }).props.value).toBe('down');
      expect(h.root.findByProps({ 'data-input': 'herdr-chat-group' }).props.checked).toBe(true);
      expect(h.root.findByProps({ 'data-input': 'herdr-chat-p2p' }).props.checked).toBe(false);
    } finally {
      h.unmount();
    }
  });

  it('PUTs the whole block as one JSON string and patches the row from the echo', async () => {
    const h = renderSection({
      herdr: { sessionName: 'default', placement: 'split', tab: '3', splitDirection: 'right', chatTypes: ['group'] },
    }, [{ __echo: true }]);
    try {
      await act(async () => {
        await h.root.findByProps({ 'data-action': 'save-herdr' }).props.onClick();
      });
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]!.url).toBe('/api/bots/cli_herdr/herdr');
      expect(JSON.parse(h.calls[0]!.init!.body as string)).toEqual({
        herdr: JSON.stringify({
          sessionName: 'default',
          placement: 'split',
          tab: '3',
          splitDirection: 'right',
          chatTypes: ['group'],
        }),
      });
      expect(h.patchBot).toHaveBeenLastCalledWith('cli_herdr', {
        herdr: { sessionName: 'default', placement: 'split', tab: '3', splitDirection: 'right', chatTypes: ['group'] },
      });
    } finally {
      h.unmount();
    }
  });

  it('includes edited text fields and checkbox toggles in the saved JSON', async () => {
    const h = renderSection({ herdr: { placement: 'tab' } }, [{ __echo: true }]);
    try {
      act(() => {
        h.root.findByProps({ 'data-input': 'herdr-session-name' }).props.onChange({ currentTarget: { value: ' default ' } });
        h.root.findByProps({ 'data-input': 'herdr-tab' }).props.onChange({ currentTarget: { value: '3' } });
        h.root.findByProps({ 'data-input': 'herdr-chat-p2p' }).props.onChange({ currentTarget: { checked: true } });
      });
      await act(async () => {
        await h.root.findByProps({ 'data-action': 'save-herdr' }).props.onClick();
      });
      expect(JSON.parse(h.calls[0]!.init!.body as string)).toEqual({
        herdr: JSON.stringify({ sessionName: 'default', placement: 'tab', tab: '3', chatTypes: ['p2p'] }),
      });
    } finally {
      h.unmount();
    }
  });

  it('sends an empty string to clear when every field is empty', async () => {
    const h = renderSection({}, [{ __echo: true }]);
    try {
      await act(async () => {
        await h.root.findByProps({ 'data-action': 'save-herdr' }).props.onClick();
      });
      expect(JSON.parse(h.calls[0]!.init!.body as string)).toEqual({ herdr: '' });
      expect(h.patchBot).toHaveBeenLastCalledWith('cli_herdr', { herdr: null });
    } finally {
      h.unmount();
    }
  });

  it('shows a Chinese error and keeps the draft when the daemon rejects the block', async () => {
    const h = renderSection({ herdr: { sessionName: 'default' } }, [{ ok: false, error: 'invalid_herdr_config: herdr.placement 必须是 workspace、tab 或 split' }]);
    try {
      await act(async () => {
        await h.root.findByProps({ 'data-action': 'save-herdr' }).props.onClick();
      });
      expect(h.patchBot).not.toHaveBeenCalled();
      const status = h.root.findByProps({ 'data-herdr-status': '' });
      const text = Array.isArray(status.props.children) ? status.props.children.join('') : String(status.props.children);
      expect(text).toContain('invalid_herdr_config');
      expect(h.root.findByProps({ 'data-input': 'herdr-session-name' }).props.value).toBe('default');
    } finally {
      h.unmount();
    }
  });
});

describe('HerdrConfigSection draft lifecycle', () => {
  function mount(bot: Record<string, unknown>) {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      renderer = TestRenderer.create(createElement(HerdrConfigSection, {
        bot: { larkAppId: 'cli_herdr', cliId: 'claude-code', ...bot },
        patchBot: vi.fn(),
      }));
    });
    return {
      root: renderer!.root,
      update(next: Record<string, unknown>) {
        act(() => {
          renderer!.update(createElement(HerdrConfigSection, {
            bot: { larkAppId: 'cli_herdr', cliId: 'claude-code', ...next },
            patchBot: vi.fn(),
          }));
        });
      },
      unmount() {
        act(() => renderer!.unmount());
      },
    };
  }

  it('does not overwrite a draft with the save echo for the same bot', () => {
    const h = mount({ herdr: { placement: 'tab' } });
    try {
      act(() => {
        h.root.findByProps({ 'data-input': 'herdr-session-name' }).props.onChange({ currentTarget: { value: 'default' } });
      });
      // 同一 bot 保存后的回显（新对象引用）不应把草稿重置回服务端值。
      h.update({ herdr: { placement: 'tab' } });
      expect(h.root.findByProps({ 'data-input': 'herdr-session-name' }).props.value).toBe('default');
    } finally {
      h.unmount();
    }
  });

  it('reinitializes the draft when switching to another bot', () => {
    const h = mount({ larkAppId: 'cli_herdr', herdr: { sessionName: 'default' } });
    try {
      act(() => {
        h.root.findByProps({ 'data-input': 'herdr-tab' }).props.onChange({ currentTarget: { value: '3' } });
      });
      h.update({ larkAppId: 'cli_other', herdr: { sessionName: 'shared', tab: '9' } });
      expect(h.root.findByProps({ 'data-input': 'herdr-session-name' }).props.value).toBe('shared');
      expect(h.root.findByProps({ 'data-input': 'herdr-tab' }).props.value).toBe('9');
    } finally {
      h.unmount();
    }
  });
});
