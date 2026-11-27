import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const namesSnapshot = vi.hoisted(() => vi.fn(async () => ({
  bots: [{ larkAppId: 'cli_lark', botName: '飞书助理', cliId: 'claude' }],
  chats: [],
})));
vi.mock('../src/dashboard/web/groups-api.js', () => ({ fetchGroupsNamesSnapshot: namesSnapshot }));

import { BotDefaultsCard, BotDefaultsPage } from '../src/dashboard/web/bot-defaults-page.js';
import { BotRosterRow } from '../src/dashboard/web/bot-profile-ui.js';
import { LoadingState } from '../src/dashboard/web/dashboard-components.js';
import { BOT_ONBOARDING_COMPLETED_EVENT } from '../src/dashboard/web/bot-onboarding-events.js';
import { OverviewPage } from '../src/dashboard/web/overview-page.js';
import { providerRosterSnapshot, publishProviderRoster } from '../src/dashboard/web/provider-roster.js';
import { bootstrap, store } from '../src/dashboard/web/store.js';
import { t } from '../src/dashboard/web/ui.js';
import { useWecomConnections } from '../src/dashboard/web/wecom-connections-section.js';
import { startWecomRosterSync } from '../src/dashboard/web/wecom-roster-sync.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const WECOM_LIST = '/api/wecom/connections';
const connection = {
  id: 'cfg', label: '企微助理', botIdHint: '…cfg', allowedUserCount: 1, coreMode: 'managed', configuration: 'ready',
  gateway: 'running', connection: 'connected', ownership: 'dashboard', canStart: false, canStop: true,
};
const larkBot = { larkAppId: 'cli_lark', botName: '飞书助理', cliId: 'claude' };

let renderer: TestRenderer.ReactTestRenderer | undefined;
let fetched: string[] = [];

type Reply = Promise<Response> | Response;

function stubFetch(routes: { wecom: () => Reply; bots?: () => Reply; board?: () => Reply }): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetched.push(url);
    if (url === WECOM_LIST) return routes.wecom();
    if (url === '/api/sessions?view=board' && routes.board) return routes.board();
    if (url === '/api/schedules') return new Response(JSON.stringify({ schedules: [] }));
    if (url === '/api/bots') return routes.bots ? routes.bots() : new Response(JSON.stringify({ bots: [larkBot] }));
    if (url.startsWith('/api/cli-options')) return new Response(JSON.stringify({ options: [{ id: 'claude', label: 'Claude' }], status: 'available', models: [] }));
    if (url === '/api/agents') return new Response(JSON.stringify({ agents: [], links: {} }));
    return new Response('{}', { status: 404 });
  }));
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const wecomListCalls = () => fetched.filter(url => url === WECOM_LIST).length;
const wecomApiCalls = () => fetched.filter(url => url.startsWith('/api/wecom/')).length;

/** store 的 bootstrap 只需要一个永远不发帧的 EventSource。 */
class SilentEventSource {
  readyState = 0;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(readonly url: string) {}
  addEventListener(): void {}
  close(): void { this.readyState = 2; }
}

function stubWindow(): void {
  const storage = new Map<string, string>();
  const events = new EventTarget();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
    location: { hash: '#/' },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  });
}

