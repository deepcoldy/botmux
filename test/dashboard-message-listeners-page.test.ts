import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageListenersPage } from '../src/dashboard/web/message-listeners-page.js';
import { pendingLeavePrompt } from '../src/dashboard/web/leave-guard.js';
import { ui } from '../src/dashboard/web/ui.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const confirmMock = vi.hoisted(() => vi.fn(async (_options: { title: string; message: string }) => true));
vi.mock('../src/dashboard/web/confirm-modal.js', () => ({ confirm: confirmMock }));
const toastMock = vi.hoisted(() => vi.fn());
vi.mock('../src/dashboard/web/toast.js', () => ({ toast: toastMock }));

const BOT = 'cli_listener';
const OTHER_BOT = 'cli_other';
const INHERIT = 'oc_inherit';
const CUSTOM = 'oc_custom';

type Instance = TestRenderer.ReactTestInstance;
type Request = { url: string; method: string; body?: any };

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

function text(node: Instance): string {
  const visit = (value: unknown): string => {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map(visit).join('');
    if (value && typeof value === 'object' && 'children' in value) return visit((value as Instance).children);
    return '';
  };
  return visit(node.children);
}

function hasClass(node: Instance, name: string): boolean {
  return typeof node.type === 'string' && String(node.props.className ?? '').split(/\s+/).includes(name);
}

function byClass(root: Instance, name: string): Instance[] {
  return root.findAll(node => hasClass(node, name));
}

function savedGlobal(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    name: 'saved rule',
    prompt: 'triage',
    senderPolicy: { mode: 'include_only', includeSenderOpenIds: ['ou_alice'], includeSenderTypes: ['user'] },
    messagePolicy: { includeMsgTypes: ['text'] },
    contentPolicy: { includeKeywords: ['bug'] },
    ...overrides,
  };
}

function mockApi(options: {
  global?: unknown;
  otherGlobal?: () => Promise<Response>;
  customEnabled?: boolean;
  chats?: Array<[string, string]>;
  members?: (url: string) => Promise<Response> | Response;
  put?: (request: Request) => Response | undefined;
  // A daemon that drops a custom rule saved switched off with no prompt, yet
  // still answers mode:'custom' (with no rule).
  dropsBlankPausedRule?: boolean;
} = {}) {
  const requests: Request[] = [];
  const chat = (chatId: string, name: string) => ({ chatId, name, memberBots: [
    { larkAppId: BOT, botName: 'Listener', inChat: true },
    { larkAppId: OTHER_BOT, botName: 'Other', inChat: chatId === INHERIT },
  ] });
  // Group modes persist across requests like the daemon's, so a re-read after
  // a save sees what was saved.
  const groupState = new Map<string, { mode: string; listener: unknown }>([
    [INHERIT, { mode: 'inherit', listener: null }],
    [CUSTOM, { mode: 'custom', listener: { ...savedGlobal(), name: 'custom rule', enabled: options.customEnabled ?? true } }],
  ]);
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const request = { url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(request);
    if (method === 'PUT') {
      const rejected = options.put?.(request);
      if (rejected) return rejected;
      const chatId = url.match(new RegExp(`^/api/group-message-listeners/${BOT}/(.+)$`))?.[1];
      if (!chatId) return response({ ok: true });
      // Like the daemon's route (pinned in dashboard-ipc.test.ts): inherit drops
      // the group's entry, and the answer is what a re-read returns.
      const { mode, listener } = request.body;
      const dropsRule = mode === 'custom' && options.dropsBlankPausedRule && !listener.enabled && !listener.prompt.trim();
      groupState.set(chatId, mode === 'inherit' || dropsRule ? { mode: 'inherit', listener: null } : { mode, listener: listener ?? null });
      return response(dropsRule ? { ok: true, mode: 'custom', listener: null } : { ok: true, ...groupState.get(chatId) });
    }
    const chatList: Array<[string, string]> = options.chats
      ?? [[INHERIT, 'Inherit group'], [CUSTOM, 'Custom group']];
    if (url === '/api/groups') return response({ chats: chatList.map(([chatId, name]) => chat(chatId, name)) });
    if (url === `/api/global-message-listener/${BOT}`) return response({ listener: options.global ?? savedGlobal() });
    if (url === `/api/global-message-listener/${OTHER_BOT}`) return options.otherGlobal?.() ?? response({ listener: savedGlobal({ name: 'other rule' }) });
    if (url === `/api/group-message-listeners/${BOT}`) return response({ groups: [...groupState].map(([chatId, state]) => ({ chatId, ...state })) });
    if (url === `/api/group-message-listeners/${OTHER_BOT}`) return response({ groups: [{ chatId: INHERIT, mode: 'inherit', listener: null }] });
    if (url.includes('/members-display') && options.members) return options.members(url);
    if (url.includes('/members-display')) return response({ members: [
      { openId: 'ou_alice', name: 'Alice', memberType: 'user' },
      { openId: 'ou_bob', name: 'Bob', memberType: 'user' },
    ] });
    if (url.endsWith('/run-preview')) return response({ ok: true, requestedLimit: 5, matches: [], results: [] });
    throw new Error(`unexpected ${method} ${url}`);
  }) as any;
  return requests;
}

