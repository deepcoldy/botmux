/**
 * ⌘K 命令面板列出的 Bot 配置区块 / 配置项，在当前部署对应的配置页上都有落点；配置页上渲染的
 * 区块格子也都能从命令面板搜到；条目标题就是该部署配置页上显示的标签（只有企业微信的部署用企业微信措辞）。
 * 两边读同一张 provider 能力表（providers/profile.ts），这里用真实的卡片渲染和真实的深链落点函数
 * （resolveBotDefaultsTarget）把这件事钉住。企业微信专属格子（本地核心策略、原生平台设置、本地业务设置
 * 与账本）和企业微信的会话模式另有一组用例，逐项校验落点与标题。
 */
import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOT_PROFILE_SHARED_PARTS, BotDefaultsCard, resolveBotDefaultsTarget } from '../src/dashboard/web/bot-defaults-page.js';
import { WecomBotDefaultsCard } from '../src/dashboard/web/wecom-bot-defaults-card.js';
import { buildBotDefaultsSectionItems } from '../src/dashboard/web/command-palette-sources.js';
import { searchPalette, type PaletteItem } from '../src/dashboard/web/command-palette-model.js';
import {
  BOT_DEFAULTS_SECTIONS,
  BOT_DEFAULTS_TABS,
  findBotDefaultsSection,
  type BotDefaultsSection,
  type BotDefaultsTab,
} from '../src/dashboard/web/bot-defaults.js';
import { publishProviderRoster } from '../src/dashboard/web/provider-roster.js';
import { botProfileCapabilities, botProfileSectionSupported } from '../src/dashboard/web/providers/profile.js';
import { t, ui } from '../src/dashboard/web/ui.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ENV_VIEW = { scope: 'bot', rows: [], reserved: { keys: [], prefixes: [] }, conflicts: [], redactedHostKeys: [], inherit: { mode: 'inherit' }, sessions: [], canReveal: false, overlayApplies: true };
const cliState = { options: [{ id: 'codex', label: 'Codex' }, { id: 'claude-code', label: 'Claude Code' }, { id: 'codex-app', label: 'Codex App' }], ttadkModelDefault: '', ttadkModelSuggestions: [] } as any;

/** 命令面板会单独列出配置项、且平台能力表对其收窄的区块：逐项校验落点。 */
const FIELD_CHECKED_SECTIONS = new Set(['card-behavior', 'slash-commands', 'sender-tag', 'role']);

function textOf(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(child => textOf(child as ReactTestInstance | string)).join('');
}

function matches(node: ReactTestInstance, selector: string): boolean {
  if (typeof node.type !== 'string') return false;
  if (selector.startsWith('.')) return String(node.props.className ?? '').split(/\s+/).includes(selector.slice(1));
  return node.type === selector;
}

/** resolveBotDefaultsTarget 只用到的那几样 DOM 能力，落在测试渲染树上；`node` 是被包装的渲染节点。 */
function asElement(node: ReactTestInstance): any {
  return {
    node,
    get textContent() { return textOf(node); },
    querySelectorAll(selector: string) {
      const parts = selector.split(',').map(part => part.trim());
      return node.findAll(child => child !== node && parts.some(part => matches(child, part))).map(asElement);
    },
    closest(selector: string) {
      const parts = selector.split(',').map(part => part.trim());
      let current: ReactTestInstance | null = node;
      while (current) {
        const candidate = current;
        if (parts.some(part => matches(candidate, part))) return asElement(candidate);
        current = current.parent;
      }
      return null;
    },
  };
}

function documentOf(root: ReactTestInstance): Pick<Document, 'getElementById'> {
  return {
    getElementById: (id: string) => {
      const found = root.findAll(node => typeof node.type === 'string' && node.props.id === id);
      return found[0] ? asElement(found[0]) : null;
    },
  } as Pick<Document, 'getElementById'>;
}

