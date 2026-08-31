import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// The session-group-tag auth overlay renders through `createPortal(…, document.body)`
// (bot-defaults-page.tsx) so it escapes the animated `.page` containing block in the
// real dashboard. react-test-renderer has no DOM host, so a real portal's children are
// NOT placed in the renderer tree and `renderer.root.findByProps` can't see the paste
// input / cancel / complete controls. Render portal children inline here so the overlay
// stays discoverable; production keeps its real createPortal behavior untouched. Only
// createPortal is overridden — everything else in react-dom (which react-test-renderer
// depends on) passes through.
vi.mock('react-dom', () => {
  // `require` inside the factory, not the vitest-only `importOriginal` argument
  // (bun passes none) and not a top-level import (vitest hoists this call above
  // the imports, so a top-level namespace would be read before initialisation).
  const actual = require('react-dom') as typeof import('react-dom');
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});

import { createRefreshGate } from '../src/dashboard/web/bot-defaults.js';
import { SessionGroupTagRow } from '../src/dashboard/web/bot-defaults-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Deferred promise helper: lets the test resolve two overlapping "requests"
// in an arbitrary order to reproduce 后发先回 (a slow earlier request that
// returns AFTER a newer one).
function defer<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('createRefreshGate (bot-defaults latest-wins)', () => {
  it('lets a single request commit', async () => {
    const gate = createRefreshGate();
    const req = gate.begin();
    expect(req.commit()).toBe(true);
  });

  it('invalidates an earlier request once a newer one begins', () => {
    const gate = createRefreshGate();
    const first = gate.begin();
    const second = gate.begin();
    // second is now newest — first must no longer commit, second may.
    expect(first.commit()).toBe(false);
    expect(second.commit()).toBe(true);
  });

  it('drops the stale (后发先回) response and keeps the newest roster', async () => {
    const gate = createRefreshGate();

    // Request A = initial mount refresh (returns the OLD single-bot roster).
    // Request B = bots.changed refresh (returns the NEW two-bot roster).
    const aResp = defer<string[]>();
    const bResp = defer<string[]>();

    let committed: string[] | null = null;
    const runA = (async () => {
      const req = gate.begin();
      const roster = await aResp.promise;
      if (req.commit()) committed = roster;
    })();
    const runB = (async () => {
      const req = gate.begin();
      const roster = await bResp.promise;
      if (req.commit()) committed = roster;
    })();

    // Newest (B) returns FIRST with the fresh roster and commits.
    bResp.resolve(['botA', 'botB']);
    await runB;
    expect(committed).toEqual(['botA', 'botB']);

    // Stale (A) returns LATE with the old roster — must be dropped, not clobber.
    aResp.resolve(['botA']);
    await runA;
    expect(committed).toEqual(['botA', 'botB']);
  });

  it('commit() re-checks live, so a request invalidated mid-flight cannot flip loading off', () => {
    const gate = createRefreshGate();
    const first = gate.begin();
    expect(first.commit()).toBe(true); // still newest before B starts
    gate.begin();                      // B begins → first is now stale
    expect(first.commit()).toBe(false); // both the state write AND loading gate see false
  });
});

// ---------------------------------------------------------------------------
// SessionGroupTagRow bot-switch races: the row instance survives a bot switch
// (same component, new props.bot). A slow saveMode / startAuth response for the
// PREVIOUS bot must be dropped once the row's lifecycle generation moved on —
// it must neither overwrite the new bot's row state nor window.open the old
// bot's authorization page.
// ---------------------------------------------------------------------------

type MockFetchResponse = { ok: boolean; status: number; json: () => Promise<any> };

function jsonResponse(body: any, ok = true, status = 200): MockFetchResponse {
  return { ok, status, json: async () => body };
}