async function renderPage(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(MessageListenersPage)); });
  await settle();
  return renderer;
}

const tabs = (root: Instance) => root.findAll(node => node.type === 'button' && node.props.role === 'tab');
const tab = (root: Instance, id: 'groups' | 'global') => tabs(root).find(node => node.props['data-listener-tab'] === id)!;
const panel = (root: Instance, id: 'groups' | 'global') => root.find(node => node.type === 'section' && node.props.id === `message-listener-panel-${id}`);
// The editor component instance itself: driving its callbacks exercises the
// page's wiring exactly at the boundary where partial patches arrive.
const editorOf = (root: Instance, scope: 'global' | 'group') => root.find(node => typeof node.type === 'function' && node.props.previewScope === scope);
const hasEditor = (root: Instance, scope: 'global' | 'group') => root.findAll(node => typeof node.type === 'function' && node.props.previewScope === scope).length > 0;
const globalSave = (root: Instance) => byClass(panel(root, 'global'), 'message-listener-panel-actions')[0]!.findByType('button');
const groupSave = (root: Instance) => byClass(root, 'message-listener-detail-actions')[0]!.findByType('button');
const groupItem = (root: Instance, name: string) => byClass(root, 'message-listener-group-item').find(node => node.findByType('strong').children.join('') === name)!;
const modeButton = (root: Instance, index: 0 | 1 | 2) => byClass(root, 'message-listener-mode-picker')[0]!.findAllByType('button')[index]!;
const puts = (requests: Request[], url: string) => requests.filter(request => request.method === 'PUT' && request.url === url);
const GLOBAL_URL = `/api/global-message-listener/${BOT}`;

async function click(node: Instance): Promise<void> {
  await act(async () => { await node.props.onClick(); });
  await settle();
}