function stubFetch(wecomConfig?: Record<string, unknown>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    let body: unknown = {};
    if (/\/(environment|session-env)(\?|$)/.test(url)) body = ENV_VIEW;
    else if (/\/api\/wecom\/connections\/[^/]+\/config$/.test(url)) body = wecomConfig;
    else if (url.includes('/command-triggers')) body = { enabled: false, commands: [], scope: 'all', chats: [], excludedChats: [], prompt: '' };
    else if (url.includes('/codex-profiles')) body = { status: 'empty', candidates: [] };
    return { ok: true, status: 200, json: async () => body };
  }));
}

const renderers: TestRenderer.ReactTestRenderer[] = [];
/**
 * 卸载本用例渲染过的卡片。还原语言、provider 名单这类全局 store 之前要先调：store 一变就会通知仍挂载的
 * 订阅组件，在 act 之外触发整树重渲染。
 */
async function unmountRendered(): Promise<void> {
  for (const renderer of renderers.splice(0)) await act(async () => renderer.unmount());
}
afterEach(async () => {
  await unmountRendered();
  vi.unstubAllGlobals();
});

async function renderCard(element: React.ReactElement, wecomConfig?: Record<string, unknown>): Promise<ReactTestInstance> {
  stubFetch(wecomConfig);
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => { renderer = TestRenderer.create(element); });
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  // 飞书卡的页签面板首次切到时才挂载（之后保留）：逐个切一遍，让每个分类里的格子都渲染出来。
  if (element.type === BotDefaultsCard) {
    for (const tab of BOT_DEFAULTS_TABS) {
      await act(async () => { renderer!.update(React.cloneElement(element as React.ReactElement<any>, { activeTab: tab })); });
    }
    for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
  renderers.push(renderer!);
  return renderer!.root;
}

function larkCard(bot: Record<string, unknown>): React.ReactElement {
  return React.createElement(BotDefaultsCard, {
    bot: { larkAppId: 'cli_fixture', botName: 'Fixture', online: true, ...bot } as any,
    bots: [], cliState, patchBot: () => {}, brandEnabled: true, activeTab: 'common', onTabChange: () => {},
    onLocate: () => {}, filterQuery: '', onFilterQuery: () => {}, modifiedOnly: false,
    onModifiedOnly: () => {}, onClearFilter: () => {},
  });
}

function wecomCard(): React.ReactElement {
  return React.createElement(WecomBotDefaultsCard, {
    shared: BOT_PROFILE_SHARED_PARTS,
    connection: { id: 'fixture', label: 'Fixture', botIdHint: '…fixture', allowedUserCount: 1, coreMode: 'managed', configuration: 'ready', gateway: 'running', connection: 'connected', ownership: 'fleet', canStart: false, canStop: true, canRestart: true } as any,
    cliState, activeTab: 'common', onTabChange: () => {}, onRefresh: () => {}, onAction: () => {},
  });
}

const wecomConfig = (cli: string, botConfig: Record<string, unknown>, backend = 'pty') => ({
  editable: true, revision: 'r1', displayName: 'Fixture', cli, backend, model: '', workingDirectory: '/workspace', requiresRestart: true,
  botConfig, runtime: { usageSupported: true }, allowedUsers: ['owner'], blockedUsers: [], role: { content: '', injectMode: 'once' },
  native: {}, business: {}, sessionMode: { p2pMode: 'chat', regularGroupReplyMode: 'user', regularGroupMentionMode: 'never' },
});

