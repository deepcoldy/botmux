/**
 * 带 provider=wecom 的链接打开 Bot 配置页（⌘K 的企业微信条目、创建向导完成页）：
 *   - 选中哪个企业微信机器人：链接点名的；否则保持配置页上一次显示的企业微信机器人；否则名单里第一个；
 *   - 等待期间不先显示、也不选中飞书机器人；
 *   - 分类 / 区块深链等企业微信卡的配置读完再落点；读失败、只读时照常提示「当前 Bot 不显示该项」；
 *     等待期间用户换了机器人或页签就放弃，不跳也不提示；
 *   - 平台专属区块只在带 provider=wecom 的链接上生效，没带就和未知区块一样被忽略。
 * 用真实的 BotDefaultsPage 渲染，fetch 每一路都由测试控制什么时候回来。
 */
import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock('../src/dashboard/web/toast.js', () => ({ toast: toastSpy, ToastStack: () => null }));
// 配置页里「等页面画完再做」的可选探测（模型列表等）也走 requestAnimationFrame；这里的 frames 只用来
// 观察深链落点，所以让那类探测直接执行，不占用 frames。
vi.mock('../src/dashboard/web/deferred-task.js', () => ({
  afterNextPaint: (task: () => void) => { task(); return () => {}; },
}));

import { BotDefaultsCard, BotDefaultsPage, readBotDefaultsDeepLink, resetLastShownWecomBot } from '../src/dashboard/web/bot-defaults-page.js';
import { WecomBotDefaultsCard } from '../src/dashboard/web/wecom-bot-defaults-card.js';
import { BotRosterRow } from '../src/dashboard/web/bot-profile-ui.js';
import { LoadingState } from '../src/dashboard/web/dashboard-components.js';
import { botDefaultsHref, findBotDefaultsSection } from '../src/dashboard/web/bot-defaults.js';
import { publishProviderRoster } from '../src/dashboard/web/provider-roster.js';
import { buildBotDefaultsSectionItems } from '../src/dashboard/web/command-palette-sources.js';
import { t, ui } from '../src/dashboard/web/ui.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

type Reply = { status: number; body: unknown };
const ok = (body: unknown): Reply => ({ status: 200, body });

const LARK_BOT = { larkAppId: 'cli_feishu', botName: 'Feishu Fixture', cliId: 'codex', agentSelectionKey: 'codex', online: true };
const wecomConnection = (id: string) => ({
  id, label: `WeCom ${id}`, botIdHint: `…${id}`, allowedUserCount: 1, coreMode: 'managed', configuration: 'ready',
  gateway: 'running', connection: 'connected', ownership: 'fleet', canStart: false, canStop: true, canRestart: true,
});
const editableConfig = {
  editable: true, revision: 'r1', displayName: 'WeCom', cli: 'codex', backend: 'pty', model: '', workingDirectory: '/workspace',
  requiresRestart: true, botConfig: {}, runtime: {}, allowedUsers: ['owner'], blockedUsers: [], role: { content: '', injectMode: 'once' },
  native: {}, business: {}, sessionMode: { p2pMode: 'chat', regularGroupReplyMode: 'user', regularGroupMentionMode: 'never' },
};
const ENV_VIEW = { scope: 'bot', rows: [], reserved: { keys: [], prefixes: [] }, conflicts: [], redactedHostKeys: [], inherit: { mode: 'inherit' }, sessions: [], canReveal: false, overlayApplies: true };

/** 每一路请求什么时候回来由测试决定；没登记的路径立刻回一个无害的空响应。 */
class Server {
  lark = deferred<Reply>();
  wecomList = deferred<Reply>();
  configs = new Map<string, Deferred<Reply>>();
  config(id: string): Deferred<Reply> {
    if (!this.configs.has(id)) this.configs.set(id, deferred<Reply>());
    return this.configs.get(id)!;
  }
  async reply(url: string): Promise<Reply> {
    if (url === '/api/bots') return this.lark.promise;
    if (url === '/api/wecom/connections') return this.wecomList.promise;
    const config = /^\/api\/wecom\/connections\/([^/]+)\/config$/.exec(url);
    if (config) return this.config(decodeURIComponent(config[1]!)).promise;
    if (/\/(environment|session-env)(\?|$)/.test(url)) return ok(ENV_VIEW);
    if (url.includes('/command-triggers')) return ok({ enabled: false, commands: [], scope: 'all', chats: [], excludedChats: [], prompt: '' });
    if (url.startsWith('/api/cli-options/availability')) return ok({ status: 'available' });
    if (url.startsWith('/api/cli-options')) return ok({ options: [{ id: 'codex', label: 'Codex' }] });
    if (url === '/api/agents') return ok({ agents: [], links: {} });
    return ok({ bots: [], chats: [] });
  }
}

