import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 看板视图换成记录 props 的替身：只看会话页交给它的回调引用，不渲染卡片。
const kanbanRenders = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../src/dashboard/web/sessions-kanban.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/dashboard/web/sessions-kanban.js')>(),
  SessionsKanbanView: (props: Record<string, unknown>) => {
    kanbanRenders.push(props);
    return null;
  },
}));
vi.mock('../src/dashboard/web/groups-api.js', () => ({
  fetchGroupsNamesSnapshot: vi.fn(async () => ({ bots: [], chats: [] })),
}));

import { SessionsPage } from '../src/dashboard/web/sessions-page.js';
import { publishProviderRoster } from '../src/dashboard/web/provider-roster.js';
import { store } from '../src/dashboard/web/store.js';
import { t } from '../src/dashboard/web/ui.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let renderer: TestRenderer.ReactTestRenderer | undefined;

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  kanbanRenders.length = 0;
  vi.unstubAllGlobals();
});

function stubBrowser(): void {
  const storage = new Map<string, string>();
  // 页面里的 base-ui 控件在 layout effect 里做 instanceof 判断；没有 DOM 构造器时会直接抛错。
  class FakeElement {}
  class FakeHTMLElement extends FakeElement {}
  vi.stubGlobal('Element', FakeElement);
  vi.stubGlobal('HTMLElement', FakeHTMLElement);
  vi.stubGlobal('window', {
    Element: FakeElement,
    HTMLElement: FakeHTMLElement,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
    location: { hash: '#/sessions', protocol: 'https:', origin: 'https://fixture.invalid', hostname: 'fixture.invalid' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setInterval: () => 0,
    clearInterval: () => undefined,
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  vi.stubGlobal('document', { getElementById: () => null, documentElement: { lang: '', dataset: {} } });
}

describe('sessions page wiring', () => {
  // KanbanCard 的 memo 比较器逐个比较回调引用（卡片多时全量重渲染一次点选阻塞约 2s）。
  // 会话页每次重渲染（每条 SSE、每次 store emit）都必须交出同一组函数，否则 memo 全部失效。
  it('hands the kanban the same callback references across page re-renders', async () => {
    stubBrowser();
    store.replaceSnapshot([
      { sessionId: 'lark-1', status: 'working', larkAppId: 'cli_a', cliId: 'claude', title: 'one' },
      {
        sessionId: 'wecom:cfg:core:1', provider: 'wecom', providerBotId: 'cfg', status: 'working', cliId: 'codex',
        title: 'two', capabilities: { interrupt: true, history: true },
      },
    ], null);

    await act(async () => { renderer = TestRenderer.create(React.createElement(SessionsPage)); });
    expect(kanbanRenders.length).toBeGreaterThan(0);
    const before = kanbanRenders.at(-1)!;
    const renderedBefore = kanbanRenders.length;

    await act(async () => { store.setOnline(!store.getSnapshot().online); });
    expect(kanbanRenders.length).toBeGreaterThan(renderedBefore);
    const after = kanbanRenders.at(-1)!;

    const callbackNames = Object.keys(before).filter(name => typeof before[name] === 'function');
    expect(callbackNames).toContain('onInterrupt');
    const changed = callbackNames.filter(name => after[name] !== before[name]);
    expect(changed).toEqual([]);
  });

  it('offers platform source filters only when WeCom bots or sessions exist', async () => {
    stubBrowser();
    const sourceValues = () => renderer!.root
      .find(node => typeof node.type !== 'string' && node.props.name === t('sessions.filters.source'))
      .props.options.map((option: { value: string }) => option.value);

    publishProviderRoster('wecom', 0);
    store.replaceSnapshot([{ sessionId: 'lark-1', status: 'working', larkAppId: 'cli_a', cliId: 'claude' }], null);
    await act(async () => { renderer = TestRenderer.create(React.createElement(SessionsPage)); });
    expect(sourceValues()).toEqual(['no', 'yes']);

    await act(async () => { publishProviderRoster('wecom', 1); });
    expect(sourceValues()).toEqual(['wecom', 'lark', 'no', 'yes']);

    await act(async () => { publishProviderRoster('wecom', 0); });
    await act(async () => {
      store.replaceSnapshot([
        { sessionId: 'lark-1', status: 'working', larkAppId: 'cli_a', cliId: 'claude' },
        { sessionId: 'wecom:cfg:core:1', provider: 'wecom', providerBotId: 'cfg', status: 'working', cliId: 'codex' },
      ], null);
    });
    expect(sourceValues()).toEqual(['wecom', 'lark', 'no', 'yes']);
  });
});
