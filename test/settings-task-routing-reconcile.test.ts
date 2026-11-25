import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from '../src/dashboard/web/settings-page.js';
import { TASK_ROUTING_CHANGED_EVENT } from '../src/dashboard/web/task-routing-model.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('task-routing settings reconciliation', () => {
  it('publishes the confirmed nav state after a committed PUT loses its response', async () => {
    let serverSettings: Record<string, unknown> = {
      taskRouting: { enabled: true, botOptions: [] },
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method?.toUpperCase() ?? 'GET';
      if (url === '/api/settings' && method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ settings: serverSettings, authed: true, bound: true }),
        } as Response;
      }
      if (url === '/api/settings' && method === 'PUT') {
        // Commit first, then lose the response: catch must reconcile via GET.
        serverSettings = {
          ...serverSettings,
          taskRouting: { enabled: false, botOptions: [] },
        };
        throw new TypeError('response lost after commit');
      }
      return {
        ok: false,
        status: 503,
        json: async () => ({}),
      } as Response;
    });
    vi.stubGlobal('fetch', fetcher);

    const dispatchEvent = vi.fn(() => true);
    vi.stubGlobal('window', {
      dispatchEvent,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      requestAnimationFrame: () => 1,
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { hash: '#/settings' },
    });

    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      view = TestRenderer.create(React.createElement(SettingsPage));
    });
    const toggle = view.root.findByProps({ 'data-action': 'toggle-task-routing' });
    expect(toggle.props.checked).toBe(true);
    dispatchEvent.mockClear();

    await act(async () => {
      toggle.props.onChange({ currentTarget: { checked: false } });
    });
    await act(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
    });

    expect(serverSettings).toMatchObject({ taskRouting: { enabled: false } });
    expect(fetcher).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ method: 'PUT' }));
    expect(view.root.findByProps({ 'data-action': 'toggle-task-routing' }).props.checked).toBe(false);
    const navEvents = dispatchEvent.mock.calls
      .map(([event]) => event as unknown as { type?: string; detail?: unknown })
      .filter(event => event.type === TASK_ROUTING_CHANGED_EVENT);
    expect(navEvents).toHaveLength(1);
    expect(navEvents[0]?.detail).toEqual({ enabled: false });

    act(() => view.unmount());
  });
});
