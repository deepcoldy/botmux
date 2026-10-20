import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroupReplyModeRow, GroupReplyModeSection, replyModeStateFromPut } from '../src/dashboard/web/group-reply-mode.js';
import { getChatModeForGroup, setReplyModeForGroup, type GroupsActionDeps } from '../src/dashboard/groups-action-helpers.js';
import { dashboardEventInvalidatesGroupsMatrix } from '../src/dashboard/groups-matrix-snapshot.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());

const inherited = { override: null, default: 'chat', effective: 'chat', inherited: true } as const;

it('offers inherit + four modes, shows the source, and saves/rolls back via PUT', async () => {
  let failure = false;
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const { mode } = JSON.parse(init.body as string);
    return new Response(JSON.stringify(failure
      ? { ok: false, error: 'chat_mode_unconfirmed' }
      : { ok: true, override: mode === 'inherit' ? null : mode }), { status: failure ? 503 : 200 });
  });
  vi.stubGlobal('fetch', fetcher);
  const props = { chatId: 'oc_a', appId: 'app-a', botName: '助手', state: inherited, onSaved: vi.fn(async () => undefined) };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(GroupReplyModeRow, props)); });
  const select = () => renderer.root.findByType('select');
  try {
    expect(select().props.value).toBe('inherit');
    expect(select().findAllByType('option').map(o => o.props.value))
      .toEqual(['inherit', 'chat-topic', 'chat', 'shared', 'new-topic']);
    const source = renderer.root.find(n => n.props.className === 'group-reply-mode-source').children.join('');
    expect(source).toMatch(/继承|inherits/);

    await act(async () => select().props.onChange({ currentTarget: { value: 'new-topic' } }));
    expect(fetcher).toHaveBeenLastCalledWith('/api/groups/oc_a/reply-mode/app-a', expect.objectContaining({
      method: 'PUT', body: '{"mode":"new-topic"}',
    }));
    expect(select().props.value).toBe('new-topic');
    expect(props.onSaved).toHaveBeenCalledOnce();

    failure = true;
    await act(async () => select().props.onChange({ currentTarget: { value: 'chat' } }));
    expect(select().props.value).toBe('new-topic'); // rolled back
    expect(props.onSaved).toHaveBeenCalledOnce();

    failure = false;
    await act(async () => select().props.onChange({ currentTarget: { value: 'inherit' } }));
    expect(fetcher).toHaveBeenLastCalledWith('/api/groups/oc_a/reply-mode/app-a', expect.objectContaining({ body: '{"mode":"inherit"}' }));
    expect(select().props.value).toBe('inherit');
  } finally { await act(async () => renderer.unmount()); }
});

it('topic groups only allow clearing a dormant override', async () => {
  const base = { chatId: 'oc_t', appId: 'app-a', botName: 'b', topicGroup: true, onSaved: vi.fn(async () => undefined) };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(GroupReplyModeRow, { ...base, state: inherited })); });
  try {
    expect(renderer.root.findByType('select').props.disabled).toBe(true);
    await act(async () => renderer.update(React.createElement(GroupReplyModeRow, {
      ...base, state: { override: 'new-topic', default: 'chat', effective: 'new-topic', inherited: false },
    })));
    const select = renderer.root.findByType('select');
    expect(select.props.disabled).toBe(false);
    expect(select.findAllByType('option').map(o => o.props.value)).toEqual(['inherit', 'new-topic']);
  } finally { await act(async () => renderer.unmount()); }
});

it('proxies to the exact bot daemon and invalidates the snapshot only on success', async () => {
  const proxyToDaemon = vi.fn(async () => new Response('{"ok":true}'));
  const invalidateGroups = vi.fn();
  const deps = { proxyToDaemon, invalidateGroups } as unknown as GroupsActionDeps;
  expect(await setReplyModeForGroup('oc_a', 'app-a', '{"mode":"inherit"}', deps)).toEqual({ status: 200, body: { ok: true } });
  expect(proxyToDaemon).toHaveBeenCalledWith('app-a', '/api/group-reply-mode/oc_a', expect.objectContaining({ method: 'PUT', body: '{"mode":"inherit"}' }));
  expect(invalidateGroups).toHaveBeenCalledOnce();
  proxyToDaemon.mockResolvedValue(new Response('{"ok":false}', { status: 409 }));
  await setReplyModeForGroup('oc_a', 'app-a', '{"mode":"chat"}', deps);
  expect(invalidateGroups).toHaveBeenCalledOnce();
});

it('daemon reply-policy events (e.g. from /reply-mode in Lark) invalidate the groups matrix', () => {
  expect(dashboardEventInvalidatesGroupsMatrix({ type: 'groups.reply-policy.changed' })).toBe(true);
  expect(dashboardEventInvalidatesGroupsMatrix({ type: 'session.update' })).toBe(false);
});

