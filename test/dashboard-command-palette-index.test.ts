/**
 * ⌘K 索引的覆盖面与 Bot 配置相关的可达性：
 *
 *   - 覆盖：路由表里的每个页面要么在侧边栏 / 索引子页面里，要么写明理由排除；设置页的每个区块、
 *     Bot 配置页的每个分类和每个区块、数据洞察的每个 tab 都进索引——新加页面或分区忘了登记就红。
 *   - 可达：「Bot 配置」「机器人配置」「bot settings」直达 Bot 配置页，分类、区块、配置项（「普通群」）
 *     可直达定位，按 bot 名或 app id 直达那个 bot 的配置；中英两种界面都要成立。
 *   - 不抢：新收录的子页面 / 分类不能把主页面挤下首条（「会话」「sessions」「设置」这类高频短词）。
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { searchPalette, type PaletteItem } from '../src/dashboard/web/command-palette-model.js';
import {
  SETTINGS_SEARCH_INDEX,
  buildActionItems,
  buildBotDefaultsSectionItems,
  buildBotDefaultsTabItems,
  buildBotItems,
  buildPageItems,
  buildSessionItems,
  buildSettingItems,
  type PalettePageEntry,
} from '../src/dashboard/web/command-palette-sources.js';
import {
  BOT_DEFAULTS_SECTIONS,
  BOT_DEFAULTS_TABS,
  BOT_DEFAULTS_TAB_LABEL_KEYS,
  botDefaultsHref,
  botDefaultsSectionDomId,
  findBotDefaultsSection,
  parseBotDefaultsTab,
} from '../src/dashboard/web/bot-defaults.js';
import { BotAgentSection, BotDefaultsTabs, readBotDefaultsDeepLink, resolveBotDefaultsTarget } from '../src/dashboard/web/bot-defaults-page.js';
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

  const botDefaultsPageSource = () => readFileSync(new URL('../src/dashboard/web/bot-defaults-page.tsx', import.meta.url), 'utf8');

  // 源码结构护栏(K4)：分类网格是 BotDefaultsEditor 内部的 JSX（依赖整套 bot 数据与接口），渲染不出来，
  // 只能读文本反查；守的是「某个分类里新加了格子却没登记进 BOT_DEFAULTS_SECTIONS / 没挂深链落点 id」。
  it('every tile in the Bot config category panels carries a registered section id of that category', () => {
    const source = botDefaultsPageSource();
    const starts = BOT_DEFAULTS_TABS.map(tab => ({ tab, at: source.indexOf(`id="bd-panel-${tab}"`) }));
    expect(starts.every(entry => entry.at > 0)).toBe(true);
    const tiles: string[] = [];
    starts.forEach(({ tab, at }, index) => {
      const end = starts[index + 1]?.at ?? source.indexOf('</article>', at);
      const panel = source.slice(at, end);
      const found = [...panel.matchAll(/<section className="bd-tile[^"]*"([^>]*)>/g)].map(match => /botDefaultsSectionDomId\('([^']+)'\)/.exec(match[1]!)?.[1] ?? '(no id)');
      expect(found.length, tab).toBeGreaterThan(0);
      tiles.push(...found.map(id => `${tab}:${id}`));
    });
    const registered = BOT_DEFAULTS_SECTIONS.filter(section => !section.tile).map(section => `${section.tab}:${section.id}`);
    expect([...tiles].sort()).toEqual([...registered].sort());
    // 合放在别的格子里的区块：那个格子得存在、同分类，而且自己不是合放的。
    for (const section of BOT_DEFAULTS_SECTIONS.filter(entry => entry.tile)) {
      const host = findBotDefaultsSection(section.tile);
      expect(host?.tab, section.id).toBe(section.tab);
      expect(host?.tile, section.id).toBeUndefined();
    }
    expect(new Set(BOT_DEFAULTS_SECTIONS.map(section => section.id)).size).toBe(BOT_DEFAULTS_SECTIONS.length);
  });

  // 源码结构护栏(K4)：区块标题写在各区块组件内部，组件依赖整套 bot 数据渲染不出来，只能读文本反查；
  // 守的是「新加区块组件却没登记」以及「区块标题写死中文、英文界面搜不到」。
  it('every Bot config section heading uses a translation key that is in the section index', () => {
    const titleKeys = new Set(BOT_DEFAULTS_SECTIONS.map(section => section.titleKey));
    const headings: string[] = [];
    for (const file of ['bot-defaults-page.tsx', 'blocked-users-editor.tsx']) {
      const source = readFileSync(new URL(`../src/dashboard/web/${file}`, import.meta.url), 'utf8');
      // 区块标题是 `<h3 className="bd-section-title">` 或不带属性的 `<h3>`；弹窗里的 h3 带自己的 id / class，不算。
      headings.push(...[...source.matchAll(/<h3(?: className="bd-section-title")?>([\s\S]*?)<\/h3>/g)].map(match => match[1]!));
    }
    expect(headings.length).toBeGreaterThanOrEqual(BOT_DEFAULTS_SECTIONS.length);
    const keys = headings.map(body => /\btr\('([^']+)'\)/.exec(body.replace(/help=\{[^}]*\}/g, ''))?.[1] ?? `(literal) ${body.trim()}`);
    expect(keys.filter(key => !titleKeys.has(key)), 'section headings missing from BOT_DEFAULTS_SECTIONS').toEqual([]);
  });

  // 源码结构护栏(K4)：配置项行在各区块组件内部渲染，组件依赖整套 bot 数据渲染不出来，只能读文本反查；
  // 守的是「登记的配置项键拼错 / 已删 / 不是看得见的标签」——那样落地时按文字找不到那一行。
  it('every indexed Bot config title and option exists in both locales and is rendered as a label', () => {
    const sources = ['bot-defaults-page.tsx', 'blocked-users-editor.tsx', 'session-env-editor.tsx']
      .map(file => readFileSync(new URL(`../src/dashboard/web/${file}`, import.meta.url), 'utf8')).join('\n');
    for (const section of BOT_DEFAULTS_SECTIONS) {
      for (const key of [section.titleKey, ...(section.fieldKeys ?? [])]) {
        expect(zh(key), key).not.toBe(key);
        expect(en(key), key).not.toBe(key);
      }
      for (const key of section.fieldKeys ?? []) {
        // 落地时按文字找这一行，所以它得是看得见的标签：配置项标题、选项组名或开关行标题。
        const asLabel = [`{tr('${key}')}</FieldTitle>`, `groupName={tr('${key}')}`, `title={tr('${key}')}`].some(form => sources.includes(form));
        expect(asLabel, key).toBe(true);
      }
    }
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
    it.each([
      { cliId: 'dsh', field: 'botDefaults.agentTurnTimeout' },
      { cliId: 'minimax', field: 'botDefaults.minimaxTurnBudget' },
    ])(`finds the rendered $cliId budget field and preserves its deep link (${locale} UI)`, async ({ cliId, field }) => {
      vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => {} } });
      vi.stubGlobal('document', { documentElement: {}, addEventListener: () => {}, removeEventListener: () => {} });
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ models: [], profiles: [] }),
      })));
      ui.setLocale(locale);
      let renderer: TestRenderer.ReactTestRenderer | undefined;
      try {
        await act(async () => {
          renderer = TestRenderer.create(createElement(BotAgentSection, {
            bot: { larkAppId: 'cli_budget_search', cliId, agentSelectionKey: cliId },
            sessionFallback: cliId,
            cliState: { options: [{ id: cliId, label: cliId }], ttadkModelDefault: '', ttadkModelSuggestions: [] },
            patchBot: () => {},
          }));
        });
        const label = renderer!.root.findByProps({ 'data-input': 'agentTurnTimeout' }).parent!
          .findByProps({ className: 'bd-field-title-text' }).children.join('');
        expect(label).toBe(createDashboardTranslator(locale)(field));
        const items = buildBotDefaultsSectionItems();
        const href = botDefaultsHref({ section: 'agent', field });
        for (const query of [label, zh(field), en(field)]) {
          expect(topItem(items, query)?.primary.href, query).toBe(href);
        }
        vi.stubGlobal('location', { hash: href });
        expect(readBotDefaultsDeepLink()).toEqual({ tab: 'common', section: findBotDefaultsSection('agent'), field });
      } finally {
        if (renderer) act(() => renderer!.unmount());
        ui.setLocale('zh');
      }
    });

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

  describe('sub-pages, categories, sections and options do not push the main pages off the top', () => {
    const allItems = (): PaletteItem[] => [
      ...buildPageItems([...NAV_ITEMS.map(item => navPage(item.id)), ...subPages()]),
      ...buildBotDefaultsTabItems(),
      ...buildBotDefaultsSectionItems(),
      ...buildSettingItems(),
    ];
    const subPageKeys = new Set(NAV_SUBPAGES.map(sub => `page:${sub.id}`));
    const isSubItem = (key: string) => subPageKeys.has(key) || /^setting:bot-defaults(-section|-field)?:/.test(key);
    const shortLabelKeys = [
      ...NAV_SUBPAGES.map(sub => sub.labelKey),
      ...BOT_DEFAULTS_TABS.map(tab => BOT_DEFAULTS_TAB_LABEL_KEYS[tab]),
      ...BOT_DEFAULTS_SECTIONS.flatMap(section => [section.titleKey, ...(section.fieldKeys ?? [])]),
    ];
    const order = (items: PaletteItem[], query: string): string[] =>
      searchPalette({ items, query, scope: 'all' }).rows.flatMap(row => (row.type === 'item' ? [row.item.key] : []));
    const expectAheadOfSubItems = (items: PaletteItem[], query: string, pageId: string) => {
      const keys = order(items, query);
      const mine = keys.indexOf(`page:${pageId}`);
      expect(mine, `${query}: page:${pageId} missing`).toBeGreaterThanOrEqual(0);
      const firstSub = keys.findIndex(isSubItem);
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
            for (const query of [item.id, ...names, ...(item.aliases ?? [])]) expectAheadOfSubItems(items, query, item.id);
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

  for (const locale of ['zh', 'en'] as const) {
    it(`finds Bot config sections and options, in either language (${locale} UI)`, () => {
      vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => {} } });
      vi.stubGlobal('document', { documentElement: {} });
      ui.setLocale(locale);
      try {
        const tr = createDashboardTranslator(locale);
        const other = locale === 'zh' ? en : zh;
        const items = [...buildBotDefaultsTabItems(), ...buildBotDefaultsSectionItems(), ...buildSettingItems()];
        const topSetting = (query: string) => {
          const row = searchPalette({ items, query, scope: 'setting' }).rows[0];
          return row?.type === 'item' ? row.item : undefined;
        };
        // 「普通群」这类区块里的配置项：直达那一行，界面语言和另一种语言的叫法都行。
        const regularHref = botDefaultsHref({ section: 'session-mode', field: 'botDefaults.groupRegular' });
        expect(topSetting(tr('botDefaults.groupRegular'))?.primary.href).toBe(regularHref);
        expect(topSetting(other('botDefaults.groupRegular'))?.primary.href).toBe(regularHref);
        // 区块标题直达区块；合放在别的格子里的区块也有自己的条目。
        expect(topSetting(tr('botDefaults.sectionSessionMode'))?.primary.href).toBe(botDefaultsHref({ section: 'session-mode' }));
        expect(topSetting(tr('botDefaults.networkPolicy'))?.primary.href).toBe(botDefaultsHref({ section: 'network-policy' }));
        // 每个区块都有条目，标题带「Bot 配置 ›」。
        for (const section of BOT_DEFAULTS_SECTIONS) {
          const item = items.find(entry => entry.key === `setting:bot-defaults-section:${section.id}`);
          expect(item?.title, section.id).toBe(`${tr('nav.botDefaults')} › ${tr(section.titleKey)}`);
        }
      } finally {
        ui.setLocale('zh');
      }
    });
  }

  describe('with the full ⌘K item set', () => {
    // 面板里真实组装的条目：快捷操作、页面（含子页面）、Bot 配置的分类 / 区块 / 配置项、全局设置、bot。
    const fullItems = (): PaletteItem[] => [
      ...buildActionItems({ openCreateSession: () => {}, openCreateBot: () => {} }),
      ...buildSettingItems(),
      ...buildBotDefaultsTabItems(),
      ...buildBotDefaultsSectionItems(),
      ...buildBotItems([{ larkAppId: 'cli_dev123', name: '开发助手' }]),
      ...buildPageItems([...NAV_ITEMS.map(item => navPage(item.id)), ...subPages()]),
    ];
    const visible = (items: PaletteItem[], query: string) =>
      searchPalette({ items, query, scope: 'all' }).rows.flatMap(row => (row.type === 'item' ? [row.item] : []));

    for (const locale of ['zh', 'en'] as const) {
      it(`keeps the categories, and quick actions, ahead of the sections and options under them (${locale} UI)`, () => {
        vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => {} } });
        vi.stubGlobal('document', { documentElement: {} });
        ui.setLocale(locale);
        try {
          const items = fullItems();
          // 搜页面自己的名字（两种语言）：五个分类都在「全部」的首屏里，不被区块 / 配置项挤掉。
          for (const query of [zh('nav.botDefaults'), en('nav.botDefaults')]) {
            const keys = visible(items, query).map(item => item.key);
            expect(keys[0], query).toBe('page:bot-defaults');
            for (const tab of BOT_DEFAULTS_TABS) expect(keys, `${query}: ${tab}`).toContain(`setting:bot-defaults:${tab}`);
          }
          // 搜分类名：排在最前的 Bot 配置条目是分类本身，不是它下面的区块。
          for (const tab of BOT_DEFAULTS_TABS) {
            for (const query of [zh(BOT_DEFAULTS_TAB_LABEL_KEYS[tab]), en(BOT_DEFAULTS_TAB_LABEL_KEYS[tab])]) {
              const first = visible(items, query).find(item => item.key.startsWith('setting:bot-defaults'));
              expect(first?.key, query).toBe(`setting:bot-defaults:${tab}`);
            }
          }
          // 全局设置页的英文名：中文界面里它只能靠关键词命中，也得排第一——十几个设置区块的关键词里
          // 都挂着同一个「Global Settings」，整句全等规则若对它们也生效，就会和页面打平、把页面挤下去。
          expect(visible(items, en('nav.settings'))[0]?.key).toBe('page:settings');
          // 快捷操作的多词别名整句打全（「new bot」「new session」）：快捷操作排第一。
          for (const action of items.filter(item => item.kind === 'action')) {
            for (const phrase of (action.keywords ?? []).filter(keyword => /\s/.test(keyword))) {
              expect(visible(items, phrase)[0]?.key, phrase).toBe(action.key);
            }
          }
        } finally {
          ui.setLocale('zh');
        }
      });
    }
  });

  describe('Bot config deep-link landing', () => {
    // 极简 DOM：落点解析只用 getElementById / querySelectorAll / closest / textContent。
    class FakeEl {
      parent: FakeEl | null = null;
      children: FakeEl[] = [];
      constructor(readonly tag: string, readonly classes: string[] = [], readonly text = '', readonly id = '') {}
      add(...kids: FakeEl[]): this { for (const kid of kids) { kid.parent = this; this.children.push(kid); } return this; }
      get textContent(): string { return this.text + this.children.map(kid => kid.textContent).join(''); }
      matches(selector: string): boolean {
        return selector.split(',').map(part => part.trim()).some(part => (part.startsWith('.') ? this.classes.includes(part.slice(1)) : this.tag === part));
      }
      querySelectorAll(selector: string): FakeEl[] {
        return this.children.flatMap(kid => [...(kid.matches(selector) ? [kid] : []), ...kid.querySelectorAll(selector)]);
      }
      closest(selector: string): FakeEl | null {
        for (let el: FakeEl | null = this; el; el = el.parent) if (el.matches(selector)) return el;
        return null;
      }
      find(id: string): FakeEl | null {
        if (this.id === id) return this;
        for (const kid of this.children) { const hit = kid.find(id); if (hit) return hit; }
        return null;
      }
    }
    const doc = (root: FakeEl) => ({ getElementById: (id: string) => root.find(id) }) as unknown as Pick<Document, 'getElementById'>;
    const section = (id: string) => findBotDefaultsSection(id)!;
    const titleOf = (key: string) => new FakeEl('span', ['bd-field-title-text'], zh(key));

    it('lands on the option row inside its section', () => {
      const row = new FakeEl('div', ['bd-mode-group']).add(new FakeEl('h4', ['bd-mode-group-title'], zh('botDefaults.groupRegular')));
      const root = new FakeEl('main').add(
        new FakeEl('button', [], '', 'bd-tab-sessions'),
        new FakeEl('section', ['bd-tile'], '', botDefaultsSectionDomId('session-mode')).add(new FakeEl('section', ['bd-section']).add(row)),
      );
      const result = resolveBotDefaultsTarget({ tab: 'sessions', section: section('session-mode'), field: 'botDefaults.groupRegular' }, doc(root), zh);
      expect(result).toEqual({ target: row, block: 'center', missing: null });
    });

    it('stops at the section and names the option when this bot does not show it', () => {
      const tile = new FakeEl('section', ['bd-tile'], '', botDefaultsSectionDomId('agent')).add(new FakeEl('div', ['bd-field']).add(titleOf('botDefaults.agentModel')));
      const root = new FakeEl('main').add(new FakeEl('button', [], '', 'bd-tab-common'), tile);
      const result = resolveBotDefaultsTarget({ tab: 'common', section: section('agent'), field: 'botDefaults.riffJwtEnv' }, doc(root), zh);
      expect(result).toEqual({ target: tile, block: 'start', missing: zh('botDefaults.riffJwtEnv') });
    });

    it('stops at the category and names the section when this bot does not show it', () => {
      const tabButton = new FakeEl('button', [], '', 'bd-tab-security');
      const root = new FakeEl('main').add(tabButton);
      const result = resolveBotDefaultsTarget({ tab: 'security', section: section('codex-auth'), field: null }, doc(root), zh);
      expect(result).toEqual({ target: tabButton, block: 'center', missing: zh('botDefaults.sectionCodexAuth') });
    });

    it('finds a section that shares its tile with another one by its heading', () => {
      const network = new FakeEl('section', ['bd-section']).add(new FakeEl('h3', [], zh('botDefaults.networkPolicy')));
      const root = new FakeEl('main').add(new FakeEl('section', ['bd-tile'], '', botDefaultsSectionDomId('sandbox')).add(
        new FakeEl('section', ['bd-section']).add(new FakeEl('h3', ['bd-section-title']).add(titleOf('botDefaults.sectionSandbox'))),
        network,
      ));
      const result = resolveBotDefaultsTarget({ tab: 'security', section: section('network-policy'), field: null }, doc(root), zh);
      expect(result).toEqual({ target: network, block: 'start', missing: null });
    });

    it('reads tab / section / field from the hash, deriving the category from the section', () => {
      vi.stubGlobal('location', { hash: botDefaultsHref({ section: 'session-mode', field: 'botDefaults.groupRegular' }) });
      expect(readBotDefaultsDeepLink()).toEqual({ tab: 'sessions', section: section('session-mode'), field: 'botDefaults.groupRegular' });
      vi.stubGlobal('location', { hash: botDefaultsHref({ tab: 'cards' }) });
      expect(readBotDefaultsDeepLink()).toEqual({ tab: 'cards', section: null, field: null });
      vi.stubGlobal('location', { hash: '#/bot-defaults?tab=common&section=session-mode' });
      expect(readBotDefaultsDeepLink()?.tab).toBe('sessions');
      // 不在该区块登记表里的配置项当没给：落到区块本身，不误报「当前 Bot 不显示」。
      vi.stubGlobal('location', { hash: botDefaultsHref({ section: 'agent', field: 'botDefaults.nope' }) });
      expect(readBotDefaultsDeepLink()).toEqual({ tab: 'common', section: section('agent'), field: null });
      vi.stubGlobal('location', { hash: '#/bot-defaults?section=bogus&field=x' });
      expect(readBotDefaultsDeepLink()).toBeNull();
      vi.stubGlobal('location', { hash: '#/bot-defaults' });
      expect(readBotDefaultsDeepLink()).toBeNull();
    });
  });

  it('builds and parses Bot config deep links', () => {
    expect(botDefaultsHref()).toBe('#/bot-defaults');
    expect(botDefaultsHref({ bot: 'cli_a', tab: 'cards' })).toBe('#/bot-defaults?bot=cli_a&tab=cards');
    expect(botDefaultsHref({ section: 'session-mode', field: 'botDefaults.groupRegular' })).toBe('#/bot-defaults?section=session-mode&field=botDefaults.groupRegular');
    expect(parseBotDefaultsTab('security')).toBe('security');
    expect(parseBotDefaultsTab('bogus')).toBeNull();
    expect(parseBotDefaultsTab(null)).toBeNull();
  });
});