describe('SessionGroupTagRow (bot-switch stale responses)', () => {
  function renderRow(appId: string): TestRenderer.ReactTestRenderer {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(SessionGroupTagRow, { bot: { larkAppId: appId } as any }));
    });
    return renderer;
  }

  function switchBot(renderer: TestRenderer.ReactTestRenderer, appId: string): void {
    renderer.update(React.createElement(SessionGroupTagRow, { bot: { larkAppId: appId } as any }));
  }

  // Run an action, then drain enough microtask ticks for sendJson (fetch →
  // res.json → setState) chains to settle inside act.
  async function flush(action?: () => void): Promise<void> {
    await act(async () => {
      action?.();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // The auth overlay renders only when `authUrl && typeof document !== 'undefined'`
  // and, once open, a modal effect attaches document-level listeners (scroll/keydown).
  // react-test-renderer has no DOM, so without a document stub the overlay's
  // `typeof document` guard short-circuits to null (paste input never appears) and,
  // once past it, `document.addEventListener` throws. Provide the minimum surface the
  // portaled overlay touches; createPortal itself is rendered inline via the top-level
  // react-dom mock. unstubAllGlobals in afterEach clears this between tests.
  beforeEach(() => {
    vi.stubGlobal('document', {
      body: {},
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  it('drops a slow saveMode response from the previous bot instead of overwriting the new row', async () => {
    const oldPut = defer<MockFetchResponse>();
    const newPut = defer<MockFetchResponse>();
    const putUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/session-group-tag-status')) {
        // Old bot starts on feed-group; the new bot's row is chat-tag.
        return jsonResponse({ ok: true, authorized: false, tagMode: url.includes('app_old') ? 'feed-group' : 'chat-tag' });
      }
      if (method === 'PUT' && url.includes('/session-group-tag-config')) {
        putUrls.push(url);
        return url.includes('app_old') ? oldPut.promise : newPut.promise;
      }
      throw new Error(`unexpected ${method} ${url}`);
    }));

    const renderer = renderRow('app_old');
    await flush();
    const dropdown = () => renderer.root.findByProps({ dataInput: 'sessionGroupTagMode' });
    expect(dropdown().props.value).toBe('feed-group');

    // User flips the old bot's mode to 'off' — the PUT hangs (slow server).
    act(() => { dropdown().props.onChange('off'); });
    expect(putUrls).toEqual(['/api/bots/app_old/session-group-tag-config']);

    // Bot switch while the PUT is still in flight: the row resets and loads
    // the new bot's status.
    await flush(() => switchBot(renderer, 'app_new'));
    expect(dropdown().props.value).toBe('chat-tag');

    // The old bot's PUT finally returns — it must NOT overwrite the new row,
    // surface an error on it, or re-enable/disable its controls.
    await flush(() => oldPut.resolve(jsonResponse({ ok: true, tagMode: 'off' })));
    expect(dropdown().props.value).toBe('chat-tag');
    expect(renderer.root.findAllByProps({ className: 'status-error' })).toHaveLength(0);
    expect(dropdown().props.disabled).toBe(false);

    // Positive control: the new bot's OWN save still lands normally.
    act(() => { dropdown().props.onChange('off'); });
    expect(putUrls).toEqual([
      '/api/bots/app_old/session-group-tag-config',
      '/api/bots/app_new/session-group-tag-config',
    ]);
    await flush(() => newPut.resolve(jsonResponse({ ok: true, tagMode: 'off' })));
    expect(dropdown().props.value).toBe('off');
    act(() => renderer.unmount());
  });

  it('drops a stale startAuth success after a bot switch: never opens the old bot auth page', async () => {
    // Keep the authorization poll loop's 3s sleeps inert (they are irrelevant
    // to this race and would otherwise leave a live timer behind).
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    const oldAuth = defer<MockFetchResponse>();
    const newAuth = defer<MockFetchResponse>();
    const postUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/session-group-tag-status')) {
        // Both bots: unauthorized feed-group, so the auth button is rendered.
        return jsonResponse({ ok: true, authorized: false, tagMode: 'feed-group' });
      }
      if (method === 'POST' && url.includes('/session-group-tag-auth')) {
        postUrls.push(url);
        return url.includes('app_old') ? oldAuth.promise : newAuth.promise;
      }
      throw new Error(`unexpected ${method} ${url}`);
    }));

    const renderer = renderRow('app_old');
    await flush();
    const authButton = () => renderer.root.findByProps({ 'data-action': 'session-group-tag-auth' });
    // startAuth now awaits the silent redirect-whitelist repair BEFORE minting the
    // auth URL (the fetch stub above rejects that call, which is exactly the
    // non-blocking path), so the auth POST only goes out after a microtask drain.
    await flush(() => { authButton().props.onClick(); });
    expect(postUrls).toEqual(['/api/bots/app_old/session-group-tag-auth']);

    // Bot switch while the old bot's POST is in flight, THEN its response
    // lands with the old bot's authUrl: the tab must not open.
    await flush(() => switchBot(renderer, 'app_new'));
    await flush(() => oldAuth.resolve(jsonResponse({ ok: true, authUrl: 'https://auth.example/OLD-BOT' })));
    expect(open).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ className: 'status-error' })).toHaveLength(0);
    // authBusy belongs to the old generation — the new row's button stays usable.
    expect(authButton().props.disabled).toBe(false);

    // Positive control: the new bot's own auth flow still opens ITS page.
    await flush(() => { authButton().props.onClick(); });
    await flush(() => newAuth.resolve(jsonResponse({ ok: true, authUrl: 'https://auth.example/NEW-BOT' })));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://auth.example/NEW-BOT', '_blank', 'noopener');
    act(() => renderer.unmount());
  });

  it('drops a stale startAuth failure after a bot switch: no error surfaces on the new row', async () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    const oldAuth = defer<MockFetchResponse>();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/session-group-tag-status')) {
        return jsonResponse({ ok: true, authorized: false, tagMode: 'feed-group' });
      }
      if (method === 'POST' && url.includes('/session-group-tag-auth')) return oldAuth.promise;
      throw new Error(`unexpected ${method} ${url}`);
    }));

    const renderer = renderRow('app_old');
    await flush();
    // Drain past the silent repair call so the auth POST is genuinely in flight
    // when the bot switch happens (that is the race this test is about).
    await flush(() => { renderer.root.findByProps({ 'data-action': 'session-group-tag-auth' }).props.onClick(); });

    await flush(() => switchBot(renderer, 'app_new'));
    // The old bot's POST fails late — the error belongs to the previous
    // generation and must not show up on the new bot's row.
    await flush(() => oldAuth.resolve(jsonResponse({ ok: false, error: 'old-bot-auth-broken' }, false, 500)));
    expect(renderer.root.findAllByProps({ className: 'status-error' })).toHaveLength(0);
    expect(open).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  // Remote-browser paste fallback (the reported bug): a browser reaching the
  // dashboard through the centralized platform m-* subdomain can't hit the
  // daemon's 127.0.0.1:9768 loopback, so the OAuth redirect goes nowhere and the
  // poll never flips. The overlay must let the user paste the callback URL to
  // finish via the cross-process /api/feed-groups/oauth-callback exchanger.
  it('remote fallback: pasting the callback URL completes auth and flips the badge', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    // status starts unauthorized; only the paste callback flips it to authorized.
    let authorized = false;
    const callbackUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/session-group-tag-status')) {
        return jsonResponse({ ok: true, authorized, tagMode: 'feed-group' });
      }
      if (method === 'POST' && url.includes('/session-group-tag-auth')) {
        return jsonResponse({ ok: true, authUrl: 'https://auth.example/REMOTE' });
      }
      if (method === 'POST' && url.includes('/feed-groups/oauth-callback')) {
        callbackUrls.push(String(JSON.parse(init.body).callbackUrl));
        authorized = true; // the daemon saved the token; next status GET reflects it
        return jsonResponse({ ok: true, message: '✅ 授权成功' });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }));

    const renderer = renderRow('app_remote');
    await flush();
    // Kick off auth: overlay (paste input) must appear, distinct from just polling.
    act(() => { renderer.root.findByProps({ 'data-action': 'session-group-tag-auth' }).props.onClick(); });
    await flush();
    const pasteInput = () => renderer.root.findByProps({ 'data-input': 'sessionGroupTagCallbackUrl' });
    expect(open).toHaveBeenCalledWith('https://auth.example/REMOTE', '_blank', 'noopener');
    expect(pasteInput()).toBeTruthy();

    // Paste the loopback callback URL and complete.
    act(() => { pasteInput().props.onChange({ currentTarget: { value: 'http://127.0.0.1:9768/callback?code=C&state=S' } }); });
    await flush(() => { renderer.root.findByProps({ 'data-action': 'session-group-tag-complete' }).props.onClick(); });

    expect(callbackUrls).toEqual(['http://127.0.0.1:9768/callback?code=C&state=S']);
    // Overlay closes (input gone) and the badge reads authorized.
    expect(renderer.root.findAllByProps({ 'data-input': 'sessionGroupTagCallbackUrl' })).toHaveLength(0);
    expect(renderer.root.findByProps({ 'data-sg-tag-state': 'authorized' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ className: 'status-error' })).toHaveLength(0);
    act(() => renderer.unmount());
  });

  // completeAuth success path guards on the confirming status re-check: if the
  // POST succeeds (token exchanged) but the follow-up status GET does NOT report
  // authorized — feed-group scope not granted, or a transient GET failure — the
  // overlay must STAY OPEN with a hint rather than silently closing on a still-⚪
  // badge (Pi's non-blocking observation, folded in).
  it('paste POST ok but status not authorized: keeps overlay open with a hint, no false green', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    // Never flips to authorized (e.g. login granted but feed-group scope wasn't).
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/session-group-tag-status')) {
        return jsonResponse({ ok: true, authorized: false, tagMode: 'feed-group' });
      }
      if (method === 'POST' && url.includes('/session-group-tag-auth')) {
        return jsonResponse({ ok: true, authUrl: 'https://auth.example/NOSCOPE' });
      }
      if (method === 'POST' && url.includes('/feed-groups/oauth-callback')) {
        return jsonResponse({ ok: true, message: '✅ 授权成功' }); // exchange ok, but scope missing
      }
      throw new Error(`unexpected ${method} ${url}`);
    }));

    const renderer = renderRow('app_noscope');
    await flush();
    act(() => { renderer.root.findByProps({ 'data-action': 'session-group-tag-auth' }).props.onClick(); });
    await flush();
    const pasteInput = () => renderer.root.findByProps({ 'data-input': 'sessionGroupTagCallbackUrl' });
    act(() => { pasteInput().props.onChange({ currentTarget: { value: 'http://127.0.0.1:9768/callback?code=C&state=S' } }); });
    await flush(() => { renderer.root.findByProps({ 'data-action': 'session-group-tag-complete' }).props.onClick(); });

    // Overlay stays open, badge still unauthorized, and a hint is shown.
    expect(renderer.root.findAllByProps({ 'data-input': 'sessionGroupTagCallbackUrl' })).toHaveLength(1);
    expect(renderer.root.findByProps({ 'data-sg-tag-state': 'unauthorized' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ className: 'status-error' })).toHaveLength(1);
    act(() => renderer.unmount());
  });

  // Same-machine path: the loopback receiver finishes the exchange out of band,
  // so the 3s poll observes authorized and must auto-close the overlay without
  // any paste.
  it('same-machine path: the poll auto-closes the overlay once authorized', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    let authorized = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/session-group-tag-status')) {
        return jsonResponse({ ok: true, authorized, tagMode: 'feed-group' });
      }
      if (method === 'POST' && url.includes('/session-group-tag-auth')) {
        return jsonResponse({ ok: true, authUrl: 'https://auth.example/LOCAL' });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }));

    const renderer = renderRow('app_local');
    await flush();
    act(() => { renderer.root.findByProps({ 'data-action': 'session-group-tag-auth' }).props.onClick(); });
    await flush();
    expect(renderer.root.findByProps({ 'data-input': 'sessionGroupTagCallbackUrl' })).toBeTruthy();

    // The loopback receiver lands the token; the next poll tick sees it.
    authorized = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });

    expect(renderer.root.findAllByProps({ 'data-input': 'sessionGroupTagCallbackUrl' })).toHaveLength(0);
    expect(renderer.root.findByProps({ 'data-sg-tag-state': 'authorized' })).toBeTruthy();
    act(() => renderer.unmount());
  });

  // Q2 narrow race: the same-machine loopback consumes the one-shot state moments
  // before the user's paste lands. The oauth-callback POST then fails with
  // "state 不匹配", but the token IS saved — completeAuth must re-check status and
  // treat it as success (no red error next to the green badge).
  it('paste after loopback already consumed the state: re-checks status, shows no false error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    // Token not yet saved at mount (button shows); the loopback lands it right
    // before the paste POST, which itself fails because the state is consumed.
    let authorized = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/session-group-tag-status')) {
        return jsonResponse({ ok: true, authorized, tagMode: 'feed-group' });
      }
      if (method === 'POST' && url.includes('/session-group-tag-auth')) {
        return jsonResponse({ ok: true, authUrl: 'https://auth.example/RACE' });
      }
      if (method === 'POST' && url.includes('/feed-groups/oauth-callback')) {
        authorized = true; // loopback already landed the token before this paste
        return jsonResponse({ ok: false, error: 'oauth_exchange_failed', message: '❌ 授权失败：state 不匹配或已过期，请重新发起授权' }, false, 400);
      }
      throw new Error(`unexpected ${method} ${url}`);
    }));

    const renderer = renderRow('app_race');
    await flush();
    act(() => { renderer.root.findByProps({ 'data-action': 'session-group-tag-auth' }).props.onClick(); });
    await flush();
    const pasteInput = () => renderer.root.findByProps({ 'data-input': 'sessionGroupTagCallbackUrl' });
    act(() => { pasteInput().props.onChange({ currentTarget: { value: 'http://127.0.0.1:9768/callback?code=C&state=S' } }); });
    await flush(() => { renderer.root.findByProps({ 'data-action': 'session-group-tag-complete' }).props.onClick(); });

    // Despite the POST failing, status re-check sees authorized → overlay closes,
    // badge green, NO error surfaced.
    expect(renderer.root.findAllByProps({ className: 'status-error' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-input': 'sessionGroupTagCallbackUrl' })).toHaveLength(0);
    expect(renderer.root.findByProps({ 'data-sg-tag-state': 'authorized' })).toBeTruthy();
    act(() => renderer.unmount());
  });

  // Cancel must stop startAuth's in-flight poll and re-enable the button —
  // otherwise authBusy stays true and "一键授权" is stuck disabled for up to 3min.
  it('cancel stops the poll and re-enables the authorize button', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    let statusGets = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/session-group-tag-status')) {
        statusGets += 1;
        return jsonResponse({ ok: true, authorized: false, tagMode: 'feed-group' });
      }
      if (method === 'POST' && url.includes('/session-group-tag-auth')) {
        return jsonResponse({ ok: true, authUrl: 'https://auth.example/CANCEL' });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }));

    const renderer = renderRow('app_cancel');
    await flush();
    const authButton = () => renderer.root.findByProps({ 'data-action': 'session-group-tag-auth' });
    act(() => { authButton().props.onClick(); });
    await flush();
    // Overlay open, button disabled (waiting).
    expect(authButton().props.disabled).toBe(true);
    act(() => { renderer.root.findByProps({ 'data-action': 'session-group-tag-cancel' }).props.onClick(); });
    await flush();
    // Overlay closed and button usable again immediately.
    expect(renderer.root.findAllByProps({ 'data-input': 'sessionGroupTagCallbackUrl' })).toHaveLength(0);
    expect(authButton().props.disabled).toBe(false);

    // The poll must be dead: advancing well past a tick triggers no further status GETs.
    const before = statusGets;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    expect(statusGets).toBe(before);
    act(() => renderer.unmount());
  });
});

