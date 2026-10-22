/**
 * ⌘K 索引的覆盖面与 Bot 配置相关的可达性：
 *
 *   - 覆盖：路由表里的每个页面要么在侧边栏 / 索引子页面里，要么写明理由排除；设置页的每个区块、
 *     Bot 配置页的每个分类、数据洞察的每个 tab 都进索引——新加页面或分区忘了登记就红。
 *   - 可达：「Bot 配置」「机器人配置」「bot settings」直达 Bot 配置页，分类可直达定位，按 bot 名
 *     或 app id 直达那个 bot 的配置；中英两种界面都要成立。
 *   - 不抢：新收录的子页面 / 分类不能把主页面挤下首条（「会话」「sessions」「设置」这类高频短词）。
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { searchPalette, type PaletteItem } from '../src/dashboard/web/command-palette-model.js';
import {
  SETTINGS_SEARCH_INDEX,
  buildBotDefaultsTabItems,
  buildBotItems,
  buildPageItems,
  buildSessionItems,
  buildSettingItems,
  type PalettePageEntry,
} from '../src/dashboard/web/command-palette-sources.js';
import {
  BOT_DEFAULTS_TABS,
  BOT_DEFAULTS_TAB_LABEL_KEYS,
  botDefaultsHref,
  parseBotDefaultsTab,
} from '../src/dashboard/web/bot-defaults.js';
import { BotDefaultsTabs } from '../src/dashboard/web/bot-defaults-page.js';
import { dashboardRoutes, findDashboardRoute } from '../src/dashboard/web/dashboard-routes.js';
import { INSIGHT_TABS } from '../src/dashboard/web/insight-tabs.js';
import { NAV_ITEMS, NAV_SUBPAGES, PALETTE_UNINDEXED_ROUTES, type NavItem } from '../src/dashboard/web/nav-items.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
import { knownBots, loadNameMaps, t, ui } from '../src/dashboard/web/ui.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const zh = createDashboardTranslator('zh');
const en = createDashboardTranslator('en');

const navLabel = (item: NavItem): string => (item.labelKey ? t(item.labelKey) : item.label ?? item.id);

function navPage(id: string): PalettePageEntry {
  const item = NAV_ITEMS.find(entry => entry.id === id)!;
  return { id: item.id, href: item.href, label: navLabel(item), labelKey: item.labelKey, aliases: item.aliases };
}

/** 与壳层 paletteNavPages() 同样的组装：子页面挂在父页面下。 */
function subPages(): PalettePageEntry[] {
  return NAV_SUBPAGES.map(sub => {
    const parent = NAV_ITEMS.find(item => item.id === sub.parentId)!;
    return { id: sub.id, href: sub.href, label: t(sub.labelKey), labelKey: sub.labelKey, aliases: sub.aliases, parent: { label: navLabel(parent), labelKey: parent.labelKey } };
  });
}

function topItem(items: PaletteItem[], query: string): PaletteItem | undefined {
  const row = searchPalette({ items, query, scope: 'all' }).rows[0];
  return row?.type === 'item' ? row.item : undefined;
}