describe('message-listener page', () => {
  beforeEach(() => { confirmMock.mockReset(); confirmMock.mockResolvedValue(true); });
  afterEach(() => vi.restoreAllMocks());

  it('saves silent execution selected in the editor and restores the hidden card title when switched back', async () => {
    const requests = mockApi({ global: savedGlobal({ replyCardTitle: 'saved title' }) });
    const renderer = await renderPage();
    const root = renderer.root;
    await click(tab(root, 'global'));
    const placement = () => byClass(panel(root, 'global'), 'roles-listener-reply-placement')[0]!.findByType('select');
    await act(async () => placement().props.onChange({ currentTarget: { value: 'none' } }));
    expect(placement().props.value).toBe('none');
    expect(panel(root, 'global').findAll(node => node.type === 'input' && node.props.value === 'saved title')).toHaveLength(0);
    await click(globalSave(root));
    expect(puts(requests, GLOBAL_URL).at(-1)?.body.replyPolicy?.mode).toBe('none');
    await act(async () => placement().props.onChange({ currentTarget: { value: 'thread' } }));
    expect(panel(root, 'global').findAll(node => node.type === 'input' && node.props.value === 'saved title')).toHaveLength(1);
    await act(async () => renderer.unmount());
  });

  it('puts group settings first and opens on them, keeping the global panel mounted but hidden', async () => {
    mockApi();
    const renderer = await renderPage();
    const root = renderer.root;
    expect(tabs(root).map(node => node.props['data-listener-tab'])).toEqual(['groups', 'global']);
    expect(tab(root, 'groups').props['aria-selected']).toBe(true);
    expect(panel(root, 'groups').props.hidden).toBe(false);
    expect(panel(root, 'global').props.hidden).toBe(true);
    expect(text(tab(root, 'groups'))).toContain('2');
    expect(text(tab(root, 'global'))).toContain('已启用');

    act(() => tab(root, 'groups').props.onKeyDown({ key: 'ArrowRight', preventDefault() {} }));
    expect(tab(root, 'global').props['aria-selected']).toBe(true);
    expect(panel(root, 'global').props.hidden).toBe(false);
    expect(panel(root, 'groups').props.hidden).toBe(true);

    // The inherit summary links back to the global tab.
    act(() => tab(root, 'global').props.onKeyDown({ key: 'Home', preventDefault() {} }));
    act(() => byClass(byClass(panel(root, 'groups'), 'message-listener-inherit-summary')[0]!, 'message-listener-link')[0]!.props.onClick());
    expect(tab(root, 'global').props['aria-selected']).toBe(true);
    await act(async () => { renderer.unmount(); });
  });

  it('merges partial policy patches so a save never widens the sender or keyword filter', async () => {
    const requests = mockApi();
    const renderer = await renderPage();
    const root = renderer.root;
    const editor = () => editorOf(root, 'global');
    act(() => editor().props.onSenderPolicyPatch({ excludeSelf: false }));
    act(() => editor().props.onContentPolicyPatch({ matchMode: 'all' }));
    act(() => editor().props.onToggleSenderType('user', false));
    await click(globalSave(root));

    const [put] = puts(requests, GLOBAL_URL);
    expect(put?.body.senderPolicy).toEqual({ mode: 'include_only', includeSenderOpenIds: ['ou_alice'], includeSenderTypes: ['user'], excludeSelf: false });
    expect(put?.body.contentPolicy).toEqual({ includeKeywords: ['bug'], matchMode: 'all' });
    await act(async () => { renderer.unmount(); });
  });

  it('selects and removes identity keywords through the rendered controls and saves stable IDs', async () => {
    const requests = mockApi({ global: savedGlobal({ contentPolicy: { includeKeywords: ['ask'], includeMentionedOpenIds: ['ou_not_in_sample'], matchMode: 'all' } }) });
    const renderer = await renderPage();
    const root = renderer.root;
    const editor = () => editorOf(root, 'global');
    const identitySelect = () => byClass(editor(), 'roles-listener-content-policy')[0]!.findAllByType('select')[0]!;
    expect(identitySelect().findAllByType('option').map(option => option.props.value)).toContain('ou_bob');
    act(() => identitySelect().props.onChange({ currentTarget: { value: 'ou_bob' } }));
    const modeSelect = byClass(editor(), 'roles-listener-content-policy')[0]!.findAllByType('select')[1]!;
    act(() => modeSelect.props.onChange({ currentTarget: { value: 'all' } }));
    await click(globalSave(root));
    expect(puts(requests, GLOBAL_URL)[0]?.body.contentPolicy).toEqual({ includeKeywords: ['ask'], includeMentionedOpenIds: ['ou_not_in_sample', 'ou_bob'], matchMode: 'all' });
    const chip = () => byClass(editor(), 'roles-listener-identity-keyword').find(node => node.props.title === 'ou_bob')!;
    await click(chip());
    await click(globalSave(root));
    expect(puts(requests, GLOBAL_URL).at(-1)?.body.contentPolicy.includeMentionedOpenIds).toEqual(['ou_not_in_sample']);
    await click(byClass(editor(), 'roles-listener-identity-keyword')[0]!);
    await click(globalSave(root));
    expect(puts(requests, GLOBAL_URL).at(-1)?.body.contentPolicy).toEqual({ includeKeywords: ['ask'], matchMode: 'all' });
    await act(async () => { renderer.unmount(); });
  });

  it('cannot select the previous Bot identity while the new Bot roster is loading', async () => {
    const pendingMembers = deferred<Response>();
    const requests = mockApi({ members: url => url.includes(`/${OTHER_BOT}/`)
      ? pendingMembers.promise
      : response({ members: [{ openId: 'ou_source_member', name: 'Source member', memberType: 'user' }] }),
    });
    const renderer = await renderPage();
    const root = renderer.root;
    const editor = () => editorOf(root, 'global');
    const select = () => byClass(editor(), 'roles-listener-content-policy')[0]!.findAllByType('select')[0]!;
    expect(select().findAllByType('option').map(node => node.props.value)).toContain('ou_source_member');
    await click(byClass(root, 'bd-roster-item').find(node => text(node).includes(OTHER_BOT))!);
    expect(select().props.disabled).toBe(true);
    expect(select().findAllByType('option').map(node => node.props.value)).not.toContain('ou_source_member');
    act(() => select().props.onChange({ currentTarget: { value: 'ou_source_member' } }));
    expect(editor().props.listener.contentPolicy?.includeMentionedOpenIds).toBeUndefined();
    await act(async () => { pendingMembers.resolve(response({ members: [{ openId: 'ou_target_member', name: 'Target member', memberType: 'user' }] })); });
    await settle();
    expect(select().props.disabled).toBe(false);
    act(() => select().props.onChange({ currentTarget: { value: 'ou_target_member' } }));
    await click(globalSave(root));
    expect(puts(requests, `/api/global-message-listener/${OTHER_BOT}`).at(-1)?.body.contentPolicy.includeMentionedOpenIds).toEqual(['ou_target_member']);
    await act(async () => { renderer.unmount(); });
  });

  it('offers only real users as identity keywords and rejects bot or out-of-roster values', async () => {
    const requests = mockApi({
      members: () => response({ members: [
        { openId: 'ou_alice', name: 'Alice', memberType: 'user' },
        { openId: 'ou_bot_member', name: 'Bot member', memberType: 'bot' },
      ] }),
    });
    const renderer = await renderPage();
    const root = renderer.root;
    const editor = () => editorOf(root, 'global');
    const select = () => byClass(editor(), 'roles-listener-content-policy')[0]!.findAllByType('select')[0]!;
    const optionValues = () => select().findAllByType('option').map((node: any) => node.props.value);
    expect(optionValues()).toContain('ou_alice');
    expect(optionValues()).not.toContain('ou_bot_member');
    // A synthesized event must not add a bot or an id outside the roster even
    // if the option filter were bypassed — the onChange handler re-checks.
    act(() => select().props.onChange({ currentTarget: { value: 'ou_bot_member' } }));
    expect(editor().props.listener.contentPolicy?.includeMentionedOpenIds).toBeUndefined();
    act(() => select().props.onChange({ currentTarget: { value: 'ou_stranger' } }));
    expect(editor().props.listener.contentPolicy?.includeMentionedOpenIds).toBeUndefined();
    act(() => select().props.onChange({ currentTarget: { value: 'ou_alice' } }));
    expect(editor().props.listener.contentPolicy?.includeMentionedOpenIds).toEqual(['ou_alice']);
    await click(globalSave(root));
    expect(puts(requests, GLOBAL_URL).at(-1)?.body.contentPolicy.includeMentionedOpenIds).toEqual(['ou_alice']);
    await act(async () => { renderer.unmount(); });
  });

  it('keeps "close session after completion" through saves of the global rule and a custom group', async () => {
    const requests = mockApi({ global: savedGlobal({ autoCloseAfterCompletion: true }) });
    const renderer = await renderPage();
    const root = renderer.root;
    expect(editorOf(root, 'global').props.listener.autoCloseAfterCompletion).toBe(true);
    // Saving an unrelated edit must not clear the persisted opt-in.
    act(() => editorOf(root, 'global').props.onPatch({ name: 'renamed' }));
    await click(globalSave(root));
    expect(puts(requests, GLOBAL_URL)[0]?.body.autoCloseAfterCompletion).toBe(true);

    // Turning it on in a custom group reaches the daemon and counts as an edit.
    await click(groupItem(root, 'Custom group'));
    act(() => editorOf(root, 'group').props.onPatch({ autoCloseAfterCompletion: true }));
    expect(byClass(groupItem(root, 'Custom group'), 'message-listener-unsaved-tag')).toHaveLength(1);
    await click(groupSave(root));
    expect(puts(requests, `/api/group-message-listeners/${BOT}/${CUSTOM}`)[0]?.body.listener.autoCloseAfterCompletion).toBe(true);
    await act(async () => { renderer.unmount(); });
  });

  it('records the sender kind of a newly excluded member on save', async () => {
    const requests = mockApi({ global: savedGlobal({ senderPolicy: { mode: 'all_except_excluded', includeSenderTypes: ['user', 'bot'] } }) });
    const renderer = await renderPage();
    const root = renderer.root;
    act(() => editorOf(root, 'global').props.onSetTargetPolicy('ou_bob', false));
    await click(globalSave(root));

    expect(puts(requests, GLOBAL_URL)[0]?.body.senderPolicy).toMatchObject({ mode: 'all_except_excluded', excludeSenderOpenIds: ['ou_bob'], excludeSenderKinds: { ou_bob: 'user' } });
    await act(async () => { renderer.unmount(); });
  });

  it('shows the saved global rule to groups, flags the unsaved draft, and keeps it across a group save', async () => {
    const requests = mockApi();
    const renderer = await renderPage();
    const root = renderer.root;
    act(() => editorOf(root, 'global').props.onPatch({ enabled: false, name: 'draft rule' }));

    // The tab badge and inherit summary describe what groups run right now.
    expect(text(tab(root, 'global'))).toContain('已启用');
    expect(byClass(tab(root, 'global'), 'message-listener-tab-dirty')).toHaveLength(1);
    expect(text(byClass(root, 'message-listener-inherit-summary')[0]!)).toContain('正在使用全局监听规则');

    // Saving a custom group re-reads groups only; the global draft survives.
    confirmMock.mockResolvedValueOnce(true); // leave the inherit group (no custom draft there, so not asked)
    await click(groupItem(root, 'Custom group'));
    act(() => editorOf(root, 'group').props.onPatch({ name: 'edited custom' }));
    await click(groupSave(root));
    expect(puts(requests, `/api/group-message-listeners/${BOT}/${CUSTOM}`)).toHaveLength(1);
    expect(requests.filter(request => request.method === 'GET' && request.url === GLOBAL_URL)).toHaveLength(1);
    expect(editorOf(root, 'global').props.listener).toMatchObject({ enabled: false, name: 'draft rule' });

    // Switching another group to custom copies the SAVED rule, not the draft.
    await click(groupItem(root, 'Inherit group'));
    await click(modeButton(root, 2));
    expect(editorOf(root, 'group').props.listener).toMatchObject({ enabled: true, name: 'saved rule' });

    // Disabling is a narrowing change: saved without a confirmation, then the
    // badge follows and the dirty marker clears.
    confirmMock.mockClear();
    await click(globalSave(root));
    expect(confirmMock).not.toHaveBeenCalled();
    expect(text(tab(root, 'global'))).toContain('未启用');
    expect(byClass(tab(root, 'global'), 'message-listener-tab-dirty')).toHaveLength(0);
    await act(async () => { renderer.unmount(); });
  });
});

