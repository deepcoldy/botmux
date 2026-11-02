import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEX_BROWSER_TOOL_NAME, CodexBrowserBroker, type DynamicToolCallParams } from '../src/services/codex-browser-broker.js';

function call(arguments_: Record<string, unknown>): DynamicToolCallParams {
  return { arguments: arguments_, callId: 'call-reconnect', namespace: null, threadId: 'thread-1', tool: CODEX_BROWSER_TOOL_NAME, turnId: 'turn-1' };
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

describe.sequential('browser connection recovery', () => {
  let broker: CodexBrowserBroker | undefined;
  afterEach(async () => { await broker?.close(); broker = undefined; });

  it.each(['Browser is not available: 1', 'native pipe closed before response'])(
    'rediscovers after a cached browser disconnects: %s', async message => {
      const previousRuntime = (globalThis as any).nodeRepl;
      const stale = fakeModules();
      const fresh = fakeModules();
      const get = vi.fn().mockResolvedValueOnce(stale.browser).mockResolvedValue(fresh.browser);
      stale.modules.setupBrowserRuntime = vi.fn(async () => ({ browsers: { get } }));
      broker = new CodexBrowserBroker({ sessionId: 'cached-reconnect', family: 'chrome', modules: stale.modules });

      expect((await broker.handleToolCall(call({ operation: 'claim_tab', tabId: 'user-7' }))).success).toBe(true);
      stale.browser.user.openTabs.mockRejectedValueOnce(new Error(message));
      const disconnected = await broker.handleToolCall(call({ operation: 'list_tabs' }));
      expect(disconnected.success).toBe(false);
      expect(get).toHaveBeenCalledOnce();

      const recoveredCall = { ...call({ operation: 'list_tabs' }), threadId: 'thread-recovered', turnId: 'turn-recovered' };
      fresh.browser.user.openTabs.mockImplementationOnce(async () => {
        const meta = JSON.parse((globalThis as any).nodeRepl.requestMeta['x-codex-turn-metadata']);
        expect(meta).toMatchObject({ thread_id: 'thread-recovered', turn_id: 'turn-recovered' });
        return [{ id: 'user-7', title: 'Existing tab', url: 'https://example.test/' }];
      });
      expect((await broker.handleToolCall(recoveredCall)).success).toBe(true);
      expect(get).toHaveBeenCalledTimes(2);

      expect((await broker.handleToolCall(call({ operation: 'snapshot', tabId: 'claimed-7' }))).success).toBe(false);
      expect(fresh.browser.tabs.get).not.toHaveBeenCalled();
      expect(fresh.tab.ax.get).not.toHaveBeenCalled();
      expect((await broker.handleToolCall(call({ operation: 'claim_tab', tabId: 'user-7' }))).success).toBe(true);
      expect((await broker.handleToolCall(call({ operation: 'snapshot', tabId: 'user-7' }))).success).toBe(true);
      expect(fresh.tab.ax.get).toHaveBeenCalledOnce();
      expect(stale.tab.ax.get).not.toHaveBeenCalled();
      expect(stale.modules.setupBrowserRuntime).toHaveBeenCalledOnce();
      broker.close();
      expect((globalThis as any).nodeRepl).toBe(previousRuntime);
    },
  );

  it('invalidates a disconnected binding without replaying an uncertain click', async () => {
    const stale = fakeModules();
    const fresh = fakeModules();
    const get = vi.fn().mockResolvedValueOnce(stale.browser).mockResolvedValue(fresh.browser);
    stale.modules.setupBrowserRuntime = vi.fn(async () => ({ browsers: { get } }));
    broker = new CodexBrowserBroker({ sessionId: 'uncertain-click', family: 'chrome', modules: stale.modules });
    await broker.handleToolCall(call({ operation: 'claim_tab', tabId: 'user-7' }));
    stale.tab.ax.click.mockRejectedValueOnce(new Error('native pipe closed before response'));

    const failed = await broker.handleToolCall(call({ operation: 'click', tabId: 'claimed-7', elementIndex: 12 }));
    expect(failed.success).toBe(false);
    expect(stale.tab.ax.click).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
    expect(fresh.tab.ax.click).not.toHaveBeenCalled();

    expect((await broker.handleToolCall(call({ operation: 'list_tabs' }))).success).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
    expect(stale.tab.ax.click).toHaveBeenCalledOnce();
    expect(fresh.tab.ax.click).not.toHaveBeenCalled();
  });

  it('keeps a fresh binding when an older in-flight operation fails late', async () => {
    const stale = fakeModules();
    const fresh = fakeModules();
    const get = vi.fn().mockResolvedValueOnce(stale.browser).mockResolvedValue(fresh.browser);
    stale.modules.setupBrowserRuntime = vi.fn(async () => ({ browsers: { get } }));
    broker = new CodexBrowserBroker({ sessionId: 'late-disconnect', family: 'chrome', modules: stale.modules });
    await broker.handleToolCall(call({ operation: 'claim_tab', tabId: 'user-7' }));
    let rejectClick!: (error: Error) => void;
    stale.tab.ax.click.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectClick = reject; }));
    const pending = broker.handleToolCall(call({ operation: 'click', tabId: 'claimed-7', elementIndex: 12 }));
    await vi.waitFor(() => expect(rejectClick).toBeTypeOf('function'));

    stale.browser.user.openTabs.mockRejectedValueOnce(new Error('Browser is not available: 1'));
    expect((await broker.handleToolCall(call({ operation: 'list_tabs' }))).success).toBe(false);
    expect((await broker.handleToolCall(call({ operation: 'list_tabs' }))).success).toBe(true);
    rejectClick(new Error('native pipe closed before response'));
    expect((await pending).success).toBe(false);
    expect((await broker.handleToolCall(call({ operation: 'list_tabs' }))).success).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
    expect(stale.tab.ax.click).toHaveBeenCalledOnce();
    expect(fresh.tab.ax.click).not.toHaveBeenCalled();
  });

  it.each(['Permission denied by browser safety policy', 'Locator deadline exceeded'])(
    'keeps its binding after a non-transport failure: %s', async message => {
      const fake = fakeModules();
      const get = vi.fn(async () => fake.browser);
      fake.modules.setupBrowserRuntime = vi.fn(async () => ({ browsers: { get } }));
      broker = new CodexBrowserBroker({ sessionId: 'non-transport-error', family: 'chrome', modules: fake.modules });
      await broker.handleToolCall(call({ operation: 'claim_tab', tabId: 'user-7' }));
      fake.tab.ax.click.mockRejectedValueOnce(new Error(message));
      const failed = await broker.handleToolCall(call({ operation: 'click', tabId: 'claimed-7', elementIndex: 12 }));
      expect(failed.success).toBe(false);
      // State-level proof that no invalidation happened:
      //  - the claimed tab cache stays usable through its old id, and the
      //    snapshot is still served by that tab's accessibility tree;
      //  - a bare id that was never claimed still resolves through
      //    browser.tabs.get, i.e. the reconnect-only fresh-claim gate was not
      //    armed by a benign error;
      //  - family discovery is not re-run;
      //  - the failure is not misreported as a connection change. That last
      //    assertion guards the model-facing instruction (whether the model
      //    must list/claim again), not the exact wording.
      const cachedSnapshot = await broker.handleToolCall(call({ operation: 'snapshot', tabId: 'claimed-7' }));
      expect(cachedSnapshot.success).toBe(true);
      expect((cachedSnapshot.contentItems[0] as { text: string }).text)
        .toContain('AX snapshot: button "Continue" [12]');
      const bareSnapshot = await broker.handleToolCall(call({ operation: 'snapshot', tabId: 'bare-9' }));
      expect(bareSnapshot.success).toBe(true);
      expect(fake.browser.tabs.get).toHaveBeenCalledOnce();
      expect((await broker.handleToolCall(call({ operation: 'list_tabs' }))).success).toBe(true);
      expect(get).toHaveBeenCalledOnce();
      expect(fake.modules.setupBrowserRuntime).toHaveBeenCalledOnce();
      expect((failed.contentItems[0] as { text: string }).text).not.toContain('Browser connection changed');
    },
  );

  it('retains one runtime hook and current metadata across repeated reconnects', async () => {
    const previousRuntime = (globalThis as any).nodeRepl;
    const fake = fakeModules();
    const turnEnded = vi.fn(async () => {});
    const get = vi.fn(async () => fake.browser);
    fake.modules.setupBrowserRuntime = vi.fn(async () => {
      const shim = (globalThis as any).nodeRepl;
      expect(JSON.parse(shim.requestMeta['x-codex-turn-metadata'])).toMatchObject({ thread_id: 'first-thread', turn_id: 'first-turn' });
      shim.addTurnEndedHandler({ run: turnEnded });
      return { browsers: { get } };
    });
    broker = new CodexBrowserBroker({ sessionId: 'one-runtime', family: 'edge', modules: fake.modules });
    await broker.handleToolCall({ ...call({ operation: 'list_tabs' }), threadId: 'first-thread', turnId: 'first-turn' });
    const shim = (globalThis as any).nodeRepl;
    for (let i = 0; i < 3; i++) {
      fake.browser.user.openTabs.mockRejectedValueOnce(new Error('Browser is not available: 1'));
      expect((await broker.handleToolCall(call({ operation: 'list_tabs' }))).success).toBe(false);
      expect((await broker.handleToolCall({ ...call({ operation: 'list_tabs' }), turnId: `reconnected-${i}` })).success).toBe(true);
      expect((globalThis as any).nodeRepl).toBe(shim);
      expect(JSON.parse(shim.requestMeta['x-codex-turn-metadata']).turn_id).toBe(`reconnected-${i}`);
    }
    await broker.handleTurnEnded('last-turn');
    expect(turnEnded).toHaveBeenCalledOnce();
    expect(get.mock.calls).toEqual([['edge'], ['edge'], ['edge'], ['edge']]);
    expect(fake.modules.setupBrowserRuntime).toHaveBeenCalledOnce();
    await broker.close();
    expect((globalThis as any).nodeRepl).toBe(previousRuntime);
  });

  it.each(['claim_tab', 'new_tab', 'selected_tab', 'snapshot'])(
    'rejects a late %s result instead of restoring a stale tab alias', async operation => {
      const stale = fakeModules();
      const fresh = fakeModules();
      const get = vi.fn().mockResolvedValueOnce(stale.browser).mockResolvedValue(fresh.browser);
      stale.modules.setupBrowserRuntime = vi.fn(async () => ({ browsers: { get } }));
      broker = new CodexBrowserBroker({ sessionId: 'late-acquire', family: 'chrome', modules: stale.modules });
      await broker.handleToolCall(call({ operation: 'list_tabs' }));
      let resolveTab!: (tab: typeof stale.tab) => void;
      const delayed = () => new Promise<typeof stale.tab>(resolve => { resolveTab = resolve; });
      if (operation === 'claim_tab') stale.browser.user.claimTab.mockImplementationOnce(delayed);
      else if (operation === 'new_tab') stale.browser.tabs.new.mockImplementationOnce(delayed);
      else if (operation === 'selected_tab') stale.browser.tabs.selected.mockImplementationOnce(delayed);
      else stale.browser.tabs.get.mockImplementationOnce(delayed);
      const pending = broker.handleToolCall(call({ operation, tabId: 'user-7' }));
      await vi.waitFor(() => expect(resolveTab).toBeTypeOf('function'));
      stale.browser.user.openTabs.mockRejectedValueOnce(new Error('Browser is not available: 1'));
      expect((await broker.handleToolCall(call({ operation: 'list_tabs' }))).success).toBe(false);
      expect((await broker.handleToolCall(call({ operation: 'list_tabs' }))).success).toBe(true);
      await broker.handleToolCall(call({ operation: 'claim_tab', tabId: 'user-7' }));
      resolveTab(stale.tab);
      expect((await pending).success).toBe(false);
      expect((await broker.handleToolCall(call({ operation: 'snapshot', tabId: 'user-7' }))).success).toBe(true);
      expect(stale.tab.ax.get).not.toHaveBeenCalled();
      expect(fresh.tab.ax.get).toHaveBeenCalledOnce();
    },
  );

  it('rolls back hooks registered by a setup attempt that fails halfway', async () => {
    const previous = (globalThis as any).nodeRepl;
    const fake = fakeModules();
    const abandoned = vi.fn(async () => {});
    const active = vi.fn(async () => {});
    let attempts = 0;
    fake.modules.setupBrowserRuntime = vi.fn(async () => {
      const shim = (globalThis as any).nodeRepl;
      if (attempts++ === 0) {
        shim.addTurnEndedHandler({ run: abandoned });
        throw new Error('setup interrupted after hook registration');
      }
      shim.addTurnEndedHandler({ run: active });
      return { browsers: { get: vi.fn(async () => fake.browser) } };
    });
    broker = new CodexBrowserBroker({ sessionId: 'partial-setup', family: 'chrome', modules: fake.modules });
    expect((await broker.handleToolCall(call({ operation: 'list_tabs' }))).success).toBe(false);
    expect((await broker.handleToolCall(call({ operation: 'list_tabs' }))).success).toBe(true);
    await broker.handleTurnEnded('completed-turn');
    expect(abandoned).not.toHaveBeenCalled();
    expect(active).toHaveBeenCalledOnce();
    await broker.close();
    expect((globalThis as any).nodeRepl).toBe(previous);
  });

  it('fences late errors even when discovery reuses the same browser object', async () => {
    const fake = fakeModules();
    const get = vi.fn(async () => fake.browser);
    fake.modules.setupBrowserRuntime = vi.fn(async () => ({ browsers: { get } }));
    broker = new CodexBrowserBroker({ sessionId: 'same-object', family: 'chrome', modules: fake.modules });
    await broker.handleToolCall(call({ operation: 'claim_tab', tabId: 'user-7' }));
    let rejectClick!: (error: Error) => void;
    fake.tab.ax.click.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectClick = reject; }));
    const pending = broker.handleToolCall(call({ operation: 'click', tabId: 'user-7', elementIndex: 12 }));
    await vi.waitFor(() => expect(rejectClick).toBeTypeOf('function'));
    fake.browser.user.openTabs.mockRejectedValueOnce(new Error('Browser is not available: 1'));
    expect((await broker.handleToolCall(call({ operation: 'list_tabs' }))).success).toBe(false);
    expect((await broker.handleToolCall(call({ operation: 'list_tabs' }))).success).toBe(true);
    await broker.handleToolCall(call({ operation: 'claim_tab', tabId: 'user-7' }));
    rejectClick(new Error('native pipe closed before response'));
    expect((await pending).success).toBe(false);
    expect((await broker.handleToolCall(call({ operation: 'snapshot', tabId: 'user-7' }))).success).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('does not let a late close remove a newly claimed alias', async () => {
    const stale = fakeModules();
    const fresh = stale;
    const get = vi.fn().mockResolvedValueOnce(stale.browser).mockResolvedValue(fresh.browser);
    stale.modules.setupBrowserRuntime = vi.fn(async () => ({ browsers: { get } }));
    broker = new CodexBrowserBroker({ sessionId: 'late-close', family: 'chrome', modules: stale.modules });
    await broker.handleToolCall(call({ operation: 'claim_tab', tabId: 'user-7' }));
    let finishClose!: () => void;
    stale.tab.close.mockImplementationOnce(() => new Promise<void>(resolve => { finishClose = resolve; }));
    const pending = broker.handleToolCall(call({ operation: 'close_tab', tabId: 'user-7' }));
    await vi.waitFor(() => expect(finishClose).toBeTypeOf('function'));
    stale.browser.user.openTabs.mockRejectedValueOnce(new Error('Browser is not available: 1'));
    await broker.handleToolCall(call({ operation: 'list_tabs' }));
    await broker.handleToolCall(call({ operation: 'list_tabs' }));
    await broker.handleToolCall(call({ operation: 'claim_tab', tabId: 'user-7' }));
    finishClose();
    expect((await pending).success).toBe(true);
    expect((await broker.handleToolCall(call({ operation: 'snapshot', tabId: 'claimed-7' }))).success).toBe(true);
    expect(fresh.tab.ax.get).toHaveBeenCalledOnce();
    await broker.handleToolCall(call({ operation: 'close_tab', tabId: 'user-7' }));
    expect((await broker.handleToolCall(call({ operation: 'snapshot', tabId: 'user-7' }))).success).toBe(false);
    expect(fresh.tab.ax.get).toHaveBeenCalledOnce();
  });
});