type Platform = 'lark' | 'wecom';
type Deployment = { name: string; provider: Platform; publish(): void; cards(): Promise<Record<Platform, ReactTestInstance[]>> };
const larkCards = async (): Promise<ReactTestInstance[]> => [
  await renderCard(larkCard({ cliId: 'codex', agentSelectionKey: 'codex', backendType: 'herdr', sandbox: true, sandboxMode: 'oncall', replyCardMode: 'legacy', usageSupported: true })),
  await renderCard(larkCard({ cliId: 'claude-code', agentSelectionKey: 'claude-code', replyCardMode: 'unified', usageSupported: true })),
  await renderCard(larkCard({ cliId: 'codex-app', agentSelectionKey: 'codex-app' })),
];
const wecomCards = async (): Promise<ReactTestInstance[]> => [
  await renderCard(wecomCard(), wecomConfig('codex', { sandbox: 'oncall', replyCardMode: 'legacy' }, 'herdr')),
  await renderCard(wecomCard(), wecomConfig('claude-code', { replyCardMode: 'unified' })),
  await renderCard(wecomCard(), wecomConfig('codex-app', {})),
];
const publishFeishuOnly = () => { publishProviderRoster('lark', 1); publishProviderRoster('wecom', 0); };
const publishMixed = () => { publishProviderRoster('lark', 1); publishProviderRoster('wecom', 2); };
const deployments: Deployment[] = [
  {
    name: 'Feishu-only',
    provider: 'lark',
    publish: publishFeishuOnly,
    cards: async () => ({ lark: await larkCards(), wecom: [] }),
  },
  {
    // 混合部署：不带 provider 的深链落在飞书机器人上，带 provider=wecom 的落在企业微信机器人上。
    name: 'Mixed',
    provider: 'lark',
    publish: publishMixed,
    cards: async () => ({ lark: await larkCards(), wecom: await wecomCards() }),
  },
  {
    name: 'WeCom-only',
    provider: 'wecom',
    publish: () => { publishProviderRoster('lark', 0); publishProviderRoster('wecom', 1); },
    cards: async () => ({ lark: [], wecom: await wecomCards() }),
  },
];

/** 条目落到哪个平台的配置卡上：深链带 provider 就是它，否则是部署按的平台。 */
function landingPlatform(item: PaletteItem, deployment: Deployment): Platform {
  const provider = new URLSearchParams(item.primary.href!.split('?')[1]).get('provider');
  return provider === 'wecom' || provider === 'lark' ? provider : deployment.provider;
}

function paletteTargets(deployment: Deployment): Array<{ section: BotDefaultsSection; field?: string; platform: Platform }> {
  return buildBotDefaultsSectionItems().map(item => {
    const params = new URLSearchParams(item.primary.href!.split('?')[1]);
    return {
      section: findBotDefaultsSection(params.get('section'))!,
      field: params.get('field') ?? undefined,
      platform: landingPlatform(item, deployment),
    };
  });
}