describe('unsaved edits', () => {
  beforeEach(() => { confirmMock.mockReset(); confirmMock.mockResolvedValue(true); });
  afterEach(() => vi.restoreAllMocks());

  it('keeps an unsaved switch to custom local: the list shows the saved mode until it is saved', async () => {
    const requests = mockApi();
    const renderer = await renderPage();
    const root = renderer.root;
    await click(modeButton(root, 2));
    expect(puts(requests, `/api/group-message-listeners/${BOT}/${INHERIT}`)).toHaveLength(0);
    expect(hasEditor(root, 'group')).toBe(true);
    const item = () => groupItem(root, 'Inherit group');
    expect(text(byClass(item(), 'message-listener-group-status')[0]!)).toBe('使用全局');
    expect(byClass(item(), 'message-listener-unsaved-tag')).toHaveLength(1);

    // Leaving the group asks first; declining keeps the draft and the selection.
    confirmMock.mockResolvedValueOnce(false);
    await click(groupItem(root, 'Custom group'));
    expect(confirmMock.mock.calls.at(-1)?.[0].message).toContain('Inherit group');
    expect(groupItem(root, 'Inherit group').props['aria-pressed']).toBe(true);
    expect(hasEditor(root, 'group')).toBe(true);

    // Saving persists it as custom.
    await click(groupSave(root));
    const [put] = puts(requests, `/api/group-message-listeners/${BOT}/${INHERIT}`);
    expect(put?.body).toMatchObject({ mode: 'custom', listener: { name: 'saved rule' } });
    expect(text(byClass(item(), 'message-listener-group-status')[0]!)).toBe('自定义');
    expect(byClass(item(), 'message-listener-unsaved-tag')).toHaveLength(0);
    await act(async () => { renderer.unmount(); });
  });

  it('backs out of an unedited switch to custom without asking or writing', async () => {
    const requests = mockApi();
    const renderer = await renderPage();
    const root = renderer.root;
    await click(modeButton(root, 2));
    await click(modeButton(root, 0));
    expect(confirmMock).not.toHaveBeenCalled();
    expect(requests.filter(request => request.method === 'PUT')).toHaveLength(0);
    expect(hasEditor(root, 'group')).toBe(false);
    await act(async () => { renderer.unmount(); });
  });

  it('asks before switching Bot with unsaved edits, and never shows the old Bot rules while the next one loads', async () => {
    const otherGlobal = deferred<Response>();
    mockApi({ otherGlobal: () => otherGlobal.promise });
    const renderer = await renderPage();
    const root = renderer.root;
    act(() => editorOf(root, 'global').props.onPatch({ name: 'draft rule' }));
    const otherBot = () => root.findAll(node => hasClass(node, 'bd-roster-item')).find(node => text(node).includes(OTHER_BOT))!;

    confirmMock.mockResolvedValueOnce(false);
    await click(otherBot());
    expect(editorOf(root, 'global').props.listener).toMatchObject({ name: 'draft rule' });

    await click(otherBot());
    expect(hasEditor(root, 'global')).toBe(false);
    expect(tabs(root)).toHaveLength(0);
    await act(async () => { otherGlobal.resolve(response({ listener: savedGlobal({ name: 'other rule' }) })); });
    await settle();
    expect(editorOf(root, 'global').props.listener).toMatchObject({ name: 'other rule' });
    await act(async () => { renderer.unmount(); });
  });

  it('holds page navigation while edits are unsaved', async () => {
    mockApi();
    const renderer = await renderPage();
    const root = renderer.root;
    expect(pendingLeavePrompt()).toBeNull();
    act(() => editorOf(root, 'global').props.onPatch({ name: 'draft rule' }));
    expect(pendingLeavePrompt()?.message).toContain('未保存');
    await click(globalSave(root));
    expect(pendingLeavePrompt()).toBeNull();
    act(() => editorOf(root, 'global').props.onPatch({ name: 'another draft' }));
    await act(async () => { renderer.unmount(); });
    expect(pendingLeavePrompt()).toBeNull();
  });
});

