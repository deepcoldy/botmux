/**
 * 群组管理页重构后的新行为：
 *  - 列表按「某 bot 在群」筛选、行内只列在群 bot，点 bot 直达它在本群的设置；
 *  - 「复制为新群」取代「保存 Profile」：预填源群 bot / 目录，建群后复制群级角色；
 *  - 管理抽屉的概览矩阵把各 bot 的设置压成一格，点一行切到该 bot 的设置页。
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateDialog, GroupListRow, ManageDialog, renderGroupsPage } from '../src/dashboard/web/groups-page.js';
import { __testOnly_resetGroupsSnapshotCache } from '../src/dashboard/web/groups-api.js';
import {
  copyChatRoles,
  filterGroupChats,
  groupCloneTemplate,
  type GroupBot,
  type GroupChat,
} from '../src/dashboard/web/groups.js';
import { summarizeBotSettings } from '../src/dashboard/web/group-settings-summary.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pageMount = vi.hoisted(() => ({ node: null as unknown }));
vi.mock('../src/dashboard/web/react-mount.js', () => ({
  mountReactPage: (_root: HTMLElement, node: unknown) => { pageMount.node = node; return () => undefined; },
}));
vi.mock('../src/dashboard/web/toast.js', () => ({ toast: vi.fn() }));
vi.mock('../src/dashboard/web/confirm-modal.js', () => ({ confirm: vi.fn(async () => false) }));

const tr = createDashboardTranslator('zh');
type Member = GroupChat['memberBots'][number];

const BOTS: GroupBot[] = [
  { larkAppId: 'cli_a', botName: 'Alpha' },
  { larkAppId: 'cli_b', botName: 'Beta' },
  { larkAppId: 'cli_c', botName: 'Gamma' },
];

function member(larkAppId: string, overrides: Partial<Member> = {}): Member {
  return { larkAppId, botName: BOTS.find(b => b.larkAppId === larkAppId)?.botName, inChat: true, ...overrides };
}

function chat(memberBots: Member[], overrides: Partial<GroupChat> = {}): GroupChat {
  return { chatId: 'oc_src', name: 'Src Room', ownerId: 'cli_a', memberBots, ...overrides };
}

function json(body: unknown, status = 200): any {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('filterGroupChats — bot filter', () => {
  const chats = [
    chat([member('cli_a'), member('cli_b', { inChat: false })], { chatId: 'oc_1', name: 'One' }),
    chat([member('cli_b')], { chatId: 'oc_2', name: 'Two' }),
  ];

  it('keeps only chats where the chosen bot is actually in the chat', () => {
    expect(filterGroupChats(chats, { q: '', botId: 'cli_b' }).map(c => c.chatId)).toEqual(['oc_2']);
    expect(filterGroupChats(chats, { q: '', botId: 'cli_a' }).map(c => c.chatId)).toEqual(['oc_1']);
  });

  it('does not filter when no bot is chosen, and composes with the text query', () => {
    expect(filterGroupChats(chats, { q: '', botId: '' })).toHaveLength(2);
    expect(filterGroupChats(chats, { q: 'two', botId: '' }).map(c => c.chatId)).toEqual(['oc_2']);
    expect(filterGroupChats(chats, { q: 'one', botId: 'cli_b' })).toEqual([]);
  });
});

describe('groupCloneTemplate — prefill for "duplicate as new chat"', () => {
  it('takes in-chat roster bots, role bots and the most common oncall dir', () => {
    const source = chat([
      member('cli_a', { hasRole: true, oncallChat: { workingDir: '/srv/x' } }),
      member('cli_b', { oncallChat: { workingDir: '/srv/y' } }),
      member('cli_c', { hasRole: true, oncallChat: { workingDir: '/srv/x' } }),
      member('cli_gone', { hasRole: true }), // 已不在 roster：建群接口不认，不能预选
      member('cli_out', { inChat: false, hasRole: true }),
    ]);
    expect(groupCloneTemplate(source, BOTS)).toEqual({
      sourceChatId: 'oc_src',
      sourceName: 'Src Room',
      botIds: ['cli_a', 'cli_b', 'cli_c'],
      roleBotIds: ['cli_a', 'cli_c'],
      workingDir: '/srv/x',
    });
  });

  it('leaves the directory empty when nobody has an oncall binding', () => {
    expect(groupCloneTemplate(chat([member('cli_a')]), BOTS).workingDir).toBe('');
  });
});

describe('copyChatRoles — chat-level roles only', () => {
  it('copies explicit chat roles with their settings, skips team-default ones, reports failures', async () => {
    const puts: Array<{ url: string; body: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method) {
        if (url === '/api/roles/cli_a/oc_src') {
          return json({ hasRole: true, content: 'role A', injectMode: 'once', replyPrivately: true, effectiveSource: 'chat' });
        }
        // 只有团队默认角色：hasRole=false，不应复制成群级角色
        if (url === '/api/roles/cli_b/oc_src') {
          return json({ hasRole: false, content: null, hasEffectiveRole: true, effectiveContent: 'team', effectiveSource: 'team' });
        }
        if (url === '/api/roles/cli_c/oc_src') return json({ hasRole: true, content: 'role C' });
      }
      if (init?.method === 'PUT') {
        puts.push({ url, body: JSON.parse(String(init.body)) });
        if (url === '/api/roles/cli_c/oc_new') return json({ ok: false, error: 'bot_offline' }, 502);
        return json({ ok: true, changed: true });
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await copyChatRoles('oc_src', 'oc_new', ['cli_a', 'cli_b', 'cli_c']);

    expect(result.copied).toEqual(['cli_a']);
    expect(result.skipped).toEqual(['cli_b']);
    expect(result.failed).toEqual([{ larkAppId: 'cli_c', error: 'bot_offline' }]);
    expect(puts.find(p => p.url === '/api/roles/cli_a/oc_new')?.body)
      .toEqual({ content: 'role A', injectMode: 'once', replyPrivately: true });
    expect(puts.some(p => p.url.startsWith('/api/roles/cli_b/'))).toBe(false);
  });

  it('fails closed when hasRole is not true even if the GET carries content', async () => {
    // hasRole 是独立于 content.trim() 的门：异常/畸形回包（hasRole 非 true 却带正文）
    // 不允许 PUT 成群级角色——真实 daemon 下两者同源（hasRole = content !== null），
    // 这例钉的是门本身，防止重构时把双重防御误删成只看 trim()。
    const puts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        puts.push(String(_url));
        return json({ ok: true, changed: true });
      }
      return json({ hasRole: false, content: 'unexpected nonempty content' });
    }));

    const result = await copyChatRoles('oc_src', 'oc_new', ['cli_a']);

    expect(result.skipped).toEqual(['cli_a']);
    expect(result.copied).toEqual([]);
    expect(puts).toEqual([]);
  });
});

describe('summarizeBotSettings — overview matrix cells', () => {
  it('marks per-chat overrides as "on" and inherited/default values as "off"', () => {
    const cells = summarizeBotSettings(member('cli_a', {
      hasRole: true,
      replyMode: { override: 'chat', default: 'chat-topic', effective: 'chat', inherited: false },
      oncallChat: { workingDir: '/srv/repo' },
      agentCliId: 'codex',
      defaultModels: { codex: { model: 'gpt-x', reasoningEffort: 'high' } },
      serialInput: true,
      idleClose: { enabled: true, duration: 3, unit: 'days' },
      streamingCardChatEnabled: true,
      streamingCardMasterEnabled: true,
      pinStreamingCardEffectiveEnabled: true,
    }), tr);
    for (const cell of Object.values(cells)) expect(cell.tone).toBe('on');
    expect(cells.oncall.text).toBe('/srv/repo');
    expect(cells.model.text).toBe('gpt-x · high');
  });

  it('flags a chat-level switch that the bot-level master blocks', () => {
    const cells = summarizeBotSettings(member('cli_a', {
      streamingCardChatEnabled: true,
      streamingCardMasterEnabled: false,
      pinStreamingCardChatEnabled: true,
      pinStreamingCardMasterEnabled: false,
      pinStreamingCardEffectiveEnabled: false,
    }), tr);
    expect(cells.cardMode.tone).toBe('warn');
    expect(cells.pin.tone).toBe('warn');
  });

  it('treats a missing / inherited configuration as off', () => {
    const cells = summarizeBotSettings(member('cli_a', {
      replyMode: { override: null, default: 'chat-topic', effective: 'chat-topic', inherited: true },
      agentCliId: 'gemini',
    }), tr);
    expect(cells.role.tone).toBe('off');
    expect(cells.replyMode.tone).toBe('off');
    expect(cells.oncall.tone).toBe('off');
    expect(cells.model.tone).toBe('off');
    expect(cells.cardMode.tone).toBe('on'); // 默认继承 Bot 级开启
    expect(cells.pin.tone).toBe('off');
  });
});

describe('GroupListRow — in-chat bot chips', () => {
  function renderRow(memberBots: Member[], onManage = vi.fn()) {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(GroupListRow, {
        chat: chat(memberBots),
        bots: BOTS,
        tr,
        onAddBots: vi.fn(),
        onClone: vi.fn(),
        onManage,
      }));
    });
    return renderer;
  }

  it('lists only bots that are in the chat, and a chip opens that bot\'s settings', () => {
    const onManage = vi.fn();
    const renderer = renderRow([member('cli_a'), member('cli_b', { inChat: false }), member('cli_c')], onManage);
    const chips = renderer.root.findAll(node => node.type === 'button' && node.props.className === 'groups-bot-chip');
    expect(chips.map(chip => chip.props['data-bot'])).toEqual(['cli_a', 'cli_c']);

    act(() => { chips[1].props.onClick(); });
    expect(onManage).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'oc_src' }), 'cli_c');
  });

  it('clicking the row background opens the manage drawer but inner buttons do not double-fire', () => {
    const onManage = vi.fn();
    const renderer = renderRow([member('cli_a')], onManage);
    const row = renderer.root.findByProps({ 'data-chat': 'oc_src' });

    act(() => { row.props.onClick({ target: { closest: () => null } }); });
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(onManage).toHaveBeenLastCalledWith(expect.objectContaining({ chatId: 'oc_src' }));

    act(() => { row.props.onClick({ target: { closest: () => ({}) } }); });
    expect(onManage).toHaveBeenCalledTimes(1);
  });
});

describe('ManageDialog — overview matrix drives the per-bot pane', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (/\/chat-mode\//.test(url)) return json({ ok: true, chatMode: 'group' });
      if (/\/members$/.test(url) || /\/grants/.test(url) || /\/blocked/.test(url)) return json({ ok: true, members: [], grants: [], blocked: [] });
      return json({ ok: true });
    }));
  });

  function renderManage(initialBotId?: string) {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(ManageDialog, {
        chat: chat([member('cli_a'), member('cli_b'), member('cli_c', { inChat: false })]),
        initialBotId,
        tr,
        onClose: vi.fn(),
        onReloadGroups: async () => ({ chats: [], bots: [] }),
      }));
    });
    return renderer;
  }

  const panel = (renderer: TestRenderer.ReactTestRenderer, id: string) =>
    renderer.root.findByProps({ id: `g-manage-panel-${id}` });
  const visiblePane = (renderer: TestRenderer.ReactTestRenderer) =>
    panel(renderer, 'bots').findByProps({ className: 'g-bot-settings-host' }).children
      .filter((wrapper): wrapper is TestRenderer.ReactTestInstance => typeof wrapper !== 'string' && wrapper.props.hidden === false)
      .map(wrapper => wrapper.findByProps({ className: 'g-bot-settings' }).props['data-bot']);

  it('opens on the overview with one matrix row per in-chat bot', () => {
    const renderer = renderManage();
    expect(panel(renderer, 'overview').props.hidden).toBe(false);
    expect(panel(renderer, 'bots').props.hidden).toBe(true);
    const rows = panel(renderer, 'overview').findAll(node => node.type === 'tr' && node.props['data-bot']);
    expect(rows.map(row => row.props['data-bot'])).toEqual(['cli_a', 'cli_b']);
  });

  it('clicking a matrix row switches to that bot\'s settings', () => {
    const renderer = renderManage();
    const row = panel(renderer, 'overview').find(node => node.type === 'tr' && node.props['data-bot'] === 'cli_b');
    act(() => { row.props.onClick(); });
    expect(panel(renderer, 'bots').props.hidden).toBe(false);
    expect(visiblePane(renderer)).toEqual(['cli_b']);
  });

  it('opens straight on a bot when the row chip asked for one', async () => {
    const renderer = renderManage('cli_b');
    await flush();
    expect(panel(renderer, 'bots').props.hidden).toBe(false);
    expect(visiblePane(renderer)).toEqual(['cli_b']);
  });
});

describe('ManageDialog — tabs show their content directly', () => {
  function renderDialog(urls: string[]) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      if (/\/chat-mode\//.test(url)) return json({ ok: true, chatMode: 'group' });
      if (url.endsWith('/members-display')) return json({ members: [{ openId: 'ou_u1', name: '成员甲', memberType: 'user' }] });
      if (url.endsWith('/blocked-users')) return json({ ok: true, raw: [], resolved: [] });
      if (url.endsWith('/grants/chat')) return json({ ok: true, subjects: [] });
      return json({ ok: true });
    }));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(ManageDialog, {
        chat: chat([member('cli_a'), member('cli_b')]),
        tr,
        onClose: vi.fn(),
        onReloadGroups: async () => ({ chats: [], bots: [] }),
      }));
    });
    return renderer;
  }
  const panel = (renderer: TestRenderer.ReactTestRenderer, id: string) =>
    renderer.root.findByProps({ id: `g-manage-panel-${id}` });
  const tabButton = (renderer: TestRenderer.ReactTestRenderer, id: string) =>
    renderer.root.findByProps({ id: `g-manage-tab-${id}` });

  it('member access: no collapsed block or repeated title, and it loads only once the tab is opened', async () => {
    const urls: string[] = [];
    const renderer = renderDialog(urls);
    await flush();
    // 打开抽屉不该为成员权限发请求
    expect(urls.some(url => url.endsWith('/members-display'))).toBe(false);

    act(() => { tabButton(renderer, 'access').props.onClick(); });
    await flush();
    const access = panel(renderer, 'access');
    expect(access.props.hidden).toBe(false);
    expect(access.findAllByType('details')).toHaveLength(0);
    expect(access.findAllByType('legend')).toHaveLength(0);
    expect(access.findAllByProps({ 'data-member-row': 'ou_u1' })).toHaveLength(1);
    expect(urls.filter(url => url.endsWith('/members-display'))).toHaveLength(1);

    // 切走再切回：常驻挂载，不重复加载
    act(() => { tabButton(renderer, 'overview').props.onClick(); });
    act(() => { tabButton(renderer, 'access').props.onClick(); });
    await flush();
    expect(urls.filter(url => url.endsWith('/members-display'))).toHaveLength(1);
  });

  it('collaboration: the tab label is the only title (no legend repeating it)', () => {
    const renderer = renderDialog([]);
    const collab = panel(renderer, 'collab');
    expect(collab.findAllByType('legend')).toHaveLength(0);
    expect(collab.findByProps({ className: 'g-collaboration-mode' }).props['aria-label']).toBe(tr('groups.collaborationMode'));
  });
});

describe('CreateDialog — duplicate as new chat', () => {
  it('prefills the source bots, creates the chat, then copies the selected bots\' chat roles', async () => {
    const calls: Array<{ method: string; url: string; body?: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/feed-groups') return json({ ok: true, groups: [], larkAppId: 'cli_a' });
      if (url === '/api/groups/create') return json({ ok: true, chatId: 'oc_new', creator: 'cli_a' });
      if (method === 'GET' && url.startsWith('/api/roles/')) return json({ hasRole: true, content: `role of ${url}` });
      if (method === 'PUT' && url.startsWith('/api/roles/')) return json({ ok: true, changed: true });
      throw new Error(`unexpected ${method} ${url}`);
    }));
    vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {}, getElementById() { return null; } });
    const nativeFormData = globalThis.FormData;
    (globalThis as any).FormData = class {
      get(name: string): string { return name === 'bindWorkingDir' ? '/srv/x' : ''; }
    };
    const onCreated = vi.fn();
    const template = groupCloneTemplate(chat([
      member('cli_a', { hasRole: true }),
      member('cli_b', { hasRole: true }),
    ]), BOTS);

    try {
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(CreateDialog, {
          bots: BOTS,
          template,
          tr,
          onClose: vi.fn(),
          onCreated,
          setTimer: () => 0,
        }));
      });
      const checked = renderer.root.findAll(node => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked === true)
        .map(node => node.props.value);
      expect(checked).toEqual(expect.arrayContaining(['cli_a', 'cli_b']));

      // 取消 Beta：它的群角色也不该被复制
      act(() => {
        renderer.root.findByProps({ type: 'checkbox', value: 'cli_b' }).props.onChange({ currentTarget: { checked: false } });
      });
      await act(async () => {
        renderer.root.findByProps({ id: 'g-createform' }).props.onSubmit({ preventDefault() {}, currentTarget: {} });
      });
      await flush();

      const create = calls.find(call => call.url === '/api/groups/create');
      expect(create?.body).toMatchObject({ larkAppIds: ['cli_a'], bindWorkingDir: '/srv/x' });
      expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'oc_new' }), ['cli_a'], '');
      const rolePuts = calls.filter(call => call.method === 'PUT').map(call => call.url);
      expect(rolePuts).toEqual(['/api/roles/cli_a/oc_new']);
      expect(renderer.root.findAll(node => node.props.className === 'hint-ok'
        && String(node.children.join('')).includes('已复制 1 个群角色'))).toHaveLength(1);
    } finally {
      (globalThis as any).FormData = nativeFormData;
    }
  });

  it('skips role copies for bots the create response marks invalid', async () => {
    // 两个 bot 都勾选且都有群角色；建群接口报 cli_b 无效（没进群），
    // 角色复制必须把它剔除，不能给不在新群里的 bot 写角色。
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      if (url === '/api/feed-groups') return json({ ok: true, groups: [], larkAppId: 'cli_a' });
      if (url === '/api/groups/create') {
        return json({ ok: true, chatId: 'oc_new', creator: 'cli_a', invalidBotIds: ['cli_b'] });
      }
      if (method === 'GET' && url.startsWith('/api/roles/')) return json({ hasRole: true, content: `role ${url}` });
      if (method === 'PUT' && url.startsWith('/api/roles/')) return json({ ok: true, changed: true });
      throw new Error(`unexpected ${method} ${url}`);
    }));
    vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {}, getElementById() { return null; } });
    const nativeFormData = globalThis.FormData;
    (globalThis as any).FormData = class {
      get(name: string): string { return name === 'bindWorkingDir' ? '/srv/x' : ''; }
    };
    const template = groupCloneTemplate(chat([
      member('cli_a', { hasRole: true }),
      member('cli_b', { hasRole: true }),
    ]), BOTS);

    try {
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(CreateDialog, {
          bots: BOTS,
          template,
          tr,
          onClose: vi.fn(),
          onCreated: vi.fn(),
          setTimer: () => 0,
        }));
      });
      await act(async () => {
        renderer.root.findByProps({ id: 'g-createform' }).props.onSubmit({ preventDefault() {}, currentTarget: {} });
      });
      await flush();

      const rolePuts = calls.filter(call => call.method === 'PUT').map(call => call.url);
      expect(rolePuts).toEqual(['/api/roles/cli_a/oc_new']);
    } finally {
      (globalThis as any).FormData = nativeFormData;
    }
  });
});

describe('GroupsPage — bot avatars', () => {
  it('shows the roster avatar for in-chat bots (memberBots carry no avatar URL)', async () => {
    __testOnly_resetGroupsSnapshotCache();
    vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {}, getElementById() { return null; } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/groups') {
        return json({
          bots: [{ larkAppId: 'cli_a', botName: 'Alpha', botAvatarUrl: 'https://cdn.example/alpha.png' }, { larkAppId: 'cli_b', botName: 'Beta' }],
          // 与 /api/groups 真实形状一致：memberBots 只有名字和设置，没有 botAvatarUrl
          chats: [chat([member('cli_a'), member('cli_b')])],
        });
      }
      throw new Error(`unexpected ${url}`);
    }));
    renderGroupsPage({} as HTMLElement);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(pageMount.node as React.ReactElement); });
    await vi.waitFor(async () => {
      await act(async () => undefined);
      expect(renderer.root.findAll(node => node.props.className === 'groups-bot-chip')).toHaveLength(2);
    });
    const avatarHtml = (botId: string) => renderer.root
      .find(node => node.props.className === 'groups-bot-chip' && node.props['data-bot'] === botId)
      .findAll(node => typeof node.props.dangerouslySetInnerHTML?.__html === 'string')[0]
      .props.dangerouslySetInnerHTML.__html as string;
    expect(avatarHtml('cli_a')).toContain('src="https://cdn.example/alpha.png"');
    expect(avatarHtml('cli_b')).not.toContain('<img');
    act(() => renderer.unmount());
  });
});
