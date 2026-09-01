import { afterEach, beforeEach, describe, it, expect, vi } from 'bun:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// Same portal shim as dashboard-bot-defaults-refresh-race.test.ts: the auth overlay
// and the Feishu login modal both `createPortal(…, document.body)` so they escape the
// animated `.page` containing block in the real dashboard. react-test-renderer has no
// DOM host, so a real portal's children never land in the renderer tree. Render them
// inline here; production keeps its real createPortal behavior untouched.
vi.mock('react-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-dom')>();
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});

import { SessionGroupTagRow } from '../src/dashboard/web/bot-defaults-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type MockFetchResponse = { ok: boolean; status: number; json: () => Promise<any> };

function jsonResponse(body: any, ok = true, status = 200): MockFetchResponse {
  return { ok, status, json: async () => body };
}

const REPAIR_URL = '/api/open-platform/repair-redirects';

/**
 * B4 的核心契约：「一键授权」先静默补一次开放平台 redirect 白名单，但那一步
 * **永远不能挡住授权**——缺登录态 / 已有一批在跑 / console 报错 / 网络超时，一律
 * 照常开授权页，只在区块内留一条提示。这里逐条钉住。
 */
describe('SessionGroupTagRow — redirect 白名单修复', () => {
  function renderRow(appId = 'cli_repairtest'): TestRenderer.ReactTestRenderer {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(SessionGroupTagRow, { bot: { larkAppId: appId } as any }));
    });
    return renderer;
  }

  async function flush(action?: () => void): Promise<void> {
    await act(async () => {
      action?.();
      for (let i = 0; i < 16; i++) await Promise.resolve();
    });
  }

  beforeEach(() => {
    vi.stubGlobal('document', { body: {}, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** 记录所有 repair 请求体，并让 repair 返回调用方指定的响应。 */
  function stubFetch(opts: {
    repair: () => MockFetchResponse;
    repairBodies: any[];
    authorized?: () => boolean;
    onAuth?: () => MockFetchResponse;
    loginStart?: () => MockFetchResponse;
  }) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/session-group-tag-status')) {
        return jsonResponse({ ok: true, authorized: opts.authorized?.() ?? false, tagMode: 'feed-group' });
      }
      if (method === 'POST' && url === REPAIR_URL) {
        opts.repairBodies.push(JSON.parse(init.body));
        return opts.repair();
      }
      if (method === 'POST' && url.includes('/session-group-tag-auth')) {
        return opts.onAuth?.() ?? jsonResponse({ ok: true, authUrl: 'https://auth.example/OK' });
      }
      if (method === 'POST' && url.includes('/api/feishu-login/start')) {
        return opts.loginStart?.() ?? jsonResponse({ login: { status: 'starting' } });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }));
  }

  const repairButton = (r: TestRenderer.ReactTestRenderer) =>
    r.root.findAllByProps({ 'data-action': 'session-group-tag-repair' })[0];
  const authButton = (r: TestRenderer.ReactTestRenderer) =>
    r.root.findByProps({ 'data-action': 'session-group-tag-auth' });
  const feedback = (r: TestRenderer.ReactTestRenderer, kind: string) =>
    r.root.findAllByProps({ 'data-sg-tag-repair-feedback': kind });

  it('一键授权：先修白名单，成功（fixed）则静默继续，不留任何提示', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    const repairBodies: any[] = [];
    stubFetch({
      repairBodies,
      repair: () => jsonResponse({
        ok: true,
        results: [{ appId: 'cli_repairtest', status: 'fixed', redirectUrls: ['http://127.0.0.1:9768/callback'] }],
        wanted: ['http://127.0.0.1:9768/callback'],
      }),
    });

    const renderer = renderRow();
    await flush();
    await flush(() => { authButton(renderer).props.onClick(); });

    // 修复只点名当前 bot；授权页照常打开；区块里干干净净。
    expect(repairBodies).toEqual([{ appIds: ['cli_repairtest'] }]);
    expect(open).toHaveBeenCalledWith('https://auth.example/OK', '_blank', 'noopener');
    expect(feedback(renderer, 'done')).toHaveLength(0);
    expect(feedback(renderer, 'error')).toHaveLength(0);
    expect(feedback(renderer, 'login_required')).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('一键授权：修复只补上一部分（partial）不算成功，必须把缺失地址显示出来', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    const repairBodies: any[] = [];
    stubFetch({
      repairBodies,
      repair: () => jsonResponse({
        ok: true,
        results: [{
          appId: 'cli_repairtest',
          status: 'partial',
          message: '完整地址列表被开放平台拒绝，已退回最小集写入；仍缺: https://m-abc.example.com/oauth/callback',
          redirectUrls: ['http://127.0.0.1:9768/callback'],
          missingRedirectUrls: ['https://m-abc.example.com/oauth/callback'],
        }],
        wanted: ['http://127.0.0.1:9768/callback', 'https://m-abc.example.com/oauth/callback'],
      }),
    });

    const renderer = renderRow();
    await flush();
    await flush(() => { authButton(renderer).props.onClick(); });

    // 授权流程本身照常不被阻塞（既定设计）。
    expect(open).toHaveBeenCalledWith('https://auth.example/OK', '_blank', 'noopener');
    // 但绝不能像 fixed 那样静默：缺的那条恰恰可能是这次要用的回调地址。
    expect(feedback(renderer, 'done')).toHaveLength(1);
    const item = renderer.root.findByProps({ 'data-sg-tag-repair-item': 'partial' });
    const text = String(item.props.children);
    expect(text).toContain('https://m-abc.example.com/oauth/callback');
    act(() => renderer.unmount());
  });

  it('一键授权：修复报 feishu_login_required 也照常开授权页，并给一条可点的扫码提示', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    const repairBodies: any[] = [];
    stubFetch({
      repairBodies,
      // 服务端契约：缺登录态回 HTTP 200 + ok:false + errorCode，不是错误码 4xx。
      repair: () => jsonResponse({ ok: false, errorCode: 'feishu_login_required', message: '没有可用的飞书开放平台登录态' }),
    });

    const renderer = renderRow();
    await flush();
    await flush(() => { authButton(renderer).props.onClick(); });

    expect(open).toHaveBeenCalledWith('https://auth.example/OK', '_blank', 'noopener');
    expect(feedback(renderer, 'login_required')).toHaveLength(1);
    // 提示是可点的：点它弹扫码框，而不是把红错怼在授权按钮旁边。
    expect(renderer.root.findByProps({ 'data-action': 'session-group-tag-repair-login' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ className: 'status-error' })).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('一键授权：修复撞上 409 repair_in_flight 照常授权，提示归到 error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    const repairBodies: any[] = [];
    stubFetch({
      repairBodies,
      repair: () => jsonResponse({ ok: false, errorCode: 'repair_in_flight', message: '已有一批 redirect 白名单修复在执行' }, false, 409),
    });

    const renderer = renderRow();
    await flush();
    await flush(() => { authButton(renderer).props.onClick(); });

    expect(open).toHaveBeenCalledWith('https://auth.example/OK', '_blank', 'noopener');
    expect(feedback(renderer, 'error')).toHaveLength(1);
    expect(renderer.root.findAllByProps({ className: 'status-error' })).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('一键授权：修复整个请求抛异常（网络/超时）仍照常授权', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/session-group-tag-status')) {
        return jsonResponse({ ok: true, authorized: false, tagMode: 'feed-group' });
      }
      // AbortSignal.timeout 触发时 fetch 就是这样 reject 的。
      if (method === 'POST' && url === REPAIR_URL) throw new Error('The operation was aborted');
      if (method === 'POST' && url.includes('/session-group-tag-auth')) {
        return jsonResponse({ ok: true, authUrl: 'https://auth.example/TIMEOUT' });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }));

    const renderer = renderRow();
    await flush();
    await flush(() => { authButton(renderer).props.onClick(); });

    expect(open).toHaveBeenCalledWith('https://auth.example/TIMEOUT', '_blank', 'noopener');
    expect(feedback(renderer, 'error')).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('一键授权：修复回 not_owned（换了账号）也不挡授权，逐 bot 列出结果', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    const repairBodies: any[] = [];
    stubFetch({
      repairBodies,
      repair: () => jsonResponse({
        ok: true,
        results: [{ appId: 'cli_repairtest', status: 'not_owned', message: '不是该应用的协作者' }],
        wanted: [],
      }),
    });

    const renderer = renderRow();
    await flush();
    await flush(() => { authButton(renderer).props.onClick(); });

    expect(open).toHaveBeenCalledWith('https://auth.example/OK', '_blank', 'noopener');
    expect(feedback(renderer, 'done')).toHaveLength(1);
    expect(renderer.root.findByProps({ 'data-sg-tag-repair-item': 'not_owned' })).toBeTruthy();
    act(() => renderer.unmount());
  });

  it('次级入口「修复配置」：默认只修当前 bot，结果逐条回显', async () => {
    const repairBodies: any[] = [];
    stubFetch({
      repairBodies,
      repair: () => jsonResponse({
        ok: true,
        results: [{ appId: 'cli_repairtest', status: 'unchanged', redirectUrls: ['http://127.0.0.1:9768/callback'] }],
        wanted: ['http://127.0.0.1:9768/callback'],
      }),
    });

    const renderer = renderRow();
    await flush();
    await flush(() => { repairButton(renderer).props.onClick(); });

    expect(repairBodies).toEqual([{ appIds: ['cli_repairtest'] }]);
    expect(renderer.root.findByProps({ 'data-sg-tag-repair-item': 'unchanged' })).toBeTruthy();
    act(() => renderer.unmount());
  });

  it('勾上「顺便补齐其它 bot」后，修复请求不带 appIds（服务端按全量处理）', async () => {
    const repairBodies: any[] = [];
    stubFetch({
      repairBodies,
      repair: () => jsonResponse({
        ok: true,
        results: [
          { appId: 'cli_repairtest', status: 'fixed' },
          { appId: 'cli_other', status: 'fixed' },
        ],
        wanted: [],
      }),
    });

    const renderer = renderRow();
    await flush();
    const checkbox = () => renderer.root.findByProps({ 'data-input': 'sessionGroupTagRepairAll' });
    act(() => { checkbox().props.onChange({ currentTarget: { checked: true } }); });
    await flush(() => { repairButton(renderer).props.onClick(); });

    // 空 appIds 数组在服务端等于「一个都不修」，所以全量必须是**整个字段缺席**。
    expect(repairBodies).toEqual([{}]);
    expect(renderer.root.findAllByProps({ 'data-sg-tag-repair-item': 'fixed' })).toHaveLength(2);
    act(() => renderer.unmount());
  });

  it('次级入口遇到缺登录态：弹现成的飞书扫码框，扫完自动重跑修复', async () => {
    const timeouts: Array<() => void> = [];
    vi.stubGlobal('window', {
      open: vi.fn(),
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      setTimeout: vi.fn((cb: () => void) => { timeouts.push(cb); return 1; }),
      clearTimeout: vi.fn(),
    });
    const repairBodies: any[] = [];
    let loggedIn = false;
    stubFetch({
      repairBodies,
      repair: () => (loggedIn
        ? jsonResponse({ ok: true, results: [{ appId: 'cli_repairtest', status: 'fixed' }], wanted: [] })
        : jsonResponse({ ok: false, errorCode: 'feishu_login_required', message: '没有可用的飞书开放平台登录态' })),
      // 扫码面板一开就报成功（真实链路里是轮询到 success）。
      loginStart: () => { loggedIn = true; return jsonResponse({ login: { status: 'success' } }); },
    });

    const renderer = renderRow();
    await flush();
    await flush(() => { repairButton(renderer).props.onClick(); });

    // 第一次修复缺登录态 → 弹扫码框（不报错、也不显示 login_required 行内提示，
    // 因为用户是主动点的「修复配置」，直接进扫码更顺）。
    expect(repairBodies).toHaveLength(1);
    expect(renderer.root.findByProps({ className: 'feishu-login-title' })).toBeTruthy();

    // FeishuLoginModal 在 status=success 后延时 900ms 调 onSuccess；这里直接放行。
    await flush(() => { timeouts.forEach(cb => cb()); });

    // 扫完自动重跑：第二次修复成功，扫码框关闭，结果回显。
    expect(repairBodies).toHaveLength(2);
    expect(renderer.root.findAllByProps({ className: 'feishu-login-title' })).toHaveLength(0);
    expect(renderer.root.findByProps({ 'data-sg-tag-repair-item': 'fixed' })).toBeTruthy();
    act(() => renderer.unmount());
  });

  it('授权轮询跑满仍未授权：给出 20029 诊断 + 「修复配置」入口 + 安全设置深链', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    const repairBodies: any[] = [];
    stubFetch({
      repairBodies,
      repair: () => jsonResponse({ ok: true, results: [{ appId: 'cli_repairtest', status: 'fixed' }], wanted: [] }),
    });

    const renderer = renderRow();
    await flush();
    await flush(() => { authButton(renderer).props.onClick(); });
    expect(renderer.root.findAllByProps({ 'data-sg-tag-auth-timeout': true })).toHaveLength(0);

    // 3s × 60 次轮询全部落空。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000 * 61);
      for (let i = 0; i < 16; i++) await Promise.resolve();
    });

    const diagnostics = renderer.root.findAllByProps({ 'data-sg-tag-auth-timeout': true });
    expect(diagnostics.length).toBeGreaterThan(0);
    // 深链指向开放平台该应用的「安全设置」页 —— 白名单就配在那儿。
    const safeLink = renderer.root.findAllByType('a').find(a => String(a.props.href).endsWith('/safe'));
    expect(safeLink?.props.href).toBe('https://open.feishu.cn/app/cli_repairtest/safe');
    // 诊断里带着「修复配置」按钮（弹窗内 + 行内共用同一份节点）。
    expect(renderer.root.findAllByProps({ 'data-action': 'session-group-tag-repair' }).length).toBeGreaterThan(1);
    // 超时不是错误：不弹红字，粘贴弹窗仍开着等远程用户粘贴。
    expect(renderer.root.findAllByProps({ className: 'status-error' })).toHaveLength(0);
    expect(renderer.root.findByProps({ 'data-input': 'sessionGroupTagCallbackUrl' })).toBeTruthy();
    act(() => renderer.unmount());
  });

  // 「修复配置」和一键授权的静默修复打的是同一个 single-flight 接口，所以修复期间
  // 按钮必须置灰；更要紧的是**跑完必须放开**——之前 startAuth 的 ++generation 会让
  // 手动修复的提交守卫失配、busy 态永远留在 true，把按钮锁死到换 bot 为止。
  it('修复按钮在请求期间置灰，一键授权的静默修复跑完后重新可点', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.stubGlobal('window', { open: vi.fn() });
    let release!: (v: MockFetchResponse) => void;
    const pending = new Promise<MockFetchResponse>(r => { release = r; });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/session-group-tag-status')) {
        return jsonResponse({ ok: true, authorized: false, tagMode: 'feed-group' });
      }
      if (method === 'POST' && url === REPAIR_URL) return pending;
      if (method === 'POST' && url.includes('/session-group-tag-auth')) {
        return jsonResponse({ ok: true, authUrl: 'https://auth.example/OK' });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }));

    const renderer = renderRow();
    await flush();
    expect(repairButton(renderer).props.disabled).toBe(false);

    await flush(() => { authButton(renderer).props.onClick(); });
    expect(repairButton(renderer).props.disabled).toBe(true);

    await flush(() => release(jsonResponse({ ok: true, results: [{ appId: 'cli_repairtest', status: 'fixed' }], wanted: [] })));
    expect(repairButton(renderer).props.disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it('换 bot 后旧 bot 的修复结果不会留在新行上', async () => {
    const repairBodies: any[] = [];
    stubFetch({
      repairBodies,
      repair: () => jsonResponse({ ok: true, results: [{ appId: 'cli_old', status: 'fixed' }], wanted: [] }),
    });

    const renderer = renderRow('cli_old');
    await flush();
    await flush(() => { repairButton(renderer).props.onClick(); });
    expect(renderer.root.findAllByProps({ 'data-sg-tag-repair-item': 'fixed' })).toHaveLength(1);

    await flush(() => renderer.update(
      React.createElement(SessionGroupTagRow, { bot: { larkAppId: 'cli_new' } as any }),
    ));
    expect(renderer.root.findAllByProps({ 'data-sg-tag-repair-item': 'fixed' })).toHaveLength(0);
    act(() => renderer.unmount());
  });
});