describe('effective state and confirmations', () => {
  beforeEach(() => { confirmMock.mockReset(); confirmMock.mockResolvedValue(true); });
  afterEach(() => vi.restoreAllMocks());

  it('shows which groups actually listen and warns when the global rule is off', async () => {
    mockApi({ global: savedGlobal({ enabled: false }), customEnabled: true });
    const renderer = await renderPage();
    const root = renderer.root;
    expect(text(byClass(root, 'message-listener-banner')[0]!)).toContain('1 个「使用全局」的群');
    expect(text(byClass(groupItem(root, 'Inherit group'), 'message-listener-effective')[0]!)).toBe('未监听');
    expect(text(byClass(groupItem(root, 'Custom group'), 'message-listener-effective')[0]!)).toBe('监听中');
    expect(text(byClass(root, 'message-listener-mode-counts')[0]!)).toContain('1 个监听中');
    await act(async () => { renderer.unmount(); });
  });

  it('confirms how many groups a widening global save reaches', async () => {
    const requests = mockApi({ global: savedGlobal({ enabled: false }) });
    const renderer = await renderPage();
    const root = renderer.root;
    act(() => editorOf(root, 'global').props.onPatch({ enabled: true }));
    confirmMock.mockResolvedValueOnce(false);
    await click(globalSave(root));
    expect(confirmMock.mock.calls[0]?.[0].message).toContain('1 个使用全局设置的群');
    expect(confirmMock.mock.calls[0]?.[0].message).toContain('启用监听');
    expect(puts(requests, GLOBAL_URL)).toHaveLength(0);
    await click(globalSave(root));
    expect(puts(requests, GLOBAL_URL)).toHaveLength(1);
    await act(async () => { renderer.unmount(); });
  });

  it('asks before a test run posts real replies', async () => {
    const requests = mockApi();
    const renderer = await renderPage();
    const root = renderer.root;
    confirmMock.mockResolvedValueOnce(false);
    await act(async () => { editorOf(root, 'global').props.onRunPreview(); });
    await settle();
    expect(confirmMock.mock.calls[0]?.[0].message).toContain('Inherit group');
    expect(requests.some(request => request.url.endsWith('/run-preview'))).toBe(false);
    await act(async () => { editorOf(root, 'global').props.onRunPreview(); });
    await settle();
    expect(requests.some(request => request.url.endsWith('/run-preview'))).toBe(true);
    await act(async () => { renderer.unmount(); });
  });

  it('explains invalid rules in words, before and after the round trip', async () => {
    const requests = mockApi({ put: request => request.url.includes(CUSTOM) ? response({ ok: false, error: 'sender_required' }, false) : undefined });
    const renderer = await renderPage();
    const root = renderer.root;
    act(() => editorOf(root, 'global').props.onPatch({ prompt: '   ' }));
    await click(globalSave(root));
    expect(puts(requests, GLOBAL_URL)).toHaveLength(0);
    expect(editorOf(root, 'global').props.flash?.text).toBe('启用监听时提示词不能为空');

    // The size limit holds for a disabled draft too.
    act(() => editorOf(root, 'global').props.onPatch({ enabled: false, prompt: 'x'.repeat(40_000) }));
    await click(globalSave(root));
    expect(puts(requests, GLOBAL_URL)).toHaveLength(0);
    expect(editorOf(root, 'global').props.flash?.text).toContain('字节上限');

    await click(groupItem(root, 'Custom group'));
    act(() => editorOf(root, 'group').props.onPatch({ name: 'edited' }));
    await click(groupSave(root));
    expect(editorOf(root, 'group').props.flash?.text).toBe('保存失败：启用监听时至少选择一个发送者');
    // A result belongs to its own editor only.
    expect(editorOf(root, 'global').props.flash).toBeNull();
    await act(async () => { renderer.unmount(); });
  });

});

