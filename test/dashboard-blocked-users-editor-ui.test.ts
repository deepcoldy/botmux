import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlockedUsersEditor } from '../src/dashboard/web/blocked-users-editor.js';
import { toast } from '../src/dashboard/web/toast.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/dashboard/web/toast.js', () => ({ toast: vi.fn() }));

const tr = (key: string, values?: Record<string, unknown>) => {
  let result = key;
  for (const [name, value] of Object.entries(values ?? {})) result = result.replace(`{${name}}`, String(value));
  return result;
};

type Call = { url: string; method: string; body: any };

function jsonResponse(status: number, body: any): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function installFetch(route: (method: string, body: any) => { status: number; body: any }): { calls: Call[] } {
  const state: { calls: Call[] } = { calls: [] };
  globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const parsedBody = init?.body ? JSON.parse(String(init.body)) : null;
    state.calls.push({ url: String(url), method, body: parsedBody });
    const { status, body } = route(method, parsedBody);
    return jsonResponse(status, body);
  }) as any;
  return state;
}

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

function renderEditor(): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(BlockedUsersEditor, {
      larkAppId: 'cli_a',
      tr,
    }));
  });
  return renderer;
}

async function open(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.root.findByProps({ 'data-blocked-users-toggle': true })
      .props.onToggle({ currentTarget: { open: true } });
  });
  await settle();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BlockedUsersEditor', () => {
  it('performs no request before the section is expanded, then loads raw entries', async () => {
    const state = installFetch(method => {
      if (method === 'GET') return { status: 200, body: { ok: true, raw: ['ou_x', 'on_y'], resolved: ['x'] } };
      return { status: 200, body: { ok: true, raw: [], resolved: [] } };
    });
    const renderer = renderEditor();
    expect(state.calls).toHaveLength(0);

    await open(renderer);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]).toMatchObject({ method: 'GET', url: '/api/bots/cli_a/blocked-users' });
    const items = renderer.root.findAllByType('li').map((li: any) => li.props['data-blocked-entry']);
    expect(items).toEqual(['ou_x', 'on_y']);
  });

  it('splits the draft on commas/whitespace and dedupes locally', async () => {
    const state = installFetch(() => ({ status: 200, body: { ok: true, raw: ['ou_keep'], resolved: [] } }));
    const renderer = renderEditor();
    await open(renderer);

    await act(async () => {
      renderer.root.findByProps({ 'data-action': 'add-input' })
        .props.onChange({ currentTarget: { value: 'ou_a, ou_b\nou_keep ou_c' } });
    });
    await act(async () => {
      renderer.root.findByProps({ 'data-action': 'add-draft' }).props.onClick();
    });

    const items = renderer.root.findAllByType('li').map((li: any) => li.props['data-blocked-entry']);
    expect(items).toEqual(['ou_keep', 'ou_a', 'ou_b', 'ou_c']);
    // No PUT until explicit save.
    expect(state.calls.filter(c => c.method === 'PUT')).toHaveLength(0);
  });

  it('PUTs the full raw list on save and refreshes from the response', async () => {
    const state = installFetch((method, body) => {
      if (method === 'GET') return { status: 200, body: { ok: true, raw: ['ou_a'], resolved: ['ou_a'] } };
      return { status: 200, body: { ok: true, raw: body.entries, resolved: body.entries } };
    });
    const renderer = renderEditor();
    await open(renderer);

    await act(async () => {
      renderer.root.findByProps({ 'data-action': 'add-input' })
        .props.onChange({ currentTarget: { value: 'ou_b' } });
    });
    await act(async () => {
      renderer.root.findByProps({ 'data-action': 'add-draft' }).props.onClick();
    });
    await act(async () => {
      renderer.root.findByProps({ 'data-action': 'save' }).props.onClick();
    });
    await settle();

    const put = state.calls.filter(c => c.method === 'PUT');
    expect(put).toHaveLength(1);
    expect(put[0]?.body).toEqual({ entries: ['ou_a', 'ou_b'] });
    expect(toast).toHaveBeenCalledWith('blocked.saved', expect.objectContaining({ kind: 'success' }));
  });

  it('removes one entry locally and saves the remainder via a full PUT', async () => {
    const state = installFetch((method, body) => {
      if (method === 'GET') return { status: 200, body: { ok: true, raw: ['ou_a', 'ou_b'], resolved: ['ou_a', 'ou_b'] } };
      return { status: 200, body: { ok: true, raw: body.entries, resolved: body.entries } };
    });
    const renderer = renderEditor();
    await open(renderer);

    const row = renderer.root.findByProps({ 'data-blocked-entry': 'ou_a' });
    await act(async () => {
      row.findByProps({ 'data-action': 'remove-entry' }).props.onClick();
    });
    await act(async () => {
      renderer.root.findByProps({ 'data-action': 'save' }).props.onClick();
    });
    await settle();

    expect(state.calls.filter(c => c.method === 'PUT').at(-1)?.body).toEqual({ entries: ['ou_b'] });
  });

  it('clears the whole list with a single empty-array PUT', async () => {
    const state = installFetch((method, body) => {
      if (method === 'GET') return { status: 200, body: { ok: true, raw: ['ou_a'], resolved: ['ou_a'] } };
      return { status: 200, body: { ok: true, raw: body.entries, resolved: body.entries } };
    });
    const renderer = renderEditor();
    await open(renderer);

    await act(async () => {
      renderer.root.findByProps({ 'data-action': 'clear-all' }).props.onClick();
    });
    await settle();

    expect(state.calls.filter(c => c.method === 'PUT').at(-1)?.body).toEqual({ entries: [] });
  });

  it('maps 409/422/400 failures to the specific warning toasts', async () => {
    const responses = [
      { status: 409, body: { ok: false, error: 'cannot_block_admin' } },
      { status: 422, body: { ok: false, error: 'empty_resolved' } },
      { status: 400, body: { ok: false, error: 'invalid_entries' } },
    ];
    installFetch(method => {
      if (method === 'GET') return { status: 200, body: { ok: true, raw: ['ou_a'], resolved: ['ou_a'] } };
      return responses.shift()!;
    });
    const renderer = renderEditor();
    await open(renderer);

    for (const key of ['blocked.conflict', 'blocked.emptyResolved', 'blocked.invalidEntries']) {
      await act(async () => {
        renderer.root.findByProps({ 'data-action': 'save' }).props.onClick();
      });
      await settle();
      expect(toast).toHaveBeenCalledWith(key, expect.objectContaining({ kind: 'warning' }));
    }
  });
});