describe.each(deployments)('$name deployment: ⌘K Bot config index and the config page agree', deployment => {
  it('every listed section and narrowed field lands on the rendered card, and every rendered section tile is listed', async () => {
    const previous = ui.authed;
    ui.authed = true;
    try {
      deployment.publish();
      const targets = paletteTargets(deployment);
      expect(targets.length).toBeGreaterThan(0);
      const cards = await deployment.cards();

      const missing = targets
        .filter(target => !target.field || FIELD_CHECKED_SECTIONS.has(target.section.id))
        .filter(target => !cards[target.platform].some(root => {
          const link = { tab: target.section.tab, section: target.section, field: target.field };
          return resolveBotDefaultsTarget(link as any, documentOf(root), t, target.platform).missing === null;
        }))
        .map(target => `${target.platform}:${target.section.id}${target.field ? ` › ${target.field}` : ''}`);
      expect(missing, 'listed in ⌘K but not on the page').toEqual([]);

      const knownTiles = new Set(BOT_DEFAULTS_SECTIONS.map(section => section.id));
      for (const platform of ['lark', 'wecom'] as const) {
        const listedTiles = new Set(targets.filter(target => target.platform === platform).map(target => target.section.tile ?? target.section.id));
        const renderedTiles = new Set(cards[platform].flatMap(root => root.findAll(node => typeof node.type === 'string' && typeof node.props.id === 'string' && node.props.id.startsWith('bd-section-'))
          .map(node => node.props.id.slice('bd-section-'.length))));
        // 混合部署里企业微信只另列它自己的格子，共用格子由飞书条目覆盖。
        const reachable = (id: string) => listedTiles.has(id) || (platform === 'wecom' && deployment.provider === 'lark'
          && !BOT_DEFAULTS_SECTIONS.find(section => section.id === id)?.provider);
        expect([...renderedTiles].filter(id => knownTiles.has(id) && !reachable(id)), `${platform}: on the page but not listed in ⌘K`).toEqual([]);
      }
    } finally {
      await unmountRendered();
      ui.authed = previous;
      publishProviderRoster('lark', 1);
      publishProviderRoster('wecom', 0);
    }
  });

  it.each(['zh', 'en'] as const)('names every entry with the label the config page shows (%s)', async locale => {
    const previous = { authed: ui.authed, locale: ui.locale };
    ui.authed = true;
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => {} } });
    vi.stubGlobal('document', { documentElement: {}, addEventListener: () => {}, removeEventListener: () => {} });
    ui.setLocale(locale);
    try {
      deployment.publish();
      const items = buildBotDefaultsSectionItems();
      const cards = await deployment.cards();
      // 页面上「看得见的标签」：与深链落点找行时认的同一组元素（区块标题、配置项标题、选项组标题）。
      const shownLabels = (platform: Platform) => new Set(cards[platform].flatMap(root => root.findAll(node => typeof node.type === 'string'
        && ['h3', 'h4', 'label', 'span', 'strong', 'small'].includes(node.type as string))
        .map(node => textOf(node).trim())));
      const shown = { lark: shownLabels('lark'), wecom: shownLabels('wecom') };
      const misnamed = items
        .filter(item => {
          const params = new URLSearchParams(item.primary.href!.split('?')[1]);
          const section = findBotDefaultsSection(params.get('section'))!;
          const link = { tab: section.tab, section, field: params.get('field') };
          const platform = landingPlatform(item, deployment);
          // 只看能在这几张夹具卡上落点的条目：只在别的配置下才渲染的行，这几张卡上本来就找不到，这里不判断。
          return cards[platform].some(root => resolveBotDefaultsTarget(link as any, documentOf(root), t, platform).missing === null);
        })
        .filter(item => !shown[landingPlatform(item, deployment)].has(item.title.slice(item.titleContext)))
        .map(item => item.title.slice(item.titleContext));
      expect(misnamed, '⌘K titles that the page does not show').toEqual([]);
    } finally {
      await unmountRendered();
      ui.authed = previous.authed;
      ui.setLocale(previous.locale);
      publishProviderRoster('lark', 1);
      publishProviderRoster('wecom', 0);
    }
  });
});

// ── 企业微信专属格子与企业微信的会话模式 ───────────────────────────────────────

type NativeBlock = 'core' | 'platform';

/**
 * 企业微信卡上专属区块按分类的布局：本地核心策略在安全（「授权与额度」，另有合放在共用「Slash 命令」格里的
 * 「对话权限用户可用的命令」）、卡片、高级页，原生平台设置只在会话页（「/summary 总结范围」）。接入 ⌘K 不能
 * 改变它。
 */
const NATIVE_LAYOUT: Readonly<Record<NativeBlock, readonly BotDefaultsTab[]>> = {
  core: ['security', 'security', 'cards', 'advanced'],
  platform: ['sessions'],
};

/** 各专属区块组件给自己挂的无障碍名称：用它在页面上认出专属区块，与格子 id、登记表都无关。 */
const NATIVE_ARIA_KEYS: Readonly<Record<NativeBlock, string>> = {
  core: 'botDefaults.wecom.core.aria',
  platform: 'botDefaults.wecom.platform.aria',
};

/** 专属区块里看得见、却故意不进 ⌘K 的标签：[区块所在格子的区块 id, 标签键, 理由]。 */
const NATIVE_LABELS_NOT_LISTED: ReadonlyArray<readonly [string, string, string]> = [];

type NativeElement = { block: NativeBlock; tab: BotDefaultsTab; node: ReactTestInstance };

function hasClass(node: ReactTestInstance, name: string): boolean {
  return String(node.props.className ?? '').split(/\s+/).includes(name);
}

function contains(outer: ReactTestInstance, inner: ReactTestInstance): boolean {
  return outer === inner || outer.findAll(node => node === inner).length > 0;
}

