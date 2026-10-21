import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageListenersPage } from '../src/dashboard/web/message-listeners-page.js';
import { pendingLeavePrompt } from '../src/dashboard/web/leave-guard.js';
import { ui } from '../src/dashboard/web/ui.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const confirmMock = vi.hoisted(() => vi.fn(async (_options: { title: string; message: string }) => true));
vi.mock('../src/dashboard/web/confirm-modal.js', () => ({ confirm: confirmMock }));

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
  put?: (request: Request) => Response | undefined;
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
      if (chatId) groupState.set(chatId, { mode: request.body.mode, listener: request.body.listener ?? null });
      return response({ ok: true });
    }
    if (url === '/api/groups') return response({ chats: [chat(INHERIT, 'Inherit group'), chat(CUSTOM, 'Custom group')] });
    if (url === `/api/global-message-listener/${BOT}`) return response({ listener: options.global ?? savedGlobal() });
    if (url === `/api/global-message-listener/${OTHER_BOT}`) return options.otherGlobal?.() ?? response({ listener: savedGlobal({ name: 'other rule' }) });
    if (url === `/api/group-message-listeners/${BOT}`) return response({ groups: [...groupState].map(([chatId, state]) => ({ chatId, ...state })) });
    if (url === `/api/group-message-listeners/${OTHER_BOT}`) return response({ groups: [{ chatId: INHERIT, mode: 'inherit', listener: null }] });
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