describe('⌘K index coverage', () => {
  it('every dashboard route is in the sidebar or NAV_SUBPAGES, or excluded on purpose with a reason', () => {
    const indexedHrefs = [...NAV_ITEMS.map(item => item.href), ...NAV_SUBPAGES.map(sub => sub.href)];
    const uncovered = dashboardRoutes
      .filter(route => !indexedHrefs.some(href => findDashboardRoute(href)?.id === route.id))
      .filter(route => !(route.id in PALETTE_UNINDEXED_ROUTES))
      .map(route => route.id);
    expect(uncovered, `routes missing from the ⌘K index: ${uncovered.join(', ')}`).toEqual([]);
    // 排除名单不能留着已经不存在的路由。
    const stale = Object.keys(PALETTE_UNINDEXED_ROUTES).filter(id => !dashboardRoutes.some(route => route.id === id));
    expect(stale).toEqual([]);
  });

  it('every sub-page lands on a real route under an existing sidebar item, and is translated in both locales', () => {
    for (const sub of NAV_SUBPAGES) {
      expect(findDashboardRoute(sub.href), sub.href).toBeDefined();
      expect(NAV_ITEMS.some(item => item.id === sub.parentId), sub.parentId).toBe(true);
      expect(zh(sub.labelKey), sub.labelKey).not.toBe(sub.labelKey);
      expect(en(sub.labelKey), sub.labelKey).not.toBe(sub.labelKey);
    }
  });

  it('indexes every Insights tab (overview is the page itself)', () => {
    for (const tab of INSIGHT_TABS.filter(entry => entry.key !== 'overview')) {
      expect(NAV_SUBPAGES.some(sub => sub.href === `#/insights?tab=${tab.key}`), tab.key).toBe(true);
    }
  });

  it('indexes every Bot config category, with the same labels the page renders', () => {
    const items = buildBotDefaultsTabItems();
    expect(items.map(item => item.primary.href)).toEqual(BOT_DEFAULTS_TABS.map(tab => botDefaultsHref({ tab })));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(createElement(BotDefaultsTabs, { active: 'common', onChange: () => {} })); });
    const rendered = renderer.root.findAll(node => node.type === 'button' && node.props.role === 'tab')
      .map(node => node.children.join(''));
    act(() => renderer.unmount());
    expect(items.map(item => item.title)).toEqual(rendered.map(label => expect.stringContaining(label)));
    for (const tab of BOT_DEFAULTS_TABS) {
      expect(en(BOT_DEFAULTS_TAB_LABEL_KEYS[tab])).not.toBe(BOT_DEFAULTS_TAB_LABEL_KEYS[tab]);
    }
  });

  // 源码结构护栏(K4)：设置页的区块是 SettingsBody 内部的 JSX（组件不导出、依赖整套设置数据），
  // import 不出来，只能读文本反查；守的是「设置页新加区块却没进 ⌘K 索引 / 没给深链可用的 id」。
  it('every settings block has an id and is in the ⌘K settings index', () => {
    const source = readFileSync(new URL('../src/dashboard/web/settings-page.tsx', import.meta.url), 'utf8');
    const blocks = [...source.matchAll(/<SettingsBlock\b([\s\S]*?)\btitle=/g)].map(match => match[1]!);
    expect(blocks.length).toBeGreaterThan(10);
    const ids = blocks.map(attrs => /\bid="([^"]+)"/.exec(attrs)?.[1] ?? null);
    expect(ids.filter(id => id === null), 'SettingsBlock without an id').toEqual([]);
    const indexed = new Set(SETTINGS_SEARCH_INDEX.map(entry => entry.id));
    expect(ids.filter(id => !indexed.has(id!)), 'settings blocks missing from the index').toEqual([]);
  });
});