let server: Server;
let renderer: TestRenderer.ReactTestRenderer | undefined;
let frames: Array<() => void> = [];
let scrolled: ReactTestInstance[] = [];
const location = { hash: '#/', pathname: '/', search: '' };

function textOf(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(child => textOf(child as ReactTestInstance | string)).join('');
}

function matches(node: ReactTestInstance, selector: string): boolean {
  if (typeof node.type !== 'string') return false;
  if (selector.startsWith('.')) return String(node.props.className ?? '').split(/\s+/).includes(selector.slice(1));
  return node.type === selector;
}

/** 落点代码用到的那几样 DOM 能力，接在测试渲染树上；scrollIntoView 记下滚到了哪个节点。 */
function domElement(node: ReactTestInstance): any {
  return {
    node,
    style: {},
    offsetWidth: 0,
    classList: { add() {}, remove() {} },
    get textContent() { return textOf(node); },
    scrollIntoView() { scrolled.push(node); },
    querySelectorAll(selector: string) {
      const parts = selector.split(',').map(part => part.trim());
      return node.findAll(child => child !== node && parts.some(part => matches(child, part))).map(domElement);
    },
    closest(selector: string) {
      const parts = selector.split(',').map(part => part.trim());
      for (let current: ReactTestInstance | null = node; current; current = current.parent) {
        const candidate = current;
        if (parts.some(part => matches(candidate, part))) return domElement(candidate);
      }
      return null;
    },
  };
}

beforeEach(() => {
  server = new Server();
  frames = [];
  scrolled = [];
  toastSpy.mockReset();
  resetLastShownWecomBot();
  const events = new EventTarget();
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', {
    state: null,
    replaceState: (_state: unknown, _title: string, url: string) => { location.hash = url.slice(url.indexOf('#')); },
  });
  vi.stubGlobal('window', {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length; },
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  vi.stubGlobal('document', {
    documentElement: {},
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    getElementById: (id: string) => {
      const found = renderer?.root.findAll(node => typeof node.type === 'string' && node.props.id === id) ?? [];
      return found[0] ? domElement(found[0]) : null;
    },
  });
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const reply = await server.reply(String(input));
    return { ok: reply.status === 200, status: reply.status, json: async () => reply.body };
  }));
  // 混合部署：一个飞书机器人、两个企业微信机器人。
  publishProviderRoster('lark', 1);
  publishProviderRoster('wecom', 2);
});

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  publishProviderRoster('lark', 1);
  publishProviderRoster('wecom', 0);
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

async function open(hash: string): Promise<void> {
  location.hash = hash;
  await act(async () => { renderer = TestRenderer.create(React.createElement(BotDefaultsPage)); });
  await settle();
}

async function close(): Promise<void> {
  await act(async () => renderer!.unmount());
  renderer = undefined;
}

async function resolve<T>(target: Deferred<T>, value: T): Promise<void> {
  await act(async () => target.resolve(value));
  await settle();
}

const answerLark = () => resolve(server.lark, ok({ bots: [LARK_BOT] }));
const answerWecomList = () => resolve(server.wecomList, ok({ connections: [wecomConnection('w1'), wecomConnection('w2')] }));
const answerConfig = (id: string, reply: Reply = ok(editableConfig)) => resolve(server.config(id), reply);

/** 详情区显示的是什么：哪个企业微信机器人的卡、飞书卡，还是加载中。 */
function detail(): string {
  const root = renderer!.root;
  const wecom = root.findAllByType(WecomBotDefaultsCard);
  if (wecom.length) return `wecom:${wecom[0]!.props.connection.id}`;
  if (root.findAllByType(BotDefaultsCard).length) return 'lark';
  return root.findByProps({ id: 'bd-list' }).findAllByType(LoadingState).length ? 'loading' : 'empty';
}

const selectedRows = () => renderer!.root.findAllByType(BotRosterRow).filter(row => row.props.selected).map(row => row.props.name);
const rosterRow = (name: string) => renderer!.root.findAllByType(BotRosterRow).find(row => row.props.name === name)!;

async function runFrames(): Promise<void> {
  const pending = frames.splice(0);
  await act(async () => { for (const frame of pending) frame(); });
}

const notShown = (titleKey: string) => t('botDefaults.deepLinkNotShown', { name: t(titleKey) });
const sectionLink = (section: string) => botDefaultsHref({ provider: 'wecom', section });
const SECURITY_SECTION = 'wecom-core-security';