/** 企业微信卡上带专属区块无障碍名称的元素，连同它所在的分类面板。 */
function nativeElements(root: ReactTestInstance): NativeElement[] {
  const found: NativeElement[] = [];
  for (const tab of BOT_DEFAULTS_TABS) {
    const panel = root.find(node => node.type === 'div' && node.props.id === `bd-panel-${tab}`);
    for (const block of Object.keys(NATIVE_ARIA_KEYS) as NativeBlock[]) {
      const label = t(NATIVE_ARIA_KEYS[block]);
      for (const node of panel.findAll(child => child.type === 'section' && child.props['aria-label'] === label)) {
        found.push({ block, tab, node });
      }
    }
  }
  return found;
}

/** 元素所在的格子：最近的 section.bd-tile（可以是它自己）。 */
function tileOf(node: ReactTestInstance): ReactTestInstance {
  let current: ReactTestInstance | null = node;
  while (current && !(current.type === 'section' && hasClass(current, 'bd-tile'))) current = current.parent;
  if (!current) throw new Error('element is not inside a tile');
  return current;
}

function tileSectionId(tile: ReactTestInstance): string | null {
  const id = tile.props.id;
  return typeof id === 'string' && id.startsWith('bd-section-') ? id.slice('bd-section-'.length) : null;
}

/**
 * 卡上企业微信专属区块的登记：整格都是专属的格子（连同合放在里面的区块），以及合放在共用格子里的专属区块
 * （按它的标题认）。
 */
function nativeSectionIds(root: ReactTestInstance): Set<string> {
  const ids = new Set<string>();
  const elements = nativeElements(root);
  const ownTiles = new Set(elements.filter(element => tileOf(element.node) === element.node).map(element => tileSectionId(element.node)));
  for (const section of BOT_DEFAULTS_SECTIONS) if (ownTiles.has(section.tile ?? section.id)) ids.add(section.id);
  for (const element of elements.filter(element => tileOf(element.node) !== element.node)) {
    const tileId = tileSectionId(tileOf(element.node));
    const heading = textOf(element.node.findAll(node => node.type === 'h3')[0]!).trim();
    const hosted = BOT_DEFAULTS_SECTIONS.find(section => section.tile === tileId && t(section.titleKey) === heading);
    if (hosted) ids.add(hosted.id);
  }
  return ids;
}

/** 条目深链指向的区块与配置项。 */
function linkOf(item: PaletteItem): { section: BotDefaultsSection; field: string | null } {
  const params = new URLSearchParams(item.primary.href!.split('?')[1]);
  return { section: findBotDefaultsSection(params.get('section'))!, field: params.get('field') };
}

function landOnWecomCard(item: PaletteItem, root: ReactTestInstance) {
  const { section, field } = linkOf(item);
  return resolveBotDefaultsTarget({ tab: section.tab, section, field }, documentOf(root), t, 'wecom');
}

const ownTitle = (item: PaletteItem): string => item.title.slice(item.titleContext);

/** 落点自己或它里面有没有一个看得见的标签恰好是 label（与落点按文字找行时认的同一组元素）。 */
function showsLabel(target: any, label: string): boolean {
  return [target, ...target.querySelectorAll('h3, h4, label, span, strong, small')]
    .some((element: any) => element.textContent.trim() === label);
}

/**
 * 专属格子里的可见标签：开关行、输入行与下拉框的标题、区块与小组标题
 * （NativeToggle / NativeField / NativeSelect / NativeGroup / NativeSubgroup）。
 */
function nativeTileLabels(tile: ReactTestInstance): string[] {
  // 开关行的标题在 <strong> 里；下面的 <small> 是说明，不是标签。
  const toggles = tile.findAll(node => node.type === 'label' && hasClass(node, 'toggle-row'))
    .map(node => textOf(node.findAll(child => child.type === 'strong')[0] ?? node));
  const fields = tile.findAll(node => typeof node.type === 'string' && hasClass(node, 'bd-field'))
    .map(node => textOf(node.findAll(child => child.type === 'span')[0]!));
  const groups = tile.findAll(node => node.type === 'h3' || (node.type === 'h4' && hasClass(node, 'bd-subsection-title')))
    .map(node => textOf(node));
  return [...toggles, ...fields, ...groups].map(label => label.trim());
}