const dormant = { override: 'new-topic', default: 'chat', effective: 'new-topic', inherited: false } as const;
function sectionChat(chatMode = 'group') {
  return {
    chatId: 'oc_s', name: 'g', chatMode, memberBots: [
      { larkAppId: 'app-a', botName: 'A', inChat: true, replyMode: dormant },
      { larkAppId: 'app-b', botName: 'B', inChat: true, replyMode: inherited },
      { larkAppId: 'app-c', botName: 'C', inChat: false },
    ],
  } as any;
}
async function renderSection(chat: any) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(GroupReplyModeSection, { chat, onSaved: async () => undefined })); });
  return renderer;
}
const optionsOf = (r: TestRenderer.ReactTestRenderer) => r.root.findAllByType('select')
  .map(sel => ({ disabled: sel.props.disabled, values: sel.findAllByType('option').map(o => o.props.value) }));
const fieldset = (r: TestRenderer.ReactTestRenderer) => r.root.findByType('fieldset');

it('regular group switched to the topic layout (chat_mode=group, probe=topic) only offers clearing dormant overrides', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, chatMode: 'topic' })));
  vi.stubGlobal('fetch', fetcher);
  const r = await renderSection(sectionChat('group'));
  try {
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith('/api/groups/oc_s/chat-mode/app-a');
    expect(fieldset(r).props['data-topology']).toBe('topic');
    expect(optionsOf(r)).toEqual([
      { disabled: false, values: ['inherit', 'new-topic'] },
      { disabled: true, values: ['inherit'] },
    ]);
    // 同一对话框内刷新（成员数据变化）不再重复查询
    await act(async () => r.update(React.createElement(GroupReplyModeSection, { chat: sectionChat('group'), onSaved: async () => undefined })));
    expect(fetcher).toHaveBeenCalledOnce();
  } finally { await act(async () => r.unmount()); }
});

it('confirmed regular group gets the full selector', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, chatMode: 'group' }))));
  const r = await renderSection(sectionChat('group'));
  try {
    expect(fieldset(r).props['data-topology']).toBe('group');
    expect(optionsOf(r)[1]).toEqual({ disabled: false, values: ['inherit', 'chat-topic', 'chat', 'shared', 'new-topic'] });
  } finally { await act(async () => r.unmount()); }
});

it('probe failure / unknown degrades conservatively: neutral copy, no topic pre-judgement', async () => {
  for (const respond of [
    async () => new Response(JSON.stringify({ ok: true, chatMode: 'unknown' })),
    async () => new Response(JSON.stringify({ ok: false, error: 'offline' }), { status: 503 }),
    async () => { throw new Error('network'); },
  ]) {
    vi.stubGlobal('fetch', vi.fn(respond));
    const r = await renderSection(sectionChat('group'));
    try {
      expect(fieldset(r).props['data-topology']).toBe('unknown');
      expect(r.root.findByType('p').findByType('small').children.join('')).toMatch(/保存时会校验群类型|checked on save/);
      expect(optionsOf(r)[1].values).toEqual(['inherit', 'chat-topic', 'chat', 'shared', 'new-topic']);
    } finally { await act(async () => r.unmount()); }
  }
});

it('chat_mode=topic from the list needs no probe', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const r = await renderSection(sectionChat('topic'));
  try {
    expect(fetcher).not.toHaveBeenCalled();
    expect(fieldset(r).props['data-topology']).toBe('topic');
  } finally { await act(async () => r.unmount()); }
});

it('topology probe proxies a read-only GET to the named bot daemon without invalidating', async () => {
  const proxyToDaemon = vi.fn(async () => new Response('{"ok":true,"chatMode":"topic"}'));
  const invalidateGroups = vi.fn();
  const deps = { proxyToDaemon, invalidateGroups } as unknown as GroupsActionDeps;
  expect(await getChatModeForGroup('oc_a', 'app-a', deps)).toEqual({ status: 200, body: { ok: true, chatMode: 'topic' } });
  expect(proxyToDaemon).toHaveBeenCalledWith('app-a', '/api/group-chat-mode/oc_a', { method: 'GET' });
  expect(invalidateGroups).not.toHaveBeenCalled();
});