describe('a custom rule saved switched off with no prompt', () => {
  beforeEach(() => { confirmMock.mockReset(); confirmMock.mockResolvedValue(true); toastMock.mockReset(); });
  afterEach(() => vi.restoreAllMocks());

  // With no global rule set up, a fresh custom draft starts switched off and empty.
  const noGlobalRule = () => savedGlobal({ enabled: false, prompt: '' });
  const status = (root: Instance, name = 'Inherit group') => text(byClass(groupItem(root, name), 'message-listener-group-status')[0]!);

  it('stays custom and paused after the re-read and a reload', async () => {
    const requests = mockApi({ global: noGlobalRule() });
    let renderer = await renderPage();
    await click(modeButton(renderer.root, 2));
    await click(groupSave(renderer.root));
    expect(puts(requests, `/api/group-message-listeners/${BOT}/${INHERIT}`)[0]?.body).toMatchObject({ mode: 'custom', listener: { enabled: false, prompt: '' } });
    expect(editorOf(renderer.root, 'group').props.flash?.text).toBe('已保存');
    expect(status(renderer.root)).toBe('自定义');
    expect(text(byClass(groupItem(renderer.root, 'Inherit group'), 'message-listener-effective')[0]!)).toBe('未监听');
    expect(text(byClass(renderer.root, 'message-listener-detail-head')[0]!)).toContain('规则未启用');

    await act(async () => { renderer.unmount(); });
    renderer = await renderPage();
    expect(status(renderer.root)).toBe('自定义');
    expect(toastMock).not.toHaveBeenCalled();
    await act(async () => { renderer.unmount(); });
  });

  it('does not report a rule the daemon dropped as saved, and keeps the draft open', async () => {
    mockApi({ global: noGlobalRule(), dropsBlankPausedRule: true });
    const renderer = await renderPage();
    const root = renderer.root;
    await click(modeButton(root, 2));
    await click(groupSave(root));
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('没有保留'), { kind: 'error' });
    expect(status(root)).toBe('使用全局');
    // Still an unsaved switch: the user can add a prompt or pick another mode.
    expect(hasEditor(root, 'group')).toBe(true);
    expect(editorOf(root, 'group').props.flash).toBeNull();
    expect(byClass(groupItem(root, 'Inherit group'), 'message-listener-unsaved-tag')).toHaveLength(1);
    await act(async () => { renderer.unmount(); });
  });

  it('re-reads a group whose existing custom rule the daemon dropped, so it no longer shows as custom', async () => {
    mockApi({ global: noGlobalRule(), dropsBlankPausedRule: true });
    const renderer = await renderPage();
    const root = renderer.root;
    await click(groupItem(root, 'Custom group'));
    act(() => editorOf(root, 'group').props.onPatch({ enabled: false, prompt: '' }));
    await click(groupSave(root));
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('「Custom group」'), { kind: 'error' });
    expect(status(root, 'Custom group')).toBe('使用全局');
    await act(async () => { renderer.unmount(); });
  });
});