const publishWecomOnly = () => { publishProviderRoster('lark', 0); publishProviderRoster('wecom', 1); };

/** 条目深链上的 provider 参数（没有时为 null）。 */
function linkProvider(item: PaletteItem): string | null {
  return new URLSearchParams(item.primary.href!.split('?')[1]).get('provider');
}

async function withLocale(locale: 'zh' | 'en', run: () => Promise<void>): Promise<void> {
  const previous = { authed: ui.authed, locale: ui.locale };
  ui.authed = true;
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => {} } });
  vi.stubGlobal('document', { documentElement: {}, addEventListener: () => {}, removeEventListener: () => {} });
  ui.setLocale(locale);
  try {
    await run();
  } finally {
    await unmountRendered();
    ui.authed = previous.authed;
    ui.setLocale(previous.locale);
    publishProviderRoster('lark', 1);
    publishProviderRoster('wecom', 0);
  }
}

/**
 * 有企业微信机器人的两种部署形态，以及其中落到企业微信机器人上的条目：只有企业微信时是全部条目，
 * 混合部署里是深链带 provider=wecom 的那些。
 */
const wecomDeployments = [
  { name: 'WeCom-only', publish: publishWecomOnly, wecomItems: (items: PaletteItem[]) => items },
  { name: 'Mixed', publish: publishMixed, wecomItems: (items: PaletteItem[]) => items.filter(item => linkProvider(item) === 'wecom') },
];

