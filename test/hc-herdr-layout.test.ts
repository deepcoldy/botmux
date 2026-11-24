import { describe, expect, it, vi } from 'vitest';
import { HcError, type HcClient } from '../src/adapters/backend/hc/client.js';
import { publishHcHerdrTab } from '../src/adapters/backend/hc/herdr-layout.js';

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

  it('fills an existing Botmux tab’s missing title and preserves a later manual name', async () => {
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
    expect(tab().name).toBe('Botmux session title');
    expect(value!.spaces[0]!.tabs).toHaveLength(1);

    tab().name = 'My Herdr title';
    await publishHcHerdrTab(client, 'session-a', terminal, 'Another Botmux title', () => true);
    expect(tab().name).toBe('My Herdr title');
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
