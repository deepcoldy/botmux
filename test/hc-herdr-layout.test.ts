import { describe, expect, it, vi } from 'vitest';
import { HcError, type HcClient } from '../src/adapters/backend/hc/client.js';
import { publishHcHerdrTab } from '../src/adapters/backend/hc/herdr-layout.js';
import { flushFakeTimers } from './helpers/flush-fake-timers.js';

const terminal = { address: 't7', cwd: '/repos/wallet' };

describe('publishHcHerdrTab', () => {
  it('merges an intervening Herdr edit and preserves where a user moved the pane', async () => {
    const manualSpace = { id: 'sp1', name: 'Manual space', tabs: [] };
    let version = 0;
    let value: { spaces: unknown[] } = { spaces: [] };
    const call = vi.fn(async (method: string, params: { version?: number; value?: typeof value }) => {
      if (method === 'doc.get') return { version, value: structuredClone(value) };
      if (version === 0) {
        value.spaces.push(manualSpace);
        version++;
        throw new HcError('rpc', 'layout changed', { kind: 'conflict' });
      }
      expect(params.version).toBe(version);
      value = structuredClone(params.value!);
      return { version: ++version };
    });
    const client = { call: call as HcClient['call'] };

    await publishHcHerdrTab(client, 'session-a', terminal, 'Check the wallet flow', () => true);
    expect(value.spaces).toMatchObject([
      manualSpace,
      { name: 'wallet', folder: terminal.cwd, tabs: [{ name: 'Check the wallet flow', root: { children: [{ content: { terminal: 't7' } }] } }] },
    ]);

    value = { spaces: [{ ...manualSpace, tabs: [{ id: 'user-tab', root: { content: { terminal: 't7' } } }] }] };
    version++;
    const afterMove = version;
    await publishHcHerdrTab(client, 'session-a', terminal, 'Check the wallet flow', () => true);
    expect(version).toBe(afterMove);
  });

  it('preserves an existing tab after the user clears or changes its name', async () => {
    let value: { spaces: { tabs: { name: string }[] }[] } | null = null;
    const call = vi.fn(async (method: string, params: { value?: typeof value }) => {
      if (method === 'doc.get') return { version: 0, value: structuredClone(value) };
      value = structuredClone(params.value!);
      return { version: 1 };
    });
    const client = { call: call as HcClient['call'] };
    const tab = () => value!.spaces[0]!.tabs[0]!;

    await publishHcHerdrTab(client, 'session-a', terminal, 'Original title', () => true);
    tab().name = '';
    await publishHcHerdrTab(client, 'session-a', terminal, 'Botmux session title', () => true);
    expect(tab().name).toBe('');
    expect(value!.spaces[0]!.tabs).toHaveLength(1);

    tab().name = 'My Herdr title';
    await publishHcHerdrTab(client, 'session-a', terminal, 'Another Botmux title', () => true);
    expect(tab().name).toBe('My Herdr title');
  });

  it('preserves a tab whose id survived a manual rebuild of its panes', async () => {
    type Layout = { spaces: { id: string; tabs: { id: string; name: string; root: unknown }[] }[] };
    let value: Layout | null = null;
    let version = 0;
    const call = vi.fn(async (method: string, params: { value?: Layout }) => {
      if (method === 'doc.get') return { version, value: structuredClone(value) };
      value = structuredClone(params.value!);
      return { version: ++version };
    });
    const client = { call: call as HcClient['call'] };
    await publishHcHerdrTab(client, 'session-a', terminal, 'Original title', () => true);

    const tab = value!.spaces[0]!.tabs[0]!;
    tab.name = 'Rebuilt tab';
    tab.root = {
      id: 'user-root', type: 'row',
      children: [{ id: 'user-pane', type: 'block', content: { terminal: 't42' } }],
    };
    version++;
    call.mockClear();

    await publishHcHerdrTab(client, 'session-a', terminal, 'Original title', () => true);

    expect(call.mock.calls.map(([method]) => method)).toEqual(['doc.get']);
  });

  it('confirms a saved tab whose reply times out at the end of a round of contention', async () => {
    let version = 0;
    let value: { spaces: { tabs: unknown[] }[] } | null = null;
    let conflictingWrites = 7;
    let saveFailed = false;
    const call = vi.fn(async (method: string, params: { version?: number; value?: typeof value }) => {
      if (method === 'doc.get') return { version, value: structuredClone(value) };
      expect(params.version).toBe(version);
      if (!saveFailed) {
        saveFailed = true;
        throw new HcError('rpc', 'cannot save document', { rpcCode: -32603 });
      }
      version++;
      if (conflictingWrites-- > 0) throw new HcError('rpc', 'layout changed', { kind: 'conflict' });
      value = structuredClone(params.value!);
      throw new HcError('timeout', 'write succeeded without a reply');
    });

    vi.useFakeTimers();
    try {
      const publishing = publishHcHerdrTab({ call: call as HcClient['call'] }, 'session-a', terminal, 'Title', () => true);
      await Promise.all([publishing, flushFakeTimers(20_000, 100)]);
      expect(conflictingWrites).toBe(-1);
      expect(call.mock.calls.at(-1)?.[0]).toBe('doc.get');
      expect(value!.spaces[0]!.tabs).toMatchObject([{ name: 'Title' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a timed-out read after the worker disconnects during backoff', async () => {
    let current = true;
    const call = vi.fn(async () => { throw new HcError('timeout', 'read did not answer'); });
    vi.useFakeTimers();
    try {
      const publishing = publishHcHerdrTab({ call: call as HcClient['call'] }, 'session-a', terminal, 'Title', () => current);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      current = false;
      await vi.runAllTimersAsync();
      await publishing;
      expect(call).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not write after the worker loses the terminal during its layout read', async () => {
    let current = true;
    const call = vi.fn(async () => {
      current = false;
      return { version: 0, value: null };
    });

    await publishHcHerdrTab({ call: call as HcClient['call'] }, 'session-a', terminal, 'Title', () => current);
    expect(call).toHaveBeenCalledOnce();
  });
});