describe.each(wecomDeployments)('$name deployment: WeCom-specific tiles and the WeCom session mode in ⌘K', deployment => {
  it.each(['zh', 'en'] as const)('lists every WeCom-specific tile of the editable card and lands each entry on it with the label it shows (%s)', locale => withLocale(locale, async () => {
    deployment.publish();
    const all = buildBotDefaultsSectionItems();
    const items = deployment.wecomItems(all);
    const root = await renderCard(wecomCard(), wecomConfig('codex', {}));
    const elements = nativeElements(root);
    const layout = (Object.keys(NATIVE_LAYOUT) as NativeBlock[]).flatMap(block => NATIVE_LAYOUT[block].map(tab => `${tab}:${block}`));
    expect(elements.map(element => `${element.tab}:${element.block}`).sort()).toEqual(layout.sort());

    // 每一块都有自己的区块条目：标题就是它的小标题，深链落在它所在的格子上、并且停在它自己那一段；
    // 按这一块的无障碍名称（各分类共用的「本地核心策略」这类叫法）在全部条目里也搜得到它。
    const nativeSections = new Set<string>();
    for (const element of elements) {
      const name = `${element.tab}:${element.block}`;
      const tile = tileOf(element.node);
      const heading = element.node.findAll(node => node.type === 'h3')[0]!;
      const entry = items.find(item => item.key.startsWith('setting:bot-defaults-section:') && ownTitle(item) === textOf(heading).trim());
      expect(entry, `${name}: no section entry titled with its heading`).toBeDefined();
      const { section } = linkOf(entry!);
      expect(section.tile ?? section.id, `${name}: lands on another tile`).toBe(tileSectionId(tile));
      const landed = landOnWecomCard(entry!, root);
      expect(landed.missing, name).toBeNull();
      expect(contains(tile, landed.target.node) && contains(landed.target.node, heading), `${name}: landing spot`).toBe(true);
      const byName = searchPalette({ items: all, query: String(element.node.props['aria-label']), scope: 'setting' }).rows
        .flatMap(row => (row.type === 'item' ? [row.item.key] : []));
      expect(byName, `${name}: not found by its accessible name`).toContain(entry!.key);
      nativeSections.add(section.id);
    }

    // 这些区块下的配置项条目：都落得到，落点上的标签就是条目标题。
    const fieldItems = items.filter(item => item.key.startsWith('setting:bot-defaults-field:') && nativeSections.has(linkOf(item).section.id));
    expect(fieldItems.length).toBeGreaterThan(0);
    const misplaced = fieldItems.filter(item => {
      const landed = landOnWecomCard(item, root);
      return landed.missing !== null || !showsLabel(landed.target, ownTitle(item));
    });
    expect(misplaced.map(item => item.key), 'field entries that miss their row').toEqual([]);
  }));

  it.each(['zh', 'en'] as const)('lists every label the WeCom-specific blocks show, apart from the ones left out on purpose (%s)', locale => withLocale(locale, async () => {
    deployment.publish();
    const items = deployment.wecomItems(buildBotDefaultsSectionItems());
    const root = await renderCard(wecomCard(), wecomConfig('codex', {}));
    const notListed = NATIVE_LABELS_NOT_LISTED.map(([tileId, key]) => [tileId, t(key)] as const);
    // 每个专属区块里看得见的标签（合放在共用格子里的专属区块只看它自己那一段，不看共用区块的标签）。
    for (const element of nativeElements(root)) {
      const tileId = tileSectionId(tileOf(element.node))!;
      const listed = new Set(items.filter(item => {
        const { section } = linkOf(item);
        return (section.tile ?? section.id) === tileId;
      }).map(ownTitle));
      const shown = nativeTileLabels(element.node);
      const leftOut = notListed.filter(([id]) => id === tileId).map(([, label]) => label);
      expect(shown.filter(label => !listed.has(label) && !leftOut.includes(label)), `${tileId}: shown but not in ⌘K`).toEqual([]);
      // 名单不留静默豁免：豁免的标签确实显示在这一格、也确实没进 ⌘K。
      for (const label of leftOut) {
        expect(shown, `${tileId}: ${label}`).toContain(label);
        expect(listed.has(label), `${tileId}: ${label}`).toBe(false);
      }
    }
  }));

  it.each(['zh', 'en'] as const)('lists every titled control of the WeCom session-mode form, and lands on it (%s)', locale => withLocale(locale, async () => {
    deployment.publish();
    const items = deployment.wecomItems(buildBotDefaultsSectionItems());
    const root = await renderCard(wecomCard(), wecomConfig('codex', {}));
    const tile = root.find(node => node.type === 'section' && node.props.id === 'bd-section-session-mode');
    // 企业微信会话模式表单上看得见的标题：私聊选项组的组标题、群会话方式下拉框的标题。
    const titles = tile.findAll(node => (node.type === 'h4' && hasClass(node, 'bd-mode-group-title'))
      || (node.type === 'span' && hasClass(node, 'bd-field-title-text'))).map(node => textOf(node).trim());
    expect(titles.length).toBeGreaterThan(0);
    const entries = items.filter(item => item.key.startsWith('setting:bot-defaults-field:session-mode:'));
    expect(entries.map(ownTitle).sort()).toEqual([...titles].sort());
    for (const item of entries) {
      const landed = landOnWecomCard(item, root);
      expect(landed.missing, item.key).toBeNull();
      const row = hasClass(landed.target.node, 'bd-mode-group') || hasClass(landed.target.node, 'bd-field');
      expect(row && showsLabel(landed.target, ownTitle(item)), item.key).toBe(true);
    }
  }));
});

