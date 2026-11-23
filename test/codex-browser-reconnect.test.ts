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

  it('closes the service created by a failed plugin setup before retrying', async () => {
    const f = fakeModules();
    const close = vi.fn(async () => {});
    f.modules.setupBrowserRuntime.mockRejectedValueOnce(new Error('plugin setup failed'));
    broker = new CodexBrowserBroker({ sessionId: 'setup-cleanup', family: 'chrome', modules: { ...f.modules, close } });
    expect((await broker.handleToolCall(call({ operation: 'list_tabs' }))).success).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    expect((await broker.handleToolCall(call({ operation: 'list_tabs' }))).success).toBe(true);
    expect(f.modules.setupBrowserRuntime).toHaveBeenCalledTimes(2);
  });

  it('tears down and rebuilds a dead Node runtime when discovery fails', async () => {
    const close = vi.fn(async () => {});
    const get = vi.fn(async () => {
      throw new Error('Browser Node runtime exited; verify Node.js 22+ and start a fresh browser connection');
    });
    const setupBrowserRuntime = vi.fn(async () => ({ browsers: { get } }));
    broker = new CodexBrowserBroker({
      sessionId: 'dead-runtime-discovery',
      family: 'chrome',
      modules: { handleRpc: vi.fn(), setupBrowserRuntime, close },
    });

    const first = await broker.handleToolCall(call({ operation: 'list_tabs' }));
    expect(first.success).toBe(false);
    expect((first.contentItems[0] as { text: string }).text).toContain('Browser connection changed');
    expect(close).toHaveBeenCalledOnce();

    const second = await broker.handleToolCall(call({ operation: 'list_tabs' }));
    expect(second.success).toBe(false);
    // A fresh runtime must be built: the exited child cannot be reused.
    expect(setupBrowserRuntime).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it.each(['discovery', 'operation'] as const)('rebuilds the runtime after teardown fails during %s', async phase => {
    const stale = fakeModules();
    const recovered = fakeModules();
    const disconnected = new Error('Browser Node runtime exited');
    const get = vi.fn(async () => stale.browser);
    if (phase === 'discovery') get.mockRejectedValueOnce(disconnected);
    else stale.browser.user.openTabs.mockRejectedValueOnce(disconnected);
    const setupBrowserRuntime = recovered.modules.setupBrowserRuntime
      .mockResolvedValueOnce({ browsers: { get } });
    const close = vi.fn(async () => {}).mockRejectedValueOnce(new Error('temporary cleanup failure'));
    broker = new CodexBrowserBroker({
      sessionId: 'failed-invalidation',
      family: 'chrome',
      modules: { ...recovered.modules, setupBrowserRuntime, close },
    });

    const request = call({ operation: 'list_tabs' });
    expect((await broker.handleToolCall(request)).success).toBe(false);
    expect(setupBrowserRuntime).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(recovered.browser.user.openTabs).not.toHaveBeenCalled();

    expect((await broker.handleToolCall(request)).success).toBe(true);
    expect(recovered.browser.user.openTabs).toHaveBeenCalledOnce();
    expect(setupBrowserRuntime).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it('rebuilds even when every teardown close() keeps rejecting, not just the first one', async () => {
    // Stricter than the reject-once case: recovery must come from resetting
    // broker state in the teardown's finally, never from a later close() retry.
    const recovered = fakeModules();
    const disconnected = new Error('Browser Node runtime exited');
    let getCalls = 0;
    const get = vi.fn(async () => {
      getCalls += 1;
      if (getCalls === 1) throw disconnected;
      return recovered.browser;
    });
    const setupBrowserRuntime = recovered.modules.setupBrowserRuntime
      .mockResolvedValueOnce({ browsers: { get } });
    const close = vi.fn().mockRejectedValue(new Error('persistent cleanup failure'));
    broker = new CodexBrowserBroker({
      sessionId: 'persistent-failed-invalidation',
      family: 'chrome',
      modules: { ...recovered.modules, setupBrowserRuntime, close },
    });

    const request = call({ operation: 'list_tabs' });
    expect((await broker.handleToolCall(request)).success).toBe(false);
    expect((await broker.handleToolCall(request)).success).toBe(true);
    expect(setupBrowserRuntime).toHaveBeenCalledTimes(2);
    // Let afterEach's broker.close() resolve instead of replaying the mock error.
    close.mockImplementation(async () => {});
  });

  it.each(['resolve', 'reject'] as const)(
    'retires the old runtime when an ordinary disconnect clears init mid-close (close %s)',
    async closeMode => {
      let closeResolve!: () => void;
      const closeGate = new Promise<void>(resolve => { closeResolve = resolve; });
      const close = vi.fn(async () => {
        await closeGate;
        if (closeMode === 'reject') throw new Error('Browser Node runtime is unavailable: close failed');
      });

      let setupCalls = 0;
      let aGate!: (e: Error) => void;
      let bGate!: (e: Error) => void;
      const aOpen = new Promise<never>((_, reject) => { aGate = reject; });
      const bOpen = new Promise<never>((_, reject) => { bGate = reject; });
      let openCall = 0;

      const buildBinding = (generation: number) => ({
        browserId: `browser-${generation}`,
        nameSession: vi.fn(async () => {}),
        tabs: { get: vi.fn(), list: vi.fn(async () => []), new: vi.fn(), selected: vi.fn() },
        user: {
          claimTab: vi.fn(),
          openTabs: vi.fn(async () => {
            // The rebuilt second-generation binding is healthy and always succeeds.
            if (generation >= 2) return [{ id: 'recovered' }];
            openCall += 1;
            const n = openCall;
            if (n === 1) return [{ id: 't1' }];
            if (n === 2) return aOpen; // operation A
            if (n === 3) return bOpen; // operation B
            throw new Error('Browser is not available: stale agent still bound');
          }),
        },
      });
      const setupBrowserRuntime = vi.fn(async () => {
        setupCalls += 1;
        return { browsers: { get: vi.fn(async () => buildBinding(setupCalls)) } };
      });
      broker = new CodexBrowserBroker({
        sessionId: 'interleaved-invalidation',
        family: 'chrome',
        modules: { handleRpc: vi.fn(), setupBrowserRuntime, close },
      });

      // Establish the cached browser/agent/modules/init first.
      expect((await broker.handleToolCall(call({ operation: 'list_tabs' }))).success).toBe(true);

      // A (dead Node runtime) and B (ordinary disconnect) run concurrently on
      // the same cached browser/generation.
      const a = broker.handleToolCall(call({ operation: 'list_tabs' }));
      const b = broker.handleToolCall(call({ operation: 'list_tabs' }));
      await vi.waitFor(() => expect(openCall).toBe(3));

      // A fails first and parks inside the hanging close.
      aGate(new Error('Browser Node runtime exited; verify Node.js 22+ and start a fresh browser connection'));
      await new Promise(resolve => setTimeout(resolve, 20));
      // B fails with an ordinary disconnect while A's close is still pending;
      // this path clears this.init without replacing agent/modules.
      bGate(new Error('Browser is not available: extension transport reset'));
      await new Promise(resolve => setTimeout(resolve, 20));

      closeResolve();
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra.success).toBe(false);
      expect(rb.success).toBe(false);

      // The dead runtime must be retired despite B having cleared init: the next
      // operation runs a fresh setupBrowserRuntime instead of reusing the closed agent.
      const recovered = await broker.handleToolCall(call({ operation: 'list_tabs' }));
      expect(setupCalls).toBeGreaterThanOrEqual(2);
      expect(recovered.success).toBe(true);
      close.mockImplementation(async () => {});
    },
  );

  it('shares one invalidation promise so concurrent callers wait for the same teardown', async () => {
    const closeDefers: Array<{ resolve: () => void }> = [];
    const close = vi.fn(async () => new Promise<void>(resolve => {
      closeDefers.push({ resolve });
    }));
    let getCalls = 0;
    const setupBrowserRuntime = vi.fn(async () => ({
      browsers: {
        get: vi.fn(async () => {
          getCalls += 1;
          if (getCalls === 1) {
            throw new Error('Browser Node runtime exited; verify Node.js 22+ and start a fresh browser connection');
          }
          return {
            browserId: `browser-${getCalls}`,
            nameSession: vi.fn(async () => {}),
            tabs: { get: vi.fn(), list: vi.fn(async () => []), new: vi.fn(), selected: vi.fn() },
            user: { claimTab: vi.fn(), openTabs: vi.fn(async () => [{ id: 't1' }]) },
          };
        }),
      },
    }));
    broker = new CodexBrowserBroker({
      sessionId: 'stale-invalidation',
      family: 'chrome',
      modules: { handleRpc: vi.fn(), setupBrowserRuntime, close },
    });

    // Both calls share the same rejected init and park on the one shared close.
    const first = broker.handleToolCall(call({ operation: 'list_tabs' }));
    const second = broker.handleToolCall(call({ operation: 'list_tabs' }));
    await vi.waitFor(() => expect(closeDefers.length).toBe(1));
    const secondSettled = vi.fn();
    void second.then(secondSettled);
    await new Promise(resolve => setTimeout(resolve, 20));
    // The shared-promise wait must not return early while close() is pending.
    expect(secondSettled).not.toHaveBeenCalled();

    // A third operation during the cleanup window joins the same wait instead
    // of replaying the stale rejected init on its own.
    const thirdSettled = vi.fn();
    const third = broker.handleToolCall(call({ operation: 'list_tabs' }));
    void third.then(thirdSettled);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(thirdSettled).not.toHaveBeenCalled();
    expect(setupBrowserRuntime).toHaveBeenCalledTimes(1);

    // Releasing the single close settles every shared waiter; the cleanup window
    // produced no new setup, and all three operations report the failure.
    closeDefers[0]!.resolve();
    expect((await first).success).toBe(false);
    expect((await second).success).toBe(false);
    expect((await third).success).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    expect(setupBrowserRuntime).toHaveBeenCalledTimes(1);
    close.mockImplementation(async () => {});

    // The next operation after the shared teardown rebuilds immediately, and
    // later calls reuse that browser without a third setup.
    expect((await broker.handleToolCall(call({ operation: 'list_tabs' }))).success).toBe(true);
    expect(setupBrowserRuntime).toHaveBeenCalledTimes(2);
    expect((await broker.handleToolCall(call({ operation: 'list_tabs' }))).success).toBe(true);
    expect(setupBrowserRuntime).toHaveBeenCalledTimes(2);
  });

  it('serializes fire-and-forget turn-ended calls in event order', async () => {
    const starts: number[] = [];
    const handleTurnEnded = vi.fn(() => new Promise<void>(resolve => {
      starts.push(Date.now());
      setTimeout(resolve, 80);
    }));
    const f = fakeModules();
    broker = new CodexBrowserBroker({
      sessionId: 'turn-ended-tail',
      family: 'chrome',
      modules: { ...f.modules, handleTurnEnded },
    });
    // Initialize the runtime so pluginModules (and its handleTurnEnded) is wired.
    expect((await broker.handleToolCall(call({ operation: 'list_tabs' }))).success).toBe(true);

    // Mirror codex-app-runner's void handleTurnEnded(...): do not await the
    // first batch before dispatching the second notification.
    void broker.handleTurnEnded('one').catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 20));
    await broker.handleTurnEnded('two');

    expect(handleTurnEnded).toHaveBeenCalledTimes(2);
    // The second batch cannot start until the 80ms first batch fully settles.
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(70);
  });

  it.each(['Browser is not available: 1', 'native pipe closed before response', 'Debugger unattached'])(
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
