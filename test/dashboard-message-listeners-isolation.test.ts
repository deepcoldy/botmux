import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageListenersPage } from '../src/dashboard/web/message-listeners-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const BOT = 'cli_listener';
const SAMPLE = 'oc_sample';
const GROUP = 'oc_group';

function response(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

function treeText(node: TestRenderer.ReactTestInstance): string {
  const visit = (value: unknown): string => {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map(visit).join('');
    if (value && typeof value === 'object' && 'children' in value) return visit((value as TestRenderer.ReactTestInstance).children);
    return '';
  };
  return visit(node.children);
}

function listener() {
  return { enabled: true, prompt: 'inspect', senderPolicy: { mode: 'all_except_excluded', includeSenderTypes: ['user'] } };
}

describe('message-listener page editor isolation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps global and group preview requests, results, limits, and member contexts isolated', async () => {
    const requests: Array<{ url: string; body?: any }> = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, body });
      if (url === '/api/groups') return response({ chats: [
        { chatId: SAMPLE, name: 'Sample', memberBots: [{ larkAppId: BOT, botName: 'Listener', inChat: true }] },
        { chatId: GROUP, name: 'Group', memberBots: [{ larkAppId: BOT, botName: 'Listener', inChat: true }] },
      ], bots: [{ larkAppId: BOT, botName: 'Listener' }] });
      if (url === `/api/global-message-listener/${BOT}`) return response({ listener: listener() });
      if (url === `/api/group-message-listeners/${BOT}`) return response({ groups: [
        { chatId: SAMPLE, name: 'Sample', mode: 'inherit', listener: null },
        { chatId: GROUP, name: 'Group', mode: 'custom', listener: listener() },
      ] });
      if (url === `/api/groups/${BOT}/${SAMPLE}/members-display`) return response({ members: [{ openId: 'ou_sample', name: 'Sample member', memberType: 'user' }] });
      if (url === `/api/groups/${BOT}/${GROUP}/members-display`) return response({ members: [{ openId: 'ou_group', name: 'Group member', memberType: 'user' }] });
      if (url === `/api/message-listeners/${BOT}/${SAMPLE}/preview`) return response({ ok: true, requestedLimit: 2, matches: [{ messageId: 'om_global', messageText: 'global only', msgType: 'text', senderType: 'user' }] });
      if (url === `/api/message-listeners/${BOT}/${GROUP}/preview`) return response({ ok: true, requestedLimit: 5, matches: [{ messageId: 'om_group', messageText: 'group only', msgType: 'text', senderType: 'user' }] });
      if (url === `/api/message-listeners/${BOT}/${GROUP}/run-preview`) return response({ ok: true, requestedLimit: 5, matches: [{ messageId: 'om_group_run', messageText: 'group run only', msgType: 'text', senderType: 'user' }], results: [] });
      throw new Error(`unexpected ${url}`);
    }) as any;

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(MessageListenersPage)); });
    await settle();

    const root = renderer.root;
    // Global sample remains the first group; group editor starts with the first
    // group, then select the custom group to render the second editor.
    const groupButton = root.findAllByType('button').find(button =>
      String(button.props.className).includes('message-listener-group-item')
      && button.findByType('strong').children.join('') === 'Group',
    );
    expect(groupButton).toBeTruthy();
    act(() => groupButton!.props.onClick());
    await settle();

    const globalPreview = root.findByProps({ 'data-listener-preview-scope': 'global' });
    const groupPreview = root.findByProps({ 'data-listener-preview-scope': 'group' });
    const previewButtons = [globalPreview, groupPreview].map(panel => panel.findAllByType('button')[0]!);
    const previewLimits = [globalPreview, groupPreview].map(panel => panel.findByType('select'));
    // Change only the global editor's limit; the group editor must retain 5.
    act(() => previewLimits[0]!.props.onChange({ currentTarget: { value: '2' } }));
    expect(globalPreview.findByType('select').props.value).toBe(2);
    expect(groupPreview.findByType('select').props.value).toBe(5);

    await act(async () => { previewButtons[0]!.props.onClick(); await Promise.resolve(); });
    expect(requests.filter(request => request.url.endsWith('/preview')).map(request => request.url)).toEqual([
      `/api/message-listeners/${BOT}/${SAMPLE}/preview`,
    ]);
    expect(treeText(globalPreview)).toContain('global only');
    expect(treeText(groupPreview)).not.toContain('group only');

    await act(async () => { previewButtons[1]!.props.onClick(); await Promise.resolve(); });
    expect(requests.filter(request => request.url.endsWith('/preview')).map(request => request.url)).toEqual([
      `/api/message-listeners/${BOT}/${SAMPLE}/preview`,
      `/api/message-listeners/${BOT}/${GROUP}/preview`,
    ]);
    expect(treeText(globalPreview)).toContain('global only');
    expect(treeText(groupPreview)).toContain('group only');
    expect(JSON.stringify(renderer.toJSON())).toContain('Sample member');
    expect(JSON.stringify(renderer.toJSON())).toContain('Group member');

    // Trial runs use the same scope resolver, but exercise the separate
    // mutating endpoint explicitly: group run must never use the sample chat.
    await act(async () => { groupPreview.findAllByType('button')[1]!.props.onClick(); await Promise.resolve(); });
    expect(requests.filter(request => request.url.endsWith('/run-preview')).map(request => request.url)).toEqual([
      `/api/message-listeners/${BOT}/${GROUP}/run-preview`,
    ]);
    expect(treeText(globalPreview)).toContain('global only');
    expect(treeText(groupPreview)).toContain('group run only');
    await act(async () => { renderer.unmount(); });
  });

  it('drops a preview response after its editor context changes', async () => {
    const pending = deferred<Response>();
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === '/api/groups') return response({ chats: [
        { chatId: SAMPLE, name: 'Sample', memberBots: [{ larkAppId: BOT, botName: 'Listener', inChat: true }] },
        { chatId: GROUP, name: 'Group', memberBots: [{ larkAppId: BOT, botName: 'Listener', inChat: true }] },
      ] });
      if (url === `/api/global-message-listener/${BOT}`) return response({ listener: listener() });
      if (url === `/api/group-message-listeners/${BOT}`) return response({ groups: [{ chatId: SAMPLE, mode: 'inherit', listener: null }, { chatId: GROUP, mode: 'inherit', listener: null }] });
      if (url.includes('/members-display')) return response({ members: [] });
      if (url === `/api/message-listeners/${BOT}/${SAMPLE}/preview`) return pending.promise;
      throw new Error(`unexpected ${url}`);
    }) as any;

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(MessageListenersPage)); });
    await settle();
    const root = renderer.root;
    const globalPreview = root.findByProps({ 'data-listener-preview-scope': 'global' });
    await act(async () => { globalPreview.findAllByType('button')[0]!.props.onClick(); await Promise.resolve(); });
    expect(treeText(globalPreview)).not.toContain('late result');
    const sampleSelector = root.findAllByType('select').find(select => select.props.value === SAMPLE);
    expect(sampleSelector).toBeTruthy();
    act(() => sampleSelector!.props.onChange({ currentTarget: { value: GROUP } }));
    await settle();
    await act(async () => { pending.resolve(response({ ok: true, requestedLimit: 5, matches: [{ messageId: 'om_late', messageText: 'late result', msgType: 'text', senderType: 'user' }] })); await Promise.resolve(); });
    expect(treeText(root.findByProps({ 'data-listener-preview-scope': 'global' }))).not.toContain('late result');
    await act(async () => { renderer.unmount(); });
  });

  it('contains preview failures to the initiating editor and restores its controls', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === '/api/groups') return response({ chats: [
        { chatId: SAMPLE, name: 'Sample', memberBots: [{ larkAppId: BOT, botName: 'Listener', inChat: true }] },
        { chatId: GROUP, name: 'Group', memberBots: [{ larkAppId: BOT, botName: 'Listener', inChat: true }] },
      ] });
      if (url === `/api/global-message-listener/${BOT}`) return response({ listener: listener() });
      if (url === `/api/group-message-listeners/${BOT}`) return response({ groups: [{ chatId: SAMPLE, mode: 'inherit', listener: null }, { chatId: GROUP, mode: 'custom', listener: listener() }] });
      if (url.includes('/members-display')) return response({ members: [] });
      if (url === `/api/message-listeners/${BOT}/${SAMPLE}/preview`) throw new Error('preview offline');
      throw new Error(`unexpected ${url}`);
    }) as any;

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(MessageListenersPage)); });
    await settle();
    const root = renderer.root;
    const groupButton = root.findAllByType('button').find(button => String(button.props.className).includes('message-listener-group-item') && button.findByType('strong').children.join('') === 'Group');
    act(() => groupButton!.props.onClick());
    await settle();
    const globalPreview = root.findByProps({ 'data-listener-preview-scope': 'global' });
    const groupPreview = root.findByProps({ 'data-listener-preview-scope': 'group' });
    await act(async () => { globalPreview.findAllByType('button')[0]!.props.onClick(); await Promise.resolve(); });
    expect(treeText(globalPreview)).toContain('preview offline');
    expect(treeText(groupPreview)).not.toContain('preview offline');
    expect(globalPreview.findAllByType('button').every(button => !button.props.disabled)).toBe(true);
    expect(groupPreview.findAllByType('button').every(button => !button.props.disabled)).toBe(true);
    await act(async () => { renderer.unmount(); });
  });
});