describe('WeCom-specific entries by deployment', () => {
  it('lists none of the WeCom-specific tiles in a Feishu-only deployment', () => withLocale('zh', async () => {
    // 先在企业微信卡上按无障碍名称认出专属区块（连同合放在专属格子里的区块），再看这种部署的条目。
    const root = await renderCard(wecomCard(), wecomConfig('codex', {}));
    const nativeSections = nativeSectionIds(root);
    expect(nativeSections.size).toBeGreaterThan(0);
    publishFeishuOnly();
    const listed = buildBotDefaultsSectionItems().filter(item => nativeSections.has(linkOf(item).section.id));
    expect(listed.map(item => item.key)).toEqual([]);
  }));

  it.each(['zh', 'en'] as const)('keeps every Feishu entry of a Mixed deployment as it is and adds the WeCom ones once, marked as WeCom (%s)', locale => withLocale(locale, async () => {
    publishFeishuOnly();
    const feishuOnly = buildBotDefaultsSectionItems();
    publishMixed();
    const mixed = buildBotDefaultsSectionItems();
    // 原有条目逐项不变（集合、顺序、每个字段），企业微信条目只是追加在后面。
    expect(mixed.slice(0, feishuOnly.length)).toEqual(feishuOnly);
    const added = mixed.slice(feishuOnly.length);
    expect(added.length).toBeGreaterThan(0);
    expect(new Set(mixed.map(item => item.key)).size).toBe(mixed.length);
    // 只出一组：每个区块 / 配置项一条，深链只带 provider=wecom、不点名机器人。
    const targets = added.map(item => {
      const params = new URLSearchParams(item.primary.href!.split('?')[1]);
      expect(params.get('provider'), item.key).toBe('wecom');
      expect(params.get('bot'), item.key).toBeNull();
      return `${params.get('section')} ${params.get('field') ?? ''}`;
    });
    expect(new Set(targets).size).toBe(targets.length);
    // 和飞书条目分得开：副标题前标「企业微信」；没有哪条企业微信条目和飞书条目的标题、副标题都相同。
    const wecomName = t('provider.wecom');
    expect(added.filter(item => !item.subtitle?.startsWith(wecomName)).map(item => item.key)).toEqual([]);
    const feishuLabels = new Set(feishuOnly.map(item => `${item.title}\n${item.subtitle ?? ''}`));
    expect(added.filter(item => feishuLabels.has(`${item.title}\n${item.subtitle ?? ''}`)).map(item => item.key)).toEqual([]);
    // 两边都有的同名条目（会话模式的「私聊」等）确实同时出现，只靠副标题区分。
    const feishuTitles = new Set(feishuOnly.map(item => item.title));
    expect(added.some(item => feishuTitles.has(item.title))).toBe(true);
  }));

  it('links the WeCom-specific tile entries of a WeCom-only deployment with provider=wecom, and leaves the shared ones as they are', () => withLocale('zh', async () => {
    const root = await renderCard(wecomCard(), wecomConfig('codex', {}));
    const nativeSections = nativeSectionIds(root);
    publishWecomOnly();
    const items = buildBotDefaultsSectionItems();
    const native = items.filter(item => nativeSections.has(linkOf(item).section.id));
    const shared = items.filter(item => !native.includes(item));
    expect(native.length).toBeGreaterThan(0);
    expect(native.filter(item => linkProvider(item) !== 'wecom').map(item => item.key)).toEqual([]);
    expect(shared.filter(item => linkProvider(item) !== null).map(item => item.key)).toEqual([]);
    // 只改深链：只有企业微信时不标平台、键不带后缀。
    expect(native.filter(item => item.key.includes('@') || item.subtitle?.startsWith(t('provider.wecom'))).map(item => item.key)).toEqual([]);
  }));

  it('keeps the WeCom-specific tiles off a platform that opens tiles of its own', async () => {
    // 在企业微信卡上认出专属区块，再问一个也开放了自己专属格子的飞书能力表。
    const root = await renderCard(wecomCard(), wecomConfig('codex', {}));
    const ids = nativeSectionIds(root);
    const nativeSections = BOT_DEFAULTS_SECTIONS.filter(section => ids.has(section.id));
    expect(nativeSections.length).toBeGreaterThan(0);
    const larkWithOwnTiles = { ...botProfileCapabilities('lark'), platformSections: true };
    expect(nativeSections.filter(section => botProfileSectionSupported(larkWithOwnTiles, section)).map(section => section.id)).toEqual([]);
  });

  it.each([
    ['read-only', { editable: false, revision: 'external-r1', requiresRestart: true }],
    ['unreadable', {}],
  ] as const)('shows no WeCom-specific tile when the configuration is %s', async (_name, config) => {
    const root = await renderCard(wecomCard(), config);
    // 卡片确实渲染出来了（运行状态格总在），只是没有专属格子。
    expect(root.findAll(node => node.type === 'section' && node.props['data-runtime-status'] !== undefined)).toHaveLength(1);
    expect(nativeElements(root)).toEqual([]);
  });
});
