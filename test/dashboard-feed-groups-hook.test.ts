import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import {
  FeedGroupAuthOverlay,
  FeedGroupAuthPrompt,
  useFeedGroups,
  type FeedGroupsState,
  type UseFeedGroupsOptions,
} from '../src/dashboard/web/feed-groups.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * groups 页「新建群聊」与 sessions 页「新建会话」共用的飞书标签读取 + 授权状态机。
 * 两处原先各手写一份逐行相同的实现（1s 轮询 /api/feed-groups、auth-url、callback），
 * 这里钉住抽出后的行为：首次读取、读取失败、授权弹层的轮询自动关闭、粘贴回调、
 * 失败回调给各页自己展示、reset、以及 enabled / reloadKey 控制的重读。
 */

type Call = { url: string; method: string; body?: any };

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

let calls: Call[];
let handler: (call: Call) => Response | Promise<Response>;

function listBody(groups: Array<{ groupId: string; name: string }>, larkAppId = 'cli_a') {
  return { ok: true, groups, larkAppId };
}

function mountHook(initial: UseFeedGroupsOptions) {
  const latest: { current: FeedGroupsState | null } = { current: null };
  let options = initial;
  function Harness() {
    latest.current = useFeedGroups(options);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(React.createElement(Harness)); });
  return {
    get feed() { return latest.current!; },
    rerender(next: UseFeedGroupsOptions) {
      options = next;
      act(() => { renderer.update(React.createElement(Harness)); });
    },
    unmount() { act(() => renderer.unmount()); },
  };
}

/** 让挂载 effect 里发起的 fetch 与其后续 setState 都落地。 */
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  calls = [];
  handler = () => jsonResponse(listBody([]));
  (globalThis as any).window = globalThis;
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call);
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as any).window;
});

describe('useFeedGroups — 读取', () => {
  it('挂载即读取一次：loading 先为 true，成功后带出标签与 larkAppId、清空 error', async () => {
    handler = () => jsonResponse(listBody([{ groupId: 'g1', name: '研发' }], 'cli_x'));
    const h = mountHook({ onAuthError: vi.fn() });
    expect(h.feed.loading).toBe(true);
    await flush();
    expect(h.feed.loading).toBe(false);
    expect(h.feed.groups).toEqual([{ groupId: 'g1', name: '研发' }]);
    expect(h.feed.appId).toBe('cli_x');
    expect(h.feed.error).toBe('');
    expect(calls.map(c => c.url)).toEqual(['/api/feed-groups']);
    h.unmount();
  });

  it('读取失败：error 取 body.message，其次 body.error，最后 HTTP 状态码；loading 收起', async () => {
    handler = () => jsonResponse({ ok: false, message: '尚未授权' }, false, 401);
    const h = mountHook({ onAuthError: vi.fn() });
    await flush();
    expect(h.feed.error).toBe('尚未授权');
    expect(h.feed.loading).toBe(false);
    expect(h.feed.groups).toEqual([]);
    h.unmount();

    handler = () => jsonResponse({}, false, 502);
    const h2 = mountHook({ onAuthError: vi.fn() });
    await flush();
    expect(h2.feed.error).toBe('HTTP 502');
    h2.unmount();
  });

  it('enabled=false 不发请求；变为 true 才读取；reloadKey 变化重读', async () => {
    const h = mountHook({ enabled: false, reloadKey: 1, onAuthError: vi.fn() });
    await flush();
    expect(calls).toHaveLength(0);
    expect(h.feed.loading).toBe(false);

    h.rerender({ enabled: true, reloadKey: 1, onAuthError: vi.fn() });
    await flush();
    expect(calls).toHaveLength(1);

    h.rerender({ enabled: true, reloadKey: 1, onAuthError: vi.fn() });
    await flush();
    expect(calls).toHaveLength(1);

    h.rerender({ enabled: true, reloadKey: 2, onAuthError: vi.fn() });
    await flush();
    expect(calls).toHaveLength(2);
    h.unmount();
  });

  it('select 同时写 selectedId 与 newName；reset 清掉选择、error 与授权弹层但保留已读到的列表', async () => {
    handler = () => jsonResponse(listBody([{ groupId: 'g1', name: '研发' }]));
    const h = mountHook({ onAuthError: vi.fn() });
    await flush();
    act(() => h.feed.select('g1', ''));
    expect(h.feed.selectedId).toBe('g1');
    act(() => h.feed.select('', '新标签'));
    expect(h.feed.selectedId).toBe('');
    expect(h.feed.newName).toBe('新标签');

    act(() => h.feed.reset());
    expect(h.feed.selectedId).toBe('');
    expect(h.feed.newName).toBe('');
    expect(h.feed.error).toBe('');
    expect(h.feed.authUrl).toBe('');
    expect(h.feed.groups).toHaveLength(1);
    h.unmount();
  });
});