// 「会话群标签」区块的标签名输入框（用户实测反馈：只有模式下拉，找不到在哪配名字）。
// 关注点是保存语义，不是 race：失焦/回车触发保存、留空=清配置回默认、无改动不打接口、
// placeholder 展示的是服务端算出来的默认名「<bot 名>会话」。
describe('SessionGroupTagRow (标签名输入框)', () => {
  function renderRow(appId: string): TestRenderer.ReactTestRenderer {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(SessionGroupTagRow, { bot: { larkAppId: appId } as any }));
    });
    return renderer;
  }

  async function flush(action?: () => void): Promise<void> {
    await act(async () => {
      action?.();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
  }

  /** 记录每次 PUT 的 body；GET 返回当前已保存的标签名。 */
  function stubServer(initial: { tagMode?: string; tagName?: string; defaultTagName?: string } = {}) {
    const state = {
      tagMode: initial.tagMode ?? 'feed-group',
      tagName: initial.tagName ?? '',
      defaultTagName: initial.defaultTagName ?? 'CodeXonAst会话',
    };
    const puts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/session-group-tag-status')) {
        return jsonResponse({ ok: true, authorized: true, ...state });
      }
      if (method === 'PUT' && url.includes('/session-group-tag-config')) {
        const body = JSON.parse(init.body);
        puts.push(body);
        // 服务端语义：trim 后为空 = 清配置；这里连同 trim 一起模拟。
        if (typeof body.name === 'string') state.tagName = body.name.trim();
        if (body.mode) state.tagMode = body.mode;
        return jsonResponse({ ok: true, ...state });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }));
    return { puts, state };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('首屏回填已保存的名字，placeholder 用服务端算出的默认名', async () => {
    stubServer({ tagName: '我的工作台' });
    const renderer = renderRow('app_name');
    await flush();

    const input = renderer.root.findByProps({ 'data-input': 'sessionGroupTagName' });
    expect(input.props.value).toBe('我的工作台');
    expect(input.props.placeholder).toBe('CodeXonAst会话');
    act(() => renderer.unmount());
  });

  it('失焦保存：写入 trim 后的名字并回填服务端存下来的值', async () => {
    const { puts } = stubServer();
    const renderer = renderRow('app_name');
    await flush();
    const input = () => renderer.root.findByProps({ 'data-input': 'sessionGroupTagName' });

    await flush(() => { input().props.onChange({ currentTarget: { value: '  我的工作台 ' } }); });
    await flush(() => { input().props.onBlur(); });

    expect(puts).toEqual([{ name: '我的工作台' }]);
    expect(input().props.value).toBe('我的工作台');
    // 成功提示与页面其它控件同款（StatusSpan）。
    expect(renderer.root.findByProps({ 'data-sg-tag-name-status': '' }).props.children).toBeTruthy();
    act(() => renderer.unmount());
  });

  it('回车触发失焦（真正的保存挂在 onBlur 上）', async () => {
    const { puts } = stubServer();
    const renderer = renderRow('app_name');
    await flush();
    const input = () => renderer.root.findByProps({ 'data-input': 'sessionGroupTagName' });

    await flush(() => { input().props.onChange({ currentTarget: { value: '按回车保存' } }); });
    const blur = vi.fn();
    const preventDefault = vi.fn();
    act(() => { input().props.onKeyDown({ key: 'Enter', preventDefault, currentTarget: { blur } }); });
    expect(preventDefault).toHaveBeenCalled();
    expect(blur).toHaveBeenCalled();
    // 没敲回车的按键不做任何事。
    act(() => { input().props.onKeyDown({ key: 'a', preventDefault: vi.fn(), currentTarget: { blur: vi.fn() } }); });

    await flush(() => { input().props.onBlur(); });
    expect(puts).toEqual([{ name: '按回车保存' }]);
    act(() => renderer.unmount());
  });

  it('清空 = 发空串清配置，回到默认名', async () => {
    const { puts } = stubServer({ tagName: '我的工作台' });
    const renderer = renderRow('app_name');
    await flush();
    const input = () => renderer.root.findByProps({ 'data-input': 'sessionGroupTagName' });

    await flush(() => { input().props.onChange({ currentTarget: { value: '   ' } }); });
    await flush(() => { input().props.onBlur(); });

    expect(puts).toEqual([{ name: '' }]);
    expect(input().props.value).toBe('');
    expect(input().props.placeholder).toBe('CodeXonAst会话');
    act(() => renderer.unmount());
  });

  it('没改动的失焦不打接口', async () => {
    const { puts } = stubServer({ tagName: '我的工作台' });
    const renderer = renderRow('app_name');
    await flush();
    const input = () => renderer.root.findByProps({ 'data-input': 'sessionGroupTagName' });

    await flush(() => { input().props.onBlur(); });
    expect(puts).toEqual([]);
    act(() => renderer.unmount());
  });

  it('off 模式不渲染输入框（不打标签，名字没有意义）', async () => {
    stubServer({ tagMode: 'off' });
    const renderer = renderRow('app_name');
    await flush();

    expect(renderer.root.findAllByProps({ 'data-input': 'sessionGroupTagName' })).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('chat-tag 模式同样有输入框（两种模式共用一个标签名）', async () => {
    stubServer({ tagMode: 'chat-tag' });
    const renderer = renderRow('app_name');
    await flush();

    expect(renderer.root.findAllByProps({ 'data-input': 'sessionGroupTagName' })).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('保存失败时把错误显示在标签名这一行，不污染模式行', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return jsonResponse({ ok: true, authorized: true, tagMode: 'feed-group', tagName: '', defaultTagName: 'CodeXonAst会话' });
      }
      return jsonResponse({ ok: false, error: 'bot_not_in_config' }, false, 400);
    }));
    const renderer = renderRow('app_name');
    await flush();
    const input = () => renderer.root.findByProps({ 'data-input': 'sessionGroupTagName' });

    await flush(() => { input().props.onChange({ currentTarget: { value: '新名字' } }); });
    await flush(() => { input().props.onBlur(); });

    expect(renderer.root.findByProps({ 'data-sg-tag-name-status': '' }).props.children).toContain('bot_not_in_config');
    expect(renderer.root.findAllByProps({ className: 'status-error' })).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('切 bot 后输入框换成新 bot 的名字与默认名', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('app_old')) {
        return jsonResponse({ ok: true, authorized: true, tagMode: 'feed-group', tagName: '旧 bot 的名字', defaultTagName: 'OldBot会话' });
      }
      if (method === 'GET') {
        return jsonResponse({ ok: true, authorized: true, tagMode: 'feed-group', tagName: '', defaultTagName: 'NewBot会话' });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }));
    const renderer = renderRow('app_old');
    await flush();
    const input = () => renderer.root.findByProps({ 'data-input': 'sessionGroupTagName' });
    expect(input().props.value).toBe('旧 bot 的名字');

    await flush(() => renderer.update(React.createElement(SessionGroupTagRow, { bot: { larkAppId: 'app_new' } as any })));
    expect(input().props.value).toBe('');
    expect(input().props.placeholder).toBe('NewBot会话');
    act(() => renderer.unmount());
  });
});