describe('group list ordering', () => {
  beforeEach(() => { confirmMock.mockReset(); confirmMock.mockResolvedValue(true); });
  afterEach(() => vi.restoreAllMocks());

  const itemNames = (root: Instance) =>
    byClass(root, 'message-listener-group-item').map(node => node.findByType('strong').children.join(''));

  it('shows custom-rule groups first and keeps /api/groups order within each tier', async () => {
    mockApi({
      chats: [
        [INHERIT, 'Inherit group'],
        ['oc_plain_a', 'Plain A'],
        [CUSTOM, 'Custom group'],
        ['oc_plain_b', 'Plain B'],
      ],
    });
    const renderer = await renderPage();
    const root = renderer.root;
    // Source order is inherit, inherit, custom, inherit: the custom block moves
    // to the top, while the three non-custom groups keep their relative order
    // (the page relies on Array.prototype.sort stability).
    expect(itemNames(root)).toEqual(['Custom group', 'Inherit group', 'Plain A', 'Plain B']);
    await act(async () => { renderer.unmount(); });
  });

  it('keeps a paused custom rule in the top tier, and stays partitioned while searching', async () => {
    mockApi({ customEnabled: false });
    const renderer = await renderPage();
    const root = renderer.root;
    // mode stays 'custom' with enabled=false: still a custom configuration, so
    // it remains first even though the group currently does not listen.
    expect(itemNames(root)).toEqual(['Custom group', 'Inherit group']);
    expect(text(byClass(groupItem(root, 'Custom group'), 'message-listener-effective')[0]!)).toBe('未监听');

    const search = byClass(root, 'message-listener-group-search')[0]!;
    await act(async () => { search.props.onChange({ currentTarget: { value: 'inherit' } }); });
    expect(itemNames(root)).toEqual(['Inherit group']);
    await act(async () => { search.props.onChange({ currentTarget: { value: '' } }); });
    expect(itemNames(root)).toEqual(['Custom group', 'Inherit group']);
    await act(async () => { renderer.unmount(); });
  });
});

describe('localization', () => {
  beforeEach(() => {
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value); },
        removeItem: (key: string) => { storage.delete(key); },
      },
      setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {},
    });
    vi.stubGlobal('document', { documentElement: { lang: '', dataset: {} } });
  });
  afterEach(() => {
    act(() => { ui.setLocale('zh'); });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders every page string in English, both tabs and every group state', async () => {
    mockApi({ global: savedGlobal({ enabled: false }) });
    act(() => { ui.setLocale('en'); });
    const renderer = await renderPage();
    const root = renderer.root;
    const cjk = () => JSON.stringify(renderer.toJSON()).match(/[\u4e00-\u9fff]+/g) ?? [];
    expect(text(tab(root, 'groups'))).toContain('Group settings');
    expect(cjk()).toEqual([]);
    await click(modeButton(root, 2)); // unsaved switch to custom: markers + custom editor
    expect(cjk()).toEqual([]);
    await click(modeButton(root, 1)); // disabled summary
    expect(cjk()).toEqual([]);
    await act(async () => { renderer.unmount(); });
  });
});
