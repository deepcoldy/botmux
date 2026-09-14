import { beforeEach, describe, expect, it, vi } from 'vitest';

const chatTab = {
  create: vi.fn(),
  listTabs: vi.fn(),
  updateTabs: vi.fn(),
  deleteTabs: vi.fn(),
  sortTabs: vi.fn(),
};

vi.mock('../src/bot-registry.js', () => ({
  getBotClient: () => ({ im: { v1: { chatTab } } }),
}));

import {
  addUrlChatTab,
  deleteChatTab,
  ensureUrlChatTab,
  isCompleteChatTabOrder,
  listChatTabs,
  renameChatTab,
  sortChatTabs,
} from '../src/im/lark/chat-tabs.js';
import { parseTabsCommand } from '../src/im/lark/chat-tabs-command.js';
import { parseChatTabsCli } from '../src/cli/chat-tabs-command.js';

describe('chat tabs API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists tabs', async () => {
    chatTab.listTabs.mockResolvedValue({ code: 0, data: { chat_tabs: [{ tab_id: 'tab-1', tab_type: 'message' }] } });
    await expect(listChatTabs('app', 'chat')).resolves.toEqual([{ tab_id: 'tab-1', tab_type: 'message' }]);
    expect(chatTab.listTabs).toHaveBeenCalledWith({ path: { chat_id: 'chat' } });
  });

  it('creates a URL tab', async () => {
    chatTab.create.mockResolvedValue({ code: 0, data: { chat_tabs: [{ tab_id: 'tab-2', tab_type: 'url' }] } });
    await addUrlChatTab('app', 'chat', 'https://example.com/', '项目主页');
    expect(chatTab.create).toHaveBeenCalledWith({
      path: { chat_id: 'chat' },
      data: { chat_tabs: [{ tab_type: 'url', tab_content: { url: 'https://example.com/' }, tab_name: '项目主页' }] },
    });
  });

  it('idempotently reuses an existing URL tab and refreshes its name', async () => {
    const existing = {
      tab_id: 'tab-page', tab_name: '发布页', tab_type: 'url',
      tab_content: { url: 'https://example.com/project/releases/2026/' },
    };
    chatTab.listTabs
      .mockResolvedValueOnce({ code: 0, data: { chat_tabs: [existing] } })
      .mockResolvedValueOnce({ code: 0, data: { chat_tabs: [existing] } });
    chatTab.updateTabs.mockResolvedValue({ code: 0, data: { chat_tabs: [{ ...existing, tab_name: '项目发布页' }] } });
    await expect(ensureUrlChatTab(
      'app', 'chat',
      'https://example.com/project/releases/2026#details',
      '项目发布页',
    )).resolves.toMatchObject({ created: false, tab: { tab_id: 'tab-page', tab_name: '项目发布页' } });
    expect(chatTab.create).not.toHaveBeenCalled();
    expect(chatTab.updateTabs).toHaveBeenCalledOnce();
  });

  it('preserves type and content when renaming an editable tab', async () => {
    const existing = { tab_id: 'tab-2', tab_name: '旧名', tab_type: 'url', tab_content: { url: 'https://example.com/' } };
    chatTab.listTabs.mockResolvedValue({ code: 0, data: { chat_tabs: [existing] } });
    chatTab.updateTabs.mockResolvedValue({ code: 0, data: { chat_tabs: [] } });
    await renameChatTab('app', 'chat', 'tab-2', '新名');
    expect(chatTab.updateTabs).toHaveBeenCalledWith({
      path: { chat_id: 'chat' },
      data: { chat_tabs: [{ ...existing, tab_name: '新名' }] },
    });
  });

  it('rejects edits to built-in tab types', async () => {
    chatTab.listTabs.mockResolvedValue({ code: 0, data: { chat_tabs: [{ tab_id: 'msg', tab_type: 'message' }] } });
    await expect(renameChatTab('app', 'chat', 'msg', 'no')).rejects.toThrow('tab_type_not_editable');
  });

  it('deletes and sorts tabs', async () => {
    chatTab.deleteTabs.mockResolvedValue({ code: 0 });
    chatTab.sortTabs.mockResolvedValue({ code: 0, data: { chat_tabs: [] } });
    await deleteChatTab('app', 'chat', 'tab-2');
    await sortChatTabs('app', 'chat', ['msg', 'tab-2']);
    expect(chatTab.deleteTabs).toHaveBeenCalledWith({ path: { chat_id: 'chat' }, data: { tab_ids: ['tab-2'] } });
    expect(chatTab.sortTabs).toHaveBeenCalledWith({ path: { chat_id: 'chat' }, data: { tab_ids: ['msg', 'tab-2'] } });
  });

  it('accepts only a duplicate-free permutation of every current tab ID', () => {
    const current = [
      { tab_id: 'msg', tab_type: 'message' as const },
      { tab_id: 'url-1', tab_type: 'url' as const },
    ];
    expect(isCompleteChatTabOrder(current, ['url-1', 'msg'])).toBe(true);
    expect(isCompleteChatTabOrder(current, ['msg', 'msg'])).toBe(false);
    expect(isCompleteChatTabOrder(current, ['msg'])).toBe(false);
    expect(isCompleteChatTabOrder(current, ['msg', 'unknown'])).toBe(false);
    expect(isCompleteChatTabOrder([...current, { tab_type: 'url' as const }], ['msg', 'url-1'])).toBe(false);
  });

  it('surfaces non-zero API responses', async () => {
    chatTab.listTabs.mockResolvedValue({ code: 230001, msg: 'invalid' });
    await expect(listChatTabs('app', 'chat')).rejects.toThrow('230001: invalid');
  });
});

