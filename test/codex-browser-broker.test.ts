import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CODEX_BROWSER_TOOL_NAME,
  CodexBrowserBroker,
  resolveCodexBrowserPluginRoot,
  type DynamicToolCallParams,
} from '../src/services/codex-browser-broker.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function call(arguments_: Record<string, unknown>): DynamicToolCallParams {
  return {
    arguments: arguments_,
    callId: 'call-1',
    namespace: null,
    threadId: 'thread-1',
    tool: CODEX_BROWSER_TOOL_NAME,
    turnId: 'turn-1',
  };
}

function fakeModules() {
  const actions: string[] = [];
  const tab = {
    id: 'claimed-7',
    ax: {
      click: vi.fn(async (index: number) => { actions.push(`click:${index}`); }),
      get: vi.fn(async () => 'AX snapshot: button "Continue" [12]'),
      pressKey: vi.fn(async (key: string) => { actions.push(`key:${key}`); }),
      scroll: vi.fn(async () => { actions.push('scroll'); }),
      setValue: vi.fn(async (index: number, value: string) => { actions.push(`set:${index}:${value}`); }),
      typeText: vi.fn(async (value: string) => { actions.push(`type:${value}`); }),
    },
    back: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    forward: vi.fn(async () => {}),
    goto: vi.fn(async (url: string) => { actions.push(`goto:${url}`); }),
    markDeliverable: vi.fn(async () => {}),
    markHandoff: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    screenshot: vi.fn(async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9])),
    title: vi.fn(async () => 'Example'),
    url: vi.fn(async () => 'https://example.test/'),
  };
  const browser = {
    browserId: 'browser-1',
    nameSession: vi.fn(async () => {}),
    tabs: {
      get: vi.fn(async () => tab),
      list: vi.fn(async () => [{ id: tab.id }]),
      new: vi.fn(async () => tab),
      selected: vi.fn(async () => tab),
    },
    user: {
      claimTab: vi.fn(async () => tab),
      openTabs: vi.fn(async () => [{
        id: 'user-7',
        title: 'Existing tab',
        url: 'https://example.test/',
      }]),
    },
  };
  return {
    actions,
    browser,
    modules: {
      handleRpc: vi.fn(async () => ({})),
      setupBrowserRuntime: vi.fn(async () => ({
        browsers: { get: vi.fn(async () => browser) },
      })),
    },
  };
}

describe.sequential('CodexBrowserBroker', () => {
  let broker: CodexBrowserBroker | undefined;

  afterEach(() => {
    broker?.close();
    broker = undefined;
  });

  it('lists and claims only explicitly requested user tabs', async () => {
    const fake = fakeModules();
    broker = new CodexBrowserBroker({
      sessionId: 'session-1',
      family: 'chrome',
      modules: fake.modules,
    });

    const listed = await broker.handleToolCall(call({ operation: 'list_tabs' }));
    expect(listed.success).toBe(true);
    expect(listed.contentItems[0]).toMatchObject({ type: 'inputText' });
    expect((listed.contentItems[0] as { text: string }).text).toContain('user-7');

    const claimed = await broker.handleToolCall(call({ operation: 'claim_tab', tabId: 'user-7' }));
    expect(claimed.success).toBe(true);
    expect(fake.browser.user.claimTab).toHaveBeenCalledOnce();
  });

  it('supports bounded accessibility actions without arbitrary JavaScript', async () => {
    const fake = fakeModules();
    broker = new CodexBrowserBroker({
      sessionId: 'session-2',
      family: 'chrome',
      modules: fake.modules,
    });

    const snapshot = await broker.handleToolCall(call({ operation: 'snapshot', tabId: 'claimed-7' }));
    expect(snapshot).toEqual({
      contentItems: [{ type: 'inputText', text: 'AX snapshot: button "Continue" [12]' }],
      success: true,
    });
    expect((await broker.handleToolCall(call({
      operation: 'click',
      tabId: 'claimed-7',
      elementIndex: 12,
    }))).success).toBe(true);
    expect(fake.actions).toContain('click:12');

    const rejected = await broker.handleToolCall(call({
      operation: 'evaluate_javascript',
      tabId: 'claimed-7',
      value: 'document.cookie',
    }));
    expect(rejected.success).toBe(false);
    expect((rejected.contentItems[0] as { text: string }).text).toContain('unsupported browser operation');

    expect((await broker.handleToolCall(call({
      operation: 'set_value',
      tabId: 'claimed-7',
      elementIndex: 4,
      value: '',
    }))).success).toBe(true);
    expect(fake.actions).toContain('set:4:');
  });

  it('returns screenshots as app-server image content', async () => {
    const fake = fakeModules();
    broker = new CodexBrowserBroker({
      sessionId: 'session-3',
      family: 'chrome',
      modules: fake.modules,
    });
    const result = await broker.handleToolCall(call({ operation: 'screenshot', tabId: 'claimed-7' }));
    expect(result).toEqual({
      contentItems: [{ type: 'inputImage', imageUrl: 'data:image/jpeg;base64,/9j/2Q==' }],
      success: true,
    });
  });

  it('fails closed for a different tool or namespace', async () => {
    const fake = fakeModules();
    broker = new CodexBrowserBroker({
      sessionId: 'session-4',
      family: 'chrome',
      modules: fake.modules,
    });
    expect((await broker.handleToolCall({ ...call({ operation: 'list_tabs' }), tool: 'shell' })).success).toBe(false);
    expect((await broker.handleToolCall({ ...call({ operation: 'list_tabs' }), namespace: 'raw' })).success).toBe(false);
    expect(fake.modules.setupBrowserRuntime).not.toHaveBeenCalled();
  });
});

describe('resolveCodexBrowserPluginRoot', () => {
  it('rejects an explicit relative plugin root', () => {
    expect(() => resolveCodexBrowserPluginRoot('./chrome-plugin')).toThrow(
      'Codex browser plugin root must be absolute',
    );
  });

  it('discovers the newest complete installed plugin without requiring a latest symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-browser-plugin-'));
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = root;
      for (const version of ['26.9.0', '26.10.1']) {
        const scripts = join(root, 'plugins', 'cache', 'openai-bundled', 'chrome', version, 'scripts');
        mkdirSync(scripts, { recursive: true });
        writeFileSync(join(scripts, 'browser-client.mjs'), 'export {}');
        writeFileSync(join(scripts, 'browser-service.mjs'), 'export {}');
      }
      expect(resolveCodexBrowserPluginRoot()).toBe(
        join(root, 'plugins', 'cache', 'openai-bundled', 'chrome', '26.10.1'),
      );
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
