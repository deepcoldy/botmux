import { afterEach, describe, expect, it, vi } from 'vitest';
const approvalExec = vi.hoisted(() => vi.fn((...args: any[]) => {
  args.at(-1)(null, JSON.stringify({ answer: 'approve' }), '');
}));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFile: approvalExec,
}));
import {
  CODEX_BROWSER_TOOL_NAME,
  CodexBrowserBroker,
  resolveCodexBrowserPluginRoot,
  type DynamicToolCallParams,
} from '../src/services/codex-browser-broker.js';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
    tab,
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
    vi.unstubAllEnvs();
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

  it('retries browser discovery after a transient extension connection failure', async () => {
    const fake = fakeModules();
    const get = vi.fn()
      .mockRejectedValueOnce(new Error('Browser is not available: chrome'))
      .mockResolvedValue(fake.browser);
    fake.modules.setupBrowserRuntime = vi.fn(async () => ({ browsers: { get } }));
    broker = new CodexBrowserBroker({
      sessionId: 'session-reconnect',
      family: 'chrome',
      modules: fake.modules,
    });

    const disconnected = await broker.handleToolCall(call({ operation: 'list_tabs' }));
    expect(disconnected.success).toBe(false);
    expect((disconnected.contentItems[0] as { text: string }).text).toContain('Browser is not available: chrome');

    const reconnected = await broker.handleToolCall(call({ operation: 'list_tabs' }));
    expect(reconnected.success).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
    expect(fake.modules.setupBrowserRuntime).toHaveBeenCalledTimes(2);
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

  it('detects optional capabilities and falls back from AX to the visible DOM', async () => {
    const fake = fakeModules();
    delete (fake.tab as { ax?: unknown }).ax;
    Object.assign(fake.tab, {
      capabilities: { list: vi.fn(async () => ['tab.example']) },
      dom_cua: {
        get_visible_dom: vi.fn(async () => ({ node_id: 'dom-1', role: 'button', text: 'Continue' })),
      },
    });
    Object.assign(fake.browser, {
      capabilities: { list: vi.fn(async () => ['browser.example']) },
    });
    broker = new CodexBrowserBroker({
      sessionId: 'session-dom',
      family: 'chrome',
      modules: fake.modules,
    });

    const snapshot = await broker.handleToolCall(call({ operation: 'snapshot', tabId: 'claimed-7' }));
    expect(snapshot.success).toBe(true);
    expect((snapshot.contentItems[0] as { text: string }).text).toContain('visible_dom');
    expect((snapshot.contentItems[0] as { text: string }).text).toContain('Continue');

    const capabilities = await broker.handleToolCall(call({ operation: 'capabilities', tabId: 'claimed-7' }));
    expect(capabilities.success).toBe(true);
    expect(JSON.parse((capabilities.contentItems[0] as { text: string }).text)).toMatchObject({
      interaction: { accessibility: false, domCua: true, playwright: false },
      advertised: {
        browser: { available: true, ids: ['browser.example'] },
        tab: { available: true, ids: ['tab.example'] },
      },
    });
  });

  it('uses typed Playwright locators without exposing JavaScript evaluation', async () => {
    const fake = fakeModules();
    const locator = {
      click: vi.fn(async () => {}),
      first: vi.fn(),
    };
    locator.first.mockReturnValue(locator);
    Object.assign(fake.tab, {
      playwright: {
        getByRole: vi.fn(() => locator),
      },
    });
    broker = new CodexBrowserBroker({
      sessionId: 'session-locator',
      family: 'chrome',
      modules: fake.modules,
    });

    const result = await broker.handleToolCall(call({
      operation: 'locator_click',
      tabId: 'claimed-7',
      locatorType: 'role',
      role: 'button',
      name: 'Continue',
      exact: true,
      pick: 'first',
      timeoutMs: 5000,
    }));
    expect(result.success).toBe(true);
    expect((fake.tab as any).playwright.getByRole).toHaveBeenCalledWith('button', {
      exact: true,
      name: 'Continue',
    });
    expect(locator.click).toHaveBeenCalledWith({
      button: undefined,
      modifiers: undefined,
      timeoutMs: 5000,
    });
  });

  it('uses an explicit 10-second default for file chooser uploads', async () => {
    const fake = fakeModules();
    const setFiles = vi.fn(async () => {});
    const chooser = {
      isMultiple: vi.fn(() => false),
      setFiles,
    };
    const waitForEvent = vi.fn(async () => chooser);
    const locator = {
      click: vi.fn(async () => {}),
      isVisible: vi.fn(async () => true),
    };
    Object.assign(fake.tab, {
      playwright: {
        locator: vi.fn(() => locator),
        waitForEvent,
      },
    });
    broker = new CodexBrowserBroker({
      sessionId: 'session-upload',
      family: 'chrome',
      modules: fake.modules,
    });

    const result = await broker.handleToolCall(call({
      operation: 'locator_upload',
      tabId: 'claimed-7',
      selector: 'input[type="file"]',
      files: ['/tmp/example.mp4'],
    }));

    expect(result.success).toBe(true);
    expect(waitForEvent).toHaveBeenCalledWith('filechooser', { timeoutMs: 10_000 });
    expect(locator.click).toHaveBeenCalledWith({
      button: undefined,
      modifiers: undefined,
      timeoutMs: 10_000,
    });
    expect(setFiles).toHaveBeenCalledWith('/tmp/example.mp4', { timeoutMs: 10_000 });
  });

  it('consumes a late file chooser rejection when the upload click fails first', async () => {
    const fake = fakeModules();
    let rejectChooser!: (reason: Error) => void;
    const chooserPromise = new Promise<never>((_resolve, reject) => {
      rejectChooser = reject;
    });
    const locator = {
      click: vi.fn(async () => { throw new Error('upload input is not clickable'); }),
      isVisible: vi.fn(async () => true),
    };
    Object.assign(fake.tab, {
      playwright: {
        locator: vi.fn(() => locator),
        waitForEvent: vi.fn(() => chooserPromise),
      },
    });
    broker = new CodexBrowserBroker({
      sessionId: 'session-upload-click-failure',
      family: 'chrome',
      modules: fake.modules,
    });

    const result = await broker.handleToolCall(call({
      operation: 'locator_upload',
      tabId: 'claimed-7',
      selector: 'input[type="file"]',
      files: ['/tmp/example.mp4'],
    }));

    expect(result.success).toBe(false);
    expect((result.contentItems[0] as { text: string }).text).toContain('upload input is not clickable');
    rejectChooser(new Error('late file chooser timeout'));
    await new Promise(resolve => setImmediate(resolve));
  });

  it('downloads through the locator and returns the downloaded path', async () => {
    const fake = fakeModules();
    const path = vi.fn(async () => '/tmp/report.csv');
    const click = vi.fn(async () => {});
    const waitForEvent = vi.fn(async () => ({ path }));
    Object.assign(fake.tab, { playwright: { locator: () => ({ click }), waitForEvent } });
    broker = new CodexBrowserBroker({ sessionId: 'download', family: 'chrome', modules: fake.modules });
    const result = await broker.handleToolCall(call({ operation: 'locator_download', tabId: 'claimed-7', selector: 'button', timeoutMs: 5000 }));
    expect(result.success).toBe(true);
    expect(waitForEvent).toHaveBeenCalledWith('download', { timeoutMs: 5000 });
    expect(path).toHaveBeenCalledWith({ timeoutMs: 5000 });
  });

  it('attaches a download rejection handler before clicking, including when the click fails', async () => {
    const fake = fakeModules();
    let rejectDownload!: (reason: Error) => void;
    const waiter = new Promise<never>((_, reject) => { rejectDownload = reject; });
    // Inspect registration directly: vi.fn returning a promise can otherwise
    // mask an unhandled rejection in Vitest's bookkeeping.
    const consume = vi.spyOn(waiter, 'catch');
    let attachedBeforeClick = false;
    Object.assign(fake.tab, { playwright: {
      locator: () => ({ click: async () => {
        attachedBeforeClick = consume.mock.calls.length > 0;
        throw new Error('download click failed');
      } }),
      waitForEvent: () => waiter,
    } });
    broker = new CodexBrowserBroker({ sessionId: 'download-failure', family: 'chrome', modules: fake.modules });
    const result = await broker.handleToolCall(call({ operation: 'locator_download', tabId: 'claimed-7', selector: 'button' }));
    expect(result.success).toBe(false);
    expect((result.contentItems[0] as { text: string }).text).toContain('download click failed');
    expect(attachedBeforeClick).toBe(true);
    rejectDownload(new Error('late download timeout'));
    await new Promise(resolve => setImmediate(resolve));
  });

  it('rejects a hidden upload input before starting a file chooser waiter', async () => {
    const fake = fakeModules();
    const waitForEvent = vi.fn();
    const locator = {
      click: vi.fn(),
      isVisible: vi.fn(async () => false),
    };
    Object.assign(fake.tab, {
      playwright: {
        locator: vi.fn(() => locator),
        waitForEvent,
      },
    });
    broker = new CodexBrowserBroker({
      sessionId: 'session-upload-hidden-input',
      family: 'chrome',
      modules: fake.modules,
    });

    const result = await broker.handleToolCall(call({
      operation: 'locator_upload',
      tabId: 'claimed-7',
      selector: 'input[type="file"]',
      files: ['/tmp/example.mp4'],
    }));

    expect(result.success).toBe(false);
    expect((result.contentItems[0] as { text: string }).text).toContain('upload locator is hidden');
    expect(waitForEvent).not.toHaveBeenCalled();
    expect(locator.click).not.toHaveBeenCalled();
  });

  it('forwards browser safety elicitations to the injected approval handler', async () => {
    const fake = fakeModules();
    const requestApproval = vi.fn(async () => ({ action: 'accept' as const, meta: { reviewer: 'user-1' } }));
    broker = new CodexBrowserBroker({
      sessionId: 'session-approval',
      family: 'chrome',
      modules: fake.modules,
      requestApproval,
    });
    await broker.handleToolCall(call({ operation: 'list_tabs' }));

    const request = {
      message: 'Allow upload?',
      meta: { codex_approval_kind: 'mcp_tool_call', origin: 'https://example.test' },
    };
    const response = await (globalThis as any).nodeRepl.createElicitation(request);
    expect(requestApproval).toHaveBeenCalledWith(request);
    expect(response).toEqual({ action: 'accept', meta: { reviewer: 'user-1' } });
  });

  it('caches accepted session-scoped approvals per origin and tool', async () => {
    const fake = fakeModules();
    const requestApproval = vi.fn(async () => ({ action: 'accept' as const }));
    broker = new CodexBrowserBroker({
      sessionId: 'session-approval-cache',
      family: 'chrome',
      modules: fake.modules,
      requestApproval,
    });
    await broker.handleToolCall(call({ operation: 'list_tabs' }));

    const request = {
      message: 'Allow upload?',
      meta: {
        codex_approval_kind: 'mcp_tool_call',
        persist: ['session', 'always'],
        origin: 'https://example.test',
        tool_name: 'upload_browser_files',
      },
    };
    const createElicitation = (globalThis as any).nodeRepl.createElicitation;
    await expect(createElicitation(request)).resolves.toMatchObject({
      action: 'accept',
      meta: { approval_scope: 'session-cache', persist: 'session' },
    });
    await expect(createElicitation(request)).resolves.toMatchObject({
      action: 'accept',
      meta: { approval_scope: 'session-cache', approved_by: 'authorized_user_session' },
    });
    await expect(createElicitation({
      ...request,
      meta: { ...request.meta, origin: 'https://other.example' },
    })).resolves.toMatchObject({ action: 'accept' });

    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  it('reads browser security policy from the owning Codex app-server', async () => {
    const fake = fakeModules();
    const readConfig = vi.fn(async () => ({ config: { browser_use: {} }, origins: {} }));
    const readConfigRequirements = vi.fn(async () => ({ requirements: null }));
    broker = new CodexBrowserBroker({
      sessionId: 'session-policy',
      family: 'chrome',
      modules: fake.modules,
      readConfig,
      readConfigRequirements,
    });
    await broker.handleToolCall(call({ operation: 'list_tabs' }));

    await expect((globalThis as any).nodeRepl.config.read({
      cwd: '/tmp/example',
      includeLayers: false,
    })).resolves.toEqual({ config: { browser_use: {} }, origins: {} });
    await expect((globalThis as any).nodeRepl.config.readRequirements())
      .resolves.toEqual({ requirements: null });
    expect(readConfig).toHaveBeenCalledWith({ cwd: '/tmp/example', includeLayers: false });
    expect(readConfigRequirements).toHaveBeenCalledOnce();
  });

  it('fails closed for secure browser authentication elicitations', async () => {
    for (const key of ['BOTMUX_SESSION_ID', 'BOTMUX_CHAT_ID', 'BOTMUX_LARK_APP_ID', 'BOTMUX_ROOT_MESSAGE_ID']) {
      vi.stubEnv(key, 'browser-auth-test');
    }
    approvalExec.mockClear();
    const fake = fakeModules();
    broker = new CodexBrowserBroker({
      sessionId: 'session-auth',
      family: 'chrome',
      modules: fake.modules,
    });
    await broker.handleToolCall(call({ operation: 'list_tabs' }));
    await expect((globalThis as any).nodeRepl.createElicitation({
      message: 'Enter credentials',
      meta: { codex_approval_kind: 'browser_auth' },
    })).resolves.toEqual({ action: 'cancel' });
    expect(approvalExec).not.toHaveBeenCalled();
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
        realpathSync(join(root, 'plugins', 'cache', 'openai-bundled', 'chrome', '26.10.1')),
      );
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