async function mount(node: React.ReactElement): Promise<TestRenderer.ReactTestRenderer> {
  await act(async () => { renderer = TestRenderer.create(node); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return renderer!;
}

beforeEach(() => {
  vi.useFakeTimers();
  fetched = [];
  namesSnapshot.mockClear();
  stubWindow();
  publishProviderRoster('lark', 1);
  publishProviderRoster('wecom', 0);
});

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('overview requests', () => {
  it('sends no WeCom request and never re-reads the names snapshot for a Feishu-only deployment', async () => {
    stubFetch({ wecom: () => json({ connections: [] }) });
    const page = await mount(React.createElement(OverviewPage));
    const namesAfterMount = namesSnapshot.mock.calls.length;

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(wecomListCalls()).toBe(0);
    expect(namesSnapshot.mock.calls.length).toBe(namesAfterMount);
    // 页头也和企微接入前一样：没有额外的「Bot 配置」入口。
    const headingActions = page.root.find(node => node.type === 'div' && node.props.className === 'page-heading-actions');
    expect(headingActions.findAll(node => node.type === 'a' && node.props.href === '#/bot-defaults')).toHaveLength(0);
  });

  it('refreshes only the small WeCom list while WeCom connections exist', async () => {
    publishProviderRoster('wecom', 1);
    stubFetch({ wecom: () => json({ connections: [connection] }) });
    await mount(React.createElement(OverviewPage));
    const namesAfterMount = namesSnapshot.mock.calls.length;

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(wecomListCalls()).toBeGreaterThan(1);
    expect(namesSnapshot.mock.calls.length).toBe(namesAfterMount);
  });
});

describe('bot configuration page requests', () => {
  it('shows the Feishu bot while the WeCom list is still loading', async () => {
    publishProviderRoster('wecom', 1);
    stubFetch({ wecom: () => new Promise<Response>(() => {}) });
    const page = await mount(React.createElement(BotDefaultsPage));

    expect(page.root.findAllByType(BotDefaultsCard)).toHaveLength(1);
    expect(page.root.findAllByType(LoadingState)).toHaveLength(0);
  });

  it('shows the Feishu bot when the WeCom list fails', async () => {
    publishProviderRoster('wecom', 1);
    stubFetch({ wecom: () => json({ error: 'boom' }, 500) });
    const page = await mount(React.createElement(BotDefaultsPage));

    expect(page.root.findAllByType(BotDefaultsCard)).toHaveLength(1);
  });

  it('never reads the WeCom list and keeps the Feishu roster rows unprefixed for a Feishu-only deployment', async () => {
    stubFetch({ wecom: () => json({ connections: [] }) });
    const page = await mount(React.createElement(BotDefaultsPage));

    await act(async () => { page.root.findByProps({ id: 'bd-refresh' }).props.onClick(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(wecomApiCalls()).toBe(0);
    const [row] = page.root.findAllByType(BotRosterRow);
    expect(row!.props.subtitle).toBe('claude');
  });

  it('keeps polling and labels the platform once WeCom connections exist', async () => {
    publishProviderRoster('wecom', 1);
    stubFetch({ wecom: () => json({ connections: [connection] }) });
    const page = await mount(React.createElement(BotDefaultsPage));

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(wecomListCalls()).toBeGreaterThan(1);
    const larkRow = page.root.findAllByType(BotRosterRow).find(node => node.props.id === 'cli_lark');
    expect(larkRow!.props.subtitle).toBe(`${t('provider.lark')} · claude`);
  });

  it('shows the translated empty state when there is no bot at all', async () => {
    stubFetch({ wecom: () => json({ connections: [] }), bots: () => json({ bots: [] }) });
    const page = await mount(React.createElement(BotDefaultsPage));

    const empty = page.root.find(node => node.type === 'p' && node.props.className === 'empty');
    expect(empty.children.join('')).toBe(t('botDefaults.empty'));
  });

  it('does not poll the WeCom list from a background tab', async () => {
    publishProviderRoster('wecom', 1);
    vi.stubGlobal('document', { hidden: true, addEventListener() {}, removeEventListener() {} });
    stubFetch({ wecom: () => json({ connections: [connection] }) });
    await mount(React.createElement(BotDefaultsPage));
    const afterMount = wecomListCalls();

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(afterMount).toBe(1);
    expect(wecomListCalls()).toBe(afterMount);
  });
});

describe('WeCom connection list polling', () => {
  /**
   * The hook the Bot configuration page lists connections with, in a page whose
   * content counts its renders: the content re-renders whenever the page does.
   */
  async function mountConnections(list: () => Promise<{ status: number; body: { connections: any[] } }>) {
    let renders = 0;
    const client = { list: vi.fn(list), action: vi.fn(async () => ({ ok: true, status: 202 })) };
    function Content(_props: { connections: unknown[] }) {
      renders += 1;
      return null;
    }
    function Page() {
      const { connections } = useWecomConnections({ client });
      return React.createElement(Content, { connections });
    }
    await mount(React.createElement(Page));
    return { client, renders: () => renders };
  }

  it('does not re-render when a poll brings the same connections, and does when they change', async () => {
    publishProviderRoster('wecom', 1);
    let gateway = 'running';
    const page = await mountConnections(async () => ({ status: 200, body: { connections: [{ ...connection, gateway }] } }));
    const afterMount = page.renders();

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(page.client.list.mock.calls.length).toBeGreaterThan(2);
    expect(page.renders()).toBe(afterMount);

    gateway = 'stopped';
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(page.renders()).toBeGreaterThan(afterMount);
  });
});

describe('WeCom roster follows the board snapshot', () => {
  const larkRow = { sessionId: 'lark-1', status: 'working', larkAppId: 'cli_lark', cliId: 'claude' };

  async function bootWithRosterSync() {
    vi.stubGlobal('EventSource', SilentEventSource);
    const sync = startWecomRosterSync({ canRead: () => true, onUpdate: () => {} });
    await bootstrap({
      canReadProviderSessions: () => true,
      onSessionSnapshot: sync.onSessionSnapshot,
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    return sync;
  }

  it('sends no /api/wecom request across startup, the config page, a bots.changed and a minute for a Feishu-only deployment', async () => {
    stubFetch({ wecom: () => json({ connections: [] }), board: () => json({ sessions: [larkRow] }) });
    const sync = await bootWithRosterSync();
    try {
      expect(providerRosterSnapshot()).toMatchObject({ wecomKnown: true, hasWecomBots: false });
      await mount(React.createElement(BotDefaultsPage));
      await act(async () => { store.applySse('bots.changed', { digest: 'next' }); });
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

      expect(wecomApiCalls()).toBe(0);
    } finally {
      sync.dispose();
    }
  });

  it('loads the WeCom list when the board reports WeCom connections', async () => {
    stubFetch({
      wecom: () => json({ connections: [connection] }),
      board: () => json({ sessions: [larkRow], wecomSessionIds: [], wecomConnectionCount: 1 }),
    });
    const sync = await bootWithRosterSync();
    try {
      expect(wecomListCalls()).toBe(1);
      expect(providerRosterSnapshot().hasWecomBots).toBe(true);
    } finally {
      sync.dispose();
    }
  });

  it('turns the roster to WeCom once the wizard finishes the first WeCom bot', async () => {
    stubFetch({ wecom: () => json({ connections: [connection] }), board: () => json({ sessions: [larkRow] }) });
    const sync = await bootWithRosterSync();
    try {
      expect(providerRosterSnapshot().hasWecomBots).toBe(false);
      await act(async () => {
        window.dispatchEvent(new CustomEvent(BOT_ONBOARDING_COMPLETED_EVENT, { detail: { platform: 'wecom', connectionId: 'cfg' } }));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(wecomListCalls()).toBe(1);
      expect(providerRosterSnapshot().hasWecomBots).toBe(true);
    } finally {
      sync.dispose();
    }
  });

  it('clears the WeCom rows of an identity that turns out unable to read them, keeping them while it can', async () => {
    const open = { sessionId: 'wecom:cfg:core:open', provider: 'wecom', providerBotId: 'cfg', status: 'working' };
    const closed = { ...open, sessionId: 'wecom:cfg:core:closed', status: 'closed', closedAt: 5 };
    let readable = true;
    const sync = startWecomRosterSync({ canRead: () => readable, onUpdate: () => {} });
    try {
      store.replaceSnapshot([larkRow, open, closed], null, undefined, { closedCursor: null, closedTotal: 1, wecomSessionIds: [open.sessionId, closed.sessionId] });
      sync.onAuthStateLoaded();
      expect(store.sessions.has(open.sessionId)).toBe(true);

      readable = false;
      // The narrower identity's next board snapshot has no WeCom ids, so it cannot drop the closed row.
      store.replaceSnapshot([larkRow], null, undefined, { closedCursor: null, closedTotal: 1 });
      expect(store.sessions.has(closed.sessionId)).toBe(true);
      sync.onAuthStateLoaded();

      expect(store.sessions.has(open.sessionId)).toBe(false);
      expect(store.sessions.has(closed.sessionId)).toBe(false);
      expect(store.sessions.has(larkRow.sessionId)).toBe(true);
      expect(wecomApiCalls()).toBe(0);
    } finally {
      sync.dispose();
      store.replaceSnapshot([], null, undefined, { wecomSessionIds: [] });
    }
  });
});