describe('parseTabsCommand', () => {
  it('parses list and mutations', () => {
    expect(parseTabsCommand('/tabs')).toEqual({ action: 'list' });
    expect(parseTabsCommand('/tab list')).toEqual({ action: 'list' });
    expect(parseTabsCommand('/tabs add https://example.com 项目主页')).toEqual({
      action: 'add', url: 'https://example.com/', name: '项目主页',
    });
    expect(parseTabsCommand('/tabs rename tab-1 新名称')).toEqual({ action: 'rename', tabId: 'tab-1', name: '新名称' });
    expect(parseTabsCommand('/tabs delete tab-1')).toEqual({ action: 'delete', tabId: 'tab-1' });
    expect(parseTabsCommand('/tabs sort msg,tab-1 tab-2')).toEqual({ action: 'sort', tabIds: ['msg', 'tab-1', 'tab-2'] });
  });

  it('rejects unsafe URL protocols and malformed input', () => {
    expect(parseTabsCommand('/tabs add javascript:alert(1) bad')).toEqual({ action: 'usage' });
    expect(parseTabsCommand('/tabs wat')).toEqual({ action: 'usage' });
    expect(parseTabsCommand('tabs')).toBeNull();
  });
});

describe('parseChatTabsCli', () => {
  it('parses an idempotent URL-tab add command', () => {
    expect(parseChatTabsCli([
      'add', 'https://example.com/project/releases/2026',
      '--name', '项目发布页', '--json',
    ])).toEqual({
      action: 'add',
      url: 'https://example.com/project/releases/2026',
      name: '项目发布页',
      sessionId: undefined,
      chatId: undefined,
      json: true,
    });
  });

  it('parses explicit target and management commands', () => {
    expect(parseChatTabsCli(['list', '--session-id=s1', '--chat-id', 'oc_1'])).toMatchObject({
      action: 'list', sessionId: 's1', chatId: 'oc_1',
    });
    expect(parseChatTabsCli(['update', 'tab-1', '--name', 'new', '--url=https://example.com/page/1'])).toMatchObject({
      action: 'update', tabId: 'tab-1', name: 'new', url: 'https://example.com/page/1',
    });
    expect(parseChatTabsCli(['remove', 'tab-1'])).toMatchObject({ action: 'remove', tabId: 'tab-1' });
    expect(parseChatTabsCli(['sort', 'msg', 'tab-1'])).toMatchObject({ action: 'sort', tabIds: ['msg', 'tab-1'] });
  });

  it('rejects unsafe protocols and incomplete updates', () => {
    expect(() => parseChatTabsCli(['add', 'javascript:alert(1)'])).toThrow('http/https');
    expect(() => parseChatTabsCli(['update', 'tab-1'])).toThrow('至少需要');
  });
});