describe('GroupReplyModeRow save / snapshot behaviour (same as the other group-management rows)', () => {
  const st = (override: string | null) => ({
    override, default: 'chat', effective: override ?? 'chat', inherited: override === null,
  }) as any;
  const rowProps = (state: any, onSaved = vi.fn(async () => undefined)) =>
    ({ chatId: 'oc_r', appId: 'app-a', botName: 'A', state, onSaved });
  const value = (r: TestRenderer.ReactTestRenderer) => r.root.findByType('select').props.value;

  it('a successful save takes the PUT result, even when the refresh fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, override: 'shared' }))));
    const onSaved = vi.fn(async () => { throw new Error('refresh failed'); });
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(React.createElement(GroupReplyModeRow, rowProps(st('chat'), onSaved))); });
    try {
      // 服务端回包的规范化值（topic → shared）为准，而不是本地选择值
      await act(async () => r.root.findByType('select').props.onChange({ currentTarget: { value: 'new-topic' } }));
      expect(value(r)).toBe('shared');
      expect(onSaved).toHaveBeenCalledOnce();
    } finally { await act(async () => r.unmount()); }
  });

  it('a failed save rolls back to the pre-save value', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'chat_mode_unconfirmed' }), { status: 503 })));
    const onSaved = vi.fn(async () => undefined);
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(React.createElement(GroupReplyModeRow, rowProps(st('new-topic'), onSaved))); });
    try {
      await act(async () => r.root.findByType('select').props.onChange({ currentTarget: { value: 'chat' } }));
      expect(value(r)).toBe('new-topic');
      expect(onSaved).not.toHaveBeenCalled();
      expect(r.root.findByProps({ role: 'status' }).children.join('')).toMatch(/无法确认群类型|confirm the chat type/);
    } finally { await act(async () => r.unmount()); }
  });

  it('follows snapshot changes while not saving', async () => {
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(React.createElement(GroupReplyModeRow, rowProps(st(null)))); });
    try {
      expect(value(r)).toBe('inherit');
      await act(async () => r.update(React.createElement(GroupReplyModeRow, rowProps(st('chat-topic')))));
      expect(value(r)).toBe('chat-topic');
      await act(async () => r.update(React.createElement(GroupReplyModeRow, rowProps(st(null)))));
      expect(value(r)).toBe('inherit');
    } finally { await act(async () => r.unmount()); }
  });

  const source = (r: TestRenderer.ReactTestRenderer) =>
    r.root.find(n => n.props.className === 'group-reply-mode-source').children.join('');

  it('renders the effective mode and source from the PUT result until the next snapshot arrives', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true, chatId: 'oc_r', mode: 'new-topic', override: 'new-topic', default: 'chat', effective: 'new-topic', inherited: false,
    }))));
    const onSaved = vi.fn(async () => { throw new Error('refresh failed'); });
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(React.createElement(GroupReplyModeRow, rowProps(st(null), onSaved))); });
    try {
      expect(source(r)).toMatch(/继承|inherits/);
      await act(async () => r.root.findByType('select').props.onChange({ currentTarget: { value: 'new-topic' } }));
      expect(value(r)).toBe('new-topic');
      // 刷新失败、快照仍是「继承 chat」：说明也必须跟随已确认的保存结果
      expect(source(r)).toMatch(/本群覆盖|group override/);
      expect(source(r)).toMatch(/每次 @ 开新话题|A new topic per @/);
      expect(source(r)).not.toMatch(/继承|inherits/);

      // 下一份快照到来后回到跟随快照
      await act(async () => r.update(React.createElement(GroupReplyModeRow, rowProps(st('shared'), onSaved))));
      expect(value(r)).toBe('shared');
      expect(source(r)).toMatch(/分话题展示，共享会话|Topic display, shared session/);
    } finally { await act(async () => r.unmount()); }
  });

  it('clearing to inherit shows the inherited source from the PUT result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true, chatId: 'oc_r', cleared: true, override: null, default: 'chat-topic', effective: 'chat-topic', inherited: true,
    }))));
    let r!: TestRenderer.ReactTestRenderer;
    const onSaved = vi.fn(async () => { throw new Error('refresh failed'); });
    await act(async () => { r = TestRenderer.create(React.createElement(GroupReplyModeRow, rowProps(st('new-topic'), onSaved))); });
    try {
      await act(async () => r.root.findByType('select').props.onChange({ currentTarget: { value: 'inherit' } }));
      expect(value(r)).toBe('inherit');
      expect(source(r)).toMatch(/继承|inherits/);
      expect(source(r)).toMatch(/顶层连续，话题独立|Continuous on top, isolated topics/);
    } finally { await act(async () => r.unmount()); }
  });

  it('replyModeStateFromPut takes complete PUT bodies and derives missing fields from the known bot default', () => {
    expect(replyModeStateFromPut({ ok: true, override: 'shared', default: 'chat', effective: 'shared', inherited: false }))
      .toEqual({ override: 'shared', default: 'chat', effective: 'shared', inherited: false });
    expect(replyModeStateFromPut({ ok: true, override: 'new-topic' }, 'chat'))
      .toEqual({ override: 'new-topic', default: 'chat', effective: 'new-topic', inherited: false });
    expect(replyModeStateFromPut({ ok: true, override: null }, 'chat-topic'))
      .toEqual({ override: null, default: 'chat-topic', effective: 'chat-topic', inherited: true });
    expect(replyModeStateFromPut({ ok: true, override: 'chat' })).toBeNull();
  });
});