describe('useFeedGroups — 授权', () => {
  it('openLogin 带上当前 larkAppId 取授权链接；失败时把 body.error 交给 onAuthError("open")', async () => {
    const onAuthError = vi.fn();
    handler = call => {
      if (call.url.startsWith('/api/feed-groups/auth-url')) return jsonResponse({ error: '没有可用的应用' }, false, 400);
      return jsonResponse(listBody([], 'cli_a b'));
    };
    const h = mountHook({ onAuthError });
    await flush();
    await act(async () => { await h.feed.openLogin(); });
    expect(calls.at(-1)!.url).toBe('/api/feed-groups/auth-url?larkAppId=cli_a%20b');
    expect(onAuthError).toHaveBeenCalledWith('open', '没有可用的应用');
    expect(h.feed.authUrl).toBe('');
    h.unmount();
  });

  it('授权链接出现后每秒轮询，一旦读取成功就关闭弹层并刷新列表；轮询失败则弹层保留', async () => {
    vi.useFakeTimers();
    let listOk = false;
    handler = call => {
      if (call.url.startsWith('/api/feed-groups/auth-url')) return jsonResponse({ authUrl: 'https://feishu.test/auth' });
      return listOk ? jsonResponse(listBody([{ groupId: 'g2', name: '产品' }], 'cli_b')) : jsonResponse({ ok: false }, false, 401);
    };
    const h = mountHook({ onAuthError: vi.fn() });
    await flush();
    expect(h.feed.error).toBe('HTTP 401');

    await act(async () => { await h.feed.openLogin(); });
    expect(h.feed.authUrl).toBe('https://feishu.test/auth');
    expect(h.feed.callbackUrl).toBe('');

    // 授权未完成：轮询读取失败，弹层与 error 都保持。
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(h.feed.authUrl).toBe('https://feishu.test/auth');
    expect(h.feed.error).toBe('HTTP 401');

    // 飞书回调被 daemon 接住后读取成功：弹层自动关闭、error 清空、列表刷新。
    listOk = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(h.feed.authUrl).toBe('');
    expect(h.feed.error).toBe('');
    expect(h.feed.groups).toEqual([{ groupId: 'g2', name: '产品' }]);
    expect(h.feed.appId).toBe('cli_b');

    // 弹层已关，不再轮询。
    const before = calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(calls.length).toBe(before);
    h.unmount();
  });

  it('completeLogin：POST 回调（trim 后）→ 重读列表 → 关闭弹层；submitting 全程收尾', async () => {
    let authorized = false;
    handler = call => {
      if (call.url.startsWith('/api/feed-groups/auth-url')) return jsonResponse({ authUrl: 'https://feishu.test/auth' });
      if (call.url === '/api/feed-groups/oauth-callback') { authorized = true; return jsonResponse({ ok: true }); }
      return authorized ? jsonResponse(listBody([{ groupId: 'g3', name: '运营' }])) : jsonResponse({ ok: false }, false, 401);
    };
    const h = mountHook({ onAuthError: vi.fn() });
    await flush();
    await act(async () => { await h.feed.openLogin(); });
    act(() => h.feed.setCallbackUrl('  http://127.0.0.1:9768/callback?code=1  '));
    await act(async () => { await h.feed.completeLogin(h.feed.callbackUrl); });
    const post = calls.find(c => c.url === '/api/feed-groups/oauth-callback')!;
    expect(post.method).toBe('POST');
    expect(post.body).toEqual({ callbackUrl: 'http://127.0.0.1:9768/callback?code=1' });
    expect(h.feed.authUrl).toBe('');
    expect(h.feed.callbackUrl).toBe('');
    expect(h.feed.groups).toEqual([{ groupId: 'g3', name: '运营' }]);
    expect(h.feed.authSubmitting).toBe(false);
    h.unmount();
  });

  it('completeLogin 失败：把错误文案交给 onAuthError("complete")，弹层保留，submitting 收尾', async () => {
    const onAuthError = vi.fn();
    handler = call => {
      if (call.url.startsWith('/api/feed-groups/auth-url')) return jsonResponse({ authUrl: 'https://feishu.test/auth' });
      if (call.url === '/api/feed-groups/oauth-callback') return jsonResponse({ ok: false, message: 'state 不匹配' }, false, 400);
      return jsonResponse({ ok: false }, false, 401);
    };
    const h = mountHook({ onAuthError });
    await flush();
    await act(async () => { await h.feed.openLogin(); });
    await act(async () => { await h.feed.completeLogin('http://bad'); });
    expect(onAuthError).toHaveBeenCalledWith('complete', 'state 不匹配');
    expect(h.feed.authUrl).toBe('https://feishu.test/auth');
    expect(h.feed.authSubmitting).toBe(false);
    h.unmount();
  });

  it('cancelAuth 关闭弹层并清空粘贴框', async () => {
    handler = call => call.url.startsWith('/api/feed-groups/auth-url')
      ? jsonResponse({ authUrl: 'https://feishu.test/auth' })
      : jsonResponse({ ok: false }, false, 401);
    const h = mountHook({ onAuthError: vi.fn() });
    await flush();
    await act(async () => { await h.feed.openLogin(); });
    act(() => h.feed.setCallbackUrl('x'));
    act(() => h.feed.cancelAuth());
    expect(h.feed.authUrl).toBe('');
    expect(h.feed.callbackUrl).toBe('');
    h.unmount();
  });
});

