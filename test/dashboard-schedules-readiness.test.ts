import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '../src/dashboard/web/store.js';
import { SchedulesPage } from '../src/dashboard/web/schedules-page.js';

function response(body: unknown): Response {
  return new Response(JSON.stringify(body));
}

describe('Schedules page initial snapshot readiness', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('document', { body: {}, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('fetch', vi.fn(async (path: string) => response(
      path === '/api/bots'
        ? { bots: [{ larkAppId: 'app_schedules', botName: 'Schedule bot' }] }
        : { bots: [], chats: [] },
    )));
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it('holds the empty state and creation until a schedules result, including unavailable, commits', async () => {
    await act(async () => { renderer = TestRenderer.create(createElement(SchedulesPage)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const create = () => renderer!.root.findByProps({ 'data-action': 'create-schedule' });
    const list = () => renderer!.root.findByProps({ id: 'schedules-tbody' });
    expect(create().props.disabled).toBe(true);
    expect(list().props.role).toBe('status');

    // The session snapshot becoming ready must not expose a false schedule empty state.
    act(() => { store.replaceSessionsSnapshot([], {}); });
    expect(store.getSnapshot().bootstrapped).toBe(true);
    expect(store.getSnapshot().schedulesReady).toBe(false);
    expect(create().props.disabled).toBe(true);
    expect(list().props.role).toBe('status');

    act(() => { store.replaceSchedulesSnapshot(null); });
    expect(store.getSnapshot().schedulesReady).toBe(true);
    expect(store.getSnapshot().schedulesAvailable).toBe(false);
    expect(list().props.role).not.toBe('status');

    act(() => { store.replaceSchedulesSnapshot([]); });
    expect(store.getSnapshot().schedulesAvailable).toBe(true);
    expect(create().props.disabled).toBe(false);
  });
});
