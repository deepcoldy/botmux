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

    await publishHcHerdrTab(client, 'session-a', terminal, () => true);
    expect(value.spaces).toMatchObject([
      manualSpace,
      { name: 'wallet', folder: terminal.cwd, tabs: [{ root: { children: [{ content: { terminal: 't7' } }] } }] },
    ]);

    value = { spaces: [{ ...manualSpace, tabs: [{ id: 'user-tab', root: { content: { terminal: 't7' } } }] }] };
    version++;
    const afterMove = version;
    await publishHcHerdrTab(client, 'session-a', terminal, () => true);
    expect(version).toBe(afterMove);
  });

  it('does not write after the worker loses the terminal during its layout read', async () => {
    let current = true;
    const call = vi.fn(async () => {
      current = false;
      return { version: 0, value: null };
    });

    await publishHcHerdrTab({ call: call as HcClient['call'] }, 'session-a', terminal, () => current);
    expect(call).toHaveBeenCalledOnce();
  });
});