describe('FeedGroupAuthPrompt / FeedGroupAuthOverlay', () => {
  function render(element: React.ReactElement): TestRenderer.ReactTestRenderer {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(element); });
    return renderer;
  }
  function stateOf(over: Partial<FeedGroupsState>): FeedGroupsState {
    return {
      groups: [], appId: '', loading: false, error: '', selectedId: '', newName: '',
      select: () => {}, authUrl: '', callbackUrl: '', authSubmitting: false,
      setCallbackUrl: () => {}, cancelAuth: () => {}, openLogin: async () => {}, completeLogin: async () => {},
      reset: () => {}, ...over,
    } as FeedGroupsState;
  }

  it('无 error / 无 authUrl 时两者都不渲染', () => {
    const prompt = render(React.createElement(FeedGroupAuthPrompt, { feed: stateOf({}), className: 'x' }));
    const overlay = render(React.createElement(FeedGroupAuthOverlay, { feed: stateOf({}), titleId: 't' }));
    expect(prompt.toJSON()).toBeNull();
    expect(overlay.toJSON()).toBeNull();
  });

  it('Prompt 使用调用方传入的 class；授权中按钮置灰并改文案', () => {
    const r = render(React.createElement(FeedGroupAuthPrompt, {
      feed: stateOf({ error: '尚未授权', authSubmitting: true }), className: 'cs-warn',
    }));
    const root = r.root.findByProps({ className: 'cs-warn' });
    const button = root.findByType('button');
    expect(button.props.disabled).toBe(true);
    expect(JSON.stringify(r.toJSON())).toContain('正在完成授权…');
  });

  it('Overlay 的 aria-labelledby 与标题 id 一致；回调为空时「完成授权」置灰', () => {
    const r = render(React.createElement(FeedGroupAuthOverlay, {
      feed: stateOf({ authUrl: 'https://feishu.test/auth', callbackUrl: '   ' }), titleId: 'session-feed-group-auth-title',
    }));
    const section = r.root.findByProps({ role: 'dialog' });
    expect(section.props['aria-labelledby']).toBe('session-feed-group-auth-title');
    expect(r.root.findByType('h3').props.id).toBe('session-feed-group-auth-title');
    const complete = r.root.findAllByType('button').find(b => b.props.className === 'primary');
    expect(complete!.props.disabled).toBe(true);
  });
});