describe('Bot config page opened by a provider=wecom link in a mixed deployment', () => {
  it('waits for the WeCom roster and that bot\'s configuration before landing, and never shows or selects the Feishu bot meanwhile', async () => {
    await open(sectionLink(SECURITY_SECTION));
    await answerLark();
    expect(detail()).toBe('loading');
    expect(selectedRows()).toEqual([]);

    await answerWecomList();
    expect(detail()).toBe('wecom:w1');
    expect(selectedRows()).toEqual(['WeCom w1']);
    expect(frames).toHaveLength(0);

    await answerConfig('w1');
    expect(frames).toHaveLength(1);
    await runFrames();
    expect(scrolled.map(node => node.props.id)).toEqual([`bd-section-${SECURITY_SECTION}`]);
    expect(toastSpy).not.toHaveBeenCalled();
    // 一次性：分类 / 区块参数清掉，provider 留着。
    expect(location.hash).toBe('#/bot-defaults?provider=wecom');
    expect(selectedRows()).toEqual(['WeCom w1']);
  });

  it('lands the same way when the WeCom roster arrives before the Feishu one', async () => {
    await open(sectionLink(SECURITY_SECTION));
    await answerWecomList();
    await answerConfig('w1');
    await answerLark();
    expect(detail()).toBe('wecom:w1');
    expect(frames).toHaveLength(1);
    await runFrames();
    expect(scrolled.map(node => node.props.id)).toEqual([`bd-section-${SECURITY_SECTION}`]);
  });

  it('keeps the WeCom bot the page showed last, and falls back to the first one once a Feishu bot was shown', async () => {
    // 用户在配置页上看着第二个企业微信机器人。
    await open('#/bot-defaults?provider=wecom&bot=w2');
    await answerLark();
    await answerWecomList();
    await answerConfig('w2');
    expect(detail()).toBe('wecom:w2');
    await close();

    // 从 ⌘K 选一个企业微信条目：保持第二个，落点也在它上面。
    server = new Server();
    await open(sectionLink(SECURITY_SECTION));
    await answerLark();
    await answerWecomList();
    expect(detail()).toBe('wecom:w2');
    await answerConfig('w2');
    await runFrames();
    expect(scrolled.map(node => node.props.id)).toEqual([`bd-section-${SECURITY_SECTION}`]);

    // 切到飞书机器人之后再从 ⌘K 选企业微信条目：当前没有选中的企业微信机器人，选第一个。
    await act(async () => rosterRow(LARK_BOT.botName).props.onSelect());
    expect(detail()).toBe('lark');
    await close();
    server = new Server();
    await open(sectionLink(SECURITY_SECTION));
    await answerLark();
    await answerWecomList();
    expect(detail()).toBe('wecom:w1');
  });

  it('selects a WeCom bot for a link that names none (the bot-creation wizard\'s link)', async () => {
    await open('#/bot-defaults?provider=wecom');
    await answerLark();
    expect(detail()).toBe('loading');
    await answerWecomList();
    expect(detail()).toBe('wecom:w1');
    expect(selectedRows()).toEqual(['WeCom w1']);
  });

  it.each([
    ['cannot be read', { status: 500, body: {} }],
    ['is read-only', ok({ editable: false, revision: 'external', requiresRestart: true })],
  ] as const)('tells the user the section is not shown when the configuration %s, instead of waiting forever', async (_name, reply) => {
    await open(sectionLink(SECURITY_SECTION));
    await answerLark();
    await answerWecomList();
    expect(frames).toHaveLength(0);
    await answerConfig('w1', reply);
    expect(frames).toHaveLength(1);
    await runFrames();
    expect(scrolled).toEqual([]);
    expect(toastSpy.mock.calls.map(call => call[0])).toEqual([notShown(findBotDefaultsSection(SECURITY_SECTION)!.titleKey)]);
  });

  it.each([
    ['the Feishu bot', LARK_BOT.botName],
    ['the other WeCom bot', 'WeCom w2'],
  ])('gives up the link when the user picks %s while it waits', async (_name, rowName) => {
    await open(sectionLink(SECURITY_SECTION));
    await answerLark();
    await answerWecomList();
    await act(async () => rosterRow(rowName).props.onSelect());
    await answerConfig('w1');
    await answerConfig('w2');
    expect(frames).toHaveLength(0);
    expect(toastSpy).not.toHaveBeenCalled();
    expect(location.hash).toBe('#/bot-defaults?provider=wecom');
  });

  it('stays on the Feishu bot the user picked while the WeCom roster was still loading', async () => {
    await open(sectionLink(SECURITY_SECTION));
    await answerLark();
    await act(async () => rosterRow(LARK_BOT.botName).props.onSelect());
    expect(detail()).toBe('lark');
    await answerWecomList();
    await answerConfig('w1');
    expect(detail()).toBe('lark');
    expect(selectedRows()).toEqual([LARK_BOT.botName]);
    expect(frames).toHaveLength(0);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('gives up the link when a roster search hides the bot it was waiting for', async () => {
    await answerLark();
    await open(sectionLink(SECURITY_SECTION));
    await answerWecomList();
    // 只留下第二个企业微信机器人：配置页自动选中它，但这条链接等的是第一个。
    const search = renderer!.root.findByProps({ name: 'q' });
    await act(async () => search.props.onChange({ currentTarget: { value: 'w2' } }));
    await settle();
    expect(detail()).toBe('wecom:w2');
    await answerConfig('w2');
    await answerConfig('w1');
    expect(frames).toHaveLength(0);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('gives up the link when the user switches the category tab while it waits', async () => {
    await open(sectionLink(SECURITY_SECTION));
    await answerLark();
    await answerWecomList();
    const card = renderer!.root.findByType(WecomBotDefaultsCard);
    await act(async () => card.props.onTabChange('cards'));
    await answerConfig('w1');
    expect(frames).toHaveLength(0);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('falls back to the Feishu bot when the deployment turns out to have no WeCom bot', async () => {
    await open(sectionLink(SECURITY_SECTION));
    await answerLark();
    await resolve(server.wecomList, ok({ connections: [] }));
    expect(detail()).toBe('lark');
    expect(selectedRows()).toEqual([LARK_BOT.botName]);
  });
});

describe('Bot config deep link to a WeCom-specific section', () => {
  const deployments = [['Feishu-only', 1, 0], ['Mixed', 1, 2], ['WeCom-only', 0, 2]] as const;

  it.each(deployments)('ignores it, like any unknown section, when the link has no provider=wecom (%s)', (_name, lark, wecom) => {
    publishProviderRoster('lark', lark);
    publishProviderRoster('wecom', wecom);
    location.hash = botDefaultsHref({ section: SECURITY_SECTION });
    expect(readBotDefaultsDeepLink()).toBeNull();
    location.hash = botDefaultsHref({ provider: 'lark', section: SECURITY_SECTION });
    expect(readBotDefaultsDeepLink()).toBeNull();
    location.hash = `#/bot-defaults?tab=cards&section=${SECURITY_SECTION}`;
    expect(readBotDefaultsDeepLink()).toEqual({ tab: 'cards', section: null, field: null });
  });

  it.each(deployments.filter(([, , wecom]) => wecom > 0))('takes it from a provider=wecom link (%s)', (_name, lark, wecom) => {
    publishProviderRoster('lark', lark);
    publishProviderRoster('wecom', wecom);
    location.hash = sectionLink(SECURITY_SECTION);
    expect(readBotDefaultsDeepLink()?.section?.id).toBe(SECURITY_SECTION);
  });

  it('ignores it even from a provider=wecom link when the deployment has no WeCom bot', () => {
    publishProviderRoster('wecom', 0);
    location.hash = sectionLink(SECURITY_SECTION);
    expect(readBotDefaultsDeepLink()).toBeNull();
  });
});

describe('Bot config page opened from a WeCom-only deployment\'s ⌘K', () => {
  it('follows a WeCom-specific tile entry like a provider=wecom link: waits for the configuration and tells the user when it cannot be read', async () => {
    publishProviderRoster('lark', 0);
    publishProviderRoster('wecom', 2);
    const previous = ui.authed;
    ui.authed = true;
    let href: string;
    try {
      href = buildBotDefaultsSectionItems().find(item => {
        const params = new URLSearchParams(item.primary.href!.split('?')[1]);
        return params.get('section') === SECURITY_SECTION && !params.has('field');
      })!.primary.href!;
    } finally {
      ui.authed = previous;
    }
    await open(href);
    await resolve(server.lark, ok({ bots: [] }));
    await answerWecomList();
    expect(detail()).toBe('wecom:w1');
    expect(frames).toHaveLength(0);
    await answerConfig('w1', { status: 500, body: {} });
    expect(frames).toHaveLength(1);
    await runFrames();
    expect(toastSpy.mock.calls.map(call => call[0])).toEqual([notShown(findBotDefaultsSection(SECURITY_SECTION)!.titleKey)]);
  });
});
