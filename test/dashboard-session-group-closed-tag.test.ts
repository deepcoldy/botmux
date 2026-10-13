/** Dashboard name editing uses the existing per-bot config route without touching the active name. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { SessionGroupTagRow } from '../src/dashboard/web/bot-defaults-page.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let renderer: TestRenderer.ReactTestRenderer | undefined;
let closedTagName: string;
let mode: string;
const bodies: unknown[] = [];

/** Flush observable React updates, not wall-clock delays. */
async function flush(action?: () => void): Promise<void> {
  await act(async () => { action?.(); });
}
/** Mount one isolated settings row with no live daemon or OAuth. */
async function renderRow(): Promise<TestRenderer.ReactTestRenderer> {
  await flush(() => {
    renderer = TestRenderer.create(React.createElement(SessionGroupTagRow, {
      bot: { larkAppId: 'cli_tag_test' } as React.ComponentProps<typeof SessionGroupTagRow>['bot'],
    }));
  });
  return renderer!;
}

beforeEach(() => {
  closedTagName = 'Closed'; mode = 'feed-group'; bodies.length = 0;
  vi.stubGlobal('document', { body: {}, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { closedName: string };
      bodies.push(body); closedTagName = body.closedName.trim();
    }
    return Response.json({ ok: true, authorized: true, tagMode: mode, tagName: 'Active', closedTagName, defaultTagName: 'Test chats' });
  }));
});
afterEach(async () => { await flush(() => renderer?.unmount()); renderer = undefined; vi.unstubAllGlobals(); });

describe('closed tag settings', () => {
  it('loads, saves and clears the configured name independently', async () => {
    const row = await renderRow();
    const input = () => row.root.findByProps({ 'data-input': 'sessionGroupClosedTagName' });
    expect(input().props.value).toBe('Closed');
    await flush(() => input().props.onChange({ currentTarget: { value: 'Archived' } }));
    await flush(() => input().props.onBlur());
    expect(bodies).toEqual([{ closedName: 'Archived' }]);
    expect(input().props.value).toBe('Archived');
    expect(row.root.findByProps({ 'data-input': 'sessionGroupTagName' }).props.value).toBe('Active');
    await flush(() => input().props.onChange({ currentTarget: { value: '' } }));
    await flush(() => input().props.onBlur());
    expect(bodies.at(-1)).toEqual({ closedName: '' });
  });

  it.each(['off', 'chat-tag'])('does not expose unsupported closed tagging in %s mode', async value => {
    mode = value;
    const row = await renderRow();
    expect(row.root.findAllByProps({ 'data-input': 'sessionGroupClosedTagName' })).toHaveLength(0);
  });
});