describe('⌘K reaches the Bot config page, its categories and each bot', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const indexItems = (): PaletteItem[] => [
    ...buildPageItems(['bot-defaults', 'settings', 'agents', 'sessions'].map(navPage)),
    ...buildBotDefaultsTabItems(),
    ...buildBotItems([
      { larkAppId: 'cli_dev123', name: '开发助手' },
      { larkAppId: 'cli_unnamed9', name: 'cli_unnamed9' },
    ]),
    ...buildSessionItems([
      { sessionId: 's1', status: 'working', title: '修登录页', larkAppId: 'cli_dev123', botName: 'cli_dev123', lastMessageAt: Date.now() },
      { sessionId: 's2', status: 'idle', title: '整理文档', larkAppId: 'cli_dev123', botName: 'cli_dev123', lastMessageAt: Date.now() - 1_000 },
    ]),
  ];

  for (const locale of ['zh', 'en'] as const) {
    it(`finds the page, its categories and bots with ${locale} UI`, () => {
      vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => {} } });
      vi.stubGlobal('document', { documentElement: {} });
      ui.setLocale(locale);
      try {
        const tr = createDashboardTranslator(locale);
        const items = indexItems();
        for (const query of ['Bot 配置', 'bot 配置', '机器人配置', 'Bot Config', 'bot settings']) {
          expect(topItem(items, query)?.key, query).toBe('page:bot-defaults');
        }
        // 搜「Bot 配置」时五个分类也在结果里。
        const settingRows = searchPalette({ items, query: tr('nav.botDefaults'), scope: 'setting' }).rows;
        expect(settingRows.filter(row => row.type === 'item' && row.item.key.startsWith('setting:bot-defaults:'))).toHaveLength(BOT_DEFAULTS_TABS.length);
        // 分类名直达那个分类。
        const security = topItem(items, tr('botDefaults.tabSecurity'));
        expect(security?.primary.href).toBe('#/bot-defaults?tab=security');
        // bot 名 / app id 直达那个 bot 的配置，排在带同一 app id 的会话前面。
        expect(topItem(items, '开发助手')?.primary.href).toBe('#/bot-defaults?bot=cli_dev123');
        expect(topItem(items, 'cli_dev123')?.primary.href).toBe('#/bot-defaults?bot=cli_dev123');
        expect(topItem(items, 'cli_unnamed9')?.primary.href).toBe('#/bot-defaults?bot=cli_unnamed9');
      } finally {
        ui.setLocale('zh');
      }
    });
  }

  it('lists registry bots that have no friendly name yet, under their app id', async () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => {} } });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        bots: [{ larkAppId: 'cli_named', botName: '有名字的 Bot' }, { larkAppId: 'cli_raw', botName: 'cli_raw' }],
        chats: [],
      }),
    })));
    await loadNameMaps();
    expect(knownBots()).toEqual(expect.arrayContaining([
      { larkAppId: 'cli_named', name: '有名字的 Bot' },
      { larkAppId: 'cli_raw', name: 'cli_raw' },
    ]));
  });

  describe('sub-pages and categories do not push the main pages off the top', () => {
    const allItems = (): PaletteItem[] => [
      ...buildPageItems([...NAV_ITEMS.map(item => navPage(item.id)), ...subPages()]),
      ...buildBotDefaultsTabItems(),
      ...buildSettingItems(),
    ];
    const subKeys = new Set([
      ...NAV_SUBPAGES.map(sub => `page:${sub.id}`),
      ...BOT_DEFAULTS_TABS.map(tab => `setting:bot-defaults:${tab}`),
    ]);
    const shortLabelKeys = [...NAV_SUBPAGES.map(sub => sub.labelKey), ...BOT_DEFAULTS_TABS.map(tab => BOT_DEFAULTS_TAB_LABEL_KEYS[tab])];
    const order = (items: PaletteItem[], query: string): string[] =>
      searchPalette({ items, query, scope: 'all' }).rows.flatMap(row => (row.type === 'item' ? [row.item.key] : []));
    const expectAheadOfSubItems = (items: PaletteItem[], query: string, pageId: string) => {
      const keys = order(items, query);
      const mine = keys.indexOf(`page:${pageId}`);
      expect(mine, `${query}: page:${pageId} missing`).toBeGreaterThanOrEqual(0);
      const firstSub = keys.findIndex(key => subKeys.has(key));
      if (firstSub >= 0) expect(mine, `${query}: ${keys[firstSub]} ranks above page:${pageId}`).toBeLessThan(firstSub);
    };

    for (const locale of ['zh', 'en'] as const) {
      it(`keeps each main page ahead when searching its own id or name (${locale} UI)`, () => {
        vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => {} } });
        vi.stubGlobal('document', { documentElement: {} });
        ui.setLocale(locale);
        try {
          const items = allItems();
          for (const item of NAV_ITEMS) {
            const names = item.labelKey ? [zh(item.labelKey), en(item.labelKey)] : [navLabel(item)];
            for (const query of [item.id, ...names]) expectAheadOfSubItems(items, query, item.id);
          }
          // 子页面 / 分类的短名恰好是某个主页面名字的开头（「会话」之于「会话控制」）时，主页面在前。
          let prefixPairs = 0;
          for (const short of shortLabelKeys.flatMap(key => [zh(key), en(key)])) {
            for (const item of NAV_ITEMS.filter(entry => entry.labelKey)) {
              if (![zh(item.labelKey!), en(item.labelKey!)].some(name => name.toLowerCase().startsWith(short.toLowerCase()))) continue;
              prefixPairs++;
              expectAheadOfSubItems(items, short, item.id);
            }
          }
          expect(prefixPairs).toBeGreaterThan(0);
          // 「设置」的首个页面是全局设置，不是经由别名命中的 Bot 配置。
          expect(order(items, '设置').find(key => key.startsWith('page:'))).toBe('page:settings');
        } finally {
          ui.setLocale('zh');
        }
      });
    }
  });

  it('builds and parses Bot config deep links', () => {
    expect(botDefaultsHref()).toBe('#/bot-defaults');
    expect(botDefaultsHref({ bot: 'cli_a', tab: 'cards' })).toBe('#/bot-defaults?bot=cli_a&tab=cards');
    expect(parseBotDefaultsTab('security')).toBe('security');
    expect(parseBotDefaultsTab('bogus')).toBeNull();
    expect(parseBotDefaultsTab(null)).toBeNull();
  });
});
